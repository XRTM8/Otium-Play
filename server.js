'use strict';

/**
 * KRMZI PRO - High-performance scraping API
 *
 * Performance model:
 *  - native fetch (HTTP keep-alive + automatic brotli/gzip decompression)
 *  - bounded TTL cache with stale-while-revalidate and stale-if-error
 *  - in-flight request coalescing (one upstream fetch per key, even under load)
 *  - parallel server/stream resolution
 *  - compression + immutable static asset caching
 */

const express = require('express');
const compression = require('compression');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const ORIGIN = 'https://krmzi.org';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const appStartedAt = Date.now();

app.disable('x-powered-by');
app.set('trust proxy', true);
app.set('etag', 'strong');

app.use(
  compression({
    threshold: 1024,
    level: 6,
    memLevel: 8,
    filter: (req, res) => {
      if (req.headers['x-no-compression']) return false;
      return compression.filter(req, res);
    },
  })
);

app.use(
  cors({
    origin: true,
    methods: ['GET', 'OPTIONS'],
    maxAge: 86400,
  })
);

// The API is read-only; keep the body parser tiny so a malformed request can
// never allocate unbounded memory.
app.use(express.json({ limit: '16kb' }));

/* -------------------------------------------------------------------------- */
/*  Cache                                                                     */
/* -------------------------------------------------------------------------- */

class BoundedTtlCache {
  constructor(maxEntries = 600) {
    this.maxEntries = maxEntries;
    this.store = new Map();
  }

  peek(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    // Refresh insertion order for a cheap LRU eviction.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry;
  }

  set(key, data, ttlMs, staleMs) {
    const now = Date.now();
    if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) this.store.delete(oldestKey);
    }
    this.store.set(key, {
      data,
      expiresAt: now + ttlMs,
      staleUntil: now + ttlMs + staleMs,
      createdAt: now,
    });
  }

  delete(key) {
    this.store.delete(key);
  }

  get size() {
    return this.store.size;
  }

  stats() {
    let fresh = 0;
    let stale = 0;
    const now = Date.now();
    for (const entry of this.store.values()) {
      if (entry.expiresAt > now) fresh++;
      else if (entry.staleUntil > now) stale++;
    }
    return { entries: this.store.size, fresh, stale };
  }
}

const cache = new BoundedTtlCache(600);
const inFlight = new Map();

/**
 * Read-through cache with stale-while-revalidate.
 * Concurrent callers for the same key share a single upstream request.
 */
async function cached(key, { ttl, stale = ttl * 4 }, producer) {
  const entry = cache.peek(key);
  const now = Date.now();

  if (entry && entry.expiresAt > now) {
    return { data: entry.data, state: 'HIT' };
  }

  if (entry && entry.staleUntil > now) {
    // Serve instantly, refresh in the background.
    refresh(key, ttl, stale, producer).catch(() => {});
    return { data: entry.data, state: 'STALE' };
  }

  const data = await refresh(key, ttl, stale, producer);
  return { data, state: 'MISS' };
}

function refresh(key, ttl, stale, producer) {
  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = Promise.resolve()
    .then(producer)
    .then((data) => {
      cache.set(key, data, ttl, stale);
      return data;
    })
    .catch((err) => {
      // Stale-if-error: keep the last good payload alive instead of failing.
      const entry = cache.peek(key);
      if (entry) {
        entry.staleUntil = Date.now() + 60_000;
        return entry.data;
      }
      throw err;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, promise);
  return promise;
}

function sendCached(res, result, maxAgeSeconds, staleSeconds) {
  res.setHeader(
    'Cache-Control',
    `public, max-age=${maxAgeSeconds}, stale-while-revalidate=${staleSeconds}`
  );
  res.setHeader('X-Cache', result.state);
  res.json(result.data);
}

/* -------------------------------------------------------------------------- */
/*  Upstream helpers                                                          */
/* -------------------------------------------------------------------------- */

const HTML_HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
  Referer: `${ORIGIN}/`,
};

async function fetchText(url, { timeout = 12_000, headers = HTML_HEADERS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: controller.signal,
      // Native fetch (undici) keeps connections alive and transparently
      // decodes gzip/br, unlike the previous http.get implementation.
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return await response.text();
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeout}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function isKrmziUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    return url.hostname === 'krmzi.org' || url.hostname === 'www.krmzi.org';
  } catch {
    return false;
  }
}

function safeKrmziUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!isKrmziUrl(trimmed)) return null;
  const url = new URL(trimmed);
  url.hash = '';
  return url.toString();
}

/** Unwrap ad-shortener URLs such as sayyarh.com?url=aHR0cHM6... */
function extractRealUrl(rawUrl) {
  if (!rawUrl) return '';
  if (rawUrl.includes('krmzi.org/episode/')) return rawUrl;

  const match = rawUrl.match(/[?&](?:url|link|target)=([^&]+)/);
  if (match) {
    let value = match[1];
    try {
      value = decodeURIComponent(value);
      if (!value.startsWith('http')) {
        const decoded = Buffer.from(value, 'base64').toString('utf8');
        if (decoded.includes('krmzi.org')) return safeKrmziUrl(decodeURIComponent(decoded)) || rawUrl;
      }
      if (value.includes('krmzi.org')) return safeKrmziUrl(value) || rawUrl;
    } catch {
      /* ignore malformed wrappers */
    }
  }
  return rawUrl;
}

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  ndash: '–',
  mdash: '—',
};

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (full, entity) => {
    if (entity[0] === '#') {
      const code =
        entity[1].toLowerCase() === 'x'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    return ENTITIES[entity.toLowerCase()] ?? full;
  });
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTitle(title) {
  return stripTags(title).replace(/\s*-\s*قرمزي\s*$/, '').trim();
}

function absoluteThumb(raw) {
  if (!raw) return '';
  const value = decodeEntities(raw).trim();
  if (value.startsWith('https://krmzi.org/')) return value;
  if (value.startsWith('/')) return `${ORIGIN}${value}`;
  return value;
}

const BLOCK_REGEX = /<div class="block-post">([\s\S]*?)<\/div>\s*<\/div>/g;
const LINK_REGEX = /<a\s+href="([^"]+)"\s+title="([^"]+)"/;
const EPISODE_NUM_REGEX = /<div class="episodeNum">[\s\S]*?<span>(\d+)<\/span>/;
const THUMB_REGEX = /url\((https:\/\/krmzi\.org\/wp-content\/uploads\/[^)]+)\)/;
const SERIES_LINK_REGEX = /<a\s+href="(https:\/\/krmzi\.org\/series\/[^"]+)"\s+title="([^"]+)"/;

function parseCards(html, kind) {
  const items = [];
  BLOCK_REGEX.lastIndex = 0;
  let blockMatch;
  while ((blockMatch = BLOCK_REGEX.exec(html)) !== null) {
    const block = blockMatch[1];

    let linkMatch;
    if (kind === 'series') {
      linkMatch = block.match(SERIES_LINK_REGEX);
    } else {
      linkMatch = block.match(LINK_REGEX);
      if (linkMatch && kind === 'search') {
        const candidate = extractRealUrl(linkMatch[1]);
        if (!/\/(?:series|episode)\//.test(candidate)) linkMatch = null;
      }
    }
    if (!linkMatch) continue;

    const itemUrl = extractRealUrl(linkMatch[1]);
    if (!isKrmziUrl(itemUrl)) continue;

    const title = cleanTitle(linkMatch[2]);
    const thumbMatch = block.match(THUMB_REGEX);
    const thumbnail = thumbMatch ? absoluteThumb(thumbMatch[1]) : '';

    if (kind === 'series') {
      items.push({ url: safeKrmziUrl(itemUrl) || itemUrl, title, thumbnail });
      continue;
    }

    const numMatch = block.match(EPISODE_NUM_REGEX);
    const episodeNum = numMatch ? numMatch[1] : '';
    let seriesTitle = title;
    if (episodeNum) {
      seriesTitle = title.replace(new RegExp(`الحلقة\\s*${episodeNum}.*`), '').trim();
    }

    items.push({
      url: safeKrmziUrl(itemUrl) || itemUrl,
      title,
      seriesTitle: seriesTitle || title,
      episodeNum,
      thumbnail,
      type: kind === 'search' ? (itemUrl.includes('/series/') ? 'series' : 'episode') : undefined,
    });
  }
  return items;
}

/* -------------------------------------------------------------------------- */
/*  Scrapers (pure data functions, easy to cache)                             */
/* -------------------------------------------------------------------------- */

async function getEpisodesData(page) {
  const url = page === 1 ? `${ORIGIN}/` : `${ORIGIN}/page/${page}/`;
  const html = await fetchText(url);
  const episodes = parseCards(html, 'episodes');
  const hasNext =
    html.includes(`${ORIGIN}/page/${page + 1}/`) || html.includes(`page/${page + 1}/`);
  return { page, episodes, hasNext };
}

async function getSeriesData(page) {
  const url =
    page === 1 ? `${ORIGIN}/series-list/` : `${ORIGIN}/series-list/page/${page}/`;
  const html = await fetchText(url);
  const series = parseCards(html, 'series');
  const hasNext = html.includes(`series-list/page/${page + 1}/`);
  return { page, series, hasNext };
}

async function getSeriesDetailData(seriesUrl) {
  const html = await fetchText(seriesUrl);

  const titleMatch =
    html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) ||
    html.match(/<div class="title">\s*([^<]+)\s*<\/div>/);
  const title = titleMatch ? stripTags(titleMatch[1]) : '';

  const posterMatch = html.match(THUMB_REGEX);
  const poster = posterMatch ? absoluteThumb(posterMatch[1]) : '';

  const storyMatch =
    html.match(/<div class="story">([\s\S]*?)<\/div>/) ||
    html.match(/<div class="desc">([\s\S]*?)<\/div>/);
  const story = storyMatch ? stripTags(storyMatch[1]) : '';

  const episodes = [];
  const seen = new Set();
  const epRegex = /<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let epMatch;
  while ((epMatch = epRegex.exec(html)) !== null) {
    const epUrl = extractRealUrl(epMatch[1]);
    if (!epUrl.includes('/episode/') || !isKrmziUrl(epUrl) || seen.has(epUrl)) continue;
    seen.add(epUrl);

    const titleClean = stripTags(epMatch[2]);
    const numMatch = epUrl.match(/الحلقة-(\d+)/) || titleClean.match(/(\d+)/);
    episodes.push({
      url: safeKrmziUrl(epUrl) || epUrl,
      title: titleClean || `الحلقة ${numMatch ? numMatch[1] : ''}`,
      episodeNum: numMatch ? numMatch[1] : '',
    });
  }

  episodes.sort(
    (a, b) => (parseInt(a.episodeNum, 10) || 0) - (parseInt(b.episodeNum, 10) || 0)
  );

  return { url: seriesUrl, title, poster, story, episodes };
}

async function getSearchData(query) {
  const searchUrl = `${ORIGIN}/?s=${encodeURIComponent(query)}`;
  const html = await fetchText(searchUrl);
  const results = parseCards(html, 'search').map((item) => ({
    url: item.url,
    title: item.title,
    type: item.type,
    thumbnail: item.thumbnail,
  }));
  return { query, results };
}

const QUALITY_ORDER = ['full', 'hd', 'sd', 'low', 'lowest', 'mobile'];
const QUALITY_LABELS = {
  full: '1080p (Full HD)',
  hd: '720p (HD)',
  sd: '480p (SD)',
  low: '360p',
  lowest: '240p',
  mobile: '144p',
};

/** Extract direct MP4/HLS renditions from an OK.ru embed page. */
async function extractOkStreams(id) {
  try {
    const html = await fetchText(`https://ok.ru/videoembed/${id}`, {
      timeout: 6_500,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
        Referer: `${ORIGIN}/`,
      },
    });

    const optMatch = html.match(/data-options="([^"]+)"/);
    if (!optMatch) return [];

    const options = JSON.parse(optMatch[1].replace(/&quot;/g, '"'));
    const metadata = options?.flashvars?.metadata;
    const meta = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
    const videos = Array.isArray(meta?.videos) ? meta.videos : [];
    if (videos.length === 0) return [];

    const byName = new Map(videos.map((video) => [video.name, video]));
    return QUALITY_ORDER.flatMap((quality) => {
      const video = byName.get(quality);
      return video?.url
        ? [{ quality: QUALITY_LABELS[quality] || quality, url: video.url }]
        : [];
    });
  } catch (error) {
    console.warn(`OK.ru extraction skipped for ${id}: ${error.message}`);
    return [];
  }
}

async function getEpisodeDetailData(epUrl) {
  const html = await fetchText(epUrl);

  const titleMatch =
    html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || html.match(/<title>([^<]+)<\/title>/);
  const title = titleMatch ? cleanTitle(titleMatch[1]) : '';

  const numMatch = epUrl.match(/الحلقة-(\d+)/) || title.match(/الحلقة\s*(\d+)/);
  const episodeNum = numMatch ? numMatch[1] : '';

  const posterMatch =
    html.match(/url\('(https:\/\/krmzi\.org\/wp-content\/uploads\/[^']+)'\)/) ||
    html.match(THUMB_REGEX);
  const poster = posterMatch ? absoluteThumb(posterMatch[1]) : '';

  const seriesLinkMatch = html.match(/<a[^>]+href="(https:\/\/krmzi\.org\/series\/[^"]+)"/);
  const seriesUrl = seriesLinkMatch ? safeKrmziUrl(seriesLinkMatch[1]) || '' : '';

  // 1. Modern Qesen base64 payload (present on virtually every episode).
  let rawServers = [];
  const qesenMatch = html.match(/href="https:\/\/qesen\.net\/krmzi\?post=([^"]+)"/);
  if (qesenMatch) {
    try {
      const decoded = Buffer.from(qesenMatch[1], 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);
      if (Array.isArray(parsed?.servers)) rawServers = parsed.servers;
    } catch (error) {
      console.warn('Failed to parse Qesen payload:', error.message);
    }
  }

  // 2. Legacy <li data-name/data-server> markup.
  if (rawServers.length === 0) {
    const liRegex = /<li[^>]*data-name="([^"]*)"[^>]*data-server="([^"]*)"/g;
    let match;
    while ((match = liRegex.exec(html)) !== null) {
      if (match[1] || match[2]) {
        rawServers.push({ name: match[1] || 'مشغل', id: match[2] });
      }
    }
  }

  // 3. Last resort: an iframe already present on the page.
  if (rawServers.length === 0) {
    const iframeMatch = html.match(/<iframe[^>]+src="([^"]+)"/);
    if (iframeMatch) rawServers.push({ name: 'سيرفر رئيسي', id: iframeMatch[1] });
  }

  const seenIds = new Set();
  const normalizedServers = [];
  for (const server of rawServers) {
    const name = String(server?.name || '').trim();
    const id = String(server?.id || '').trim();
    if (!id || seenIds.has(`${name}:${id}`)) continue;
    seenIds.add(`${name}:${id}`);
    normalizedServers.push({ name, id });
  }

  const embedFor = (name, id) => {
    switch (name.toLowerCase()) {
      case 'ok':
        return `https://ok.ru/videoembed/${id}`;
      case 'arab hd':
        return `https://arabhd.onl/embed-${id}.html`;
      case 'estream':
        return `https://arabveturk.com/embed-${id}.html`;
      case 'box':
        return `https://youdboox.com/embed-${id}.html`;
      case 'now':
        return `https://extreamnow.org/embed-${id}.html`;
      case 'red hd':
        return `https://iplayerhls.com/e/${id}`;
      case 'pro hd':
        return `https://embedo.co/e/${id}`;
      case 'dailymotion':
        return `https://www.dailymotion.com/embed/video/${id}`;
      case 'youtube':
        return `https://www.youtube.com/embed/${id}`;
      case 'express':
        return id.startsWith('http') ? id : `https://cloud.mail.ru/public/${id}`;
      default:
        return id.startsWith('http') ? id : '';
    }
  };

  // Resolve every OK.ru server in parallel instead of serially.
  const okServers = normalizedServers.filter((s) => s.name.toLowerCase() === 'ok');
  const okResults = await Promise.all(okServers.map((s) => extractOkStreams(s.id)));
  const okStreams = okResults.flat();

  const seenStreamUrls = new Set();
  const directStreams = okStreams.filter((stream) => {
    if (!stream.url || seenStreamUrls.has(stream.url)) return false;
    seenStreamUrls.add(stream.url);
    return true;
  });

  const servers = normalizedServers
    .map(({ name, id }) => {
      const embedUrl = embedFor(name, id);
      if (!embedUrl) return null;
      return {
        name,
        id,
        embedUrl,
        hasDirectStream: name.toLowerCase() === 'ok' && directStreams.length > 0,
      };
    })
    .filter(Boolean);

  // Direct-capable servers first.
  servers.sort((a, b) => Number(b.hasDirectStream) - Number(a.hasDirectStream));

  return {
    url: epUrl,
    title,
    episodeNum,
    poster,
    seriesUrl,
    servers,
    directStreams,
  };
}

/* -------------------------------------------------------------------------- */
/*  Routes                                                                    */
/* -------------------------------------------------------------------------- */

function pageParam(req) {
  const page = parseInt(req.query.page, 10);
  return Number.isFinite(page) && page > 0 && page < 500 ? page : 1;
}

app.get('/api/home', async (req, res) => {
  const page = pageParam(req);
  const key = `home_${page}`;
  try {
    const result = await cached(key, { ttl: 120_000, stale: 600_000 }, async () => {
      const [episodes, series] = await Promise.all([getEpisodesData(page), getSeriesData(page)]);
      return { episodes, series, fetchedAt: new Date().toISOString() };
    });
    sendCached(res, result, 120, 600);
  } catch (error) {
    console.error('Error fetching home:', error.message);
    res.status(502).json({ error: 'Failed to fetch home data', details: error.message });
  }
});

app.get('/api/episodes', async (req, res) => {
  const page = pageParam(req);
  try {
    const result = await cached(`episodes_${page}`, { ttl: 120_000, stale: 600_000 }, () =>
      getEpisodesData(page)
    );
    sendCached(res, result, 120, 600);
  } catch (error) {
    console.error('Error fetching episodes:', error.message);
    res.status(502).json({ error: 'Failed to fetch episodes', details: error.message });
  }
});

app.get('/api/series', async (req, res) => {
  const page = pageParam(req);
  try {
    const result = await cached(`series_${page}`, { ttl: 300_000, stale: 1_800_000 }, () =>
      getSeriesData(page)
    );
    sendCached(res, result, 300, 1800);
  } catch (error) {
    console.error('Error fetching series:', error.message);
    res.status(502).json({ error: 'Failed to fetch series', details: error.message });
  }
});

app.get('/api/series/detail', async (req, res) => {
  const seriesUrl = safeKrmziUrl(req.query.url);
  if (!seriesUrl) return res.status(400).json({ error: 'Missing or invalid series url' });

  try {
    const result = await cached(
      `series_detail_${seriesUrl}`,
      { ttl: 600_000, stale: 3_600_000 },
      () => getSeriesDetailData(seriesUrl)
    );
    sendCached(res, result, 600, 3600);
  } catch (error) {
    console.error('Error fetching series detail:', error.message);
    res.status(502).json({ error: 'Failed to fetch series detail', details: error.message });
  }
});

app.get('/api/search', async (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 120);
  if (!query) return res.json({ query: '', results: [] });

  try {
    const result = await cached(
      `search_${query.toLowerCase()}`,
      { ttl: 300_000, stale: 900_000 },
      () => getSearchData(query)
    );
    sendCached(res, result, 300, 900);
  } catch (error) {
    console.error('Error searching:', error.message);
    res.status(502).json({ error: 'Search failed', details: error.message });
  }
});

app.get('/api/episode/detail', async (req, res) => {
  const epUrl = safeKrmziUrl(req.query.url);
  if (!epUrl) return res.status(400).json({ error: 'Missing or invalid episode url' });

  try {
    const result = await cached(
      `episode_detail_${epUrl}`,
      { ttl: 300_000, stale: 1_800_000 },
      () => getEpisodeDetailData(epUrl)
    );
    sendCached(res, result, 300, 1800);
  } catch (error) {
    console.error('Error fetching episode detail:', error.message);
    res.status(502).json({ error: 'Failed to fetch episode detail', details: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    uptimeSeconds: Math.round((Date.now() - appStartedAt) / 1000),
    cache: cache.stats(),
    inflight: inFlight.size,
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  });
});

// Static assets: long-lived and immutable, except the HTML shell.
app.use(
  express.static(path.join(__dirname, 'public'), {
    etag: true,
    lastModified: true,
    maxAge: '7d',
    immutable: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      } else if (filePath.endsWith('manifest.json') || filePath.endsWith('sw.js')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

// SPA fallback
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(PORT, () => {
  console.log('=======================================================');
  console.log('  KRMZI PRO SERVER IS RUNNING');
  console.log(`  Open in browser: http://localhost:${PORT}`);
  console.log('  Cache: SWR + request coalescing enabled');
  console.log('=======================================================');

  // Prime the most requested endpoint so the first user gets a cache hit.
  if (process.env.KRMZI_WARMUP !== 'false') {
    setTimeout(() => {
      cached('home_1', { ttl: 120_000, stale: 600_000 }, async () => {
        const [episodes, series] = await Promise.all([getEpisodesData(1), getSeriesData(1)]);
        return { episodes, series, fetchedAt: new Date().toISOString() };
      }).catch(() => {});
    }, 400).unref?.();
  }
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

function shutdown(signal) {
  console.log(`\n${signal} received, closing server...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
