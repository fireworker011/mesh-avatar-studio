import { expect, test } from 'vitest';
import { Motion } from '../packages/runtime/src/engine/motion.js';
import { createVisemeTracker, vowelFromSpectrum } from '../packages/runtime/src/engine/viseme.js';
import { driveSpeech } from '../src/live/speech-source';

const FFT = 1024;
const RATE = 48000;

function spectrum(levels: { low: number; first: number; second: number; high: number }) {
  const step = RATE / FFT;
  const values = new Float32Array(FFT / 2).fill(-100);
  const bands: [number, number, number][] = [[250, 450, levels.low], [500, 900, levels.first], [1000, 1500, levels.second], [1800, 2800, levels.high]];
  for (let i = 0; i < values.length; i++) {
    const frequency = i * step;
    for (const [low, high, decibel] of bands) if (frequency >= low && frequency < high) values[i] = decibel;
  }
  return values;
}

test('formant bands pick the five Japanese vowels', () => {
  expect(vowelFromSpectrum(spectrum({ low: -40, first: -40, second: -40, high: 0 }), RATE, FFT)).toBe('i');
  expect(vowelFromSpectrum(spectrum({ low: -30, first: -2, second: -20, high: 0 }), RATE, FFT)).toBe('e');
  expect(vowelFromSpectrum(spectrum({ low: 0, first: -8, second: -40, high: -40 }), RATE, FFT)).toBe('u');
  expect(vowelFromSpectrum(spectrum({ low: -20, first: 0, second: 0, high: -30 }), RATE, FFT)).toBe('a');
  expect(vowelFromSpectrum(spectrum({ low: -12, first: 0, second: -10, high: -30 }), RATE, FFT)).toBe('o');
});

test('a short gap after a voiced frame closes the lips, and a longer gap goes quiet', () => {
  const tracker = createVisemeTracker();
  const bins = spectrum({ low: -20, first: 0, second: 0, high: -30 });
  const voiced = tracker.update({ bins, sampleRate: RATE, fftSize: FFT, rms: 0.3 }, 1 / 60);
  expect(voiced).toMatchObject({ active: true, vowel: 'a' });
  const closed = tracker.update({ bins, sampleRate: RATE, fftSize: FFT, rms: 0.01 }, 0.04);
  expect(closed).toMatchObject({ active: true, vowel: 'm', open: 0.02 });
  expect(closed.form).toBe(voiced.form);
  const silent = tracker.update({ bins, sampleRate: RATE, fftSize: FFT, rms: 0 }, 0.2);
  expect(silent.active).toBe(false);
  tracker.reset();
  expect(tracker.update({ rms: 0.01 }, 0.04).active).toBe(false);
});

test('a microphone vowel sets the drawn mouth, and a bilabial keeps that shape while it shuts', () => {
  const motion = new Motion([0, 0]);
  motion.mode = 'manual';
  motion.setSpeaking(true);
  motion.setVoiceLevel(0.2);
  motion.setViseme('i');
  for (let i = 0; i < 12; i++) motion.update(1 / 60);
  expect(motion.P.mouthForm).toBeLessThan(-0.5);
  expect(motion.P.mouthOpen).toBeGreaterThan(0.2);
  motion.setViseme('u');
  motion.update(1 / 60);
  expect(motion.P.mouthForm).toBeGreaterThan(0.7);
  motion.setViseme('m');
  for (let i = 0; i < 18; i++) motion.update(1 / 60);
  expect(motion.P.mouthOpen).toBeLessThan(0.08);
  expect(motion.P.mouthForm).toBeGreaterThan(0.7);
  motion.setViseme('nope');
  motion.setSpeaking(true);
  motion.setVoiceLevel(0.8);
  motion.update(1 / 60);
  expect(motion.P.mouthOpen).toBeGreaterThan(0.08);
});

test('the microphone owns the mouth only while a voice is coming in', () => {
  const seen: string[] = [];
  const avatar = {
    setSpeaking(on: boolean) { seen.push(`speak:${on}`); },
    setViseme(vowel: string | null) { seen.push(`viseme:${vowel}`); },
    setVoiceLevel(value: number) { seen.push(`level:${value}`); },
  };
  const tracker = createVisemeTracker();
  const params = { mouthOpen: 0.4, mouthForm: 0.2 };
  expect(driveSpeech(avatar, params, { micOn: false, frame: null, dt: 1 / 60 }, tracker)).toBe('camera');
  expect(params).toEqual({ mouthOpen: 0.4, mouthForm: 0.2 });
  const frame = { bins: spectrum({ low: -20, first: 0, second: 0, high: -30 }), sampleRate: RATE, fftSize: FFT, rms: 0.4 };
  expect(driveSpeech(avatar, params, { micOn: true, frame, dt: 1 / 60 }, tracker)).toBe('mic');
  expect(params).toEqual({ mouthOpen: 0, mouthForm: 0 });
  expect(seen).toContain('viseme:a');
  const quiet = { ...frame, rms: 0 };
  const camera = { mouthOpen: 0.55, mouthForm: -0.2 };
  expect(driveSpeech(avatar, camera, { micOn: true, frame: quiet, dt: 0.2 }, tracker)).toBe('camera');
  expect(camera).toEqual({ mouthOpen: 0.55, mouthForm: -0.2 });
  expect(seen.at(-1)).toBe('viseme:null');
});
