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

// === SYSTEM PROMPT ===
const SYSTEM_PROMPT = `
Du är Curevia-boten. Svara kort och tydligt på svenska.

⚠️ Policy:
- Ta aldrig emot personnummer eller journaltext. Avbryt och hänvisa till säker kontakt.
- Ge inga medicinska råd. Vid osäkerhet: erbjud "Boka demo" (${LINKS.demo}).

🎯 Mål:
- Konsulter/vårdpersonal: guida mot registrering (${LINKS.regConsult}).
- Vårdgivare: guida mot registrering (${LINKS.regProvider}) eller demobokning (${LINKS.demo}).
- Lyft värdet: direktmatchning utan mellanhänder; se CV och betyg. 3 första uppdrag/år gratis, därefter låg avgift (${LINKS.pricingProviders}).

📚 Snabbfakta:
Konsult: Utbetalning via Curevia när vårdgivaren betalat; med eget bolag fakturerar du själv (ofta 30 dagar). Vid utebliven betalning driver Curevia ärendet via inkasso/Kronofogden.
Vårdgivare: Skapa uppdrag → välj bland intresserade konsulter. Dedikerad kundansvarig.
Svarston: kort, trygg, hjälpsam och med tydlig CTA.
`;

// === INBYGGDA QUICK ANSWERS (0 kostnad) ===
const DEFAULT_QA = [
  {
    pattern: /eget bolag|företag/i,
    reply: `Nej, du kan få betalt via Curevia eller genom ditt eget bolag – välj det som passar dig bäst.\n👉 Registrera konsultprofil: ${LINKS.regConsult}`
  },
  {
    pattern: /utbetal/i,
    reply: `Via Curevia sker utbetalning när vårdgivaren betalat Curevia. Med eget bolag fakturerar du själv (vanligen 30 dagar).`
  },
  {
    pattern: /inte betalar|försenad betal|betalningspåminn/i,
    reply: `Om en vårdgivare inte betalar i tid driver Curevia ärendet vidare till inkasso och därefter Kronofogden. Du ska kunna känna dig trygg att arbetet ersätts.`
  },
  {
    pattern: /kostnad|pris|avgift|prislista/i,
    reply: `Att testa är gratis och de tre första uppdragen per år är kostnadsfria. Därefter låg avgift.\n👉 Prisöversikt: ${LINKS.pricingProviders}`
  },
  {
    pattern: /onboard|komma igång|starta|hur börjar/i,
    reply: `Enkelt: skapa ett uppdrag och välj bland intresserade konsulter. Du får en dedikerad kundansvarig som följer upp.`
  },
  { pattern: /registrera.*(vårdgiv|klinik|mottag)/i, reply: `Registrera vårdgivare: ${LINKS.regProvider}` },
  { pattern: /registrera.*(konsult|sjuksköters|läkar|vård)/i, reply: `Registrera konsult: ${LINKS.regConsult}` },
  { pattern: /boka.*demo|demo|möte|visa/i, reply: `Boka demo: ${LINKS.demo}` },
];

// === HÄMTA EXTERNA QUICK ANSWERS (från Gist/JSON) ===
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
    } catch { /* ignorera nätfel */ }
  }
  qaCache = list;
  return qaCache;
}

// === HJÄLP ===
function hasSensitive(s="") {
  const pnr = /\b(\d{6}|\d{8})[-+]?\d{4}\b/;
  const journal = /journal|anamnes|diagnos|patient/i;
  return pnr.test(s) || journal.test(s);
}
function detectIntent(text="") {
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
  if (intent === "provider") return `MÅL: driva vårdgivare till demo (${LINKS.demo}) eller registrering (${LINKS.regProvider}).`;
  if (intent === "consult")  return `MÅL: driva konsult/vårdpersonal till registrering (${LINKS.regConsult}).`;
  return `MÅL: om osäker, föreslå demo (${LINKS.demo}).`;
}

// === HANDLER ===
export default async function handler(req, res) {
  // GET: status + möjlighet att ladda om externa QA via ?reload=1
  if (req.method === "GET") {
    if (req.url?.includes("reload=1")) qaCache = null;
    const qa = await loadQuickAnswers();
    return res.json({ ok: true, route: "/api/curevia-chat", qaCount: qa.length, hasKey: Boolean(OPENAI_API_KEY) });
  }

  if (req.method !== "POST") return res.status(405).end();

  try {
    const body = await new Promise((resolve, reject) => {
      let d=""; req.on("data", c=>d+=c); req.on("end", ()=>resolve(d||"{}")); req.on("error", reject);
    });
    const { message = "" } = JSON.parse(body);

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing 'message' string" });
    }
    if (hasSensitive(message)) {
      return res.json({ reply: "Jag kan inte ta emot person- eller journaluppgifter här. Kontakta oss via säker kanal." });
    }

    // 1) Direkta vägar (utan GPT)
    const intent = detectIntent(message);
    if (intent === "register_provider") return res.json({ reply: `Toppen! Registrera verksamheten här: ${LINKS.regProvider}` });
    if (intent === "register_consult")  return res.json({ reply: `Grymt! Registrera konsultprofil här: ${LINKS.regConsult}` });

    // 2) Quick answers (utan GPT) – endast om det FINNS en träff
    const qa = await loadQuickAnswers();
    const hit = qa.find(qa => qa.pattern.test(message));
    if (hit) return res.json({ reply: hit.reply });

    // 3) GPT-fallback (alltid om inget QA-träff)
    if (!OPENAI_API_KEY) {
      // tydligt fel till oss utvecklare; användare får neutral fallback
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    const payload = {
      model: "gpt-5-mini",
      input: `${SYSTEM_PROMPT}\n\n${goalFor(intent)}\n\nAnvändarens fråga: ${message}`,
      max_output_tokens: 220
    };

    const r = await fetch(`${OPENAI_API_BASE}/responses`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await r.json();
    if (!r.ok) {
      return res.status(502).json({ error: data?.error || data });
    }

    const reply =
      data?.output_text ||
      data?.output?.[0]?.content?.[0]?.text ||
      "Vill du boka en demo så visar jag mer?";

    return res.json({ reply });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
