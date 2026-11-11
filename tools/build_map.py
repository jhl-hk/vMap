"""Build the 像素北科 map data.

Inputs
  source/beijing-*.osm.pbf               OpenStreetMap extract (geometry, names)
  https://map.ustb.edu.cn/2d/            official campus map (ground cover, labels; cached in tools/.cache)

Outputs (public/data/)
  ground.png   8-bit paletted raster, 2 cells per metre, value = ground class
  campus.json  buildings, trees, labels, gates, fence, world metadata

World frame: metres, x east, y south, origin at the top-left corner of the world box.
"""
import collections, concurrent.futures as cf, glob, io, json, math, os, re, sys, urllib.request

import numpy as np
import osmium
import scipy.ndimage as ndi
from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'tools', '.cache')
OUT = os.path.join(ROOT, 'public', 'data')
os.makedirs(CACHE, exist_ok=True)
os.makedirs(OUT, exist_ok=True)

CAMPUS_WAY = 277989175          # amenity=university 北京科技大学, 学院路30号
BBOX = (39.9830, 116.3420, 39.9960, 116.3650)  # S W N E, generous
LON0, LAT0 = 116.3532, 39.9890
MX = 111320 * math.cos(math.radians(LAT0))
MY = 110574
MARGIN = 70                     # metres around the campus polygon
RES = 2                         # ground cells per metre
TILE_URL = 'https://map.ustb.edu.cn/2d/mapdata/zoom3/{x}_{y}.jpg'
GADGET_URL = 'https://map.ustb.edu.cn/2d/xml/gadgets/3/{x},{y}.xml'
TX0, TX1, TY0, TY1 = 4, 30, 14, 46   # zoom3 tile range covering 本部

# ground classes (shared with src/world/ground.ts)
G_GRASS, G_PAVE, G_ASPH, G_RED, G_TURF, G_BLUE, G_WATER, G_LPAVE, G_LINE, G_URBAN, G_SIDEWALK, G_DIRT = range(1, 13)
DEBUG_COLORS = {
    0: (0, 0, 0), G_GRASS: (112, 178, 72), G_PAVE: (150, 150, 146), G_ASPH: (66, 66, 72), G_RED: (186, 82, 62),
    G_TURF: (62, 150, 66), G_BLUE: (64, 98, 196), G_WATER: (52, 118, 210), G_LPAVE: (214, 212, 204),
    G_LINE: (245, 245, 245), G_URBAN: (186, 182, 172), G_SIDEWALK: (200, 196, 186), G_DIRT: (160, 128, 88),
}


def proj(lon, lat):
    return ((lon - LON0) * MX, -(lat - LAT0) * MY)


# ---------------------------------------------------------------- OSM
class OsmReader(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.feats = []

    def _in(self, lon, lat):
        S, W, N, E = BBOX
        return S <= lat <= N and W <= lon <= E

    def node(self, n):
        if len(n.tags) and self._in(n.location.lon, n.location.lat):
            self.feats.append({'t': 'n', 'id': n.id, 'tags': dict(n.tags), 'c': [n.location.lon, n.location.lat]})

    def way(self, w):
        if not len(w.tags):
            return
        try:
            pts = [[nd.lon, nd.lat] for nd in w.nodes]
        except osmium.InvalidLocationError:
            return
        if any(self._in(*p) for p in pts):
            self.feats.append({'t': 'w', 'id': w.id, 'tags': dict(w.tags), 'c': pts})

    def area(self, a):
        if a.from_way():
            return
        rings = []
        for outer in a.outer_rings():
            o = [[n.lon, n.lat] for n in outer]
            rings.append([o] + [[[n.lon, n.lat] for n in i] for i in a.inner_rings(outer)])
        if any(self._in(*p) for r in rings for p in r[0]):
            self.feats.append({'t': 'r', 'id': a.orig_id(), 'tags': dict(a.tags), 'c': rings})


def load_osm():
    pbf = sorted(glob.glob(os.path.join(ROOT, 'source', '*.osm.pbf')))[-1]
    cache = os.path.join(CACHE, 'osm_' + os.path.basename(pbf) + '.json')
    if os.path.exists(cache):
        return json.load(open(cache))
    h = OsmReader()
    h.apply_file(pbf, locations=True)
    json.dump(h.feats, open(cache, 'w'), ensure_ascii=False)
    return h.feats


def rings_of(f):
    """Outer rings (each with holes) of a closed way or multipolygon, in metres."""
    if f['t'] == 'w':
        c = f['c']
        if len(c) < 4 or c[0] != c[-1]:
            return []
        return [[[proj(*p) for p in c]]]
    if f['t'] == 'r':
        return [[[proj(*p) for p in ring] for ring in poly] for poly in f['c']]
    return []


# ---------------------------------------------------------------- official map
def fetch(url, path):
    if os.path.exists(path):
        return open(path, 'rb').read()
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            b = r.read()
    except Exception:
        b = b''
    open(path, 'wb').write(b)
    return b


def load_mosaic():
    d = os.path.join(CACHE, 'tiles')
    os.makedirs(d, exist_ok=True)
    jobs = [(x, y) for x in range(TX0, TX1) for y in range(TY0, TY1)]
    with cf.ThreadPoolExecutor(16) as ex:
        blobs = list(ex.map(lambda xy: fetch(TILE_URL.format(x=xy[0], y=xy[1]), f'{d}/{xy[0]}_{xy[1]}.jpg'), jobs))
    M = Image.new('RGB', ((TX1 - TX0) * 256, (TY1 - TY0) * 256), (255, 255, 255))
    for (x, y), b in zip(jobs, blobs):
        if b[:3] == b'\xff\xd8\xff':
            M.paste(Image.open(io.BytesIO(b)).convert('RGB'), ((x - TX0) * 256, (y - TY0) * 256))
    return M


def load_gadgets():
    d = os.path.join(CACHE, 'gadgets')
    os.makedirs(d, exist_ok=True)
    jobs = [(x, y) for x in range(0, 40) for y in range(0, 50)]
    with cf.ThreadPoolExecutor(24) as ex:
        blobs = list(ex.map(lambda xy: fetch(GADGET_URL.format(x=xy[0], y=xy[1]), f'{d}/{xy[0]}_{xy[1]}.xml'), jobs))
    seen = {}
    for b in blobs:
        t = b.decode('utf-8-sig', 'replace')
        for g in re.findall(r'<gadget>(.*?)</gadget>', t, re.S):
            rec = {k: (re.search(f'<{k}>(.*?)</{k}>', g, re.S) or [None, None])[1] for k in ('id', 'x0', 'y0', 'type', 'title')}
            if rec['id'] and rec['title']:
                # gadget coords are 4x zoom3 pixels; convert to mosaic pixels
                rec['mx'] = int(rec['x0']) / 4 - TX0 * 256
                rec['my'] = int(rec['y0']) / 4 - TY0 * 256
                seen[rec['id']] = rec
    return list(seen.values())


def clean_name(n):
    n = n.replace('北京科技大学', '').strip()
    return n.translate(str.maketrans('館樓齋棟會議廳學', '馆楼斋栋会议厅学'))


def fit_affine(gadgets, feats):
    """Robust affine mosaic px -> metres, matching official labels to uniquely named OSM features."""
    cent = collections.defaultdict(list)
    for f in feats:
        n = clean_name(f['tags'].get('name', ''))
        for poly in rings_of(f):
            r = np.array(poly[0])
            cent[n].append(r.mean(0))
    by_title = collections.defaultdict(list)
    for g in gadgets:
        by_title[g['title']].append((g['mx'], g['my']))
    pairs = []
    for n, pts in by_title.items():
        if n and n in cent and len(cent[n]) == 1:
            p = np.mean(pts, 0)
            pairs.append((p[0], p[1], *cent[n][0]))
    pairs = np.array(pairs)
    # RANSAC: label names repeat across campuses, so start from the largest consistent subset
    rng = np.random.default_rng(1)
    A_all = np.c_[pairs[:, :2], np.ones(len(pairs))]
    best = None
    for _ in range(4000):
        s = rng.choice(len(pairs), 3, replace=False)
        try:
            ax = np.linalg.solve(A_all[s], pairs[s, 2])
            ay = np.linalg.solve(A_all[s], pairs[s, 3])
        except np.linalg.LinAlgError:
            continue
        res = np.hypot(A_all @ ax - pairs[:, 2], A_all @ ay - pairs[:, 3])
        inl = res < 25
        if best is None or inl.sum() > best.sum():
            best = inl
    keep = best
    for _ in range(6):
        ax = np.linalg.lstsq(A_all[keep], pairs[keep, 2], rcond=None)[0]
        ay = np.linalg.lstsq(A_all[keep], pairs[keep, 3], rcond=None)[0]
        res = np.hypot(A_all @ ax - pairs[:, 2], A_all @ ay - pairs[:, 3])
        keep = res < max(2.5 * np.median(res[keep]), 12)
    print(f'affine: {keep.sum()}/{len(pairs)} label matches, median residual {np.median(res[keep]):.1f} m, '
          f'scale {math.hypot(ax[0], ay[0]):.4f} m/px', file=sys.stderr)
    return np.array([ax, ay, [0, 0, 1]])


# ---------------------------------------------------------------- helpers
def poly_mask(shape, polys, scale, ox, oy, value=1, dtype=np.uint8, outline=False):
    img = Image.new('L', (shape[1], shape[0]), 0)
    d = ImageDraw.Draw(img)
    for poly in polys:
        for i, ring in enumerate(poly):
            pts = [((x - ox) * scale, (y - oy) * scale) for x, y in ring]
            if len(pts) >= 3:
                d.polygon(pts, fill=value if i == 0 else 0, outline=(value if outline else None))
    return np.asarray(img, dtype=dtype)


def line_mask(shape, lines, scale, ox, oy):
    img = Image.new('L', (shape[1], shape[0]), 0)
    d = ImageDraw.Draw(img)
    for pts, width, value in lines:
        q = [((x - ox) * scale, (y - oy) * scale) for x, y in pts]
        w = max(1, int(round(width * scale)))
        d.line(q, fill=value, width=w)
        r = w / 2
        for x, y in q:  # round joints
            d.ellipse((x - r, y - r, x + r, y + r), fill=value)
    return np.asarray(img)


def simplify(pts, tol):
    """Douglas-Peucker on an open polyline (list of (x, y))."""
    if len(pts) < 3:
        return pts
    a, b = np.array(pts[0]), np.array(pts[-1])
    ab = b - a
    L = np.hypot(*ab)
    best, idx = -1, 0
    for i in range(1, len(pts) - 1):
        p = np.array(pts[i])
        d = abs(ab[0] * (a[1] - p[1]) - ab[1] * (a[0] - p[0])) / L if L > 1e-9 else np.hypot(*(p - a))
        if d > best:
            best, idx = d, i
    if best <= tol:
        return [pts[0], pts[-1]]
    return simplify(pts[:idx + 1], tol)[:-1] + simplify(pts[idx:], tol)


def simplify_ring(ring, tol=0.25):
    r = [tuple(p) for p in ring]
    if r[0] == r[-1]:
        r = r[:-1]
    if len(r) < 4:
        return r
    # split at the farthest point from r[0] so DP works on two open chains
    far = max(range(len(r)), key=lambda i: (r[i][0] - r[0][0]) ** 2 + (r[i][1] - r[0][1]) ** 2)
    a = simplify(r[:far + 1], tol)
    b = simplify(r[far:] + [r[0]], tol)
    out = a[:-1] + b[:-1]
    return out if len(out) >= 3 else r


def signed_area(r):
    return 0.5 * sum(r[i][0] * r[(i + 1) % len(r)][1] - r[(i + 1) % len(r)][0] * r[i][1] for i in range(len(r)))


def point_in_ring(x, y, r):
    inside = False
    j = len(r) - 1
    for i in range(len(r)):
        xi, yi = r[i]
        xj, yj = r[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi:
            inside = not inside
        j = i
    return inside


# ---------------------------------------------------------------- building semantics
HEIGHT_OVERRIDES = {  # floors, from campus knowledge; others fall back to heuristics
    '主楼': 7, '逸夫楼': 9, '科技楼': 11, '机电信息楼': 9, '土木环境楼': 10, '理化楼': 5, '文法楼': 5,
    '图书馆': 5, '体育馆': 8, '天工大厦': 18, '科大天工大厦': 18, '方兴大厦': 15, '鼎新楼': 9,
    '外语楼': 5, '综合楼': 6, '办公楼': 5, '经济管理楼': 6, '冶金生态楼': 6, '化生楼': 6, '研究生院': 6,
    '材料测试楼': 4, '实验楼': 5, '数理楼': 5, '金物楼': 4, '腐蚀楼': 4, '科研楼': 7, '校医院': 4,
    '会议中心': 4, '学生活动中心': 3, '鸿博园': 3, '万秀园': 3, '校史馆': 2, '锅炉房': 2,
    '智能科学与技术楼': 8, '科群大厦': 6, '海泰大厦': 4, '运动场看台': 1,
}


def classify_building(name, tags):
    b = tags.get('building', 'yes')
    if '斋' in name:
        return 'dorm'
    if re.search(r'\d+栋', name) or b in ('apartments', 'residential', 'house'):
        return 'home'
    if any(k in name for k in ('馆', '体育')) or b in ('sports_centre',):
        return 'hall'
    if any(k in name for k in ('园', '餐厅', '食堂')):
        return 'canteen'
    if any(k in name for k in ('大厦',)) or b == 'commercial':
        return 'tower'
    if b in ('school', 'university') or '楼' in name:
        return 'teach'
    if b in ('roof', 'grandstand'):
        return 'roof'
    return 'misc'


DEFAULT_FLOORS = {'dorm': 6, 'home': 6, 'hall': 3, 'canteen': 3, 'tower': 12, 'teach': 5, 'roof': 1, 'misc': 3}


# ---------------------------------------------------------------- main
def main():
    feats = load_osm()
    gadgets = load_gadgets()
    mosaic = load_mosaic()
    aff = fit_affine(gadgets, feats)

    campus = next(f for f in feats if f['id'] == CAMPUS_WAY)
    cring = [proj(*p) for p in campus['c']]
    cr = np.array(cring)
    X0 = math.floor(cr[:, 0].min() - MARGIN)
    Y0 = math.floor(cr[:, 1].min() - MARGIN)
    WW = math.ceil(cr[:, 0].max() + MARGIN - X0)
    WH = math.ceil(cr[:, 1].max() + MARGIN - Y0)
    GW, GH = WW * RES, WH * RES
    print(f'world {WW} x {WH} m, ground {GW} x {GH}', file=sys.stderr)

    def to_world(x, y):
        return x - X0, y - Y0

    # ---- official imagery warped onto the ground grid
    T = np.linalg.inv(aff) @ np.array([[1 / RES, 0, X0], [0, 1 / RES, Y0], [0, 0, 1]])
    warp = mosaic.transform((GW, GH), Image.AFFINE, data=tuple(T[:2].flatten()), resample=Image.BILINEAR)
    warp.save(os.path.join(CACHE, 'warp.png'))
    rgb = np.asarray(warp).astype(np.float32) / 255
    hsv = np.asarray(warp.convert('HSV')).astype(np.float32)
    H = hsv[..., 0] * 360 / 255
    S = hsv[..., 1] / 255
    V = hsv[..., 2] / 255
    g = rgb.mean(-1)
    std = np.sqrt(np.clip(ndi.uniform_filter(g * g, 5) - ndi.uniform_filter(g, 5) ** 2, 0, None))

    # detail region: campus polygon grown to cover the boundary roads drawn by the official map
    campus_m = poly_mask((GH, GW), [[cring]], RES, X0, Y0)
    detail = ndi.binary_dilation(campus_m, iterations=int(34 * RES))

    green = (H > 55) & (H < 165) & (S > 0.22)
    treeish = (green & ((std > 0.07) | (V < 0.33))) | ((H > 15) & (H < 55) & (S > 0.45) & (V > 0.42) & (std > 0.06))
    cls = np.full((GH, GW), G_PAVE, np.uint8)
    cls[(S < 0.22) & (V < 0.43)] = G_ASPH
    cls[(S < 0.16) & (V > 0.74)] = G_LPAVE
    cls[green & ~treeish] = G_GRASS
    red = ((H <= 22) | (H >= 335)) & (S > 0.3) & (V > 0.33)
    cls[red] = G_RED
    cls[(H > 192) & (H < 245) & (S > 0.45) & (V > 0.45)] = G_BLUE
    white = (S < 0.12) & (V > 0.86)
    tree_px = treeish & detail

    # ---- OSM layers
    pitches, waters, grass_osm, buildings_raw, roads, courts = [], [], [], [], [], []
    for f in feats:
        t = f['tags']
        if 'building' in t and t['building'] not in ('no',):
            buildings_raw.append(f)
            continue
        if t.get('leisure') == 'pitch' or t.get('leisure') == 'track':
            pitches += rings_of(f)
            for poly in rings_of(f):
                courts.append((t.get('sport', ''), poly[0]))
        if t.get('natural') == 'water' or t.get('water') or t.get('leisure') == 'swimming_pool':
            waters += rings_of(f)
        if t.get('landuse') in ('grass', 'recreation_ground', 'forest') or t.get('leisure') in ('park', 'garden') or t.get('natural') in ('wood', 'scrub', 'grassland'):
            grass_osm += rings_of(f)
        if f['t'] == 'w' and 'highway' in t:
            roads.append(f)

    pitch_m = poly_mask((GH, GW), pitches, RES, X0, Y0).astype(bool)
    # inside pitches every non-red/blue surface is court or turf; anti-aliased court lines read as grey paving
    cls[pitch_m & ~np.isin(cls, (G_RED, G_BLUE))] = G_TURF
    # court lines and fences read as textured green; no trees on sports surfaces
    sports = pitch_m | ndi.binary_dilation(np.isin(cls, (G_RED, G_BLUE)), iterations=int(1.5 * RES))
    tree_px &= ~sports
    # court and lane markings: bright white on sports surfaces or asphalt
    near_sport = ndi.binary_dilation(np.isin(cls, (G_RED, G_TURF, G_BLUE, G_GRASS)) & pitch_m | (cls == G_RED) | (cls == G_BLUE), iterations=2)
    near_asph = ndi.binary_dilation(cls == G_ASPH, iterations=2)
    line_px = (white & (near_sport | near_asph) & detail) | (pitch_m & (S < 0.25) & (V > 0.7))

    # trees removed from ground: fill with the nearest class, but never extend roads under street trees
    base = cls.copy()
    base[tree_px] = 0
    src = (base != 0) & (base != G_ASPH)
    idx = ndi.distance_transform_edt(~src, return_distances=False, return_indices=True)
    cls = np.where(tree_px, base[idx[0], idx[1]], base)
    # majority filter to remove label text and shading speckle
    for _ in range(2):
        cls = majority(cls, 3)
    # paving shades from the official render are lighting, not material: merge small islands
    cls = np.where(np.isin(cls, (G_PAVE, G_LPAVE)), majority(np.where(np.isin(cls, (G_PAVE, G_LPAVE)), cls, 0), 7), cls)
    cls[cls == 0] = G_PAVE
    cls[line_px & ~tree_px] = G_LINE
    # procedural markings: the official tiles are too coarse for court lines and running lanes
    marks = sports_markings(courts)
    mark_m = line_mask((GH, GW), [(pts, 0.25, 1) for pts in marks], RES, X0, Y0).astype(bool)
    cls[mark_m & np.isin(cls, (G_TURF, G_GRASS, G_RED, G_BLUE))] = G_LINE
    track_dims = None
    for sport, ring in courts:
        if sport:
            continue
        # untagged pitch holding a running track: lanes follow the edge of the grass infield
        field = poly_mask((GH, GW), [[ring]], RES, X0, Y0).astype(bool)
        if field.sum() / RES ** 2 < 3000:
            continue
        inner = field & np.isin(cls, (G_TURF, G_GRASS))
        if (cls[field] == G_RED).mean() < 0.25 or inner.sum() < 0.25 * field.sum():
            continue
        lab, _ = ndi.label(inner)
        infield = ndi.binary_fill_holes(lab == np.argmax(np.bincount(lab[lab > 0])))
        dist = ndi.distance_transform_edt(~infield) / RES
        lane = (cls == G_RED) & (dist > 0.3) & (dist <= 9.9) & (np.abs(dist - np.round(dist / 1.22) * 1.22) < 0.26)
        cls[lane] = G_LINE
        track_dims = oriented_rect(ring)[3:]

    # outside the official detail: OSM based city
    out = ~detail
    cls[out] = G_URBAN
    gm = poly_mask((GH, GW), grass_osm, RES, X0, Y0).astype(bool)
    cls[out & gm] = G_GRASS
    road_lines = []
    widths = {'motorway': 24, 'trunk': 22, 'primary': 18, 'secondary': 14, 'tertiary': 10, 'unclassified': 7,
              'residential': 6, 'service': 4, 'living_street': 5, 'motorway_link': 7, 'trunk_link': 7, 'primary_link': 7}
    for f in roads:
        hw = f['tags']['highway']
        if hw in widths:
            pts = [proj(*p) for p in f['c']]
            road_lines.append((pts, widths[hw] + 4, 1))
    sidewalk = line_mask((GH, GW), road_lines, RES, X0, Y0).astype(bool)
    road_lines = [(p, w - 4, 1) for p, w, _ in road_lines]
    asph = line_mask((GH, GW), road_lines, RES, X0, Y0).astype(bool)
    cls[out & sidewalk] = G_SIDEWALK
    cls[out & asph] = G_ASPH
    wm = poly_mask((GH, GW), waters, RES, X0, Y0).astype(bool)
    cls[wm] = G_WATER

    # ---- buildings
    gad_w = []
    for gd in gadgets:
        v = aff @ np.array([gd['mx'], gd['my'], 1])
        x, y = to_world(v[0], v[1])
        if 0 <= x < WW and 0 <= y < WH:
            gad_w.append((gd, x, y))
    used_label = set()
    buildings = []
    bmask = np.zeros((GH, GW), bool)
    for f in buildings_raw:
        t = f['tags']
        for poly in rings_of(f):
            outer = [to_world(*p) for p in poly[0]]
            o = np.array(outer)
            if o[:, 0].max() < 0 or o[:, 1].max() < 0 or o[:, 0].min() > WW or o[:, 1].min() > WH:
                continue
            outer = simplify_ring(outer)
            if abs(signed_area(outer)) < 12:
                continue
            holes = [simplify_ring([to_world(*p) for p in h]) for h in poly[1:]]
            holes = [h for h in holes if len(h) >= 3 and abs(signed_area(h)) > 4]
            # screen y is down: make outer clockwise on screen (positive signed area), holes negative
            if signed_area(outer) < 0:
                outer = outer[::-1]
            holes = [h if signed_area(h) < 0 else h[::-1] for h in holes]
            name = clean_name(t.get('name', ''))
            if not name:
                for gd, x, y in gad_w:
                    if gd['type'] == '1' and point_in_ring(x, y, outer):
                        name = gd['title']
                        break
            kind = classify_building(name, t)
            floors = None
            if 'building:levels' in t:
                try:
                    floors = float(t['building:levels'])
                except ValueError:
                    pass
            if floors is None:
                floors = HEIGHT_OVERRIDES.get(name) or HEIGHT_OVERRIDES.get(name.replace('科大', ''))
            in_campus = point_in_ring(*np.mean(outer, 0), [to_world(*p) for p in cring])
            if floors is None:
                floors = DEFAULT_FLOORS[kind] if in_campus else 4
            height = 1.2 + floors * 3.3 if kind != 'roof' else 4.0
            m = poly_mask((GH, GW), [[outer] + holes], RES, 0, 0).astype(bool)
            inner = ndi.binary_erosion(m, iterations=3)
            if inner.sum() < 8:
                inner = m
            roof = None
            if detail[m].mean() > 0.5 and inner.any():
                px = np.asarray(warp)[inner]
                roof = '#%02x%02x%02x' % tuple(int(v) for v in np.median(px, 0))
            bmask |= m
            buildings.append({
                'n': name, 'k': kind, 'h': round(height, 1), 'f': int(floors), 'roof': roof,
                'p': [round(v * 10) for pt in outer for v in pt],
                'holes': [[round(v * 10) for pt in hh for v in pt] for hh in holes] or None,
                'campus': bool(in_campus),
            })
    # names repeated outside the campus belong to other institutions' buildings
    campus_names = {b['n'] for b in buildings if b['campus'] and b['n']}
    for b in buildings:
        if not b['campus'] and b['n'] in campus_names:
            b['n'] = ''
    # ground under buildings: pavement, so the PNG stays compressible
    cls[bmask & ~wm] = G_PAVE
    # red/blue roof slivers next to OSM footprints are roofs, not courts
    near_b = ndi.binary_dilation(bmask, iterations=int(4 * RES))
    for c in (G_RED, G_BLUE):
        lab, n = ndi.label(cls == c)
        if n:
            area = ndi.sum(np.ones_like(lab), lab, range(1, n + 1)) / RES ** 2
            nearf = ndi.mean(near_b, lab, range(1, n + 1))
            inpitch = ndi.mean(pitch_m, lab, range(1, n + 1))
            bad = ((area < 40) | (nearf > 0.35)) & (inpitch < 0.5)
            cls[np.isin(lab, np.nonzero(bad)[0] + 1)] = G_PAVE
    # road names printed on the official tiles: flatten to asphalt around each road label
    for gd, x, y in gad_w:
        if gd['type'] != '2':
            continue
        r = int(16 * RES)
        x0, x1 = max(int(x * RES) - r, 0), min(int(x * RES) + r, GW)
        y0, y1 = max(int(y * RES) - r, 0), min(int(y * RES) + r, GH)
        win = cls[y0:y1, x0:x1]
        if (win == G_ASPH).mean() > 0.3:
            light = np.isin(win, (G_LINE, G_LPAVE, G_PAVE))
            lab, n = ndi.label(light)
            if n:
                area = ndi.sum(np.ones_like(lab), lab, range(1, n + 1)) / RES ** 2
                small = np.isin(lab, np.nonzero(area < 6)[0] + 1)
                win[small] = G_ASPH

    # ---- trees
    trees = place_trees(tree_px & ~ndi.binary_dilation(bmask, iterations=1), H, S, V, wm)
    # also OSM single trees outside the detail area
    for f in feats:
        if f['t'] == 'n' and f['tags'].get('natural') == 'tree':
            x, y = to_world(*proj(*f['c']))
            if 0 <= x < WW and 0 <= y < WH and not detail[int(y * RES), int(x * RES)]:
                trees.append((x, y, 2.4, 0))

    # ---- labels
    labels, gates, roads_named = [], [], []
    seen_lab = set()
    for gd, x, y in gad_w:
        key = (gd['type'], gd['title'], round(x / 25), round(y / 25))
        if key in seen_lab:
            continue
        seen_lab.add(key)
        ty = gd['type']
        rec = {'t': gd['title'], 'x': round(x * 10), 'y': round(y * 10)}
        if ty == '15':
            gates.append(rec)
        elif ty == '2':
            roads_named.append(rec)
        elif ty == '1':
            labels.append(rec)
        elif ty == '7':
            rec['c'] = 'P'
            labels.append(rec)
    for f in feats:  # OSM gates on the boundary
        if f['t'] == 'n' and f['tags'].get('barrier') == 'gate':
            x, y = to_world(*proj(*f['c']))
            if 0 <= x < WW and 0 <= y < WH:
                gates.append({'t': clean_name(f['tags'].get('name', '')) or '门', 'x': round(x * 10), 'y': round(y * 10), 'osm': 1})

    # ---- scale check: a standard 400 m track measures about 176.9 x 92.5 m over the outer lane
    if track_dims:
        print(f'athletics track outline {track_dims[0] * 2:.1f} x {track_dims[1] * 2:.1f} m (standard 176.9 x 92.5 m)', file=sys.stderr)

    # ---- write
    pal = Image.new('P', (GW, GH))
    pal.putdata(cls.flatten().tolist())
    flat = []
    for i in range(256):
        flat += list(DEBUG_COLORS.get(i, (255, 0, 255)))
    pal.putpalette(flat)
    pal.save(os.path.join(OUT, 'ground.png'), optimize=True)

    data = {
        'v': 1,
        'name': '北京科技大学',
        'size': [WW, WH],
        'res': RES,
        'origin': {'lon0': LON0, 'lat0': LAT0, 'mx': MX, 'my': MY, 'x0': X0, 'y0': Y0},
        'campus': [round(v * 10) for p in cring for v in to_world(*p)],
        'buildings': buildings,
        'trees': [v for t in trees for v in (round(t[0] * 10), round(t[1] * 10), round(t[2] * 10), t[3])],
        'labels': labels,
        'gates': gates,
        'roads': roads_named,
    }
    for b in data['buildings']:
        if b['holes'] is None:
            del b['holes']
        if b['roof'] is None:
            del b['roof']
    s = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
    open(os.path.join(OUT, 'campus.json'), 'w').write(s)
    print(f'buildings {len(buildings)}, trees {len(trees)}, labels {len(labels)}, gates {len(gates)}, '
          f'campus.json {len(s) // 1024} KB, ground.png {os.path.getsize(os.path.join(OUT, "ground.png")) // 1024} KB', file=sys.stderr)


def majority(a, k):
    """k x k majority filter over class ids."""
    classes = np.unique(a)
    best = np.zeros(a.shape, np.float32) - 1
    out = a.copy()
    for c in classes:
        cnt = ndi.uniform_filter((a == c).astype(np.float32), k)
        sel = cnt > best
        out[sel] = c
        best[sel] = cnt[sel]
    return out


def oriented_rect(ring):
    """Centre, unit axes (long, short) and half sizes of the bounding rectangle along the principal axis."""
    p = np.array(ring, float)
    c = p.mean(0)
    q = p - c
    _, v = np.linalg.eigh(q.T @ q)
    u = v[:, 1]
    n = np.array([-u[1], u[0]])
    a, b = q @ u, q @ n
    c = c + u * (a.max() + a.min()) / 2 + n * (b.max() + b.min()) / 2
    return c, u, n, (a.max() - a.min()) / 2, (b.max() - b.min()) / 2


def sports_markings(courts):
    """Polylines (metres) for soccer, tennis, basketball and volleyball pitches."""
    out = []
    for sport, ring in courts:
        # polygons much larger than one court cover a group of courts: no single layout fits
        if sport not in ('soccer', 'tennis', 'basketball', 'volleyball') or (sport != 'soccer' and abs(signed_area(ring)) > 1100):
            continue
        c, u, n, hl, hw = oriented_rect(ring)

        def P(a, b):
            return tuple(c + u * a + n * b)

        def circle(r):
            return [P(math.cos(t) * r, math.sin(t) * r) for t in np.linspace(0, 2 * math.pi, 33)]

        inset = 1.0 if sport == 'soccer' else 0.6
        L, W = hl - inset, hw - inset
        if L < 4 or W < 3:
            continue
        out.append([P(-L, -W), P(L, -W), P(L, W), P(-L, W), P(-L, -W)])
        out.append([P(0, -W), P(0, W)])
        if sport == 'soccer':
            s = min(1.0, L * 2 / 105)
            out.append(circle(9.15 * s))
            for side in (-1, 1):
                for d, w in ((16.5 * s, min(40.3 * s, W * 2 - 2)), (5.5 * s, min(18.3 * s, W * 2 - 4))):
                    out.append([P(side * L, -w / 2), P(side * (L - d), -w / 2), P(side * (L - d), w / 2), P(side * L, w / 2)])
        elif sport == 'tennis':
            sv = min(6.4, L * 0.55)
            for side in (-1, 1):
                out.append([P(side * sv, -W * 0.75), P(side * sv, W * 0.75)])
            out.append([P(-sv, 0), P(sv, 0)])
        elif sport == 'basketball':
            out.append(circle(1.8))
            for side in (-1, 1):
                out.append([P(side * L, -2.45), P(side * (L - 5.8), -2.45), P(side * (L - 5.8), 2.45), P(side * L, 2.45)])
    return out



def place_trees(mask, H, S, V, water):
    """Poisson-ish tree placement inside canopy pixels. Returns (x, y, radius_m, kind)."""
    rng = np.random.default_rng(7)
    lab, n = ndi.label(mask)
    objs = ndi.find_objects(lab)
    trees = []
    occ = {}

    def free(x, y, r):
        cx, cy = int(x // 4), int(y // 4)
        for i in range(cx - 2, cx + 3):
            for j in range(cy - 2, cy + 3):
                for (tx, ty, tr) in occ.get((i, j), ()):
                    if (tx - x) ** 2 + (ty - y) ** 2 < (0.92 * (tr + r)) ** 2:
                        return False
        return True

    def add(x, y, r, kind):
        trees.append((round(x, 1), round(y, 1), round(r, 1), kind))
        occ.setdefault((int(x // 4), int(y // 4)), []).append((x, y, r))

    def kind_at(px, py):
        y0, y1, x0, x1 = max(py - 3, 0), py + 4, max(px - 3, 0), px + 4
        h = H[y0:y1, x0:x1].mean()
        s = S[y0:y1, x0:x1].mean()
        v = V[y0:y1, x0:x1].mean()
        if 15 < h < 50 and s > 0.4:
            return 2 if h < 30 else 1          # maple (red/orange) / ginkgo (yellow)
        if v < 0.27:
            return 3                            # evergreen
        return 0                                # deciduous green

    for i, sl in enumerate(objs, 1):
        if sl is None:
            continue
        comp = lab[sl] == i
        area = comp.sum() / RES ** 2
        if area < 3:
            continue
        ys, xs = np.nonzero(comp)
        ys = ys + sl[0].start
        xs = xs + sl[1].start
        if area < 22:
            px, py = int(xs.mean()), int(ys.mean())
            r = min(3.2, max(1.4, math.sqrt(area / math.pi) * 1.05))
            add(px / RES, py / RES, r, kind_at(px, py))
            continue
        tries = int(area / 4) + 10
        order = rng.permutation(len(xs))[:tries * 3]
        for k in order:
            px, py = xs[k], ys[k]
            r = float(rng.uniform(2.0, 3.3))
            x, y = px / RES, py / RES
            if free(x, y, r):
                add(x, y, r, kind_at(px, py))
    return trees


if __name__ == '__main__':
    main()
