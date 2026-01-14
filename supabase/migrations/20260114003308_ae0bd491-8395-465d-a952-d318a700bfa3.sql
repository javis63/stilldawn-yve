-- Add column to store Whisper word-level timestamps for subtitle sync
ALTER TABLE public.projects 
ADD COLUMN word_timestamps jsonb DEFAULT NULL;