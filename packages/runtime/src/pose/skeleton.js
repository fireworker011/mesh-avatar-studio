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
 * @typedef {{ joints: Record<string, JointPose>, drawOrder: Record<string, number> }} Pose
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

export function clonePose(pose) {
  const joints = {};
  for (const [name, value] of Object.entries(pose?.joints ?? {})) {
    joints[name] = { swing: value?.swing || 0, twist: value?.twist || 0 };
  }
  return { joints, drawOrder: { ...(pose?.drawOrder ?? {}) } };
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
  return { angles, parents: skeleton.meshParents, twists, drawOrder: clamped.drawOrder, pose: clamped };
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
  return { format: 'mesh-avatar-pose', version: 1, joints, drawOrder: pose.drawOrder ?? {} };
}

function round(value) {
  return Math.round((value || 0) * 1e6) / 1e6;
}

export function poseFromJson(skeleton, value) {
  if (!value || value.format !== 'mesh-avatar-pose' || value.version !== 1 || !value.joints) {
    throw new Error('pose JSON must be mesh-avatar-pose version 1');
  }
  return clampPose(skeleton, { joints: value.joints, drawOrder: value.drawOrder ?? {} });
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
const OPENPOSE_25 = { neck: 1, Rsho: 2, Relb: 3, Rwri: 4, Lsho: 5, Lelb: 6, Lwri: 7, midhip: 8, Rhip: 9, Rkne: 10, Rank: 11, Lhip: 12, Lkne: 13, Lank: 14, nose: 0 };
const COCO_17 = { nose: 0, Lsho: 5, Rsho: 6, Lelb: 7, Relb: 8, Lwri: 9, Rwri: 10, Lhip: 11, Rhip: 12, Lkne: 13, Rkne: 14, Lank: 15, Rank: 16 };

function namedPoints(flat, table) {
  const triples = [];
  for (let i = 0; i + 2 < flat.length; i += 3) triples.push({ x: flat[i], y: flat[i + 1], c: flat[i + 2] ?? 1 });
  const named = {};
  for (const [name, index] of Object.entries(table)) named[name] = triples[index] ?? null;
  return named;
}

function usable(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y) && (point.c ?? 1) >= 0.05;
}

/**
 * @param {object} skeleton
 * @param {object | number[]} input OpenPose BODY_25 or COCO-17 keypoints
 * @param {{ facing?: 'camera' | 'same' }} [options] camera maps a front-facing person's right to image-left
 */
export function poseFromKeypoints(skeleton, input, options = {}) {
  const flat = readPeople(input);
  if (!flat) throw new Error('keypoints JSON needs pose_keypoints_2d or keypoints');
  const count = flat.length / 3;
  const table = count >= 25 ? OPENPOSE_25 : COCO_17;
  if (count < 17) throw new Error('keypoints need COCO-17 or OpenPose BODY_25');
  const named = namedPoints(flat, table);
  const camera = (options.facing ?? 'camera') === 'camera';
  const our = side => camera ? (side === 'L' ? 'R' : 'L') : side;
  const pose = restPose(skeleton);
  const setLimb = (joint, parentJoint, parentName, jointName, childName, hinge) => {
    const parent = named[parentName], at = named[jointName], child = named[childName];
    if (!usable(at) || !usable(child) || !skeleton.joints[joint]) return;
    if (hinge) {
      if (!usable(parent) || !skeleton.joints[parentJoint]) return;
      const bend = signedBend(sub([at.x, at.y], [parent.x, parent.y]), sub([child.x, child.y], [at.x, at.y]));
      const illustrated = signedBend(skeleton.joints[parentJoint].restVector, skeleton.joints[joint].restVector);
      pose.joints[joint].swing = bend - illustrated;
      return;
    }
    const rest = skeleton.joints[joint].restVector;
    pose.joints[joint].swing = fromDown(sub([child.x, child.y], [at.x, at.y])) - fromDown(rest);
  };
  for (const side of ['L', 'R']) {
    const person = our(side);
    setLimb(`shoulder${side}`, null, null, `${person}sho`, `${person}elb`, false);
    setLimb(`elbow${side}`, `shoulder${side}`, `${person}sho`, `${person}elb`, `${person}wri`, true);
    setLimb(`hip${side}`, null, null, `${person}hip`, `${person}kne`, false);
    setLimb(`knee${side}`, `hip${side}`, `${person}hip`, `${person}kne`, `${person}ank`, true);
  }
  if (usable(named.neck) && usable(named.nose) && skeleton.joints.neck) {
    pose.joints.neck.swing = fromDown(sub([named.nose.x, named.nose.y], [named.neck.x, named.neck.y])) - fromDown(skeleton.joints.neck.restVector);
  }
  return clampPose(skeleton, pose);
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
