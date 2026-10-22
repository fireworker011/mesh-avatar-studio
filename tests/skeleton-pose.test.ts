import { expect, test } from 'vitest';
import fixture from '../samples/miko-qipao/rig.json';
import vest from '../samples/full-body-vest/rig.json';
import {
  CLINICAL_DEG, IK_CHAINS, PARAMS, PRESET_NAMES, buildSkeleton, clampPose, forwardKinematics,
  jointLimits, meshAngles, orderTriangles, parseRig, poseFromJson, poseFromKeypoints, posePreset,
  poseToJson, restPose, solveCcd, solveFabrik, uncoveredWedges, validateRig, type LimbBone, type Rig,
} from 'mesh-avatar';
import { createRig } from '../packages/runtime/src/engine/rig.js';

const DEG = Math.PI / 180;

function defaults() {
  return Object.fromEntries(PARAMS.map(parameter => [parameter.id, parameter.def]));
}
function segment(pivot: [number, number], tip: [number, number], radius = 28, maxBend = 0.4): LimbBone {
  return { pivot, tip, radius, maxBend };
}
function figure(fingers = false): Rig {
  const standing = parseRig(fixture);
  standing.fullBody = {
    sway: 0, armFollow: 0,
    bones: {
      torso: segment([640, 980], [640, 760], 70, 0.3),
      hips: segment([640, 980], [640, 1060], 60, 0.2),
      upperArmL: segment([480, 800], [480, 980]),
      lowerArmL: segment([480, 980], [480, 1120]),
      handL: segment([480, 1120], [480, 1220], 16),
      upperArmR: segment([800, 800], [800, 980]),
      lowerArmR: segment([800, 980], [800, 1120]),
      handR: segment([800, 1120], [800, 1220], 16),
      upperLegL: segment([560, 1020], [560, 1240], 36),
      lowerLegL: segment([560, 1240], [560, 1460], 30),
      footL: segment([560, 1460], [520, 1500], 16),
      upperLegR: segment([720, 1020], [720, 1240], 36),
      lowerLegR: segment([720, 1240], [720, 1460], 30),
      footR: segment([720, 1460], [760, 1500], 16),
    },
    ...(fingers ? { fingers: { L: [[480, 1220], [470, 1280], [465, 1340]] as [number, number][] } } : {}),
  };
  return standing;
}
function withinLimits(skeleton: NonNullable<ReturnType<typeof buildSkeleton>>, pose: ReturnType<typeof restPose>) {
  for (const name of skeleton.order) {
    const joint = skeleton.joints[name];
    const value = pose.joints[name];
    expect(value.swing).toBeGreaterThanOrEqual(joint.swing.min - 1e-9);
    expect(value.swing).toBeLessThanOrEqual(joint.swing.max + 1e-9);
    expect(value.twist).toBeGreaterThanOrEqual(joint.twist.min - 1e-9);
    expect(value.twist).toBeLessThanOrEqual(joint.twist.max + 1e-9);
  }
}
function body25(points: Record<number, [number, number, number]>) {
  const flat = Array.from({ length: 25 * 3 }, () => 0);
  for (const [index, value] of Object.entries(points)) {
    const at = Number(index) * 3;
    flat[at] = value[0]; flat[at + 1] = value[1]; flat[at + 2] = value[2];
  }
  return flat;
}

test('a bust has no skeleton and a standing figure has the anatomical joints', () => {
  expect(buildSkeleton(parseRig(fixture))).toBeNull();
  const skeleton = buildSkeleton(figure());
  expect(skeleton).toBeTruthy();
  expect(skeleton!.order).toEqual(expect.arrayContaining([
    'pelvis', 'spine1', 'spine2', 'spine3', 'neck', 'head',
    'clavicleL', 'shoulderL', 'elbowL', 'wristL', 'hipL', 'kneeL', 'ankleL',
    'clavicleR', 'shoulderR', 'elbowR', 'wristR', 'hipR', 'kneeR', 'ankleR',
  ]));
  expect(jointLimits(skeleton!).find(joint => joint.name === 'elbowL')?.twistMax).toBe(0);
  expect(jointLimits(skeleton!).find(joint => joint.name === 'kneeR')?.twistMin).toBe(0);
  const world = forwardKinematics(skeleton!, restPose(skeleton!));
  expect(world.wristL.tip[0]).toBeCloseTo(skeleton!.joints.wristL.tip[0], 4);
  expect(world.wristL.tip[1]).toBeCloseTo(skeleton!.joints.wristL.tip[1], 4);
  expect(world.ankleR.tip[0]).toBeCloseTo(skeleton!.joints.ankleR.tip[0], 4);
});

test('the vest sample keeps a pelvis when the hips and torso share a pivot', () => {
  const rig = parseRig(vest);
  expect(validateRig(rig)).toEqual([]);
  expect(rig.fullBody!.bones.torso.pivot).toEqual(rig.fullBody!.bones.hips.pivot);
  const skeleton = buildSkeleton(rig);
  expect(skeleton!.order).toEqual(expect.arrayContaining(['pelvis', 'spine1', 'spine2', 'spine3', 'elbowL', 'kneeR', 'head']));
  const world = forwardKinematics(skeleton!, restPose(skeleton!));
  expect(world.elbowL.pivot[0]).toBeCloseTo(skeleton!.joints.elbowL.pivot[0], 3);
  expect(world.head.pivot[1]).toBeCloseTo(skeleton!.joints.head.pivot[1], 3);
});

test('elbow and knee clamps stop past flexion and hyperextension, and a hinge cannot twist', () => {
  const skeleton = buildSkeleton(figure())!;
  const pose = restPose(skeleton);
  pose.joints.elbowL = { swing: -180 * DEG, twist: 0.8 };
  pose.joints.kneeL = { swing: 40 * DEG, twist: 0.4 };
  pose.joints.elbowR = { swing: 180 * DEG, twist: -1 };
  const clamped = clampPose(skeleton, pose);
  expect(clamped.joints.elbowL.swing).toBeCloseTo(-CLINICAL_DEG.elbow.flexion * DEG, 6);
  expect(clamped.joints.elbowL.twist).toBe(0);
  expect(clamped.joints.kneeL.swing).toBeCloseTo(CLINICAL_DEG.knee.hyperextension * DEG, 6);
  expect(clamped.joints.kneeL.twist).toBe(0);
  expect(clamped.joints.elbowR.swing).toBeCloseTo(CLINICAL_DEG.elbow.flexion * DEG, 6);
  expect(clamped.joints.elbowR.twist).toBe(0);
  withinLimits(skeleton, clamped);
});

test('CCD and FABRIK move a hand toward a target and stay inside the limits', () => {
  const skeleton = buildSkeleton(figure())!;
  const rest = restPose(skeleton);
  const start = forwardKinematics(skeleton, rest).wristL.tip as [number, number];
  const target: [number, number] = [start[0] - 140, start[1] - 180];
  const before = Math.hypot(start[0] - target[0], start[1] - target[1]);
  for (const solve of [solveCcd, solveFabrik]) {
    const solved = solve(skeleton, rest, { effector: 'handL', target });
    const tip = forwardKinematics(skeleton, solved).wristL.tip as [number, number];
    expect(Math.hypot(tip[0] - target[0], tip[1] - target[1])).toBeLessThan(before * 0.85);
    withinLimits(skeleton, solved);
    expect(solved.joints.elbowL.twist).toBe(0);
    expect(solved.joints.kneeL.twist).toBe(0);
  }
  const far = solveCcd(skeleton, rest, { effector: 'handL', target: [start[0] - 4000, start[1]] });
  withinLimits(skeleton, far);
  expect(IK_CHAINS.handL).toEqual({ effector: 'wristL', root: 'clavicleL' });
});

test('presets are finite and clamped, and an unknown name is rejected', () => {
  const skeleton = buildSkeleton(figure())!;
  for (const name of PRESET_NAMES) withinLimits(skeleton, posePreset(skeleton, name));
  expect(posePreset(skeleton, 'kneel').joints.kneeL.swing).toBeCloseTo(-CLINICAL_DEG.knee.flexion * DEG, 6);
  expect(posePreset(skeleton, 'armsCrossed').drawOrder.lowerArmL).toBeGreaterThan(posePreset(skeleton, 'armsCrossed').drawOrder.upperArmR);
  expect(() => posePreset(skeleton, 'fly')).toThrow(/Unknown pose preset/);
});

test('OpenPose person-right maps to image-left, COCO person-left maps to image-right, and JSON round-trips', () => {
  const skeleton = buildSkeleton(figure())!;
  const raised = body25({
    2: [300, 200, 1], 3: [220, 80, 1], 4: [200, 40, 1],
    5: [500, 200, 1], 6: [500, 360, 1], 7: [500, 480, 1],
    9: [360, 400, 1], 10: [360, 560, 1], 11: [360, 720, 1],
    12: [460, 400, 1], 13: [460, 560, 1], 14: [460, 720, 1],
  });
  const camera = poseFromKeypoints(skeleton, { people: [{ pose_keypoints_2d: raised }] });
  expect(camera.joints.shoulderL.swing).toBeGreaterThan(1);
  expect(Math.abs(camera.joints.shoulderR.swing)).toBeLessThan(0.2);
  withinLimits(skeleton, camera);
  const coco = Array.from({ length: 17 * 3 }, () => 0);
  const put = (index: number, x: number, y: number) => { coco[index * 3] = x; coco[index * 3 + 1] = y; coco[index * 3 + 2] = 1; };
  put(5, 300, 200); put(7, 420, 70); put(9, 480, 40);
  put(6, 500, 200); put(8, 500, 360); put(10, 500, 480);
  const sameSide = poseFromKeypoints(skeleton, { keypoints: coco });
  expect(Math.abs(sameSide.joints.shoulderL.swing)).toBeLessThan(0.2);
  expect(sameSide.joints.shoulderR.swing).toBeLessThan(-1);
  const hidden = body25({ 2: [300, 200, 1], 3: [220, 80, 0.01], 5: [500, 200, 1], 6: [500, 360, 1] });
  expect(poseFromKeypoints(skeleton, hidden).joints.shoulderL.swing).toBe(0);
  const saved = poseToJson(posePreset(skeleton, 'wave'));
  expect(saved.format).toBe('mesh-avatar-pose');
  expect(poseFromJson(skeleton, saved).joints.elbowL.swing).toBeCloseTo(saved.joints['elbowL'].swing, 5);
  expect(() => poseFromJson(skeleton, { format: 'other', version: 1, joints: {} })).toThrow(/mesh-avatar-pose/);
  expect(() => poseFromKeypoints(skeleton, [1, 2, 3])).toThrow(/COCO-17/);
});

test('optional fingers are hinges, and a short chain is rejected by the rig schema', () => {
  const withFingers = figure(true);
  expect(validateRig(withFingers)).toEqual([]);
  const skeleton = buildSkeleton(withFingers)!;
  expect(skeleton.order).toContain('fingerL0');
  expect(skeleton.joints.fingerL0.twist).toEqual({ min: 0, max: 0 });
  const pose = restPose(skeleton);
  pose.joints.fingerL0 = { swing: -2, twist: 1 };
  expect(clampPose(skeleton, pose).joints.fingerL0.swing).toBeCloseTo(-CLINICAL_DEG.finger.flexion * DEG, 6);
  expect(clampPose(skeleton, pose).joints.fingerL0.twist).toBe(0);
  const broken = figure();
  broken.fullBody!.fingers = { L: [[1, 2]] };
  expect(validateRig(broken).some(error => error.includes('fingers'))).toBe(true);
});

test('an anatomical pose moves a full-body forearm and does not move a bust', () => {
  const standing = figure();
  const skeleton = buildSkeleton(standing)!;
  const engine = createRig(standing);
  const rest = { gain: 1, bunL: [0, 0], bunR: [0, 0], strands: [], limbs: {} };
  const bone = standing.fullBody!.bones.lowerArmL;
  const mid: [number, number] = [(bone.pivot[0] + bone.tip[0]) / 2, (bone.pivot[1] + bone.tip[1]) / 2];
  const weights = engine.baseWeights(mid[0], mid[1]);
  const still = engine.deformBase(mid[0], mid[1], weights, defaults(), rest, [0, 0]);
  const mesh = meshAngles(skeleton, posePreset(skeleton, 'wave'));
  const posed = engine.deformBase(mid[0], mid[1], weights, { ...defaults(), skeletonAngles: mesh.angles, skeletonParents: mesh.parents, skeletonTwist: mesh.twists }, rest, [0, 0]);
  expect(Math.hypot(posed[0] - still[0], posed[1] - still[1])).toBeGreaterThan(5);
  expect(posed.every(Number.isFinite)).toBe(true);
  const bust = createRig(parseRig(fixture));
  const at: [number, number] = [615, 400];
  const bustWeights = bust.baseWeights(at[0], at[1]);
  const plain = bust.deformBase(at[0], at[1], bustWeights, defaults(), rest, [0, 0]);
  const ignored = bust.deformBase(at[0], at[1], bustWeights, { ...defaults(), skeletonAngles: { lowerArmL: 1 } }, rest, [0, 0]);
  expect(ignored[0]).toBeCloseTo(plain[0], 8);
  expect(ignored[1]).toBeCloseTo(plain[1], 8);
  const wedges = uncoveredWedges(skeleton, posePreset(skeleton, 'wave'));
  expect(wedges.some(wedge => wedge.joint === 'elbowL')).toBe(true);
  expect(uncoveredWedges(skeleton, restPose(skeleton))).toEqual([]);
});

test('triangle order is stable until a bone depth changes', () => {
  const tris = new Uint32Array([0, 1, 2, 3, 4, 5]);
  const bones = ['upperArmL', 'upperArmL', 'upperArmL', 'upperArmR', 'upperArmR', 'upperArmR'];
  expect(Array.from(orderTriangles(tris, bones, {}))).toEqual([0, 1, 2, 3, 4, 5]);
  expect(Array.from(orderTriangles(tris, bones, { upperArmL: 2, upperArmR: 0 }))).toEqual([3, 4, 5, 0, 1, 2]);
});
