/**
 * Audio Chunking Utility
 * 
 * Splits large audio files into smaller chunks for reliable transcription.
 * Each chunk is compressed to 16kHz mono WAV for optimal Whisper processing.
 */

export interface AudioChunk {
  blob: Blob;
  index: number;
  startTime: number;
  endTime: number;
  duration: number;
}

export interface ChunkingProgress {
  stage: 'decoding' | 'chunking' | 'complete';
  progress: number;
  message: string;
  currentChunk?: number;
  totalChunks?: number;
}

export interface ChunkingResult {
  chunks: AudioChunk[];
  totalDuration: number;
  originalSize: number;
}

// Target settings for transcription-quality audio
const TARGET_SAMPLE_RATE = 16000; // 16kHz is optimal for speech recognition
const TARGET_CHANNELS = 1; // Mono

// 10 minutes per chunk = ~19MB per chunk (well under 25MB Whisper limit)
const CHUNK_DURATION_SECONDS = 600;

/**
 * Check if audio needs to be chunked (over 20MB or over 15 minutes)
 */
export function needsChunking(file: File, durationSeconds?: number): boolean {
  const sizeMB = file.size / (1024 * 1024);
  // Chunk if file is large OR if we know duration is long
  if (sizeMB > 20) return true;
  if (durationSeconds && durationSeconds > 900) return true; // > 15 minutes
  return false;
}

/**
 * Get audio duration from file
 */
export async function getAudioDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    audio.preload = 'metadata';
    
    audio.onloadedmetadata = () => {
      URL.revokeObjectURL(audio.src);
      resolve(audio.duration);
    };
    
    audio.onerror = () => {
      URL.revokeObjectURL(audio.src);
      reject(new Error('Failed to load audio metadata'));
    };
    
    audio.src = URL.createObjectURL(file);
  });
}

/**
 * Split audio file into chunks for transcription
 */
export async function splitAudioIntoChunks(
  file: File,
  onProgress?: (progress: ChunkingProgress) => void
): Promise<ChunkingResult> {
  const originalSize = file.size;
  
  onProgress?.({ stage: 'decoding', progress: 0, message: 'Reading audio file...' });
  
  // Create audio context at target sample rate
  const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
    sampleRate: TARGET_SAMPLE_RATE
  });
  
  try {
    // Read file as array buffer
    const arrayBuffer = await file.arrayBuffer();
    onProgress?.({ stage: 'decoding', progress: 30, message: 'Decoding audio...' });
    
    // Decode audio data
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    onProgress?.({ stage: 'decoding', progress: 100, message: 'Audio decoded' });
    
    const totalDuration = audioBuffer.duration;
    const numChunks = Math.ceil(totalDuration / CHUNK_DURATION_SECONDS);
    
    console.log(`Audio duration: ${(totalDuration / 60).toFixed(1)} minutes`);
    console.log(`Splitting into ${numChunks} chunks of ${CHUNK_DURATION_SECONDS / 60} minutes each`);
    
    const chunks: AudioChunk[] = [];
    
    for (let i = 0; i < numChunks; i++) {
      const startTime = i * CHUNK_DURATION_SECONDS;
      const endTime = Math.min((i + 1) * CHUNK_DURATION_SECONDS, totalDuration);
      const chunkDuration = endTime - startTime;
      
      onProgress?.({ 
        stage: 'chunking', 
        progress: Math.round(((i + 1) / numChunks) * 100),
        message: `Creating chunk ${i + 1} of ${numChunks}...`,
        currentChunk: i + 1,
        totalChunks: numChunks
      });
      
      // Calculate sample positions
      const startSample = Math.floor(startTime * audioBuffer.sampleRate);
      const numSourceSamples = Math.ceil(chunkDuration * audioBuffer.sampleRate);
      const numOutputSamples = Math.ceil(chunkDuration * TARGET_SAMPLE_RATE);
      
      // Create output buffer at target sample rate
      const chunkBuffer = new Float32Array(numOutputSamples);
      
      // Resample and convert to mono
      for (let sample = 0; sample < numOutputSamples; sample++) {
        // Map output sample to source sample
        const sourcePos = (sample / TARGET_SAMPLE_RATE) * audioBuffer.sampleRate;
        const sourceIndex = Math.floor(startSample + sourcePos);
        
        if (sourceIndex < audioBuffer.length) {
          // Average all channels to mono
          let sum = 0;
          for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
            sum += audioBuffer.getChannelData(ch)[sourceIndex] || 0;
          }
          chunkBuffer[sample] = sum / audioBuffer.numberOfChannels;
        }
      }
      
      // Convert to WAV
      const wavBlob = float32ToWav(chunkBuffer, TARGET_SAMPLE_RATE);
      
      chunks.push({
        blob: wavBlob,
        index: i,
        startTime,
        endTime,
        duration: chunkDuration
      });
      
      console.log(`Chunk ${i + 1}: ${startTime.toFixed(1)}s - ${endTime.toFixed(1)}s (${(wavBlob.size / 1024 / 1024).toFixed(1)}MB)`);
    }
    
    onProgress?.({ 
      stage: 'complete', 
      progress: 100, 
      message: `Created ${numChunks} chunks`,
      totalChunks: numChunks
    });
    
    return {
      chunks,
      totalDuration,
      originalSize
    };
  } finally {
    audioContext.close();
  }
}

/**
 * Convert Float32Array to WAV Blob
 */
function float32ToWav(samples: Float32Array, sampleRate: number): Blob {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Write audio data
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
    view.setInt16(offset, int16, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
