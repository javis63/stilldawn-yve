-- Add user_id column to projects table to track ownership
ALTER TABLE public.projects 
ADD COLUMN user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

-- Drop existing permissive policies on projects
DROP POLICY IF EXISTS "Allow public delete access on projects" ON public.projects;
DROP POLICY IF EXISTS "Allow public insert access on projects" ON public.projects;
DROP POLICY IF EXISTS "Allow public read access on projects" ON public.projects;
DROP POLICY IF EXISTS "Allow public update access on projects" ON public.projects;

-- Create owner-only policies for projects
CREATE POLICY "Users can view their own projects"
ON public.projects FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own projects"
ON public.projects FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own projects"
ON public.projects FOR UPDATE
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own projects"
ON public.projects FOR DELETE
TO authenticated
USING (auth.uid() = user_id);

-- Drop existing permissive policies on renders
DROP POLICY IF EXISTS "Allow public delete access on renders" ON public.renders;
DROP POLICY IF EXISTS "Allow public insert access on renders" ON public.renders;
DROP POLICY IF EXISTS "Allow public read access on renders" ON public.renders;
DROP POLICY IF EXISTS "Allow public update access on renders" ON public.renders;

-- Create owner-only policies for renders (via project ownership)
CREATE POLICY "Users can view renders of their projects"
ON public.renders FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.projects 
    WHERE projects.id = renders.project_id 
    AND projects.user_id = auth.uid()
  )
);

CREATE POLICY "Users can create renders for their projects"
ON public.renders FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.projects 
    WHERE projects.id = renders.project_id 
    AND projects.user_id = auth.uid()
  )
);

CREATE POLICY "Users can update renders of their projects"
ON public.renders FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.projects 
    WHERE projects.id = renders.project_id 
    AND projects.user_id = auth.uid()
  )
);

CREATE POLICY "Users can delete renders of their projects"
ON public.renders FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.projects 
    WHERE projects.id = renders.project_id 
    AND projects.user_id = auth.uid()
  )
);

-- Drop existing permissive policies on scenes
DROP POLICY IF EXISTS "Allow public delete access on scenes" ON public.scenes;
DROP POLICY IF EXISTS "Allow public insert access on scenes" ON public.scenes;
DROP POLICY IF EXISTS "Allow public read access on scenes" ON public.scenes;
DROP POLICY IF EXISTS "Allow public update access on scenes" ON public.scenes;

-- Create owner-only policies for scenes (via project ownership)
CREATE POLICY "Users can view scenes of their projects"
ON public.scenes FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.projects 
    WHERE projects.id = scenes.project_id 
    AND projects.user_id = auth.uid()
  )
);

CREATE POLICY "Users can create scenes for their projects"
ON public.scenes FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.projects 
    WHERE projects.id = scenes.project_id 
    AND projects.user_id = auth.uid()
  )
);

CREATE POLICY "Users can update scenes of their projects"
ON public.scenes FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.projects 
    WHERE projects.id = scenes.project_id 
    AND projects.user_id = auth.uid()
  )
);

CREATE POLICY "Users can delete scenes of their projects"
ON public.scenes FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.projects 
    WHERE projects.id = scenes.project_id 
    AND projects.user_id = auth.uid()
  )
);