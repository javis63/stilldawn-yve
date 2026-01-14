-- Add progress column to track TTS generation progress
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS progress integer DEFAULT 0;

-- Enable realtime for projects table
ALTER PUBLICATION supabase_realtime ADD TABLE public.projects;