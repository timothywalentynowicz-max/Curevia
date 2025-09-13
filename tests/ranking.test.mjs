import { describe, it, expect, beforeAll } from "vitest";
import { ensureMigrations, getDb, getTopFaqs } from "../src/db.mjs";

beforeAll(() => {
  ensureMigrations();
});

describe("Top 4 ranking", () => {
  it("never returns more than 4 and respects score", () => {
    const db = getDb();
    db.exec("DELETE FROM faqs;");
    const now = Math.floor(Date.now()/1000);
    const insert = db.prepare("INSERT INTO faqs(lang,question,answer,upvotes,last_used_at) VALUES (?,?,?,?,?)");
    insert.run("sv","q1","a", 10, now-60); // high upvotes
    insert.run("sv","q2","a", 1, now-60);  // lower
    insert.run("sv","q3","a", 5, now-86400*10); // older
    insert.run("sv","q4","a", 2, now-3600); // recent
    insert.run("sv","q5","a", 3, now-3600*2);
    const top = getTopFaqs("sv", 4);
    expect(top.length).toBe(4);
    expect(top[0].upvotes).toBeGreaterThanOrEqual(top[1].upvotes);
  });
});

