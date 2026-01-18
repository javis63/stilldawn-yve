import { Scene } from "@/types/project";

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
