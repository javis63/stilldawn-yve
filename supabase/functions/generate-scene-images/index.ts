import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CHARACTER_LOCK = `Photorealistic cinematic film still. Modern military special operations team in desert tactical gear. Professional cinematography, natural dramatic lighting. 4K quality. No cartoon, no illustration, no anime, no CGI.`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { projectId, sceneId, narration, useCharacterLock } = await req.json();

    if (!projectId || !sceneId || !narration) {
      throw new Error("Missing projectId, sceneId, or narration");
    }

    const characterLockEnabled = useCharacterLock !== false;

    const replicateToken = Deno.env.get("REPLICATE_API_TOKEN");
    if (!replicateToken) {
      throw new Error("REPLICATE_API_TOKEN is not configured");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log(`Generating image for scene ${sceneId}`);

    // Build prompt — character lock at front when enabled
    const prompt = characterLockEnabled
      ? `${CHARACTER_LOCK} ${narration}`
      : narration;

    console.log(`Calling Replicate Flux 1.1 Pro...`);

    // Create prediction via Replicate API using model identifier
    const createResp = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${replicateToken}`,
        "Content-Type": "application/json",
        Prefer: "wait",
      },
      body: JSON.stringify({
        input: {
          prompt,
          aspect_ratio: "16:9",
          output_format: "jpg",
          output_quality: 90,
          num_outputs: 1,
        },
      }),
    });

    if (!createResp.ok) {
      const errText = await createResp.text();
      console.error("Replicate create error:", errText);
      if (createResp.status === 422) {
        throw new Error(`Replicate rejected the request: ${errText}`);
      }
      throw new Error(`Replicate API error: ${createResp.status}`);
    }

    let prediction = await createResp.json();
    console.log(`Prediction created: ${prediction.id}, status: ${prediction.status}`);

    // If Prefer: wait didn't resolve it, poll until complete
    while (prediction.status !== "succeeded" && prediction.status !== "failed" && prediction.status !== "canceled") {
      await new Promise((r) => setTimeout(r, 2000));
      const pollResp = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
        headers: { Authorization: `Bearer ${replicateToken}` },
      });
      if (!pollResp.ok) {
        throw new Error(`Replicate poll error: ${pollResp.status}`);
      }
      prediction = await pollResp.json();
      console.log(`Poll: ${prediction.status}`);
    }

    if (prediction.status === "failed") {
      throw new Error(`Replicate generation failed: ${prediction.error || "unknown"}`);
    }
    if (prediction.status === "canceled") {
      throw new Error("Replicate generation was canceled");
    }

    // Flux 1.1 Pro returns a single URL string (or array with one URL)
    const outputUrl: string = Array.isArray(prediction.output)
      ? prediction.output[0]
      : prediction.output;

    if (!outputUrl) {
      throw new Error("No image URL in Replicate response");
    }

    console.log(`Image generated, downloading from Replicate...`);

    // Download the image from Replicate's temporary URL
    const imgResp = await fetch(outputUrl);
    if (!imgResp.ok) {
      throw new Error(`Failed to download image: ${imgResp.status}`);
    }
    const imgBytes = new Uint8Array(await imgResp.arrayBuffer());
    console.log(`Downloaded ${imgBytes.length} bytes`);

    // Upload to Supabase storage
    const fileName = `${projectId}/${sceneId}_${Date.now()}.jpg`;
    const { error: uploadError } = await supabase.storage
      .from("scene-images")
      .upload(fileName, imgBytes, {
        contentType: "image/jpeg",
        upsert: true,
      });

    if (uploadError) {
      console.error("Upload error:", uploadError);
      throw new Error(`Failed to upload image: ${uploadError.message}`);
    }

    const { data: urlData } = supabase.storage
      .from("scene-images")
      .getPublicUrl(fileName);

    const imageUrl = urlData.publicUrl;
    console.log(`Uploaded to storage: ${imageUrl}`);

    // Fetch scene to get existing images and timing info
    const { data: scene, error: fetchError } = await supabase
      .from("scenes")
      .select("image_urls, image_url, start_time, end_time")
      .eq("id", sceneId)
      .single();

    if (fetchError) {
      throw new Error(`Failed to fetch scene: ${fetchError.message}`);
    }

    // Append to existing images
    const existingUrls: string[] = scene?.image_urls || [];
    if (scene?.image_url && !existingUrls.includes(scene.image_url)) {
      existingUrls.unshift(scene.image_url);
    }
    const updatedUrls = [...existingUrls, imageUrl];

    // Calculate equal durations for all images in the scene
    const sceneDuration = Number(scene?.end_time || 0) - Number(scene?.start_time || 0);
    const durationPerImage = sceneDuration > 0 && updatedUrls.length > 0
      ? sceneDuration / updatedUrls.length
      : 0;
    const equalDurations = updatedUrls.map(() => durationPerImage);

    const primaryImage = existingUrls.length === 0 ? imageUrl : (scene?.image_url || imageUrl);

    const { error: updateError } = await supabase
      .from("scenes")
      .update({
        image_url: primaryImage,
        image_urls: updatedUrls,
        image_durations: equalDurations,
      })
      .eq("id", sceneId);

    if (updateError) {
      throw new Error(`Failed to update scene: ${updateError.message}`);
    }

    console.log(`Done: scene ${sceneId} image saved`);

    return new Response(
      JSON.stringify({ success: true, imageUrl }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Image generation error:", error);
    return new Response(
      JSON.stringify({ error: errorMessage, success: false }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
