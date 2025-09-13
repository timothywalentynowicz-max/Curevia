import { describe, it, expect, beforeAll } from "vitest";
import { ensureMigrations, upsertFaq, findBestMatch } from "../src/db.mjs";

beforeAll(() => {
  process.env.TEST_FAKE_OPENAI = "1";
  ensureMigrations();
});

describe("KB similarity and fallback threshold", () => {
  it("returns null when below threshold", () => {
    const best = findBestMatch({ lang: "sv", queryVector: [0,0,0,0,0,0,0,0], threshold: 0.99 });
    expect(best).toBeNull();
  });
  it("can match inserted faq", () => {
    const id = upsertFaq({ lang:"sv", question:"Vad kostar det?", answer:"Det beror på.", vector:[0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1] });
    const best = findBestMatch({ lang:"sv", queryVector:[0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1], threshold: 0.5 });
    expect(best?.id).toBeTypeOf("number");
  });
});

