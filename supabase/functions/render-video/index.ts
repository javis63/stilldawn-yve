// Updated to include word_timestamps - 2026-02-01
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function getBackendConfig(): { url: string; serviceRoleKey: string } {
  const url = Deno.env.get("SUPABASE_URL")?.trim();
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();

  if (!url) throw new Error("Missing backend SUPABASE_URL environment variable");
  if (!serviceRoleKey) {
    throw new Error("Missing backend SUPABASE_SERVICE_ROLE_KEY environment variable");
  }

  const looksLikeJwt = serviceRoleKey.startsWith("eyJ") && serviceRoleKey.split(".").length === 3;
  const looksLikeSecretKey = /^(sbp_|sbs_|sb_)/.test(serviceRoleKey);

  if (serviceRoleKey.length < 20) {
    throw new Error(
      `Backend service role key looks too short (len=${serviceRoleKey.length}). Paste the full service_role key.`,
    );
  }

  if (!looksLikeJwt && !looksLikeSecretKey) {
    console.warn(
      `[RENDER] Backend service role key format is unexpected (len=${serviceRoleKey.length}). Continuing anyway.`,
    );
  }

  return { url, serviceRoleKey };
}

// ============================================================================
// VPS RENDER PIPELINE
// ============================================================================

const VPS_RENDER_URL = "http://31.97.147.132:5000/api/lovable-render";
const VPS_STATUS_URL = "http://31.97.147.132:5000/api/lovable-render";
const VPS_API_KEY = Deno.env.get("VPS_API_KEY") || "";

// Helper to poll VPS for render status
async function pollVpsStatus(
  jobId: string,
  maxWaitMs: number = 1800000,
): Promise<{
  success: boolean;
  videoUrl?: string;
  error?: string;
}> {
  const startTime = Date.now();
  const pollIntervalMs = 5000;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const response = await fetch(`${VPS_STATUS_URL}/${jobId}/status`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${VPS_API_KEY}`,
        },
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          console.error(`[VPS] Authentication failed (${response.status}). Check VPS_API_KEY secret.`);
          return {
            success: false,
            error: `VPS authentication failed (${response.status}). Check VPS_API_KEY configuration.`,
          };
        }
        console.log(`[VPS] Status check failed: ${response.status}`);
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        continue;
      }

      const status = await response.json();
      console.log(`[VPS] Job ${jobId}: ${status.status} - ${status.progress}% - ${status.message}`);

      if (status.status === "completed" && status.video_url) {
        return { success: true, videoUrl: status.video_url };
      }

      if (status.status === "failed") {
        return { success: false, error: status.error || "VPS render failed" };
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    } catch (error) {
      console.error(`[VPS] Poll error:`, error);
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }

  return { success: false, error: "Render timed out after 30 minutes" };
}

// Generate SEO metadata using AI
async function generateSeoMetadata(
  projectTitle: string,
  narrations: string[],
): Promise<{
  title: string;
  description: string;
  keywords: string;
  hashtags: string;
}> {
  const fullNarration = narrations.join(" ").slice(0, 2000);

  try {
    const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!lovableApiKey) {
      console.log("[SEO] No Lovable API key, using defaults");
      return {
        title: projectTitle || "Video",
        description: fullNarration.slice(0, 160),
        keywords: "",
        hashtags: "",
      };
    }

    const response = await fetch("https://ai.lovable.dev/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${lovableApiKey}`,
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "user",
            content: `Generate YouTube SEO for this video. Title: "${projectTitle}". Content summary: "${fullNarration.slice(0, 1000)}..."

Return JSON only:
{
  "title": "catchy YouTube title under 60 chars",
  "description": "engaging description under 160 chars",
  "keywords": "comma,separated,keywords",
  "hashtags": "#hashtag1 #hashtag2 #hashtag3"
}`,
          },
        ],
        max_tokens: 500,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || "";
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    }
  } catch (error) {
    console.error("[SEO] Error generating metadata:", error);
  }

  return {
    title: projectTitle || "Video",
    description: fullNarration.slice(0, 160),
    keywords: "",
    hashtags: "",
  };
}

// Generate subtitle files (scene-level, stored in DB for download)
function generateSrtSubtitles(scenes: Array<{ start_time: number; end_time: number; narration: string }>): string {
  let srt = "";
  scenes.forEach((scene, index) => {
    srt += `${index + 1}\n`;
    srt += `${formatSrtTime(scene.start_time)} --> ${formatSrtTime(scene.end_time)}\n`;
    srt += `${scene.narration}\n\n`;
  });
  return srt;
}

function generateVttSubtitles(scenes: Array<{ start_time: number; end_time: number; narration: string }>): string {
  let vtt = "WEBVTT\n\n";
  scenes.forEach((scene, index) => {
    vtt += `${index + 1}\n`;
    vtt += `${formatVttTime(scene.start_time)} --> ${formatVttTime(scene.end_time)}\n`;
    vtt += `${scene.narration}\n\n`;
  });
  return vtt;
}

function formatSrtTime(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)},${pad(ms, 3)}`;
}

function formatVttTime(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)}.${pad(ms, 3)}`;
}

function pad(num: number, size = 2): string {
  return num.toString().padStart(size, "0");
}

// Main render processing function
async function processRender(
  projectId: string,
  scenes: Array<{
    scene_number: number;
    narration: string;
    image_url?: string;
    start_time: number;
    end_time: number;
  }>,
  audioUrl: string | null,
  audioDuration: number,
  thumbnailImageUrl: string | null,
  projectTitle: string,
  renderId: string,
): Promise<void> {
  const { url: supabaseUrl, serviceRoleKey: supabaseKey } = getBackendConfig();
  const supabase = createClient(supabaseUrl, supabaseKey);

  const updateProgress = async (message: string) => {
    console.log(`[RENDER] ${message}`);
    await supabase
      .from("renders")
      .update({ error_message: `[PROGRESS] ${message}` })
      .eq("id", renderId);
  };

  try {
    await updateProgress("Preparing render data for VPS...");

    // Validate scenes have images
    const validScenes = scenes.filter((s) => s.image_url);
    if (validScenes.length === 0) {
      throw new Error("No scenes with images to render");
    }

    // ---------------------------------------------------------------
    // FIX: Fetch word_timestamps from the projects table.
    // These are the Whisper segments with per-segment start/end times.
    // The VPS interpolates per-word timing and groups into 3-4 word
    // subtitle lines from this data.
    // ---------------------------------------------------------------
    let wordTimestamps: any = null;
    try {
      const { data: projectRow } = await supabase
        .from("projects")
        .select("word_timestamps")
        .eq("id", projectId)
        .single();

      if (projectRow?.word_timestamps) {
        wordTimestamps = projectRow.word_timestamps;
        console.log(
          `[RENDER] Fetched word_timestamps: ${Array.isArray(wordTimestamps) ? wordTimestamps.length + " segments" : "object with segments key"}`,
        );
      } else {
        console.warn("[RENDER] No word_timestamps found in project — subtitles will be skipped on VPS");
      }
    } catch (err) {
      console.warn("[RENDER] Failed to fetch word_timestamps:", err);
    }
    // ---------------------------------------------------------------

    // Prepare scene data for VPS
    const vpsScenes = validScenes.map((scene) => ({
      scene_number: scene.scene_number,
      image_url: scene.image_url,
      duration: scene.end_time - scene.start_time,
      narration: scene.narration,
      start_time: scene.start_time,
      end_time: scene.end_time,
    }));

    await updateProgress(`Sending ${vpsScenes.length} scenes + word timestamps to VPS...`);

    // Call VPS render endpoint
    const vpsResponse = await fetch(VPS_RENDER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${VPS_API_KEY}`,
      },
      body: JSON.stringify({
        project_id: projectId,
        render_id: renderId,
        scenes: vpsScenes,
        audio_url: audioUrl,
        audio_duration: audioDuration,
        thumbnail_url: thumbnailImageUrl,
        project_title: projectTitle,
        supabase_url: supabaseUrl,
        supabase_key: supabaseKey,
        word_timestamps: wordTimestamps,
      }),
    });

    if (!vpsResponse.ok) {
      const errorText = await vpsResponse.text();
      if (vpsResponse.status === 401 || vpsResponse.status === 403) {
        throw new Error(
          `VPS authentication failed (${vpsResponse.status}). Check VPS_API_KEY secret matches your VPS server.`,
        );
      }
      throw new Error(`VPS request failed: ${vpsResponse.status} - ${errorText}`);
    }

    const vpsData = await vpsResponse.json();
    if (!vpsData.success || !vpsData.job_id) {
      throw new Error(`VPS rejected request: ${vpsData.error || "Unknown error"}`);
    }

    const jobId = vpsData.job_id;
    await updateProgress(`VPS job started: ${jobId}. Waiting for render...`);

    // Poll for completion (up to 30 minutes)
    const result = await pollVpsStatus(jobId, 1800000);

    if (!result.success) {
      throw new Error(result.error || "VPS render failed");
    }

    await updateProgress("VPS render complete! Generating metadata...");

    // Generate SEO metadata
    const narrations = scenes.map((s) => s.narration).filter(Boolean);
    const seoMetadata = await generateSeoMetadata(projectTitle, narrations);

    // Generate scene-level subtitle files (for download, not burn-in)
    const srtContent = generateSrtSubtitles(validScenes);
    const vttContent = generateVttSubtitles(validScenes);

    // Calculate final duration
    const finalDuration = validScenes.reduce((sum, s) => sum + (s.end_time - s.start_time), 0);

    // Update render record with success
    await supabase
      .from("renders")
      .update({
        status: "completed",
        video_url: result.videoUrl,
        duration: Math.round(finalDuration),
        seo_title: seoMetadata.title,
        seo_description: seoMetadata.description,
        seo_keywords: seoMetadata.keywords,
        seo_hashtags: seoMetadata.hashtags,
        subtitle_srt: srtContent,
        subtitle_vtt: vttContent,
        thumbnail_url: thumbnailImageUrl,
        error_message: null,
      })
      .eq("id", renderId);

    // Update project status
    await supabase.from("projects").update({ status: "completed" }).eq("id", projectId);

    console.log(`[RENDER] ✅ Complete! Video URL: ${result.videoUrl}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error(`[RENDER] ❌ Failed:`, errorMessage);

    await supabase
      .from("renders")
      .update({
        status: "failed",
        error_message: `[FAILED] ${errorMessage}`,
      })
      .eq("id", renderId);

    await supabase.from("projects").update({ status: "ready" }).eq("id", projectId);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { projectId, scenes, audioUrl, audioDuration, thumbnailImageUrl, projectTitle } = await req.json();

    if (!projectId || !scenes || scenes.length === 0) {
      throw new Error("Missing projectId or scenes");
    }

    const { url: supabaseUrl, serviceRoleKey: supabaseKey } = getBackendConfig();
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log(`[RENDER] Starting VPS render for project ${projectId} with ${scenes.length} scenes`);

    // Create a render record
    const { data: renderRecord, error: renderError } = await supabase
      .from("renders")
      .insert({
        project_id: projectId,
        status: "rendering",
        duration: audioDuration,
        error_message: "[STARTED] Sending to VPS for rendering...",
      })
      .select()
      .single();

    if (renderError) {
      throw new Error(`Failed to create render record: ${renderError.message}`);
    }

    const renderId = renderRecord.id;
    console.log(`[RENDER] Created render record: ${renderId}`);

    // Start background processing
    // @ts-ignore - EdgeRuntime is available in Supabase Edge Functions
    (globalThis as any).EdgeRuntime?.waitUntil?.(
      processRender(projectId, scenes, audioUrl, audioDuration, thumbnailImageUrl, projectTitle, renderId),
    );

    return new Response(
      JSON.stringify({
        success: true,
        renderId,
        message: "Render started on VPS. Check the Finished tab for progress.",
        status: "rendering",
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("[RENDER] Error:", error);
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
