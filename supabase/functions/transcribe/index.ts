import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Whisper API has a 25MB limit
const WHISPER_MAX_SIZE = 25 * 1024 * 1024;
// Split audio into 10-minute chunks for processing (keeps each chunk under 25MB)
const CHUNK_DURATION_SECONDS = 600;

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

    // Fetch audio to check size and get content
    const audioResponse = await fetch(audioUrl);
    if (!audioResponse.ok) {
      throw new Error(`Failed to fetch audio: ${audioResponse.statusText}`);
    }

    // Get content length to check file size
    const contentLength = audioResponse.headers.get('content-length');
    const fileSizeBytes = contentLength ? parseInt(contentLength, 10) : 0;
    const fileSizeMB = fileSizeBytes / (1024 * 1024);
    console.log(`Audio file size: ${fileSizeMB.toFixed(2)} MB`);

    // Stream audio to buffer
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
      // Log progress every 10MB
      if (receivedBytes % (10 * 1024 * 1024) < value.length) {
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
    const fileName = urlPath.split('/').pop() || 'audio.wav';

    let transcriptionText: string;
    let audioDuration: number | undefined;

    // Check if file exceeds Whisper limit
    if (receivedBytes > WHISPER_MAX_SIZE) {
      console.log(`File exceeds 25MB limit (${fileSizeMB.toFixed(1)}MB). Using chunked transcription...`);
      
      // For large files, we need to split and transcribe in chunks
      const result = await transcribeInChunks(audioData, fileName, openaiApiKey);
      transcriptionText = result.text;
      audioDuration = result.duration;
    } else {
      // File is within limits, transcribe directly
      const result = await transcribeAudio(audioData, fileName, openaiApiKey);
      transcriptionText = result.text;
      audioDuration = result.duration;
    }

    console.log('Transcription complete:', transcriptionText?.substring(0, 100) + '...');

    // Update project in database
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { error: updateError } = await supabase
      .from('projects')
      .update({
        transcript: transcriptionText,
        audio_duration: audioDuration,
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
      transcript: transcriptionText,
      duration: audioDuration,
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

// Transcribe a single audio buffer
async function transcribeAudio(
  audioData: Uint8Array<ArrayBuffer>, 
  fileName: string, 
  apiKey: string
): Promise<{ text: string; duration?: number }> {
  const formData = new FormData();
  formData.append('file', new Blob([audioData]), fileName);
  formData.append('model', 'whisper-1');
  formData.append('response_format', 'verbose_json');

  console.log(`Calling Whisper API for ${fileName}...`);

  const whisperResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!whisperResponse.ok) {
    const errorText = await whisperResponse.text();
    console.error('Whisper API error:', errorText);
    throw new Error(`Whisper API error: ${whisperResponse.status} - ${errorText}`);
  }

  const result = await whisperResponse.json();
  return {
    text: result.text,
    duration: result.duration
  };
}

// Transcribe large audio by splitting into chunks
async function transcribeInChunks(
  audioData: Uint8Array,
  fileName: string,
  apiKey: string
): Promise<{ text: string; duration: number }> {
  // Parse WAV header to get audio properties
  const view = new DataView(audioData.buffer, audioData.byteOffset, audioData.byteLength);
  
  // Basic WAV validation
  const riff = String.fromCharCode(...audioData.slice(0, 4));
  if (riff !== 'RIFF') {
    throw new Error('Expected WAV file for chunked transcription. Please compress the audio before uploading.');
  }

  // Parse WAV header
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  const numChannels = view.getUint16(22, true);
  const bytesPerSample = bitsPerSample / 8;
  const bytesPerSecond = sampleRate * numChannels * bytesPerSample;
  
  // Find data chunk
  let dataOffset = 12;
  while (dataOffset < audioData.length - 8) {
    const chunkId = String.fromCharCode(...audioData.slice(dataOffset, dataOffset + 4));
    const chunkSize = view.getUint32(dataOffset + 4, true);
    
    if (chunkId === 'data') {
      dataOffset += 8; // Skip chunk header
      break;
    }
    dataOffset += 8 + chunkSize;
  }

  const dataSize = audioData.length - dataOffset;
  const totalDuration = dataSize / bytesPerSecond;
  const chunkSizeBytes = CHUNK_DURATION_SECONDS * bytesPerSecond;
  const numChunks = Math.ceil(dataSize / chunkSizeBytes);

  console.log(`Audio properties: ${sampleRate}Hz, ${bitsPerSample}-bit, ${numChannels} channel(s)`);
  console.log(`Total duration: ${(totalDuration / 60).toFixed(1)} minutes`);
  console.log(`Splitting into ${numChunks} chunks of ${CHUNK_DURATION_SECONDS / 60} minutes each`);

  const transcripts: string[] = [];

  for (let i = 0; i < numChunks; i++) {
    const chunkStart = i * chunkSizeBytes;
    const chunkEnd = Math.min((i + 1) * chunkSizeBytes, dataSize);
    const chunkDataSize = chunkEnd - chunkStart;

    console.log(`Processing chunk ${i + 1}/${numChunks}...`);

    // Create a new WAV file for this chunk
    const chunkHeaderSize = dataOffset;
    const chunkWavSize = chunkHeaderSize + chunkDataSize;
    const chunkWav = new Uint8Array(chunkWavSize);

    // Copy header (modify sizes)
    chunkWav.set(audioData.slice(0, dataOffset), 0);
    
    // Fix RIFF size
    const chunkView = new DataView(chunkWav.buffer);
    chunkView.setUint32(4, chunkWavSize - 8, true);
    
    // Fix data chunk size (find and update it)
    let searchOffset = 12;
    while (searchOffset < dataOffset - 4) {
      const chunkId = String.fromCharCode(...chunkWav.slice(searchOffset, searchOffset + 4));
      if (chunkId === 'data') {
        chunkView.setUint32(searchOffset + 4, chunkDataSize, true);
        break;
      }
      const size = chunkView.getUint32(searchOffset + 4, true);
      searchOffset += 8 + size;
    }

    // Copy audio data
    chunkWav.set(audioData.slice(dataOffset + chunkStart, dataOffset + chunkEnd), dataOffset);

    // Transcribe this chunk
    const chunkResult = await transcribeAudio(
      chunkWav,
      `chunk_${i + 1}.wav`,
      apiKey
    );

    transcripts.push(chunkResult.text);
    console.log(`Chunk ${i + 1}/${numChunks} transcribed: "${chunkResult.text.substring(0, 50)}..."`);
  }

  // Combine all transcripts
  const combinedText = transcripts.join(' ');
  
  return {
    text: combinedText,
    duration: totalDuration
  };
}
