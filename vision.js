// Screenshot / ImageData card reader (Pinco white faces).
(function () {
  'use strict';
  if (window.PokerVision) return;

  var rankTpls = null;

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

  function ensureRankTpls() {
    if (rankTpls) return rankTpls;
    rankTpls = [];
    var chars = ['A', 'K', 'Q', 'J', 'T', '10', '9', '8', '7', '6', '5', '4', '3', '2'];
    var fonts = ['700 52px Arial', '700 52px "Segoe UI"', '700 48px sans-serif'];
    var c = document.createElement('canvas');
    c.width = 80;
    c.height = 90;
    var ctx = c.getContext('2d', { willReadFrequently: true });
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
    countHoles._cy = 0.5;
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
      if (holeY != null) {
        if (r === '6' && holeY < 0.38) continue;
        if (r === '9' && holeY > 0.62) continue;
      }
      var s = corr(probe, tpls[i].mask);
      if (s > bestS) { bestS = s; best = r; }
    }
    if (!best || bestS < 0.28) return null;
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
    var top = 0, bot = 0, tN = 0, bN = 0, maxY = 0;
    for (var y2 = 0; y2 < blob.h; y2++) {
      var v = rows[y2] / max;
      if (v >= rows[maxY] / max) maxY = y2;
      if (y2 < blob.h * 0.25) { top += v; tN++; }
      else if (y2 > blob.h * 0.75) { bot += v; bN++; }
    }
    top = tN ? top / tN : 0;
    bot = bN ? bot / bN : 0;
    var maxRel = maxY / Math.max(blob.h - 1, 1);
    if (isRed) return (top > 0.55 || maxRel < 0.32) ? 'h' : 'd';
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
      return b.n < w * h * 0.45 && b.w < w * 0.75 && b.h < h * 0.70 && b.n >= 8;
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
    if (!suitBlob && bl.length > 1) suitBlob = bl.slice(1).sort(function (a, b) { return b.n - a.n; })[0];
    var rk = classifyRank(mask, w, rankBlob);
    var suit = classifySuit(data, w, mask, suitBlob);
    if (!suit && rk) {
      var red = 0, ink = 0;
      for (var p = 0; p < data.length; p += 4) {
        if (data[p] > 200 && data[p + 1] > 200 && data[p + 2] > 200) continue;
        if (data[p] + data[p + 1] + data[p + 2] > 520) continue;
        ink++;
        if (data[p] - data[p + 2] > 25) red++;
      }
      if (ink) suit = (red / ink > 0.18) ? 'd' : 's';
    }
    if (!rk || !suit) return null;
    return { rank: rk.rank, suit: suit, conf: rk.conf };
  }

  function feltBounds(frame) {
    var w = frame.w, h = frame.h, data = frame.data;
    var step = 4;
    var minx = w, miny = h, maxx = 0, maxy = 0, n = 0;
    for (var y = 0; y < h; y += step) {
      for (var x = 0; x < w; x += step) {
        var i = (y * w + x) * 4;
        var r = data[i], g = data[i + 1], b = data[i + 2];
        if (g > 40 && g < 140 && g > r + 6 && r < 100 && b < 110 && (r + g + b) < 280) {
          n++;
          if (x < minx) minx = x;
          if (y < miny) miny = y;
          if (x > maxx) maxx = x;
          if (y > maxy) maxy = y;
        }
      }
    }
    if (n < 60) return { x: 0, y: 0, w: w, h: h };
    var pad = 12;
    var x0 = Math.max(0, minx - pad);
    var y0 = Math.max(0, miny - pad);
    var x1 = Math.min(w, maxx + pad);
    var y1 = Math.min(h, maxy + pad);
    if ((x1 - x0) * (y1 - y0) > w * h * 0.72) return { x: 0, y: 0, w: w, h: h };
    return { x: x0, y: y0, w: Math.max(40, x1 - x0), h: Math.max(40, y1 - y0) };
  }

  function findWhiteBoxes(frame) {
    var w = frame.w, h = frame.h, data = frame.data;
    var minW = Math.max(16, 0.012 * w);
    var minH = Math.max(22, 0.020 * h);
    var maxW = 0.20 * w;
    var maxH = 0.28 * h;
    var step = w > 1800 ? 2 : 1;
    var sw = Math.floor(w / step), sh = Math.floor(h / step);
    var found = [];
    var thresholds = [245, 230, 210, 190, 170];
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
        if (bw < minW || bh < minH) continue;
        if (bw > maxW || bh > maxH) continue;
        if (ar < 0.45 || ar > 1.40) continue;
        found.push({ x: b.x * step, y: b.y * step, w: bw, h: bh, area: bw * bh, ar: ar });
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
          if (c.area > m.area) {
            boxes[j] = c;
          }
          break;
        }
      }
      if (!overlap) boxes.push(c);
    }
    var split = [];
    for (var s = 0; s < boxes.length; s++) {
      var box = boxes[s];
      if (box.ar > 1.15 && box.y > h * 0.50) {
        var hw = Math.max(box.h * 0.68, box.w * 0.48);
        split.push({ x: box.x, y: box.y, w: hw, h: box.h });
        split.push({ x: box.x + box.w - hw, y: box.y, w: hw, h: box.h });
      } else {
        split.push(box);
      }
    }
    split.sort(function (a, b) { return a.x - b.x; });
    return split;
  }

  function uniqCards(list) {
    var seen = {}, out = [];
    for (var i = 0; i < (list || []).length; i++) {
      var c = list[i];
      if (!c || !c.rank || !c.suit) continue;
      var k = c.rank + c.suit;
      if (seen[k]) continue;
      seen[k] = 1;
      out.push({ rank: c.rank, suit: c.suit });
    }
    return out;
  }

  function readFrame(frame) {
    if (!frame) return { myCards: [], communityCards: [], boxes: 0 };
    var felt = feltBounds(frame);
    var table = cropFrame(frame, felt.x, felt.y, felt.w, felt.h) || frame;
    table.x0 = felt.x;
    table.y0 = felt.y;
    var whites = findWhiteBoxes(table);
    function tryRead(b) {
      var pads = [2, 6, 10, 0];
      for (var p = 0; p < pads.length; p++) {
        var pad = pads[p];
        var crop = cropFrame(table, b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
        var c = readCardCrop(crop);
        if (c) return c;
      }
      return null;
    }
    var reads = [];
    for (var i = 0; i < whites.length; i++) {
      var b = whites[i];
      var c = tryRead(b);
      if (c) reads.push({ rank: c.rank, suit: c.suit, conf: c.conf, x: b.x, y: b.y, w: b.w, h: b.h });
    }
    var h = table.h, midX = table.w * 0.5;
    var heroPool = reads.filter(function (r) {
      return r.y > h * 0.55 && Math.abs((r.x + r.w / 2) - midX) < table.w * 0.45;
    }).sort(function (a, b) { return a.x - b.x; });
    if (heroPool.length < 2) {
      heroPool = reads.filter(function (r) { return r.y > h * 0.50; })
        .sort(function (a, b) { return b.y - a.y || a.x - b.x; });
    }
    var my = uniqCards(heroPool).slice(0, 2);
    var boardPool = reads.filter(function (r) {
      var cx = r.x + r.w / 2;
      if (r.y < h * 0.18 || r.y > h * 0.58) return false;
      if (Math.abs(cx - midX) > table.w * 0.42) return false;
      return !my.some(function (hcard) { return hcard.rank === r.rank && hcard.suit === r.suit; });
    }).sort(function (a, b) { return a.x - b.x; });
    var board = uniqCards(boardPool).slice(0, 5);
    return {
      myCards: my,
      communityCards: board,
      boxes: whites.length,
      reads: reads.length,
      source: 'shot'
    };
  }

  function frameFromImage(img) {
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    var scale = w > 1600 ? 1600 / w : 1;
    var cw = Math.round(w * scale), ch = Math.round(h * scale);
    var c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    var ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, cw, ch);
    return { data: ctx.getImageData(0, 0, cw, ch).data, w: cw, h: ch };
  }

  function readDataUrl(dataUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        try { resolve(readFrame(frameFromImage(img))); }
        catch (e) { reject(e); }
      };
      img.onerror = function () { reject(new Error('shot image')); };
      img.src = dataUrl;
    });
  }

  window.PokerVision = { readFrame: readFrame, readDataUrl: readDataUrl };
})();
