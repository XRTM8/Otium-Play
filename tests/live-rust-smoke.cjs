'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/mjd20/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'..');
const output=path.join(root,'artifacts','ui-2.0.0');fs.mkdirSync(output,{recursive:true});
const executable=path.join(root,'rust','otium-core','target','debug',process.platform==='win32'?'otium-server.exe':'otium-server');
const port=3419;
const server=spawn(executable,[],{cwd:root,env:{...process.env,PORT:String(port)},windowsHide:true,stdio:['ignore','pipe','pipe']});
const errors=[];let browser;
async function run(){
  await new Promise((resolve,reject)=>{server.once('error',reject);server.stdout.once('data',resolve);});
  const executablePath=process.env.BROWSER_PATH||'C:/Users/mjd20/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe';
  browser=await chromium.launch({executablePath,headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  const page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')console.log('BROWSER',message.text().replace(/https?:\/\/[^\s"']+/g,'[remote URL]'));});
  page.on('response',response=>{if(response.status()>=400){const url=new URL(response.url());console.log('HTTP',response.status(),url.hostname,path.extname(url.pathname));}});
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.locator('#seriesGrid .series-tile[data-url]').first().waitFor({timeout:30000});
  await page.waitForFunction(()=>document.querySelector('#seriesGrid').getAttribute('aria-busy')==='false',{timeout:30000});
  console.log('LIVE unified initial series:',await page.locator('#seriesGrid [data-url]').count());
  await page.waitForTimeout(600);
  await page.screenshot({path:path.join(output,'phone-series.png')});
  await page.locator('[data-source="krmzi"]').click();
  await page.waitForFunction(()=>document.querySelector('#seriesGrid').getAttribute('aria-busy')==='false');
  let pages=1;
  while(await page.locator('#loadMoreSeriesBtn').isVisible()&&pages<12){
    await page.locator('#loadMoreSeriesBtn').click();
    await page.waitForFunction(()=>document.querySelector('#seriesGrid').getAttribute('aria-busy')==='false');
    pages++;
  }
  console.log('LIVE Krmzi catalogue:',await page.locator('#seriesGrid [data-url]').count(),'titles across',pages,'pages; exhausted:',!await page.locator('#loadMoreSeriesBtn').isVisible());
  await page.locator('#seriesGrid [data-action="series"]').first().click();
  await page.locator('.sheet-episode-btn').first().waitFor({timeout:20000});
  console.log('LIVE series episodes:',await page.locator('.sheet-episode-btn').count());
  await page.screenshot({path:path.join(output,'phone-detail.png')});
  await page.locator('.sheet-episode-btn').last().click();
  try {await page.waitForFunction(()=>document.getElementById('nativePlayer').readyState>=2&&!document.getElementById('nativePlayer').paused,null,{timeout:60000});}
  catch(error){console.log('VIDEO DIAGNOSTIC',await page.locator('#nativePlayer').evaluate(v=>({ready:v.readyState,paused:v.paused,error:v.error?.code,currentTime:v.currentTime,source:v.src.includes('/api/media')?'HLS proxy':'direct',player:document.getElementById('playerSpinner').textContent})));await page.screenshot({path:path.join(output,'player-failure.png')});throw error;}
  const start=await page.locator('#nativePlayer').evaluate(v=>v.currentTime);
  await page.waitForFunction(start=>document.getElementById('nativePlayer').currentTime>start+.5,start,{timeout:10000});
  console.log('LIVE real video decoded and currentTime advanced; runtime errors:',errors.length);
  await page.screenshot({path:path.join(output,'player.png')});
  await page.keyboard.press('Escape');
  await page.locator('#tabMovies').click();
  await page.waitForFunction(()=>document.querySelector('#seriesGrid').getAttribute('aria-busy')==='false');
  console.log('LIVE movies:',await page.locator('#seriesGrid [data-url]').count());
  await page.waitForTimeout(600);
  await page.screenshot({path:path.join(output,'phone-movies.png')});
  await page.setViewportSize({width:1440,height:900});await page.locator('#tabSeries').click();
  await page.waitForFunction(()=>document.querySelector('#seriesGrid').getAttribute('aria-busy')==='false');
  await page.waitForTimeout(600);
  await page.screenshot({path:path.join(output,'desktop-series.png')});
  if(errors.length)throw new Error(errors.join('\n'));
  await context.close();
}
run().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.kill();});
