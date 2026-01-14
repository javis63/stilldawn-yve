-- Add project_type enum
CREATE TYPE project_type AS ENUM ('narration', 'music');

-- Add project_type column to projects table with default
ALTER TABLE public.projects 
ADD COLUMN project_type project_type NOT NULL DEFAULT 'narration';