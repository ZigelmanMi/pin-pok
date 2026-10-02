#!/usr/bin/env node
// Fast unit test of SVG decode + card parse (no browser).
const fs = require('fs');
const vm = require('vm');

const code = fs.readFileSync(__dirname + '/card_parser.js', 'utf8');
const window = {};
const ctx = {
  window,
  console,
  TextDecoder,
  Uint8Array,
  atob,
  btoa,
  document: {
    querySelectorAll: () => [],
    body: { innerText: 'Банк: $ 3.91\nКолл: $ 0.50\nСтавки: $ 0.01/$ 0.02' },
    querySelector: () => null,
  },
};
vm.createContext(ctx);
vm.runInContext(code, ctx);

const u = window.PokerParseUtils;
if (!u) {
  console.error('PokerParseUtils missing');
  process.exit(1);
}

function svgUri(rank, suit) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text>${rank}${suit}</text></svg>`;
  const b64 = Buffer.from(svg, 'utf8').toString('base64');
  return 'data:image/svg+xml;base64,' + b64;
}

const cases = [
  ['A', '♠', 'A', 's'],
  ['K', '♥', 'K', 'h'],
  ['7', '♦', '7', 'd'],
  ['6', '♦', '6', 'd'],
  ['J', '♣', 'J', 'c'],
  ['10', '♠', 'T', 's'],
];

let fails = 0;
for (const [rank, sym, er, es] of cases) {
  const uri = svgUri(rank, sym);
  const decoded = u.decodeSvgDataUri(uri);
  const card = u.parseCardFromSVG(decoded);
  const ok = card && card.rank === er && card.suit === es && decoded.includes(sym);
  console.log((ok ? 'OK ' : 'FAIL'), rank + sym, '->', card, 'hasSym', decoded && decoded.includes(sym));
  if (!ok) fails++;
}

// Old broken decode: decodeURIComponent(atob(utf8)) should fail on ♠
const svg = '<svg><text>A♠</text></svg>';
const b64 = Buffer.from(svg, 'utf8').toString('base64');
let oldThrew = false;
try {
  decodeURIComponent(Buffer.from(b64, 'base64').toString('binary'));
} catch (e) {
  oldThrew = true;
}
const newOk = u.decodeBase64Utf8(b64).includes('♠');
console.log('old decodeURIComponent(atob) throws:', oldThrew, '| new utf8 ok:', newOk);
if (!newOk) fails++;

// Path-based diamond (no unicode)
const diamondSvg = '<svg><text>9</text><path d="M10 0 L20 15 L10 30 L0 15 Z" fill="#e53935"/></svg>';
const dcard = u.parseCardFromSVG(diamondSvg);
console.log('path diamond:', dcard);
if (!(dcard && dcard.rank === '9' && dcard.suit === 'd')) fails++;

console.log('fails:', fails);
process.exit(fails ? 1 : 0);
