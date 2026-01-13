import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Replicate from "https://esm.sh/replicate@0.25.2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Background render processing function
async function processRender(
  projectId: string,
  scenes: any[],
  audioUrl: string | null,
  audioDuration: number | null,
  thumbnailImageUrl: string | null,
  projectTitle: string | null,
  renderId: string
) {
  const REPLICATE_API_KEY = Deno.env.get('REPLICATE_API_KEY')!;
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);
  const replicate = new Replicate({ auth: REPLICATE_API_KEY });

  try {
    console.log(`[BG] Starting render ${renderId} for project ${projectId}`);

    // Step 1: Generate images for each scene if not already generated
    console.log(`[BG] Processing ${scenes.length} scenes for images...`);
    const imagePromises = scenes.map(async (scene: any, i: number) => {
      if (scene.image_url) {
        console.log(`[BG] Scene ${i + 1} already has image`);
        return { index: i, url: scene.image_url };
      }
      
      if (!scene.visual_prompt) {
        return { index: i, url: null };
      }

      console.log(`[BG] Generating image for scene ${i + 1}`);
      
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
          await supabase
            .from('scenes')
            .update({ image_url: output[0] })
            .eq('id', scene.id);
            
          console.log(`[BG] Generated image for scene ${i + 1}`);
          return { index: i, url: output[0] };
        }
      } catch (imgError) {
        console.error(`[BG] Failed to generate image for scene ${i + 1}:`, imgError);
      }
      
      return { index: i, url: null };
    });

    const imageResults = await Promise.all(imagePromises);
    const sortedImages = imageResults.sort((a, b) => a.index - b.index);
    let validImages = sortedImages.filter(r => r.url).map(r => r.url!);

    console.log(`[BG] Generated ${validImages.length} images`);

    // Step 1b: Apply Ken Burns effect
    console.log('[BG] Applying Ken Burns effect...');
    const kenBurnsPromises = validImages.map(async (imageUrl, i) => {
      try {
        console.log(`[BG] Ken Burns for image ${i + 1}/${validImages.length}`);
        const output = await replicate.run(
          "sniklaus/3d-ken-burns:61c026e96be87de9d7cb3a8e9a8f6bdcf9b6bc57c6ea0cc25c6ccc6cd5c98abe",
          {
            input: {
              image: imageUrl,
              shift_x: 0.0,
              shift_y: 0.0,
              focus_x: 0.5,
              focus_y: 0.5,
              zoom: 1.15,
              duration: Math.min(5, (scenes[i]?.end_time - scenes[i]?.start_time) || 3),
              fps: 25
            }
          }
        ) as string | string[];
        
        const resultUrl = Array.isArray(output) ? output[0] : output;
        console.log(`[BG] Ken Burns complete for image ${i + 1}`);
        return { index: i, url: resultUrl, type: 'video' };
      } catch (kbError) {
        console.error(`[BG] Ken Burns failed for image ${i + 1}:`, kbError);
        return { index: i, url: imageUrl, type: 'image' };
      }
    });

    const kenBurnsResults = await Promise.all(kenBurnsPromises);
    const kenBurnsVideos = kenBurnsResults.sort((a, b) => a.index - b.index);
    validImages = kenBurnsVideos.map(r => r.url);
    console.log(`[BG] Ken Burns: ${kenBurnsVideos.filter(r => r.type === 'video').length}/${kenBurnsVideos.length} scenes`);

    if (validImages.length === 0) {
      throw new Error('No images available for video generation');
    }

    // Step 2: Create slideshow video
    console.log('[BG] Creating slideshow video...');

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

    const orderedSceneImages = sortedImages.map((r) => r.url as string | null);
    const inferredDuration = Math.max(...scenes.map((s: any) => Number(s?.end_time ?? 0)), 0);
    const targetDurationSec = Number(audioDuration ?? 0) > 0 ? Number(audioDuration) : inferredDuration;

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

    while (imagesForSlideshow.length < 2 && validImages[0]) imagesForSlideshow.push(validImages[0]);
    if (imagesForSlideshow.length > 50) imagesForSlideshow.length = 50;

    console.log(`[BG] Slideshow: ${imagesForSlideshow.length} frames, ${durationPerImage}s each, target: ${targetDurationSec}s`);

    try {
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
      console.log('[BG] Slideshow video generated:', slideshowVideoUrl);

      let muxedVideoUrl = slideshowVideoUrl;
      if (audioUrl) {
        try {
          console.log('[BG] Muxing narration audio...');
          const muxOut = await replicate.run(
            "lucataco/video-audio-merge",
            {
              input: {
                video_file: slideshowVideoUrl,
                audio_file: audioUrl,
                duration_mode: "audio",
              },
            }
          );

          const muxUrl = extractUrl(muxOut);
          if (muxUrl) {
            muxedVideoUrl = muxUrl;
            console.log('[BG] Audio mux complete:', muxedVideoUrl);
          } else {
            audioMuxWarning = 'Audio mux returned no video URL';
            console.warn('[BG]', audioMuxWarning);
          }
        } catch (muxErr) {
          audioMuxWarning = `Audio mux failed: ${(muxErr as Error)?.message ?? ''}`;
          console.error('[BG]', audioMuxWarning);
        }
      } else {
        audioMuxWarning = 'No audioUrl provided; render is silent.';
      }

      // Upload final video to storage
      console.log('[BG] Uploading video to storage...');
      const videoResponse = await fetch(muxedVideoUrl);
      if (!videoResponse.ok) {
        throw new Error(`Failed to download video: ${videoResponse.status}`);
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
        console.error('[BG] Upload error:', uploadError);
        finalVideoUrl = muxedVideoUrl;
      } else {
        const { data: publicUrl } = supabase.storage.from('renders').getPublicUrl(fileName);
        finalVideoUrl = publicUrl.publicUrl;
        console.log('[BG] Video uploaded:', finalVideoUrl);
      }
    } catch (vidError) {
      console.error('[BG] Video generation error:', vidError);
      finalVideoUrl = null;
    }

    // Generate SEO metadata
    const lovableApiKey = Deno.env.get('LOVABLE_API_KEY');
    let seoData = { title: '', description: '', keywords: '', hashtags: '' };

    if (lovableApiKey && scenes.length > 0) {
      try {
        console.log('[BG] Generating SEO metadata...');
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
        console.log('[BG] SEO generated');
      } catch (seoError) {
        console.error('[BG] SEO generation error:', seoError);
      }
    }

    // Generate subtitles
    let srtContent = '';
    let vttContent = 'WEBVTT\n\n';
    
    scenes.forEach((scene: any, index: number) => {
      const startTime = scene.start_time || 0;
      const endTime = scene.end_time || startTime + 5;
      
      const srtStart = formatSrtTime(startTime);
      const srtEnd = formatSrtTime(endTime);
      srtContent += `${index + 1}\n${srtStart} --> ${srtEnd}\n${scene.narration}\n\n`;
      
      const vttStart = formatVttTime(startTime);
      const vttEnd = formatVttTime(endTime);
      vttContent += `${vttStart} --> ${vttEnd}\n${scene.narration}\n\n`;
    });

    // Generate viral thumbnail
    let generatedThumbnailUrl: string | null = thumbnailImageUrl || validImages[0] || null;
    
    if (lovableApiKey && generatedThumbnailUrl) {
      try {
        console.log('[BG] Generating viral thumbnail...');
        const baseImageUrl = thumbnailImageUrl || validImages[0];
        const videoTitle = projectTitle || seoData.title || 'Video';
        const narrationSummary = scenes.map((s: any) => s.narration).join(' ').substring(0, 500);
        
        const thumbnailResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${lovableApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'google/gemini-2.5-flash-image-preview',
            modalities: ['image', 'text'],
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: `Transform this image into a viral YouTube thumbnail that makes people NEED to click. 
                    
Video title: "${videoTitle}"
Content summary: "${narrationSummary}"

Requirements:
- Make it eye-catching with bold, dramatic colors and high contrast
- Add visual drama: enhance lighting, add subtle glow effects or color grading
- Keep the main subject prominent and clear
- Make it look professional and high-quality like top YouTubers use
- Use a 16:9 aspect ratio optimized for YouTube thumbnails
- Do NOT add any text or overlays - keep it purely visual enhancement
- Create strong visual hooks that trigger curiosity

Make it irresistible to click!`
                  },
                  {
                    type: 'image_url',
                    image_url: { url: baseImageUrl }
                  }
                ]
              }
            ],
          }),
        });

        if (thumbnailResponse.ok) {
          const thumbnailResult = await thumbnailResponse.json();
          const thumbnailBase64 = thumbnailResult.choices?.[0]?.message?.images?.[0]?.image_url?.url;
          
          if (thumbnailBase64) {
            const base64Data = thumbnailBase64.replace(/^data:image\/\w+;base64,/, '');
            const thumbnailBytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
            
            const thumbnailFileName = `${projectId}/${renderId}_thumbnail.png`;
            const { error: thumbUploadError } = await supabase.storage
              .from('renders')
              .upload(thumbnailFileName, thumbnailBytes, {
                contentType: 'image/png',
                upsert: true,
              });

            if (!thumbUploadError) {
              const { data: thumbPublicUrl } = supabase.storage.from('renders').getPublicUrl(thumbnailFileName);
              generatedThumbnailUrl = thumbPublicUrl.publicUrl;
              console.log('[BG] Viral thumbnail generated:', generatedThumbnailUrl);
            }
          }
        }
      } catch (thumbError) {
        console.error('[BG] Thumbnail generation error:', thumbError);
      }
    }

    // Update render record with results
    const isSuccess = !!finalVideoUrl;

    const { error: updateError } = await supabase
      .from('renders')
      .update({
        status: isSuccess ? 'completed' : 'failed',
        video_url: finalVideoUrl,
        thumbnail_url: generatedThumbnailUrl,
        seo_title: seoData.title,
        seo_description: seoData.description,
        seo_keywords: seoData.keywords,
        seo_hashtags: seoData.hashtags,
        subtitle_srt: srtContent,
        subtitle_vtt: vttContent,
        error_message: isSuccess ? (audioMuxWarning ?? null) : 'Failed to generate final mp4',
      })
      .eq('id', renderId);

    if (updateError) {
      console.error('[BG] Update error:', updateError);
    }

    // Update project status
    await supabase
      .from('projects')
      .update({ status: isSuccess ? 'completed' : 'ready' })
      .eq('id', projectId);

    console.log(`[BG] Render ${renderId} completed: ${isSuccess ? 'SUCCESS' : 'FAILED'}`);

  } catch (error) {
    console.error(`[BG] Render ${renderId} failed:`, error);
    
    // Update render as failed
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    await supabase
      .from('renders')
      .update({
        status: 'failed',
        error_message: error instanceof Error ? error.message : 'Unknown error',
      })
      .eq('id', renderId);

    await supabase
      .from('projects')
      .update({ status: 'ready' })
      .eq('id', projectId);
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { projectId, scenes, audioUrl, audioDuration, thumbnailImageUrl, projectTitle } = await req.json();
    
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

    console.log(`Starting render for project ${projectId} with ${scenes.length} scenes`);

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
    console.log(`Created render record: ${renderId} - starting background processing`);

    // Start background processing - this allows the request to return immediately
    // @ts-ignore - EdgeRuntime is available in Supabase Edge Functions
    (globalThis as any).EdgeRuntime?.waitUntil?.(
      processRender(projectId, scenes, audioUrl, audioDuration, thumbnailImageUrl, projectTitle, renderId)
    );

    // Return immediately with the render ID
    return new Response(JSON.stringify({
      success: true,
      renderId,
      message: 'Render started in background. Check the Finished tab for progress.',
      status: 'rendering'
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
