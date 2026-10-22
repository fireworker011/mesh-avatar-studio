/** Which drawing of a split limb is showing. `front` is the painted side. */
export function partVisibility(part, pose = {}) {
  const twist = Math.abs(pose.twists?.[part.bone] ?? 0);
  const behind = (pose.drawOrder?.[part.bone] ?? 0) < 0;
  const curl = part.side ? (pose.hands?.[part.side] ?? 0) : 0;
  if (part.kind === 'hand' && curl > 0.62) return 'fist';
  if (part.kind === 'torso' || part.kind === 'skirt') return Math.abs(pose.angleX ?? 0) > 18 ? 'back' : 'front';
  if (behind || twist > 0.55) return 'back';
  return 'front';
}

/**
 * Optional limb drawings laid over a full-body avatar. Missing parts leave the
 * illustration as it was. A bust never has this file.
 * @param {ReturnType<import('./rig.js').createRig>} engine
 */
export function createBodyParts(R, sheet, images, buildGrid, alphaOf, baseWeights, deformBase, rig) {
  const cell = Math.max(4, Math.round((rig.mesh?.baseCell ?? 12) / 2));
  const parts = [];
  for (const binding of sheet.bindings ?? []) {
    const views = {};
    for (const role of ['front', 'back', 'fist']) {
      const name = binding[role];
      const rect = name && sheet.layers?.[name];
      const image = name && images[name];
      if (!name || !rect || !image) continue;
      const mesh = buildGrid(rect, cell, alphaOf(image), image.width);
      const weights = [];
      for (let i = 0; i < mesh.rest.length / 2; i++) {
        const base = baseWeights(mesh.rest[i * 2], mesh.rest[i * 2 + 1], 0);
        weights.push({ ...base, skeletonLimbs: [[binding.bone, 1]] });
      }
      const layer = R.addLayer(`part:${name}`, image, mesh);
      layer.visible = role === 'front' && binding.kind !== 'torso' && binding.kind !== 'skirt';
      views[role] = { mesh, weights, layer, role };
    }
    parts.push({ ...binding, views });
  }
  const tmp = [0, 0];
  // Inner bones are placed first. Each later insert sits just under the face, or just
  // under the body, so a hand stays in front of its sleeve.
  const depth = part => {
    const bone = part.bone ?? '';
    if (bone.startsWith('hand') || bone.startsWith('foot')) return 4;
    if (bone.startsWith('lower')) return 3;
    if (bone.startsWith('upper')) return 2;
    return part.kind === 'torso' ? 0 : 1;
  };
  return {
    update(parameters, physics, skeleton) {
      for (const part of [...parts].sort((a, b) => depth(a) - depth(b))) {
        const role = partVisibility(part, {
          twists: parameters.skeletonTwist,
          drawOrder: skeleton?.drawOrder,
          hands: skeleton?.hands ?? parameters.skeletonHands,
          angleX: parameters.angleX,
        });
        for (const view of Object.values(part.views)) {
          const show = view.role === role;
          view.layer.visible = show;
          if (!show) continue;
          const behindBody = (skeleton?.drawOrder?.[part.bone] ?? 0) < 0;
          const phase = role === 'back' && behindBody && part.kind !== 'torso' && part.kind !== 'skirt' ? 'behind' : 'over';
          R.placeLayer(view.layer.name, phase);
          const rest = view.mesh.rest, pos = view.mesh.pos;
          for (let i = 0; i < view.weights.length; i++) {
            deformBase(rest[i * 2], rest[i * 2 + 1], view.weights[i], parameters, physics, tmp);
            pos[i * 2] = tmp[0];
            pos[i * 2 + 1] = tmp[1];
          }
        }
      }
    },
  };
}
