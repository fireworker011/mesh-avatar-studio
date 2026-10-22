---
"mesh-avatar": minor
---

Draw full-body limbs as rigid cut-outs when `parts/parts.json` has a `cutout` section. The torso, coat and skirt stay as drawn, each limb turns about its drawn joints with its parent covering the root, a shoulder cap and the front hair are drawn over the arms, and a body yaw slides the near arm, torso and far arm by depth instead of warping the torso. Hair anchors follow the torso, not a limb. Bust avatars, and full-body avatars without that section, render as before.
