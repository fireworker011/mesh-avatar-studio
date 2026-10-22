import type { FullBodyBoneName, Point, Rig } from 'mesh-avatar';

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
