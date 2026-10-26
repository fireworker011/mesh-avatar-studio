"""Closed eyes and vowel mouths for the full-body samples, from the illustration's own pixels.

The closed line uses each eye's measured lash thickness and stays inside the opening.
The opening is filled with the skin already under that eye, so the sprite does not
lay a new flat colour on the face. Brow strokes on the lash layer are copied across,
because hiding that layer for the blink would erase them. Mouths are the drawn lip
stroke opened into each vowel, not an ellipse. A sheet without mouth_e / mouth_u is
left for the runtime to fall back.
"""
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

# How far each vowel opens, as a fraction of the mouth's half length, and how the
# corners pinch. `curve` below 1 stays wide toward the corners (い); above 1 rounds
# them in (う, お). `width` scales the stroke about the lip centre.
VOWELS = {
    'a': {'up': 0.05, 'down': 0.42, 'width': 1.0, 'curve': 0.65},
    'a_half': {'up': 0.03, 'down': 0.22, 'width': 0.98, 'curve': 1.0},
    'i': {'up': 0.02, 'down': 0.08, 'width': 1.16, 'curve': 0.45},
    'e': {'up': 0.04, 'down': 0.24, 'width': 1.10, 'curve': 0.75},
    'o': {'up': 0.07, 'down': 0.34, 'width': 0.70, 'curve': 1.35},
    'u': {'up': 0.05, 'down': 0.18, 'width': 0.56, 'curve': 1.55},
}


def luma_of(rgb):
    return rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114


def curve_at(values, u):
    x = float(np.clip(u, 0, 1)) * (len(values) - 1)
    i = int(np.floor(x))
    j = min(i + 1, len(values) - 1)
    t = x - i
    return float(values[i] * (1 - t) + values[j] * t)


def save_png(path, array):
    Image.fromarray(np.ascontiguousarray(array), 'RGBA').save(path)


def composite_eyes(base, folder):
    """Base plus the eye cut-outs, so the lash ink is there to measure and copy."""
    layers = json.loads((folder / 'built' / 'layers.json').read_text())['layers']
    image = base.copy()
    for name, rect in layers.items():
        if not name.startswith('eye'):
            continue
        part = np.array(Image.open(folder / 'built' / f'{name}.png').convert('RGBA'))
        x, y, w, h = rect
        src = part.astype(np.float32)
        dst = image[y:y + h, x:x + w].astype(np.float32)
        a = src[..., 3:4] / 255
        dst[..., :3] = src[..., :3] * a + dst[..., :3] * (1 - a)
        dst[..., 3:4] = src[..., 3:4] + dst[..., 3:4] * (1 - a)
        image[y:y + h, x:x + w] = np.clip(dst, 0, 255).astype(np.uint8)
    return image


def load_part(folder, name):
    layers = json.loads((folder / 'built' / 'layers.json').read_text())['layers']
    rect = layers[name]
    image = np.array(Image.open(folder / 'built' / f'{name}.png').convert('RGBA'))
    return image, rect


def measure_lash(lash, rect, eye):
    """Thickness and ink of this eye's upper lash.

    Only the dark core counts. A soft eyelid gradient in the same cut-out is not
    the stroke, and taking it made the closed line a bar.
    """
    x0, y0, w, _h = rect
    top = np.asarray(eye['top'], np.float64)
    span = max(float(eye['x1']) - float(eye['x0']), 1)
    runs, inks = [], []
    for i in range(5, 19):
        u = i / 23
        px = float(eye['x0']) + span * u
        py = curve_at(top, u)
        lx = int(round(px - x0))
        if not (0 <= lx < w):
            continue
        column = lash[:, lx]
        tones = luma_of(column[:, :3].astype(np.float32))
        opaque = np.nonzero(column[:, 3] > 40)[0]
        if not len(opaque):
            continue
        target = py - y0
        near = opaque[np.abs(opaque - target) <= 6]
        if not len(near):
            continue
        darkest_tone = float(tones[near].min())
        core = near[tones[near] <= darkest_tone + 26]
        if not len(core):
            continue
        runs.append(int(len(core)))
        inks.append(column[int(near[np.argmin(tones[near])]), :3])
    thick = float(np.clip(np.median(runs) if runs else 1.5, 1, 2.5))
    ink = np.median(np.stack(inks), axis=0).astype(np.uint8) if inks else np.array([36, 24, 18], np.uint8)
    return thick, ink


def brow_mask(lash, rect, eye):
    """Brow strokes on the lash layer: a separate run above the lash, with a gap between.

    The lash itself stays out of this mask. Copying it as well as the closed line
    drew two lids.
    """
    x0, y0, w, h = rect
    top = np.asarray(eye['top'], np.float64)
    span = max(float(eye['x1']) - float(eye['x0']), 1)
    mask = np.zeros((h, w), bool)
    tones = luma_of(lash[..., :3].astype(np.float32))
    opaque = (lash[..., 3] > 40) & (tones < 80)
    for x in range(w):
        u = (x0 + x - float(eye['x0'])) / span
        lid = curve_at(top, float(np.clip(u, 0, 1))) - y0
        ys = np.nonzero(opaque[:, x])[0]
        if not len(ys):
            continue
        groups = np.split(ys, np.where(np.diff(ys) > 1)[0] + 1)
        lash_i = min(range(len(groups)), key=lambda i: abs(float(groups[i].mean()) - lid))
        lash_top = int(groups[lash_i][0])
        for i, group in enumerate(groups):
            if i == lash_i or int(group[-1]) >= lash_top:
                continue
            if float(group.mean()) > float(np.min(top)) - y0 - 1:
                continue
            mask[group, x] = True
    if mask.any():
        count, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
        for i in range(1, count):
            if stats[i, cv2.CC_STAT_WIDTH] < 5:
                mask[labels == i] = False
    return mask


def paint_eye(base, composite, lash, lash_rect, eye, index, mode, thick, ink):
    """One lid line on the skin that is already drawn under the eye.

    The opening of the base picture is that skin. A single averaged colour there
    sat on the face as a pale disc, so the sprite copies the base pixels and only
    adds the line. Half-open eyes keep the iris below the line.
    """
    x0, x1 = float(eye['x0']), float(eye['x1'])
    top = np.asarray(eye['top'], np.float64)
    bot = np.asarray(eye['bot'], np.float64)
    lx, ly, lw, lh = lash_rect
    pad = 2
    left = max(0, min(int(np.floor(x0)) - pad, lx))
    right = min(base.shape[1], max(int(np.ceil(x1)) + pad, lx + lw))
    upper = max(0, min(int(np.floor(min(top.min(), bot.min()))) - pad, ly))
    lower = min(base.shape[0], max(int(np.ceil(max(top.max(), bot.max()))) + pad, ly + lh))
    canvas = np.zeros((lower - upper, right - left, 4), np.uint8)
    span = max(x1 - x0, 1)
    ink_f = ink.astype(np.float32)
    for y in range(canvas.shape[0]):
        py = upper + y
        for x in range(canvas.shape[1]):
            px = left + x
            u = (px - x0) / span
            if u < 0 or u > 1:
                continue
            lid_top = curve_at(top, u)
            lid_bot = curve_at(bot, u)
            if py < lid_top or py > lid_bot:
                continue
            height = max(lid_bot - lid_top, 1)
            hump = 4 * u * (1 - u)
            if mode == 'half':
                line = lid_top + height * (0.52 + 0.05 * hump)
            elif mode == 'smile':
                line = lid_top + height * (0.70 - 0.34 * hump)
            elif mode == 'closed':
                line = lid_top + height * (0.42 + 0.12 * hump)
            else:
                raise ValueError(f'unknown eye sprite {mode}')
            outer = u if index == 0 else 1 - u
            inner = 1 - u if index == 0 else u
            taper = min(1.0, outer / 0.16) * min(1.0, inner / 0.06)
            half = min(thick / 2, height * 0.4) * taper
            if half > 0.15:
                line = min(max(line, lid_top + half), lid_bot - half)
            source = composite if mode == 'half' and py > line + max(half, 0.5) else base
            pixel = source[py, px]
            if pixel[3] < 200:
                continue
            canvas[y, x, :3] = pixel[:3]
            canvas[y, x, 3] = 255
            if half > 0.15 and abs(py - line) <= half:
                # Soften the ink into the pixel already there, not into a new colour.
                edge = abs(py - line) / half
                cover = 1.0 if edge < 0.55 else max(0.0, (1 - edge) / 0.45)
                skin_f = pixel[:3].astype(np.float32)
                canvas[y, x, :3] = (ink_f * cover + skin_f * (1 - cover)).astype(np.uint8)
    brow = brow_mask(lash, lash_rect, eye)
    oy, ox = ly - upper, lx - left
    if oy >= 0 and ox >= 0:
        view = canvas[oy:oy + lh, ox:ox + lw]
        cut = brow[:view.shape[0], :view.shape[1]]
        view[cut] = lash[:view.shape[0], :view.shape[1]][cut]
    return [left, upper, right - left, lower - upper], canvas


def stroke_columns(image, mouth):
    """The drawn lip mark: the dark pixel in each column, kept while it stays a stroke."""
    h, w = image.shape[:2]
    cx, cy = float(mouth['cx']), float(mouth['cy'])
    half = float(mouth['halfLen'])
    angle = float(mouth.get('angle', 0))
    found = []
    for x in range(max(0, int(cx - half * 2.4)), min(w, int(cx + half * 2.4) + 1)):
        y_line = cy + (x - cx) * np.tan(angle)
        window = []
        for dy in range(-7, 8):
            y = int(round(y_line + dy))
            if 0 <= y < h and image[y, x, 3] > 40:
                window.append((y, image[y, x, :3].astype(np.int16)))
        if len(window) < 3:
            continue
        tones = [float(luma_of(pixel[None])[0]) for _, pixel in window]
        darkest = int(np.argmin(tones))
        # The middle of a thin mouth line is only a little darker than the skin.
        if np.median(tones) - tones[darkest] < 10 or tones[darkest] > 200:
            continue
        y, pixel = window[darkest]
        found.append((x, y, pixel, tones[darkest]))
    if not found:
        return []
    runs, run = [], [found[0]]
    for prev, cur in zip(found, found[1:]):
        gap = cur[0] - prev[0]
        # A lighter stretch in the middle of one mouth line is still that line.
        if gap <= 10 and abs(cur[1] - prev[1]) <= 4:
            run.append(cur)
        else:
            runs.append(run)
            run = [cur]
    runs.append(run)
    on_centre = [item for item in runs if item[0][0] - 4 <= cx <= item[-1][0] + 4]
    return (on_centre or runs)[0] if on_centre else min(runs, key=lambda item: min(abs(point[0] - cx) for point in item))


def stroke_thickness(image, columns):
    if not columns:
        return 2.0
    runs = []
    h = image.shape[0]
    for x, y, _pixel, tone in columns[:: max(1, len(columns) // 7)]:
        count = 0
        for yy in range(max(0, y - 4), min(h, y + 5)):
            pixel = image[yy, x]
            if pixel[3] > 40 and float(luma_of(pixel[:3][None])[0]) < tone + 22:
                count += 1
        if count:
            runs.append(count)
    return float(np.clip(np.median(runs) if runs else 2, 1, 5))


def paint_drawn_mouth(image, mouth, kind):
    columns = stroke_columns(image, mouth)
    if len(columns) < 4:
        raise RuntimeError(f'mouth {kind}: the lip stroke was not found')
    spec = VOWELS[kind]
    thick = stroke_thickness(image, columns)
    by_x = {point[0]: point for point in columns}
    xs = np.array(sorted(by_x))
    span = max(float(xs.max() - xs.min()) / 2, 2)
    mid_x = float(xs.min() + xs.max()) / 2
    skins, inks = [], []
    for x, y, pixel, _tone in columns:
        above = max(0, y - 6)
        sample = image[above, x]
        if sample[3] > 180 and float(luma_of(sample[:3][None])[0]) > 120:
            skins.append(sample[:3].astype(np.float32))
        inks.append(pixel.astype(np.float32))
    skin = np.median(np.stack(skins), axis=0) if skins else np.array([220, 190, 176], np.float32)
    ink = np.median(np.stack(inks), axis=0)
    interior = np.clip(ink * 0.45, 0, 255)
    # Open relative to the drawn stroke, so a short straight mouth does not become a tall block.
    down = spec['down'] * max(span * 0.7, thick * 3)
    up = spec['up'] * max(span * 0.2, thick)
    width = spec['width']
    pad = int(thick + 4)
    left = max(0, int(min(xs.min(), mid_x - span * width) - pad))
    right = min(image.shape[1], int(max(xs.max(), mid_x + span * width) + pad) + 1)
    ys = np.array([by_x[int(x)][1] for x in xs])
    upper = max(0, int(ys.min() - up - thick - pad))
    lower = min(image.shape[0], int(ys.max() + down + thick + pad) + 1)
    canvas = np.zeros((lower - upper, right - left, 4), np.uint8)
    # Cover the original stroke, including its soft edge, or it stays beside the open mouth.
    cover = np.zeros(image.shape[:2], np.uint8)
    cover[ys, xs] = 255
    cover = cv2.dilate(cover, np.ones((5, 5), np.uint8))
    skin_u8 = np.clip(skin, 0, 255).astype(np.uint8)
    source_y = {int(x): by_x[int(x)][1] for x in xs}
    source_ink = {int(x): by_x[int(x)][2].astype(np.float32) for x in xs}

    def column_at(x):
        if x in source_y:
            return source_y[x], source_ink[x]
        nearest = int(xs[np.argmin(np.abs(xs - x))])
        return source_y[nearest], source_ink[nearest]

    for x in range(left, right):
        src_x = mid_x + (x - mid_x) / width
        if xs.min() - 1 <= src_x <= xs.max() + 1:
            src_y, src_ink = column_at(int(round(np.clip(src_x, xs.min(), xs.max()))))
        else:
            src_y, src_ink = None, None
        u = (x - mid_x) / max(span * width, 1)
        profile = max(0.0, 1 - u * u) ** spec['curve'] if abs(u) <= 1 else 0
        top_lip = src_y - up * profile if src_y is not None else None
        bot_lip = src_y + down * profile if src_y is not None else None
        for y in range(upper, lower):
            on_stroke = cover[y, x] > 0
            in_mouth = top_lip is not None and abs(u) <= 1 and top_lip - thick <= y <= bot_lip + thick
            if not on_stroke and not in_mouth:
                continue
            local = canvas[y - upper, x - left]
            local[:3] = skin_u8
            local[3] = 255
            if top_lip is None or abs(u) > 1:
                continue
            half_t = max(thick / 2, 0.8)
            if abs(y - top_lip) <= half_t or abs(y - bot_lip) <= half_t:
                local[:3] = np.clip(src_ink, 0, 255).astype(np.uint8)
            elif top_lip < y < bot_lip:
                local[:3] = interior.astype(np.uint8)
    return [left, upper, right - left, lower - upper], canvas


def photo_lip_mask(image, mouth):
    """The painted lips, limited to the mouth ellipse so cheek blush is not a lip."""
    h, w = image.shape[:2]
    cx, cy = float(mouth['cx']), float(mouth['cy'])
    half = float(mouth['halfLen'])
    area = mouth['area']
    rx, ry = max(float(area['rx']) * 0.95, half * 0.7), max(float(area['ry']) * 1.5, 7)
    yy, xx = np.mgrid[:h, :w]
    window = ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2 <= 1
    rgb = image[..., :3].astype(np.float32)
    red = (rgb[..., 0] > rgb[..., 1] + 8) & (rgb[..., 0] > rgb[..., 2] + 10)
    red &= (luma_of(rgb) > 60) & (luma_of(rgb) < 200) & (image[..., 3] > 180) & window
    red = cv2.morphologyEx(red.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8)) > 0
    count, labels, stats, centroids = cv2.connectedComponentsWithStats(red.astype(np.uint8), connectivity=8)
    best, best_d = None, 1e9
    for i in range(1, count):
        if stats[i, cv2.CC_STAT_AREA] < 8:
            continue
        distance = float(np.hypot(centroids[i, 0] - cx, centroids[i, 1] - cy))
        if distance < best_d:
            best, best_d = i, distance
    if best is None or best_d > half:
        return None
    return labels == best


def paint_photo_mouth(image, mouth, kind):
    mask = photo_lip_mask(image, mouth)
    if mask is None:
        return paint_drawn_mouth(image, mouth, kind)
    spec = VOWELS[kind]
    cx = float(mouth['cx'])
    half = float(mouth['halfLen'])
    columns = {}
    ys, xs = np.nonzero(mask)
    for x, y in zip(xs, ys):
        columns.setdefault(int(x), []).append(int(y))
    order = sorted(columns)
    if len(order) < 4:
        return paint_drawn_mouth(image, mouth, kind)
    top_edge = {x: min(columns[x]) for x in order}
    bot_edge = {x: max(columns[x]) for x in order}
    height = max(3.0, float(np.median([bot_edge[x] - top_edge[x] + 1 for x in order])))
    # Open by a fraction of the lip itself. halfLen made あ a hole larger than the mouth.
    up = spec['up'] * height * 1.2
    down = spec['down'] * height * 1.15
    width = spec['width']
    seam_y = np.array([(top_edge[x] + bot_edge[x]) // 2 for x in order], np.int32)
    seam = image[np.clip(seam_y, 0, image.shape[0] - 1), np.array(order)]
    tones = luma_of(seam[..., :3].astype(np.float32))
    hole = np.median(seam[tones <= np.percentile(tones, 35)][..., :3].astype(np.float32), axis=0)
    hole = np.clip(hole * 0.62, 0, 255)
    # Skin is the pixel just outside the lip, per column, not one flat rectangle.
    skin_at = {}
    for x in order:
        for y in (top_edge[x] - 3, bot_edge[x] + 3):
            if 0 <= y < image.shape[0] and image[y, x, 3] > 180 and not mask[y, x]:
                skin_at[x] = image[y, x, :3]
                break
        else:
            skin_at[x] = image[max(0, top_edge[x] - 3), x, :3]
    pad = 3
    reach = max(up, down) + pad
    left = max(0, int(min(min(order), cx - (order[-1] - cx) * width) - pad))
    right = min(image.shape[1], int(max(max(order), cx + (cx - order[0]) * width) + pad + 1))
    upper = max(0, int(min(top_edge.values()) - reach))
    lower = min(image.shape[0], int(max(bot_edge.values()) + reach + 1))
    canvas = np.zeros((lower - upper, right - left, 4), np.uint8)
    cover = cv2.dilate(mask.astype(np.uint8), np.ones((5, 5), np.uint8), iterations=2) > 0
    for x in order:
        y0 = max(0, top_edge[x] - 2)
        y1 = min(image.shape[0], bot_edge[x] + 7)
        cover[y0:y1, x] = True
    xs_arr = np.array(order)

    def nearest_x(x):
        return int(xs_arr[np.argmin(np.abs(xs_arr - x))])

    for x in range(left, right):
        src_x = nearest_x(int(round(cx + (x - cx) / max(width, 1e-3))))
        u = (x - cx) / max((order[-1] - order[0]) * 0.5 * width, 1)
        profile = max(0.0, 1 - min(abs(u), 1) ** 2) ** spec['curve'] if abs(u) <= 1.02 else 0
        # The corners stay shut so the two lips meet and the original corner is covered.
        profile *= max(0.0, 1 - max(0.0, abs(u) - 0.84) / 0.16)
        src_top, src_bot = top_edge[src_x], bot_edge[src_x]
        shift_up = up * profile
        shift_down = down * profile
        new_top = src_top - shift_up
        new_bot = src_bot + shift_down
        mid = (src_top + src_bot) / 2
        for y in range(upper, lower):
            was = bool(cover[y, x]) if 0 <= y < image.shape[0] else False
            in_open = abs(u) <= 1.02 and new_top - 0.5 <= y <= new_bot + 0.5
            if not was and not in_open:
                continue
            local = canvas[y - upper, x - left]
            local[3] = 255
            if not in_open:
                local[:3] = skin_at[nearest_x(x)]
                continue
            upper_span = max(1.0, mid - src_top)
            lower_span = max(1.0, src_bot - mid)
            if y <= new_top + upper_span:
                src_y = int(np.clip(src_top + (y - new_top) * (upper_span / max(upper_span + shift_up, 1)), src_top, mid))
                local[:3] = image[src_y, src_x, :3]
            elif y >= new_bot - lower_span:
                src_y = int(np.clip(src_bot - (new_bot - y) * (lower_span / max(lower_span + shift_down, 1)), mid, src_bot))
                local[:3] = image[src_y, src_x, :3]
            else:
                local[:3] = hole.astype(np.uint8)
    # Any of the original lip the new drawing missed is covered, or it shows beside the vowel.
    ys, xs = np.nonzero(cover)
    for y, x in zip(ys, xs):
        if not (upper <= y < lower and left <= x < right):
            continue
        local = canvas[y - upper, x - left]
        if local[3] == 0:
            local[:3] = skin_at[nearest_x(x)]
            local[3] = 255
    return [left, upper, right - left, lower - upper], canvas


def paint_faces(folder, base, rig, style):
    composite = composite_eyes(base, folder)
    layers = {}
    notes = []
    for index, eye in enumerate(rig['eyes']):
        lash, rect = load_part(folder, f'eye{index}_lash')
        thick, ink = measure_lash(lash, rect, eye)
        notes.append(f'eye{index} lash {thick:.1f}px ink {ink.tolist()}')
        for mode, name in (('closed', f'eyes_closed_{index}'), ('half', f'eyes_half_{index}'), ('smile', f'eyes_smile_{index}')):
            layers[name] = paint_eye(base, composite, lash, rect, eye, index, mode, thick, ink)
    painter = paint_photo_mouth if style == 'photo' else paint_drawn_mouth
    for kind, name in (
        ('a', 'mouth_a'), ('a_half', 'mouth_a_half'), ('i', 'mouth_i'),
        ('u', 'mouth_u'), ('e', 'mouth_e'), ('o', 'mouth_o'),
    ):
        layers[name] = painter(base, rig['mouth'], kind)
    sprite_dir = folder / 'built' / 'sprites'
    sprite_dir.mkdir(parents=True, exist_ok=True)
    for stale in sprite_dir.glob('*.png'):
        stale.unlink()
    sheet = {name: rect for name, (rect, _image) in layers.items()}
    for name, (_rect, image) in layers.items():
        save_png(sprite_dir / f'{name}.png', image)
    (sprite_dir / 'sprites.json').write_text(json.dumps(
        {'version': 1, 'build': 'sprites-2', 'layers': sheet}, indent=2) + '\n')
    return notes
