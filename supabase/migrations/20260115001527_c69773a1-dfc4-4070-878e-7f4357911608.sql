-- Add image_urls array column to support multiple images per scene
ALTER TABLE public.scenes 
ADD COLUMN image_urls TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Comment for clarity
COMMENT ON COLUMN public.scenes.image_urls IS 'Array of image URLs for multiple images per scene with Ken Burns effects';