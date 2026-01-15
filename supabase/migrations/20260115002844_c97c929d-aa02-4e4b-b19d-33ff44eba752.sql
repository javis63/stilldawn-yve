-- Add image_durations column to store custom duration for each image in seconds
ALTER TABLE public.scenes ADD COLUMN image_durations numeric[] DEFAULT ARRAY[]::numeric[];