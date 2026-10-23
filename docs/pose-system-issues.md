# Posing one illustration

A full-body avatar is still one painted picture on one mesh. The anatomical pose in
`packages/runtime/src/pose/skeleton.js` can aim that picture at a requested stance.
It cannot invent the pixels the picture never had. This note lists the blockers,
the options, what the runtime actually does, and the sources it learned from
without copying.

Bust avatars omit `fullBody`. They never build a skeleton, and a full-body avatar
that never calls `setSkeletonPose` keeps the older limb sliders. Both paths are
what the 0 px bust regression measures.

## Cut-out limbs

A full-body sample whose `parts/parts.json` has a `cutout` section does not skin
the torso, coat or skirt to the limb bones. Those stay the painted picture.
Each limb is one rigid piece about its drawn joints. The parent is drawn over
the child's root, a shoulder cap and the front hair are drawn over the arms, and
a body yaw slides the near arm, the torso and the far arm apart in depth. Twist
does not squash a cut-out. A closed hand, or a limb turned away, swaps in another
drawing of the same cut-out. Cloth that was hidden at rest — under a sleeve, a
skirt, a coat or long hair — is continued from that part's own pixels.

Bust avatars, and a full-body avatar without `cutout`, still use the single mesh
described below.

Hair on a full-body rig may sway, but a strand point is not allowed to sit
deeper inside the head, shoulder or chest ellipses than the drawing placed it.
That limit does not move chest or clothing pixels. Chest collision, pushing the
painted chest, is not implemented. The photo sample's hair mask used to cover
the shirt because the back strands ran down the placket; the mask now keeps the
dark hair only, so the shirt does not sway with it. The strand polylines
themselves are unchanged.

## Blockers, and the options for each

### Occluded and unpainted regions

A front view does not contain the back of the arm, the inside of a skirt, or the
palm. A large swing slides those texels away and shows whatever was behind them,
which is often background or another body part.

Options:

- Split the art into layers and inpaint the hidden side before it is ever posed.
- Keep a second sprite (a turned arm, a fist) and swap it in when the angle passes a threshold.
- Leave the hole. The runtime can only report it.

What we do: a cut-out avatar continues the hidden cloth from the part's own
pixels and can swap a back or fist drawing. `uncoveredRegions()` still returns a
polygon for each joint whose swing passes about 20°. The single mesh, used when
there is no `cutout` section, does not invent skin, cloth, or a hand.

### Self-overlap and draw order

Crossed arms need the near limb painted over the far one. A single mesh has one
triangle order, chosen when the grid was built.

Options:

- Cut each limb into its own sprite and swap that sprite's z-order.
- Re-sort the existing triangles by a per-bone depth.
- Accept the overlap and let the original painter's order win.

What we do: an anatomical pose may set `drawOrder` (bone name to a number).
Triangles are re-sorted by the highest depth of their three vertices. Equal
depth keeps the original order, so an empty draw order does not move triangles.
`armsCrossed` puts the image-left arm in front. This is not a second sprite.
A limb that was painted underneath another limb in the source still carries that
paint.

### Foreshortening

A limb pointing at the camera gets shorter in the picture, and its outline
changes. A flat painting has no volume to turn toward the camera.

Options:

- Multi-view sprites (front, three-quarter, side), blended or swapped.
- A 2.5D depth offset, with a real side drawing.
- Scale the limb perpendicular to the bone as a stand-in for twist.

What we do: on the single mesh, twist scales the cross-section by `cos(twist)`
about the posed bone. A cut-out limb does not squash; past the threshold it
shows the back drawing instead. Elbows, knees, and fingers have twist clamped
to 0, because a hinge does not spin the painting around the bone. The scale on
the single mesh is not a rotation of the artwork. Past a small angle it looks
like a squash.

### Cloth and skirt

A skirt is a surface, not a bone. Bending the hips should fold cloth, open a
hem, and keep the legs inside it. Skinning the skirt texels to the thigh bones
drags the hem along as if it were skin.

Options:

- A cloth simulation, or a few extra skirt bones authored on the hem.
- A separate skirt layer with its own weights.
- Leave the skirt on the thigh and hip weights.

What we do: without `cutout`, the skirt stays on the hip and thigh weights.
There is no cloth solver. A deep knee bend will smear or tear the hem. With
`cutout`, the coat and skirt stay in the base and the leg turns underneath
them. Hair keeps the existing strand springs. On a full-body rig those points
cannot sink further into the head, shoulders or chest than they were drawn.
They do not push the chest. Strands are still short springs, not a hair groom.

### Hands and fingers

The hand in the sample is one bone from the wrist to the fingertips. Fingers
that curl need a chain, and they need to have been drawn.

Options:

- Author `fullBody.fingers.L` and `.R` as polylines and hinge each segment.
- Swap in a drawn fist or open hand.
- Leave the hand rigid.

What we do: optional finger hinges, parented to the wrist, flexion 90° and
hyperextension 15°, twist 0. The vest sample does not author fingers, so its
hands stay one bone. A cut-out hand can swap to a fist drawing made by pulling
the same hand in toward the knuckles. That drawing is not a new hand.

### Hair

Long hair should pass behind the shoulders in one pose and in front in another,
and it should not rotate as a rigid board when the head turns.

Options:

- The strand springs already in the runtime.
- Extra hair layers with their own draw order.
- A groom or a neural warp.

What we do: the existing springs. An anatomical head or spine pose moves the
anchor. It does not grow new strands, and a 30° head turn still warps a flat
painting. The vest sample's strands are capped at 10 px.

### Rotation past about 30°

The bust path was built for a head turn of about ±30°. A shoulder or hip can
legally move much further. The texture then stretches across the joint, and the
silhouette stops matching a body.

Options:

- Multi-view art.
- Part layers, so the upper arm texture rotates as a whole instead of shearing a
  patch of the torso.
- Stop the slider earlier than the anatomical limit.

What we do: the joint limit is the anatomical one, not 30°. The deformation is
still one texture. Expect warping, holes, and a wrong silhouette as the pose
leaves the drawing. The limit stops an impossible joint. It does not make the
picture hold together.

### Mesh tearing

Two bones that meet in the picture can pull apart when their parents differ.
The sharp case is a bow: the spine flexes and the legs stay on the pelvis, so
the waist can open. A vertex weighted to both bones stretches instead.

Options:

- Overlapping weights across the waist, which is what the skeleton weights do.
- A dedicated waist bone that both the spine and the legs inherit.
- Part layers with a drawn overlap at the seam.

What we do: three spine bones share the torso texture, and the legs are parented
to the hips, not to the spine. Neighbouring weights overlap, and a hinge gets a
small radial push (`1 - cos(|angle)|`, inside about half a radius) so the joint
does not pinch to a point. That push is volume-ish. It is not a 3D volume
preservation, and a deep bow can still gap at the waist.

## What the pose API does

The skeleton is pelvis, three spine joints, neck, head, clavicle, shoulder,
elbow, wrist, hip, knee, ankle, on each side, plus optional fingers. Image-left
is L. Swing is radians added to the illustrated bone. Positive swing rotates a
downward bone toward image-left, the same sign as the older limb bend.

`setSkeletonPose` takes `{ joints: { name: { swing, twist } }, drawOrder }` and
clamps it. `null` clears the pose and the limb sliders work again. Presets:
stand, walk, sit, wave, hands on hips, arms crossed, kneel, bow, shrug, lunge.
Stand is an explicit zero pose; it still replaces the limb sliders until reset.

IK handles are `handL`, `handR`, `footL`, `footR`, and `head`. The default
solver is cyclic coordinate descent (CCD; Wang and Chen, IEEE Transactions on
Robotics and Automation, 1991). `method: "fabrik"` uses FABRIK (Aristidou and
Lasenby, Graphical Models, 2011) and writes the result back as clamped swings.
Both stay inside the joint limits. There is no 3D pole vector. A target the
bones cannot reach is left at the closest limited pose.

`poseFromKeypoints` reads OpenPose BODY_25 (`pose_keypoints_2d`, 25×3 with a
confidence) or COCO-17 (`keypoints`). The default `facing: "camera"` maps a
front-facing person's right, which appears on the image left, onto our L.
`facing: "same"` uses the names as written. A confidence below 0.05 leaves that
joint at rest. This does not run OpenPose. It only retargets JSON the caller
already has. The solver is not the OpenPose code.

`getSkeletonPoseJson` / `loadSkeletonPose` use
`{ format: "mesh-avatar-pose", version: 1, joints, drawOrder }`.

The editor exposes the presets, a forward-kinematics slider per joint (degrees,
clamped), the two IK solvers, and save / load for a pose file or a keypoint file.
Those controls appear only when the rig has `fullBody`.

## Range of motion

Numbers are population means in degrees from the anatomical position, used here
as the allowed in-plane swing. They are not a promise about one person, and a
front-view painting cannot perform the out-of-plane part of a clinical range.
Abduction of the shoulder, for example, leaves the picture plane; the degrees
below are the size of the clamp, not a claim that the 2D swing is that anatomical
motion.

| Joint | Swing | Twist |
|---|---|---|
| Pelvis | ±15 | ±10 |
| Each spine joint | ±20 | ±15 |
| Neck | ±45 | ±40 |
| Head | ±25 | ±30 |
| Clavicle | up 45, down 10 | ±15 |
| Shoulder | abduction 170, adduction 30, measured from straight down | ±90 |
| Elbow | flexion 150, hyperextension 10, hinge | 0 |
| Wrist | flexion 80, extension 70 | ±25 |
| Hip | abduction 45, adduction 30, measured from straight down | ±40 |
| Knee | flexion 135, hyperextension 10, hinge | 0 |
| Ankle | dorsiflexion 20, plantarflexion 50 | ±20 |
| Finger | flexion 90, hyperextension 15, hinge | 0 |

Image-left elbow, knee, and finger flexion is a negative swing. Image-right
flexion is a positive swing. Three spine joints at ±20° are a stand-in for a
lumbar-sized bend split along the torso, not three independently measured levels.

Sources for the degree values:

- American Academy of Orthopaedic Surgeons. *Joint Motion: Method of Measuring and Recording.* 1965.
- Walter B. Greene, James D. Heckman, editors. *The Clinical Measurement of Joint Motion.* American Academy of Orthopaedic Surgeons, 1994.
- Cynthia C. Norkin, D. Joyce White. *Measurement of Joint Motion: A Guide to Goniometry.* 5th ed. F. A. Davis, 2016.

Tables in those books differ by a few degrees, and hyperextension of the elbow
and knee is often listed as 0° with some adults reaching about 10°. This runtime
uses the 10° figure and then stops.

## Prior art

Searched and read for the design. No source from these repositories is included,
copied, or adapted. Licences below are the SPDX id GitHub reported when this
note was written.

| Project | Stars (approx.) | Licence | What was taken |
|---|---|---|---|
| [Inochi2D/inochi2d](https://github.com/Inochi2D/inochi2d) | 1800 | BSD-2-Clause | Nothing. Part puppets need split art. |
| [Inochi2D/inochi-creator](https://github.com/Inochi2D/inochi-creator) | 1200 | BSD-2-Clause | Nothing. |
| [EsotericSoftware/spine-runtimes](https://github.com/EsotericSoftware/spine-runtimes) | 5300 | NOASSERTION (Spine Runtimes License, not MIT) | Nothing. Not shipped. |
| [pixijs-userland/spine](https://github.com/pixijs-userland/spine) | 600 | NOASSERTION | Nothing. |
| [DragonBones/DragonBonesJS](https://github.com/DragonBones/DragonBonesJS) | 850 | MIT | Nothing. |
| [facebookresearch/AnimatedDrawings](https://github.com/facebookresearch/AnimatedDrawings) | 12800 | MIT | Nothing. It animates a cut-out character from a drawing; different pipeline. |
| [FedUni/caliko](https://github.com/FedUni/caliko) | 180 | MIT | Nothing. FABRIK here is written from the 2011 paper. |
| [saleone/pyfabrik](https://github.com/saleone/pyfabrik) | 30 | MIT | Nothing. |
| [SebLague/Cloth-and-IK-Test](https://github.com/SebLague/Cloth-and-IK-Test) | 190 | MIT | Nothing. |
| [1iyiwei/deform2d](https://github.com/1iyiwei/deform2d) | 30 | MIT | Nothing. ARAP stays offline; see [full-body-research.md](full-body-research.md). |
| [AmazingZhen/AsRigidAsPossible_2d](https://github.com/AmazingZhen/AsRigidAsPossible_2d) | 11 | no SPDX licence on the repo | Not copied. |
| [open-mmlab/mmpose](https://github.com/open-mmlab/mmpose) | 8000 | Apache-2.0 | Not vendored. Keypoint JSON is accepted; the model is not run. |
| [CMU-Perceptual-Computing-Lab/openpose](https://github.com/CMU-Perceptual-Computing-Lab/openpose) | 34500 | NOASSERTION; some releases are non-commercial | Not vendored. Only the BODY_25 keypoint order is read from user JSON. |

Live2D Cubism is proprietary. Nothing from that SDK is here. `lo-th/ossos` and
`yuki-koyama/enhanced-arap-2d` were not on GitHub when this was checked (404).

The dual-quaternion hinge used for the limb interior is the earlier full-body
work (Kavan et al., 2007), still only on the joint band, and still skipped when
every angle is zero.

## Still blocked

- One illustration. Large turns, crossed limbs, and a bent skirt show background
  or a smear. The wedge list is data, not a fill.
- Twist does not rotate the painting.
- The waist can open in a bow because the legs do not inherit spinal flexion.
- The vest sample has no finger chain and no extra views.
- IK is planar. A hand target behind the body is the same pixel as a hand in front.
- Retargeting sets the limbs it can see. It does not recover a clavicle, a wrist,
  or a spine curve from a BODY_25 file.
- Draw order re-sorts one mesh. It cannot show a limb that was never painted on top.
