(function(){
  try{
    if (window.CureviaChatWidget) return;
    window.CureviaChatWidget = true;

    var curScript = document.currentScript || (function(){
      var scripts = document.getElementsByTagName('script');
      return scripts[scripts.length-1];
    })();

    var url = (curScript && curScript.getAttribute('data-url')) || 'https://chat.curevia.ai/';
    var mode = (curScript && curScript.getAttribute('data-mode')) || 'popup'; // 'popup' | 'overlay'
    var label = (curScript && curScript.getAttribute('data-label')) || '';
    var color = (curScript && curScript.getAttribute('data-color')) || '#111827';
    var position = (curScript && curScript.getAttribute('data-position')) || 'right'; // 'right' | 'left'

    var root = document.createElement('div');
    root.id = 'curevia-chat-bubble';
    root.style.position = 'fixed';
    root.style.zIndex = '2147483647';
    root.style.bottom = '16px';
    if (position === 'left') root.style.left = '16px'; else root.style.right = '16px';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-label','Öppna chatten');
    btn.style.background = color;
    btn.style.color = '#fff';
    btn.style.border = '0';
    btn.style.borderRadius = '9999px';
    btn.style.padding = '12px 14px';
    btn.style.boxShadow = '0 8px 24px rgba(0,0,0,.2)';
    btn.style.cursor = 'pointer';
    btn.style.display = 'inline-flex';
    btn.style.alignItems = 'center';
    btn.style.gap = '8px';
    btn.style.font = '600 14px system-ui, -apple-system, Segoe UI, Roboto, Arial';
    var icon = document.createElement('span'); icon.textContent = '💬'; icon.style.fontSize='16px';
    var text = document.createElement('span'); text.textContent = label || 'Chatta med oss';
    btn.appendChild(icon); btn.appendChild(text);

    root.appendChild(btn);
    document.body.appendChild(root);

    var overlay = null;
    function openOverlay(){
      if (overlay){ overlay.style.display='block'; return; }
      overlay = document.createElement('div');
      overlay.style.position='fixed'; overlay.style.inset='0'; overlay.style.background='rgba(0,0,0,.35)'; overlay.style.zIndex='2147483648';
      var frameWrap=document.createElement('div'); frameWrap.style.position='absolute'; frameWrap.style.bottom='84px'; frameWrap.style.right= position==='left'? 'auto':'16px'; frameWrap.style.left= position==='left'? '16px':'auto'; frameWrap.style.width='100%'; frameWrap.style.maxWidth='420px'; frameWrap.style.height='70vh'; frameWrap.style.maxHeight='720px'; frameWrap.style.boxShadow='0 20px 60px rgba(0,0,0,.35)'; frameWrap.style.borderRadius='16px';
      var iframe=document.createElement('iframe'); iframe.src=url; iframe.title='Curevia Chat'; iframe.style.width='100%'; iframe.style.height='100%'; iframe.style.border='0'; iframe.style.borderRadius='16px'; iframe.referrerPolicy='no-referrer'; iframe.loading='eager';
      var close=document.createElement('button'); close.type='button'; close.setAttribute('aria-label','Stäng chatten'); close.textContent='✕'; close.style.position='absolute'; close.style.top='-10px'; close.style.right= position==='left'? 'auto':'-10px'; close.style.left= position==='left'? '-10px':'auto'; close.style.width='36px'; close.style.height='36px'; close.style.borderRadius='9999px'; close.style.border='0'; close.style.background='#fff'; close.style.boxShadow='0 6px 20px rgba(0,0,0,.25)'; close.style.cursor='pointer';
      close.onclick = function(){ overlay.style.display='none'; };
      frameWrap.appendChild(iframe); frameWrap.appendChild(close);
      overlay.appendChild(frameWrap);
      overlay.addEventListener('click', function(e){ if (e.target === overlay) overlay.style.display='none'; });
      document.body.appendChild(overlay);
    }

    btn.onclick = function(){
      if (mode === 'overlay') openOverlay();
      else window.open(url, '_blank', 'noopener,noreferrer');
    };
  }catch(e){ /* swallow */ }
})();

