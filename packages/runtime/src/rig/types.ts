export type Point = [number, number];
export type Band = [number, number];
export interface Ellipse { cx: number; cy: number; rx: number; ry: number }
export interface Eye {
  opening: Point[];
  roi: Point[];
  x0: number;
  x1: number;
  top: number[];
  bot: number[];
}
export interface Strand {
  name: string;
  nodes: Point[];
  sigma: number;
  k: number;
  max: number;
}
export interface Accessory {
  name: string;
  pivot: Point;
  tip: Point;
  split: number;
  box: [number, number, number, number];
  color: { redness: number; minRed: number };
}
export type FullBodyBoneName =
  | 'torso' | 'hips'
  | 'upperArmL' | 'lowerArmL' | 'handL'
  | 'upperArmR' | 'lowerArmR' | 'handR'
  | 'upperLegL' | 'lowerLegL' | 'footL'
  | 'upperLegR' | 'lowerLegR' | 'footR';
/** One limb segment. Positive maxBend rotates a downward tip toward image-left. */
export interface LimbBone {
  pivot: Point;
  tip: Point;
  radius: number;
  maxBend: number;
}
export interface FullBody {
  bones: Record<FullBodyBoneName, LimbBone>;
  /** Idle pose amplitude, 0–1. */
  sway: number;
  /** How strongly the arms follow body roll, 0–1. */
  armFollow: number;
  /** Optional finger chains, wrist outward. Each step is a hinge. Omit to keep the hand one bone. */
  fingers?: { L?: Point[]; R?: Point[] };
}
export interface Hand {
  outline: Point[];
  jaw: Point[];
  jawRange: Band;
  background: Point[];
  elbow: Point;
  wrist: Point;
  knuckle: Point;
  contact: Point;
  forearmShare: number;
  armBand: Band;
  wristBand: Band;
  handBand: Band;
  fingerXBand: Band;
  fingerYBand: Band;
  pinBand: Band;
}
export interface Rig {
  version: 1;
  image: { width: number; height: number };
  head: Ellipse & {
    shiftX: number; shiftY: number; pivotX: number; pivotY: number;
    maxRoll: number; weightBand: Band; turnBand: Band;
  };
  body: {
    pivotX: number; pivotY: number; maxRoll: number;
    breathBand: Band; rollBand: Band; chest: Ellipse; shoulders: Ellipse[];
  };
  face: Record<'nose' | 'mouth' | 'eyeA' | 'eyeB' | 'earL' | 'earR', Ellipse> & {
    brow: Ellipse & { band: Band };
    jaw: Ellipse & { band: Band };
  };
  buns?: Partial<Record<'bunL' | 'bunR', Ellipse>>;
  eyes: Eye[];
  mouth: {
    cx: number; cy: number; angle: number; halfLen: number; bow: number;
    area: Ellipse & { angle: number };
  };
  cheeks: Point[];
  strands?: Strand[];
  accessories?: Accessory[];
  hand?: Hand;
  /** Present on full-body avatars. Omitted bust avatars render unchanged. */
  fullBody?: FullBody;
  mesh: {
    baseCell: number;
    fine: { x0: number; x1: number; y0: number; y1: number; cell: number };
    handCell: number; tasselCell: number; eyeBallCell: number;
    eyeCell: number; spriteCell: number;
  };
  view: { padTop: number; padSide: number; gazeCenter?: Point };
}
