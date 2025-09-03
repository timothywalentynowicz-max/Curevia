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
      .ma
