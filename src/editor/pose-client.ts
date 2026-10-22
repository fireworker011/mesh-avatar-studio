import type { PoseLandmark } from './pose-landmarks';

type WorkerMessage =
  | { type: 'ready'; delegate: 'GPU' | 'CPU' }
  | { type: 'result'; landmarks: PoseLandmark[] | null }
  | { type: 'error' };

let ready: Promise<Worker> | null = null;
let pending: Promise<unknown> = Promise.resolve();

function poseWorker() {
  if (!ready) {
    const current = new Worker('/mediapipe/pose-worker.js');
    ready = new Promise((resolve, reject) => {
      const onMessage = (event: MessageEvent<WorkerMessage>) => {
        if (event.data.type === 'ready') {
          current.removeEventListener('message', onMessage);
          resolve(current);
        } else if (event.data.type === 'error') {
          current.removeEventListener('message', onMessage);
          current.terminate();
          ready = null;
          reject(new Error('Pose detection could not start.'));
        }
      };
      current.addEventListener('message', onMessage);
      current.postMessage({ type: 'init' });
    });
  }
  return ready;
}

/** Detect one still image. Landmarks are normalised; null means no pose was found. */
export function detectPoseLandmarks(image: CanvasImageSource): Promise<PoseLandmark[] | null> {
  const run = pending.then(() => detectOne(image));
  pending = run.then(() => undefined, () => undefined);
  return run;
}

function detectOne(image: CanvasImageSource): Promise<PoseLandmark[] | null> {
  return createImageBitmap(image).then(async bitmap => {
    const current = await poseWorker().catch(error => { bitmap.close(); throw error; });
    return new Promise((resolve, reject) => {
      const onMessage = (event: MessageEvent<WorkerMessage>) => {
        if (event.data.type !== 'result' && event.data.type !== 'error') return;
        current.removeEventListener('message', onMessage);
        if (event.data.type === 'result') resolve(event.data.landmarks);
        else reject(new Error('Pose detection failed.'));
      };
      current.addEventListener('message', onMessage);
      current.postMessage({ type: 'detect', image: bitmap }, [bitmap]);
    });
  });
}
