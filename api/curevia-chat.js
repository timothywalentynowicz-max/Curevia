// api/curevia-chat.js — v3 (Stabil + WOW: RAG + Redis persistence + Actions + SSE)
// -------------------------------------------------------------
// ENV (set these in your environment):
// OPENAI_API_KEY               = sk-...
// OPENAI_API_BASE              = https://api.openai.com/v1  (optional)
// OPENAI_MODEL                 = gpt-4o-mini                (optional)
// OPENAI_EMBED_MODEL           = text-embedding-3-small     (optional)
// CONTACT_WEBHOOK_URL          = https://... (optional)
// QUICK_ANSWERS_URL            = https://.../qa.json (optional: [{pattern, reply}])
// RAG_INDEX_URL                = https://.../curevia-rag-index.json (optional; built by /scripts/build-rag-index.mjs)
// UPSTASH_REDIS_REST_URL       = https://us1-...upstash.io
// UPSTASH_REDIS_REST_TOKEN     = <token>
// -------------------------------------------------------------

const OPENAI_API_KEY    = process.env.OPENAI_API_KEY;
const OPENAI_API_BASE   = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";
const OPENAI_MODEL      = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_EMBED_MODEL= process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";
const QUICK_ANSWERS_URL = process.env.QUICK_ANSWERS_URL || "";
const CONTACT_WEBHOOK_URL = process.env.CONTACT_WEBHOOK_URL || "";
const RAG_INDEX_URL     = process.env.RAG_INDEX_URL || "";

const MAX_INPUT_LEN     = 2000;
const OPENAI_TIMEOUT_MS = 18000;
const RATE_LIMIT_PER_MIN = 40;

const LINKS = {
  demo: "https://calendly.com/tim-curevia/30min",
  regConsult: "https://curevia.ai/consultant/register",
  regProvider: "https://curevia.ai/auth?type=signup&returnTo=/employer/register",
  pricingProviders: "https://preview--vardgig-connect.lovable.app/vardgivare",
};

const ACTIONS = {
  OPEN_URL: "open_url",
  OPEN_CONTACT_FORM: "open_contact_form",
};

const SCHEMA_VERSION = "3.0.0";

// ===== Utilities =====
const rl = new Map(); // ip -> { count, ts }
function rateLimitOk(ip) {
  const now = Date.now();
  const rec = rl.get(ip) || { count:0, ts:now };
  if (now - rec.ts > 60_000) { rec.count = 0; rec.ts = now; }
  rec.count += 1;
  rl.set(ip, rec);
  return rec.count <= RATE_LIMIT_PER_MIN;
}

function normalize(str="") {
  return str.toLowerCase()
    .replace(/[åä]/g, "a")
    .replace(/ö/g, "o")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function languageOf(s=""){
  const t = s.toLowerCase();
  const svHits = /är|hur|vad|vill|kan|demo|boka|vårdgiv|konsult|registrera|pris|avgift|fakturer|moms/.test(t);
  const enHits = /(how|what|demo|book|provider|consultant|register|price|fee|invoice|vat)/.test(t);
  if (svHits && !enHits) return "sv";
  if (enHits && !svHits) return "en";
  return "sv";
}

function dePrompt(msg="") {
  return msg.replace(/^(system:|du är|you are|ignore.*instructions|act as).{0,200}/i, "").trim();
}
function hasSensitive(s=""){
  const pnr = /\b(\d{6}|\d{8})[-+]?\d{4}\b/;  // svensk PNR
  const journal = /journal|anamnes|diagnos|patient/i;
  return pnr.test(s) || journal.test(s);
}

function sendJSON(res, payload){
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(200).send(JSON.stringify(payload));
}

function wantsSSE(req) {
  if (/\bstream=1\b/.test(req.url || "")) return true;
  const accept = String(req.headers["accept"] || "");
  return accept.includes("text/event-stream");
}
function sseHeaders(res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
}
function sseSend(res, event, data) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

// ===== Redis (Upstash) — optional, with fallback =====
let redis = null;
async function lazyRedis(){
  if (redis !== null) return redis;
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const { Redis } = await import("@upstash/redis");
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  } else {
    redis = false; // no redis configured
  }
  return redis;
}

async function trackTrendPersist(qNorm, reply){
  const r = await lazyRedis();
  if (!r) return; // no-op
  try {
    await r.hincrby("curevia:trending", qNorm, 1);
    if (reply && reply.length <= 420) {
      await r.hset("curevia:trending:lastReply", { [qNorm]: reply });
    }
  } catch {}
}

async function getPromotedQAFromRedis(limit=10){
  const r = await lazyRedis();
  if (!r) return [];
  try {
    const all = await r.hgetall("curevia:trending");
    const last = await r.hgetall("curevia:trending:lastReply") || {};
    if (!all) return [];
    const entries = Object.entries(all)
      .map(([k,v]) => ({ q: k, n: Number(v)||0, reply: last?.[k] }))
      .filter(x => x.n >= 3 && x.reply && x.reply.length < 420)
      .sort((a,b)=>b.n-a.n)
      .slice(0, limit)
      .map(x => ({ pattern: new RegExp(x.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), "i"), reply: x.reply }));
    return entries;
  } catch {
    return [];
  }
}

async function touchSession(sessionId, patch){
  const r = await lazyRedis();
  if (!r || !sessionId) return;
  try {
    const key = `curevia:sess:${sessionId}`;
    await r.hset(key, { ...patch, lastSeenAt: Date.now() });
    await r.expire(key, 60 * 60 * 24 * 7); // 7 days
  } catch {}
}

// ===== Quick Answers (regex) =====
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
];

let qaCache = null;
async function loadQuickAnswers(force=false){
  if (!force && qaCache) return qaCache;
  const list = [...DEFAULT_QA];

  // promoted from Redis
  const promoted = await getPromotedQAFromRedis(10);
  for (const p of promoted) list.push(p);

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
    }catch{/* silent */}
  }
  qaCache = list;
  return qaCache;
}

function qaChips(){
  return [
    { label: "Hur funkar betalning?", reply: DEFAULT_QA[1].reply },
    { label: "Vad kostar det?", reply: DEFAULT_QA[3].reply },
    { label: "Registrera konsult", reply: `Registrera konsult: ${LINKS.regConsult}` },
    { label: "Registrera vårdgivare", reply: `Registrera vårdgivare: ${LINKS.regProvider}` },
  ];
}

// ===== Net salary calculator =====
function calcNetFromInvoiceExVat(amountExVat, opts={}){
  const ag = Math.max(0, Number(opts.agAvg ?? 0.3142));
  const tax = Math.max(0, Math.min(0.6, Number(opts.taxRate ?? 0.30)));
  const pension = Math.max(0, Number(opts.pension ?? 0));
  const vacation = Math.max(0, Number(opts.vacation ?? 0));
  const brutto = amountExVat / (1 + ag);
  const pensionAmt = brutto * pension;
  const vacationAmt = brutto * vacation;
  const skatt  = (brutto - pensionAmt) * tax;
  const netto  = brutto - skatt - pensionAmt - vacationAmt;
  const fmt = (n)=> Math.round(n).toLocaleString("sv-SE");
  return {
    text: `På faktura ca ${amountExVat.toLocaleString("sv-SE")} kr exkl. moms:
- Bruttolön: ~${fmt(brutto)} kr
- Preliminär skatt (~${Math.round(tax*100)}%): ~${fmt(skatt)} kr
- Tjänstepension (${Math.round(pension*100)}%): ~${fmt(pensionAmt)} kr
- Semesteravsättning (${Math.round(vacation*100)}%): ~${fmt(vacationAmt)} kr
= Nettolön: ~${fmt(netto)} kr

Obs: förenklad uppskattning – procentsatser varierar per kommun och avtal.`,
    brutto, skatt, netto
  };
}

function parseInvoiceAmount(msg=""){
  const m = msg.match(/fakturer[aä]?r?\\s+([\\d\\s.,]{2,})(?:\\s*kr)?(?:\\s*(inkl|exkl)\\s*moms)?/i);
  if (!m) return null;
  const raw = parseInt(String(m[1]).replace(/[^\\d]/g, ""), 10);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const inkl = /inkl\\s*moms/i.test(m[0]);
  const exkl = /exkl\\s*moms/i.test(m[0]);
  let amountExVat = raw;
  if (inkl && !exkl) amountExVat = Math.round(raw / 1.25);
  return amountExVat;
}

// ===== Intent & CTA =====
function detectIntent(text=""){
  const t = text.toLowerCase();
  const isProvider = /(vårdgivar|klinik|mottag|region|upphandl|integration|pris|avgift|pilot)/.test(t);
  const isConsult  = /(konsult|uppdrag|ersättn|timlön|bemann|legitimation|profil|sjuksköters|läkar)/.test(t);
  const wantsDemo  = /(demo|visa|boka|möte|genomgång|walkthrough)/.test(t);
  const wantsReg   = /(registrera|skapa konto|signa|ansök|register)/.test(t);
  const wantsContact = /(kontakta|ring upp|hör av er|hör av dig|contact)/.test(t);

  if (wantsReg && isProvider) return "register_provider";
  if (wantsReg && isConsult)  return "register_consult";
  if (wantsDemo && isProvider) return "provider_demo";
  if (wantsDemo && isConsult)  return "consult_demo";
  if (wantsContact) return "contact_me";
  if (isProvider) return "provider";
  if (isConsult)  return "consult";
  return "general";
}

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
  const safe = (text||"").replace(/\s+/g," ").trim();
  const parts = safe.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0,3);
  let msg = parts.join(" ");
  const hasLink = /(https?:\/\/|boka.*demo|registrera|curevia\.ai|calendly\.com)/i.test(msg);
  if (addCTA && !hasLink) {
    if (intent.startsWith("provider")) msg += ` Vill du kika tillsammans? Boka gärna en kort demo 🌟 ${LINKS.demo}`;
    else if (intent.startsWith("consult")) msg += ` Vill du komma igång? Registrera dig här 💙 ${LINKS.regConsult}`;
    else msg += ` Vill du veta mer? Jag visar gärna 🌟 ${LINKS.demo}`;
  }
  return msg || `Vill du veta mer? Jag visar gärna 🌟 ${LINKS.demo}`;
}

// ===== RAG (optional) =====
let ragIndex = null; // { dims, chunks:[{id,url,title,text,embedding:[...]}] }
async function loadRagIndex(force=false){
  if (!RAG_INDEX_URL) return null;
  if (!force && ragIndex) return ragIndex;
  try{
    const r = await fetch(RAG_INDEX_URL, { cache:"no-store" });
    if (r.ok){
      ragIndex = await r.json();
      return ragIndex;
    }
  }catch{}
  return null;
}

async function embedText(text){
  const r = await fetch(`${OPENAI_API_BASE}/embeddings`, {
    method:"POST",
    headers:{ "Authorization":`Bearer ${OPENAI_API_KEY}`, "Content-Type":"application/json" },
    body: JSON.stringify({
      input: text,
      model: OPENAI_EMBED_MODEL
    })
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Embedding error: " + JSON.stringify(j));
  return j.data?.[0]?.embedding;
}

function cosineSim(a=[], b=[]){
  let dot=0, na=0, nb=0;
  for (let i=0;i<Math.min(a.length,b.length);i++){
    dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na)*Math.sqrt(nb));
}

async function ragRetrieve(query, k=4){
  const idx = await loadRagIndex();
  if (!idx || !idx.chunks?.length || !OPENAI_API_KEY) return { passages: [], citations: [] };
  const qvec = await embedText(query);
  const scored = idx.chunks.map(ch => ({ ch, s: cosineSim(qvec, ch.embedding || []) }))
    .sort((a,b)=>b.s-a.s).slice(0,k);
  const passages = scored.map(x => x.ch.text);
  const citations = scored.map(x => ({ url: x.ch.url, title: x.ch.title || x.ch.url, score: x.s }));
  return { passages, citations };
}

// ===== OpenAI chat =====
const SYSTEM_PROMPT = `Du är Curevia-boten. Svara kort, konkret och i samma språk som användaren (svenska som standard).
• Föreslå “Boka demo” bara när användaren ber om det eller bekräftar att de vill se plattformen.
• Vid “kontakta mig”: erbjud kontaktformulär och säg att vi hör av oss inom kort.
• Dela aldrig person- eller journaluppgifter; be om säker kanal i sådana fall.
• Ton: varm, proffsig, lösningsorienterad. Max 2–3 meningar per svar.
• Om du får relevanta utdrag (KÄLLOR), basera svaret på dem och lägg till korta källhänvisningar (t.ex. [1], [2]).`;

function buildUserPrompt(message, ragPassages, lang){
  if (!ragPassages?.length) return message;
  const joined = ragPassages.map((p,i)=>`[${i+1}] ${p}`).join("\n\n");
  const h = lang === "en" ? "SOURCES" : "KÄLLOR";
  return `${message}\n\n----- ${h} -----\n${joined}`;
}

// ===== HTTP handler =====
export default async function handler(req, res) {
  // CORS & headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Session-Id, Accept, Accept-Language");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();

  const ip = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").toString().split(",")[0].trim();
  if (!rateLimitOk(ip)) return res.status(429).json({ error: "Too Many Requests" });

  const sessionId = String(req.headers["x-session-id"] || "").slice(0, 100) || null;

  if (req.method === "GET"){
    const qa = await loadQuickAnswers();
    await loadRagIndex(); // warm
    return sendJSON(res, {
      ok:true,
      schema: SCHEMA_VERSION,
      route:"/api/curevia-chat",
      qaCount: qa.length,
      suggested: qaChips(),
      hasKey: Boolean(OPENAI_API_KEY),
      ragReady: Boolean(ragIndex),
      model: OPENAI_MODEL,
      streaming: true,
      contactWebhook: Boolean(CONTACT_WEBHOOK_URL)
    });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  // Safe body parse
  let bodyRaw="";
  try{
    bodyRaw = await new Promise((resolve, reject) => {
      let d="";
      req.on("data", c => {
        d += c;
        if (d.length > 128 * 1024) { reject(new Error("Payload too large")); try{req.destroy();}catch{} }
      });
      req.on("end", () => resolve(d || "{}"));
      req.on("error", reject);
    });
  } catch {
    return res.status(413).json({ error: "Payload too large" });
  }

  let parsed;
  try { parsed = JSON.parse(bodyRaw); }
  catch { return res.status(400).json({ error:"Invalid JSON body" }); }

  // Contact submission
  if (parsed?.contact && typeof parsed.contact === "object") {
    const c = parsed.contact;
    if (!c.name || !c.email) return res.status(400).json({ error: "Missing contact.name or contact.email" });
    if (CONTACT_WEBHOOK_URL) {
      try{
        const r = await fetch(CONTACT_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type":"application/json" },
          body: JSON.stringify({ source:"curevia-chat", ip, ts:new Date().toISOString(), sessionId, contact: c })
        });
        if (!r.ok) {
          const txt = await r.text().catch(()=> "");
          return res.status(502).json({ error: "Webhook error", details: txt });
        }
      } catch{
        return res.status(502).json({ error: "Webhook unreachable" });
      }
    }
    return res.status(202).json({ ok:true });
  }

  // Chat flow
  let { message = "", prefs = null, assumptions = null } = parsed;
  if (typeof message !== "string" || !message.trim()) return res.status(400).json({ error:"Missing 'message' string" });
  message = dePrompt(message).slice(0, MAX_INPUT_LEN);

  const lang = languageOf(message);
  if (sessionId) touchSession(sessionId, { lang });

  if (hasSensitive(message)) {
    return sendJSON(res, {
      version: SCHEMA_VERSION,
      reply: lang === 'en'
        ? "I can’t process personal IDs or medical records here. Please use a secure channel 💙"
        : "Jag kan tyvärr inte ta emot person- eller journaluppgifter här. Hör av dig via en säker kanal så hjälper vi dig vidare 💙",
      action: null, url: null, citations: [], confidence: 0.9
    });
  }

  const amountExVat = parseInvoiceAmount(message);
  if (amountExVat) {
    const intentNet = detectIntent(message);
    const { text } = calcNetFromInvoiceExVat(amountExVat, assumptions||{});
    const reply = polishReply(text, intentNet, shouldSuggestCTA(message,intentNet));
    await trackTrendPersist(normalize(message), reply);
    return sendJSON(res, { version:SCHEMA_VERSION, reply, action:null, url:null, citations:[], confidence:0.85 });
  }

  const intent = detectIntent(message);
  if (sessionId) {
    if (intent.startsWith("provider")) touchSession(sessionId, { roleHint:"provider" });
    if (intent.startsWith("consult"))  touchSession(sessionId, { roleHint:"consult" });
  }

  if (intent === "contact_me") {
    const reply = lang === 'en'
      ? "Absolutely! Leave your details and we’ll get back to you shortly."
      : "Absolut! Fyll i dina kontaktuppgifter så hör vi av oss inom kort.";
    await trackTrendPersist(normalize(message), reply);
    return sendJSON(res, { version:SCHEMA_VERSION, reply, action:ACTIONS.OPEN_CONTACT_FORM, url:null, citations:[], confidence:0.95 });
  }
  if (intent === "register_provider") {
    const reply = polishReply(`Här kan du registrera din verksamhet: ${LINKS.regProvider}`, intent, false);
    await trackTrendPersist(normalize(message), reply);
    return sendJSON(res, { version:SCHEMA_VERSION, reply, action:ACTIONS.OPEN_URL, url:LINKS.regProvider, citations:[], confidence:0.95 });
  }
  if (intent === "register_consult") {
    const reply = polishReply(`Toppen! Registrera din konsultprofil här: ${LINKS.regConsult}`, intent, false);
    await trackTrendPersist(normalize(message), reply);
    return sendJSON(res, { version:SCHEMA_VERSION, reply, action:ACTIONS.OPEN_URL, url:LINKS.regConsult, citations:[], confidence:0.95 });
  }
  if (intent === "provider_demo" || intent === "consult_demo") {
    const lead = lang === 'en' ? "Great — let’s book a short demo." : "Toppen – låt oss boka en kort demo.";
    const reply = polishReply(`${lead} ${LINKS.demo}`, intent, false);
    await trackTrendPersist(normalize(message), reply);
    return sendJSON(res, { version:SCHEMA_VERSION, reply, action:ACTIONS.OPEN_URL, url:LINKS.demo, citations:[], confidence:0.98 });
  }

  const qa = await loadQuickAnswers();
  const hit = qa.find(q => q.pattern.test(message));
  if (hit) {
    const reply = polishReply(hit.reply, intent, shouldSuggestCTA(message,intent));
    await trackTrendPersist(normalize(message), reply);
    return sendJSON(res, { version:SCHEMA_VERSION, reply, action:null, url:null, citations:[], confidence:0.9 });
  }

  // RAG retrieve
  let ragPassages = [], citations = [];
  try {
    const r = await ragRetrieve(message, 4);
    ragPassages = r.passages || [];
    citations = (r.citations || []).map((c,i)=>({ id:i+1, url:c.url, title:c.title, score: Number(c.score.toFixed(3)) }));
  } catch { /* ignore RAG errors */ }

  if (!OPENAI_API_KEY){
    return res.status(500).json({ error:"Missing OPENAI_API_KEY" });
  }

  const TOOL_HINT = `\n\nOm du vill föreslå en demo, skriv avslutningsvis exakt [[OPEN_URL:${LINKS.demo}]] (utan extra text).`;

  const sys = `${SYSTEM_PROMPT}\nMål för svaret: ${
    intent.startsWith("provider") ? `Hjälp vårdgivare vidare på ett vänligt sätt. CTA endast om det känns naturligt.` :
    intent.startsWith("consult")  ? `Hjälp konsulten vidare på ett vänligt sätt. CTA endast om det känns naturligt.` :
                                    `Ge ett kort, vänligt svar. CTA endast om det känns naturligt.`
  }${TOOL_HINT}`;

  const userPrompt = buildUserPrompt(message, ragPassages, lang);

  const basePayload = {
    model: OPENAI_MODEL,
    messages: [
      { role:"system", content: sys },
      { role:"user", content: userPrompt }
    ],
    temperature: 0.35,
    max_tokens: 240,
  };

  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    if (wantsSSE(req)) {
      sseHeaders(res);
      sseSend(res, "meta", { model: OPENAI_MODEL, schema: SCHEMA_VERSION, citations });

      const r = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
        method:"POST",
        headers:{ "Authorization":`Bearer ${OPENAI_API_KEY}`, "Content-Type":"application/json" },
        body: JSON.stringify({ ...basePayload, stream:true }),
        signal: controller.signal
      }).catch(e => { throw (e.name === "AbortError" ? new Error("Upstream timeout") : e); });
      if (!r.ok || !r.body) {
        const errTxt = await r.text().catch(()=> "");
        sseSend(res, "error", { error: "Upstream error", details: errTxt });
        res.end(); clearTimeout(to); return;
      }

      const reader = r.body.getReader();
      let full = "";
      const decoder = new TextDecoder();
      let actionSent = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split(/\r?\n/);
        for (const line of lines) {
          if (!line) continue;
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") continue;
            try {
              const json = JSON.parse(data);
              const delta = json.choices?.[0]?.delta?.content || "";
              if (delta) {
                full += delta;
                sseSend(res, "token", delta);
                if (!actionSent && full.includes("[[OPEN_URL:")){
                  const m = full.match(/\[\[OPEN_URL:([^\]]+)\]\]/);
                  if (m && m[1]){ actionSent = true; sseSend(res, "action", { action:ACTIONS.OPEN_URL, url:m[1] }); }
                }
              }
            } catch {}
          }
        }
      }

      clearTimeout(to);
      const cleaned = full.replace(/\[\[OPEN_URL:[^\]]+\]\]/g, "").trim();
      const reply = polishReply(cleaned, intent, shouldSuggestCTA(message,intent));
      await trackTrendPersist(normalize(message), reply);
      sseSend(res, "final", {
        version: SCHEMA_VERSION,
        reply, action: null, url: null,
        citations, confidence: 0.86
      });
      res.end();
      return;

    } else {
      const r = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
        method:"POST",
        headers:{ "Authorization":`Bearer ${OPENAI_API_KEY}`, "Content-Type":"application/json" },
        body: JSON.stringify(basePayload),
        signal: controller.signal
      }).catch(e => { throw (e.name === "AbortError" ? new Error("Upstream timeout") : e); });

      clearTimeout(to);

      let data;
      try { data = await r.json(); }
      catch { return res.status(502).json({ error:"Upstream parse error" }); }
      if (!r.ok) return res.status(502).json({ error: data || "Upstream error" });

      let raw = data?.choices?.[0]?.message?.content?.trim() || "";
      let action = null, url = null;
      const tag = raw.match(/\[\[OPEN_URL:([^\]]+)\]\]/);
      if (tag && tag[1]){ action = ACTIONS.OPEN_URL; url = tag[1]; raw = raw.replace(tag[0], "").trim(); }

      const reply = polishReply(raw, intent, shouldSuggestCTA(message,intent));
      await trackTrendPersist(normalize(message), reply);
      return sendJSON(res, {
        version: SCHEMA_VERSION,
        reply, action, url, citations, confidence: 0.88
      });
    }

  } catch(e){
    clearTimeout(to);
    if (wantsSSE(req)) {
      try { sseSend(res, "error", { error: String(e?.message || e) }); } catch {}
      try { res.end(); } catch {}
      return;
    }
    return res.status(500).json({ error:String(e?.message || e) });
  }
}
