import type { NetCalcResult } from "../src/ai/tools/calculateNetSalary";

export function formatNetSalaryMessage(
  input: { fakturabeloppExMoms: number; plattformAvgiftPct: number; arbetsgivaravgiftPct: number; skattPct: number; semesterInklPct?: number; skattefriaErsSEK?: number; },
  result: NetCalcResult
) {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  return [
    `Här är din uppskattning:`,
    `• Efter avgift: ${result.efterAvgift.toLocaleString()} kr (avgift ${pct(input.plattformAvgiftPct)})`,
    `• Bruttolön: ${result.bruttolön.toLocaleString()} kr`,
    input.semesterInklPct && input.semesterInklPct > 0
      ? `• Bruttolön inkl. semester (${pct(input.semesterInklPct)}): ${result.bruttolönMedSemester.toLocaleString()} kr`
      : undefined,
    `• Preliminär skatt (${pct(input.skattPct)}): −${result.preliminärSkatt.toLocaleString()} kr`,
    `• Nettolön: ${result.nettolön.toLocaleString()} kr`,
    input.skattefriaErsSEK && input.skattefriaErsSEK > 0
      ? `• Skattefria ersättningar: +${result.skattefriaErsSEK.toLocaleString()} kr`
      : undefined,
    `= Utbetalning totalt: ${result.nettoutbetalningTotalt.toLocaleString()} kr`,
    ``,
    `Vill du finjustera med din skattetabell eller jämföra mot fakturering via eget AB?`
  ].filter(Boolean).join("\n");
}

