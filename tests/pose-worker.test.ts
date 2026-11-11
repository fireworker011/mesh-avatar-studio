import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, test, vi } from 'vitest';

const source = readFileSync(new URL('../src/editor/pose-worker.js', import.meta.url), 'utf8');

test('pose worker falls back from GPU to CPU, returns landmarks and closes the bitmap', async () => {
  const landmarks = [{ x: 0.3, y: 0.4, visibility: 0.9 }];
  const detect = vi.fn(() => ({ landmarks: [landmarks] }));
  const create = vi.fn().mockRejectedValueOnce(new Error('GPU unavailable')).mockResolvedValue({ detect });
  const postMessage = vi.fn();
  const scope = {
    exports: {}, postMessage, location: { href: 'http://127.0.0.1:5173/mediapipe/pose-worker.js' },
    importScripts: vi.fn((url: string) => {
      expect(url).toBe('http://127.0.0.1:5173/mediapipe/vision_bundle.js');
      scope.exports = { PoseLandmarker: { createFromOptions: create }, FilesetResolver: { forVisionTasks: async (path: string) => { expect(path).toBe('http://127.0.0.1:5173/mediapipe'); return {}; } } };
    }),
    onmessage: async (_event: { data: Record<string, unknown> }) => {},
  };
  runInNewContext(source, { self: scope, URL });
  await scope.onmessage({ data: { type: 'init' } });
  expect(create.mock.calls.map(call => call[1].baseOptions.delegate)).toEqual(['GPU', 'CPU']);
  expect(create.mock.calls[0][1].runningMode).toBe('IMAGE');
  expect(create.mock.calls[1][1].baseOptions.modelAssetPath).toBe('http://127.0.0.1:5173/mediapipe/pose_landmarker_lite.task');
  expect(postMessage).toHaveBeenCalledWith({ type: 'ready', delegate: 'CPU' });
  const image = { close: vi.fn() };
  await scope.onmessage({ data: { type: 'detect', image } });
  expect(detect).toHaveBeenCalledOnce();
  expect(image.close).toHaveBeenCalledOnce();
  expect(postMessage).toHaveBeenCalledWith({ type: 'result', landmarks });
  detect.mockImplementation(() => { throw new Error('Bad image'); });
  await scope.onmessage({ data: { type: 'detect', image } });
  expect(image.close).toHaveBeenCalledTimes(2);
  expect(postMessage).toHaveBeenLastCalledWith({ type: 'error' });
});
