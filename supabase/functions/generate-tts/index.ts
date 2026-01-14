import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Declare EdgeRuntime for Supabase background tasks
declare const EdgeRuntime: {
  waitUntil: (promise: Promise<unknown>) => void;
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// OpenAI TTS has a limit of 4096 characters per request
const MAX_CHUNK_SIZE = 4000;

function chunkText(text: string, maxSize: number): string[] {
  const chunks: string[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  let currentChunk = '';

  for (const sentence of sentences) {
    if ((currentChunk + sentence).length > maxSize) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
      }
      // If a single sentence is too long, split it by words
      if (sentence.length > maxSize) {
        const words = sentence.split(' ');
        currentChunk = '';
        for (const word of words) {
          if ((currentChunk + ' ' + word).length > maxSize) {
            chunks.push(currentChunk.trim());
            currentChunk = word;
          } else {
            currentChunk = currentChunk ? currentChunk + ' ' + word : word;
          }
        }
      } else {
        currentChunk = sentence;
      }
    } else {
      currentChunk = currentChunk ? currentChunk + ' ' + sentence : sentence;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

async function generateTTSChunk(text: string, apiKey: string, voice: string): Promise<ArrayBuffer> {
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1-hd',
      input: text,
      voice: voice,
      response_format: 'mp3',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`TTS API error: ${response.status} - ${error}`);
  }

  return await response.arrayBuffer();
}

// Background task for long-running TTS generation
async function processLongTTS(
  projectId: string,
  script: string,
  voice: string,
  openaiApiKey: string,
  supabase: any
) {
  try {
    console.log(`[Background] Starting TTS for project ${projectId}`);
    
    // Chunk the script for processing
    const chunks = chunkText(script, MAX_CHUNK_SIZE);
    console.log(`[Background] Split script into ${chunks.length} chunks`);

    // Generate audio for each chunk with progress updates
    const audioBuffers: ArrayBuffer[] = [];
    for (let i = 0; i < chunks.length; i++) {
      console.log(`[Background] Processing chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)`);
      
      const buffer = await generateTTSChunk(chunks[i], openaiApiKey, voice);
      audioBuffers.push(buffer);
      
      // Update progress (TTS is 70% of total work, whisper is 30%)
      const ttsProgress = Math.round(((i + 1) / chunks.length) * 70);
      await supabase
        .from('projects')
        .update({ progress: ttsProgress })
        .eq('id', projectId);
      
      console.log(`[Background] Progress: ${ttsProgress}%`);
    }

    // Combine all audio chunks into a single buffer
    const totalLength = audioBuffers.reduce((acc, buf) => acc + buf.byteLength, 0);
    const combinedBuffer = new Uint8Array(totalLength);
    let offset = 0;
    for (const buffer of audioBuffers) {
      combinedBuffer.set(new Uint8Array(buffer), offset);
      offset += buffer.byteLength;
    }

    console.log(`[Background] Total audio size: ${combinedBuffer.byteLength} bytes`);

    // Upload to Supabase storage
    const filePath = `${projectId}/audio.mp3`;
    const { error: uploadError } = await supabase.storage
      .from('audio')
      .upload(filePath, combinedBuffer, {
        contentType: 'audio/mpeg',
        upsert: true,
      });

    if (uploadError) {
      throw new Error(`Failed to upload audio: ${uploadError.message}`);
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from('audio')
      .getPublicUrl(filePath);

    const audioUrl = urlData.publicUrl;
    console.log(`[Background] Audio uploaded: ${audioUrl}`);

    // Update project with audio URL and script as transcript
    await supabase
      .from('projects')
      .update({
        audio_url: audioUrl,
        transcript: script,
        progress: 75,
      })
      .eq('id', projectId);

    console.log('[Background] TTS generation complete, now transcribing for timestamps...');

    // Now call Whisper to get word-level timestamps
    const audioResponse = await fetch(audioUrl);
    if (!audioResponse.ok) {
      throw new Error(`Failed to download generated audio: ${audioResponse.statusText}`);
    }

    const audioBlob = await audioResponse.blob();
    console.log(`[Background] Downloaded audio for transcription: ${audioBlob.size} bytes`);

    await supabase
      .from('projects')
      .update({ progress: 80 })
      .eq('id', projectId);

    const formData = new FormData();
    formData.append('file', audioBlob, 'audio.mp3');
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'word');
    formData.append('timestamp_granularities[]', 'segment');

    const whisperResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
      },
      body: formData,
    });

    if (!whisperResponse.ok) {
      const errorText = await whisperResponse.text();
      console.error('[Background] Whisper API error:', errorText);
      throw new Error(`Whisper API error: ${whisperResponse.status} - ${errorText}`);
    }

    await supabase
      .from('projects')
      .update({ progress: 95 })
      .eq('id', projectId);

    const transcription = await whisperResponse.json();
    console.log('[Background] Transcription complete, duration:', transcription.duration);
    console.log('[Background] Word timestamps count:', transcription.words?.length || 0);

    // Update project with duration, word timestamps, and mark as ready
    await supabase
      .from('projects')
      .update({
        audio_duration: transcription.duration,
        word_timestamps: transcription.words || [],
        status: 'ready',
        progress: 100,
      })
      .eq('id', projectId);

    console.log(`[Background] Project ${projectId} completed successfully!`);

  } catch (error) {
    console.error('[Background] TTS generation error:', error);
    
    // Update project status to error
    await supabase
      .from('projects')
      .update({
        status: 'error',
        progress: 0,
      })
      .eq('id', projectId);
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { projectId, script, voice = 'onyx' } = await req.json();

    if (!projectId) {
      throw new Error('Missing projectId');
    }

    if (!script || script.trim().length === 0) {
      throw new Error('Missing or empty script');
    }

    const openaiApiKey = Deno.env.get('OPENAI_API_KEY');
    if (!openaiApiKey) {
      throw new Error('OPENAI_API_KEY is not configured');
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log(`Starting TTS generation for project ${projectId}`);
    console.log(`Script length: ${script.length} characters`);
    console.log(`Using voice: ${voice}`);

    // Update project status and reset progress
    await supabase
      .from('projects')
      .update({ status: 'processing', progress: 0 })
      .eq('id', projectId);

    // Calculate estimated chunks for logging
    const estimatedChunks = Math.ceil(script.length / MAX_CHUNK_SIZE);
    console.log(`Estimated ${estimatedChunks} chunks to process`);

    // Use EdgeRuntime.waitUntil for background processing
    // This allows the function to return immediately while processing continues
    EdgeRuntime.waitUntil(
      processLongTTS(projectId, script.trim(), voice, openaiApiKey, supabase)
    );

    // Return immediately with success - processing continues in background
    return new Response(JSON.stringify({
      success: true,
      message: 'TTS generation started in background',
      estimatedChunks,
      projectId,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('TTS generation error:', error);
    return new Response(JSON.stringify({
      error: errorMessage,
      success: false,
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
