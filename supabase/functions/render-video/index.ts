import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Replicate from "https://esm.sh/replicate@0.25.2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ============================================================================
// PHASE 2 & 3: BULLETPROOF RENDER PIPELINE
// - NO silent fallback - if FFmpeg fails, render fails with clear error
// - Segmented cog-ffmpeg approach using file1..file4 inputs (local files, not URLs)
// - Ken Burns with ultra-slow zoom + burned-in ASS subtitles
// ============================================================================

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

// ============================================================================
// PHASE 3: SEGMENTED COG-FFMPEG PIPELINE
// Uses file1..file4 inputs to avoid remote URL fetch issues
// ============================================================================

interface SegmentResult {
  videoUrl: string;
  segmentIndex: number;
}

// Build FFmpeg command for a single segment (up to 4 images)
// Uses LOCAL file references (file1, file2, etc.) which cog-ffmpeg downloads
function buildSegmentFfmpegCommand(
  imageCount: number,
  durations: number[],
  fps: number = 30
): string {
  const maxZoom = 1.08;
  let filterComplex = '';
  const videoLabels: string[] = [];

  for (let i = 0; i < imageCount; i++) {
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
    const fadeOut = i < imageCount - 1 ? `,fade=t=out:st=${fadeOutStart}:d=0.5` : '';

    // Reference file1, file2, etc. (local files downloaded by cog-ffmpeg)
    filterComplex += `[${i}:v]` +
      `scale=1920:1080:force_original_aspect_ratio=decrease,` +
      `pad=1920:1080:-1:-1:black,` +
      `zoompan=z='${expr}':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=${fps}` +
      `${fadeIn}${fadeOut}` +
      `[v${i}]; `;

    videoLabels.push(`[v${i}]`);
  }

  filterComplex += `${videoLabels.join('')}concat=n=${imageCount}:v=1:a=0[out]`;

  // Build input section using file1, file2, etc.
  let inputSection = '';
  for (let i = 0; i < imageCount; i++) {
    const duration = durations[i];
    inputSection += `-loop 1 -t ${duration} -i file${i + 1} `;
  }

  // Seek-friendly encoding
  const outputSection = `-map "[out]" -c:v libx264 -profile:v high -level 4.1 -pix_fmt yuv420p ` +
    `-preset medium -crf 23 -g 60 -keyint_min 60 -movflags +faststart -y output.mp4`;

  return `ffmpeg ${inputSection}-filter_complex "${filterComplex}" ${outputSection}`;
}

// Build FFmpeg command to concatenate multiple segment videos
function buildConcatFfmpegCommand(segmentCount: number): string {
  let inputSection = '';
  let filterComplex = '';
  const videoLabels: string[] = [];

  for (let i = 0; i < segmentCount; i++) {
    inputSection += `-i file${i + 1} `;
    videoLabels.push(`[${i}:v]`);
  }

  filterComplex = `${videoLabels.join('')}concat=n=${segmentCount}:v=1:a=0[out]`;

  return `ffmpeg ${inputSection}-filter_complex "${filterComplex}" -map "[out]" -c:v libx264 -preset medium -crf 23 -g 60 -movflags +faststart -y output.mp4`;
}

// Build FFmpeg command to mux audio + burn subtitles into video
function buildFinalMuxCommand(hasAudio: boolean, hasSubtitles: boolean): string {
  // file1 = video, file2 = audio (optional), file3 = subtitles.ass (optional)
  let inputs = '-i file1 ';
  if (hasAudio) inputs += '-i file2 ';

  let filterComplex = '[0:v]copy[vout]';
  if (hasSubtitles) {
    // Burn in subtitles from file3 (downloaded locally by cog-ffmpeg)
    filterComplex = `[0:v]ass=file3[vout]`;
  }

  let output = `-filter_complex "${filterComplex}" -map "[vout]" `;
  if (hasAudio) {
    output += `-map 1:a -c:a aac -b:a 192k `;
  }
  output += `-c:v libx264 -preset medium -crf 23 -g 60 -keyint_min 60 -movflags +faststart -shortest -y output.mp4`;

  return `ffmpeg ${inputs}${output}`;
}

// Helper to run cog-ffmpeg with retries
async function runCogFfmpeg(
  replicate: any,
  command: string,
  files: Record<string, string>,
  description: string,
  maxRetries: number = 2
): Promise<string> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[FFmpeg] ${description} (attempt ${attempt}/${maxRetries})`);
      console.log(`[FFmpeg] Command: ${command.substring(0, 200)}...`);
      
      const input: Record<string, any> = {
        command,
        output1: "output.mp4",
      };
      
      // Add file inputs (file1, file2, file3, file4)
      for (const [key, url] of Object.entries(files)) {
        input[key] = url;
      }
      
      const output = await replicate.run(
        "magpai-app/cog-ffmpeg:efd0b79b577bcd58ae7d035bce9de5c4659a59e09faafac4d426d61c04249251",
        { input }
      );
      
      // Extract URL from output
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
      
      const url = pickUrl(output);
      if (!url) {
        throw new Error(`No output URL from FFmpeg for: ${description}`);
      }
      
      console.log(`[FFmpeg] ${description} SUCCESS: ${url}`);
      return url;
      
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`[FFmpeg] ${description} attempt ${attempt} failed:`, lastError.message);
      
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s before retry
      }
    }
  }
  
  throw lastError || new Error(`FFmpeg failed: ${description}`);
}

// ============================================================================
// MAIN RENDER PROCESSING
// ============================================================================

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
  
  // Helper to update progress in error_message (breadcrumbs)
  const updateProgress = async (stage: string) => {
    console.log(`[BG] ${stage}`);
    await supabase.from('renders').update({ error_message: `[PROGRESS] ${stage}` }).eq('id', renderId);
  };

  try {
    await updateProgress(`Starting render for project ${projectId}`);

    // Step 0: Generate TTS audio if no audio provided
    let finalAudioUrl = audioUrl;
    let finalAudioDuration = audioDuration;
    
    if (!audioUrl) {
      await updateProgress('No audio provided, generating TTS...');
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
    await updateProgress(`Processing ${scenes.length} scenes for images...`);
    
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

    // PHASE 4 GUARDRAIL: Validate we have images
    if (totalImages === 0) {
      throw new Error('VALIDATION_ERROR: No images available for video generation. Please add images to your scenes.');
    }

    // Calculate target duration
    const inferredDuration = Math.max(...scenes.map((s: any) => Number(s?.end_time ?? 0)), 0);
    const targetDurationSec = Number(finalAudioDuration ?? 0) > 0 ? Number(finalAudioDuration) : inferredDuration;
    
    // PHASE 4 GUARDRAIL: Validate duration
    if (targetDurationSec <= 0) {
      throw new Error('VALIDATION_ERROR: Cannot determine video duration. Please ensure audio has valid duration or scenes have end times.');
    }
    
    console.log(`[BG] Target duration: ${targetDurationSec}s (${(targetDurationSec / 60).toFixed(1)} minutes)`);

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
    
    // PHASE 4 GUARDRAIL: Validate duration math
    const computedTotalDuration = imageList.reduce((sum, img) => sum + img.duration, 0);
    const durationDiff = Math.abs(computedTotalDuration - targetDurationSec);
    if (durationDiff > 5) {
      console.warn(`[BG] Duration mismatch: computed=${computedTotalDuration.toFixed(1)}s, target=${targetDurationSec.toFixed(1)}s, diff=${durationDiff.toFixed(1)}s`);
    }
    
    console.log(`[BG] Image durations: Custom=${imagesWithCustomDuration}, Auto=${imagesWithoutCustomDuration} @ ${autoDurationPerImage.toFixed(1)}s each`);
    await updateProgress(`Images prepared: ${totalImages} images, ${computedTotalDuration.toFixed(0)}s total`);

    // Step 2: Generate ASS subtitles
    await updateProgress('Generating ASS subtitles...');
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

    // ========================================================================
    // PHASE 3: SEGMENTED FFMPEG PIPELINE
    // Process images in TIME-BASED segments (max 30s per segment) to avoid
    // Replicate upload failures on large output files
    // ========================================================================
    
    await updateProgress('Starting segmented FFmpeg pipeline (Ken Burns)...');
    
    // Split images into time-based segments (max 30 seconds each to keep output small)
    const MAX_SEGMENT_DURATION = 30; // seconds - keeps output files small enough for Replicate
    const MAX_IMAGES_PER_SEGMENT = 4; // cog-ffmpeg limit
    
    interface ImageSegment {
      images: Array<{ url: string; duration: number }>;
      totalDuration: number;
    }
    
    const segments: ImageSegment[] = [];
    let currentSegment: ImageSegment = { images: [], totalDuration: 0 };
    
    for (const img of imageList) {
      // If this image is longer than MAX_SEGMENT_DURATION, we need to split it
      // into multiple virtual "sub-images" with the same URL but shorter duration
      let remainingDuration = img.duration;
      
      while (remainingDuration > 0) {
        const spaceInCurrentSegment = MAX_SEGMENT_DURATION - currentSegment.totalDuration;
        const canFitImages = currentSegment.images.length < MAX_IMAGES_PER_SEGMENT;
        
        if (spaceInCurrentSegment <= 0 || !canFitImages) {
          // Current segment is full, start a new one
          if (currentSegment.images.length > 0) {
            segments.push(currentSegment);
          }
          currentSegment = { images: [], totalDuration: 0 };
        }
        
        // Calculate how much of this image fits in current segment
        const durationToUse = Math.min(remainingDuration, MAX_SEGMENT_DURATION - currentSegment.totalDuration);
        
        if (durationToUse > 0) {
          currentSegment.images.push({
            url: img.url,
            duration: durationToUse,
          });
          currentSegment.totalDuration += durationToUse;
          remainingDuration -= durationToUse;
        }
      }
    }
    
    // Don't forget the last segment
    if (currentSegment.images.length > 0) {
      segments.push(currentSegment);
    }
    
    console.log(`[BG] Split into ${segments.length} time-based segments (max ${MAX_SEGMENT_DURATION}s each)`);
    for (let i = 0; i < segments.length; i++) {
      console.log(`[BG]   Segment ${i + 1}: ${segments[i].images.length} images, ${segments[i].totalDuration.toFixed(1)}s`);
    }
    
    // Process each segment
    const segmentVideos: string[] = [];
    
    for (let segIdx = 0; segIdx < segments.length; segIdx++) {
      const segment = segments[segIdx];
      const imageCount = segment.images.length;
      const durations = segment.images.map(img => img.duration);
      
      await updateProgress(`Rendering segment ${segIdx + 1}/${segments.length} (${imageCount} images, ${segment.totalDuration.toFixed(0)}s)...`);
      
      // Build FFmpeg command for this segment
      const command = buildSegmentFfmpegCommand(imageCount, durations, 30);
      
      // Build file inputs (file1..file4)
      const files: Record<string, string> = {};
      for (let i = 0; i < imageCount; i++) {
        files[`file${i + 1}`] = segment.images[i].url;
      }
      
      // Run FFmpeg for this segment
      const segmentUrl = await runCogFfmpeg(
        replicate,
        command,
        files,
        `Segment ${segIdx + 1}/${segments.length}`,
        2 // retries
      );
      
      segmentVideos.push(segmentUrl);
    }
    
    console.log(`[BG] All ${segmentVideos.length} segments rendered successfully`);
    
    // Concatenate segments if more than one
    let slideshowUrl: string;
    
    if (segmentVideos.length === 1) {
      slideshowUrl = segmentVideos[0];
      console.log('[BG] Single segment, no concatenation needed');
    } else {
      await updateProgress(`Concatenating ${segmentVideos.length} segments...`);
      
      // Tree reduction: concat up to 4 at a time until we have 1
      let currentVideos = [...segmentVideos];
      let concatRound = 1;
      
      while (currentVideos.length > 1) {
        const nextRoundVideos: string[] = [];
        
        for (let i = 0; i < currentVideos.length; i += 4) {
          const batch = currentVideos.slice(i, i + 4);
          
          if (batch.length === 1) {
            nextRoundVideos.push(batch[0]);
          } else {
            const concatCommand = buildConcatFfmpegCommand(batch.length);
            const files: Record<string, string> = {};
            for (let j = 0; j < batch.length; j++) {
              files[`file${j + 1}`] = batch[j];
            }
            
            const concatUrl = await runCogFfmpeg(
              replicate,
              concatCommand,
              files,
              `Concat round ${concatRound}, batch ${Math.floor(i / 4) + 1}`,
              2
            );
            
            nextRoundVideos.push(concatUrl);
          }
        }
        
        currentVideos = nextRoundVideos;
        concatRound++;
      }
      
      slideshowUrl = currentVideos[0];
      console.log('[BG] Concatenation complete');
    }
    
    // Final mux: add audio + burn subtitles
    await updateProgress('Final pass: muxing audio and burning subtitles...');
    
    const hasAudio = !!finalAudioUrl;
    const hasSubtitles = !!assFileUrl;
    
    const muxCommand = buildFinalMuxCommand(hasAudio, hasSubtitles);
    const muxFiles: Record<string, string> = {
      file1: slideshowUrl,
    };
    if (hasAudio) muxFiles.file2 = finalAudioUrl!;
    if (hasSubtitles) muxFiles.file3 = assFileUrl!;
    
    const finalVideoUrl = await runCogFfmpeg(
      replicate,
      muxCommand,
      muxFiles,
      'Final mux (audio + subtitles)',
      2
    );
    
    console.log('[BG] Final video generated:', finalVideoUrl);

    // Step 4: Upload final video to storage
    await updateProgress('Uploading final video to storage...');
    let storedVideoUrl: string;
    
    const videoResponse = await fetch(finalVideoUrl);
    if (!videoResponse.ok) {
      throw new Error(`Failed to download final video: ${videoResponse.status}`);
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
      storedVideoUrl = finalVideoUrl; // Use Replicate URL as fallback
    } else {
      const { data: publicUrl } = supabase.storage.from('renders').getPublicUrl(fileName);
      storedVideoUrl = publicUrl.publicUrl;
      console.log('[BG] Video uploaded:', storedVideoUrl);
    }

    // Step 5: Generate SEO metadata
    const lovableApiKey = Deno.env.get('LOVABLE_API_KEY');
    let seoData = { title: '', description: '', keywords: '', hashtags: '' };

    if (lovableApiKey && scenes.length > 0) {
      try {
        await updateProgress('Generating SEO metadata...');
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
        await updateProgress('Generating viral thumbnail...');
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

    // Step 8: Update render record with SUCCESS
    const { error: updateError } = await supabase
      .from('renders')
      .update({
        status: 'completed',
        video_url: storedVideoUrl,
        thumbnail_url: generatedThumbnailUrl,
        seo_title: seoData.title,
        seo_description: seoData.description,
        seo_keywords: seoData.keywords,
        seo_hashtags: seoData.hashtags,
        subtitle_srt: srtContent,
        subtitle_vtt: vttContent,
        error_message: `[SUCCESS] Pipeline=segmented_ffmpeg, Segments=${segments.length}, Images=${totalImages}, Duration=${computedTotalDuration.toFixed(0)}s`,
      })
      .eq('id', renderId);

    if (updateError) {
      console.error('[BG] Update error:', updateError);
    }

    // Update project status
    await supabase
      .from('projects')
      .update({ status: 'completed' })
      .eq('id', projectId);

    console.log(`[BG] Render ${renderId} completed: SUCCESS (segmented pipeline, ${segments.length} segments, ${totalImages} images)`);

  } catch (error) {
    // PHASE 2: NO SILENT FALLBACK - render fails with clear error
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[BG] Render ${renderId} FAILED:`, errorMessage);
    
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    await supabase
      .from('renders')
      .update({
        status: 'failed',
        error_message: `[FAILED] ${errorMessage}`,
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
        error_message: '[STARTED] Initializing segmented FFmpeg pipeline...',
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
