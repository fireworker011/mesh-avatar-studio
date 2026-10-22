"""Review sheets from the frames of tools/review-cutout.mjs.

    uv run --with pillow tools/compose_cutout_review.py [--out work/cutout-review] [--tag review] [sample ...]

Writes <out>/<tag>-<sample>-poses.png (whole figure per frame), -joints.png (shoulders,
elbows, knee, hip and yaw at 1:1 or larger), -detail.png (joints enlarged) and -face.png
(closed, half and smiling eyes, and the five vowel mouths, enlarged).
"""
import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
BG = (222, 223, 229)


def load(out, sample, name):
    image = Image.open(out / f'{sample}-{name}.png').convert('RGBA')
    backdrop = Image.new('RGBA', image.size, BG + (255,))
    backdrop.alpha_composite(image)
    return backdrop.convert('RGB')


def sheet(cells, cell_w, cell_h, columns, title):
    rows = (len(cells) + columns - 1) // columns
    out = Image.new('RGB', (columns * cell_w, rows * (cell_h + 26) + 30), (250, 250, 250))
    draw = ImageDraw.Draw(out)
    draw.text((8, 6), title, fill=(0, 0, 0))
    for i, (label, image) in enumerate(cells):
        x, y = (i % columns) * cell_w, 30 + (i // columns) * (cell_h + 26)
        scale = min(cell_w / image.size[0], cell_h / image.size[1])
        size = (max(1, int(image.size[0] * scale)), max(1, int(image.size[1] * scale)))
        image = image.resize(size, Image.LANCZOS if scale < 1 else Image.NEAREST)
        out.paste(image, (x + (cell_w - size[0]) // 2, y + 20))
        draw.text((x + 6, y + 4), label, fill=(0, 0, 0))
    return out


def crop(image, centre, radius, size):
    w, h = size
    cx, cy = centre
    return image.crop((int(max(0, cx - radius)), int(max(0, cy - radius)), int(min(w, cx + radius)), int(min(h, cy + radius))))


def compose(out, tag, sample):
    rig = json.loads((ROOT / 'samples' / sample / 'rig.json').read_text())
    bones = rig['fullBody']['bones']
    size = (rig['image']['width'], rig['image']['height'])
    span = abs(bones['upperArmR']['pivot'][0] - bones['upperArmL']['pivot'][0])
    frame = lambda name: load(out, sample, name)
    poses = ['rest', 'armL50', 'armR50', 'elbow', 'kneeL', 'sit', 'yawR', 'yawL']
    sheet([(name, frame(name)) for name in poses], 300, 700, 4,
          f'{sample}: rest, image-left arm +50 deg, image-right arm +50 deg, elbows, left knee 45 deg, sit, body yaw right, left'
          ).save(out / f'{tag}-{sample}-poses.png')
    chest = ((bones['upperArmL']['pivot'][0] + bones['upperArmR']['pivot'][0]) / 2, bones['upperArmL']['pivot'][1] + span * 0.4)
    joints = [('armL50', bones['upperArmL']['pivot'], 0.55), ('armR50', bones['upperArmR']['pivot'], 0.55),
              ('elbow', bones['lowerArmL']['pivot'], 0.4), ('kneeL', bones['lowerLegL']['pivot'], 0.45),
              ('sit', bones['upperLegL']['pivot'], 0.7), ('yawR', chest, 0.85), ('yawL', chest, 0.85),
              ('rest', bones['upperArmL']['pivot'], 0.55)]
    sheet([(f'{name} zoom', crop(frame(name), centre, span * r, size)) for name, centre, r in joints], 420, 420, 4,
          f'{sample}: joints at 1:1 or larger').save(out / f'{tag}-{sample}-joints.png')
    detail = [('armL50', 'shoulder', bones['upperArmL']['pivot'], 0.2), ('armR50', 'shoulder', bones['upperArmR']['pivot'], 0.2),
              ('elbowL', 'L elbow', bones['lowerArmL']['pivot'], 0.2), ('elbowL', 'R elbow', bones['lowerArmR']['pivot'], 0.2),
              ('kneeL', 'knee', bones['lowerLegL']['pivot'], 0.2), ('sit', 'hip', bones['upperLegL']['pivot'], 0.35),
              ('yawR', 'L shoulder', bones['upperArmL']['pivot'], 0.2), ('yawL', 'R shoulder', bones['upperArmR']['pivot'], 0.2)]
    sheet([(f'{name} {where}', crop(frame(name), centre, span * r, size)) for name, where, centre, r in detail], 400, 400, 4,
          f'{sample}: joint detail, enlarged').save(out / f'{tag}-{sample}-detail.png')
    eyes = rig['eyes']
    eye_centre = ((eyes[0]['x0'] + eyes[1]['x1']) / 2, (min(eyes[0]['top']) + max(eyes[0]['bot'])) / 2)
    eye_radius = (eyes[1]['x1'] - eyes[0]['x0']) * 0.7
    mouth = rig['mouth']
    mouth_radius = mouth['halfLen'] * 2.2
    faces = [(f'{name} eyes', crop(frame(name), eye_centre, eye_radius, size)) for name in ('rest', 'eyesClosed', 'eyesHalf', 'eyesSmile')]
    faces += [(f'{name}', crop(frame(name), (mouth['cx'], mouth['cy'] + mouth['halfLen'] * 0.4), mouth_radius, size))
              for name in ('rest', 'mouthA', 'mouthI', 'mouthU', 'mouthE', 'mouthO')]
    sheet(faces, 300, 220, 5, f'{sample}: eyes (open, closed, half, smile) and mouths (closed, a i u e o), enlarged'
          ).save(out / f'{tag}-{sample}-face.png')


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--out', type=Path, default=ROOT / 'work' / 'cutout-review')
    parser.add_argument('--tag', default='review')
    parser.add_argument('samples', nargs='*', default=['full-body-vest', 'full-body-coat', 'full-body-photo'])
    args = parser.parse_args()
    out = args.out if args.out.is_absolute() else ROOT / args.out
    for sample in args.samples:
        compose(out, args.tag, sample)
        print('wrote', sample)


if __name__ == '__main__':
    main()
