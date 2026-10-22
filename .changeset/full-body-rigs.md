---
"mesh-avatar": minor
"mesh-avatar-element": minor
---

Add an optional full-body limb rig. Bust avatars that omit `fullBody` render as before, and older runtimes ignore the new fields. Limb segments rotate rigidly, with a short dual-quaternion blend at the elbows and knees, and hair follows the torso only in that mode. The custom element uses the image aspect ratio for a tall full-body avatar after it loads.
