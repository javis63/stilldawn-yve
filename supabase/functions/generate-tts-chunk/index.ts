import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const NARRATOR_STYLE = `You are a cinematic action-thriller narrator.

Voice: low, controlled, authoritative. Calm intensity. Neutral American accent.

Delivery: restrained and realistic—never theatrical, never cartoonish.

Pacing:
- Default: measured, deliberate.
- Tension: slow slightly; add micro-pauses before reveals.
- Action: tighten cadence; slightly faster; crisp consonants.

Emotion:
- Convey danger through emphasis and timing, not volume.
- No melodrama, no comedy, no "announcer voice."

Pauses:
- Short pause at commas.
- Medium pause at sentence ends.
- Longer pause before scene transitions or critical decisions.

Rules:
- Read the provided text exactly as written.
- Do not add sound effects, music cues, or extra words.
- Do not change wording, even if awkward.`;

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { text, voice } = await req.json();

    if (!text) {
      throw new Error("Text is required");
    }

    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_API_KEY) {
      throw new Error("OpenAI API key not configured");
    }

    console.log(`Generating TTS for ${text.length} characters with gpt-4o-mini-tts`);

    // Generate audio using OpenAI's new TTS model with instructions
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: voice || "onyx",
        input: `${NARRATOR_STYLE}\n\n---\n\n${text}`,
        response_format: "mp3",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("OpenAI TTS error:", errorText);
      throw new Error(`TTS failed: ${errorText}`);
    }

    // Return audio as binary
    const audioBuffer = await response.arrayBuffer();

    console.log(`Generated ${audioBuffer.byteLength} bytes of audio`);

    return new Response(audioBuffer, {
      headers: {
        ...corsHeaders,
        "Content-Type": "audio/mpeg",
      },
    });
  } catch (error: any) {
    console.error("Error generating TTS chunk:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
