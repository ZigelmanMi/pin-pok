#!/usr/bin/env python3
"""Card-face computer vision for Pinco / similar HTML poker tables.

OCR cannot read the table's stylized rank glyphs. This module:
  1. finds the white card face inside a tight bounding box
  2. splits ink into rank (top) + suit (below)
  3. reads rank by template match (real crops + system fonts) + hole count
  4. reads suit by ink color + width profile (heart/diamond/spade/club)

Used by vision_assistant.py. Run self-test:
  python3 card_vision.py --selftest
"""
from __future__ import annotations

import re
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

BASE = Path(__file__).parent
RANK_TPL_DIR = BASE / 'card_templates' / 'ranks'
CARD_TPL_DIR = BASE / 'card_templates' / 'cards'

RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2']
# How many interior holes each rank glyph typically has
RANK_HOLES = {
    'A': (0, 1), 'K': (0,), 'Q': (0, 1), 'J': (0,), 'T': (0, 1),
    '9': (1,), '8': (2,), '7': (0,), '6': (1,), '5': (0,),
    '4': (0, 1), '3': (0,), '2': (0,),
}

SEED_CARDS = (
    (BASE / 'card_samples' / 'card_0_raw_459_525.png', '6', 'd'),
    (BASE / 'card_samples' / 'card_1_raw_509_524.png', 'J', 'c'),
    (BASE / 'poker_bot' / 'card_0.png', '3', 's'),
    (BASE / 'poker_bot' / 'card_1.png', 'K', 'd'),
    (BASE / 'poker_bot' / 'card_2.png', '4', 'h'),
    (BASE / 'poker_bot' / 'card_3.png', '6', 'h'),
    (BASE / 'poker_bot' / 'card_4.png', '2', 'h'),
)

FONT_PATHS = [
    '/usr/share/fonts/truetype/liberation/LiberationSansNarrow-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/ubuntu/Ubuntu-B.ttf',
    '/usr/share/fonts/truetype/ubuntu/Ubuntu-Bold.ttf',
]

_RANK_TEMPLATES = []  # (rank, source, 32x44 uint8 ink=255)
_LOADED = False
TPL_SIZE = (32, 44)


# ---------- geometry helpers ----------
def _norm_ink(roi, size=TPL_SIZE):
    if roi is None or roi.size == 0:
        return None
    ys, xs = np.where(roi > 0)
    if len(ys) < 8:
        return None
    g = roi[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    return cv2.resize(g, size, interpolation=cv2.INTER_AREA)


def _count_holes(roi):
    if roi is None or roi.size == 0:
        return 0
    cnts, hier = cv2.findContours(roi, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hier is None:
        return 0
    return int(sum(1 for h in hier[0] if h[3] >= 0))


def _hole_cy(roi):
    """Relative Y (0=top) of the first interior hole, or None."""
    if roi is None or roi.size == 0:
        return None
    cnts, hier = cv2.findContours(roi, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hier is None:
        return None
    h = roi.shape[0]
    for i, info in enumerate(hier[0]):
        if info[3] >= 0:
            m = cv2.moments(cnts[i])
            if m['m00'] > 0:
                return float(m['m01'] / m['m00']) / max(h, 1)
    return None


# ---------- ink extraction ----------
def extract_ink(bgr):
    """Return (ink_mask, face_mask) for a BGR crop of one card."""
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    _, white = cv2.threshold(gray, 190, 255, cv2.THRESH_BINARY)
    cnts, _ = cv2.findContours(white, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    face = np.zeros_like(gray)
    if cnts:
        cv2.drawContours(face, [max(cnts, key=cv2.contourArea)], -1, 255, -1)
        face = cv2.erode(face, np.ones((3, 3), np.uint8), iterations=1)
    else:
        face[:] = 255

    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    sat, val = hsv[:, :, 1], hsv[:, :, 2]
    ink = ((val < 200) | (sat > 40)).astype(np.uint8) * 255
    ink[gray > 230] = 0
    ink[face == 0] = 0
    ink = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    return ink, face


def _ink_blobs(ink, min_area=12):
    cnts, _ = cv2.findContours(ink, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    blobs = []
    for c in cnts:
        x, y, w, h = cv2.boundingRect(c)
        area = cv2.contourArea(c)
        if area < min_area:
            continue
        blobs.append({'x': x, 'y': y, 'w': w, 'h': h, 'area': area, 'cnt': c})
    blobs.sort(key=lambda b: (b['y'], b['x']))
    return blobs


def _merge_ten_blobs(ink, blobs):
    """Pinco '10' is a thin '1' glued to a holed '0' on the same row."""
    if len(blobs) < 2:
        return blobs
    top_y = min(b['y'] for b in blobs)
    top = [b for b in blobs if b['y'] <= top_y + max(6, 0.08 * ink.shape[0])]
    top.sort(key=lambda b: b['x'])
    if len(top) < 2:
        return blobs
    a, b = top[0], top[1]
    same_row = abs(a['y'] - b['y']) <= 6 and abs(a['h'] - b['h']) <= max(8, 0.35 * max(a['h'], b['h']))
    gap = b['x'] - (a['x'] + a['w'])
    close = -3 <= gap <= max(10, int(0.45 * a['h']))
    left_thin = a['w'] / max(a['h'], 1) <= 0.38
    left_tall = a['h'] >= 0.7 * b['h']
    if not (same_row and close and left_thin and left_tall):
        return blobs
    right = ink[b['y']:b['y'] + b['h'], b['x']:b['x'] + b['w']]
    right_holes = _count_holes(right)
    right_oval = 0.28 <= (b['w'] / max(b['h'], 1)) <= 0.85
    if right_holes != 1 and not right_oval:
        return blobs
    merged = {
        'x': a['x'],
        'y': min(a['y'], b['y']),
        'w': (b['x'] + b['w']) - a['x'],
        'h': max(a['y'] + a['h'], b['y'] + b['h']) - min(a['y'], b['y']),
        'area': a['area'] + b['area'],
        'cnt': a.get('cnt'),
        'ten': True,
    }
    skip = {id(a), id(b)}
    return [merged] + [x for x in blobs if id(x) not in skip]


def _is_ten_rank(ink, rank_blob):
    if rank_blob.get('ten'):
        return True
    roi = _crop_blob(ink, rank_blob, pad=0)
    if roi is None or roi.size == 0:
        return False
    binary = (roi > 0).astype(np.uint8) * 255
    n, labels, stats, _ = cv2.connectedComponentsWithStats(binary, 8)
    comps = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if area < 8 or h < 6:
            continue
        comps.append((x, y, w, h, area, i))
    comps.sort()
    if len(comps) != 2:
        return False
    a, b = comps[0], comps[1]
    if a[2] / max(a[3], 1) > 0.38:
        return False
    if abs(a[1] - b[1]) > max(6, 0.25 * max(a[3], b[3])):
        return False
    hole = _count_holes(((labels == b[5]).astype(np.uint8) * 255))
    return hole == 1 or b[2] > a[2] * 1.3


def split_rank_suit(ink):
    """Pick rank (topmost glyph) and suit (largest remaining blob)."""
    blobs = _merge_ten_blobs(ink, _ink_blobs(ink))
    if not blobs:
        return None, None
    rank = blobs[0]
    rest = blobs[1:]
    if not rest:
        return rank, None
    # Prefer a blob below the rank (index suit or center pip)
    below = [b for b in rest if b['y'] >= rank['y'] + rank['h'] * 0.4]
    pool = below or rest
    suit = max(pool, key=lambda b: b['area'])
    return rank, suit


def _crop_blob(mask, blob, pad=2):
    h, w = mask.shape[:2]
    x0 = max(0, blob['x'] - pad)
    y0 = max(0, blob['y'] - pad)
    x1 = min(w, blob['x'] + blob['w'] + pad)
    y1 = min(h, blob['y'] + blob['h'] + pad)
    return mask[y0:y1, x0:x1]


# ---------- templates ----------
def _render_font_rank(ch, font_path, size=52):
    try:
        font = ImageFont.truetype(font_path, size)
    except Exception:
        return None
    canvas = Image.new('L', (100, 110), 0)
    ImageDraw.Draw(canvas).text((6, 0), ch, fill=255, font=font)
    arr = np.array(canvas)
    return _norm_ink(arr)


def _seed_real_templates():
    RANK_TPL_DIR.mkdir(parents=True, exist_ok=True)
    CARD_TPL_DIR.mkdir(parents=True, exist_ok=True)
    for path, rank, suit in SEED_CARDS:
        if not path.exists():
            continue
        dest_card = CARD_TPL_DIR / f'{rank}{suit}.png'
        if not dest_card.exists():
            try:
                Image.open(path).convert('RGB').save(dest_card)
            except Exception:
                pass
        img = cv2.imread(str(path))
        if img is None:
            continue
        ink, _ = extract_ink(img)
        rb, _ = split_rank_suit(ink)
        if rb is None:
            continue
        roi = _norm_ink(_crop_blob(ink, rb))
        if roi is None:
            continue
        dest_rank = RANK_TPL_DIR / f'{rank}.png'
        if dest_rank.exists():
            alt = RANK_TPL_DIR / f'{rank}b.png'
            dest_rank = dest_rank if not alt.exists() else None
            if dest_rank is None:
                continue
            dest_rank = alt
        cv2.imwrite(str(dest_rank), roi)


def _load_templates():
    global _RANK_TEMPLATES, _LOADED
    if _LOADED:
        return _RANK_TEMPLATES
    _seed_real_templates()
    tpls = []
    if RANK_TPL_DIR.exists():
        for f in sorted(RANK_TPL_DIR.glob('*.png')):
            m = re.match(r'^(10|[AKQJT2-9])b?$', f.stem, re.I)
            if not m:
                continue
            arr = cv2.imread(str(f), cv2.IMREAD_GRAYSCALE)
            arr = _norm_ink(arr)
            if arr is None:
                continue
            rank = 'T' if m.group(1).upper() == '10' else m.group(1).upper()
            tpls.append((rank, f'file:{f.name}', arr))
    for fp in FONT_PATHS:
        if not Path(fp).exists():
            continue
        for ch in ['A', 'K', 'Q', 'J', 'T', '10', '9', '8', '7', '6', '5', '4', '3', '2']:
            arr = _render_font_rank(ch, fp)
            if arr is None:
                continue
            rank = 'T' if ch == '10' else ch
            tpls.append((rank, Path(fp).name, arr))
    _RANK_TEMPLATES = tpls
    _LOADED = True
    return _RANK_TEMPLATES


def save_rank_template(rank, roi):
    """Store a newly read rank glyph so later hands match faster."""
    rank = 'T' if rank == '10' else str(rank).upper()
    if rank not in RANKS:
        return
    arr = _norm_ink(roi)
    if arr is None:
        return
    RANK_TPL_DIR.mkdir(parents=True, exist_ok=True)
    dest = RANK_TPL_DIR / f'{rank}.png'
    if dest.exists():
        return
    cv2.imwrite(str(dest), arr)
    _RANK_TEMPLATES.append((rank, f'live:{rank}', arr))


# ---------- rank / suit classifiers ----------
def classify_rank(ink, rank_blob):
    if rank_blob is None:
        return None, 0.0, 'none'
    if _is_ten_rank(ink, rank_blob):
        return 'T', 0.93, 'ten'
    roi = _crop_blob(ink, rank_blob)
    probe = _norm_ink(roi)
    if probe is None:
        return None, 0.0, 'none'

    holes = _count_holes(roi)
    hole_y = _hole_cy(roi)
    scores = {}
    sources = {}
    for rank, src, tpl in _load_templates():
        if holes not in RANK_HOLES.get(rank, (holes,)):
            continue
        # 6 has the bowl at the bottom; 9 has it at the top
        if hole_y is not None:
            if rank == '6' and hole_y < 0.40:
                continue
            if rank == '9' and hole_y > 0.60:
                continue
        try:
            res = cv2.matchTemplate(probe, tpl, cv2.TM_CCOEFF_NORMED)
            val = float(res.max())
        except cv2.error:
            continue
        # real crops beat generated fonts when scores are close
        if src.startswith('file:') or src.startswith('live:'):
            val = min(1.0, val + 0.06)
        if val > scores.get(rank, -1):
            scores[rank] = val
            sources[rank] = src

    if not scores:
        return None, 0.0, 'none'
    rank = max(scores, key=scores.get)
    conf = scores[rank]
    if conf < 0.48:
        return None, conf, sources[rank]
    return rank, conf, sources[rank]


def _suit_profile(roi):
    h, w = roi.shape
    rows = (roi > 0).sum(axis=1).astype(np.float32)
    if rows.max() > 0:
        rows = rows / rows.max()
    top_w = float(rows[:max(1, int(h * 0.25))].mean()) if h > 4 else 0
    mid_w = float(rows[int(h * 0.35):int(h * 0.65)].mean()) if h > 4 else 0
    bot_w = float(rows[int(h * 0.75):].mean()) if h > 4 else 0
    max_y = float(np.argmax(rows)) / max(h - 1, 1)
    cnts, _ = cv2.findContours(roi, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    solidity = 0.0
    if cnts:
        c = max(cnts, key=cv2.contourArea)
        area = cv2.contourArea(c)
        hull = cv2.contourArea(cv2.convexHull(c))
        solidity = float(area / hull) if hull else 0.0
    return {'top_w': top_w, 'mid_w': mid_w, 'bot_w': bot_w,
            'max_y': max_y, 'solidity': solidity}


def classify_suit(bgr, ink, suit_blob):
    if suit_blob is None:
        return None, 0.0
    x, y, w, h = suit_blob['x'], suit_blob['y'], suit_blob['w'], suit_blob['h']
    patch = bgr[y:y + h, x:x + w]
    b, g, r = cv2.split(patch)
    ink_roi = ink[y:y + h, x:x + w]
    colored = ink_roi > 0
    if colored.any():
        red_frac = float(((r.astype(int) - b.astype(int)) > 25)[colored].mean())
    else:
        red_frac = float(((r.astype(int) - b.astype(int)) > 25).mean())
    is_red = red_frac > 0.18

    feat = _suit_profile(ink_roi)
    top_w, bot_w, max_y, sol = feat['top_w'], feat['bot_w'], feat['max_y'], feat['solidity']

    if is_red:
        # Heart is wide at the top (two lobes); diamond is pointed both ends.
        if top_w > 0.55 or max_y < 0.32:
            return 'h', 0.9
        return 'd', 0.88

    # Club is less convex (3 lobes) and fairly even top/bottom.
    # Spade is pointed at the top and has a stem.
    even = abs(top_w - bot_w) < 0.16
    if sol < 0.86 or (top_w > 0.34 and even and max_y > 0.45):
        return 'c', 0.86
    return 's', 0.86


# ---------- public API ----------
def read_card(pil_img, region, pad=5):
    """Read rank+suit from a card rectangle on a PIL RGB image.

    Returns dict: rank, suit, method, conf, read
    """
    W, H = pil_img.size
    x0 = max(0, int(region['x']) - pad)
    y0 = max(0, int(region['y']) - pad)
    x1 = min(W, int(region['x'] + region['w']) + pad)
    y1 = min(H, int(region['y'] + region['h']) + pad)
    crop = pil_img.crop((x0, y0, x1, y1)).convert('RGB')
    bgr = cv2.cvtColor(np.array(crop), cv2.COLOR_RGB2BGR)
    return read_card_bgr(bgr)


def read_card_bgr(bgr):
    ink, face = extract_ink(bgr)
    # empty / face-down: little white interior
    if face.mean() < 80:
        return {'rank': None, 'suit': None, 'method': 'back', 'conf': 0.0, 'read': False}
    rank_blob, suit_blob = split_rank_suit(ink)
    rank, rconf, rsrc = classify_rank(ink, rank_blob)
    suit, sconf = classify_suit(bgr, ink, suit_blob)
    ok = bool(rank and suit)
    if ok and rconf >= 0.72 and rank_blob is not None:
        save_rank_template(rank, _crop_blob(ink, rank_blob))
    return {
        'rank': rank,
        'suit': suit,
        'method': 'cv' if ok else 'partial',
        'conf': round(min(rconf, sconf if suit else rconf), 3),
        'read': ok,
        'rank_src': rsrc,
    }


def detect_card_regions(img):
    """White rounded-rect cards. `img` is a PIL RGB image."""
    arr = np.array(img.convert('RGB'))
    gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
    W, H = img.size
    min_w, min_h = max(0.018 * W, 22), max(0.025 * H, 26)

    found = []
    for t in (245, 230, 210, 190, 170):
        _, thresh = cv2.threshold(gray, t, 255, cv2.THRESH_BINARY)
        contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c in contours:
            x, y, w, h = cv2.boundingRect(c)
            if w < min_w or h < min_h:
                continue
            ar = w / float(h)
            if ar < 0.45 or ar > 1.35:
                continue
            patch = arr[y:y + h, x:x + w]
            if patch.size == 0:
                continue
            # must be a bright (white) face, not a blue card-back
            mean = patch.reshape(-1, 3).mean(axis=0)
            if mean.mean() < 170:
                continue
            if mean[2] > mean[0] + 25 and mean[2] > mean[1] + 15:
                continue  # mostly blue
            mask = np.zeros_like(gray)
            cv2.drawContours(mask, [c], -1, 255, -1)
            fill = cv2.countNonZero(mask[y:y + h, x:x + w]) / max(w * h, 1)
            if fill < 0.62:
                continue
            found.append((t, x, y, w, h))

    # Keep the largest box per location. Highest-threshold contours are
    # often just the bright top of the card and cut the suit off.
    found.sort(key=lambda r: (-(r[3] * r[4]), -r[0]))
    cards = []
    for t, x, y, w, h in found:
        overlap = None
        for m in cards:
            if abs(x - m['x']) < max(m['w'] * 0.55, 8) and abs(y - m['y']) < max(m['h'] * 0.55, 8):
                overlap = m
                break
        if overlap:
            if w * h > overlap['w'] * overlap['h']:
                overlap.update({'x': x, 'y': y, 'w': w, 'h': h, 't': t})
            continue
        cards.append({'x': x, 'y': y, 'w': w, 'h': h, 't': t})
    return cards


def selftest():
    """Verify known crops + the 2026-10-02 table screenshot if present."""
    _load_templates()
    fails = 0
    print('--- known crops ---')
    for path, rank, suit in SEED_CARDS:
        if not path.exists():
            print(f'  SKIP missing {path}')
            continue
        img = cv2.imread(str(path))
        got = read_card_bgr(img)
        ok = got['rank'] == rank and got['suit'] == suit
        fails += not ok
        mark = 'OK' if ok else 'FAIL'
        print(f'  {mark} {path.name}: expect {rank}{suit}  got '
              f"{got['rank']}{got['suit']}  conf={got['conf']}  {got['method']}")

    shot = Path('/home/z/Изображения/Снимки экрана/Снимок экрана от 2026-10-02 09-39-18.png')
    if shot.exists():
        print('--- screenshot hero ---')
        pil = Image.open(shot).convert('RGB')
        regions = detect_card_regions(pil)
        print(f'  regions: {len(regions)}')
        reads = []
        for r in sorted(regions, key=lambda c: c['x']):
            got = read_card(pil, r)
            reads.append(f"{got['rank'] or '?'}{got['suit'] or '?'}")
            print(f"  ({r['x']},{r['y']}) {r['w']}x{r['h']} -> "
                  f"{got['rank']}{got['suit']} conf={got['conf']}")
        if reads != ['6d', 'Jc']:
            print(f'  FAIL screenshot expected 6d Jc, got {reads}')
            fails += 1
        else:
            print('  OK screenshot 6d Jc')

    ten_shot = Path('/home/z/Изображения/Снимки экрана/Снимок экрана от 2026-10-02 15-56-35.png')
    if ten_shot.exists():
        print('--- flop with ten ---')
        labels = []
        pil = Image.open(ten_shot).convert('RGB')
        for r in sorted(detect_card_regions(pil), key=lambda c: (c['y'], c['x'])):
            got = read_card(pil, r)
            labels.append(f"{got['rank'] or '?'}{got['suit'] or '?'}")
        print(' ', labels)
        if 'Td' not in labels or '5s' not in labels or 'Jd' not in labels:
            print('  FAIL expected board 5s Td Jd')
            fails += 1
        else:
            print('  OK 5s Td Jd')
    print('fails:', fails)
    return fails


if __name__ == '__main__':
    import sys
    if '--selftest' in sys.argv:
        raise SystemExit(selftest())
    print('card_vision loaded. Use: python3 card_vision.py --selftest')
