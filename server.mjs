import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import cookie from "cookie";
import chatHandler from "./api/curevia-chat.js";
import contactHandler from "./api/contact.js";
import { ensureMigrations } from "./src/db.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8787;

app.use(express.json({ limit: "1mb" }));

// Static
app.use(express.static(path.join(__dirname, "public")));
app.use("/locales", express.static(path.join(__dirname, "locales")));

// Cookie parser (minimal)
app.use((req, _res, next) => {
  const c = req.headers.cookie ? cookie.parse(req.headers.cookie) : {};
  req.cookies = c;
  next();
});

// API routes
app.all("/api/curevia-chat", (req, res) => chatHandler(req, res));
app.all("/api/contact", (req, res) => contactHandler(req, res));

// Health
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Start
ensureMigrations().then(() => {
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}).catch((e) => {
  console.error("Failed to run migrations:", e);
  process.exit(1);
});

