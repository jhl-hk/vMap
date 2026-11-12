"""Build the 像素北科 map data.

Inputs
  source/beijing-*.osm.pbf               OpenStreetMap extract (georeference, building tags, the city around the campus)
  https://map.ustb.edu.cn/2d/            official campus map (render, outlines, labels; cached in tools/.cache)

Outputs (public/data/)
  ground.png   8-bit paletted raster, 4 cells per metre, value = ground class
  roofs.webp   the official render inside each official outline, on the ground grid
  campus.json  buildings, painted lines, props, trees, labels, gates, fence, world metadata

World frame: metres, origin at the top-left corner of the world box, axes along those of the official map,
which follow the campus grid and the running track (about 2 degrees off east and south).
Official map frame: pixels of its finest zoom level (zoom 1, about 0.1 m per pixel).
"""
import collections, concurrent.futures as cf, glob, http.client, io, json, math, os, re, sys, time, urllib.request

import numpy as np
import osmium
import scipy.ndimage as ndi
from scipy import optimize
from PIL import Image, ImageDraw, ImageFilter

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'tools', '.cache')
OUT = os.path.join(ROOT, 'public', 'data')
os.makedirs(CACHE, exist_ok=True)
os.makedirs(OUT, exist_ok=True)

CAMPUS_WAY = 277989175          # amenity=university 北京科技大学, 学院路30号
BBOX = (39.9830, 116.3420, 39.9960, 116.3650)  # S W N E, generous
LON0, LAT0 = 116.3532, 39.9890
# metres per degree on the WGS-84 ellipsoid at LAT0
_E2 = 0.00669437999014
_W2 = 1 - _E2 * math.sin(math.radians(LAT0)) ** 2
MX = math.radians(6378137.0 / math.sqrt(_W2)) * math.cos(math.radians(LAT0))
MY = math.radians(6378137.0 * (1 - _E2) / _W2 ** 1.5)
MARGIN = 70                     # metres around the campus polygon
RES = 4                         # ground cells per metre
WRES = 8                        # working raster cells per metre, a multiple of RES
SUN = math.radians(228)         # shadows in the official render fall this way (x east, y south) ...
SHADOW = 0.97                   # ... and are this long per metre of height
SITE = 'https://map.ustb.edu.cn/2d/'
TILE_URL = SITE + 'mapdata/zoom{z}/{{x}}_{{y}}.jpg'     # zoom 1 is the finest; each level halves the scale
GADGET_URL = SITE + 'xml/gadgets/3/{x},{y}.xml'
OUTLINE_URL = SITE + 'xml/tips/1/{x},{y}.xml'

# ground classes (shared with src/world/ground.ts)
G_GRASS, G_PAVE, G_ASPH, G_RED, G_TURF, G_BLUE, G_WATER, G_LPAVE, G_URBAN, G_SIDEWALK, G_DIRT = range(1, 12)
DEBUG_COLORS = {
    0: (0, 0, 0), G_GRASS: (112, 178, 72), G_PAVE: (150, 150, 146), G_ASPH: (66, 66, 72), G_RED: (186, 82, 62),
    G_TURF: (62, 150, 66), G_BLUE: (64, 98, 196), G_WATER: (52, 118, 210), G_LPAVE: (214, 212, 204),
    G_URBAN: (186, 182, 172), G_SIDEWALK: (200, 196, 186), G_DIRT: (160, 128, 88),
}


TURN = 0.0                      # rotation of the world frame from true north, radians; set by main()


def proj(lon, lat):
    x, y = (lon - LON0) * MX, -(lat - LAT0) * MY
    c, s = math.cos(TURN), math.sin(TURN)
    return (c * x - s * y, s * x + c * y)


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
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=20) as r:
                b = r.read()
            break
        except (OSError, http.client.HTTPException):
            if attempt == 3:
                raise
            time.sleep(1 + attempt)
    open(path, 'wb').write(b)
    return b


def fetch_grid(url, name, tx0, tx1, ty0, ty1, ext):
    d = os.path.join(CACHE, name)
    os.makedirs(d, exist_ok=True)
    jobs = [(x, y) for x in range(tx0, tx1) for y in range(ty0, ty1)]
    with cf.ThreadPoolExecutor(16) as ex:
        return jobs, list(ex.map(lambda xy: fetch(url.format(x=xy[0], y=xy[1]), f'{d}/{xy[0]}_{xy[1]}.{ext}'), jobs))


def tile_range(aff, box, size):
    """Index range (x0, x1, y0, y1) of the tiles `size` zoom-1 pixels wide that cover a box in metres."""
    x0, y0, x1, y1 = box
    c = (np.linalg.inv(aff) @ np.array([[x0, x1, x0, x1], [y0, y0, y1, y1], [1, 1, 1, 1]]))[:2] / size
    return math.floor(c[0].min()) - 1, math.ceil(c[0].max()) + 1, math.floor(c[1].min()) - 1, math.ceil(c[1].max()) + 1


def imagery(aff, box, zoom, scale):
    """The official render of a box in metres (x0, y0, x1, y1), resampled to `scale` pixels per metre."""
    zs = 2 ** (zoom - 1)
    tx0, tx1, ty0, ty1 = tile_range(aff, box, 256 * zs)
    jobs, blobs = fetch_grid(TILE_URL.format(z=zoom), f'tiles_z{zoom}', tx0, tx1, ty0, ty1, 'jpg')
    M = Image.new('RGB', ((tx1 - tx0) * 256, (ty1 - ty0) * 256), (255, 255, 255))
    for (x, y), b in zip(jobs, blobs):
        if b[:3] == b'\xff\xd8\xff':
            M.paste(Image.open(io.BytesIO(b)).convert('RGB'), ((x - tx0) * 256, (y - ty0) * 256))
    T = (np.array([[1 / zs, 0, -tx0 * 256], [0, 1 / zs, -ty0 * 256], [0, 0, 1]]) @ np.linalg.inv(aff)
         @ np.array([[1 / scale, 0, box[0]], [0, 1 / scale, box[1]], [0, 0, 1]]))
    size = (round((box[2] - box[0]) * scale), round((box[3] - box[1]) * scale))
    return M.transform(size, Image.AFFINE, data=tuple(T[:2].flatten()), resample=Image.BILINEAR)


def load_gadgets():
    """Labels of the official map, positions in zoom-1 pixels."""
    _, blobs = fetch_grid(GADGET_URL, 'gadgets', 0, 40, 0, 50, 'xml')
    seen = {}
    for b in blobs:
        t = b.decode('utf-8-sig', 'replace')
        for g in re.findall(r'<gadget>(.*?)</gadget>', t, re.S):
            rec = {k: (re.search(f'<{k}>(.*?)</{k}>', g, re.S) or [None, None])[1] for k in ('id', 'x0', 'y0', 'type', 'title')}
            if rec['id'] and rec['title']:
                rec['px'] = int(rec['x0'])
                rec['py'] = int(rec['y0'])
                seen[rec['id']] = rec
    return list(seen.values())


def load_outlines(tx0, tx1, ty0, ty1):
    """Named outlines drawn on the official map (buildings, courts, squares), rings in zoom-1 pixels."""
    _, blobs = fetch_grid(OUTLINE_URL, 'outlines', tx0, tx1, ty0, ty1, 'xml')
    seen = {}
    for b in blobs:
        t = b.decode('gb18030', 'replace')
        for z in re.findall(r'<zJ>(.*?)</zJ>', t, re.S):
            rec = {k: (re.search(f'<{k}>(.*?)</{k}>', z, re.S) or [None, ''])[1] for k in ('zH', 'zI', 'fG', 'fJ', 'sC')}
            ring = list(zip((int(v) for v in rec['fG'].split(',') if v), (int(v) for v in rec['fJ'].split(',') if v)))
            if len(ring) >= 3:
                seen[rec['zH']] = {'name': clean_name(rec['zI']), 'sort': rec['sC'], 'ring': ring}
    return list(seen.values())


def clean_name(n):
    n = n.replace('北京科技大学', '').strip()
    return n.translate(str.maketrans('館樓齋棟會議廳學', '馆楼斋栋会议厅学'))


def apply_affine(aff, pts):
    return [(aff[0, 0] * x + aff[0, 1] * y + aff[0, 2], aff[1, 0] * x + aff[1, 1] * y + aff[1, 2]) for x, y in pts]


def fit_robust(src, dst, keep, floor):
    """Least-squares affine src -> dst, repeatedly dropping pairs further off than 2.5 medians (at least `floor`)."""
    A = np.c_[src, np.ones(len(src))]
    for _ in range(8):
        ax = np.linalg.lstsq(A[keep], dst[keep, 0], rcond=None)[0]
        ay = np.linalg.lstsq(A[keep], dst[keep, 1], rcond=None)[0]
        res = np.hypot(A @ ax - dst[:, 0], A @ ay - dst[:, 1])
        keep = res < max(2.5 * np.median(res[keep]), floor)
    return np.array([ax, ay, [0, 0, 1]]), keep, res


def fit_affine(gadgets, feats):
    """Coarse affine official px -> metres, matching official labels to uniquely named OSM features."""
    cent = collections.defaultdict(list)
    for f in feats:
        n = clean_name(f['tags'].get('name', ''))
        for poly in rings_of(f):
            r = np.array(poly[0])
            cent[n].append(r.mean(0))
    by_title = collections.defaultdict(list)
    for g in gadgets:
        by_title[g['title']].append((g['px'], g['py']))
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
    aff, keep, res = fit_robust(pairs[:, :2], pairs[:, 2:], best, 12)
    print(f'labels: {keep.sum()}/{len(pairs)} matches, median residual {np.median(res[keep]):.1f} m', file=sys.stderr)
    return aff


def refine_affine(aff, outlines, footprints):
    """Affine official px -> metres from official outlines paired with OSM footprints by overlap."""
    boxes = [(np.min(r, 0), np.max(r, 0)) for r in footprints]
    for it in range(4):
        src, dst = [], []
        for o in outlines:
            ring = apply_affine(aff, o['ring'])
            lo, hi = np.min(ring, 0), np.max(ring, 0)
            best, match = 0.3 if it == 0 else 0.5, None
            for r, (blo, bhi) in zip(footprints, boxes):
                if (blo > hi).any() or (bhi < lo).any():
                    continue
                i, a, b = overlap(ring, r)
                if i > best * (a + b - i):
                    best, match = i / (a + b - i), r
            if match is not None:
                src.append(centroid(o['ring']))
                dst.append(centroid(match))
        src, dst = np.array(src), np.array(dst)
        aff, keep, res = fit_robust(src, dst, np.ones(len(src), bool), 1.0)
    sx, sy = math.hypot(aff[0, 0], aff[1, 0]), math.hypot(aff[0, 1], aff[1, 1])
    print(f'outlines: {keep.sum()}/{len(src)} matches, median residual {np.median(res[keep]):.1f} m, '
          f'scale {sx:.5f} x {sy:.5f} m/px, rotation {math.degrees(math.atan2(aff[1, 0], aff[0, 0])):.2f} deg', file=sys.stderr)
    return aff


# ---------------------------------------------------------------- helpers
def poly_mask(shape, polys, scale, ox, oy, value=1, dtype=np.uint8, outline=False):
    img = Image.new('L', (shape[1], shape[0]), 0)
    d = ImageDraw.Draw(img)
    for poly in polys:
        for i, ring in enumerate(poly):
            # PIL addresses pixel centres
            pts = [((x - ox) * scale - 0.5, (y - oy) * scale - 0.5) for x, y in ring]
            if len(pts) >= 3:
                d.polygon(pts, fill=value if i == 0 else 0, outline=(value if outline else None))
    return np.asarray(img, dtype=dtype)


def local_mask(rings, scale, shape):
    """Mask of a polygon with holes inside its bounding window of a `shape` raster: (mask, window slices)."""
    o = np.array(rings[0])
    x0, y0 = np.maximum(np.floor(o.min(0) * scale).astype(int), 0)
    x1, y1 = np.minimum(np.ceil(o.max(0) * scale).astype(int) + 1, (shape[1], shape[0]))
    if x1 <= x0 or y1 <= y0:
        return None
    return poly_mask((y1 - y0, x1 - x0), [rings], scale, x0 / scale, y0 / scale).astype(bool), (slice(y0, y1), slice(x0, x1))


def line_mask(shape, lines, scale, ox, oy):
    img = Image.new('L', (shape[1], shape[0]), 0)
    d = ImageDraw.Draw(img)
    for pts, width, value in lines:
        q = [((x - ox) * scale - 0.5, (y - oy) * scale - 0.5) for x, y in pts]
        w = max(1, int(round(width * scale)))
        d.line(q, fill=value, width=w)
        r = w / 2
        for x, y in q:  # round joints
            d.ellipse((x - r, y - r, x + r, y + r), fill=value)
    return np.asarray(img)


def simplify(pts, tol):
    """Douglas-Peucker on an open polyline."""
    p = np.asarray(pts, float)
    keep = np.zeros(len(p), bool)
    keep[[0, -1]] = True
    todo = [(0, len(p) - 1)]
    while todo:
        a, b = todo.pop()
        if b - a < 2:
            continue
        ab, q = p[b] - p[a], p[a + 1:b] - p[a]
        L = np.hypot(*ab)
        d = np.abs(ab[0] * q[:, 1] - ab[1] * q[:, 0]) / L if L > 1e-9 else np.hypot(q[:, 0], q[:, 1])
        i = a + 1 + int(d.argmax())
        if d[i - a - 1] > tol:
            keep[i] = True
            todo += [(a, i), (i, b)]
    return [tuple(v) for v in p[keep].tolist()]


def simplify_ring(ring, tol):
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


def centroid(r):
    """Area centroid of a ring."""
    p = np.array(r, float)
    q = np.roll(p, -1, 0)
    c = p[:, 0] * q[:, 1] - q[:, 0] * p[:, 1]
    return ((p + q) * c[:, None]).sum(0) / (3 * c.sum())


def overlap(a, b):
    """Areas in square metres of the intersection of two rings and of each ring."""
    lo = np.minimum(np.min(a, 0), np.min(b, 0))
    hi = np.maximum(np.max(a, 0), np.max(b, 0))
    shape = (int((hi[1] - lo[1]) * RES) + 2, int((hi[0] - lo[0]) * RES) + 2)
    ma = poly_mask(shape, [[a]], RES, lo[0], lo[1]) > 0
    mb = poly_mask(shape, [[b]], RES, lo[0], lo[1]) > 0
    return (ma & mb).sum() / RES ** 2, ma.sum() / RES ** 2, mb.sum() / RES ** 2


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
# official outline categories that are buildings, the kind some of them imply, and buildings filed elsewhere
OUTLINE_SORTS = {'002001', '002002', '002003', '002004', '002005', '002999', '010001', '010002', '010003'}
OUTLINE_KIND = {'002001': 'hall', '002003': 'dorm', '002005': 'home', '010001': 'canteen'}
OUTLINE_BUILDINGS = {'气膜馆', '快递中心', '教职工活动中心'}
SPORTS = re.compile('球场$|运动场$')
PROPS = {'bikes': '自行车|非机动车|车棚|充电', 'statue': '像$|锻锤|鼎$|展翅', 'rock': '石$', 'table': '乒乓', 'cage': '拳击', 'lockers': '柜|近邻宝'}


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
    aff = fit_affine(gadgets, feats)

    # ---- official outlines, final registration, with north up
    campus = next(f for f in feats if f['id'] == CAMPUS_WAY)
    cr = np.array([proj(*p) for p in campus['c']])
    outlines = load_outlines(*tile_range(aff, (*(cr.min(0) - MARGIN), *(cr.max(0) + MARGIN)), 256))
    aff = refine_affine(aff, outlines, [poly[0] for ft in feats if ft['tags'].get('building', 'no') != 'no' for poly in rings_of(ft)])
    # ---- turn the world onto the axes of the official map
    global TURN
    TURN = math.atan2(aff[0, 1], aff[1, 1])
    aff = np.array([[math.cos(TURN), -math.sin(TURN), 0], [math.sin(TURN), math.cos(TURN), 0], [0, 0, 1]]) @ aff
    print(f'world turned {math.degrees(TURN):.2f} deg', file=sys.stderr)

    cring = [proj(*p) for p in campus['c']]
    cr = np.array(cring)
    X0 = math.floor(cr[:, 0].min() - MARGIN)
    Y0 = math.floor(cr[:, 1].min() - MARGIN)
    WW = math.ceil(cr[:, 0].max() + MARGIN - X0)
    WH = math.ceil(cr[:, 1].max() + MARGIN - Y0)
    GW, GH = WW * RES, WH * RES
    HW, HH = WW * WRES, WH * WRES
    box = (X0, Y0, X0 + WW, Y0 + WH)
    print(f'world {WW} x {WH} m, ground {GW} x {GH}', file=sys.stderr)

    def to_world(x, y):
        return x - X0, y - Y0

    f = WRES // RES

    def up(m):
        return np.repeat(np.repeat(m, f, 0), f, 1)

    def down(m, n):
        """Ground cells holding at least n set working cells."""
        return m.reshape(GH, f, GW, f).sum((1, 3)) >= n

    # ---- OSM layers
    waters, grass_osm, buildings_raw, roads = [], [], [], []
    for ft in feats:
        t = ft['tags']
        if 'building' in t and t['building'] not in ('no',):
            buildings_raw += [(t, poly) for poly in rings_of(ft)]
            continue
        if t.get('natural') == 'water' or t.get('water') or t.get('leisure') == 'swimming_pool':
            waters += rings_of(ft)
        if t.get('landuse') in ('grass', 'recreation_ground', 'forest') or t.get('leisure') in ('park', 'garden') or t.get('natural') in ('wood', 'scrub', 'grassland'):
            grass_osm += rings_of(ft)
        if ft['t'] == 'w' and 'highway' in t:
            roads.append(ft)

    for o in outlines:
        o['w'] = [to_world(*p) for p in apply_affine(aff, o['ring'])]
    campus_w = [to_world(*p) for p in cring]

    # ---- official imagery warped onto the working grid
    warp = imagery(aff, box, 1, WRES)
    warp.save(os.path.join(CACHE, 'warp.png'))
    warp_px = np.asarray(warp)
    hsv = np.asarray(warp.convert('HSV')).astype(np.float32)
    H = hsv[..., 0] * 360 / 255
    S = hsv[..., 1] / 255
    V = hsv[..., 2] / 255

    # detail region: campus polygon grown to cover the boundary roads drawn by the official map
    campus_m = poly_mask((GH, GW), [[campus_w]], RES, 0, 0).astype(bool)
    detail_lo = ndi.distance_transform_edt(~campus_m) <= 34 * RES
    detail = up(detail_lo)

    # ---- buildings: official outlines where the official map has them, OSM footprints elsewhere
    gad_w = []
    for gd in gadgets:
        x, y = to_world(*apply_affine(aff, [(gd['px'], gd['py'])])[0])
        if 0 <= x < WW and 0 <= y < WH:
            gad_w.append((gd, x, y))
    buildings = []
    bmask = np.zeros((HH, HW), bool)

    def add_building(outer, holes, names, tags, kind, official=False):
        outer = square(simplify_ring(outer, 0.1), True)
        if abs(signed_area(outer)) < 12:
            return
        holes = [square(simplify_ring(h, 0.1), True) for h in holes]
        holes = [h for h in holes if len(h) >= 3 and abs(signed_area(h)) > 4]
        # screen y is down: make outer clockwise on screen (positive signed area), holes negative
        if signed_area(outer) < 0:
            outer = outer[::-1]
        holes = [h if signed_area(h) < 0 else h[::-1] for h in holes]
        floors = None
        if 'building:levels' in tags:
            try:
                floors = float(tags['building:levels'])
            except ValueError:
                pass
        if floors is None:
            floors = next((HEIGHT_OVERRIDES[n] for nm in names for n in (nm, nm.replace('科大', '')) if n in HEIGHT_OVERRIDES), None)
        in_campus = point_in_ring(*np.mean(outer, 0), campus_w)
        guess = floors is None
        if guess:
            floors = DEFAULT_FLOORS[kind] if in_campus else 4
        height = 1.2 + floors * 3.3 if kind != 'roof' else 4.0
        roof = None
        lm = local_mask([outer] + holes, WRES, (HH, HW))
        if lm and lm[0].any():
            m, win = lm
            inner = ndi.binary_erosion(m, iterations=int(1.5 * WRES))
            if inner.sum() < 2 * WRES ** 2:
                inner = m
            if detail[win][m].mean() > 0.5:
                roof = '#%02x%02x%02x' % tuple(int(v) for v in np.median(warp_px[win][inner], 0))
            bmask[win] |= m
        buildings.append({
            'n': names[0], 'k': kind, 'h': round(height, 1), 'f': int(floors), 'roof': roof,
            'p': [round(v * 10) for pt in outer for v in pt],
            'holes': [[round(v * 10) for pt in hh for v in pt] for hh in holes] or None,
            'campus': bool(in_campus), 'tex': official, 'guess': guess,
        })

    official = [o for o in outlines if o['sort'] in OUTLINE_SORTS or o['name'] in OUTLINE_BUILDINGS]
    obox = [(np.min(o['w'], 0), np.max(o['w'], 0)) for o in official]
    source = [None] * len(official)   # the OSM footprint that overlaps each outline most: tags and courtyards
    osm_only = []
    for t, poly in buildings_raw:
        rings = [[to_world(*p) for p in r] for r in poly]
        lo, hi = np.min(rings[0], 0), np.max(rings[0], 0)
        if hi[0] < 0 or hi[1] < 0 or lo[0] > WW or lo[1] > WH:
            continue
        covered, best = 0.0, None
        for j, (blo, bhi) in enumerate(obox):
            if (blo > hi).any() or (bhi < lo).any():
                continue
            i, a, _ = overlap(rings[0], official[j]['w'])
            if i:
                covered += i / a
                if best is None or i > best[0]:
                    best = (i, j)
        if covered > 0.3:
            if source[best[1]] is None or best[0] > source[best[1]][0]:
                source[best[1]] = (best[0], t, rings)
        else:
            osm_only.append((t, rings))
    for o, src in zip(official, source):
        t, rings = src[1:] if src else ({}, [o['w']])
        # courtyards come from OSM, moved by the offset between the two outlines
        dx, dy = centroid(o['w']) - centroid(rings[0])
        holes = [[(x + dx, y + dy) for x, y in h] for h in rings[1:]]
        holes = [h for h in holes if all(point_in_ring(x, y, o['w']) for x, y in h)]
        kind = classify_building(o['name'], t)
        if kind in ('teach', 'misc'):
            kind = OUTLINE_KIND.get(o['sort'], kind)
        add_building(o['w'], holes, (o['name'], clean_name(t.get('name', ''))), t, kind, True)
    for t, rings in osm_only:
        name = clean_name(t.get('name', ''))
        if not name:
            for gd, x, y in gad_w:
                if gd['type'] == '1' and point_in_ring(x, y, rings[0]):
                    name = gd['title']
                    break
        add_building(rings[0], rings[1:], (name,), t, classify_building(name, t))
    # names repeated outside the campus belong to other institutions' buildings
    campus_names = {b['n'] for b in buildings if b['campus'] and b['n']}
    for b in buildings:
        if not b['campus'] and b['n'] in campus_names:
            b['n'] = ''

    # ---- ground cover from the imagery. The render has baked shadows: they halve value, leave the hue and
    # saturation of plants and paint alone, and tint grey surfaces blue
    shade = (H > 180) & (H < 250) & (S > 0.085) & (S < 0.34) & (V < 0.55)
    autumn = ((H > 15) & (H <= 60) & (S > 0.6)) | (((H <= 15) | (H >= 340)) & (S > 0.75))
    # crowns are duller than lawn; painted lines and letters are thinner than any crown
    crown = ndi.binary_opening(((H > 60) & (H < 100) & (S >= 0.3) & (S < 0.72)) | autumn, iterations=WRES // 2)
    cls = np.full((HH, HW), G_PAVE, np.uint8)
    cls[~shade & (S < 0.22) & (V < 0.43)] = G_ASPH
    cls[shade] = np.where(V[shade] < 0.29, G_ASPH, G_LPAVE)
    cls[(S < 0.16) & (V > 0.74)] = G_LPAVE
    cls[(H > 60) & (H < 125) & (S > 0.22)] = G_GRASS
    cls[(H >= 125) & (H < 170) & (S > 0.4)] = G_TURF
    cls[((H <= 22) | (H >= 335)) & (S > 0.3) & (V > 0.2)] = G_RED
    blue = (H > 185) & (H < 245) & (S > 0.45) & (V > 0.25)
    cls[blue] = np.where(H[blue] < 204, G_WATER, G_BLUE)       # ponds are cyan, courts ultramarine
    # the roofs of bike sheds are neither
    sheds = poly_mask((HH, HW), [[o['w']] for o in outlines if re.search(PROPS['bikes'], o['name'])], WRES, 0, 0).astype(bool)
    cls[sheds & blue] = G_PAVE
    tree_px = crown & detail
    pitch_m = poly_mask((HH, HW), [[o['w']] for o in outlines if SPORTS.search(o['name'])], WRES, 0, 0).astype(bool)
    # inside pitches every non-red/blue surface is court or turf
    cls[pitch_m & ~np.isin(cls, (G_RED, G_BLUE))] = G_TURF
    # sports surfaces: the pitches and every large red, blue or court-green area
    lab, _ = ndi.label(ndi.binary_opening(np.isin(cls, (G_RED, G_BLUE, G_TURF)), iterations=WRES // 2))
    large = np.bincount(lab.ravel()) >= 150 * WRES ** 2
    large[0] = False
    sports = pitch_m | ndi.binary_dilation(large[lab], iterations=int(1.5 * WRES))
    # road names are printed on the tiles in pure white: the road continues under them. A name is a cluster of
    # thin strokes on a road, most of them not straight along an axis as road markings are
    near_asph = ndi.binary_dilation(cls == G_ASPH, iterations=WRES)
    lum = warp_px.min(-1)
    pale = (lum >= 232) & near_asph & ~sports
    pale &= ~ndi.binary_opening(pale, iterations=WRES)
    k = int(1.5 * WRES)
    straight = ndi.binary_opening(pale, np.ones((1, k), bool)) | ndi.binary_opening(pale, np.ones((k, 1), bool))
    lab, n = ndi.label(ndi.binary_closing(pale, iterations=int(1.5 * WRES)), structure=np.ones((3, 3)))
    size, cores, bars = (ndi.sum(m, lab, range(1, n + 1)) for m in (pale, pale & (lum >= 248), straight))
    glyph = np.zeros(n + 1, bool)
    for i, (sy, sx) in enumerate(ndi.find_objects(lab)):
        glyph[i + 1] = cores[i] > 0 and min(sy.stop - sy.start, sx.stop - sx.start) >= 2 * WRES and bars[i] < 0.7 * size[i]
    text = ndi.binary_dilation(glyph[lab], iterations=WRES // 2) & detail
    text |= ndi.binary_dilation(text, iterations=WRES * 3 // 2) & np.isin(cls, (G_PAVE, G_LPAVE))     # the glow around the strokes
    cls = fill_nearest(cls, text, ~text)
    # planting beds: dark warm colours away from the courts
    cls[~sports & ~text & ((H < 60) | (H >= 335)) & (S > 0.3) & (V < 0.5)] = G_GRASS
    # painted markings: thin bright strokes on sports surfaces and asphalt, yellow ones on asphalt
    white = V * (1 - S)
    relief = white - ndi.grey_opening(white, size=WRES + 1)
    shape_true = np.linalg.inv(aff[:2, :2]) * math.sqrt(np.linalg.det(aff[:2, :2]))
    lanes, track = track_lanes(relief * ndi.binary_dilation(cls == G_RED, iterations=WRES // 2), shape_true, WRES, (0, 0))
    cls[track & np.isin(cls, (G_PAVE, G_LPAVE))] = G_RED     # lanes too close to tell the surface between them
    table_m = poly_mask((HH, HW), [[o['w']] for o in outlines if re.search(PROPS['table'], o['name'])], WRES, 0, 0).astype(bool)
    covered = tree_px | text | bmask | ~detail
    # strokes on a slanted line fade in and out: keep the faint parts joined to clear ones
    parts, n = ndi.label((relief > 0.2) & sports)
    clear = np.zeros(n + 1, bool)
    clear[parts[relief > 0.4]] = True
    clear[0] = False
    # strokes in the track band that no fitted lane accounts for stay: the sprint lanes run on past the curves
    fitted = line_mask((HH, HW), [(pl, 0.9, 1) for pl in lanes], WRES, 0, 0).astype(bool)
    on_road = (relief > 0.2) & (S < 0.12) & (V > 0.8) & near_asph & ~sports
    stroke = ((clear[parts] & ~fitted) | on_road) & ~covered
    # table-tennis tables are outlined in white: each becomes a prop, not lines
    props = []
    parts, n = ndi.label(ndi.binary_dilation(stroke & table_m))
    for sy, sx in ndi.find_objects(parts):
        short, long = sorted(((sy.stop - sy.start) / WRES, (sx.stop - sx.start) / WRES))
        if 1.2 <= short <= 2.2 and 2.2 <= long <= 3.4:
            props.append(('table', (sx.start / WRES, sy.start / WRES), (sx.stop / WRES, sy.stop / WRES)))
    stroke &= ~table_m
    straight, used = axis_lines(stroke, white, WRES, 2.0, 0.6)
    styled = [('f1f1ec', 0.125, pl) for pl in lanes + [pl for pl, _ in straight] + trace_lines(stroke & ~used, white, WRES, (0, 0))]
    amber = (H > 35) & (H < 65) & (S > 0.5) & (V > 0.6)
    amber &= ~ndi.binary_opening(amber, iterations=WRES // 2) & near_asph & ~sports & ~covered & ~ndi.binary_dilation(tree_px, iterations=WRES)
    amber &= ndi.uniform_filter((cls == G_ASPH).astype(np.float32), 2 * WRES) > 0.5
    # paint runs straight, fallen leaves do not
    styled += [('e8c33c', 0.125, pl) for pl in trace_lines(amber, S * V, WRES, (0, 0))
               if sum(math.dist(a, b) for a, b in zip(pl, pl[1:])) < 1.2 * math.dist(pl[0], pl[-1])]
    paint = ((relief > 0.2) & sports & np.isin(cls, (G_PAVE, G_LPAVE))) | on_road | amber
    # coloured paint on courts and squares: bands and outlines up to 1.5 m wide, kept as lines with their width.
    # Black counts only where it runs straight, or joins such a run: shadows are dark and thin too
    square_m = poly_mask((HH, HW), [[o['w']] for o in outlines if o['name'].endswith('广场')], WRES, 0, 0).astype(bool)
    hard = ndi.uniform_filter(np.isin(cls, (G_BLUE, G_PAVE, G_LPAVE)).astype(np.float32), 3 * WRES) > 0.5
    warm = (H < 15) | (H > 345)
    for sel, black in (((H > 40) & (H < 70) & (S > 0.55) & (V > 0.7), False), ((H > 95) & (H < 125) & (S > 0.6) & (V > 0.7), False),
                       ((H > 185) & (H < 212) & (S > 0.55) & (V > 0.8), False), (warm & (S > 0.5) & (V > 0.7), False),
                       (warm & (S > 0.4) & (V > 0.2) & (V <= 0.7), False), ((V < 0.3) & (S < 0.3) & square_m, True)):
        m = sel & (sports | square_m) & hard & ~covered
        m &= ~ndi.binary_opening(m, iterations=3 * WRES // 4)
        if m.sum() < 4 * WRES ** 2:
            continue
        bands, used = axis_lines(m, m.astype(np.float32), WRES, 5.0 if black else 2.0, 1.6)
        rest = m & ~used
        if black:
            parts, n = ndi.label(m)
            joined = np.zeros(n + 1, bool)
            joined[parts[used & m]] = True
            joined[0] = False
            rest &= joined[parts]
            m = joined[parts]
        depth = ndi.distance_transform_edt(m)
        colour = '%02x%02x%02x' % tuple(int(v) for v in np.median(warp_px[m], 0))
        styled += [(colour, width, pl) for pl, width in bands]
        for pl in trace_lines(rest, depth, WRES, (0, 0)):
            at = np.clip(np.floor(np.array(pl) * WRES).astype(int), 0, (HW - 1, HH - 1))
            styled.append((colour, 2 * float(np.median(depth[at[:, 1], at[:, 0]])) / WRES, pl))
        paint |= ndi.binary_dilation(m, iterations=2)

    # the ground continues under trees and paint: fill with the nearest class; a road reaches at most 2 m under a crown
    holes = tree_px | paint
    dist, idx = ndi.distance_transform_edt(holes, return_indices=True)
    road = holes & (cls[idx[0], idx[1]] == G_ASPH) & (dist <= 2 * WRES)
    cls = fill_nearest(cls, holes, cls != G_ASPH)
    cls[road] = G_ASPH
    # majority filter to remove shading speckle
    cls = reduce(majority(cls, WRES + 1), f)
    # paving shades from the official render are lighting, not material: merge small islands
    cls = np.where(np.isin(cls, (G_PAVE, G_LPAVE)), majority(np.where(np.isin(cls, (G_PAVE, G_LPAVE)), cls, 0), 3 * RES + 1), cls)
    cls[cls == 0] = G_PAVE
    # dark patches cut off from the roads are deep shade, not asphalt
    lab, _ = ndi.label(cls == G_ASPH)
    cls[(np.bincount(lab.ravel()) < 60 * RES ** 2)[lab]] = G_LPAVE
    # lawn specks on paving are the fringes of crowns standing there
    lab, _ = ndi.label(cls == G_GRASS)
    cls = fill_nearest(cls, (np.bincount(lab.ravel()) < 12 * RES ** 2)[lab], cls != G_GRASS)
    # a patch of lawn or turf that lies under and around crowns only is the crowns themselves, not ground
    by_tree = down(ndi.binary_dilation(tree_px, iterations=WRES), 1)
    for c in (G_GRASS, G_TURF):
        lab, n = ndi.label(cls == c)
        size = np.bincount(lab.ravel(), minlength=n + 1)
        fringe = (size < 150 * RES ** 2) & (np.bincount(lab[by_tree], minlength=n + 1) >= 0.9 * size)
        fringe[0] = False
        cls = fill_nearest(cls, fringe[lab], cls != c)

    # outside the official detail: OSM based city
    out = ~detail_lo
    cls[out] = G_URBAN
    gm = poly_mask((GH, GW), grass_osm, RES, X0, Y0).astype(bool)
    cls[out & gm] = G_GRASS
    road_lines = []
    widths = {'motorway': 24, 'trunk': 22, 'primary': 18, 'secondary': 14, 'tertiary': 10, 'unclassified': 7,
              'residential': 6, 'service': 4, 'living_street': 5, 'motorway_link': 7, 'trunk_link': 7, 'primary_link': 7}
    for ft in roads:
        hw = ft['tags']['highway']
        if hw in widths:
            pts = [proj(*p) for p in ft['c']]
            road_lines.append((pts, widths[hw] + 4, 1))
    sidewalk = line_mask((GH, GW), road_lines, RES, X0, Y0).astype(bool)
    road_lines = [(p, w - 4, 1) for p, w, _ in road_lines]
    asph = line_mask((GH, GW), road_lines, RES, X0, Y0).astype(bool)
    cls[out & sidewalk] = G_SIDEWALK
    cls[out & asph] = G_ASPH
    wm = poly_mask((GH, GW), waters, RES, X0, Y0).astype(bool)
    cls[wm] = G_WATER

    # ground under buildings: pavement, so the PNG stays compressible
    bmask_lo = down(bmask, f * f // 2)
    sports_lo = down(sports, f * f // 2)
    cls[bmask_lo & ~wm] = G_PAVE
    # red/blue roof slivers next to footprints are roofs, not courts or ponds
    near_b = ndi.binary_dilation(bmask_lo, iterations=int(4 * RES))
    for c in (G_RED, G_BLUE, G_WATER):
        lab, n = ndi.label((cls == c) & ~wm)
        if n:
            area = ndi.sum(np.ones_like(lab), lab, range(1, n + 1)) / RES ** 2
            nearf = ndi.mean(near_b, lab, range(1, n + 1))
            inpitch = ndi.mean(sports_lo, lab, range(1, n + 1))
            bad = ((area < 40) | (nearf > 0.35)) & (inpitch < 0.5)
            if c == G_WATER:        # ponds are not rectangles; blue canopies are
                bad |= area > 0.85 * np.array([(sy.stop - sy.start) * (sx.stop - sx.start) for sy, sx in ndi.find_objects(lab)]) / RES ** 2
            cls[np.isin(lab, np.nonzero(bad)[0] + 1)] = G_PAVE

    # ---- trees
    canopy = tree_px & ~ndi.binary_dilation(bmask, iterations=WRES // 2)
    trees = place_trees(canopy, H, S, V)
    # also OSM single trees outside the detail area
    for ft in feats:
        if ft['t'] == 'n' and ft['tags'].get('natural') == 'tree':
            x, y = to_world(*proj(*ft['c']))
            if 0 <= x < WW and 0 <= y < WH and not detail_lo[int(y * RES), int(x * RES)]:
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
    for ft in feats:  # OSM gates on the boundary
        if ft['t'] == 'n' and ft['tags'].get('barrier') == 'gate':
            x, y = to_world(*proj(*ft['c']))
            if 0 <= x < WW and 0 <= y < WH:
                gates.append({'t': clean_name(ft['tags'].get('name', '')) or '门', 'x': round(x * 10), 'y': round(y * 10), 'osm': 1})

    # ---- storeys of buildings without a tag or a table entry, from the shadows they cast in the official render
    lawn = (H > 60) & (H < 125) & (S >= 0.72)
    lit = np.full((HH, HW), -1, np.int8)        # 1 lit, 0 in shadow, -1 cannot tell
    lit[(S < 0.085)] = 1
    lit[shade] = 0
    lit[lawn] = V[lawn] >= 0.31
    lit[bmask | tree_px] = -1
    cast = shadow_lengths([b['p'] for b in buildings], lit, bmask)
    measured = 0
    for b, length in zip(buildings, cast):
        if b.pop('guess') and length and b['k'] != 'roof':
            b['f'] = int(min(max(round((length / SHADOW - 1.2) / 3.3), 1), 30))
            b['h'] = round(1.2 + b['f'] * 3.3, 1)
            measured += 1

    # ---- roofs as the official render shows them
    roofed = poly_mask((GH, GW), [[o['w']] for o in official], RES, 0, 0).astype(bool)
    roof_px = np.asarray(warp.resize((GW, GH), Image.BOX)).copy()
    roof_px[~roofed] = np.median(roof_px[roofed], 0)        # flat, so only roofs cost bytes
    # a few flat colours: reads as pixel art, and compresses
    roof_px = Image.fromarray(roof_px).filter(ImageFilter.MedianFilter(3)).quantize(16, method=Image.MEDIANCUT, dither=Image.NONE)
    roof_px.convert('RGB').save(os.path.join(OUT, 'roofs.webp'), lossless=True, method=6)

    # ---- props: the small things the official map outlines
    for o in outlines:
        kind = next((k for k, pat in PROPS.items() if re.search(pat, o['name'])), None)
        if kind and kind != 'table' and o not in official:
            props.append((kind, np.min(o['w'], 0), np.max(o['w'], 0)))
    props = [{'k': k, 'x': round(lo[0] * 10), 'y': round(lo[1] * 10), 'w': round((hi[0] - lo[0]) * 10), 'd': round((hi[1] - lo[1]) * 10)} for k, lo, hi in props]
    lines = collections.defaultdict(list)
    for colour, width, pl in styled:
        lines[max(2, round(width * 16)), colour].append(pl)

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
        'origin': {'lon0': LON0, 'lat0': LAT0, 'mx': MX, 'my': MY, 'turn': TURN, 'x0': X0, 'y0': Y0},
        'campus': [round(v * 10) for p in campus_w for v in p],
        'buildings': buildings,
        'props': props,
        # painted lines by colour and width in 1/16 m, widest first: polylines, 1/20 m: first vertex, then steps
        'lines': [{'c': c, 'w': w, 'l': [steps(pl) for pl in pls]} for (w, c), pls in sorted(lines.items(), reverse=True)],
        'trees': [v for t in trees for v in (round(t[0] * 10), round(t[1] * 10), round(t[2] * 10), t[3])],
        'labels': labels,
        'gates': gates,
        'roads': roads_named,
    }
    for b in data['buildings']:
        if not b['tex']:
            del b['tex']
        if b['holes'] is None:
            del b['holes']
        if b['roof'] is None:
            del b['roof']
    s = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
    open(os.path.join(OUT, 'campus.json'), 'w').write(s)
    print(f'buildings {len(buildings)} ({len(official)} official outlines), lines {len(styled)} in {len(lines)} styles, {measured} heights from shadows, props {len(props)}, '
          f'trees {len(trees)}, labels {len(labels)}, '
          f'gates {len(gates)}, campus.json {len(s) // 1024} KB, ground.png {os.path.getsize(os.path.join(OUT, "ground.png")) // 1024} KB', file=sys.stderr)


def steps(pl):
    """A polyline as integers of 1/20 m: the first vertex, then the step to each next one."""
    q = [(round(x * 20), round(y * 20)) for x, y in pl]
    return list(q[0]) + [v for a, b in zip(q, q[1:]) for v in (b[0] - a[0], b[1] - a[1])]


def shadow_lengths(rings, lit, built):
    """Length in metres of the shadow each footprint (flat decimetre ring) casts, or None where rays cast from its
    far walls do not agree. lit: 1 lit ground, 0 shadow, -1 unknown, working grid. built: all footprints."""
    d = np.array([math.cos(SUN), math.sin(SUN)])
    ts = np.arange(0.5, 90, 0.25)
    out = []
    for ring in rings:
        p = np.array(ring, float).reshape(-1, 2) / 10
        e = np.roll(p, -1, 0) - p
        found = []
        for k in range(len(p)):
            L = np.hypot(*e[k])
            n = np.array([e[k, 1], -e[k, 0]]) / max(L, 1e-9)
            if L < 2 or n @ d < 0.3:
                continue
            base = p[k] + e[k] * (np.arange(0.5, L, 1.0) / L)[:, None] + n * 0.3
            at = np.floor((base[:, None, :] + ts[None, :, None] * d) * WRES).astype(int)
            ok = (at[..., 0] >= 0) & (at[..., 1] >= 0) & (at[..., 0] < lit.shape[1]) & (at[..., 1] < lit.shape[0])
            x, y = np.clip(at[..., 0], 0, lit.shape[1] - 1), np.clip(at[..., 1], 0, lit.shape[0] - 1)
            state, wall = np.where(ok, lit[y, x], -1), built[y, x] | ~ok
            for s, w in zip(state, wall):
                s = s[:np.argmax(w)] if w.any() else s          # the ray ends at the next building
                for j in np.nonzero(s == 1)[0]:
                    ahead, behind = s[j:j + 8], s[:j]
                    ahead, behind = ahead[ahead >= 0], behind[behind >= 0]
                    if len(ahead) < 5 or ahead.mean() < 0.8:
                        continue
                    # shadow all the way from the wall, ending within 1.5 m of this lit cell
                    if len(behind) >= 4 and behind.mean() <= 0.3 and (j - np.nonzero(s[:j] == 0)[0][-1]) * 0.25 <= 1.5:
                        found.append(ts[j] + 0.3)
                    break
        q = np.percentile(found, [25, 50, 75]) if len(found) >= 15 else None
        out.append(q[1] if q is not None and q[2] - q[0] <= 0.2 * q[1] else None)
    return out


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


def reduce(a, f):
    """Most common class id in each f x f block."""
    blocks = a.reshape(a.shape[0] // f, f, a.shape[1] // f, f)
    best = np.zeros(blocks.shape[::2], np.int16) - 1
    out = np.zeros(blocks.shape[::2], a.dtype)
    for c in np.unique(a):
        cnt = (blocks == c).sum((1, 3))
        sel = cnt > best
        out[sel] = c
        best[sel] = cnt[sel]
    return out


def thin(m):
    """Zhang-Suen thinning: strokes one cell wide."""
    m = np.pad(m, 1)
    ring = ((1, 0), (1, -1), (0, -1), (-1, -1), (-1, 0), (-1, 1), (0, 1), (1, 1))   # N, NE, E, SE, S, SW, W, NW
    while True:
        before = m.sum()
        for a, b in (((0, 2, 4), (2, 4, 6)), ((0, 2, 6), (0, 4, 6))):
            p = [np.roll(m, s, (0, 1)) for s in ring]
            count = sum(q.astype(np.uint8) for q in p)
            turns = sum((~p[i] & p[(i + 1) % 8]).astype(np.uint8) for i in range(8))
            m = m & ~((count >= 2) & (count <= 6) & (turns == 1) & ~(p[a[0]] & p[a[1]] & p[a[2]]) & ~(p[b[0]] & p[b[1]] & p[b[2]]))
        if m.sum() == before:
            return m[1:-1, 1:-1]


def axis_lines(mask, weight, scale, least, widest):
    """Straight strokes along the world axes in `mask`, a raster of `scale` cells per metre: at least `least` metres
    long, at most `widest` across. Returns them as ([(x0, y0), (x1, y1)], width) in metres, each end moved onto the
    stroke it meets, and the cells they cover. `weight` places a stroke across its width."""
    found = [[], []]
    used = np.zeros(mask.shape, bool)
    for turned in (0, 1):
        m, wt = (mask.T, weight.T) if turned else (mask, weight)
        run = ndi.binary_opening(ndi.binary_closing(m, np.ones((1, scale // 4 + 1), bool)), np.ones((1, int(least * scale)), bool))
        lab, _ = ndi.label(run, structure=np.ones((3, 3)))
        for i, (sy, sx) in enumerate(ndi.find_objects(lab), 1):
            if sy.stop - sy.start > widest * scale:
                continue
            part = lab[sy, sx] == i
            w = np.where(part, wt[sy, sx], 0).sum(1) + 1e-6 * part.sum(1)
            across = sy.start + ((np.arange(len(w)) + 0.5) * w).sum() / w.sum()
            found[turned].append((sx.start / scale, sx.stop / scale, across / scale, part.sum() / (sx.stop - sx.start) / scale))
            (used.T if turned else used)[sy, sx] |= part
    found = [np.array(f, float).reshape(-1, 4) for f in found]
    out = []
    for turned in (0, 1):
        other = found[1 - turned]
        for a0, a1, c, width in found[turned]:
            ends = []
            for a in (a0, a1):
                hit = (np.abs(other[:, 2] - a) < 0.3) & (other[:, 0] - 0.3 <= c) & (c <= other[:, 1] + 0.3)
                ends.append(other[hit, 2][np.argmin(np.abs(other[hit, 2] - a))] if hit.any() else a)
            out.append(([(c, a) for a in ends] if turned else [(a, c) for a in ends], width))
    return out, ndi.binary_dilation(used)


def trace_lines(mask, weight, scale, origin):
    """Centre lines of the strokes in `mask`, a raster of `scale` cells per metre whose corner is at `origin`
    metres, as polylines in metres. `weight` is the brightness that places each line to a fraction of a cell."""
    ys, xs = np.nonzero(thin(mask))
    cells = set(zip(xs.tolist(), ys.tolist()))

    def links(x, y):
        """Neighbours along the stroke: across an edge, or across a corner where no edge neighbour joins the two."""
        out = [(x + dx, y + dy) for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)) if (x + dx, y + dy) in cells]
        return out + [(x + dx, y + dy) for dx in (-1, 1) for dy in (-1, 1)
                      if (x + dx, y + dy) in cells and (x + dx, y) not in cells and (x, y + dy) not in cells]

    link = {p: links(*p) for p in cells}
    nodes = {p for p, l in link.items() if len(l) != 2}
    paths, seen = [], set()
    for a in sorted(nodes):
        for b in link[a]:
            if (a, b) in seen:
                continue
            path = [a, b]
            while path[-1] not in nodes:
                n = link[path[-1]]
                path.append(n[0] if n[1] == path[-2] else n[1])
            seen.add((a, b))
            seen.add((path[-1], path[-2]))
            paths.append(path)
    done = {p for path in paths for p in path}
    for a in sorted(cells - done - nodes):      # closed loops without a junction
        if a in done:
            continue
        path = [a, link[a][0]]
        while path[-1] != a:
            n = link[path[-1]]
            path.append(n[0] if n[1] == path[-2] else n[1])
        done.update(path)
        paths.append(path)

    lines = []
    steps = np.arange(-2, 2.01, 0.5)
    for path in paths:
        p = np.array(path, float) + 0.5
        ends = [len(link[path[0]]), len(link[path[-1]])]
        if len(p) < (2.0 if ends == [1, 1] else 1.0 if 1 in ends else 0.5) * scale:     # specks and spurs
            continue
        # slide each point across the stroke to its brightness centre
        t = p[np.minimum(np.arange(len(p)) + 3, len(p) - 1)] - p[np.maximum(np.arange(len(p)) - 3, 0)]
        n = np.c_[-t[:, 1], t[:, 0]] / np.maximum(np.hypot(t[:, 0], t[:, 1]), 1e-9)[:, None]
        at = p[:, None, :] + steps[None, :, None] * n[:, None, :] - 0.5
        w = ndi.map_coordinates(weight, [at[..., 1], at[..., 0]], order=1, mode='nearest')
        w = np.maximum(w - w.min(1, keepdims=True), 0)
        off = (w * steps).sum(1) / np.maximum(w.sum(1), 1e-9)
        p += ndi.median_filter(np.clip(off, -1, 1), 9, mode='nearest')[:, None] * n      # crossings pull sideways
        q = np.array(square(simplify(p / scale + origin, 0.05), False))
        for i, j, deg in ((0, 1, ends[0]), (-1, -2, ends[1])):      # reach the centre of the line met at a junction
            if deg > 2 and path[0] != path[-1]:
                d = q[i] - q[j]
                q[i] += d / max(np.hypot(*d), 1e-9) * 0.12
        if path[0] == path[-1]:
            q[0] = q[-1] = (q[0] + q[-1]) / 2
        lines.append([tuple(v) for v in q])
    return lines


def square(pts, closed):
    """Make runs of edges within 3 degrees of a world axis exactly parallel to it."""
    p = np.array(pts, float)
    n = len(p) if closed and len(p) > 2 else len(p) - 1
    e = np.roll(p, -1, 0)[:n] - p[:n]
    kind = np.where(np.abs(e[:, 1]) < np.abs(e[:, 0]) * 0.0524, 1, np.where(np.abs(e[:, 0]) < np.abs(e[:, 1]) * 0.0524, 0, -1))
    length = np.hypot(e[:, 0], e[:, 1])
    start = next((i for i in range(n) if kind[i] != kind[i - 1]), 0) if n == len(p) else 0
    i = 0
    while i < n:
        j = i
        while j + 1 < n and kind[(start + j + 1) % n] == kind[(start + i) % n]:
            j += 1
        k = kind[(start + i) % n]
        if k >= 0:      # edges i..j run along axis 1 - k: their k coordinate is one value
            idx = [(start + m) % len(p) for m in range(i, j + 2)]
            mid = [(p[a, k] + p[b, k]) / 2 for a, b in zip(idx, idx[1:])]
            p[idx, k] = np.average(mid, weights=np.maximum(length[[(start + m) % n for m in range(i, j + 1)]], 1e-9))
        i = j + 1
    return [tuple(v) for v in p]


def fill_nearest(cls, holes, sources):
    """Give the cells in `holes` the class of the nearest cell in `sources`."""
    idx = ndi.distance_transform_edt(holes | ~sources, return_distances=False, return_indices=True)
    return np.where(holes, cls[idx[0], idx[1]], cls)


def track_lanes(relief, true, scale, origin):
    """Lane lines of a running track. The imagery resolves them only in part, so a stadium outline (two straights
    joined by half circles) and a lane width are fitted to the line pixels, and each ring is drawn where pixels
    back it. relief: brightness of thin strokes on the track surface, a raster of `scale` cells per metre whose corner
    is at `origin` metres. true: 2 x 2 matrix from world metres to the frame the official map was drawn in, where
    the curves are circles. Returns the lane lines as polylines in metres and the track band on the raster."""
    stroke = relief > 0.2
    none = [], np.zeros(stroke.shape, bool)
    lab, n = ndi.label(ndi.uniform_filter(stroke.astype(np.float32), 3 * scale) > 0.1)
    if not n:
        return none
    sizes = np.bincount(lab.ravel())
    sizes[0] = 0
    band = lab == sizes.argmax()
    lab, n = ndi.label(ndi.binary_fill_holes(band) & ~band)
    if band.sum() < 2000 * scale ** 2 or not n:
        return none
    ys, xs = np.nonzero(band & (relief > 0.3))
    ys, xs = ys[::max(1, len(xs) // 30000)], xs[::max(1, len(xs) // 30000)]
    pts = ((np.c_[xs, ys] + 0.5) / scale + origin) @ true.T
    wt = relief[ys, xs] - 0.3       # brighter cells sit nearer the middle of a line
    # the infield, the hole in the band, gives the first estimate of the two curve centres
    ys, xs = np.nonzero(lab == np.bincount(lab.ravel())[1:].argmax() + 1)
    q = ((np.c_[xs, ys][::97] + 0.5) / scale + origin) @ true.T
    c = q.mean(0)
    u = np.linalg.eigh(np.cov((q - c).T))[1][:, 1]
    v = np.array([-u[1], u[0]])
    al, ac = (q - c) @ u, (q - c) @ v
    c = c + u * (al.max() + al.min()) / 2 + v * (ac.max() + ac.min()) / 2
    half = (al.max() - al.min() - ac.max() + ac.min()) / 2
    along = (pts - c) @ u

    def radius(p, prm):
        """Distance to the segment joining the centres of the two curves."""
        a, ab = prm[:2], prm[2:4] - prm[:2]
        t = np.clip((p - a) @ ab / (ab @ ab), 0, 1)
        return np.hypot(*(p - a - t[:, None] * ab).T)

    def coherence(prm, sel):
        return abs((wt[sel] * np.exp(2j * np.pi * radius(pts[sel], prm) / prm[4])).sum())

    def fit(x0, sel):
        simplex = x0 + np.r_[np.zeros((1, 5)), np.diag([0.3, 0.3, 0.3, 0.3, 0.01])]
        return optimize.minimize(lambda prm: -coherence(prm, sel), x0, method='Nelder-Mead',
                                 options={'initial_simplex': simplex, 'xatol': 0.002, 'fatol': 1e-3 * wt.sum()})

    # the lines repeat every lane width, so a fit can lock a lane off. The straights alone fix the direction of
    # the axis and the lane width, and its position to a multiple of half a lane; for each such position the
    # two curve centres slide along the axis to their best place, and the most coherent whole wins
    start = fit(np.r_[c - u * half, c + u * half, 1.22], np.abs(along) < 0.7 * half).x
    slides = np.arange(-3, 3.01, 0.05)
    best = None
    for k in range(-3, 4):
        prm = start + np.r_[v, v, 0] * k * start[4] / 2
        for end, sel in ((0, along < 0), (2, along >= 0)):
            def moved(d):
                m = prm.copy()
                m[end:end + 2] += u * d
                return m
            prm = moved(max(slides, key=lambda d: coherence(moved(d), sel)))
        if best is None or coherence(prm, slice(None)) > coherence(best, slice(None)):
            best = prm
    prm = fit(best, slice(None)).x
    z = (wt * np.exp(2j * np.pi * radius(pts, prm) / prm[4])).sum()
    a, b, s = prm[:2], prm[2:4], prm[4]
    print(f'track: lane width {s:.3f} m, straight {np.hypot(*(b - a)):.1f} m, coherence {abs(z) / wt.sum():.2f}', file=sys.stderr)
    if abs(z) < 0.3 * wt.sum():
        return none
    ax = (b - a) / np.hypot(*(b - a))
    nv = np.array([-ax[1], ax[0]])
    ys, xs = np.nonzero(band & stroke)
    rs = (radius(((np.c_[xs, ys][::7] + 0.5) / scale + origin) @ true.T, prm) - np.angle(z) / (2 * np.pi) * s) / s
    near = ndi.binary_dilation(stroke & band, iterations=scale // 4)
    back = np.linalg.inv(true)
    lanes = []
    for i in range(int(np.floor(rs.min())), int(np.ceil(rs.max())) + 1):
        r = np.angle(z) / (2 * np.pi) * s + i * s
        if r < 5:
            continue
        # the ring of this radius, a point every half metre: down one straight, round b, back, round a
        t = np.arange(0, np.hypot(*(b - a)), 0.5)[:, None]
        turn = np.arange(0, np.pi, 0.5 / r)[:, None]
        ring = np.r_[a + ax * t + nv * r, b + r * (np.cos(turn) * nv + np.sin(turn) * ax),
                     b - ax * t - nv * r, a - r * (np.cos(turn) * nv + np.sin(turn) * ax)] @ back.T
        px = np.floor((ring - origin) * scale).astype(int)
        ok = (px[:, 0] >= 0) & (px[:, 1] >= 0) & (px[:, 0] < stroke.shape[1]) & (px[:, 1] < stroke.shape[0])
        on = np.zeros(len(ring))
        on[ok] = near[px[ok, 1], px[ok, 0]]
        on = ndi.uniform_filter1d(on, 13, mode='wrap') > 0.3      # drawn where 6 m of it are mostly backed
        if on.all():
            lanes.append(simplify(np.r_[ring, ring[:1]], 0.03))
            continue
        first = int(np.argmin(on))
        on, ring = np.roll(on, -first), np.roll(ring, -first, 0)
        lab, n = ndi.label(on)
        for sl, in ndi.find_objects(lab):
            if sl.stop - sl.start >= 60:      # 30 m
                lanes.append(simplify(ring[sl], 0.03))
    return lanes, band


def place_trees(mask, H, S, V):
    """One tree per crown: circles packed into the canopy pixels, largest first. Returns (x, y, size_m, kind);
    the client draws a crown of radius 0.8 x size."""
    spread = 1.24       # radius of a lone crown over that of the largest circle inside it, campus median
    trees = []
    occ = {}

    def free(x, y, r):
        cx, cy = int(x // 4), int(y // 4)
        for i in range(cx - 2, cx + 3):
            for j in range(cy - 2, cy + 3):
                for (tx, ty, tr) in occ.get((i, j), ()):
                    if (tx - x) ** 2 + (ty - y) ** 2 < (0.85 * (tr + r)) ** 2:
                        return False
        return True

    def kind_at(px, py):
        win = (slice(max(py - WRES, 0), py + WRES + 1), slice(max(px - WRES, 0), px + WRES + 1))
        m = mask[win]
        h = ((H[win][m] + 180) % 360 - 180).mean()      # reds on either side of 0 average correctly
        s = S[win][m].mean()
        v = V[win][m].mean()
        if -25 < h < 50 and s > 0.4:
            return 2 if h < 30 else 1          # maple (red/orange) / ginkgo (yellow)
        if v < 0.27:
            return 3                            # evergreen
        return 0                                # deciduous green

    rest = ndi.binary_closing(mask, iterations=WRES // 2)   # leaf gaps are not crown edges
    reach = 4 * WRES
    yy, xx = np.mgrid[-reach:reach + 1, -reach:reach + 1]
    for least in (0.7, 1.0, 1.0, 1.0, 1.0):
        # crown centres: the points deepest inside the canopy not yet covered; later rounds skip leftover slivers
        depth = ndi.gaussian_filter(ndi.distance_transform_edt(rest), WRES / 4) / WRES
        peaks = (depth == ndi.maximum_filter(depth, size=2 * WRES + 1)) & (depth >= least)
        ys, xs = np.nonzero(peaks)
        for i in np.argsort(-depth[ys, xs], kind='stable'):
            px, py = int(xs[i]), int(ys[i])
            crown = spread * min(float(depth[py, px]), 3.0)
            x, y = (px + 0.5) / WRES, (py + 0.5) / WRES
            if not free(x, y, crown):
                continue
            trees.append((round(x, 1), round(y, 1), round(min(max(crown / 0.8, 1.3), 3.6), 1), kind_at(px, py)))
            occ.setdefault((int(x // 4), int(y // 4)), []).append((x, y, crown))
            y0, x0 = max(py - reach, 0), max(px - reach, 0)
            disc = (xx ** 2 + yy ** 2 <= (crown * WRES + 1) ** 2)[y0 - py + reach:, x0 - px + reach:]
            win = rest[y0:py + reach + 1, x0:px + reach + 1]
            win &= ~disc[:win.shape[0], :win.shape[1]]
    return trees


if __name__ == '__main__':
    main()
