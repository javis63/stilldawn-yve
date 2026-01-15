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
    
    const maxChunkSize = 4000;
    const chunks: string[] = [];
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
          voice: 'onyx',
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

    const totalLength = audioBuffers.reduce((acc, buf) => acc + buf.byteLength, 0);
    const combinedBuffer = new Uint8Array(totalLength);
    let offset = 0;
    
    for (const buffer of audioBuffers) {
      combinedBuffer.set(new Uint8Array(buffer), offset);
      offset += buffer.byteLength;
    }

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

// Generate ASS subtitle content with yellow text and black outline
function generateAssSubtitles(
  wordTimestamps: Array<{ word: string; start: number; end: number }>,
  scenes: any[]
): string {
  let assContent = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,56,&H0000FFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,3,1,2,20,20,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const formatAssTime = (seconds: number): string => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const centis = Math.floor((seconds % 1) * 100);
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${centis.toString().padStart(2, '0')}`;
  };

  if (wordTimestamps && wordTimestamps.length > 0) {
    console.log('[ASS] Generating from word timestamps');
    
    const maxWordsPerChunk = 7;
    const maxCharsPerChunk = 50;
    
    let currentWords: typeof wordTimestamps = [];
    let currentText = '';
    
    for (const wordData of wordTimestamps) {
      const word = wordData.word.trim();
      if (!word) continue;
      
      const newText = currentText + (currentText ? ' ' : '') + word;
      
      if (currentWords.length >= maxWordsPerChunk || newText.length > maxCharsPerChunk) {
        if (currentWords.length > 0) {
          const startTime = formatAssTime(currentWords[0].start);
          const endTime = formatAssTime(currentWords[currentWords.length - 1].end);
          assContent += `Dialogue: 0,${startTime},${endTime},Default,,0,0,0,,${currentText}\n`;
        }
        
        currentWords = [wordData];
        currentText = word;
      } else {
        currentWords.push(wordData);
        currentText = newText;
      }
    }
    
    if (currentWords.length > 0) {
      const startTime = formatAssTime(currentWords[0].start);
      const endTime = formatAssTime(currentWords[currentWords.length - 1].end);
      assContent += `Dialogue: 0,${startTime},${endTime},Default,,0,0,0,,${currentText}\n`;
    }
  } else {
    console.log('[ASS] Fallback to scene-based subtitles');
    
    for (const scene of scenes) {
      const sceneStart = scene.start_time || 0;
      const sceneEnd = scene.end_time || sceneStart + 5;
      const sceneDuration = sceneEnd - sceneStart;
      
      const sentences = scene.narration.match(/[^.!?]+[.!?]+/g) || [scene.narration];
      const subtitleChunks: string[] = [];
      let currentChunk = '';
      
      for (const sentence of sentences) {
        const trimmed = sentence.trim();
        if (currentChunk.length + trimmed.length > 60 && currentChunk) {
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
        
        assContent += `Dialogue: 0,${formatAssTime(chunkStart)},${formatAssTime(chunkEnd)},Default,,0,0,0,,${chunk}\n`;
      });
    }
  }
  
  return assContent;
}

// Build FFmpeg command for Ken Burns slideshow with (optional) burned-in ASS subtitles
function buildFfmpegCommand(
  imageUrls: string[],
  durations: number[],
  audioUrl: string | null,
  assUrl: string | null,
  fps: number = 30
): string {
  const totalImages = imageUrls.length;

  // Inputs: images (looped) + optional audio. Subtitles are referenced by URL in the filter.
  let inputSection = '';
  for (let i = 0; i < totalImages; i++) {
    const duration = durations[i];
    inputSection += `-loop 1 -t ${duration} -i "${imageUrls[i]}" `;
  }

  const audioInputIndex = audioUrl ? totalImages : -1;
  if (audioUrl) {
    inputSection += `-i "${audioUrl}" `;
  }

  // Filters: per-image ultra-slow Ken Burns + fades, then concat.
  let filterComplex = '';
  const videoLabels: string[] = [];

  // Slow as possible without being imperceptible: only ~8% zoom over the *entire* image duration.
  const maxZoom = 1.08;

  for (let i = 0; i < totalImages; i++) {
    const duration = durations[i];
    const frames = Math.max(1, Math.ceil(duration * fps));
    const zoomStep = Number(((maxZoom - 1.0) / frames).toFixed(10));

    // Alternate direction for variety
    const isZoomIn = i % 2 === 0;
    const expr = isZoomIn
      ? `if(eq(on,0),1.0,min(${maxZoom},zoom+${zoomStep}))`
      : `if(eq(on,0),${maxZoom},max(1.0,zoom-${zoomStep}))`;

    const fadeOutStart = Math.max(0, duration - 0.5);
    const fadeIn = i > 0 ? `,fade=t=in:d=0.5` : '';
    const fadeOut = i < totalImages - 1 ? `,fade=t=out:st=${fadeOutStart}:d=0.5` : '';

    filterComplex += `[${i}:v]` +
      `scale=1920:1080:force_original_aspect_ratio=decrease,` +
      `pad=1920:1080:-1:-1:black,` +
      `zoompan=z='${expr}':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=${fps}` +
      `${fadeIn}${fadeOut}` +
      `[v${i}]; `;

    videoLabels.push(`[v${i}]`);
  }

  filterComplex += `${videoLabels.join('')}concat=n=${totalImages}:v=1:a=0[slideshow]`;

  // Burn-in subtitles using the ASS file we generated (keeps exact styling from the .ass).
  if (assUrl) {
    filterComplex += `; [slideshow]ass='${assUrl}'[final]`;
  } else {
    filterComplex += `; [slideshow]null[final]`;
  }

  let outputSection = `-map "[final]" `;
  if (audioInputIndex >= 0) {
    outputSection += `-map ${audioInputIndex}:a `;
  }

  // Encoding tuned for seeking (frequent keyframes + faststart)
  outputSection += `-c:v libx264 -profile:v high -level 4.1 -pix_fmt yuv420p `;
  outputSection += `-preset medium -crf 23 -g 30 -keyint_min 30 -force_key_frames "expr:gte(t,n_forced*1)" `;
  outputSection += `-c:a aac -b:a 192k -movflags +faststart -shortest -y output.mp4`;

  return `ffmpeg ${inputSection}-filter_complex "${filterComplex}" ${outputSection}`;
}

// Simplified FFmpeg command that works with cog-ffmpeg file inputs
function buildSimpleFfmpegCommand(
  numImages: number,
  durations: number[],
  hasAudio: boolean,
  hasSubtitles: boolean,
  fps: number = 30
): { command: string; fileMapping: string } {
  // cog-ffmpeg supports file1, file2, file3, file4 as inputs
  // We'll pass: file1=concat list, file2=audio, file3=subtitles manifest
  
  // For Ken Burns, we need to process each image individually
  // Since we can't use URLs directly, we'll use a different approach:
  // Create a manifest and let FFmpeg handle it
  
  let filterComplex = '';
  const videoLabels: string[] = [];
  
  for (let i = 0; i < numImages; i++) {
    const duration = durations[i];
    const frames = Math.ceil(duration * fps);
    
    // Alternate Ken Burns direction
    const isZoomIn = i % 2 === 0;
    let zoomExpr: string;
    
    if (isZoomIn) {
      zoomExpr = `'min(zoom+0.0002,1.2)'`;
    } else {
      zoomExpr = `'if(lte(zoom,1.0),1.2,max(1.0,zoom-0.0002))'`;
    }
    
    const fadeOutStart = Math.max(0, duration - 0.5);
    const fadeInDuration = i > 0 ? `,fade=t=in:d=0.5` : '';
    const fadeOutDuration = i < numImages - 1 ? `,fade=t=out:st=${fadeOutStart}:d=0.5` : '';
    
    // Reference images as img_0.jpg, img_1.jpg, etc. (will be downloaded by wrapper script)
    filterComplex += `[${i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:-1:-1:black,zoompan=z=${zoomExpr}:d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=${fps}${fadeInDuration}${fadeOutDuration}[v${i}]; `;
    videoLabels.push(`[v${i}]`);
  }
  
  filterComplex += `${videoLabels.join('')}concat=n=${numImages}:v=1:a=0[slideshow]`;
  
  // Add subtitles filter
  if (hasSubtitles) {
    filterComplex += `; [slideshow]ass=subtitles.ass[final]`;
  } else {
    filterComplex += `; [slideshow]copy[final]`;
  }
  
  // Build the command
  let inputs = '';
  for (let i = 0; i < numImages; i++) {
    inputs += `-loop 1 -t ${durations[i]} -i img_${i}.jpg `;
  }
  
  const audioIndex = numImages;
  if (hasAudio) {
    inputs += `-i audio.mp3 `;
  }
  
  let output = `-map "[final]" `;
  if (hasAudio) {
    output += `-map ${audioIndex}:a `;
  }
  output += `-c:v libx264 -preset medium -crf 23 -g 30 -keyint_min 30 -c:a aac -b:a 192k -movflags +faststart -shortest -y output.mp4`;
  
  const command = `${inputs}-filter_complex "${filterComplex}" ${output}`;
  
  return { command, fileMapping: 'See manifest' };
}

// Background render processing function - IMAGES ONLY with Ken Burns via FFmpeg
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

    // Step 1: Collect ALL images from ALL scenes
    console.log(`[BG] Processing ${scenes.length} scenes for images...`);
    
    const allImages: Array<{
      url: string;
      sceneIndex: number;
      imageIndex: number;
      customDuration?: number;
    }> = [];
    
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const sceneImages: string[] = [];
      
      if (scene.image_urls && Array.isArray(scene.image_urls)) {
        sceneImages.push(...scene.image_urls);
      }
      if (scene.image_url && !sceneImages.includes(scene.image_url)) {
        sceneImages.unshift(scene.image_url);
      }
      
      const imageDurations: number[] = scene.image_durations && Array.isArray(scene.image_durations) 
        ? scene.image_durations 
        : [];
      
      console.log(`[BG] Scene ${i + 1}: ${sceneImages.length} image(s)`);
      
      for (let j = 0; j < sceneImages.length; j++) {
        allImages.push({
          url: sceneImages[j],
          sceneIndex: i,
          imageIndex: j,
          customDuration: imageDurations[j] || 0,
        });
      }
    }

    const totalImages = allImages.length;
    console.log(`[BG] Total images collected: ${totalImages}`);

    if (totalImages === 0) {
      throw new Error('No images available for video generation. Please add images to your scenes.');
    }

    // Calculate target duration
    const inferredDuration = Math.max(...scenes.map((s: any) => Number(s?.end_time ?? 0)), 0);
    const targetDurationSec = Number(finalAudioDuration ?? 0) > 0 ? Number(finalAudioDuration) : inferredDuration;
    
    console.log(`[BG] Target duration: ${targetDurationSec}s`);

    // Calculate duration per image
    let totalCustomDuration = 0;
    let imagesWithCustomDuration = 0;
    
    for (const img of allImages) {
      if (img.customDuration && img.customDuration > 0) {
        totalCustomDuration += img.customDuration;
        imagesWithCustomDuration++;
      }
    }
    
    const remainingDuration = Math.max(0, targetDurationSec - totalCustomDuration);
    const imagesWithoutCustomDuration = totalImages - imagesWithCustomDuration;
    const autoDurationPerImage = imagesWithoutCustomDuration > 0 
      ? remainingDuration / imagesWithoutCustomDuration 
      : 10;
    
    // Build final image list with durations
    const imageList = allImages.map(img => ({
      url: img.url,
      duration: img.customDuration && img.customDuration > 0 ? img.customDuration : autoDurationPerImage,
    }));
    
    console.log(`[BG] Image durations calculated. Custom: ${imagesWithCustomDuration}, Auto: ${imagesWithoutCustomDuration} @ ${autoDurationPerImage.toFixed(1)}s each`);

    // Step 2: Generate ASS subtitles
    console.log('[BG] Generating ASS subtitles...');
    const assContent = generateAssSubtitles(wordTimestamps, scenes);
    const assLineCount = assContent.split('\n').length;
    console.log(`[BG] ASS subtitles generated: ${assLineCount} lines`);
    
    // Upload ASS file to storage
    const assFileName = `${projectId}/${renderId}_subtitles.ass`;
    const { error: assUploadError } = await supabase.storage
      .from('renders')
      .upload(assFileName, new TextEncoder().encode(assContent), {
        contentType: 'text/plain',
        upsert: true,
      });
    
    let assFileUrl: string | null = null;
    if (!assUploadError) {
      const { data: assPublicUrl } = supabase.storage.from('renders').getPublicUrl(assFileName);
      assFileUrl = assPublicUrl.publicUrl;
      console.log('[BG] ASS file uploaded:', assFileUrl);
    } else {
      console.error('[BG] ASS upload error:', assUploadError);
    }

    // Step 3: Generate Ken Burns video using FFmpeg via Replicate
    console.log('[BG] Generating Ken Burns video with FFmpeg...');
    
    // Build image URLs and durations arrays
    const imageUrls = imageList.map(img => img.url);
    const durations = imageList.map(img => img.duration);
    
    // Use magpai-app/cog-ffmpeg for full FFmpeg control
    // This model accepts URLs directly in the command!
    const ffmpegCommand = buildFfmpegCommand(imageUrls, durations, finalAudioUrl, assFileUrl, 30);
    console.log('[BG] FFmpeg command length:', ffmpegCommand.length);
    console.log('[BG] FFmpeg command preview:', ffmpegCommand.substring(0, 500) + '...');

    let baseVideoUrl: string | null = null;
    
    try {
      // Call cog-ffmpeg with the command
      // The model can fetch URLs directly, so we pass them in the command
      console.log('[BG] Calling magpai-app/cog-ffmpeg...');
      
      const ffmpegOutput = await replicate.run(
        // Latest public version (older pinned hash caused 422 + fallback)
        "magpai-app/cog-ffmpeg:efd0b79b577bcd58ae7d035bce9de5c4659a59e09faafac4d426d61c04249251",
        {
          input: {
            command: ffmpegCommand,
            output1: "output.mp4",
          },
        }
      );

      console.log('[BG] FFmpeg output:', JSON.stringify(ffmpegOutput));

      const pickUrl = (out: unknown): string | null => {
        if (!out) return null;
        if (typeof out === 'string') return out;
        if (Array.isArray(out)) return typeof out[0] === 'string' ? (out[0] as string) : null;
        if (typeof out === 'object') {
          const o = out as any;
          if (Array.isArray(o.files) && o.files.length) return o.files[0] as string;
          if (typeof o.output1 === 'string') return o.output1;
          if (typeof o.output === 'string') return o.output;
          if (typeof o.video === 'string') return o.video;
          if (typeof o.url === 'string') return o.url;
          if (Array.isArray(o.output) && o.output.length) return o.output[0] as string;
        }
        return null;
      };

      baseVideoUrl = pickUrl(ffmpegOutput);
      
      if (baseVideoUrl) {
        console.log('[BG] Ken Burns video generated:', baseVideoUrl);
      }
    } catch (ffmpegErr) {
      console.error('[BG] FFmpeg failed:', ffmpegErr);
      
      // Fallback: try the simpler slideshow model without Ken Burns
      console.log('[BG] Falling back to lucataco slideshow (without Ken Burns)...');
      
      try {
        // Clamp durations for the slideshow model
        const clampedDurations = durations.map(d => Math.min(10, d));
        const avgDuration = Math.round(clampedDurations.reduce((a, b) => a + b, 0) / clampedDurations.length);
        
        const slideshowOut = await replicate.run(
          "lucataco/image-to-video-slideshow:9804ac4d89f8bf64eed4bc0bee6e8e7d7c13fcce45280f770d0245890d8988e9",
          {
            input: {
              images: imageUrls,
              duration_per_image: Math.max(2, Math.min(10, avgDuration)),
              frame_rate: 30,
              resolution: "1080p",
              aspect_ratio: "16:9",
              transition_type: "fade",
            },
          }
        );
        
        if (slideshowOut) {
          if (typeof slideshowOut === 'string') {
            baseVideoUrl = slideshowOut;
          } else if (Array.isArray(slideshowOut)) {
            baseVideoUrl = slideshowOut[0] as string;
          }
        }
        
        if (baseVideoUrl) {
          console.log('[BG] Fallback slideshow generated:', baseVideoUrl);
          
          // Still need to mux audio if available
          if (finalAudioUrl) {
            try {
              console.log('[BG] Muxing audio with fallback video...');
              const muxOut = await replicate.run(
                "lucataco/video-audio-merge:8c3d57c9c9a1aaa05feabafbcd2dff9f68a5cb394e54ec020c1c2dcc42bde109",
                {
                  input: {
                    video_file: baseVideoUrl,
                    audio_file: finalAudioUrl,
                    duration_mode: "audio",
                  },
                }
              );
              
              if (muxOut) {
                const muxUrl = typeof muxOut === 'string' ? muxOut : (Array.isArray(muxOut) ? muxOut[0] : null);
                if (muxUrl) {
                  baseVideoUrl = muxUrl as string;
                  console.log('[BG] Audio muxed:', baseVideoUrl);
                }
              }
            } catch (muxErr) {
              console.error('[BG] Audio mux failed:', muxErr);
            }
          }
        }
      } catch (fallbackErr) {
        console.error('[BG] Fallback slideshow also failed:', fallbackErr);
        throw new Error('Failed to generate video with both FFmpeg and fallback methods');
      }
    }

    if (!baseVideoUrl) {
      throw new Error('Failed to generate video');
    }

    // Step 4: Upload final video to storage
    console.log('[BG] Uploading video to storage...');
    let finalVideoUrl: string | null = null;
    
    const videoResponse = await fetch(baseVideoUrl);
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
      finalVideoUrl = baseVideoUrl;
    } else {
      const { data: publicUrl } = supabase.storage.from('renders').getPublicUrl(fileName);
      finalVideoUrl = publicUrl.publicUrl;
      console.log('[BG] Video uploaded:', finalVideoUrl);
    }

    // Step 5: Generate SEO metadata
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

    // Step 6: Generate SRT and VTT subtitle files
    let srtContent = '';
    let vttContent = 'WEBVTT\n\n';
    let subtitleIndex = 1;
    
    if (wordTimestamps && wordTimestamps.length > 0) {
      console.log('[BG] Generating SRT/VTT from word timestamps');
      
      const maxWordsPerChunk = 7;
      const maxCharsPerChunk = 50;
      
      let currentWords: typeof wordTimestamps = [];
      let currentText = '';
      
      for (const wordData of wordTimestamps) {
        const word = wordData.word.trim();
        if (!word) continue;
        
        const newText = currentText + (currentText ? ' ' : '') + word;
        
        if (currentWords.length >= maxWordsPerChunk || newText.length > maxCharsPerChunk) {
          if (currentWords.length > 0) {
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
          
          currentWords = [wordData];
          currentText = word;
        } else {
          currentWords.push(wordData);
          currentText = newText;
        }
      }
      
      if (currentWords.length > 0) {
        const startTime = currentWords[0].start;
        const endTime = currentWords[currentWords.length - 1].end;
        
        srtContent += `${subtitleIndex}\n${formatSrtTime(startTime)} --> ${formatSrtTime(endTime)}\n${currentText}\n\n`;
        vttContent += `${formatVttTime(startTime)} --> ${formatVttTime(endTime)}\n${currentText}\n\n`;
      }
      
      console.log(`[BG] Generated ${subtitleIndex} subtitle cues`);
    } else {
      console.log('[BG] No word timestamps, using scene-based subtitles for SRT/VTT');
      
      for (const scene of scenes) {
        const sceneStart = scene.start_time || 0;
        const sceneEnd = scene.end_time || sceneStart + 5;
        const sceneDuration = sceneEnd - sceneStart;
        
        const sentences = scene.narration.match(/[^.!?]+[.!?]+/g) || [scene.narration];
        const subtitleChunks: string[] = [];
        let currentChunk = '';
        
        for (const sentence of sentences) {
          const trimmed = sentence.trim();
          if (currentChunk.length + trimmed.length > 60 && currentChunk) {
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
          
          srtContent += `${subtitleIndex}\n${formatSrtTime(chunkStart)} --> ${formatSrtTime(chunkEnd)}\n${chunk}\n\n`;
          vttContent += `${formatVttTime(chunkStart)} --> ${formatVttTime(chunkEnd)}\n${chunk}\n\n`;
          
          subtitleIndex++;
        });
      }
    }

    // Step 7: Generate viral thumbnail
    let generatedThumbnailUrl: string | null = thumbnailImageUrl || allImages[0]?.url || null;
    
    if (lovableApiKey && generatedThumbnailUrl) {
      try {
        console.log('[BG] Generating viral thumbnail...');
        const baseImageUrl = thumbnailImageUrl || allImages[0]?.url;
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

    // Step 8: Update render record with results
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
        error_message: isSuccess ? null : 'Failed to generate final mp4',
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

    // Start background processing
    // @ts-ignore - EdgeRuntime is available in Supabase Edge Functions
    (globalThis as any).EdgeRuntime?.waitUntil?.(
      processRender(projectId, scenes, audioUrl, audioDuration, thumbnailImageUrl, projectTitle, renderId, wordTimestamps)
    );

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
