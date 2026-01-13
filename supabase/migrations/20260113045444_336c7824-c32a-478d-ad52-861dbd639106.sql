-- Create enum for project status
CREATE TYPE public.project_status AS ENUM ('draft', 'processing', 'ready', 'rendering', 'completed', 'error');

-- Create enum for scene type
CREATE TYPE public.scene_type AS ENUM ('image', 'video');

-- Create enum for transition type
CREATE TYPE public.transition_type AS ENUM ('crossfade', 'hard_cut', 'zoom_in', 'zoom_out', 'fade_to_black', 'slide_left', 'slide_right');

-- Create enum for render status
CREATE TYPE public.render_status AS ENUM ('queued', 'rendering', 'completed', 'failed');

-- Projects table
CREATE TABLE public.projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  audio_url TEXT,
  audio_duration DECIMAL,
  transcript TEXT,
  status project_status NOT NULL DEFAULT 'draft',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Scenes table
CREATE TABLE public.scenes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE NOT NULL,
  scene_number INTEGER NOT NULL,
  scene_type scene_type NOT NULL DEFAULT 'image',
  start_time DECIMAL NOT NULL,
  end_time DECIMAL NOT NULL,
  narration TEXT NOT NULL,
  visual_prompt TEXT,
  image_url TEXT,
  video_url TEXT,
  transition transition_type NOT NULL DEFAULT 'crossfade',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(project_id, scene_number)
);

-- Renders table
CREATE TABLE public.renders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE NOT NULL,
  status render_status NOT NULL DEFAULT 'queued',
  video_url TEXT,
  thumbnail_url TEXT,
  duration DECIMAL,
  subtitle_srt TEXT,
  subtitle_vtt TEXT,
  seo_title TEXT,
  seo_description TEXT,
  seo_keywords TEXT,
  seo_hashtags TEXT,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS on all tables (but allow public access for now since no auth)
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scenes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.renders ENABLE ROW LEVEL SECURITY;

-- Public access policies (no auth required for this tool)
CREATE POLICY "Allow public read access on projects" ON public.projects FOR SELECT USING (true);
CREATE POLICY "Allow public insert access on projects" ON public.projects FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public update access on projects" ON public.projects FOR UPDATE USING (true);
CREATE POLICY "Allow public delete access on projects" ON public.projects FOR DELETE USING (true);

CREATE POLICY "Allow public read access on scenes" ON public.scenes FOR SELECT USING (true);
CREATE POLICY "Allow public insert access on scenes" ON public.scenes FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public update access on scenes" ON public.scenes FOR UPDATE USING (true);
CREATE POLICY "Allow public delete access on scenes" ON public.scenes FOR DELETE USING (true);

CREATE POLICY "Allow public read access on renders" ON public.renders FOR SELECT USING (true);
CREATE POLICY "Allow public insert access on renders" ON public.renders FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public update access on renders" ON public.renders FOR UPDATE USING (true);
CREATE POLICY "Allow public delete access on renders" ON public.renders FOR DELETE USING (true);

-- Create storage buckets
INSERT INTO storage.buckets (id, name, public) VALUES ('audio', 'audio', true);
INSERT INTO storage.buckets (id, name, public) VALUES ('images', 'images', true);
INSERT INTO storage.buckets (id, name, public) VALUES ('videos', 'videos', true);
INSERT INTO storage.buckets (id, name, public) VALUES ('renders', 'renders', true);

-- Storage policies for public access
CREATE POLICY "Allow public read access on audio" ON storage.objects FOR SELECT USING (bucket_id = 'audio');
CREATE POLICY "Allow public insert access on audio" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'audio');
CREATE POLICY "Allow public update access on audio" ON storage.objects FOR UPDATE USING (bucket_id = 'audio');
CREATE POLICY "Allow public delete access on audio" ON storage.objects FOR DELETE USING (bucket_id = 'audio');

CREATE POLICY "Allow public read access on images" ON storage.objects FOR SELECT USING (bucket_id = 'images');
CREATE POLICY "Allow public insert access on images" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'images');
CREATE POLICY "Allow public update access on images" ON storage.objects FOR UPDATE USING (bucket_id = 'images');
CREATE POLICY "Allow public delete access on images" ON storage.objects FOR DELETE USING (bucket_id = 'images');

CREATE POLICY "Allow public read access on videos" ON storage.objects FOR SELECT USING (bucket_id = 'videos');
CREATE POLICY "Allow public insert access on videos" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'videos');
CREATE POLICY "Allow public update access on videos" ON storage.objects FOR UPDATE USING (bucket_id = 'videos');
CREATE POLICY "Allow public delete access on videos" ON storage.objects FOR DELETE USING (bucket_id = 'videos');

CREATE POLICY "Allow public read access on renders" ON storage.objects FOR SELECT USING (bucket_id = 'renders');
CREATE POLICY "Allow public insert access on renders" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'renders');
CREATE POLICY "Allow public update access on renders" ON storage.objects FOR UPDATE USING (bucket_id = 'renders');
CREATE POLICY "Allow public delete access on renders" ON storage.objects FOR DELETE USING (bucket_id = 'renders');

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add triggers for updated_at
CREATE TRIGGER update_projects_updated_at BEFORE UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_scenes_updated_at BEFORE UPDATE ON public.scenes FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_renders_updated_at BEFORE UPDATE ON public.renders FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();