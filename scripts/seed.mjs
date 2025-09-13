import { getDb, upsertFaq } from "../src/db.mjs";

const examples = {
  sv: [
    ["Hur fungerar Curevia för vårdgivare?", "Curevia matchar uppdrag med vårdpersonal och hjälper med avtal, planering och kvalitet."],
    ["Vad kostar det?", "Pris beror på användning. Vi erbjuder paket för både små och stora verksamheter."],
    ["Hur registrerar jag mig som konsult?", "Skapa en profil, lägg in kompetenser och tillgänglighet. Vi hör av oss med uppdrag."],
    ["När får jag betalt?", "Utbetalning sker efter att fakturan betalats, alternativt via löneutbetalning om du väljer det."],
    ["Hur bokar jag en demo?", "Boka en 30-minuters genomgång så visar vi plattformen och svarar på frågor."]
  ],
  en: [
    ["How does Curevia work for providers?", "We match assignments with clinicians and support agreements, scheduling, and quality."],
    ["What does it cost?", "Pricing depends on usage. We offer plans for both small and large organizations."],
    ["How do I sign up as a consultant?", "Create a profile, add skills and availability. We’ll reach out with assignments."],
    ["When do I get paid?", "Payment is made after the invoice is paid, or via payroll if you choose that."],
    ["How do I book a demo?", "Book a 30-minute walkthrough and we’ll show you the platform and answer questions."]
  ],
  no: [
    ["Hvordan fungerer Curevia for leverandører?", "Vi matcher oppdrag med klinikere og hjelper med avtaler, planlegging og kvalitet."],
    ["Hva koster det?", "Prisen avhenger av bruk. Vi tilbyr pakker for både små og store virksomheter."],
    ["Hvordan registrerer jeg meg som konsulent?", "Lag en profil, legg inn kompetanse og tilgjengelighet. Vi tar kontakt med oppdrag."],
    ["Når får jeg betalt?", "Utbetaling skjer etter at fakturaen er betalt, eller via lønn hvis du ønsker det."],
    ["Hvordan booker jeg en demo?", "Book en 30-minutters gjennomgang så viser vi plattformen og svarer på spørsmål."]
  ],
  da: [
    ["Hvordan fungerer Curevia for udbydere?", "Vi matcher opgaver med klinikere og hjælper med aftaler, planlægning og kvalitet."],
    ["Hvad koster det?", "Prisen afhænger af brug. Vi tilbyder pakker til både små og store organisationer."],
    ["Hvordan registrerer jeg mig som konsulent?", "Opret en profil, tilføj kompetencer og tilgængelighed. Vi kontakter dig med opgaver."],
    ["Hvornår får jeg udbetalt?", "Udbetaling sker efter at fakturaen er betalt, eller via løn hvis du vælger det."],
    ["Hvordan booker jeg en demo?", "Book en 30-minutters gennemgang, så viser vi platformen og svarer på spørgsmål."]
  ]
};

for (const [lang, list] of Object.entries(examples)){
  for (const [q, a] of list){
    upsertFaq({ lang, question: q, answer: a, vector: [0,0,0] });
  }
}

console.log("Seeded example FAQs for sv, en, no, da.");

