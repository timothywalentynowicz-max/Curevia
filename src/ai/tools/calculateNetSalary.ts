export type NetCalcInput = {
  fakturabeloppExMoms: number;
  plattformAvgiftPct: number;
  arbetsgivaravgiftPct: number;
  skattPct: number;
  semesterInklPct?: number;
  skattefriaErsSEK?: number;
};

export type NetCalcResult = {
  efterAvgift: number;
  bruttolön: number;
  bruttolönMedSemester: number;
  preliminärSkatt: number;
  nettolön: number;
  skattefriaErsSEK: number;
  nettoutbetalningTotalt: number;
};

export const calculateNetSalaryTool = {
  type: "function" as const,
  function: {
    name: "calculate_net_salary",
    description:
      "Beräkna nettolön givet fakturabelopp exkl. moms. Försäkring tillhandahålls av vårdgivaren (inget försäkringsavdrag här). Returnerar brutto, skatt och netto.",
    parameters: {
      type: "object",
      properties: {
        fakturabeloppExMoms: { type: "number", description: "Fakturabelopp exkl. moms (SEK)" },
        plattformAvgiftPct:  { type: "number", description: "Plattformsavgift (0.00–1.00), t.ex. 0.05 = 5%" },
        arbetsgivaravgiftPct:{ type: "number", description: "Arbetsgivaravgift (0.00–1.00), t.ex. 0.3142 = 31.42%" },
        skattPct:            { type: "number", description: "Preliminär skatt (0.00–1.00), t.ex. 0.32 = 32%" },
        semesterInklPct:     { type: "number", description: "Semesterpåslag på bruttolön (0.00–1.00), t.ex. 0.12 = 12%", default: 0 },
        skattefriaErsSEK:    { type: "number", description: "Skattefria ersättningar (SEK), t.ex. traktamente/mil", default: 0 }
      },
      required: ["fakturabeloppExMoms", "plattformAvgiftPct", "arbetsgivaravgiftPct", "skattPct"]
    }
  }
};

// Beräkningen
export function beräknaNettolön(input: NetCalcInput): NetCalcResult {
  const {
    fakturabeloppExMoms,
    plattformAvgiftPct,
    arbetsgivaravgiftPct,
    skattPct,
    semesterInklPct = 0,
    skattefriaErsSEK = 0
  } = input;

  const efterAvgift = fakturabeloppExMoms * (1 - plattformAvgiftPct);
  const bruttolön = efterAvgift / (1 + arbetsgivaravgiftPct);
  const bruttolönMedSemester = bruttolön * (1 + semesterInklPct);
  const preliminärSkatt = bruttolönMedSemester * skattPct;
  const nettolön = bruttolönMedSemester - preliminärSkatt;
  const nettoutbetalningTotalt = nettolön + skattefriaErsSEK;

  const round = (n: number) => Math.round(n);

  return {
    efterAvgift: round(efterAvgift),
    bruttolön: round(bruttolön),
    bruttolönMedSemester: round(bruttolönMedSemester),
    preliminärSkatt: round(preliminärSkatt),
    nettolön: round(nettolön),
    skattefriaErsSEK: round(skattefriaErsSEK),
    nettoutbetalningTotalt: round(nettoutbetalningTotalt)
  };
}

