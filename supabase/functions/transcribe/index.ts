import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { projectId, audioUrl } = await req.json();
    
    if (!projectId || !audioUrl) {
      throw new Error('Missing projectId or audioUrl');
    }

    const openaiApiKey = Deno.env.get('OPENAI_API_KEY');
    if (!openaiApiKey) {
      throw new Error('OPENAI_API_KEY is not configured');
    }

    console.log(`Starting transcription for project ${projectId}`);
    console.log(`Audio URL: ${audioUrl}`);

    // Stream audio directly to Whisper without buffering entire file in memory
    // This prevents memory limit errors for large audio files
    const audioResponse = await fetch(audioUrl);
    if (!audioResponse.ok) {
      throw new Error(`Failed to fetch audio: ${audioResponse.statusText}`);
    }

    // Get content length to check file size
    const contentLength = audioResponse.headers.get('content-length');
    const fileSizeBytes = contentLength ? parseInt(contentLength, 10) : 0;
    const fileSizeMB = fileSizeBytes / (1024 * 1024);
    console.log(`Audio file size: ${fileSizeMB.toFixed(2)} MB`);

    // Whisper API has a 25MB limit
    if (fileSizeMB > 25) {
      throw new Error(`Audio file too large (${fileSizeMB.toFixed(1)}MB). Whisper API limit is 25MB. Please compress or shorten the audio.`);
    }

    // For files within limits, stream to a buffer and send to Whisper
    const chunks: Uint8Array[] = [];
    const reader = audioResponse.body?.getReader();
    if (!reader) {
      throw new Error('Failed to get audio stream reader');
    }

    let receivedBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      receivedBytes += value.length;
      // Log progress every 5MB
      if (receivedBytes % (5 * 1024 * 1024) < value.length) {
        console.log(`Downloaded ${(receivedBytes / (1024 * 1024)).toFixed(1)}MB...`);
      }
    }

    // Combine chunks
    const audioData = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      audioData.set(chunk, offset);
      offset += chunk.length;
    }
    
    console.log(`Downloaded audio file: ${receivedBytes} bytes`);

    // Determine file extension from URL
    const urlPath = new URL(audioUrl).pathname;
    const fileName = urlPath.split('/').pop() || 'audio.mp3';

    // Create form data for Whisper API
    const formData = new FormData();
    formData.append('file', new Blob([audioData]), fileName);
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'word');
    formData.append('timestamp_granularities[]', 'segment');

    console.log('Calling Whisper API...');

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
    console.log('Transcription complete:', transcription.text?.substring(0, 100) + '...');

    // Update project in database
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { error: updateError } = await supabase
      .from('projects')
      .update({
        transcript: transcription.text,
        audio_duration: transcription.duration,
        status: 'processing',
      })
      .eq('id', projectId);

    if (updateError) {
      console.error('Database update error:', updateError);
      throw new Error(`Failed to update project: ${updateError.message}`);
    }

    console.log('Project updated successfully');

    return new Response(JSON.stringify({
      success: true,
      transcript: transcription.text,
      duration: transcription.duration,
      segments: transcription.segments,
      words: transcription.words,
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
