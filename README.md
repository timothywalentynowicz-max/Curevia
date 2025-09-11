# Curevia Chat – i18n, KB+GPT, Top4, Calculator

## Setup

1. Requirements: Node.js 20
2. Install deps:

```bash
npm ci
```

3. Environment (.env or process env):

- OPENAI_API_KEY (for production GPT fallback; tests use TEST_FAKE_OPENAI=1)
- SEARCH_SIMILARITY_THRESHOLD (default 0.82)
- FEATURE_FAQ_TOP4=1
- FEATURE_FALLBACK_OPENAI=1

## Run locally

```bash
npm run migrate
npm run dev:seed
npm run dev
```

Open `http://localhost:8787/chat.html`

## Migrations & Seed

- `npm run migrate` – creates tables (`faqs`, `embeddings`, `queries`)
- `npm run dev:seed` – adds 5 FAQs per language (`sv`, `en`, `no`, `da`)

## Testing

- Unit: `npm test`
- E2E (requires server running): `npm run e2e`

Coverage thresholds are set to 80% and enforced in CI.

## Features

- i18n (sv, en, no, da) auto-detect via `Accept-Language`, cookie, URL; manual switcher in UI
- Net salary calculator with real-time localized output
- Knowledge base with semantic search and GPT-4o-mini fallback (cached to DB)
- Top 4 FAQ chips per language on start, voting via thumbs up/down, rate-limited OpenAI calls
- Accessibility: aria labels, keyboard focus states

## Privacy & Security

- User queries are anonymized before storing (`email`, `phone`, `personnummer` masked)
- OpenAI calls rate-limited to 10/min/IP

