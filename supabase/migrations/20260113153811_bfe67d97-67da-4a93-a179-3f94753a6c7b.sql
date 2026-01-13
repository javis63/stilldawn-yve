-- Add thumbnail selection to projects table
ALTER TABLE public.projects 
ADD COLUMN IF NOT EXISTS thumbnail_scene_id UUID REFERENCES public.scenes(id) ON DELETE SET NULL;

-- Add comment for clarity
COMMENT ON COLUMN public.projects.thumbnail_scene_id IS 'Scene ID whose image will be used as the base for YouTube thumbnail generation';