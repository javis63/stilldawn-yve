import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

      const audioBuffer = await response.arrayBuffer();
      console.log(`Successfully generated ${audioBuffer.byteLength} bytes of audio`);
      return audioBuffer;
      
    } catch (error: any) {
      lastError = error;
      console.error(`TTS attempt ${attempt} failed:`, error.message);
      
      if (attempt < maxRetries) {
        const waitTime = Math.pow(2, attempt - 1) * 1000;
        console.log(`Waiting ${waitTime}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  throw lastError || new Error("TTS generation failed after all retries");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { text, voice, speed, chunkId } = await req.json();

    if (!text) {
      throw new Error("Text is required");
    }

    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_API_KEY) {
      throw new Error("OpenAI API key not configured");
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Supabase configuration missing");
    }

    console.log(`Generating TTS for ${text.length} characters, chunkId: ${chunkId}`);

    // Generate audio with retry logic
    const audioBuffer = await generateTTSWithRetry(
      text,
      voice || "onyx",
      speed || 1.0,
      OPENAI_API_KEY
    );

    // Upload to Supabase Storage
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    
    // Generate unique filename using timestamp and chunkId
    const timestamp = Date.now();
    const uniqueId = chunkId || crypto.randomUUID();
    const filePath = `chunks/${timestamp}_${uniqueId}.mp3`;

    console.log(`Uploading audio to storage: ${filePath}`);

    const { error: uploadError } = await supabase.storage
      .from("audio")
      .upload(filePath, audioBuffer, {
        contentType: "audio/mpeg",
        cacheControl: "3600",
        upsert: true,
      });

    if (uploadError) {
      console.error("Storage upload error:", uploadError);
      throw new Error(`Failed to upload audio: ${uploadError.message}`);
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from("audio")
      .getPublicUrl(filePath);

    console.log(`Audio uploaded successfully: ${urlData.publicUrl}`);

    return new Response(
      JSON.stringify({ 
        audioUrl: urlData.publicUrl,
        byteSize: audioBuffer.byteLength 
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
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
