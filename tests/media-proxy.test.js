'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const text=fs.readFileSync(require('node:path').join(__dirname,'../server.js'),'utf8');const helpers=text.slice(text.indexOf('function safeMediaUrl('),text.indexOf("app.get('/api/media'"));const api=vm.runInNewContext(helpers+';({safeMediaUrl,rewritePlaylist})',{URL});
test('media proxy permits provider CDN hosts and rejects arbitrary URLs',()=>{
 for(const url of ['https://vd196.okcdn.ru/video.m3u8','https://ok6.vkuser.net/x'])assert(api.safeMediaUrl(url));
 for(const url of ['http://vd196.okcdn.ru/x','https://okcdn.ru.attacker.test/x','https://localhost/x','https://127.0.0.1/x','https://name@vd196.okcdn.ru/x','https://vd196.okcdn.ru:8443/x'])assert.equal(api.safeMediaUrl(url),null,url);
});
test('HLS child playlists, segments, and key URIs use the same-origin proxy',()=>{
 const result=api.rewritePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="../key.bin"\nsegment.ts\nhttps://other.okcdn.ru/child.m3u8','https://vd196.okcdn.ru/path/master.m3u8');
 assert(result.includes('URI="/api/media?url=https%3A%2F%2Fvd196.okcdn.ru%2Fkey.bin"'));
 assert(result.includes('/api/media?url=https%3A%2F%2Fvd196.okcdn.ru%2Fpath%2Fsegment.ts'));
 assert(result.includes('/api/media?url=https%3A%2F%2Fother.okcdn.ru%2Fchild.m3u8'));
 assert.throws(()=>api.rewritePlaylist('#EXTM3U\nhttps://attacker.test/a.ts','https://vd196.okcdn.ru/a.m3u8'));
});
