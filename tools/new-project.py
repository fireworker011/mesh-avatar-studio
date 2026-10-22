# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow>=10.4"]
# ///
"""Create a private local project skeleton; its empty eye polygons must be traced."""

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

from agent_common import ROOT, inside_repo, save_json
from PIL import Image


def create(source, name, force=False, full_body=False):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", name):
        raise ValueError("name must use letters, digits, hyphens or underscores")
    with Image.open(source) as image:
        if image.format != "PNG":
            raise ValueError("input must be a PNG")
        image.load()
        w, h = image.size
        if "A" not in image.getbands() and "transparency" not in image.info:
            print(
                "Warning: no alpha channel; a transparent background is recommended.",
                file=sys.stderr,
            )
        if h < 800:
            print(
                "Warning: image is less than 800 px tall; eye details may be difficult to trace.",
                file=sys.stderr,
            )
    project = inside_repo(ROOT / "projects" / name)
    if not project.is_relative_to((ROOT / "projects").resolve()):
        raise ValueError(
            "project must stay inside projects/; redirected paths are not allowed"
        )
    if project.exists() and not force:
        raise ValueError(
            "project already exists; use --force to replace source and draft (other files are retained)"
        )
    if (project / "source.png").resolve() == source.resolve():
        raise ValueError("input is already this project's source.png")
    template = json.loads((ROOT / "samples/miko-qipao/rig.json").read_text())
    ellipse = lambda x, y, rx, ry: {
        "cx": w * x,
        "cy": h * y,
        "rx": w * rx,
        "ry": h * ry,
    }
    rig = {
        "version": 1,
        "image": {"width": w, "height": h},
        "head": {
            **ellipse(0.5, 0.3, 0.3, 0.3),
            "shiftX": 0,
            "shiftY": 0,
            "pivotX": w / 2,
            "pivotY": h * 0.55,
            "maxRoll": 0.15,
            "weightBand": [h * 0.5, h * 0.65],
            "turnBand": [h * 0.5, h * 0.7],
        },
        "body": {
            "pivotX": w / 2,
            "pivotY": h,
            "maxRoll": 0.035,
            "breathBand": [h * 0.6, h],
            "rollBand": [h * 0.5, h],
            "chest": ellipse(0.5, 0.75, 0.3, 0.25),
            "shoulders": [],
        },
        "face": {
            name: ellipse(0.5, 0.35, 0.04, 0.03)
            for name in ("nose", "mouth", "eyeA", "eyeB", "earL", "earR", "brow", "jaw")
        },
        "eyes": [{"opening": [], "roi": []} for _ in range(2)],
        "mouth": {
            "cx": w / 2,
            "cy": h * 0.45,
            "angle": 0,
            "halfLen": w * 0.04,
            "bow": 0,
            "area": {**ellipse(0.5, 0.45, 0.06, 0.03), "angle": 0},
        },
        "cheeks": [[w * 0.4, h * 0.4], [w * 0.6, h * 0.4]],
        "mesh": template["mesh"],
        "view": template["view"],
    }
    for part in ("brow", "jaw"):
        rig["face"][part]["band"] = [h * 0.4, h * 0.45]
    # Retain engine defaults, but no example illustration's gaze origin.
    rig["view"].pop("gazeCenter", None)
    if full_body:
        apply_full_body(rig, w, h)
    (project / "work").mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, project / "source.png")
    save_json(rig, project / "rig.draft.json")
    if not (project / "avatar.json").exists():
        save_json({"format": "mesh-avatar", "version": 1, "name": name}, project / "avatar.json")
    print(
        f"Created projects/{name}/ ({w} x {h}). Trace the empty eyes and place every required region before building."
    )
    if force:
        print(
            "Existing generated layers/variants were retained; rebuild and review before use."
        )


def _point(w, h, x, y):
    return [round(w * x, 2), round(h * y, 2)]


def _bone(w, h, ax, ay, bx, by, radius, bend):
    return {
        "pivot": _point(w, h, ax, ay),
        "tip": _point(w, h, bx, by),
        "radius": round(w * radius, 2),
        "maxBend": bend,
    }


def apply_full_body(rig, w, h):
    """Overlay a standing figure on a bust draft. Image-left is L."""
    if w >= h:
        print(
            "Warning: full-body source is wider than it is tall; 9:16 or 1:2 fits better.",
            file=sys.stderr,
        )
    ellipse = lambda x, y, rx, ry: {
        "cx": w * x,
        "cy": h * y,
        "rx": w * rx,
        "ry": h * ry,
    }
    rig["head"].update(
        {
            **ellipse(0.5, 0.09, 0.15, 0.05),
            "pivotX": w / 2,
            "pivotY": h * 0.155,
            "shiftX": w * 0.035,
            "shiftY": h * 0.02,
            "weightBand": [h * 0.145, h * 0.175],
            "turnBand": [h * 0.15, h * 0.20],
        }
    )
    rig["body"].update(
        {
            "pivotX": w / 2,
            "pivotY": h * 0.56,
            "maxRoll": 0.05,
            "breathBand": [h * 0.18, h * 0.42],
            "rollBand": [h * 0.17, h * 0.98],
            "chest": ellipse(0.5, 0.32, 0.16, 0.1),
            "shoulders": [
                ellipse(0.34, 0.175, 0.08, 0.03),
                ellipse(0.66, 0.175, 0.08, 0.03),
            ],
        }
    )
    features = {
        "nose": (0.5, 0.095, 0.012, 0.008),
        "mouth": (0.5, 0.115, 0.02, 0.008),
        "eyeA": (0.44, 0.085, 0.02, 0.008),
        "eyeB": (0.56, 0.085, 0.02, 0.008),
        "earL": (0.36, 0.09, 0.02, 0.012),
        "earR": (0.64, 0.09, 0.02, 0.012),
        "brow": (0.5, 0.072, 0.12, 0.01),
        "jaw": (0.5, 0.125, 0.08, 0.012),
    }
    for name, values in features.items():
        rig["face"][name] = ellipse(*values)
    for part in ("brow", "jaw"):
        rig["face"][part]["band"] = [h * 0.07, h * 0.13]
    rig["mouth"] = {
        "cx": w / 2,
        "cy": h * 0.115,
        "angle": 0,
        "halfLen": w * 0.025,
        "bow": 0,
        "area": {**ellipse(0.5, 0.115, 0.04, 0.012), "angle": 0},
    }
    rig["cheeks"] = [[w * 0.42, h * 0.105], [w * 0.58, h * 0.105]]
    x0, x1 = int(w * 0.32), int(w * 0.68)
    y0, y1 = int(h * 0.02), int(h * 0.16)
    rig["mesh"] = {
        **rig["mesh"],
        "baseCell": 12,
        "fine": {"x0": x0, "x1": max(x0 + 1, x1), "y0": y0, "y1": max(y0 + 1, y1), "cell": 6},
    }
    rig["view"] = {"padTop": 0.02, "padSide": 0.04, "gazeCenter": [w / 2, h * 0.085]}
    rig["fullBody"] = {
        "sway": 0.12,
        "armFollow": 0.65,
        "bones": {
            "torso": _bone(w, h, 0.50, 0.56, 0.50, 0.175, 0.16, 0.2),
            "hips": _bone(w, h, 0.50, 0.56, 0.50, 0.64, 0.14, 0.15),
            "upperArmL": _bone(w, h, 0.34, 0.175, 0.28, 0.32, 0.055, 0.7),
            "lowerArmL": _bone(w, h, 0.28, 0.32, 0.26, 0.45, 0.045, 0.6),
            "handL": _bone(w, h, 0.26, 0.45, 0.24, 0.51, 0.04, 0.4),
            "upperArmR": _bone(w, h, 0.66, 0.175, 0.72, 0.32, 0.055, -0.7),
            "lowerArmR": _bone(w, h, 0.72, 0.32, 0.74, 0.45, 0.045, -0.6),
            "handR": _bone(w, h, 0.74, 0.45, 0.76, 0.51, 0.04, -0.4),
            "upperLegL": _bone(w, h, 0.42, 0.50, 0.40, 0.70, 0.07, 0.4),
            "lowerLegL": _bone(w, h, 0.40, 0.70, 0.39, 0.90, 0.055, 0.35),
            "footL": _bone(w, h, 0.39, 0.90, 0.32, 0.935, 0.045, 0.3),
            "upperLegR": _bone(w, h, 0.58, 0.50, 0.60, 0.70, 0.07, -0.4),
            "lowerLegR": _bone(w, h, 0.60, 0.70, 0.61, 0.90, 0.055, -0.35),
            "footR": _bone(w, h, 0.61, 0.90, 0.68, 0.935, 0.045, -0.3),
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    parser.add_argument("name")
    parser.add_argument("--force", action="store_true")
    parser.add_argument(
        "--full-body",
        action="store_true",
        help="Place a standing figure from head to feet instead of a bust",
    )
    args = parser.parse_args()
    try:
        create(args.image, args.name, args.force, args.full_body)
    except (OSError, ValueError) as error:
        print(f"new-project: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
