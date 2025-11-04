// /api/curevia-chat.js — v4.1 (GPT-fix + RAG-stub + full Curevia-logik)
// ------------------------------------------------------------------

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
const SCHEMA_VERSION = "4.1.0";

// ==== Rate limit ===================================================
const rl = new Map();
function rateLimitOk(ip) {
  const now = Date.now();
  const rec = rl.get(ip) || { count: 0, ts: now };
  if (now - rec.ts > 60_000) { rec.count = 0; rec.ts = now; }
  rec.count += 1; rl.set(ip, rec);
  return rec.count <= RATE_LIMIT_PER_MIN;
}

// ==== Helpers ======================================================
function normalize(str=""){
  return str.toLowerCase()
    .replace(/[åä]/g,"a").replace(/ö/g,"o")
    .replace(/[^a-z0-9\s]/g,"").replace(/\s+/g," ").trim();
}
function dePrompt(msg=""){ return msg.replace(/^(system:|du är|you are|ignore.*instructions|act as).{0,200}/i,"").trim(); }
function hasSensitive(s=""){ return /\b(\d{6}|\d{8})[-+]?\d{4}\b/.test(s) || /journal|anamnes|diagnos|patient/i.test(s); }

function wantsSSE(req){ if (/\bstream=1\b/.test(req.url || "")) return true; return String(req.headers.accept||"").includes("text/event-stream"); }
function sseHeaders(res){ res.setHeader("Content-Type","text/event-stream; charset=utf-8"); res.setHeader("Cache-Control","no-cache, no-transform"); res.setHeader("Connection","keep-alive"); }
function sseSend(res, event, data){ if(event) res.write(`event: ${event}\n`); res.write(`data: ${typeof data==="string"?data:JSON.stringify(data)}\n\n`); }
function sendJSON(res,payload){ res.setHeader("Content-Type","application/json; charset=utf-8"); res.status(200).send(JSON.stringify(payload)); }

// ==== Redis (optional) =============================================
let redis = null;
const sessMem = new Map();
async function lazyRedis(){
  if (redis !== null) return redis;
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN){
    const { Redis } = await import("@upstash/redis");
    redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
  } else redis = false;
  return redis;
}
async function getSess(id){ if(!id) return {}; const r=await lazyRedis(); if(r){ try{ const o=await r.hgetall(`curevia:sess:${id}`); if(o) return o; }catch{} } return sessMem.get(id)||{}; }
async function patchSess(id,patch){ if(!id) return; const r=await lazyRedis(); if(r){ try{const k=`curevia:sess:${id}`; await r.hset(k,{...patch,lastSeenAt:Date.now()}); await r.expire(k,60*60*24*7);}catch{} } const cur=sessMem.get(id)||{}; sessMem.set(id,{...cur,...patch,lastSeenAt:Date.now()}); }

// ==== Language =====================================================
function parseHeaderLang(req){
  const x=String(req.headers["x-lang"]||"").toLowerCase();
  const a=String(req.headers["accept-language"]||"").toLowerCase();
  const pick=x||a;
  if(/^sv|swedish|se/.test(pick)) return "sv";
  if(/^no|nb|nn|norsk/.test(pick)) return "no";
  if(/^en|english|uk|us|gb/.test(pick)) return "en";
  return "sv";
}
const PROMPTS = {
  sv:`Du är Curevia-boten. Svara kort, vänligt och konkret på **svenska**.`,
  en:`You are the Curevia assistant. Reply briefly, warmly, and clearly in **English**.`,
  no:`Du er Curevia-boten. Svar kort, vennlig og konkret på **norsk bokmål**.`
};
const POLICY=`• Föreslå “Boka demo” bara när användaren ber om det.
• Vid “kontakta mig”: erbjud kontaktformulär och säg att vi hör av oss inom kort.
• Dela aldrig person- eller journaluppgifter.
• Ton: varm, proffsig och lösningsorienterad.`;

// ==== Default QA ===================================================
const DEFAULT_QA=[
  {pattern:/kostnad|pris|avgift|prislista/i,reply:`Curevia är gratis att komma igång med. För vårdgivare finns olika paket. Läs mer: ${LINKS.pricingProviders}`},
  {pattern:/registrera.*(vårdgiv|klinik|mottag)/i,reply:`Registrera vårdgivare: ${LINKS.regProvider}`},
  {pattern:/registrera.*(konsult|sjuksköters|läkar|vård)/i,reply:`Registrera konsult: ${LINKS.regConsult}`},
];
async function loadQuickAnswers(){ return DEFAULT_QA; }

// ==== Simple salary calc ===========================================
function calcNetFromInvoiceExVat(amountExVat){
  const ag=0.3142, tax=0.30, pension=0.04, vacation=0.12;
  const brutto=amountExVat/(1+ag);
  const skatt=(brutto*(1-pension))*tax;
  const netto=brutto-skatt-(brutto*pension)-(brutto*vacation);
  const fmt=n=>Math.round(n).toLocaleString("sv-SE");
  return `På faktura ${amountExVat.toLocaleString("sv-SE")} kr exkl. moms:
- Bruttolön: ~${fmt(brutto)} kr
- Skatt: ~${fmt(skatt)} kr
- Pension + semester: ~${fmt(brutto*(pension+vacation))} kr
= Nettolön: ~${fmt(netto)} kr (ca)`;
}
function parseInvoiceAmount(msg=""){
  const m=msg.match(/(\d[\d\s.,]{2,})\s*(kr)?/i); if(!m) return null;
  const raw=parseInt(String(m[1]).replace(/[^\d]/g,""),10);
  if(!raw||raw<=0) return null;
  return raw;
}

// ==== Intent =======================================================
function detectIntent(t=""){ t=t.toLowerCase();
  if(/registrera/.test(t)&&/vård/.test(t)) return "register_provider";
  if(/registrera/.test(t)) return "register_consult";
  if(/demo|möte|visa/.test(t)) return "demo";
  if(/kontakt|hör av/.test(t)) return "contact";
  return "general";
}
function shouldSuggestCTA(user,intent){ return /(demo|visa|möte|registrera|pris)/i.test(user) || ["demo","register_consult","register_provider"].includes(intent); }
function polishReply(text,intent="general",addCTA=false){
  let msg=(text||"").trim();
  if(addCTA&&!/https?:/.test(msg)){
    if(intent.includes("provider")) msg+=` Vill du kika? Boka en kort demo 🌟 ${LINKS.demo}`;
    else if(intent.includes("consult")) msg+=` Vill du komma igång? Registrera dig här 💙 ${LINKS.regConsult}`;
    else msg+=` Vill du veta mer? Jag visar gärna 🌟 ${LINKS.demo}`;
  }
  return msg||`Vill du veta mer? Jag visar gärna 🌟 ${LINKS.demo}`;
}

// ==== RAG (stubs + GPT fix) =======================================
let ragIndex=null;
async function loadRagIndex(){
  if(!RAG_INDEX_URL) return null;
  try{const r=await fetch(RAG_INDEX_URL,{cache:"no-store"}); if(r.ok) ragIndex=await r.json();}catch{}
  return ragIndex;
}
async function embedText(){ return {}; }
async function ragRetrieve(){ return { passages:[], citations:[] }; }

async function buildUserPrompt(message){
  const context=`Du är Curevia-boten – en digital assistent som hjälper användare att förstå och använda Curevia-plattformen.
Curevia är en svensk plattform som matchar vårdpersonal och vårdgivare på ett tryggt, digitalt och transparent sätt.

Svara vänligt, tydligt och kortfattat. Om frågan gäller registrering, ersättning, uppdrag eller hur plattformen fungerar – förklara kort och erbjud länk vid behov.
Om frågan inte gäller Curevia, svara kort och professionellt att du endast kan hjälpa till med frågor relaterade till Curevia.`;
  return `${context}\n\nAnvändarens fråga:\n${message}`;
}

// ==== HTTP handler ================================================
export default async function handler(req,res){
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type, Authorization, X-Session-Id, X-Lang, Accept-Language, Accept");
  res.setHeader("Cache-Control","no-store");
  if(req.method==="OPTIONS") return res.status(204).end();

  const ip=(req.headers["x-forwarded-for"]||req.socket?.remoteAddress||"").toString().split(",")[0].trim();
  if(!rateLimitOk(ip)) return res.status(429).json({error:"Too Many Requests"});

  const sessionId=String(req.headers["x-session-id"]||"").slice(0,100)||null;

  // --- Parse body
  let raw=""; try{
    raw=await new Promise((resolve,reject)=>{
      let d=""; req.on("data",c=>{d+=c;if(d.length>128*1024){reject(new Error("Payload too large"));try{req.destroy();}catch{}}});
      req.on("end",()=>resolve(d||"{}")); req.on("error",reject);
    });
  }catch{return res.status(413).json({error:"Payload too large"});}
  let parsed; try{parsed=JSON.parse(raw);}catch{return res.status(400).json({error:"Invalid JSON"});}
  let { message="" }=parsed;
  if(!message.trim()) return res.status(400).json({error:"Missing message"});
  message=dePrompt(message).slice(0,MAX_INPUT_LEN);

  const lang=parseHeaderLang(req);
  const qa=await loadQuickAnswers();

  // Quick FAQ
  const hit=qa.find(q=>q.pattern.test(message));
  if(hit){ return sendJSON(res,{version:SCHEMA_VERSION,reply:hit.reply}); }

  // Sensitive
  if(hasSensitive(message)){
    const msg="Jag kan tyvärr inte ta emot person- eller journaluppgifter här. Hör av dig via en säker kanal 💙";
    return sendJSON(res,{version:SCHEMA_VERSION,reply:msg});
  }

  // Net salary calc
  const amt=parseInvoiceAmount(message);
  if(amt){ const reply=calcNetFromInvoiceExVat(amt); return sendJSON(res,{version:SCHEMA_VERSION,reply}); }

  // Intent
  const intent=detectIntent(message);
  if(intent==="register_provider") return sendJSON(res,{version:SCHEMA_VERSION,reply:`Här kan du registrera din verksamhet: ${LINKS.regProvider}`,url:LINKS.regProvider});
  if(intent==="register_consult")  return sendJSON(res,{version:SCHEMA_VERSION,reply:`Registrera din konsultprofil här: ${LINKS.regConsult}`,url:LINKS.regConsult});
  if(intent==="demo")              return sendJSON(res,{version:SCHEMA_VERSION,reply:`Toppen – låt oss boka en kort demo: ${LINKS.demo}`,url:LINKS.demo});
  if(intent==="contact")           return sendJSON(res,{version:SCHEMA_VERSION,reply:`Fyll i dina uppgifter så hör vi av oss inom kort 💙`,action:ACTIONS.OPEN_CONTACT_FORM});

  // --- GPT fallback ----------------------------------------------
  if(!OPENAI_API_KEY) return res.status(500).json({error:"Missing OPENAI_API_KEY"});
  const userPrompt=await buildUserPrompt(message);
  const system=`${PROMPTS[lang]||PROMPTS.sv}\n${POLICY}`;
  const basePayload={
    model:OPENAI_MODEL,
    temperature:0.35,
    max_tokens:240,
    messages:[{role:"system",content:system},{role:"user",content:userPrompt}],
  };

  const controller=new AbortController();
  const to=setTimeout(()=>controller.abort(),OPENAI_TIMEOUT_MS);

  try{
    if(wantsSSE(req)){
      sseHeaders(res);
      sseSend(res,"meta",{model:OPENAI_MODEL,schema:SCHEMA_VERSION});
      const r=await fetch(`${OPENAI_API_BASE}/chat/completions`,{
        method:"POST",
        headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,"Content-Type":"application/json"},
        body:JSON.stringify({...basePayload,stream:true}),
        signal:controller.signal,
      });
      if(!r.ok||!r.body){const txt=await r.text().catch(()=> "");sseSend(res,"error",{error:"Upstream error",details:txt});res.end();clearTimeout(to);return;}
      const reader=r.body.getReader();const dec=new TextDecoder();let full="";
      while(true){
        const {value,done}=await reader.read();if(done)break;
        const chunk=dec.decode(value,{stream:true});
        const lines=chunk.split(/\r?\n/);
        for(const line of lines){
          if(!line)continue;
          if(line.startsWith("data: ")){
            const data=line.slice(6);
            if(data==="[DONE]")continue;
            try{
              const j=JSON.parse(data);
              const delta=j.choices?.[0]?.delta?.content||"";
              if(delta){full+=delta;sseSend(res,"token",delta);}
            }catch{}
          }
        }
      }
      clearTimeout(to);
      const reply=polishReply(full.trim(),intent,shouldSuggestCTA(message,intent));
      sseSend(res,"final",{version:SCHEMA_VERSION,reply,action:null,url:null});
      res.end(); return;
    } else {
      const r=await fetch(`${OPENAI_API_BASE}/chat/completions`,{
        method:"POST",headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,"Content-Type":"application/json"},
        body:JSON.stringify(basePayload),signal:controller.signal,
      });
      clearTimeout(to);
      const data=await r.json();
      const raw=(data?.choices?.[0]?.message?.content||"").trim();
      const reply=polishReply(raw,intent,shouldSuggestCTA(message,intent));
      return sendJSON(res,{version:SCHEMA_VERSION,reply});
    }
  }catch(e){
    clearTimeout(to);
    if(wantsSSE(req)){try{sseSend(res,"error",{error:String(e?.message||e)});}catch{}try{res.end();}catch{}return;}
    return res.status(500).json({error:String(e?.message||e)});
  }
}
