import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const isVercel = !!process.env.VERCEL;
const DATA_DIR = process.env.DATA_DIR || (isVercel ? "/tmp" : path.join(process.cwd(), "data"));
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "app.db");

let dbInstance = null;

export function getDb(){
  if (dbInstance) return dbInstance;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  dbInstance = new Database(DB_PATH);
  dbInstance.pragma("journal_mode = WAL");
  return dbInstance;
}

export function ensureMigrations(){
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations(
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const applied = new Set(db.prepare("SELECT name FROM migrations").all().map(r => r.name));
  const toApply = [
    { name: "001_init_faqs", sql: `
      CREATE TABLE IF NOT EXISTS faqs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lang TEXT NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        upvotes INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_faqs_lang ON faqs(lang);
      CREATE INDEX IF NOT EXISTS idx_faqs_last_used ON faqs(last_used_at);
    `},
    { name: "002_embeddings", sql: `
      CREATE TABLE IF NOT EXISTS embeddings (
        faq_id INTEGER PRIMARY KEY,
        vector TEXT NOT NULL,
        FOREIGN KEY(faq_id) REFERENCES faqs(id) ON DELETE CASCADE
      );
    `},
    { name: "003_queries", sql: `
      CREATE TABLE IF NOT EXISTS queries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lang TEXT NOT NULL,
        user_text TEXT NOT NULL,
        matched_faq_id INTEGER,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        FOREIGN KEY(matched_faq_id) REFERENCES faqs(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_queries_lang ON queries(lang);
      CREATE INDEX IF NOT EXISTS idx_queries_created ON queries(created_at);
    `}
  ];
  const now = Math.floor(Date.now()/1000);
  const insertMig = db.prepare("INSERT INTO migrations(name, applied_at) VALUES (?, ?)");
  db.transaction(() => {
    for (const m of toApply){
      if (applied.has(m.name)) continue;
      db.exec(m.sql);
      insertMig.run(m.name, now);
    }
  })();
}

export function upsertFaq({ lang, question, answer, vector }){
  const db = getDb();
  const insert = db.prepare("INSERT INTO faqs(lang,question,answer,upvotes,last_used_at) VALUES (?,?,?,?,?)");
  const now = Math.floor(Date.now()/1000);
  const info = insert.run(lang, question, answer, 0, now);
  const faqId = info.lastInsertRowid;
  if (Array.isArray(vector)){
    db.prepare("INSERT OR REPLACE INTO embeddings(faq_id, vector) VALUES (?, ?)").run(faqId, JSON.stringify(vector));
  }
  return faqId;
}

export function recordQuery({ lang, userText, matchedFaqId }){
  const db = getDb();
  db.prepare("INSERT INTO queries(lang,user_text,matched_faq_id) VALUES (?,?,?)").run(lang, userText, matchedFaqId ?? null);
}

export function updateFaqUsage(faqId){
  const db = getDb();
  db.prepare("UPDATE faqs SET last_used_at = strftime('%s','now') WHERE id = ?").run(faqId);
}

export function voteFaq(faqId, delta){
  const db = getDb();
  db.prepare("UPDATE faqs SET upvotes = MAX(0, upvotes + ?) WHERE id = ?").run(delta, faqId);
}

export function getTopFaqs(lang, limit=4){
  const db = getDb();
  const rows = db.prepare("SELECT id, question, answer, upvotes, last_used_at FROM faqs WHERE lang = ?").all(lang);
  const now = Math.floor(Date.now()/1000);
  const scored = rows.map(r => {
    const days = (now - r.last_used_at) / 86400;
    const recency = days < 1 ? 3 : days < 7 ? 2 : days < 30 ? 1 : 0;
    return { ...r, score: r.upvotes * 10 + recency };
  }).sort((a,b)=> b.score - a.score);
  return scored.slice(0, limit);
}

export function findBestMatch({ lang, queryVector, threshold }){
  const db = getDb();
  const rows = db.prepare(`
    SELECT f.id, f.question, f.answer, f.upvotes, f.last_used_at, e.vector AS vector
    FROM faqs f JOIN embeddings e ON e.faq_id = f.id
    WHERE f.lang = ?
  `).all(lang);
  let best = null;
  for (const r of rows){
    const v = JSON.parse(r.vector);
    const sim = cosineSimilarity(queryVector, v);
    if (!best || sim > best.sim) best = { id: r.id, sim, answer: r.answer };
  }
  if (best && best.sim >= threshold) return best;
  return null;
}

export function cosineSimilarity(a, b){
  let dot=0, na=0, nb=0;
  for (let i=0;i<a.length;i++){
    const x=a[i]||0, y=b[i]||0; dot+=x*y; na+=x*x; nb+=y*y;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na)*Math.sqrt(nb));
}

