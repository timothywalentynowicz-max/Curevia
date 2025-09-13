# Architecture Overview

## Flow

1. Client (`public/chat.html`) boots and requests `/api/curevia-chat` metadata with `Accept-Language` header.
2. Server detects language (URL param, cookie, header; fallback `sv`).
3. Server returns Top 4 FAQs for that language (if `FEATURE_FAQ_TOP4`), plus suggested chips.
4. When a user asks a question:
   - Message is anonymized and language is stored in session.
   - Semantic search: we embed the query (OpenAI or test fake) and compute cosine similarity vs stored `embeddings` joined to `faqs`.
   - If similarity ≥ `SEARCH_SIMILARITY_THRESHOLD`, return cached FAQ answer and update usage.
   - Else, if `FEATURE_FALLBACK_OPENAI` and `OPENAI_API_KEY` present and within rate-limit, call GPT (`gpt-4o-mini`).
   - The response is polished and cached back into DB as a new FAQ with its embedding.

## Data Model

- `faqs(id, lang, question, answer, upvotes, last_used_at)`
- `embeddings(faq_id, vector)` where `vector` is JSON array
- `queries(id, lang, user_text, matched_faq_id, created_at)`

## i18n

- Auto-detect via `Accept-Language`, cookie `lang`, or `?lang=xx`. Fallback `sv`.
- UI has manual language selector; persisted in `localStorage`.
- Static strings are inline in the client; server uses prompt language.

## Net salary calculator

- In-chat card with input "Fakturerat belopp".
- Computes `net = amount * factor(lang)` with defaults: sv/en 0.55, no 0.57, da 0.56.
- Formats output per locale.

## Top 4 ranking

- Score = `upvotes * 10 + recencyWeight` where recencyWeight is 3 (<1 day), 2 (<7d), 1 (<30d), else 0.
- Only 4 items max are returned.

## Privacy

- We store anonymized queries only. Email, phone numbers, and Swedish personal numbers are masked.

## Rate limiting

- General handler limit; separate OpenAI limit (10/min/IP) to protect upstream.

