-- Add archived column to projects table
ALTER TABLE public.projects 
ADD COLUMN archived boolean NOT NULL DEFAULT false;

-- Add index for faster filtering
CREATE INDEX idx_projects_archived ON public.projects(archived);