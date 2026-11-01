'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),catalogue=require('../public/catalogue.js');
test('catalogue merges Arabic series aliases and keeps both playback references',()=>{
 const result=catalogue.merge([{url:'https://krmzi.org/series/a',title:'مسلسل هذا البحر سوف يفيض',type:'series'},{url:'cinemana:12',title:'هذا البَحر سوف يفيض',type:'series',year:'2025'}]);
 assert.equal(result.length,1);assert.equal(result[0].offers.length,2);assert.equal(result[0].url,'cinemana:12');assert.deepEqual(result[0].sources,['krmzi','cinemana']);
});
test('catalogue keeps different years and episode numbers separate',()=>{
 assert.equal(catalogue.merge([{url:'a',title:'Dune',type:'series',year:1984},{url:'b',title:'Dune',type:'series',year:2021}]).length,2);
 assert.equal(catalogue.merge([{url:'a',title:'التجربة الحلقة 1',type:'episode'},{url:'b',title:'التجربة الحلقة 2',type:'episode'}]).length,2);
});
test('provider switching requires a unique matching season and episode',()=>{
 const current={episodeNum:'2',season:'1'};
 assert.equal(catalogue.matchEpisode(current,[{url:'a',episodeNum:'2',season:'2'}]),null);
 assert.equal(catalogue.matchEpisode(current,[{url:'a',episodeNum:'2',season:'1'}]).url,'a');
 assert.equal(catalogue.matchEpisode(current,[{url:'a',episodeNum:'2'},{url:'b',episodeNum:'2'}]),null);
 assert.equal(catalogue.matchEpisode({},[{episodeNum:'2'}]),null);
});

test('unknown-year source does not bridge two known remakes into one card',()=>{
 const result=catalogue.merge([{url:'a',title:'The Return',type:'series'},{url:'b',title:'The Return',type:'series',year:2010},{url:'c',title:'The Return',type:'series',year:2025}]);
 assert.equal(result.length,2);assert.equal(result[0].offers.length,2);assert.equal(result[1].offers.length,1);
});
