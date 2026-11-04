'use strict';
window.voiceOverlay.onUpdate(({settings,items})=>{
  const strip=document.getElementById('strip');strip.classList.toggle('vertical',settings.orientation==='vertical');strip.style.setProperty('--size',`${settings.size}px`);strip.replaceChildren();
  for(const item of items){const tile=document.createElement('div');tile.className=`tile ${item.status}${(item.label||item.key).length>3?' long':''}`;tile.dataset.actionId=item.actionId;tile.textContent=(item.label||item.key).replace(/\+/g,'+​');tile.title=`${item.phrase} · ${item.status}`;if(item.actionType==='hold'){const small=document.createElement('small');small.textContent=`${item.durationMs}ms`;tile.append(small);}strip.append(tile);}
});
