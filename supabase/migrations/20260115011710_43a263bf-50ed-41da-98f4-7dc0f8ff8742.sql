-- Add parts column for storing AI-generated scene breakdown
ALTER TABLE public.scenes 
ADD COLUMN parts jsonb DEFAULT NULL;

-- Parts structure: [{part_number, start_time, end_time, duration, content, visual_prompt}]
COMMENT ON COLUMN public.scenes.parts IS 'AI-generated breakdown of scene into logical story parts with timing from word timestamps';