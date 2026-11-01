/* Device-specific interaction: touch and mouse layouts use CSS; TV uses D-pad focus. */
(() => {
  let preference='auto';
  try { preference=localStorage.getItem('otium_display') || 'auto'; } catch (_) {}
  const television = () => {
    try { if(window.KrmziBridge?.isTelevision?.()) return true; } catch (_) {}
    return /Android TV|GoogleTV|SmartTV|SMART-TV|HbbTV|Tizen|Web0S|WebOS|BRAVIA|AFT[A-Z]|MiBOX|SHIELD/i.test(navigator.userAgent);
  };
  const isTV = () => document.documentElement.dataset.display === 'tv';
  function apply() {
    document.documentElement.dataset.display = preference==='tv' || television() ? 'tv' : innerWidth>=1024 ? 'desktop' : 'mobile';
  }
  function focusHome(force=false) {
    if(!isTV() || document.querySelector('#mobilePlayer:not(.hidden),#sheetBackdrop:not(.hidden),#searchOverlay:not(.hidden)')) return;
    if(force || document.activeElement===document.body || document.activeElement===document.documentElement)
      document.getElementById('spotlightPlayBtn')?.focus({preventScroll:true});
  }
  window.OtiumDisplay={isTV,focusHome,apply};
  apply();
  window.addEventListener('resize',apply);
  function init() {
    const selector=document.getElementById('displayModeSelect');
    selector.value=preference;
    selector.addEventListener('change',()=>{
      preference=selector.value;
      try { localStorage.setItem('otium_display',preference); } catch (_) {}
      apply();focusHome(true);
    });
    document.addEventListener('keydown',event=>{
      if(!isTV()) return;
      const player=document.getElementById('mobilePlayer');
      const playerOpen=!player.classList.contains('hidden');
      if(['MediaFastForward','MediaRewind','MediaTrackNext'].includes(event.key)&&playerOpen){event.preventDefault();document.getElementById(event.key==='MediaFastForward'?'centerForward':event.key==='MediaRewind'?'centerRewind':'autoNextPlayBtn').click();return;}
      if(event.key==='MediaPlayPause' && playerOpen){event.preventDefault();document.getElementById('centerPlay').click();return;}
      if(['BrowserBack','GoBack','Backspace'].includes(event.key) && !event.target.matches('input,textarea')){
        event.preventDefault();
        if(window.krmziIsSheetOpen?.()) window.krmziCloseSheet();
        else if(window.krmziIsSearchOpen?.()) window.krmziCloseSearch();
        else if(playerOpen) {window.krmziClosePlayer();focusHome(true);}
        else document.querySelector('[data-tab="home"]').click();
        return;
      }
      if(playerOpen && event.target.id==='playerCanvas' && ['Enter',' '].includes(event.key)){
        event.preventDefault();document.getElementById('centerPlay').click();return;
      }
      if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)) return;
      if(event.target.matches('select') || (event.target.matches('input,textarea') && ['ArrowLeft','ArrowRight'].includes(event.key))) return;
      const sheet=document.getElementById('sheetBackdrop'),search=document.getElementById('searchOverlay');
      const root=!sheet.classList.contains('hidden')?sheet:!search.classList.contains('hidden')?search:playerOpen?player:document.getElementById('appFrame');
      if(root===player && document.getElementById('playerHudTop').classList.contains('hud-hidden')){
        event.preventDefault();
        if(event.key==='ArrowLeft'||event.key==='ArrowRight'){window.OtiumControls?.seek(event.key==='ArrowLeft'?-10:10);return;}
        // Up/down reveals controls without changing playback.
        for(const id of ['playerHudTop','playerHudBottom','hudCenter'])document.getElementById(id).classList.remove('hud-hidden');
        document.getElementById('centerPlay').focus({preventScroll:true});return;
      }
      event.preventDefault();
      const candidates=[...root.querySelectorAll('button,input,select,[role="button"][tabindex="0"],[role="slider"]')].filter(element=>{
        if(element.disabled || !element.getClientRects().length || element.closest('.hidden,.hud-hidden'))return false;
        const style=getComputedStyle(element);return style.visibility!=='hidden' && style.display!=='none';
      });
      const current=document.activeElement;
      if(!candidates.includes(current)){candidates[0]?.focus();return;}
      const rect=current.getBoundingClientRect(),cx=rect.x+rect.width/2,cy=rect.y+rect.height/2;
      const horizontal=['ArrowLeft','ArrowRight'].includes(event.key),sign=['ArrowLeft','ArrowUp'].includes(event.key)?-1:1;
      const ranked=candidates.filter(element=>element!==current).map(element=>{
        const r=element.getBoundingClientRect(),dx=r.x+r.width/2-cx,dy=r.y+r.height/2-cy;
        const primary=(horizontal?dx:dy)*sign,secondary=Math.abs(horizontal?dy:dx);
        const overlap=horizontal ? r.top<rect.bottom&&r.bottom>rect.top : r.left<rect.right&&r.right>rect.left;
        return {element,primary,score:primary+secondary*3+(overlap?0:1000)};
      }).filter(item=>item.primary>3).sort((a,b)=>a.score-b.score);
      const next=ranked[0]?.element;
      if(next){next.focus({preventScroll:true});next.scrollIntoView({block:'nearest',inline:'nearest',behavior:'auto'});}
    });
    focusHome();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
