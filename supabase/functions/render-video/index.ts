import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Replicate from "https://esm.sh/replicate@0.25.2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Generate TTS audio using OpenAI
async function generateTTSAudio(
  text: string,
  supabase: any,
  projectId: string,
  renderId: string
): Promise<{ url: string; duration: number } | null> {
  const openaiApiKey = Deno.env.get('OPENAI_API_KEY');
  
  if (!openaiApiKey) {
    console.log('[TTS] No OpenAI API key configured, skipping TTS');
    return null;
  }

  try {
    console.log(`[TTS] Generating audio for ${text.length} characters...`);
    
    // OpenAI TTS has a 4096 character limit per request, so we need to chunk
    const maxChunkSize = 4000;
    const chunks: string[] = [];
    
    // Split text into chunks at sentence boundaries
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    let currentChunk = '';
    
    for (const sentence of sentences) {
      if ((currentChunk + sentence).length > maxChunkSize) {
        if (currentChunk) chunks.push(currentChunk.trim());
        currentChunk = sentence;
      } else {
        currentChunk += sentence;
      }
    }
    if (currentChunk.trim()) chunks.push(currentChunk.trim());
    
    console.log(`[TTS] Split into ${chunks.length} chunks`);
    
    // Generate audio for each chunk
    const audioBuffers: ArrayBuffer[] = [];
    
    for (let i = 0; i < chunks.length; i++) {
      console.log(`[TTS] Processing chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)`);
      
      const response = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openaiApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'tts-1',
          input: chunks[i],
          voice: 'onyx', // Natural, warm male voice
          response_format: 'mp3',
          speed: 1.0,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[TTS] OpenAI error for chunk ${i + 1}:`, errorText);
        throw new Error(`TTS failed: ${response.status}`);
      }

      const audioBuffer = await response.arrayBuffer();
      audioBuffers.push(audioBuffer);
      console.log(`[TTS] Chunk ${i + 1} complete: ${audioBuffer.byteLength} bytes`);
    }

    // Combine all audio buffers
    const totalLength = audioBuffers.reduce((acc, buf) => acc + buf.byteLength, 0);
    const combinedBuffer = new Uint8Array(totalLength);
    let offset = 0;
    
    for (const buffer of audioBuffers) {
      combinedBuffer.set(new Uint8Array(buffer), offset);
      offset += buffer.byteLength;
    }

    // Upload to storage
    const audioFileName = `${projectId}/${renderId}_tts.mp3`;
    const { error: uploadError } = await supabase.storage
      .from('renders')
      .upload(audioFileName, combinedBuffer, {
        contentType: 'audio/mpeg',
        upsert: true,
      });

    if (uploadError) {
      console.error('[TTS] Upload error:', uploadError);
      throw uploadError;
    }

    const { data: publicUrl } = supabase.storage.from('renders').getPublicUrl(audioFileName);
    
    // Estimate duration: ~150 words per minute, average 5 chars per word
    const wordCount = text.split(/\s+/).length;
    const estimatedDuration = (wordCount / 150) * 60;
    
    console.log(`[TTS] Audio generated: ${publicUrl.publicUrl}, estimated ${estimatedDuration.toFixed(1)}s`);
    
    return {
      url: publicUrl.publicUrl,
      duration: estimatedDuration,
    };
  } catch (error) {
    console.error('[TTS] Error generating audio:', error);
    return null;
  }
}

// Background render processing function
async function processRender(
  projectId: string,
  scenes: any[],
  audioUrl: string | null,
  audioDuration: number | null,
  thumbnailImageUrl: string | null,
  projectTitle: string | null,
  renderId: string,
  wordTimestamps: Array<{ word: string; start: number; end: number }> = []
) {
  const REPLICATE_API_KEY = Deno.env.get('REPLICATE_API_KEY')!;
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);
  const replicate = new Replicate({ auth: REPLICATE_API_KEY });

  try {
    console.log(`[BG] Starting render ${renderId} for project ${projectId}`);

    // Step 0: Generate TTS audio if no audio provided
    let finalAudioUrl = audioUrl;
    let finalAudioDuration = audioDuration;
    
    if (!audioUrl) {
      console.log('[BG] No audio provided, generating TTS...');
      const fullNarration = scenes.map((s: any) => s.narration).join(' ');
      
      if (fullNarration.trim()) {
        const ttsResult = await generateTTSAudio(fullNarration, supabase, projectId, renderId);
        
        if (ttsResult) {
          finalAudioUrl = ttsResult.url;
          finalAudioDuration = ttsResult.duration;
          console.log(`[BG] TTS audio ready: ${finalAudioUrl}`);
        }
      }
    }

    // Step 1: Collect existing images/videos - including multiple images per scene with custom durations
    console.log(`[BG] Processing ${scenes.length} scenes for media...`);
    const mediaResults = scenes.map((scene: any, i: number) => {
      // Prefer video_url over images
      if (scene.video_url) {
        console.log(`[BG] Scene ${i + 1} has video: ${scene.video_url}`);
        return { 
          index: i, 
          urls: [scene.video_url], 
          type: 'video', 
          duration: Number(scene.end_time) - Number(scene.start_time),
          imageDurations: [] as number[]
        };
      }
      
      // Collect all images for the scene (image_urls array + image_url)
      const sceneImages: string[] = [];
      if (scene.image_urls && Array.isArray(scene.image_urls)) {
        sceneImages.push(...scene.image_urls);
      }
      if (scene.image_url && !sceneImages.includes(scene.image_url)) {
        sceneImages.unshift(scene.image_url);
      }
      
      // Get custom durations if available
      const imageDurations: number[] = scene.image_durations && Array.isArray(scene.image_durations) 
        ? scene.image_durations 
        : [];
      
      if (sceneImages.length > 0) {
        console.log(`[BG] Scene ${i + 1} has ${sceneImages.length} image(s) with durations: ${JSON.stringify(imageDurations)}`);
        return { 
          index: i, 
          urls: sceneImages, 
          type: 'image', 
          duration: Number(scene.end_time) - Number(scene.start_time),
          imageDurations
        };
      }
      
      console.log(`[BG] Scene ${i + 1} has no media`);
      return { index: i, urls: [], type: null, duration: 0, imageDurations: [] as number[] };
    });

    const sortedMedia = mediaResults.sort((a, b) => a.index - b.index);
    const allImageUrls: string[] = [];
    sortedMedia.forEach(m => {
      if (m.urls.length > 0) allImageUrls.push(...m.urls);
    });

    console.log(`[BG] Found ${allImageUrls.length} total media items`);

    // Check if we have any videos vs images
    const hasVideos = mediaResults.some(r => r.type === 'video');
    const hasImages = mediaResults.some(r => r.type === 'image');
    console.log(`[BG] Media types: ${hasVideos ? 'videos' : ''} ${hasImages ? 'images' : ''}`);

    if (allImageUrls.length === 0) {
      throw new Error('No media (images or videos) available for video generation');
    }

    // Step 2: Create final video
    console.log('[BG] Creating final video...');

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

    // Use first scene's video directly if only one scene with video
    const scenesWithVideo = sortedMedia.filter(r => r.type === 'video');
    const scenesWithImage = sortedMedia.filter(r => r.type === 'image');
    
    let baseVideoUrl: string | null = null;
    
    // If we have videos, use the first video directly (or concatenate if multiple)
    if (scenesWithVideo.length > 0) {
      if (scenesWithVideo.length === 1) {
        // Single video - use it directly
        baseVideoUrl = scenesWithVideo[0].urls[0];
        console.log('[BG] Using single video directly:', baseVideoUrl);
      } else {
        // Multiple videos - try to concatenate them
        console.log(`[BG] Concatenating ${scenesWithVideo.length} videos...`);
        try {
          // Use ffmpeg-based video concatenation via replicate
          const concatOut = await replicate.run(
            "fofr/video-concat:50ee2c50c05cb8fcb1dbbc1d1e3e0bbe08f912e1e0f1e2e1e3e0bbe08f912e1e",
            {
              input: {
                video_urls: scenesWithVideo.map(s => s.urls[0]).join(','),
              },
            }
          );
          baseVideoUrl = extractUrl(concatOut);
        } catch (concatErr) {
          console.error('[BG] Video concat failed, using first video:', concatErr);
          baseVideoUrl = scenesWithVideo[0].urls[0];
        }
      }
    } else if (scenesWithImage.length > 0) {
      // Only images - create slideshow with Ken Burns effect
      // Each image gets its duration calculated based on scene timing
      const inferredDuration = Math.max(...scenes.map((s: any) => Number(s?.end_time ?? 0)), 0);
      const targetDurationSec = Number(finalAudioDuration ?? 0) > 0 ? Number(finalAudioDuration) : inferredDuration;

      // Build image sequence with proper timing - now supporting custom durations per image
      // For Ken Burns, we use shorter duration per image with more images to create dynamic movement
      const imagesForSlideshow: string[] = [];
      const imageDurationsForSlideshow: number[] = [];
      const KEN_BURNS_CYCLE_DURATION = 8; // Each image gets 8 seconds with Ken Burns effect
      
      for (const sceneMedia of sortedMedia) {
        if (sceneMedia.type !== 'image' || sceneMedia.urls.length === 0) continue;
        
        const sceneDuration = sceneMedia.duration;
        const imagesInScene = sceneMedia.urls;
        const customDurations = sceneMedia.imageDurations || [];
        
        // Calculate default duration (evenly split) for images without custom duration
        const defaultDuration = sceneDuration / imagesInScene.length;
        
        for (let imgIdx = 0; imgIdx < imagesInScene.length; imgIdx++) {
          const img = imagesInScene[imgIdx];
          // Use custom duration if set (> 0), otherwise use default
          const imgDuration = (customDurations[imgIdx] && customDurations[imgIdx] > 0) 
            ? customDurations[imgIdx] 
            : defaultDuration;
          
          // Add image with potential repeats for Ken Burns cycles
          const repeats = Math.max(1, Math.ceil(imgDuration / KEN_BURNS_CYCLE_DURATION));
          const durationPerRepeat = imgDuration / repeats;
          
          for (let r = 0; r < repeats; r++) {
            imagesForSlideshow.push(img);
            imageDurationsForSlideshow.push(durationPerRepeat);
          }
        }
      }

      // Ensure minimum images and cap at max
      while (imagesForSlideshow.length < 2 && allImageUrls[0]) imagesForSlideshow.push(allImageUrls[0]);
      if (imagesForSlideshow.length > 100) imagesForSlideshow.length = 100;

      // Calculate duration per image to match target duration
      const durationPerImage = Math.max(3, Math.min(12, targetDurationSec / imagesForSlideshow.length));

      console.log(`[BG] Ken Burns Slideshow: ${imagesForSlideshow.length} frames, ${durationPerImage.toFixed(1)}s each, target: ${targetDurationSec}s`);

      const slideshowOut = await replicate.run(
        "lucataco/image-to-video-slideshow:9804ac4d89f8bf64eed4bc0bee6e8e7d7c13fcce45280f770d0245890d8988e9",
        {
          input: {
            images: imagesForSlideshow,
            duration_per_image: Math.round(durationPerImage),
            frame_rate: 30,
            resolution: "1080p",
            aspect_ratio: "auto",
            transition_type: "fade", // Smooth transitions between Ken Burns cycles
            zoom_pan: true, // Enable Ken Burns effect
          },
        }
      );

      baseVideoUrl = extractUrl(slideshowOut);
    }

    if (!baseVideoUrl) {
      throw new Error('Failed to create base video from media');
    }
    
    console.log('[BG] Base video ready:', baseVideoUrl);

    // Step 3: Mux audio with video
    let muxedVideoUrl = baseVideoUrl;
    try {
      if (finalAudioUrl) {
        try {
          console.log('[BG] Muxing narration audio...');
          const muxOut = await replicate.run(
            "lucataco/video-audio-merge",
            {
              input: {
                video_file: baseVideoUrl,
                audio_file: finalAudioUrl,
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

    // Generate subtitles using Whisper word-level timestamps for perfect sync
    let srtContent = '';
    let vttContent = 'WEBVTT\n\n';
    let subtitleIndex = 1;
    
    if (wordTimestamps && wordTimestamps.length > 0) {
      console.log('[BG] Using Whisper word timestamps for subtitles');
      
      // Group words into subtitle chunks (4-8 words or ~40-80 chars max)
      const maxWordsPerChunk = 8;
      const maxCharsPerChunk = 60;
      
      let currentWords: typeof wordTimestamps = [];
      let currentText = '';
      
      for (const wordData of wordTimestamps) {
        const word = wordData.word.trim();
        if (!word) continue;
        
        const newText = currentText + (currentText ? ' ' : '') + word;
        
        // Check if we should start a new chunk
        if (currentWords.length >= maxWordsPerChunk || newText.length > maxCharsPerChunk) {
          if (currentWords.length > 0) {
            // Output current chunk
            const startTime = currentWords[0].start;
            const endTime = currentWords[currentWords.length - 1].end;
            
            const srtStart = formatSrtTime(startTime);
            const srtEnd = formatSrtTime(endTime);
            srtContent += `${subtitleIndex}\n${srtStart} --> ${srtEnd}\n${currentText}\n\n`;
            
            const vttStart = formatVttTime(startTime);
            const vttEnd = formatVttTime(endTime);
            vttContent += `${vttStart} --> ${vttEnd}\n${currentText}\n\n`;
            
            subtitleIndex++;
          }
          
          // Start new chunk with current word
          currentWords = [wordData];
          currentText = word;
        } else {
          currentWords.push(wordData);
          currentText = newText;
        }
      }
      
      // Output final chunk
      if (currentWords.length > 0) {
        const startTime = currentWords[0].start;
        const endTime = currentWords[currentWords.length - 1].end;
        
        const srtStart = formatSrtTime(startTime);
        const srtEnd = formatSrtTime(endTime);
        srtContent += `${subtitleIndex}\n${srtStart} --> ${srtEnd}\n${currentText}\n\n`;
        
        const vttStart = formatVttTime(startTime);
        const vttEnd = formatVttTime(endTime);
        vttContent += `${vttStart} --> ${vttEnd}\n${currentText}\n\n`;
      }
      
      console.log(`[BG] Generated ${subtitleIndex} subtitles from word timestamps`);
    } else {
      console.log('[BG] No word timestamps, falling back to scene-based subtitles');
      
      // Fallback: use scene-based subtitles
      scenes.forEach((scene: any) => {
        const sceneStart = scene.start_time || 0;
        const sceneEnd = scene.end_time || sceneStart + 5;
        const sceneDuration = sceneEnd - sceneStart;
        
        const sentences = scene.narration.match(/[^.!?]+[.!?]+/g) || [scene.narration];
        const subtitleChunks: string[] = [];
        let currentChunk = '';
        
        for (const sentence of sentences) {
          const trimmed = sentence.trim();
          if (currentChunk.length + trimmed.length > 80 && currentChunk) {
            subtitleChunks.push(currentChunk.trim());
            currentChunk = trimmed;
          } else {
            currentChunk += (currentChunk ? ' ' : '') + trimmed;
          }
        }
        if (currentChunk.trim()) subtitleChunks.push(currentChunk.trim());
        
        const chunkDuration = subtitleChunks.length > 0 ? sceneDuration / subtitleChunks.length : sceneDuration;
        
        subtitleChunks.forEach((chunk, i) => {
          const chunkStart = sceneStart + (i * chunkDuration);
          const chunkEnd = Math.min(chunkStart + chunkDuration, sceneEnd);
          
          const srtStart = formatSrtTime(chunkStart);
          const srtEnd = formatSrtTime(chunkEnd);
          srtContent += `${subtitleIndex}\n${srtStart} --> ${srtEnd}\n${chunk}\n\n`;
          
          const vttStart = formatVttTime(chunkStart);
          const vttEnd = formatVttTime(chunkEnd);
          vttContent += `${vttStart} --> ${vttEnd}\n${chunk}\n\n`;
          
          subtitleIndex++;
        });
      });
    }

    // Generate viral thumbnail
    let generatedThumbnailUrl: string | null = thumbnailImageUrl || allImageUrls[0] || null;
    
    if (lovableApiKey && generatedThumbnailUrl) {
      try {
        console.log('[BG] Generating viral thumbnail...');
        const baseImageUrl = thumbnailImageUrl || allImageUrls[0];
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

    // Fetch word timestamps from project for accurate subtitles
    const { data: projectData } = await supabase
      .from('projects')
      .select('word_timestamps')
      .eq('id', projectId)
      .single();

    const wordTimestamps = projectData?.word_timestamps || [];
    console.log(`Fetched ${wordTimestamps.length} word timestamps for subtitles`);

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
      processRender(projectId, scenes, audioUrl, audioDuration, thumbnailImageUrl, projectTitle, renderId, wordTimestamps)
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
