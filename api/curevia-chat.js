// api/curevia-chat.js

// ==== Config & constants ======================================================
const OPENAI_API_KEY   = process.env.OPENAI_API_KEY;
const OPENAI_API_BASE  = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";
const OPENAI_MODEL     = process.env.OPENAI_MODEL || "gpt-4o-mini";
const QUICK_ANSWERS_URL = process.env.QUICK_ANSWERS_URL || "";
const MAX_INPUT_LEN    = 2000;            // hårt tak för user input
const OPENAI_TIMEOUT_MS = 12000;          // abort om svar dröjer
const RATE_LIMIT_PER_MIN = 40;            // per IP

const LINKS = {
  demo: "https://calendly.com/tim-curevia/30min",
  regConsult: "https://curevia.ai/consultant/register",
  regProvider: "https://curevia.ai/auth?type=signup&returnTo=/employer/register",
  pricingProviders: "https://preview--vardgig-connect.lovable.app/vardgivare",
};

// ==== Simple in-memory rate limiter ==========================================
const rl = new Map(); // ip -> { count, ts }
function rateLimitOk(ip) {
  const now = Date.now();
  const rec = rl.get(ip) || { count:0, ts:now };
  if (now - rec.ts > 60_000) { rec.count = 0; rec.ts = now; }
  rec.count += 1;
  rl.set(ip, rec);
  return rec.count <= RATE_LIMIT_PER_MIN;
}

// ==== Helpers =================================================================
function normalize(str="") {
  return str.toLowerCase()
    .replace(/[åä]/g, "a")
    .replace(/ö/g, "o")
    .replace(/[^a-z0-9\s]/g, "")
    .trim();
}

// Fuzzy inklusionsmatchning mellan användartext och {q,a}-lista
function fuzzyFromQAList(message, qaList=[]) {
  const qNorm = normalize(message);
  for (const item of qaList) {
    const q = item?.q; const a = item?.a || item?.reply;
    if (!q || !a) continue;
    const qn = normalize(String(q));
    if (!qn) continue;
    if (qNorm.includes(qn) || qn.includes(qNorm)) return String(a);
  }
  return null;
}

// Nettolönekalkylator (enkel, pedagogisk)
function calcNetFromInvoice(amount) {
  const arbetsgivaravgift = 0.3142; // 31.42 %
  const prelimSkatt = 0.30;         // 30 % (förenklad)
  const brutto = amount / (1 + arbetsgivaravgift);
  const skatt  = brutto * prelimSkatt;
  const netto  = brutto - skatt;
  const fmt = (n)=> Math.round(n).toLocaleString("sv-SE");

  return `Om du fakturerar ca ${amount.toLocaleString("sv-SE")} kr exkl. moms:
- Bruttolön (före skatt): ~${fmt(brutto)} kr
- Preliminär skatt (30%): ~${fmt(skatt)} kr
- Nettolön (efter skatt): ~${fmt(netto)} kr

Obs: förenklad uppskattning – faktisk skatt/avgifter kan variera.`;
}

// Plockar t.ex. “fakturera 50 000” / “fakturerar 50000”
function detectNetSalaryQuestion(msg="") {
  const m = msg.match(/fakturer?a?\s+(\d[\d\s.,]{2,})/i);
  if (!m) return null;
  const amount = parseInt(m[1].replace(/[^\d]/g,""), 10);
  if (Number.isFinite(amount) && amount > 0) return calcNetFromInvoice(amount);
  return null;
}

// Mild “injection shield”: klipp bort typiska systemprompt-fraser i user-input
function dePrompt(msg="") {
  return msg.replace(/^(system:|du är|you are|ignore.*instructions|act as).{0,200}/i, "").trim();
}

function hasSensitive(s=""){
  const pnr = /\b(\d{6}|\d{8})[-+]?\d{4}\b/;  // svensk PNR
  const journal = /journal|anamnes|diagnos|patient/i;
  return pnr.test(s) || journal.test(s);
}

function detectIntent(text=""){
  const t = text.toLowerCase();
  const isProvider = /(vårdgivar|klinik|mottag|region|upphandl|integration|pris|avgift|pilot)/.test(t);
  const isConsult  = /(konsult|uppdrag|ersättn|timlön|bemann|legitimation|profil|sjuksköters|läkar)/.test(t);
  const wantsDemo  = /(demo|visa|boka|möte|genomgång)/.test(t);
  const wantsReg   = /(registrera|skapa konto|signa|ansök)/.test(t);
  if (wantsReg && isProvider) return "register_provider";
  if (wantsReg && isConsult)  return "register_consult";
  if (wantsDemo && isProvider) return "provider_demo";
  if (wantsDemo && isConsult)  return "consult_demo";
  if (isProvider) return "provider";
  if (isConsult)  return "consult";
  return "general";
}

// När bör vi addera CTA automatiskt?
function shouldSuggestCTA(userText, intent) {
  const t = (userText || "").toLowerCase();
  const explicitDemo = /(demo|visa plattformen|genomgång|boka.*möte)/.test(t);

  if (intent === "provider_demo" || intent === "consult_demo") return true;
  if (intent === "provider") {
    return /(pris|avgift|gdpr|integration|onboard|kom igång|hur fungerar|testa)/i.test(t) && explicitDemo;
  }
  if (intent === "consult") {
    return /(uppdrag|ersättn|timlön|kom igång|registrera|hur fungerar)/i.test(t) && !/(nej|inte nu)/.test(t);
  }
  return explicitDemo;
}

function polishReply(text, intent="general", addCTA=false){
  if (!text) return `Vill du veta mer? Jag visar gärna 🌟 ${LINKS.demo}`;

  // Max 3 meningar
  const parts = text.replace(/\s+/g," ")
    .split(/(?<=[.!?])\s+/).filter(Boolean).slice(0,3);
  let msg = parts.join(" ");

  // Lägg inte CTA om svaret redan har länk/CTA
  const hasLink = /(https?:\/\/|boka.*demo|registrera|curevia\.ai|calendly\.com)/i.test(msg);

  if (addCTA && !hasLink) {
    if (intent.startsWith("provider")) msg += ` Vill du kika tillsammans? Boka gärna en kort demo 🌟 ${LINKS.demo}`;
    else if (intent.startsWith("consult")) msg += ` Vill du komma igång? Registrera dig här 💙 ${LINKS.regConsult}`;
    else msg += ` Vill du veta mer? Jag visar gärna 🌟 ${LINKS.demo}`;
  }
  return msg;
}

// === System prompt ============================================================
const SYSTEM_PROMPT = `Du är Curevia-boten. Svara kort, vänligt och konkret på svenska.

• Föreslå “Boka demo” ENDAST när användaren uttryckligen ber om demo, vill “se plattformen”, ”visa mer”, eller bekräftar att de vill titta i en genomgång.
• Om användaren vill bli kontaktad (t.ex. “kontakta mig”, “ring upp”, “hör av er”): erbjud “Kontakta mig” och initiera kontaktflödet (öppna formulär). Säg kort att vi hör av oss inom kort.
• Ställ hellre en förtydligande fråga än att pusha demo.
• Ge aldrig råd som innehåller personnummer eller journalinformation; hänvisa till säker kanal.
• Ton: varm, proffsig och lösningsorienterad. Max 2–3 meningar per svar.
`;

// === Quick Answers (regex m.m.) ==============================================
const DEFAULT_QA = [
  { pattern: /eget bolag|företag/i,
    reply: `Du behöver inte ha eget bolag – du kan få betalt via Curevia eller fakturera själv om du vill. Registrera konsultprofil: ${LINKS.regConsult}` },
  { pattern: /utbetal/i,
    reply: `Utbetalning via Curevia sker när vårdgivaren betalat. Har du eget bolag fakturerar du själv, vanligtvis med 30 dagars betalvillkor.` },
  { pattern: /inte betalar|försenad betal|betalningspåminn/i,
    reply: `Om en vårdgivare är sen driver Curevia ärendet till påminnelse, inkasso och vid behov Kronofogden – du ska känna dig trygg att få betalt.` },
  { pattern: /kostnad|pris|avgift|prislista/i,
    reply: `Att testa är gratis – de tre första uppdragen per år är kostnadsfria. Därefter låg avgift. Prislista: ${LINKS.pricingProviders}` },
  { pattern: /onboard|komma igång|starta|hur börjar/i,
    reply: `Skapa ett uppdrag och välj bland intresserade konsulter – en kundansvarig hjälper er hela vägen.` },
  { pattern: /registrera.*(vårdgiv|klinik|mottag)/i,
    reply: `Registrera vårdgivare: ${LINKS.regProvider}` },
  { pattern: /registrera.*(konsult|sjuksköters|läkar|vård)/i,
    reply: `Registrera konsult: ${LINKS.regConsult}` },
  // OBS: Ingen direkt demo-push här – hanteras via shouldSuggestCTA
];

let qaCache = null;
async function loadQuickAnswers(force=false){
  if (!force && qaCache) return qaCache;
  const list = [...DEFAULT_QA];

  if (QUICK_ANSWERS_URL && /^https?:\/\//i.test(QUICK_ANSWERS_URL)) {
    try{
      const r = await fetch(QUICK_ANSWERS_URL, { cache:"no-store" });
      if (r.ok){
        const extra = await r.json();
        for (const item of extra){
          if (item?.pattern && (item?.reply || item?.a)) {
            list.push({ pattern: new RegExp(item.pattern, "i"), reply: String(item.reply || item.a) });
          }
        }
      }
    }catch{/* tyst fallback */}
  }
  qaCache = list;
  return qaCache;
}

// === HTTP handler =============================================================
export default async function handler(req, res) {
  // Basic CORS & security headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(204).end();

  const ip = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").toString().split(",")[0].trim();
  if (!rateLimitOk(ip)) return res.status(429).json({ error: "Too Many Requests" });

  if (req.method === "GET"){
    if (req.url?.includes("reload=1")) qaCache = null;
    const qa = await loadQuickAnswers();
    return res.json({
      ok:true,
      route:"/api/curevia-chat",
      qaCount:qa.length,
      hasKey:Boolean(OPENAI_API_KEY),
      model: OPENAI_MODEL
    });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try{
    // Safe body parse (limit size)
    const bodyRaw = await new Promise((resolve, reject) => {
      let d=""; 
      req.on("data", c => {
        d += c;
        if (d.length > 10 * 1024) { // 10KB rå tak
          reject(new Error("Payload too large"));
          try { req.destroy(); } catch {}
        }
      });
      req.on("end", () => resolve(d || "{}"));
      req.on("error", reject);
    });

    let parsed;
    try { parsed = JSON.parse(bodyRaw); }
    catch { return res.status(400).json({ error:"Invalid JSON body" }); }

    let { message = "" } = parsed;
    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error:"Missing 'message' string" });
    }

    // Trim & clamp
    message = dePrompt(message).slice(0, MAX_INPUT_LEN);

    // Sensitivt innehåll
    if (hasSensitive(message)) {
      return res.json({
        reply: "Jag kan tyvärr inte ta emot person- eller journaluppgifter här. Hör av dig via en säker kanal så hjälper vi dig vidare 💙"
      });
    }

    // Direkt: nettolönefråga?
    const net = detectNetSalaryQuestion(message);
    if (net) {
      const intentNet = detectIntent(message);
      return res.json({ reply: polishReply(net, intentNet, shouldSuggestCTA(message, intentNet)) });
    }

    // Intent & quick answers
    const intent = detectIntent(message);
    if (intent === "register_provider") {
      return res.json({ reply: polishReply(`Här kan du registrera din verksamhet: ${LINKS.regProvider}`, intent, false) });
    }
    if (intent === "register_consult") {
      return res.json({ reply: polishReply(`Toppen! Registrera din konsultprofil här: ${LINKS.regConsult}`, intent, false) });
    }

    const qa = await loadQuickAnswers();
    const hit = qa.find(q => q.pattern.test(message));
    if (hit) {
      return res.json({ reply: polishReply(hit.reply, intent, shouldSuggestCTA(message,intent)) });
    }

    // Fuzzy fallback på {q,a}
    const fuzzyHit = fuzzyFromQAList(message, qa.map(x => ({ q: x.pattern.source, a: x.reply })));
    if (fuzzyHit) {
      return res.json({ reply: polishReply(fuzzyHit, intent, shouldSuggestCTA(message,intent)) });
    }

    // OpenAI fallback
    if (!OPENAI_API_KEY) return res.status(500).json({ error:"Missing OPENAI_API_KEY" });

    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

    const payload = {
      model: OPENAI_MODEL,
      messages: [
        { role:"system", content: `${SYSTEM_PROMPT}\nMål för svaret: ${
          intent.startsWith("provider") ? `Hjälp vårdgivare vidare på ett vänligt sätt. CTA endast om det känns naturligt.` :
          intent.startsWith("consult")  ? `Hjälp konsulten vidare på ett vänligt sätt. CTA endast om det känns naturligt.` :
                                          `Ge ett kort, vänligt svar. CTA endast om det känns naturligt.`
        }` },
        { role:"user", content: message }
      ],
      temperature: 0.4,
      max_tokens: 220
    };

    const r = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
      method:"POST",
      headers:{ "Authorization":`Bearer ${OPENAI_API_KEY}`, "Content-Type":"application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    }).catch(e => { throw (e.name === "AbortError" ? new Error("Upstream timeout") : e); });
    clearTimeout(to);

    let data;
    try { data = await r.json(); }
    catch { return res.status(502).json({ error:"Upstream parse error" }); }

    if (!r.ok) {
      return res.status(502).json({ error: data || "Upstream error" });
    }

    const raw = data?.choices?.[0]?.message?.content?.trim() || "";
    const reply = polishReply(raw, intent, shouldSuggestCTA(message,intent));
    return res.json({ reply });

  } catch(e){
    return res.status(500).json({ error:String(e?.message || e) });
  }
}
