/* FOLD TEMPO 真机验收：真实 Chromium + 假时钟压缩全曲 + 页面内独立复算谱面 */
const { chromium } = require('playwright');
const path = require('path');

const URL = 'file://' + path.resolve(__dirname, 'index.html') + '#dev';

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + label + '  ' + (extra || '')); }
}

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 749, height: 827 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__TP, null, { timeout: 8000 });
  await page.waitForTimeout(300);

  /* ── 1. 首屏 ── */
  console.log('\n[1] 启动与首屏');
  const u0 = await page.evaluate(() => window.__TP.ui());
  ok(u0.veil === true, '开场面板可见');
  ok(/合/.test(u0.text) && /拍/.test(u0.text), '标题「合拍」存在');
  ok(/轻\s*折/.test(u0.text) && /深\s*折/.test(u0.text) && /极\s*折/.test(u0.text), '三档难度齐全');
  const ink = await page.evaluate(() => {
    const c = document.getElementById('cv'), g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0, vio = 0, acid = 0;
    for (let i = 0; i < d.length; i += 32) {
      if (d[i + 3] < 10) continue;
      n++;
      if (d[i + 2] > d[i] + 14 && d[i + 2] > d[i + 1] + 30) vio++;     // 紫
      if (d[i + 1] > d[i] + 20 && d[i + 1] > d[i + 2] + 20) acid++;    // 酸性绿
    }
    return { n, vio, acid };
  });
  ok(ink.n > 4000, '画布已绘制', '采样=' + ink.n);
  ok(ink.vio > 40 && ink.acid > 40, '两界色温同时存在', '紫=' + ink.vio + ' 绿=' + ink.acid);

  /* ── 2. 页面内独立复算：谱面必须与音乐同源 ── */
  console.log('\n[2] 谱面与音乐同源（页面内独立复算）');
  const chart = await page.evaluate(() => {
    const s = window.__TP.song();
    const evTimes = new Set();
    ['kick', 'snare', 'bass', 'arp', 'lead'].forEach(k => {
      (s.tracks[k] || []).forEach(e => evTimes.add(Math.round(e[0] * 1000)));
    });
    const out = { step: s.step, bars: s.bars, length: s.length, bpm: s.bpm, per: {}, orphan: {}, grid: {} };
    ['easy', 'normal', 'hard'].forEach(k => {
      const c = s.charts[k];
      out.per[k] = c.length;
      let orph = 0, off = 0;
      const seen = new Set();
      c.forEach(n => {
        if (!evTimes.has(Math.round(n[0] * 1000))) orph++;
        const q = n[0] / s.step;
        if (Math.abs(q - Math.round(q)) * s.step > 0.001) off++;
        seen.add(n[0].toFixed(3) + ':' + n[1]);
      });
      out.orphan[k] = orph;
      out.grid[k] = off;
      out.dup = (out.dup || 0) + (c.length - seen.size);
      // 上下均衡
      const up = c.filter(n => n[1] === 0).length;
      out['bal_' + k] = Math.round(Math.max(up, c.length - up) / c.length * 100);
    });
    return out;
  });
  ok(chart.bars === 32 && Math.abs(chart.length - 63.1) < 0.3, '曲目 32 小节 / 63.1s',
    chart.bars + ' 小节 ' + chart.length.toFixed(2) + 's BPM ' + chart.bpm);
  ok(chart.per.easy === 104 && chart.per.normal === 226 && chart.per.hard === 347,
    '三档音符数 104 / 226 / 347', JSON.stringify(chart.per));
  ok(chart.orphan.easy === 0 && chart.orphan.normal === 0 && chart.orphan.hard === 0,
    '每个音符都有对应发声事件', JSON.stringify(chart.orphan));
  ok(chart.grid.easy === 0 && chart.grid.normal === 0 && chart.grid.hard === 0,
    '全部音符落在 16 分网格上', JSON.stringify(chart.grid));
  ok(chart.bal_easy <= 65 && chart.bal_normal <= 65 && chart.bal_hard <= 65,
    '上下两界均衡（单侧≤65%）', 'easy ' + chart.bal_easy + '% / normal ' + chart.bal_normal + '% / hard ' + chart.bal_hard + '%');

  /* ── 3. 判定窗口（假时钟） ── */
  console.log('\n[3] 判定窗口');
  const firstNote = await page.evaluate(() => {
    window.__TP.fake(0);
    window.__TP.start(0);
    const n = window.__TP.notes(0)[0];
    return n;
  });
  const cases = [
    { off: 0.000, want: 0, name: '正中' },
    { off: 0.035, want: 0, name: '偏早 35ms' },
    { off: -0.048, want: 0, name: '偏晚 48ms' },
    { off: 0.072, want: 1, name: '偏早 72ms' },
    { off: -0.095, want: 1, name: '偏晚 95ms' },
    { off: 0.125, want: 3, name: '偏早 125ms（判 MISS）' }
  ];
  for (const c of cases) {
    const r = await page.evaluate(({ t, off }) => {
      window.__TP.fake(0);
      window.__TP.start(0);
      window.__TP.fake(t - off);
      const r = window.__TP.tap(0);
      return { res: r ? r.res : null, dt: r ? Math.round(r.dt * 1000) : null };
    }, { t: firstNote.t, off: c.off });
    ok(r.res === c.want, c.name + ' → ' + ['PERFECT', 'GOOD', '—', 'MISS'][r.res],
      '实测偏差 ' + r.dt + 'ms');
  }

  /* ── 4. 空击不罚 ── */
  console.log('\n[4] 空击与漏击');
  const empty = await page.evaluate(() => {
    window.__TP.fake(0); window.__TP.start(0);
    window.__TP.fake(0.2);       // 第一个音符在 ~8s，此刻是空白
    const before = window.__TP.state();
    const r = window.__TP.tap(1);
    const after = window.__TP.state();
    return { r, comboBefore: before.combo, comboAfter: after.combo, missBefore: before.miss, missAfter: after.miss };
  });
  ok(empty.r === null && empty.comboAfter === 0 && empty.missAfter === 0,
    '空击不计分、不罚、不改变状态');

  const miss = await page.evaluate(() => {
    window.__TP.fake(0); window.__TP.start(0);
    const n = window.__TP.notes(0)[0];
    const s = window.__TP.seek(n.t + 0.2);   // 过窗未点 → 漏击
    return s;
  });
  ok(miss.miss >= 1 && miss.combo === 0, '过窗未点自动判漏击', 'miss=' + miss.miss);

  /* ── 5. 双押 ── */
  console.log('\n[5] 合折双押');
  const dbl = await page.evaluate(() => {
    window.__TP.fake(0); window.__TP.start(1);      // normal 档双押多
    const a = window.__TP.notes(0), b = window.__TP.notes(1);
    const bset = new Map(b.map(n => [n.t.toFixed(4), n]));
    let hit = null;
    for (const n of a) {
      if (bset.has(n.t.toFixed(4))) { hit = n.t; break; }
    }
    if (hit === null) return { none: true };
    window.__TP.fake(hit);
    const r1 = window.__TP.tap(0);
    const r2 = window.__TP.tap(1);
    const st = window.__TP.state();
    return { t: hit, r1: r1 && r1.res, r2: r2 && r2.res, combo: st.combo, judged: st.judged };
  });
  ok(!dbl.none && dbl.r1 === 0 && dbl.r2 === 0 && dbl.combo === 2,
    '同一时刻两侧都能命中，连击 +2', 't=' + (dbl.t || 0).toFixed(2) + 's combo=' + dbl.combo);

  /* ── 6. 自动全连 → 满分 ── */
  console.log('\n[6] 全连结算');
  const auto = await page.evaluate(() => {
    window.__TP.fake(0);
    window.__TP.start(2);        // hard
    const s = window.__TP.auto();
    return s;
  });
  ok(auto.perfect === auto.total && auto.good === 0 && auto.miss === 0,
    '全连：全部 PERFECT', auto.perfect + '/' + auto.total);
  ok(Math.abs(auto.acc - 1) < 1e-6 && auto.rank === 'S', '准确率 100%、评级 S',
    (auto.acc * 100).toFixed(2) + '% ' + auto.rank);
  ok(auto.maxCombo === auto.total, '最大连击等于音符总数', String(auto.maxCombo));

  await page.waitForTimeout(800);
  const winUI = await page.evaluate(() => window.__TP.ui());
  ok(winUI.veil === true && /S/.test(winUI.text) && /MAX COMBO/.test(winUI.text),
    '结算面板弹出并显示评级与连击');

  /* ── 7. 全漏 → D ── */
  console.log('\n[7] 全漏结算');
  const zero = await page.evaluate(() => {
    window.__TP.fake(0);
    window.__TP.start(1);
    return window.__TP.skip();
  });
  ok(zero.miss === zero.total && zero.acc === 0 && zero.rank === 'D',
    '全部漏击 → 0%、评级 D', zero.miss + '/' + zero.total + ' ' + zero.rank);

  /* ── 8. 真实 DOM 输入链（假时钟，确定性） ── */
  console.log('\n[8] 真实 DOM 输入链');
  const box0 = await page.locator('#cv').boundingBox();
  const jy0 = await page.evaluate(() => window.__TP.judgeY());

  // 8a 上半屏点击 → 命中上界第一个音符
  // 用「增量」断言：只关心这一下点击是否恰好多出 1 个 PERFECT，
  // 不受同一帧里 updateMiss 补判更早音符的影响。
  const beforeTop = await page.evaluate(() => {
    window.__TP.fake(0); window.__TP.start(0);
    const n = window.__TP.notes(0)[0];
    window.__TP.fake(n.t);
    return window.__TP.state();
  });
  await page.waitForTimeout(60);
  await page.mouse.click(box0.x + box0.width / 2, box0.y + jy0 - 60);
  await page.waitForTimeout(80);
  const afterTop = await page.evaluate(() => window.__TP.state());
  ok(afterTop.perfect - beforeTop.perfect === 1, '上半屏真实点击命中上界音符',
    'PERFECT ' + beforeTop.perfect + ' → ' + afterTop.perfect);

  // 8b 下半屏点击 → 命中下界音符
  const beforeBot = await page.evaluate(() => {
    window.__TP.fake(0); window.__TP.start(0);
    const n = window.__TP.notes(1)[0];
    window.__TP.fake(n.t);
    return window.__TP.state();
  });
  await page.waitForTimeout(60);
  await page.mouse.click(box0.x + box0.width / 2, box0.y + jy0 + 60);
  await page.waitForTimeout(80);
  const afterBot = await page.evaluate(() => window.__TP.state());
  ok(afterBot.perfect - beforeBot.perfect === 1 &&
     afterBot.judged - beforeBot.judged >= 1, '下半屏真实点击命中下界音符',
    'PERFECT ' + beforeBot.perfect + ' → ' + afterBot.perfect);

  /* ── 9. 真实音频 ── */
  console.log('\n[9] 真实音频');
  // 重新加载页面，避免假时钟测试的残留状态干扰。
  // 注意：goto 到同一个带 hash 的 URL 不会重新执行脚本，必须加查询参数强制真实导航。
  await page.goto('file://' + path.resolve(__dirname, 'index.html') + '?r=' + Date.now() + '#dev',
    { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__TP, null, { timeout: 8000 });
  await page.waitForTimeout(250);
  await page.click('#btnGo');
  await page.waitForTimeout(900);
  const au1 = await page.evaluate(() => window.__TP.state());
  await page.waitForTimeout(900);
  const au2 = await page.evaluate(() => window.__TP.state());
  ok(au1.audio === 'running', 'AudioContext 处于 running', au1.audio);
  ok(au1.sched > 0 && au2.sched > au1.sched, '调度器持续推进',
    au1.sched + ' → ' + au2.sched + ' 事件');
  ok(au2.evs > 1000, '事件表已建立', au2.evs + ' 个发声事件');

  // 读真实输出波形：证明合成器确实在产生信号（不只是调度计数在动）
  let peak = 0;
  for (let i = 0; i < 12; i++) {
    peak = Math.max(peak, await page.evaluate(() => window.__TP.rms()));
    await page.waitForTimeout(90);
  }
  ok(peak > 0.002, '主输出有实际波形能量', 'RMS 峰值 ' + peak.toFixed(4));
  ok(au2.t > 0, '曲目时钟在走', 't=' + au2.t.toFixed(2) + 's');

  /* ── 10. 多视口布局 ── */
  console.log('\n[10] 多视口布局');
  for (const vp of [{ w: 749, h: 827 }, { w: 827, h: 749 }, { w: 420, h: 900 }, { w: 360, h: 640 }]) {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.waitForTimeout(220);
    const m = await page.evaluate(() => {
      const c = document.getElementById('cv');
      const r = c.getBoundingClientRect();
      return {
        jy: window.__TP.judgeY(),
        cvh: Math.round(r.height), cvw: Math.round(r.width),
        docH: document.documentElement.scrollHeight,
        winH: window.innerHeight,
        docW: document.documentElement.scrollWidth,
        winW: window.innerWidth
      };
    });
    const centered = Math.abs(m.jy - m.cvh / 2) <= 2;
    ok(m.docH <= m.winH + 1 && m.docW <= m.winW + 1, vp.w + 'x' + vp.h + ' 无溢出',
      'doc=' + m.docH + '/' + m.winH);
    ok(centered, vp.w + 'x' + vp.h + ' 判定线在画布正中',
      'jy=' + m.jy + ' 画布高=' + m.cvh);
  }

  /* ── 11. 运行时错误 ── */
  console.log('\n[11] 运行时错误');
  ok(errors.length === 0, '无 console/page 错误', errors.slice(0, 3).join(' | '));

  await browser.close();
  console.log('\n' + '─'.repeat(30));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})();
