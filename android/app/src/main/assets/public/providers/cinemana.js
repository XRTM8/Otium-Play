/* Cinemana adapter. Calls run on the user's network through the local/native API. */
(() => {
  const ref = (id) => `cinemana:${id}`;
  const idOf = (url) => String(url || '').match(/^cinemana:(\d+)$/)?.[1];
  const artwork = (item) => item.imgObjUrl || item.imgMediumThumbObjUrl || item.imgThumbObjUrl || '';
  const title = (item) => item.ar_title || item.en_title || 'بدون عنوان';
  const rootId = (item) => item.rootSeries && item.rootSeries !== '0' ? item.rootSeries : item.nb;
  const card = (item) => ({ url: ref(item.nb), title: title(item), thumbnail: item.imgMediumThumbObjUrl || artwork(item), artwork: artwork(item), seriesTitle: title(item),
    source: 'cinemana', type: String(item.kind) === '1' ? 'episode' : 'series', year: item.year || '', rating: item.stars || '',
    seriesUrl: String(item.kind) === '1' ? '' : ref(rootId(item)) });
  async function request(path, signal) {
    const response = await fetch('/api/cinemana?path=' + encodeURIComponent(path), { signal, cache:'no-store' });
    if (!response.ok) throw new Error('سينمانا غير متاح على اتصالك الحالي');
    const data = await response.json();
    if (data.error || data.status === false) throw new Error('سينمانا غير متاح على اتصالك الحالي');
    return data;
  }
  const rows = (data) => Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
  window.OtiumCinemana = {
    owns: (url) => Boolean(idOf(url)),
    async call(endpoint, params, signal) {
      if (endpoint === '/api/home') {
        const [series, movies] = await Promise.all([
          request('latestSeries/level/0/itemsPerPage/24/page/0/', signal),
          request('latestMovies/level/0/itemsPerPage/24/page/0/', signal),
        ]);
        return { episodes:{episodes:rows(movies).map(card)},series:{series:rows(series).map(card)} };
      }
      if (endpoint === '/api/series' || endpoint === '/api/episodes') {
        const movie = endpoint === '/api/episodes';
        const data = await request(`${movie?'latestMovies':'latestSeries'}/level/0/itemsPerPage/24/page/0/`,signal);
        return {[movie?'episodes':'series']:rows(data).map(card)};
      }
      if (endpoint === '/api/search') {
        const data = await request('video/V/2/itemsPerPage/20/video_title_search/'+encodeURIComponent(params.q)+'/itemsPerPage/12/pageNumber/0/level/0',signal);
        return {results:rows(data).map(card)};
      }
      const id = idOf(params.url);
      if (!id) throw new Error('Invalid Cinemana reference');
      if (endpoint === '/api/series/detail') {
        const [info, items] = await Promise.all([request('allVideoInfo/id/'+id,signal),request('videoSeason/id/'+id,signal)]);
        const episodes = rows(items).map(item => ({...card(item),episodeNum:String(item.episodeNummer||''),season:String(item.season||'1'),
          seriesUrl:ref(rootId(info)),title:`الحلقة ${item.episodeNummer||''}`}))
          .sort((a,b)=>Number(a.season)-Number(b.season)||Number(a.episodeNum)-Number(b.episodeNum));
        return {...card(info),poster:artwork(info),story:info.ar_content||info.en_content||'',episodes};
      }
      if (endpoint === '/api/episode/detail') {
        const [info, files] = await Promise.all([request('allVideoInfo/id/'+id,signal),request('transcoddedFiles/id/'+id,signal)]);
        const streams = rows(files).filter(f=>f.videoUrl && /^https:\/\//.test(f.videoUrl) && ['mp4','m3u8','hls'].includes(String(f.container).toLowerCase()))
          .map(f=>({quality:f.resolution || 'تلقائي',url:f.videoUrl,...(/m3u8|hls/i.test(f.container)?{type:'hls',provider:'cinemana'}:{})}))
          .sort((a,b)=>(parseInt(b.quality)||0)-(parseInt(a.quality)||0));
        if (!streams.length) throw new Error('روابط سينمانا غير متاحة على شبكتك');
        return {...card(info), title:String(info.kind)==='1'?title(info):`${title(info)} · الحلقة ${info.episodeNummer||''}`,
          subtitles:rows(info.translations).filter(t=>t.extention==='vtt' && /^https:\/\//.test(t.file||'')).map(t=>({url:t.file,lang:t.type,label:t.type==='ar'?'العربية':t.type==='en'?'English':t.name})),
          poster:artwork(info),episodeNum:String(info.episodeNummer||''),season:String(info.season||'1'),
          seriesUrl:String(info.kind)==='1'?'':ref(rootId(info)),servers:[],directStreams:streams,isSuccess:true};
      }
      throw new Error('Unsupported Cinemana endpoint');
    },
  };
})();
