import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decode as base64Decode } from "https://deno.land/std@0.168.0/encoding/base64.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Character lock for consistent character appearance
const CHARACTER_LOCK = `CHARACTER LOCK — PRIMARY PROTAGONIST (ECHO VALE)
The same woman in every scene:
• Adult American female, late 20s to early 30s (never teenage)
• Strikingly beautiful, model-level facial structure
• Very tan skin tone, warm bronze complexion
• High cheekbones, sharp jawline, symmetrical face
• Almond-shaped eyes, intense but controlled gaze
• Minimal makeup, natural military-appropriate appearance
• Brown hair pulled into a tight ponytail or low tactical bun
• Athletic, feminine, well-developed physique (fit, not exaggerated)
• Mature presence, calm authority, experienced demeanor
• NO changes to face shape, ethnicity, age range, or hair color

SUPPORTING CHARACTERS:
• Mason: Male, early-mid 30s, ruggedly handsome, short tactical haircut, light stubble, strong masculine build
• Mercer: Male, early-mid 40s, Caucasian, handsome, battle-hardened, senior-operator presence, salt-and-pepper short hair with neat gray beard
• Senior Chief: Male, early-mid 50s, African American, short-cropped hair, mustache only (no beard)

All characters wear desert tan modern US military tactical uniforms with STILLDAWN patches and body armor.
Cinematic, photorealistic, 16:9, 4K, no text, no logos.`;

// Reference image URL for character consistency (hosted in storage)
const REFERENCE_IMAGE_URL = "https://eofedcncgpcpvxoibkjm.supabase.co/storage/v1/object/public/scene-images/character-reference/echo-crew-reference.png";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { projectId, sceneId, narration, characterLock, useReferenceImage = true } = await req.json();

    if (!projectId || !sceneId || !narration) {
      throw new Error("Missing projectId, sceneId, or narration");
    }

    const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!lovableApiKey) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log(`Generating image for scene ${sceneId}`);

    // Use provided character lock or default
    const charLock = characterLock || CHARACTER_LOCK;

    // Build the image generation prompt
    const imagePrompt = `Use the reference image to maintain exact character appearances.
Keep the SAME faces, uniforms, and STILLDAWN patches as shown in the reference.

${charLock}

SCENE TO GENERATE:
${narration}

Create a new scene showing these exact same characters in a different setting/action based on the scene description above.
Maintain identical faces, hair, skin tones, uniforms, and patches.
Cinematic composition, photorealistic, 16:9 aspect ratio, dramatic lighting.
No text overlays, no watermarks.`;

    console.log("Calling Lovable AI for image generation with reference...");

    // Use image editing API with reference image for character consistency
    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lovableApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-image-preview",
        messages: [
          {
            role: "user",
            content: useReferenceImage ? [
              {
                type: "text",
                text: imagePrompt,
              },
              {
                type: "image_url",
                image_url: {
                  url: REFERENCE_IMAGE_URL,
                },
              },
            ] : imagePrompt,
          },
        ],
        modalities: ["image", "text"],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("AI API error:", errorText);
      
      if (response.status === 429) {
        throw new Error("Rate limit exceeded. Please wait a moment and try again.");
      }
      if (response.status === 402) {
        throw new Error("API credits depleted. Please add credits to continue.");
      }
      
      throw new Error(`AI API error: ${response.status}`);
    }

    const aiResult = await response.json();
    console.log("AI response received");

    // Extract the generated image
    const imageData = aiResult.choices?.[0]?.message?.images?.[0]?.image_url?.url;
    
    if (!imageData) {
      throw new Error("No image generated in AI response");
    }

    // The image is base64 encoded, upload to Supabase storage
    let imageUrl = imageData;
    
    if (imageData.startsWith("data:image")) {
      // Extract base64 data
      const base64Match = imageData.match(/^data:image\/(\w+);base64,(.+)$/);
      if (base64Match) {
        const imageType = base64Match[1];
        const base64Data = base64Match[2];
        const imageBytes = base64Decode(base64Data);
        
        // Upload to Supabase storage
        const fileName = `${projectId}/${sceneId}_generated_${Date.now()}.${imageType}`;
        const { data: uploadData, error: uploadError } = await supabase.storage
          .from("scene-images")
          .upload(fileName, imageBytes, {
            contentType: `image/${imageType}`,
            upsert: true,
          });

        if (uploadError) {
          console.error("Upload error:", uploadError);
          throw new Error(`Failed to upload image: ${uploadError.message}`);
        }

        // Get public URL
        const { data: urlData } = supabase.storage
          .from("scene-images")
          .getPublicUrl(fileName);
        
        imageUrl = urlData.publicUrl;
      }
    }

    // Fetch scene to get existing images and timing info
    const { data: scene, error: fetchError } = await supabase
      .from("scenes")
      .select("image_urls, image_url, start_time, end_time")
      .eq("id", sceneId)
      .single();

    if (fetchError) {
      throw new Error(`Failed to fetch scene: ${fetchError.message}`);
    }

    // Add to existing images (append mode)
    const existingUrls = scene?.image_urls || [];
    // If there's a primary image_url but not in image_urls, include it
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

    // Only set image_url (primary) if this is the first image
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

    console.log(`Successfully generated and saved image for scene ${sceneId}`);

    return new Response(
      JSON.stringify({
        success: true,
        imageUrl,
        message: "Image generated successfully",
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Image generation error:", error);
    return new Response(
      JSON.stringify({
        error: errorMessage,
        success: false,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
