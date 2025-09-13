import { describe, it, expect } from "vitest";
import { parseAmount } from "../src/i18n.mjs";

describe("Net calculator factor application (front logic)", () => {
  it("parses common money formats", () => {
    expect(parseAmount("120 000")).toBe(120000);
    expect(parseAmount("120.000,00")).toBe(120000);
  });
});

