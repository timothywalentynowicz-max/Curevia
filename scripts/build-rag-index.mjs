// scripts/build-rag-index.mjs
// Usage: node scripts/build-rag-index.mjs
// ENV: OPENAI_API_KEY, OPENAI_EMBED_MODEL (optional)

import fs from "node:fs/promises";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";

// 1) Lista källor du vill indexera (lägg till fler Curevia-sidor här)
const SOURCES = [
  { url: "https://curevia.ai/consultant/register", title: "Registrera som konsult" },
  { url: "https://curevia.ai/employer", title: "För vårdgivare" },
  { url: "https://curevia.ai/blogg/stafettlakare-myter-och-fakta", title: "Stafettläkare – myter och fakta" },
  { url: "https://preview--vardgig-connect.lovable.app/vardgivare", title: "Prislista vårdgivare" },
];

async function fetchText(url){
  const r = await fetch(url);
  const html = await r.text();
  // Minimal text-extraktion (för mer robust: använd Readability eller CMS-API)
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi," ")
    .replace(/<style[\s\S]*?<\/style>/gi," ")
    .replace(/<[^>]+>/g," ")
    .replace(/\s+/g," ")
    .trim();
  return text.slice(0, 20000); // skydda embedding-kostnad
}

function chunkText(text, maxLen=900){
  const words = text.split(/\s+/);
  const chunks = [];
  let cur=[];
  for (const w of words){
    cur.push(w);
    if (cur.join(" ").length > maxLen){
      chunks.push(cur.join(" "));
      cur = [];
    }
  }
  if (cur.length) chunks.push(cur.join(" "));
  return chunks;
}

async function embed(text){
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method:"POST",
    headers:{ "Authorization":`Bearer ${OPENAI_API_KEY}`, "Content-Type":"application/json" },
    body: JSON.stringify({ input:text, model: OPENAI_EMBED_MODEL })
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Embeddings failed: "+JSON.stringify(j));
  return j.data[0].embedding;
}

async function main(){
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
  const out = { dims: null, chunks: [] };
  let id = 1;

  for (const src of SOURCES){
    console.log("Fetching", src.url);
    const text = await fetchText(src.url);
    const parts = chunkText(text);
    for (const p of parts){
      console.log("Embedding chunk", id);
      const vec = await embed(p);
      if (!out.dims) out.dims = vec.length;
      out.chunks.push({
        id: id++,
        url: src.url,
        title: src.title,
        text: p,
        embedding: vec
      });
    }
  }

  await fs.mkdir("./.rag", { recursive:true });
  await fs.writeFile("./.rag/curevia-rag-index.json", JSON.stringify(out));
  console.log("Wrote ./.rag/curevia-rag-index.json");
}

main().catch(e => { console.error(e); process.exit(1); });

