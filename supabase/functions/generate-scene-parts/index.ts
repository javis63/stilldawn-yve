import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface WordTimestamp {
  word: string;
  start: number;
  end: number;
}

interface Part {
  part_number: number;
  start_time: number;
  end_time: number;
  duration: number;
  content: string;
  visual_prompt: string;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { sceneId, projectId } = await req.json();
    
    if (!sceneId || !projectId) {
      throw new Error('Missing sceneId or projectId');
    }

    const lovableApiKey = Deno.env.get('LOVABLE_API_KEY');
    if (!lovableApiKey) {
      throw new Error('LOVABLE_API_KEY is not configured');
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get scene data
    const { data: scene, error: sceneError } = await supabase
      .from('scenes')
      .select('*')
      .eq('id', sceneId)
      .single();

    if (sceneError || !scene) {
      throw new Error(`Scene not found: ${sceneError?.message}`);
    }

    // Get project word timestamps
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('word_timestamps')
      .eq('id', projectId)
      .single();

    if (projectError) {
      throw new Error(`Project not found: ${projectError.message}`);
    }

    const wordTimestamps: WordTimestamp[] = project?.word_timestamps || [];
    const sceneStartTime = Number(scene.start_time);
    const sceneEndTime = Number(scene.end_time);
    const sceneDuration = sceneEndTime - sceneStartTime;
    const narration = scene.narration;

    console.log(`Generating parts for scene ${sceneId}`);
    console.log(`Scene time: ${sceneStartTime}s - ${sceneEndTime}s (${sceneDuration}s)`);
    console.log(`Narration length: ${narration.length} chars`);
    console.log(`Word timestamps available: ${wordTimestamps.length}`);

    // Filter word timestamps for this scene's time range
    const sceneWords = wordTimestamps.filter(
      w => w.start >= sceneStartTime && w.end <= sceneEndTime
    );
    console.log(`Words in scene time range: ${sceneWords.length}`);

    // Calculate target parts (2-5 parts per scene, based on duration)
    const targetParts = Math.min(5, Math.max(2, Math.ceil(sceneDuration / 120))); // ~2 min per part baseline

    const systemPrompt = `You are an expert at breaking down narration into logical story parts for video production.

Your task is to divide the given narration into ${targetParts} distinct parts based on:
- Natural story beats or thematic shifts
- Logical paragraph or section breaks
- Visual scene changes

CRITICAL RULES:
1. Each part MUST contain COMPLETE sentences. NEVER split a sentence between parts.
2. Include the FULL narration text for each part - no truncation, no summaries.
3. Every word from the original narration must appear in exactly one part.

For each part, provide:
1. The EXACT and COMPLETE narration text for that part (full sentences only)
2. A detailed visual prompt (50-80 words) describing a SINGLE cohesive image

CRITICAL: You must return ONLY valid JSON in this exact format:
{
  "parts": [
    {
      "part_number": 1,
      "content": "The exact and complete narration text for this part with full sentences...",
      "visual_prompt": "Detailed visual description of a SINGLE image: lighting, mood, composition, style, camera angle..."
    }
  ]
}

Guidelines for visual prompts:
- NEVER use words like "montage", "cut to", "transition to", "series of", "sequence of", "multiple shots"
- Each prompt must describe ONE single cohesive image that can be generated as a standalone visual
- Be specific: lighting (golden hour, dramatic shadows), mood (tense, serene)
- Include composition: wide establishing shot, close-up, aerial view
- Mention style: photorealistic, cinematic, illustration, oil painting
- Add atmosphere: misty, ethereal, gritty, dreamlike`;

    const userPrompt = `Break this ${Math.round(sceneDuration / 60)} minute scene narration into exactly ${targetParts} logical parts.

NARRATION:
${narration}

Remember: Return ONLY the JSON, no other text. Each part should have distinct content and a unique visual prompt.`;

    console.log('Calling Lovable AI for parts breakdown...');

    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${lovableApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-3-flash-preview',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('AI API error:', errorText);
      throw new Error(`AI API error: ${response.status}`);
    }

    const aiResult = await response.json();
    const content = aiResult.choices?.[0]?.message?.content;
    
    if (!content) {
      throw new Error('No content in AI response');
    }

    console.log('AI response received, parsing...');

    // Parse JSON from response
    let partsData;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        partsData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error('Parse error:', parseError);
      console.error('Raw content:', content);
      throw new Error('Failed to parse AI response as JSON');
    }

    if (!partsData.parts || !Array.isArray(partsData.parts)) {
      throw new Error('Invalid parts data structure');
    }

    // Now calculate timing for each part using word timestamps
    const parts: Part[] = [];
    const rawParts = partsData.parts;
    
    if (sceneWords.length > 0) {
      // Use word timestamps for accurate timing
      const wordsPerPart = Math.ceil(sceneWords.length / rawParts.length);
      
      for (let i = 0; i < rawParts.length; i++) {
        const startWordIdx = i * wordsPerPart;
        const endWordIdx = Math.min((i + 1) * wordsPerPart - 1, sceneWords.length - 1);
        
        const partStartTime = sceneWords[startWordIdx]?.start ?? sceneStartTime;
        const partEndTime = sceneWords[endWordIdx]?.end ?? sceneEndTime;
        
        // For the last part, extend to scene end
        const finalEndTime = i === rawParts.length - 1 ? sceneEndTime : partEndTime;
        
        parts.push({
          part_number: i + 1,
          start_time: Number(partStartTime.toFixed(2)),
          end_time: Number(finalEndTime.toFixed(2)),
          duration: Number((finalEndTime - partStartTime).toFixed(2)),
          content: rawParts[i].content,
          visual_prompt: rawParts[i].visual_prompt,
        });
      }
    } else {
      // Fallback: evenly divide scene duration
      const partDuration = sceneDuration / rawParts.length;
      
      for (let i = 0; i < rawParts.length; i++) {
        const partStart = sceneStartTime + (i * partDuration);
        const partEnd = i === rawParts.length - 1 ? sceneEndTime : partStart + partDuration;
        
        parts.push({
          part_number: i + 1,
          start_time: Number(partStart.toFixed(2)),
          end_time: Number(partEnd.toFixed(2)),
          duration: Number((partEnd - partStart).toFixed(2)),
          content: rawParts[i].content,
          visual_prompt: rawParts[i].visual_prompt,
        });
      }
    }

    console.log(`Generated ${parts.length} parts with timing`);

    // Save parts to scene
    const { error: updateError } = await supabase
      .from('scenes')
      .update({ parts })
      .eq('id', sceneId);

    if (updateError) {
      console.error('Update error:', updateError);
      throw new Error(`Failed to save parts: ${updateError.message}`);
    }

    console.log('Parts saved successfully');

    return new Response(JSON.stringify({
      success: true,
      parts,
      count: parts.length,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Parts generation error:', error);
    return new Response(JSON.stringify({ 
      error: errorMessage,
      success: false,
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
