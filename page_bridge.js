// PAGE world. Cards are Pixi/WebGL — not in the DOM.
// v3: pin game state (React/Pixi/WS) + read white card faces from the canvas.
(function () {
  if (window.__paBridgeV >= 4) return;
  window.__paBridgeV = 4;
  window.__paBridge = true;

  try {
    var proto = HTMLCanvasElement.prototype;
    if (!proto.__paGetContext) {
      var origGetContext = proto.getContext;
      proto.getContext = function (type, attrs) {
        if (/webgl/i.test(String(type || ''))) {
          attrs = Object.assign({}, attrs || {}, { preserveDrawingBuffer: true });
        }
        return origGetContext.call(this, type, attrs);
      };
      proto.__paGetContext = true;
    }
  } catch (e0) { /* ignore */ }

  var RANK_NUM = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 10: 'T' };
  var RANKS = '23456789TJQKA';
  var SUIT_ORDERS = ['shdc', 'cdhs', 'hsdc', 'dchs', 'chsd', 'sdch'];
  var lastWs = { myCards: [], communityCards: [], hits: 0, raw: 0 };
  var lastFrame = null;
  var needCapture = false;
  var rankTpls = null;
  var debug = { pixi: 0, react: 0, ws: 0, cv: 0, gl: 'no' };

  function post(data) {
    try { window.postMessage({ source: 'PA_BRIDGE', data: data }, '*'); } catch (e) { /* ignore */ }
  }

  function normRank(r) {
    if (r == null) return null;
    if (typeof r === 'number') {
      if (RANK_NUM[r]) return RANK_NUM[r];
      if (r >= 2 && r <= 9) return String(r);
      return null;
    }
    var s = String(r).replace(/\s/g, '').toUpperCase();
    if (s === '10' || s === 'T') return 'T';
    if (/^[AKQJ2-9]$/.test(s)) return s;
    return null;
  }

  function normSuit(s) {
    if (s == null) return null;
    if (typeof s === 'number') {
      return ['s', 'h', 'd', 'c'][s] || ['c', 'd', 'h', 's'][s] || null;
    }
    var t = String(s).toLowerCase();
    if (/^(s|spade|spades|♠|пик)/.test(t)) return 's';
    if (/^(h|heart|hearts|♥|черв)/.test(t)) return 'h';
    if (/^(d|diamond|diamonds|♦|бубн)/.test(t)) return 'd';
    if (/^(c|club|clubs|♣|треф)/.test(t)) return 'c';
    return null;
  }

  function fromCode(n, order) {
    n = Number(n);
    if (!isFinite(n) || n < 0 || n > 51) return null;
    var ranks = '23456789TJQKA';
    var suits = order || 'shdc';
    return { rank: ranks[Math.floor(n / 4)], suit: suits.charAt(n % 4) };
  }

  function asCard(v, allowCode) {
    if (v == null) return null;
    if (typeof v === 'number') return allowCode ? fromCode(v, 'shdc') : null;
    if (typeof v === 'string') {
      var t = v.trim();
      var m = t.match(/^(10|[AKQJT2-9])([hdcsHDCS♠♥♦♣])$/);
      if (!m) m = t.match(/^([♠♥♦♣])(10|[AKQJT2-9])$/);
      if (!m) return null;
      var rank = m[1].length <= 2 && /[AKQJT2-9]|10/.test(m[1]) ? m[1] : m[2];
      var suit = m[1].length <= 2 && /[AKQJT2-9]|10/.test(m[1]) ? m[2] : m[1];
      var sm = { '♠': 's', '♥': 'h', '♦': 'd', '♣': 'c' };
      return { rank: rank === '10' ? 'T' : String(rank).toUpperCase(), suit: sm[suit] || String(suit).toLowerCase() };
    }
    if (typeof v !== 'object') return null;
    if (typeof v.code === 'number') return fromCode(v.code);
    if (typeof v.cardId === 'number') return fromCode(v.cardId);
    if (typeof v.id === 'number' && v.id <= 51) {
      var c0 = fromCode(v.id);
      if (c0) return c0;
    }
    var rank = normRank(v.rank != null ? v.rank : (v.Rank != null ? v.Rank : (v.r != null ? v.r : v.value)));
    var suit = normSuit(v.suit != null ? v.suit : (v.Suit != null ? v.Suit : (v.s != null ? v.s : v.color)));
    if (rank && suit) return { rank: rank, suit: suit };
    if (v.card) return asCard(v.card);
    if (v.name) return asCard(v.name);
    return null;
  }

  function toCardList(v, allowCode) {
    if (!v) return [];
    if (typeof v === 'string') {
      var out = [];
      var re = /(10|[AKQJT2-9])([hdcsHDCS])/g;
      var m;
      while ((m = re.exec(v))) out.push({ rank: m[1] === '10' ? 'T' : m[1].toUpperCase(), suit: m[2].toLowerCase() });
      if (out.length) return out;
      re = /(10|[AKQJT2-9])([♠♥♦♣])/g;
      while ((m = re.exec(v))) {
        var sm = { '♠': 's', '♥': 'h', '♦': 'd', '♣': 'c' };
        out.push({ rank: m[1] === '10' ? 'T' : m[1].toUpperCase(), suit: sm[m[2]] });
      }
      return out;
    }
    if (!Array.isArray(v)) return [];
    var cards = [];
    for (var i = 0; i < v.length; i++) {
      var c = asCard(v[i], allowCode);
      if (c) cards.push(c);
    }
    return cards;
  }

  function uniqCards(list) {
    var seen = {};
    var out = [];
    for (var i = 0; i < (list || []).length; i++) {
      var c = list[i];
      if (!c || !c.rank || !c.suit) continue;
      var k = c.rank + c.suit;
      if (seen[k]) continue;
      seen[k] = 1;
      out.push({ rank: c.rank, suit: c.suit, x: c.x, y: c.y });
    }
    return out;
  }

  function scrapeText(text, acc) {
    if (!text || typeof text !== 'string' || text.length > 20000) return;
    var list = toCardList(text);
    if (list.length >= 2 && list.length <= 7) {
      acc.candidates.push(list);
    }
  }

  function harvest(obj, acc, depth, seen) {
    if (!obj || typeof obj !== 'object' || depth > 7) return;
    if (acc.visits > 8000) return;
    if (seen) {
      if (seen.has(obj)) return;
      try { seen.add(obj); } catch (e) { return; }
    }
    acc.visits++;
    if (Array.isArray(obj)) {
      if (obj.length >= 2 && obj.length <= 7) {
        var cs = toCardList(obj, false);
        if (cs.length === obj.length && cs.length >= 2) acc.candidates.push(cs);
      }
      var n = Math.min(obj.length, 12);
      for (var a = 0; a < n; a++) harvest(obj[a], acc, depth + 1, seen);
      return;
    }
    var keys;
    try { keys = Object.keys(obj); } catch (e) { return; }
    if (keys.length > 80) keys = keys.slice(0, 80);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k.charAt(0) === '_' && k !== '_card' && k !== '_cards') continue;
      var lk = k.toLowerCase();
      var v;
      try { v = obj[k]; } catch (e2) { continue; }
      if (typeof v === 'string') {
        scrapeText(v, acc);
        if (/hole|herocard|mycard|pocket|handcard|closecard|holecard/.test(lk)) {
          var hs = toCardList(v);
          if (hs.length >= 2) acc.myCards = hs.slice(0, 2);
        }
        if (/board|community|tablecard|flopcard|sharedcard|boardcard/.test(lk)) {
          var bs = toCardList(v);
          if (bs.length >= 1) acc.communityCards = bs.slice(0, 5);
        }
        continue;
      }
      if (/hole|herocard|mycard|pocket|handcard|closecard|holecard/.test(lk)) {
        var hs2 = toCardList(v, true);
        if (hs2.length >= 2) acc.myCards = hs2.slice(0, 2);
      }
      if (/board|community|tablecard|flopcard|sharedcard|boardcard/.test(lk)) {
        var bs2 = toCardList(v, true);
        if (bs2.length >= 1) acc.communityCards = bs2.slice(0, 5);
      }
      if (v && typeof v === 'object' && depth < 6) harvest(v, acc, depth + 1, seen);
    }
  }

  function walkReactFiber(fiber, depth, acc, seen) {
    if (!fiber || depth > 36 || acc.visits > 8000) return;
    acc.visits++;
    var sn = fiber.stateNode;
    if (sn && typeof sn === 'object' && !seen.has(sn)) {
      seen.add(sn);
      harvest(sn, acc, 0, seen);
      if (sn.props) harvest(sn.props, acc, 0, seen);
      if (sn.state) harvest(sn.state, acc, 0, seen);
      if (sn.application || sn.app || sn._app || sn.pixiApp) acc.apps.push(sn.application || sn.app || sn._app || sn.pixiApp);
    }
    if (fiber.memoizedProps) harvest(fiber.memoizedProps, acc, 0, seen);
    var hook = fiber.memoizedState;
    var hn = 0;
    while (hook && hn < 60) {
      if (hook.memoizedState) harvest(hook.memoizedState, acc, 0, seen);
      if (hook.queue && hook.queue.lastRenderedState) harvest(hook.queue.lastRenderedState, acc, 0, seen);
      hook = hook.next;
      hn++;
    }
    walkReactFiber(fiber.child, depth + 1, acc, seen);
    walkReactFiber(fiber.sibling, depth + 1, acc, seen);
  }

  function reactKey(el) {
    if (!el) return null;
    var keys = Object.keys(el);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf('__reactFiber') === 0 || keys[i].indexOf('__reactInternalInstance') === 0) return keys[i];
    }
    return null;
  }

  function findReactCards() {
    var acc = { visits: 0, candidates: [], apps: [] };
    var seen = new WeakSet();
    var roots = document.querySelectorAll(
      '.poker-root, .PixiComponent, .GameContainer, .game-container, .poker-game, canvas, #root, [class*="GameContainer"], [class*="SingleTable"]'
    );
    for (var i = 0; i < roots.length; i++) {
      var el = roots[i];
      for (var up = 0; up < 4 && el; up++) {
        var key = reactKey(el);
        if (key) {
          walkReactFiber(el[key], 0, acc, seen);
          break;
        }
        el = el.parentElement;
      }
    }
    if (!acc.myCards && acc.candidates) {
      var two = acc.candidates.filter(function (c) { return c.length === 2; });
      var board = acc.candidates.filter(function (c) { return c.length >= 3 && c.length <= 5; });
      if (two.length) acc.myCards = two[two.length - 1];
      if (board.length) acc.communityCards = board[board.length - 1];
    }
    return acc;
  }

  function walkPixiNode(node, acc, depth) {
    if (!node || depth > 22 || acc.length > 80) return;
    var name = String(node.name || node.label || node.id || '');
    var ids = [];
    try {
      if (node.text != null && String(node.text).length <= 4) ids.push(String(node.text));
      var tex = node.texture;
      if (tex) {
        if (tex.textureCacheIds) ids = ids.concat(tex.textureCacheIds);
        if (tex.baseTexture) {
          var bid = tex.baseTexture.cacheId || (tex.baseTexture.resource && tex.baseTexture.resource.url);
          if (bid) ids.push(String(bid));
        }
        if (tex.label) ids.push(String(tex.label));
      }
    } catch (e) { /* ignore */ }
    var blob = (name + ' ' + ids.join(' ')).toLowerCase();
    var m = blob.match(/(?:card[_-]?)?(10|[akqjt2-9])[_-]?([hdcs])(?:[_.\s-]|$)/i);
    var card = m ? {
      rank: m[1].toUpperCase() === '10' ? 'T' : m[1].toUpperCase(),
      suit: m[2].toLowerCase()
    } : asCard(node.card || node.cardData || node._card || node.model);
    if (card) {
      acc.push({
        rank: card.rank,
        suit: card.suit,
        x: node.worldTransform ? node.worldTransform.tx : node.x,
        y: node.worldTransform ? node.worldTransform.ty : node.y
      });
    }
    var kids = node.children || [];
    for (var i = 0; i < kids.length; i++) walkPixiNode(kids[i], acc, depth + 1);
  }

  function considerApp(obj, apps) {
    if (!obj || typeof obj !== 'object') return;
    if ((obj.stage && (obj.renderer || obj.view || obj.ticker)) || (obj.renderer && obj.renderer.stage)) {
      if (apps.indexOf(obj) === -1) apps.push(obj);
    }
  }

  function findPixiApps(reactApps) {
    var apps = [];
    if (reactApps) for (var r = 0; r < reactApps.length; r++) considerApp(reactApps[r], apps);
    var cvs = document.querySelectorAll('canvas');
    for (var i = 0; i < cvs.length; i++) {
      var c = cvs[i];
      considerApp(c.__PIXI_APP__, apps);
      considerApp(c._pixiApp, apps);
      considerApp(c.__app, apps);
      try {
        var names = Object.getOwnPropertyNames(c);
        for (var n = 0; n < names.length; n++) {
          try { considerApp(c[names[n]], apps); } catch (e) { /* ignore */ }
        }
      } catch (e2) { /* ignore */ }
    }
    considerApp(window.__PIXI_APP__, apps);
    considerApp(window.pixiApp, apps);
    if (window.PIXI && window.PIXI.Application && window.PIXI.Application._instances) {
      Array.from(window.PIXI.Application._instances).forEach(function (a) { considerApp(a, apps); });
    }
    return apps;
  }

  function findPixiCards(apps) {
    var cards = [];
    for (var a = 0; a < apps.length; a++) {
      var app = apps[a];
      var stage = app && (app.stage || (app.renderer && app.renderer.stage));
      if (stage) walkPixiNode(stage, cards, 0);
    }
    return cards;
  }

  function classifyByY(cards) {
    if (!cards.length) return { myCards: [], communityCards: [] };
    var h = (lastFrame && lastFrame.h) || window.innerHeight || 800;
    var hero = cards.filter(function (c) { return (c.y || 0) > h * 0.55; }).slice(0, 2);
    var board = cards.filter(function (c) { return (c.y || 0) >= h * 0.18 && (c.y || 0) <= h * 0.58; }).slice(0, 5);
    if (hero.length < 2 && cards.length >= 2) {
      var sorted = cards.slice().sort(function (a, b) { return (b.y || 0) - (a.y || 0); });
      hero = sorted.slice(0, 2);
      board = sorted.slice(2, 7);
    }
    return { myCards: hero, communityCards: board };
  }

  function ingestWsPayload(payload) {
    lastWs.raw++;
    var acc = { visits: 0, candidates: [] };
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch (e) { payload = null; }
    }
    if (payload && typeof payload === 'object') harvest(payload, acc, 0, new WeakSet());
    // Only keep explicitly named hole/board strings — never random JSON fragments.
    if (acc.myCards && acc.myCards.length >= 2) {
      lastWs.myCards = acc.myCards.slice(0, 2);
      lastWs.hits++;
    }
    if (acc.communityCards && acc.communityCards.length) {
      lastWs.communityCards = acc.communityCards.slice(0, 5);
    }
  }

  function hookSockets() {
    if (window.__paWsHook) return;
    window.__paWsHook = true;
    var Orig = window.WebSocket;
    if (!Orig) return;
    function Wrapped(url, proto) {
      var ws = proto !== undefined ? new Orig(url, proto) : new Orig(url);
      ws.addEventListener('message', function (ev) {
        try { ingestWsPayload(ev.data); } catch (e) { /* ignore */ }
      });
      return ws;
    }
    Wrapped.prototype = Orig.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { Wrapped[k] = Orig[k]; });
    window.WebSocket = Wrapped;

  }

  function hookRafCapture() {
    if (window.__paRafHook) return;
    window.__paRafHook = true;
    var orig = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = function (cb) {
      return orig(function (t) {
        var ret;
        try { ret = cb(t); } catch (e) { throw e; }
        if (needCapture) {
          needCapture = false;
          try { lastFrame = grabCanvas(); } catch (err) { /* ignore */ }
        }
        return ret;
      });
    };
  }

  function grabCanvas() {
    var canvas = document.querySelector('.PixiComponent canvas, .r-scene-container canvas, canvas');
    if (!canvas || canvas.width < 40 || canvas.height < 40) return null;

    function pack(data, w, h) {
      var bright = 0;
      var step = Math.max(1, Math.floor(data.length / 400));
      for (var i = 0; i < data.length; i += step) if (data[i] > 180) bright++;
      if (bright < 8) return null;
      return { data: data, w: w, h: h, rect: canvas.getBoundingClientRect() };
    }

    try {
      var ctx2 = canvas.getContext('2d');
      if (ctx2 && ctx2.getImageData) {
        var img = ctx2.getImageData(0, 0, canvas.width, canvas.height);
        var p = pack(img.data, canvas.width, canvas.height);
        if (p) { debug.gl = '2d'; return p; }
      }
    } catch (e) { /* webgl already bound */ }

    var gl = null;
    try { gl = canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl'); } catch (e2) {}
    if (gl) {
      try {
        var w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
        var buf = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        var flip = new Uint8ClampedArray(w * h * 4);
        var row = w * 4;
        for (var y = 0; y < h; y++) flip.set(buf.subarray((h - 1 - y) * row, (h - y) * row), y * row);
        var p2 = pack(flip, w, h);
        if (p2) { debug.gl = 'webgl'; return p2; }
        debug.gl = 'webgl-black';
      } catch (e3) { debug.gl = 'webgl-err'; }
    }

    var apps = findPixiApps([]);
    for (var a = 0; a < apps.length; a++) {
      try {
        var r = apps[a].renderer;
        var ext = r && (r.extract || (r.plugins && r.plugins.extract));
        if (!ext || !ext.canvas) continue;
        var cnv = ext.canvas(apps[a].stage || r.stage);
        if (!cnv) continue;
        var cx = cnv.getContext('2d');
        var im = cx.getImageData(0, 0, cnv.width, cnv.height);
        var p3 = pack(im.data, cnv.width, cnv.height);
        if (p3) { debug.gl = 'extract'; return p3; }
      } catch (e4) { /* ignore */ }
    }
    return lastFrame;
  }

  function cropFrame(frame, x, y, w, h) {
    x = Math.max(0, Math.floor(x));
    y = Math.max(0, Math.floor(y));
    w = Math.min(frame.w - x, Math.floor(w));
    h = Math.min(frame.h - y, Math.floor(h));
    if (w < 12 || h < 16) return null;
    var out = new Uint8ClampedArray(w * h * 4);
    for (var row = 0; row < h; row++) {
      var src = ((y + row) * frame.w + x) * 4;
      out.set(frame.data.subarray(src, src + w * 4), row * w * 4);
    }
    return { data: out, w: w, h: h };
  }

  function ensureRankTpls() {
    if (rankTpls) return rankTpls;
    rankTpls = [];
    var chars = ['A', 'K', 'Q', 'J', 'T', '10', '9', '8', '7', '6', '5', '4', '3', '2'];
    var fonts = ['700 52px Arial', '700 52px "Segoe UI"', '700 48px sans-serif'];
    var c = document.createElement('canvas');
    c.width = 80;
    c.height = 90;
    var ctx = c.getContext('2d');
    for (var f = 0; f < fonts.length; f++) {
      for (var i = 0; i < chars.length; i++) {
        ctx.clearRect(0, 0, 80, 90);
        ctx.fillStyle = '#000';
        ctx.font = fonts[f];
        ctx.textBaseline = 'top';
        ctx.fillText(chars[i], 4, 2);
        var img = ctx.getImageData(0, 0, 80, 90);
        var mask = inkFromRgba(img.data, 80, 90, true);
        var norm = normalizeMask(mask, 80, 90, 32, 44);
        if (norm) rankTpls.push({ rank: chars[i] === '10' ? 'T' : chars[i], mask: norm });
      }
    }
    return rankTpls;
  }

  function inkFromRgba(data, w, h, blackOnly) {
    var m = new Uint8Array(w * h);
    for (var i = 0, p = 0; i < data.length; i += 4, p++) {
      var r = data[i], g = data[i + 1], b = data[i + 2];
      var mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      var sat = mx - mn;
      if (mx > 188 && sat < 28) { m[p] = 0; continue; }
      var dark = mx < 175;
      var colored = sat > 45 && mx < 230;
      m[p] = (blackOnly ? (r + g + b < 360) : (dark || colored)) ? 1 : 0;
    }
    return m;
  }

  function bbox(mask, w, h) {
    var x0 = w, y0 = h, x1 = 0, y1 = 0, n = 0;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (!mask[y * w + x]) continue;
        n++;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
    if (n < 8) return null;
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, n: n };
  }

  function normalizeMask(mask, w, h, tw, th) {
    var box = bbox(mask, w, h);
    if (!box) return null;
    var out = new Uint8Array(tw * th);
    for (var y = 0; y < th; y++) {
      for (var x = 0; x < tw; x++) {
        var sx = box.x + Math.floor(x * box.w / tw);
        var sy = box.y + Math.floor(y * box.h / th);
        out[y * tw + x] = mask[sy * w + sx] ? 1 : 0;
      }
    }
    return out;
  }

  function corr(a, b) {
    var n = a.length, sa = 0, sb = 0, sab = 0, saa = 0, sbb = 0;
    for (var i = 0; i < n; i++) {
      sa += a[i]; sb += b[i]; sab += a[i] * b[i]; saa += a[i] * a[i]; sbb += b[i] * b[i];
    }
    var cov = n * sab - sa * sb;
    var da = n * saa - sa * sa;
    var db = n * sbb - sb * sb;
    if (da <= 0 || db <= 0) return 0;
    return cov / Math.sqrt(da * db);
  }

  function blobsOf(mask, w, h) {
    var seen = new Uint8Array(w * h);
    var blobs = [];
    var qx = new Int32Array(w * h);
    var qy = new Int32Array(w * h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = y * w + x;
        if (!mask[i] || seen[i]) continue;
        var qh = 0, qt = 0;
        qx[qt] = x; qy[qt] = y; qt++;
        seen[i] = 1;
        var x0 = x, y0 = y, x1 = x, y1 = y, n = 0;
        while (qh < qt) {
          var cx = qx[qh], cy = qy[qh]; qh++;
          n++;
          if (cx < x0) x0 = cx;
          if (cy < y0) y0 = cy;
          if (cx > x1) x1 = cx;
          if (cy > y1) y1 = cy;
          for (var dy = -1; dy <= 1; dy++) {
            for (var dx = -1; dx <= 1; dx++) {
              var nx = cx + dx, ny = cy + dy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              var ni = ny * w + nx;
              if (!mask[ni] || seen[ni]) continue;
              seen[ni] = 1;
              qx[qt] = nx; qy[qt] = ny; qt++;
            }
          }
        }
        if (n >= 12) blobs.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, n: n });
      }
    }
    blobs.sort(function (a, b) { return a.y - b.y || a.x - b.x; });
    return blobs;
  }

  function countHoles(mask, w, h) {
    var seen = new Uint8Array(w * h);
    var qx = new Int32Array(w * h + 8);
    var qy = new Int32Array(w * h + 8);
    var qh = 0, qt = 0;
    function push(x, y) {
      var i = y * w + x;
      if (seen[i] || mask[i]) return;
      seen[i] = 1;
      qx[qt] = x; qy[qt] = y; qt++;
    }
    for (var x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
    for (var y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
    while (qh < qt) {
      var cx = qx[qh], cy = qy[qh]; qh++;
      if (cx > 0) push(cx - 1, cy);
      if (cx + 1 < w) push(cx + 1, cy);
      if (cy > 0) push(cx, cy - 1);
      if (cy + 1 < h) push(cx, cy + 1);
    }
    var holes = 0;
    for (var i = 0; i < w * h; i++) {
      if (seen[i] || mask[i]) continue;
      holes++;
      var sx = i % w, sy = (i - sx) / w;
      qh = 0; qt = 0;
      seen[i] = 1;
      qx[qt] = sx; qy[qt] = sy; qt++;
      var sySum = 0, sn = 0;
      while (qh < qt) {
        cx = qx[qh]; cy = qy[qh]; qh++;
        sySum += cy; sn++;
        if (cx > 0) push(cx - 1, cy);
        if (cx + 1 < w) push(cx + 1, cy);
        if (cy > 0) push(cx, cy - 1);
        if (cy + 1 < h) push(cx, cy + 1);
      }
      if (holes === 1) countHoles._cy = sn ? (sySum / sn) / h : 0.5;
    }
    return holes;
  }

  function submask(mask, w, blob) {
    var out = new Uint8Array(blob.w * blob.h);
    for (var y = 0; y < blob.h; y++) {
      for (var x = 0; x < blob.w; x++) {
        out[y * blob.w + x] = mask[(blob.y + y) * w + (blob.x + x)];
      }
    }
    return out;
  }

  function classifyRank(mask, w, blob) {
    if (!blob) return null;
    var roi = submask(mask, w, blob);
    var holes = countHoles(roi, blob.w, blob.h);
    var holeY = countHoles._cy;
    var probe = normalizeMask(roi, blob.w, blob.h, 32, 44);
    if (!probe) return null;
    var tpls = ensureRankTpls();
    var best = null, bestS = 0;
    for (var i = 0; i < tpls.length; i++) {
      var r = tpls[i].rank;
      if (r === '8' && holes < 1) continue;
      if ((r === '6' || r === '9' || r === 'A' || r === '4' || r === 'D') && holes > 2) continue;
      if (holeY != null) {
        if (r === '6' && holeY < 0.38) continue;
        if (r === '9' && holeY > 0.62) continue;
      }
      var s = corr(probe, tpls[i].mask);
      if (s > bestS) { bestS = s; best = r; }
    }
    if (!best || bestS < 0.42) return null;
    return { rank: best, conf: bestS };
  }

  function classifySuit(data, w, mask, blob) {
    if (!blob) return null;
    var red = 0, ink = 0;
    var rows = new Float32Array(blob.h);
    for (var y = 0; y < blob.h; y++) {
      var rw = 0;
      for (var x = 0; x < blob.w; x++) {
        if (!mask[(blob.y + y) * w + (blob.x + x)]) continue;
        rw++;
        ink++;
        var i = ((blob.y + y) * w + (blob.x + x)) * 4;
        if (data[i] - data[i + 2] > 25) red++;
      }
      rows[y] = rw;
    }
    if (!ink) return null;
    var isRed = red / ink > 0.18;
    var max = 1;
    for (var i2 = 0; i2 < rows.length; i2++) if (rows[i2] > max) max = rows[i2];
    var top = 0, bot = 0, mid = 0, tN = 0, bN = 0, mN = 0, maxY = 0;
    for (var y2 = 0; y2 < blob.h; y2++) {
      var v = rows[y2] / max;
      if (v >= rows[maxY] / max) maxY = y2;
      if (y2 < blob.h * 0.25) { top += v; tN++; }
      else if (y2 > blob.h * 0.75) { bot += v; bN++; }
      else if (y2 > blob.h * 0.35 && y2 < blob.h * 0.65) { mid += v; mN++; }
    }
    top = tN ? top / tN : 0;
    bot = bN ? bot / bN : 0;
    var maxRel = maxY / Math.max(blob.h - 1, 1);
    if (isRed) {
      if (top > 0.55 || maxRel < 0.32) return 'h';
      return 'd';
    }
    var even = Math.abs(top - bot) < 0.16;
    if ((top > 0.34 && even && maxRel > 0.45) || (top > 0.42 && bot > 0.38)) return 'c';
    return 's';
  }

  function readCardCrop(crop) {
    if (!crop) return null;
    var data = crop.data, w = crop.w, h = crop.h;
    var white = 0;
    for (var i = 0; i < data.length; i += 16) {
      if (data[i] > 190 && data[i + 1] > 190 && data[i + 2] > 190) white++;
    }
    if (white < 8) return null;
    var mask = inkFromRgba(data, w, h, false);
    var bl = blobsOf(mask, w, h).filter(function (b) {
      return b.n < w * h * 0.28 && b.w < w * 0.62 && b.h < h * 0.55;
    });
    if (!bl.length) return null;
    var left = bl.filter(function (b) { return b.x < w * 0.58 && b.y < h * 0.62; });
    var pool = left.length ? left : bl;
    var rankBlob = pool[0];
    var suitBlob = null;
    for (var i2 = 1; i2 < pool.length; i2++) {
      if (pool[i2].y >= rankBlob.y + rankBlob.h * 0.35) {
        if (!suitBlob || pool[i2].n > suitBlob.n) suitBlob = pool[i2];
      }
    }
    if (!suitBlob) {
      var rest = bl.slice(1);
      if (rest.length) suitBlob = rest.sort(function (a, b) { return b.n - a.n; })[0];
    }
    var rk = classifyRank(mask, w, rankBlob);
    var suit = classifySuit(data, w, mask, suitBlob);
    if (!rk || !suit) return null;
    return { rank: rk.rank, suit: suit, conf: rk.conf };
  }

  function findWhiteBoxes(frame) {
    var w = frame.w, h = frame.h, data = frame.data;
    var step = w > 1600 ? 2 : 1;
    var sw = Math.floor(w / step), sh = Math.floor(h / step);
    var found = [];
    var thresholds = [230, 210, 190];
    for (var t = 0; t < thresholds.length; t++) {
      var thr = thresholds[t];
      var bin = new Uint8Array(sw * sh);
      for (var y = 0; y < sh; y++) {
        for (var x = 0; x < sw; x++) {
          var i = ((y * step) * w + (x * step)) * 4;
          var gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          bin[y * sw + x] = gray > thr ? 1 : 0;
        }
      }
      var raw = blobsOf(bin, sw, sh);
      for (var i2 = 0; i2 < raw.length; i2++) {
        var b = raw[i2];
        var bw = b.w * step, bh = b.h * step;
        var ar = bw / bh;
        if (bw < w * 0.018 || bh < h * 0.025) continue;
        if (bw > w * 0.18 || bh > h * 0.28) continue;
        if (ar < 0.45 || ar > 1.25) continue;
        found.push({ x: b.x * step, y: b.y * step, w: bw, h: bh, area: bw * bh });
      }
    }
    found.sort(function (a, b) { return b.area - a.area; });
    var boxes = [];
    for (var i3 = 0; i3 < found.length; i3++) {
      var c = found[i3];
      var overlap = false;
      for (var j = 0; j < boxes.length; j++) {
        var m = boxes[j];
        if (Math.abs(c.x - m.x) < Math.max(m.w * 0.55, 8) && Math.abs(c.y - m.y) < Math.max(m.h * 0.55, 8)) {
          overlap = true;
          break;
        }
      }
      if (!overlap) boxes.push(c);
    }
    boxes.sort(function (a, b) { return a.x - b.x; });
    return boxes;
  }

  function cssBoxesToCanvas(sel, frame) {
    var canvas = document.querySelector('.PixiComponent canvas, canvas');
    if (!canvas || !frame.rect) return [];
    var cr = frame.rect;
    var sx = frame.w / Math.max(cr.width, 1);
    var sy = frame.h / Math.max(cr.height, 1);
    var els = document.querySelectorAll(sel);
    var out = [];
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (r.width < 16 || r.height < 20) continue;
      out.push({
        x: (r.left - cr.left) * sx,
        y: (r.top - cr.top) * sy,
        w: r.width * sx,
        h: r.height * sy
      });
    }
    return out;
  }

  function readCanvasCards(frame) {
    if (!frame) return { myCards: [], communityCards: [] };
    var holes = cssBoxesToCanvas('.r-card.hole-card, .r-card.close-card, .wrapper-close-card .r-card', frame);
    var boardDom = cssBoxesToCanvas('.r-table-cards .r-card, .r-table-cards .card-holder', frame);
    var whites = findWhiteBoxes(frame);
    var heroBoxes = holes.length >= 2 ? holes.slice(0, 2) : whites.filter(function (b) { return b.y > frame.h * 0.58; }).slice(0, 2);
    if (heroBoxes.length < 2) {
      var bottom = whites.filter(function (b) { return b.y > frame.h * 0.52; }).sort(function (a, b) { return a.x - b.x; });
      if (bottom.length >= 2) heroBoxes = bottom.slice(0, 2);
    }
    var boardBoxes = boardDom.length ? boardDom : whites.filter(function (b) {
      return b.y > frame.h * 0.22 && b.y < frame.h * 0.58;
    });
    function readList(boxes, max) {
      var cards = [];
      for (var i = 0; i < boxes.length && cards.length < max; i++) {
        var crop = cropFrame(frame, boxes[i].x - 2, boxes[i].y - 2, boxes[i].w + 4, boxes[i].h + 4);
        var c = readCardCrop(crop);
        if (c) cards.push({ rank: c.rank, suit: c.suit, x: boxes[i].x, y: boxes[i].y });
      }
      return cards;
    }
    var my = uniqCards(readList(heroBoxes, 2));
    var board = uniqCards(readList(boardBoxes, 5)).filter(function (c) {
      return !my.some(function (h) { return h.rank === c.rank && h.suit === c.suit; });
    });
    return { myCards: my, communityCards: board };
  }

  function tick() {
    needCapture = true;
    var react = { visits: 0, candidates: [], apps: [] };
    var pixi = [];
    try { react = findReactCards(); } catch (e) { react = { visits: 0, candidates: [], apps: [], error: String(e) }; }
    var apps = [];
    try { apps = findPixiApps(react.apps || []); } catch (e2) { apps = []; }
    try { pixi = findPixiCards(apps); } catch (e3) { pixi = []; }

    var cv = { myCards: [], communityCards: [] };
    try { if (lastFrame) cv = readCanvasCards(lastFrame); } catch (e4) { cv = { myCards: [], communityCards: [] }; }

    var my = [];
    var board = [];
    var source = 'none';

    if (cv.myCards.length >= 2) {
      my = cv.myCards;
      board = cv.communityCards || [];
      source = 'cv';
    } else if (react.myCards && react.myCards.length >= 2) {
      my = react.myCards.slice(0, 2);
      board = react.communityCards || [];
      source = 'react';
    } else if (pixi.length) {
      var cl = classifyByY(pixi);
      if (cl.myCards.length >= 2) {
        my = cl.myCards;
        board = cl.communityCards || [];
        source = 'pixi';
      }
    }

    if (!board.length && cv.communityCards.length) board = cv.communityCards;
    if (!board.length && react.communityCards) board = react.communityCards;

    debug.pixi = pixi.length;
    debug.react = react.visits || 0;
    debug.ws = lastWs.hits;
    debug.cv = cv.myCards.length + cv.communityCards.length;

    post({
      myCards: uniqCards(my).slice(0, 2).map(function (c) { return { rank: c.rank, suit: c.suit }; }),
      communityCards: uniqCards(board).slice(0, 5).map(function (c) { return { rank: c.rank, suit: c.suit }; }),
      pixiCount: pixi.length,
      reactVisits: react.visits || 0,
      wsHits: lastWs.hits,
      cvCount: debug.cv,
      gl: debug.gl,
      source: my.length >= 2 ? source : 'none'
    });
  }

  hookSockets();
  hookRafCapture();
  setInterval(tick, 1200);
  setTimeout(tick, 250);
  setTimeout(function () { needCapture = true; }, 800);
})();
