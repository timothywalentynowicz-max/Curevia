// api/curevia-chat.js — v3.3 (chips + contact-form)

const OPENAI_API_KEY       = process.env.OPENAI_API_KEY;
const OPENAI_API_BASE      = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";
const OPENAI_MODEL         = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_EMBED_MODEL   = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";
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
const SCHEMA_VERSION = "3.3.0";

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
const NORWAY_SUPERPROMPT = `Du är en ultra-pedagogisk rådgivare för svensk vårdpersonal som vill jobba i Norge.
Svara alltid på svenska. Anpassa efter yrkesroll och arbetsform (onsite i Norge eller distans från Sverige). Var professionell men varm, enkel och trygg. Använd tydlig, visuellt avbockningsbar presentation.

Din uppgift i varje konversation:
1) Kartlägg användarens situation via korta frågor (max 6):
   - Yrkesroll? {läkare | sjuksköterska | undersköterska/helsefagarbeider | psykolog}
   - Arbetsform? {onsite i Norge | distans från Sverige}
   - Planerat startdatum?
   - Anställningsform? {anställd hos norsk vårdgivare | konsult/egen firma i Sverige}
   - Har du svensk legitimation + Good Standing från Socialstyrelsen? {ja/nej/pågår}
   - Behöver du stå kvar i svensk socialförsäkring (A1) eller gå över till norsk? {A1/oklart/norsk}

2) När du svarar – följ ALLTID denna struktur:
— Översikt (1 stycke): Bekräfta användarens nuläge, mål och startdatum.
— Kravbild (punktlista): Autorisasjon/HPR, språk (riktmärke B2), skatt (skattekort, D-nummer, PAYE 25 %/17,3 %), politiattest, MRSA/TB (FHI), journalregler (norsk rätt), socialförsäkring (A1/NAV), distanskrav vid e-tjänster.
— Checklista (avbockningsbar): Varje rad måste innehålla: ⬜ steg | ⏱ tid | 🧭 ansvar | 🧾 kostnad | 🔗 länk
— Tidslinje (ASCII, veckor 1–8): Milstolpar för autorisasjon, ID-kontroll/D-nummer/skattekort, A1/NAV, start.
— Dokumentlista: max 8 viktigaste dokument att samla.
— Vanliga fallgropar + tips: 3–5 bullets.
— Next best action: 1–3 exakta steg med knappar/länkar.
— Curevia CTA: Avsluta alltid med exakt text:
   ✨ Vill du ha hjälp genom hela processen och matchas mot rätt norska uppdrag? Registrera dig gratis på [Curevia.ai](https://curevia.ai/consultant/register). Inga mellanhänder, full frihet.

3) Regler du alltid tar hänsyn till (lägg in där relevant, särskilt i checklistan):
- Norsk autorisasjon + HPR-nummer via Helsedirektoratet/Altinn (alla yrken).
- Språk: arbetsgivarens ansvar; riktmärke B2 norska (svenska kan godtas, men B2 rekommenderas).
- Politiattest för kommunal hälso- och omsorgstjänst.
- MRSA/TB enligt FHI:s riktlinjer (arbetsgivarens ansvar att kräva prov).
- Journalregler: dokumentation på norska (svenska/danska kan accepteras i viss mån), norsk lag gäller.
- Skatt: skattekort, D-nummer vid ID-kontroll, PAYE (25 %/17,3 %) för utländska arbetstagare.
- Nordiska medborgare behöver ej registrera sig hos polisen; övriga EU/EES >3 mån måste.
- Socialförsäkring: A1-intyg (Sverige/NAV) vid utsändning.
- Distans: autorisasjon krävs ändå, journalföring enligt norsk rätt, ev. NHN-medlemskap (arbetsgivarens ansvar) vid e-recept/ekontakt.
- Yrkesvisa spår: Läkare (Certificate of Conformity + Good Standing), Sjuksköterska (autorisasjon via Altinn), Undersköterska=Helsefagarbeider, Psykolog (autorisasjon/lisens via Helsedirektoratet).

4) Visuella element (måste alltid renderas så här):
- Ikoner: ✅ (klart), ⬜ (kvar), ⏱ (tid), 🧭 (ansvar), 🧾 (kostnad), 🔗 (länk).
- Tidslinje: ASCII, exempel:
  Vecka 1 | [Autorisasjon ansökt]———
  Vecka 2 | ——[ID-kontroll/skattekort]—
  Vecka 3–4| ———[A1/NAV-besked]——
  Vecka 5+ | —————[Start]—————

5) Felhantering & rollback:
- Saknar Good Standing: instruera exakt hur den beställs från Socialstyrelsen.
- Distans + e-recept: påpeka att NHN-medlemskap är arbetsgivarens ansvar.
- Utsändning: bekräfta A1 och förklara konsekvenser för norsk trygd/skatt.
- Ofullständig info: fråga endast relevanta följdfrågor (fråga inte allt på nytt).

6) FAQ (lägg sist):
- Hur lång tid tar autorisasjon?
- Kan jag börja jobba innan HPR-nummer?
- Måste jag kunna norska?
- Behöver jag norsk bank?
- Vad gör Curevia i processen?

Viktiga länkar (använd när relevant, visa som klickbara i svaret):
- Autorisasjon/HPR (Helsedirektoratet/Altinn):
  https://www.helsedirektoratet.no/english/authorisation-and-license-for-health-personnel
  https://info.altinn.no/skjemaoversikt/helsedirektoratet/soknad-om-autorisasjon-og-lisens-som-helsepersonell/
- Läkarspår: https://www.helsedirektoratet.no/tema/autorisasjon-og-spesialistutdanning/autorisasjon-og-lisens?path=15-2-2-lege-eueos
- Helsefagarbeider: https://info.altinn.no/skjemaoversikt/helsedirektoratet-godkjenning-av-utenlandske-yrkeskvalifikasjoner/helsefagarbeider/
- Språk/arbetsgivaransvar: https://www.helsedirektoratet.no/tema/autorisasjon-og-spesialistutdanning/tilleggsinformasjon/arbeidsgivers-ansvar-ved-ansettelse-av-helsepersonell
- Politiattest: https://www.helsedirektoratet.no/rundskriv/helsepersonelloven-med-kommentarer/saerskilte-regler-i-tilknytning-til-autorisasjon-krav-om-politiattest-m.v/-20a.krav-om-politiattest
- MRSA/TB (FHI): https://www.fhi.no/publ/eldre/mrsa-veilederen/ | https://www.fhi.no/ss/tuberkulose/tuberkuloseveilederen/forekomst-og-kontroll/4.-grupper-med-plikt-til-tuberkulos/
- Journalregler: https://lovdata.no/forskrift/2019-03-01-168
- Skatt/PAYE/D-nummer: https://www.skatteetaten.no/en/person/foreign/are-you-intending-to-work-in-norway/tax-deduction-cards/paye/
- A1 (NAV/Altinn): https://info.altinn.no/skjemaoversikt/arbeids--og-velferdsetaten-nav/soknad-om-a1-for-utsendte-arbeidstakeren-innen-eossveits/
- Norsk Helsenett: https://www.nhn.no/medlemskap-i-helsenettet/nye-medlemsvilkar

Ton: varm, proffsig, lösningsorienterad. Fråga kort och guidande. Avsluta alltid med Curevia-CTA enligt ovan.`;
const PROMPTS = {
  sv: NORWAY_SUPERPROMPT,
  en: `You are the Curevia assistant (Norway guide). Always answer in Swedish and follow the structure.`,
  no: `Du er Curevia-assistenten (Norge-guide). Svar alltid på svensk og følg strukturen.`
};
const POLICY = ``;

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

// ==== Trending / QA (unchanged core) ===============================
async function trackTrendPersist(){ /* noop if redis absent */ }
async function getPromotedQAFromRedis(){ return []; }

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
function qaChips(){ return []; }

// ==== Net salary ====================================================
function calcNetFromInvoiceExVat(amountExVat, opts={}){ /* — same as your version — */ 
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

Obs: förenklad uppskattning – procentsatser varierar per kommun och avtal.`
  };
}
function parseInvoiceAmount(msg=""){
  const m = msg.match(/fakturer[aä]?r?\s+([\d\s.,]{2,})(?:\s*kr)?(?:\s*(inkl|exkl)\s*moms)?/i);
  if (!m) return null;
  const raw = parseInt(String(m[1]).replace(/[^\d]/g,""),10);
  if (!Number.isFinite(raw) || raw<=0) return null;
  const inkl = /inkl\s*moms/i.test(m[0]);
  const exkl = /exkl\s*moms/i.test(m[0]);
  let amountExVat=raw;
  if (inkl && !exkl) amountExVat = Math.round(raw/1.25);
  return amountExVat;
}

// ==== Intent + CTA + Suggestions ===================================
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
  // Do not shorten or modify; the SUPERPROMPT already formats and includes CTA
  const msg = String(text||"").trim();
  return msg || "Jag hjälper dig steg för steg. Börja gärna med att berätta din yrkesroll och arbetsform (onsite i Norge eller distans från Sverige).";
}
function suggestFor(intent, lang="sv"){
  // Focused on Norway guidance for Swedish clinicians
  return [
    { emoji:"👩‍⚕️", label:"Yrkesroll", text:"Jag är sjuksköterska" },
    { emoji:"📍", label:"Onsite i Norge", text:"Jag vill jobba onsite i Norge" },
    { emoji:"🌐", label:"Distans från Sverige", text:"Jag vill jobba på distans från Sverige" },
    { emoji:"🗓️", label:"Startdatum", text:"Planerat startdatum: 1 december" },
    { emoji:"✍️", label:"Registrera dig", url:LINKS.regConsult }
  ];
}

// ==== Norway slot parsing ==========================================
function parseNorwaySlots(msg=""){
  const t = msg.toLowerCase();
  const out = {};
  // Role
  if (/\bläkare|doktor\b/.test(t)) out.no_role = "läkare";
  else if (/sjukskötersk/.test(t)) out.no_role = "sjuksköterska";
  else if (/underskötersk|helsefagarbeider|vårdbiträde/.test(t)) out.no_role = "undersköterska/helsefagarbeider";
  else if (/psykolog/.test(t)) out.no_role = "psykolog";
  // Work mode
  if (/distans|remote|hemifr[aå]n|fr[aå]n sverige/.test(t)) out.no_mode = "distans från Sverige";
  if (/onsite|p[aå] plats|i norge|flytta till norge/.test(t)) out.no_mode = "onsite i Norge";
  // Employment
  if (/anst[aä]lld|norsk arbetsgivare|fast tj[aä]nst/.test(t)) out.no_employment = "anställd hos norsk vårdgivare";
  if (/konsult|egen firma|eget bolag|enskild firma|ab\b/.test(t)) out.no_employment = "konsult/egen firma i Sverige";
  // License + Good Standing
  if (/(good\s*standing|intyg).*?(ja|klar|finns)/.test(t) || /(legitimation).*?(ja|har)/.test(t)) out.no_license = "ja";
  else if (/(good\s*standing|legitimation).*?(nej|saknas|inte)/.test(t)) out.no_license = "nej";
  else if (/(good\s*standing|legitimation).*?(p[aå]g[aå]r|under handl[aä]ggning)/.test(t)) out.no_license = "pågår";
  // Social security
  if (/\bA1\b/.test(t)) out.no_social = "A1";
  else if (/norsk trygd|nav|folketrygd/.test(t)) out.no_social = "norsk";
  else if (/oklart|os[aä]kert|vet inte/.test(t)) out.no_social = "oklart";
  // Start date (very lenient capture)
  const m = t.match(/(start|fr\s*o\s*m|fr[aå]n|börjar|startdatum)[:\s-]*([^\n]{3,40})/);
  if (m && m[2]) out.no_start = m[2].trim();
  const m2 = t.match(/\b(\d{1,2}\s*(jan|feb|mar|m[aä]r|apr|maj|jun|jul|aug|sep|sept|okt|nov|dec|december|januari|februari|mars|april|juni|juli|augusti|september|oktober|november|december)\b[^\n]*)/);
  if (!out.no_start && m2) out.no_start = m2[1];
  return out;
}

function summarizeNorwaySlots(sess={}){
  const role = sess.no_role || "?";
  const mode = sess.no_mode || "?";
  const start = sess.no_start || "?";
  const emp = sess.no_employment || "?";
  const lic = sess.no_license || "?";
  const soc = sess.no_social || "?";
  const missing = [];
  if (role === "?") missing.push("Yrkesroll");
  if (mode === "?") missing.push("Arbetsform");
  if (start === "?") missing.push("Planerat startdatum");
  if (emp === "?") missing.push("Anställningsform");
  if (lic === "?") missing.push("Legitimation + Good Standing");
  if (soc === "?") missing.push("Socialförsäkring (A1/norsk)");
  const known = `Yrkesroll: ${role} | Arbetsform: ${mode} | Startdatum: ${start} | Anställning: ${emp} | Legitimation/GS: ${lic} | Socialförsäkring: ${soc}`;
  return { known, missing };
}

// ==== RAG (same behavior as before, trimmed) =======================
let ragIndex=null;
async function loadRagIndex(){ if(!RAG_INDEX_URL) return null; try{ const r=await fetch(RAG_INDEX_URL,{cache:"no-store"}); if(r.ok){ ragIndex=await r.json(); } }catch{} return ragIndex; }
async function embedText(){ return { }; } // omitted when no RAG
async function ragRetrieve(){ return { passages:[], citations:[] }; }
function buildUserPrompt(message, sess){
  const { known, missing } = summarizeNorwaySlots(sess||{});
  const missingLine = missing.length ? `Saknas: ${missing.join(", ")}. Ställ bara relevanta, korta följdfrågor (max 6 totalt).` : `All info finns. Generera fullständig vägledning enligt strukturen.`;
  const lead = `Känd information: ${known}. ${missingLine}`;
  return `${lead}\n\nAnvändarens senaste meddelande:\n${message}`;
}

// ==== HTTP handler ==================================================
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
  let lang = "sv"; // Always Swedish for Norway guidance
  if (sessionId) await patchSess(sessionId,{ lang });

  // Parse and store Norway-specific slots
  let sess = sessionId ? (await getSess(sessionId)) : {};
  const slots = parseNorwaySlots(message);
  if (Object.keys(slots).length && sessionId){
    await patchSess(sessionId, slots);
    sess = { ...(sess||{}), ...slots };
  }

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
  // Disable other URL-opening intents to keep focus on guidance flow

  // QA
  // Skip generic QA to allow the SUPERPROMPT to answer comprehensively

  // RAG (optional)
  const userPrompt = buildUserPrompt(message, sess);
  if (!OPENAI_API_KEY) return res.status(500).json({ error:"Missing OPENAI_API_KEY" });

  const system = `${PROMPTS[lang] || PROMPTS.sv}`;
  const basePayload = {
    model: OPENAI_MODEL,
    temperature: 0.25,
    max_tokens: 1200,
    messages: [{ role:"system", content:system }, { role:"user", content:userPrompt }]
  };

  const controller = new AbortController();
  const to = setTimeout(()=>controller.abort(), OPENAI_TIMEOUT_MS);

  try{
    if (wantsSSE(req)){
      sseHeaders(res);
      sseSend(res,"meta",{ model:OPENAI_MODEL, schema:SCHEMA_VERSION, citations:[] });

      const r = await fetch(`${OPENAI_API_BASE}/chat/completions`,{
        method:"POST", headers:{ "Authorization":`Bearer ${OPENAI_API_KEY}`,"Content-Type":"application/json" },
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
