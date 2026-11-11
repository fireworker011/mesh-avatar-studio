import { useEffect, useMemo, useRef, useState } from 'react';
import { buildSkeleton, forwardKinematics, IK_CHAINS, jointLimits, PRESET_NAMES, restPose, type MeshAvatar, type Rig, type SkeletonPose } from 'mesh-avatar';
import { useI18n } from './i18n';

const DEG = 180 / Math.PI;
const PRESET_LABEL: Record<'en' | 'ja' | 'zh', Record<string, string>> = {
  en: { stand: 'Stand', walk: 'Walk', sit: 'Sit', wave: 'Wave', handsOnHips: 'Hands on hips', armsCrossed: 'Arms crossed', kneel: 'Kneel', bow: 'Bow', shrug: 'Shrug', lunge: 'Lunge' },
  ja: { stand: '立ち', walk: '歩き', sit: '座り', wave: '手を振る', handsOnHips: '腰に手', armsCrossed: '腕組み', kneel: 'ひざまずく', bow: 'お辞儀', shrug: '肩をすくめる', lunge: '踏み込み' },
  zh: { stand: '站立', walk: '行走', sit: '坐下', wave: '挥手', handsOnHips: '叉腰', armsCrossed: '抱臂', kneel: '跪', bow: '鞠躬', shrug: '耸肩', lunge: '弓步' },
};
const JOINT_LABEL: Record<'en' | 'ja' | 'zh', Record<string, string>> = {
  en: { pelvis: 'Pelvis', spine1: 'Spine 1', spine2: 'Spine 2', spine3: 'Spine 3', neck: 'Neck', head: 'Head', clavicleL: 'Clavicle L', clavicleR: 'Clavicle R', shoulderL: 'Shoulder L', shoulderR: 'Shoulder R', elbowL: 'Elbow L', elbowR: 'Elbow R', wristL: 'Wrist L', wristR: 'Wrist R', hipL: 'Hip L', hipR: 'Hip R', kneeL: 'Knee L', kneeR: 'Knee R', ankleL: 'Ankle L', ankleR: 'Ankle R' },
  ja: { pelvis: '骨盤', spine1: '背骨 1', spine2: '背骨 2', spine3: '背骨 3', neck: '首', head: '頭', clavicleL: '左鎖骨', clavicleR: '右鎖骨', shoulderL: '左肩', shoulderR: '右肩', elbowL: '左ひじ', elbowR: '右ひじ', wristL: '左手首', wristR: '右手首', hipL: '左股', hipR: '右股', kneeL: '左ひざ', kneeR: '右ひざ', ankleL: '左足首', ankleR: '右足首' },
  zh: { pelvis: '骨盆', spine1: '脊柱 1', spine2: '脊柱 2', spine3: '脊柱 3', neck: '颈', head: '头', clavicleL: '左锁骨', clavicleR: '右锁骨', shoulderL: '左肩', shoulderR: '右肩', elbowL: '左肘', elbowR: '右肘', wristL: '左腕', wristR: '右腕', hipL: '左髋', hipR: '右髋', kneeL: '左膝', kneeR: '右膝', ankleL: '左踝', ankleR: '右踝' },
};
const ARM = ['shoulderL', 'elbowL', 'wristL', 'shoulderR', 'elbowR', 'wristR'];
const LEG = ['hipL', 'kneeL', 'ankleL', 'hipR', 'kneeR', 'ankleR'];
const SPINE = ['pelvis', 'spine1', 'spine2', 'spine3', 'neck', 'head', 'clavicleL', 'clavicleR'];
const HANDLES = ['handL', 'handR', 'footL', 'footR', 'head'] as const;

function download(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function SkeletonControls({ rig, avatar, revision, poseEpoch, onPose }: {
  rig: Rig; avatar: MeshAvatar | null; revision: number; poseEpoch: number; onPose: () => void;
}) {
  const { t, language } = useI18n();
  const skeleton = useMemo(() => buildSkeleton(rig), [rig]);
  const limits = useMemo(() => skeleton ? jointLimits(skeleton) : [], [skeleton]);
  const [pose, setPose] = useState<SkeletonPose | null>(null);
  const [handle, setHandle] = useState<(typeof HANDLES)[number]>('handL');
  const [target, setTarget] = useState<[number, number]>([0, 0]);
  const [error, setError] = useState('');
  const poseFile = useRef<HTMLInputElement>(null);
  const keyFile = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setPose(avatar?.getSkeletonPose() ?? null);
    setError('');
  }, [avatar, revision, poseEpoch]);
  useEffect(() => {
    if (!skeleton) return;
    const chain = IK_CHAINS[handle];
    const world = forwardKinematics(skeleton, restPose(skeleton));
    const tip = world[chain.effector]?.tip ?? [rig.image.width / 2, rig.image.height / 3];
    setTarget([Math.round(tip[0]), Math.round(tip[1] - 80)]);
  }, [skeleton, handle, rig.image.width, rig.image.height]);
  if (!skeleton) return null;
  const shown = pose ?? restPose(skeleton);
  const byName = Object.fromEntries(limits.map(item => [item.name, item]));
  const apply = (next: SkeletonPose | null) => {
    const applied = avatar?.setSkeletonPose(next) ?? null;
    setPose(applied);
    setError('');
    onPose();
  };
  const setSwing = (name: string, degrees: number) => {
    const next = pose ?? restPose(skeleton);
    next.joints[name] = { ...(next.joints[name] ?? { swing: 0, twist: 0 }), swing: degrees / DEG };
    apply(next);
  };
  const groups = [
    [t.skeletonArms, ARM],
    [t.skeletonLegs, LEG],
    [t.skeletonSpine, SPINE],
    [t.skeletonFingers, limits.map(item => item.name).filter(name => name.startsWith('finger'))],
  ] as const;
  const sliders = (names: readonly string[]) => (
    <div className="sliders">
      {names.filter(name => byName[name]).map(name => {
        const limit = byName[name];
        const swing = shown.joints[name]?.swing ?? 0;
        return (
          <label key={name}>{JOINT_LABEL[language][name] ?? name}
            <input type="range" aria-label={JOINT_LABEL[language][name] ?? name}
              min={Math.round(limit.swingMin * DEG)} max={Math.round(limit.swingMax * DEG)} step="1"
              value={Math.round(swing * DEG)}
              onChange={event => setSwing(name, Number(event.target.value))} />
            <output>{Math.round(swing * DEG)}°</output>
          </label>
        );
      })}
    </div>
  );
  const readJson = async (file: File, mode: 'pose' | 'keypoints') => {
    try {
      const value = JSON.parse(await file.text());
      if (!avatar) return;
      const applied = mode === 'pose' ? avatar.loadSkeletonPose(value) : avatar.poseFromKeypoints(value);
      setPose(applied);
      setError('');
      onPose();
    } catch {
      setError(t.poseError);
    }
  };
  return (
    <details className="limb-sliders skeleton-pose" data-testid="skeleton-pose">
      <summary>{t.skeletonPose}</summary>
      <div className="skeleton-body">
        <p className="skeleton-help">{t.skeletonHelp}</p>
        <div className="skeleton-presets" role="group" aria-label={t.skeletonPose}>
          {PRESET_NAMES.map(name => (
            <button key={name} type="button" onClick={() => { const applied = avatar?.applyPosePreset(name) ?? null; setPose(applied); setError(''); onPose(); }}>
              {PRESET_LABEL[language][name] ?? name}
            </button>
          ))}
        </div>
        {sliders(groups[0][1])}
        {groups.slice(1).filter(([, names]) => names.some(name => byName[name])).map(([title, names]) => (
          <details key={title}><summary>{title}</summary>{sliders(names)}</details>
        ))}
        <div className="skeleton-ik">
          <select aria-label={t.ikEffector} value={handle} onChange={event => setHandle(event.target.value as (typeof HANDLES)[number])}>
            {HANDLES.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
          <input aria-label={`${t.ikReach} x`} type="number" value={target[0]} onChange={event => setTarget([Number(event.target.value), target[1]])} />
          <input aria-label={`${t.ikReach} y`} type="number" value={target[1]} onChange={event => setTarget([target[0], Number(event.target.value)])} />
        </div>
        <div className="skeleton-actions">
          <button type="button" onClick={() => apply(avatar?.solveSkeletonIk({ effector: handle, target, method: 'ccd' }) ?? null)}>{t.ikCcd}</button>
          <button type="button" onClick={() => apply(avatar?.solveSkeletonIk({ effector: handle, target, method: 'fabrik' }) ?? null)}>{t.ikFabrik}</button>
          <button type="button" disabled={!pose} onClick={() => { const json = avatar?.getSkeletonPoseJson(); if (json) download('pose.json', json); }}>{t.savePose}</button>
          <button type="button" onClick={() => poseFile.current?.click()}>{t.loadPose}</button>
          <button type="button" onClick={() => keyFile.current?.click()}>{t.loadKeypoints}</button>
        </div>
        <input ref={poseFile} hidden type="file" accept="application/json,.json" aria-label={t.loadPose} onChange={event => { const file = event.target.files?.[0]; if (file) void readJson(file, 'pose'); event.target.value = ''; }} />
        <input ref={keyFile} hidden type="file" accept="application/json,.json" aria-label={t.loadKeypoints} onChange={event => { const file = event.target.files?.[0]; if (file) void readJson(file, 'keypoints'); event.target.value = ''; }} />
        {error && <p className="skeleton-help" role="alert">{error}</p>}
      </div>
    </details>
  );
}
