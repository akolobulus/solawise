import { NextResponse } from "next/server";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

const MAX_MESSAGES = 12;
const MAX_MESSAGE_LENGTH = 2_000;

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) {
    return NextResponse.json({ error: "Requests must come from this app." }, { status: 403 });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "AI assistant is not configured. Add GROQ_API_KEY on the server." },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  if (
    typeof body !== "object" ||
    body === null ||
    !("messages" in body) ||
    !Array.isArray(body.messages) ||
    body.messages.length === 0 ||
    body.messages.length > MAX_MESSAGES
  ) {
    return NextResponse.json(
      { error: `Send between 1 and ${MAX_MESSAGES} chat messages.` },
      { status: 400 },
    );
  }

  const messages: ChatMessage[] = [];
  for (const message of body.messages) {
    if (
      typeof message !== "object" ||
      message === null ||
      !("role" in message) ||
      !("content" in message) ||
      (message.role !== "user" && message.role !== "assistant") ||
      typeof message.content !== "string" ||
      message.content.trim().length === 0 ||
      message.content.length > MAX_MESSAGE_LENGTH
    ) {
      return NextResponse.json(
        { error: "Each message needs a valid role and non-empty text under 2,000 characters." },
        { status: 400 },
      );
    }

    messages.push({ role: message.role, content: message.content.trim() });
  }

  let response: Response;
  try {
    response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content:
              "You are SolaWise Assistant, a warm, concise guide to savings and rotating ajo circles. Give general educational guidance, not individualized financial advice. Never claim a payment, bill, Naira conversion, investment, or ticket succeeded. Never promise returns or instruct the user to share passwords, seed phrases, or private keys. SolaWise currently uses Solana devnet test tokens; explain that every on-chain transaction requires the user's wallet approval. Do not claim to know the user's wallet, balance, or account history unless the user tells you in this conversation. Keep replies under 120 words.",
          },
          ...messages,
        ],
        temperature: 0.4,
        max_tokens: 300,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    console.error("Groq assistant request failed", error);
    return NextResponse.json(
      { error: "Could not reach the AI provider. Please try again." },
      { status: 502 },
    );
  }

  if (!response.ok) {
    console.error("Groq assistant returned an error", { status: response.status });
    return NextResponse.json(
      {
        error:
          response.status === 401
            ? "Groq rejected the API key. Check GROQ_API_KEY."
            : "The AI provider could not complete this request. Please try again.",
      },
      { status: response.status === 401 ? 502 : 503 },
    );
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    return NextResponse.json(
      { error: "The AI provider returned an invalid response." },
      { status: 502 },
    );
  }

  const content =
    typeof result === "object" &&
    result !== null &&
    "choices" in result &&
    Array.isArray(result.choices) &&
    typeof result.choices[0] === "object" &&
    result.choices[0] !== null &&
    "message" in result.choices[0] &&
    typeof result.choices[0].message === "object" &&
    result.choices[0].message !== null &&
    "content" in result.choices[0].message &&
    typeof result.choices[0].message.content === "string"
      ? result.choices[0].message.content.trim()
      : "";

  if (!content) {
    return NextResponse.json(
      { error: "The AI provider returned an empty response." },
      { status: 502 },
    );
  }

  return NextResponse.json({ content });
}
