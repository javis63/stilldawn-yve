import { Scene } from "@/types/project";

export interface WordTimestamp {
  word: string;
  start: number;
  end: number;
}

/**
 * Convert seconds to SMPTE timecode format (HH:MM:SS:FF)
 * Using 24fps as standard for video editing
 */
function secondsToTimecode(seconds: number, fps: number = 24): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const frames = Math.floor((seconds % 1) * fps);
  
  return [
    hours.toString().padStart(2, '0'),
    minutes.toString().padStart(2, '0'),
    secs.toString().padStart(2, '0'),
    frames.toString().padStart(2, '0'),
  ].join(':');
}

/**
 * Convert seconds to SRT timecode format (HH:MM:SS,mmm)
 */
function secondsToSRTTimecode(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const millis = Math.floor((seconds % 1) * 1000);
  
  return [
    hours.toString().padStart(2, '0'),
    minutes.toString().padStart(2, '0'),
    secs.toString().padStart(2, '0'),
  ].join(':') + ',' + millis.toString().padStart(3, '0');
}

/**
 * Group words into subtitle chunks
 * Groups by: max words per line, max characters, or punctuation breaks
 */
function groupWordsIntoSubtitles(
  words: WordTimestamp[],
  maxWordsPerSubtitle: number = 8,
  maxCharsPerSubtitle: number = 42,
  maxDuration: number = 4
): { text: string; start: number; end: number }[] {
  const subtitles: { text: string; start: number; end: number }[] = [];
  
  let currentWords: WordTimestamp[] = [];
  let currentText = '';
  
  for (const word of words) {
    const wordText = word.word.trim();
    const testText = currentText ? `${currentText} ${wordText}` : wordText;
    const currentDuration = currentWords.length > 0 
      ? word.end - currentWords[0].start 
      : 0;
    
    // Check if we should start a new subtitle
    const shouldBreak = 
      currentWords.length >= maxWordsPerSubtitle ||
      testText.length > maxCharsPerSubtitle ||
      currentDuration > maxDuration ||
      (currentText && /[.!?]$/.test(currentText)); // Break after sentence-ending punctuation
    
    if (shouldBreak && currentWords.length > 0) {
      subtitles.push({
        text: currentText,
        start: currentWords[0].start,
        end: currentWords[currentWords.length - 1].end,
      });
      currentWords = [];
      currentText = '';
    }
    
    currentWords.push(word);
    currentText = currentText ? `${currentText} ${wordText}` : wordText;
  }
  
  // Don't forget the last group
  if (currentWords.length > 0) {
    subtitles.push({
      text: currentText,
      start: currentWords[0].start,
      end: currentWords[currentWords.length - 1].end,
    });
  }
  
  return subtitles;
}

/**
 * Generate SRT subtitle file from word timestamps
 */
export function generateSRT(wordTimestamps: WordTimestamp[]): string {
  if (!wordTimestamps || wordTimestamps.length === 0) {
    return '';
  }
  
  const subtitles = groupWordsIntoSubtitles(wordTimestamps);
  
  return subtitles.map((sub, index) => {
    const num = index + 1;
    const startTC = secondsToSRTTimecode(sub.start);
    const endTC = secondsToSRTTimecode(sub.end);
    
    return `${num}\n${startTC} --> ${endTC}\n${sub.text}\n`;
  }).join('\n');
}

/**
 * Generate VTT subtitle file from word timestamps (alternative format)
 */
export function generateVTT(wordTimestamps: WordTimestamp[]): string {
  if (!wordTimestamps || wordTimestamps.length === 0) {
    return '';
  }
  
  const subtitles = groupWordsIntoSubtitles(wordTimestamps);
  
  const lines = ['WEBVTT', ''];
  
  subtitles.forEach((sub, index) => {
    const startTC = secondsToSRTTimecode(sub.start).replace(',', '.');
    const endTC = secondsToSRTTimecode(sub.end).replace(',', '.');
    
    lines.push(`${index + 1}`);
    lines.push(`${startTC} --> ${endTC}`);
    lines.push(sub.text);
    lines.push('');
  });
  
  return lines.join('\n');
}

/**
 * Generate EDL (Edit Decision List) file content for DaVinci Resolve
 */
export function generateEDL(projectTitle: string, scenes: Scene[]): string {
  const lines: string[] = [
    `TITLE: ${projectTitle}`,
    'FCM: NON-DROP FRAME',
    '',
  ];

  scenes.forEach((scene, index) => {
    const eventNum = (index + 1).toString().padStart(3, '0');
    const clipName = `${eventNum}_scene`;
    
    // Source timecode (always starts at 00:00:00:00 for each clip)
    const sourceIn = '00:00:00:00';
    const sourceOut = secondsToTimecode(scene.end_time - scene.start_time);
    
    // Record timecode (position on timeline)
    const recordIn = secondsToTimecode(scene.start_time);
    const recordOut = secondsToTimecode(scene.end_time);
    
    // EDL event line format:
    // EVENT  REEL  TRACK  EDIT  SOURCE_IN  SOURCE_OUT  RECORD_IN  RECORD_OUT
    lines.push(`${eventNum}  ${clipName}  V     C        ${sourceIn} ${sourceOut} ${recordIn} ${recordOut}`);
    lines.push(`* FROM CLIP NAME: ${clipName}.jpg`);
    
    // Add comment with scene info for reference
    const duration = scene.end_time - scene.start_time;
    lines.push(`* COMMENT: Scene ${scene.scene_number} - Duration: ${Math.round(duration)}s`);
    lines.push('');
  });

  return lines.join('\n');
}

/**
 * Generate a detailed scene list as CSV for reference
 */
export function generateSceneCSV(projectTitle: string, scenes: Scene[]): string {
  const headers = [
    'Scene Number',
    'Filename',
    'Start Time (s)',
    'End Time (s)',
    'Duration (s)',
    'Start Timecode',
    'End Timecode',
    'Visual Prompt',
    'Narration Preview',
  ];

  const rows = scenes.map((scene, index) => {
    const filename = `${(index + 1).toString().padStart(3, '0')}_scene.jpg`;
    const duration = scene.end_time - scene.start_time;
    const narrationPreview = scene.narration.substring(0, 100).replace(/"/g, '""');
    const promptPreview = (scene.visual_prompt || '').substring(0, 100).replace(/"/g, '""');

    return [
      scene.scene_number,
      filename,
      scene.start_time.toFixed(2),
      scene.end_time.toFixed(2),
      duration.toFixed(2),
      secondsToTimecode(scene.start_time),
      secondsToTimecode(scene.end_time),
      `"${promptPreview}"`,
      `"${narrationPreview}"`,
    ].join(',');
  });

  return [headers.join(','), ...rows].join('\n');
}

/**
 * Download a file to the user's computer
 */
export function downloadFile(content: string, filename: string, mimeType: string = 'text/plain') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Download an image from URL and return as blob with proper filename
 */
async function downloadImageAsBlob(url: string): Promise<Blob | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.blob();
  } catch {
    return null;
  }
}

/**
 * Get all images from scenes with their numbered filenames
 */
export function getSceneImages(scenes: Scene[]): { filename: string; url: string; sceneNumber: number }[] {
  const images: { filename: string; url: string; sceneNumber: number }[] = [];
  
  scenes.forEach((scene, index) => {
    const prefix = (index + 1).toString().padStart(3, '0');
    
    // Check for primary image
    if (scene.image_url) {
      images.push({
        filename: `${prefix}_scene.jpg`,
        url: scene.image_url,
        sceneNumber: scene.scene_number,
      });
    }
    
    // Check for additional images in image_urls array
    const imageUrls = (scene as any).image_urls as string[] | undefined;
    if (imageUrls && Array.isArray(imageUrls)) {
      imageUrls.forEach((url, imgIndex) => {
        if (url && url !== scene.image_url) {
          images.push({
            filename: `${prefix}_scene_${(imgIndex + 1).toString().padStart(2, '0')}.jpg`,
            url,
            sceneNumber: scene.scene_number,
          });
        }
      });
    }
  });
  
  return images;
}

/**
 * Download all scene images as individual files
 * Note: Due to browser limitations, each image triggers a separate download
 */
export async function downloadAllImages(
  scenes: Scene[], 
  onProgress?: (current: number, total: number) => void
): Promise<void> {
  const images = getSceneImages(scenes);
  
  for (let i = 0; i < images.length; i++) {
    const { filename, url } = images[i];
    onProgress?.(i + 1, images.length);
    
    const blob = await downloadImageAsBlob(url);
    if (blob) {
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
      
      // Small delay to prevent browser from blocking multiple downloads
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
}
