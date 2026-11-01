'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Exercise the actual provider and cache code without opening a server port.
const serverPath = path.join(__dirname, '..', 'server.js');
const source = fs.readFileSync(serverPath, 'utf8').split('/*  Routes')[0];
// The routes banner's first divider is already present in the prefix; remove it
// before appending the test harness.
const code = source.slice(0, source.lastIndexOf('/* -------------------------------------------------------------------------- */'));
function load(fetch) {
  return vm.runInNewContext(`${code}\n;({ resolveFirstOkStreams, getEpisodeDetailData, cached, cache });`, {
    require: createRequire(serverPath), __dirname: path.dirname(serverPath),
    fetch, AbortController, AbortSignal, setTimeout, clearTimeout, Buffer,
    console: { ...console, warn() {} }, process,
  });
}

function providerHtml(videos, extra = {}) {
  const options = { flashvars: { metadata: JSON.stringify({ videos, ...extra }) } };
  return `<div data-options="${JSON.stringify(options).replace(/"/g, '&quot;')}"></div>`;
}
function htmlResponse(html) { return { ok: true, text: async () => html }; }

test('first playable mirror returns immediately and cancels a hanging mirror', async () => {
  let losingSignal;
  const api = load(async (url, { signal }) => {
    if (url.endsWith('/slow')) {
      losingSignal = signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () => {
        reject(new DOMException('cancelled', 'AbortError'));
      }, { once: true }));
    }
    return htmlResponse(providerHtml([{ name: 'hd', url: 'https://video.test/720.mp4' }]));
  });
  const result = await api.resolveFirstOkStreams([{ id: 'slow' }, { id: 'ready' }]);
  assert.equal(result.id, 'ready');
  assert.equal(result.streams[0].url, 'https://video.test/720.mp4');
  assert.equal(losingSignal.aborted, true);
});

test('an empty fast mirror does not suppress a later valid provider', async () => {
  const api = load(async (url) => {
    if (url.endsWith('/empty')) return htmlResponse(providerHtml([]));
    await new Promise(resolve => setImmediate(resolve));
    return htmlResponse(providerHtml([{ name: 'full', url: 'https://video.test/full.mp4' }]));
  });
  const result = await api.resolveFirstOkStreams([{ id: 'empty' }, { id: 'valid' }]);
  assert.equal(result.id, 'valid');
  assert.equal(result.streams.length, 1);
});

test('adaptive HLS is offered before MP4 and works without MP4 renditions', async () => {
  for (const videos of [[], [{ name: 'full', url: 'https://video.test/full.mp4' }]]) {
    const api = load(async () => htmlResponse(providerHtml(videos, {
      hlsManifestUrl: 'https://video.test/master.m3u8',
    })));
    const result = await api.resolveFirstOkStreams([{ id: 'adaptive' }]);
    assert.equal(result.id, 'adaptive');
    assert.equal(result.streams[0].type, 'hls');
    assert.equal(result.streams[0].url, 'https://video.test/master.m3u8');
    assert.equal(result.streams.length, videos.length + 1);
  }
});

test('failed providers retain embed fallback and Qesen payloads need no URL fields', async () => {
  const payload = Buffer.from(JSON.stringify({ servers: [{ name: 'ok', id: '123' }] })).toString('base64');
  const requests = [];
  const api = load(async (url) => {
    requests.push(url);
    return htmlResponse(url.includes('krmzi.org')
      ? `<h1>مسلسل الحلقة 3</h1><a href="https://qesen.net/krmzi?post=${payload}">play</a>`
      : '<html>Provider unavailable</html>');
  });
  const result = await api.getEpisodeDetailData('https://krmzi.org/episode/test/');
  assert.equal(result.directStreams.length, 0);
  assert.equal(result.servers[0].embedUrl, 'https://ok.ru/videoembed/123');
  assert.equal(requests.length, 2, 'no image requests are needed to resolve playback');
});

test('expired signed-stream cache is never returned after a refresh failure', async () => {
  const api = load(() => { throw new Error('unused'); });
  api.cache.set('signed-stream', { url: 'https://video.test/expired' }, -1, 0);
  await assert.rejects(api.cached('signed-stream', {
    ttl: 45_000, stale: 0, staleIfError: false,
  }, async () => { throw new Error('provider down'); }), /provider down/);
});

test('concurrent requests still share one stream-resolution request', async () => {
  const api = load(() => { throw new Error('unused'); });
  let count = 0;
  const producer = async () => { count++; await new Promise(resolve => setImmediate(resolve)); return 'valid'; };
  const options = { ttl: 45_000, stale: 0, staleIfError: false };
  const results = await Promise.all([api.cached('episode', options, producer), api.cached('episode', options, producer)]);
  assert.equal(count, 1);
  assert.equal(results[0].data, 'valid');
  assert.equal(results[1].data, 'valid');
});
