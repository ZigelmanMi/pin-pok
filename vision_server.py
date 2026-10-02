#!/usr/bin/env python3
"""Local card-vision HTTP server for the Chrome extension.

  python3 /home/z/pok/vision_server.py

Listens on http://127.0.0.1:8765
  GET  /health
  POST /read   JSON { "image": "data:image/png;base64,..." }
"""
from __future__ import annotations

import base64
import io
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image

from card_vision import detect_card_regions, read_card

HOST = '127.0.0.1'
PORT = 8765


def decode_image(data_url: str) -> Image.Image:
    raw = data_url.split(',', 1)[-1]
    return Image.open(io.BytesIO(base64.b64decode(raw))).convert('RGB')


def read_table(img: Image.Image) -> dict:
    w, h = img.size
    regions = detect_card_regions(img)
    cards = []
    for r in regions:
        got = read_card(img, r)
        if not (got.get('read') and got.get('rank') and got.get('suit')):
            continue
        cards.append({
            'rank': got['rank'],
            'suit': got['suit'],
            'conf': float(got.get('conf') or 0),
            'x': r['x'], 'y': r['y'], 'w': r['w'], 'h': r['h'],
        })

    bottom = [c for c in cards if c['y'] > h * 0.55]
    if len(bottom) < 2:
        bottom = sorted(cards, key=lambda c: -c['y'])[:4]
    hero = sorted(bottom, key=lambda c: c['x'])[:2]
    used = {(c['rank'], c['suit']) for c in hero}

    board = [
        c for c in cards
        if (c['rank'], c['suit']) not in used and h * 0.18 <= c['y'] <= h * 0.58
    ]
    if len(board) >= 2:
        board.sort(key=lambda c: c['y'])
        med = board[len(board) // 2]['y']
        board = [c for c in board if abs(c['y'] - med) < max(36, 0.06 * h)]
    board = sorted(board, key=lambda c: c['x'])[:5]

    return {
        'myCards': [{'rank': c['rank'], 'suit': c['suit']} for c in hero],
        'communityCards': [{'rank': c['rank'], 'suit': c['suit']} for c in board],
        'boxes': len(regions),
        'reads': len(cards),
        'source': 'py',
        'size': [w, h],
    }


class Handler(BaseHTTPRequestHandler):
    def _cors(self) -> None:
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Private-Network', 'true')

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:
        if self.path.split('?', 1)[0] != '/health':
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self._cors()
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"ok":true,"engine":"card_vision"}')

    def do_POST(self) -> None:
        if self.path.split('?', 1)[0] != '/read':
            self.send_response(404)
            self.end_headers()
            return
        n = int(self.headers.get('Content-Length') or '0')
        try:
            body = json.loads(self.rfile.read(n) or b'{}')
            img = decode_image(body.get('image') or '')
            result = read_table(img)
            payload = json.dumps(result).encode()
            self.send_response(200)
            self._cors()
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(payload)
        except Exception as e:
            err = json.dumps({'error': str(e), 'myCards': [], 'communityCards': []}).encode()
            self.send_response(500)
            self._cors()
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(err)

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write('[vision-server] ' + (fmt % args) + '\n')


if __name__ == '__main__':
    print(f'Poker card vision: http://{HOST}:{PORT}/read', flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
