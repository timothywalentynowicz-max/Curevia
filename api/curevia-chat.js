// ---- Curevia FAQ (lägg nya längst NED, ta aldrig bort) -----------------------
const CureviaFAQs = [
  // OM CUREVIA
  { q:"Vilket företag står bakom Curevia?", a:"Curevia drivs av Nenetka AB – en svensk plattform som matchar vårdpersonal med uppdrag. Enkelt, tryggt och utan krångel." },
  { q:"Vad är Curevia?", a:"En digital marknadsplats för vården. Vårdpersonal hittar uppdrag och vårdgivare hittar kompetens – helt digitalt." },
  { q:"Är Curevia ett bemanningsföretag?", a:"Vi är en plattform/marknadsplats snarare än ett traditionellt bemanningsbolag, vilket ger transparens och snabbare processer." },
  { q:"Vilka kan använda Curevia?", a:"Legitimerad vårdpersonal och vårdgivare/kliniker i behov av bemanning." },
  { q:"Var finns ni?", a:"Vi är baserade i Sverige och expanderar stegvis. Fråga oss om din region." },
  { q:"Är Curevia godkänt av myndigheter?", a:"Vi följer gällande regelverk och GDPR, och verifierar legitimation innan uppdrag." },
  { q:"Tar ni provision från vårdpersonalens lön?", a:"Vi tar en transparent plattformsavgift på fakturabeloppet exkl. moms enligt avtal – ersättningen syns tydligt i kalkylen." },
  { q:"Vad skiljer er från klassiska bemanningsbolag?", a:"Digitalt flöde, mer valfrihet och snabb matchning. Mindre friktion, mer kontroll." },
  { q:"Har ni kollektivavtal?", a:"Villkor beror på uppdragsform. Be oss om underlag för just din situation." },
  { q:"Jobbar ni bara i Sverige?", a:"Primärt i Sverige just nu, men vi bygger broar mellan europeiska länder stegvis." },

  // REGISTRERING & PROFIL
  { q:"Hur registrerar jag mig som konsult?", a:"Skapa konto, fyll i profil och ladda upp legitimation/intyg. Boten guidar dig steg för steg." },
  { q:"Hur registrerar sig en vårdgivare?", a:"Skapa konto, lägg in behov (kompetens, datum, villkor) och signera digitalt när matchen är klar." },
  { q:"Vilka dokument behöver jag som konsult?", a:"Legitimation, CV, eventuella intyg och referenser. Ladda upp i din profil så kan vi verifiera." },
  { q:"Hur verifieras min legitimation?", a:"Vi kontrollerar legitimation mot tillgängliga register och begär kompletteringar vid behov." },
  { q:"Kan jag pausa min profil?", a:"Ja, du kan dölja eller pausa din profil när du inte är tillgänglig." },
  { q:"Hur uppdaterar jag mina uppgifter?", a:"Gå till Profil → Redigera. Ändringar slår igenom direkt efter sparning." },

  // FÖR KONSULTER – ARBETSSÄTT
  { q:"Hur funkar det att jobba via Curevia?", a:"Skapa profil, hitta uppdrag, signera digitalt och rapportera tid. Vi sköter administration och utbetalning." },
  { q:"Måste jag ha ett eget bolag?", a:"Nej. Du kan få lön utan bolag via oss – eller fakturera från eget AB om du föredrar det." },
  { q:"Kan jag välja uppdrag fritt?", a:"Ja, du väljer plats, tider och villkor inom ramen för uppdraget." },
  { q:"Kan jag arbeta deltid?", a:"Absolut. Du styr själv din tillgänglighet och omfattning." },
  { q:"Erbjuder ni distansuppdrag?", a:"Ja, när vårdgivaren tillåter det. Filtrera på distans i uppdragslistan." },
  { q:"Hur hittar jag nya uppdrag?", a:"I din dashboard – och via personliga rekommendationer utifrån din profil." },
  { q:"Hur rapporterar jag tid?", a:"Direkt i plattformen. Signera och skicka för godkännande." },
  { q:"Hur snabbt får jag feedback på en ansökan?", a:"Ofta inom 24–72 timmar. Du får notiser i appen." },

  // EKONOMI & ERSÄTTNING – KONSULT
  { q:"Hur mycket får jag ut i nettolön om jag fakturerar X kr?", a:"Ange fakturabelopp exkl. moms så räknar vi brutto, skatt och nettolön direkt – med tydliga mellanled." },
  { q:"Vilken plattformsavgift tar ni?", a:"Enligt avtal, t.ex. en procentsats på fakturabeloppet exkl. moms. Den visas öppet i kalkylen." },
  { q:"När får jag betalt?", a:"Vanligtvis inom 5–10 bankdagar efter godkänd tidrapport/faktura. Tider kan variera per uppdrag." },
  { q:"Får jag tjänstepension?", a:"Beror på uppdragsform. Fråga oss så sätter vi upp rätt lösning." },
  { q:"Hur funkar semesterersättning?", a:"Vi kan lägga på t.ex. 12 % enligt valt upplägg, eller redovisa separat – du väljer." },
  { q:"Hur funkar skatten?", a:"Vid lön via oss drar vi preliminär skatt enligt tabell/schablon. Med eget AB hanterar du skatt i bolaget." },
  { q:"Vad är skillnaden mellan lön via Curevia och fakturering via AB?", a:"Med lön sköter vi arbetsgivaransvar, skatter och utbetalning. Med AB fakturerar du och sköter ekonomi själv." },
  { q:"Kan jag få milersättning och traktamente?", a:"Ja, enligt Skatteverkets regler och uppdragsavtal. Rapportera i tidrapporten så hanterar vi det korrekt." },
  { q:"Kan jag se exempel på lönebesked?", a:"Ja, vi kan visa en exempel-PDF så du ser hur allt redovisas." },
  { q:"Hur hanteras OB och ersättning för helg/kväll?", a:"Enligt uppdragsavtal. Vi visar alltid ersättningsnivåerna tydligt innan du accepterar." },
  { q:"Kan jag få förskott?", a:"I vissa fall efter överenskommelse. Fråga support så hjälper vi dig." },

  // TRYGGHET & JURIDIK
  { q:"Vem står för försäkring?", a:"Försäkring tillhandahålls av vårdgivaren enligt uppdragets villkor. Be oss om intyg för just ditt uppdrag." },
  { q:"Vem är arbetsgivare?", a:"Vid lön via Curevia är vi arbetsgivare. Fakturerar du via eget AB är uppdraget B2B." },
  { q:"Är mina personuppgifter säkra?", a:"Ja, vi följer GDPR och lagrar data säkert inom EU. Du kan begära utdrag eller radering när som helst." },
  { q:"Hur hanterar ni känslig information?", a:"Vi minimerar insamling, krypterar där det krävs och delar aldrig utan laglig grund." },
  { q:"Har jag rätt till sjuklön?", a:"Beror på uppdragsform och avtal. Vi förklarar gärna vad som gäller i ditt specifika uppdrag." },
  { q:"Vad händer om vårdgivaren betalar sent?", a:"Vi hanterar påminnelser enligt avtal. Vid lön via oss påverkas normalt inte din utbetalning." },

  // VÅRDGIVARE – BOKNING & AVTAL
  { q:"Hur lägger vi en förfrågan som vårdgivare?", a:"Skapa konto, ange kompetens, datum, omfattning och villkor. Vi matchar snabbt och ni signerar digitalt." },
  { q:"Vilka kompetenser kan vi boka?", a:"Läkare, sjuksköterskor (grund/specialist), undersköterskor m.fl. Fråga om nischade roller." },
  { q:"Hur snabbt kan ni leverera personal?", a:"Ofta inom 24–72 timmar för kortare vikariat. Längre uppdrag planeras i god tid." },
  { q:"Kan vi skriva ramavtal?", a:"Ja, för bättre priser, SLA och tydlig uppföljning." },
  { q:"Hur fungerar prissättning?", a:"Tim- eller dygnspriser baseras på kompetens, plats och tider. Vi lämnar offert med tydlig kostnadsbild." },
  { q:"Kan vi följa uppdrag i realtid?", a:"Ja, i er dashboard ser ni status, tidrapporter och KPI:er." },
  { q:"Hur sker fakturering?", a:"Digital tidrapportering och samlad faktura enligt överenskommet intervall." },
  { q:"Gör ni bakgrundskontroller?", a:"Ja, legitimation och referenser kontrolleras innan start." },
  { q:"Kan vi behöva teckna extra försäkring?", a:"Vårdgivaren ansvarar för nödvändiga försäkringar och arbetsmiljö enligt lag och avtal." },

  // PRAKTIK & APP
  { q:"Hur loggar jag in?", a:"Med e-post/telefon och engångskod eller BankID om aktiverat." },
  { q:"Jag har glömt mitt lösenord, vad gör jag?", a:"Klicka på ”Glömt?” så skickar vi en återställningslänk eller engångskod." },
  { q:"Har ni en mobilapp?", a:"Webben är mobilanpassad idag. Native app är på väg." },
  { q:"Kan jag få notiser om nya uppdrag?", a:"Ja, aktivera notiser och bevakningar i din profil." },
  { q:"Kan jag exportera min historik?", a:"Ja, exportera som PDF/CSV under Historik." },
  { q:"Stödjer ni flera språk?", a:"Ja, svenska, norska, engelska och danska. Fler språk kan tillkomma." },
  { q:"Kan jag bjuda in en kollega?", a:"Ja, dela din inbjudningslänk – båda kan få bonus enligt kampanjvillkor." },

  // DISTANS
  { q:"Hur funkar distansuppdrag praktiskt?", a:"När vårdgivaren tillåter det sker arbetet digitalt enligt deras processer och system." },
  { q:"Vilken utrustning behöver jag för distans?", a:"Säker uppkoppling, kamera/mikrofon och tillgång till vårdgivarens system enligt instruktion." },
  { q:"Kan jag kombinera distans och på plats?", a:"Ja, om uppdraget medger hybridupplägg." },

  // GDPR
  { q:"Följer ni GDPR?", a:"Ja. Vi hanterar personuppgifter lagligt, säkert och med minimal insamling." },
  { q:"Hur raderar jag min data?", a:"Kontakta support eller begär radering i kontoinställningar – vi hjälper dig direkt." },
  { q:"Hur hanterar ni journaluppgifter?", a:"Journaldata ska inte delas i chatten. Använd vårdgivarens säkra system för patientinformation." },

  // TEKNIK & SUPPORT
  { q:"Får ni driftstörningar ibland?", a:"Som alla digitala tjänster kan det hända. Vi övervakar och kommunicerar läget i appen." },
  { q:"Hur kontaktar jag support?", a:"Skriv i chatten eller maila oss – vi svarar snabbt vardagar och bevakar kritiska ärenden." },
  { q:"Hur rapporterar jag en bugg?", a:"Använd ”Rapportera problem” i appen och beskriv vad som hände – gärna med skärmklipp." },

  // PRIS & OFFERT – VÅRDGIVARE
  { q:"Kan vi få en snabb offert?", a:"Ja, ange kompetens, erfarenhetsnivå, plats och tidsperiod – vi återkommer samma dag." },
  { q:"Vad ingår i priset?", a:"Matchning, digital administration, tidrapportering och kvalitetskontroller. Försäkring ligger hos vårdgivaren." },
  { q:"Kan ni bemanna med kort varsel?", a:"Vi gör vårt bästa – akuta förfrågningar prioriteras i nätverket." },

  // SKATT & MODELLER
  { q:"Vilken skattetabell använder ni i beräkningar?", a:"Som standard schablon, men du kan ange din kommun/tabell för mer exakt resultat." },
  { q:"Kan jag lägga till skattefria ersättningar i kalkylen?", a:"Ja, lägg till traktamente/milersättning så visas de separat utanför nettolönen." },
  { q:"Visa mellanled i kalkylen?", a:"Självklart – efter avgift, bruttolön, skatt, semester och netto. Allt syns öppet." },
  { q:"Kan ni jämföra AB vs lön via Curevia?", a:"Ja, vi visar en enkel jämförelse och pekar på vad som skiljer i ansvar, skatt och administration." },

  // MATCHNING & KVALITET
  { q:"Hur säkerställer ni kvalitet i matchningen?", a:"Profildata, verifierad legitimation och relevanta referenser. Vårdgivare kan sätta krav och ge feedback." },
  { q:"Kan jag få uppdrag inom en specifik specialitet?", a:"Ja, filtrera på specialitet och lägg bevakning så pingar vi dig vid nya uppdrag." },
  { q:"Hur funkar feedback efter avslutat uppdrag?", a:"Båda parter kan ge omdöme. Det förbättrar matchningar framåt." },

  // AVSLUT & UPPFÖLJNING
  { q:"Hur avslutar jag ett uppdrag?", a:"Rapportera sista passet och signera. Slutrapport och ersättning hanteras direkt i systemet." },
  { q:"Kan jag få arbetsgivarintyg eller intyg på uppdrag?", a:"Ja, be support så hjälper vi dig med underlag." },
  { q:"Hur stänger vi ett uppdrag som vårdgivare?", a:"Bekräfta sista tidrapporten och signera digitalt. Fakturan skapas enligt avtal." },

  // KAMPANJER
  { q:"Har ni någon värvningsbonus?", a:"Ibland kör vi kampanjer. Använd din inbjudningslänk och se aktuella villkor i appen." },
  { q:"Får både jag och den jag bjuder in bonus?", a:"Ja, när kampanjvillkoren uppfylls – till exempel efter första genomförda uppdrag." },

  // ÖVRIGT
  { q:"Vad kostar det att registrera sig?", a:"Det är gratis att skapa konto. Avgifter framgår först när du accepterar uppdrag." },
  { q:"Kan ni hjälpa till med vidareutbildning?", a:"Vi tipsar gärna om kurser och certifieringar – fråga efter förslag inom din specialitet." },
  { q:"Var kan jag följa er?", a:"Följ oss på LinkedIn för nyheter, uppdrag och insikter." },
];

// ---- FAQ-hjälpare (behåller din normalize()) -----------------------
function faqFindExact(text){ return CureviaFAQs.find(f => normalize(f.q) === normalize(text)); }
function faqFindFuzzy(text){
  const t = normalize(text);
  return CureviaFAQs.find(f => normalize(f.q).includes(t) || normalize(f.a).includes(t));
}

// ---- Norge-guide (återanvänds i intent) ---------------------------
function norwayGuide(){
  return `Så skaffar du norsk legitimation (HPR) – steg för steg:

1) Förbered dokument
• Pass/id, examensbevis, svensk legitimation, CV.
• Certificate of Current Professional Status/”Letter of Good Standing”.
• Auktoriserade översättningar om dokument ej på norska/svenska/engelska.

2) Ansök om autorisasjon
• Ansökan görs digitalt via Helsedirektoratet (HPR).
• Skapa konto, ladda upp dokument, betala avgift.
• Handläggningstid varierar – räkna med några veckor.

3) Efter beslut – HPR-nummer
• Vid beviljad autorisasjon registreras du i HPR (Norges legitimation).
• Du får HPR-nummer som arbetsgivare/vårdgivare kontrollerar.

4) Praktiska steg för arbete i Norge
• D-nummer via Skatteetaten.
• Skattekort (tax card) – krävs för lön.
• Norsk bank/utbetalning enligt arbetsgivarens rutiner.
• Ev. HMS-kort och lokala intro-/IT-behörigheter.

Tips
• Spara original och ha skannade PDF:er redo.
• Krav varierar per yrkesgrupp; vissa specialiteter kräver extra intyg.
• Good standing från Sverige? Beställ i god tid.

Vill du att jag skapar en personlig checklista utifrån din yrkesroll och startdatum?`;
}
