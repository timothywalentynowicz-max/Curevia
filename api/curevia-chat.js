// api/curevia-chat.js

// === ENV ===
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";
const QUICK_ANSWERS_URL = process.env.QUICK_ANSWERS_URL || "";

// === LÄNKAR ===
const LINKS = {
  demo: "https://calendly.com/tim-curevia/30min",
  regConsult: "https://curevia.ai/consultant/register",
  regProvider: "https://curevia.ai/auth?type=signup&returnTo=/employer/register",
  pricingProviders: "https://preview--vardgig-connect.lovable.app/vardgivare",
};

// === SYSTEM-PROMPT: varm, kort och hjälpsam ===
const SYSTEM_PROMPT = `
Du är Curevia-boten. Svara alltid kort (2–3 meningar), på svenska, i en varm, lättsam och trygg ton.
Skriv som en hjälpsam kollega – undvik byråkratiska formuleringar. Var konkret och positiv.
Om frågan är oklar: be snällt om förtydligande i en mening.
Viktigt: Hantera aldrig personnummer eller journaldata – avbryt och hänvisa till säker kontakt.
Berätta inte om interna policys; ge bara relevant, praktiskt svar.
`;

// === INBYGGDA QUICK ANSWERS ===
const DEFAULT_QA = [
  {
    pattern: /eget bolag|företag/i,
    reply: `Du behöver inte ha eget bolag – du kan få betalt via Curevia eller fakturera själv om du vill. 👉 Registrera konsultprofil: ${LINKS.regConsult}`
  },
  {
    pattern: /utbetal/i,
    reply: `Utbetalning via Curevia sker när vårdgivaren betalat. Har du eget bolag fakturerar du själv, oftast 30 dagar.`
  },
  {
    pattern: /inte betalar|försenad betal|betalningspåminn/i,
    reply: `Om en vårdgivare inte betalar i tid driver Curevia ärendet vidare till inkasso och därefter Kronofogden – du ska känna dig trygg att få betalt.`
  },
  {
    pattern: /kostnad|pris|avgift|prislista/i,
    reply: `Att testa är gratis – de tre första uppdragen per år är kostnadsfria. Därefter låg avgift. 👉 Prislista: ${LINKS.pricingProviders}`
  },
  {
    pattern: /onboard|komma igång|starta|hur börjar/i,
    reply: `Skapa ett uppdrag och välj bland intresserade konsulter – du får en dedikerad kundansvarig som ser till att allt flyter på.`
  },
  { pattern: /registrera.*(vårdgiv|klinik|mottag)/i, reply: `Registrera vårdgivare: ${LINKS.regProvider}` },
  { pattern: /registrera.*(konsult|sjuksköters|läkar|vård)/i, reply: `Registrera konsult: ${LINKS.regConsult}` },
  { pattern: /boka.*demo|demo|möte|visa/i, reply: `Boka gärna en kort demo så visar vi hur allt funkar: ${LINKS.demo}` },
];

// === LADDA EXTERNA QUICK ANSWERS (Gist/JSON) ===
let qaCache = null;
async function loadQuickAnswers(force = false) {
  if (!force && qaCache) return qaCache;
  const list = [...DEFAULT_QA];
  if (QUICK_ANSWERS_URL) {
    try {
      const r = await fetch(QUICK_ANSWERS_URL, { cache: "no-store" });
      if (r.ok) {
        const extra = await r.json();
        for (const item of extra) {
          if (item?.pattern && item?.reply) {
            list.push({ pattern: new RegExp(item.pattern, "i"), reply: String(item.reply) });
          }
        }
      }
    } catch {
      // Ignorera nätverksfel
    }
  }
  qaCache = list;
  return qaCache;
}

// === HJÄLPFUNKTIONER ===
function hasSensitive(s = "") {
  const pnr = /\b(\d{6}|\d{8})[-+]?\d{4}\b/;
  const journal = /journal|anamnes|diagnos|patient/i;
  return pnr.test(s) || journal.test(s);
}

function detectIntent(text = "") {
  const t = text.toLowerCase();
  const isProvider = /(vårdgivar|klinik|mottag|region|upphandl|integration|pris|avgift|pilot)/.test(t);
  const isConsult  = /(konsult|uppdrag|ersättn|timlön|bemann|legitimation|profil|sjuksköters|läkar)/.test(t);
  const wantsDemo  = /(demo|visa|boka|möte|kontakt)/.test(t);
  const wantsReg   = /(registrera|skapa konto|signa|ansök)/.test(t);
  if (wantsReg && isProvider) return "register_provider";
  if (wantsReg && isConsult)  return "register_consult";
  if (wantsDemo || isProvider) return "provider";
  if (isConsult) return "consult";
  return "general";
}

function goalFor(intent) {
  if (intent === "provider")
    return `Mål: hjälp vårdgivare vidare, gärna till demo (${LINKS.demo}) eller registrering (${LINKS.regProvider}).`;
  if (intent === "consult")
    return `Mål: hjälp konsult/vårdpersonal vidare, gärna till registrering (${LINKS.regConsult}).`;
  return `Mål: ge kort hjälp och föreslå demo vid osäkerhet (${LINKS.demo}).`;
}

// Gör svaret kort (max 3 meningar) och lägg till varm CTA.
function polishReply(text, intent = "general") {
  if (!text) return "Vill du boka en demo så visar jag gärna mer 🌟 " + LINKS.demo;

  // Ta max 3 meningar
  const parts = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean)
    .slice(0, 3);

  let msg = parts.join(" ");

  // Lägg till CTA om det inte redan finns länkar/CTA
  const hasLink = /(https?:\/\/|boka.*demo|registrera)/i.test(msg);
  if (!hasLink) {
    if (intent === "provider") {
      msg += ` Vill du kika tillsammans? Boka gärna en kort demo 🌟 ${LINKS.demo}`;
    } else if (intent === "consult") {
      msg += ` Vill du komma igång? Registrera dig här 💙 ${LINKS.regConsult}`;
    } else {
      msg += ` Vill du veta mer? Jag visar gärna 🌟 ${LINKS.demo}`;
    }
  }
  return msg;
}

// === HANDLER ===
export default async function handler(req, res) {
  // GET: status + ?reload=1 för att ladda om externa QA
  if (req.method === "GET") {
    if (req.url?.includes("reload=1")) qaCache = null;
    const qa = await loadQuickAnswers();
    return res.json({
      ok: true,
      route: "/api/curevia-chat",
      qaCount: qa.length,
      hasKey: Boolean(OPENAI_API_KEY),
    });
  }

  if (req.method !== "POST") return res.status(405).end();

  try {
    // Läs kropp (Node/Vercel)
    const body = await new Promise((resolve, reject) => {
      let d = "";
      req.on("data", (c) => (d += c));
      req.on("end", () => resolve(d || "{}"));
      req.on("error", reject);
    });

    const { message = "" } = JSON.parse(body);

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing 'message' string" });
    }

    if (hasSensitive(message)) {
      return res.json({
        reply:
          "Jag kan tyvärr inte ta emot person- eller journaluppgifter här. Hör av dig via en säker kanal så hjälper vi dig vidare 💙",
      });
    }

    // Intent-genvägar
    const intent = detectIntent(message);
    if (intent === "register_provider")
      return res.json({ reply: polishReply(`Här kan du registrera din verksamhet: ${LINKS.regProvider}`, intent) });
    if (intent === "register_consult")
      return res.json({ reply: polishReply(`Toppen! Registrera din konsultprofil här: ${LINKS.regConsult}`, intent) });

    // Quick answers (snabbt & billigt) – endast om det träffar
    const qa = await loadQuickAnswers();
    const hit = qa.find((qa) => qa.pattern.test(message));
    if (hit) return res.json({ reply: polishReply(hit.reply, intent) });

    // GPT fallback (chat/completions – stabilt)
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    const payload = {
      model: "gpt-4o-mini", // stabil & prisvärd
      messages: [
        { role: "system", content: `${SYSTEM_PROMPT}\n${goalFor(intent)}` },
        { role: "user", content: message },
      ],
      temperature: 0.3,
      max_tokens: 220,
    };

    const r = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json();
    if (!r.ok) {
      return res.status(502).json({ error: data });
    }

    const raw =
      data?.choices?.[0]?.message?.content?.trim() ||
      "Jag hjälper gärna till! Vill du att vi går igenom det ihop? 🌟 " + LINKS.demo;

    return res.json({ reply: polishReply(raw, intent) });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
