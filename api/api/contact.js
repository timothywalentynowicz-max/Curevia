// api/contact.js
const RESEND_API_KEY = process.env.RESEND_API_KEY;          // skapas i Resend.com
const TO_EMAIL = process.env.CONTACT_TO_EMAIL || "tim@curevia.ai";
const FROM_EMAIL = process.env.CONTACT_FROM_EMAIL || "no-reply@curevia.ai";

function clean(s=""){ return String(s || "").trim(); }

export default async function handler(req, res){
  if (req.method !== "POST") return res.status(405).end();

  try {
    const body = await new Promise((resolve, reject) => {
      let d=""; req.on("data", c=>d+=c); req.on("end", ()=>resolve(d||"{}")); req.on("error", reject);
    });
    const { name, email, phone, message } = JSON.parse(body);

    const n = clean(name), e = clean(email), p = clean(phone), m = clean(message);

    if (!n || !e) return res.status(400).json({ ok:false, error:"Name and email are required" });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return res.status(400).json({ ok:false, error:"Invalid email" });

    if (!RESEND_API_KEY) {
      // Ingen nyckel – logga på servern så ni ser att det kom in
      console.log("CONTACT (no email sent)", { n, e, p, m });
      return res.status(200).json({ ok:true, message:"Tack! Vi hör av oss inom kort." });
    }

    const html = `
      <h2>Ny kontakt från Curevia-chatten</h2>
      <p><b>Namn:</b> ${n}</p>
      <p><b>E-post:</b> ${e}</p>
      <p><b>Telefon:</b> ${p || "-"}</p>
      <p><b>Meddelande:</b><br>${(m||"-").replace(/\n/g,"<br>")}</p>
      <hr><small>Skickad ${new Date().toISOString()}</small>
    `;

    const emailPayload = {
      from: FROM_EMAIL,
      to: TO_EMAIL,
      subject: "Kontaktförfrågan via Curevia-chatten",
      html
    };

    const r = await fetch("https://api.resend.com/emails", {
      method:"POST",
      headers:{
        "Authorization":`Bearer ${RESEND_API_KEY}`,
        "Content-Type":"application/json"
      },
      body: JSON.stringify(emailPayload)
    });

    const data = await r.json();
    if (!r.ok) return res.status(502).json({ ok:false, error:data });

    return res.status(200).json({ ok:true, message:"Tack! Vi hör av oss inom kort." });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
}
