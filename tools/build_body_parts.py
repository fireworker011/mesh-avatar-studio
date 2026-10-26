"""Cut the full-body samples into a 2.5D puppet, and paint their eye and mouth drawings.

Limbs become cut-outs that rotate rigidly about their joints. The torso, coat and skirt
stay in a separate base that no limb bone ever stretches. Every cut-out keeps the pixels
it was drawn with. Only pixels hidden at rest are painted: the root of a limb under its
parent, a thigh under the skirt, a sleeve behind long hair, and the side of a coat behind
a sleeve. Each is painted from the pixels of the layer it belongs to, never from a flat
fill. Laying the layers back in draw order reproduces the illustration exactly.

base.png is not modified. The cut base is parts/base_cut.png, so a runtime without parts
still draws the whole illustration.

    uv run --with numpy --with pillow --with opencv-python-headless tools/build_body_parts.py [--debug DIR]
"""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from paint_face import paint_faces

ROOT = Path(__file__).resolve().parents[1]

# Per-illustration decisions that the pixels alone do not settle:
#   torso_over_arms  the torso outline is drawn over the sleeve (vest), so there is no
#                    hidden torso to paint behind the arm
#   leg_from         y where a leg starts to be its own drawing (skirt hem, or crotch for
#                    trousers); above it the cloth belongs to the hips in the base
#   hair             'mask' trusts hairmask.png; 'dark' also takes dark strands joined to it
#   style            'anime' draws outlined mouths; 'photo' opens the drawn lips
SAMPLES = {
    'full-body-vest': {'style': 'anime', 'torso_over_arms': True, 'leg_from': 1376, 'hair': 'mask'},
    'full-body-coat': {'style': 'anime', 'torso_over_arms': False, 'leg_from': 690, 'hair': 'dark'},
    'full-body-photo': {'style': 'photo', 'torso_over_arms': False, 'leg_from': 600, 'hair': 'dark'},
}
CHAINS = {
    'armL': ['upperArmL', 'lowerArmL', 'handL'],
    'armR': ['upperArmR', 'lowerArmR', 'handR'],
    'legL': ['upperLegL', 'lowerLegL', 'footL'],
    'legR': ['upperLegR', 'lowerLegR', 'footR'],
}
LABEL = {'bg': 1, 'torso': 2, 'armL': 3, 'armR': 4, 'legL': 5, 'legR': 6}
# Rest draw order, bottom to top. The runtime uses the same order, so a standing frame is
# the illustration: parents over children, legs under the skirt, arms over the torso,
# the torso's shoulder caps and the front hair over the arms.
REST_ORDER = ['torso_hidden', 'footL', 'footR', 'lowerLegL', 'lowerLegR', 'upperLegL', 'upperLegR', 'base_cut',
              'handL', 'lowerArmL', 'upperArmL', 'handR', 'lowerArmR', 'upperArmR', 'cap_shoulderL', 'cap_shoulderR', 'hair_front']


def luma(rgb):
    return rgb[..., :3].astype(np.float32) @ np.array([0.299, 0.587, 0.114], np.float32)


def grid(shape):
    h, w = shape
    ys, xs = np.mgrid[0:h, 0:w]
    return xs.astype(np.float32), ys.astype(np.float32)


def segment_field(xs, ys, a, b):
    """Distance to the segment a-b and the position t along it (0 at a, 1 at b)."""
    ax, ay = float(a[0]), float(a[1])
    vx, vy = float(b[0]) - ax, float(b[1]) - ay
    length2 = max(vx * vx + vy * vy, 1e-6)
    t = ((xs - ax) * vx + (ys - ay) * vy) / length2
    tc = np.clip(t, 0, 1)
    return np.hypot(xs - (ax + vx * tc), ys - (ay + vy * tc)), t


def disc(xs, ys, c, r):
    return (xs - c[0]) ** 2 + (ys - c[1]) ** 2 <= r * r


def bounds(mask, pad=2):
    ys, xs = np.nonzero(mask)
    if not len(xs):
        return None
    x0, y0 = max(0, int(xs.min()) - pad), max(0, int(ys.min()) - pad)
    x1, y1 = min(mask.shape[1], int(xs.max()) + pad + 1), min(mask.shape[0], int(ys.max()) + pad + 1)
    return [x0, y0, x1 - x0, y1 - y0]


def save_png(path, array):
    Image.fromarray(np.ascontiguousarray(array), 'RGBA').save(path, optimize=True)


def unit(v):
    v = np.asarray(v, np.float64)
    n = float(np.hypot(v[0], v[1])) or 1.0
    return v / n


def paint_from(rgba, known, fill, radius=5):
    """Colour `fill` by copying pixels of `known` only.

    Each missing pixel repeats a real texel a short way back into that cloth, so a
    fold continues instead of blurring into one flat colour. Nothing outside
    `known` is sampled. `radius` is unused; callers still pass it.
    """
    del radius
    if not fill.any():
        return np.zeros(fill.shape + (3,), np.uint8)
    box = bounds(fill | known, pad=2)
    if box is None:
        return np.zeros(fill.shape + (3,), np.uint8)
    x, y, w, h = box
    colour = continue_cloth(rgba[y:y + h, x:x + w], known[y:y + h, x:x + w], fill[y:y + h, x:x + w])
    full = np.zeros(fill.shape + (3,), np.uint8)
    full[y:y + h, x:x + w] = colour
    return full


def continue_cloth(rgba, known, fill):
    """Nearest known texel, then one step further in, repeated every few pixels."""
    h, w = known.shape
    out = np.zeros((h, w, 3), np.uint8)
    if not known.any() or not fill.any():
        return out
    sx = np.full((h, w), -1, np.int32)
    sy = np.full((h, w), -1, np.int32)
    ys, xs = np.nonzero(known)
    sx[ys, xs] = xs
    sy[ys, xs] = ys
    step = 1 << int(np.floor(np.log2(max(h, w))))
    while step >= 1:
        cy = np.arange(h, dtype=np.int32)[:, None]
        cx = np.arange(w, dtype=np.int32)[None, :]
        for dy in (-step, 0, step):
            for dx in (-step, 0, step):
                if dx == 0 and dy == 0:
                    continue
                rolled_x = np.roll(sx, (dy, dx), axis=(0, 1))
                rolled_y = np.roll(sy, (dy, dx), axis=(0, 1))
                valid = rolled_x >= 0
                if dy > 0:
                    valid[:dy, :] = False
                elif dy < 0:
                    valid[dy:, :] = False
                if dx > 0:
                    valid[:, :dx] = False
                elif dx < 0:
                    valid[:, dx:] = False
                old_d = np.where(sx >= 0, ((cy - sy).astype(np.float64) ** 2) + ((cx - sx).astype(np.float64) ** 2), 1e12)
                new_d = np.where(valid, ((cy - rolled_y).astype(np.float64) ** 2) + ((cx - rolled_x).astype(np.float64) ** 2), 1e12)
                take = new_d < old_d
                sx = np.where(take, rolled_x, sx)
                sy = np.where(take, rolled_y, sy)
        step //= 2
    ys, xs = np.nonzero(fill)
    nx, ny = sx[ys, xs], sy[ys, xs]
    ok = np.nonzero(nx >= 0)[0]
    if not len(ok):
        return out
    vx = xs[ok].astype(np.float64) - nx[ok]
    vy = ys[ok].astype(np.float64) - ny[ok]
    dist = np.hypot(vx, vy)
    ux = vx / np.maximum(dist, 1e-3)
    uy = vy / np.maximum(dist, 1e-3)
    # Walk outward from the cloth. Each new pixel repeats the texel two steps
    # further in, so a fold continues. A blur here turned that continuation flat.
    buf = rgba[..., :3].copy()
    filled = known.copy()
    for k in np.argsort(dist):
        y = int(ys[ok[k]])
        x = int(xs[ok[k]])
        step = min(2.0, float(dist[k]))
        sy_i = int(np.clip(round(y - uy[k] * step), 0, h - 1))
        sx_i = int(np.clip(round(x - ux[k] * step), 0, w - 1))
        if not (known[sy_i, sx_i] or filled[sy_i, sx_i]):
            sy_i, sx_i = int(ny[ok[k]]), int(nx[ok[k]])
        buf[y, x] = buf[sy_i, sx_i]
        filled[y, x] = True
    out[ys[ok], xs[ok]] = buf[ys[ok], xs[ok]]
    return out


def width_samples(alpha, bones, visible, hair):
    """Half-width readings (t, half) across each bone. Where background shows on both
    sides the two edges give the width; where one side runs into the torso the free side
    is used, since the bones sit on the limb centre lines. Hair in front of an arm counts
    as its edge, and a reading taken from inside the hair is skipped."""
    h, w = alpha.shape
    limit = 0.05 * max(h, w)
    out = {}
    for name, bone in bones.items():
        arm = 'Arm' in name or name.startswith('hand')
        clear = (alpha < 100) | (hair if arm else False)
        p0, p1 = np.array(bone['pivot'], float), np.array(bone['tip'], float)
        u = unit(p1 - p0)
        n = np.array([-u[1], u[0]])
        reach = int(max(bone['radius'] * 3, 0.06 * max(h, w))) + 4
        readings = []
        for t in np.linspace(0.05, 0.95, 31):
            a = p0 + (p1 - p0) * t
            ax, ay = int(round(a[0])), int(round(a[1]))
            if not (0 <= ax < w and 0 <= ay < h) or clear[ay, ax] or not visible(name, ay):
                continue
            hits = []
            for sign in (1, -1):
                hit = None
                for k in range(1, reach):
                    x, y = int(round(a[0] + sign * k * n[0])), int(round(a[1] + sign * k * n[1]))
                    if not (0 <= x < w and 0 <= y < h) or clear[y, x]:
                        hit = k
                        break
                hits.append(hit)
            if hits[0] and hits[1]:
                # a centred bone sees both edges at about the same distance; a lopsided
                # pair means one ray ran on through cloth that is not this limb
                if max(hits) <= 1.8 * min(hits):
                    readings.append((t, (hits[0] + hits[1]) / 2))
            elif arm and (hits[0] or hits[1]) and (hits[0] or hits[1]) <= max(bone['radius'] * 2.2 + 6, limit):
                # one free side only counts for an arm, whose other side is the torso; a
                # leg's single reading is usually a ray that crossed the skirt or coat
                readings.append((t, float(hits[0] or hits[1])))
        out[name] = readings
    return out


def width_profile(samples, bones, name, flat=None):
    """Half-width along a bone as a function of t, from its readings (median-smoothed),
    or the bone's single width where it has too few."""
    readings = sorted(samples[name])
    flat = width_of(samples, bones, name) if flat is None else flat
    if len(readings) < 4:
        return lambda t: np.full_like(t, flat, dtype=np.float32)
    ts = np.array([r[0] for r in readings])
    vs = np.array([r[1] for r in readings])
    smooth = np.array([np.median(vs[max(0, i - 2):i + 3]) for i in range(len(vs))])
    return lambda t: np.interp(np.clip(t, 0, 1), ts, smooth).astype(np.float32)


def width_of(samples, bones, name, t0=0.0, t1=1.0):
    """Median half-width of a bone between t0 and t1, falling back to the whole bone,
    then to the neighbouring bone of the same limb, then to the rig radius."""
    near = [v for t, v in samples[name] if t0 <= t <= t1]
    if len(near) >= 2:
        return float(np.median(near))
    every = [v for _, v in samples[name]]
    if len(every) >= 3:
        return float(np.median(every))
    for names in CHAINS.values():
        if name in names:
            i = names.index(name)
            for j, scale in ((i + 1, 1.1), (i - 1, 0.85)):
                if 0 <= j < len(names) and len(samples[names[j]]) >= 3:
                    return float(np.median([v for _, v in samples[names[j]]])) * scale
    return float(bones[name]['radius'])


def side_of(bone, centre_x):
    """+1 if the normal (-u.y, u.x) of the bone points toward the body centre."""
    p0, p1 = np.array(bone['pivot'], float), np.array(bone['tip'], float)
    u = unit(p1 - p0)
    n = np.array([-u[1], u[0]])
    mid = (p0 + p1) / 2
    return 1 if (centre_x - mid[0]) * n[0] >= 0 else -1


def hair_pixels(rgba, hairmask, rig, mode):
    opaque = rgba[..., 3] > 8
    hair = (hairmask > 0.5) & opaque
    if mode == 'mask':
        return hair
    # Dark strands joined to the head's hair. A photo mask also covers clothing, so the
    # mask only seeds the search near the head and colour decides the rest. Thin outlines
    # are opened away first, or a coat's ink lines would join the hair.
    head = rig['head']
    xs, ys = grid(hair.shape)
    near_head = ((xs - head['cx']) / (head['rx'] * 1.25)) ** 2 + ((ys - head['cy']) / (head['ry'] * 1.15)) ** 2 <= 1
    rgb = rgba[..., :3].astype(np.float32)
    lum = luma(rgb)
    # hair is neutral or warm; the photo's shirt and trousers are blue and the coat's
    # ink lines carry its teal
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    dark = (lum < 78) & opaque & (b < r + 12) & (g < r + 10)
    thick = cv2.morphologyEx(dark.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)) > 0
    seed = thick & hair & near_head
    n, lab = cv2.connectedComponents(thick.astype(np.uint8), connectivity=8)
    keep = np.zeros(n, bool)
    keep[np.unique(lab[seed])] = True
    keep[0] = False
    strands = keep[lab]
    # soft hair edges are lighter than the core: take them where they touch the strands
    edge = cv2.dilate(strands.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    edge &= (lum < 125) & opaque & (b < r + 20) & (g < r + 16)
    found = strands | edge | (hair & near_head)
    # thin wisps that the opening dropped: follow hair-coloured pixels out from the hair
    wisp = (lum < 112) & opaque & (b < r + 14) & (g < r + 12)
    kernel = np.ones((3, 3), np.uint8)
    for _ in range(int(0.3 * max(hair.shape))):
        grown = (cv2.dilate(found.astype(np.uint8), kernel) > 0) & wisp & ~found
        if not grown.any():
            break
        found |= grown
    # Long hair can pass behind a shoulder and show again beside the arm, cut off from
    # the head. A sizeable strand group that starts near the head is still hair.
    n, lab, stats, centroids = cv2.connectedComponentsWithStats(wisp.astype(np.uint8), connectivity=8)
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        cx, cy = centroids[i]
        if area < 150 or found[lab == i].mean() > 0.5:
            continue
        if y < head['cy'] + 2.2 * head['ry'] and cy < head['cy'] + 3.0 * head['ry'] and abs(cx - head['cx']) < 2.5 * head['rx']:
            found |= lab == i
    return found


def cloth_match(rgb, ref):
    """Same cloth as `ref`: close in hue (the r-g and g-b differences), with a wide
    allowance in brightness for folds and shading. Grey trousers and a teal coat of the
    same brightness differ here; a dark and a light fold of one sleeve do not."""
    rg = (rgb[..., 0] - rgb[..., 1]) - (ref[0] - ref[1])
    gb = (rgb[..., 1] - rgb[..., 2]) - (ref[1] - ref[2])
    return (np.maximum(np.abs(rg), np.abs(gb)) < 22) & (np.abs(luma(rgb) - float(luma(ref[None, None])[0, 0])) < 95)


def matte_leftovers(rgba):
    """Background left opaque by the cut-out matte, such as the gap between an arm and the
    body in a photo: light, nearly colourless pixels. They are not cloth."""
    rgb = rgba[..., :3].astype(np.float32)
    return (rgba[..., 3] == 255) & (luma(rgb) > 195) & (rgb.max(-1) - rgb.min(-1) < 14)


def smooth_internal(regions, opaque):
    """Straighten a cut that runs through the figure. Pixels on the silhouette,
    against the background, stay on the part they were drawn on."""
    silhouette = cv2.dilate((~opaque).astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    labels = np.zeros(opaque.shape, np.int32)
    names = list(CHAINS)
    for index, name in enumerate(names, start=1):
        labels[regions[name]] = index
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)).astype(np.float32)
    kernel /= kernel.sum()
    votes = [cv2.filter2D(((labels == 0) & opaque).astype(np.float32), -1, kernel)]
    votes += [cv2.filter2D((labels == index).astype(np.float32), -1, kernel) for index in range(1, len(names) + 1)]
    choice = np.argmax(np.stack(votes), axis=0).astype(np.int32)
    labels = np.where(opaque & ~silhouette, choice, labels)
    smoothed = {}
    for index, name in enumerate(names, start=1):
        smoothed[name] = (labels == index) & opaque
    return smoothed


def claim_outline(owner, other, rgba, steps=3):
    """Move the dark outline pixels that border `owner` from `other` into `owner`.
    Dark means darker than both cloths there, so a dark coat is not taken for its outline."""
    owner = owner.copy()
    other = other.copy()
    lum = luma(rgba)
    near = (cv2.dilate(owner.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0)
    a, b = lum[owner & near], lum[other & near]
    if not len(a) or not len(b):
        return owner, other
    threshold = float(np.clip(min(np.median(a), np.median(b)) - 30, 25, 110))
    for _ in range(steps):
        ring = (cv2.dilate(owner.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0) & other
        ring &= lum < threshold
        if not ring.any():
            break
        owner |= ring
        other &= ~ring
    return owner, other


def segment(rgba, rig, cfg, hair, debug=None):
    alpha = rgba[..., 3]
    shape = alpha.shape
    xs, ys = grid(shape)
    bones = rig['fullBody']['bones']
    leg_from = cfg['leg_from']
    visible = lambda name, y: not name.startswith('upperLeg') or y >= leg_from + 6
    samples = width_samples(alpha, bones, visible, hair)
    widths = {name: width_of(samples, bones, name) for name in bones}
    # A thigh is mostly hidden by the skirt or coat, and where it shows the cloth beside
    # it often reads as part of it. It is not much wider than its own shin.
    for side in 'LR':
        cap = widths[f'lowerLeg{side}'] * 1.1
        if widths[f'upperLeg{side}'] > cap:
            widths[f'upperLeg{side}'] = cap
            samples[f'upperLeg{side}'] = []
    opaque = alpha > 8
    head = rig['head']
    face = ((xs - head['cx']) / (head['rx'] * 0.9)) ** 2 + ((ys - head['cy']) / (head['ry'] * 0.9)) ** 2 <= 1
    markers = np.zeros(shape, np.int32)
    rgb = rgba[..., :3].astype(np.float32)
    centre_x = float(bones['torso']['pivot'][0])
    fields = {name: segment_field(xs, ys, bones[name]['pivot'], bones[name]['tip']) for name in bones}

    def reference(name, t0=0.25, t1=0.75):
        d, t = fields[name]
        thin = (d < max(3, widths[name] * 0.25)) & (t > t0) & (t < t1) & opaque & ~hair & ~face
        if name.startswith('upperLeg'):
            thin &= ys >= leg_from + 4
        return np.median(rgb[thin], axis=0) if thin.sum() > 12 else None

    near = {}
    torso = np.zeros(shape, bool)
    cores = {}
    for chain, names in CHAINS.items():
        core = np.zeros(shape, bool)
        near[chain] = np.zeros(shape, bool)
        # the cloth each limb is drawn in, read where it is surely visible: the forearm
        # for the arm, the shin for the leg, the hand and foot themselves
        cloth = reference(names[1])
        for name in names:
            bone = bones[name]
            d, t = fields[name]
            width = width_profile(samples, bones, name, widths[name])(t)
            near[chain] |= d < width * 2.4 + 6
            if chain.startswith('arm'):
                # Torso seeds on the inner side of an arm, past where the sleeve can reach.
                # Same-cloth sleeves (coat, shirt) need these to stop at the seam.
                p0 = np.array(bone['pivot'], float)
                u = unit(np.subtract(bone['tip'], bone['pivot']))
                normal = np.array([-u[1], u[0]]) * side_of(bone, centre_x)
                across = (xs - p0[0]) * normal[0] + (ys - p0[1]) * normal[1]
                # a sleeve's centre line curves, so its own shading can reach past 1.35
                # widths; same-coloured pixels are seeded only further out
                same = cloth_match(rgb, cloth) if cloth is not None else np.zeros(shape, bool)
                reach = np.where(same, width * 1.6 + 3, width * 1.35 + 3)
                torso |= (across > reach) & (t > 0.05) & (t < 0.95) & (d < width * 3.2 + 8)
            if name in names[:2]:
                mine = (d < width * 0.85) & opaque & ~hair & ~face
                if cloth is not None:
                    mine &= cloth_match(rgb, cloth)
            else:
                # a hand or a shoe is mostly against background and can be two colours
                # (skin and shoe), so it is seeded by position alone
                mine = (d < width * 0.6) & opaque & ~hair & ~face
            if chain.startswith('leg'):
                mine &= ys >= leg_from + 4
            core |= mine
        cores[chain] = core
    torso &= opaque
    torso |= opaque & ~np.logical_or.reduce(list(near.values()))
    arms_near = near['armL'] | near['armR']
    for chain in ('legL', 'legR'):
        torso |= near[chain] & opaque & (ys < leg_from - 8) & ~arms_near
    centre_core, _ = segment_field(xs, ys, bones['torso']['pivot'], bones['torso']['tip'])
    torso |= opaque & (centre_core < bones['torso']['radius'] * 0.5) & (ys < leg_from - 8)
    # a shadow painted on the ground stays on the ground when a foot turns
    grey = (rgb.max(-1) - rgb.min(-1) < 14) & (luma(rgb) > 110) & (alpha == 255)
    for side in 'LR':
        foot = bones[f'foot{side}']
        shoe = reference(f'foot{side}', 0.35, 0.9)
        ground = grey & (ys > foot['pivot'][1] + 0.3 * abs(foot['tip'][1] - foot['pivot'][1]))
        if shoe is not None:
            ground &= ~cloth_match(rgb, shoe)
        torso |= ground & near[f'leg{side}']
    markers[torso] = LABEL['torso']
    for chain, core in cores.items():
        markers[core] = LABEL[chain]
    markers[(face | hair) & opaque] = LABEL['torso']
    markers[~opaque] = LABEL['bg']
    # Light matte left in the gap beside a sleeve is not cloth. Seeded onto the
    # limb, it travels with the sleeve and reads as a pale jagged rim.
    markers[matte_leftovers(rgba)] = LABEL['torso']
    image = np.where(opaque[..., None], rgba[..., :3], 200).astype(np.uint8)
    labels = cv2.watershed(np.ascontiguousarray(image[..., ::-1]), markers.copy())
    # watershed ridge pixels: give them to the neighbouring label that is not background
    ridge = labels == -1
    if ridge.any():
        grown = labels.copy()
        grown[ridge] = 0
        for _ in range(3):
            pad = cv2.dilate(grown.astype(np.float32), np.ones((3, 3), np.uint8)).astype(np.int32)
            hole = (grown == 0)
            grown[hole] = pad[hole]
        labels = grown
    # A watershed line follows texture noise on a photo. A majority vote over a small disc
    # straightens the cuts between parts, without touching the silhouette against background.
    radius = 3 if cfg['style'] == 'photo' else 2
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius * 2 + 1, radius * 2 + 1))
    ids = [LABEL['torso']] + [LABEL[c] for c in CHAINS]
    votes = np.stack([cv2.filter2D((labels == i).astype(np.float32), -1, kernel) for i in ids])
    smooth = np.array(ids)[np.argmax(votes, axis=0)]
    inner = opaque & (labels > 1) & ~hair & ~face
    labels = np.where(inner, smooth, labels)
    for chain in ('legL', 'legR'):
        # a leg starts at one straight line; above it the cloth belongs to the hips
        labels[(labels == LABEL[chain]) & (ys < leg_from)] = LABEL['torso']
    regions = {chain: (labels == LABEL[chain]) & opaque & ~hair for chain in CHAINS}
    # Soft silhouette edges that the background flood took, and the faint fringe beyond
    # them, go with the limb they border. Left in the base they would stay behind as a
    # ghost outline when the limb moves.
    claimed = np.logical_or.reduce([labels == LABEL[c] for c in CHAINS] + [labels == LABEL['torso']])
    loose = (alpha > 0) & ~claimed & ~hair
    kernel = np.ones((3, 3), np.uint8)
    for _ in range(4):
        for chain in CHAINS:
            grow = (cv2.dilate(regions[chain].astype(np.uint8), kernel) > 0) & loose
            regions[chain] |= grow
            loose &= ~grow
    body = (labels == LABEL['torso']) & opaque & ~hair
    for chain in CHAINS:
        # legs pass under the skirt or coat; arms are over the torso unless the torso
        # outline is drawn across the sleeve
        if chain.startswith('leg') or cfg['torso_over_arms']:
            body, regions[chain] = claim_outline(body, regions[chain], rgba)
        else:
            regions[chain], body = claim_outline(regions[chain], body, rgba)
    # The same matte, if the outline pass picked it up, stays off the limb.
    matte = matte_leftovers(rgba)
    for chain in CHAINS:
        regions[chain] &= ~matte
    regions = smooth_internal(regions, opaque)
    if debug is not None:
        colours = {'armL': (230, 60, 60), 'armR': (60, 120, 230), 'legL': (240, 170, 40), 'legR': (60, 190, 90)}
        view = rgba[..., :3].astype(np.float32).copy()
        for chain, colour in colours.items():
            view[regions[chain]] = view[regions[chain]] * 0.45 + np.array(colour) * 0.55
        view[hair] = view[hair] * 0.6 + np.array([200, 0, 200]) * 0.4
        debug['markers'] = markers
        debug['segments'] = np.dstack([view.clip(0, 255).astype(np.uint8), np.where(opaque, 255, 0).astype(np.uint8)])
    return regions, widths, samples


def split_chain(region, names, bones, widths, xs, ys):
    """Cut a limb chain at its joints, on the line through each pivot that halves the
    angle between the two bones."""
    out = {}
    remaining = region.copy()
    for i, name in enumerate(names):
        bone = bones[name]
        d, _ = segment_field(xs, ys, bone['pivot'], bone['tip'])
        mine = remaining & (d < widths[name] * 3.2 + 6)
        if i + 1 < len(names):
            child = bones[names[i + 1]]
            n = unit(unit(np.subtract(bone['tip'], bone['pivot'])) + unit(np.subtract(child['tip'], child['pivot'])))
            px, py = child['pivot']
            mine &= (xs - px) * n[0] + (ys - py) * n[1] < 0
        out[name] = mine
        remaining &= ~mine
    # a few stray pixels that fell outside every capsule go to the nearest bone
    if remaining.any():
        nearest = np.argmin(np.stack([segment_field(xs, ys, bones[n]['pivot'], bones[n]['tip'])[0] for n in names]), axis=0)
        for k, name in enumerate(names):
            out[name] |= remaining & (nearest == k)
    return out


def compose(layers, order, shape):
    """Premultiplied alpha compositing of {name: (rgba, rect)} in order, onto transparent."""
    h, w = shape
    acc = np.zeros((h, w, 4), np.float32)
    for name in order:
        if name not in layers:
            continue
        image, rect = layers[name]
        x, y, lw, lh = rect
        src = image.astype(np.float32) / 255
        a = src[..., 3:4]
        dst = acc[y:y + lh, x:x + lw]
        dst[..., :3] = src[..., :3] * a + dst[..., :3] * (1 - a)
        dst[..., 3:4] = a + dst[..., 3:4] * (1 - a)
    rgb = np.where(acc[..., 3:4] > 1e-6, acc[..., :3] / np.maximum(acc[..., 3:4], 1e-6), 0)
    return np.dstack([rgb, acc[..., 3:4]]) * 255


def rest_delta(layers, original):
    """Largest difference, in premultiplied 0-255 units, between the layers laid back in
    rest order and the illustration."""
    restored = compose(layers, REST_ORDER, original.shape[:2])
    def premultiplied(image):
        image = image.astype(np.float32)
        return np.dstack([image[..., :3] * image[..., 3:4] / 255, image[..., 3:4]])
    return float(np.abs(premultiplied(restored) - premultiplied(original)).max())


def crop_layer(rgba, mask):
    rect = bounds(mask, pad=1)
    x, y, w, h = rect
    out = rgba[y:y + h, x:x + w].copy()
    out[..., 3] = np.where(mask[y:y + h, x:x + w], out[..., 3], 0)
    out[out[..., 3] == 0] = 0
    return out, rect


def soften(image):
    """The same silhouette with the drawn interior detail calmed: a stand-in for the side
    of a limb the illustration never showed. The outline ring stays as drawn."""
    alpha = image[..., 3]
    inside = (alpha > 0).astype(np.uint8)
    dist = cv2.distanceTransform(inside, cv2.DIST_L2, 3)
    rgb = np.ascontiguousarray(image[..., :3])
    calm = cv2.bilateralFilter(rgb, 9, 38, 7)
    calm = cv2.bilateralFilter(calm, 9, 38, 7)
    ring = (dist < 3.5)[..., None]
    out = image.copy()
    out[..., :3] = np.where(ring, rgb, calm)
    return out


def fist(image, rect, bone, length_scale=0.55, taper=0.22, knuckle=0.46):
    """A closed hand as the same cut-out drawn smaller: the fingers are pulled in toward
    the knuckles and narrowed. The wrist end is unchanged, so it still meets the cuff."""
    x0, y0, w, h = rect
    p0 = np.array(bone['pivot'], float) - (x0, y0)
    p1 = np.array(bone['tip'], float) - (x0, y0)
    axis = p1 - p0
    length = float(np.hypot(*axis)) or 1.0
    u = axis / length
    n = np.array([-u[1], u[0]])
    xs, ys = grid((h, w))
    rx, ry = xs - p0[0], ys - p0[1]
    t = (rx * u[0] + ry * u[1]) / length
    s = rx * n[0] + ry * n[1]
    t_src = t.copy()
    s_src = s.copy()
    beyond = t > knuckle
    reach = knuckle + (1.05 - knuckle) * length_scale
    k = np.clip((t - knuckle) / max(reach - knuckle, 1e-3), 0, None)
    t_src[beyond] = knuckle + (t[beyond] - knuckle) / length_scale
    shrink = 1 - taper * np.clip(k, 0, 1)
    s_src[beyond] = s[beyond] / shrink[beyond]
    mx = (p0[0] + (t_src * length) * u[0] + s_src * n[0]).astype(np.float32)
    my = (p0[1] + (t_src * length) * u[1] + s_src * n[1]).astype(np.float32)
    premul = image.astype(np.float32)
    premul[..., :3] *= premul[..., 3:4] / 255
    warped = cv2.remap(premul, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    a = warped[..., 3]
    rgb = np.where(a[..., None] > 0.5, warped[..., :3] / np.maximum(a[..., None], 1e-3) * 255, 0)
    out = np.dstack([rgb, a]).clip(0, 255).astype(np.uint8)
    # close the gaps the fingers leave when they bunch together; the outside is whatever
    # the border reaches, so a hand touching its own rect corner is still outside-aware
    solid = (out[..., 3] > 127).astype(np.uint8)
    closed = cv2.morphologyEx(solid, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    padded = np.pad(closed, 1)
    flood = np.zeros((h + 4, w + 4), np.uint8)
    cv2.floodFill(padded, flood, (0, 0), 1)
    outside = (padded[1:-1, 1:-1] == 1) & (closed == 0)
    holes = ((closed == 0) & ~outside) | ((closed > 0) & (solid == 0))
    if holes.any():
        colour = paint_from(out, out[..., 3] > 127, holes, radius=3)
        out[holes, :3] = colour[holes]
        out[holes, 3] = 255
    # the wrist and palm are the open hand's own pixels
    keep = (t <= knuckle - 0.04)
    out[keep] = image[keep]
    return out


def hidden_along(xs, ys, bone, width, cover, region, t0, t1):
    """Cloth the illustration hid, at the limb's width, touching the visible part.

    Distance to the bone line, not to the segment, so the end is flat instead of
    a semicircle. Growth from the visible part keeps the hidden cloth attached.
    """
    ax, ay = float(bone['pivot'][0]), float(bone['pivot'][1])
    vx, vy = float(bone['tip'][0]) - ax, float(bone['tip'][1]) - ay
    length = max(float(np.hypot(vx, vy)), 1e-6)
    line_d = np.abs((xs - ax) * vy - (ys - ay) * vx) / length
    _d, t = segment_field(xs, ys, bone['pivot'], bone['tip'])
    along = (line_d < width * 0.92) & (t >= t0) & (t <= t1)
    candidate = (along & cover) | region
    grow = region.copy()
    kernel = np.ones((3, 3), np.uint8)
    for _ in range(64):
        nxt = cv2.dilate(grow.astype(np.uint8), kernel, iterations=1) > 0
        nxt &= candidate
        if int(nxt.sum()) == int(grow.sum()):
            break
        grow = nxt
    return grow & cover & ~region


def build_parts(sample, folder, rig, cfg, original, hairmask, debug):
    shape = original.shape[:2]
    xs, ys = grid(shape)
    bones = rig['fullBody']['bones']
    hair = hair_pixels(original, hairmask, rig, cfg['hair'])
    regions, widths, samples = segment(original, rig, cfg, hair, debug)
    parts = {}
    for chain, names in CHAINS.items():
        parts.update(split_chain(regions[chain], names, bones, widths, xs, ys))
    limb_any = np.logical_or.reduce(list(parts.values()))
    opaque = original[..., 3] > 0
    solid = original[..., 3] == 255
    # the sleeve width where it leaves the shoulder sizes the shoulder disc and cap
    shoulder = {side: width_of(samples, bones, f'upperArm{side}', 0.0, 0.35) for side in 'LR'}
    # hair lying over one shoulder reads as sleeve; the two shoulders are about alike
    shoulder = {'L': min(shoulder['L'], 1.5 * shoulder['R']), 'R': min(shoulder['R'], 1.5 * shoulder['L'])}
    # Front hair: strands that hang below the neck, drawn over the arms.
    shoulder_y = min(bones['upperArmL']['pivot'][1], bones['upperArmR']['pivot'][1])
    neck_band = shoulder_y - 0.9 * min(shoulder.values())
    hair_front = hair & opaque & (ys > neck_band) & ~limb_any
    # Shoulder caps: torso pixels around each shoulder pivot, drawn over the arm so its
    # root slides under the torso instead of showing a cut.
    caps = {}
    torso_px = opaque & ~limb_any & ~hair_front
    head = rig['head']
    face = ((xs - head['cx']) / head['rx']) ** 2 + ((ys - head['cy']) / head['ry']) ** 2 <= 1
    # In a body yaw the front arm slides 0.2 x 0.08 x shoulder span further than the torso
    # (YAW_DEPTH in the runtime's rig.js); the cap reaches past the arm's hidden root by that.
    span = float(np.hypot(*np.subtract(bones['upperArmR']['pivot'], bones['upperArmL']['pivot'])))
    yaw_slide = 0.2 * 0.08 * span
    for side in 'LR':
        bone = bones[f'upperArm{side}']
        caps[side] = disc(xs, ys, bone['pivot'], shoulder[side] * 1.5 + 4 + yaw_slide) & torso_px & ~face
        torso_px &= ~caps[side]
    # A couple of real torso pixels past the cap close the hairline that shows
    # when a body yaw slides the arm.
    for side in 'LR':
        grown = cv2.dilate(caps[side].astype(np.uint8), np.ones((3, 3), np.uint8), iterations=2) > 0
        grown &= torso_px & ~face & ~limb_any
        caps[side] |= grown
        torso_px &= ~grown
    base_cut_mask = torso_px
    # Coat or shirt side behind a sleeve: per row, the torso edge is interpolated between
    # the shoulder and the rows where background shows between arm and torso.
    hidden = np.zeros(shape, bool)
    if not cfg['torso_over_arms']:
        for side in 'LR':
            arm = parts[f'upperArm{side}'] | parts[f'lowerArm{side}'] | parts[f'hand{side}']
            # the sleeve also runs on under long hair; the torso behind that is hidden too
            for name in (f'upperArm{side}', f'lowerArm{side}'):
                d, _ = segment_field(xs, ys, bones[name]['pivot'], bones[name]['tip'])
                arm |= (d < widths[name] * 1.05) & hair_front
            hidden |= torso_behind(arm, base_cut_mask | caps['L'] | caps['R'], solid, bones, side, rig, original[..., 3], matte_leftovers(original))
    # Hidden roots, painted from each part's own pixels and only where an opaque layer
    # above covers them at rest.
    layers = {}
    rest_cover = {}
    above = np.zeros(shape, bool)
    owner = {name: parts[name] & opaque for name in parts}
    pixel_layers = {'base_cut': base_cut_mask, 'hair_front': hair_front, 'cap_shoulderL': caps['L'], 'cap_shoulderR': caps['R'], **owner}
    for name in reversed(REST_ORDER):
        rest_cover[name] = above.copy()
        if name in pixel_layers:
            above |= pixel_layers[name] & solid
    extensions = {}
    for chain, names in CHAINS.items():
        for i, name in enumerate(names):
            bone = bones[name]
            region = parts[name]
            cover = rest_cover[name]
            ext = np.zeros(shape, bool)
            # Flat-ended cloth along the bone, joined to the visible part. A disc
            # around the pivot, or a stub that does not meet the cloth, showed as a
            # separate patch once the joint turned.
            t1 = 0.36 if i else 1.02
            ext |= hidden_along(xs, ys, bone, widths[name], cover, region, 0.0, t1)
            # never under a soft edge of the cover: it would show through at rest
            extensions[name] = ext
    rgb = original[..., :3].astype(np.float32)
    kernel = np.ones((3, 3), np.uint8)
    matte = matte_leftovers(original)
    drawn, same_root = {}, {}
    for chain, names in CHAINS.items():
        for i, name in enumerate(names):
            region = parts[name]
            if not region.any():
                continue
            ext = extensions[name]
            image = original.copy()
            # paint from the part's inside, not its ink outline, which would smear into a rim
            inside = cv2.erode((region & solid & ~matte).astype(np.uint8), kernel, iterations=2) > 0
            colour = paint_from(original, inside if inside.sum() > 50 else region & solid & ~matte, ext, radius=5)
            if i > 0:
                # The hidden root is the parent's own pixels, so the overlap can fade
                # without a step and the rest stack stays the illustration.
                same = ext & parts[names[i - 1]]
                colour[same] = original[same, :3]
                same_root[name] = same
            image[ext, :3] = colour[ext]
            image[ext, 3] = 255
            drawn[name] = (image, region | ext)
    # The parent covers its child's root. Where that root is the parent's own cloth, the
    # last few pixels of the parent fade out across the cut, so a bent joint shows an
    # overlap instead of a straight seam. At rest the faded pixels lie over identical ones.
    for names in CHAINS.values():
        for parent, child in zip(names, names[1:]):
            same = same_root.get(child)
            if same is None or not same.any() or parent not in drawn:
                continue
            pb, cb = bones[parent], bones[child]
            n = unit(unit(np.subtract(pb['tip'], pb['pivot'])) + unit(np.subtract(cb['tip'], cb['pivot'])))
            s = (xs - cb['pivot'][0]) * n[0] + (ys - cb['pivot'][1]) * n[1]
            fade = max(8.0, 0.42 * widths[child])
            child_image, _child_mask = drawn[child]
            image, mask = drawn[parent]
            # Only where the child already holds the parent's pixel: fading to nothing
            # there still composites to the illustration, and a bent joint no longer
            # shows the cut as a hard step in the shading.
            same_colour = np.all(image[..., :3] == child_image[..., :3], axis=-1) & (child_image[..., 3] > 0)
            band = same & same_colour & (s < 0) & (s > -fade)
            t = np.clip(-s / fade, 0, 1)
            smooth = t * t * (3 - 2 * t)
            image[band, 3] = (image[band, 3].astype(np.float32) * smooth[band]).astype(np.uint8)
    for name, (image, mask) in drawn.items():
        layers[name] = crop_layer(image, mask)
    # Layers cut from the same base meet along seams. Once the body moves by a fraction of a
    # pixel, texture filtering softens both sides of a seam and whatever lies below shows
    # through as a hairline. Two pixels of solid overlap close it; a solid pixel drawn twice
    # is unchanged, so the rest frame stays the illustration.
    grow = lambda mask: cv2.dilate(mask.astype(np.uint8), kernel, iterations=2) > 0
    over = caps['L'] | caps['R'] | hair_front
    under_seam = over & solid & grow(base_cut_mask)
    base = original.copy()
    base[~(base_cut_mask | under_seam)] = 0
    layers['base_cut'] = (base, [0, 0, shape[1], shape[0]])
    for side in 'LR':
        if caps[side].any():
            layers[f'cap_shoulder{side}'] = crop_layer(original, caps[side])
    if hair_front.any():
        layers['hair_front'] = crop_layer(original, hair_front)
    if hidden.any():
        # the torso's own cloth a few pixels in from its edge: the edge itself is often a
        # blend with the gap beside it
        known = cv2.erode((base_cut_mask & solid & ~hair & ~face & ~matte).astype(np.uint8), kernel, iterations=3) > 0
        colour = paint_from(original, known, hidden, radius=6)
        image = np.zeros_like(original)
        image[hidden, :3] = colour[hidden]
        image[hidden, 3] = 255
        # under the base's edge as well, where the torso it continues was drawn
        tuck = grow(hidden) & base_cut_mask & solid & ~hidden
        image[tuck] = original[tuck]
        layers['torso_hidden'] = crop_layer(image, hidden | tuck)
    delta = rest_delta(layers, original)
    if debug is not None:
        debug['hidden'] = hidden
        debug['extensions'] = extensions
        debug['caps'] = caps
        debug['hair_front'] = hair_front
    return layers, delta, widths, hair


def slice_of(toward, inner_arm, t_edge):
    return slice(inner_arm + 1, t_edge) if toward > 0 else slice(t_edge + 1, inner_arm)


def torso_behind(arm, torso, solid, bones, side, rig, alpha, matte):
    """Pixels of `arm` that would be torso if the arm were raised: per row, between the
    torso's visible edge and an edge interpolated from the rows where background shows
    between the two (and the shoulder pivot at the top). Hair between them is not a gap;
    a matte leftover is."""
    h, w = arm.shape
    ys_arm = np.nonzero(arm.any(axis=1))[0]
    if not len(ys_arm):
        return np.zeros_like(arm)
    pivot = bones[f'upperArm{side}']['pivot']
    toward = 1 if side == 'L' else -1  # direction from the arm to the torso centre
    # rows a little below the hand show where the torso edge runs once the arm ends
    rows = range(int(pivot[1]), min(h, int(ys_arm.max()) + 90))
    edge = {}
    occluded = {}
    for y in rows:
        # matte leftovers held by the arm are background for this purpose
        cols_arm = np.nonzero(arm[y] & ~matte[y])[0]
        cols_torso = np.nonzero(torso[y])[0]
        if not len(cols_torso):
            continue
        if not len(cols_arm):
            edge[y] = cols_torso.min() if toward > 0 else cols_torso.max()
            occluded[y] = False
            continue
        if toward > 0:
            inner_arm = cols_arm.max()
            torso_cols = cols_torso[cols_torso > inner_arm - 2]
            if not len(torso_cols):
                continue
            t_edge = torso_cols.min()
            between = alpha[y, slice_of(toward, inner_arm, t_edge)]
        else:
            inner_arm = cols_arm.min()
            torso_cols = cols_torso[cols_torso < inner_arm + 2]
            if not len(torso_cols):
                continue
            t_edge = torso_cols.max()
            between = alpha[y, slice_of(toward, inner_arm, t_edge)]
        occluded[y] = not ((between < 100) | matte[y, slice_of(toward, inner_arm, t_edge)]).any()
        edge[y] = t_edge
    if not edge:
        return np.zeros_like(arm)
    known_y = [y for y in edge if not occluded[y]]
    known_x = [edge[y] for y in known_y]
    anchor_y = [int(pivot[1])] + known_y
    anchor_x = [float(pivot[0]) + toward * 2] + known_x
    hidden = np.zeros_like(arm)
    for y, visible_edge in edge.items():
        if not occluded[y]:
            continue
        est = float(np.interp(y, anchor_y, anchor_x))
        if toward > 0:
            x0, x1 = int(np.floor(est)), int(visible_edge)
        else:
            x0, x1 = int(visible_edge) + 1, int(np.ceil(est)) + 1
        if x1 > x0:
            hidden[y, max(0, x0):min(w, x1)] = True
    hidden &= arm & solid & ~matte
    n, lab, stats, _ = cv2.connectedComponentsWithStats(hidden.astype(np.uint8), connectivity=8)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] < 40:
            hidden[lab == i] = False
    return cv2.morphologyEx(hidden.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)) > 0


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--debug', type=Path, help='write segmentation views here (keep it under work/)')
    parser.add_argument('samples', nargs='*', default=list(SAMPLES))
    args = parser.parse_args()
    for sample in args.samples:
        build(sample, args.debug)


def photo_hair_mask(rgba, found):
    """Hair for the photo sample: the dark strands, without the shirt, trousers or face skin.

    The built hair mask follows the long back strands down the placket and then
    matches the blue cloth, so the shirt centre sways with the hair. Blue cloth
    and skin-toned pixels are not hair; the strand springs then have nothing
    there to move.
    """
    rgb = rgba[..., :3].astype(np.float32)
    red, green, blue = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    tone = luma(rgb)
    blue_cloth = (blue > red + 8) & (blue > green + 2)
    skin = (tone > 105) & (red > blue + 12) & (red + 6 > green)
    return found & ~blue_cloth & ~skin & (rgba[..., 3] > 8)


def load_authored(folder, filename, shape):
    """A drawn replacement for a generated part, when the illustration never showed that side.

    `authored/<filename>` wins when it is the same size as the generated cut-out.
    """
    path = folder / 'authored' / filename
    if not path.is_file():
        return None
    image = np.array(Image.open(path).convert('RGBA'))
    if image.shape[:2] != shape:
        print(f'  {filename}: authored size {image.shape[1]}x{image.shape[0]} does not match the cut-out')
        return None
    return image


def build(sample, debug_dir=None):
    folder = ROOT / 'samples' / sample
    cfg = SAMPLES[sample]
    rig = json.loads((folder / 'rig.json').read_text())
    original = np.array(Image.open(folder / 'built' / 'base.png').convert('RGBA'))
    if original.shape[1] != rig['image']['width'] or original.shape[0] != rig['image']['height']:
        raise SystemExit(f'{sample}: base size does not match the rig')
    hairmask = np.array(Image.open(folder / 'built' / 'hairmask.png').convert('L')).astype(np.float32) / 255
    debug = {} if debug_dir else None
    layers, delta, widths, hair = build_parts(sample, folder, rig, cfg, original, hairmask, debug)
    if delta > 1.01:
        raise SystemExit(f'{sample}: layers laid back at rest differ from the illustration by {delta:.1f}')
    part_dir = folder / 'built' / 'parts'
    part_dir.mkdir(parents=True, exist_ok=True)
    for stale in part_dir.glob('*.png'):
        stale.unlink()
    rects = {}
    bindings = []
    bones = rig['fullBody']['bones']
    for chain, names in CHAINS.items():
        for name in names:
            if name not in layers:
                continue
            image, rect = layers[name]
            side = name[-1]
            kind = 'hand' if name.startswith('hand') else 'limb'
            binding = {'bone': name, 'side': side, 'kind': kind, 'front': f'{name}_front', 'back': f'{name}_back'}
            save_png(part_dir / f'{name}_front.png', image)
            back = load_authored(folder, f'{name}_back.png', image.shape[:2])
            save_png(part_dir / f'{name}_back.png', back if back is not None else soften(image))
            rects[f'{name}_front'] = rect
            rects[f'{name}_back'] = rect
            if kind == 'hand':
                closed = load_authored(folder, f'{name}_fist.png', image.shape[:2])
                save_png(part_dir / f'{name}_fist.png', closed if closed is not None else fist(image, rect, bones[name]))
                rects[f'{name}_fist'] = rect
                binding['fist'] = f'{name}_fist'
            bindings.append(binding)
    cutout = {'base': 'base_cut', 'under': [], 'over': []}
    for name in ('torso_hidden',):
        if name in layers:
            cutout['under'].append(name)
    for name in ('cap_shoulderL', 'cap_shoulderR', 'hair_front'):
        if name in layers:
            cutout['over'].append(name)
    for name in ['base_cut'] + cutout['under'] + cutout['over']:
        image, rect = layers[name]
        save_png(part_dir / f'{name}.png', image)
        rects[name] = rect
    manifest = {'version': 1, 'build': 'parts-2', 'cutout': cutout, 'layers': rects, 'bindings': bindings}
    (part_dir / 'parts.json').write_text(json.dumps(manifest, indent=2) + '\n')
    notes = paint_faces(folder, original, rig, cfg['style'])
    if sample == 'full-body-photo':
        kept = photo_hair_mask(original, hair)
        before = int((hairmask > 0.5).sum())
        Image.fromarray(kept.astype(np.uint8) * 255, 'L').save(folder / 'built' / 'hairmask.png')
        print(f'  photo hairmask {before} -> {int(kept.sum())} px (shirt and face skin dropped)')
    print(f'{sample}: {len(bindings)} limb parts, rest max delta {delta:.2f}, widths ' +
          ' '.join(f'{k}={v:.0f}' for k, v in widths.items()))
    for note in notes:
        print(f'  {note}')
    if debug is not None:
        write_debug(debug_dir, sample, original, debug)


def write_debug(debug_dir, sample, original, debug):
    debug_dir.mkdir(parents=True, exist_ok=True)
    view = debug['segments'].astype(np.float32)
    for name, mask in debug['extensions'].items():
        view[mask, :3] = view[mask, :3] * 0.3 + np.array([255, 255, 0]) * 0.7
        view[mask, 3] = 255
    for mask in debug['caps'].values():
        view[mask, :3] = view[mask, :3] * 0.4 + np.array([0, 255, 255]) * 0.6
    view[debug['hidden'], :3] = view[debug['hidden'], :3] * 0.3 + np.array([255, 0, 128]) * 0.7
    view[debug['hidden'], 3] = 255
    image = Image.fromarray(view.clip(0, 255).astype(np.uint8), 'RGBA')
    bg = Image.new('RGBA', image.size, (222, 223, 229, 255))
    bg.alpha_composite(image)
    bg.convert('RGB').save(debug_dir / f'{sample}-segments.png')
    seeds = original[..., :3].astype(np.float32) * 0.35 + 140
    palette = {LABEL['torso']: (40, 40, 220), LABEL['armL']: (230, 60, 60), LABEL['armR']: (60, 160, 230),
               LABEL['legL']: (240, 170, 40), LABEL['legR']: (60, 190, 90)}
    for label, colour in palette.items():
        seeds[debug['markers'] == label] = colour
    Image.fromarray(seeds.clip(0, 255).astype(np.uint8), 'RGB').save(debug_dir / f'{sample}-seeds.png')


if __name__ == '__main__':
    main()
