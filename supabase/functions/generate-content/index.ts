import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface GeneratedScene {
  scene_number: number;
  narration: string;
  duration: number;
  visual_description: string;
}

interface GeneratedScript {
  title: string;
  scenes: GeneratedScene[];
}

interface TeaserScript {
  title: string;
  scenes: GeneratedScene[];
}

function formatDuration(seconds: number): string {
  if (seconds >= 60) {
    const mins = seconds / 60;
    return `${mins} minute${mins !== 1 ? "s" : ""}`;
  }
  return `${seconds} seconds`;
}

function parseJsonFromText(text: string): unknown {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[0]);
  }
  throw new Error("No JSON found in response");
}

async function callClaude(
  apiKey: string,
  prompt: string,
): Promise<string> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Claude API error:", errorText);
    throw new Error(`Claude API error: ${response.status}`);
  }

  const result = await response.json();
  const content = result.content?.[0]?.text;

  if (!content) {
    throw new Error("No content in Claude response");
  }

  return content;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const {
      topic,
      style,
      videoLength,
      generateShorts,
      shortsCount,
      shortsLength,
      userId,
    } = await req.json();

    if (!topic || !style || !videoLength) {
      throw new Error("Missing required fields: topic, style, videoLength");
    }

    const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!anthropicApiKey) {
      throw new Error("ANTHROPIC_API_KEY is not configured");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const durationStr = formatDuration(videoLength);
    console.log(
      `Generating ${style} script about "${topic}" for ${durationStr}`,
    );

    // --- Generate main video script ---
    const mainPrompt = `Generate a ${style} video script about "${topic}" that is exactly ${durationStr} long. Break it into scenes of 10-15 seconds each. For each scene provide: scene number, narration text, duration in seconds, visual description suggestion. Also generate a short catchy title for the project.

Format as JSON:
{
  "title": "Project Title Here",
  "scenes": [
    {
      "scene_number": 1,
      "narration": "The narration text for this scene...",
      "duration": 12,
      "visual_description": "A detailed cinematic visual description for image generation..."
    }
  ]
}

CRITICAL: The sum of all scene durations MUST equal exactly ${videoLength} seconds. Return ONLY the JSON, no other text.`;

    const mainContent = await callClaude(anthropicApiKey, mainPrompt);

    let mainScript: GeneratedScript;
    try {
      mainScript = parseJsonFromText(mainContent) as GeneratedScript;
    } catch (parseError) {
      console.error("Parse error:", parseError);
      console.error("Raw content:", mainContent);
      throw new Error("Failed to parse Claude response as JSON");
    }

    if (
      !mainScript.scenes ||
      !Array.isArray(mainScript.scenes) ||
      mainScript.scenes.length === 0
    ) {
      throw new Error("Invalid scenes data from Claude");
    }

    console.log(
      `Parsed ${mainScript.scenes.length} scenes for main script`,
    );

    // --- Create main project ---
    const projectTitle = mainScript.title || `${topic} - ${style}`;
    const fullTranscript = mainScript.scenes.map((s) => s.narration).join(" ");

    const { data: mainProject, error: projectError } = await supabase
      .from("projects")
      .insert({
        title: projectTitle,
        status: "ready",
        user_id: userId,
        project_type: "narration",
        transcript: fullTranscript,
        audio_duration: videoLength,
      })
      .select()
      .single();

    if (projectError) {
      throw new Error(`Failed to create project: ${projectError.message}`);
    }

    // --- Create scenes for main project ---
    let currentTime = 0;
    const scenesToInsert = mainScript.scenes.map((scene) => {
      const startTime = currentTime;
      const endTime = currentTime + scene.duration;
      currentTime = endTime;

      return {
        project_id: mainProject.id,
        scene_number: scene.scene_number,
        scene_type: "image",
        start_time: startTime,
        end_time: endTime,
        narration: scene.narration,
        visual_prompt: scene.visual_description,
        transition: "crossfade",
      };
    });

    const { error: scenesError } = await supabase
      .from("scenes")
      .insert(scenesToInsert);

    if (scenesError) {
      throw new Error(`Failed to create scenes: ${scenesError.message}`);
    }

    console.log(
      `Created main project "${projectTitle}" with ${scenesToInsert.length} scenes`,
    );

    // --- Generate shorts if requested ---
    const shortProjectIds: string[] = [];

    if (generateShorts && shortsCount > 0) {
      const shortsDurationStr = formatDuration(shortsLength);

      const shortsPrompt = `Based on this topic: "${topic}"

Generate ${shortsCount} short teaser video scripts. Each teaser should be exactly ${shortsDurationStr} long and designed to hook viewers and drive them to watch the main video. Each teaser should highlight a different interesting aspect of the topic.

For each teaser, provide: a catchy teaser title, and scenes broken into 5-10 second segments with scene number, narration text, duration in seconds, and visual description.

Format as JSON:
{
  "teasers": [
    {
      "title": "Catchy Teaser Title",
      "scenes": [
        {
          "scene_number": 1,
          "narration": "Hook text that grabs attention...",
          "duration": 8,
          "visual_description": "A detailed cinematic visual description..."
        }
      ]
    }
  ]
}

CRITICAL: For each teaser, the sum of scene durations MUST equal exactly ${shortsLength} seconds. Return ONLY the JSON, no other text.`;

      try {
        const shortsContent = await callClaude(anthropicApiKey, shortsPrompt);
        const shortsData = parseJsonFromText(shortsContent) as {
          teasers: TeaserScript[];
        };

        if (shortsData.teasers && Array.isArray(shortsData.teasers)) {
          for (let i = 0; i < shortsData.teasers.length; i++) {
            const teaser = shortsData.teasers[i];
            const shortTitle =
              teaser.title || `${topic} - Short ${i + 1}`;

            const { data: shortProject, error: shortProjError } =
              await supabase
                .from("projects")
                .insert({
                  title: shortTitle,
                  status: "ready",
                  user_id: userId,
                  project_type: "narration",
                  transcript: (teaser.scenes || [])
                    .map((s) => s.narration)
                    .join(" "),
                  audio_duration: shortsLength,
                })
                .select()
                .single();

            if (shortProjError) {
              console.error(
                `Failed to create short ${i + 1}:`,
                shortProjError,
              );
              continue;
            }

            let shortCurrentTime = 0;
            const shortScenes = (teaser.scenes || []).map((scene) => {
              const start = shortCurrentTime;
              const end = shortCurrentTime + (scene.duration || 5);
              shortCurrentTime = end;
              return {
                project_id: shortProject.id,
                scene_number: scene.scene_number || 1,
                scene_type: "image",
                start_time: start,
                end_time: end,
                narration: scene.narration || "",
                visual_prompt: scene.visual_description || "",
                transition: "crossfade",
              };
            });

            if (shortScenes.length > 0) {
              const { error: shortScenesError } = await supabase
                .from("scenes")
                .insert(shortScenes);

              if (shortScenesError) {
                console.error(
                  `Failed to create scenes for short ${i + 1}:`,
                  shortScenesError,
                );
              }
            }

            shortProjectIds.push(shortProject.id);
            console.log(
              `Created short project "${shortTitle}" with ${shortScenes.length} scenes`,
            );
          }
        }
      } catch (shortsError) {
        console.error(
          "Shorts generation failed, continuing with main project:",
          shortsError,
        );
      }
    }

    const totalProjects = 1 + shortProjectIds.length;
    console.log(`Successfully created ${totalProjects} project(s) total`);

    return new Response(
      JSON.stringify({
        success: true,
        mainProjectId: mainProject.id,
        shortProjectIds,
        projectCount: totalProjects,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("Content generation error:", error);
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
