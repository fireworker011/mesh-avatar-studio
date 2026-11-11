// One still image in, pose landmarks out. The bitmap stays in this worker and is closed here.
// Asset paths are relative to this worker, so the files can be served under any folder.
const base = new URL('.', self.location.href).href.replace(/\/$/, '');
self.exports = {};
self.importScripts(`${base}/vision_bundle.js`);
const { PoseLandmarker, FilesetResolver } = self.exports;
let tracker;
self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      const files = await FilesetResolver.forVisionTasks(base);
      const options = { runningMode: 'IMAGE', numPoses: 1, minPoseDetectionConfidence: 0.25, minPosePresenceConfidence: 0.25 };
      let delegate = 'GPU';
      try {
        tracker = await PoseLandmarker.createFromOptions(files, { ...options, baseOptions: { modelAssetPath: `${base}/pose_landmarker_lite.task`, delegate } });
      } catch {
        delegate = 'CPU';
        tracker = await PoseLandmarker.createFromOptions(files, { ...options, baseOptions: { modelAssetPath: `${base}/pose_landmarker_lite.task`, delegate } });
      }
      self.postMessage({ type: 'ready', delegate });
    } catch { self.postMessage({ type: 'error' }); }
  } else if (data.type === 'detect') {
    try {
      if (!tracker) throw new Error('Pose landmarker is not ready.');
      const result = tracker.detect(data.image);
      self.postMessage({ type: 'result', landmarks: result.landmarks?.[0] ?? null });
    } catch { self.postMessage({ type: 'error' }); }
    finally { data.image?.close?.(); }
  }
};
