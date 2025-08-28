const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";

const SYSTEM_PROMPT = `
Du är Curevia-boten. Svara kort på svenska.
- Hantera inte personnummer eller journaldata. Avbryt och hänvisa till säker kontakt.
- Vid osäkerhet: föreslå "Boka demo" (https://calendly.com/tim-curevia/30min).
- Fakta: Curevia hjälper vårdgivare att minska hyrkostnader, schemalägga smartare och säkra kontinuitet.
- Vårdpersonal: profil → legitimation → uppdrag → ersättning enligt avtal.
`;

export default async function handler(req, res) {
  // Gör GET testbart i browsern
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, route: "/api/curevia-chat" });
  }
  if (req.method !== "POST") return res.status(405).end();

  try {
    // Läs JSON-body i Vercel/Node (req.json finns inte här)
    const raw = await new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => resolve(data || "{}"));
      req.on("error", reject);
    });
    const { message = "" } = JSON.parse(raw);

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    // Enkel block på personnummer
    if (/\b(\d{6}|\d{8})[-+]?\d{4}\b/.test(message)) {
      return res.json({
        reply:
          "Jag kan inte ta emot person- eller journaluppgifter här. Kontakta oss via en säker kanal.",
      });
    }

    const payload = {
      model: "gpt-5-mini",
      input: `${SYSTEM_PROMPT}\n\nAnvändarens fråga: ${message}`,
      max_output_tokens: 220,
    };

    const r = await fetch(`${OPENAI_API_BASE}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json();
    if (!r.ok) {
      // bubbla upp fel från OpenAI så vi ser dem i Vercel logs
      return res.status(500).json({ error: data?.error || data });
    }

    const reply =
      data?.output_text ||
      data?.output?.[0]?.content?.[0]?.text ||
      "Vill du boka en demo så visar jag mer?";
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
