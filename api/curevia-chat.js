const QUICK_ANSWERS = [
  {
    pattern: /eget bolag/i,
    reply: "Nej, du kan få betalt direkt via Curevia eller genom ditt eget bolag – det som passar dig bäst. 👉 Registrera dig här: https://curevia.ai/consultant/register"
  },
  {
    pattern: /utbetal/i,
    reply: "Via Curevia sker utbetalning automatiskt när vårdgivaren har betalat. Har du eget bolag fakturerar du själv med 30 dagars betalningsvillkor."
  },
  {
    pattern: /inte betalar/i,
    reply: "Om en vårdgivare inte betalar i tid driver Curevia ärendet vidare till inkasso och Kronofogden. Du kan känna dig trygg i att ditt arbete blir ersatt."
  },
  {
    pattern: /kostnad|pris/i,
    reply: "Att testa Curevia är gratis och de tre första uppdragen per år är kostnadsfria. Därefter gäller en låg avgift. Se hela prislistan här: https://preview--vardgig-connect.lovable.app/vardgivare"
  },
  {
    pattern: /onboard|komma igång/i,
    reply: "Det är enkelt att komma igång: skapa ett uppdrag och välj bland intresserade konsulter. En dedikerad kundansvarig säkerställer att du blir nöjd."
  }
];
