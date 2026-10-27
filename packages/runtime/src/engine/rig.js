import { FULL_BODY_BONES, LIMB_PARAMS } from '../rig/bones.js';
import { buildSkeleton } from '../pose/skeleton.js';
import { faceDensity } from './renderer.js';

export const PARAMS = [
  { id: 'angleX', label: 'Face angle X', min: -30, max: 30, def: 0, group: 'Head and body' },
  { id: 'angleY', label: 'Face angle Y', min: -30, max: 30, def: 0, group: 'Head and body' },
  { id: 'angleZ', label: 'Face roll', min: -30, max: 30, def: 0, group: 'Head and body' },
  { id: 'bodyAngleX', label: 'Body angle X', min: -10, max: 10, def: 0, group: 'Head and body' },
  { id: 'bodyAngleZ', label: 'Body roll', min: -10, max: 10, def: 0, group: 'Head and body' },
  { id: 'breath', label: 'Breath', min: 0, max: 1, def: 0, group: 'Head and body' },
  { id: 'eyeLOpen', label: 'Left eye open', min: 0, max: 1.25, def: 1, group: 'Eyes and brows' },
  { id: 'eyeROpen', label: 'Right eye open', min: 0, max: 1.25, def: 1, group: 'Eyes and brows' },
  { id: 'eyeSmile', label: 'Eye smile', min: 0, max: 1, def: 0, group: 'Eyes and brows' },
  { id: 'gazeX', label: 'Gaze X', min: -1, max: 1, def: 0, group: 'Eyes and brows' },
  { id: 'gazeY', label: 'Gaze Y', min: -1, max: 1, def: 0, group: 'Eyes and brows' },
  { id: 'browY', label: 'Brow Y', min: -1, max: 1, def: 0, group: 'Eyes and brows' },
  { id: 'browAngle', label: 'Brow angle', min: -1, max: 1, def: 0, group: 'Eyes and brows' },
  { id: 'mouthOpen', label: 'Mouth open', min: 0, max: 1, def: 0, group: 'Mouth and cheeks' },
  { id: 'mouthForm', label: 'Mouth form (i to o)', min: -1, max: 1, def: 0, group: 'Mouth and cheeks' },
  { id: 'blush', label: 'Blush', min: 0, max: 1, def: 0, group: 'Mouth and cheeks' },
  { id: 'armAngle', label: 'Arm angle', min: -10, max: 10, def: 0, group: 'Hand' },
  { id: 'handAngle', label: 'Wrist angle', min: -10, max: 10, def: 0, group: 'Hand' },
  { id: 'fingerTap', label: 'Finger tap', min: 0, max: 1, def: 0, group: 'Hand' },
  ...LIMB_PARAMS.map(param => ({ id: param.id, label: param.label, min: -1, max: 1, def: 0, group: 'Full body' })),
];

// Reference algorithms are intentionally retained as JavaScript; the factory's rig input
// and public TypeScript adapter are typed, with numerical regression covering this port.
// Bones of a limb that a cut-out part rotates with. The torso, hips, spine, neck, head
// and clavicles stay with the cut base: a part's chain stops at the first of those.
const CUT_LIMBS = new Set(['upperArmL', 'lowerArmL', 'handL', 'upperArmR', 'lowerArmR', 'handR',
  'upperLegL', 'lowerLegL', 'footL', 'upperLegR', 'lowerLegR', 'footR']);
// Share of the body-yaw slide per layer. The front arm runs a little ahead of the torso:
// part tools size the shoulder caps to hide its root over that margin (0.2 x 0.08 x span).
const YAW_DEPTH = { torso: 0.5, front: 0.7, back: 0.05, leg: 0 };

/**
 * @param {import('../rig/types').Rig} rig
 * @param {{ cutout?: boolean }} [options] cutout: limbs are separate rigid parts (parts.json
 *   with a cut base); the base is then never skinned to a limb bone. Ignored on a bust.
 */
export function createRig(rig, options = {}) {
  const IMG = { w: rig.image.width, h: rig.image.height };
  const gaussian = (x, y, a) => a ? Math.exp(-(((x - a.cx) / a.rx) ** 2 + ((y - a.cy) / a.ry) ** 2)) : 0;
  // ---- face features ----
  // Eye openings come from layers.json ("eyes", written when the layers were cut): the top / bottom edge of
  // the visible eye white + iris, sampled at EYE_N evenly spaced columns from corner to corner.
  const EYE_N = 24;
  const EYES = rig.eyes;

  function sampled(arr, u) {
    const f = Math.min(1, Math.max(0, u)) * (EYE_N - 1), i = Math.min(Math.floor(f), EYE_N - 2), t = f - i;
    return arr[i] + (arr[i + 1] - arr[i]) * t;
  }

  // Raw lid lines at column u for the current state; must match eyeLidsRaw() in the shader.
  //   plain closing: the upper lid comes down onto the lower lid
  //   smiling (^^):  both lids meet on an upward arc from corner to corner
  function eyeLidsRaw(e, u, open, smile) {
    u = Math.min(1, Math.max(0, u));
    const top = sampled(e.top, u), bot = sampled(e.bot, u);
    const b = 1 - open, hump = 4 * u * (1 - u);
    const H = sampled(e.bot, 0.5) - sampled(e.top, 0.5);
    const arc = e.top[0] + (e.top[EYE_N - 1] - e.top[0]) * u - 0.3 * H * hump;
    const closed = Math.max(top, bot + 1 + (arc - bot - 1) * smile);
    // wide-open (open > 1) only lifts the lash a few px: there is no drawn eye white above it
    return [(closed - top) * Math.max(b, -0.07), b > 0 ? (closed - bot) * b * smile : 0];
  }

  // Lid movement is smoothed across columns: the opening's edge is very steep at the corners,
  // and following it exactly bent the lash into a zigzag there.
  const LID_TAPS = [[-2, 1], [-1, 2], [0, 3], [1, 2], [2, 1]], LID_STEP = 5;
  function eyeLids(e, x, open, smile) {
    let du = 0, db = 0;
    for (const [k, w] of LID_TAPS) {
      const [a, c] = eyeLidsRaw(e, (x + k * LID_STEP - e.x0) / (e.x1 - e.x0), open, smile);
      du += a * w / 9; db += c * w / 9;
    }
    const u = Math.min(1, Math.max(0, (x - e.x0) / (e.x1 - e.x0)));
    const top = sampled(e.top, u), bot = sampled(e.bot, u);
    return { top, bot, b: 1 - open, lid: top + du, bc: bot + db };
  }

  // Rest-space y of an eye-part vertex for the current eye state. The upper lash slides down
  // to the lid line and thins a little; the lower lash rises for smiling eyes; the crease
  // follows the lid a little (the lid skin stretches).
  function eyePartY(e, part, x, y, open, smile) {
    const L = eyeLids(e, x, open, smile);
    if (part === 'lash') return L.lid - (L.top - y) * (1 - 0.3 * Math.min(1, Math.max(0, L.b)));
    if (part === 'low') return y + (L.bc - L.bot);
    if (part === 'crease') return y + (L.lid - L.top) * 0.22;
    return y;
  }

  // The lower lash fades out as smiling eyes close, so the arc reads as one line, not two;
  // the crease softens as the lid stretches.
  function eyePartAlpha(part, open, smile) {
    const b = Math.min(1, Math.max(0, 1 - open));
    if (part === 'low') return 1 - Math.min(1, b * smile * 1.2);
    if (part === 'crease') return 1 - 0.45 * b;
    return 1;
  }

  // Closed mouth line runs from (599,579) to (672,556) and bows down ~5.5px.
  const MOUTH = rig.mouth;
  const CHEEKS = rig.cheeks;

  // ---- mesh deformers ----
  // The turn field is a smooth bump over the head. It is deliberately larger than the
  // face so its rim falls in the background, and its slope is zero at the rim.
  const HEAD = rig.head;
  const BODY = rig.body;
  const FULL = rig.fullBody ?? null;
  const CUT = !!(options.cutout && FULL);
  // 1 for a bust (and a bust-sized full-body face). Smaller eyes shrink the pixel
  // offsets below; head shift, roll and the traced eyelids already come from the rig.
  const FACE = faceDensity(rig).scale;
  const PARENT = Object.fromEntries(FULL_BODY_BONES.map(bone => [bone.name, bone.parent]));
  const PARAM_OF = Object.fromEntries(FULL_BODY_BONES.map(bone => [bone.name, bone.param]));
  // Extra spine, neck, clavicle and finger bones exist only for an anatomical pose.
  // A bust, and a full-body pose that never sets skeletonAngles, never reads them.
  const SKELETON = buildSkeleton(rig);
  const BONES = FULL ? { ...FULL.bones, ...(SKELETON?.extraBones ?? {}) } : null;
  const boneOf = name => BONES?.[name];
  const parentOf = (name, P) => P?.skeletonParents && Object.prototype.hasOwnProperty.call(P.skeletonParents, name)
    ? P.skeletonParents[name]
    : (PARENT[name] ?? null);

  const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  function headWeight(x, y) { return 1 - sstep(...HEAD.weightBand, y); }
  // The turn bump already fades out towards its rim, so it only needs a gentle cut-off
  // (stacking both fades is what sheared the neck).
  function turnWeight(x, y) { return 1 - sstep(...HEAD.turnBand, y); }

  // Hair strands: rest polylines root -> tip (4 nodes each), traced from the drawing.
  // Each one is a small spring chain in physics.js; vertices follow the strands near them.
  const STRANDS = rig.strands ?? [];

  // distance to a polyline and the normalised position t (0 root .. 1 tip) of the closest point
  function onPolyline(x, y, nodes) {
    let best = Infinity, bt = 0;
    const n = nodes.length - 1;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = nodes[i], [bx, by] = nodes[i + 1];
      const vx = bx - ax, vy = by - ay;
      const u = Math.min(1, Math.max(0, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy)));
      const d = Math.hypot(x - ax - vx * u, y - ay - vy * u);
      if (d < best) { best = d; bt = (i + u) / n; }
    }
    return [best, bt];
  }

  // Sparse list of [strand index, weight, t]. Weights of overlapping strands are shared so
  // the region between two strands blends their motions instead of adding them.
  function strandWeights(x, y, hair) {
    if (hair < 0.02) return [];
    const hits = [];
    let sum = 0;
    STRANDS.forEach((s, i) => {
      const [d, t] = onPolyline(x, y, s.nodes);
      const g = Math.exp(-((d / s.sigma) ** 2));
      if (g < 0.02) return;
      hits.push([i, g, t]); sum += g;
    });
    const norm = Math.max(1, sum);
    return hits.map(([i, g, t]) => [i, hair * g / norm * sstep(0.04, 0.55, t), t]);
  }

  // Per-vertex weights of the base layer, computed once from the rest position.
  // hair: 0..1 from hairmask.png, so strands only move actual hair.
  // Distance to the segment. Past either end the bone lets go, so the next segment
  // owns its own interior. At the shared joint both distances are equal and both weights survive.
  function boneWeight(x, y, bone) {
    const ax = bone.pivot[0], ay = bone.pivot[1], bx = bone.tip[0], by = bone.tip[1];
    const vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy;
    if (len2 < 1 || bone.radius <= 0) return 0;
    const u = ((x - ax) * vx + (y - ay) * vy) / len2;
    const uClamped = Math.min(1, Math.max(0, u));
    let d = Math.hypot(x - (ax + vx * uClamped), y - (ay + vy * uClamped));
    const outside = u < 0 ? -u : u > 1 ? u - 1 : 0;
    if (outside) d += outside * Math.sqrt(len2) * 0.65;
    const radius = bone.radius;
    if (d >= radius) return 0;
    const t = 1 - d / radius;
    const radial = t * t * (3 - 2 * t);
    return radial < 0.02 ? 0 : radial;
  }

  function baseWeights(x, y, hair = 1) {
    const weights = {
      head: headWeight(x, y),
      turn: turnWeight(x, y),
      strands: strandWeights(x, y, hair),
      bunL: gaussian(x, y, rig.buns?.bunL),
      bunR: gaussian(x, y, rig.buns?.bunR),
      brow: gaussian(x, y, rig.face.brow) * (1 - sstep(...rig.face.brow.band, y)),
      // chin below the mouth line drops a little when the mouth opens
      jaw: gaussian(x, y, rig.face.jaw) * sstep(...rig.face.jaw.band, y),
      // per-feature depth for head turns (nose sticks out most, ears sit at the back)
      nose: gaussian(x, y, rig.face.nose),
      mouth: gaussian(x, y, rig.face.mouth),
      eyeA: gaussian(x, y, rig.face.eyeA),
      eyeB: gaussian(x, y, rig.face.eyeB),
      earR: gaussian(x, y, rig.face.earR),
      earL: gaussian(x, y, rig.face.earL),
      chest: gaussian(x, y, BODY.chest),
      breath: 1 - sstep(...BODY.breathBand, y),
      shoulder: BODY.shoulders.reduce((sum, area) => sum + gaussian(x, y, area), 0),
    };
    if (FULL) {
      const mask = (1 - weights.head) ** 2;
      const collect = (names, maskFor, extraFor = () => 0) => {
        const hits = [];
        let sum = 0;
        for (const name of names) {
          const limb = boneOf(name);
          if (!limb) continue;
          const weight = boneWeight(x, y, limb) * maskFor(name) + extraFor(name);
          if (weight < 0.03) continue;
          hits.push([name, weight]);
          sum += weight;
        }
        const scale = sum > 1 ? 1 / sum : 1;
        return hits.map(([name, weight]) => [name, weight * scale]);
      };
      // The head rides the torso: what the mask takes from the limbs goes to the torso
      // bone, so a torso bend carries the head and neck instead of shearing the neck.
      weights.limbs = collect(FULL_BODY_BONES.map(bone => bone.name), () => mask, name => name === 'torso' ? 1 - mask : 0);
      if (SKELETON) {
        const headNames = new Set(SKELETON.headNames);
        weights.skeletonLimbs = collect(SKELETON.limbNames, name => headNames.has(name) ? 1 : mask);
      }
    }
    return weights;
  }

  // Head turn: features near the face centre travel further than the contour.
  // (A sphere projection was tried first; its rim has an infinite slope and kinked
  // the hair strands and fingers it crossed.)
  function turnOffset(x, y, ax, ay) {
    const nx = (x - HEAD.cx) / HEAD.rx, ny = (y - HEAD.cy) / HEAD.ry;
    const t = 1 - nx * nx - ny * ny;
    if (t <= 0) return [0, 0];
    // flat top over eyes/nose/mouth (r < ~0.4) so they move as one piece; all the
    // stretching needed for parallax happens on the cheeks, contour and hair
    const d = sstep(0, 0.84, t);
    return [ax * HEAD.shiftX * d, -ay * HEAD.shiftY * d];
  }

  function rotateAround(p, cx, cy, a) {
    const c = Math.cos(a), s = Math.sin(a), dx = p[0] - cx, dy = p[1] - cy;
    p[0] = cx + dx * c - dy * s; p[1] = cy + dx * s + dy * c;
  }

  // Head transform with weight w (0 = body, 1 = fully head). Mutates p.
  function applyHead(p, w, P, wTurn = w) {
    const o = turnOffset(p[0], p[1], P.angleX / 30, P.angleY / 30);
    p[0] += o[0] * wTurn; p[1] += o[1] * wTurn;
    if (w <= 0) return;
    rotateAround(p, HEAD.pivotX, HEAD.pivotY, -P.angleZ / 30 * HEAD.maxRoll * w);
  }

  function applyBody(p, restY, P, chest = 0, breathW = 1, shoulder = 0) {
    const b = P.breath;
    // inhale: everything above the cut-off rises, shoulders lift more, the chest widens a little
    p[1] -= b * (5 * breathW + 4 * shoulder);
    p[0] += (p[0] - BODY.chest.cx) * 0.012 * b * chest;
    p[0] += P.bodyAngleX / 10 * (7 + 9 * chest);
    // bottom rows stay put so no gap opens at the cut-off edge of the image
    rotateAround(p, BODY.pivotX, BODY.pivotY, -P.bodyAngleZ / 10 * BODY.maxRoll * (1 - sstep(...BODY.rollBand, restY)));
  }

  // ---- cut-out full body ----
  // Shoulder span, the scale of the body-yaw depth shift.
  const SPAN = FULL ? Math.hypot(FULL.bones.upperArmR.pivot[0] - FULL.bones.upperArmL.pivot[0],
    FULL.bones.upperArmR.pivot[1] - FULL.bones.upperArmL.pivot[1]) : 0;
  // Body yaw on a flat drawing: layers slide by depth instead of the torso warping. The arm
  // that turns toward the camera slides furthest, the torso about half, the far arm hardly,
  // and the legs not at all, so the feet stay planted. Positive yaw turns the chest toward
  // image-right, which brings the image-left arm forward.
  function yawShift(P, depth) {
    const yaw = Math.max(-1, Math.min(1, (P.bodyAngleX ?? 0) / 10));
    return yaw * SPAN * 0.08 * YAW_DEPTH[depth];
  }
  function frontSide(P) {
    const yaw = P.bodyAngleX ?? 0;
    return yaw > 0 ? 'L' : yaw < 0 ? 'R' : null;
  }
  // The torso's own lean, from the spine of an anatomical pose or the torso slider, as one
  // small rotation of the cut base. The spine is not bent and nothing is skinned to it.
  function torsoLean(P) {
    let lean = 0;
    if (P.skeletonAngles) {
      for (const name of ['hips', 'spine1', 'spine2', 'spine3']) lean += P.skeletonAngles[name] || 0;
    } else {
      lean = (P.torsoBend ?? 0) * (FULL?.bones.torso.maxBend ?? 0);
    }
    return Math.max(-0.05, Math.min(0.05, lean));
  }
  function applyCutBody(p, restY, P, chest = 0, breathW = 1, shoulder = 0) {
    const b = P.breath;
    p[1] -= b * (5 * breathW + 4 * shoulder);
    p[0] += (p[0] - BODY.chest.cx) * 0.012 * b * chest;
    p[0] += yawShift(P, 'torso');
    const roll = -P.bodyAngleZ / 10 * BODY.maxRoll + torsoLean(P);
    rotateAround(p, BODY.pivotX, BODY.pivotY, roll * (1 - sstep(...BODY.rollBand, restY)));
  }
  const applyTorso = (p, restY, P, chest, breathW, shoulder) =>
    (CUT ? applyCutBody : applyBody)(p, restY, P, chest, breathW, shoulder);

  function localAngle(name, P, phys) {
    const bone = boneOf(name);
    if (!bone) return phys.limbs?.[name] ?? 0;
    if (P.skeletonAngles && Object.prototype.hasOwnProperty.call(P.skeletonAngles, name)) {
      return P.skeletonAngles[name] + (phys.limbs?.[name] ?? 0);
    }
    const param = PARAM_OF[name];
    if (!param) return phys.limbs?.[name] ?? 0;
    return (P[param] ?? 0) * bone.maxBend + (phys.limbs?.[name] ?? 0);
  }
  function posedPivot(name, P, phys, cache) {
    if (cache[name]) return cache[name];
    const rest = boneOf(name).pivot;
    const parent = parentOf(name, P);
    if (!parent) { cache[name] = [rest[0], rest[1]]; return cache[name]; }
    const q = [rest[0], rest[1]];
    applyChain(q, parent, P, phys, cache);
    cache[name] = q;
    return q;
  }
  function applyChain(point, name, P, phys, cache) {
    const parent = parentOf(name, P);
    if (parent) applyChain(point, parent, P, phys, cache);
    const angle = localAngle(name, P, phys);
    if (angle !== 0) {
      const pivot = posedPivot(name, P, phys, cache);
      rotateAround(point, pivot[0], pivot[1], angle);
    }
  }
  // One rigid transform for the whole bone: rotation by the chain angle, then translation.
  // A zero chain is skipped so a resting full-body point stays bit-identical.
  function boneRigid(name, P, phys, cache) {
    if (cache.rigid[name]) return cache.rigid[name];
    let theta = 0, moving = false;
    for (let n = name; n; n = parentOf(n, P)) {
      const angle = localAngle(n, P, phys);
      if (angle !== 0) moving = true;
      theta += angle;
    }
    const bone = boneOf(name);
    const rest = bone.pivot;
    const posed = posedPivot(name, P, phys, cache.pivot);
    const c = Math.cos(theta), s = Math.sin(theta);
    const rigid = {
      name, theta, moving, c, s, posed, radius: bone.radius, restVector: [bone.tip[0] - rest[0], bone.tip[1] - rest[1]],
      tx: posed[0] - (c * rest[0] - s * rest[1]),
      ty: posed[1] - (s * rest[0] + c * rest[1]),
    };
    cache.rigid[name] = rigid;
    return rigid;
  }
  // Dual-quaternion blend of the rigid bone transforms (Kavan et al., Skinning with
  // Dual Quaternions). The limb interior is one bone, so it stays rigid. Only the
  // joint band mixes two rotations, which keeps the hinge from collapsing the way a
  // linear blend of positions does. A little linear blend at that band only trims
  // the dual-quaternion bulge. Zero angles return before any of this runs.
  function applyLimbs(point, weights, P, phys) {
    if (!FULL || !weights?.length) return;
    const cache = { pivot: {}, rigid: {} };
    const used = [];
    let moving = false, bound = 0, best = null;
    for (const [name, weight] of weights) {
      if (weight <= 0 || !boneOf(name)) continue;
      const rigid = boneRigid(name, P, phys, cache);
      if (rigid.moving) moving = true;
      const item = { rigid, weight };
      used.push(item);
      if (!best || weight > best.weight) best = item;
      bound += weight;
    }
    if (!moving || bound <= 0 || !used.length) return;
    let lx = 0, ly = 0, dominant = 0;
    const quats = [];
    for (const { rigid, weight } of used) {
      const half = rigid.theta * 0.5, qw = Math.cos(half), qz = Math.sin(half);
      quats.push({
        weight, w: qw, z: qz,
        dx: 0.5 * (rigid.tx * qw + rigid.ty * qz),
        dy: 0.5 * (-rigid.tx * qz + rigid.ty * qw),
      });
      const px = rigid.c * point[0] - rigid.s * point[1] + rigid.tx;
      const py = rigid.s * point[0] + rigid.c * point[1] + rigid.ty;
      lx += px * weight; ly += py * weight;
      if (weight > dominant) dominant = weight;
    }
    if (bound < 1) {
      quats.push({ weight: 1 - bound, w: 1, z: 0, dx: 0, dy: 0 });
      lx += point[0] * (1 - bound); ly += point[1] * (1 - bound);
    }
    let ref = quats[0];
    for (const q of quats) if (q.weight > ref.weight) ref = q;
    let w = 0, z = 0, dx = 0, dy = 0;
    for (const q of quats) {
      const sign = q.w * ref.w + q.z * ref.z < 0 ? -1 : 1;
      w += q.weight * q.w * sign; z += q.weight * q.z * sign;
      dx += q.weight * q.dx * sign; dy += q.weight * q.dy * sign;
    }
    const mag = Math.hypot(w, z) || 1;
    w /= mag; z /= mag; dx /= mag; dy /= mag;
    const tx = 2 * (dx * w - dy * z);
    const ty = 2 * (dy * w + dx * z);
    const c = 1 - 2 * z * z, s = 2 * w * z;
    const qx = c * point[0] - s * point[1] + tx;
    const qy = s * point[0] + c * point[1] + ty;
    const joint = bound > 0 ? 1 - dominant / Math.max(bound, dominant) : 0;
    const mix = joint * 0.2;
    let x = qx * (1 - mix) + lx * mix, y = qy * (1 - mix) + ly * mix;
    // Volume and twist run only for an anatomical pose. The legacy slider path
    // returns the dual-quaternion point above, which the hinge regression measures.
    if (P.skeletonAngles && best) {
      const pinch = 1 - Math.cos(Math.min(Math.abs(best.rigid.theta), Math.PI));
      const band = best.rigid.radius * 0.55;
      const px = best.rigid.posed[0], py = best.rigid.posed[1];
      const dx = x - px, dy = y - py, dist = Math.hypot(dx, dy);
      if (pinch > 0.05 && dist > 1 && dist < band) {
        const push = pinch * 0.18 * (1 - dist / band) * best.rigid.radius;
        x += dx / dist * push; y += dy / dist * push;
      }
      const tw = P.skeletonTwist?.[best.rigid.name] || 0;
      if (tw) {
        const rv = best.rigid.restVector;
        const c = best.rigid.c, s = best.rigid.s;
        const ax = rv[0] * c - rv[1] * s, ay = rv[0] * s + rv[1] * c;
        const len = Math.hypot(ax, ay) || 1;
        const ux = ax / len, uy = ay / len;
        const rx = x - px, ry = y - py;
        const along = rx * ux + ry * uy;
        const foreshorten = Math.cos(tw);
        x = px + along * ux + (rx - along * ux) * foreshorten;
        y = py + along * uy + (ry - along * uy) * foreshorten;
      }
    }
    point[0] = x; point[1] = y;
  }

  // Base layer: hair and face-part offsets are added in rest space, then head, then body.
  function deformBase(x, y, w, P, phys, out) {
    const p = out;
    p[0] = x; p[1] = y;
    const g = phys.gain;
    for (const [i, wi, t] of w.strands) {
      const o = phys.strands?.[i];
      if (!o) continue;
      const f = t * 3, k = Math.min(2, Math.floor(f)), u = f - k;
      p[0] += (o[k][0] + (o[k + 1][0] - o[k][0]) * u) * wi * g;
      p[1] += (o[k][1] + (o[k + 1][1] - o[k][1]) * u) * wi * g;
    }
    p[0] += (phys.bunL[0] * w.bunL + phys.bunR[0] * w.bunR) * g;
    p[1] += (phys.bunL[1] * w.bunL + phys.bunR[1] * w.bunR) * g;
    // brows
    p[1] -= P.browY * 7 * FACE * w.brow;
    if (w.brow > 0.01) {
      const a = P.browAngle * 0.12 * w.brow;
      p[1] += (x - rig.face.brow.cx) * Math.sin(a);
    }
    p[1] += P.mouthOpen * 3.5 * FACE * w.jaw;
    // head turn, per part: nose and mouth travel further than the eyes, the far eye
    // narrows and the near eye widens, the ears and buns slide the other way.
    // The added distances are bust pixels; FACE shrinks them on a small full-body eye.
    // Terms that already multiply (x - centre) scale with the feature and stay put.
    const ax = P.angleX / 30, ay = P.angleY / 30;
    p[0] += ax * FACE * (8 * w.nose + 5 * w.mouth) + (x - rig.face.eyeA.cx) * 0.12 * ax * w.eyeA - (x - rig.face.eyeB.cx) * 0.12 * ax * w.eyeB
      - ax * FACE * 9 * w.earR + ax * FACE * 4 * w.earL - ax * FACE * 10 * (w.bunL + w.bunR);
    p[1] -= ay * FACE * (6 * w.nose + 3 * w.mouth);
    p[1] += (y - rig.face.eyeA.cy) * -0.06 * Math.abs(ay) * w.eyeA + (y - rig.face.eyeB.cy) * -0.06 * Math.abs(ay) * w.eyeB;
    if (CUT) {
      // the cut base holds only the torso, head and clothes: limbs are their own parts
      applyHead(p, w.head, P, w.turn);
      applyCutBody(p, y, P, w.chest, w.breath, w.shoulder);
    } else {
      const limbs = P.skeletonAngles ? w.skeletonLimbs : w.limbs;
      if (limbs?.length) applyLimbs(p, limbs, P, phys);
      applyHead(p, w.head, P, w.turn);
      applyBody(p, y, P, w.chest, w.breath, w.shoulder);
    }
    // Whole-body shift from hip tracking and foot contact. A zero shift is skipped,
    // and a bust has no full-body rig, so this cannot change the bust regression.
    const shift = FULL ? P.skeletonTranslation : null;
    if (shift && (shift[0] || shift[1])) { p[0] += shift[0]; p[1] += shift[1]; }
    return p;
  }

  // ---- cut-out parts ----
  // A limb part moves as one rigid piece: the rotations of its chain about the drawn joints,
  // then where the cut base carries its root. An arm takes the torso's local motion at the
  // shoulder (breath, roll, lean, head weight) plus its own depth in a body yaw. A leg only
  // follows the hip's travel: it passes under the skirt and its foot stays planted.
  const rootCache = new Map();
  function rootPoints(root) {
    let hit = rootCache.get(root);
    if (!hit) {
      const bone = boneOf(root);
      const [px, py] = bone.pivot;
      const ux = bone.tip[0] - px, uy = bone.tip[1] - py, len = Math.hypot(ux, uy) || 1;
      const reach = Math.min(24, len * 0.5);
      const q = [px + ux / len * reach, py + uy / len * reach];
      hit = { p: [px, py], q, wp: baseWeights(px, py, 0), wq: baseWeights(q[0], q[1], 0) };
      rootCache.set(root, hit);
    }
    return hit;
  }
  const rootA = [0, 0], rootB = [0, 0];
  function partFrame(name, P, phys) {
    let c = 1, s = 0, tx = 0, ty = 0, root = name;
    for (let n = name; n && CUT_LIMBS.has(n); n = parentOf(n, P)) {
      root = n;
      const a = localAngle(n, P, phys);
      if (!a) continue;
      const [px, py] = boneOf(n).pivot;
      const ca = Math.cos(a), sa = Math.sin(a);
      const nc = ca * c - sa * s, ns = sa * c + ca * s;
      const ntx = ca * (tx - px) - sa * (ty - py) + px, nty = sa * (tx - px) + ca * (ty - py) + py;
      c = nc; s = ns; tx = ntx; ty = nty;
    }
    const at = rootPoints(root);
    deformBase(at.p[0], at.p[1], at.wp, P, phys, rootA);
    const arm = root.startsWith('upperArm');
    let fc = 1, fs = 0, ox = rootA[0], oy = rootA[1];
    if (arm) {
      deformBase(at.q[0], at.q[1], at.wq, P, phys, rootB);
      const turn = Math.atan2(rootB[1] - rootA[1], rootB[0] - rootA[0]) - Math.atan2(at.q[1] - at.p[1], at.q[0] - at.p[0]);
      fc = Math.cos(turn); fs = Math.sin(turn);
      const front = frontSide(P);
      if (front) ox += yawShift(P, front === root[root.length - 1] ? 'front' : 'back') - yawShift(P, 'torso');
    } else {
      ox -= yawShift(P, 'torso');
    }
    const [px, py] = at.p;
    return {
      c: fc * c - fs * s, s: fs * c + fc * s,
      tx: fc * (tx - px) - fs * (ty - py) + ox, ty: fs * (tx - px) + fc * (ty - py) + oy,
    };
  }

  // ---- hand / forearm ----
  // Two rigid bones (forearm about the elbow, hand about the wrist) instead of letting the
  // head's warp field bend them. The forearm takes only part of the swing, because whatever
  // it uncovers is inpainted; the wrist does the rest so the fingertips stay on the chin.
  const H = rig.hand;
  const ELBOW = H?.elbow ?? [0, 0], WRIST = H?.wrist ?? [0, 0];
  const KNUCKLE = H?.knuckle ?? [0, 0], CONTACT = H?.contact ?? [0, 0];
  const FOREARM_SHARE = H?.forearmShare ?? 0;

  function handWeights(x, y) {
    if (!H) return { arm: 0, wrist: 0, hand: 0, finger: 0, pinBottom: 0 };
    return {
      arm: 1 - sstep(...H.armBand, y),
      wrist: 1 - sstep(...H.wristBand, y),
      hand: 1 - sstep(...H.handBand, y),
      finger: sstep(...H.fingerXBand, x) * (1 - sstep(...H.fingerYBand, y)),
      pinBottom: sstep(...H.pinBand, y),
    };
  }

  const rot = (p, o, c, s) => { const dx = p[0] - o[0], dy = p[1] - o[1]; return [o[0] + dx * c - dy * s, o[1] + dx * s + dy * c]; };
  const angleOf = v => Math.atan2(v[1], v[0]);

  // Per-frame bone transforms of the hand layer.
  function handFrame(P) {
    const c = [...CONTACT];
    applyHead(c, headWeight(...CONTACT), P, turnWeight(...CONTACT));
    applyBody(c, CONTACT[1], P, 0, 1, 0);
    const e = [...ELBOW];
    applyBody(e, ELBOW[1], P, 0, 0, 0);
    const full = angleOf([c[0] - e[0], c[1] - e[1]]) - angleOf([CONTACT[0] - ELBOW[0], CONTACT[1] - ELBOW[1]]);
    const a = full * FOREARM_SHARE;
    const ca = Math.cos(a), sa = Math.sin(a);
    const tr = p => { const q = rot(p, ELBOW, ca, sa); return [q[0] + e[0] - ELBOW[0], q[1] + e[1] - ELBOW[1]]; };
    const w = tr(WRIST), c1 = tr(CONTACT);
    const b = angleOf([c[0] - w[0], c[1] - w[1]]) - angleOf([c1[0] - w[0], c1[1] - w[1]]);
    const k = Math.min(1.03, Math.max(0.97, Math.hypot(c[0] - w[0], c[1] - w[1]) / Math.hypot(c1[0] - w[0], c1[1] - w[1])));
    return { tr, w, b, k };
  }

  function deformHand(x, y, w, P, F, out) {
    let p = [x, y];
    // kept small on purpose: anything the hand uncovers is only a blurry inpaint
    p = rot(p, KNUCKLE, Math.cos(P.fingerTap * 0.07 * w.finger), Math.sin(P.fingerTap * 0.07 * w.finger));
    const ha = -P.handAngle / 10 * 0.045 * w.wrist, aa = -P.armAngle / 10 * 0.015 * w.arm;
    p = rot(p, WRIST, Math.cos(ha), Math.sin(ha));
    p = rot(p, ELBOW, Math.cos(aa), Math.sin(aa));
    p = F.tr(p);
    // wrist bone, blended in across the wrist so the joint bends smoothly
    const bw = F.b * w.hand, kw = 1 + (F.k - 1) * w.hand;
    p = rot(p, F.w, Math.cos(bw) * kw, Math.sin(bw) * kw);
    // the arm is cut by the image edge: keep that edge on the edge
    p[1] += (y - p[1]) * w.pinBottom;
    out[0] = p[0]; out[1] = p[1];
    return out;
  }

  // ---- tassels (2-bone chains driven by physics) ----
  const TASSELS = rig.accessories ?? [];

  // Where the tassel hangs from, after head/body deformation.
  function tasselAnchor(t, P, phys, out) {
    const w = baseWeights(t.pivot[0], t.pivot[1]);
    return deformBase(t.pivot[0], t.pivot[1], w, P, phys, out);
  }
  return { IMG, EYES, MOUTH, CHEEKS, STRANDS, TASSELS, cutout: CUT, headWeight, turnWeight, baseWeights, deformBase, applyHead, applyBody, applyTorso, applyLimbs, partFrame, frontSide, handWeights, handFrame, deformHand, eyePartY, eyePartAlpha, tasselAnchor };
}
