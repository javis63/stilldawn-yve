import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface WordTimestamp {
  word: string;
  start: number;
  end: number;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { audioUrl, chunkIndex, totalChunks } = await req.json();
    
    if (!audioUrl) {
      throw new Error('Missing audioUrl');
    }

    const openaiApiKey = Deno.env.get('OPENAI_API_KEY');
    if (!openaiApiKey) {
      throw new Error('OPENAI_API_KEY is not configured');
    }

    console.log(`Transcribing chunk ${chunkIndex + 1}/${totalChunks}`);
    console.log(`Audio URL: ${audioUrl}`);

    // Fetch audio chunk
    const audioResponse = await fetch(audioUrl);
    if (!audioResponse.ok) {
      throw new Error(`Failed to fetch audio: ${audioResponse.statusText}`);
    }

    const audioData = await audioResponse.arrayBuffer();
    const fileSizeMB = audioData.byteLength / (1024 * 1024);
    console.log(`Chunk size: ${fileSizeMB.toFixed(2)} MB`);

    // Whisper has a 25MB limit
    if (fileSizeMB > 25) {
      throw new Error(`Chunk exceeds 25MB limit (${fileSizeMB.toFixed(1)}MB)`);
    }

    // Create form data for Whisper API - request word-level timestamps
    const formData = new FormData();
    formData.append('file', new Blob([audioData]), `chunk_${chunkIndex}.wav`);
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'word');

    console.log('Calling Whisper API with word timestamps...');

    // Call Whisper API
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
    
    // Extract word-level timestamps
    const words: WordTimestamp[] = [];
    if (transcription.words && Array.isArray(transcription.words)) {
      for (const w of transcription.words) {
        words.push({
          word: w.word || '',
          start: w.start || 0,
          end: w.end || 0,
        });
      }
    }
    
    console.log(`Chunk ${chunkIndex + 1} transcribed: "${transcription.text?.substring(0, 50)}..." (${words.length} words)`);

    return new Response(JSON.stringify({
      success: true,
      text: transcription.text,
      duration: transcription.duration,
      words: words,
      chunkIndex,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Transcription error:', error);
    return new Response(JSON.stringify({ 
      error: errorMessage,
      success: false,
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
