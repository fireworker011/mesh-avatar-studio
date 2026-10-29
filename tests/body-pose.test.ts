import { expect, test } from 'vitest';
import { buildSkeleton, poseFromKeypoints, type Rig } from 'mesh-avatar';
import vest from '../samples/full-body-vest/rig.json';
import { BodyDriver, poseRowsToBody25 } from '../src/live/body-pose';

function raisedRows() {
  const rows = Array.from({ length: 33 }, () => [0.5, 0.5, 0, 0]);
  const put = (index: number, x: number, y: number) => { rows[index] = [x, y, 0, 1]; };
  put(0, 0.5, 0.2);
  put(11, 0.62, 0.35); put(13, 0.62, 0.5); put(15, 0.62, 0.62);
  put(12, 0.38, 0.35); put(14, 0.22, 0.18); put(16, 0.18, 0.08);
  put(23, 0.58, 0.62); put(25, 0.58, 0.78); put(27, 0.58, 0.92);
  put(24, 0.42, 0.62); put(26, 0.42, 0.78); put(28, 0.42, 0.92);
  return rows;
}

test('pose rows become OpenPose BODY_25 and a mirrored preview raises image-right', () => {
  const rows = raisedRows();
  const flat = poseRowsToBody25(rows);
  expect(flat).toHaveLength(75);
  expect(flat![2 * 3]).toBeCloseTo(0.38);
  const skeleton = buildSkeleton(vest as Rig)!;
  const mirrored = poseFromKeypoints(skeleton, { pose_keypoints_2d: flat }, { facing: 'same' });
  expect(Math.abs(mirrored.joints.shoulderR.swing)).toBeGreaterThan(Math.abs(mirrored.joints.shoulderL.swing) + 0.4);
  const calls: unknown[] = [];
  const avatar = {
    fullBody: true,
    trackBody(input: unknown, options?: { facing?: 'camera' | 'same'; format?: 'mediapipe'; smoothing?: number; dt?: number }) {
      calls.push(options);
      return poseFromKeypoints(skeleton, input as object, options);
    },
    poseFromKeypoints(input: unknown, options?: { facing?: 'camera' | 'same' }) { return poseFromKeypoints(skeleton, input as object, options); },
    setSkeletonPose() { return null; },
  };
  const driver = new BodyDriver();
  driver.update({ faceLandmarks: [], faceBlendshapes: [], facialTransformationMatrixes: [], poseLandmarks: rows, hands: [{ side: 'Right', landmarks: [[0, 0, 0]] }] }, 1000);
  const pose = driver.apply(avatar, 1200, 1 / 30, { mirror: true, sensitivity: 1, smoothing: 0.35 });
  expect(calls[0]).toMatchObject({ facing: 'same', format: 'mediapipe' });
  expect(pose).toBeTruthy();
  driver.apply({ ...avatar, fullBody: false }, 1300, 1 / 30, { mirror: true, sensitivity: 1, smoothing: 0.35 });
  expect(calls).toHaveLength(1);
});
