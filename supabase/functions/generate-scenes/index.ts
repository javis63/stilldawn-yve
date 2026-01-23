import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type WordTimestamp = {
  word: string;
  start: number;
  end: number;
};

type AiScene = {
  scene_number: number;
  start_time: number;
  end_time: number;
  visual_prompt: string;
};

function cleanJoinedWords(text: string) {
  return text
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s+"/g, '"')
    .replace(/"\s+/g, '"')
    .replace(/\s+'/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function buildNarrationFromTimestamps(words: WordTimestamp[], start: number, end: number) {
  // Include words whose timestamps overlap the interval (more robust than strict containment)
  const inRange = words.filter((w) => w.start < end && w.end > start);
  const joined = inRange.map((w) => w.word).join(" ");
  return cleanJoinedWords(joined);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { projectId, transcript, audioDuration } = await req.json();

    if (!projectId || !transcript) {
      throw new Error("Missing projectId or transcript");
    }

    const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!lovableApiKey) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log(`Generating scenes for project ${projectId}`);
    console.log(`Transcript length: ${transcript.length} characters`);
    console.log(`Audio duration: ${audioDuration}s`);

    // Pull word timestamps so we can build FULL narration per scene without AI truncation.
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("word_timestamps")
      .eq("id", projectId)
      .single();

    if (projectError) {
      throw new Error(`Project not found: ${projectError.message}`);
    }

    const wordTimestamps: WordTimestamp[] = Array.isArray(project?.word_timestamps)
      ? project.word_timestamps
      : [];

    console.log(`Word timestamps available: ${wordTimestamps.length}`);

    // FIXED: Always create exactly 4 scenes for the entire video
    // Each image will be visible for 1/4 of the video duration with smooth transitions
    const targetScenes = 4;
    const sceneDuration = Math.round((audioDuration || 60) / targetScenes);
    console.log(
      `Target scenes: ${targetScenes} (fixed at 4 scenes, ~${Math.round(sceneDuration / 60)} min each)`,
    );

    // IMPORTANT: We do NOT ask the model to return the narration text (too long → truncation/"...").
    // Instead: model returns timings + visual prompts, then we derive full narration from timestamps.
    const systemPrompt = `You are a video scene breakdown expert for long-form storytelling.

Your job is to break down a narration transcript into EXACTLY 4 major story scenes.

ABSOLUTE CRITICAL RULES:
- Create EXACTLY 4 scenes - no more, no less
- Each scene should represent a MAJOR story beat, theme change, or narrative shift
- Scenes should divide the story into 4 equal-ish parts with natural breakpoints
- NEVER return narration text (it is too long and gets truncated). Only return timings + a visual prompt.
- Visual prompts should be detailed and cinematic, describing the scene for image generation

Return ONLY valid JSON in this exact format:
{
  "scenes": [
    {
      "scene_number": 1,
      "start_time": 0,
      "end_time": ${Math.round((audioDuration || 60) / 4)},
      "visual_prompt": "Detailed visual description for the primary image of this scene (50-100 words, cinematic, photorealistic)"
    }
  ]
}`;

    const userPrompt = `Break down this ${Math.round((audioDuration || 0) / 60)} minute narration into EXACTLY 4 scenes.

CRITICAL REQUIREMENTS:
- EXACTLY 4 scenes (no more, no less)
- Each scene should be approximately ${Math.round((audioDuration || 60) / 4 / 60)} minutes long
- Split at major story beats, theme changes, or narrative shifts
- Output start/end times in seconds
- Visual prompts should be detailed and cinematic for image generation

TRANSCRIPT:
${transcript}

Return ONLY the JSON, no other text.`;

    console.log("Calling Lovable AI for scene boundaries + prompts...");

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lovableApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-5-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("AI API error:", errorText);
      throw new Error(`AI API error: ${response.status}`);
    }

    const aiResult = await response.json();
    const content = aiResult.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("No content in AI response");
    }

    console.log("AI response received, parsing...");

    let scenesData: { scenes: AiScene[] };
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        scenesData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error("No JSON found in response");
      }
    } catch (parseError) {
      console.error("Parse error:", parseError);
      console.error("Raw content:", content);
      throw new Error("Failed to parse AI response as JSON");
    }

    if (!scenesData.scenes || !Array.isArray(scenesData.scenes)) {
      throw new Error("Invalid scenes data structure");
    }

    console.log(`Parsed ${scenesData.scenes.length} scenes`);

    // Basic normalization/guardrails
    const duration = Number(audioDuration || 0);
    const normalizedScenes = scenesData.scenes
      .map((s, idx) => {
        const sceneNumber = Number(s.scene_number || idx + 1);
        const start = Math.max(0, Number(s.start_time || 0));
        const end = Math.max(start, Number(s.end_time || start));
        const prompt = String(s.visual_prompt || "").trim();
        return { scene_number: sceneNumber, start_time: start, end_time: end, visual_prompt: prompt };
      })
      .sort((a, b) => a.start_time - b.start_time);

    if (normalizedScenes.length === 0) {
      throw new Error("AI returned zero scenes");
    }

    // Force coverage of the whole audio timeline if we have a known duration
    normalizedScenes[0].start_time = 0;
    if (duration > 0) {
      normalizedScenes[normalizedScenes.length - 1].end_time = duration;
    }

    // Derive FULL narration per scene from word timestamps (preferred)
    const scenesToInsert = normalizedScenes.map((s) => {
      let narration = "";

      if (wordTimestamps.length > 0) {
        narration = buildNarrationFromTimestamps(wordTimestamps, s.start_time, s.end_time);
      }

      // Fallback when timestamps are missing: keep narration non-empty (rough split by proportion)
      if (!narration) {
        const total = Math.max(1, duration || 1);
        const startRatio = s.start_time / total;
        const endRatio = s.end_time / total;
        const startIdx = Math.floor(transcript.length * startRatio);
        const endIdx = Math.max(startIdx + 1, Math.floor(transcript.length * endRatio));
        narration = transcript.slice(startIdx, endIdx).trim();
      }

      return {
        project_id: projectId,
        scene_number: s.scene_number,
        scene_type: "image",
        start_time: s.start_time,
        end_time: s.end_time,
        narration,
        visual_prompt: s.visual_prompt,
        transition: "crossfade",
      };
    });

    // Delete existing scenes for this project
    const { error: deleteError } = await supabase.from("scenes").delete().eq("project_id", projectId);
    if (deleteError) {
      console.error("Delete error:", deleteError);
    }

    const { data: insertedScenes, error: insertError } = await supabase
      .from("scenes")
      .insert(scenesToInsert)
      .select();

    if (insertError) {
      console.error("Insert error:", insertError);
      throw new Error(`Failed to save scenes: ${insertError.message}`);
    }

    const { error: updateError } = await supabase.from("projects").update({ status: "ready" }).eq("id", projectId);
    if (updateError) {
      console.error("Update error:", updateError);
    }

    console.log(`Successfully created ${insertedScenes?.length} scenes`);

    return new Response(
      JSON.stringify({
        success: true,
        scenes: insertedScenes,
        count: insertedScenes?.length || 0,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Scene generation error:", error);
    return new Response(
      JSON.stringify({
        error: errorMessage,
        success: false,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
