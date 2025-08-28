// --- ENV ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";
// (valfritt) Länk till en extern JSON med fler quick answers, t.ex. en GitHub Gist Raw URL
// Format: [{ "pattern": "regex utan / /i", "reply": "text..." }, ...]
const QUICK_ANSWERS_URL = process.env.QUICK_ANSWERS_URL || ""; 

// --- LÄNKAR / CTA ---
const LINKS = {
  demo: "https://calendly.com/tim-curevia/30min",
  regConsult: "https://curevia.ai/consultant/register",
  regProvider: "https://curevia.ai/auth?type=signup&returnTo=/employer/register",
  pricingProviders: "https://preview--vardgig-connect.lovable.app/vardgivare",
};

// --- SYSTEMPROMPT (cachebar prefix + FAQ) ---
const SYSTEM_PROMPT = `
Du är Curevia-boten. Svara kort och tydligt på svenska.

⚠️ Policy:
- Hantera aldrig personnummer eller journaluppgifter. Avbryt och hänvisa till säker kontakt.
- Ge inga medicinska råd i chatten.
- Vid osäkerhet: erbjud "Boka demo" (${LINKS.demo}).

🎯 Mål:
- Konsulter/vårdpersonal: guida mot registrering (${LINKS.regConsult}).
- Vårdgivare: guida mot registrering (${LINKS.regProvider}) eller demobokning (${LINKS.demo}).
- Lyft värdet: direktmatchning utan mellanhänder; se CV och betyg från tidigare uppdrag.
- Påminn gärna: att testa är gratis och de tre första uppdragen per år är kostnadsfria; därefter låg avgift.

📚 Snabbfakta / FAQ:
KONSULTER
- Behöver jag eget bolag? Nej, du kan få betalt via Curevia eller genom ditt eget bolag.
- Hur fungerar utbetalningen? Via Curevia sker utbetalning automatiskt när vårdgivaren har betalat Curevia. Med eget bolag skickar du själv faktura (vanligen 30 dagar).
- Om vårdgivaren inte betalar i tid? Curevia driver ärendet vidare till inkasso och Kronofogden. Du kan känna dig trygg att ditt arbete blir ersatt.

VÅRDGIVARE
- Vad kostar tjänsten? Att testa är gratis. Tre uppdrag per år är kostnadsfria; därefter låg avgift (se prislista: ${LINKS.pricingProviders}).
- Onboarding? Enkelt: skapa uppdrag → välj bland intresserade konsulter. Dedikerad kundansvarig säkerställer nöjd matchning.

Svarston: Kort, hjälpsam, trygg. Ge tydlig CTA (demo/registrering) när relevant.
`;

// --- SNABBA SVAR (100% korrekta, 0 API-kostnad) ---
const DEFAULT_QUICK_ANSWERS = [
  {
    pattern: /eget bolag|företag/i,
    reply: `Nej, du kan få betalt direkt via Curevia eller genom ditt eget bolag – välj det som passar dig bäst.\n👉 Registrera konsultprofil: ${LINKS.regConsult}`
  },
  {
    pattern: /utbetal/i,
    reply: `Utbetalning via Curevia sker automatiskt när vårdgivaren har betalat Curevia. Har du eget bolag fakturerar du själv (oftast 30 dagars villkor).`
  },
  {
    pattern: /inte betalar|försenad betal|betalningspåminnel|betalningspåminnelse/i,
    reply: `Om en vårdgivare inte betalar i tid driver Curevia ärendet vidare till inkasso och därefter Kronofogden. Du ska kunna känna dig trygg att arbetet ersätts.`
  },
  {
    pattern: /kostnad|pris|avgift/i,
    reply: `Att testa Curevia är gratis och de tre första uppdragen per år är kostnadsfria. Därefter gäller en låg avgift.\n👉 Prisöversikt för vårdgivare: ${LINKS.pricingProviders}`
  },
  {
    pattern: /onboard|komma igång|starta|hur börjar|hur kommer|onboarding/i,
    reply: `Enkelt att komma igång: skapa ett uppdrag och välj bland intresserade konsulter. Du får en dedikerad kundansvarig som säkerställer att du blir nöjd.`
  },
  // Direktvägar:
  { pattern: /registrera.*(vårdgiv|klinik|mottag)/i, reply: `Registrera vårdgivare: ${LINKS.regProvider}` },
  { pattern: /registrera.*(konsult|sjuksköters|läkar|vård)/i, reply: `Registrera konsult: ${LINKS.regConsult}` },
  { pattern: /boka.*demo|demo|möte|visa/i, reply: `Boka demo här: ${LINKS.demo}` },
];

// --- Enkel intent-analys för CTA-mål ---
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

// --- (Valfritt) Ladda fler quick answers från extern JSON ---
let _qaCache = null;
async function getQuickAnswers() {
  if (_qaCache) return _qaCache;
  _qaCache = [...DEFAULT_QUICK_ANSWERS];
  if (QUICK_ANSWERS_URL) {
    try {
      const r = await fetch(QUICK_ANSWERS_URL);
      if (r.ok) {
        const list = await r.json();
        for (const item of list) {
          if (item?.pattern && item?.reply) {
            // Bygg regex med 'i'
            _qaCache.push({ pattern: new RegExp(item.pattern, "i"), reply: String(item.reply) });
          }
        }
      }
    } catch { /* ignorera nätfel */ }
  }
  return _qaCache;
}

// --- Hjälpfunktioner ---
function hasSensitive(s="") {
  const pnr = /\b(\d{6}|\d{8})[-+]?\d{4}\b/; // svensk personnummerform
  const journal = /journal|anamnes|diagnos|patient/i;
  return pnr.test(s) || journal.test(s);
}

function buildGoal(intent) {
  if (intent === "provider") {
    return `MÅL: driva vårdgivare till demobokning (${LINKS.demo}) eller registrering (${LINKS.regProvider}).`;
  }
  if (intent === "consult") {
    return `MÅL: driva konsult/vårdpersonal till registrering (${LINKS.regConsult}).`;
  }
  return `MÅL: om osäker, föreslå demo (${LINKS.demo}).`;
}

// --- Handler ---
export default async function handler(req, res) {
  // GET: enkel hälsokoll så du kan surfa till endpointen
  if (req.method === "GET") {
    const qa = await getQuickAnswers();
    return res.status(200).json({ ok: true, route: "/api/curevia-chat", qaCount: qa.length, hasKey: Boolean(OPENAI_API_KEY) });
  }

  if (req.method !== "POST") return res.status(405).end();

  try {
    // Läs body i Vercel/Node
    const raw = await new Promise((resolve, reject) => {
      let data = ""; req.on("data", (c)=>data+=c); req.on("end", ()=>resolve(data||"{}")); req.on("error", reject);
    });
    const { message = "" } = JSON.parse(raw);

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing 'message' string" });
    }
    if (hasSensitive(message)) {
      return res.json({ reply: "Jag kan inte ta emot person- eller journaluppgifter här. Mejla oss via en säker kanal så hjälper vi dig." });
    }

    // Intent & direkta vägar (utan LLM)
    const intent = detectIntent(message);
    if (intent === "register_provider") {
      return res.json({ reply: `Toppen! Registrera din verksamhet här: ${LINKS.regProvider}` });
    }
    if (intent === "register_consult") {
      return res.json({ reply: `Grymt! Registrera din konsultprofil här: ${LINKS.regConsult}` });
    }

    // Quick answers (utan LLM)
    const quick = await getQuickAnswers();
    for (const qa of quick) {
      if (qa.pattern.test(message)) {
        return res.json({ reply: qa.reply });
      }
    }

    // GPT-fallback (kort & säljdrivet)
    const goal = buildGoal(intent);
    const payload = {
      model: "gpt-5-mini",                // billigt som standard
      input: `${SYSTEM_PROMPT}\n\n${goal}\n\nAnvändarens fråga: ${message}`,
      max_output_tokens: 220
    };

    const r = await fetch(`${OPENAI_API_BASE}/responses`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await r.json();
    if (!r.ok) {
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
