// api/contact.js
//
// Tar emot { name, email, phone, message } och skickar e-post via Resend.
// Läser följande env-variabler i Vercel:
// - RESEND_API_KEY        (re_... nyckel)
// - CONTACT_TO_EMAIL      (mottagare, t.ex. tim@curevia.ai)
// - CONTACT_FROM_EMAIL    (avsändare, t.ex. info@curevia.ai – måste vara verifierad i Resend)

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const TO_EMAIL       = process.env.CONTACT_TO_EMAIL || "tim@curevia.ai";
const FROM_EMAIL     = process.env.CONTACT_FROM_EMAIL || "info@curevia.ai";

// Enkel sanering
function clean(s = "") {
  return String(s).trim().slice(0, 1000);
}

function isEmail(s = "") {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
}

// Liten CORS-hjälp om du vill anropa från andra origin
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end(); // preflight

  if (req.method !== "POST") return res.status(405).end();

  try {
    // Läs inkommande body (Vercel/Node)
    const raw = await new Promise((resolve, reject) => {
      let d = "";
      req.on("data", (c) => (d += c));
      req.on("end", () => resolve(d || "{}"));
      req.on("error", reject);
    });

    const { name, email, phone, message } = JSON.parse(raw);

    const n = clean(name);
    const e = clean(email);
    const p = clean(phone);
    const m = clean(message);

    if (!n || !e) {
      return res.status(400).json({ ok: false, error: "Namn och e-post krävs." });
    }
    if (!isEmail(e)) {
      return res.status(400).json({ ok: false, error: "Ogiltig e-postadress." });
    }

    // Om Resend saknas -> logga och kvittera OK så ni inte tappar leads under setup
    if (!RESEND_API_KEY) {
      console.log("CONTACT (no RESEND_API_KEY) ->", { n, e, p, m });
      return res.status(200).json({ ok: true, message: "Tack! Vi hör av oss inom kort." });
    }

    const html = `
      <h2>Ny kontakt från Curevia-chatten</h2>
      <p><b>Namn:</b> ${n}</p>
      <p><b>E-post:</b> ${e}</p>
      <p><b>Telefon:</b> ${p || "-"}</p>
      <p><b>Meddelande:</b><br>${(m || "-").replace(/\n/g, "<br>")}</p>
      <hr>
      <small>Skickad: ${new Date().toISOString()}</small>
    `;

    // Bygg payload till Resend
    const payload = {
      from: FROM_EMAIL,
      to: TO_EMAIL,
      subject: "Kontaktförfrågan via Curevia-chatten",
      html,
      // Gör det lätt att svara direkt till den som skrev
      reply_to: e
    };

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await r.json();
    if (!r.ok) {
      // Skicka tillbaka felet så du kan se det i Network/Logs
      return res.status(502).json({ ok: false, error: data });
    }

    return res.status(200).json({ ok: true, message: "Tack! Vi hör av oss inom kort." });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
