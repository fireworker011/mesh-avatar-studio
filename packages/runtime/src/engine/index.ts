import type { LightingSettings } from '../lighting/settings';
import type { Rig } from '../rig/types';
import { parseRig } from '../rig/validate';
import { createMeshAvatarImpl } from './createMeshAvatar.js';
import { OVERLAY_EXPRESSIONS } from './expression-overlay.js';

export type LiveExpression = keyof typeof OVERLAY_EXPRESSIONS;
export const LIVE_EXPRESSIONS = Object.keys(OVERLAY_EXPRESSIONS) as LiveExpression[];

export interface MeshAvatarOptions {
  rig: Rig;
  assetsBase?: string;
  assets?: Record<string, string>;
  manual?: boolean;
  padTop?: number;
  padSide?: number;
  fit?: 'contain' | 'cover';
  preserveMouthForm?: boolean;
}
export interface SkeletonJointPose { swing: number; twist: number }
export interface SkeletonPose {
  joints: Record<string, SkeletonJointPose>;
  drawOrder: Record<string, number>;
  /** Fist curl, 0 open to 1 closed. Present when a hand observation set it. */
  hands?: { L: number; R: number };
  /** Rig-pixel shift of the whole body. Present when foot contact or hip tracking sets it. */
  translation?: [number, number];
}
export interface SkeletonPoseFile extends SkeletonPose {
  format: 'mesh-avatar-pose';
  version: 1;
}
export interface SkeletonIkGoal {
  /** `handL`, `handR`, `footL`, `footR`, `head`, or a joint name when `root` is set. */
  effector: string;
  target: [number, number];
  root?: string;
  method?: 'ccd' | 'fabrik';
  iterations?: number;
}
export interface UncoveredRegion {
  joint: string;
  swing: number;
  polygon: [number, number][];
}
export interface MeshAvatar {
  readonly motions: { id: string; label: string; idle: boolean }[];
  readonly imageSize: { width: number; height: number };
  readonly fullBody: boolean;
  setLighting(settings: Partial<LightingSettings>): void;
  getLightingStats(): { normalMs: number; computedLayers: number; cachedLayers: number };
  setParameters(parameters: Record<string, number>, weight?: number): void;
  getParameters(): Record<string, number>;
  setVoiceLevel(value: number): void;
  setSpeaking(on: boolean): void;
  /** Microphone vowel. `m` closes the lips. Null returns the mouth to the camera or to volume lip sync. */
  setViseme(vowel: 'a' | 'i' | 'u' | 'e' | 'o' | 'm' | null): void;
  setEmotion(tag: string | null, options?: { playMotion?: boolean }): void;
  setExpression(name: LiveExpression): void;
  getExpression(): { name: LiveExpression; active: boolean };
  setTalkGain(gain: number): void;
  play(id: string): void;
  speakKana(text: string, options?: { speed?: number; loop?: boolean }): void;
  holdMouth(vowel: 'a' | 'i' | 'u' | 'e' | 'o' | 'n'): void;
  stopLipSync(): void;
  getLipSyncState(): { active: boolean; open: number; form: number };
  setAutoIdle(on: boolean): void;
  setAutoMotion(on: boolean): void;
  setSwayGain(gain: number): void;
  /** Anatomical pose. Null clears it and returns the avatar to the legacy limb sliders. A bust returns null. */
  setSkeletonPose(pose: SkeletonPose | null): SkeletonPose | null;
  getSkeletonPose(): SkeletonPose | null;
  applyPosePreset(name: string): SkeletonPose | null;
  solveSkeletonIk(goal: SkeletonIkGoal): SkeletonPose | null;
  poseFromKeypoints(input: unknown, options?: { facing?: 'camera' | 'same'; format?: 'mediapipe' | 'openpose' | 'coco'; smoothing?: number; dt?: number }): SkeletonPose | null;
  /** Camera pose with held low-confidence joints and smoothing. A bust returns null. */
  trackBody(input: unknown, options?: { facing?: 'camera' | 'same'; format?: 'mediapipe' | 'openpose' | 'coco'; smoothing?: number; dt?: number; hands?: { side?: string; landmarks?: number[][] }[] }): SkeletonPose | null;
  resetBodyTrack(): SkeletonPose | null;
  getSkeletonPoseJson(): SkeletonPoseFile | null;
  loadSkeletonPose(json: unknown): SkeletonPose | null;
  /** Polygons of the illustration a large swing uncovers. Empty when no anatomical pose is set. */
  uncoveredRegions(): UncoveredRegion[];
  onMotion(listener: (id: string | null) => void): () => void;
  advance(seconds: number, fps?: number): void;
  advanceParameters(seconds: number): void;
  destroy(): void;
}

export async function createMeshAvatar(
  canvas: HTMLCanvasElement,
  options: MeshAvatarOptions,
): Promise<MeshAvatar> {
  return createMeshAvatarImpl(canvas, { ...options, rig: parseRig(options.rig) });
}
