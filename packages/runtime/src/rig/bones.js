// Image-left is L, the same side as earL. A parent swing carries its children.
// Pose parameters are -1..1; each bone's maxBend is the rotation at +1.
export const FULL_BODY_BONES = [
  { name: 'torso', parent: null, param: 'torsoBend' },
  { name: 'hips', parent: null, param: 'hipSway' },
  { name: 'upperArmL', parent: 'torso', param: 'armL' },
  { name: 'lowerArmL', parent: 'upperArmL', param: 'forearmL' },
  { name: 'handL', parent: 'lowerArmL', param: 'wristL' },
  { name: 'upperArmR', parent: 'torso', param: 'armR' },
  { name: 'lowerArmR', parent: 'upperArmR', param: 'forearmR' },
  { name: 'handR', parent: 'lowerArmR', param: 'wristR' },
  { name: 'upperLegL', parent: 'hips', param: 'thighL' },
  { name: 'lowerLegL', parent: 'upperLegL', param: 'shinL' },
  { name: 'footL', parent: 'lowerLegL', param: 'footL' },
  { name: 'upperLegR', parent: 'hips', param: 'thighR' },
  { name: 'lowerLegR', parent: 'upperLegR', param: 'shinR' },
  { name: 'footR', parent: 'lowerLegR', param: 'footR' },
];

export const LIMB_PARAMS = [
  { id: 'torsoBend', label: 'Torso bend' },
  { id: 'hipSway', label: 'Hip sway' },
  { id: 'armL', label: 'Image-left arm' },
  { id: 'forearmL', label: 'Image-left forearm' },
  { id: 'wristL', label: 'Image-left wrist' },
  { id: 'armR', label: 'Image-right arm' },
  { id: 'forearmR', label: 'Image-right forearm' },
  { id: 'wristR', label: 'Image-right wrist' },
  { id: 'thighL', label: 'Image-left thigh' },
  { id: 'shinL', label: 'Image-left shin' },
  { id: 'footL', label: 'Image-left foot' },
  { id: 'thighR', label: 'Image-right thigh' },
  { id: 'shinR', label: 'Image-right shin' },
  { id: 'footR', label: 'Image-right foot' },
];
