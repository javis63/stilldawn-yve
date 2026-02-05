import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const {
      projectId,
      projectType,
      scenes,
      audioUrl,
      audioDuration,
      thumbnailImageUrl,
      projectTitle,
      wordTimestamps,
    } = await req.json();

    if (!projectId || !scenes || scenes.length === 0) {
      throw new Error("Missing projectId or scenes");
    }

    const vpsRenderUrl = Deno.env.get("VPS_RENDER_URL");
    const vpsApiKey = Deno.env.get("VPS_API_KEY");

    if (!vpsRenderUrl) {
      throw new Error("VPS_RENDER_URL is not configured");
    }
    if (!vpsApiKey) {
      throw new Error("VPS_API_KEY is not configured");
    }

    // --- Create the render record ---
    const { data: renderRecord, error: renderError } = await supabase
      .from("renders")
      .insert({
        project_id: projectId,
        status: "rendering",
      })
      .select()
      .single();

    if (renderError) {
      throw new Error(`Failed to create render record: ${renderError.message}`);
    }

    const renderId = renderRecord.id;
    console.log(`Created render record ${renderId} for project ${projectId}`);

    // --- Update project status ---
    await supabase
      .from("projects")
      .update({ status: "rendering" })
      .eq("id", projectId);

    // --- Prepare scene data for VPS ---
    const vpsScenes = scenes.map((s: any) => {
      const imageUrls = s.image_urls || [];
      const primaryImage = imageUrls.length > 0 ? imageUrls[0] : s.image_url;
      const duration = (s.end_time || 0) - (s.start_time || 0);

      return {
        scene_number: s.scene_number,
        image_url: primaryImage,
        image_urls: imageUrls,
        image_durations: s.image_durations || [],
        video_url: s.video_url,
        start_time: s.start_time,
        end_time: s.end_time,
        duration: duration > 0 ? duration : 10,
        narration: s.narration,
        visual_prompt: s.visual_prompt,
      };
    });

    // --- Call VPS to start the render ---
    console.log(`Calling VPS at ${vpsRenderUrl}/api/lovable-render`);

    const vpsResponse = await fetch(`${vpsRenderUrl}/api/lovable-render`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${vpsApiKey}`,
      },
      body: JSON.stringify({
        project_id: projectId,
        render_id: renderId,
        scenes: vpsScenes,
        audio_url: audioUrl,
        audio_duration: audioDuration,
        thumbnail_image_url: thumbnailImageUrl,
        project_title: projectTitle,
        word_timestamps: wordTimestamps,
        supabase_url: supabaseUrl,
        supabase_key: supabaseKey,
      }),
    });

    if (!vpsResponse.ok) {
      const errText = await vpsResponse.text();
      console.error("VPS render request failed:", errText);

      await supabase
        .from("renders")
        .update({
          status: "failed",
          error_message: `VPS error: ${vpsResponse.status} - ${errText.slice(0, 500)}`,
        })
        .eq("id", renderId);

      throw new Error(`VPS render request failed: ${vpsResponse.status}`);
    }

    const vpsResult = await vpsResponse.json();
    console.log(`VPS render job started: job_id=${vpsResult.job_id}`);

    // --- Poll VPS for completion ---
    const maxPollTime = 10 * 60 * 1000; // 10 minutes
    const pollInterval = 3000; // 3 seconds
    const startTime = Date.now();

    let finalStatus = "rendering";
    let finalVideoUrl: string | null = null;
    let finalError: string | null = null;

    while (Date.now() - startTime < maxPollTime) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));

      try {
        const statusResponse = await fetch(
          `${vpsRenderUrl}/api/lovable-render/${vpsResult.job_id}/status`,
          {
            headers: { Authorization: `Bearer ${vpsApiKey}` },
          },
        );

        if (!statusResponse.ok) {
          console.warn(`Status poll failed: ${statusResponse.status}`);
          continue;
        }

        const statusData = await statusResponse.json();
        console.log(
          `Poll: status=${statusData.status} progress=${statusData.progress}%`,
        );

        if (statusData.status === "completed") {
          finalStatus = "completed";
          finalVideoUrl = statusData.video_url || null;
          break;
        }

        if (statusData.status === "failed") {
          finalStatus = "failed";
          finalError = statusData.error || "Render failed on VPS";
          break;
        }
      } catch (pollError) {
        console.warn("Poll error:", pollError);
      }
    }

    // Timed out
    if (finalStatus === "rendering") {
      finalStatus = "failed";
      finalError = "Render timed out after 10 minutes";
    }

    // --- Resolve the video URL ---
    // If video_url is a relative VPS path like /output/..., make it absolute
    if (finalVideoUrl && finalVideoUrl.startsWith("/")) {
      finalVideoUrl = `${vpsRenderUrl}${finalVideoUrl}`;
    }

    // --- Update the render record ---
    const updatePayload: Record<string, unknown> = {
      status: finalStatus,
    };

    if (finalVideoUrl) {
      updatePayload.video_url = finalVideoUrl;
    }
    if (finalError) {
      updatePayload.error_message = finalError;
    }

    if (finalStatus === "completed" && scenes.length > 0) {
      const lastScene = scenes[scenes.length - 1];
      const duration = lastScene.end_time || audioDuration || null;
      if (duration) {
        updatePayload.duration = duration;
      }
    }

    await supabase.from("renders").update(updatePayload).eq("id", renderId);

    // --- Update project status ---
    await supabase
      .from("projects")
      .update({
        status: finalStatus === "completed" ? "completed" : "error",
      })
      .eq("id", projectId);

    console.log(`Render ${renderId} finished: status=${finalStatus}`);

    return new Response(
      JSON.stringify({
        success: finalStatus === "completed",
        renderId,
        videoUrl: finalVideoUrl,
        status: finalStatus,
        error: finalError,
        imageCount: scenes.length,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("Render error:", error);
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
