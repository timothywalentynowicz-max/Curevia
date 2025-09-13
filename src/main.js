import './style.css';

const API = '/api/curevia-chat';
const sessionId = self.crypto?.randomUUID?.() || ('sess-' + Date.now());

// Small DOM helper
function h(tag, props={}, ...children){
  const el = document.createElement(tag);
  for (const [k,v] of Object.entries(props||{})){
    if (k === 'class') el.className = v; else if (k === 'html') el.innerHTML = v; else el.setAttribute(k, v);
  }
  for (const c of children){ if (c) el.appendChild(typeof c==='string'? document.createTextNode(c) : c); }
  return el;
}

// i18n
const STRINGS = {};
function getLang(){ return localStorage.getItem('lang') || (navigator.language||'sv').slice(0,2); }
async function loadStrings(){
  const L = getLang();
  if (STRINGS[L]) return STRINGS[L];
  try{ const r=await fetch(`/locales/${L}/common.json`); STRINGS[L]=await r.json(); }catch{ STRINGS[L]={ greet:'Hej! 👋 Välkommen till Curevia. Vad vill du göra?', send:'Skicka', placeholder:'Skriv ett meddelande...', darkToggle:'Mörkt läge', netTitle:'Snabb kalkyl – Nettolön', netLabel:'Fakturerat belopp (exkl. moms):', netOutPrefix:'≈ Nettolön:' }; }
  return STRINGS[L];
}
function t(key){ const L=getLang(); const s=STRINGS[L]||{}; const v=s[key]; return typeof v==='function'? v(): v || key; }

// App shell
const app = document.getElementById('app');
const wrap = h('div', { class:'wrap', role:'main' });
const heading = h('h3', { role:'heading', 'aria-level':'1' },
  h('span', { id:'title' }, 'Curevia Assistant'),
  h('div', { style:'display:flex; gap:8px; align-items:center' },
    (()=>{ const s=h('select',{ id:'lang', class:'toggle','aria-label':'Language selector' }); s.innerHTML=`<option value="sv">Svenska</option><option value="en">English</option><option value="no">Norsk</option><option value="da">Dansk</option>`; return s; })(),
    h('button', { id:'dark', class:'toggle', type:'button', 'aria-pressed':'false', 'aria-label':'Växla mörkt läge' }, 'Mörkt läge')
  )
);
const log = h('div', { id:'log', 'aria-live':'polite', 'aria-atomic':'false' });
const row = h('div', { class:'row', role:'form', 'aria-label':'Chat input' },
  h('input', { id:'inp', type:'text', placeholder:'Skriv ett meddelande...', autocomplete:'off', 'aria-label':'Skriv ett meddelande' }),
  h('button', { id:'btn', class:'primary', type:'button' }, 'Skicka')
);
wrap.append(heading, log, row);
app.appendChild(wrap);

// Extra UI: Net calculator + privacy
const netCard = h('div', { id:'netcard', class:'bubble bot', 'aria-live':'polite' },
  h('div', { id:'netTitle', style:'font-weight:700; margin-bottom:6px' }, 'Snabb kalkyl – Nettolön'),
  h('label', { for:'netInput', id:'netLabel' }, 'Fakturerat belopp (exkl. moms):'),
  h('input', { id:'netInput', type:'text', inputmode:'decimal', style:'margin:6px 0; width:100%; padding:10px; border:1px solid var(--border); border-radius:10px', placeholder:'t.ex. 120 000' }),
  h('div', { id:'netOut', style:'margin-top:4px' })
);
const privacy = h('div', { class:'bubble bot', style:'font-size:13px' },
  h('span', { id:'privacy', html:'Vi anonymiserar frågor och sparar inga personuppgifter. <a href="#" target="_blank" rel="noopener">Läs mer</a>.' })
);

// Styles for chips and bubbles included via CSS

// Helpers
function addBubble(text, who='bot'){ const div=h('div',{ class:'bubble ' + (who==='me'?'me':'bot')}); if(text) div.innerText=text; log.appendChild(div); log.scrollTop=log.scrollHeight; return div; }
function addCopyIfLong(div){ if(!div||!div.innerText) return; if(div.innerText.length<=120) return; const cp=h('div',{ class:'copy' },'📋 Kopiera'); cp.onclick=()=> navigator.clipboard.writeText(div.innerText); div.appendChild(cp); }
function typingBubble(){ const b = addBubble('…','bot'); return { destroy(){ try{ b.remove(); }catch{} } }; }

// Chips
let chipsBar=null;
function clearChips(){ if(chipsBar){ try{ chipsBar.remove(); }catch{} chipsBar=null; } }
function createChip(it){ const b=h('button',{ class:'chip', type:'button', 'aria-label':(it.text||it.label||'').trim() }, h('span',{ class:'emoji' }, it.emoji||''), h('span',{ class:'label' }, it.text||it.label||'')); b.onclick=()=>{ if(it.url){ window.open(it.url,'_blank','noopener,noreferrer'); return; } const sendText=it.textSend||it.text||it.label; if(sendText) send(sendText); }; return b; }
function renderChips(items=[]){ clearChips(); if(!items||!items.length) return; chipsBar=h('div',{ class:'chips' }); for(const it of items){ chipsBar.appendChild(createChip(it)); } const last=[...log.querySelectorAll('.bubble.bot')].pop(); if(last){ last.appendChild(chipsBar); } log.scrollTop=log.scrollHeight; }

// Theme toggle
(function initTheme(){ const saved=localStorage.getItem('curevia_dark'); if(saved==='1' || (!saved && window.matchMedia?.('(prefers-color-scheme: dark)').matches)){ document.body.classList.add('dark'); document.getElementById('dark').setAttribute('aria-pressed','true'); } })();
document.getElementById('dark').onclick=()=>{ const on=document.body.classList.toggle('dark'); document.getElementById('dark').setAttribute('aria-pressed', on?'true':'false'); localStorage.setItem('curevia_dark', on?'1':'0'); };

// Lang switcher
const langSel = document.getElementById('lang'); langSel.value = ['sv','en','no','da'].includes(getLang()) ? getLang() : 'sv'; langSel.onchange=()=>{ localStorage.setItem('lang', langSel.value); applyLang(); };
function fmtCurrency(n,L){ const map={ sv:['sv-SE','SEK'], en:['en-GB','SEK'], no:['nb-NO','NOK'], da:['da-DK','DKK'] }[L]||['sv-SE','SEK']; return new Intl.NumberFormat(map[0],{ style:'currency', currency:map[1], maximumFractionDigits:0 }).format(n); }
function factor(){ const L=getLang(); return ({ sv:0.55, en:0.55, no:0.57, da:0.56 })[L]||0.55; }
function parseMoney(s){ s=String(s).trim(); if(!s) return NaN; const cleaned=s.replace(/[^0-9,\.\s]/g,'').replace(/\s+/g,''); const comma=cleaned.lastIndexOf(','); const dot=cleaned.lastIndexOf('.'); let norm=cleaned; if(comma>dot) norm=cleaned.replace(/\./g,'').replace(',','.'); else norm=cleaned.replace(/,/g,''); const n=Number(norm); return Number.isFinite(n)? n: NaN; }
function updateNet(){ const L=getLang(); const amt=parseMoney(document.getElementById('netInput').value); const out=document.getElementById('netOut'); if(!isFinite(amt)||amt<=0){ out.textContent=''; return; } const net=amt*factor(); const pref=(STRINGS[L]?.netOutPrefix)||'≈'; out.textContent = `${pref} ${fmtCurrency(net, L)}`; }

function applyLang(){ const L=getLang(); const dark=document.getElementById('dark'); const inp=document.getElementById('inp'); const btn=document.getElementById('btn'); document.documentElement.lang=L; dark.textContent=t('darkToggle')||dark.textContent; dark.setAttribute('aria-label', t('darkToggleAria')||''); btn.textContent=t('send')||btn.textContent; inp.placeholder=t('placeholder')||inp.placeholder; document.getElementById('netTitle').textContent=t('netTitle')||'Snabb kalkyl – Nettolön'; document.getElementById('netLabel').textContent=t('netLabel')||'Fakturerat belopp (exkl. moms):'; updateNet(); }

// Boot
(async function boot(){
  await loadStrings();
  addBubble(t('greet')||'Hej! 👋 Välkommen till Curevia. Vad vill du göra?');
  log.appendChild(netCard);
  log.appendChild(privacy);
  const inp=document.getElementById('inp'); try{ inp.focus(); }catch{}
  applyLang();
  try{
    const controller=new AbortController(); const to=setTimeout(()=>controller.abort(),4000);
    const r = await fetch(API, { headers:{ 'X-Session-Id': sessionId, 'Accept-Language': getLang() }, signal: controller.signal });
    clearTimeout(to);
    const ok=(r.headers.get('content-type')||'').toLowerCase().includes('application/json'); if(ok){ const meta=await r.json(); if(Array.isArray(meta.suggestedQuestions) && meta.suggestedQuestions.length){ renderChips(meta.suggestedQuestions.map(q=>({ emoji:'💡', text:q }))); } else if(Array.isArray(meta.topFaqs) && meta.topFaqs.length){ renderChips(meta.topFaqs.map(q=>({ emoji:'💡', text:q.q }))); } else if (Array.isArray(meta.suggested) && meta.suggested.length){ renderChips(meta.suggested); } }
  }catch{}

  // Expose minimal API for external bubble that mounts into #cv-chat-panel
  window.CureviaChat = {
    getSuggested: async function(){
      const r = await fetch(API, { headers:{ 'X-Session-Id': sessionId, 'Accept-Language': getLang() } });
      const j = await r.json().catch(()=>({}));
      return {
        suggestedQuestions: Array.isArray(j.suggestedQuestions)? j.suggestedQuestions : (Array.isArray(j.suggested)? (j.suggested.map(it=> it.text||it.label||'').filter(Boolean)) : [])
      };
    },
    ask: async function(message){
      const r = await fetch(API, { method:'POST', headers:{ 'Content-Type':'application/json', 'X-Session-Id': sessionId }, body: JSON.stringify({ message }) });
      const j = await r.json().catch(()=>({ reply:'Tekniskt fel – prova igen.' }));
      return {
        reply: j.reply,
        suggestedQuestions: Array.isArray(j.suggestedQuestions)? j.suggestedQuestions : (Array.isArray(j.suggestions)? (j.suggestions.map(it=> it.text||it.label||'').filter(Boolean)) : []),
        data: j.data && typeof j.data==='object' ? j.data : (j.action||j.url ? { action:j.action||null, url:j.url||null } : null)
      };
    }
  };
})();

// Send logic
const inp = document.getElementById('inp');
const btn = document.getElementById('btn');
btn.onclick = ()=> send(inp.value);
inp.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); if(inp.value.trim()) send(inp.value);} });
document.getElementById('netInput').addEventListener('input', updateNet);

async function send(text){
  if (!text || !text.trim()) return;
  clearChips();
  addBubble(text, 'me');
  inp.value='';
  const bubble = addBubble('', 'bot');
  const typing = typingBubble();
  let lastFaqId = null;
  try{
    const r = await fetch(API + '?stream=1', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'X-Session-Id': sessionId, 'X-Lang': getLang(), 'Accept':'text/event-stream' },
      body: JSON.stringify({ message: text })
    });
    const ct = (r.headers.get('content-type')||'').toLowerCase();
    if (!ct.includes('text/event-stream')){
      typing.destroy();
      const ok = ct.includes('application/json');
      if (ok){
        const data = await r.json();
        bubble.innerText = data.reply || 'Tekniskt fel – prova igen.';
        lastFaqId = data.faqId||null;
        // Auto-open URL on demo actions
        if (data?.data && data.data.action === 'open_url' && data.data.url){ try{ window.open(data.data.url, '_blank', 'noopener,noreferrer'); }catch{} }
        if(Array.isArray(data.suggestions)) renderChips(data.suggestions);
      }
      else bubble.innerText = 'Tekniskt fel – prova igen.';
      addCopyIfLong(bubble); addFeedbackUI(bubble, lastFaqId);
      return;
    }
    const reader = r.body.getReader(); const decoder=new TextDecoder('utf-8'); let buffer=''; let gotAny=false, finalText='';
    while(true){ const { value, done } = await reader.read(); if(done) break; buffer += decoder.decode(value,{stream:true});
      let idx; while((idx=buffer.indexOf('\n\n'))>=0){ const raw = buffer.slice(0,idx); buffer=buffer.slice(idx+2);
        const lines = raw.split(/\r?\n/); let event='message', data='';
        for(const line of lines){ if(!line) continue; if(line.startsWith('event:')) event=line.slice(6).trim(); else if(line.startsWith('data:')){ let p=line.slice(5); if(p.startsWith(' ')) p=p.slice(1); data+=p; } }
        if(!data) continue; if(event==='token'){ if(!gotAny){ typing.destroy(); gotAny=true; } bubble.innerText += data; finalText+=data; }
        if(event==='final'){
          typing.destroy();
          try{
            const j = JSON.parse(data);
            if(!gotAny && j.reply){ bubble.innerText = j.reply; }
            lastFaqId = j.faqId||null;
            // Auto-open URL when backend signals open_url in data
            if (j?.data && j.data.action === 'open_url' && j.data.url){ try{ window.open(j.data.url, '_blank', 'noopener,noreferrer'); }catch{} }
            if(Array.isArray(j.suggestions)) renderChips(j.suggestions);
          }catch{ if(!gotAny) bubble.innerText = data; }
        }
      }
    }
    if(!bubble.innerText){ typing.destroy(); bubble.innerText = 'Inget svar – prova igen.'; }
    addCopyIfLong(bubble); addFeedbackUI(bubble, lastFaqId);
  }catch(e){ typing.destroy(); bubble.innerText = 'Tekniskt fel – prova igen.'; addFeedbackUI(bubble, lastFaqId); }
}

function addFeedbackUI(bubble, faqId){
  const bar = h('div', { class:'feedback' },
    h('button', { class:'thumb', type:'button', 'aria-label':'Tummen upp' }, '👍'),
    h('button', { class:'thumb', type:'button', 'aria-label':'Tummen ner' }, '👎')
  );
  const [upBtn, downBtn] = bar.querySelectorAll('button');
  const send = async (up)=>{ try{ await fetch(API, { method:'POST', headers:{ 'Content-Type':'application/json', 'X-Session-Id': sessionId }, body: JSON.stringify({ feedback:{ faqId, up } }) }); }catch{} bar.remove(); };
  upBtn.onclick = ()=> send(true);
  downBtn.onclick = ()=> send(false);
  bubble.appendChild(bar);
}

