import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { sceneId, narration } = await req.json();
    
    if (!sceneId || !narration) {
      throw new Error('Missing sceneId or narration');
    }

    const lovableApiKey = Deno.env.get('LOVABLE_API_KEY');
    if (!lovableApiKey) {
      throw new Error('LOVABLE_API_KEY is not configured');
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log(`Generating visual prompt for scene ${sceneId}`);
    console.log(`Narration length: ${narration.length} chars`);

    const systemPrompt = `You are an expert at creating visual prompts for AI image generators.

Given a script/narration, create a detailed visual prompt (80-120 words) that describes a SINGLE cohesive image suitable for the content.

Guidelines:
- Describe ONE single image, not a sequence or montage
- Be specific about: lighting (golden hour, dramatic shadows, soft diffused), mood (tense, serene, mysterious)
- Include composition: wide establishing shot, medium shot, close-up, aerial view, eye-level
- Mention style: photorealistic, cinematic film still, digital art, oil painting, illustration
- Add atmosphere: misty, ethereal, gritty, dreamlike, vibrant
- Include relevant details about setting, characters, and actions
- NEVER use words like "montage", "sequence", "cut to", "transition", "series of shots"

Return ONLY the visual prompt text, no additional formatting or explanation.`;

    const userPrompt = `Create a visual prompt for this script:

${narration.substring(0, 2000)}`;

    console.log('Calling Lovable AI for visual prompt...');

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
    const visualPrompt = aiResult.choices?.[0]?.message?.content?.trim();
    
    if (!visualPrompt) {
      throw new Error('No content in AI response');
    }

    console.log('Visual prompt generated:', visualPrompt.substring(0, 100) + '...');

    // Save visual prompt to scene
    const { error: updateError } = await supabase
      .from('scenes')
      .update({ visual_prompt: visualPrompt })
      .eq('id', sceneId);

    if (updateError) {
      console.error('Update error:', updateError);
      throw new Error(`Failed to save visual prompt: ${updateError.message}`);
    }

    console.log('Visual prompt saved successfully');

    return new Response(JSON.stringify({
      success: true,
      visual_prompt: visualPrompt,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Visual prompt generation error:', error);
    return new Response(JSON.stringify({ 
      error: errorMessage,
      success: false,
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
