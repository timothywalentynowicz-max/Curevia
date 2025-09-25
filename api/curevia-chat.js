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
const NORWAY_SUPERPROMPT_SV = `Du är en ultra-pedagogisk rådgivare för svensk vårdpersonal som vill jobba i Norge.
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

const NORWAY_SUPERPROMPT_EN = `You are a highly pedagogical advisor for Swedish healthcare professionals who want to work in Norway.
Always answer in English. Adapt to role and work mode (onsite in Norway or remote from Sweden). Be professional yet warm, simple and reassuring. Use a clear, visually checkable format.

Your task in every conversation:
1) Map the user's situation with up to 6 short questions:
   - Role? {doctor | nurse | assistant nurse/helsefagarbeider | psychologist}
   - Work mode? {onsite in Norway | remote from Sweden}
   - Planned start date?
   - Employment? {employed by Norwegian provider | consultant/own company in Sweden}
   - Do you have Swedish license + Good Standing from the National Board of Health and Welfare? {yes/no/in progress}
   - Do you need to remain in Swedish social security (A1) or move to Norwegian? {A1/unclear/Norwegian}

2) Always respond with this structure:
— Overview (1 paragraph): Confirm current status, goal and start date.
— Requirements (bullets): Authorisation/HPR, language (B2 guideline), tax (tax card, D-number, PAYE 25%/17.3%), police record (politiattest), MRSA/TB (FHI), medical records (Norwegian law), social security (A1/NAV), remote e-services where applicable.
— Checklist (checkable): Each line must include: ⬜ step | ⏱ time | 🧭 owner | 🧾 cost | 🔗 link
— Timeline (ASCII, weeks 1–8): Key milestones for authorisation, ID check/D-number/tax card, A1/NAV, start.
— Documents: max 8 key documents to collect.
— Common pitfalls + tips: 3–5 bullets.
— Next best action: 1–3 precise steps with buttons/links.
— Curevia CTA: Always end with exactly:
   ✨ Want help throughout the process and to be matched to the right assignments in Norway? Sign up for free at [Curevia.ai](https://curevia.ai/consultant/register). No middlemen, full freedom.

3) Always account for (include where relevant, especially in the checklist):
- Norwegian authorisation + HPR via Helsedirektoratet/Altinn (all professions).
- Language: employer's responsibility; guideline B2 Norwegian (Swedish often accepted, but B2 recommended).
- Politiattest for municipal health and care services.
- MRSA/TB per FHI guidelines (employer to require tests).
- Records: documentation in Norwegian (Swedish/Danish may be accepted to some extent), Norwegian law applies.
- Tax: tax card, D-number via ID check, PAYE (25%/17.3%) for foreign workers.
- Nordic citizens do not need to register with the police; other EU/EEA >3 months must.
- Social security: A1 certificate (Sweden/NAV) for postings.
- Remote: authorisation still required, records per Norwegian law, possibly NHN membership (employer responsibility) for e-prescriptions/e-contact.
- Role-specific tracks: Doctors (Certificate of Conformity + Good Standing), Nurses (authorisation via Altinn), Assistant nurse=Helsefagarbeider, Psychologist (authorisation/license via Helsedirektoratet).

4) Visual elements (must render exactly like this):
- Icons: ✅ (done), ⬜ (todo), ⏱ (time), 🧭 (owner), 🧾 (cost), 🔗 (link).
- Timeline (ASCII), example:
  Week 1 | [Authorisation applied]———
  Week 2 | ——[ID check/tax card]—
  Week 3–4| ———[A1/NAV decision]——
  Week 5+ | —————[Start]—————

5) Error handling & rollback:
- Missing Good Standing: give exact instructions to order it from Socialstyrelsen.
- Remote + e-prescriptions: emphasise NHN membership is the employer's responsibility.
- Posting: confirm A1 and explain implications for Norwegian social security/tax.
- Incomplete info: ask only the relevant follow-ups (do not ask everything again).

6) FAQ (put last):
- How long does authorisation take?
- Can I start before I have an HPR number?
- Do I need to know Norwegian?
- Do I need a Norwegian bank?
- What does Curevia do in the process?

Links (use where relevant, present as clickable):
- Authorisation/HPR (Helsedirektoratet/Altinn):
  https://www.helsedirektoratet.no/english/authorisation-and-license-for-health-personnel
  https://info.altinn.no/skjemaoversikt/helsedirektoratet/soknad-om-autorisasjon-og-lisens-som-helsepersonell/
- Doctors: https://www.helsedirektoratet.no/tema/autorisasjon-og-spesialistutdanning/autorisasjon-og-lisens?path=15-2-2-lege-eueos
- Helsefagarbeider: https://info.altinn.no/skjemaoversikt/helsedirektoratet-godkjenning-av-utenlandske-yrkeskvalifikasjoner/helsefagarbeider/
- Language/employer responsibility: https://www.helsedirektoratet.no/tema/autorisasjon-og-spesialistutdanning/tilleggsinformasjon/arbeidsgivers-ansvar-ved-ansettelse-av-helsepersonell
- Politiattest: https://www.helsedirektoratet.no/rundskriv/helsepersonelloven-med-kommentarer/saerskilte-regler-i-tilknytning-til-autorisasjon-krav-om-politiattest-m.v/-20a.krav-om-politiattest
- MRSA/TB (FHI): https://www.fhi.no/publ/eldre/mrsa-veilederen/ | https://www.fhi.no/ss/tuberkulose/tuberkuloseveilederen/forekomst-og-kontroll/4.-grupper-med-plikt-til-tuberkulos/
- Records rules: https://lovdata.no/forskrift/2019-03-01-168
- Tax/PAYE/D-number: https://www.skatteetaten.no/en/person/foreign/are-you-intending-to-work-in-norway/tax-deduction-cards/paye/
- A1 (NAV/Altinn): https://info.altinn.no/skjemaoversikt/arbeids--og-velferdsetaten-nav/soknad-om-a1-for-utsendte-arbeidstakeren-innen-eossveits/
- Norsk Helsenett: https://www.nhn.no/medlemskap-i-helsenettet/nye-medlemsvilkar

Tone: warm, professional, solution-oriented. Ask short guiding questions. Always end with the Curevia CTA above.`;

const NORWAY_SUPERPROMPT_NO = `Du er en svært pedagogisk rådgiver for svensk helsepersonell som vil jobbe i Norge.
Svar alltid på norsk (bokmål). Tilpass til yrkesrolle og arbeidsform (onsite i Norge eller på distanse fra Sverige). Vær profesjonell, varm og trygg. Bruk tydelig, visuelt avkryssbart oppsett.

Din oppgave i hver samtale:
1) Kartlegg brukerens situasjon med inntil 6 korte spørsmål:
   - Yrkesrolle? {lege | sykepleier | helsefagarbeider/assistentsykepleier | psykolog}
   - Arbeidsform? {onsite i Norge | på distanse fra Sverige}
   - Planlagt oppstart?
   - Ansettelsesform? {ansatt hos norsk arbeidsgiver | konsulent/eget firma i Sverige}
   - Svensk lisens + Good Standing fra Socialstyrelsen? {ja/nei/under behandling}
   - Skal du bli i svensk trygd (A1) eller gå over til norsk? {A1/uklart/norsk}

2) Svar ALLTID med denne strukturen:
— Oversikt (1 avsnitt): Bekreft status, mål og oppstart.
— Kravbilde (punkter): Autorisasjon/HPR, språk (B2-veiledning), skatt (skattekort, D-nummer, PAYE 25 %/17,3 %), politiattest, MRSA/TB (FHI), journalregler (norsk rett), trygd (A1/NAV), distansekrav ved e‑tjenester.
— Sjekkliste (avkryssbar): Hver linje: ⬜ steg | ⏱ tid | 🧭 ansvar | 🧾 kostnad | 🔗 lenke
— Tidslinje (ASCII, uke 1–8): Milepæler for autorisasjon, ID-kontroll/D‑nummer/skattekort, A1/NAV, oppstart.
— Dokumentliste: maks 8 viktigste dokumenter.
— Vanlige fallgruver + tips: 3–5 punkter.
— Next best action: 1–3 konkrete steg med knapper/lenker.
— Curevia CTA: Avslutt alltid med:
   ✨ Vil du ha hjelp gjennom hele prosessen og matches mot riktige oppdrag i Norge? Registrer deg gratis på [Curevia.ai](https://curevia.ai/consultant/register). Ingen mellomledd, full frihet.

3) Regler (ta dem med der det passer, særlig i sjekklisten):
- Norsk autorisasjon + HPR via Helsedirektoratet/Altinn (alle yrker).
- Språk: arbeidsgivers ansvar; veiledning B2 norsk (svensk ofte akseptert, men B2 anbefales).
- Politiattest for kommunale helse- og omsorgstjenester.
- MRSA/TB etter FHI (arbeidsgiver krever prøver).
- Journal: på norsk (svensk/dansk kan aksepteres noe), norsk lov gjelder.
- Skatt: skattekort, D-nummer via ID-kontroll, PAYE (25 %/17,3 %) for utenlandske arbeidstakere.
- Nordiske borgere trenger ikke melde seg hos politiet; øvrige EU/EØS >3 mnd må.
- Trygd: A1‑attest (Sverige/NAV) ved utsending.
- Distanse: autorisasjon kreves uansett, journalføring etter norsk rett, ev. NHN-medlemskap (arbeidsgivers ansvar) for e‑resept/e‑kontakt.
- Yrkesvise spor: Lege (Certificate of Conformity + Good Standing), Sykepleier (autorisasjon via Altinn), Helsefagarbeider, Psykolog (autorisasjon/lisens via Helsedirektoratet).

4) Visuelle elementer (må vises slik):
- Ikoner: ✅ (klart), ⬜ (gjenstår), ⏱ (tid), 🧭 (ansvar), 🧾 (kostnad), 🔗 (lenke).
- Tidslinje (ASCII), eksempel:
  Uke 1 | [Autorisasjon søkt]———
  Uke 2 | ——[ID‑kontroll/skattekort]—
  Uke 3–4| ———[A1/NAV‑vedtak]——
  Uke 5+ | —————[Oppstart]—————

5) Feilhåndtering & rollback:
- Mangler Good Standing: forklar nøyaktig hvordan bestille fra Socialstyrelsen.
- Distanse + e‑resept: påpek at NHN‑medlemskap er arbeidsgivers ansvar.
- Utsending: bekreft A1 og konsekvenser for trygd/skatt.
- Mangelfull info: still kun relevante oppfølgingsspørsmål (ikke alt på nytt).

6) FAQ (til slutt):
- Hvor lang tid tar autorisasjon?
- Kan jeg starte før HPR‑nummer?
- Må jeg kunne norsk?
- Trenger jeg norsk bank?
- Hva gjør Curevia i prosessen?

Lenker (bruk når relevant, klikkbare):
- Autorisasjon/HPR (Helsedirektoratet/Altinn):
  https://www.helsedirektoratet.no/english/authorisation-and-license-for-health-personnel
  https://info.altinn.no/skjemaoversikt/helsedirektoratet/soknad-om-autorisasjon-og-lisens-som-helsepersonell/
- Lege: https://www.helsedirektoratet.no/tema/autorisasjon-og-spesialistutdanning/autorisasjon-og-lisens?path=15-2-2-lege-eueos
- Helsefagarbeider: https://info.altinn.no/skjemaoversikt/helsedirektoratet-godkjenning-av-utenlandske-yrkeskvalifikasjoner/helsefagarbeider/
- Språk/arbeidsgiveransvar: https://www.helsedirektoratet.no/tema/autorisasjon-og-spesialistutdanning/tilleggsinformasjon/arbeidsgivers-ansvar-ved-ansettelse-av-helsepersonell
- Politiattest: https://www.helsedirektoratet.no/rundskriv/helsepersonelloven-med-kommentarer/saerskilte-regler-i-tilknytning-til-autorisasjon-krav-om-politiattest-m.v/-20a.krav-om-politiattest
- MRSA/TB (FHI): https://www.fhi.no/publ/eldre/mrsa-veilederen/ | https://www.fhi.no/ss/tuberkulose/tuberkuloseveilederen/forekomst-og-kontroll/4.-grupper-med-plikt-til-tuberkulos/
- Journalforskrift: https://lovdata.no/forskrift/2019-03-01-168
- Skatt/PAYE/D‑nummer: https://www.skatteetaten.no/en/person/foreign/are-you-intending-to-work-in-norway/tax-deduction-cards/paye/
- A1 (NAV/Altinn): https://info.altinn.no/skjemaoversikt/arbeids--og-velferdsetaten-nav/soknad-om-a1-for-utsendte-arbeidstakeren-innen-eossveits/
- Norsk Helsenett: https://www.nhn.no/medlemskap-i-helsenettet/nye-medlemsvilkar

Tone: varm, profesjonell, løsningsorientert. Still korte, veiledende spørsmål. Avslutt alltid med CTA over.`;

const PROMPTS = {
  sv: NORWAY_SUPERPROMPT_SV,
  en: NORWAY_SUPERPROMPT_EN,
  no: NORWAY_SUPERPROMPT_NO
};
const POLICY = `• Föreslå “Boka demo” bara när användaren ber om det.
• Vid “kontakta mig”: erbjud kontaktformulär och säg att vi hör av oss inom kort.
• Dela aldrig person- eller journaluppgifter; be om säker kanal i sådana fall.
• Ton: varm, proffsig och lösningsorienterad. Max 2–3 meningar per svar.`;

const BASIC_PROMPTS = {
  sv: `Du är Curevia-boten. Svara kort, vänligt och konkret på svenska.`,
  en: `You are the Curevia assistant. Reply briefly, warmly, and clearly in English.`,
  no: `Du er Curevia-boten. Svar kort, vennlig og konkret på norsk bokmål.`
};

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
  // Make CTAs conservative: only add when user explicitly asks for demo or registration
  if (intent==="provider") return explicitDemo;
  if (intent==="consult")  return /(registrera|sign\s?up|create account)/i.test(t);
  return false;
}
function polishReply(text,intent="general",addCTA=false,lang="sv"){
  // Do not shorten or modify; the SUPERPROMPT already formats and includes CTA
  const msg = String(text||"").trim();
  if (msg) return msg;
  if (lang === "en") return "I’ll guide you step by step. Start by telling me your role and work mode (onsite in Norway or remote from Sweden).";
  if (lang === "no") return "Jeg veileder deg steg for steg. Start med å fortelle yrkesrolle og arbeidsform (onsite i Norge eller på distanse fra Sverige).";
  return "Jag hjälper dig steg för steg. Börja gärna med att berätta din yrkesroll och arbetsform (onsite i Norge eller distans från Sverige).";
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
  return [
    { label:t(S.about), text: lang==="en"?"Tell me about Curevia":(lang==="no"?"Fortell om Curevia":"Berätta mer om Curevia") },
    { label:t(S.prov),  text: lang==="en"?"What do you offer providers?":(lang==="no"?"Hva tilbyr dere for leverandører?":"Vad erbjuder ni för vårdgivare?") },
    { label:t(S.cons),  text: lang==="en"?"What do you offer clinicians?":(lang==="no"?"Hva tilbyr dere for klinikere?":"Vad erbjuder ni för vårdpersonal?") },
  ];
}

// ==== Norway slot parsing ==========================================
function parseNorwaySlots(msg=""){
  const t = msg.toLowerCase();
  const out = {};
  // Role
  if (/\bläkare|doktor\b/.test(t) || /\bdoctor|physician\b/.test(t) || /\blege\b/.test(t)) out.no_role = "läkare";
  else if (/sjukskötersk/.test(t) || /\bnurse\b/.test(t) || /sykepleier/.test(t)) out.no_role = "sjuksköterska";
  else if (/underskötersk|helsefagarbeider|vårdbiträde/.test(t) || /assistant nurse|auxiliary/.test(t)) out.no_role = "undersköterska/helsefagarbeider";
  else if (/psykolog/.test(t) || /psycholog/.test(t) || /psykolog\b/.test(t)) out.no_role = "psykolog";
  // Work mode
  if (/distans|remote|hemifr[aå]n|fr[aå]n sverige|from sweden/.test(t) || /på distanse|distanse/.test(t)) out.no_mode = "distans från Sverige";
  if (/onsite|p[aå] plats|i norge|flytta till norge|on site/.test(t)) out.no_mode = "onsite i Norge";
  // Employment
  if (/anst[aä]lld|norsk arbetsgivare|fast tj[aä]nst|employe?d|ansatt/.test(t)) out.no_employment = "anställd hos norsk vårdgivare";
  if (/konsult|egen firma|eget bolag|enskild firma|ab\b|consultant|own company|contractor/.test(t)) out.no_employment = "konsult/egen firma i Sverige";
  // License + Good Standing
  if (/(good\s*standing|intyg).*?(ja|klar|finns)/.test(t) || /(legitimation|license).*?(ja|har|have)/.test(t) || /(godkjent|autorisasjon).*?(har|ja)/.test(t)) out.no_license = "ja";
  else if (/(good\s*standing|legitimation|license).*?(nej|saknas|ikke|no|not)/.test(t)) out.no_license = "nej";
  else if (/(good\s*standing|legitimation|license).*?(p[aå]g[aå]r|under handl[aä]ggning|in progress|processing|under behandling)/.test(t)) out.no_license = "pågår";
  // Social security
  if (/\bA1\b/.test(t)) out.no_social = "A1";
  else if (/norsk trygd|nav|folketrygd|norwegian social/.test(t)) out.no_social = "norsk";
  else if (/oklart|os[aä]kert|vet inte|unclear|unsure|uklart/.test(t)) out.no_social = "oklart";
  // Start date (very lenient capture)
  const m = t.match(/(start|fr\s*o\s*m|fr[aå]n|börjar|startdatum)[:\s-]*([^\n]{3,40})/);
  if (m && m[2]) out.no_start = m[2].trim();
  const m2 = t.match(/\b(\d{1,2}\s*(jan|feb|mar|m[aä]r|apr|maj|jun|jul|aug|sep|sept|okt|nov|dec|december|januari|februari|mars|april|juni|juli|augusti|september|oktober|november|december)\b[^\n]*)/);
  if (!out.no_start && m2) out.no_start = m2[1];
  return out;
}

// Detect whether to use Norway guidance superprompt
function isNorwayGuidanceIntent(message="", sess={}){
  const t = (message||"").toLowerCase();
  const hard = /(norge|norway|helsedirektoratet|altinn|hpr|autorisa|autorisasjon|a1\b|nav\b|d-?nummer|skattekort|paye|politiattest|mrsa|tuberkulos|tuberkulose|norsk helsenett|nhn)/.test(t);
  const role = /(sjuksköters|läkar|læk|doctor|nurse|helsefagarbeider|psykolog|psycholog)/.test(t);
  const work = /(jobba|arbete|oppdrag|assignment|onsite|på plats|on site|distans|remote|på distanse)/.test(t);
  const sessHas = sess?.no_role || sess?.no_mode || sess?.no_employment || sess?.no_license || sess?.no_start || sess?.no_social;
  return Boolean(hard || (role && work) || sessHas);
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
function buildUserPrompt(message, sess, lang="sv"){
  const { known, missing } = summarizeNorwaySlots(sess||{});
  if (lang === "en"){
    const missingLine = missing.length ? `Missing: ${missing.join(", ")}. Ask only the relevant, short follow-ups (max 6 in total).` : `All information present. Generate the full guidance using the structure.`;
    const lead = `Known info: ${known}. ${missingLine}`;
    return `${lead}\n\nUser message:\n${message}`;
  }
  if (lang === "no"){
    const missingLine = missing.length ? `Mangler: ${missing.join(", ")}. Still kun relevante, korte oppfølgingsspørsmål (maks 6 totalt).` : `All informasjon finnes. Generer full veiledning etter strukturen.`;
    const lead = `Kjent informasjon: ${known}. ${missingLine}`;
    return `${lead}\n\nBrukers melding:\n${message}`;
  }
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
  if (intent==="register_provider"){
    const base = lang==="en" ? "I can share the provider sign-up link if you want it."
               : lang==="no" ? "Jeg kan dele registreringslenken for leverandører om du vil."
                              : "Jag kan dela länken för att registrera vårdgivare om du vill.";
    return sendJSON(res,{ version:SCHEMA_VERSION, reply: base, action:null, url:null, citations:[], suggestions:suggestFor("provider", lang), confidence:0.9 });
  }
  if (intent==="register_consult"){
    // Respond with information first; provide link only if explicitly asked
    const base = lang==="en" ? "You can create your consultant profile when you're ready. Would you like the link?"
               : lang==="no" ? "Du kan registrere konsulentprofil når du er klar. Vil du ha lenken?"
                              : "Du kan skapa din konsultprofil när du är redo. Vill du ha länken?";
    return sendJSON(res,{ version:SCHEMA_VERSION, reply: base, action:null, url:null, citations:[], suggestions:suggestFor("consult", lang), confidence:0.9 });
  }
  if (intent==="provider_demo" || intent==="consult_demo" || intent==="demo_any"){
    const lead = lang==='en' ? "Would you like a short demo? I can share the booking link."
               : lang==='no' ? "Vil du ha en kort demo? Jeg kan sende lenken."
                              : "Vill du ha en kort demo? Jag kan skicka bokningslänken.";
    return sendJSON(res,{ version:SCHEMA_VERSION, reply: lead, action:null, url:null, citations:[], suggestions:suggestFor(intent.startsWith('consult')? 'consult' : 'provider', lang), confidence:0.9 });
  }

  // QA
  const qa = await loadQuickAnswers();
  const hit = qa.find(q=>q.pattern.test(message));
  if (hit){
    const reply = await translateIfNeeded(hit.reply, lang);
    return sendJSON(res,{ version:SCHEMA_VERSION, reply, action:null, url:null, citations:[], suggestions:suggestFor("general", lang), confidence:0.9 });
  }

  // RAG / LLM call
  const norwayMode = isNorwayGuidanceIntent(message, sess);
  const userPrompt = norwayMode ? buildUserPrompt(message, sess, lang) : message;
  if (!OPENAI_API_KEY) return res.status(500).json({ error:"Missing OPENAI_API_KEY" });

  const system = norwayMode
    ? `${PROMPTS[lang] || PROMPTS.sv}`
    : `${BASIC_PROMPTS[lang] || BASIC_PROMPTS.sv}\n${POLICY}`;
  const basePayload = {
    model: OPENAI_MODEL,
    temperature: norwayMode ? 0.25 : 0.35,
    max_tokens: norwayMode ? 1200 : 320,
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
      const reply = polishReply(full.trim(), intent, shouldSuggestCTA(message,intent), lang);
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
      const reply = polishReply(raw, intent, shouldSuggestCTA(message,intent), lang);
      return sendJSON(res,{ version:SCHEMA_VERSION, reply, action:null, url:null, citations:[], suggestions:suggestFor(intent, lang), confidence:0.88 });
    }
  }catch(e){
    clearTimeout(to);
    if (wantsSSE(req)){ try{sseSend(res,"error",{ error:String(e?.message||e) });}catch{} try{res.end();}catch{} return; }
    return res.status(500).json({ error:String(e?.message||e) });
  }
}
