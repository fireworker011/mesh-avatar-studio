import { parameterRanges } from './tracking';

export const LIVE_EVENT = 'studio:live-params';
export interface LivePoseWire {
  format: 'mesh-avatar-pose';
  version: 1;
  joints: Record<string, { swing: number; twist: number }>;
  drawOrder: Record<string, number>;
  translation?: [number, number];
  hands?: { L: number; R: number };
}
export interface LiveMessage { project: string; params: Record<string, number>; t: number; sender?: string; pose?: LivePoseWire | null }
const POSE_KEYS = new Set(['format', 'version', 'joints', 'drawOrder', 'translation', 'hands']);
function finite(value: unknown, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : null;
}
/** A skeleton pose small enough to relay, or null when the camera has no body. Invalid shapes reject the whole message. */
function livePose(value: unknown): LivePoseWire | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !POSE_KEYS.has(key)) || data.format !== 'mesh-avatar-pose' || data.version !== 1) return undefined;
  if (!data.joints || typeof data.joints !== 'object' || Array.isArray(data.joints)) return undefined;
  const names = Object.keys(data.joints);
  if (!names.length || names.length > 48) return undefined;
  const joints: LivePoseWire['joints'] = {};
  for (const name of names) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,23}$/.test(name)) return undefined;
    const joint = (data.joints as Record<string, unknown>)[name];
    if (!joint || typeof joint !== 'object' || Array.isArray(joint)) return undefined;
    const record = joint as Record<string, unknown>;
    if (Object.keys(record).some(key => key !== 'swing' && key !== 'twist')) return undefined;
    const swing = finite(record.swing, -4, 4), twist = finite(record.twist, -2, 2);
    if (swing === null || twist === null) return undefined;
    joints[name] = { swing, twist };
  }
  const drawOrder: Record<string, number> = {};
  if (data.drawOrder !== undefined) {
    if (!data.drawOrder || typeof data.drawOrder !== 'object' || Array.isArray(data.drawOrder)) return undefined;
    for (const [name, depth] of Object.entries(data.drawOrder)) {
      const clamped = finite(depth, -8, 8);
      if (!/^[A-Za-z][A-Za-z0-9]{0,23}$/.test(name) || clamped === null) return undefined;
      drawOrder[name] = clamped;
    }
  }
  const pose: LivePoseWire = { format: 'mesh-avatar-pose', version: 1, joints, drawOrder };
  if (data.translation !== undefined) {
    if (!Array.isArray(data.translation) || data.translation.length !== 2) return undefined;
    const x = finite(data.translation[0], -4000, 4000), y = finite(data.translation[1], -4000, 4000);
    if (x === null || y === null) return undefined;
    pose.translation = [x, y];
  }
  if (data.hands !== undefined) {
    if (!data.hands || typeof data.hands !== 'object' || Array.isArray(data.hands)) return undefined;
    const hands = data.hands as Record<string, unknown>;
    if (Object.keys(hands).some(key => key !== 'L' && key !== 'R')) return undefined;
    const left = finite(hands.L ?? 0, 0, 1), right = finite(hands.R ?? 0, 0, 1);
    if (left === null || right === null) return undefined;
    pose.hands = { L: left, R: right };
  }
  return pose;
}
export function liveMessage(input: unknown): LiveMessage | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const data = input as Record<string, unknown>;
  if (Object.keys(data).some(key => !['project', 'params', 't', 'sender', 'pose'].includes(key)) ||
      (data.sender !== undefined && (typeof data.sender !== 'string' || !/^[a-z0-9]{8,32}$/.test(data.sender))) ||
      typeof data.project !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(data.project) ||
      typeof data.t !== 'number' || !Number.isFinite(data.t) || data.t < 0 ||
      !data.params || typeof data.params !== 'object' || Array.isArray(data.params)) return null;
  const pose = livePose(data.pose);
  if (data.pose !== undefined && pose === undefined) return null;
  const entries = Object.entries(data.params);
  if (!entries.length || entries.length > parameterRanges.size) return null;
  const params: Record<string, number> = {};
  for (const [key, value] of entries) {
    const range = parameterRanges.get(key);
    if (!range || typeof value !== 'number' || !Number.isFinite(value)) return null;
    params[key] = Math.max(range[0], Math.min(range[1], value));
  }
  return { project: data.project, params, t: data.t, ...(typeof data.sender === 'string' ? { sender: data.sender } : {}), ...(data.pose !== undefined ? { pose } : {}) };
}

export class LivePose {
  private received = -Infinity;
  private params: Record<string, number> = {};
  private pose: LivePoseWire | null | undefined;
  private weight = 0;
  constructor(private project: string) {}
  private sender: string | undefined;
  receive(input: unknown, now: number) {
    const message = liveMessage(input);
    if (!message || message.project !== this.project) return false;
    // With two Live pages open for one project, follow one of them until it goes quiet;
    // alternating between their poses makes the avatar flicker.
    if (message.sender !== this.sender && now - this.received <= 1000) return false;
    this.sender = message.sender; this.params = message.params; this.received = now;
    if ('pose' in message) this.pose = message.pose;
    return true;
  }
  sample(now: number, dt: number) {
    // Sender timestamps come from another browser clock. Use local receipt time.
    const active = now - this.received <= 1000;
    this.weight = active ? 1 : this.weight * Math.exp(-Math.max(0, dt) / 0.2);
    if (this.weight < 0.005) this.weight = 0;
    return { active, params: this.params, weight: this.weight, pose: this.pose };
  }
}
