/** Which drawing of a cut-out limb is showing. `front` is the painted side. */
export function partVisibility(part, pose = {}) {
  const twist = Math.abs(pose.twists?.[part.bone] ?? 0);
  const behind = (pose.drawOrder?.[part.bone] ?? 0) < 0;
  const curl = part.side ? (pose.hands?.[part.side] ?? 0) : 0;
  if (part.kind === 'hand' && curl > 0.62) return 'fist';
  // The torso, coat and skirt are the cut base itself. A face turn is not a body turn,
  // so nothing about them is swapped for another drawing.
  if (part.kind === 'torso' || part.kind === 'skirt') return 'front';
  if (behind || twist > 0.55) return 'back';
  return 'front';
}

const LIMBS = new Set(['upperArmL', 'lowerArmL', 'handL', 'upperArmR', 'lowerArmR', 'handR',
  'upperLegL', 'lowerLegL', 'footL', 'upperLegR', 'lowerLegR', 'footR']);
// Within a limb the parent is drawn over its child, so a shoulder covers the root of the
// upper arm, an elbow the root of the forearm, a cuff the wrist.
const chainRank = bone => (bone.startsWith('upper') ? 2 : bone.startsWith('lower') ? 1 : 0);
// A body yaw past this sends the far arm under the torso.
const YAW_BEHIND = 0.1;

/**
 * Cut-out limbs for a full-body avatar whose parts.json has a `cutout` base.
 * Limb parts move rigidly; the torso layers cut from the base (hidden sides under the
 * limbs, shoulder caps and hair over them) deform exactly like the base.
 * @param {ReturnType<import('./rig.js').createRig>} engine
 */
export function createCutout(R, sheet, images, helpers, engine, rig) {
  const { buildGrid, buildContourGrid, alphaOf, hairAt } = helpers;
  const cell = Math.max(4, Math.round((rig.mesh?.baseCell ?? 12) / 2));
  const torso = [];
  for (const [phase, names] of [['under', sheet.cutout.under ?? []], ['over', sheet.cutout.over ?? []]]) {
    for (const name of names) {
      const rect = sheet.layers?.[name], image = images[name];
      if (!rect || !image) continue;
      const mesh = buildGrid(rect, cell, alphaOf(image), image.width);
      const weights = [];
      for (let i = 0; i < mesh.rest.length / 2; i++) {
        const x = mesh.rest[i * 2], y = mesh.rest[i * 2 + 1];
        weights.push(engine.baseWeights(x, y, hairAt(x, y)));
      }
      torso.push({ phase, mesh, weights, layer: R.addLayer(`part:${name}`, image, mesh) });
    }
  }
  const parts = [];
  for (const binding of sheet.bindings ?? []) {
    if (!LIMBS.has(binding.bone)) continue;
    const views = [];
    for (const role of ['front', 'back', 'fist']) {
      const name = binding[role];
      const rect = name && sheet.layers?.[name];
      const image = name && images[name];
      if (!rect || !image) continue;
      const mesh = buildContourGrid(rect, cell, alphaOf(image), image.width, 2);
      const layer = R.addLayer(`part:${name}`, image, mesh);
      layer.visible = role === 'front';
      views.push({ role, mesh, layer });
    }
    if (views.length) parts.push({ ...binding, views, arm: !/Leg|foot/.test(binding.bone) });
  }
  const tmp = [0, 0];
  return {
    parts,
    update(P, phys, skeleton) {
      for (const t of torso) {
        const r = t.mesh.rest, o = t.mesh.pos;
        for (let i = 0; i < t.weights.length; i++) {
          engine.deformBase(r[i * 2], r[i * 2 + 1], t.weights[i], P, phys, tmp);
          o[i * 2] = tmp[0]; o[i * 2 + 1] = tmp[1];
        }
      }
      const drawOrder = skeleton?.drawOrder ?? {};
      const hands = skeleton?.hands ?? P.skeletonHands;
      for (const part of parts) {
        const role = partVisibility(part, { twists: P.skeletonTwist, drawOrder, hands });
        const shown = part.views.find(view => view.role === role) ?? part.views[0];
        const f = engine.partFrame(part.bone, P, phys);
        for (const view of part.views) {
          view.layer.visible = view === shown;
          if (view !== shown) continue;
          const r = view.mesh.rest, o = view.mesh.pos;
          for (let i = 0; i < r.length; i += 2) {
            o[i] = f.c * r[i] - f.s * r[i + 1] + f.tx;
            o[i + 1] = f.s * r[i] + f.c * r[i + 1] + f.ty;
          }
        }
        part.layer = shown.layer;
      }
      // Draw order, back to front: the torso's hidden sides, arms behind the body, the legs
      // (the skirt or coat covers their tops), the base, arms in front, then the torso's
      // shoulder caps and front hair. Each 'behind' lands just under the base and each
      // 'over' just under the face drawings, so calling them in order stacks them.
      const front = engine.frontSide(P);
      const turned = Math.abs(P.bodyAngleX ?? 0) / 10 > YAW_BEHIND;
      const armDepth = side => Math.max(...['upperArm', 'lowerArm', 'hand'].map(name => drawOrder[`${name}${side}`] ?? 0));
      const behind = part => part.arm && (armDepth(part.side) < 0 || (turned && front && part.side !== front));
      const byChain = (a, b) => chainRank(a.bone) - chainRank(b.bone);
      for (const t of torso) if (t.phase === 'under') R.placeLayer(t.layer.name, 'behind');
      const backArms = parts.filter(part => behind(part)).sort((a, b) => armDepth(a.side) - armDepth(b.side) || byChain(a, b));
      for (const part of backArms) R.placeLayer(part.layer.name, 'behind');
      for (const part of parts.filter(part => !part.arm).sort(byChain)) R.placeLayer(part.layer.name, 'behind');
      const frontArms = parts.filter(part => part.arm && !behind(part)).sort((a, b) => armDepth(a.side) - armDepth(b.side)
        || (front ? (a.side === front) - (b.side === front) : 0) || byChain(a, b));
      for (const part of frontArms) R.placeLayer(part.layer.name, 'over');
      for (const t of torso) if (t.phase === 'over') R.placeLayer(t.layer.name, 'over');
    },
  };
}
