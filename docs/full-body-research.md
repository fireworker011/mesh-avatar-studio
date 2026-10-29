# Full-body deformation and pose detection

Notes from reading public 2D rigging and pose projects before changing the limb
solver, hair anchors and illustration pose tools. The implementation in this
repository is original. No source from the projects below was copied. Techniques
that are standard published methods (linear blend skinning, dual-quaternion
skinning) are cited as papers, not as code.

## What this runtime does

A full-body avatar is still one illustration on one mesh. Each limb segment is a
rigid transform: a rotation about its posed pivot, composed with its parents.
A vertex in the middle of a segment uses that one transform, so the limb does not
stretch along its length. Vertices near an elbow or knee, where two segments are
about equally close, blend those rigid transforms as dual quaternions and then
normalise. That is the blend in Kavan et al., which avoids the hinge collapse of
averaging the two posed positions directly. A small share of the position average
is mixed back in only inside that joint band, to limit the bulge dual-quaternion
blending can add. The elbows and knees also get a tighter mesh, so the blend has
pixels to work with.

Bust avatars omit `fullBody`. Their weights, deformation and physics anchors are
unchanged, and a resting full-body pose returns before the blend runs.

Hair strand targets and tassel knots use that same limb transform when `fullBody`
is set, then the existing head and body transforms. In bust mode the anchors stay
head plus body only.

Pose detection still uses the local MediaPipe pose model. Before that, the editor
can flatten the picture onto gray, or stretch contrast and sharpen lines. If that
score is poor, or the user picks Outline, joints are placed from the opaque
silhouette so they can be dragged. Arrow keys nudge the selected joint. Mirror
copies one side across the image centre.

Separate cut-out limbs with their own draw order were not added. Live2D and
Inochi2D do that when the art is already split into parts. A single illustration
has no limb mattes, and cut-outs at the elbow would leave a seam. Skinning the
whole figure keeps the drawing intact.

## Sources

### Dual-quaternion and linear blend skinning

- Ladislav Kavan, Steven Collins, Jiří Žára, Carol O'Sullivan. *Skinning with Dual Quaternions.* Symposium on Interactive 3D Graphics and Games, 2007. <https://dl.acm.org/doi/10.1145/1230100.1230107>
- SIGGRAPH 2014 course notes, *Skinning: Real-time Shape Deformation.* <https://www.skinning.org/direct-methods.pdf>
- Gene Lee, others. *Enhanced Dual Quaternion Skinning for Production Use* (Disney, Frozen). The useful production note is that dual quaternions cover rigid bends, and a position blend is still useful where the joint should not bulge. <https://media.disneyanimation.com/uploads/production/publication_asset/98/asset/dualQ.pdf>

Adopted: represent each bone chain as one planar rigid transform, blend those as dual quaternions, normalise, and mix a little linear blend only where two weights are close. Not adopted: 3D scale and shear, because these bends are rigid.

### As-rigid-as-possible meshes

- Olga Sorkine, Marc Alexa. *As-Rigid-As-Possible Surface Modeling.* Eurographics symposium on Geometry Processing, 2007.

ARAP solves a small deformation for every frame. That is a good fit for an offline sculpt, and a poor fit for this avatar, which already deforms every vertex on the CPU each frame. The closed-form bone blend was used instead.

### Inochi2D

- <https://github.com/Inochi2D/inochi2d> — BSD 2-Clause. Puppet parts, parameters, and bone weights that move mesh vertices. Bone skinning landed in the runtime in 2026 (`source/inochi2d/nodes/bone/`).
- Docs and licence notes: <https://github.com/Inochi2D/inochi2d/blob/main/LICENSE>, <https://github.com/Inochi2D/inochi2d/wiki/Legal-Info>

Adopted as a design idea only: a bone hierarchy with per-vertex weights, and physics on top of the posed skeleton. No Inochi2D source is included, so the BSD notice is not required here. Part-based draw order was not copied; see above.

### Spine and pixi-spine

- <https://github.com/EsotericSoftware/spine-runtimes> — Spine Runtimes License. Integrating the runtime is allowed for evaluation, but shipping it requires the Spine editor licence terms. <https://github.com/EsotericSoftware/spine-runtimes/blob/4.3/spine-ts/spine-core/LICENSE>
- Weighted meshes store, per vertex, a list of bone indices and weights, then add each bone's transformed position. Public description: <https://esotericsoftware.com/spine-meshes>

The weighted-mesh idea (a vertex follows more than one bone, and only near a joint) is the same idea as linear blend skinning. The Spine implementation was not copied, and this repo does not ship a Spine runtime. The hinge here uses dual quaternions rather than Spine's position sum, because the position sum is what was shearing the limbs.

### DragonBones

- <https://github.com/DragonBones/DragonBonesJS> — MIT. Mesh deformation and skinning are documented as vertices attached to bones: <https://github.com/DragonBones/DragonBonesJS>, <https://dragonbones.github.io/en/animation.html>

Same public idea as Spine: bone weights drive mesh vertices, and inverse kinematics is a separate editor tool. No DragonBones source is included. The later anatomical pose (joint limits, CCD and FABRIK, presets, OpenPose/COCO JSON) is documented in [pose-system-issues.md](pose-system-issues.md). It does not import DragonBones, Spine, or any other solver.

### Live2D Cubism

- Cubism SDK licence: <https://www.live2d.com/en/sdk/license/>
- Cubism Core is proprietary. The framework components use Live2D's own open-software licence, which is not a general MIT/BSD grant. Sample models such as Haru have a separate free-material licence.

Nothing from the Cubism SDK, Core, or sample models is in this repository. The relevant public idea is layered art: a limb drawn as its own part bends without dragging the torso texture. That needs art split into parts. This project deforms one illustration, so the joint is a skinned band instead of a second sprite.

### Talking Head Anime

- <https://github.com/pkhungurn/talking-head-anime-3-demo> — code MIT, model files CC BY 4.0 (attribute Pramook Khungurn if those files are redistributed). The demo warps a single anime image from pose parameters, including a body.

Not adopted. It replaces the mesh rig with a neural warp and ships model weights. This avatar has to stay a deformable mesh with the existing bust regression. The model files were not downloaded.

### Pose estimation

- MediaPipe Pose Landmarker, already vendored. Apache 2.0. <https://developers.google.com/mediapipe/solutions/vision/pose_landmarker> and `vendor/mediapipe/LICENSE`. It is trained on camera photos. Flat colour and line art often come back with a low score. The editor now tries a gray composite and a contrast-sharpened copy, and lowers the detection threshold, before giving up.
- RTMPose / MMPose. Apache 2.0. <https://github.com/open-mmlab/mmpose>, paper <https://arxiv.org/abs/2303.07399>. RTMLib wraps the ONNX models without the rest of OpenMMLab: <https://github.com/Tau-J/rtmlib>. Human-Art (CVPR 2023) is the dataset they use for illustrated people. A Human-Art RTMPose model would be a stronger second detector for drawings. It was not vendored: the weights are large, and inference would add another runtime next to the local MediaPipe task. The silhouette estimator is the offline fallback instead.
- OpenPose (<https://github.com/CMU-Perceptual-Computing-Lab/openpose>) was not used. Some OpenPose releases are restricted to non-commercial or academic terms, and the code was not copied.
- Animal-Pose, AP-10K and similar sets in MMPose are for animals. They do not place a human figure's elbows, so they were not used.

## Illustration sample

`samples/full-body-photo` is an original clothed adult figure made for this repository, so pose detection can be tried on a painted picture rather than the flat geometric sample. It is not from Human-Art, Danbooru, or another dataset. Attribution is in that folder. The figure is non-explicit. The geometric sample in `samples/full-body` stays the simple standing figure used to check the rig.
