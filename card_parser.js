// =====================================================================
// Poker Assistant — Shared Card Parser & UI helpers (content scripts)
// v3.3 — UTF-8 SVG decode, suit-from-path (not red=hearts), viewport zones
// =====================================================================

(function () {
  'use strict';

  var SUIT_MAP = { '♠': 's', '♥': 'h', '♦': 'd', '♣': 'c', '♤': 's', '♡': 'h', '♢': 'd', '♧': 'c' };
  var VALID_SUITS = { s: 1, h: 1, d: 1, c: 1 };
  var RANK_TOKEN = '(?:10|[AKQJT2-9])';

  function normalizeRank(r) {
    if (r === '10') return 'T';
    return String(r).toUpperCase();
  }

  function parseMoney(str) {
    if (!str) return 0;
    var m = String(str).match(/([\d.,\s]+)/);
    if (!m) return 0;
    var s = m[1].replace(/\s/g, '');
    if (s.indexOf(',') !== -1 && s.indexOf('.') !== -1) {
      s = s.replace(/,/g, '');
    } else if (s.indexOf(',') !== -1) {
      var parts = s.split(',');
      if (parts.length === 2 && parts[1].length <= 2 && parts[0].length <= 4) {
        s = s.replace(',', '.');
      } else {
        s = s.replace(/,/g, '');
      }
    }
    var v = parseFloat(s);
    return isNaN(v) ? 0 : v;
  }

  function decodeBase64Utf8(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
    try {
      return new TextDecoder('utf-8').decode(bytes);
    } catch (e) {
      try { return decodeURIComponent(escape(bin)); } catch (e2) { return bin; }
    }
  }

  function decodeSvgDataUri(uri) {
    if (!uri) return null;
    var m = String(uri).match(/data:image\/svg\+xml([^,]*),([A-Za-z0-9+/=%\s._-]+)/i);
    if (!m) return null;
    var meta = (m[1] || '').toLowerCase();
    var data = m[2].replace(/\s/g, '');
    try {
      if (meta.indexOf('base64') !== -1) return decodeBase64Utf8(data);
      return decodeURIComponent(data);
    } catch (e) {
      return null;
    }
  }

  function decodeEntities(s) {
    if (!s) return s;
    return String(s)
      .replace(/&spades;|&#9824;|&#x2660;/gi, '♠')
      .replace(/&hearts;|&#9829;|&#x2665;/gi, '♥')
      .replace(/&diams;|&#9830;|&#x2666;/gi, '♦')
      .replace(/&clubs;|&#9827;|&#x2663;/gi, '♣')
      .replace(/&#x2664;/gi, '♤')
      .replace(/&#x2661;/gi, '♡')
      .replace(/&#x2662;/gi, '♢')
      .replace(/&#x2663;/gi, '♧');
  }

  function parseCardToken(text) {
    if (!text) return null;
    var t = decodeEntities(String(text)).replace(/\s+/g, '');
    var m = t.match(new RegExp('(' + RANK_TOKEN + ')([♠♥♦♣♤♡♢♧])'));
    if (m) return { rank: normalizeRank(m[1]), suit: SUIT_MAP[m[2]] };
    m = t.match(new RegExp('([♠♥♦♣♤♡♢♧])(' + RANK_TOKEN + ')'));
    if (m) return { rank: normalizeRank(m[2]), suit: SUIT_MAP[m[1]] };
    m = t.match(new RegExp('(' + RANK_TOKEN + ')([hdcs])$', 'i'));
    if (m) return { rank: normalizeRank(m[1]), suit: m[2].toLowerCase() };
    return null;
  }

  function colorFamily(svg) {
    var s = String(svg).toLowerCase();
    if (/#(?:e[0-9a-f]{5}|f[0-9a-f]{5}|ff0000|e53935|f44336|d32f2f|c62828|e74c3c|c0392b)|fill=["']red|rgb\(\s*2[0-9]{2}/i.test(s)) {
      return 'red';
    }
    if (/#(?:000|111|222|1a1a1a|212121|black)|fill=["']black/i.test(s)) {
      return 'black';
    }
    return null;
  }

  function inferSuitFromSvg(svg) {
    var lower = decodeEntities(String(svg)).toLowerCase();
    if (/heart|черв|♥|♡|#heart|suit-h\b/.test(lower)) return 'h';
    if (/diamond|бубн|♦|♢|#diamond|suit-d\b/.test(lower)) return 'd';
    if (/spade|пик|#spade|♠|♤|suit-s\b/.test(lower)) return 's';
    if (/club|треф|#club|♣|♧|suit-c\b/.test(lower)) return 'c';

    var paths = [];
    var re = /<path\b([^>]*)>/gi;
    var pm;
    while ((pm = re.exec(svg))) {
      var attrs = pm[1] || '';
      var d = (attrs.match(/\bd=["']([^"']+)/i) || [])[1] || '';
      var fill = (attrs.match(/\bfill=["']([^"']+)/i) || [])[1] || '';
      if (!d || d.length < 8 || /none/i.test(fill)) continue;
      paths.push({ d: d, fill: fill, len: d.length });
    }
    if (!paths.length) {
      var fam0 = colorFamily(svg);
      return fam0 === 'red' ? null : null; // never guess h vs d / s vs c from color alone
    }
    paths.sort(function (a, b) { return b.len - a.len; });
    var suitPaths = paths.filter(function (p) {
      return !/[Aa]{2,}|rx=|rounded|card-outline/i.test(p.d);
    });
    if (!suitPaths.length) suitPaths = paths.slice(Math.min(1, paths.length - 1));
    var p = suitPaths[0];
    var d = p.d;
    var curves = (d.match(/[CcQqSsTt]/g) || []).length;
    var lines = (d.match(/[LlHhVv]/g) || []).length;
    var moves = (d.match(/[Mm]/g) || []).length;
    var arcs = (d.match(/[Aa]/g) || []).length;
    var fam = colorFamily(p.fill + ' ' + svg);

    if (fam === 'red') {
      if (lines >= 3 && curves <= 2) return 'd';
      return 'h';
    }
    if (fam === 'black' || !fam) {
      if (arcs >= 2 || moves >= 3) return 'c';
      if (lines >= 4 && curves <= 2) return 's';
      return fam === 'black' ? 's' : null;
    }
    return null;
  }

  function parseCardFromSVG(svg) {
    if (!svg) return null;
    svg = decodeEntities(svg);

    var texts = [];
    var textRe = /<(?:text|tspan)[^>]*>([^<]*)<\/(?:text|tspan)>/g;
    var tm;
    while ((tm = textRe.exec(svg))) {
      var t = (tm[1] || '').trim();
      if (t) texts.push(t);
    }
    var joined = texts.join(' ');
    var card = parseCardToken(joined);
    if (card) return card;
    for (var i = 0; i < texts.length; i++) {
      card = parseCardToken(texts[i]);
      if (card) return card;
    }

    var textOnly = svg.replace(/<path\b[^>]*>/gi, '').replace(/\bd=["'][^"']+["']/gi, '');
    var m = textOnly.match(new RegExp('(' + RANK_TOKEN + ')\\s*([♠♥♦♣♤♡♢♧])'));
    if (m) return { rank: normalizeRank(m[1]), suit: SUIT_MAP[m[2]] };
    m = textOnly.match(new RegExp('(' + RANK_TOKEN + ')([hdcs])(?![a-zA-Z0-9])', 'i'));
    if (m) return { rank: normalizeRank(m[1]), suit: m[2].toLowerCase() };

    m = joined.match(new RegExp('^\\s*(' + RANK_TOKEN + ')\\s*$')) ||
        textOnly.match(new RegExp('>(\\s*' + RANK_TOKEN + '\\s*)<'));
    if (m) {
      var suit = inferSuitFromSvg(svg);
      if (suit && VALID_SUITS[suit]) {
        return { rank: normalizeRank(m[1].trim()), suit: suit };
      }
    }
    return null;
  }

  function parseCardFromElement(el) {
    if (!el) return null;
    var ds = el.dataset || {};
    if (ds.card) {
      var c = parseCardToken(ds.card);
      if (c) return c;
    }
    if (ds.rank && ds.suit) {
      var suit = String(ds.suit).toLowerCase();
      if (SUIT_MAP[ds.suit]) suit = SUIT_MAP[ds.suit];
      if (VALID_SUITS[suit]) return { rank: normalizeRank(ds.rank), suit: suit };
    }
    var attrs = [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('alt')];
    for (var i = 0; i < attrs.length; i++) {
      c = parseCardToken(attrs[i] || '');
      if (c) return c;
    }
    var cls = (el.className && el.className.toString) ? el.className.toString() : '';
    var cm = cls.match(/(?:^|[\s_-])(10|[AKQJT2-9])([hdcs])(?:$|[\s_-])/i);
    if (cm) return { rank: normalizeRank(cm[1]), suit: cm[2].toLowerCase() };

    var bg = '';
    try { bg = (el.style && el.style.backgroundImage) || ''; } catch (e) { /* ignore */ }
    if (!bg || bg.indexOf('svg') === -1) {
      try { bg = getComputedStyle(el).backgroundImage || bg; } catch (e2) { /* ignore */ }
    }
    var svg = decodeSvgDataUri(bg);
    if (svg) {
      c = parseCardFromSVG(svg);
      if (c) return c;
    }

    var img = el.tagName === 'IMG' ? el : el.querySelector && el.querySelector('img');
    if (img && img.src) {
      svg = decodeSvgDataUri(img.src);
      if (svg) {
        c = parseCardFromSVG(svg);
        if (c) return c;
      }
      c = parseCardToken(img.alt || img.src.split('/').pop() || '');
      if (c) return c;
    }

    var inline = el.tagName === 'SVG' ? el : el.querySelector && el.querySelector('svg');
    if (inline) {
      c = parseCardFromSVG(inline.outerHTML || '');
      if (c) return c;
    }

    var txt = ((el.innerText || el.textContent || '') + '').replace(/\s+/g, '');
    if (txt.length <= 8) {
      c = parseCardToken(txt);
      if (c) return c;
    }
    return null;
  }

  function isFaceDown(el) {
    if (!el) return false;
    var cls = (el.className && el.className.toString) ? el.className.toString() : '';
    return /back|facedown|face-down|hidden-card|card-back|рубашк/i.test(cls);
  }

  function classText(el) {
    if (!el) return '';
    try {
      if (typeof el.className === 'string') return el.className;
      if (el.className && el.className.baseVal) return String(el.className.baseVal);
      return el.getAttribute && (el.getAttribute('class') || '') || '';
    } catch (e) {
      return '';
    }
  }

  function isJunkPlayerName(name) {
    if (!name || name.length < 2 || name.length > 28) return true;
    return /не\s*занято|свободно|пусто|empty|vacant|отош[её]л|sit\s*out|away|банк|pot|ставк|blinds?|колл|call|check|фолд|fold|lucky|hold.?em|dealer|дилер|итого/i.test(name);
  }

  function findSeatRoot(el) {
    var n = el;
    for (var i = 0; i < 10 && n && n !== document.body; i++) {
      if (/r-seat|r-player|player-bar|player-box|player-info|seat-/i.test(classText(n))) return n;
      n = n.parentElement;
    }
    return el.parentElement || el;
  }

  function seatStatus(root, name) {
    if (isJunkPlayerName(name) || /не\s*занято|empty|vacant/i.test(name || '')) return 'empty';
    var blob = name || '';
    var node = root;
    for (var i = 0; i < 5 && node && node !== document.body; i++) {
      blob += ' ' + classText(node);
      try { blob += ' ' + (node.getAttribute('data-status') || '') + ' ' + (node.getAttribute('data-state') || ''); } catch (e) { /* ignore */ }
      node = node.parentElement;
    }
    try { blob += ' ' + String((root.innerText || '')).slice(0, 180); } catch (e2) { /* ignore */ }
    if (/sit-?out|sitting.?out|отош[её]л|away|afk/i.test(blob)) return 'sitout';
    if (/(?:^|[\s_-])(?:fold|folded|is-fold|isFolded)(?:$|[\s_-])/i.test(blob) || /фолд|\bпас\b/i.test(blob)) return 'folded';
    try {
      var st = getComputedStyle(root);
      var op = parseFloat(st.opacity);
      if (isFinite(op) && op > 0 && op < 0.78) return 'folded';
      var vis = st.visibility;
      if (vis === 'hidden') return 'empty';
      if (/grayscale\(|brightness\(\s*0?\.[0-6]/i.test(st.filter || '')) return 'folded';
    } catch (e3) { /* ignore */ }
    var cards = [];
    try { cards = root.querySelectorAll('.r-card, [class*="hole-card"], [class*="card-back"], [class*="close-card"]'); } catch (e4) { cards = []; }
    if (cards && cards.length >= 2) return 'active';
    return 'active';
  }
    constructor(opts) {
      this.opts = opts || {};
    }

    scanAllCards() {
      var cards = [];
      var seenPos = {};
      var seenEl = typeof WeakSet !== 'undefined' ? new WeakSet() : null;

      var isCardBox = function (rect) {
        if (!rect || rect.width < 32 || rect.height < 40) return false;
        if (rect.width > 200 || rect.height > 280) return false;
        var ar = rect.width / rect.height;
        return ar >= 0.45 && ar <= 1.15;
      };

      var add = function (el, card) {
        if (!card || !card.rank || !VALID_SUITS[card.suit]) return;
        if (isFaceDown(el)) return;
        if (seenEl) {
          if (seenEl.has(el)) return;
          seenEl.add(el);
        }
        var rect;
        try { rect = el.getBoundingClientRect(); } catch (e) { return; }
        if (!isCardBox(rect)) return;
        var vh = window.innerHeight || 900;
        var vw = window.innerWidth || 1600;
        if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) return;
        var x = Math.round(rect.left + rect.width / 2);
        var y = Math.round(rect.top + rect.height / 2);
        var posKey = Math.round(x / 8) + ',' + Math.round(y / 8);
        if (seenPos[posKey]) return;
        seenPos[posKey] = true;
        cards.push({
          rank: card.rank, suit: card.suit,
          x: x, y: y, w: rect.width, h: rect.height, el: el
        });
      };

      var selectors = [
        '.r-card', '.card', '[class*="r-card"]',
        '[data-card]', '[data-rank]',
        '[style*="svg+xml"]'
      ].join(',');

      var els;
      try { els = document.querySelectorAll(selectors); } catch (e) { els = []; }
      for (var i = 0; i < els.length; i++) {
        add(els[i], parseCardFromElement(els[i]));
      }

      // Real table cards are often a CSS class (no "card" in the name)
      // with an SVG data-URI computed background, or a child <svg>.
      var boxes = document.querySelectorAll('div, span, img');
      for (var b = 0; b < boxes.length; b++) {
        var el = boxes[b];
        var rect;
        try { rect = el.getBoundingClientRect(); } catch (e3) { continue; }
        if (!isCardBox(rect)) continue;
        add(el, parseCardFromElement(el));
        var childSvg = el.querySelector && el.querySelector(':scope > svg');
        if (childSvg) add(el, parseCardFromSVG(childSvg.outerHTML || ''));
      }
      return cards;
    }

    categorizeCards(cards) {
      var empty = { myCards: [], communityCards: [], opponentCards: [] };
      if (!cards || !cards.length) return empty;

      var face = cards.filter(function (c) {
        return c.rank && VALID_SUITS[c.suit] && c.w >= 16 && c.h >= 20;
      });
      if (!face.length) return empty;

      var uniq = [];
      face.forEach(function (c) {
        var key = c.rank + c.suit;
        var prev = uniq.filter(function (u) { return u.rank + u.suit === key; })[0];
        if (!prev) uniq.push(c);
        else if (c.w * c.h > prev.w * prev.h) {
          uniq[uniq.indexOf(prev)] = c;
        }
      });
      face = uniq;

      var vh = window.innerHeight || 800;
      var hintedHero = face.filter(function (c) {
        var p = c.el;
        var cls = '';
        for (var n = 0; n < 4 && p; n++) {
          cls += ' ' + ((p.className && p.className.toString) ? p.className.toString() : '');
          p = p.parentElement;
        }
        return /hero|my-card|hole|own-card/i.test(cls);
      });
      var hintedBoard = face.filter(function (c) {
        var p = c.el;
        var cls = '';
        for (var n = 0; n < 4 && p; n++) {
          cls += ' ' + ((p.className && p.className.toString) ? p.className.toString() : '');
          p = p.parentElement;
        }
        return /board|community|flop|shared/i.test(cls);
      });

      var heroBand = face.filter(function (c) { return c.y > vh * 0.55; })
        .sort(function (a, b) { return a.x - b.x; });
      var boardBand = face.filter(function (c) { return c.y >= vh * 0.20 && c.y <= vh * 0.58; })
        .sort(function (a, b) { return a.x - b.x; });

      var myCards;
      if (hintedHero.length >= 2) myCards = hintedHero.slice(0, 2);
      else if (heroBand.length >= 2) myCards = heroBand.slice(0, 2);
      else if (face.length <= 2) myCards = face.slice().sort(function (a, b) { return a.x - b.x; });
      else myCards = face.slice().sort(function (a, b) { return b.y - a.y; }).slice(0, 2);

      var rest = face.filter(function (c) { return myCards.indexOf(c) === -1; });
      var communityCards;
      if (hintedBoard.length) {
        communityCards = hintedBoard.filter(function (c) { return myCards.indexOf(c) === -1; });
      } else {
        communityCards = boardBand.filter(function (c) { return myCards.indexOf(c) === -1; });
      }
      if (communityCards.length > 1) {
        var ys = communityCards.map(function (c) { return c.y; }).sort(function (a, b) { return a - b; });
        var med = ys[Math.floor(ys.length / 2)];
        communityCards = communityCards.filter(function (c) { return Math.abs(c.y - med) < 50; });
      }
      communityCards = communityCards.sort(function (a, b) { return a.x - b.x; }).slice(0, 5);
      var opponentCards = rest.filter(function (c) { return communityCards.indexOf(c) === -1; }).slice(0, 8);

      return { myCards: myCards, communityCards: communityCards, opponentCards: opponentCards };
    }

    detectStage(communityCards) {
      var n = (communityCards || []).length;
      if (n >= 5) return 'river';
      if (n === 4) return 'turn';
      if (n === 3) return 'flop';
      var text = (document.body.innerText || '').toLowerCase();
      if (text.indexOf('ривер') !== -1 || text.indexOf('river') !== -1) return 'river';
      if (text.indexOf('терн') !== -1 || text.indexOf('turn') !== -1) return 'turn';
      if (text.indexOf('флоп') !== -1 || text.indexOf('flop') !== -1) return 'flop';
      return 'preflop';
    }

    detectBigBlind() {
      var text = document.body.innerText || '';
      var m = text.match(/(?:Ставки|Blinds|Ставка)[:\s]*([\$€£]?\s*[\d.,]+)\s*\/\s*([\$€£]?\s*[\d.,]+)/i);
      if (m) {
        var bb = parseMoney(m[2]);
        if (bb > 0) return bb;
      }
      return 0;
    }

    detectPot() {
      var text = (document.body.innerText || '').replace(/\u00a0/g, ' ');
      var patterns = [
        /(?:Банк|Pot|Bank)\s*[:.\-–]?\s*[\$€£]?\s*([\d]+(?:[.,]\d{1,2})?)/i,
        /Банк[^\d]{0,12}([\d]+[.,]\d{1,2})/i
      ];
      for (var p = 0; p < patterns.length; p++) {
        var m = text.match(patterns[p]);
        if (m) {
          var v = parseMoney(m[1]);
          if (v > 0) return v;
        }
      }
      var potEl = document.querySelector('.ReactPokerPotsContainer, [class*="pots-container"], [class*="pot-value"], [class*="pot_value"], [class*="PotContainer"], [class*="pot-container"]');
      if (potEl) {
        var pv = parseMoney(potEl.innerText);
        if (pv > 0) return pv;
      }
      var nodes = document.querySelectorAll('div, span, p, label');
      for (var i = 0; i < nodes.length; i++) {
        var t = (nodes[i].textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length > 48 || !/банк|pot|bank/i.test(t)) continue;
        var nm = t.match(/([\d]+[.,]\d{1,2})/);
        if (nm) {
          var nv = parseMoney(nm[1]);
          if (nv > 0) return nv;
        }
      }
      return 0;
    }

    detectBetToCall() {
      var text = document.body.innerText || '';
      var m = text.match(/(?:Колл|Call|Доставить|Толкнуть)[:\s]+([\$€£]?\s*[\d.,]+\s*[\d.,]*)/i);
      if (m) {
        var v = parseMoney(m[1]);
        if (v > 0) return v;
      }
      m = text.match(/Олл-ин[:\s]+([\$€£]?\s*[\d.,]+)/i);
      if (m) {
        var av = parseMoney(m[1]);
        if (av > 0) return av;
      }
      var btns = document.querySelectorAll('button, [class*="action"], [class*="btn"]');
      for (var i = 0; i < btns.length; i++) {
        var t = (btns[i].innerText || '').replace(/\s+/g, ' ');
        var bm = t.match(/(?:Колл|Call)\s*([\$€£]?\s*[\d.,]+)/i);
        if (bm) {
          var bv = parseMoney(bm[1]);
          if (bv > 0) return bv;
        }
      }
      return 0;
    }

    countPlayers() {
      var info = this.getPlayersInfo();
      var active = 0;
      var seated = 0;
      for (var i = 0; i < info.length; i++) {
        if (info[i].seated) seated++;
        if (info[i].active) active++;
      }
      if (active >= 1) return Math.max(2, Math.min(6, active));
      if (seated >= 2) return Math.min(6, seated);
      return 2;
    }

    countSeated() {
      var n = 0;
      var info = this.getPlayersInfo();
      for (var i = 0; i < info.length; i++) {
        if (info[i].seated) n++;
      }
      return n;
    }

    getPlayersInfo() {
      var players = [];
      var seen = {};
      var nameEls = document.querySelectorAll('[class*="player-name"], .bar-text.top-line');
      for (var i = 0; i < nameEls.length; i++) {
        var nameEl = nameEls[i];
        var name = (nameEl.textContent || '').replace(/\s+/g, ' ').trim();
        if (isJunkPlayerName(name)) continue;
        var rect = nameEl.getBoundingClientRect();
        if (!rect || rect.width < 4 || rect.height < 4) continue;
        var key = name + '@' + Math.round(rect.left / 40) + ',' + Math.round(rect.top / 40);
        if (seen[key]) continue;
        seen[key] = true;
        var bar = findSeatRoot(nameEl);
        var cashEl = bar ? bar.querySelector('[class*="player-cash"], .bar-text.bottom-line') : null;
        var cash = cashEl ? parseMoney(cashEl.textContent) : 0;
        if (!cash && bar) {
          var barMoney = (bar.textContent || '').match(/[\$€£]\s*[\d]+[.,]\d{1,2}/);
          if (barMoney) cash = parseMoney(barMoney[0]);
        }
        var betEl = bar ? bar.querySelector('[class*="player-bet"]') : null;
        var bet = betEl ? parseMoney(betEl.textContent) : 0;
        var status = seatStatus(bar || nameEl, name);
        var seated = status !== 'empty';
        var active = status === 'active';
        players.push({
          name: name, cash: cash, bet: bet,
          x: rect.left, y: rect.top,
          status: status, seated: seated, active: active
        });
      }
      if (players.length) {
        players.sort(function (a, b) { return b.y - a.y; });
        players[0].active = true;
        players[0].seated = true;
        if (players[0].status === 'empty' || players[0].status === 'folded') players[0].status = 'active';
      }
      return players;
    }

    getHeroAndVillainStacks() {
      var players = this.getPlayersInfo();
      if (players.length === 0) return { heroStack: 200, villainStack: 200, heroName: '', villainName: '' };
      players.sort(function (a, b) { return b.y - a.y; });
      var hero = players[0];
      var others = players.slice(1);
      var villain = others[0] || hero;
      for (var i = 1; i < others.length; i++) {
        if (others[i].cash > villain.cash) villain = others[i];
      }
      return {
        heroStack: hero.cash > 0 ? hero.cash : 200,
        villainStack: villain.cash > 0 ? villain.cash : 200,
        heroName: hero.name,
        villainName: villain.name
      };
    }

    getState() {
      var allCards = this.scanAllCards();
      var cat = this.categorizeCards(allCards);
      var stacks = this.getHeroAndVillainStacks();
      var myCards = cat.myCards.length >= 2
        ? cat.myCards.map(function (c) { return { rank: c.rank, suit: c.suit }; })
        : [];
      var communityCards = cat.communityCards.length >= 3
        ? cat.communityCards.map(function (c) { return { rank: c.rank, suit: c.suit }; })
        : [];
      var source = myCards.length >= 2 ? 'dom' : 'none';

      var shot = window.__paShotCards;
      if (shot) {
        var shotSrc = shot.source || 'shot';
        if (shot.myCards && shot.myCards.length >= 2) {
          myCards = shot.myCards.slice(0, 2);
          source = shotSrc;
        } else if (shot.myCards && shot.myCards.length === 1 && source === 'none') {
          myCards = shot.myCards.slice(0, 1);
          source = shotSrc;
        }
        if (shot.communityCards && shot.communityCards.length) {
          communityCards = shot.communityCards.slice(0, 5);
          if (source === 'none' || source === 'dom') source = shotSrc;
        }
      }

      var br = window.__paBridgeCards;
      if (source !== 'shot' && source !== 'py' && br) {
        if (br.myCards && br.myCards.length >= 2) {
          myCards = br.myCards.slice(0, 2);
          source = br.source || 'bridge';
          if (br.communityCards && br.communityCards.length) {
            communityCards = br.communityCards.slice(0, 5);
          }
        }
      }

      var stage = this.detectStage(communityCards);
      return {
        myCards: myCards,
        communityCards: communityCards,
        opponentCards: cat.opponentCards.map(function (c) { return { rank: c.rank, suit: c.suit }; }),
        pot: this.detectPot(),
        betToCall: this.detectBetToCall(),
        numPlayers: this.countPlayers(),
        numSeated: this.countSeated(),
        stage: stage,
        bigBlind: this.detectBigBlind(),
        heroStack: stacks.heroStack,
        villainStack: stacks.villainStack,
        heroName: stacks.heroName,
        villainName: stacks.villainName,
        _raw: {
          totalCardsDetected: allCards.length,
          source: source,
          pixiCount: br && br.pixiCount,
          wsHits: br && br.wsHits,
          cvCount: br && br.cvCount,
          gl: (shot && shot.error) || (br && br.gl),
          shotBoxes: shot && shot.boxes,
          shotReads: shot && shot.reads,
          rCard: document.querySelectorAll('.r-card').length,
          players: this.getPlayersInfo()
        }
      };
    }
  }

  var ACTION_COLORS = {
    'RAISE': '#ff5252',
    'CALL': '#4caf50',
    'CHECK': '#40c4ff',
    'FOLD': '#ff9800'
  };

  function formatCards(cards) {
    if (!cards || cards.length === 0) return '—';
    return cards.map(function (c) { return c.rank + c.suit; }).join(' ');
  }

  function buildOverlayHTML(response) {
    var decision = response.decision || {};
    var street = response.street || 'unknown';
    var color = ACTION_COLORS[decision.action] || '#ffffff';
    var state = response.state || {};

    var stackTxt = state.heroStack != null && state.heroStack > 0
      ? '$' + Number(state.heroStack).toFixed(2) : '—';
    var nameTxt = state.heroName ? ' (' + state.heroName + ')' : '';
    var stateBlock =
      '<div class="pa-state">' +
        '<div class="pa-state-title">📡 Прочитано из игры</div>' +
        '<div class="pa-state-row">🂡 Мои карты: <b>' + formatCards(state.myCards) + '</b></div>' +
        '<div class="pa-state-row">🃏 Доска: <b>' + formatCards(state.communityCards) + '</b></div>' +
        '<div class="pa-state-row">💰 Банк: <b>' + (state.pot != null ? '$' + Number(state.pot).toFixed(2) : '—') +
        '</b> · Ставка: <b>' + (state.betToCall != null ? '$' + Number(state.betToCall).toFixed(2) : '—') + '</b></div>' +
        '<div class="pa-state-row">👛 Стек' + nameTxt + ': <b>' + stackTxt + '</b></div>' +
      '<div class="pa-state-row">👥 В игре: <b>' + (state.numPlayers || '—') +
      '</b>' + (state.numSeated && state.numSeated !== state.numPlayers ? ' · за столом: ' + state.numSeated : '') +
      ' · Улица: <b>' + street + '</b></div>' +
        (response.readingWarning ? '<div class="pa-warning">⚠️ ' + response.readingWarning + '</div>' : '') +
      '</div>';

    var sourceBadge = decision.source === 'fallback'
      ? '<span class="pa-badge pa-badge-fallback">⚙️ GTO/Monte Carlo</span>'
      : '<span class="pa-badge pa-badge-llm">🤖 GigaChat</span>';

    return '' +
      '<div class="pa-header">🃏 Poker Assistant <span class="pa-version">v3.3.15</span></div>' +
      stateBlock +
      '<div class="pa-street">Улица: ' + street + ' ' + sourceBadge + '</div>' +
      '<div class="pa-recommendation" style="color: ' + color + ';">' + decision.action + '</div>' +
      '<div class="pa-details">' +
        '<div>📊 Эквити (шанс выиграть): ~' + (decision.winRate != null ? decision.winRate : '—') + '%</div>' +
        '<div>💰 Pot Odds (цена колла): ' + (decision.potOdds != null ? decision.potOdds : '—') + '%</div>' +
        '<div>📈 ' + (decision.reason || '') + '</div>' +
      '</div>' +
      (response.llm_response ? '<div class="pa-reasoning">🤖 ' + response.llm_response.substring(0, 300) + '</div>' : '') +
      '<div class="pa-footer">Tab — ручной ввод · PokerSkill + GigaChat</div>';
  }

  function makeDraggable(element) {
    var pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    var header = element.querySelector('.pa-header');
    (header || element).onmousedown = dragMouseDown;

    function dragMouseDown(e) {
      e = e || window.event;
      e.preventDefault();
      pos3 = e.clientX;
      pos4 = e.clientY;
      document.onmouseup = closeDragElement;
      document.onmousemove = elementDrag;
    }
    function elementDrag(e) {
      e = e || window.event;
      e.preventDefault();
      pos1 = pos3 - e.clientX;
      pos2 = pos4 - e.clientY;
      pos3 = e.clientX;
      pos4 = e.clientY;
      element.style.top = (element.offsetTop - pos2) + 'px';
      element.style.left = (element.offsetLeft - pos1) + 'px';
    }
    function closeDragElement() {
      document.onmouseup = null;
      document.onmousemove = null;
    }
  }

  function ensurePanel(doc) {
    doc = doc || document;
    var oldHud = doc.getElementById('poker-assistant-hud');
    if (oldHud) oldHud.remove();
    var panel = doc.getElementById('poker-assistant-panel');
    if (panel) return panel;
    panel = doc.createElement('div');
    panel.id = 'poker-assistant-panel';
    panel.innerHTML =
      '<div class="pa-header">🃏 Poker Assistant <span class="pa-version">v3.3.15</span></div>' +
      '<div id="pa-live" class="pa-state"><div class="pa-state-title">📡 Читаю стол…</div></div>' +
      '<div id="pa-rec" class="pa-rec-wait">Рекомендация появится, когда будут карты</div>';
    doc.body.appendChild(panel);
    makeDraggable(panel);
    return panel;
  }

  function updateLive(state, extra, doc) {
    doc = doc || document;
    extra = extra || {};
    var panel = ensurePanel(doc);
    var live = panel.querySelector('#pa-live');
    if (!live) return;
    var stackTxt = state.heroStack != null && Number(state.heroStack) > 0
      ? '$' + Number(state.heroStack).toFixed(2) : '—';
    var nameTxt = state.heroName ? ' (' + state.heroName + ')' : '';
    live.innerHTML =
      '<div class="pa-state-title">📡 Прочитано из игры</div>' +
      '<div class="pa-state-row">🂡 Мои карты: <b>' + formatCards(state.myCards) + '</b></div>' +
      '<div class="pa-state-row">🃏 Доска: <b>' + formatCards(state.communityCards) + '</b></div>' +
      '<div class="pa-state-row">💰 Банк: <b>$' + Number(state.pot || 0).toFixed(2) +
      '</b> · Ставка: <b>$' + Number(state.betToCall || 0).toFixed(2) + '</b></div>' +
      '<div class="pa-state-row">👛 Стек' + nameTxt + ': <b>' + stackTxt + '</b></div>' +
      '<div class="pa-state-row">👥 В игре: <b>' + (state.numPlayers || '—') +
      '</b>' + (state.numSeated && state.numSeated !== state.numPlayers ? ' · за столом: ' + state.numSeated : '') +
      ' · Улица: <b>' + (state.stage || extra.street || '?') + '</b>' +
      (state._raw && state._raw.source ? ' · src: ' + state._raw.source : '') +
      (state._raw && state._raw.shotBoxes != null ? ' · boxes: ' + state._raw.shotBoxes : '') +
      (state._raw && state._raw.shotReads != null ? ' · reads: ' + state._raw.shotReads : '') +
      (state._raw && state._raw.gl ? ' · ' + state._raw.gl : '') + '</div>' +
      (extra.warning ? '<div class="pa-warning">⚠️ ' + extra.warning + '</div>' : '');
  }

  function showOverlay(response, doc) {
    doc = doc || document;
    var panel = ensurePanel(doc);
    var fading = doc.getElementById('poker-assistant-overlay');
    if (fading) fading.remove();

    if (response && response.state) {
      updateLive(response.state, {
        street: response.street,
        warning: response.readingWarning || response.error
      }, doc);
    }

    var rec = panel.querySelector('#pa-rec');
    if (!rec) return;
    var decision = (response && response.decision) || {};
    if (!decision.action) {
      rec.className = 'pa-rec-wait';
      rec.innerHTML = response && response.error
        ? '⚠️ ' + response.error + ' — считаю по GTO…'
        : 'Считаю рекомендацию…';
      return;
    }
    var color = ACTION_COLORS[decision.action] || '#ffffff';
    var sourceBadge = decision.source === 'fallback'
      ? '<span class="pa-badge pa-badge-fallback">⚙️ GTO/Monte Carlo</span>'
      : '<span class="pa-badge pa-badge-llm">🤖 GigaChat</span>';
    rec.className = 'pa-rec';
    rec.innerHTML =
      '<div class="pa-street">Улица: ' + (response.street || '?') + ' ' + sourceBadge + '</div>' +
      '<div class="pa-recommendation" style="color:' + color + ';">' + decision.action + '</div>' +
      '<div class="pa-details">' +
        '<div>📊 Эквити (шанс выиграть): ~' + (decision.winRate != null ? decision.winRate : '—') + '%</div>' +
        '<div>💰 Pot Odds (цена колла): ' + (decision.potOdds != null ? decision.potOdds : '—') + '%</div>' +
        '<div>📈 ' + (decision.reason || '') + '</div>' +
      '</div>' +
      (response.llm_response ? '<div class="pa-reasoning">🤖 ' + String(response.llm_response).substring(0, 240) + '</div>' : '');
  }

  function showDead(doc) {
    doc = doc || document;
    var panel = ensurePanel(doc);
    var rec = panel.querySelector('#pa-rec');
    if (rec) {
      rec.className = 'pa-rec-wait';
      rec.innerHTML = '⚠️ Расширение перезагрузилось. Обновите страницу (F5), затем кликните иконку.';
    }
  }

  window.PokerCardParserCore = PokerCardParserCore;
  window.PokerParseUtils = {
    parseCardFromSVG: parseCardFromSVG,
    parseCardToken: parseCardToken,
    decodeSvgDataUri: decodeSvgDataUri,
    decodeBase64Utf8: decodeBase64Utf8,
    inferSuitFromSvg: inferSuitFromSvg
  };
  window.PokerAssistantUI = {
    showOverlay: showOverlay,
    buildOverlayHTML: buildOverlayHTML,
    updateLive: updateLive,
    ensurePanel: ensurePanel,
    showDead: showDead
  };
  console.log('[PokerAssistant] Shared parser v3.3.15 loaded');
})();
