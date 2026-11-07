# -*- coding: utf-8 -*-
"""把 tools/beat.json 注入 index.src.html，产出单文件 index.html。

单文件交付（零外部请求）是这一系列作品的硬要求；
但把 36KB 的 JSON 手写进 HTML 会让源码没法维护，所以保留模板 + 构建两步。
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    src = open(os.path.join(ROOT, 'index.src.html'), encoding='utf-8').read()
    data = json.load(open(os.path.join(ROOT, 'tools/beat.json'), encoding='utf-8'))
    payload = json.dumps(data, ensure_ascii=False, separators=(',', ':'))

    token = '/*__SONG__*/null'
    if src.count(token) != 1:
        raise SystemExit('模板里应有且只有一个注入点，实际 %d 个' % src.count(token))

    out = src.replace(token, payload)
    with open(os.path.join(ROOT, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(out)

    print('index.html  %d KB' % (len(out.encode('utf-8')) / 1024))
    print('曲目 %d 小节 / %.1fs / BPM %d' % (data['bars'], data['length'], data['bpm']))
    for k in ('easy', 'normal', 'hard'):
        print('  %-7s %d 音符' % (k, len(data['charts'][k])))


if __name__ == '__main__':
    main()
