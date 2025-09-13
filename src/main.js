import './style.css';

// Import locales via fetch at runtime; Vite will serve static /locales

const API = '/api/curevia-chat';
const sessionId = self.crypto?.randomUUID?.() || ('sess-' + Date.now());

function h(tag, props={}, ...children){
  const el = document.createElement(tag);
  for (const [k,v] of Object.entries(props||{})){
    if (k === 'class') el.className = v; else if (k === 'html') el.innerHTML = v; else el.setAttribute(k, v);
  }
  for (const c of children){ if (c) el.appendChild(typeof c==='string'? document.createTextNode(c) : c); }
  return el;
}

const app = document.getElementById('app');

// Shell
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

// Styles copied from legacy page
const style = document.createElement('style');
style.textContent = `
  #log{ max-height:70vh; overflow:auto; padding-bottom:8px }
  .bubble{ padding:10px 12px; border-radius:16px; margin:8px 0; max-width:90%; white-space:pre-wrap; line-height:1.35; position:relative }
  .bot{ background:#eef2ff; border-top-left-radius:6px }
  .me{ background:#2563eb; color:#fff; margin-left:auto; border-top-right-radius:6px }
  .row{ display:flex; gap:8px; position:sticky; bottom:0; background:var(--bg); padding:8px 0; border-top:1px solid var(--border) }
  input[type="text"]{ flex:1; padding:12px; border:1px solid var(--border); border-radius:12px }
  button.primary{ padding:12px 16px; border:0; border-radius:12px; background:#111827; color:#fff; cursor:pointer }
`;
document.head.appendChild(style);

// UI helpers
function addBubble(text, who='bot'){ const div=h('div',{ class:'bubble ' + (who==='me'?'me':'bot')}); if(text) div.innerText=text; log.appendChild(div); log.scrollTop=log.scrollHeight; return div; }
function typingBubble(){ const b = addBubble('…','bot'); return { destroy(){ try{ b.remove(); }catch{} } }; }

// Immediate greeting
addBubble('Hej! 👋 Välkommen till Curevia. Vad vill du göra?');

// Events
const inp = document.getElementById('inp');
const btn = document.getElementById('btn');
btn.onclick = ()=> send(inp.value);
inp.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); if(inp.value.trim()) send(inp.value);} });

async function send(text){
  if (!text || !text.trim()) return;
  addBubble(text, 'me');
  inp.value='';
  const bubble = addBubble('', 'bot');
  const typing = typingBubble();
  try{
    const r = await fetch(API + '?stream=1', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'X-Session-Id': sessionId, 'X-Lang': navigator.language || '', 'Accept':'text/event-stream' },
      body: JSON.stringify({ message: text })
    });
    const ct = (r.headers.get('content-type')||'').toLowerCase();
    if (!ct.includes('text/event-stream')){
      typing.destroy();
      const ok = ct.includes('application/json');
      if (ok){ const data=await r.json(); bubble.innerText = data.reply || 'Tekniskt fel – prova igen.'; }
      else bubble.innerText = 'Tekniskt fel – prova igen.';
      return;
    }
    const reader = r.body.getReader(); const decoder=new TextDecoder('utf-8'); let buffer=''; let gotAny=false, finalText='';
    while(true){ const { value, done } = await reader.read(); if(done) break; buffer += decoder.decode(value,{stream:true});
      let idx; while((idx=buffer.indexOf('\n\n'))>=0){ const raw = buffer.slice(0,idx); buffer=buffer.slice(idx+2);
        const lines = raw.split(/\r?\n/); let event='message', data='';
        for(const line of lines){ if(!line) continue; if(line.startsWith('event:')) event=line.slice(6).trim(); else if(line.startsWith('data:')){ let p=line.slice(5); if(p.startsWith(' ')) p=p.slice(1); data+=p; } }
        if(!data) continue; if(event==='token'){ if(!gotAny){ typing.destroy(); gotAny=true; } bubble.innerText += data; finalText+=data; }
        if(event==='final'){ typing.destroy(); try{ const j=JSON.parse(data); bubble.innerText = j.reply || finalText || ' '; }catch{ if(!gotAny) bubble.innerText = data; } }
      }
    }
    if(!bubble.innerText){ typing.destroy(); bubble.innerText = 'Inget svar – prova igen.'; }
  }catch(e){ typing.destroy(); bubble.innerText = 'Tekniskt fel – prova igen.'; }
}

