// Mesh avatar engine: turns a pre-split single illustration into a
// 2D mesh avatar animated on a WebGL2 canvas. No UI and no framework: the app drives it
// through the small API returned by createMeshAvatar().
import { buildSkeleton, meshAngles, orderTriangles, poseFromJson, poseFromKeypoints, posePreset, poseToJson, restPose, solveIk, trackSkeleton, uncoveredWedges } from '../pose/skeleton.js';
import { createRig } from './rig.js';
import { createRenderer, faceDensity } from './renderer.js';
import { createPhysics } from './physics.js';
import { createSpriteModule, eyeMood } from './sprites.js';
import { createCutout } from './body-parts.js';
import { Motion } from './motion.js';
import { ExpressionOverlay } from './expression-overlay.js';
import { MOTIONS, IDLE_MOTIONS } from './motions.js';

const EYE_PARTS = ['ball', 'low', 'crease', 'lash'];   // back to front
const HINGE_BONES = ['lowerArmL', 'lowerArmR', 'lowerLegL', 'lowerLegR'];

// Tight grid around elbows and knees, plus a bust-density face when the head is small.
// Bust rigs omit fullBody, so they get neither.
function meshRegions(rig) {
  const bones = rig.fullBody?.bones;
  if (!bones) return null;
  const cell = Math.max(4, Math.round(rig.mesh.baseCell / 2));
  const regions = [];
  for (const name of HINGE_BONES) {
    const bone = bones[name];
    if (!bone) continue;
    const [x, y] = bone.pivot;
    const reach = Math.max(12, bone.radius * 1.4);
    const x0 = Math.max(0, Math.floor(x - reach));
    const x1 = Math.min(rig.image.width, Math.ceil(x + reach));
    const y0 = Math.max(0, Math.floor(y - reach));
    const y1 = Math.min(rig.image.height, Math.ceil(y + reach));
    if (x1 > x0 && y1 > y0) regions.push({ x0, x1, y0, y1, cell });
  }
  const face = faceDensity(rig).region;
  if (face) regions.push(face);
  return regions.length ? regions : null;
}

const imageCache = new Map();
const jsonCache = new Map();
async function loadJson(src) {
  if (!jsonCache.has(src)) jsonCache.set(src, fetch(src).then(r => { if (!r.ok) throw new Error(`failed to load ${src}`); return r.json(); }));
  return jsonCache.get(src);
}
function loadImage(src) {
  if (imageCache.has(src)) return imageCache.get(src);
  const result = new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error(`failed to load ${src}`));
    i.src = src;
  });
  imageCache.set(src, result);
  return result;
}

function channelOf(img, ch) {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const a = new Uint8Array(c.width * c.height);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + ch];
  return a;
}
const alphaOf = img => channelOf(img, 3);

// Two-bone skinning along the tassel: top follows segment 1, lower part segment 2.
function deformTassel(ch, mesh) {
  const [px, py] = ch.t.pivot, d = ch.dir, P = ch.pts;
  const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const c1 = Math.cos(ch.phi[0]), s1 = Math.sin(ch.phi[0]);
  const c2 = Math.cos(ch.phi[1]), s2 = Math.sin(ch.phi[1]);
  const r = mesh.rest, o = mesh.pos;
  for (let i = 0; i < r.length; i += 2) {
    const vx = r[i] - px, vy = r[i + 1] - py;
    const along = vx * d[0] + vy * d[1];
    const ax = P[0][0] + vx * c1 - vy * s1, ay = P[0][1] + vx * s1 + vy * c1;
    const ux = vx - d[0] * ch.L1, uy = vy - d[1] * ch.L1;
    const bx = P[1][0] + ux * c2 - uy * s2, by = P[1][1] + ux * s2 + uy * c2;
    const w = sstep(ch.L1 * 0.55, ch.L1 * 1.35, along);
    o[i] = ax + (bx - ax) * w; o[i + 1] = ay + (by - ay) * w;
  }
}

/** @param {HTMLCanvasElement} canvas
 * @param {import('./index').MeshAvatarOptions} options */
export async function createMeshAvatarImpl(canvas, options) {
  if (!options.assets && options.assetsBase === undefined) {
    throw new Error('createMeshAvatar requires assets or assetsBase.');
  }
  const rig = options.rig;
  const base = (options.assetsBase ?? '').replace(/\/?$/, '/');
  const asset = (name, build) => {
    if (options.assets) {
      if (!options.assets[name]) throw new Error(`Missing project asset: ${name}`);
      return options.assets[name];
    }
    return `${base}${name}${build === undefined ? '' : `?b=${build}`}`;
  };
  // Cut-out limbs (parts/parts.json with a cut base) are optional. Without them a
  // full-body avatar is the one skinned illustration it always was.
  let cut = null;
  if (rig.fullBody) {
    try {
      const sheet = await loadJson(asset('parts/parts.json'));
      if (sheet?.cutout?.base && sheet.layers?.[sheet.cutout.base]) {
        const names = Object.keys(sheet.layers);
        const images = Object.fromEntries(await Promise.all(names.map(async name => [name, await loadImage(asset(`parts/${name}.png`, sheet.build))])));
        cut = { sheet, images };
      }
    } catch { cut = null; }
  }
  const engine = createRig(rig, { cutout: !!cut });
  const { IMG, EYES, baseWeights, deformBase, eyePartY, eyePartAlpha,
    handWeights, handFrame, deformHand, TASSELS } = engine;
  const { Renderer, buildGrid, buildContourGrid } = createRenderer(engine, rig);
  const { Physics } = createPhysics(engine, rig);
  const { createSprites } = createSpriteModule(engine, rig);
  const meta = await loadJson(asset('layers.json'));

  const names = ['base', ...(rig.hand ? ['hand'] : []), ...TASSELS.map(t => t.name), ...[0, 1].flatMap(i => EYE_PARTS.map(p => `eye${i}_${p}`)), 'hairmask'];
  const imgs = Object.fromEntries(await Promise.all(names.map(async n => [n, await loadImage(asset(`${n}.png`, meta.build))])));
  const hairMask = channelOf(imgs.hairmask, 0);
  const hairAt = (x, y) => hairMask[Math.min(IMG.h - 1, Math.max(0, Math.round(y))) * IMG.w + Math.min(IMG.w - 1, Math.max(0, Math.round(x)))] / 255;

  // The source image is cut flat at its top edge (crown and right bun). A negative top margin
  // keeps the top ~88px (7%) above the canvas, which the layout puts at the top of the panel:
  // the cut stays off screen even at the deepest head tilt.
  const R = new Renderer(canvas, { padTop: options.padTop ?? rig.view.padTop, padSide: options.padSide ?? rig.view.padSide, fit: options.fit });
  const rects = { base: [0, 0, IMG.w, IMG.h], ...meta.layers };

  // base layer, denser where hair strands bend and the face parts shift.
  // Elbows and knees get a tighter grid only when the rig has limbs.
  const density = faceDensity(rig);
  const baseImage = cut ? cut.images[cut.sheet.cutout.base] : imgs.base;
  const baseMesh = buildGrid(rects.base, rig.mesh.baseCell, alphaOf(baseImage), baseImage.width, rig.mesh.fine, meshRegions(rig));
  const baseW = [];
  for (let i = 0; i < baseMesh.rest.length / 2; i++) {
    const x = baseMesh.rest[i * 2], y = baseMesh.rest[i * 2 + 1];
    baseW.push(baseWeights(x, y, hairAt(x, y)));
  }
  R.addLayer('base', baseImage, baseMesh, { face: true });
  const skeleton = buildSkeleton(rig);
  // the cut base has no limb triangles to re-sort; its limbs are separate layers
  const vertexBone = skeleton && !cut ? baseW.map(weights => {
    let best = '', weight = 0;
    for (const [name, value] of weights.skeletonLimbs ?? []) if (value > weight) { best = name; weight = value; }
    return best;
  }) : [];
  let skeletonBinding = null, drawKey = '', bodyTrack = null;
  function applyDrawOrder() {
    if (!skeleton || cut) return;
    const depth = skeletonBinding?.drawOrder ?? {};
    const key = JSON.stringify(depth);
    if (key === drawKey) return;
    drawKey = key;
    R.setTriangleOrder('base', orderTriangles(baseMesh.tris, vertexBone, depth));
  }

  // eyes: white+iris clipped by the lids, then the line layers on top
  const eyeParts = [];
  EYES.forEach((e, i) => {
    for (const part of EYE_PARTS) {
      const n = `eye${i}_${part}`;
      // a painted blink slides the upper lash down inside its own rect, below the drawn
      // ink, so that layer needs the whole quad (the 1x1 opaque stand-in)
      const whole = part === 'lash' && density.scale < 0.9;
      const mesh = whole
        ? buildGrid(rects[n], density.eyeCell, new Uint8Array([255]), 1)
        : buildGrid(rects[n], part === 'ball' ? density.ballCell : density.eyeCell, alphaOf(imgs[n]), imgs[n].width);
      const W = [];
      for (let k = 0; k < mesh.rest.length / 2; k++) W.push(baseWeights(mesh.rest[k * 2], mesh.rest[k * 2 + 1], 0));
      const layer = R.addLayer(n, imgs[n], mesh, { eyeBall: part === 'ball' ? i : undefined });
      eyeParts.push({ e, eye: i, part, mesh, W, layer });
    }
  });

  // drawn eye / mouth variants (closed / half / smiling eyes, a/i/u/e/o mouths) over the face
  let sprites = null;
  try {
    {
      const sheet = await loadJson(asset('sprites/sprites.json'));
      const simgs = Object.fromEntries(await Promise.all(Object.keys(sheet.layers).map(async n =>
        [n, await loadImage(asset(`sprites/${n}.png`, sheet.build))])));
      sprites = createSprites(R, sheet, simgs, buildGrid, alphaOf, density.spriteCell);
    }
  } catch (err) {
    console.warn('eye / mouth sprites not loaded:', err);
  }
  const bodyParts = cut ? createCutout(R, cut.sheet, cut.images, { buildGrid, buildContourGrid, alphaOf, hairAt }, engine, rig) : null;
  // A small full-body eye has no closed-eye sprite. Moving the lash mesh squashes the
  // brow skin in that cut-out, and hiding the whole cut-out erases the brow. Leave the
  // lash where it was drawn and mask only the opening; the base shader paints the lid.
  const paintBlink = !sprites && density.scale < 0.9;
  if (paintBlink) {
    for (const ep of eyeParts) {
      if (ep.part === 'lash' || ep.part === 'low' || ep.part === 'crease') ep.layer.eyeMask = ep.eye;
    }
  }

  const tassels = TASSELS.map(t => {
    const mesh = buildGrid(rects[t.name], rig.mesh.tasselCell, alphaOf(imgs[t.name]), imgs[t.name].width);
    return R.addLayer(t.name, imgs[t.name], mesh);
  });

  const handMesh = rig.hand ? buildGrid(rects.hand, rig.mesh.handCell, alphaOf(imgs.hand), imgs.hand.width) : { rest: [], pos: [] };
  const handW = [];
  for (let i = 0; i < handMesh.rest.length / 2; i++) handW.push(handWeights(handMesh.rest[i * 2], handMesh.rest[i * 2 + 1]));
  if (rig.hand) R.addLayer('hand', imgs.hand, handMesh);

  const physics = new Physics();
  const motion = new Motion(rig.view.gazeCenter ?? [rig.head.cx, rig.head.cy], {
    fullBody: !!rig.fullBody, sway: rig.fullBody?.sway ?? 0,
  });
  const listeners = new Set();
  motion.onMotion = id => { for (const fn of listeners) fn(id); };

  let parameters = {}, parameterWeight = 1, lastParameters = {};
  const expression = new ExpressionOverlay();
  const tmp = [0, 0];
  function updateParameters(dt) {
    const P = { ...motion.update(dt) };
    for (const [key, value] of Object.entries(parameters)) P[key] = parameterWeight === 1 ? value : (P[key] ?? 0) + (value - (P[key] ?? 0)) * parameterWeight;
    // Speech owns the mouth while active; explicit pose sliders still own all other parameters.
    if (motion.lipOpen !== null) {
      P.mouthOpen = motion.P.mouthOpen;
      if (!options.preserveMouthForm || parameters.mouthForm === undefined) P.mouthForm = motion.P.mouthForm;
    }
    // Live expressions sit above tracking and lip sync; neutral leaves the parameters untouched.
    if (skeletonBinding) {
      P.skeletonAngles = skeletonBinding.angles;
      P.skeletonParents = skeletonBinding.parents;
      P.skeletonTwist = skeletonBinding.twists;
      if (skeletonBinding.translation) P.skeletonTranslation = skeletonBinding.translation;
    }
    const out = expression.apply(P, dt);
    lastParameters = out;
    return out;
  }
  function tick(dt) {
    const P = updateParameters(dt);
    const phys = physics.step(P, dt);

    const bp = baseMesh.pos, br = baseMesh.rest;
    for (let i = 0; i < baseW.length; i++) {
      deformBase(br[i * 2], br[i * 2 + 1], baseW[i], P, phys, tmp);
      bp[i * 2] = tmp[0]; bp[i * 2 + 1] = tmp[1];
    }
    // with drawn eye sprites the layered eye is only ever shown exactly as drawn: moving the
    // cut-out lash leaves seams at its edges
    const eyeOpenFor = v => (sprites ? 1 : v);
    for (const ep of eyeParts) {
      const open = eyeOpenFor(ep.eye === 0 ? P.eyeROpen : P.eyeLOpen);
      const smile = ep.eye === 0 ? P.eyeSmile : (P.eyeSmileL ?? P.eyeSmile);
      const meshOpen = paintBlink ? 1 : open;
      const meshSmile = paintBlink ? 0 : smile;
      // The iris is the open eye; the shader hides it above the lid line, so it stays
      // solid below it. Lash and lower-lash ink under the lid is masked in the shader;
      // ink outside it, including the brow, stays where it was drawn.
      ep.layer.alpha = eyePartAlpha(ep.part, meshOpen, meshSmile);
      const r = ep.mesh.rest, o = ep.mesh.pos;
      for (let k = 0; k < ep.W.length; k++) {
        const x = r[k * 2], y = r[k * 2 + 1];
        deformBase(x, eyePartY(ep.e, ep.part, x, y, meshOpen, meshSmile), ep.W[k], P, phys, tmp);
        o[k * 2] = tmp[0]; o[k * 2 + 1] = tmp[1];
      }
    }
    // the motion expression is not applied in manual mode, so only the live one counts there
    const cover = sprites?.update(P, phys, dt, eyeMood(expression.name, motion.mode === 'manual' ? null : motion.expr));
    if (cover) for (const ep of eyeParts) if (cover.eyes[ep.eye]) ep.layer.alpha = 0;
    const hp = handMesh.pos, hr = handMesh.rest, HF = handFrame(P);
    for (let i = 0; i < handW.length; i++) {
      deformHand(hr[i * 2], hr[i * 2 + 1], handW[i], P, HF, tmp);
      hp[i * 2] = tmp[0]; hp[i * 2 + 1] = tmp[1];
    }
    physics.chains.forEach((ch, k) => deformTassel(ch, tassels[k].mesh));

    bodyParts?.update(P, phys, skeletonBinding);
    const ball = 7 * density.scale; // px of iris travel; density.scale is 1 on a bust
    R.draw({
      angleX: P.angleX, angleY: P.angleY, angleZ: P.angleZ,
      eyes: [
        eyeOpenFor(P.eyeROpen), P.eyeSmile, P.gazeX * ball, -P.gazeY * ball * 0.6,
        eyeOpenFor(P.eyeLOpen), P.eyeSmileL ?? P.eyeSmile, P.gazeX * ball * 0.85, -P.gazeY * ball * 0.6,
      ],
      // with sprites the drawn mouths replace the shader-painted one
      mouthOpen: sprites ? 0 : P.mouthOpen, mouthForm: P.mouthForm, cheek: P.blush,
      showMesh: false, originalAlpha: 0, joints: [],
    });
  }

  // `manual: true` runs no animation loop: the caller advances time with advance()
  // (offline video rendering, one call per frame)
  let raf = 0, last = performance.now(), destroyed = false;
  const frame = now => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    tick(dt);
    raf = requestAnimationFrame(frame);
  };
  if (!options.manual) raf = requestAnimationFrame(frame);

  const motionList = [
    ...Object.entries(MOTIONS).map(([id, m]) => ({ id, label: m.label, idle: false })),
    ...Object.entries(IDLE_MOTIONS).map(([id, m]) => ({ id, label: m.label, idle: true })),
  ];

  return {
    motions: motionList,
    imageSize: { width: IMG.w, height: IMG.h },
    fullBody: !!rig.fullBody,
    setParameters(values, weight = 1) { parameters = { ...values }; parameterWeight = Math.min(1, Math.max(0, Number(weight) || 0)); },
    setSkeletonPose(pose) {
      if (!skeleton) return null;
      skeletonBinding = pose ? meshAngles(skeleton, pose) : null;
      applyDrawOrder();
      return skeletonBinding?.pose ?? null;
    },
    getSkeletonPose() { return skeletonBinding?.pose ?? null; },
    applyPosePreset(name) { return skeleton ? this.setSkeletonPose(posePreset(skeleton, name)) : null; },
    solveSkeletonIk(goal) {
      if (!skeleton) return null;
      return this.setSkeletonPose(solveIk(skeleton, skeletonBinding?.pose ?? restPose(skeleton), goal));
    },
    poseFromKeypoints(input, options) { return skeleton ? this.setSkeletonPose(poseFromKeypoints(skeleton, input, options)) : null; },
    trackBody(input, options = {}) {
      if (!skeleton) return null;
      if (!bodyTrack) bodyTrack = {};
      return this.setSkeletonPose(trackSkeleton(skeleton, input, bodyTrack, options));
    },
    resetBodyTrack() { bodyTrack = null; return this.setSkeletonPose(null); },
    getSkeletonPoseJson() { return this.getSkeletonPose() ? poseToJson(this.getSkeletonPose()) : null; },
    loadSkeletonPose(json) { return skeleton ? this.setSkeletonPose(poseFromJson(skeleton, json)) : null; },
    uncoveredRegions() { return skeleton && skeletonBinding ? uncoveredWedges(skeleton, skeletonBinding.pose) : []; },
    getParameters() { return { ...lastParameters }; },
    /** 0..1 loudness of the voice being played (e.g. normalised RMS). */
    setVoiceLevel(v) { motion.setVoiceLevel(v); },
    /** true while TTS audio is playing: idle motions pause and the head nods along. */
    setSpeaking(on) { motion.setSpeaking(on); },
    /** Microphone vowel (`a` `i` `u` `e` `o`), `m` while the lips close, or null. */
    setViseme(vowel) { motion.setViseme(vowel); },
    /** AITuber OnAir emotion tag: happy / sad / angry / surprised / relaxed / neutral (or null). */
    setEmotion(tag, opts) { motion.setEmotion(tag, opts); },
    /** Live expression layered over tracking (see OVERLAY_EXPRESSIONS); 'neutral' clears it. */
    setExpression(name) { expression.set(name); },
    getExpression() { return { name: expression.name, active: expression.active }; },
    /** How much the head moves with the voice while speaking (1 = default, calmer below). */
    setTalkGain(g) { motion.talkGain = Math.max(0, Number(g) || 0); },
    /** Play a motion or idle motion by id (see `motions`). */
    play(id) { if (motion.hasMotion(id)) motion.playMotion(id); },
    /** Move the mouth through the vowels of kana text (no audio; for previews). */
    speakKana(text, options) { motion.speakKana(String(text ?? ''), options); },
    holdMouth(vowel) { motion.holdMouth(vowel); },
    stopLipSync() { motion.stopLipSync(); },
    getLipSyncState() { return motion.getLipSyncState(); },
    setAutoIdle(on) { motion.autoIdle = !!on; },
    setLighting(value) { R.setLighting(value); },
    getLightingStats() { return { ...R.lightingStats }; },
    setAutoMotion(on) { motion.autoMotion = !!on; },
    /** Hair / tassel sway multiplier (1 = default). */
    setSwayGain(g) { physics.gain = g; },
    /** Called with the motion id when a motion starts and with null when it ends. */
    onMotion(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Advance the simulation by `sec` and draw (for tests / hidden tabs). */
    advance(sec, fps = 60) {
      if (destroyed) return;
      if (sec === 0) tick(0);
      else for (let i = 0; i < Math.round(sec * fps); i++) tick(1 / fps);
    },
    /** Update motion and lip sync without drawing a hidden preview. */
    advanceParameters(sec) { if (!destroyed) updateParameters(sec); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(raf);
      listeners.clear();
      R.destroy();
      // the GL context is not lost on purpose: the canvas may already be reused by a new
      // instance (React StrictMode mounts twice) and a canvas only ever has one context
    },
  };
}
