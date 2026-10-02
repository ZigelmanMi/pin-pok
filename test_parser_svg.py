#!/usr/bin/env python3
"""Verify v3.3 SVG parser: UTF-8 suits, hero/board split, pot/bet."""
import asyncio
import base64
from pathlib import Path

from playwright.async_api import async_playwright

DIR = Path(__file__).parent


def svg_uri(rank, suit_char):
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="60" height="84">'
        f'<text x="8" y="28" font-size="22">{rank}{suit_char}</text>'
        f'</svg>'
    )
    b64 = base64.b64encode(svg.encode('utf-8')).decode('ascii')
    return f'data:image/svg+xml;base64,{b64}'


HTML = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;width:1000px;height:800px;background:#1b1;">
  <div class="r-card" style="position:absolute;top:300px;left:300px;width:60px;height:84px;background-image:url('{svg_uri('A','♠')}')"></div>
  <div class="r-card" style="position:absolute;top:300px;left:370px;width:60px;height:84px;background-image:url('{svg_uri('K','♥')}')"></div>
  <div class="r-card" style="position:absolute;top:300px;left:440px;width:60px;height:84px;background-image:url('{svg_uri('7','♦')}')"></div>
  <div class="r-card" style="position:absolute;top:620px;left:430px;width:52px;height:72px;background-image:url('{svg_uri('6','♦')}')"></div>
  <div class="r-card" style="position:absolute;top:620px;left:490px;width:52px;height:72px;background-image:url('{svg_uri('J','♣')}')"></div>
  <div class="bar-text top-line player-name" style="position:absolute;top:710px;left:430px;">mimi88</div>
  <div class="bar-text bottom-line player-cash" style="position:absolute;top:735px;left:430px;">$ 1.27</div>
  <div>Банк: $ 3.91</div>
  <div>Ставки: $ 0.01/$ 0.02</div>
  <div>Колл: $ 0.50</div>
  <div class="bar-text top-line player-name" style="position:absolute;top:80px;left:400px;">PokerLady</div>
  <div class="bar-text bottom-line player-cash" style="position:absolute;top:105px;left:400px;">$ 2.43</div>
</body></html>
"""


async def main():
    html_path = Path('/tmp/pa-svg-test/index.html')
    html_path.parent.mkdir(exist_ok=True)
    html_path.write_text(HTML, encoding='utf-8')

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(viewport={'width': 1000, 'height': 800})
        await page.goto(html_path.as_uri())
        await page.evaluate(Path(DIR, 'card_parser.js').read_text(encoding='utf-8'))

        # UTF-8 decode of a suit symbol must not throw
        decode_ok = await page.evaluate("""() => {
          const svg = '<svg><text>A♠</text></svg>';
          const b64 = btoa(unescape(encodeURIComponent(svg)));
          const uri = 'data:image/svg+xml;base64,' + b64;
          const decoded = window.PokerParseUtils.decodeSvgDataUri(uri);
          const card = window.PokerParseUtils.parseCardFromSVG(decoded);
          return { decodedHasSpade: decoded.indexOf('♠') !== -1, card };
        }""")
        print('decode:', decode_ok)

        state = await page.evaluate("""() => {
          const p = new window.PokerCardParserCore();
          return p.getState();
        }""")
        print('state:', state)
        my = [c['rank'] + c['suit'] for c in state.get('myCards') or []]
        board = [c['rank'] + c['suit'] for c in state.get('communityCards') or []]
        ok = (
            my == ['6d', 'Jc']
            and board == ['As', 'Kh', '7d']
            and abs(state.get('pot') - 3.91) < 0.001
            and abs(state.get('betToCall') - 0.50) < 0.001
            and state.get('stage') == 'flop'
            and state.get('numPlayers') >= 2
        )
        print('PASS' if ok else 'FAIL', 'hero', my, 'board', board,
              'pot', state.get('pot'), 'bet', state.get('betToCall'),
              'stage', state.get('stage'), 'players', state.get('numPlayers'))
        await browser.close()
        raise SystemExit(0 if ok else 1)


if __name__ == '__main__':
    asyncio.run(main())
