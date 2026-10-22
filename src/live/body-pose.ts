import type { FaceResult, TrackingOptions } from './tracking';

/** MediaPipe Pose rows are `[x, y, z, visibility]` in camera-normalized coordinates. */
export function poseRowsToBody25(rows: number[][]): number[] | null {
  if (rows.length < 33) return null;
  const flat = Array.from({ length: 25 * 3 }, () => 0);
  const put = (index: number, row: number[] | null) => {
    if (!row || row.length < 2) return;
    flat[index * 3] = row[0];
    flat[index * 3 + 1] = row[1];
    flat[index * 3 + 2] = row[3] ?? row[2] ?? 0;
  };
  const mid = (a: number, b: number) => {
    const left = rows[a], right = rows[b];
    if (!left || !right) return null;
    return [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2, 0, Math.min(left[3] ?? 0, right[3] ?? 0)];
  };
  // OpenPose BODY_25. Person-left is MediaPipe 11/13/15; person-right is 12/14/16.
  put(0, rows[0]);
  put(1, mid(11, 12));
  put(2, rows[12]); put(3, rows[14]); put(4, rows[16]);
  put(5, rows[11]); put(6, rows[13]); put(7, rows[15]);
  put(8, mid(23, 24));
  put(9, rows[24]); put(10, rows[26]); put(11, rows[28]);
  put(12, rows[23]); put(13, rows[25]); put(14, rows[27]);
  put(19, rows[31]); put(21, rows[29]);
  put(22, rows[32]); put(24, rows[30]);
  return flat;
}

interface PosableAvatar {
  fullBody: boolean;
  trackBody?(input: unknown, options?: { facing?: 'camera' | 'same'; format?: 'mediapipe'; smoothing?: number; dt?: number; hands?: FaceResult['hands'] }): unknown;
  poseFromKeypoints(input: unknown, options?: { facing?: 'camera' | 'same' }): unknown;
  setSkeletonPose(pose: null): unknown;
  resetBodyTrack?(): unknown;
}

/** Holds the latest body observation and applies it to a full-body avatar. A bust is left untouched. */
export class BodyDriver {
  private rows: number[][] | null = null;
  private hands: NonNullable<FaceResult['hands']> = [];
  private seen = -Infinity;
  private applied = false;
  update(result: FaceResult, now: number) {
    if (result.poseLandmarks?.length) {
      this.rows = result.poseLandmarks;
      this.hands = result.hands ?? [];
      this.seen = now;
    }
  }
  reset() {
    this.rows = null;
    this.hands = [];
    this.seen = -Infinity;
    this.applied = false;
  }
  apply(avatar: PosableAvatar, now: number, dt: number, options: TrackingOptions) {
    if (!avatar.fullBody) return null;
    if (!this.rows || now - this.seen > 500) {
      if (this.applied) {
        if (avatar.resetBodyTrack) avatar.resetBodyTrack();
        else avatar.setSkeletonPose(null);
        this.applied = false;
      }
      return null;
    }
    // A mirrored preview shows the person's right on the viewer's right, which is our image-right.
    const facing = options.mirror ? 'same' as const : 'camera' as const;
    const pose = avatar.trackBody
      ? avatar.trackBody(
        { keypoints: this.rows.flat(), hands: this.hands },
        { format: 'mediapipe', facing, smoothing: options.smoothing, dt, hands: this.hands },
      )
      : avatar.poseFromKeypoints(
        { pose_keypoints_2d: poseRowsToBody25(this.rows), hands: this.hands },
        { facing },
      );
    this.applied = pose != null;
    return pose;
  }
}
