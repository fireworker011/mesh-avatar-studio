import { expect, test } from 'vitest';
import fixture from '../samples/miko-qipao/rig.json';
import vest from '../samples/full-body-vest/rig.json';
import { PARAMS, parseRig, type Rig } from 'mesh-avatar';
import { createRig } from '../packages/runtime/src/engine/rig.js';
import { createPhysics, limitStrandDepth } from '../packages/runtime/src/engine/physics.js';

const defaults = Object.fromEntries(PARAMS.map(parameter => [parameter.id, parameter.def]));

function depthIn(point: number[], shape: { cx: number; cy: number; rx: number; ry: number }) {
  const radius = Math.hypot((point[0] - shape.cx) / shape.rx, (point[1] - shape.cy) / shape.ry);
  return radius >= 1 ? 0 : (1 - radius) * Math.min(shape.rx, shape.ry);
}

test('a strand point is not pushed deeper into the head, shoulders or chest than it rests', () => {
  const rig = parseRig(vest as Rig);
  const shapes = [rig.head, rig.body.chest, ...rig.body.shoulders];
  const head = rig.head;
  const rest = [head.cx + head.rx * 0.98, head.cy];
  const pushed = limitStrandDepth([head.cx + head.rx * 0.2, head.cy], rest, shapes);
  expect(depthIn(pushed, head)).toBeLessThanOrEqual(depthIn(rest, head) + 0.05);
  const inside = [head.cx + head.rx * 0.4, head.cy];
  const stayed = limitStrandDepth(inside, inside, shapes);
  expect(depthIn(stayed, head)).toBeLessThanOrEqual(depthIn(inside, head) + 0.05);
  const outward = limitStrandDepth([head.cx + head.rx * 1.4, head.cy], inside, shapes);
  expect(depthIn(outward, head)).toBeLessThanOrEqual(depthIn(inside, head) + 0.05);
});

test('full-body strand springs stay at or outside their rest depth in the body shapes', () => {
  const rig = parseRig(vest as Rig);
  const engine = createRig(rig, { cutout: true });
  const physics = new (createPhysics(engine, rig).Physics)();
  const shapes = [rig.head, rig.body.chest, ...rig.body.shoulders];
  const restDepth = rig.strands!.map(strand => strand.nodes.map(node => Math.max(...shapes.map(shape => depthIn(node, shape)))));
  for (let frame = 0; frame < 90; frame++) {
    const out = physics.step({
      ...defaults,
      angleZ: Math.sin(frame / 8) * 25,
      bodyAngleZ: Math.cos(frame / 10) * 8,
      angleX: Math.sin(frame / 12) * 20,
    }, 1 / 60) as unknown as { strands: number[][][] };
    out.strands.forEach((strand, index) => {
      strand.forEach((offset, node) => {
        const at = rig.strands![index].nodes[node];
        const point = [at[0] + offset[0], at[1] + offset[1]];
        const depth = Math.max(...shapes.map(shape => depthIn(point, shape)));
        expect(depth).toBeLessThanOrEqual(restDepth[index][node] + 0.25);
      });
    });
  }
  // The bust rig has no full-body shapes, so this limit is not part of its step.
  const bust = parseRig(fixture as Rig);
  expect(bust.fullBody).toBeUndefined();
  expect(createRig(bust).cutout).toBe(false);
});
