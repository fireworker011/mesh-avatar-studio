import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import fixture from '../samples/miko-qipao/rig.json';
import { PARAMS, parseRig, validateRig, type LimbBone, type Rig } from 'mesh-avatar';
import { createRig } from '../packages/runtime/src/engine/rig.js';
import { createPhysics } from '../packages/runtime/src/engine/physics.js';
import { Motion } from '../packages/runtime/src/engine/motion.js';
import { faceDensity } from '../packages/runtime/src/engine/renderer.js';

function defaults() {
  return Object.fromEntries(PARAMS.map(parameter => [parameter.id, parameter.def]));
}

function segment(pivot: [number, number], tip: [number, number], radius: number, maxBend: number): LimbBone {
  return { pivot, tip, radius, maxBend };
}
function limb(): NonNullable<Rig['fullBody']> {
  const idle = segment([20, 20], [22, 20], 1, 0);
  return {
    sway: 0.2, armFollow: 0.5,
    bones: {
      torso: idle, hips: { ...idle },
      upperArmL: segment([200, 900], [200, 1100], 40, 0.8),
      lowerArmL: segment([200, 1100], [200, 1250], 36, 0.5),
      handL: { ...idle }, upperArmR: { ...idle }, lowerArmR: { ...idle }, handR: { ...idle },
      upperLegL: { ...idle }, lowerLegL: { ...idle }, footL: { ...idle },
      upperLegR: { ...idle }, lowerLegR: { ...idle }, footR: { ...idle },
    },
  };
}

test('a bust rig ignores limb pose and matches a zero-angle full-body rig', () => {
  const bust = parseRig(fixture);
  const standing = parseRig(fixture);
  standing.fullBody = limb();
  expect(validateRig(standing)).toEqual([]);
  const plain = createRig(bust);
  const posed = createRig(standing);
  const parameters = defaults();
  const rest = { gain: 1, bunL: [0, 0], bunR: [0, 0], strands: [], limbs: {} };
  for (const [x, y] of [[615, 400], [200, 1180], [640, 1100], [20, 20]]) {
    const weights = posed.baseWeights(x, y);
    const left = plain.deformBase(x, y, plain.baseWeights(x, y), parameters, rest, [0, 0]);
    const right = posed.deformBase(x, y, weights, parameters, rest, [0, 0]);
    expect(left[0]).toBeCloseTo(right[0], 8);
    expect(left[1]).toBeCloseTo(right[1], 8);
  }
  parameters.armL = 1;
  const head = posed.deformBase(615, 400, posed.baseWeights(615, 400), parameters, rest, [0, 0]);
  const still = plain.deformBase(615, 400, plain.baseWeights(615, 400), parameters, rest, [0, 0]);
  expect(head[0]).toBeCloseTo(still[0], 8);
  expect(head[1]).toBeCloseTo(still[1], 8);
  const forearm = posed.deformBase(200, 1180, posed.baseWeights(200, 1180), parameters, rest, [0, 0]);
  const forearmRest = posed.deformBase(200, 1180, posed.baseWeights(200, 1180), defaults(), rest, [0, 0]);
  expect(Math.hypot(forearm[0] - forearmRest[0], forearm[1] - forearmRest[1])).toBeGreaterThan(5);
});

test('limb springs stay finite and are absent from a bust step', () => {
  const bust = parseRig(fixture);
  const standing = parseRig(fixture);
  standing.fullBody = limb();
  const engine = createRig(standing);
  const posed = new (createPhysics(engine, standing).Physics)();
  const plain = new (createPhysics(createRig(bust), bust).Physics)();
  const parameters = defaults();
  parameters.bodyAngleZ = 8;
  const withLimbs = posed.step(parameters, 1 / 60) as { limbs?: Record<string, number> };
  const without = plain.step(parameters, 1 / 60) as { limbs?: Record<string, number> };
  expect(without.limbs).toBeUndefined();
  expect(withLimbs.limbs).toBeTruthy();
  expect(Object.values(withLimbs.limbs ?? {}).every(value => Number.isFinite(value))).toBe(true);
  const point = engine.deformBase(200, 1180, engine.baseWeights(200, 1180), parameters, withLimbs, [0, 0]);
  expect(point.every(Number.isFinite)).toBe(true);
});

test('an extreme elbow bend keeps the forearm rigid and the hinge from collapsing', () => {
  const standing = parseRig(fixture);
  standing.fullBody = limb();
  standing.fullBody.bones.lowerArmL.maxBend = Math.PI / 2;
  const engine = createRig(standing);
  const rest = { gain: 1, bunL: [0, 0] as [number, number], bunR: [0, 0] as [number, number], strands: [] as [] };
  const straight = defaults();
  const bent = defaults();
  bent.forearmL = 1;
  const pose = (point: [number, number], parameters: ReturnType<typeof defaults>) =>
    engine.deformBase(point[0], point[1], engine.baseWeights(point[0], point[1]), parameters, rest, [0, 0]);
  const elbow: [number, number] = [200, 1100];
  const tip: [number, number] = [200, 1250];
  const near: [number, number] = [200, 1108];
  const tipRest = pose(tip, straight);
  const tipBent = pose(tip, bent);
  const restLength = Math.hypot(tipRest[0] - elbow[0], tipRest[1] - elbow[1]);
  const bentLength = Math.hypot(tipBent[0] - elbow[0], tipBent[1] - elbow[1]);
  expect(Math.hypot(tipBent[0] - tipRest[0], tipBent[1] - tipRest[1])).toBeGreaterThan(20);
  expect(Math.abs(bentLength - restLength)).toBeLessThan(1);
  const nearRest = pose(near, straight);
  const nearBent = pose(near, bent);
  const nearRestLength = Math.hypot(nearRest[0] - elbow[0], nearRest[1] - elbow[1]);
  const nearBentLength = Math.hypot(nearBent[0] - elbow[0], nearBent[1] - elbow[1]);
  expect(nearBentLength).toBeGreaterThan(nearRestLength * 0.75);
});

test('hair and tassel anchors follow the torso only when fullBody is set', () => {
  const bust = parseRig(fixture);
  const standing = parseRig(fixture);
  standing.fullBody = limb();
  standing.fullBody.bones.torso = segment([640, 1200], [640, 800], 180, 0.8);
  const at: [number, number] = [640, 1000];
  bust.accessories![0].pivot = at;
  standing.accessories![0].pivot = at;
  const bustEngine = createRig(bust);
  const engine = createRig(standing);
  const physics = new (createPhysics(engine, standing).Physics)();
  const bustPhysics = new (createPhysics(bustEngine, bust).Physics)();
  const rest = defaults();
  const bent = defaults();
  bent.torsoBend = 1;
  const still = physics.hairAnchor(at, rest);
  const moved = physics.hairAnchor(at, bent);
  expect(Math.hypot(moved[0] - still[0], moved[1] - still[1])).toBeGreaterThan(5);
  const bustStill = bustPhysics.hairAnchor(at, rest);
  const bustBent = bustPhysics.hairAnchor(at, bent);
  expect(bustBent[0]).toBe(bustStill[0]);
  expect(bustBent[1]).toBe(bustStill[1]);
  const phys = { gain: 1, bunL: [0, 0] as [number, number], bunR: [0, 0] as [number, number], strands: [] as [] };
  const tassel = standing.accessories![0];
  const hung = engine.tasselAnchor(tassel, rest, phys, [0, 0]);
  const swung = engine.tasselAnchor(tassel, bent, phys, [0, 0]);
  expect(Math.hypot(swung[0] - hung[0], swung[1] - hung[1])).toBeGreaterThan(5);
  const bustTassel = bust.accessories![0];
  const bustHung = bustEngine.tasselAnchor(bustTassel, rest, phys, [0, 0]);
  const bustSwung = bustEngine.tasselAnchor(bustTassel, bent, phys, [0, 0]);
  expect(bustSwung[0]).toBe(bustHung[0]);
  expect(bustSwung[1]).toBe(bustHung[1]);
});

test('idle sway drives the arms only for a full-body motion', () => {
  const quiet = new Motion([0, 0], {});
  quiet.autoMotion = false;
  quiet.autoIdle = false;
  const moving = new Motion([0, 0], { fullBody: true, sway: 1 });
  moving.autoMotion = false;
  moving.autoIdle = false;
  for (let i = 0; i < 90; i++) {
    quiet.update(1 / 30);
    moving.update(1 / 30);
  }
  const still = (quiet.cur as Record<string, number>).armL;
  const swung = (moving.cur as Record<string, number>).armL;
  expect(still).toBe(0);
  expect(Math.abs(swung)).toBeGreaterThan(0.05);
});

test('face deformation is the same with or without limbs', () => {
  const bust = parseRig(fixture);
  const standing = parseRig(fixture);
  standing.fullBody = limb();
  const plain = createRig(bust);
  const posed = createRig(standing);
  const rest = { gain: 1, bunL: [0, 0] as [number, number], bunR: [0, 0] as [number, number], strands: [] as [] };
  const poses = [
    { ...defaults(), angleX: 30, angleY: 20, angleZ: 15 },
    { ...defaults(), browY: 1, browAngle: 1 },
    { ...defaults(), mouthOpen: 1, mouthForm: 0.8, blush: 1 },
    { ...defaults(), breath: 1, bodyAngleZ: 8 },
  ];
  for (const parameters of poses) {
    for (const point of [[493, 478], [635, 568], [615, 400], [446, 470]] as [number, number][]) {
      const left = plain.deformBase(point[0], point[1], plain.baseWeights(point[0], point[1]), parameters, rest, [0, 0]);
      const right = posed.deformBase(point[0], point[1], posed.baseWeights(point[0], point[1]), parameters, rest, [0, 0]);
      expect(left[0]).toBeCloseTo(right[0], 6);
      expect(left[1]).toBeCloseTo(right[1], 6);
    }
  }
  const eye = bust.eyes[0];
  const open = plain.eyePartY(eye, 'lash', 490, 450, 1, 0);
  const shut = plain.eyePartY(eye, 'lash', 490, 450, 0, 0);
  expect(Math.abs(shut - open)).toBeGreaterThan(2);
  expect(posed.eyePartY(eye, 'lash', 490, 450, 0, 1)).toBe(plain.eyePartY(eye, 'lash', 490, 450, 0, 1));
});

test('a small full-body face is meshed about as finely as a bust eye', () => {
  const bust = parseRig(fixture);
  expect(faceDensity(bust)).toMatchObject({ region: null, scale: 1, eyeCell: bust.mesh.eyeCell, ballCell: bust.mesh.eyeBallCell, spriteCell: bust.mesh.spriteCell });
  const withLimbs = parseRig(fixture);
  withLimbs.fullBody = limb();
  expect(faceDensity(withLimbs).region).toBeNull();
  expect(faceDensity(withLimbs).scale).toBe(1);
  const photo = JSON.parse(readFileSync(new URL('../samples/full-body-photo/rig.json', import.meta.url), 'utf8')) as Rig;
  const density = faceDensity(photo);
  const eye = photo.eyes[0].opening.map(point => point[0]);
  const span = Math.max(...eye) - Math.min(...eye);
  expect(density.region).toBeTruthy();
  expect(span / density.region!.cell).toBeGreaterThan(12);
  expect(span / density.eyeCell).toBeGreaterThan(28);
  expect(span / density.ballCell).toBeGreaterThan(20);
  expect(density.eyeCell).toBeLessThan(photo.mesh.eyeCell);
  expect(density.scale).toBeGreaterThan(0.1);
  expect(density.scale).toBeLessThan(0.3);
  const posed = createRig(photo);
  const rest = { gain: 0, bunL: [0, 0] as [number, number], bunR: [0, 0] as [number, number], strands: [] as [] };
  const at = photo.face.brow;
  const weights = posed.baseWeights(at.cx, at.cy, 0);
  const moved = posed.deformBase(at.cx, at.cy, weights, { ...defaults(), browY: 1 }, rest, [0, 0]);
  const lift = at.cy - moved[1];
  expect(lift).toBeCloseTo(7 * density.scale * weights.brow, 5);
  expect(lift).toBeLessThan(2);
});

test('the full-body sample rig is valid', () => {
  const rig = JSON.parse(readFileSync(new URL('../samples/full-body/rig.json', import.meta.url), 'utf8')) as Rig;
  expect(validateRig(rig)).toEqual([]);
  expect(rig.fullBody?.bones.footL.tip[1]).toBeGreaterThan(rig.fullBody!.bones.upperLegL.pivot[1]);
  expect(rig.image.height).toBeGreaterThan(rig.image.width * 1.5);
});

// Drawn-lip centres measured on each source image (the dark lip stroke, not the
// nose shadow above it or the chin shadow below it). Bow bends the painted line
// downward, and the open interior hangs a few pixels below that line, so the
// bowed centre has to sit on the ink. The chin point is on the outline below the jaw.
const FULL_BODY_LIPS = [
  { folder: 'full-body-vest', lip: [424, 283], chin: [430, 336] },
  { folder: 'full-body', lip: [270, 133], chin: [270, 156] },
  { folder: 'full-body-photo', lip: [148.5, 131], chin: [148.5, 155] },
  { folder: 'full-body-coat', lip: [350, 169], chin: [360, 248] },
] as const;

test('full-body talking mouths sit on the drawn lips and leave the chin outline', () => {
  const rest = { gain: 0, bunL: [0, 0] as [number, number], bunR: [0, 0] as [number, number], strands: [] as [] };
  for (const sample of FULL_BODY_LIPS) {
    const rig = JSON.parse(readFileSync(new URL(`../samples/${sample.folder}/rig.json`, import.meta.url), 'utf8')) as Rig;
    expect(validateRig(rig), sample.folder).toEqual([]);
    const mouth = rig.mouth;
    const bowedY = mouth.cy + mouth.bow;
    const miss = Math.hypot(mouth.cx - sample.lip[0], bowedY - sample.lip[1]);
    expect(miss, sample.folder).toBeLessThan(4);
    expect(mouth.halfLen, sample.folder).toBeGreaterThan(4);
    expect(rig.face.jaw.band[0], sample.folder).toBeGreaterThan(mouth.cy);

    const engine = createRig(rig);
    const lipWeights = engine.baseWeights(sample.lip[0], sample.lip[1], 0);
    expect(lipWeights.mouth, sample.folder).toBeGreaterThan(0.35);
    expect(lipWeights.jaw, sample.folder).toBeLessThan(0.15);

    const shut = { ...defaults() };
    const talking = { ...defaults(), mouthOpen: 1, mouthForm: 0 };
    const outline: Array<readonly [number, number]> = [sample.chin];
    // The vest mouth used to be painted on this cheek point, below and to the right of the lip.
    if (sample.folder === 'full-body-vest') outline.push([446, 295]);
    for (const [x, y] of outline) {
      const closed = engine.deformBase(x, y, engine.baseWeights(x, y, 0), shut, rest, [0, 0]);
      const open = engine.deformBase(x, y, engine.baseWeights(x, y, 0), talking, rest, [0, 0]);
      const drop = Math.hypot(open[0] - closed[0], open[1] - closed[1]);
      expect(drop, `${sample.folder} ${x},${y}`).toBeLessThan(0.6);
    }
  }
});
