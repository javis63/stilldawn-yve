import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function generateTTSWithRetry(
  text: string,
  voice: string,
  speed: number,
  apiKey: string,
  maxRetries = 3
): Promise<ArrayBuffer> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`TTS attempt ${attempt}/${maxRetries} for ${text.length} characters`);
      
      const response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "tts-1-hd",
          voice: voice,
          input: text,
          response_format: "mp3",
          speed: speed,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`OpenAI TTS error (attempt ${attempt}):`, errorText);
        throw new Error(`TTS failed: ${errorText}`);
      }

      // Read the response body
      const audioBuffer = await response.arrayBuffer();
      console.log(`Successfully generated ${audioBuffer.byteLength} bytes of audio`);
      return audioBuffer;
      
    } catch (error: any) {
      lastError = error;
      console.error(`TTS attempt ${attempt} failed:`, error.message);
      
      if (attempt < maxRetries) {
        // Wait before retrying (exponential backoff: 1s, 2s, 4s)
        const waitTime = Math.pow(2, attempt - 1) * 1000;
        console.log(`Waiting ${waitTime}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  throw lastError || new Error("TTS generation failed after all retries");
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { text, voice, speed } = await req.json();

    if (!text) {
      throw new Error("Text is required");
    }

    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_API_KEY) {
      throw new Error("OpenAI API key not configured");
    }

    console.log(`Generating TTS for ${text.length} characters`);

    // Generate audio with retry logic
    const audioBuffer = await generateTTSWithRetry(
      text,
      voice || "onyx",
      speed || 1.0,
      OPENAI_API_KEY
    );

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
