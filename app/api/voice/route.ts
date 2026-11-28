import { NextResponse } from "next/server";

const MAX_TEXT_LENGTH = 2_000;

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) {
    return NextResponse.json(
      { error: "Requests must come from this app." },
      { status: 403 },
    );
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!apiKey || !voiceId) {
    return NextResponse.json(
      {
        error:
          "Voice replies are not configured. Add ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID on the server.",
      },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const text =
    typeof body === "object" &&
    body !== null &&
    "text" in body &&
    typeof body.text === "string"
      ? body.text.trim()
      : "";
  if (!text || text.length > MAX_TEXT_LENGTH) {
    return NextResponse.json(
      { error: `Text must be between 1 and ${MAX_TEXT_LENGTH} characters.` },
      { status: 400 },
    );
  }

  let response: Response;
  try {
    response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch (error) {
    console.error("ElevenLabs speech request failed", error);
    return NextResponse.json(
      { error: "Could not reach ElevenLabs. Please try again." },
      { status: 502 },
    );
  }

  if (!response.ok) {
    console.error("ElevenLabs returned an error", { status: response.status });
    return NextResponse.json(
      {
        error:
          response.status === 401 || response.status === 403
            ? "ElevenLabs rejected the server credentials. Check the API key and voice ID."
            : "ElevenLabs could not generate this voice reply. Please try again.",
      },
      { status: response.status === 401 || response.status === 403 ? 502 : 503 },
    );
  }

  return new Response(response.body, {
    headers: {
      "Content-Type": response.headers.get("content-type") || "audio/mpeg",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
