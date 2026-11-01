/* Shared catalogue identity; provider URLs remain distinct for playback. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.OtiumCatalogue=api;})(globalThis,()=>{
  const normalized=(value)=>String(value||'').normalize('NFKC').toLowerCase().replace(/[\u064b-\u065f\u0670\u0640]/g,'').replace(/[أإآ]/g,'ا').replace(/ى/g,'ي').replace(/^(مسلسل|فيلم)\s+/,'').replace(/الحلقة\s*\d+.*/,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  const provider=item=>item.source||(String(item.url).startsWith('cinemana:')?'cinemana':'krmzi');
  const episodeNumber=item=>String(item.episodeNum||String(item.title||'').match(/الحلقة\s*(\d+)/)?.[1]||'');
  function merge(items,preferred='cinemana'){
    const groups=[];
    for(const item of items){
      if(!item?.url)continue;
      const type=item.type==='series'?'series':item.mediaType==='movie'?'movie':'episode';
      const titles=[item.title,...(item.aliases||[])].map(normalized).filter(Boolean);
      let group=groups.find(g=>g.kind===type && (!g.year||!item.year||String(g.year)===String(item.year)) && g.keys.some(k=>titles.includes(k)) && (type!=='episode'||(g.episode===episodeNumber(item)&&g.season===String(item.season||'1'))));
      if(!group){group={kind:type,keys:titles,year:item.year,episode:episodeNumber(item),season:String(item.season||'1'),offers:[]};groups.push(group);}
      if(!group.year&&item.year)group.year=item.year;
      for(const offer of item.offers||[item])if(!group.offers.some(o=>o.url===offer.url))group.offers.push({...offer,source:provider(offer)});
      group.keys=[...new Set([...group.keys,...titles])];
    }
    return groups.map(group=>{const primary=group.offers.find(item=>provider(item)===preferred)||group.offers[0];return {...primary,offers:group.offers,sources:[...new Set(group.offers.map(provider))]};});
  }
  function matchEpisode(current,episodes){const number=episodeNumber(current);if(!number)return null;const found=episodes.filter(ep=>episodeNumber(ep)===number&&String(ep.season||'1')===String(current.season||'1'));return found.length===1?found[0]:null;}
  return {merge,normalized,provider,episodeNumber,matchEpisode};
});
