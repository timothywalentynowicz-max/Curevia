// OBS: FAQ fallback → GPT-5

import { NextRequest } from "next/server";
import { CureviaFAQs, PinnedFAQs } from "@/data/cureviaFaqs";
import { SYSTEM_PROMPT } from "@/ai/systemPrompt";
import { gptClient } from "@/ai/gptClient"; // befintlig klient

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const messages = Array.isArray(body?.messages) ? body.messages : [];

    const last = (messages?.[messages.length - 1]?.content || "").trim();
    const found = CureviaFAQs.find(f => f.q.toLowerCase() === last.toLowerCase());
    if (found) return Response.json({ role: "assistant", content: found.a, pinnedFAQs: PinnedFAQs });

    const gpt = await gptClient.chat({ model: "gpt-5", messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages] });
    return Response.json({ role: "assistant", content: gpt.content, pinnedFAQs: PinnedFAQs });
  } catch (e: any) {
    return Response.json({ role: "assistant", content: "Tekniskt fel – försök igen.", pinnedFAQs: PinnedFAQs }, { status: 200 });
  }
}

