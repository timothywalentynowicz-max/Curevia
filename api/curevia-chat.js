// api/curevia-chat.js

const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";
const QUICK_ANSWERS_URL = process.env.QUICK_ANSWERS_URL || "";

const LINKS = {
  demo: "https://calendly.com/tim-curevia/30min",
  regConsult: "https://curevia.ai/consultant/register",
  regProvider: "https://curevia.ai/auth?type=signup&returnTo=/employer/register",
  pricingProviders: "https://preview--vardgig-connect.lovable.app/vardgivare",
};

// Varm & kort ton
const SYSTEM_PROMPT = `
Du är Curevia-boten. Svara kort, vänligt och konkret på svenska.

• Föreslå “Boka demo” ENDAST när användaren uttryckligen ber om demo, vill “se plattformen”, ”visa mer”, eller bekräftar att de vill titta i en genomgång.
• Om användaren vill bli kontaktad (t.ex. “kontakta mig”, “ring upp”, “hör av er”): erbjud “Kontakta mig” och initiera kontaktflödet (öppna formulär). Säg kort att vi hör av oss inom kort.
• Ställ hellre en förtydligande fråga än att pusha demo.
• Ge aldrig råd som innehåller personnummer eller journalinformation; hänvisa till säker kanal.
• Ton: varm, proffsig och lösningsorienterad. Max 2–3 meningar per svar.
`;
`;

// quick answers (lågbudget)
const DEFAULT_QA = [
  { pattern: /eget bolag|företag/i,
    reply: `Du behöver inte ha eget bolag – du kan få betalt via Curevia eller fakturera själv om du vill. 👉 Registrera konsultprofil: ${LINKS.regConsult}` },
  { pattern: /utbetal/i,
    reply: `Utbetalning via Curevia sker när vårdgivaren betalat. Har du eget bolag fakturerar du själv, oftast 30 dagar.` },
  { pattern: /inte betalar|försenad betal|betalningspåminn/i,
    reply: `Om en vårdgivare inte betalar i tid driver Curevia ärendet vidare till inkasso och därefter Kronofogden – du ska känna dig trygg att få betalt.` },
  { pattern: /kostnad|pris|avgift|prislista/i,
    reply: `Att testa är gratis – de tre första uppdragen per år är kostnadsfria. Därefter låg avgift. 👉 Prislista: ${LINKS.pricingProviders}` },
  { pattern: /onboard|komma igång|starta|hur börjar/i,
    reply: `Skapa ett uppdrag och välj bland intresserade konsulter – du får en dedikerad kundansvarig som ser till att allt flyter på.` },
  { pattern: /registrera.*(vårdgiv|klinik|mottag)/i, reply: `Registrera vårdgivare: ${LINKS.regProvider}` },
  { pattern: /registrera.*(konsult|sjuksköters|läkar|vård)/i, reply: `Registrera konsult: ${LINKS.regConsult}` },
  { pattern: /boka.*demo|demo|möte|visa/i, reply: `Boka gärna en kort demo så visar vi hur allt funkar: ${LINKS.demo}` },
];

let qaCache = null;
async function loadQuickAnswers(force=false){
  if (!force && qaCache) return qaCache;
  const list = [...DEFAULT_QA];
  if (QUICK_ANSWERS_URL){
    try{
      const r = await fetch(QUICK_ANSWERS_URL, { cache:"no-store" });
      if (r.ok){
        const extra = await r.json();
        for (const item of extra){
          if (item?.pattern && item?.reply){
            list.push({ pattern: new RegExp(item.pattern, "i"), reply: String(item.reply) });
          }
        }
      }
    }catch{}
  }
  qaCache = list;
  return qaCache;
}

function hasSensitive(s=""){
  const pnr = /\b(\d{6}|\d{8})[-+]?\d{4}\b/;
  const journal = /journal|anamnes|diagnos|patient/i;
  return pnr.test(s) || journal.test(s);
}
function detectIntent(text=""){
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

// Regler: när passar CTA?
function shouldSuggestCTA(userText, intent) {
  const t = (userText || "").toLowerCase();
  if (intent === "provider") {
    return /(pris|avgift|gdpr|integration|onboard|kom igång|hur fungerar|testa)/i.test(t);
  }
  if (intent === "consult") {
    return /(uppdrag|ersättn|timlön|kom igång|registrera|hur fungerar)/i.test(t);
  }
  return /(hur|kan ni|vad är|pris|demo|hjälp)/i.test(t);
}

function polishReply(text, intent="general", addCTA=false){
  if (!text) return "Vill du veta mer? Jag visar gärna 🌟 " + LINKS.demo;

  // Max 3 meningar
  const parts = text.replace(/\s+/g," ")
    .split(/(?<=[.!?])\s+/).filter(Boolean).slice(0,3);
  let msg = parts.join(" ");

  // Lägg inte CTA om svaret redan har länk/CTA
  const hasLink = /(https?:\/\/|boka.*demo|registrera)/i.test(msg);

  if (addCTA && !hasLink) {
    if (intent === "provider") msg += ` Vill du kika tillsammans? Boka gärna en kort demo 🌟 ${LINKS.demo}`;
    else if (intent === "consult") msg += ` Vill du komma igång? Registrera dig här 💙 ${LINKS.regConsult}`;
    else msg += ` Vill du veta mer? Jag visar gärna 🌟 ${LINKS.demo}`;
  }
  return msg;
}

export default async function handler(req,res){
  // Status + hot-reload av QA
  if (req.method === "GET"){
    if (req.url?.includes("reload=1")) qaCache = null;
    const qa = await loadQuickAnswers();
    return res.json({ ok:true, route:"/api/curevia-chat", qaCount:qa.length, hasKey:Boolean(OPENAI_API_KEY) });
  }

  if (req.method !== "POST") return res.status(405).end();

  try{
    const body = await new Promise((resolve,reject)=>{
      let d=""; req.on("data",c=>d+=c); req.on("end",()=>resolve(d||"{}")); req.on("error",reject);
    });
    const { message = "" } = JSON.parse(body);

    if (!message || typeof message !== "string") return res.status(400).json({ error:"Missing 'message' string" });
    if (hasSensitive(message)) return res.json({ reply:"Jag kan tyvärr inte ta emot person- eller journaluppgifter här. Hör av dig via en säker kanal så hjälper vi dig vidare 💙" });

    const intent = detectIntent(message);
    if (intent === "register_provider") return res.json({ reply: polishReply(`Här kan du registrera din verksamhet: ${LINKS.regProvider}`, intent, false) });
    if (intent === "register_consult")  return res.json({ reply: polishReply(`Toppen! Registrera din konsultprofil här: ${LINKS.regConsult}`, intent, false) });

    const qa = await loadQuickAnswers();
    const hit = qa.find(q => q.pattern.test(message));
    if (hit) return res.json({ reply: polishReply(hit.reply, intent, shouldSuggestCTA(message,intent)) });

    if (!OPENAI_API_KEY) return res.status(500).json({ error:"Missing OPENAI_API_KEY" });

    const payload = {
      model: "gpt-4o-mini",
      messages: [
        { role:"system", content: `${SYSTEM_PROMPT}\nMål för svaret: ${
          intent==="provider" ? `Hjälp vårdgivare vidare på ett vänligt sätt. CTA endast om det känns naturligt.` :
          intent==="consult"  ? `Hjälp konsulten vidare på ett vänligt sätt. CTA endast om det känns naturligt.` :
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
      body: JSON.stringify(payload)
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error:data });

    const raw = data?.choices?.[0]?.message?.content?.trim() || "";
    const reply = polishReply(raw, intent, shouldSuggestCTA(message,intent));
    return res.json({ reply });
  }catch(e){
    return res.status(500).json({ error:String(e) });
  }
}
