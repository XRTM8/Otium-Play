'use strict';

/**
 * Otium Play - multi-source viewing runtime
 *
 * Rules:
 *  - Never block the JS thread with synchronous bridge/network calls.
 *  - Fetch every screen through the native WebView interceptor (background thread)
 *    or the Node API. A small client cache removes repeated round-trips.
 *  - Render with delegated events instead of inline handlers.
 *  - Playback UI is frame-throttled; history is persisted at most once per 5s.
 */

(() => {
  const APP_VERSION = '1.3.0';
  const FAVS_KEY = 'krmzi_favs';
  const HIST_KEY = 'krmzi_hist';
  const PREF_QUALITY_KEY = 'krmzi_pref_quality';
  const UPDATE_DISMISSED_KEY = 'krmzi_update_dismissed';
  const MAX_HISTORY = 30;
  const HISTORY_SAVE_INTERVAL = 5000;
  const API_TIMEOUT = 15000;
  const GITHUB_RELEASES = 'https://api.github.com/repos/XRTM8/krmzi-app/releases/latest';

  const $ = (id) => document.getElementById(id);

  function readJSON(key, fallback) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || 'null');
      return Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  function readString(key, fallback) {
    try {
      return localStorage.getItem(key) || fallback;
    } catch {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  const state = {
    source: readString('otium_source', 'krmzi') === 'cinemana' ? 'cinemana' : 'krmzi',
    activeTab: 'home',
    previousTab: 'home',
    librarySubtab: 'favs',
    episodes: [],
    series: [],
    filteredSeries: [],
    activeFilter: 'all',
    currentEpisode: null,
    currentSeriesEpisodes: [],
    activeServer: null,
    activeQuality: null,
    brightness: 1.0,
    favorites: readJSON(FAVS_KEY, []),
    history: readJSON(HIST_KEY, []),
    preferredQuality: readString(PREF_QUALITY_KEY, '1080p (Full HD)'),
    qualityMode: readString('krmzi_quality_mode', 'auto'),
    hudTimeout: null,
    autoNextTimerId: null,
    autoNextCancelled: false,
    currentVersion: APP_VERSION,
    pendingUpdate: null,
    loadingHome: false,
    refreshing: false,
    updateChecking: false,
    searchAbort: null,
    playerAbort: null,
    drawerAbort: null,
    sheetToken: 0,
    lastHistorySave: 0,
    historySignature: '',
    skipIntroVisible: false,
    pillTimer: null,
    progressRaf: 0,
  };

  /* ------------------------------------------------------------------ */
  /*  DOM references                                                     */
  /* ------------------------------------------------------------------ */

  const contentCanvas = $('contentCanvas');
  const pullRefreshIndicator = $('pullRefreshIndicator');
  const brandBtn = $('brandBtn');

  const heroSpotlight = $('heroSpotlight');
  const spotlightMedia = $('spotlightMedia');
  const spotlightTitle = $('spotlightTitle');
  const spotlightBadgeText = $('spotlightBadgeText');
  const spotlightProgressWrap = $('spotlightProgressWrap');
  const spotlightProgressBar = $('spotlightProgressBar');
  const spotlightProgressText = $('spotlightProgressText');
  const spotlightPlayBtn = $('spotlightPlayBtn');
  const spotlightPlayBtnText = $('spotlightPlayBtnText');
  const spotlightSeriesBtn = $('spotlightSeriesBtn');

  const historySection = $('historySection');
  const historyCarousel = $('historyCarousel');
  const clearHistoryBtn = $('clearHistoryBtn');

  const episodesSection = $('episodesSection');
  const episodesCarousel = $('episodesCarousel');
  const genrePills = document.querySelectorAll('.genre-pill');
  const genreChipsWrap = $('genreChipsWrap');
  const seriesSection = $('seriesSection');
  const seriesGrid = $('seriesGrid');
  const seriesCountSub = $('seriesCountSub');

  const libraryView = $('libraryView');
  const libraryGrid = $('libraryGrid');
  const segmentBtns = document.querySelectorAll('.segment-btn');

  const dockBtns = document.querySelectorAll('.dock-btn');

  const openSearchBtn = $('openSearchBtn');
  const searchOverlay = $('searchOverlay');
  const closeSearchOverlay = $('closeSearchOverlay');
  const overlaySearchInput = $('overlaySearchInput');
  const clearSearchInput = $('clearSearchInput');
  const searchInitialState = $('searchInitialState');
  const searchGrid = $('searchGrid');

  const mobilePlayer = $('mobilePlayer');
  const playerCanvas = $('playerCanvas');
  const nativePlayer = $('nativePlayer');
  const embedPlayer = $('embedPlayer');
  const brightnessFilter = $('brightnessFilter');
  const speed2xPill = $('speed2xPill');
  const swipeIndicator = $('swipeIndicator');
  const swipeIcon = $('swipeIcon');
  const swipeValue = $('swipeValue');

  const skipIntroBtn = $('skipIntroBtn');
  const autoNextCard = $('autoNextCard');
  const autoNextTitle = $('autoNextTitle');
  const autoNextTimer = $('autoNextTimer');
  const autoNextPlayBtn = $('autoNextPlayBtn');
  const autoNextCancelBtn = $('autoNextCancelBtn');

  const playerSpinner = $('playerSpinner');
  const gesturesLayer = $('gesturesLayer');
  const rippleLeft = $('rippleLeft');
  const rippleRight = $('rippleRight');

  const playerHudTop = $('playerHudTop');
  const playerHudBottom = $('playerHudBottom');
  const dismissPlayerBtn = $('dismissPlayerBtn');
  const hudEpTitle = $('hudEpTitle');
  const hudSeriesTitle = $('hudSeriesTitle');
  const playerFavBtn = $('playerFavBtn');

  const hudCenter = $('hudCenter');
  const centerPlay = $('centerPlay');
  const centerRewind = $('centerRewind');
  const centerForward = $('centerForward');

  const timelineBar = $('timelineBar');
  const timelineLoaded = $('timelineLoaded');
  const timelineProgress = $('timelineProgress');
  const timelineThumb = $('timelineThumb');
  const hudTime = $('hudTime');

  const openServersSheetBtn = $('openServersSheetBtn');
  const activeServerLabel = $('activeServerLabel');
  const openQualitySheetBtn = $('openQualitySheetBtn');
  const activeQualityLabel = $('activeQualityLabel');
  const togglePipBtn = $('togglePipBtn');
  const toggleFullscreenBtn = $('toggleFullscreenBtn');

  const drawerEpisodesCarousel = $('drawerEpisodesCarousel');
  const drawerCount = $('drawerCount');
  const drawerActiveServerName = $('drawerActiveServerName');
  const drawerOpenServersBtn = $('drawerOpenServersBtn');

  const sheetBackdrop = $('sheetBackdrop');
  const sheetTitle = $('sheetTitle');
  const sheetBody = $('sheetBody');
  const closeSheetBtn = $('closeSheetBtn');

  const offlineState = $('offlineState');
  const retryBtn = $('retryBtn');

  const installedVersionText = $('installedVersionText');
  const manualCheckUpdateBtn = $('manualCheckUpdateBtn');
  const checkUpdateIcon = $('checkUpdateIcon');
  const checkUpdateBtnText = $('checkUpdateBtnText');

  const updateModalScrim = $('updateModalScrim');
  const updateModalTitle = $('updateModalTitle');
  const updateModalVersion = $('updateModalVersion');
  const updateChangelog = $('updateChangelog');
  const confirmUpdateBtn = $('confirmUpdateBtn');
  const dismissUpdateBtn = $('dismissUpdateBtn');

  /* ------------------------------------------------------------------ */
  /*  Small utilities                                                    */
  /* ------------------------------------------------------------------ */

  const HTML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function haptic(intensity = 'light') {
    if (!navigator.vibrate) return;
    try {
      if (intensity === 'heavy') navigator.vibrate([20]);
      else if (intensity === 'double') navigator.vibrate([8, 25, 8]);
      else navigator.vibrate([6]);
    } catch {
      /* vibration is best-effort */
    }
  }

  function debounce(fn, wait) {
    let timer = 0;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  function bridge(name, ...args) {
    const api = window.KrmziBridge;
    if (!api || typeof api[name] !== 'function') return null;
    try {
      return api[name](...args);
    } catch (error) {
      console.warn(`Bridge ${name} failed:`, error);
      return null;
    }
  }

  function setHeroImage(url) {
    if (!url) {
      spotlightMedia.style.backgroundImage = '';
      return;
    }
    const safeUrl = String(url).replace(/["\\]/g, '\\$&');
    spotlightMedia.style.backgroundImage = `url("${safeUrl}")`;
  }

  function imageTag(src, alt, className, eager = false) {
    return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" class="${className}" loading="${
      eager ? 'eager' : 'lazy'
    }" decoding="async" referrerpolicy="no-referrer">`;
  }

  /* ------------------------------------------------------------------ */
  /*  API layer: fetch-first, deduplicated, cached, abortable            */
  /* ------------------------------------------------------------------ */

  const apiCache = new Map();
  const apiInflight = new Map();

  const API_TTL = {
    '/api/home': 60_000,
    '/api/episodes': 120_000,
    '/api/series': 300_000,
    '/api/series/detail': 600_000,
    '/api/episode/detail': 0,
    '/api/search': 300_000,
  };

  function apiCacheKey(endpoint, params) {
    const qs = new URLSearchParams(params).toString();
    return qs ? `${endpoint}?${qs}` : endpoint;
  }

  function setApiCache(key, data, ttl) {
    if (!ttl) return;
    if (apiCache.size >= 150) {
      const oldest = apiCache.keys().next().value;
      if (oldest !== undefined) apiCache.delete(oldest);
    }
    apiCache.set(key, { data, expiresAt: Date.now() + ttl });
  }

  /**
   * Fetch JSON. In the Android app the WebView intercepts /api/* on a
   * background thread, so this stays completely off the UI thread.
   */
  async function apiCall(endpoint, params = {}, options = {}) {
    // Stream links expire and can be tied to the current network address.
    if (endpoint === '/api/episode/detail') {
      options = { ...options, noCache: true, noStaleFallback: true };
    }
    const source = params.url ? (window.OtiumCinemana?.owns(params.url) ? 'cinemana' : 'krmzi') : state.source;
    if (source === 'cinemana' && window.OtiumCinemana) return window.OtiumCinemana.call(endpoint, params, options.signal);
    const key = apiCacheKey(endpoint, params);
    const ttl = options.cacheTtl ?? API_TTL[endpoint] ?? 120_000;
    const cached = apiCache.get(key);

    if (!options.noCache && cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    if (!options.signal && apiInflight.has(key)) {
      return apiInflight.get(key);
    }

    const request = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeout ?? API_TIMEOUT);
      const onAbort = () => controller.abort();
      if (options.signal) {
        if (options.signal.aborted) controller.abort();
        else options.signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        const response = await fetch(key, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        setApiCache(key, data, ttl);
        return data;
      } catch (error) {
        // Serve stale data when the network hiccups; this is what makes the
        // app feel instant on flaky mobile connections.
        if (cached && cached.data && !options.noStaleFallback) return cached.data;
        throw error;
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', onAbort);
      }
    })();

    if (!options.signal) {
      apiInflight.set(key, request);
      request.finally(() => apiInflight.delete(key)).catch(() => {});
    }

    return request;
  }

  /* ------------------------------------------------------------------ */
  /*  Offline state                                                      */
  /* ------------------------------------------------------------------ */

  function showOfflineState() {
    offlineState?.classList.remove('hidden');
  }

  function hideOfflineState() {
    offlineState?.classList.add('hidden');
  }

  function checkAndShowOffline() {
    if (state.episodes.length === 0 && state.series.length === 0) {
      showOfflineState();
      spotlightTitle.textContent = 'تعذر الاتصال بالموقع';
      spotlightBadgeText.textContent = 'غير متصل';
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Home data                                                          */
  /* ------------------------------------------------------------------ */

  async function loadData(isRefresh = false) {
    if (state.loadingHome) return;
    state.loadingHome = true;
    if (isRefresh) haptic('double');
    hideOfflineState();

    if (state.episodes.length === 0) renderEpisodesSkeleton();
    if (state.series.length === 0) renderSeriesSkeleton();

    try {
      let home;
      try {
        home = await apiCall('/api/home', { page: 1 });
        if (!home?.episodes || !home?.series) {
          throw new Error('Incomplete /api/home payload');
        }
      } catch (homeError) {
        if (state.source === 'cinemana') throw homeError;
        // Backward compatible fallback for older native builds that do not
        // expose /api/home yet.
        const [episodes, series] = await Promise.all([
          apiCall('/api/episodes', { page: 1 }),
          apiCall('/api/series', { page: 1 }),
        ]);
        home = { episodes, series };
      }

      const episodes = home?.episodes?.episodes || [];
      const series = home?.series?.series || [];

      state.episodes = episodes;
      state.series = series;
      state.filteredSeries = filterSeries(series, state.activeFilter);

      if (seriesCountSub) seriesCountSub.textContent = `${series.length} مسلسل`;
      document.querySelector('[data-filter="year"]').disabled = !series.some(item => Number(item.year)>0);

      $('sourceStatus').textContent = '';
      $('sourceNetworkNote').classList.add('hidden');
      document.querySelector('#episodesSection h3').textContent = state.source === 'cinemana' ? 'أحدث الأفلام' : 'أحدث الحلقات';
      renderEpisodesCarousel(episodes);
      renderSeriesGrid(state.filteredSeries);
      renderSpotlight(episodes[0]);
      renderHistory();
      window.OtiumDisplay?.focusHome();

      if (episodes.length === 0 && series.length === 0) checkAndShowOffline();
      else hideOfflineState();
    } catch (error) {
      $('sourceStatus').textContent = state.source === 'cinemana' ? 'غير متاح حالياً' : 'تعذر الاتصال';
      $('sourceNetworkNote').classList.toggle('hidden', state.source !== 'cinemana');
      console.error('Error during loadData:', error);
      // Keep whatever was already rendered; only show the error card when
      // there is genuinely nothing to display.
      checkAndShowOffline();
      if (state.episodes.length) renderEpisodesCarousel(state.episodes);
      if (state.series.length) renderSeriesGrid(state.filteredSeries);
    } finally {
      state.loadingHome = false;
      pullRefreshIndicator?.classList.remove('visible');
    }
  }

  async function fetchEpisodes() {
    const data = await apiCall('/api/episodes', { page: 1 });
    state.episodes = data.episodes || [];
    if (state.episodes.length) {
      renderEpisodesCarousel(state.episodes);
      renderSpotlight(state.episodes[0]);
      hideOfflineState();
    }
    return data;
  }

  async function fetchSeries() {
    const data = await apiCall('/api/series', { page: 1 });
    state.series = data.series || [];
    state.filteredSeries = filterSeries(state.series, state.activeFilter);
    if (seriesCountSub) seriesCountSub.textContent = `${state.series.length} مسلسل`;
    renderSeriesGrid(state.filteredSeries);
    return data;
  }

  function filterSeries(series, filter) {
    if (filter === 'az') return [...series].sort((a,b) => String(a.title).localeCompare(String(b.title),'ar'));
    if (filter === 'year') return [...series].sort((a,b) => (Number(b.year)||0)-(Number(a.year)||0));
    return series;
  }

  /* ------------------------------------------------------------------ */
  /*  Rendering helpers                                                  */
  /* ------------------------------------------------------------------ */

  function episodeTile(ep, options = {}) {
    const progress =
      options.progress != null ? clamp(Number(options.progress) || 0, 0, 100) : null;
    const badge = ep.episodeNum
      ? `<div class="ep-tile-badge">حلقة <span>${escapeHtml(ep.episodeNum)}</span></div>`
      : '';
    const progressBar =
      progress != null
        ? `<div class="tile-progress-track"><div class="tile-progress-fill" style="width:${progress}%"></div></div>`
        : '';
    const subtitle = options.subtitle ?? ep.seriesTitle ?? '';

    return `
      <div class="ep-tile" data-action="episode" data-url="${escapeHtml(ep.url)}" role="button" tabindex="0">
        <div class="ep-tile-poster">
          ${imageTag(ep.thumbnail, ep.title, 'ep-tile-img')}
          ${progressBar}
          ${badge}
        </div>
        <div class="ep-tile-name">${escapeHtml(ep.title)}</div>
        <div class="ep-tile-series">${escapeHtml(subtitle)}</div>
      </div>`;
  }

  function seriesTile(series, subtitle = 'تصفح الحلقات') {
    return `
      <div class="series-tile" data-action="series" data-url="${escapeHtml(series.url)}" role="button" tabindex="0">
        ${imageTag(series.thumbnail, series.title, 'series-tile-thumb')}
        <div class="series-tile-body">
          <div class="series-tile-title">${escapeHtml(series.title)}</div>
          <div class="series-tile-sub">${escapeHtml([series.year,Number(series.rating)>0 ? `★ ${Number(series.rating).toFixed(1)}` : ''].filter(Boolean).join('  ·  '))}</div>
        </div>
      </div>`;
  }

  function renderEpisodesCarousel(episodes) {
    if (!episodes.length) {
      episodesCarousel.innerHTML =
        '<p class="empty-note">لا توجد حلقات جديدة حالياً.</p>';
      return;
    }
    episodesCarousel.innerHTML = episodes
      .slice(0, 12)
      .map((ep, index) => episodeTile(ep, { eager: index < 2 }))
      .join('');
    // The first two thumbnails are above the fold on most phones.
    episodesCarousel.querySelectorAll('img').forEach((img, index) => {
      if (index < 2) img.loading = 'eager';
    });
  }

  function renderSeriesGrid(seriesList) {
    if (!seriesList.length) {
      seriesGrid.innerHTML =
        '<p class="empty-note" style="grid-column:1/-1">لا توجد مسلسلات تطابق هذا التصنيف.</p>';
      return;
    }
    seriesGrid.innerHTML = seriesList.map((series) => seriesTile(series)).join('');
  }

  function renderSpotlight(ep) {
    if (renderPinnedResume()) return;

    if (!ep) {
      spotlightTitle.textContent = 'لا توجد حلقات جديدة';
      spotlightBadgeText.textContent = 'الأحدث الآن';
      return;
    }

    setHeroImage(ep.artwork || ep.thumbnail);
    spotlightTitle.textContent = ep.title || '';
    spotlightBadgeText.textContent = ep.episodeNum
      ? `الحلقة ${ep.episodeNum}`
      : 'جديد في المكتبة';
    spotlightProgressWrap.classList.add('hidden');
    spotlightPlayBtnText.textContent = 'شاهد الآن';
    $('spotlightContext').textContent = [ep.seriesTitle && ep.seriesTitle !== ep.title ? ep.seriesTitle : '',ep.year || '',state.source === 'cinemana' ? 'سينمانا' : 'قرمزي'].filter(Boolean).join(' · ');

    spotlightPlayBtn.onclick = () => {
      haptic();
      openEpisode(ep.url);
    };
    spotlightSeriesBtn.onclick = () => {
      haptic();
      if (ep.seriesUrl) openSeriesByUrl(ep.seriesUrl);
      else searchSeries(ep.seriesTitle || ep.title);
    };
  }

  function updateResumeProgress(item) {
    const duration = Number(item.duration) || 0;
    const current = Number(item.currentTime) || 0;
    const percent = duration > 0 ? clamp(Math.round((current / duration) * 100), 0, 100) : 0;

    spotlightProgressBar.style.width = `${percent}%`;
    spotlightProgressText.textContent =
      duration > 0
        ? `وصلت إلى ${formatTime(current)} / ${formatTime(duration)} (${percent}%)`
        : `وصلت إلى ${formatTime(current)}`;
  }

  function renderPinnedResume() {
    const item = state.history.find(entry => (window.OtiumCinemana?.owns(entry.url) ? 'cinemana' : 'krmzi') === state.source);
    if (!item) {
      spotlightProgressWrap.classList.add('hidden');
      spotlightPlayBtnText.textContent = 'شاهد الآن';
      return false;
    }

    if (item.thumbnail) setHeroImage(item.thumbnail);
    spotlightTitle.textContent = item.seriesTitle || item.title;
    const episodeLabel = item.episodeNum ? `الحلقة ${item.episodeNum}` : '';
    $('spotlightContext').textContent = state.source === 'cinemana' ? 'سينمانا' : 'قرمزي';
    spotlightBadgeText.innerHTML = `متابعة المشاهدة${
      episodeLabel ? ` • ${escapeHtml(episodeLabel)}` : ''
    }`;
    spotlightProgressWrap.classList.remove('hidden');
    updateResumeProgress(item);
    spotlightPlayBtnText.textContent = item.episodeNum
      ? `استئناف حلقة ${item.episodeNum}`
      : 'متابعة المشاهدة';

    spotlightPlayBtn.onclick = () => {
      haptic('heavy');
      openEpisode(item.url);
    };
    spotlightSeriesBtn.onclick = () => {
      haptic();
      if (item.seriesUrl) openSeriesByUrl(item.seriesUrl);
      else searchSeries(item.seriesTitle || item.title);
    };
    return true;
  }

  function renderHistory() {
    renderPinnedResume();

    if (!state.history.length) {
      historySection.classList.add('hidden');
      state.historySignature = '';
      return;
    }

    historySection.classList.toggle('hidden', state.activeTab !== 'home');

    const signature = state.history
      .map(
        (item) =>
          `${item.url}|${Math.round(Number(item.currentTime) || 0)}|${Math.round(
            Number(item.duration) || 0
          )}`
      )
      .join('~');
    if (signature === state.historySignature && historyCarousel.childElementCount) return;
    state.historySignature = signature;

    historyCarousel.innerHTML = state.history
      .slice(0, 20)
      .map((item) => {
        const percent = item.duration
          ? clamp((Number(item.currentTime) / Number(item.duration)) * 100, 0, 100)
          : 0;
        return episodeTile(item, {
          progress: percent,
          subtitle: `وصلت إلى ${formatTime(item.currentTime)} (${Math.round(percent)}%)`,
        });
      })
      .join('');
  }

  function renderLibrary() {
    if (state.librarySubtab === 'favs') {
      if (!state.favorites.length) {
        libraryGrid.innerHTML =
          '<p class="empty-note" style="grid-column:1/-1">لم تقم بإضافة مسلسلات للمفضلة بعد.</p>';
        return;
      }
      libraryGrid.innerHTML = state.favorites
        .slice(0, 60)
        .map((fav) => episodeTile(fav, { subtitle: 'استئناف' }))
        .join('');
      return;
    }

    if (!state.history.length) {
      libraryGrid.innerHTML =
        '<p class="empty-note" style="grid-column:1/-1">سجل المشاهدة فارغ.</p>';
      return;
    }

    libraryGrid.innerHTML = state.history
      .map((item) =>
        episodeTile(item, {
          subtitle: `متبقي ${formatTime(
            (Number(item.duration) || 0) - (Number(item.currentTime) || 0)
          )}`,
        })
      )
      .join('');
  }

  function renderEpisodesSkeleton() {
    episodesCarousel.innerHTML = Array.from(
      { length: 6 },
      () => `
        <div class="ep-tile" aria-hidden="true">
          <div class="ep-tile-poster skeleton-cell"></div>
          <div class="skeleton-cell skeleton-line"></div>
        </div>`
    ).join('');
  }

  function renderSeriesSkeleton() {
    seriesGrid.innerHTML = Array.from(
      { length: 6 },
      () => `
        <div class="series-tile" aria-hidden="true">
          <div class="skeleton-cell skeleton-poster"></div>
          <div class="series-tile-body"><div class="skeleton-cell skeleton-line"></div></div>
        </div>`
    ).join('');
  }

  /* ------------------------------------------------------------------ */
  /*  Search                                                             */
  /* ------------------------------------------------------------------ */

  let searchDebounceTimer = 0;

  function setupSearch() {
    openSearchBtn.addEventListener('click', () => {
      haptic();
      openSearch();
    });

    closeSearchOverlay.addEventListener('click', () => {
      haptic();
      closeSearch(true);
    });

    overlaySearchInput.addEventListener('input', () => {
      const query = overlaySearchInput.value.trim();
      clearSearchInput.classList.toggle('hidden', !query);
      clearTimeout(searchDebounceTimer);

      if (!query) {
        state.searchAbort?.abort();
        searchInitialState.classList.remove('hidden');
        searchGrid.classList.add('hidden');
        searchGrid.innerHTML = '';
        return;
      }

      state.searchAbort?.abort();
      const controller = new AbortController();
      state.searchAbort = controller;
      searchDebounceTimer = setTimeout(() => executeSearch(query, controller.signal), 250);
    });

    clearSearchInput.addEventListener('click', () => {
      haptic();
      state.searchAbort?.abort();
      overlaySearchInput.value = '';
      clearSearchInput.classList.add('hidden');
      searchInitialState.classList.remove('hidden');
      searchGrid.classList.add('hidden');
      searchGrid.innerHTML = '';
      overlaySearchInput.focus();
    });

    overlaySearchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const query = overlaySearchInput.value.trim();
        if (!query) return;
        clearTimeout(searchDebounceTimer);
        state.searchAbort?.abort();
        const controller = new AbortController();
        state.searchAbort = controller;
        executeSearch(query, controller.signal);
        overlaySearchInput.blur();
      }
    });
  }

  function openSearch() {
    if (state.activeTab !== 'search') state.previousTab = state.activeTab;
    state.activeTab = 'search';
    dockBtns.forEach((button) => {
      button.classList.toggle('active', button.dataset.tab === 'search');
    });
    searchOverlay.classList.remove('hidden');
    setTimeout(() => overlaySearchInput.focus(), 60);
  }

  function closeSearch(restoreTab = true) {
    state.searchAbort?.abort();
    searchOverlay.classList.add('hidden');
    overlaySearchInput.value = '';
    clearSearchInput.classList.add('hidden');
    searchInitialState.classList.remove('hidden');
    searchGrid.classList.add('hidden');
    searchGrid.innerHTML = '';
    if (restoreTab) switchTab(state.previousTab || 'home');
  }

  async function executeSearch(query, signal) {
    const trimmed = String(query || '').trim();
    if (!trimmed) return;

    searchInitialState.classList.add('hidden');
    searchGrid.classList.remove('hidden');

    const key = apiCacheKey('/api/search', { q: trimmed });
    const cached = apiCache.get(key);
    if (!cached || cached.expiresAt <= Date.now()) {
      searchGrid.innerHTML = Array.from(
        { length: 4 },
        () =>
          '<div class="series-tile" aria-hidden="true"><div class="skeleton-cell skeleton-poster"></div></div>'
      ).join('');
    }

    try {
      const data = await apiCall(
        '/api/search',
        { q: trimmed },
        { signal, cacheTtl: API_TTL['/api/search'] }
      );
      if (signal?.aborted) return;
      renderSearchResults(data.results || []);
    } catch (error) {
      if (error?.name === 'AbortError') return;
      searchGrid.innerHTML =
        '<p class="empty-note" style="grid-column:1/-1">تعذر البحث. يرجى المحاولة لاحقاً.</p>';
    }
  }

  function renderSearchResults(results) {
    const unique = [];
    const seen = new Set();
    for (const item of results) {
      if (!item?.url || seen.has(item.url)) continue;
      seen.add(item.url);
      unique.push(item);
    }

    if (!unique.length) {
      searchGrid.innerHTML =
        '<p class="empty-note" style="grid-column:1/-1">لم يتم العثور على نتائج.</p>';
      return;
    }

    searchGrid.innerHTML = unique
      .map((item) => {
        const isSeries = item.type === 'series';
        return `
          <div class="series-tile" data-action="search-result" data-type="${isSeries ? 'series' : 'episode'}" data-url="${escapeHtml(
            item.url
          )}" role="button" tabindex="0">
            ${imageTag(item.thumbnail, item.title, 'series-tile-thumb')}
            <div class="series-tile-body">
              <div class="series-tile-title">${escapeHtml(item.title)}</div>
              <div class="series-tile-sub">${isSeries ? 'مسلسل كامل' : 'حلقة'}</div>
            </div>
          </div>`;
      })
      .join('');
  }

  function searchSeries(title) {
    const query = String(title || '').trim();
    if (!query) return;
    openSearch();
    overlaySearchInput.value = query;
    clearSearchInput.classList.remove('hidden');
    state.searchAbort?.abort();
    const controller = new AbortController();
    state.searchAbort = controller;
    executeSearch(query, controller.signal);
  }

  /* ------------------------------------------------------------------ */
  /*  Player                                                             */
  /* ------------------------------------------------------------------ */

  let directWatchdogTimer = null;
  let embedSpinnerTimer = null;
  let playbackAttempt = 0;
  let playbackSession = 0;
  let metadataHandler = null;
  let episodeRetryUsed = false;
  let activeEpisodeUrl = '';
  let seriesContext = null;
  let attemptQueue = [];
  let attemptPosition = 0;
  let pendingResumeTime = 0;
  let pendingPaused = false;
  let hlsPlayer = null;

  function clearDirectWatchdog() {
    clearInterval(directWatchdogTimer);
    directWatchdogTimer = null;
  }

  function resetSpinner(message = 'جاري تجهيز الفيديو…') {
    mobilePlayer.classList.remove('player-error');
    playerSpinner.innerHTML = `<div class="spinner-ring"></div><p class="player-load-status" role="status">${escapeHtml(message)}</p>`;
    mobilePlayer.classList.add('player-loading');
  }

  function setPlayerMessage(message) {
    mobilePlayer.classList.add('player-loading', 'player-error');
    playerSpinner.innerHTML = `<p class="player-message" role="status">${escapeHtml(message)}</p><div class="player-retry-actions"><button class="player-retry-btn" data-player-retry>إعادة المحاولة</button>${window.OtiumCinemana?.owns(activeEpisodeUrl) ? '<button class="player-retry-btn" data-player-source>قرمزي بدلاً منه</button>' : '<button class="player-retry-btn" data-player-servers>اختيار السيرفر</button>'}</div>`;
    playerSpinner.classList.remove('hidden');
    showHud(false);
  }

  function normalizedTitle(title) {
    return String(title || '').replace(/^مسلسل\s+/, '').replace(/الحلقة\s*\d+.*/, '').trim();
  }

  function findEpisodeContext(url) {
    const known = [...state.episodes, ...state.history, ...state.favorites].find((item) => item.url === url);
    const title = normalizedTitle(known?.seriesTitle || known?.title);
    const series = seriesContext?.episodes?.some((item) => item.url === url)
      ? seriesContext
      : state.series.find((item) => title && normalizedTitle(item.title) === title);
    return { known, series };
  }

  function setPlayerBackdrop(url) {
    const backdrop = $('playerBackdrop');
    if (!backdrop) return;
    // Reuse art already present in the catalogue; never set video.poster.
    backdrop.style.backgroundImage = url ? `url(${JSON.stringify(url)})` : '';
  }

  async function openEpisode(epUrl, fresh = false) {
    if (!epUrl) return;
    saveHistory(true);
    state.playerAbort?.abort();
    const controller = new AbortController();
    state.playerAbort = controller;
    const session = ++playbackSession;
    activeEpisodeUrl = epUrl;
    episodeRetryUsed = fresh;
    const context = findEpisodeContext(epUrl);

    resetPlayer();
    state.currentEpisode = null;
    state.currentSeriesEpisodes = [];
    drawerEpisodesCarousel.innerHTML = '';
    drawerCount.textContent = 'جاري جلب الحلقات…';
    mobilePlayer.classList.remove('hidden');
    setPlayerBackdrop(context.series?.poster || context.series?.artwork || context.series?.thumbnail || context.known?.artwork || context.known?.thumbnail || '');
    resetSpinner('جاري الاتصال بسيرفر الحلقة…');
    playerSpinner.classList.remove('hidden');
    hudEpTitle.textContent = context.known?.title || 'جاري تحميل الحلقة…';
    hudSeriesTitle.textContent = context.series?.title || context.known?.seriesTitle || '';
    showHud(false);

    try {
      const episode = await apiCall('/api/episode/detail',
        { url: epUrl, ...(fresh ? { fresh: 1 } : {}) },
        { signal: controller.signal, timeout: 22000 });
      if (controller.signal.aborted || session !== playbackSession) return;
      if (episode.error || episode.isSuccess === false) throw new Error(episode.error || 'No episode');

      // Keep catalogue art; the episode-page poster is not requested at all.
      episode.artwork = context.series?.poster || context.series?.artwork || context.series?.thumbnail || context.known?.artwork || context.known?.thumbnail || '';
      state.currentEpisode = episode;
      setupEpisodeSubtitles(episode);
      saveHistory(true);
      hudEpTitle.textContent = episode.title || '';
      hudSeriesTitle.textContent = context.series?.title || context.known?.seriesTitle || (episode.episodeNum ? `الحلقة ${episode.episodeNum}` : '');
      refreshFavState();

      if (episode.directStreams?.length) {
        playDirectStream(episode.directStreams);
      } else if (episode.servers?.length) {
        playSandboxedEmbed(episode.servers[0]);
      } else {
        setPlayerMessage('لم تتوفر سيرفرات لهذه الحلقة. جرّب إعادة المحاولة.');
      }
      // Playback starts before the auxiliary episode-list request.
      if (episode.seriesUrl) loadDrawer(episode.seriesUrl, episode.url, session);
      else {
        drawerCount.textContent = 'فيلم';
        $('drawerEpisodeTools')?.classList.add('hidden');
        drawerEpisodesCarousel.innerHTML = '<div class="episode-empty"><i class="fa-solid fa-film"></i><p>أنت تشاهد فيلماً</p><span>يمكنك تغيير الجودة من المشغل.</span></div>';
      }
    } catch (error) {
      if (controller.signal.aborted || session !== playbackSession) return;
      console.warn('Failed to open episode:', error);
      setPlayerMessage(window.OtiumCinemana?.owns(epUrl) ? 'تعذر تشغيل سينمانا على شبكتك. جرّب اتصالاً يدعم الخدمة أو اختر مصدر قرمزي.' : 'تعذر الاتصال بسيرفر الحلقة. أعد المحاولة.');
    } finally {
      if (state.playerAbort === controller) state.playerAbort = null;
    }
  }

  function setupEpisodeSubtitles(episode) {
    nativePlayer.querySelectorAll('track').forEach(track=>track.remove());
    const tracks = episode.subtitles || [];
    $('toggleSubtitlesBtn').classList.toggle('hidden', !tracks.length);
    for (const item of tracks) {
      const track=document.createElement('track');track.kind='subtitles';track.label=item.label;track.srclang=item.lang;
      track.src='/api/cinemana/subtitle?url='+encodeURIComponent(item.url);track.default=item.lang==='ar';nativePlayer.append(track);
    }
  }

  function clearMediaHandlers() {
    if (hlsPlayer) {
      hlsPlayer.destroy();
      hlsPlayer = null;
    }
    nativePlayer.onerror = null;
    nativePlayer.oncanplay = null;
    nativePlayer.onplaying = null;
    nativePlayer.onprogress = null;
    nativePlayer.onloadeddata = null;
    if (metadataHandler) nativePlayer.removeEventListener('loadedmetadata', metadataHandler);
    metadataHandler = null;
  }

  function resetPlayer() {
    ++playbackAttempt;
    clearDirectWatchdog();
    clearTimeout(embedSpinnerTimer);
    clearMediaHandlers();
    embedPlayer.onload = null;
    embedPlayer.onerror = null;
    nativePlayer.pause();
    nativePlayer.removeAttribute('src');
    nativePlayer.removeAttribute('poster');
    nativePlayer.querySelectorAll('track').forEach(track=>track.remove());
    $('toggleSubtitlesBtn')?.classList.add('hidden');
    nativePlayer.load();
    nativePlayer.classList.add('hidden');
    nativePlayer.playbackRate = 1;
    embedPlayer.classList.add('hidden');
    embedPlayer.removeAttribute('src');
    mobilePlayer.classList.remove('embed-mode', 'video-playing', 'player-error');
    timelineProgress.style.width = '0%';
    timelineLoaded.style.width = '0%';
    timelineThumb.style.right = '100%';
    hudTime.textContent = '00:00 / 00:00';
    skipIntroBtn.classList.add('hidden');
    autoNextCard.classList.add('hidden');
    clearTimeout(state.autoNextTimerId);
    state.autoNextTimerId = null;
    state.autoNextCancelled = false;
    state.skipIntroVisible = false;
    state.activeQuality = null;
    state.activeServer = null;
    pendingResumeTime = 0;
    pendingPaused = false;
    activeServerLabel.textContent = 'السيرفر';
    activeQualityLabel.textContent = state.qualityMode === 'auto' ? 'تلقائي' : state.preferredQuality;
    if (drawerActiveServerName) drawerActiveServerName.textContent = 'تلقائي';
    state.drawerAbort?.abort();
    state.drawerAbort = null;
  }

  function initialStreamIndex(streams) {
    const adaptive = streams.findIndex((stream) => stream.type === 'hls');
    if (adaptive >= 0 && (window.Hls?.isSupported() || nativePlayer.canPlayType('application/vnd.apple.mpegurl'))) return adaptive;
    if (state.qualityMode === 'manual') {
      const preferred = streams.findIndex((stream) => stream.quality === state.preferredQuality);
      if (preferred >= 0) return preferred;
    }
    // A measured startup profile: smaller rendition on constrained links,
    // otherwise 720p. Full HD remains one tap away without re-opening the episode.
    const connection = navigator.connection;
    const target = connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType || '') ? 480 : 720;
    const ranked = streams.map((stream, index) => ({ index, height: parseInt(stream.quality, 10) || 0 })).filter((item) => item.height > 0);
    return (ranked.filter((item) => item.height <= target).sort((a, b) => b.height - a.height)[0]
      || ranked.sort((a, b) => a.height - b.height)[0])?.index || 0;
  }

  function playDirectStream(streams, index = initialStreamIndex(streams), options = {}) {
    if (!streams?.length) return fallbackToEmbedServer();
    const saved = state.history.find((item) => item.url === state.currentEpisode?.url);
    pendingResumeTime = options.resumeAt ?? (saved && Number(saved.currentTime) > 10 ? Number(saved.currentTime) : 0);
    pendingPaused = options.paused ?? false;
    // Try lower renditions before heavier ones. Limit failed startup attempts
    // so an unavailable CDN cannot consume a minute of silent retries.
    const height = parseInt(streams[index]?.quality, 10) || (state.qualityMode === 'manual' ? parseInt(state.preferredQuality, 10) : 720);
    const rest = streams.map((stream, i) => ({ i, height: parseInt(stream.quality, 10) || 0 }))
      .filter((item) => item.i !== index && streams[item.i].type !== 'hls')
      .sort((a, b) => (a.height > height) - (b.height > height) || b.height - a.height);
    attemptQueue = [index, ...rest.map((item) => item.i)].slice(0, 3);
    attemptPosition = 0;
    startDirectAttempt(streams);
  }

  function startDirectAttempt(streams) {
    clearDirectWatchdog();
    clearTimeout(embedSpinnerTimer);
    clearMediaHandlers();
    const selected = streams[attemptQueue[attemptPosition]];
    if (!selected?.url) return fallbackToEmbedServer();
    const attempt = ++playbackAttempt;
    const session = playbackSession;
    let hasPlayed = false;
    let lastBuffered = 0;
    let lastTime = pendingResumeTime;
    let lastAdvance = performance.now();
    const startedAt = lastAdvance;
    const isCurrent = () => attempt === playbackAttempt && session === playbackSession && !mobilePlayer.classList.contains('hidden');

    nativePlayer.pause();
    mobilePlayer.classList.remove('embed-mode', 'video-playing');
    embedPlayer.classList.add('hidden');
    embedPlayer.removeAttribute('src');
    embedPlayer.onload = null;
    embedPlayer.onerror = null;
    nativePlayer.classList.add('hidden');
    resetSpinner(attemptPosition ? 'جاري تجربة جودة أخف…' : 'جاري تحميل الفيديو…');
    playerSpinner.classList.remove('hidden');
    state.activeQuality = selected;
    state.activeServer = { name: 'مباشر' };
    activeServerLabel.textContent = 'مباشر';
    if (drawerActiveServerName) drawerActiveServerName.textContent = 'مباشر';
    activeQualityLabel.textContent = state.qualityMode === 'auto' ? `تلقائي · ${selected.quality.split(' ')[0]}` : selected.quality;
    nativePlayer.preload = 'auto';

    const failed = () => {
      if (!isCurrent()) return;
      clearDirectWatchdog();
      const position = nativePlayer.currentTime;
      if (Number.isFinite(position) && position > 0) pendingResumeTime = position;
      if (++attemptPosition < attemptQueue.length) startDirectAttempt(streams);
      else fallbackToEmbedServer();
    };
    const ready = () => {
      if (!isCurrent()) return;
      nativePlayer.classList.remove('hidden');
      if (pendingPaused) {
        playerSpinner.classList.add('hidden');
        mobilePlayer.classList.remove('player-loading');
        mobilePlayer.classList.add('video-playing');
        clearDirectWatchdog();
        showHud(false);
      }
    };
    nativePlayer.onerror = failed;
    nativePlayer.oncanplay = ready;
    nativePlayer.onplaying = () => {
      if (!isCurrent()) return;
      hasPlayed = true;
      lastAdvance = performance.now();
      playerSpinner.classList.add('hidden');
      mobilePlayer.classList.remove('player-loading');
      mobilePlayer.classList.add('video-playing');
      nativePlayer.classList.remove('hidden');
    };
    metadataHandler = () => {
      if (!isCurrent()) return;
      if (pendingResumeTime > 0 && Number.isFinite(nativePlayer.duration)) {
        nativePlayer.currentTime = Math.min(pendingResumeTime, Math.max(0, nativePlayer.duration - 1));
      }
      metadataHandler = null;
    };
    nativePlayer.addEventListener('loadedmetadata', metadataHandler, { once: true });

    directWatchdogTimer = setInterval(() => {
      if (!isCurrent()) return clearDirectWatchdog();
      // Hidden tabs and intentional pauses must never trigger a server change.
      if (document.hidden || (hasPlayed && nativePlayer.paused)) { lastAdvance = performance.now(); return; }
      const now = performance.now();
      const end = nativePlayer.buffered.length ? nativePlayer.buffered.end(nativePlayer.buffered.length - 1) : 0;
      if (end > lastBuffered + 0.1 || nativePlayer.currentTime > lastTime + 0.1) lastAdvance = now;
      lastBuffered = end;
      lastTime = nativePlayer.currentTime;
      if ((!hasPlayed && now - startedAt > 16000) || now - lastAdvance > (hasPlayed ? 14000 : 6500)) failed();
    }, 1000);

    if (selected.type === 'hls' && window.Hls?.isSupported()) {
      const engine = new window.Hls({ enableWorker: true, autoStartLoad: false, maxBufferLength: 30, backBufferLength: 30 });
      hlsPlayer = engine;
      engine.on(window.Hls.Events.MANIFEST_PARSED, () => {
        if (!isCurrent()) return;
        const target = state.qualityMode === 'manual' ? parseInt(state.preferredQuality, 10)
          : navigator.connection?.saveData || /(^|-)2g$/.test(navigator.connection?.effectiveType || '') ? 480 : 720;
        const level = engine.levels.map((item, i) => ({ i, height: item.height }))
          .filter((item) => item.height <= target).sort((a, b) => b.height - a.height)[0]?.i ?? 0;
        engine.startLevel = level;
        if (state.qualityMode === 'manual') engine.currentLevel = level;
        engine.startLoad(pendingResumeTime || -1);
      });
      engine.on(window.Hls.Events.LEVEL_SWITCHED, (_, data) => {
        if (isCurrent() && state.qualityMode === 'auto') activeQualityLabel.textContent = `تلقائي · ${engine.levels[data.level]?.height || ''}p`;
      });
      engine.on(window.Hls.Events.ERROR, (_, data) => { if (data.fatal) failed(); });
      engine.loadSource('/api/media?url=' + encodeURIComponent(selected.url));
      engine.attachMedia(nativePlayer);
    } else {
      nativePlayer.src = selected.type === 'hls' ? '/api/media?url=' + encodeURIComponent(selected.url) : selected.url;
      nativePlayer.load();
    }
    if (!pendingPaused) nativePlayer.play().catch((error) => {
      if (!isCurrent() || error.name === 'AbortError') return;
      if (error.name === 'NotAllowedError') {
        clearDirectWatchdog();
        mobilePlayer.classList.remove('player-loading');
        playerSpinner.classList.add('hidden');
        showHud(false);
      }
    });
    showHud();
  }

  async function fallbackToEmbedServer() {
    clearDirectWatchdog();
    clearMediaHandlers();
    // Refresh a single time to recover expired/IP-bound links. Preserve position.
    if (!episodeRetryUsed && state.currentEpisode) {
      episodeRetryUsed = true;
      const session = playbackSession;
      const controller = new AbortController();
      state.playerAbort?.abort();
      state.playerAbort = controller;
      resetSpinner('جاري تجديد رابط المشاهدة…');
      playerSpinner.classList.remove('hidden');
      try {
        const episode = await apiCall('/api/episode/detail', { url: activeEpisodeUrl, fresh: 1 },
          { signal: controller.signal, timeout: 22000 });
        if (controller.signal.aborted || session !== playbackSession) return;
        if (episode.directStreams?.length) {
          episode.artwork = state.currentEpisode.artwork;
          state.currentEpisode = episode;
          playDirectStream(episode.directStreams, initialStreamIndex(episode.directStreams), { resumeAt: pendingResumeTime, paused: pendingPaused });
          return;
        }
      } catch (_) { /* use known alternate servers below */ }
      finally { if (state.playerAbort === controller) state.playerAbort = null; }
      if (controller.signal.aborted || session !== playbackSession) return;
    }
    const servers = state.currentEpisode?.servers || [];
    if (servers.length) {
      showPill('fa-rotate', 'تم الانتقال لسيرفر بديل');
      playSandboxedEmbed(servers[0]);
    } else setPlayerMessage('تعذر تشغيل الفيديو. جرّب إعادة المحاولة أو سيرفراً آخر.');
  }

  function playSandboxedEmbed(server) {
    if (!server?.embedUrl) return;
    ++playbackAttempt;
    clearDirectWatchdog();
    clearTimeout(embedSpinnerTimer);
    clearMediaHandlers();
    nativePlayer.pause();
    nativePlayer.removeAttribute('src');
    nativePlayer.load();
    nativePlayer.classList.add('hidden');
    resetSpinner('جاري فتح السيرفر البديل…');
    playerSpinner.classList.remove('hidden');
    mobilePlayer.classList.remove('video-playing');
    mobilePlayer.classList.add('embed-mode');
    embedPlayer.classList.remove('hidden');
    // Give users a bounded recovery path; iframe load is not video playback.
    embedSpinnerTimer = setTimeout(() => setPlayerMessage('إذا لم يبدأ الفيديو، اختر سيرفراً آخر أو أعد المحاولة.'), 15000);
    embedPlayer.onload = () => {
      clearTimeout(embedSpinnerTimer);
      playerSpinner.classList.add('hidden');
      mobilePlayer.classList.remove('player-loading');
    };
    embedPlayer.onerror = () => {
      clearTimeout(embedSpinnerTimer);
      setPlayerMessage('تعذر تحميل السيرفر. جرّب سيرفراً آخر.');
    };
    embedPlayer.src = server.embedUrl;
    state.activeServer = server;
    activeServerLabel.textContent = server.name || 'سيرفر';
    if (drawerActiveServerName) drawerActiveServerName.textContent = server.name || 'سيرفر';
    activeQualityLabel.textContent = 'من السيرفر';
    showHud(false);
  }

  function switchStreamQuality(url, qualityName) {
    const streams = state.currentEpisode?.directStreams || [];
    const index = streams.findIndex((stream) => stream.url === url);
    if (index < 0) return;
    const resumeAt = nativePlayer.currentTime || 0;
    const paused = mobilePlayer.classList.contains('embed-mode') ? false : nativePlayer.paused;
    state.preferredQuality = qualityName;
    state.qualityMode = 'manual';
    try {
      localStorage.setItem(PREF_QUALITY_KEY, qualityName);
      localStorage.setItem('krmzi_quality_mode', 'manual');
    } catch (_) { /* preferences are best effort */ }
    if (hlsPlayer?.levels.length) {
      const height = parseInt(qualityName, 10);
      const level = hlsPlayer.levels.findIndex((item) => item.height === height);
      if (level >= 0) {
        hlsPlayer.nextLevel = level;
        state.activeQuality = { quality: qualityName, url };
        activeQualityLabel.textContent = qualityName;
        return;
      }
    }
    playDirectStream(streams, index, { resumeAt, paused });
  }

  /* ------------------------------------------------------------------ */
  /*  Playback progress, history and HUD                                 */
  /* ------------------------------------------------------------------ */

  function onTimeUpdate() {
    if (!nativePlayer.duration || state.progressRaf) return;
    state.progressRaf = requestAnimationFrame(() => {
      state.progressRaf = 0;
      updateProgressUI();
    });
    scheduleHistorySave();
  }

  function updateProgressUI() {
    const current = nativePlayer.currentTime || 0;
    const duration = nativePlayer.duration || 0;
    if (!duration || !Number.isFinite(duration)) return;

    const percent = clamp((current / duration) * 100, 0, 100);
    timelineBar.setAttribute('aria-valuenow',String(Math.round(percent)));
    timelineBar.setAttribute('aria-valuetext',`${formatTime(current)} من ${formatTime(duration)}`);
    timelineProgress.style.width = `${percent}%`;
    timelineThumb.style.right = `${100 - percent}%`;

    const timeText = `${formatTime(current)} / ${formatTime(duration)}`;
    if (hudTime.textContent !== timeText) hudTime.textContent = timeText;

    const showSkip = current > 5 && current < 150;
    if (showSkip !== state.skipIntroVisible) {
      state.skipIntroVisible = showSkip;
      skipIntroBtn.classList.toggle('hidden', !showSkip);
    }

    if (
      duration - current <= 40 &&
      !state.autoNextCancelled &&
      state.currentSeriesEpisodes.length > 0
    ) {
      checkAutoNext();
    }
  }

  function scheduleHistorySave() {
    const now = Date.now();
    if (now - state.lastHistorySave < HISTORY_SAVE_INTERVAL) return;
    saveHistory(false);
  }

  function onProgress() {
    if (!nativePlayer.buffered.length || !nativePlayer.duration) return;
    const end = nativePlayer.buffered.end(nativePlayer.buffered.length - 1);
    timelineLoaded.style.width = `${clamp((end / nativePlayer.duration) * 100, 0, 100)}%`;
  }

  function checkAutoNext() {
    if (
      state.autoNextTimerId ||
      !autoNextCard.classList.contains('hidden') ||
      !state.currentEpisode
    ) {
      return;
    }

    const index = state.currentSeriesEpisodes.findIndex(
      (item) => item.url === state.currentEpisode.url
    );
    if (index < 0 || index >= state.currentSeriesEpisodes.length - 1) return;

    const nextEpisode = state.currentSeriesEpisodes[index + 1];
    autoNextTitle.textContent = nextEpisode.title || 'الحلقة التالية';
    autoNextCard.classList.remove('hidden');

    let secondsLeft = 5;
    autoNextTimer.textContent = String(secondsLeft);

    const tick = () => {
      secondsLeft -= 1;
      autoNextTimer.textContent = String(Math.max(0, secondsLeft));
      if (secondsLeft <= 0) {
        state.autoNextTimerId = null;
        playNextEpisodeNow();
      } else {
        state.autoNextTimerId = setTimeout(tick, 1000);
      }
    };
    state.autoNextTimerId = setTimeout(tick, 1000);
  }

  function playNextEpisodeNow() {
    clearTimeout(state.autoNextTimerId);
    state.autoNextTimerId = null;
    autoNextCard.classList.add('hidden');
    if (!state.currentEpisode) return;

    const index = state.currentSeriesEpisodes.findIndex(
      (item) => item.url === state.currentEpisode.url
    );
    if (index >= 0 && index < state.currentSeriesEpisodes.length - 1) {
      openEpisode(state.currentSeriesEpisodes[index + 1].url);
    }
  }

  function saveHistory(force = false, options = {}) {
    if (!state.currentEpisode) return;
    const now = Date.now();
    if (!force && now - state.lastHistorySave < HISTORY_SAVE_INTERVAL) return;
    state.lastHistorySave = now;

    const episode = state.currentEpisode;
    let seriesTitle = episode.seriesTitle || '';
    if (!seriesTitle && episode.title) {
      seriesTitle = episode.title.replace(/الحلقة\s*\d+.*/, '').trim();
    }

    const current =
      Number.isFinite(nativePlayer.currentTime) && nativePlayer.currentTime > 0
        ? nativePlayer.currentTime
        : 0;
    const duration =
      Number.isFinite(nativePlayer.duration) && nativePlayer.duration > 0
        ? nativePlayer.duration
        : 0;

    const item = {
      title: episode.title || '',
      seriesTitle: seriesTitle || episode.title || '',
      seriesUrl: episode.seriesUrl || '',
      episodeNum: episode.episodeNum || '',
      url: episode.url,
      thumbnail: episode.artwork || '',
      currentTime: current,
      duration,
      updatedAt: now,
    };

    const index = state.history.findIndex(
      (entry) =>
        entry.url === item.url ||
        (item.seriesTitle && entry.seriesTitle === item.seriesTitle)
    );
    if (index >= 0) {
      const previous = state.history[index];
      if (previous.url === item.url && current === 0 && Number(previous.currentTime) > 0) {
        item.currentTime = previous.currentTime;
        item.duration = previous.duration;
      }
      state.history.splice(index, 1);
    }

    state.history.unshift(item);
    if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;
    state.historySignature = '';
    writeJSON(HIST_KEY, state.history);

    if (options.render && mobilePlayer.classList.contains('hidden')) {
      renderHistory();
      if (state.activeTab === 'library') renderLibrary();
    }
  }

  function closePlayer() {
    saveHistory(true, { render: true });
    ++playbackSession;
    state.playerAbort?.abort();
    resetPlayer();
    activeEpisodeUrl = '';
    mobilePlayer.classList.add('hidden');
    playerSpinner.classList.add('hidden');

    bridge('setVideoPlaying', false);
    bridge('setLandscape', false);
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});

    state.currentEpisode = null;
    state.currentSeriesEpisodes = [];
    state.activeServer = null;
    state.activeQuality = null;
    renderHistory();
    if (state.activeTab === 'library') renderLibrary();
    window.OtiumDisplay?.focusHome(true);
  }

  async function loadDrawer(seriesUrl, currentEpisodeUrl, session = playbackSession) {
    state.drawerAbort?.abort();
    const controller = new AbortController();
    state.drawerAbort = controller;

    if (!seriesUrl) {
      drawerCount.textContent = '0 حلقة';
      drawerEpisodesCarousel.innerHTML = '';
      return;
    }

    try {
      const series = await apiCall(
        '/api/series/detail',
        { url: seriesUrl },
        { signal: controller.signal, cacheTtl: API_TTL['/api/series/detail'] }
      );
      if (controller.signal.aborted || session !== playbackSession) return;

      seriesContext = series;
      if (state.currentEpisode?.url === currentEpisodeUrl && !state.currentEpisode.artwork) {
        state.currentEpisode.artwork = series.poster || '';
        setPlayerBackdrop(series.poster || '');
      }
      state.currentSeriesEpisodes = series.episodes || [];
      $('drawerEpisodeTools')?.classList.remove('hidden');
      $('drawerEpisodeSearch').value = '';
      const seasons = [...new Set(state.currentSeriesEpisodes.map(ep => String(ep.season || '1')))];
      drawerSeason = String(state.currentEpisode?.season || seasons[0] || '1');
      $('drawerSeasonTabs').innerHTML = seasons.map(season => `<button class="season-tab ${season === drawerSeason ? 'active' : ''}" data-drawer-season="${escapeHtml(season)}">الموسم ${escapeHtml(season)}</button>`).join('');
      renderDrawerEpisodes();
    } catch (error) {
      if (error?.name !== 'AbortError') console.warn('Drawer load failed:', error);
    }
  }

  let drawerSeason = '1';
  function episodeCard(episode, index, artwork, currentUrl = '', sheet = false) {
    const saved = state.history.find(item => item.url === episode.url);
    const active = episode.url === currentUrl;
    const progress = saved?.duration ? clamp(saved.currentTime / saved.duration * 100, 0, 100) : 0;
    const number = episode.episodeNum || episode.title?.match(/الحلقة\s*(\d+)/)?.[1] || index + 1;
    const attrs = sheet ? 'data-sheet="episode"' : 'data-action="episode"';
    return `<button class="episode-card ${sheet ? 'sheet-episode-btn' : ''} ${active ? 'active' : ''}" ${attrs} data-url="${escapeHtml(episode.url)}" ${active ? 'aria-current="true"' : ''}>
      <span class="episode-art">${artwork ? imageTag(artwork, '', '', false) : '<i class="fa-solid fa-film"></i>'}<span class="episode-play"><i class="fa-solid ${active ? 'fa-volume-high' : 'fa-play'}"></i></span>${progress ? `<span class="episode-progress" style="width:${progress}%"></span>` : ''}</span>
      <span class="episode-copy"><small>${active ? 'تشاهد الآن' : saved?.currentTime > 10 ? 'متابعة' : ''}</small><strong>${escapeHtml(episode.title || `الحلقة ${number}`)}</strong><span>${saved?.currentTime > 10 ? `وصلت إلى ${formatTime(saved.currentTime)}` : ''}</span></span>
      <span class="episode-number">${escapeHtml(number)}</span></button>`;
  }
  function renderDrawerEpisodes() {
    const query = $('drawerEpisodeSearch')?.value.trim() || '';
    const list = state.currentSeriesEpisodes.filter(ep => String(ep.season || '1') === drawerSeason && (!query || `${ep.title} ${ep.episodeNum}`.includes(query)));
    drawerCount.textContent = `${state.currentSeriesEpisodes.length} حلقة`;
    drawerEpisodesCarousel.innerHTML = list.map((ep,i) => episodeCard(ep,i,state.currentEpisode?.artwork || seriesContext?.poster || '',state.currentEpisode?.url)).join('') || '<p class="empty-note">لا توجد حلقات مطابقة.</p>';
  }

  function refreshFavState() {
    if (!state.currentEpisode) return;
    const isFavorite = state.favorites.some(
      (item) => item.url === state.currentEpisode.url
    );
    playerFavBtn.setAttribute('aria-pressed',String(isFavorite));
    playerFavBtn.innerHTML = isFavorite
      ? '<i class="fa-solid fa-heart" style="color:var(--accent)"></i>'
      : '<i class="fa-regular fa-heart"></i>';
  }

  function toggleFavorite() {
    if (!state.currentEpisode) return;
    const episode = state.currentEpisode;
    const index = state.favorites.findIndex((item) => item.url === episode.url);

    if (index >= 0) {
      state.favorites.splice(index, 1);
    } else {
      state.favorites.unshift({
        title: episode.title,
        url: episode.url,
        thumbnail: episode.artwork || '',
      });
      if (state.favorites.length > 100) state.favorites.length = 100;
    }

    writeJSON(FAVS_KEY, state.favorites);
    refreshFavState();
    if (state.activeTab === 'library') renderLibrary();
  }

  function showPill(iconClass, text) {
    swipeIcon.className = `fa-solid ${iconClass}`;
    swipeValue.textContent = text;
    swipeIndicator.classList.remove('hidden');
    clearTimeout(state.pillTimer);
    state.pillTimer = setTimeout(() => swipeIndicator.classList.add('hidden'), 900);
  }

  function togglePlay() {
    if (nativePlayer.paused) nativePlayer.play().catch(() => {});
    else nativePlayer.pause();
  }

  function seekRelative(seconds) {
    if (!nativePlayer.duration) return;
    nativePlayer.currentTime = clamp(
      nativePlayer.currentTime + seconds,
      0,
      nativePlayer.duration
    );
    resetHudTimer();
  }

  function triggerRipple(element) {
    element.classList.add('active');
    setTimeout(() => element.classList.remove('active'), 500);
  }

  function toggleHud() {
    if (playerHudTop.classList.contains('hud-hidden')) showHud();
    else hideHud();
  }

  function showHud(autoHide = true) {
    playerHudTop.classList.remove('hud-hidden');
    playerHudBottom.classList.remove('hud-hidden');
    hudCenter.classList.toggle(
      'hud-hidden',
      mobilePlayer.classList.contains('embed-mode')
    );
    if (autoHide) resetHudTimer();
  }

  function hideHud() {
    if (!mobilePlayer.classList.contains('embed-mode') && nativePlayer.paused) return;
    if(window.OtiumDisplay?.isTV() && mobilePlayer.contains(document.activeElement)) playerCanvas.focus({preventScroll:true});
    playerHudTop.classList.add('hud-hidden');
    playerHudBottom.classList.add('hud-hidden');
    hudCenter.classList.add('hud-hidden');
  }

  function resetHudTimer() {
    clearTimeout(state.hudTimeout);
    state.hudTimeout = setTimeout(hideHud, 3200);
  }

  /* ------------------------------------------------------------------ */
  /*  Player gestures and controls                                       */
  /* ------------------------------------------------------------------ */

  function setupPlayerTouch() {
    $('toggleSubtitlesBtn').addEventListener('click', () => {
      const tracks=Array.from(nativePlayer.textTracks); const visible=tracks.some(t=>t.mode==='showing');
      tracks.forEach(t=>t.mode='disabled');
      if (!visible && tracks.length) (tracks.find(t=>t.language==='ar') || tracks[0]).mode='showing';
      showPill('fa-closed-captioning',visible?'الترجمة متوقفة':'الترجمة مفعّلة');
    });
    dismissPlayerBtn.addEventListener('click', () => {
      haptic();
      closePlayer();
    });

    let touchStartX = 0;
    let touchStartY = 0;
    let longPressTimer = null;
    let is2xActive = false;
    let isVerticalSwipe = false;
    let swipeTarget = null;
    let startVal = 1;
    let lastTapTime = 0;

    gesturesLayer.addEventListener(
      'touchstart',
      (event) => {
        if (event.touches.length !== 1) return;
        if (mobilePlayer.classList.contains('embed-mode')) return;

        const touch = event.touches[0];
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;
        isVerticalSwipe = false;
        is2xActive = false;

        const rect = gesturesLayer.getBoundingClientRect();
        const xPos = touch.clientX - rect.left;
        swipeTarget = xPos < rect.width / 2 ? 'brightness' : 'volume';
        startVal =
          swipeTarget === 'brightness' ? state.brightness : nativePlayer.volume;

        clearTimeout(longPressTimer);
        longPressTimer = setTimeout(() => {
          if (!nativePlayer.paused && !isVerticalSwipe) {
            is2xActive = true;
            haptic('double');
            nativePlayer.playbackRate = 2;
            speed2xPill.classList.remove('hidden');
          }
        }, 320);
      },
      { passive: true }
    );

    gesturesLayer.addEventListener(
      'touchmove',
      (event) => {
        if (event.touches.length !== 1) return;
        const touch = event.touches[0];
        const dx = touch.clientX - touchStartX;
        const dy = touch.clientY - touchStartY;

        if (Math.abs(dx) > 12 || Math.abs(dy) > 12) clearTimeout(longPressTimer);

        if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
          isVerticalSwipe = true;
          const delta = -dy / 140;
          const newValue = clamp(startVal + delta, 0.1, 1);

          if (swipeTarget === 'brightness') {
            state.brightness = newValue;
            brightnessFilter.style.setProperty(
              '--brightness-darkness',
              (1 - newValue) * 0.85
            );
            showPill('fa-sun', `${Math.round(newValue * 100)}%`);
          } else {
            nativePlayer.volume = newValue;
            const icon =
              newValue === 0
                ? 'fa-volume-xmark'
                : newValue < 0.5
                  ? 'fa-volume-low'
                  : 'fa-volume-high';
            showPill(icon, `${Math.round(newValue * 100)}%`);
          }
        }
      },
      { passive: true }
    );

    gesturesLayer.addEventListener('touchend', () => {
      clearTimeout(longPressTimer);

      if (is2xActive) {
        is2xActive = false;
        haptic();
        nativePlayer.playbackRate = 1;
        speed2xPill.classList.add('hidden');
        return;
      }

      if (isVerticalSwipe) {
        isVerticalSwipe = false;
        clearTimeout(state.pillTimer);
        state.pillTimer = setTimeout(
          () => swipeIndicator.classList.add('hidden'),
          450
        );
        return;
      }

      const now = Date.now();
      const tapLength = now - lastTapTime;
      const rect = gesturesLayer.getBoundingClientRect();
      const isLeftHalf = touchStartX - rect.left < rect.width / 2;

      if (tapLength > 0 && tapLength < 300) {
        haptic('double');
        if (isLeftHalf) {
          seekRelative(-10);
          triggerRipple(rippleLeft);
        } else {
          seekRelative(10);
          triggerRipple(rippleRight);
        }
      } else {
        toggleHud();
      }
      lastTapTime = now;
    });

    centerPlay.addEventListener('click', () => {
      haptic();
      togglePlay();
    });
    centerRewind.addEventListener('click', () => {
      haptic();
      seekRelative(-10);
    });
    centerForward.addEventListener('click', () => {
      haptic();
      seekRelative(10);
    });

    skipIntroBtn.addEventListener('click', () => {
      haptic('heavy');
      if (nativePlayer.duration) {
        nativePlayer.currentTime = Math.min(
          nativePlayer.duration,
          nativePlayer.currentTime + 85
        );
      }
      skipIntroBtn.classList.add('hidden');
      state.skipIntroVisible = false;
    });

    autoNextPlayBtn.addEventListener('click', () => {
      haptic();
      playNextEpisodeNow();
    });
    autoNextCancelBtn.addEventListener('click', () => {
      haptic();
      state.autoNextCancelled = true;
      autoNextCard.classList.add('hidden');
      clearTimeout(state.autoNextTimerId);
      state.autoNextTimerId = null;
    });

    timelineBar.addEventListener('keydown', event => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault();event.stopPropagation();
      if (event.key==='Home') nativePlayer.currentTime=0;
      else if(event.key==='End' && Number.isFinite(nativePlayer.duration)) nativePlayer.currentTime=nativePlayer.duration;
      else seekRelative(event.key==='ArrowLeft'?10:-10);
    });
    timelineBar.addEventListener('click', (event) => {
      if (!nativePlayer.duration) return;
      haptic();
      const rect = timelineBar.getBoundingClientRect();
      const position = clamp((rect.right - event.clientX) / rect.width, 0, 1);
      nativePlayer.currentTime = position * nativePlayer.duration;
      resetHudTimer();
    });

    nativePlayer.addEventListener('timeupdate', onTimeUpdate);
    nativePlayer.addEventListener('progress', onProgress);

    nativePlayer.addEventListener('play', () => {
      centerPlay.innerHTML = '<i class="fa-solid fa-pause"></i>';
      resetHudTimer();
      bridge('setVideoPlaying', true);
    });

    nativePlayer.addEventListener('pause', () => {
      centerPlay.innerHTML = '<i class="fa-solid fa-play"></i>';
      showHud(false);
      bridge('setVideoPlaying', false);
    });

    nativePlayer.addEventListener('waiting', () => {
      if (mobilePlayer.classList.contains('embed-mode')) return;
      resetSpinner();
      playerSpinner.classList.remove('hidden');
    });

    nativePlayer.addEventListener('playing', () => {
      if (mobilePlayer.classList.contains('hidden') || mobilePlayer.classList.contains('embed-mode') || !nativePlayer.getAttribute('src')) return;
      playerSpinner.classList.add('hidden');
      nativePlayer.classList.remove('hidden');
      mobilePlayer.classList.remove('player-loading');
      mobilePlayer.classList.add('video-playing');
    });

    nativePlayer.addEventListener('ended', () => {
      saveHistory(true);
      checkAutoNext();
      showHud(false);
    });

    $('openEpisodesSheetBtn').addEventListener('click',()=>{
      const episodes=state.currentSeriesEpisodes;
      openSheet('الحلقات',`<div class="episode-card-list episode-select-list">${episodes.map((ep,i)=>episodeCard(ep,i,state.currentEpisode?.artwork || '',state.currentEpisode?.url,true)).join('') || '<p class="empty-note">لا توجد حلقات لهذا العمل.</p>'}</div>`);
    });
    openServersSheetBtn.addEventListener('click', () => {
      haptic();
      openServersSheet();
    });
    drawerOpenServersBtn?.addEventListener('click', () => {
      haptic();
      openServersSheet();
    });
    openQualitySheetBtn.addEventListener('click', () => {
      haptic();
      openQualitySheet();
    });

    togglePipBtn.addEventListener('click', () => {
      haptic();
      if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => {});
      } else if (nativePlayer.requestPictureInPicture) {
        nativePlayer.requestPictureInPicture().catch(() => {});
      }
    });

    toggleFullscreenBtn.addEventListener('click', () => {
      haptic();
      if (!document.fullscreenElement) {
        const request =
          $('appFrame').requestFullscreen || $('appFrame').webkitRequestFullscreen;
        request?.call($('appFrame'))?.catch?.(() => {});
        bridge('setLandscape', true);
      } else {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        exit?.call(document)?.catch?.(() => {});
        bridge('setLandscape', false);
      }
    });

    const onFullscreenChange = () => {
      const isFull = Boolean(
        document.fullscreenElement || document.webkitFullscreenElement
      );
      toggleFullscreenBtn.innerHTML = isFull
        ? '<i class="fa-solid fa-compress"></i>'
        : '<i class="fa-solid fa-expand"></i>';
      bridge('setLandscape', isFull);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);

    playerFavBtn.addEventListener('click', () => {
      haptic('heavy');
      toggleFavorite();
    });

    // Desktop / TV keyboard shortcuts. Cheap to keep and useful on web.
    document.addEventListener('keydown', (event) => {
      if (mobilePlayer.classList.contains('hidden')) return;
      if (event.target.matches('input, textarea, select') || !sheetBackdrop.classList.contains('hidden')) return;
      if(window.OtiumDisplay?.isTV() && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Enter',' '].includes(event.key)) return;

      switch (event.key) {
        case ' ':
          event.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          event.preventDefault();
          seekRelative(-10);
          break;
        case 'ArrowRight':
          event.preventDefault();
          seekRelative(10);
          break;
        case 'f':
        case 'F':
          toggleFullscreenBtn.click();
          break;
        case 'Escape':
          if (!document.fullscreenElement) closePlayer();
          break;
        default:
          break;
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Bottom sheet                                                       */
  /* ------------------------------------------------------------------ */

  let sheetReturnFocus = null;
  function setupBottomSheet() {
    sheetBackdrop.addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeSheet();return;}
      const row=event.target.closest('[data-sheet]');
      if((event.key==='Enter'||event.key===' ') && row && row.tagName!=='BUTTON'){event.preventDefault();row.click();return;}
      if(event.key!=='Tab')return;
      const focusable=[...sheetBackdrop.querySelectorAll('button,input,[tabindex="0"]')].filter(el=>el.getClientRects().length&&!el.disabled);
      const first=focusable[0],last=focusable[focusable.length-1];
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    });
    playerSpinner.addEventListener('click', (event) => {
      if (event.target.closest('[data-player-source]')) { closePlayer(); document.querySelector('[data-source="krmzi"]').click(); }
      if (event.target.closest('[data-player-retry]')) openEpisode(activeEpisodeUrl, true);
      if (event.target.closest('[data-player-servers]')) openServersSheet();
    });
    closeSheetBtn.addEventListener('click', () => {
      haptic();
      closeSheet();
    });

    sheetBackdrop.addEventListener('click', (event) => {
      if (event.target === sheetBackdrop) {
        haptic();
        closeSheet();
      }
    });

    sheetBody.addEventListener('click', (event) => {
      const row = event.target.closest('[data-sheet]');
      if (!row) return;
      haptic();
      const kind = row.dataset.sheet;

      if (kind === 'episode') {
        const url = row.dataset.url;
        closeSheet();
        openEpisode(url);
        return;
      }

      const episode = state.currentEpisode;
      if (!episode) return;

      if (kind === 'server-direct') {
        playDirectStream(episode.directStreams || []);
        closeSheet();
      } else if (kind === 'server-embed') {
        const index = Number(row.dataset.index);
        if (episode.servers?.[index]) playSandboxedEmbed(episode.servers[index]);
        closeSheet();
      } else if (kind === 'quality') {
        const index = Number(row.dataset.index);
        const stream = episode.directStreams?.[index];
        if (stream) switchStreamQuality(stream.url, stream.quality);
        closeSheet();
      } else if (kind === 'quality-auto') {
        state.qualityMode = 'auto';
        try { localStorage.setItem('krmzi_quality_mode', 'auto'); } catch (_) {}
        const streams = episode.directStreams || [];
        if (hlsPlayer) {
          hlsPlayer.nextLevel = -1;
          activeQualityLabel.textContent = 'تلقائي';
        } else playDirectStream(streams, initialStreamIndex(streams), { resumeAt: nativePlayer.currentTime || 0, paused: nativePlayer.paused });
        closeSheet();
      }
    });
  }

  function openSheet(title, itemsHtml) {
    if(sheetBackdrop.classList.contains('hidden')) sheetReturnFocus=document.activeElement;
    state.sheetToken += 1;
    sheetTitle.textContent = title;
    sheetBody.innerHTML = itemsHtml;
    sheetBody.scrollTop = 0;
    sheetBackdrop.classList.remove('hidden');
    closeSheetBtn.focus({preventScroll:true});
  }

  function closeSheet() {
    state.sheetToken += 1;
    sheetBackdrop.classList.add('hidden');
    sheetBody.innerHTML = '';
    if(sheetReturnFocus?.isConnected) sheetReturnFocus.focus({preventScroll:true});
  }

  function openServersSheet() {
    const episode = state.currentEpisode;
    if (!episode) return;

    let itemsHtml = '';

    if (episode.directStreams?.length) {
      const isActive = state.activeServer?.name?.includes('مباشر');
      itemsHtml += `
        <div class="sheet-row ${isActive ? 'active' : ''}" data-sheet="server-direct" role="button" tabindex="0">
          <span><i class="fa-solid fa-bolt" style="color:#10b981"></i> المشغل المباشر</span>
          <span class="sheet-pill direct">${isActive ? 'الحالي' : '1080p'}</span>
        </div>`;
    }

    (episode.servers || []).forEach((server, index) => {
      if (
        server.name &&
        (server.name.includes('مباشر') || server.name.toLowerCase() === 'ok') &&
        episode.directStreams?.length
      ) {
        return;
      }
      const isActive = state.activeServer?.name === server.name;
      itemsHtml += `
        <div class="sheet-row ${isActive ? 'active' : ''}" data-sheet="server-embed" data-index="${index}" role="button" tabindex="0">
          <span><i class="fa-solid fa-server"></i> سيرفر ${escapeHtml(server.name || '')}</span>
          <span class="sheet-pill ${isActive ? 'direct' : ''}">${isActive ? 'الحالي' : 'تشغيل'}</span>
        </div>`;
    });

    openSheet('سيرفرات المشاهدة', itemsHtml);
  }

  function openQualitySheet() {
    const streams = state.currentEpisode?.directStreams;
    if (!streams?.length) {
      openSheet(
        'دقة العرض',
        '<p class="empty-note">الجودة تلقائية وتتكيف مع سرعة اتصالك على هذا السيرفر.</p>'
      );
      return;
    }

    const itemsHtml = `<button class="sheet-row ${state.qualityMode === 'auto' ? 'active' : ''}" data-sheet="quality-auto"><span>تلقائي</span>${state.qualityMode === 'auto' ? '<i class="fa-solid fa-check"></i>' : ''}</button>` + streams
      .map((stream, index) => {
        if (stream.type === 'hls') return '';
        const isActive = state.qualityMode === 'manual' && state.activeQuality?.quality === stream.quality;
        return `
          <div class="sheet-row ${isActive ? 'active' : ''}" data-sheet="quality" data-index="${index}" role="button" tabindex="0">
            <span>${escapeHtml(stream.quality)}</span>
            ${isActive ? '<i class="fa-solid fa-check"></i>' : ''}
          </div>`;
      })
      .join('');

    openSheet('اختيار الدقة', itemsHtml);
  }

  async function openSeriesByUrl(url) {
    if (!url) return;
    openSheet('جاري التحميل...', '<div class="spinner-ring" style="margin:20px auto"></div>');
    const token = state.sheetToken;

    try {
      const series = await apiCall(
        '/api/series/detail',
        { url },
        { cacheTtl: API_TTL['/api/series/detail'] }
      );
      if (token !== state.sheetToken) return;

      seriesContext = series;
      const episodes = Array.isArray(series.episodes) ? series.episodes.slice(0, 300) : [];
      const seasons = [...new Set(episodes.map(ep => String(ep.season || '1')))];
      const itemsHtml = `
        <div class="series-detail-hero">
          ${imageTag(series.poster || series.thumbnail, series.title, 'series-detail-art', true)}
          <div class="series-detail-shade"></div><div class="series-detail-info"><span class="series-source-tag">${window.OtiumCinemana?.owns(url) ? 'سينمانا' : 'قرمزي'}</span><h4>${escapeHtml(series.title)}</h4><div class="series-detail-meta">${series.year ? `<span>${escapeHtml(series.year)}</span>` : ''}<span>${episodes.length} حلقة</span><span>${seasons.length} موسم</span></div></div>
        </div>
        <p class="series-detail-story">${escapeHtml(series.story || '')}</p>
        <div class="series-episode-heading"><h5>الحلقات</h5><span></span></div>
        <div class="season-tabs" id="sheetSeasonTabs">${seasons.map((season,i)=>`<button class="season-tab ${i===0?'active':''}" data-sheet-season="${escapeHtml(season)}">الموسم ${escapeHtml(season)}</button>`).join('')}</div>
        <label class="episode-search"><i class="fa-solid fa-magnifying-glass"></i><input id="sheetEpisodeSearch" type="search" placeholder="ابحث عن رقم أو عنوان الحلقة" aria-label="ابحث عن حلقة"></label>
        <div class="sheet-episode-grid episode-card-list" id="seriesEpisodeList">${episodes.map((ep,i)=>episodeCard(ep,i,series.poster || series.thumbnail,'',true)).join('') || '<p class="empty-note">الحلقات غير متاحة حالياً. حاول مجدداً لاحقاً.</p>'}</div>`;

      openSheet('تفاصيل العمل', itemsHtml);
      let season = seasons[0] || '1';
      const renderList = () => {
        const query = $('sheetEpisodeSearch').value.trim();
        const list = episodes.filter(ep => String(ep.season || '1') === season && (!query || `${ep.title} ${ep.episodeNum}`.includes(query)));
        $('seriesEpisodeList').innerHTML = list.map((ep,i)=>episodeCard(ep,i,series.poster || series.thumbnail,'',true)).join('') || '<p class="empty-note">لا توجد حلقات مطابقة.</p>';
      };
      $('sheetEpisodeSearch').addEventListener('input', renderList);
      $('sheetSeasonTabs').addEventListener('click', event => {
        const button = event.target.closest('[data-sheet-season]'); if (!button) return;
        season = button.dataset.sheetSeason;
        $('sheetSeasonTabs').querySelectorAll('button').forEach(item => item.classList.toggle('active', item === button));
        renderList();
      });
      renderList();
    } catch (error) {
      if (token !== state.sheetToken) return;
      console.warn('Series detail failed:', error);
      openSheet('خطأ', '<p class="empty-note">تعذر جلب الحلقات.</p>');
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Navigation, pull-to-refresh and filters                            */
  /* ------------------------------------------------------------------ */

  function setupNavigation() {
    document.querySelectorAll('[data-source]').forEach(item=>{const active=item.dataset.source===state.source;item.classList.toggle('active',active);item.setAttribute('aria-pressed',String(active));});
    document.querySelectorAll('[data-source]').forEach(button => button.addEventListener('click', async () => {
      if (state.loadingHome || state.source === button.dataset.source) return;
      try { localStorage.setItem('otium_source', button.dataset.source); } catch (_) {}
      state.searchAbort?.abort();
      state.source = button.dataset.source;
      document.querySelectorAll('[data-source]').forEach(item => { const active=item===button; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)); });
      $('sourceNetworkNote').classList.add('hidden');
      $('sourceStatus').textContent = 'جاري الاتصال…';
      state.episodes=[]; state.series=[]; state.filteredSeries=[];
      apiCache.clear();
      switchTab('home');
      await loadData(true);
    }));
    $('drawerEpisodeSearch').addEventListener('input', renderDrawerEpisodes);
    $('drawerSeasonTabs').addEventListener('click', event => {
      const button=event.target.closest('[data-drawer-season]'); if (!button) return;
      drawerSeason=button.dataset.drawerSeason;
      $('drawerSeasonTabs').querySelectorAll('button').forEach(item=>item.classList.toggle('active',item===button));
      renderDrawerEpisodes();
    });
    brandBtn.addEventListener('click', () => {
      haptic();
      switchTab('home');
    });

    dockBtns.forEach((button) => {
      button.addEventListener('click', () => {
        haptic();
        switchTab(button.dataset.tab);
      });
    });

    segmentBtns.forEach((button) => {
      button.addEventListener('click', () => {
        haptic();
        segmentBtns.forEach((item) => item.classList.remove('active'));
        button.classList.add('active');
        state.librarySubtab = button.dataset.subtab;
        renderLibrary();
      });
    });

    clearHistoryBtn.addEventListener('click', () => {
      haptic('heavy');
      state.history = [];
      state.historySignature = '';
      try {
        localStorage.removeItem(HIST_KEY);
      } catch {
        /* ignore */
      }
      historySection.classList.add('hidden');
      renderSpotlight(state.episodes[0]);
      if (state.activeTab === 'library') renderLibrary();
    });
  }

  function switchTab(tab) {
    if (tab === 'search') {
      openSearch();
      return;
    }

    state.activeTab = tab;
    dockBtns.forEach((button) => {
      button.classList.toggle('active', button.dataset.tab === tab);
      button.setAttribute('aria-current',button.dataset.tab === tab ? 'page' : 'false');
    });

    if (tab === 'home') {
      heroSpotlight.classList.remove('hidden');
      episodesSection.classList.remove('hidden');
      seriesSection.classList.remove('hidden');
      libraryView.classList.add('hidden');
      genreChipsWrap?.classList.remove('hidden');
      renderHistory();
      if (!state.history.length) renderSpotlight(state.episodes[0]);
    } else if (tab === 'series') {
      heroSpotlight.classList.add('hidden');
      episodesSection.classList.add('hidden');
      seriesSection.classList.remove('hidden');
      historySection.classList.add('hidden');
      libraryView.classList.add('hidden');
      genreChipsWrap?.classList.remove('hidden');
    } else if (tab === 'library') {
      heroSpotlight.classList.add('hidden');
      episodesSection.classList.add('hidden');
      seriesSection.classList.add('hidden');
      historySection.classList.add('hidden');
      libraryView.classList.remove('hidden');
      genreChipsWrap?.classList.add('hidden');
      renderLibrary();
    }

    contentCanvas.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function setupPullToRefresh() {
    let startY = 0;
    let isPulling = false;

    contentCanvas.addEventListener(
      'touchstart',
      (event) => {
        if (state.refreshing || state.activeTab === 'search') return;
        if (contentCanvas.scrollTop <= 0) {
          startY = event.touches[0].clientY;
          isPulling = true;
        }
      },
      { passive: true }
    );

    contentCanvas.addEventListener(
      'touchmove',
      (event) => {
        if (!isPulling || state.refreshing || contentCanvas.scrollTop > 0) return;
        const dy = event.touches[0].clientY - startY;
        pullRefreshIndicator.classList.toggle('visible', dy > 55);
      },
      { passive: true }
    );

    contentCanvas.addEventListener('touchend', async () => {
      if (!isPulling) return;
      isPulling = false;
      if (!pullRefreshIndicator.classList.contains('visible') || state.refreshing) {
        pullRefreshIndicator.classList.remove('visible');
        return;
      }
      state.refreshing = true;
      haptic('heavy');
      await loadData(true);
      state.refreshing = false;
      setTimeout(() => pullRefreshIndicator.classList.remove('visible'), 350);
    });
  }

  function setupGenreFilter() {
    genrePills.forEach((pill) => {
      pill.addEventListener('click', () => {
        haptic();
        genrePills.forEach((item) => item.classList.remove('active'));
        pill.classList.add('active');
        genrePills.forEach(item=>item.setAttribute('aria-pressed',String(item===pill)));
        state.activeFilter = pill.dataset.filter || 'all';
        applyGenreFilter();
      });
    });
  }

  function applyGenreFilter() {
    state.filteredSeries = filterSeries(state.series, state.activeFilter);
    renderSeriesGrid(state.filteredSeries);
  }

  /* ------------------------------------------------------------------ */
  /*  Global delegated events                                            */
  /* ------------------------------------------------------------------ */

  function setupGlobalEvents() {
    document.addEventListener('click', (event) => {
      const target = event.target.closest?.('[data-action]');
      if (!target) return;

      const action = target.dataset.action;
      const url = target.dataset.url;
      if (!url) return;

      if (action === 'episode') {
        haptic();
        openEpisode(url);
      } else if (action === 'series') {
        haptic();
        openSeriesByUrl(url);
      } else if (action === 'search-result') {
        haptic();
        closeSearch(true);
        if (target.dataset.type === 'series') openSeriesByUrl(url);
        else openEpisode(url);
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const target = event.target.closest?.('[data-action]');
      if (!target) return;
      event.preventDefault();
      target.click();
    });

    document.addEventListener(
      'error',
      (event) => {
        if (event.target?.tagName === 'IMG') {
          event.target.classList.add('img-broken');
        }
      },
      true
    );

    window.addEventListener('online', () => {
      if (state.episodes.length === 0 && state.series.length === 0) loadData(true);
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) saveHistory(true);
    });

    window.addEventListener('pagehide', () => saveHistory(true));
    window.addEventListener('beforeunload', () => saveHistory(true));

    // Exposed for the native back button so it can close the UI through the
    // same code path as a tap (keeping state in sync).
    window.krmziCloseSearch = () => closeSearch(true);
    window.krmziCloseSheet = () => closeSheet();
    window.krmziClosePlayer = () => closePlayer();
    window.krmziIsPlayerOpen = () => !mobilePlayer.classList.contains('hidden');
    window.krmziIsSheetOpen = () => !sheetBackdrop.classList.contains('hidden');
    window.krmziIsSearchOpen = () => !searchOverlay.classList.contains('hidden');
  }

  /* ------------------------------------------------------------------ */
  /*  In-app update system                                               */
  /* ------------------------------------------------------------------ */

  function isNewerVersion(current, latest) {
    if (!latest) return false;
    const currentParts = String(current)
      .replace(/^v/, '')
      .split('.')
      .map((part) => parseInt(part, 10) || 0);
    const latestParts = String(latest)
      .replace(/^v/, '')
      .split('.')
      .map((part) => parseInt(part, 10) || 0);
    const length = Math.max(currentParts.length, latestParts.length);
    for (let index = 0; index < length; index += 1) {
      const currentPart = currentParts[index] || 0;
      const latestPart = latestParts[index] || 0;
      if (latestPart > currentPart) return true;
      if (latestPart < currentPart) return false;
    }
    return false;
  }

  function setManualCheckState(stateName) {
    if (!manualCheckUpdateBtn) return;
    if (stateName === 'checking') {
      checkUpdateIcon?.classList.add('fa-spin');
      if (checkUpdateBtnText) checkUpdateBtnText.textContent = 'جاري التحقق...';
      manualCheckUpdateBtn.disabled = true;
    } else if (stateName === 'success') {
      manualCheckUpdateBtn.classList.add('success');
      if (checkUpdateIcon) checkUpdateIcon.className = 'fa-solid fa-check';
      if (checkUpdateBtnText) {
        checkUpdateBtnText.textContent = `أنت على أحدث إصدار (v${state.currentVersion}) ✓`;
      }
      setTimeout(() => setManualCheckState('idle'), 3500);
    } else if (stateName === 'error') {
      manualCheckUpdateBtn.classList.remove('success');
      if (checkUpdateIcon) checkUpdateIcon.className = 'fa-solid fa-triangle-exclamation';
      if (checkUpdateBtnText) checkUpdateBtnText.textContent = 'تعذر التحقق من التحديثات';
      setTimeout(() => setManualCheckState('idle'), 3000);
    } else {
      manualCheckUpdateBtn.disabled = false;
      manualCheckUpdateBtn.classList.remove('success');
      if (checkUpdateIcon) checkUpdateIcon.className = 'fa-solid fa-arrows-rotate';
      if (checkUpdateBtnText) checkUpdateBtnText.textContent = 'التحقق من التحديثات';
    }
  }

  async function checkForUpdates(isManual = false) {
    if (state.updateChecking) return;
    state.updateChecking = true;
    if (isManual) setManualCheckState('checking');

    let updateInfo = null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const response = await fetch(GITHUB_RELEASES, {
        signal: controller.signal,
        headers: { Accept: 'application/vnd.github+json' },
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const json = await response.json();
      const tag = String(json.tag_name || '').replace(/^v/, '').trim();
      let apkUrl = '';
      if (Array.isArray(json.assets)) {
        const apkAsset = json.assets.find(
          (asset) => asset?.name && asset.name.toLowerCase().endsWith('.apk')
        );
        if (apkAsset) apkUrl = apkAsset.browser_download_url || '';
      }
      if (!apkUrl) {
        apkUrl = json.html_url || 'https://github.com/XRTM8/krmzi-app/releases/latest';
      }

      updateInfo = {
        hasUpdate: isNewerVersion(state.currentVersion, tag),
        currentVersion: state.currentVersion,
        latestVersion: tag,
        releaseName: json.name || 'تحديث جديد',
        changelog: json.body || '',
        downloadUrl: apkUrl,
        isSuccess: true,
      };
    } catch (error) {
      console.warn('Update check failed:', error);
    } finally {
      clearTimeout(timeout);
      state.updateChecking = false;
      if (isManual) setManualCheckState('idle');
    }

    if (updateInfo?.hasUpdate) {
      if (isManual) {
        openUpdateModal(updateInfo);
      } else {
        let lastDismissed = 0;
        try {
          lastDismissed = parseInt(
            localStorage.getItem(UPDATE_DISMISSED_KEY) || '0',
            10
          );
        } catch {
          lastDismissed = 0;
        }
        if (Date.now() - lastDismissed > 24 * 60 * 60 * 1000) {
          openUpdateModal(updateInfo);
        }
      }
    } else if (isManual) {
      if (updateInfo) setManualCheckState('success');
      else setManualCheckState('error');
      haptic('double');
    }
  }

  function openUpdateModal(info) {
    state.pendingUpdate = info;
    if (updateModalTitle) {
      updateModalTitle.textContent = info.releaseName || 'تحديث جديد متوفر!';
    }
    if (updateModalVersion) {
      updateModalVersion.textContent = `الإصدار v${info.latestVersion || ''}`;
    }
    if (updateChangelog) {
      let notes =
        info.changelog ||
        'تحسينات عامة في الأداء وثبات التطبيق وإصلاحات لمشغل الفيديو.';
      notes = notes.replace(/#{1,6}\s+/g, '').trim();
      updateChangelog.textContent = notes;
    }
    updateModalScrim?.classList.remove('hidden');
    haptic('double');
  }

  function closeUpdateModal() {
    updateModalScrim?.classList.add('hidden');
    try {
      localStorage.setItem(UPDATE_DISMISSED_KEY, Date.now().toString());
    } catch {
      /* ignore quota errors */
    }
  }

  function setupUpdateSystem() {
    const versionRaw = bridge('getAppVersion');
    if (versionRaw) {
      try {
        const versionData = JSON.parse(versionRaw);
        if (versionData?.versionName) {
          state.currentVersion = String(versionData.versionName).replace(/^v/, '');
        }
      } catch {
        /* keep bundled version */
      }
    }

    if (installedVersionText) {
      installedVersionText.textContent = `v${state.currentVersion}`;
    }

    manualCheckUpdateBtn?.addEventListener('click', () => {
      haptic();
      checkForUpdates(true);
    });

    confirmUpdateBtn?.addEventListener('click', () => {
      haptic('heavy');
      const url = state.pendingUpdate?.downloadUrl;
      if (url) {
        const opened = bridge('openDownloadUrl', url);
        if (opened == null) window.open(url, '_blank', 'noopener');
      }
      closeUpdateModal();
    });

    dismissUpdateBtn?.addEventListener('click', () => {
      haptic();
      closeUpdateModal();
    });

    updateModalScrim?.addEventListener('click', (event) => {
      if (event.target === updateModalScrim) closeUpdateModal();
    });

    // Never compete with the first paint. The check runs when the browser is
    // idle, and a manual tap still works immediately.
    const schedule = () => checkForUpdates(false);
    if ('requestIdleCallback' in window) {
      requestIdleCallback(schedule, { timeout: 6000 });
    } else {
      setTimeout(schedule, 4000);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Service worker (web / PWA only)                                    */
  /* ------------------------------------------------------------------ */

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    if (location.hostname === 'appassets.androidplatform.net') return;

    window.addEventListener(
      'load',
      () => {
        navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
      },
      { once: true }
    );
  }

  /* ------------------------------------------------------------------ */
  /*  Boot                                                               */
  /* ------------------------------------------------------------------ */

  function init() {
    setupNavigation();
    setupPullToRefresh();
    setupGenreFilter();
    setupSearch();
    setupPlayerTouch();
    setupBottomSheet();
    setupUpdateSystem();
    setupGlobalEvents();

    renderHistory();
    loadData();
    registerServiceWorker();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
