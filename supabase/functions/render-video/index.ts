import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Replicate from "https://esm.sh/replicate@0.25.2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { projectId, scenes, audioUrl, audioDuration } = await req.json();
    
    if (!projectId || !scenes || scenes.length === 0) {
      throw new Error('Missing projectId or scenes');
    }

    const REPLICATE_API_KEY = Deno.env.get('REPLICATE_API_KEY');
    if (!REPLICATE_API_KEY) {
      throw new Error('REPLICATE_API_KEY is not configured');
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log(`Rendering video for project ${projectId} with ${scenes.length} scenes`);

    // Create a render record with "rendering" status
    const { data: renderRecord, error: renderError } = await supabase
      .from('renders')
      .insert({
        project_id: projectId,
        status: 'rendering',
        duration: audioDuration,
      })
      .select()
      .single();

    if (renderError) {
      throw new Error(`Failed to create render record: ${renderError.message}`);
    }

    const renderId = renderRecord.id;
    console.log(`Created render record: ${renderId}`);

    const replicate = new Replicate({ auth: REPLICATE_API_KEY });

    // Step 1: Generate images for each scene if not already generated (in parallel for speed)
    const imagePromises = scenes.map(async (scene: any, i: number) => {
      console.log(`Processing scene ${i + 1}/${scenes.length}`);
      
      if (scene.image_url) {
        console.log(`Scene ${i + 1} already has image`);
        return { index: i, url: scene.image_url };
      }
      
      if (!scene.visual_prompt) {
        return { index: i, url: null };
      }

      console.log(`Generating image for scene ${i + 1}`);
      
      try {
        const output = await replicate.run(
          "black-forest-labs/flux-schnell",
          {
            input: {
              prompt: scene.visual_prompt,
              go_fast: true,
              megapixels: "1",
              num_outputs: 1,
              aspect_ratio: "16:9",
              output_format: "png",
              output_quality: 90,
              num_inference_steps: 4
            }
          }
        ) as string[];

        if (output && output[0]) {
          // Update scene with generated image
          await supabase
            .from('scenes')
            .update({ image_url: output[0] })
            .eq('id', scene.id);
            
          console.log(`Generated image for scene ${i + 1}`);
          return { index: i, url: output[0] };
        }
      } catch (imgError) {
        console.error(`Failed to generate image for scene ${i + 1}:`, imgError);
      }
      
      return { index: i, url: null };
    });

    const imageResults = await Promise.all(imagePromises);
    const sortedImages = imageResults.sort((a, b) => a.index - b.index);
    const validImages = sortedImages.filter(r => r.url).map(r => r.url!);

    console.log(`Generated ${validImages.length} images`);

    if (validImages.length === 0) {
      throw new Error('No images available for video generation');
    }

    // Step 2: Create a FULL-LENGTH slideshow video from ALL scene images, then mux narration audio.
    // Notes:
    // - We use a CPU slideshow model (fast) so we avoid timeouts.
    // - The model supports max 50 images and max 10s per image, so we repeat frames to match audio length.
    console.log('Creating slideshow video from scene images...');

    let finalVideoUrl: string | null = null;
    let audioMuxWarning: string | null = null;

    const extractUrl = (out: unknown): string | null => {
      const firstString = (v: unknown): string | null =>
        Array.isArray(v) && typeof v[0] === "string" ? (v[0] as string) : null;

      if (!out) return null;
      if (typeof out === "string") return out;
      if (Array.isArray(out)) return typeof out[0] === "string" ? out[0] : null;

      if (typeof out === "object") {
        const o = out as Record<string, unknown>;

        if (typeof o.url === "string") return o.url;
        if (typeof o.video === "string") return o.video;
        if (typeof o.output === "string") return o.output;

        const videoArr = firstString(o.video);
        if (videoArr) return videoArr;

        const outputArr = firstString(o.output);
        if (outputArr) return outputArr;

        // Common nested shapes: { output: { url } }, { output: { video } }, etc.
        if (o.output && typeof o.output === "object") {
          const oo = o.output as Record<string, unknown>;
          if (typeof oo.url === "string") return oo.url;
          if (typeof oo.video === "string") return oo.video;
          if (typeof oo.output === "string") return oo.output;

          const ooVideoArr = firstString(oo.video);
          if (ooVideoArr) return ooVideoArr;

          const ooOutputArr = firstString(oo.output);
          if (ooOutputArr) return ooOutputArr;
        }
      }

      return null;
    };

    // Keep the per-scene ordering (may contain nulls)
    const orderedSceneImages = sortedImages.map((r) => r.url as string | null);

    // Prefer audioDuration, otherwise infer from last scene end
    const inferredDuration = Math.max(
      ...scenes.map((s: any) => Number(s?.end_time ?? 0)),
      0
    );
    const targetDurationSec = Number(audioDuration ?? 0) > 0 ? Number(audioDuration) : inferredDuration;

    // Choose a duration-per-image so we stay within 2..50 frames
    // duration_per_image is capped at 10s by the model.
    let durationPerImage = Math.min(10, Math.max(0.1, Math.ceil(targetDurationSec / 50)));
    if (!Number.isFinite(durationPerImage) || durationPerImage <= 0) durationPerImage = 1;

    const imagesForSlideshow: string[] = [];
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const img = orderedSceneImages[i] || validImages[0];
      if (!img) continue;

      const start = Number(scene?.start_time ?? 0);
      const end = Number(scene?.end_time ?? start + durationPerImage);
      const sceneDur = Math.max(0.1, end - start);
      const repeats = Math.max(1, Math.ceil(sceneDur / durationPerImage));

      for (let r = 0; r < repeats; r++) imagesForSlideshow.push(img);
    }

    // Enforce model limits (2..50)
    while (imagesForSlideshow.length < 2 && validImages[0]) imagesForSlideshow.push(validImages[0]);
    if (imagesForSlideshow.length > 50) {
      // If we're still too long, we cap to 50 frames (video-audio-merge can truncate/extend based on duration_mode)
      imagesForSlideshow.length = 50;
    }

    console.log(`Slideshow frames: ${imagesForSlideshow.length}, duration_per_image: ${durationPerImage}s, target: ${targetDurationSec}s`);

    try {
      // 2a) Create slideshow mp4
      const slideshowOut = await replicate.run(
        "lucataco/image-to-video-slideshow:9804ac4d89f8bf64eed4bc0bee6e8e7d7c13fcce45280f770d0245890d8988e9",
        {
          input: {
            images: imagesForSlideshow,
            duration_per_image: durationPerImage,
            frame_rate: 30,
            resolution: "1080p",
            aspect_ratio: "auto",
            transition_type: "none",
          },
        }
      );

      const slideshowVideoUrl = extractUrl(slideshowOut);
      if (!slideshowVideoUrl) throw new Error('slideshow model returned no video url');
      console.log('Slideshow video generated:', slideshowVideoUrl);

       // 2b) Mux narration audio onto the mp4
      let muxedVideoUrl = slideshowVideoUrl;
      if (audioUrl) {
        try {
          console.log('Muxing narration audio...');

          const muxOut = await replicate.run(
            "lucataco/video-audio-merge",
            {
              input: {
                video_file: slideshowVideoUrl,
                audio_file: audioUrl,
                // Match the audio length; extend video with frozen frame if needed.
                duration_mode: "audio",
              },
            }
          );

          const muxUrl = extractUrl(muxOut);
          if (muxUrl) {
            muxedVideoUrl = muxUrl;
            console.log('Audio mux complete:', muxedVideoUrl);
          } else {
            audioMuxWarning = 'Audio mux returned no video URL (render is likely silent).';
            console.warn(audioMuxWarning, muxOut);
          }
        } catch (muxErr) {
          audioMuxWarning = `Audio mux failed (render is likely silent). ${(muxErr as Error)?.message ?? ''}`.trim();
          console.error(audioMuxWarning, muxErr);
        }
      } else {
        audioMuxWarning = 'No audioUrl provided; render is silent.';
        console.log(audioMuxWarning);
      }

      // 2c) Download and upload final mp4 to storage
      const videoResponse = await fetch(muxedVideoUrl);
      if (!videoResponse.ok) {
        throw new Error(`Failed to download generated video: ${videoResponse.status}`);
      }

      const contentType = videoResponse.headers.get('content-type') || 'video/mp4';
      const videoArrayBuffer = await videoResponse.arrayBuffer();
      const videoUint8Array = new Uint8Array(videoArrayBuffer);

      const fileName = `${projectId}/${renderId}.mp4`;

      const { error: uploadError } = await supabase.storage
        .from('renders')
        .upload(fileName, videoUint8Array, {
          contentType,
          upsert: true,
        });

      if (uploadError) {
        console.error('Upload error:', uploadError);
        finalVideoUrl = muxedVideoUrl; // fallback to Replicate-hosted URL
      } else {
        const { data: publicUrl } = supabase.storage.from('renders').getPublicUrl(fileName);
        finalVideoUrl = publicUrl.publicUrl;
        console.log('Video uploaded to storage:', finalVideoUrl);
      }
    } catch (vidError) {
      console.error('Video generation error:', vidError);
      finalVideoUrl = null;
    }

    // Generate SEO metadata using AI
    const lovableApiKey = Deno.env.get('LOVABLE_API_KEY');
    let seoData = {
      title: '',
      description: '',
      keywords: '',
      hashtags: ''
    };

    if (lovableApiKey && scenes.length > 0) {
      try {
        const narrationText = scenes.map((s: any) => s.narration).join(' ');
        
        const seoResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${lovableApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'google/gemini-2.5-flash-lite',
            messages: [
              {
                role: 'system',
                content: 'Generate YouTube SEO metadata. Return ONLY valid JSON with: title (max 60 chars), description (max 300 chars), keywords (comma-separated), hashtags (5-10 with # prefix). No markdown.'
              },
              {
                role: 'user',
                content: `Generate SEO for this video narration:\n\n${narrationText.substring(0, 1500)}`
              }
            ],
          }),
        });

        if (seoResponse.ok) {
          const seoResult = await seoResponse.json();
          const seoContent = seoResult.choices?.[0]?.message?.content;
          if (seoContent) {
            const jsonMatch = seoContent.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              seoData = {
                title: parsed.title || '',
                description: parsed.description || '',
                keywords: parsed.keywords || '',
                hashtags: parsed.hashtags || ''
              };
            }
          }
        }
      } catch (seoError) {
        console.error('SEO generation error:', seoError);
      }
    }

    // Generate subtitles in SRT and VTT format
    let srtContent = '';
    let vttContent = 'WEBVTT\n\n';
    
    scenes.forEach((scene: any, index: number) => {
      const startTime = scene.start_time || 0;
      const endTime = scene.end_time || startTime + 5;
      
      // SRT format
      const srtStart = formatSrtTime(startTime);
      const srtEnd = formatSrtTime(endTime);
      srtContent += `${index + 1}\n${srtStart} --> ${srtEnd}\n${scene.narration}\n\n`;
      
      // VTT format
      const vttStart = formatVttTime(startTime);
      const vttEnd = formatVttTime(endTime);
      vttContent += `${vttStart} --> ${vttEnd}\n${scene.narration}\n\n`;
    });

    // Update render record with results
    const isSuccess = !!finalVideoUrl;

    const { error: updateError } = await supabase
      .from('renders')
      .update({
        status: isSuccess ? 'completed' : 'failed',
        video_url: finalVideoUrl,
        thumbnail_url: validImages[0],
        seo_title: seoData.title,
        seo_description: seoData.description,
        seo_keywords: seoData.keywords,
        seo_hashtags: seoData.hashtags,
        subtitle_srt: srtContent,
        subtitle_vtt: vttContent,
        // If muxing fails we still return a video, but flag it clearly.
        error_message: isSuccess ? (audioMuxWarning ?? null) : 'Failed to generate final mp4',
      })
      .eq('id', renderId);

    if (updateError) {
      console.error('Update error:', updateError);
    }

    // Update project status
    await supabase
      .from('projects')
      .update({ status: isSuccess ? 'completed' : 'ready' })
      .eq('id', projectId);

    console.log('Render completed:', { renderId, videoUrl: finalVideoUrl });

    return new Response(JSON.stringify({
      success: true,
      renderId,
      videoUrl: finalVideoUrl,
      thumbnailUrl: validImages[0],
      seo: seoData,
      imageCount: validImages.length
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Render error:', error);
    return new Response(JSON.stringify({ 
      error: errorMessage,
      success: false,
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

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
  return num.toString().padStart(size, '0');
}
