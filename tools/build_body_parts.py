"""Split full-body sample limbs into front, back and fist drawings, and paint
closed-eye and vowel sprites from the illustration that is already there.
The hidden side is a flat fill of that limb's own colour: the source has no
back view to copy. Rest pixels are restored by laying the front parts back on
the punched base, so a standing frame stays the original illustration.
"""
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SAMPLES = ['full-body-vest', 'full-body-coat', 'full-body-photo']
LIMBS = [
    ('handL', 'L', 'hand'), ('handR', 'R', 'hand'),
    ('footL', 'L', 'limb'), ('footR', 'R', 'limb'),
    ('lowerArmL', 'L', 'limb'), ('lowerArmR', 'R', 'limb'),
    ('lowerLegL', 'L', 'limb'), ('lowerLegR', 'R', 'limb'),
    ('upperArmL', 'L', 'limb'), ('upperArmR', 'R', 'limb'),
    ('upperLegL', 'L', 'limb'), ('upperLegR', 'R', 'limb'),
]


def capsule(shape, pivot, tip, radius):
    height, width = shape
    ys, xs = np.ogrid[0:height, 0:width]
    start = np.array(pivot, dtype=np.float64)
    end = np.array(tip, dtype=np.float64)
    delta = end - start
    length = float(np.hypot(delta[0], delta[1])) or 1.0
    along = ((xs - start[0]) * delta[0] + (ys - start[1]) * delta[1]) / (length * length)
    along = np.clip(along, 0.0, 1.0)
    nearest_x = start[0] + delta[0] * along
    nearest_y = start[1] + delta[1] * along
    return (xs - nearest_x) ** 2 + (ys - nearest_y) ** 2 <= radius * radius


def ellipse(shape, cx, cy, rx, ry):
    height, width = shape
    ys, xs = np.ogrid[0:height, 0:width]
    return ((xs - cx) / max(rx, 1)) ** 2 + ((ys - cy) / max(ry, 1)) ** 2 <= 1


def bounds(mask, pad=2):
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return None
    x0 = max(0, int(xs.min()) - pad)
    y0 = max(0, int(ys.min()) - pad)
    x1 = min(mask.shape[1], int(xs.max()) + pad + 1)
    y1 = min(mask.shape[0], int(ys.max()) + pad + 1)
    return x0, y0, x1 - x0, y1 - y0


def crop(image, rect, mask):
    x, y, w, h = rect
    out = np.zeros((h, w, 4), dtype=np.uint8)
    part = image[y:y + h, x:x + w].copy()
    local = mask[y:y + h, x:x + w]
    part[..., 3] = np.where(local, part[..., 3], 0)
    out[:] = part
    return out


def median_color(image, mask):
    pixels = image[mask]
    if len(pixels) == 0:
        return np.array([180, 150, 140, 255], dtype=np.uint8)
    opaque = pixels[pixels[:, 3] > 20]
    use = opaque if len(opaque) else pixels
    color = np.median(use[:, :3], axis=0)
    return np.array([*color, 255], dtype=np.uint8)


def fill_part(rect, mask, color):
    x, y, w, h = rect
    local = mask[y:y + h, x:x + w]
    out = np.zeros((h, w, 4), dtype=np.uint8)
    out[local] = color
    edge = local.copy()
    edge[1:-1, 1:-1] &= ~(local[1:-1, 1:-1] & local[:-2, 1:-1] & local[2:, 1:-1] & local[1:-1, :-2] & local[1:-1, 2:])
    darker = (color[:3].astype(np.int16) * 0.72).astype(np.uint8)
    out[edge] = [*darker, 255]
    return out


def paint_fist(rect, mask, color, bone):
    """Closed hand in this hand's own colour, covering the whole hand so the
    punched base does not leave a hole. Three darker creases mark the knuckles."""
    filled = fill_part(rect, mask, color)
    x0, y0, width, height = rect
    pivot = np.array(bone['pivot'], dtype=np.float64)
    tip = np.array(bone['tip'], dtype=np.float64)
    delta = tip - pivot
    length = float(np.hypot(delta[0], delta[1])) or 1.0
    direction = delta / length
    normal = np.array([-direction[1], direction[0]])
    darker = (color[:3].astype(np.int16) * 0.55).astype(np.uint8)
    local = mask[y0:y0 + height, x0:x0 + width]
    ys = np.arange(height)[:, None] + y0
    xs = np.arange(width)[None, :] + x0
    for band in (0.62, 0.74, 0.86):
        center = pivot + delta * band
        along = (xs - center[0]) * direction[0] + (ys - center[1]) * direction[1]
        across = np.abs((xs - center[0]) * normal[0] + (ys - center[1]) * normal[1])
        crease = local & (np.abs(along) <= 1.4) & (across < bone['radius'] * 0.7)
        filled[crease, :3] = darker
        filled[crease, 3] = 255
    return filled


def save_png(path, array):
    Image.fromarray(array, 'RGBA').save(path)


def sample_at(image, x, y):
    h, w = image.shape[:2]
    x = int(np.clip(x, 0, w - 1))
    y = int(np.clip(y, 0, h - 1))
    return image[y, x]


def curve(values, u):
    x = np.clip(u, 0, 1) * (len(values) - 1)
    i = int(np.floor(x))
    j = min(i + 1, len(values) - 1)
    t = x - i
    return values[i] * (1 - t) + values[j] * t


def paint_eye(image, eye, mode):
    x0, x1 = float(eye['x0']), float(eye['x1'])
    top, bot = np.array(eye['top'], dtype=np.float64), np.array(eye['bot'], dtype=np.float64)
    pad = 8
    left = max(0, int(np.floor(x0)) - pad)
    right = min(image.shape[1], int(np.ceil(x1)) + pad)
    upper = max(0, int(np.floor(min(top.min(), bot.min()))) - pad)
    lower = min(image.shape[0], int(np.ceil(max(top.max(), bot.max()))) + pad)
    rect = (left, upper, right - left, lower - upper)
    canvas = image[upper:lower, left:right].copy()
    span = max(x1 - x0, 1)
    ink = np.array([40, 24, 20], dtype=np.uint8)
    darkest = 255
    for i in range(24):
        u = i / 23
        px, py = x0 + span * u, top[i]
        pixel = sample_at(image, px, py)
        luma = int(pixel[0]) * 0.2 + int(pixel[1]) * 0.7 + int(pixel[2]) * 0.1
        if pixel[3] > 40 and luma < darkest:
            darkest = luma
            ink = pixel[:3]
    height, width = canvas.shape[:2]
    for y in range(height):
        for x in range(width):
            px, py = left + x, upper + y
            u = (px - x0) / span
            if u < 0 or u > 1:
                continue
            lid, lower_lid = curve(top, u), curve(bot, u)
            if py < lid - 0.5 or py > lower_lid + 0.5:
                continue
            if mode == 'half' and py > lid + (lower_lid - lid) * 0.48:
                continue
            sample_y = lower_lid + max(3, (lower_lid - lid) * 0.8)
            skin = sample_at(image, px, sample_y)
            if skin[3] < 30 or (int(skin[0]) + int(skin[1]) + int(skin[2])) < 180:
                skin = sample_at(image, px, sample_y + (lower_lid - lid))
            canvas[y, x, :3] = skin[:3]
            canvas[y, x, 3] = 255
            smile = 0.35 if mode == 'smile' else 0.08
            hump = 4 * u * (1 - u)
            arc = lid + (lower_lid - lid) * (0.46 - smile * hump)
            if abs(py - arc) <= max(1.1, (lower_lid - lid) * 0.045) and 0.04 < u < 0.96:
                canvas[y, x, :3] = ink
    return rect, canvas


def paint_mouth(image, rig, kind):
    mouth = rig['mouth']
    area = mouth['area']
    cx, cy = mouth['cx'], mouth['cy']
    rx, ry = max(area['rx'], mouth['halfLen']), max(8, area['ry'])
    left = max(0, int(cx - rx - 6))
    top = max(0, int(cy - ry - 8))
    right = min(image.shape[1], int(cx + rx + 6))
    bottom = min(image.shape[0], int(cy + ry + 8))
    rect = (left, top, right - left, bottom - top)
    canvas = np.zeros((rect[3], rect[2], 4), dtype=np.uint8)
    window = image[max(0, int(cy) - 3):int(cy) + 4, max(0, int(cx) - 8):int(cx) + 8]
    opaque = window.reshape(-1, 4)
    opaque = opaque[opaque[:, 3] > 40]
    lip = np.array([90, 40, 45], dtype=np.uint8)
    if len(opaque):
        luma = opaque[:, 0] * 0.2 + opaque[:, 1] * 0.7 + opaque[:, 2] * 0.1
        dark = opaque[luma < np.percentile(luma, 40)]
        use = dark if len(dark) else opaque
        lip = np.median(use[:, :3], axis=0).astype(np.uint8)
    skin = sample_at(image, cx, cy + ry * 0.8)
    draw = Image.fromarray(canvas, 'RGBA')
    pen = ImageDraw.Draw(draw)
    ox, oy = cx - left, cy - top
    cover = [ox - mouth['halfLen'], oy - 3, ox + mouth['halfLen'], oy + max(4, ry * 0.35)]
    pen.ellipse(cover, fill=(*skin[:3].tolist(), 255))
    shapes = {
        'a': [ox - rx * 0.72, oy - ry * 0.15, ox + rx * 0.72, oy + ry * 0.95],
        'a_half': [ox - rx * 0.62, oy - ry * 0.05, ox + rx * 0.62, oy + ry * 0.55],
        'i': [ox - rx * 0.85, oy - ry * 0.08, ox + rx * 0.85, oy + ry * 0.28],
        'o': [ox - rx * 0.42, oy - ry * 0.05, ox + rx * 0.42, oy + ry * 0.72],
    }
    box = shapes[kind]
    pen.ellipse(box, fill=(24, 12, 16, 255), outline=(*lip.tolist(), 255), width=max(1, int(ry * 0.08)))
    return rect, np.array(draw)


def build(sample):
    folder = ROOT / 'samples' / sample
    rig = json.loads((folder / 'rig.json').read_text())
    base_path = folder / 'built' / 'base.png'
    original = np.array(Image.open(base_path).convert('RGBA'))
    if original.shape[1] != rig['image']['width'] or original.shape[0] != rig['image']['height']:
        raise SystemExit(f'{sample}: base size does not match the rig')
    image = original.copy()
    bones = rig['fullBody']['bones']
    head = rig['head']
    shape = image.shape[:2]
    head_mask = ellipse(shape, head['cx'], head['cy'], head['rx'] * 0.92, head['ry'] * 0.92)
    torso = bones['torso']
    torso_core = capsule(shape, torso['pivot'], torso['tip'], torso['radius'] * 0.55)
    claimed = np.zeros(shape, dtype=bool)
    layers = {}
    bindings = []
    part_dir = folder / 'built' / 'parts'
    part_dir.mkdir(parents=True, exist_ok=True)
    for name, side, kind in LIMBS:
        bone = bones[name]
        radius = max(6, bone['radius'] * (0.62 if kind == 'hand' else 0.74))
        mask = capsule(shape, bone['pivot'], bone['tip'], radius)
        mask &= ~head_mask
        mask &= ~claimed
        if name.startswith(('upperArm', 'lowerArm', 'hand')):
            mask &= ~torso_core
        mask &= image[..., 3] > 12
        rect = bounds(mask)
        if rect is None or rect[2] < 4 or rect[3] < 4:
            continue
        claimed |= mask
        front = crop(image, rect, mask)
        back = fill_part(rect, mask, median_color(image, mask))
        front_name, back_name = f'{name}_front', f'{name}_back'
        save_png(part_dir / f'{front_name}.png', front)
        save_png(part_dir / f'{back_name}.png', back)
        layers[front_name] = list(rect)
        layers[back_name] = list(rect)
        binding = {'bone': name, 'side': side, 'kind': kind, 'front': front_name, 'back': back_name}
        if kind == 'hand':
            fist = paint_fist(rect, mask, median_color(image, mask), bone)
            fist_name = f'{name}_fist'
            save_png(part_dir / f'{fist_name}.png', fist)
            layers[fist_name] = list(rect)
            binding['fist'] = fist_name
        bindings.append(binding)
    for bone_name, kind in (('torso', 'torso'), ('hips', 'skirt')):
        bone = bones[bone_name]
        extra = bones['upperLegL']['radius'] if kind == 'skirt' else 0
        tip = [bone['tip'][0], bone['tip'][1] + extra]
        mask = capsule(shape, bone['pivot'], tip, bone['radius'] * (0.9 if kind == 'skirt' else 0.82))
        mask &= ~head_mask
        mask &= image[..., 3] > 12
        rect = bounds(mask, pad=1)
        if rect is None:
            continue
        back = fill_part(rect, mask, median_color(image, mask))
        layer = f'{kind}_back'
        save_png(part_dir / f'{layer}.png', back)
        layers[layer] = list(rect)
        bindings.append({'bone': bone_name, 'kind': kind, 'back': layer})
    punched = image.copy()
    punched[claimed, 3] = 0
    restored = punched.copy()
    for binding in bindings:
        if 'front' not in binding:
            continue
        x, y, w, h = layers[binding['front']]
        part = np.array(Image.open(part_dir / f"{binding['front']}.png").convert('RGBA'))
        dest = restored[y:y + h, x:x + w]
        cover = part[..., 3] > 0
        dest[cover] = part[cover]
    delta = np.abs(restored.astype(np.int16) - original.astype(np.int16)).max()
    save_png(base_path, punched)
    manifest = {'version': 1, 'build': 'parts-1', 'layers': layers, 'bindings': bindings}
    (part_dir / 'parts.json').write_text(json.dumps(manifest, indent=2) + '\n')

    sprite_dir = folder / 'built' / 'sprites'
    sprite_dir.mkdir(parents=True, exist_ok=True)
    sprite_layers = {}
    for index, eye in enumerate(rig['eyes']):
        for mode, sprite in (('closed', f'eyes_closed_{index}'), ('half', f'eyes_half_{index}'), ('smile', f'eyes_smile_{index}')):
            rect, painted = paint_eye(original, eye, mode)
            save_png(sprite_dir / f'{sprite}.png', painted)
            sprite_layers[sprite] = [rect[0], rect[1], rect[2], rect[3]]
    for kind, sprite in (('a', 'mouth_a'), ('a_half', 'mouth_a_half'), ('i', 'mouth_i'), ('o', 'mouth_o')):
        rect, painted = paint_mouth(original, rig, kind)
        save_png(sprite_dir / f'{sprite}.png', painted)
        sprite_layers[sprite] = [rect[0], rect[1], rect[2], rect[3]]
    (sprite_dir / 'sprites.json').write_text(json.dumps({'version': 1, 'build': 'sprites-1', 'layers': sprite_layers}, indent=2) + '\n')
    print(f'{sample}: {len(bindings)} parts, rest max delta {int(delta)} px, sprites {len(sprite_layers)}')


if __name__ == '__main__':
    for name in SAMPLES:
        build(name)
