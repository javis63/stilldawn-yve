import { Scene } from "@/types/project";
import JSZip from "jszip";

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
 * Convert any image blob to real JPEG using canvas.
 * DaVinci Resolve cannot decode WebP or other formats disguised as .jpg.
 */
async function convertToJpegBlob(blob: Blob): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas context unavailable'));
        return;
      }
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(
        (jpgBlob) => {
          if (jpgBlob) {
            resolve(jpgBlob);
          } else {
            reject(new Error('toBlob returned null'));
          }
        },
        'image/jpeg',
        0.92
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Image load failed'));
    };
    img.src = objectUrl;
  });
}

/**
 * Download an image from URL and return as a true JPEG blob.
 * This ensures DaVinci Resolve can read the file regardless of original format.
 */
async function downloadImageAsBlob(url: string): Promise<Blob | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const originalBlob = await response.blob();

    // Convert to real JPEG so the file matches its .jpg extension
    try {
      return await convertToJpegBlob(originalBlob);
    } catch {
      // Fallback: return original blob if conversion fails
      return originalBlob;
    }
  } catch {
    return null;
  }
}

function getPrimarySceneImageUrl(scene: Scene): string | null {
  if (scene.image_url) return scene.image_url;
  const imageUrls = (scene as any).image_urls as string[] | null | undefined;
  if (!imageUrls || !Array.isArray(imageUrls)) return null;
  const first = imageUrls.find(Boolean);
  return first || null;
}

/**
 * Get all images from scenes with their numbered filenames
 */
export function getSceneImages(scenes: Scene[]): { filename: string; url: string; sceneNumber: number }[] {
  const images: { filename: string; url: string; sceneNumber: number }[] = [];
  
  scenes.forEach((scene, index) => {
    const prefix = (index + 1).toString().padStart(3, '0');

    // Always ensure each scene has a "primary" image named like 001_scene.jpg.
    // Some projects store images only in `image_urls` (and leave `image_url` null).
    // DaVinci timeline generation expects 001_scene.jpg, 002_scene.jpg, etc.
    const primaryUrl = getPrimarySceneImageUrl(scene);
    if (primaryUrl) {
      images.push({
        filename: `${prefix}_scene.jpg`,
        url: primaryUrl,
        sceneNumber: scene.scene_number,
      });
    }

    // Additional images (if any)
    const imageUrls = (scene as any).image_urls as string[] | null | undefined;
    if (imageUrls && Array.isArray(imageUrls)) {
      let extraIndex = 1;
      imageUrls.forEach((url) => {
        if (!url) return;
        if (primaryUrl && url === primaryUrl) return;
        images.push({
          filename: `${prefix}_scene_${extraIndex.toString().padStart(2, '0')}.jpg`,
          url,
          sceneNumber: scene.scene_number,
        });
        extraIndex += 1;
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

/**
 * Generate DaVinci Resolve compatible XML timeline
 * This format places images and audio directly on the timeline
 * Media paths are relative - user must relink after import
 */
export function generateDaVinciXML(projectTitle: string, scenes: Scene[], audioDuration: number, audioFilename: string): string {
  const fps = 24;
  const width = 1920;
  const height = 1080;
  const safeName = projectTitle.replace(/[^a-zA-Z0-9]/g, '_');
  
  // Build asset clips for images
  let imageAssets = '';
  let imageClips = '';
  
  scenes.forEach((scene, index) => {
    const primaryUrl = getPrimarySceneImageUrl(scene);
    if (!primaryUrl) return;

    const filename = `${(index + 1).toString().padStart(3, '0')}_scene.jpg`;
    const assetId = `asset_img_${index + 1}`;
    const startFrame = Math.round(scene.start_time * fps);
    const endFrame = Math.round(scene.end_time * fps);
    const durationFrames = endFrame - startFrame;
    
    // Asset definition - use file:// URI scheme for better DaVinci compatibility.
    imageAssets += `
      <asset id="${assetId}" name="${filename}" start="0s" duration="${durationFrames}/24s" hasVideo="1" format="r1">
        <media-rep kind="original-media" src="file://${filename}"/>
      </asset>`;
    
    // Clip on timeline
    imageClips += `
          <asset-clip name="${filename}" ref="${assetId}" offset="${startFrame}/24s" duration="${durationFrames}/24s" start="0s" format="r1"/>`;
  });
  
  // Audio asset
  const audioDurationFrames = Math.round(audioDuration * fps);

  const hasAudio = Boolean(audioFilename) && audioDurationFrames > 0;

  const audioResource = hasAudio
    ? `
    <asset id="asset_audio" name="${audioFilename}" start="0s" duration="${audioDurationFrames}/24s" hasAudio="1" format="r2">
      <media-rep kind="original-media" src="file://${audioFilename}"/>
    </asset>`
    : "";

  const audioClip = hasAudio
    ? `
          <!-- Audio Track -->
          <asset-clip name="${audioFilename}" ref="asset_audio" lane="-1" offset="0s" duration="${audioDurationFrames}/24s" start="0s" format="r2"/>`
    : "";
  
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="r1" name="FFVideoFormat1080p24" frameDuration="1/24s" width="${width}" height="${height}"/>
    <format id="r2" name="FFAudioFormat48000" sampleRate="48000"/>
    ${imageAssets}
    ${audioResource}
  </resources>
  <library location="file://./">
    <event name="${safeName}">
      <project name="${safeName}">
        <sequence duration="${audioDurationFrames}/24s" format="r1" tcStart="0s" tcFormat="NDF">
          <spine>
            <!-- Video Track - Images -->
            ${imageClips}
          </spine>
          ${audioClip}
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>`;
}

/**
 * Download just the FCPXML file for DaVinci Resolve import
 */
export function downloadFCPXMLFile(
  projectTitle: string,
  scenes: Scene[],
  audioDuration: number,
  audioUrl: string | null
): void {
  const safeName = projectTitle.replace(/[^a-zA-Z0-9]/g, '_');
  const audioFilename = audioUrl ? `${safeName}_audio.mp3` : '';
  
  const fcpxml = generateDaVinciXML(projectTitle, scenes, audioDuration, audioFilename);
  downloadFile(fcpxml, `${safeName}.fcpxml`, 'application/xml');
}

/**
 * Download the media folder as a ZIP (images + audio)
 */
export async function downloadMediaFolder(
  projectTitle: string,
  scenes: Scene[],
  audioUrl: string | null,
  onProgress?: (stage: string, current: number, total: number) => void
): Promise<void> {
  const zip = new JSZip();
  const safeName = projectTitle.replace(/[^a-zA-Z0-9]/g, '_');
  const audioFilename = `${safeName}_audio.mp3`;
  
  // Add images
  const images = getSceneImages(scenes);
  
  for (let i = 0; i < images.length; i++) {
    const { filename, url } = images[i];
    onProgress?.('Downloading images', i + 1, images.length);
    
    const blob = await downloadImageAsBlob(url);
    if (blob) {
      zip.file(filename, blob);
    }
  }
  
  // Add audio file if available
  if (audioUrl) {
    onProgress?.('Downloading audio', 0, 1);
    try {
      const audioResponse = await fetch(audioUrl);
      if (audioResponse.ok) {
        const audioBlob = await audioResponse.blob();
        zip.file(audioFilename, audioBlob);
      }
    } catch (e) {
      console.warn('Failed to include audio in bundle:', e);
    }
  }
  
  onProgress?.('Generating ZIP', 1, 1);
  
  // Generate and download ZIP
  const content = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(content);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeName}_Media.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Generate FCPXML for Final Cut Pro / DaVinci Resolve import (legacy format)
 */
export function generateFCPXML(projectTitle: string, scenes: Scene[], audioDuration: number, audioFilename: string): string {
  // Now just calls the new DaVinci-optimized version
  return generateDaVinciXML(projectTitle, scenes, audioDuration, audioFilename);
}

/**
 * Download a complete ZIP bundle for DaVinci Resolve
 * Includes: EDL, FCPXML, CSV, images folder, subtitles, and optionally audio
 */
export async function downloadDaVinciBundle(
  projectTitle: string,
  scenes: Scene[],
  wordTimestamps: WordTimestamp[],
  audioUrl: string | null,
  audioDuration: number,
  onProgress?: (stage: string, current: number, total: number) => void
): Promise<void> {
  const zip = new JSZip();
  const safeName = projectTitle.replace(/[^a-zA-Z0-9]/g, '_');
  
  // Get audio filename
  const audioFilename = audioUrl ? `${safeName}_audio.mp3` : '';
  
  onProgress?.('Creating project files', 0, 5);
  
  // Add EDL
  const edl = generateEDL(projectTitle, scenes);
  zip.file(`${safeName}.edl`, edl);
  
  // Add FCPXML
  const fcpxml = generateFCPXML(projectTitle, scenes, audioDuration, audioFilename);
  zip.file(`${safeName}.fcpxml`, fcpxml);
  
  // Add CSV
  const csv = generateSceneCSV(projectTitle, scenes);
  zip.file(`${safeName}_scenes.csv`, csv);
  
  onProgress?.('Creating project files', 1, 5);
  
  // Add subtitles
  if (wordTimestamps.length > 0) {
    const srt = generateSRT(wordTimestamps);
    zip.file(`${safeName}.srt`, srt);
    
    const vtt = generateVTT(wordTimestamps);
    zip.file(`${safeName}.vtt`, vtt);
  }
  
  onProgress?.('Creating project files', 2, 5);
  
  // Add images at root level (same folder as FCPXML) for easy auto-linking
  const images = getSceneImages(scenes);
  
  for (let i = 0; i < images.length; i++) {
    const { filename, url } = images[i];
    onProgress?.('Downloading images', i + 1, images.length);
    
    const blob = await downloadImageAsBlob(url);
    if (blob) {
      zip.file(filename, blob);
    }
  }
  
  onProgress?.('Downloading audio', 0, 1);
  
  // Add audio file if available
  if (audioUrl) {
    try {
      const audioResponse = await fetch(audioUrl);
      if (audioResponse.ok) {
        const audioBlob = await audioResponse.blob();
        zip.file(audioFilename, audioBlob);
      }
    } catch (e) {
      console.warn('Failed to include audio in bundle:', e);
    }
  }
  
  onProgress?.('Generating ZIP', 1, 1);
  
  // Add README with instructions
  const readme = `# ${projectTitle} - DaVinci Resolve Import Instructions

## Files Included:
- ${safeName}.edl - Edit Decision List (legacy timeline)
- ${safeName}.fcpxml - DaVinci Resolve Timeline (RECOMMENDED)
- ${safeName}_scenes.csv - Scene reference list
- ${safeName}.srt - SRT subtitles
- ${safeName}.vtt - VTT subtitles
- 001_scene.jpg, 002_scene.jpg, etc. - Scene images
${audioUrl ? `- ${audioFilename} - Audio track` : ''}

## QUICK IMPORT:

### Step 1: Extract the ZIP
Extract this ZIP file to a folder on your computer.
All media files are at the root level alongside the .fcpxml file.

### Step 2: Import to DaVinci Resolve
1. Open DaVinci Resolve
2. File → Import → Timeline
3. Select the .fcpxml file
4. Click "Yes" when prompted to search for clips
5. Navigate to the extracted folder and select it
6. DaVinci will auto-link all images and audio

### Step 3: Verify
- Images should appear on Video Track 1, timed to narration
- Audio should appear on Audio Track 1
- Each image duration matches the script timing

### Adding Subtitles:
1. File → Import → Subtitle
2. Select the .srt file
3. Subtitles will appear aligned with audio

## Troubleshooting:

### Media Offline/Missing:
1. Right-click offline clips in Media Pool
2. Select "Relink Selected Clips..."
3. Navigate to the extracted folder

### Timecode Reference:
- Frame rate: 24fps
- Resolution: 1920x1080
`;
  zip.file('README.txt', readme);
  
  // Generate and download ZIP
  const content = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(content);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeName}_DaVinci_Bundle.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
