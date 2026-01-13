import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
      model: 'tts-1',
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

    // Update project status
    await supabase
      .from('projects')
      .update({ status: 'processing' })
      .eq('id', projectId);

    // Chunk the script for processing
    const chunks = chunkText(script, MAX_CHUNK_SIZE);
    console.log(`Split script into ${chunks.length} chunks`);

    // Generate audio for each chunk
    const audioBuffers: ArrayBuffer[] = [];
    for (let i = 0; i < chunks.length; i++) {
      console.log(`Processing chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)`);
      const buffer = await generateTTSChunk(chunks[i], openaiApiKey, voice);
      audioBuffers.push(buffer);
    }

    // Combine all audio chunks into a single buffer
    const totalLength = audioBuffers.reduce((acc, buf) => acc + buf.byteLength, 0);
    const combinedBuffer = new Uint8Array(totalLength);
    let offset = 0;
    for (const buffer of audioBuffers) {
      combinedBuffer.set(new Uint8Array(buffer), offset);
      offset += buffer.byteLength;
    }

    console.log(`Total audio size: ${combinedBuffer.byteLength} bytes`);

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
    console.log(`Audio uploaded: ${audioUrl}`);

    // Update project with audio URL and script as transcript
    const { error: updateError } = await supabase
      .from('projects')
      .update({
        audio_url: audioUrl,
        transcript: script,
      })
      .eq('id', projectId);

    if (updateError) {
      throw new Error(`Failed to update project: ${updateError.message}`);
    }

    console.log('TTS generation complete, now transcribing for timestamps...');

    // Now call Whisper to get word-level timestamps
    const audioResponse = await fetch(audioUrl);
    if (!audioResponse.ok) {
      throw new Error(`Failed to download generated audio: ${audioResponse.statusText}`);
    }

    const audioBlob = await audioResponse.blob();
    console.log(`Downloaded audio for transcription: ${audioBlob.size} bytes`);

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
      console.error('Whisper API error:', errorText);
      throw new Error(`Whisper API error: ${whisperResponse.status} - ${errorText}`);
    }

    const transcription = await whisperResponse.json();
    console.log('Transcription complete, duration:', transcription.duration);

    // Update project with duration
    await supabase
      .from('projects')
      .update({
        audio_duration: transcription.duration,
        status: 'processing',
      })
      .eq('id', projectId);

    return new Response(JSON.stringify({
      success: true,
      audioUrl: audioUrl,
      duration: transcription.duration,
      segments: transcription.segments,
      words: transcription.words,
      transcript: transcription.text,
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
