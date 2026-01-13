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
    const { projectId, transcript, audioDuration } = await req.json();
    
    if (!projectId || !transcript) {
      throw new Error('Missing projectId or transcript');
    }

    const lovableApiKey = Deno.env.get('LOVABLE_API_KEY');
    if (!lovableApiKey) {
      throw new Error('LOVABLE_API_KEY is not configured');
    }

    console.log(`Generating scenes for project ${projectId}`);
    console.log(`Transcript length: ${transcript.length} characters`);
    console.log(`Audio duration: ${audioDuration}s`);

    // Calculate target number of scenes (roughly 1 scene per 10-15 seconds, max 50)
    const targetScenes = Math.min(50, Math.max(5, Math.ceil((audioDuration || 60) / 12)));
    console.log(`Target scenes: ${targetScenes}`);

    const systemPrompt = `You are a video scene breakdown expert. Your job is to break down narration transcripts into visual scenes for video production.

For each scene, you must provide:
1. A scene number (starting from 1)
2. Approximate start and end timestamps (in seconds)
3. The exact narration text for that scene
4. A detailed visual prompt for AI image generation (Midjourney style)

Guidelines for visual prompts:
- Be specific and descriptive (lighting, mood, composition, style)
- Use cinematic language (wide shot, close-up, establishing shot)
- Include atmosphere details (dark, moody, dramatic, ethereal)
- Mention art style when appropriate (photorealistic, cinematic, illustration)
- Keep prompts 50-100 words each

Return ONLY valid JSON in this exact format:
{
  "scenes": [
    {
      "scene_number": 1,
      "start_time": 0,
      "end_time": 12.5,
      "narration": "The exact text from the transcript for this scene",
      "visual_prompt": "Detailed visual description for image generation"
    }
  ]
}`;

    const userPrompt = `Break down this narration into approximately ${targetScenes} visual scenes. The total audio duration is ${audioDuration} seconds.

TRANSCRIPT:
${transcript}

Remember:
- Scenes should flow naturally with the narration
- Each scene should be 8-15 seconds typically
- Visual prompts should be vivid and specific
- Return ONLY the JSON, no other text`;

    console.log('Calling Lovable AI...');

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

    // Parse the JSON from the response
    let scenesData;
    try {
      // Try to extract JSON from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        scenesData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error('Parse error:', parseError);
      console.error('Raw content:', content);
      throw new Error('Failed to parse AI response as JSON');
    }

    if (!scenesData.scenes || !Array.isArray(scenesData.scenes)) {
      throw new Error('Invalid scenes data structure');
    }

    console.log(`Parsed ${scenesData.scenes.length} scenes`);

    // Save scenes to database
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Delete existing scenes for this project
    const { error: deleteError } = await supabase
      .from('scenes')
      .delete()
      .eq('project_id', projectId);

    if (deleteError) {
      console.error('Delete error:', deleteError);
    }

    // Insert new scenes
    const scenesToInsert = scenesData.scenes.map((scene: any) => ({
      project_id: projectId,
      scene_number: scene.scene_number,
      scene_type: 'image',
      start_time: scene.start_time,
      end_time: scene.end_time,
      narration: scene.narration,
      visual_prompt: scene.visual_prompt,
      transition: 'crossfade',
    }));

    const { data: insertedScenes, error: insertError } = await supabase
      .from('scenes')
      .insert(scenesToInsert)
      .select();

    if (insertError) {
      console.error('Insert error:', insertError);
      throw new Error(`Failed to save scenes: ${insertError.message}`);
    }

    // Update project status
    const { error: updateError } = await supabase
      .from('projects')
      .update({ status: 'ready' })
      .eq('id', projectId);

    if (updateError) {
      console.error('Update error:', updateError);
    }

    console.log(`Successfully created ${insertedScenes?.length} scenes`);

    return new Response(JSON.stringify({
      success: true,
      scenes: insertedScenes,
      count: insertedScenes?.length || 0,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Scene generation error:', error);
    return new Response(JSON.stringify({ 
      error: errorMessage,
      success: false,
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
