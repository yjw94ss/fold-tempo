/* FOLD TEMPO 线上验收：
   1) 生产入口干净（无调试钩子）、零外部请求、零报错、动画在跑
   2) 线上部署的那份文件里，判定与谱面逻辑确实可用（用 #dev 钩子对同一份线上代码做断言）
*/
const { chromium } = require('playwright');

const BASE = 'https://yjw94ss.github.io/fold-tempo/';
const VP = { width: 749, height: 827 };
let pass = 0, fail = 0;
function ok(c, l, x) {
  if (c) { pass++; console.log('  ✓ ' + l + (x ? '  ' + x : '')); }
  else { fail++; console.log('  ✗ ' + l + '  ' + (x || '')); }
}

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

  /* ── 生产入口 ── */
  const page = await browser.newPage({ viewport: VP, deviceScaleFactor: 2 });
  const errors = [], reqs = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('request', r => reqs.push(r.url()));

  const resp = await page.goto(BASE, { waitUntil: 'load' });
  ok(resp.status() === 200, '首页返回 200', 'status=' + resp.status());
  await page.waitForTimeout(600);

  console.log('\n[1] 生产入口干净度');
  ok(await page.evaluate(() => typeof window.__TP === 'undefined'), '未暴露调试钩子 __TP');

  console.log('\n[2] 网络请求');
  const ext = reqs.filter(u => !u.startsWith(BASE));
  ok(ext.length === 0, '零外部请求（音频全部实时合成）',
    ext.length ? ext.slice(0, 3).join(', ') : '共 ' + reqs.length + ' 个同源请求');

  console.log('\n[3] 真实交互');
  await page.click('#btnGo');
  await page.waitForTimeout(500);
  const a = await page.screenshot();
  await page.waitForTimeout(700);
  const b = await page.screenshot();
  ok(Buffer.compare(a, b) !== 0, '开始后画面持续变化（动画在跑）', a.length + 'B → ' + b.length + 'B');

  const ink = await page.evaluate(() => {
    const c = document.getElementById('cv'), g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let vio = 0, acid = 0;
    for (let i = 0; i < d.length; i += 32) {
      if (d[i + 3] < 10) continue;
      if (d[i + 2] > d[i] + 14 && d[i + 2] > d[i + 1] + 30) vio++;
      if (d[i + 1] > d[i] + 20 && d[i + 1] > d[i + 2] + 20) acid++;
    }
    return { vio, acid };
  });
  ok(ink.vio > 40 && ink.acid > 40, '线上画面两界色温同时存在',
    '紫=' + ink.vio + ' 绿=' + ink.acid);

  const meta = await page.evaluate(() => {
    const m = document.querySelector('meta[name=viewport]');
    return { vp: m ? m.content : '', h: document.documentElement.scrollHeight, ih: window.innerHeight };
  });
  ok(/viewport-fit=cover/.test(meta.vp), 'viewport-fit=cover 已设置');
  ok(meta.h <= meta.ih + 1, '页面无纵向溢出', 'doc=' + meta.h + ' win=' + meta.ih);
  ok(errors.length === 0, '无 console/page 错误', errors.slice(0, 2).join(' | '));

  await page.screenshot({ path: 'shot-live.png' });
  await page.close();

  /* ── 线上同一份代码的判定断言 ── */
  console.log('\n[4] 线上构建的判定逻辑');
  const dev = await browser.newPage({ viewport: VP, deviceScaleFactor: 2 });
  const derr = [];
  dev.on('pageerror', e => derr.push(e.message));
  await dev.goto(BASE + '#dev', { waitUntil: 'load' });
  await dev.waitForFunction(() => !!window.__TP, null, { timeout: 15000 });

  const chart = await dev.evaluate(() => {
    const s = window.__TP.song();
    const ev = new Set();
    ['kick', 'snare', 'bass', 'arp', 'lead'].forEach(k =>
      (s.tracks[k] || []).forEach(e => ev.add(Math.round(e[0] * 1000))));
    const out = { counts: {}, orphan: 0 };
    ['easy', 'normal', 'hard'].forEach(k => {
      out.counts[k] = s.charts[k].length;
      s.charts[k].forEach(n => { if (!ev.has(Math.round(n[0] * 1000))) out.orphan++; });
    });
    return out;
  });
  ok(chart.counts.easy === 104 && chart.counts.normal === 226 && chart.counts.hard === 347,
    '线上谱面完整 104 / 226 / 347', JSON.stringify(chart.counts));
  ok(chart.orphan === 0, '线上每个音符都有对应发声');

  const judge = await dev.evaluate(() => {
    const T = window.__TP;
    T.fake(0); T.start(2);
    const s = T.auto();
    return s;
  });
  ok(judge.perfect === judge.total && judge.rank === 'S', '线上全连判定正确',
    judge.perfect + '/' + judge.total + ' ' + judge.rank);

  const winUI = await (async () => {
    await dev.waitForTimeout(800);
    return dev.evaluate(() => window.__TP.ui());
  })();
  ok(winUI.veil === true && /MAX COMBO/.test(winUI.text), '线上结算面板正常弹出');
  ok(derr.length === 0, '线上 #dev 页面零报错', derr.slice(0, 2).join(' | '));

  await browser.close();
  console.log('\n' + '─'.repeat(30));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})();
