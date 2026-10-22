// Anatomical pose for a full-body illustration. Bust rigs never build a skeleton.
// Image-left is L. Swing is radians in the picture plane, added to the illustrated
// bone: positive rotates a downward bone toward image-left (the same sign as the
// existing limb bend). Twist is radians about the bone and is drawn only as
// foreshortening. Elbows and knees are hinges, so their twist limit is zero.
//
// Clinical ranges are population means, not a guarantee for one person. They come
// from AAOS joint-motion tables (1965; Greene and Heckman, 1994) and Norkin and
// White, Measurement of Joint Motion, 5th ed. (F. A. Davis, 2016). A front-view
// painting cannot perform the out-of-plane part of a range; the clamp is the
// in-plane share of that range. See docs/pose-system-issues.md.

const DEG = Math.PI / 180;

/**
 * @typedef {{ min: number, max: number }} Range
 * @typedef {{ name: string, parent: string | null, kind: string, side: string | null, pivot: number[], tip: number[], restVector: number[], offset: number[], length: number, radius: number, swing: Range, twist: Range }} SkeletonJoint
 * @typedef {{ order: string[], joints: Record<string, SkeletonJoint>, extraBones: Record<string, { pivot: number[], tip: number[], radius: number, maxBend: number, length: number }>, meshParents: Record<string, string | null>, limbNames: string[], headNames: string[], angleMap: Record<string, string> }} Skeleton
 * @typedef {{ swing: number, twist: number }} JointPose
 * @typedef {{ joints: Record<string, JointPose>, drawOrder: Record<string, number>, hands?: { L: number, R: number }, translation?: number[] }} Pose
 */

/** Degrees from the anatomical position. `hyperextension` is the small reverse past straight. */
export const CLINICAL_DEG = Object.freeze({
  pelvis: { swing: 15, twist: 10 },
  spine: { swing: 20, twist: 15 },
  neck: { swing: 45, twist: 40 },
  head: { swing: 25, twist: 30 },
  clavicle: { up: 45, down: 10, twist: 15 },
  shoulder: { abduction: 170, adduction: 30, twist: 90 },
  elbow: { flexion: 150, hyperextension: 10 },
  wrist: { flexion: 80, extension: 70, twist: 25 },
  hip: { abduction: 45, adduction: 30, twist: 40 },
  knee: { flexion: 135, hyperextension: 10 },
  ankle: { dorsiflexion: 20, plantarflexion: 50, twist: 20 },
  finger: { flexion: 90, hyperextension: 15 },
});

const SPEC = [
  ['pelvis', null, 'pelvis', null],
  ['spine1', 'pelvis', 'spine', null],
  ['spine2', 'spine1', 'spine', null],
  ['spine3', 'spine2', 'spine', null],
  ['neck', 'spine3', 'neck', null],
  ['head', 'neck', 'head', null],
  ['clavicleL', 'spine3', 'clavicle', 'L'],
  ['shoulderL', 'clavicleL', 'shoulder', 'L'],
  ['elbowL', 'shoulderL', 'elbow', 'L'],
  ['wristL', 'elbowL', 'wrist', 'L'],
  ['clavicleR', 'spine3', 'clavicle', 'R'],
  ['shoulderR', 'clavicleR', 'shoulder', 'R'],
  ['elbowR', 'shoulderR', 'elbow', 'R'],
  ['wristR', 'elbowR', 'wrist', 'R'],
  ['hipL', 'pelvis', 'hip', 'L'],
  ['kneeL', 'hipL', 'knee', 'L'],
  ['ankleL', 'kneeL', 'ankle', 'L'],
  ['hipR', 'pelvis', 'hip', 'R'],
  ['kneeR', 'hipR', 'knee', 'R'],
  ['ankleR', 'kneeR', 'ankle', 'R'],
];

export const IK_CHAINS = Object.freeze({
  handL: { effector: 'wristL', root: 'clavicleL' },
  handR: { effector: 'wristR', root: 'clavicleR' },
  footL: { effector: 'ankleL', root: 'hipL' },
  footR: { effector: 'ankleR', root: 'hipR' },
  head: { effector: 'head', root: 'spine1' },
});

export const PRESET_NAMES = Object.freeze([
  'stand', 'walk', 'sit', 'wave', 'handsOnHips', 'armsCrossed', 'kneel', 'bow', 'shrug', 'lunge',
]);

const MESH_ANGLE = {
  spine1: 'spine1', spine2: 'spine2', spine3: 'spine3', neck: 'neck', head: 'head',
  clavicleL: 'clavicleL', shoulderL: 'upperArmL', elbowL: 'lowerArmL', wristL: 'handL',
  clavicleR: 'clavicleR', shoulderR: 'upperArmR', elbowR: 'lowerArmR', wristR: 'handR',
  pelvis: 'hips', hipL: 'upperLegL', kneeL: 'lowerLegL', ankleL: 'footL',
  hipR: 'upperLegR', kneeR: 'lowerLegR', ankleR: 'footR',
};

const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const hypot = v => Math.hypot(v[0], v[1]);
export function rotateVec(v, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
}
function fromDown(v) {
  return Math.atan2(-v[0], v[1]);
}
function signedBend(upper, lower) {
  return Math.atan2(upper[0] * lower[1] - upper[1] * lower[0], upper[0] * lower[0] + upper[1] * lower[1]);
}

function swingLimits(kind, side, restVector) {
  const c = CLINICAL_DEG;
  const rest = fromDown(restVector);
  if (kind === 'shoulder' || kind === 'hip') {
    const table = kind === 'shoulder' ? c.shoulder : c.hip;
    const abd = table.abduction * DEG, add = table.adduction * DEG;
    return side === 'R'
      ? { min: -abd - rest, max: add - rest }
      : { min: -add - rest, max: abd - rest };
  }
  if (kind === 'elbow' || kind === 'knee' || kind === 'finger') {
    const flex = (kind === 'elbow' ? c.elbow.flexion : kind === 'knee' ? c.knee.flexion : c.finger.flexion) * DEG;
    const back = (kind === 'elbow' ? c.elbow.hyperextension : kind === 'knee' ? c.knee.hyperextension : c.finger.hyperextension) * DEG;
    return side === 'R' ? { min: -back, max: flex } : { min: -flex, max: back };
  }
  if (kind === 'wrist') return side === 'R'
    ? { min: -c.wrist.extension * DEG, max: c.wrist.flexion * DEG }
    : { min: -c.wrist.flexion * DEG, max: c.wrist.extension * DEG };
  if (kind === 'ankle') return side === 'R'
    ? { min: -c.ankle.dorsiflexion * DEG, max: c.ankle.plantarflexion * DEG }
    : { min: -c.ankle.plantarflexion * DEG, max: c.ankle.dorsiflexion * DEG };
  if (kind === 'clavicle') return side === 'R'
    ? { min: -c.clavicle.up * DEG, max: c.clavicle.down * DEG }
    : { min: -c.clavicle.down * DEG, max: c.clavicle.up * DEG };
  const span = (c[kind]?.swing ?? 15) * DEG;
  return { min: -span, max: span };
}

function twistLimits(kind) {
  if (kind === 'elbow' || kind === 'knee' || kind === 'finger') return { min: 0, max: 0 };
  const table = CLINICAL_DEG[kind];
  const span = (table?.twist ?? 0) * DEG;
  return { min: -span, max: span };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function segment(pivot, tip, radius) {
  const length = hypot(sub(tip, pivot));
  return { pivot, tip, radius: Math.max(4, radius), maxBend: 0, length };
}

/**
 * @param {import('../rig/types').Rig} rig
 * @returns {Skeleton | null}
 */
export function buildSkeleton(rig) {
  const full = rig?.fullBody;
  if (!full?.bones?.torso || !full.bones.upperArmL || !rig.head) return null;
  const b = full.bones;
  const headPivot = [rig.head.pivotX, rig.head.pivotY];
  const headTip = [rig.head.pivotX, rig.head.pivotY - Math.max(8, rig.head.ry * 0.45)];
  const points = {
    pelvis: b.hips.pivot,
    spine1: b.torso.pivot,
    spine2: lerp(b.torso.pivot, b.torso.tip, 1 / 3),
    spine3: lerp(b.torso.pivot, b.torso.tip, 2 / 3),
    neck: b.torso.tip,
    head: headPivot,
    headTip,
    shoulderL: b.upperArmL.pivot, elbowL: b.lowerArmL.pivot, wristL: b.handL.pivot, handTipL: b.handL.tip,
    shoulderR: b.upperArmR.pivot, elbowR: b.lowerArmR.pivot, wristR: b.handR.pivot, handTipR: b.handR.tip,
    hipL: b.upperLegL.pivot, kneeL: b.lowerLegL.pivot, ankleL: b.footL.pivot, footTipL: b.footL.tip,
    hipR: b.upperLegR.pivot, kneeR: b.lowerLegR.pivot, ankleR: b.footR.pivot, footTipR: b.footR.tip,
  };
  const tips = {
    pelvis: points.spine1, spine1: points.spine2, spine2: points.spine3, spine3: points.neck,
    neck: points.head, head: points.headTip,
    clavicleL: points.shoulderL, shoulderL: points.elbowL, elbowL: points.wristL, wristL: points.handTipL,
    clavicleR: points.shoulderR, shoulderR: points.elbowR, elbowR: points.wristR, wristR: points.handTipR,
    hipL: points.kneeL, kneeL: points.ankleL, ankleL: points.footTipL,
    hipR: points.kneeR, kneeR: points.ankleR, ankleR: points.footTipR,
  };
  // The illustrated hips and torso often share a pivot, which would make the pelvis
  // segment zero long and drop every child. Give the pelvis a short upward bone so
  // the joint still exists; its mesh angle is the hips bone, not this stub.
  const torsoVec = sub(b.torso.tip, b.torso.pivot);
  const torsoLen = hypot(torsoVec) || 1;
  const pelvisReach = Math.max(12, Math.min(40, torsoLen * 0.08));
  tips.pelvis = add(b.hips.pivot, [torsoVec[0] / torsoLen * pelvisReach, torsoVec[1] / torsoLen * pelvisReach]);
  // The head pivot is often the torso tip, so the neck segment would be zero long
  // and the head would be dropped with it. Aim a short neck at the head centre.
  if (hypot(sub(tips.neck, points.neck)) < 8) {
    const toward = sub([rig.head.cx, rig.head.cy], points.neck);
    const len = hypot(toward) || 1;
    const reach = Math.max(16, Math.min(48, rig.head.ry * 0.2));
    tips.neck = add(points.neck, [toward[0] / len * reach, toward[1] / len * reach]);
  }
  const radiusOf = {
    pelvis: b.hips.radius, spine1: b.torso.radius, spine2: b.torso.radius, spine3: b.torso.radius,
    neck: Math.max(8, rig.head.rx * 0.35), head: Math.max(rig.head.rx, rig.head.ry) * 0.95,
    clavicleL: b.upperArmL.radius * 0.85, clavicleR: b.upperArmR.radius * 0.85,
    shoulderL: b.upperArmL.radius, elbowL: b.lowerArmL.radius, wristL: b.handL.radius,
    shoulderR: b.upperArmR.radius, elbowR: b.lowerArmR.radius, wristR: b.handR.radius,
    hipL: b.upperLegL.radius, kneeL: b.lowerLegL.radius, ankleL: b.footL.radius,
    hipR: b.upperLegR.radius, kneeR: b.lowerLegR.radius, ankleR: b.footR.radius,
  };
  const joints = {};
  const order = [];
  for (const [name, parent, kind, side] of SPEC) {
    if (parent && !joints[parent]) continue;
    const pivot = points[name] ?? tips[parent];
    const tip = tips[name];
    if (!pivot || !tip || hypot(sub(tip, pivot)) < 1) continue;
    const restVector = sub(tip, pivot);
    const parentPivot = parent ? joints[parent].pivot : pivot;
    order.push(name);
    joints[name] = {
      name, parent, kind, side, pivot, tip, restVector,
      offset: sub(pivot, parentPivot),
      length: hypot(restVector),
      swing: swingLimits(kind, side, restVector),
      twist: twistLimits(kind),
      radius: radiusOf[name] ?? 12,
    };
  }
  const angleMap = { ...MESH_ANGLE };
  const fingerSpecs = addFingers(joints, order, full.fingers, angleMap);
  const extraNames = ['spine1', 'spine2', 'spine3', 'neck', 'head', 'clavicleL', 'clavicleR', ...fingerSpecs];
  const extraBones = {};
  for (const name of extraNames) {
    const joint = joints[name];
    if (!joint) continue;
    extraBones[name] = segment(joint.pivot, joint.tip, joint.radius);
  }
  const meshParents = { spine1: null, hips: null };
  for (const name of order) {
    const joint = joints[name];
    if (!joint.parent) continue;
    const mapped = angleMap[name];
    const parentMapped = angleMap[joint.parent] ?? joint.parent;
    if (mapped) meshParents[mapped] = parentMapped;
  }
  const limbNames = [...new Set(Object.values(angleMap))];
  return {
    order, joints, extraBones, meshParents, limbNames, angleMap,
    headNames: ['neck', 'head'],
  };
}

function asPoint(value) {
  return Array.isArray(value) && value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]) ? value : null;
}

function addFingers(joints, order, fingers, angleMap) {
  const names = [];
  if (!fingers) return names;
  for (const side of ['L', 'R']) {
    const chain = fingers[side];
    if (!Array.isArray(chain) || chain.length < 2) continue;
    let parent = side === 'L' ? 'wristL' : 'wristR';
    if (!joints[parent]) continue;
    for (let i = 0; i < chain.length - 1; i++) {
      const name = `finger${side}${i}`;
      const pivot = i === 0 ? joints[parent].tip : asPoint(chain[i]);
      const tip = asPoint(chain[i + 1]);
      if (!pivot || !tip || hypot(sub(tip, pivot)) < 1) continue;
      const restVector = sub(tip, pivot);
      order.push(name);
      names.push(name);
      joints[name] = {
        name, parent, kind: 'finger', side, pivot, tip, restVector,
        offset: sub(pivot, joints[parent].pivot),
        length: hypot(restVector),
        swing: swingLimits('finger', side, restVector),
        twist: twistLimits('finger'),
        radius: 8,
      };
      angleMap[name] = name;
      parent = name;
    }
  }
  return names;
}

/** @param {Skeleton} skeleton @returns {Pose} */
export function restPose(skeleton) {
  /** @type {Record<string, JointPose>} */
  const joints = {};
  for (const name of skeleton.order) joints[name] = { swing: 0, twist: 0 };
  return { joints, drawOrder: {} };
}

function copyHands(hands) {
  if (!hands) return undefined;
  return { L: Number(hands.L) || 0, R: Number(hands.R) || 0 };
}

function copyTranslation(value) {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const x = Number(value[0]), y = Number(value[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return [x, y];
}

export function clonePose(pose) {
  const joints = {};
  for (const [name, value] of Object.entries(pose?.joints ?? {})) {
    joints[name] = { swing: value?.swing || 0, twist: value?.twist || 0 };
  }
  const next = { joints, drawOrder: { ...(pose?.drawOrder ?? {}) } };
  const hands = copyHands(pose?.hands);
  const translation = copyTranslation(pose?.translation);
  if (hands) next.hands = hands;
  if (translation) next.translation = translation;
  return next;
}

/** @param {Skeleton} skeleton @param {Pose} pose @returns {Pose} */
export function clampPose(skeleton, pose) {
  const next = restPose(skeleton);
  for (const name of skeleton.order) {
    const joint = skeleton.joints[name];
    const value = pose?.joints?.[name] ?? {};
    next.joints[name] = {
      swing: clamp(value.swing || 0, joint.swing.min, joint.swing.max),
      twist: clamp(value.twist || 0, joint.twist.min, joint.twist.max),
    };
  }
  next.drawOrder = { ...(pose?.drawOrder ?? {}) };
  const hands = copyHands(pose?.hands);
  const translation = copyTranslation(pose?.translation);
  if (hands) next.hands = hands;
  if (translation) next.translation = translation;
  return next;
}

/** World pivots and tips. A zero pose leaves every joint on its illustrated point.
 * @param {Skeleton} skeleton @param {Pose} pose
 * @returns {Record<string, { pivot: number[], tip: number[], angle: number, swing: number }>}
 */
export function forwardKinematics(skeleton, pose) {
  /** @type {Record<string, { pivot: number[], tip: number[], angle: number, swing: number }>} */
  const world = {};
  for (const name of skeleton.order) {
    const joint = skeleton.joints[name];
    const swing = pose.joints[name]?.swing || 0;
    const parent = joint.parent ? world[joint.parent] : null;
    const pivot = parent ? add(parent.pivot, rotateVec(joint.offset, parent.angle)) : joint.pivot.slice();
    const angle = (parent ? parent.angle : 0) + swing;
    const dir = rotateVec(joint.restVector, angle);
    world[name] = { pivot, tip: add(pivot, dir), angle, swing };
  }
  return world;
}

function chainOf(skeleton, effector, root) {
  const names = [];
  for (let name = effector; name; name = skeleton.joints[name]?.parent) {
    names.push(name);
    if (name === root) break;
  }
  return names;
}

function aim(from, toTip, toTarget) {
  const cross = toTip[0] * toTarget[1] - toTip[1] * toTarget[0];
  const dot = toTip[0] * toTarget[0] + toTip[1] * toTarget[1];
  return Math.atan2(cross, dot);
}

/** Cyclic coordinate descent. Each step clamps that joint's swing. */
export function solveCcd(skeleton, pose, goal, iterations = 14) {
  const spec = IK_CHAINS[goal.effector] ?? goal;
  const chain = chainOf(skeleton, spec.effector, spec.root ?? 'pelvis');
  const next = clampPose(skeleton, pose);
  const target = goal.target;
  for (let iter = 0; iter < iterations; iter++) {
    for (const name of chain) {
      const world = forwardKinematics(skeleton, next);
      const joint = world[name];
      const tip = world[spec.effector].tip;
      const toTip = sub(tip, joint.pivot);
      const toTarget = sub(target, joint.pivot);
      if (hypot(toTip) < 1 || hypot(toTarget) < 1) continue;
      const limits = skeleton.joints[name].swing;
      next.joints[name].swing = clamp(next.joints[name].swing + aim(joint.pivot, toTip, toTarget), limits.min, limits.max);
    }
  }
  return clampPose(skeleton, next);
}

/** FABRIK positions, then each bone is written back as a clamped swing so a hinge cannot fold past its limit. */
export function solveFabrik(skeleton, pose, goal, iterations = 8) {
  const spec = IK_CHAINS[goal.effector] ?? goal;
  const chain = chainOf(skeleton, spec.effector, spec.root ?? 'pelvis').reverse();
  let next = clampPose(skeleton, pose);
  const target = goal.target;
  for (let iter = 0; iter < iterations; iter++) {
    const world = forwardKinematics(skeleton, next);
    const points = chain.map(name => world[name].pivot.slice());
    points.push(world[spec.effector].tip.slice());
    const lengths = [];
    for (let i = 0; i < points.length - 1; i++) lengths.push(hypot(sub(points[i + 1], points[i])));
    const start = points[0].slice();
    points[points.length - 1] = target.slice();
    for (let i = points.length - 2; i >= 0; i--) {
      const dir = sub(points[i], points[i + 1]);
      const len = hypot(dir) || 1;
      points[i] = add(points[i + 1], [dir[0] / len * lengths[i], dir[1] / len * lengths[i]]);
    }
    points[0] = start;
    const rootParent = skeleton.joints[chain[0]]?.parent;
    let carried = rootParent && world[rootParent] ? world[rootParent].angle : 0;
    for (let i = 1; i < points.length; i++) {
      const dir = sub(points[i], points[i - 1]);
      const len = hypot(dir) || 1;
      points[i] = add(points[i - 1], [dir[0] / len * lengths[i - 1], dir[1] / len * lengths[i - 1]]);
    }
    for (let i = 0; i < chain.length; i++) {
      const name = chain[i];
      const aimed = sub(points[i + 1], points[i]);
      const restAimed = rotateVec(skeleton.joints[name].restVector, carried);
      const delta = signedBend(restAimed, aimed);
      const limits = skeleton.joints[name].swing;
      const swing = clamp(delta, limits.min, limits.max);
      next.joints[name].swing = swing;
      carried += swing;
    }
    next = clampPose(skeleton, next);
  }
  return next;
}

export function solveIk(skeleton, pose, goal) {
  const method = goal.method === 'fabrik' ? solveFabrik : solveCcd;
  return method(skeleton, pose, goal, goal.iterations);
}

function put(pose, name, swing, twist = 0) {
  pose.joints[name] = { swing, twist };
}

/** @param {Skeleton} skeleton @param {string} name @returns {Pose} */
export function posePreset(skeleton, name) {
  const pose = restPose(skeleton);
  if (name === 'stand') return pose;
  if (name === 'walk') {
    put(pose, 'shoulderL', 0.45); put(pose, 'elbowL', -0.35);
    put(pose, 'shoulderR', 0.15); put(pose, 'elbowR', 0.2);
    put(pose, 'hipL', -0.15); put(pose, 'kneeL', -0.2);
    put(pose, 'hipR', 0.35); put(pose, 'kneeR', 0.55);
  } else if (name === 'sit') {
    put(pose, 'hipL', -0.55); put(pose, 'kneeL', -1.15); put(pose, 'ankleL', 0.25);
    put(pose, 'hipR', 0.55); put(pose, 'kneeR', 1.15); put(pose, 'ankleR', -0.25);
    put(pose, 'spine1', 0.12); put(pose, 'spine2', 0.08);
  } else if (name === 'wave') {
    put(pose, 'shoulderL', 1.15); put(pose, 'elbowL', -0.9); put(pose, 'wristL', -0.3);
  } else if (name === 'handsOnHips') {
    put(pose, 'shoulderL', 0.65); put(pose, 'elbowL', -1.35);
    put(pose, 'shoulderR', -0.65); put(pose, 'elbowR', 1.35);
  } else if (name === 'armsCrossed') {
    put(pose, 'shoulderL', -0.45); put(pose, 'elbowL', -1.7);
    put(pose, 'shoulderR', 0.45); put(pose, 'elbowR', 1.7);
    pose.drawOrder = { upperArmL: 1, lowerArmL: 2, handL: 3, upperArmR: 0, lowerArmR: 1, handR: 2 };
  } else if (name === 'kneel') {
    put(pose, 'hipL', -0.4); put(pose, 'kneeL', -CLINICAL_DEG.knee.flexion * DEG); put(pose, 'ankleL', 0.3);
    put(pose, 'hipR', 0.25); put(pose, 'kneeR', 0.45);
    put(pose, 'spine1', 0.08);
  } else if (name === 'bow') {
    put(pose, 'pelvis', 0.18);
    put(pose, 'spine1', 0.28); put(pose, 'spine2', 0.28); put(pose, 'spine3', 0.22);
    put(pose, 'neck', -0.2); put(pose, 'shoulderL', 0.15); put(pose, 'shoulderR', -0.15);
  } else if (name === 'shrug') {
    put(pose, 'clavicleL', 0.55); put(pose, 'clavicleR', -0.55);
    put(pose, 'shoulderL', 0.25); put(pose, 'shoulderR', -0.25);
  } else if (name === 'lunge') {
    put(pose, 'hipL', 0.4); put(pose, 'kneeL', -0.35);
    put(pose, 'hipR', -0.35); put(pose, 'kneeR', 1.05); put(pose, 'ankleR', -0.2);
    put(pose, 'spine1', -0.08);
  } else {
    throw new Error(`Unknown pose preset: ${name}`);
  }
  return clampPose(skeleton, pose);
}

/** Bone angles the mesh solver consumes. Absent on a bust, and empty at the illustrated stance. */
export function meshAngles(skeleton, pose) {
  const clamped = clampPose(skeleton, pose);
  const angles = {};
  const twists = {};
  for (const [jointName, boneName] of Object.entries(skeleton.angleMap)) {
    const value = clamped.joints[jointName];
    if (!value) continue;
    angles[boneName] = (angles[boneName] || 0) + value.swing;
    if (value.twist) twists[boneName] = (twists[boneName] || 0) + value.twist;
  }
  return { angles, parents: skeleton.meshParents, twists, drawOrder: clamped.drawOrder, pose: clamped, translation: clamped.translation ?? null, hands: clamped.hands ?? null };
}

/** Slider ranges for the joints this skeleton actually built.
 * @param {Skeleton} skeleton
 * @returns {{ name: string, kind: string, side: string | null, swingMin: number, swingMax: number, twistMin: number, twistMax: number }[]}
 */
export function jointLimits(skeleton) {
  return skeleton.order.map(name => {
    const joint = skeleton.joints[name];
    return {
      name, kind: joint.kind, side: joint.side,
      swingMin: joint.swing.min, swingMax: joint.swing.max,
      twistMin: joint.twist.min, twistMax: joint.twist.max,
    };
  });
}

/** @param {Pose} pose @returns {{ format: 'mesh-avatar-pose', version: 1, joints: Record<string, JointPose>, drawOrder: Record<string, number> }} */
export function poseToJson(pose) {
  /** @type {Record<string, JointPose>} */
  const joints = {};
  for (const [name, value] of Object.entries(pose.joints)) {
    joints[name] = { swing: round(value.swing), twist: round(value.twist) };
  }
  const file = { format: 'mesh-avatar-pose', version: 1, joints, drawOrder: pose.drawOrder ?? {} };
  if (pose.translation) file.translation = pose.translation.map(round);
  if (pose.hands) file.hands = { L: round(pose.hands.L || 0), R: round(pose.hands.R || 0) };
  return file;
}

function round(value) {
  return Math.round((value || 0) * 1e6) / 1e6;
}

export function poseFromJson(skeleton, value) {
  if (!value || value.format !== 'mesh-avatar-pose' || value.version !== 1 || !value.joints) {
    throw new Error('pose JSON must be mesh-avatar-pose version 1');
  }
  return clampPose(skeleton, { joints: value.joints, drawOrder: value.drawOrder ?? {}, translation: value.translation, hands: value.hands });
}

function readPeople(input) {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input?.pose_keypoints_2d)) return input.pose_keypoints_2d;
  if (Array.isArray(input?.keypoints)) return input.keypoints.flat();
  const person = input?.people?.[0] ?? input?.person ?? null;
  if (Array.isArray(person?.pose_keypoints_2d)) return person.pose_keypoints_2d;
  if (Array.isArray(person?.keypoints)) return person.keypoints.flat();
  return null;
}

// OpenPose BODY_25 and COCO person-left is image-right on a camera-facing figure.
// Our L is image-left, so a camera-facing detection maps person-right onto L.
const OPENPOSE_25 = {
  nose: 0, neck: 1, Rsho: 2, Relb: 3, Rwri: 4, Lsho: 5, Lelb: 6, Lwri: 7, midhip: 8,
  Rhip: 9, Rkne: 10, Rank: 11, Lhip: 12, Lkne: 13, Lank: 14, Ltoe: 19, Lheel: 21, Rtoe: 22, Rheel: 24,
};
const COCO_17 = { nose: 0, Lsho: 5, Rsho: 6, Lelb: 7, Relb: 8, Lwri: 9, Rwri: 10, Lhip: 11, Rhip: 12, Lkne: 13, Rkne: 14, Lank: 15, Rank: 16 };
const MEDIAPIPE_33 = {
  nose: 0, Lsho: 11, Rsho: 12, Lelb: 13, Relb: 14, Lwri: 15, Rwri: 16,
  Lpinky: 17, Rpinky: 18, Lindex: 19, Rindex: 20,
  Lhip: 23, Rhip: 24, Lkne: 25, Rkne: 26, Lank: 27, Rank: 28, Lheel: 29, Rheel: 30, Ltoe: 31, Rtoe: 32,
};

function namedPoints(flat, table, step) {
  const triples = [];
  for (let i = 0; i < flat.length / step; i++) {
    const offset = i * step;
    triples.push({
      x: flat[offset], y: flat[offset + 1],
      z: step >= 4 ? flat[offset + 2] : 0,
      c: step >= 4 ? (flat[offset + 3] ?? 1) : (flat[offset + 2] ?? 1),
    });
  }
  const named = {};
  for (const [name, index] of Object.entries(table)) named[name] = triples[index] ?? null;
  return named;
}

function usable(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y) && (point.c ?? 1) >= 0.05;
}

function fingerCurl(points) {
  if (!Array.isArray(points) || points.length < 21) return null;
  const at = index => points[index];
  const bend = (a, b, c) => {
    const u = sub(b, a), v = sub(c, b);
    if (hypot(u) < 1e-6 || hypot(v) < 1e-6) return 0;
    return Math.abs(Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]));
  };
  const curls = [[5, 6, 7], [9, 10, 11], [13, 14, 15], [17, 18, 19]].map(([a, b, c]) => bend(at(a), at(b), at(c)));
  return clamp(curls.reduce((sum, value) => sum + value, 0) / curls.length / 1.35, 0, 1);
}

/**
 * @param {object} skeleton
 * @param {object | number[]} input OpenPose BODY_25, COCO-17, or MediaPipe pose rows
 * @param {{ facing?: 'camera' | 'same', format?: 'mediapipe' | 'openpose' | 'coco', previous?: Pose, smoothing?: number, dt?: number, hands?: { side?: string, landmarks?: number[][] }[] }} [options]
 * camera maps a front-facing person's right to image-left. `previous` keeps a joint whose
 * confidence is below 0.05. `smoothing` blends toward that pose (0 snaps, 1 is slowest).
 */
export function poseFromKeypoints(skeleton, input, options = {}) {
  const flat = readPeople(input);
  if (!flat) throw new Error('keypoints JSON needs pose_keypoints_2d or keypoints');
  const mediapipe = options.format === 'mediapipe' || (flat.length % 4 === 0 && flat.length / 4 === 33);
  const count = mediapipe ? flat.length / 4 : flat.length / 3;
  const table = mediapipe ? MEDIAPIPE_33 : count >= 25 ? OPENPOSE_25 : COCO_17;
  if (!mediapipe && count < 17) throw new Error('keypoints need COCO-17 or OpenPose BODY_25');
  if (mediapipe && count < 33) throw new Error('MediaPipe pose needs 33 landmarks');
  const named = namedPoints(flat, table, mediapipe ? 4 : 3);
  const camera = (options.facing ?? 'camera') === 'camera';
  const our = side => camera ? (side === 'L' ? 'R' : 'L') : side;
  const pose = restPose(skeleton);
  const seen = new Set();
  const setLimb = (joint, parentJoint, parentName, jointName, childName, hinge) => {
    const parent = named[parentName], at = named[jointName], child = named[childName];
    if (!usable(at) || !usable(child) || !skeleton.joints[joint]) return false;
    if (hinge) {
      if (!usable(parent) || !skeleton.joints[parentJoint]) return false;
      const bend = signedBend(sub([at.x, at.y], [parent.x, parent.y]), sub([child.x, child.y], [at.x, at.y]));
      const illustrated = signedBend(skeleton.joints[parentJoint].restVector, skeleton.joints[joint].restVector);
      pose.joints[joint].swing = bend - illustrated;
      seen.add(joint);
      return true;
    }
    const rest = skeleton.joints[joint].restVector;
    pose.joints[joint].swing = fromDown(sub([child.x, child.y], [at.x, at.y])) - fromDown(rest);
    seen.add(joint);
    return true;
  };
  const neck = usable(named.neck) ? named.neck : (usable(named.Lsho) && usable(named.Rsho) ? {
    x: (named.Lsho.x + named.Rsho.x) / 2, y: (named.Lsho.y + named.Rsho.y) / 2, c: Math.min(named.Lsho.c, named.Rsho.c), z: 0,
  } : null);
  for (const side of ['L', 'R']) {
    const person = our(side);
    setLimb(`shoulder${side}`, null, null, `${person}sho`, `${person}elb`, false);
    setLimb(`elbow${side}`, `shoulder${side}`, `${person}sho`, `${person}elb`, `${person}wri`, true);
    const handPoint = usable(named[`${person}index`]) ? `${person}index` : usable(named[`${person}pinky`]) ? `${person}pinky` : null;
    if (handPoint) setLimb(`wrist${side}`, `elbow${side}`, `${person}elb`, `${person}wri`, handPoint, true);
    setLimb(`hip${side}`, null, null, `${person}hip`, `${person}kne`, false);
    setLimb(`knee${side}`, `hip${side}`, `${person}hip`, `${person}kne`, `${person}ank`, true);
    const footPoint = usable(named[`${person}toe`]) ? `${person}toe` : usable(named[`${person}heel`]) ? `${person}heel` : null;
    if (footPoint) setLimb(`ankle${side}`, `knee${side}`, `${person}kne`, `${person}ank`, footPoint, true);
    if (neck && skeleton.joints[`clavicle${side}`] && usable(named[`${person}sho`])) {
      const shoulder = named[`${person}sho`];
      pose.joints[`clavicle${side}`].swing = fromDown(sub([shoulder.x, shoulder.y], [neck.x, neck.y])) - fromDown(skeleton.joints[`clavicle${side}`].restVector);
      seen.add(`clavicle${side}`);
    }
    const wrist = named[`${person}wri`], shoulder = named[`${person}sho`];
    if (usable(wrist) && usable(shoulder) && Number.isFinite(wrist.z) && Number.isFinite(shoulder.z) && mediapipe) {
      const delta = wrist.z - shoulder.z;
      if (delta < -0.03) {
        pose.drawOrder[`upperArm${side}`] = 2;
        pose.drawOrder[`lowerArm${side}`] = 3;
        pose.drawOrder[`hand${side}`] = 4;
      } else if (delta > 0.03) {
        pose.drawOrder[`upperArm${side}`] = -2;
        pose.drawOrder[`lowerArm${side}`] = -2;
        pose.drawOrder[`hand${side}`] = -2;
      }
    }
  }
  if (usable(named.neck) && usable(named.nose) && skeleton.joints.neck) {
    pose.joints.neck.swing = fromDown(sub([named.nose.x, named.nose.y], [named.neck.x, named.neck.y])) - fromDown(skeleton.joints.neck.restVector);
    seen.add('neck');
  }
  const hip = usable(named.midhip) ? named.midhip : (usable(named.Lhip) && usable(named.Rhip) ? {
    x: (named.Lhip.x + named.Rhip.x) / 2, y: (named.Lhip.y + named.Rhip.y) / 2, c: 1,
  } : null);
  const shoulders = usable(named.Lsho) && usable(named.Rsho) ? {
    x: (named.Lsho.x + named.Rsho.x) / 2, y: (named.Lsho.y + named.Rsho.y) / 2,
  } : null;
  if (hip && shoulders && skeleton.joints.spine1) {
    const lower = fromDown(sub([shoulders.x, shoulders.y], [hip.x, hip.y])) - fromDown(skeleton.joints.spine1.restVector);
    pose.joints.spine1.swing = lower * 0.45;
    seen.add('spine1');
    if (skeleton.joints.spine2) { pose.joints.spine2.swing = lower * 0.35; seen.add('spine2'); }
    if (skeleton.joints.pelvis) { pose.joints.pelvis.swing = lower * 0.2; seen.add('pelvis'); }
    if (skeleton.joints.spine3) {
      const upper = usable(named.nose)
        ? fromDown(sub([named.nose.x, named.nose.y], [shoulders.x, shoulders.y])) - fromDown(skeleton.joints.spine3.restVector)
        : lower;
      pose.joints.spine3.swing = usable(named.nose) ? upper - lower : lower * 0.2;
      seen.add('spine3');
    }
  }
  if (usable(named.Lsho) && usable(named.Rsho) && skeleton.joints.shoulderL && skeleton.joints.shoulderR) {
    const observed = Math.hypot(named.Lsho.x - named.Rsho.x, named.Lsho.y - named.Rsho.y);
    const rig = Math.hypot(
      skeleton.joints.shoulderL.pivot[0] - skeleton.joints.shoulderR.pivot[0],
      skeleton.joints.shoulderL.pivot[1] - skeleton.joints.shoulderR.pivot[1],
    );
    const scale = observed > 1e-4 && rig > 1 ? rig / observed : 1;
    for (const side of ['L', 'R']) {
      const person = our(side);
      // Twist is written on the joint that can spin. The measured length is that
      // segment: the forearm is the elbow bone, but an elbow cannot twist.
      const segments = [
        ['shoulder', `shoulder${side}`, `${person}sho`, `${person}elb`],
        ['elbow', `wrist${side}`, `${person}elb`, `${person}wri`],
        ['hip', `hip${side}`, `${person}hip`, `${person}kne`],
        ['knee', `ankle${side}`, `${person}kne`, `${person}ank`],
      ];
      for (const [measured, jointName, fromName, toName] of segments) {
        const bone = skeleton.joints[`${measured}${side}`];
        const joint = skeleton.joints[jointName];
        const from = named[fromName], to = named[toName];
        if (!bone || !joint || !usable(from) || !usable(to) || joint.twist.max === 0) continue;
        const length = Math.hypot(to.x - from.x, to.y - from.y);
        const expected = bone.length / scale;
        if (expected < 1 || length < 1) continue;
        const ratio = length / expected;
        if (ratio >= 0.92) continue;
        const sign = (to.z ?? 0) <= (from.z ?? 0) ? 1 : -1;
        pose.joints[jointName].twist = Math.acos(clamp(ratio, 0.35, 1)) * sign;
      }
    }
  }
  const hands = options.hands ?? input?.hands;
  if (Array.isArray(hands)) {
    pose.hands = { L: 0, R: 0 };
    for (const hand of hands) {
      const person = hand?.side === 'Right' ? 'R' : hand?.side === 'Left' ? 'L' : null;
      if (!person) continue;
      const side = camera ? (person === 'L' ? 'R' : 'L') : person;
      const curl = fingerCurl(hand.landmarks);
      if (curl === null) continue;
      pose.hands[side] = curl;
      const flex = CLINICAL_DEG.finger.flexion * DEG;
      const swing = side === 'R' ? curl * flex : -curl * flex;
      for (const name of skeleton.order) {
        if (!name.startsWith(`finger${side}`)) continue;
        pose.joints[name].swing = swing;
        seen.add(name);
      }
    }
  }
  if (options.previous?.joints) {
    for (const name of skeleton.order) {
      if (seen.has(name)) continue;
      const prior = options.previous.joints[name];
      if (!prior) continue;
      pose.joints[name].swing = prior.swing || 0;
      pose.joints[name].twist = prior.twist || 0;
    }
    if (!pose.hands && options.previous.hands) pose.hands = copyHands(options.previous.hands);
  }
  if (options.previous?.joints && options.smoothing > 0) {
    const tau = Math.max(0.04, options.smoothing * 0.18);
    const alpha = options.dt > 0 ? 1 - Math.exp(-options.dt / tau) : 1;
    for (const name of skeleton.order) {
      const prior = options.previous.joints[name];
      if (!prior) continue;
      pose.joints[name].swing = prior.swing + (pose.joints[name].swing - prior.swing) * alpha;
      pose.joints[name].twist = prior.twist + (pose.joints[name].twist - prior.twist) * alpha;
    }
  }
  return clampPose(skeleton, pose);
}

/**
 * Retarget one observation and remember it. Low-confidence joints keep the remembered
 * swing, then the result is smoothed. `state` is owned by the caller.
 * @param {Skeleton} skeleton
 * @param {object | number[]} input
 * @param {{ pose?: Pose }} state
 * @param {{ facing?: 'camera' | 'same', format?: string, smoothing?: number, dt?: number, hands?: object[] }} [options]
 */
function observationHip(input, options) {
  const flat = readPeople(input);
  if (!flat) return null;
  const mediapipe = options.format === 'mediapipe' || (flat.length % 4 === 0 && flat.length / 4 === 33);
  const count = mediapipe ? flat.length / 4 : flat.length / 3;
  if (!mediapipe && count < 17) return null;
  const table = mediapipe ? MEDIAPIPE_33 : count >= 25 ? OPENPOSE_25 : COCO_17;
  const named = namedPoints(flat, table, mediapipe ? 4 : 3);
  if (!usable(named.Lhip) || !usable(named.Rhip)) return null;
  const span = usable(named.Lsho) && usable(named.Rsho)
    ? Math.hypot(named.Lsho.x - named.Rsho.x, named.Lsho.y - named.Rsho.y) : 0;
  return { x: (named.Lhip.x + named.Rhip.x) / 2, y: (named.Lhip.y + named.Rhip.y) / 2, span };
}

/** Keep a planted foot from sliding or sinking, and carry hip travel as a body translation.
 * @param {Skeleton} skeleton @param {Pose} pose @param {{ groundY?: number, locks?: Record<string, number[] | null> }} [state]
 */
export function plantFeet(skeleton, pose, state = {}) {
  const clamped = clampPose(skeleton, pose);
  clamped.translation = copyTranslation(clamped.translation) ?? [0, 0];
  const ground = state.groundY ?? Math.max(skeleton.joints.ankleL?.tip?.[1] ?? 0, skeleton.joints.ankleR?.tip?.[1] ?? 0);
  state.groundY = ground;
  const locks = state.locks ?? (state.locks = { L: null, R: null });
  let world = forwardKinematics(skeleton, clamped);
  const tx = clamped.translation[0], ty = clamped.translation[1];
  let stance = null;
  for (const side of ['L', 'R']) {
    const tip = world[`ankle${side}`]?.tip;
    if (!tip) continue;
    const drawnX = tip[0] + tx, drawnY = tip[1] + ty;
    if (drawnY < ground - 12) { locks[side] = null; continue; }
    if (!locks[side]) locks[side] = [drawnX, Math.min(drawnY, ground)];
    if (!stance || drawnY > stance.drawnY) stance = { side, drawnY, tip };
  }
  if (stance && locks[stance.side]) {
    const lock = locks[stance.side];
    const target = [lock[0] - tx, lock[1] - ty];
    if (Math.hypot(stance.tip[0] - target[0], stance.tip[1] - target[1]) > 1.5) {
      const solved = solveIk(skeleton, clamped, { effector: `foot${stance.side}`, target, iterations: 8 });
      clamped.joints = solved.joints;
      clamped.drawOrder = solved.drawOrder;
      if (solved.hands) clamped.hands = solved.hands;
      clamped.translation = copyTranslation(solved.translation) ?? clamped.translation;
    }
  }
  world = forwardKinematics(skeleton, clamped);
  let sink = 0;
  for (const side of ['L', 'R']) {
    const tip = world[`ankle${side}`]?.tip;
    if (tip) sink = Math.max(sink, tip[1] + clamped.translation[1] - ground);
  }
  if (sink > 0.5) clamped.translation[1] -= sink;
  return clamped;
}

export function trackSkeleton(skeleton, input, state, options = {}) {
  const pose = poseFromKeypoints(skeleton, input, {
    ...options,
    previous: state?.pose ?? null,
    hands: options.hands ?? input?.hands,
  });
  const hip = observationHip(input, options);
  if (hip && skeleton.joints.shoulderL && skeleton.joints.shoulderR) {
    if (state && !state.hipHome) state.hipHome = { x: hip.x, y: hip.y };
    const home = state?.hipHome ?? hip;
    const rigSpan = Math.hypot(
      skeleton.joints.shoulderL.pivot[0] - skeleton.joints.shoulderR.pivot[0],
      skeleton.joints.shoulderL.pivot[1] - skeleton.joints.shoulderR.pivot[1],
    ) || 1;
    const px = hip.span > 1e-4 ? rigSpan / hip.span : 1;
    const limit = rigSpan * 0.45;
    pose.translation = [
      clamp((hip.x - home.x) * px, -limit, limit),
      clamp((hip.y - home.y) * px * 0.35, -limit * 0.35, limit * 0.35),
    ];
  }
  if (options.ground === false) {
    if (state) state.pose = pose;
    return pose;
  }
  const planted = plantFeet(skeleton, pose, state?.feet ?? (state ? (state.feet = {}) : {}));
  if (state) state.pose = planted;
  return planted;
}

/** Wedges of illustration that a large swing uncovers. Callers may paint them; the mesh does not invent texture.
 * @param {Skeleton} skeleton @param {Pose} pose
 * @returns {{ joint: string, swing: number, polygon: [number, number][] }[]}
 */
export function uncoveredWedges(skeleton, pose) {
  const clamped = clampPose(skeleton, pose);
  const world = forwardKinematics(skeleton, clamped);
  const wedges = [];
  for (const name of skeleton.order) {
    const swing = clamped.joints[name].swing;
    if (Math.abs(swing) < 0.35) continue;
    const joint = skeleton.joints[name];
    const restTip = add(world[name].pivot, rotateVec(joint.restVector, world[name].angle - swing));
    const posedTip = world[name].tip;
    const reach = Math.min(joint.length, joint.radius * 1.4);
    const unit = v => { const len = hypot(v) || 1; return [v[0] / len * reach, v[1] / len * reach]; };
    /** @param {number[]} point @returns {[number, number]} */
    const pair = point => [point[0], point[1]];
    wedges.push({
      joint: name,
      swing,
      polygon: [pair(world[name].pivot), pair(add(world[name].pivot, unit(sub(restTip, world[name].pivot)))), pair(add(world[name].pivot, unit(sub(posedTip, world[name].pivot))))],
    });
  }
  return wedges;
}

/** Stable triangle order. Equal depth keeps the original order, so an empty draw order is a no-op. */
export function orderTriangles(tris, vertexBone, depth) {
  const count = tris.length / 3;
  const items = new Array(count);
  for (let i = 0; i < count; i++) {
    const a = tris[i * 3], b = tris[i * 3 + 1], c = tris[i * 3 + 2];
    const da = depth[vertexBone[a]] ?? 0, db = depth[vertexBone[b]] ?? 0, dc = depth[vertexBone[c]] ?? 0;
    items[i] = { i, d: Math.max(da, db, dc) };
  }
  items.sort((p, q) => p.d - q.d || p.i - q.i);
  const out = new Uint32Array(tris.length);
  for (let k = 0; k < count; k++) {
    const source = items[k].i * 3;
    out[k * 3] = tris[source];
    out[k * 3 + 1] = tris[source + 1];
    out[k * 3 + 2] = tris[source + 2];
  }
  return out;
}
