# -*- coding: utf-8 -*-
"""
FOLD BEAT 音乐与谱面生成器

设计原则：谱面不是手写的，而是**从音乐事件派生**。
每个 tap 音符都对应一个真实发声的音符，因此音画必然同步；
反过来，任何音乐改动都会自动反映到谱面，不会出现「音乐改了谱面没改」的错位。

输出 tools/beat.json：
  bpm / step / length
  tracks: {inst: [[t, midi, vel], ...]}   合成器要播的事件
  sections: [{name, t}]                   段落标记（用于 UI 显示进度）
  charts: {easy|normal|hard: [[t, side], ...]}  side: 0=上界 1=下界
"""
import json
import math

BPM = 124
BEAT = 60.0 / BPM
STEP = BEAT / 4.0          # 16 分音符
BAR = BEAT * 4

# 段落：前奏 2 小节热身（再长玩家会以为卡住），A/B/C 共 26 小节，尾奏 4 小节
SEC = [('前奏', 2), ('A', 10), ('B', 8), ('C', 8), ('尾奏', 4)]
TOTAL_BARS = sum(n for _, n in SEC)
CHART_FROM, CHART_TO = 2, TOTAL_BARS - 4    # 有音符的小节区间

# 和弦进行：Am - F - C - G（vi-IV-I-V），每小节一个
CHORDS = [
    ('Am', 45, [0, 3, 7]),   # A2  A C E
    ('F',  41, [0, 4, 7]),   # F2  F A C
    ('C',  48, [0, 4, 7]),   # C3  C E G
    ('G',  43, [0, 4, 7]),   # G2  G B D
]

# 主旋律动机：4 小节一个循环，八分音符网格（每小节 8 格）
# 每个元素 (格位, midi)，留空表示延音
MOTIF = [
    [(0, 69), (2, 72), (4, 76), (6, 74)],   # Am  A4 C5 E5 D5
    [(0, 72), (2, 69), (4, 65), (6, 69)],   # F   C5 A4 F4 A4
    [(0, 67), (2, 76), (4, 79), (6, 76)],   # C   G4 E5 G5 E5
    [(0, 74), (2, 71), (4, 67), (6, 71)],   # G   D5 B4 G4 B4
]

# B 段变奏：把动机尾部改成上行经过句，避免 8 小节原样重复
MOTIF_B = [
    [(0, 69), (2, 72), (4, 76), (6, 81)],   # 冲到 A5
    [(0, 79), (2, 76), (4, 72), (6, 76)],
    [(0, 67), (2, 72), (4, 76), (6, 79)],
    [(0, 74), (2, 71), (4, 67), (6, 64)],   # 落回 E4，为下一轮蓄力
]


def bar_chord(bar):
    return CHORDS[bar % 4]


def section_of(bar):
    acc = 0
    for name, n in SEC:
        if bar < acc + n:
            return name, bar - acc, n
        acc += n
    return SEC[-1][0], 0, SEC[-1][1]


def t_of(bar, step=0.0):
    """小节 + 16 分格位 → 绝对秒数。"""
    return bar * BAR + step * STEP


def build():
    tracks = {'kick': [], 'snare': [], 'hat': [], 'openhat': [],
              'bass': [], 'arp': [], 'lead': [], 'pad': []}
    for bar in range(TOTAL_BARS):
        name, bi, bn = section_of(bar)
        cname, root, triad = bar_chord(bar)
        intro = name == '前奏'
        outro = name == '尾奏'
        dense = name in ('B', 'C')

        # ── pad：每小节一个和弦长音，铺底 ──
        for k, iv in enumerate(triad):
            tracks['pad'].append((t_of(bar), root + 12 + iv, 0.30))
        # ── arp：16 分琶音，和弦音上下往返 ──
        pat = [0, 1, 2, 1]
        for s in range(16):
            iv = triad[pat[s % 4]] + (12 if s >= 8 else 0)
            vel = 0.34 if s % 4 == 0 else 0.22
            tracks['arp'].append((t_of(bar, s), root + 24 + iv, vel))
        # ── bass：八分音符，第 3、7 个跳八度 ──
        if not intro:
            for s in range(0, 16, 2):
                oct_shift = 12 if s in (4, 12) else 0
                vel = 0.95 if s % 4 == 0 else 0.72
                tracks['bass'].append((t_of(bar, s), root + oct_shift, vel))
        # ── kick：四拍落地 ──
        if not intro:
            for b in range(4):
                tracks['kick'].append((t_of(bar, b * 4), 36, 1.0))
        # ── snare：2、4 拍 ──
        if name in ('A', 'B', 'C'):
            for b in (1, 3):
                tracks['snare'].append((t_of(bar, b * 4), 38, 0.95))
        # ── hat：八分，正拍弱反拍强 ──
        for s in range(0, 16, 2):
            vel = 0.30 if s % 4 == 0 else 0.46
            tracks['hat'].append((t_of(bar, s), 42, vel))
        # ── openhat：C 段每拍反拍加开镲，抬高能量 ──
        if name == 'C':
            for s in (2, 10):
                tracks['openhat'].append((t_of(bar, s), 46, 0.5))
        # ── 16 分 hi-hat 细碎：只有 C 段 ──
        if name == 'C':
            for s in range(1, 16, 4):
                tracks['hat'].append((t_of(bar, s), 42, 0.18))
        # ── lead：主旋律 ──
        if name in ('A', 'B', 'C'):
            motif = MOTIF_B if name == 'B' else MOTIF
            transpose = 12 if name == 'C' else 0
            for st, midi in motif[bi % 4]:
                if outro:
                    continue
                tracks['lead'].append((t_of(bar, st), midi + transpose, 0.72))

    for k in tracks:
        tracks[k].sort(key=lambda e: (e[0], e[1]))

    length = t_of(TOTAL_BARS) + 1.2
    sections = []
    acc = 0
    for name, n in SEC:
        sections.append({'name': name, 't': t_of(acc), 'bar': acc, 'bars': n})
        acc += n
    return tracks, sections, length


# ══════════════ 谱面派生 ══════════════

def derive(tracks):
    """从音乐事件派生三档谱面。返回 {难度: [{t, side, src}]}。"""
    charts = {}

    # ── 轻折：一拍一个，落在 kick/主旋律的强拍上，左右交替 ──
    easy = []
    for bar in range(CHART_FROM, CHART_TO):
        for b in range(4):
            easy.append({'t': t_of(bar, b * 4), 'src': 'beat'})
    charts['easy'] = assign_sides(easy, max_run=2, double_rate=0.0)

    # ── 深折：正拍 + 反拍贝斯，强拍上按比例出双押 ──
    normal = []
    for bar in range(CHART_FROM, CHART_TO):
        for b in range(4):
            normal.append({'t': t_of(bar, b * 4), 'src': 'beat'})
            normal.append({'t': t_of(bar, b * 4 + 2), 'src': 'off8'})
    charts['normal'] = assign_sides(normal, max_run=2, double_rate=0.18)

    # ── 极限折：16 分连打 + 更密的双押 ──
    hard = []
    for bar in range(CHART_FROM, CHART_TO):
        for b in range(4):
            hard.append({'t': t_of(bar, b * 4), 'src': 'beat'})
            hard.append({'t': t_of(bar, b * 4 + 2), 'src': 'off8'})
            if b in (1, 3):
                hard.append({'t': t_of(bar, b * 4 + 1), 'src': 'off16'})
                hard.append({'t': t_of(bar, b * 4 + 3), 'src': 'off16'})
    charts['hard'] = assign_sides(hard, max_run=3, double_rate=0.30)
    return charts


def assign_sides(notes, max_run, double_rate):
    """给音符分上下界。

    规则：以「换边」为主（58%），允许小幅连打同侧（42%），同侧连续不超过 max_run；
    双押只出现在强拍上，按 double_rate 概率触发，避免密集段落出现连续双押。
    伪随机用固定种子，保证每次生成完全一致，回归测试才有意义。
    """
    notes = sorted(notes, key=lambda n: n['t'])
    merged = []
    for n in notes:
        if merged and abs(merged[-1]['t'] - n['t']) < 1e-6:
            merged[-1]['double'] = True     # 同一时刻两个来源 → 双押
        else:
            merged.append({'t': n['t'], 'double': False, 'src': n['src']})

    seed = 20261107
    out = []
    run = 0
    last = -1
    for n in merged:
        seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
        r = seed / 0x7FFFFFFF
        if n['double'] or (n['src'] == 'beat' and r < double_rate):
            out.append([round(n['t'], 6), 0])
            out.append([round(n['t'], 6), 1])
            run = 0
            last = -1
            continue
        if last < 0:
            side = 0 if r < 0.5 else 1
        elif run >= max_run:
            side = 1 - last
        elif r < 0.58:
            side = 1 - last
        else:
            side = last
        out.append([round(n['t'], 6), side])
        run = run + 1 if side == last else 1
        last = side
    out.sort(key=lambda x: (x[0], x[1]))
    return out


def verify(tracks, charts):
    """对生成结果做硬性校验：任何一条不满足就不许写盘。"""
    bad = []
    # 1) 所有事件必须落在 16 分网格上（误差 < 1ms）
    for inst, evs in tracks.items():
        for t, midi, vel in evs:
            k = t / STEP
            if abs(k - round(k)) * STEP > 0.001:
                bad.append('%s 事件 %.4f 不在 16 分网格上' % (inst, t))
    # 2) 音高与音量在合理范围
    for inst, evs in tracks.items():
        for t, midi, vel in evs:
            if not (0 <= midi <= 127):
                bad.append('%s 音高越界 %d' % (inst, midi))
            if not (0 < vel <= 1.0):
                bad.append('%s 音量越界 %.2f' % (inst, vel))

    stats = {}
    for name, notes in charts.items():
        total = len(notes)
        if total < 60:
            bad.append('%s 音符过少 %d' % (name, total))
        # 3) 同一时刻最多两个音符（上、下各一），不允许三押
        by_t = {}
        for t, side in notes:
            by_t.setdefault(t, []).append(side)
        for t, ss in by_t.items():
            if len(ss) != len(set(ss)):
                bad.append('%s 在 %.3fs 出现同侧重叠' % (name, t))
            if len(ss) > 2:
                bad.append('%s 在 %.3fs 音符过多 %d' % (name, t, len(ss)))
        # 4) 相邻不同时刻的最小间隔（难点：极限档允许 16 分 ≈ 121ms）
        times = sorted(set(t for t, _ in notes))
        gaps = [round(b - a, 6) for a, b in zip(times, times[1:])]
        mgg = min(gaps) if gaps else 0
        limit = {'easy': 0.30, 'normal': 0.20, 'hard': 0.10}[name]
        if mgg < limit:
            bad.append('%s 最小间隔 %.3fs 小于 %.2fs' % (name, mgg, limit))
        # 5) 上下均衡：任何一侧不超过 65%
        up = sum(1 for _, s in notes if s == 0)
        dn = total - up
        if max(up, dn) / total > 0.65:
            bad.append('%s 上下失衡 上%d 下%d' % (name, up, dn))
        # 6) 音符必须对得上真实发声事件
        ev_times = set()
        for inst, evs in tracks.items():
            if inst in ('kick', 'snare', 'bass', 'lead', 'arp'):
                for t, midi, vel in evs:
                    ev_times.add(round(t, 6))
        orphan = [t for t, _ in notes if round(t, 6) not in ev_times]
        if orphan:
            bad.append('%s 有 %d 个音符无对应发声（首个 %.3f）' % (name, len(orphan), orphan[0]))
        doubles = sum(1 for t, ss in by_t.items() if len(ss) == 2)
        stats[name] = {'notes': total, 'min_gap': round(mgg, 3),
                       'up': up, 'down': dn, 'doubles': doubles,
                       'per_sec': round(total / (TOTAL_BARS * BAR), 2)}
    return bad, stats


def main():
    tracks, sections, length = build()
    charts = derive(tracks)
    bad, stats = verify(tracks, charts)
    if bad:
        raise SystemExit('自检失败:\n  ' + '\n  '.join(bad[:12]))

    data = {
        'bpm': BPM, 'beat': round(BEAT, 6), 'step': round(STEP, 6),
        'bar': round(BAR, 6), 'bars': TOTAL_BARS, 'length': round(length, 4),
        'sections': sections,
        'tracks': {k: [[round(t, 6), m, round(v, 3)] for t, m, v in v] for k, v in tracks.items()},
        'charts': charts,
    }
    with open('tools/beat.json', 'w') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))

    print('BPM %d  时长 %.1fs  小节 %d  16分格 %.1fms' % (BPM, length, TOTAL_BARS, STEP * 1000))
    for inst, evs in tracks.items():
        print('  %-8s %4d 事件' % (inst, len(evs)))
    print()
    for name in ('easy', 'normal', 'hard'):
        s = stats[name]
        print('  %-7s %4d 音符  密度 %.2f/s  最小间隔 %.0fms  上%d/下%d  双押 %d' % (
            name, s['notes'], s['per_sec'], s['min_gap'] * 1000, s['up'], s['down'], s['doubles']))
    print('\n自检通过：事件在网格上、无同侧重叠、上下均衡、每个音符都有对应发声')


if __name__ == '__main__':
    main()
