import { expect, test } from 'vitest';
import fixture from '../samples/miko-qipao/rig.json';
import { parseRig, type LimbBone, type Rig } from 'mesh-avatar';
import { applyPoseLandmarks, mirrorLimbs, poseScore, silhouetteLandmarks, type PoseLandmark } from '../src/editor/pose-landmarks';

function standingRig(): Rig {
  const rig = parseRig(fixture);
  const bone = (): LimbBone => ({ pivot: [1, 1], tip: [2, 2], radius: 10, maxBend: 0.2 });
  rig.fullBody = {
    sway: 0, armFollow: 0,
    bones: {
      torso: bone(), hips: bone(),
      upperArmL: bone(), lowerArmL: bone(), handL: bone(),
      upperArmR: bone(), lowerArmR: bone(), handR: bone(),
      upperLegL: bone(), lowerLegL: bone(), footL: bone(),
      upperLegR: bone(), lowerLegR: bone(), footR: bone(),
    },
  };
  rig.body.shoulders = [];
  return rig;
}

function marks(): PoseLandmark[] {
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }));
  const place = (index: number, x: number, y: number, visibility = 1) => { landmarks[index] = { x, y, visibility }; };
  place(12, 0.34, 0.2); place(14, 0.28, 0.35); place(16, 0.26, 0.48); place(20, 0.24, 0.55);
  place(11, 0.66, 0.2); place(13, 0.72, 0.35); place(15, 0.74, 0.48); place(19, 0.76, 0.55);
  place(24, 0.42, 0.55); place(26, 0.4, 0.72); place(28, 0.39, 0.9); place(32, 0.32, 0.95);
  place(23, 0.58, 0.55); place(25, 0.6, 0.72); place(27, 0.61, 0.9); place(31, 0.68, 0.95);
  return landmarks;
}

test('pose landmarks move image-left joints and leave the eyes alone', () => {
  const rig = standingRig();
  const eyes = structuredClone(rig.eyes);
  const placed = applyPoseLandmarks(rig, marks());
  expect(placed.count).toBe(14);
  expect(placed.rig.eyes).toEqual(eyes);
  expect(placed.rig.head.weightBand).toEqual(rig.head.weightBand);
  const width = rig.image.width, height = rig.image.height;
  expect(placed.rig.fullBody?.bones.upperArmL.pivot).toEqual([0.34 * width, 0.2 * height]);
  expect(placed.rig.fullBody?.bones.upperArmR.pivot[0]).toBeGreaterThan(placed.rig.fullBody!.bones.upperArmL.pivot[0]);
  expect(placed.rig.body.pivotY).toBeCloseTo(0.55 * height);
  expect(placed.rig.body.shoulders).toHaveLength(2);
  expect(placed.rig.head.pivotY).toBeCloseTo(0.2 * height);
});

test('a hidden pose and a bust rig place nothing', () => {
  const rig = standingRig();
  const hidden = marks().map(mark => ({ ...mark, visibility: 0.1 }));
  expect(applyPoseLandmarks(rig, hidden).count).toBe(0);
  const bust = parseRig(fixture);
  expect(applyPoseLandmarks(bust, marks()).count).toBe(0);
  expect(applyPoseLandmarks(bust, marks()).rig.fullBody).toBeUndefined();
});

test('a standing silhouette places both sides and can be applied', () => {
  const marksFromMask = silhouetteLandmarks(100, 200, (x, y) => x >= 40 && x <= 80 && y >= 10 && y <= 190);
  expect(marksFromMask).toBeTruthy();
  expect(poseScore(marksFromMask)).toBeCloseTo(0.55);
  expect(marksFromMask![12].x).toBeLessThan(0.5);
  expect(marksFromMask![11].x).toBeGreaterThan(0.5);
  expect(marksFromMask![28].y).toBeGreaterThan(marksFromMask![12].y);
  const placed = applyPoseLandmarks(standingRig(), marksFromMask!);
  expect(placed.count).toBe(14);
});

test('mirroring copies image-left limbs across the centre', () => {
  const rig = standingRig();
  rig.image.width = 100;
  rig.fullBody!.bones.upperArmL = { pivot: [10, 20], tip: [15, 40], radius: 8, maxBend: 0.2 };
  const next = mirrorLimbs(rig);
  expect(next.fullBody!.bones.upperArmR.pivot).toEqual([90, 20]);
  expect(next.fullBody!.bones.upperArmR.tip).toEqual([85, 40]);
  expect(next.fullBody!.bones.upperArmL.pivot).toEqual([10, 20]);
  expect(mirrorLimbs(parseRig(fixture)).fullBody).toBeUndefined();
});
