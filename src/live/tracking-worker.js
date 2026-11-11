// Camera frames stay in this worker. Only the face pose and timing return to the page.
// Asset paths are relative to this worker, so the files can be served under any folder.
const base = new URL('.', self.location.href).href.replace(/\/$/, '');
self.exports = {};
self.importScripts(`${base}/vision_bundle.js`);
const { FaceLandmarker, PoseLandmarker, HandLandmarker, FilesetResolver } = self.exports;
let tracker, poseTracker, handTracker, lastFrame = -Infinity, delegate = 'GPU', frames = 0, gpuSamples = 0, gpuMs = 0;

async function createOptional(Kind, file, options, files) {
  if (!Kind?.createFromOptions) return null;
  try {
    return await Kind.createFromOptions(files, { ...options, baseOptions: { modelAssetPath: `${base}/${file}`, delegate } });
  } catch {
    try { return await Kind.createFromOptions(files, { ...options, baseOptions: { modelAssetPath: `${base}/${file}`, delegate: 'CPU' } }); }
    catch { return null; }
  }
}
function packLandmarks(points) {
  if (!points?.length) return [];
  return points.map(point => [point.x, point.y, point.z || 0, point.visibility ?? point.presence ?? 0]);
}
function packHands(result) {
  const landmarks = result?.landmarks ?? [];
  const handed = result?.handedness ?? [];
  const hands = [];
  for (let i = 0; i < landmarks.length; i++) {
    const category = handed[i]?.[0] ?? handed[i]?.categories?.[0];
    const name = category?.categoryName === 'Right' ? 'Right' : 'Left';
    hands.push({ side: name, landmarks: (landmarks[i] ?? []).map(point => [point.x, point.y, point.z || 0]) });
  }
  return hands;
}
self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      const files = await FilesetResolver.forVisionTasks(base);
      const options = { runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true };
      try { tracker = await FaceLandmarker.createFromOptions(files, { ...options, baseOptions: { modelAssetPath: `${base}/face_landmarker.task`, delegate } }); }
      catch {
        delegate = 'CPU';
        tracker = await FaceLandmarker.createFromOptions(files, { ...options, baseOptions: { modelAssetPath: `${base}/face_landmarker.task`, delegate } });
      }
      // Body models are optional: a face-only page still tracks if a model fails to load.
      poseTracker = await createOptional(PoseLandmarker, 'pose_landmarker_lite.task', { runningMode: 'VIDEO', numPoses: 1, minPoseDetectionConfidence: 0.25, minPosePresenceConfidence: 0.25 }, files);
      handTracker = await createOptional(HandLandmarker, 'hand_landmarker.task', { runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.25, minHandPresenceConfidence: 0.25 }, files);
      self.postMessage({ type: 'ready', delegate });
      // Also wakes the ImageBitmap fallback when video frame callbacks stop in a hidden tab.
      self.setInterval(() => self.postMessage({ type: 'tick' }), 1000 / 30);
    } catch { self.postMessage({ type: 'error' }); }
  } else if (data.type === 'frame') {
    try {
      const now = performance.now();
      if (tracker && data.timestamp - lastFrame >= 1000 / 30 - 2) {
        lastFrame = data.timestamp;
        const start = performance.now(), result = tracker.detectForVideo(data.frame, now);
        const posed = poseTracker ? poseTracker.detectForVideo(data.frame, now) : null;
        const handed = handTracker ? handTracker.detectForVideo(data.frame, now) : null;
        const elapsed = performance.now() - start;
        self.postMessage({ type: 'result', elapsed, result: {
          faceLandmarks: result.faceLandmarks.length ? [[]] : [],
          faceBlendshapes: result.faceBlendshapes,
          facialTransformationMatrixes: result.facialTransformationMatrixes,
          poseLandmarks: packLandmarks(posed?.landmarks?.[0]),
          hands: packHands(handed),
        } });
        // Some worker GPU backends initialize but run too slowly. Ignore warm-up, then
        // try CPU if sustained inference alone cannot meet the 15 fps target.
        if (delegate === 'GPU' && ++frames > 5) {
          gpuMs += elapsed;
          if (++gpuSamples === 8) {
            if (gpuMs / gpuSamples > 1000 / 15) {
              await tracker.setOptions({ baseOptions: { delegate: 'CPU' } });
              delegate = 'CPU'; self.postMessage({ type: 'delegate', delegate });
            }
            gpuMs = 0; gpuSamples = 0;
          }
        }
      }
    } catch { self.postMessage({ type: 'error' }); }
    finally { data.frame.close(); self.postMessage({ type: 'consumed' }); }
  }
};
