# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow>=10.4", "numpy>=1.26", "opencv-python-headless>=4.9"]
# ///
"""Turn a clothed standing illustration into samples/full-body-photo.

The source picture is an original figure made for this repository. Background
pixels that touch the border are cleared, joints follow the remaining silhouette,
and build-layers.py is run afterwards by the caller.
"""

import math
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from agent_common import ROOT, save_json


def knock_out(rgb: np.ndarray) -> np.ndarray:
    """Clear light gray pixels that connect to the picture border. Skin and clothes stay."""
    height, width = rgb.shape[:2]
    peak = rgb.max(axis=2).astype(np.int16)
    dull = ((peak - rgb.min(axis=2).astype(np.int16)) < 28) & (rgb.mean(axis=2) > 135)
    count, labels = cv2.connectedComponents(dull.astype(np.uint8), connectivity=4)
    border = np.zeros(count, dtype=bool)
    border[labels[0, :]] = True
    border[labels[-1, :]] = True
    border[labels[:, 0]] = True
    border[labels[:, -1]] = True
    border[0] = False
    background = border[labels]
    rgba = np.dstack([rgb, np.full((height, width), 255, np.uint8)])
    rgba[background, 3] = 0
    fringe = cv2.dilate(background.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    rgba[fringe & dull, 3] = 0
    return rgba


def crop_scale(rgba: np.ndarray, height_px: int = 1080) -> np.ndarray:
    alpha = rgba[..., 3] > 16
    ys, xs = np.nonzero(alpha)
    if len(xs) == 0:
        raise SystemExit('The illustration had no foreground after background removal.')
    pad = 12
    y0, y1 = max(0, ys.min() - pad), min(rgba.shape[0], ys.max() + pad + 1)
    x0, x1 = max(0, xs.min() - pad), min(rgba.shape[1], xs.max() + pad + 1)
    cropped = rgba[y0:y1, x0:x1]
    scale = height_px / cropped.shape[0]
    width_px = max(1, round(cropped.shape[1] * scale))
    return cv2.resize(cropped, (width_px, height_px), interpolation=cv2.INTER_AREA)


def rows_of(alpha: np.ndarray):
    height, width = alpha.shape
    step = max(1, round(min(width, height) / 180))
    rows = []
    for y in range(0, height, step):
        hits = np.flatnonzero(alpha[y])
        if len(hits):
            rows.append((y, int(hits[0]), int(hits[-1])))
    return rows


def row_at(rows, top, span, t):
    y = top + span * t
    return min(rows, key=lambda row: abs(row[0] - y))


def side(row, which, inset):
    y, x0, x1 = row
    width = max(1, x1 - x0)
    x = x0 + width * inset if which == 'L' else x1 - width * inset
    return [round(x, 2), round(y, 2)]


def bone(pivot, tip, radius, bend):
    return {'pivot': pivot, 'tip': tip, 'radius': round(radius, 2), 'maxBend': bend}


def ellipse(cx, cy, rx, ry):
    return {'cx': cx, 'cy': cy, 'rx': max(1, rx), 'ry': max(1, ry)}


def oval(cx, cy, rx, ry, steps=20):
    return [
        [round(cx + math.cos(math.tau * i / steps) * rx, 2), round(cy + math.sin(math.tau * i / steps) * ry, 2)]
        for i in range(steps)
    ]


def eye_centres(rgba, head_box):
    """Two dark clusters in the upper face, falling back to the head box."""
    x0, y0, x1, y1 = head_box
    crop = rgba[y0:y1, x0:x1]
    if crop.size == 0:
        return None
    luma = crop[..., :3].astype(np.float32).mean(axis=2)
    opaque = crop[..., 3] > 32
    # Upper inner face. Very dark pixels are hair, bright pixels are skin.
    face = np.zeros(opaque.shape, bool)
    face[int(crop.shape[0] * 0.18):int(crop.shape[0] * 0.5), int(crop.shape[1] * 0.16):int(crop.shape[1] * 0.84)] = True
    region = opaque & face
    if int(region.sum()) < 30:
        return None
    mid = crop.shape[1] // 2
    centres = []
    for offset in (0, mid):
        half_luma = luma[:, offset:offset + mid]
        half_region = region[:, offset:offset + mid]
        values = half_luma[half_region]
        if len(values) < 20:
            return None
        low = max(float(np.percentile(values, 12)), 40)
        high = float(np.percentile(values, 48))
        if high <= low:
            return None
        chosen = half_region & (half_luma >= low) & (half_luma <= high)
        ys, xs = np.nonzero(chosen)
        if len(xs) < 8:
            return None
        weight = high - half_luma[ys, xs] + 1
        centres.append((x0 + offset + float(np.average(xs, weights=weight)), y0 + float(np.average(ys, weights=weight))))
    if abs(centres[0][1] - centres[1][1]) > abs(centres[1][0] - centres[0][0]) * 0.8:
        return None
    return centres


def build(source: Path):
    rgb = np.array(Image.open(source).convert('RGB'))
    rgba = crop_scale(knock_out(rgb))
    height, width = rgba.shape[:2]
    alpha = rgba[..., 3] > 16
    found = rows_of(alpha)
    if len(found) < 8:
        raise SystemExit('The figure silhouette is too small to place joints.')
    top, bottom = found[0][0], found[-1][0]
    span = bottom - top
    shoulder, hip = row_at(found, top, span, 0.18), row_at(found, top, span, 0.52)
    knee, ankle = row_at(found, top, span, 0.74), row_at(found, top, span, 0.92)
    elbow, wrist = row_at(found, top, span, 0.34), row_at(found, top, span, 0.48)
    shoulders = side(shoulder, 'L', 0.18), side(shoulder, 'R', 0.18)
    hips = side(hip, 'L', 0.28), side(hip, 'R', 0.28)
    knees = side(knee, 'L', 0.32), side(knee, 'R', 0.32)
    ankles = side(ankle, 'L', 0.3), side(ankle, 'R', 0.3)
    elbows = side(elbow, 'L', 0.08), side(elbow, 'R', 0.08)
    wrists = side(wrist, 'L', 0.1), side(wrist, 'R', 0.1)
    hands = side(wrist, 'L', 0.02), side(wrist, 'R', 0.02)
    feet = side(ankle, 'L', 0.02), side(ankle, 'R', 0.02)
    feet[0][1] = min(height - 2, ankles[0][1] + span * 0.04)
    feet[1][1] = min(height - 2, ankles[1][1] + span * 0.04)
    chest = [(shoulders[0][0] + hips[0][0]) / 2, (shoulders[0][1] + hips[0][1]) / 2]
    chest[0] = (chest[0] + (shoulders[1][0] + hips[1][0]) / 2) / 2
    neck = [(shoulders[0][0] + shoulders[1][0]) / 2, (shoulders[0][1] + shoulders[1][1]) / 2]
    hip_mid = [(hips[0][0] + hips[1][0]) / 2, (hips[0][1] + hips[1][1]) / 2]
    head_rx = max(8, abs(shoulders[1][0] - shoulders[0][0]) * 0.42)
    head_top = top + span * 0.02
    head_cy = (head_top + neck[1]) / 2
    head_box = (
        int(max(0, neck[0] - head_rx)),
        int(max(0, head_top)),
        int(min(width, neck[0] + head_rx)),
        int(min(height, neck[1])),
    )
    centres = eye_centres(rgba, head_box) or (
        (neck[0] - head_rx * 0.28, head_cy),
        (neck[0] + head_rx * 0.28, head_cy),
    )
    project = ROOT / 'samples' / 'full-body-photo'
    project.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba).save(project / 'source.png')
    limb = max(12, abs(shoulders[1][0] - shoulders[0][0]) * 0.08)

    def strand(name, nodes):
        return {'name': name, 'nodes': nodes, 'sigma': 14, 'k': 1, 'max': 12}

    hair_top = head_top + 4
    rig = {
        'version': 1,
        'image': {'width': width, 'height': height},
        'head': {
            **ellipse(neck[0], head_cy, head_rx, max(8, (neck[1] - head_top) * 0.55)),
            'shiftX': round(width * 0.02, 2),
            'shiftY': round(height * 0.012, 2),
            'pivotX': neck[0],
            'pivotY': neck[1],
            'maxRoll': 0.12,
            'weightBand': [round(neck[1] - span * 0.02, 2), round(neck[1] + span * 0.04, 2)],
            'turnBand': [round(neck[1], 2), round(neck[1] + span * 0.06, 2)],
        },
        'body': {
            'pivotX': hip_mid[0],
            'pivotY': hip_mid[1],
            'maxRoll': 0.04,
            'breathBand': [round(neck[1], 2), round(hip_mid[1], 2)],
            'rollBand': [round(neck[1], 2), round(height * 0.98, 2)],
            'chest': ellipse(chest[0], chest[1], abs(shoulders[1][0] - shoulders[0][0]) * 0.28, abs(hip_mid[1] - neck[1]) * 0.45),
            'shoulders': [
                ellipse(shoulders[0][0], shoulders[0][1], limb, limb * 0.6),
                ellipse(shoulders[1][0], shoulders[1][1], limb, limb * 0.6),
            ],
        },
        'face': {
            'nose': ellipse(neck[0], head_cy + head_rx * 0.05, head_rx * 0.08, head_rx * 0.1),
            'mouth': ellipse(neck[0], centres[0][1] + head_rx * 0.35, head_rx * 0.16, head_rx * 0.08),
            'eyeA': ellipse(centres[0][0], centres[0][1], head_rx * 0.16, head_rx * 0.08),
            'eyeB': ellipse(centres[1][0], centres[1][1], head_rx * 0.16, head_rx * 0.08),
            'earL': ellipse(neck[0] - head_rx * 0.85, head_cy, head_rx * 0.12, head_rx * 0.16),
            'earR': ellipse(neck[0] + head_rx * 0.85, head_cy, head_rx * 0.12, head_rx * 0.16),
            'brow': {**ellipse(neck[0], centres[0][1] - head_rx * 0.16, head_rx * 0.7, head_rx * 0.08),
                     'band': [round(centres[0][1] - head_rx * 0.28, 2), round(centres[0][1] - head_rx * 0.02, 2)]},
            'jaw': {**ellipse(neck[0], centres[0][1] + head_rx * 0.42, head_rx * 0.4, head_rx * 0.12),
                    'band': [round(centres[0][1] + head_rx * 0.2, 2), round(centres[0][1] + head_rx * 0.55, 2)]},
        },
        'eyes': [
            {'opening': oval(centres[0][0], centres[0][1], head_rx * 0.16, head_rx * 0.07),
             'roi': oval(centres[0][0], centres[0][1], head_rx * 0.28, head_rx * 0.18)},
            {'opening': oval(centres[1][0], centres[1][1], head_rx * 0.16, head_rx * 0.07),
             'roi': oval(centres[1][0], centres[1][1], head_rx * 0.28, head_rx * 0.18)},
        ],
        'mouth': {
            'cx': neck[0], 'cy': centres[0][1] + head_rx * 0.35, 'angle': 0,
            'halfLen': round(head_rx * 0.16, 2), 'bow': 2,
            'area': {**ellipse(neck[0], centres[0][1] + head_rx * 0.35, head_rx * 0.2, head_rx * 0.1), 'angle': 0},
        },
        'cheeks': [
            [round(centres[0][0] - head_rx * 0.05, 2), round(centres[0][1] + head_rx * 0.18, 2)],
            [round(centres[1][0] + head_rx * 0.05, 2), round(centres[1][1] + head_rx * 0.18, 2)],
        ],
        'strands': [
            strand('bangC', [[neck[0], hair_top], [neck[0], head_cy - head_rx * 0.2], [neck[0], centres[0][1] - 6], [neck[0], centres[0][1] + 4]]),
            strand('sideL', [[neck[0] - head_rx * 0.7, head_cy], [neck[0] - head_rx * 0.9, neck[1]], [shoulders[0][0], shoulders[0][1] + span * 0.08], [shoulders[0][0] - 6, chest[1]]]),
            strand('sideR', [[neck[0] + head_rx * 0.7, head_cy], [neck[0] + head_rx * 0.9, neck[1]], [shoulders[1][0], shoulders[1][1] + span * 0.08], [shoulders[1][0] + 6, chest[1]]]),
            strand('backL', [[neck[0] - head_rx * 0.2, hair_top], [neck[0] - 10, neck[1]], [chest[0] - limb, chest[1]], [hip_mid[0] - limb * 0.4, hip_mid[1]]]),
            strand('backR', [[neck[0] + head_rx * 0.2, hair_top], [neck[0] + 10, neck[1]], [chest[0] + limb, chest[1]], [hip_mid[0] + limb * 0.4, hip_mid[1]]]),
        ],
        'fullBody': {
            'sway': 0.08,
            'armFollow': 0.45,
            'bones': {
                'torso': bone(hip_mid, neck, abs(shoulders[1][0] - shoulders[0][0]) * 0.34, 0.2),
                'hips': bone(hip_mid, [hip_mid[0], hip_mid[1] + span * 0.08], abs(hips[1][0] - hips[0][0]) * 0.7, 0.15),
                'upperArmL': bone(shoulders[0], elbows[0], limb * 0.7, 0.6),
                'lowerArmL': bone(elbows[0], wrists[0], limb * 0.55, 0.5),
                'handL': bone(wrists[0], hands[0], limb * 0.45, 0.35),
                'upperArmR': bone(shoulders[1], elbows[1], limb * 0.7, -0.6),
                'lowerArmR': bone(elbows[1], wrists[1], limb * 0.55, -0.5),
                'handR': bone(wrists[1], hands[1], limb * 0.45, -0.35),
                'upperLegL': bone(hips[0], knees[0], limb * 0.9, 0.35),
                'lowerLegL': bone(knees[0], ankles[0], limb * 0.7, 0.3),
                'footL': bone(ankles[0], feet[0], limb * 0.55, 0.25),
                'upperLegR': bone(hips[1], knees[1], limb * 0.9, -0.35),
                'lowerLegR': bone(knees[1], ankles[1], limb * 0.7, -0.3),
                'footR': bone(ankles[1], feet[1], limb * 0.55, -0.25),
            },
        },
        'mesh': {
            'baseCell': 14,
            'fine': {
                'x0': int(max(0, neck[0] - head_rx)),
                'x1': int(min(width, neck[0] + head_rx)),
                'y0': int(max(0, head_top)),
                'y1': int(min(height, neck[1])),
                'cell': 6,
            },
            'handCell': 9, 'tasselCell': 6, 'eyeBallCell': 4, 'eyeCell': 3, 'spriteCell': 4,
        },
        'view': {'padTop': 0.02, 'padSide': 0.04, 'gazeCenter': [round(neck[0], 2), round(centres[0][1], 2)]},
    }
    # Brow and jaw bands must be start < end. A short face can invert them.
    for part in ('brow', 'jaw'):
        band = rig['face'][part]['band']
        if band[0] >= band[1]:
            rig['face'][part]['band'] = [band[0], band[0] + 4]
    for key in ('weightBand', 'turnBand', 'breathBand', 'rollBand'):
        group = rig['head'] if key in ('weightBand', 'turnBand') else rig['body']
        band = group[key]
        if band[0] >= band[1]:
            group[key] = [band[0], min(height - 1, band[0] + 8)]
    save_json(rig, project / 'rig.json')
    save_json({
        'format': 'mesh-avatar',
        'version': 1,
        'name': 'Illustration pose sample',
        'description': 'Original clothed adult figure generated for this repository, for pose detection and full-body preview. Not taken from another dataset.',
    }, project / 'avatar.json')
    (project / 'ATTRIBUTION.md').write_text(
        'Illustration pose sample\n\n'
        'The picture in source.png is an original clothed adult figure created for this repository.\n'
        'It is not copied from Human-Art, a stock library, or another dataset.\n'
        'The figure is non-explicit. It is distributed under the same MIT licence as the rest of the repository.\n',
        encoding='utf-8',
    )
    print(f'Wrote samples/full-body-photo ({width} x {height}).')


if __name__ == '__main__':
    picture = Path(sys.argv[1] if len(sys.argv) > 1 else '/opt/cursor/artifacts/assets/standing-clothed.jpg')
    build(picture)
    subprocess.run([sys.executable, str(ROOT / 'tools' / 'build-layers.py'), str(ROOT / 'samples' / 'full-body-photo')], check=True)
