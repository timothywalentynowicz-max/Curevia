// /api/curevia-chat.js — v4.0 (SSE + FAQ + Calc + Norway + Intents)
// ------------------------------------------------------------------
// Tips på env i Vercel:
// OPENAI_API_KEY=sk-...                (krävs för GPT-fallback + översättningar)
// OPENAI_API_BASE=https://api.openai.com/v1
// OPENAI_MODEL=gpt-5                   (eller din valfria modell, ex gpt-4o-mini)
// QUICK_ANSWERS_URL=https://.../qa.json (valfritt, extra QAs)
// CONTACT_WEBHOOK_URL=https://...       (valfritt, tar emot kontaktformulär)
// RAG_INDEX_URL=https://.../curevia-rag-index.json (valfritt, RAG)
//
// (valfritt) Upstash Redis för sessioner/rate-limit-statistik:
// UPSTASH_REDIS_REST_URL=...
// UPSTASH_REDIS_REST_TOKEN=...

const OPENAI_API_KEY       = process.env.OPENAI_API_KEY;
const OPENAI_API_BASE      = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";
const OPENAI_MODEL         = process.env.OPENAI_MODEL || "gpt-4o-mini";
const QUICK_ANSWERS_URL    = process.env.QUICK_ANSWERS_URL || "";
const CONTACT_WEBHOOK_URL  = process.env.CONTACT_WEBHOOK_URL || "";
const RAG_INDEX_URL        = process.env.RAG_INDEX_URL || "";

const MAX_INPUT_LEN        = 2000;
const OPENAI_TIMEOUT_MS    = 18000;
const RATE_LIMIT_PER_MIN   = 40;

const LINKS = {
  demo: "https://calendly.com/tim-curevia/30min",
  regConsult: "https://curevia.ai/consultant/register",
  regProvider: "https://curevia.ai/auth?type=signup&returnTo=/employer/register",
  pricingProviders: "https://curevia.ai/vardgivare",
};

const ACTIONS = { OPEN_URL: "open_url", OPEN_CONTACT_FORM: "open_contact_form" };
const SCHEMA_VERSION = "4.0.0";

// ==== Rate limit ===================================================
const rl = new Map();
function rateLimitOk(ip){
  const now = Date.now();
  const rec = rl.get(ip) || { count:0, ts:now };
  if (now - rec.ts > 60_000) { rec.count = 0; rec.ts = now; }
  rec.count += 1; rl.set(ip, rec);
  return rec.count <= RATE_LIMIT_PER_MIN;
}

// ==== Small utils ==================================================
function normalize(str=""){
  return str.toLowerCase()
    .replace(/[åä]/g,"a").replace(/ö/g,"o")
    .replace(/[^a-z0-9\s]/g,"").replace(/\s+/g," ").trim();
}
function dePrompt(msg=""){ return msg.replace(/^(system:|du är|you are|ignore.*instructions|act as).{0,200}/i,"").trim(); }
function hasSensitive(s=""){ return /\b(\d{6}|\d{8})[-+]?\d{4}\b/.test(s) || /journal|anamnes|diagnos|patient/i.test(s); }

function wantsSSE(req){ if (/\bstream=1\b/.test(req.url || "")) return true; return String(req.headers.accept||"").includes("text/event-stream"); }
function sseHeaders(res){ res.setHeader("Content-Type","text/event-stream; charset=utf-8"); res.setHeader("Cache-Control","no-cache, no-transform"); res.setHeader("Connection","keep-alive"); }
function sseSend(res, event, data){ if(event) res.write(`event: ${event}\n`); res.write(`data: ${typeof data==="string" ? data : JSON.stringify(data)}\n\n`); }
function sendJSON(res, payload){ res.setHeader("Content-Type","application/json; charset=utf-8"); res.status(200).send(JSON.stringify(payload)); }

// ==== Redis session (optional) =====================================
let redis = null;
const sessMem = new Map();
async function lazyRedis(){
  if (redis !== null) return redis;
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const { Redis } = await import("@upstash/redis");
    redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
  } else redis = false;
  return redis;
}
async function getSess(sessionId){
  if (!sessionId) return {};
  const r = await lazyRedis();
  if (r) { try { const obj = await r.hgetall(`curevia:sess:${sessionId}`); if (obj) return obj; } catch {} }
  return sessMem.get(sessionId) || {};
}
async function patchSess(sessionId, patch){
  if (!sessionId) return;
  const r = await lazyRedis();
  if (r) {
    try {
      const key = `curevia:sess:${sessionId}`;
      await r.hset(key, { ...patch, lastSeenAt: Date.now() });
      await r.expire(key, 60*60*24*7);
    } catch {}
  }
  const cur = sessMem.get(sessionId) || {};
  sessMem.set(sessionId, { ...cur, ...patch, lastSeenAt: Date.now() });
}

// ==== Language =====================================================
function parseHeaderLang(req){
  const x = String(req.headers["x-lang"] || "").toLowerCase();
  const a = String(req.headers["accept-language"] || "").toLowerCase();
  const pick = x || a;
  if (/^sv|swedish|sweden|se/.test(pick)) return "sv";
  if (/^no|nb|nn|norsk|norwegian|no-/.test(pick)) return "no";
  if (/^en|english|uk|us|gb/.test(pick)) return "en";
  return null;
}
function detectLangFromText(t=""){
  const s = t.toLowerCase();
  if (/(english|engelska|switch.*english|in english)/.test(s)) return "en";
  if (/(norsk|norska|på norsk|switch.*norwegian)/.test(s)) return "no";
  if (/(svenska|på svenska)/.test(s)) return "sv";
  return null;
}
function languageOf(message=""){
  const t = message.toLowerCase();
  const no = /\b(hvordan|hva|demo|booke|leverandør|konsulent)\b/.test(t) || /[æøå]/.test(t);
  const en = /\b(how|what|demo|book|provider|consultant|register|price|fee)\b/.test(t);
  if (no) return "no";
  if (en) return "en";
  return "sv";
}
const PROMPTS = {
  sv: `Du är Curevia-boten. Svara kort, vänligt och konkret på **svenska**.`,
  en: `You are the Curevia assistant. Reply briefly, warmly, and clearly in **English**.`,
  no: `Du er Curevia-boten. Svar kort, vennlig og konkret på **norsk bokmål**.`
};
const POLICY = `• Föreslå “Boka demo” bara när användaren ber om det.
• Vid “kontakta mig”: erbjud kontaktformulär och säg att vi hör av oss inom kort.
• Dela aldrig person- eller journaluppgifter; be om säker kanal i sådana fall.
• Försäkring tillhandahålls av vårdgivaren.
• Ton: varm, proffsig och lösningsorienterad. Max 2–3 meningar per svar.`;

// ==== Translate helper ============================================
async function translateIfNeeded(text, lang){
  if (!text || lang === "sv") return text;
  if (!OPENAI_API_KEY) return text;
  const controller = new AbortController();
  const to = setTimeout(()=>controller.abort(), OPENAI_TIMEOUT_MS);
  try{
    const r = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
      method:"POST",
      headers:{ "Authorization":`Bearer ${OPENAI_API_KEY}`, "Content-Type":"application/json" },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.0,
        messages: [
          { role:"system", content:"You translate short product support messages. Preserve links and numbers." },
          { role:"user", content:`Translate into ${lang==="no"?"Norwegian (bokmål)":"English"}:\n\n${text}` }
        ]
      }),
      signal: controller.signal
    });
    clearTimeout(to);
    const j = await r.json().catch(()=>null);
    return j?.choices?.[0]?.message?.content?.trim() || text;
  }catch{
    clearTimeout(to);
    return text;
  }
}

// ==== DEFAULT QA ===================================================
const DEFAULT_QA = [
  { pattern:/eget bolag|företag/i,
    reply:`Du behöver inte ha eget bolag – du kan få betalt via Curevia eller fakturera själv om du vill. Registrera konsultprofil: ${LINKS.regConsult}` },
  { pattern:/utbetal/i,
    reply:`Utbetalning via Curevia sker när vårdgivaren betalat. Har du eget bolag fakturerar du själv, vanligtvis med 30 dagars betalvillkor.` },
  { pattern:/inte betalar|försenad betal|betalningspåminn/i,
    reply:`Om en vårdgivare är sen driver Curevia ärendet till påminnelse, inkasso och vid behov Kronofogden – du ska känna dig trygg att få betalt.` },
  { pattern:/kostnad|pris|avgift|prislista/i,
    reply:`Curevia är gratis att komma igång med. För vårdgivare finns olika paket beroende på användning. Läs mer: ${LINKS.pricingProviders}` },
  { pattern:/onboard|komma igång|starta|hur börjar/i,
    reply:`Skapa ett uppdrag och välj bland intresserade konsulter – en kundansvarig hjälper er hela vägen.` },
  { pattern:/registrera.*(vårdgiv|klinik|mottag)/i,
    reply:`Registrera vårdgivare: ${LINKS.regProvider}` },
  { pattern:/registrera.*(konsult|sjuksköters|läkar|vård)/i,
    reply:`Registrera konsult: ${LINKS.regConsult}` },
];
let qaCache=null;
async function getPromotedQAFromRedis(){ return []; }
async function loadQuickAnswers(force=false){
  if (!force && qaCache) return qaCache;
  const list=[...DEFAULT_QA];
  const promoted = await getPromotedQAFromRedis(10); for (const p of promoted) list.push(p);
  if (QUICK_ANSWERS_URL && /^https?:\/\//i.test(QUICK_ANSWERS_URL)){
    try{
      const r = await fetch(QUICK_ANSWERS_URL, { cache:"no-store" });
      if (r.ok){
        const extra = await r.json();
        for (const item of extra){
          if (item?.pattern && (item?.reply || item?.a)){
            list.push({ pattern:new RegExp(item.pattern,"i"), reply:String(item.reply||item.a) });
          }
        }
      }
    }catch{}
  }
  qaCache=list; return qaCache;
}

// ==== NET SALARY CALC =============================================
function calcNetFromInvoiceExVat(amountExVat, opts={}){ 
  const ag = Math.max(0, Number(opts.agAvg ?? 0.3142));      // arbetsgivaravgift
  const tax = Math.max(0, Math.min(0.6, Number(opts.taxRate ?? 0.30)));
  const pension = Math.max(0, Number(opts.pension ?? 0));
  const vacation = Math.max(0, Number(opts.vacation ?? 0.12));
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

Obs: förenklad uppskattning – procentsatser varierar per kommun och avtal.`
  };
}
function parseInvoiceAmount(msg=""){
  const m = msg.match(/(\d[\d\s.,]{2,})\s*(kr)?\s*(inkl|exkl)?\s*moms?/i) || msg.match(/faktur[a-z]*\s+(\d[\d\s.,]+)/i);
  if (!m) return null;
  const raw = parseInt(String(m[1]).replace(/[^\d]/g,""),10);
  if (!Number.isFinite(raw) || raw<=0) return null;
  const inkl = /inkl\s*moms/i.test(m[0]);
  const exkl = /exkl\s*moms/i.test(m[0]);
  let amountExVat=raw;
  if (inkl && !exkl) amountExVat = Math.round(raw/1.25);
  return amountExVat;
}

// ==== Intents + CTA ================================================
function detectIntent(text=""){
  const t = text.toLowerCase();
  if (/(english|engelska|switch.*english|in english)/.test(t)) return "set_lang_en";
  if (/(norsk|norska|på norsk|switch.*norwegian)/.test(t))     return "set_lang_no";
  if (/(svenska|på svenska)/.test(t))                           return "set_lang_sv";

  const isProvider = /(vårdgivar|klinik|mottag|region|upphandl|integration|pris|avgift|pilot|provider|clinic|hospital|tender|integration)/.test(t);
  const isConsult  = /(konsult|uppdrag|ersättn|timlön|bemann|legitimation|profil|sjuksköters|läkar|nurse|doctor|consultant|assignment|rate|per hour)/.test(t);

  const wantsDemo  = /(demo|visa plattformen|genomgång|walkthrough|book.*demo|schedule.*demo|see (the )?platform)/.test(t);
  const wantsReg   = /(registrera|skapa konto|signa|ansök|register|sign ?up|create account|apply)/.test(t);
  const wantsContact = /(kontakta|ring upp|hör av er|hör av dig|contact|reach out|call me)/.test(t);

  if (wantsReg && isProvider) return "register_provider";
  if (wantsReg && isConsult)  return "register_consult";

  if (wantsDemo && isProvider) return "provider_demo";
  if (wantsDemo && isConsult)  return "consult_demo";
  if (wantsDemo)               return "demo_any";

  if (wantsContact) return "contact_me";
  if (isProvider) return "provider";
  if (isConsult)  return "consult";
  return "general";
}
function shouldSuggestCTA(userText, intent){
  const t = (userText||"").toLowerCase();
  const explicitDemo = /(demo|visa plattformen|genomgång|boka.*möte)/.test(t);
  if (intent==="provider_demo"||intent==="consult_demo") return true;
  if (intent==="provider") return /(pris|avgift|gdpr|integration|onboard|kom igång|hur fungerar|testa)/i.test(t) && explicitDemo;
  if (intent==="consult")  return /(uppdrag|ersättn|timlön|kom igång|registrera|hur fungerar)/i.test(t) && !/(nej|inte nu)/.test(t);
  return explicitDemo;
}
function polishReply(text,intent="general",addCTA=false){
  const safe=(text||"").replace(/\s+/g," ").trim();
  const parts=safe.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0,3);
  let msg=parts.join(" ");
  const hasLink=/(https?:\/\/|boka.*demo|registrera|curevia\.ai|calendly\.com)/i.test(msg);
  if(addCTA && !hasLink){
    if (intent.startsWith("provider")) msg+=` Vill du kika tillsammans? Boka gärna en kort demo 🌟 ${LINKS.demo}`;
    else if (intent.startsWith("consult")) msg+=` Vill du komma igång? Registrera dig här 💙 ${LINKS.regConsult}`;
    else msg+=` Vill du veta mer? Jag visar gärna 🌟 ${LINKS.demo}`;
  }
  return msg || `Vill du veta mer? Jag visar gärna 🌟 ${LINKS.demo}`;
}
function suggestFor(intent, lang="sv"){
  const t = (s)=> lang==="en" ? s.en : lang==="no" ? s.no : s.sv;
  const S = {
    about:  { sv:"ℹ️ Om Curevia", en:"ℹ️ About Curevia", no:"ℹ️ Om Curevia" },
    prov:   { sv:"🏥 För vårdgivare", en:"🏥 For providers", no:"🏥 For providers" },
    cons:   { sv:"👩‍⚕️ För vårdpersonal", en:"👩‍⚕️ For clinicians", no:"👩‍⚕️ For clinicians" },
    reg:    { sv:"✍️ Registrera dig", en:"✍️ Sign up", no:"✍️ Registrer deg" },
    demo:   { sv:"📅 Boka demo", en:"📅 Book a demo", no:"📅 Book en demo" },
    price:  { sv:"📄 Pris & paket", en:"📄 Pricing", no:"📄 Priser" },
    faqC:   { sv:"💬 Vanliga frågor (konsult)", en:"💬 FAQ (consultant)", no:"💬 FAQ (konsulent)" },
  };
  if (intent.startsWith("provider")) return [
    { label:t(S.demo), url:LINKS.demo },
    { label:t(S.price), text: lang==="en" ? "What does it cost?" : (lang==="no" ? "Hva koster det?" : "Vad kostar det?") },
    { label:t(S.reg), url:LINKS.regProvider }
  ];
  if (intent.startsWith("consult")) return [
    { label:t(S.reg), url:LINKS.regConsult },
    { label:t(S.demo), url:LINKS.demo },
    { label:t(S.faqC), text: lang==="en"?"FAQ for consultants":(lang==="no"?"FAQ for konsulenter":"Vanliga frågor för konsulter") }
  ];
  if (intent==="demo_any") return [
    { label:t(S.demo), url:LINKS.demo },
    { label:t(S.prov), text: lang==="en"?"What do you offer providers?":(lang==="no"?"Hva tilbyr dere for leverandører?":"Vad erbjuder ni för vårdgivare?") },
    { label:t(S.cons), text: lang==="en"?"What do you offer clinicians?":(lang==="no"?"Hva tilbyr dere for klinikere?":"Vad erbjuder ni för vårdpersonal?") }
  ];
  // default + (kalkyl/Norge) chips
  return [
    { label:t(S.about), text: lang==="en"?"Tell me about Curevia":(lang==="no"?"Fortell om Curevia":"Berätta mer om Curevia") },
    { label:t(S.prov),  text: lang==="en"?"What do you offer providers?":(lang==="no"?"Hva tilbyr dere for leverandører?":"Vad erbjuder ni för vårdgivare?") },
    { label:t(S.cons),  text: lang==="en"?"What do you offer clinicians?":(lang==="no"?"Hva tilbyr dere for klinikere?":"Vad erbjuder ni för vårdpersonal?") },
    { label:t(S.reg),   text: lang==="en"?"I want to sign up":(lang==="no"?"Jeg vil registrere meg":"Jag vill registrera mig") },
    { label: lang==="en"?"🧮 Net pay calc":"🧮 Räkna ut nettolön", text: lang==="en"?"Calculate net salary from invoice":"Beräkna nettolön från faktura" },
    { label: lang==="en"?"🇳🇴 Work in Norway":"🇳🇴 Jobba i Norge", text: lang==="en"?"How to get Norwegian authorization (HPR)?":"Hur skaffar jag norsk legitimation (HPR)?" },
  ];
}

// ==== RAG (stubs) ==================================================
let ragIndex=null;
async function loadRagIndex(){ if(!RAG_INDEX_URL) return null; try{ const r=await fetch(RAG_INDEX_URL,{cache:"no-store"}); if(r.ok){ ragIndex=await r.json(); } }catch{} return ragIndex; }
async function embedText(){ return { }; }
async function ragRetrieve(){ return { passages:[], citations:[] }; }
function buildUserPrompt(message){ return message; }

// ==== Curevia FAQ (lägg nya längst NED, ta aldrig bort) ===========
const CureviaFAQs = [
  { q:"Vilket företag står bakom Curevia?", a:"Curevia drivs av Nenetka AB – en svensk plattform som matchar vårdpersonal med uppdrag. Enkelt, tryggt och utan krångel." },
  { q:"Vad är Curevia?", a:"En digital marknadsplats för vården. Vårdpersonal hittar uppdrag och vårdgivare hittar kompetens – helt digitalt." },
  { q:"Är Curevia ett bemanningsföretag?", a:"Vi är en plattform/marknadsplats snarare än ett traditionellt bemanningsbolag, vilket ger transparens och snabbare processer." },
  { q:"Vilka kan använda Curevia?", a:"Legitimerad vårdpersonal och vårdgivare/kliniker i behov av bemanning." },
  { q:"Var finns ni?", a:"Vi är baserade i Sverige och expanderar stegvis. Fråga oss om din region." },
  { q:"Är Curevia godkänt av myndigheter?", a:"Vi följer gällande regelverk och GDPR, och verifierar legitimation innan uppdrag." },
  { q:"Tar ni provision från vårdpersonalens lön?", a:"Vi tar en transparent plattformsavgift på fakturabeloppet exkl. moms enligt avtal – ersättningen syns tydligt i kalkylen." },
  { q:"Vad skiljer er från klassiska bemanningsbolag?", a:"Digitalt flöde, mer valfrihet och snabb matchning. Mindre friktion, mer kontroll." },
  { q:"Har ni kollektivavtal?", a:"Villkor beror på uppdragsform. Be oss om underlag för just din situation." },
  { q:"Jobbar ni bara i Sverige?", a:"Primärt i Sverige just nu, men vi bygger broar mellan europeiska länder stegvis." },

  { q:"Hur registrerar jag mig som konsult?", a:"Skapa konto, fyll i profil och ladda upp legitimation/intyg. Boten guidar dig steg för steg." },
  { q:"Hur registrerar sig en vårdgivare?", a:"Skapa konto, lägg in behov (kompetens, datum, villkor) och signera digitalt när matchen är klar." },
  { q:"Vilka dokument behöver jag som konsult?", a:"Legitimation, CV, eventuella intyg och referenser. Ladda upp i din profil så kan vi verifiera." },
  { q:"Hur verifieras min legitimation?", a:"Vi kontrollerar legitimation mot tillgängliga register och begär kompletteringar vid behov." },
  { q:"Kan jag pausa min profil?", a:"Ja, du kan dölja eller pausa din profil när du inte är tillgänglig." },
  { q:"Hur uppdaterar jag mina uppgifter?", a:"Gå till Profil → Redigera. Ändringar slår igenom direkt efter sparning." },

  { q:"Hur funkar det att jobba via Curevia?", a:"Skapa profil, hitta uppdrag, signera digitalt och rapportera tid. Vi sköter administration och utbetalning." },
  { q:"Måste jag ha ett eget bolag?", a:"Nej. Du kan få lön utan bolag via oss – eller fakturera från eget AB om du föredrar det." },
  { q:"Kan jag välja uppdrag fritt?", a:"Ja, du väljer plats, tider och villkor inom ramen för uppdraget." },
  { q:"Kan jag arbeta deltid?", a:"Absolut. Du styr själv din tillgänglighet och omfattning." },
  { q:"Erbjuder ni distansuppdrag?", a:"Ja, när vårdgivaren tillåter det. Filtrera på distans i uppdragslistan." },
  { q:"Hur hittar jag nya uppdrag?", a:"I din dashboard – och via personliga rekommendationer utifrån din profil." },
  { q:"Hur rapporterar jag tid?", a:"Direkt i plattformen. Signera och skicka för godkännande." },
  { q:"Hur snabbt får jag feedback på en ansökan?", a:"Ofta inom 24–72 timmar. Du får notiser i appen." },

  { q:"Hur mycket får jag ut i nettolön om jag fakturerar X kr?", a:"Ange fakturabelopp exkl. moms så räknar vi brutto, skatt och nettolön direkt – med tydliga mellanled." },
  { q:"Vilken plattformsavgift tar ni?", a:"Enligt avtal, t.ex. en procentsats på fakturabeloppet exkl. moms. Den visas öppet i kalkylen." },
  { q:"När får jag betalt?", a:"Vanligtvis inom 5–10 bankdagar efter godkänd tidrapport/faktura. Tider kan variera per uppdrag." },
  { q:"Får jag tjänstepension?", a:"Beror på uppdragsform. Fråga oss så sätter vi upp rätt lösning." },
  { q:"Hur funkar semesterersättning?", a:"Vi kan lägga på t.ex. 12 % enligt valt upplägg, eller redovisa separat – du väljer." },
  { q:"Hur funkar skatten?", a:"Vid lön via oss drar vi preliminär skatt enligt tabell/schablon. Med eget AB hanterar du skatt i bolaget." },
  { q:"Vad är skillnaden mellan lön via Curevia och fakturering via AB?", a:"Med lön sköter vi arbetsgivaransvar, skatter och utbetalning. Med AB fakturerar du och sköter ekonomi själv." },
  { q:"Kan jag få milersättning och traktamente?", a:"Ja, enligt Skatteverkets regler och uppdragsavtal. Rapportera i tidrapporten så hanterar vi det korrekt." },
  { q:"Kan jag se exempel på lönebesked?", a:"Ja, vi kan visa en exempel-PDF så du ser hur allt redovisas." },
  { q:"Hur hanteras OB och ersättning för helg/kväll?", a:"Enligt uppdragsavtal. Vi visar alltid ersättningsnivåerna tydligt innan du accepterar." },
  { q:"Kan jag få förskott?", a:"I vissa fall efter överenskommelse. Fråga support så hjälper vi dig." },

  { q:"Vem står för försäkring?", a:"Försäkring tillhandahålls av vårdgivaren enligt uppdragets villkor. Be oss om intyg för just ditt uppdrag." },
  { q:"Vem är arbetsgivare?", a:"Vid lön via Curevia är vi arbetsgivare. Fakturerar du via eget AB är uppdraget B2B." },
  { q:"Är mina personuppgifter säkra?", a:"Ja, vi följer GDPR och lagrar data säkert inom EU. Du kan begära utdrag eller radering när som helst." },
  { q:"Hur hanterar ni känslig information?", a:"Vi minimerar insamling, krypterar där det krävs och delar aldrig utan laglig grund." },
  { q:"Har jag rätt till sjuklön?", a:"Beror på uppdragsform och avtal. Vi förklarar gärna vad som gäller i ditt specifika uppdrag." },
  { q:"Vad händer om vårdgivaren betalar sent?", a:"Vi hanterar påminnelser enligt avtal. Vid lön via oss påverkas normalt inte din utbetalning." },

  { q:"Hur lägger vi en förfrågan som vårdgivare?", a:"Skapa konto, ange kompetens, datum, omfattning och villkor. Vi matchar snabbt och ni signerar digitalt." },
  { q:"Vilka kompetenser kan vi boka?", a:"Läkare, sjuksköterskor (grund/specialist), undersköterskor m.fl. Fråga om nischade roller." },
  { q:"Hur snabbt kan ni leverera personal?", a:"Ofta inom 24–72 timmar för kortare vikariat. Längre uppdrag planeras i god tid." },
  { q:"Kan vi skriva ramavtal?", a:"Ja, för bättre priser, SLA och tydlig uppföljning." },
  { q:"Hur fungerar prissättning?", a:"Tim- eller dygnspriser baseras på kompetens, plats och tider. Vi lämnar offert med tydlig kostnadsbild." },
  { q:"Kan vi följa uppdrag i realtid?", a:"Ja, i er dashboard ser ni status, tidrapporter och KPI:er." },
  { q:"Hur sker fakturering?", a:"Digital tidrapportering och samlad faktura enligt överenskommet intervall." },
  { q:"Gör ni bakgrundskontroller?", a:"Ja, legitimation och referenser kontrolleras innan start." },
  { q:"Kan vi behöva teckna extra försäkring?", a:"Vårdgivaren ansvarar för nödvändiga försäkringar och arbetsmiljö enligt lag och avtal." },

  { q:"Hur loggar jag in?", a:"Med e-post/telefon och engångskod eller BankID om aktiverat." },
  { q:"Jag har glömt mitt lösenord, vad gör jag?", a:"Klicka på ”Glömt?” så skickar vi en återställningslänk eller engångskod." },
  { q:"Har ni en mobilapp?", a:"Webben är mobilanpassad idag. Native app är på väg." },
  { q:"Kan jag få notiser om nya uppdrag?", a:"Ja, aktivera notiser och bevakningar i din profil." },
  { q:"Kan jag exportera min historik?", a:"Ja, exportera som PDF/CSV under Historik." },
  { q:"Stödjer ni flera språk?", a:"Ja, svenska, norska, engelska och danska. Fler språk kan tillkomma." },
  { q:"Kan jag bjuda in en kollega?", a:"Ja, dela din inbjudningslänk – båda kan få bonus enligt kampanjvillkor." },

  { q:"Hur funkar distansuppdrag praktiskt?", a:"När vårdgivaren tillåter det sker arbetet digitalt enligt deras processer och system." },
  { q:"Vilken utrustning behöver jag för distans?", a:"Säker uppkoppling, kamera/mikrofon och tillgång till vårdgivarens system enligt instruktion." },
  { q:"Kan jag kombinera distans och på plats?", a:"Ja, om uppdraget medger hybridupplägg." },

  { q:"Följer ni GDPR?", a:"Ja. Vi hanterar personuppgifter lagligt, säkert och med minimal insamling." },
  { q:"Hur raderar jag min data?", a:"Kontakta support eller begär radering i kontoinställningar – vi hjälper dig direkt." },
  { q:"Hur hanterar ni journaluppgifter?", a:"Journaldata ska inte delas i chatten. Använd vårdgivarens säkra system för patientinformation." },

  { q:"Får ni driftstörningar ibland?", a:"Som alla digitala tjänster kan det hända. Vi övervakar och kommunicerar läget i appen." },
  { q:"Hur kontaktar jag support?", a:"Skriv i chatten eller maila oss – vi svarar snabbt vardagar och bevakar kritiska ärenden." },
  { q:"Hur rapporterar jag en bugg?", a:"Använd ”Rapportera problem” i appen och beskriv vad som hände – gärna med skärmklipp." },

  { q:"Kan vi få en snabb offert?", a:"Ja, ange kompetens, erfarenhetsnivå, plats och tidsperiod – vi återkommer samma dag." },
  { q:"Vad ingår i priset?", a:"Matchning, digital administration, tidrapportering och kvalitetskontroller. Försäkring ligger hos vårdgivaren." },
  { q:"Kan ni bemanna med kort varsel?", a:"Vi gör vårt bästa – akuta förfrågningar prioriteras i nätverket." },

  { q:"Vilken skattetabell använder ni i beräkningar?", a:"Som standard schablon, men du kan ange din kommun/tabell för mer exakt resultat." },
  { q:"Kan jag lägga till skattefria ersättningar i kalkylen?", a:"Ja, lägg till traktamente/milersättning så visas de separat utanför nettolönen." },
  { q:"Visa mellanled i kalkylen?", a:"Självklart – efter avgift, bruttolön, skatt, semester och netto. Allt syns öppet." },
  { q:"Kan ni jämföra AB vs lön via Curevia?", a:"Ja, vi visar en enkel jämförelse och pekar på vad som skiljer i ansvar, skatt och administration." },

  { q:"Hur säkerställer ni kvalitet i matchningen?", a:"Profildata, verifierad legitimation och relevanta referenser. Vårdgivare kan sätta krav och ge feedback." },
  { q:"Kan jag få uppdrag inom en specifik specialitet?", a:"Ja, filtrera på specialitet och lägg bevakning så pingar vi dig vid nya uppdrag." },
  { q:"Hur funkar feedback efter avslutat uppdrag?", a:"Båda parter kan ge omdöme. Det förbättrar matchningar framåt." },

  { q:"Hur avslutar jag ett uppdrag?", a:"Rapportera sista passet och signera. Slutrapport och ersättning hanteras direkt i systemet." },
  { q:"Kan jag få arbetsgivarintyg eller intyg på uppdrag?", a:"Ja, be support så hjälper vi dig med underlag." },
  { q:"Hur stänger vi ett uppdrag som vårdgivare?", a:"Bekräfta sista tidrapporten och signera digitalt. Fakturan skapas enligt avtal." },

  { q:"Har ni någon värvningsbonus?", a:"Ibland kör vi kampanjer. Använd din inbjudningslänk och se aktuella villkor i appen." },
  { q:"Får både jag och den jag bjuder in bonus?", a:"Ja, när kampanjvillkoren uppfylls – till exempel efter första genomförda uppdrag." },

  { q:"Vad kostar det att registrera sig?", a:"Det är gratis att skapa konto. Avgifter framgår först när du accepterar uppdrag." },
  { q:"Kan ni hjälpa till med vidareutbildning?", a:"Vi tipsar gärna om kurser och certifieringar – fråga efter förslag inom din specialitet." },
  { q:"Var kan jag följa er?", a:"Följ oss på LinkedIn för nyheter, uppdrag och insikter." },
];
function faqFindExact(text){ return CureviaFAQs.find(f => normalize(f.q) === normalize(text)); }
function faqFindFuzzy(text){
  const t = normalize(text);
  return CureviaFAQs.find(f => normalize(f.q).includes(t) || normalize(f.a).includes(t));
}

// ==== Norge / HPR guide ===========================================
function norwayGuide(){
  return `Så skaffar du norsk legitimation (HPR) – steg för steg:

1) Förbered dokument
• Pass/id, examensbevis, svensk legitimation, CV.
• Certificate of Current Professional Status/”Letter of Good Standing”.
• Auktoriserade översättningar om dokument ej på norska/svenska/engelska.

2) Ansök om autorisasjon
• Ansökan görs digitalt via Helsedirektoratet (HPR).
• Skapa konto, ladda upp dokument, betala avgift.
• Handläggningstid varierar – räkna med några veckor.

3) Efter beslut – HPR-nummer
• Vid beviljad autorisasjon registreras du i HPR (Norges legitimation).
• Du får HPR-nummer som arbetsgivare/vårdgivare kontrollerar.

4) Praktiska steg för arbete i Norge
• D-nummer via Skatteetaten.
• Skattekort (tax card) – krävs för lön.
• Norsk bank/utbetalning enligt arbetsgivarens rutiner.
• Ev. HMS-kort och lokala intro-/IT-behörigheter.

Tips
• Spara original och ha skannade PDF:er redo.
• Krav varierar per yrkesgrupp; vissa specialiteter kräver extra intyg.
• Good standing från Sverige? Beställ i god tid.

Vill du att jag skapar en personlig checklista utifrån din yrkesroll och startdatum?`;
}

// ==== HTTP handler =================================================
export default async function handler(req,res){
  // CORS
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type, Authorization, X-Session-Id, X-Lang, Accept-Language, Accept");
  res.setHeader("Cache-Control","no-store");
  if (req.method==="OPTIONS") return res.status(204).end();

  const ip = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").toString().split(",")[0].trim();
  if (!rateLimitOk(ip)) return res.status(429).json({ error:"Too Many Requests" });

  const sessionId = String(req.headers["x-session-id"] || "").slice(0,100) || null;

  // GET meta
  if (req.method==="GET"){
    const qa = await loadQuickAnswers(); await loadRagIndex();
    const lang = parseHeaderLang(req) || "sv";
    return sendJSON(res, {
      ok:true, schema:SCHEMA_VERSION, route:"/api/curevia-chat",
      qaCount: qa.length,
      suggested: suggestFor("general", lang),
      hasKey:Boolean(OPENAI_API_KEY), ragReady:Boolean(ragIndex),
      model:OPENAI_MODEL, streaming:true, contactWebhook:Boolean(CONTACT_WEBHOOK_URL)
    });
  }
  if (req.method!=="POST") return res.status(405).json({ error:"Method Not Allowed" });

  // parse body
  let bodyRaw="";
  try{
    bodyRaw = await new Promise((resolve,reject)=>{
      let d=""; req.on("data",c=>{ d+=c; if (d.length>128*1024){ reject(new Error("Payload too large")); try{req.destroy();}catch{} }});
      req.on("end",()=>resolve(d||"{}")); req.on("error",reject);
    });
  }catch{ return res.status(413).json({ error:"Payload too large" }); }
  let parsed; try{ parsed=JSON.parse(bodyRaw);}catch{ return res.status(400).json({ error:"Invalid JSON body" }); }

  // contact form
  if (parsed?.contact && typeof parsed.contact==="object"){
    const c=parsed.contact; if(!c.name||!c.email) return res.status(400).json({ error:"Missing contact.name or contact.email" });
    if (CONTACT_WEBHOOK_URL){
      try{
        const r=await fetch(CONTACT_WEBHOOK_URL,{ method:"POST", headers:{ "Content-Type":"application/json" },
          body: JSON.stringify({ source:"curevia-chat", ip, ts:new Date().toISOString(), sessionId, contact:c }) });
        if(!r.ok){ const txt=await r.text().catch(()=> ""); return res.status(502).json({ error:"Webhook error", details:txt }); }
      }catch{ return res.status(502).json({ error:"Webhook unreachable" });}
    }
    return sendJSON(res,{ ok:true });
  }

  // main chat
  let { message="", assumptions=null } = parsed;
  if (typeof message!=="string" || !message.trim()) return res.status(400).json({ error:"Missing 'message' string" });
  message = dePrompt(message).slice(0, MAX_INPUT_LEN);

  // language
  const stored   = sessionId ? (await getSess(sessionId)).lang : null;
  const headerL  = parseHeaderLang(req);
  const askedFor = detectLangFromText(message);
  let lang = stored || headerL || languageOf(message);

  const intent0 = detectIntent(message);
  if (intent0==="set_lang_en" || intent0==="set_lang_no" || intent0==="set_lang_sv"){
    lang = intent0==="set_lang_en" ? "en" : intent0==="set_lang_no" ? "no" : "sv";
    if (sessionId) await patchSess(sessionId,{ lang });
    const confirm = lang==="en" ? "Switched to English 🇬🇧"
                  : lang==="no" ? "Byttet til norsk 🇳🇴"
                                 : "Bytte till svenska 🇸🇪";
    return sendJSON(res,{ version:SCHEMA_VERSION, reply:confirm, action:null, url:null, citations:[], suggestions:suggestFor("general", lang), confidence:0.99 });
  }
  if (askedFor && askedFor!==lang){ lang=askedFor; if(sessionId) await patchSess(sessionId,{ lang }); }
  if (sessionId) await patchSess(sessionId,{ lang });

  // sensitive
  if (hasSensitive(message)){
    const msg = lang==="en" ? "I can’t process personal IDs or medical records here. Please use a secure channel 💙"
              : lang==="no" ? "Jeg kan dessverre ikke motta person- eller journalopplysninger her. Ta kontakt via sikker kanal 💙"
                            : "Jag kan tyvärr inte ta emot person- eller journaluppgifter här. Hör av dig via en säker kanal 💙";
    return sendJSON(res,{ version:SCHEMA_VERSION, reply:msg, action:null, url:null, citations:[], suggestions:suggestFor("general", lang), confidence:0.95 });
  }

  // net salary
  const amountExVat = parseInvoiceAmount(message);
  if (amountExVat){
    const { text } = calcNetFromInvoiceExVat(amountExVat, assumptions||{});
    const reply = await translateIfNeeded(text, lang);
    return sendJSON(res,{ version:SCHEMA_VERSION, reply, action:null, url:null, citations:[], suggestions:suggestFor("general", lang), confidence:0.86 });
  }

  // intents
  const intent = detectIntent(message);
  if (intent==="contact_me"){
    const reply = lang==="en" ? "Absolutely! Leave your details and we’ll get back to you shortly."
               : lang==="no" ? "Selvfølgelig! Legg igjen kontaktinfo så hører vi av oss snart."
                              : "Absolut! Fyll i dina kontaktuppgifter så hör vi av oss inom kort.";
    return sendJSON(res,{ version:SCHEMA_VERSION, reply, action:ACTIONS.OPEN_CONTACT_FORM, url:null, citations:[], suggestions:suggestFor("general", lang), confidence:0.95 });
  }
  if (intent==="register_provider"){
    const base = `Här kan du registrera din verksamhet: ${LINKS.regProvider}`;
    return sendJSON(res,{ version:SCHEMA_VERSION, reply: await translateIfNeeded(base, lang), action:ACTIONS.OPEN_URL, url:LINKS.regProvider, citations:[], suggestions:suggestFor("provider", lang), confidence:0.95 });
  }
  if (intent==="register_consult"){
    const base = `Toppen! Registrera din konsultprofil här: ${LINKS.regConsult}`;
    return sendJSON(res,{ version:SCHEMA_VERSION, reply: await translateIfNeeded(base, lang), action:ACTIONS.OPEN_URL, url:LINKS.regConsult, citations:[], suggestions:suggestFor("consult", lang), confidence:0.95 });
  }
  if (intent==="provider_demo" || intent==="consult_demo" || intent==="demo_any"){
    const lead = lang==='en' ? "Great — let’s book a short demo."
               : lang==='no' ? "Supert – la oss booke en kort demo."
                              : "Toppen – låt oss boka en kort demo.";
    const reply = `${lead} ${LINKS.demo}`;
    const bucket = intent==="consult_demo" ? "consult" : "provider";
    return sendJSON(res,{ version:SCHEMA_VERSION, reply, action:ACTIONS.OPEN_URL, url:LINKS.demo, citations:[], suggestions:suggestFor(bucket, lang), confidence:0.98 });
  }

  // Norway / HPR quick guide
  if (/norge|hpr|autorisa(s|z)jon|norsk legitimation/i.test(message)) {
    const reply = await translateIfNeeded(norwayGuide(), lang);
    return sendJSON(res, { version: SCHEMA_VERSION, reply, action:null, url:null, citations:[], suggestions:suggestFor("general", lang), confidence:0.92 });
  }

  // FAQ exact/fuzzy
  const faqHit = faqFindExact(message) || faqFindFuzzy(message);
  if (faqHit) {
    const reply = await translateIfNeeded(faqHit.a, lang);
    return sendJSON(res, { version: SCHEMA_VERSION, reply, action:null, url:null, citations:[], suggestions:suggestFor("general", lang), confidence:0.9 });
  }

  // QA
  const qa = await loadQuickAnswers();
  const hit = qa.find(q=>q.pattern.test(message));
  if (hit){
    const reply = await translateIfNeeded(hit.reply, lang);
    return sendJSON(res,{ version:SCHEMA_VERSION, reply, action:null, url:null, citations:[], suggestions:suggestFor("general", lang), confidence:0.9 });
  }

  // RAG (optional) + GPT fallback
  const userPrompt = buildUserPrompt(message);
  if (!OPENAI_API_KEY) return res.status(500).json({ error:"Missing OPENAI_API_KEY" });
  const system = `${PROMPTS[lang] || PROMPTS.sv}\n${POLICY}`;
  const basePayload = {
    model: OPENAI_MODEL,
    temperature: 0.35,
    max_tokens: 240,
    messages: [{ role:"system", content:system }, { role:"user", content:userPrompt }]
  };

  const controller = new AbortController();
  const to = setTimeout(()=>controller.abort(), OPENAI_TIMEOUT_MS);

  try{
    if (wantsSSE(req)){
      sseHeaders(res);
      sseSend(res,"meta",{ model:OPENAI_MODEL, schema:SCHEMA_VERSION, citations:[] });

      const r = await fetch(`${OPENAI_API_BASE}/chat/completions`,{
        method:"POST",
        headers:{ "Authorization":`Bearer ${OPENAI_API_KEY}`,"Content-Type":"application/json" },
        body: JSON.stringify({ ...basePayload, stream:true }), signal: controller.signal
      }).catch(e=>{ throw (e.name==="AbortError" ? new Error("Upstream timeout") : e); });
      if (!r.ok || !r.body){ const errTxt = await r.text().catch(()=> ""); sseSend(res,"error",{ error:"Upstream error", details:errTxt }); res.end(); clearTimeout(to); return; }

      const reader=r.body.getReader(); const decoder=new TextDecoder(); let full="";
      while(true){
        const { value, done } = await reader.read(); if (done) break;
        const chunk = decoder.decode(value,{stream:true});
        const lines = chunk.split(/\r?\n/);
        for (const line of lines){
          if (!line) continue;
          if (line.startsWith("data: ")){
            const data = line.slice(6);
            if (data === "[DONE]") continue;
            try{
              const json = JSON.parse(data);
              const delta = json.choices?.[0]?.delta?.content || "";
              if (delta){ full += delta; sseSend(res,"token",delta); }
            }catch{}
          }
        }
      }
      clearTimeout(to);
      const reply = polishReply(full.trim(), intent, shouldSuggestCTA(message,intent));
      sseSend(res,"final",{ version:SCHEMA_VERSION, reply, action:null, url:null, citations:[], suggestions:suggestFor(intent, lang), confidence:0.86 });
      res.end(); return;

    } else {
      const r = await fetch(`${OPENAI_API_BASE}/chat/completions`,{
        method:"POST", headers:{ "Authorization":`Bearer ${OPENAI_API_KEY}`,"Content-Type":"application/json" },
        body: JSON.stringify(basePayload), signal: controller.signal
      }).catch(e=>{ throw (e.name==="AbortError" ? new Error("Upstream timeout") : e); });
      clearTimeout(to);

      let data; try{ data=await r.json(); }catch{ return res.status(502).json({ error:"Upstream parse error" }); }
      if (!r.ok) return res.status(502).json({ error:data || "Upstream error" });

      const raw = (data?.choices?.[0]?.message?.content || "").trim();
      const reply = polishReply(raw, intent, shouldSuggestCTA(message,intent));
      return sendJSON(res,{ version:SCHEMA_VERSION, reply, action:null, url:null, citations:[], suggestions:suggestFor(intent, lang), confidence:0.88 });
    }
  }catch(e){
    clearTimeout(to);
    if (wantsSSE(req)){ try{sseSend(res,"error",{ error:String(e?.message||e) });}catch{} try{res.end();}catch{} return; }
    return res.status(500).json({ error:String(e?.message||e) });
  }
}
