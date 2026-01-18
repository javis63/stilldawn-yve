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

/**
 * Generate FCPXML for Final Cut Pro / DaVinci Resolve import
 */
export function generateFCPXML(projectTitle: string, scenes: Scene[], audioDuration: number, audioFilename: string): string {
  const fps = 24;
  const frameRate = `${fps}/1s`;
  
  const secondsToFCPTime = (seconds: number): string => {
    const frames = Math.round(seconds * fps);
    return `${frames}/${fps}s`;
  };

  const totalFrames = Math.ceil(audioDuration * fps);
  
  let clipItems = '';
  scenes.forEach((scene, index) => {
    const filename = `${(index + 1).toString().padStart(3, '0')}_scene.jpg`;
    const startFrames = Math.round(scene.start_time * fps);
    const durationFrames = Math.round((scene.end_time - scene.start_time) * fps);
    
    clipItems += `
        <clip name="${filename}" offset="${secondsToFCPTime(scene.start_time)}" duration="${secondsToFCPTime(scene.end_time - scene.start_time)}">
          <video ref="r${index + 2}" offset="0s" duration="${secondsToFCPTime(scene.end_time - scene.start_time)}">
            <param name="Ken Burns" key="crop" value="1 0 0 0"/>
          </video>
        </clip>`;
  });

  let resourceRefs = `
    <asset id="r1" name="${audioFilename}" src="file://./${audioFilename}" duration="${secondsToFCPTime(audioDuration)}" hasAudio="1"/>`;
  
  scenes.forEach((scene, index) => {
    const filename = `${(index + 1).toString().padStart(3, '0')}_scene.jpg`;
    resourceRefs += `
    <asset id="r${index + 2}" name="${filename}" src="file://./images/${filename}" duration="${secondsToFCPTime(scene.end_time - scene.start_time)}" hasVideo="1"/>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>${resourceRefs}
  </resources>
  <library>
    <event name="${projectTitle}">
      <project name="${projectTitle}">
        <sequence duration="${secondsToFCPTime(audioDuration)}" format="r0">
          <spine>
            <gap name="Gap" offset="0s" duration="${secondsToFCPTime(audioDuration)}">
              <audio-channel-source srcCh="1, 2" outCh="L, R"/>
            </gap>${clipItems}
          </spine>
          <audio-role-source role="dialogue" offset="0s" duration="${secondsToFCPTime(audioDuration)}">
            <clip name="${audioFilename}" offset="0s" duration="${secondsToFCPTime(audioDuration)}">
              <audio ref="r1" offset="0s" duration="${secondsToFCPTime(audioDuration)}"/>
            </clip>
          </audio-role-source>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>`;
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
  
  // Add images folder
  const images = getSceneImages(scenes);
  const imagesFolder = zip.folder('images');
  
  for (let i = 0; i < images.length; i++) {
    const { filename, url } = images[i];
    onProgress?.('Downloading images', i + 1, images.length);
    
    const blob = await downloadImageAsBlob(url);
    if (blob && imagesFolder) {
      imagesFolder.file(filename, blob);
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
- ${safeName}.edl - Edit Decision List (timeline)
- ${safeName}.fcpxml - Final Cut Pro XML (alternative timeline format)
- ${safeName}_scenes.csv - Scene reference list
- ${safeName}.srt - SRT subtitles
- ${safeName}.vtt - VTT subtitles
- images/ - All scene images (numbered)
${audioUrl ? `- ${audioFilename} - Audio track` : ''}

## Import to DaVinci Resolve:

### Method 1: Using EDL
1. File → Import → Timeline (Import AAF, EDL, XML)
2. Select the .edl file
3. Import your images folder to the Media Pool
4. Right-click timeline → Reconform from Bins
5. DaVinci will match images by filename

### Method 2: Using FCPXML  
1. File → Import → Timeline (Import AAF, EDL, XML)
2. Select the .fcpxml file
3. Make sure images folder is in same location as FCPXML
4. Media should auto-link

### Adding Audio:
1. Import ${audioFilename || 'your audio file'} to Media Pool
2. Drag to audio track on timeline
3. Align to start (00:00:00:00)

### Adding Subtitles:
1. File → Import → Subtitle
2. Select the .srt file
3. Subtitles will appear on subtitle track

## Timecode Reference:
Frame rate: 24fps
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
