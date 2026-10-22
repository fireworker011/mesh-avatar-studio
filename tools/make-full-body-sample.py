# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow>=10.4"]
# ///
"""Draw the clothed full-body sample and write its rig. Run build-layers afterwards."""

import math
from pathlib import Path

from PIL import Image, ImageDraw

from agent_common import ROOT, save_json

W, H = 540, 1080
SKIN = (242, 199, 165, 255)
HAIR = (72, 46, 34, 255)
SHIRT = (64, 112, 176, 255)
PANTS = (52, 60, 92, 255)
SHOE = (42, 38, 36, 255)
WHITE = (250, 250, 252, 255)
IRIS = (36, 48, 72, 255)
LASH = (28, 20, 16, 255)
MOUTH = (176, 78, 86, 255)


def xy(x, y):
    return [round(W * x, 2), round(H * y, 2)]


def bone(ax, ay, bx, by, radius, bend):
    return {"pivot": xy(ax, ay), "tip": xy(bx, by), "radius": round(W * radius, 2), "maxBend": bend}


def ellipse(x, y, rx, ry):
    return {"cx": W * x, "cy": H * y, "rx": W * rx, "ry": H * ry}


def oval(cx, cy, rx, ry, steps=20):
    return [
        [round(cx + math.cos(math.tau * i / steps) * rx, 2), round(cy + math.sin(math.tau * i / steps) * ry, 2)]
        for i in range(steps)
    ]


def main():
    image = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    hip_l, hip_r = xy(0.42, 0.50), xy(0.58, 0.50)
    knee_l, knee_r = xy(0.40, 0.70), xy(0.60, 0.70)
    ankle_l, ankle_r = xy(0.39, 0.90), xy(0.61, 0.90)
    foot_l, foot_r = xy(0.32, 0.935), xy(0.68, 0.935)
    shoulder_l, shoulder_r = xy(0.34, 0.175), xy(0.66, 0.175)
    elbow_l, elbow_r = xy(0.28, 0.32), xy(0.72, 0.32)
    wrist_l, wrist_r = xy(0.26, 0.45), xy(0.74, 0.45)
    hand_l, hand_r = xy(0.24, 0.51), xy(0.76, 0.51)
    for start, end, colour, width in (
        (hip_l, knee_l, PANTS, 46), (hip_r, knee_r, PANTS, 46),
        (knee_l, ankle_l, PANTS, 38), (knee_r, ankle_r, PANTS, 38),
        (ankle_l, foot_l, SHOE, 28), (ankle_r, foot_r, SHOE, 28),
    ):
        draw.line([tuple(start), tuple(end)], fill=colour, width=width)
    draw.ellipse([foot_l[0] - 8, foot_l[1] - 10, foot_l[0] + 28, foot_l[1] + 16], fill=SHOE)
    draw.ellipse([foot_r[0] - 28, foot_r[1] - 10, foot_r[0] + 8, foot_r[1] + 16], fill=SHOE)
    draw.polygon([
        (shoulder_l[0] + 8, shoulder_l[1]), (shoulder_r[0] - 8, shoulder_r[1]),
        (hip_r[0] + 10, hip_r[1] + 30), (hip_l[0] - 10, hip_l[1] + 30),
    ], fill=SHIRT)
    for start, end, width in (
        (shoulder_l, elbow_l, 30), (elbow_l, wrist_l, 24), (wrist_l, hand_l, 20),
        (shoulder_r, elbow_r, 30), (elbow_r, wrist_r, 24), (wrist_r, hand_r, 20),
    ):
        draw.line([tuple(start), tuple(end)], fill=SKIN, width=width)
    for point in (hand_l, hand_r):
        draw.ellipse([point[0] - 14, point[1] - 12, point[0] + 14, point[1] + 16], fill=SKIN)
    draw.polygon([(250, 150), (290, 150), (284, 188), (256, 188)], fill=SKIN)
    draw.ellipse([190, 42, 350, 158], fill=SKIN)
    draw.ellipse([176, 24, 364, 96], fill=HAIR)
    draw.polygon([(188, 70), (168, 210), (196, 210), (210, 90)], fill=HAIR)
    draw.polygon([(352, 70), (372, 210), (344, 210), (330, 90)], fill=HAIR)
    for centre in ((238, 92), (302, 92)):
        cx, cy = centre
        draw.ellipse([cx - 16, cy - 9, cx + 16, cy + 9], fill=WHITE)
        draw.ellipse([cx - 6, cy - 6, cx + 6, cy + 6], fill=IRIS)
        draw.arc([cx - 18, cy - 16, cx + 18, cy + 2], 200, 340, fill=LASH, width=3)
    draw.arc([250, 118, 290, 136], 20, 160, fill=MOUTH, width=3)
    project = ROOT / "samples" / "full-body"
    project.mkdir(parents=True, exist_ok=True)
    image.save(project / "source.png")
    face = {
        "nose": ellipse(0.5, 0.098, 0.012, 0.008),
        "mouth": ellipse(0.5, 0.115, 0.025, 0.008),
        "eyeA": ellipse(0.44, 0.085, 0.03, 0.01),
        "eyeB": ellipse(0.56, 0.085, 0.03, 0.01),
        "earL": ellipse(0.37, 0.09, 0.018, 0.012),
        "earR": ellipse(0.63, 0.09, 0.018, 0.012),
        "brow": {**ellipse(0.5, 0.072, 0.12, 0.008), "band": [H * 0.06, H * 0.09]},
        "jaw": {**ellipse(0.5, 0.128, 0.08, 0.012), "band": [H * 0.11, H * 0.15]},
    }
    rig = {
        "version": 1,
        "image": {"width": W, "height": H},
        "head": {
            **ellipse(0.5, 0.09, 0.15, 0.05),
            "shiftX": W * 0.035, "shiftY": H * 0.02,
            "pivotX": W / 2, "pivotY": H * 0.155, "maxRoll": 0.15,
            "weightBand": [H * 0.145, H * 0.175],
            "turnBand": [H * 0.15, H * 0.20],
        },
        "body": {
            "pivotX": W / 2, "pivotY": H * 0.56, "maxRoll": 0.05,
            "breathBand": [H * 0.18, H * 0.42],
            "rollBand": [H * 0.17, H * 0.98],
            "chest": ellipse(0.5, 0.32, 0.18, 0.12),
            "shoulders": [ellipse(0.34, 0.175, 0.08, 0.03), ellipse(0.66, 0.175, 0.08, 0.03)],
        },
        "face": face,
        "eyes": [
            {"opening": oval(238, 92, 14, 7), "roi": oval(238, 92, 28, 20)},
            {"opening": oval(302, 92, 14, 7), "roi": oval(302, 92, 28, 20)},
        ],
        "mouth": {
            "cx": W / 2, "cy": H * 0.118, "angle": 0, "halfLen": 18, "bow": 2,
            "area": {**ellipse(0.5, 0.118, 0.04, 0.012), "angle": 0},
        },
        "cheeks": [xy(0.42, 0.105), xy(0.58, 0.105)],
        "strands": [
            {"name": "bangL", "nodes": [xy(0.42, 0.045), xy(0.40, 0.07), xy(0.41, 0.09), xy(0.43, 0.10)], "sigma": 10, "k": 1, "max": 8},
            {"name": "bangC", "nodes": [xy(0.50, 0.03), xy(0.50, 0.05), xy(0.50, 0.065), xy(0.50, 0.075)], "sigma": 12, "k": 1, "max": 6},
            {"name": "bangR", "nodes": [xy(0.58, 0.045), xy(0.60, 0.07), xy(0.59, 0.09), xy(0.57, 0.10)], "sigma": 10, "k": 1, "max": 8},
            {"name": "sideL", "nodes": [xy(0.36, 0.08), xy(0.34, 0.12), xy(0.33, 0.16), xy(0.33, 0.19)], "sigma": 12, "k": 1, "max": 10},
            {"name": "sideR", "nodes": [xy(0.64, 0.08), xy(0.66, 0.12), xy(0.67, 0.16), xy(0.67, 0.19)], "sigma": 12, "k": 1, "max": 10},
        ],
        "fullBody": {
            "sway": 0.12,
            "armFollow": 0.65,
            "bones": {
                "torso": bone(0.50, 0.56, 0.50, 0.175, 0.16, 0.2),
                "hips": bone(0.50, 0.56, 0.50, 0.64, 0.14, 0.15),
                "upperArmL": bone(0.34, 0.175, 0.28, 0.32, 0.055, 0.7),
                "lowerArmL": bone(0.28, 0.32, 0.26, 0.45, 0.045, 0.6),
                "handL": bone(0.26, 0.45, 0.24, 0.51, 0.04, 0.4),
                "upperArmR": bone(0.66, 0.175, 0.72, 0.32, 0.055, -0.7),
                "lowerArmR": bone(0.72, 0.32, 0.74, 0.45, 0.045, -0.6),
                "handR": bone(0.74, 0.45, 0.76, 0.51, 0.04, -0.4),
                "upperLegL": bone(0.42, 0.50, 0.40, 0.70, 0.07, 0.4),
                "lowerLegL": bone(0.40, 0.70, 0.39, 0.90, 0.055, 0.35),
                "footL": bone(0.39, 0.90, 0.32, 0.935, 0.045, 0.3),
                "upperLegR": bone(0.58, 0.50, 0.60, 0.70, 0.07, -0.4),
                "lowerLegR": bone(0.60, 0.70, 0.61, 0.90, 0.055, -0.35),
                "footR": bone(0.61, 0.90, 0.68, 0.935, 0.045, -0.3),
            },
        },
        "mesh": {
            "baseCell": 12,
            "fine": {"x0": 170, "x1": 370, "y0": 20, "y1": 170, "cell": 6},
            "handCell": 9, "tasselCell": 6, "eyeBallCell": 4, "eyeCell": 3, "spriteCell": 4,
        },
        "view": {"padTop": 0.02, "padSide": 0.04, "gazeCenter": xy(0.5, 0.085)},
    }
    save_json(rig, project / "rig.json")
    save_json({"format": "mesh-avatar", "version": 1, "name": "Full-body sample"}, project / "avatar.json")
    print(f"Wrote samples/full-body ({W} x {H}).")


if __name__ == "__main__":
    main()
