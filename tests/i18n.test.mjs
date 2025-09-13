import { describe, it, expect } from "vitest";
import { detectLang, parseAmount, formatCurrency } from "../src/i18n.mjs";

describe("i18n detection", () => {
  it("detects from url, cookie, header with fallback sv", () => {
    expect(detectLang({ url: "?lang=en" })).toBe("en");
    expect(detectLang({ cookie: "lang=no" })).toBe("no");
    expect(detectLang({ header: "da-DK,sv;q=0.8" })).toBe("da");
    expect(detectLang({})).toBe("sv");
  });
});

describe("amount parsing and currency format", () => {
  it("parses european and us formats", () => {
    expect(parseAmount("120 000")).toBe(120000);
    expect(parseAmount("120,000.50")).toBe(120000.5);
    expect(parseAmount("120.000,50")).toBe(120000.5);
  });
  it("formats per locale", () => {
    expect(formatCurrency(1000, "sv")).toMatch(/SEK|kr/);
    expect(formatCurrency(1000, "no")).toMatch(/NOK|kr/);
    expect(formatCurrency(1000, "da")).toMatch(/DKK|kr/);
  });
});

