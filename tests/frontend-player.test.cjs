'use strict';

// Browser regressions exercise the shipped app, with deterministic provider/API
// responses and media events. No third-party video or expiring stream is used.
// Set PLAYWRIGHT_MODULE / BROWSER_PATH when using a different local runtime.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ||
  'C:/Users/mjd20/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const seriesUrl = 'https://krmzi.org/series/test-series/';
const episodeUrl = (number) => `https://krmzi.org/episode/test-${number}/`;
const artwork = '/test-images/series.png';
const episodeArtwork = '/test-images/episode.png';
const episodes = Array.from({ length: 80 }, (_, i) => ({
  url: episodeUrl(i + 1), title: `مسلسل التجربة الحلقة ${i + 1}`,
  seriesTitle: 'مسلسل التجربة', episodeNum: String(i + 1),
  seriesUrl, thumbnail: artwork,
}));
const series = { url: seriesUrl, title: 'مسلسل التجربة', thumbnail: artwork };
const requests = [];
const failures = [];
let delayEpisode = 0;
let failEpisode = false;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  requests.push(url.pathname + url.search);
  res.setHeader('Cache-Control', 'no-store');
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    let data;
    switch (url.pathname) {
      case '/api/home': data = { episodes: { episodes }, series: { series: [series] } }; break;
      case '/api/episodes': data = { episodes }; break;
      case '/api/series': data = { series: [series] }; break;
      case '/api/series/detail': data = { ...series, poster: artwork, story: 'قصة قصيرة للاختبار', episodes }; break;
      case '/api/episode/detail':
        if (delayEpisode) await new Promise((resolve) => setTimeout(resolve, delayEpisode));
        if (failEpisode) { res.statusCode = 502; data = { error: 'Provider unavailable' }; break; }
        data = {
          url: url.searchParams.get('url'), title: 'مسلسل التجربة الحلقة 1',
          seriesTitle: series.title, episodeNum: '1', seriesUrl, poster: episodeArtwork,
          directStreams: [
            { quality: '1080p (Full HD)', url: '/test-stream/full.mp4' },
            { quality: '720p (HD)', url: '/test-stream/hd.mp4' },
            { quality: '480p (SD)', url: '/test-stream/sd.mp4' },
          ],
          servers: Array.from({ length: 12 }, (_, i) => ({
            name: `سيرفر تجريبي باسم طويل جداً ${i + 1}`,
            embedUrl: `/test-embed/${i + 1}`,
          })),
        };
        break;
      default: data = { ok: true };
    }
    res.end(JSON.stringify(data));
    return;
  }
  if (url.pathname.startsWith('/test-images/')) {
    res.setHeader('Content-Type', 'image/png');
    res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4z0AAAAASUVORK5CYII=', 'base64'));
    return;
  }
  if (url.pathname.startsWith('/test-stream/')) { res.statusCode = 204; res.end(); return; }
  if (url.pathname.startsWith('/test-embed/')) { res.end('<!doctype html><title>Test provider</title>'); return; }
  const file = path.resolve(publicDir, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(publicDir + path.sep)) { res.statusCode = 403; res.end(); return; }
  try {
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.woff2': 'font/woff2' })[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  } catch { res.statusCode = 404; res.end(); }
});

async function mediaMock() {
  Object.defineProperty(navigator, 'connection', { configurable: true, value: { effectiveType: '4g', saveData: false } });
  window.__media = { time: 0, duration: 1800, paused: true, readyState: 0, bufferedEnd: 0, loads: [], plays: 0 };
  const p = HTMLMediaElement.prototype;
  const getAttribute = p.getAttribute;
  const removeAttribute = p.removeAttribute;
  Object.defineProperty(p, 'src', { configurable: true, get() { return this.__testSource || ''; }, set(value) { this.__testSource = value; } });
  p.getAttribute = function (name) { return name === 'src' ? this.__testSource || null : getAttribute.call(this, name); };
  p.removeAttribute = function (name) { if (name === 'src') this.__testSource = ''; else removeAttribute.call(this, name); };
  for (const [key, field] of [['currentTime', 'time'], ['duration', 'duration'], ['paused', 'paused'], ['readyState', 'readyState']]) {
    Object.defineProperty(p, key, { configurable: true, get() { return window.__media[field]; }, set(value) { window.__media[field] = value; } });
  }
  Object.defineProperty(p, 'buffered', { configurable: true, get() { return { length: window.__media.bufferedEnd > 0 ? 1 : 0, start() { return 0; }, end() { return window.__media.bufferedEnd; } }; } });
  p.load = function () { window.__media.time = 0; window.__media.readyState = 0; window.__media.loads.push(this.getAttribute('src')); };
  p.pause = function () { window.__media.paused = true; this.dispatchEvent(new Event('pause')); };
  p.play = function () { window.__media.paused = false; window.__media.plays++; this.dispatchEvent(new Event('play')); return Promise.resolve(); };
  window.__ready = () => {
    window.__media.readyState = 4;
    const video = document.getElementById('nativePlayer');
    video.dispatchEvent(new Event('loadedmetadata'));
    video.dispatchEvent(new Event('canplay'));
    video.dispatchEvent(new Event('playing'));
  };
}

async function run() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const candidate = process.env.BROWSER_PATH || [
    'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
    'C:/Users/mjd20/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe',
    chromium.executablePath(),
  ].find((file) => fs.existsSync(file));
  const browser = await chromium.launch({ executablePath: candidate, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    for (const viewport of [{ width: 320, height: 640 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1280, height: 800 }]) {
      const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
      await context.addInitScript(mediaMock);
      await context.route('https://**/*', (route) => route.abort());
      const page = await context.newPage();
      page.on('pageerror', (error) => failures.push(error.message));
      await page.goto(origin);
      await page.locator('#episodesCarousel [data-action="episode"]').first().waitFor();
      if (viewport.width === 390) await page.screenshot({ path: path.join(os.tmpdir(), 'krmzi-1.1.1-home-390.png') });
      const bounds = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, frame: document.getElementById('appFrame').getBoundingClientRect().width }));
      assert(bounds.scroll <= bounds.width + 1, `Page overflow at ${viewport.width}`);
      assert(bounds.frame > 250 && bounds.frame <= bounds.width + 1, `Collapsed app frame at ${viewport.width}`);
      await page.locator('#seriesGrid [data-action="series"]').first().click();
      await page.locator('.sheet-episode-btn').last().waitFor();
      await page.waitForTimeout(400); // Let the sheet entrance animation settle before measuring.
      assert(await page.locator('.sheet-episode-btn').count() === 80);
      const episodeRows = await page.locator('.sheet-episode-btn').evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
      assert(episodeRows.every((height) => height >= 43.99), `Squeezed episode rows at ${viewport.width}: minimum ${Math.min(...episodeRows)}`);
      await page.locator('.sheet-episode-btn').last().scrollIntoViewIfNeeded();
      assert(await page.locator('.sheet-episode-btn').last().isVisible());
      await page.locator('#closeSheetBtn').click();
      const requestStart = requests.length;
      await page.locator('#spotlightPlayBtn').click();
      await page.waitForFunction(() => !!document.getElementById('nativePlayer').getAttribute('src'));
      assert.match(await page.locator('#nativePlayer').evaluate((video) => video.src), /hd\.mp4$/, 'Auto should start at 720p for a fast first frame');
      assert.equal(await page.locator('#nativePlayer').getAttribute('poster'), null, 'Do not load the episode poster');
      await page.waitForTimeout(100);
      assert(!requests.slice(requestStart).some((request) => request.startsWith(episodeArtwork)), 'Episode artwork requested during startup');
      const backdrop = await page.locator('#playerBackdrop').evaluate((el) => el.style.backgroundImage);
      assert(backdrop.includes('series.png'), `Use existing series artwork while loading (actual: ${backdrop})`);
      await page.evaluate(() => window.__ready());
      await page.locator('#openServersSheetBtn').click();
      await page.waitForTimeout(400);
      if ([390, 844].includes(viewport.width)) await page.screenshot({ path: path.join(os.tmpdir(), `krmzi-1.1.1-servers-${viewport.width}.png`) });
      const panel = await page.locator('#bottomSheet').boundingBox();
      assert(panel.y >= -1 && panel.y + panel.height <= viewport.height + 1, `Sheet outside viewport at ${viewport.width}`);
      const serverRows = await page.locator('#sheetBody .sheet-row').evaluateAll((rows) => rows.map((row) => ({ height: row.getBoundingClientRect().height, scroll: row.scrollWidth, width: row.clientWidth })));
      assert(serverRows.every((row) => row.height >= 43.99 && row.scroll <= row.width + 1), `Inconsistent server rows at ${viewport.width}`);
      await page.locator('#sheetBody .sheet-row').last().scrollIntoViewIfNeeded();
      await page.locator('#closeSheetBtn').click();
      await page.evaluate(() => { window.__media.time = 137; window.__media.paused = true; });
      await page.locator('#openQualitySheetBtn').click();
      await page.locator('[data-sheet="quality"]').filter({ hasText: '1080p' }).click();
      await page.evaluate(() => document.getElementById('nativePlayer').dispatchEvent(new Event('loadedmetadata')));
      const playback = await page.evaluate(() => ({ time: window.__media.time, paused: window.__media.paused }));
      assert.equal(playback.time, 137, 'Quality selection preserves position');
      assert.equal(playback.paused, true, 'Quality selection preserves pause');
      if (viewport.width === 390) {
        await page.locator('#toggleFullscreenBtn').click();
        await page.waitForFunction(() => document.fullscreenElement?.id === 'appFrame');
        await page.locator('#openQualitySheetBtn').click();
        assert(await page.locator('#sheetBackdrop').isVisible(), 'Quality sheet visible in fullscreen');
        assert(await page.locator('[data-sheet="quality"]').last().isVisible());
        await page.locator('#closeSheetBtn').click();
        await page.evaluate(() => document.exitFullscreen());
      }
      await page.locator('#dismissPlayerBtn').click();
      assert.equal(await page.locator('#nativePlayer').evaluate((video) => video.getAttribute('src')), null, 'Closing releases the stream');
      assert(await page.locator('#mobilePlayer').evaluate((el) => el.classList.contains('hidden')));
      if (viewport.width === 390) {
        await page.locator('#spotlightPlayBtn').click();
        await page.waitForFunction(() => document.getElementById('nativePlayer').src.endsWith('/full.mp4'));
        await page.locator('#openQualitySheetBtn').click();
        await page.locator('[data-sheet="quality-auto"]').click();
        await page.waitForFunction(() => document.getElementById('nativePlayer').src.endsWith('/hd.mp4'));
        await page.locator('#dismissPlayerBtn').click();
      }
      await context.close();
      console.log(`PASS viewport ${viewport.width}x${viewport.height}: menus, artwork, quality, close`);
    }
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    await context.addInitScript(mediaMock);
    await context.route('https://**/*', (route) => route.abort());
    const page = await context.newPage();
    page.on('pageerror', (error) => failures.push(error.message));
    await page.clock.install();
    await page.goto(origin);
    await page.locator('#spotlightPlayBtn').click();
    await page.waitForFunction(() => document.getElementById('nativePlayer').src.endsWith('/hd.mp4'));
    // A single metadata/progress event used to disable fallback permanently.
    await page.evaluate(() => {
      window.__media.readyState = 1;
      document.getElementById('nativePlayer').dispatchEvent(new Event('progress'));
    });
    await page.clock.runFor(7500);
    assert.match(await page.locator('#nativePlayer').evaluate((video) => video.src), /sd\.mp4$/, 'A stalled startup must fall back after progress without playing');
    await page.locator('#dismissPlayerBtn').click();
    // Even continuous download progress cannot leave startup waiting forever.
    await page.locator('#spotlightPlayBtn').click();
    await page.waitForFunction(() => document.getElementById('nativePlayer').src.endsWith('/hd.mp4'));
    for (let i = 0; i < 17; i++) {
      await page.evaluate(() => { window.__media.bufferedEnd += 1; });
      await page.clock.runFor(1000);
    }
    assert.match(await page.locator('#nativePlayer').evaluate((video) => video.src), /sd\.mp4$/, 'Startup has a hard bound even if buffering progresses');
    await page.locator('#dismissPlayerBtn').click();
    await page.clock.resume();
    // Closing cancels a pending provider lookup and blocks its late response.
    delayEpisode = 250;
    await page.locator('#spotlightPlayBtn').click();
    await page.locator('#dismissPlayerBtn').click();
    await page.waitForTimeout(350);
    assert(await page.locator('#mobilePlayer').evaluate((el) => el.classList.contains('hidden')));
    assert.equal(await page.locator('#nativePlayer').evaluate((video) => video.src), '');
    delayEpisode = 0;
    failEpisode = true;
    await page.setViewportSize({ width: 320, height: 640 });
    await page.locator('#spotlightPlayBtn').click();
    await page.locator('[data-player-retry]').waitFor();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(os.tmpdir(), 'krmzi-1.1.1-error-320.png') });
    const errorControls = await page.locator('[data-player-retry], [data-player-servers]').evaluateAll((buttons) => buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return { top: rect.top, bottom: rect.bottom, height: rect.height, hittable: hit === button || button.contains(hit) };
    }));
    assert(errorControls.every((control) => control.height >= 43.99 && control.hittable), `Error controls must remain tappable on narrow phones: ${JSON.stringify(errorControls)}`);
    failEpisode = false;
    const retryStart = requests.length;
    await page.locator('[data-player-retry]').click();
    await page.waitForFunction(() => document.getElementById('nativePlayer').src.endsWith('/hd.mp4'));
    assert(requests.slice(retryStart).some((request) => request.startsWith('/api/episode/detail?') && request.includes('fresh=1')), 'Retry asks for fresh stream links');
    // An old stream callback cannot tear down a newly opened episode.
    await page.evaluate(() => { window.__oldStreamError = document.getElementById('nativePlayer').onerror; });
    await page.locator('#dismissPlayerBtn').click();
    await page.locator('#episodesCarousel [data-action="episode"]').nth(1).click();
    await page.waitForFunction(() => document.getElementById('nativePlayer').src.endsWith('/hd.mp4'));
    const loadsBefore = await page.evaluate(() => window.__media.loads.length);
    await page.evaluate(() => window.__oldStreamError());
    assert.equal(await page.evaluate(() => window.__media.loads.length), loadsBefore, 'Stale media error ignored');
    await context.close();
    console.log('PASS player lifecycle: bounded stalls, fresh retry, cancel pending lookup, stale callbacks');
    const adaptiveContext = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    await adaptiveContext.addInitScript(mediaMock);
    const adaptivePage = await adaptiveContext.newPage();
    await adaptivePage.route('**/vendor/hls/hls.min.js', route => route.fulfill({ contentType: 'application/javascript', body: `
      window.Hls = class {
        static isSupported() { return true; }
        static Events = { MANIFEST_PARSED:'manifest', LEVEL_SWITCHED:'level', ERROR:'error' };
        constructor() { window.__engine = this; this.handlers = {}; this.levels = [{height:480},{height:720},{height:1080}]; }
        on(event, fn) { this.handlers[event] = fn; }
        loadSource(url) { this.source = url; }
        attachMedia(video) { video.src = 'blob:fake-media'; this.handlers.manifest(); }
        startLoad(position) { this.position = position; }
        destroy() { this.destroyed = true; }
      };` }));
    await adaptivePage.route('**/api/episode/detail?**', async route => {
      const response = await route.fetch(); const data = await response.json();
      data.directStreams.unshift({quality:'تلقائي',type:'hls',url:'https://vd196.okcdn.ru/master.m3u8'});
      await route.fulfill({response,json:data});
    });
    await adaptivePage.goto(origin);
    await adaptivePage.locator('#episodesCarousel [data-action="episode"]').first().waitFor();
    await adaptivePage.locator('#spotlightPlayBtn').click();
    await adaptivePage.waitForFunction(() => window.__engine?.source);
    assert.match(await adaptivePage.evaluate(() => window.__engine.source), /^\/api\/media\?url=/);
    assert.equal(await adaptivePage.evaluate(() => window.__engine.startLevel), 1, 'Adaptive startup chooses720p');
    await adaptivePage.evaluate(() => { window.__ready(); window.__media.time=137; });
    await adaptivePage.locator('#openQualitySheetBtn').click();
    await adaptivePage.locator('[data-sheet="quality"]').filter({hasText:'1080p'}).click();
    assert.equal(await adaptivePage.evaluate(() => window.__engine.nextLevel), 2, 'Manual HLS quality changes in-place');
    assert.equal(await adaptivePage.evaluate(() => window.__media.time), 137);
    await adaptivePage.locator('#openQualitySheetBtn').click();
    await adaptivePage.locator('[data-sheet="quality-auto"]').click();
    assert.equal(await adaptivePage.evaluate(() => window.__engine.nextLevel), -1, 'Auto restores adaptive quality');
    await adaptivePage.locator('#dismissPlayerBtn').click();
    assert.equal(await adaptivePage.evaluate(() => window.__engine.destroyed), true, 'Closing destroys HLS downloads');
    await adaptiveContext.close();
    console.log('PASS adaptive lifecycle: same-origin source,720p startup,seamless quality,Auto,cleanup');
    assert.deepEqual(failures, [], 'Browser runtime errors');
  } finally { await browser.close(); server.close(); }
}

run().catch((error) => { console.error(error); server.close(); process.exitCode = 1; });
