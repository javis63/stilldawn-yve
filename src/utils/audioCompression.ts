/**
 * Audio Compression Utility
 * 
 * Compresses audio files to reduce size while maintaining quality for transcription.
 * Uses Web Audio API to decode and re-encode audio at a lower bitrate.
 * 
 * For long audio (>50 minutes), the compressed file may exceed 25MB but the
 * server will handle chunked transcription automatically.
 */

export interface CompressionProgress {
  stage: 'decoding' | 'encoding' | 'complete';
  progress: number;
  message?: string;
}

export interface CompressionResult {
  blob: Blob;
  originalSize: number;
  compressedSize: number;
  compressionRatio: number;
  duration: number;
}

// Target: 16kHz mono audio is optimal for speech recognition
const TARGET_SAMPLE_RATE = 16000;

/**
 * Check if compression is needed based on file size
 * We compress if over 20MB to reduce upload time and server processing
 */
export function needsCompression(file: File): boolean {
  const MAX_SIZE_MB = 20;
  const fileSizeMB = file.size / (1024 * 1024);
  return fileSizeMB > MAX_SIZE_MB;
}

/**
 * Estimate compressed size based on duration
 * At 16kHz 16-bit mono WAV: ~1.92 MB per minute
 */
export function estimateCompressedSize(durationSeconds: number): number {
  // 16kHz * 2 bytes per sample * 1 channel = 32000 bytes per second
  return 32000 * durationSeconds;
}

/**
 * Compress audio file using Web Audio API
 * Converts to 16kHz mono WAV which is optimal for Whisper transcription
 */
export async function compressAudio(
  file: File,
  onProgress?: (progress: CompressionProgress) => void
): Promise<CompressionResult> {
  const originalSize = file.size;
  
  onProgress?.({ stage: 'decoding', progress: 0, message: 'Reading audio file...' });

  try {
    // Create audio context
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
      sampleRate: TARGET_SAMPLE_RATE,
    });

    // Read file as array buffer
    const arrayBuffer = await file.arrayBuffer();
    onProgress?.({ stage: 'decoding', progress: 30, message: 'Decoding audio...' });

    // Decode audio data
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    onProgress?.({ stage: 'decoding', progress: 60, message: 'Audio decoded' });

    const duration = audioBuffer.duration;
    const durationMinutes = Math.round(duration / 60);
    
    // Log info about long audio
    if (duration > 3000) { // > 50 minutes
      console.log(`Long audio detected (${durationMinutes} minutes). Server will handle chunked transcription.`);
    }

    // Create offline context for rendering
    const offlineContext = new OfflineAudioContext(
      1, // mono
      Math.ceil(audioBuffer.duration * TARGET_SAMPLE_RATE),
      TARGET_SAMPLE_RATE
    );

    // Create buffer source
    const source = offlineContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineContext.destination);
    source.start(0);

    onProgress?.({ stage: 'encoding', progress: 0, message: 'Compressing audio...' });

    // Render to get resampled audio
    const renderedBuffer = await offlineContext.startRendering();
    onProgress?.({ stage: 'encoding', progress: 30, message: 'Encoding WAV...' });

    // Convert to WAV format (universally supported, good for Whisper)
    const wavBlob = audioBufferToWav(renderedBuffer);
    onProgress?.({ stage: 'encoding', progress: 90, message: 'Finalizing...' });

    // Close audio context
    await audioContext.close();

    const compressedSize = wavBlob.size;
    const compressionRatio = originalSize / compressedSize;

    onProgress?.({ stage: 'complete', progress: 100, message: 'Complete' });

    console.log(`Audio compression complete:
      Original: ${(originalSize / (1024 * 1024)).toFixed(2)} MB
      Compressed: ${(compressedSize / (1024 * 1024)).toFixed(2)} MB
      Ratio: ${compressionRatio.toFixed(2)}x
      Duration: ${durationMinutes} minutes`);

    return {
      blob: wavBlob,
      originalSize,
      compressedSize,
      compressionRatio,
      duration,
    };
  } catch (error) {
    console.error('Audio compression failed:', error);
    throw error;
  }
}

/**
 * Convert AudioBuffer to WAV Blob
 * WAV is uncompressed but widely supported and perfect for Whisper
 */
function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;

  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = buffer.length * blockAlign;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const arrayBuffer = new ArrayBuffer(totalSize);
  const view = new DataView(arrayBuffer);

  // Write WAV header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Write audio data
  const channelData = buffer.getChannelData(0);
  let offset = 44;
  
  for (let i = 0; i < buffer.length; i++) {
    // Clamp and convert to 16-bit integer
    const sample = Math.max(-1, Math.min(1, channelData[i]));
    const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
    view.setInt16(offset, intSample, true);
    offset += 2;
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, string: string): void {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

/**
 * Get audio file duration without fully decoding
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
