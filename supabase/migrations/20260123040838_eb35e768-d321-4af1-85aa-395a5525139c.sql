-- Create storage bucket for AI-generated scene images
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'scene-images',
  'scene-images',
  true,
  52428800, -- 50MB limit
  ARRAY['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO NOTHING;

-- Allow public read access to scene images
CREATE POLICY "Public read access for scene images"
ON storage.objects FOR SELECT
USING (bucket_id = 'scene-images');

-- Allow authenticated users to upload scene images
CREATE POLICY "Allow uploads to scene-images"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'scene-images');

-- Allow authenticated users to update scene images  
CREATE POLICY "Allow updates to scene-images"
ON storage.objects FOR UPDATE
USING (bucket_id = 'scene-images');

-- Allow authenticated users to delete scene images
CREATE POLICY "Allow deletes from scene-images"
ON storage.objects FOR DELETE
USING (bucket_id = 'scene-images');