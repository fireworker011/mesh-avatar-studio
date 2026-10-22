import type { FullBodyBoneName, Point, Rig } from 'mesh-avatar';

const LIMB_PAIRS: [FullBodyBoneName, FullBodyBoneName][] = [
  ['upperArmL', 'upperArmR'], ['lowerArmL', 'lowerArmR'], ['handL', 'handR'],
  ['upperLegL', 'upperLegR'], ['lowerLegL', 'lowerLegR'], ['footL', 'footR'],
];

export interface PoseLandmark {
  x: number;
  y: number;
  visibility?: number;
}

const MIN_VISIBILITY = 0.35;
// MediaPipe names the person's own sides. A front-facing figure's right side is image-left.
const IMAGE_LEFT = { shoulder: 12, elbow: 14, wrist: 16, index: 20, hip: 24, knee: 26, ankle: 28, foot: 32 };
const IMAGE_RIGHT = { shoulder: 11, elbow: 13, wrist: 15, index: 19, hip: 23, knee: 25, ankle: 27, foot: 31 };

function landmarkPoint(landmarks: PoseLandmark[], index: number, width: number, height: number): Point | null {
  const mark = landmarks[index];
  if (!mark || (mark.visibility ?? 1) < MIN_VISIBILITY || !Number.isFinite(mark.x) || !Number.isFinite(mark.y)) return null;
  return [mark.x * width, mark.y * height];
}

function midpoint(a: Point, b: Point): Point {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** Move full-body joints onto a detected pose. Face, eye and fade bands stay where they are. */
export function applyPoseLandmarks(rig: Rig, landmarks: PoseLandmark[]): { rig: Rig; count: number } {
  const next = structuredClone(rig);
  const body = next.fullBody;
  if (!body) return { rig: next, count: 0 };
  const { width, height } = next.image;
  const at = (index: number) => landmarkPoint(landmarks, index, width, height);
  let count = 0;
  const setBone = (name: FullBodyBoneName, pivot: Point | null, tip: Point | null) => {
    if (!pivot || !tip || (pivot[0] === tip[0] && pivot[1] === tip[1])) return;
    const bone = body.bones[name];
    if (!bone) return;
    bone.pivot = pivot;
    bone.tip = tip;
    count += 1;
  };
  const shoulderL = at(IMAGE_LEFT.shoulder), shoulderR = at(IMAGE_RIGHT.shoulder);
  const hipL = at(IMAGE_LEFT.hip), hipR = at(IMAGE_RIGHT.hip);
  const elbowL = at(IMAGE_LEFT.elbow), elbowR = at(IMAGE_RIGHT.elbow);
  const wristL = at(IMAGE_LEFT.wrist), wristR = at(IMAGE_RIGHT.wrist);
  const handL = at(IMAGE_LEFT.index), handR = at(IMAGE_RIGHT.index);
  const kneeL = at(IMAGE_LEFT.knee), kneeR = at(IMAGE_RIGHT.knee);
  const ankleL = at(IMAGE_LEFT.ankle), ankleR = at(IMAGE_RIGHT.ankle);
  const footL = at(IMAGE_LEFT.foot), footR = at(IMAGE_RIGHT.foot);
  const shoulders = shoulderL && shoulderR ? midpoint(shoulderL, shoulderR) : null;
  const hips = hipL && hipR ? midpoint(hipL, hipR) : null;
  const knees = kneeL && kneeR ? midpoint(kneeL, kneeR) : null;
  setBone('torso', hips, shoulders);
  if (hips) {
    const tip: Point = knees
      ? [hips[0] + (knees[0] - hips[0]) * 0.28, hips[1] + (knees[1] - hips[1]) * 0.28]
      : [hips[0], hips[1] + height * 0.06];
    setBone('hips', hips, tip[0] === hips[0] && tip[1] === hips[1] ? null : tip);
    next.body.pivotX = hips[0];
    next.body.pivotY = hips[1];
  }
  setBone('upperArmL', shoulderL, elbowL);
  setBone('lowerArmL', elbowL, wristL);
  setBone('handL', wristL, handL);
  setBone('upperArmR', shoulderR, elbowR);
  setBone('lowerArmR', elbowR, wristR);
  setBone('handR', wristR, handR);
  setBone('upperLegL', hipL, kneeL);
  setBone('lowerLegL', kneeL, ankleL);
  setBone('footL', ankleL, footL);
  setBone('upperLegR', hipR, kneeR);
  setBone('lowerLegR', kneeR, ankleR);
  setBone('footR', ankleR, footR);
  if (shoulders && hips) {
    next.body.chest.cx = (shoulders[0] + hips[0]) / 2;
    next.body.chest.cy = (shoulders[1] + hips[1]) / 2;
  }
  if (shoulders) {
    next.head.pivotX = shoulders[0];
    next.head.pivotY = shoulders[1];
  }
  if (next.body.shoulders.length === 0 && shoulderL && shoulderR) {
    const rx = width * 0.08, ry = Math.max(1, height * 0.035);
    next.body.shoulders.push(
      { cx: shoulderL[0], cy: shoulderL[1], rx, ry },
      { cx: shoulderR[0], cy: shoulderR[1], rx, ry },
    );
  } else if (shoulderL && shoulderR && next.body.shoulders.length >= 2) {
    const [first, second] = next.body.shoulders;
    const left = first.cx <= second.cx ? first : second;
    const right = left === first ? second : first;
    left.cx = shoulderL[0];
    left.cy = shoulderL[1];
    right.cx = shoulderR[0];
    right.cy = shoulderR[1];
  }
  return { rig: next, count };
}

const SCORED = [11, 12, 23, 24, 25, 26, 27, 28];

/** Mean visibility of the torso and legs. Outline guesses use a fixed mid value. */
export function poseScore(landmarks: PoseLandmark[] | null): number {
  if (!landmarks?.length) return 0;
  let sum = 0;
  for (const index of SCORED) sum += landmarks[index]?.visibility ?? 0;
  return sum / SCORED.length;
}

/**
 * Standing-figure guess from an opaque mask. MediaPipe's photo model often misses
 * a flat illustration; this still drops joints on the silhouette so they can be dragged.
 * Coordinates are normalised, matching MediaPipe. Image-left is the person's right.
 */
export function silhouetteLandmarks(width: number, height: number, opaque: (x: number, y: number) => boolean): PoseLandmark[] | null {
  const step = Math.max(1, Math.round(Math.min(width, height) / 180));
  const rows: { y: number; x0: number; x1: number }[] = [];
  for (let y = 0; y < height; y += step) {
    let x0 = -1, x1 = -1;
    for (let x = 0; x < width; x += step) {
      if (!opaque(x, y)) continue;
      if (x0 < 0) x0 = x;
      x1 = x;
    }
    if (x0 >= 0) rows.push({ y, x0, x1 });
  }
  if (rows.length < 8) return null;
  const top = rows[0], bottom = rows[rows.length - 1];
  const span = bottom.y - top.y;
  if (span < height * 0.35) return null;
  const rowAt = (t: number) => {
    const y = top.y + span * t;
    let best = rows[0], bestDistance = Infinity;
    for (const row of rows) {
      const distance = Math.abs(row.y - y);
      if (distance < bestDistance) { best = row; bestDistance = distance; }
    }
    return best;
  };
  const side = (row: { x0: number; x1: number }, which: 'L' | 'R', inset: number) => {
    const widthOf = Math.max(1, row.x1 - row.x0);
    return which === 'L' ? row.x0 + widthOf * inset : row.x1 - widthOf * inset;
  };
  const marks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0 }));
  const put = (index: number, x: number, y: number) => {
    marks[index] = { x: Math.min(1, Math.max(0, x / width)), y: Math.min(1, Math.max(0, y / height)), visibility: 0.55 };
  };
  const shoulder = rowAt(0.18), hip = rowAt(0.52), knee = rowAt(0.74), ankle = rowAt(0.92);
  const elbow = rowAt(0.34), wrist = rowAt(0.48);
  put(12, side(shoulder, 'L', 0.18), shoulder.y);
  put(11, side(shoulder, 'R', 0.18), shoulder.y);
  put(24, side(hip, 'L', 0.28), hip.y);
  put(23, side(hip, 'R', 0.28), hip.y);
  put(26, side(knee, 'L', 0.32), knee.y);
  put(25, side(knee, 'R', 0.32), knee.y);
  put(28, side(ankle, 'L', 0.3), ankle.y);
  put(27, side(ankle, 'R', 0.3), ankle.y);
  put(14, side(elbow, 'L', 0.08), elbow.y);
  put(13, side(elbow, 'R', 0.08), elbow.y);
  put(16, side(wrist, 'L', 0.1), wrist.y);
  put(15, side(wrist, 'R', 0.1), wrist.y);
  put(20, side(wrist, 'L', 0.02), wrist.y);
  put(19, side(wrist, 'R', 0.02), wrist.y);
  put(32, side(ankle, 'L', 0.05), Math.min(height - 1, ankle.y + span * 0.04));
  put(31, side(ankle, 'R', 0.05), Math.min(height - 1, ankle.y + span * 0.04));
  return marks;
}

/** Copy one side's limbs across the image centre. The source side stays put. */
export function mirrorLimbs(rig: Rig, toward: 'right' | 'left' = 'right'): Rig {
  const next = structuredClone(rig);
  const body = next.fullBody;
  if (!body) return next;
  const mid = next.image.width / 2;
  const reflect = (point: Point): Point => [Math.round((mid * 2 - point[0]) * 10) / 10, point[1]];
  for (const [left, right] of LIMB_PAIRS) {
    const source = body.bones[toward === 'right' ? left : right];
    const target = body.bones[toward === 'right' ? right : left];
    if (!source || !target) continue;
    target.pivot = reflect(source.pivot);
    target.tip = reflect(source.tip);
  }
  return next;
}
