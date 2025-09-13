import { describe, it, expect } from 'vitest';
import { beräknaNettolön } from '../src/ai/tools/calculateNetSalary.ts';

describe('beräknaNettolön', () => {
  it('computes positive, consistent fields', () => {
    const input = {
      fakturabeloppExMoms: 100000,
      plattformAvgiftPct: 0.05,
      arbetsgivaravgiftPct: 0.3142,
      skattPct: 0.32,
      semesterInklPct: 0.12,
      skattefriaErsSEK: 0,
    };
    const r = beräknaNettolön(input);
    expect(r.efterAvgift).toBeGreaterThan(0);
    expect(r.bruttolön).toBeGreaterThan(0);
    expect(r.bruttolönMedSemester).toBeGreaterThan(0);
    expect(r.preliminärSkatt).toBeGreaterThan(0);
    expect(r.nettolön).toBeGreaterThan(0);
    expect(r.nettoutbetalningTotalt).toBe(r.nettolön + r.skattefriaErsSEK);
  });
});

