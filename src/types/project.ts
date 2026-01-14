export type ProjectStatus = 'draft' | 'processing' | 'ready' | 'rendering' | 'completed' | 'error';
export type SceneType = 'image' | 'video';
export type TransitionType = 'crossfade' | 'hard_cut' | 'zoom_in' | 'zoom_out' | 'fade_to_black' | 'slide_left' | 'slide_right';
export type RenderStatus = 'queued' | 'rendering' | 'completed' | 'failed';

export interface Project {
  id: string;
  title: string;
  user_id: string | null;
  audio_url: string | null;
  audio_duration: number | null;
  transcript: string | null;
  status: ProjectStatus;
  progress: number | null;
  created_at: string;
  updated_at: string;
}

export interface Scene {
  id: string;
  project_id: string;
  scene_number: number;
  scene_type: SceneType;
  start_time: number;
  end_time: number;
  narration: string;
  visual_prompt: string | null;
  image_url: string | null;
  video_url: string | null;
  transition: TransitionType;
  created_at: string;
  updated_at: string;
}

export interface Render {
  id: string;
  project_id: string;
  status: RenderStatus;
  video_url: string | null;
  thumbnail_url: string | null;
  duration: number | null;
  subtitle_srt: string | null;
  subtitle_vtt: string | null;
  seo_title: string | null;
  seo_description: string | null;
  seo_keywords: string | null;
  seo_hashtags: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  project?: Project;
}
