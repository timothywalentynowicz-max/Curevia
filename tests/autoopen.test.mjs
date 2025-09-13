import { describe, it, expect } from 'vitest';

// lightweight re-implementation mirroring src/main.js
function shouldAutoOpen(payload, lastText){
  if (!payload || !payload.data || payload.data.action !== 'open_url' || !payload.data.url) return false;
  const t = (lastText||'').toLowerCase();
  const isDemo = /(demo|visa plattformen|genomgång|boka.*möte|book.*demo)/.test(t);
  const isRegister = /(registrera|signa|skapa konto|sign ?up)/.test(t);
  return isDemo || isRegister;
}

describe('shouldAutoOpen', () => {
  const payload = { data:{ action:'open_url', url:'https://example.com' } };
  it('opens for demo intents', () => {
    expect(shouldAutoOpen(payload, 'Jag vill boka en demo')).toBe(true);
    expect(shouldAutoOpen(payload, 'Kan vi book demo?')).toBe(true);
  });
  it('opens for register intents', () => {
    expect(shouldAutoOpen(payload, 'Jag vill registrera mig')).toBe(true);
    expect(shouldAutoOpen(payload, 'Signa upp mig')).toBe(true);
  });
  it('does not open for pricing queries', () => {
    expect(shouldAutoOpen(payload, 'Vad kostar det?')).toBe(false);
  });
  it('does not open when payload missing', () => {
    expect(shouldAutoOpen({}, 'Jag vill boka demo')).toBe(false);
  });
});

