export const SUPPORTED_LANGS = ["sv", "en", "no", "da"];

export function detectLang({ header = "", cookie = "", url = "" } = {}){
  const fromUrl = (() => {
    const m = String(url).match(/[?&#]lang=([a-z-]+)/i); return m ? m[1].toLowerCase() : null;
  })();
  const cookies = Object.fromEntries(String(cookie).split(/;\s*/).map(s=>{
    const i=s.indexOf("="); if(i<0) return [s,""]; return [s.slice(0,i), decodeURIComponent(s.slice(i+1))];
  }).filter(Boolean));
  const fromCookie = (cookies.lang || cookies.LANG || cookies.locale || "").toLowerCase();
  const fromHeader = String(header).toLowerCase();
  const all = [fromUrl, fromCookie, fromHeader].filter(Boolean);
  for (const pick of all){
    if (/^sv|swedish|se-?/.test(pick)) return "sv";
    if (/^en|english|gb|us|uk/.test(pick)) return "en";
    if (/^no|nb|nn|norsk|norwegian/.test(pick)) return "no";
    if (/^da|danish|dk/.test(pick)) return "da";
  }
  return "sv";
}

export const NET_FACTORS = { sv: 0.55, en: 0.55, no: 0.57, da: 0.56 };

export function formatCurrency(n, lang){
  const locales = { sv: "sv-SE", en: "en-GB", no: "nb-NO", da: "da-DK" };
  const cur = { sv: "SEK", en: "SEK", no: "NOK", da: "DKK" };
  const fmt = new Intl.NumberFormat(locales[lang] || "sv-SE", { style:"currency", currency: cur[lang] || "SEK", maximumFractionDigits:0 });
  return fmt.format(n);
}

export function parseAmount(text){
  const cleaned = String(text).replace(/[^0-9,\.\s]/g, "").replace(/\s+/g, "");
  const comma = cleaned.lastIndexOf(",");
  const dot = cleaned.lastIndexOf(".");
  let normalized = cleaned;
  if (comma > dot) normalized = cleaned.replace(/\./g, "").replace(",", ".");
  else normalized = cleaned.replace(/,/g, "");
  const num = Number(normalized);
  return Number.isFinite(num) ? num : NaN;
}

