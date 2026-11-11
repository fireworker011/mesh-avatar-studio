// Japanese vowel shapes from a microphone spectrum. Formant bands follow the
// ranges in Kent and Read, The Acoustic Analysis of Speech (Delmar, 2002):
// あ has a high first formant, い a high second, う and お stay low.
import { VOWELS } from './kana.js';

function energy(bins, sampleRate, fftSize, low, high) {
  const step = sampleRate / fftSize;
  let total = 0;
  let count = 0;
  for (let i = 0; i < bins.length; i++) {
    const frequency = i * step;
    if (frequency < low || frequency >= high) continue;
    const decibel = bins[i];
    const magnitude = Number.isFinite(decibel) ? 10 ** (decibel / 20) : 0;
    total += magnitude * magnitude;
    count++;
  }
  return count ? total / count : 0;
}

/**
 * Japanese vowels from band energy. Approximate formants (Hz):
 * い F2 ~2300, え F1 ~500 and F2 ~1900, う F1 ~350, お both formants ~500–800,
 * あ F1 ~700 and F2 ~1200.
 * @param {ArrayLike<number>} bins analyser decibels
 * @returns {'a' | 'i' | 'u' | 'e' | 'o'}
 */
export function vowelFromSpectrum(bins, sampleRate = 48000, fftSize = 1024) {
  const low = energy(bins, sampleRate, fftSize, 250, 450);
  const first = energy(bins, sampleRate, fftSize, 500, 900);
  const second = energy(bins, sampleRate, fftSize, 1000, 1500);
  const high = energy(bins, sampleRate, fftSize, 1800, 2800);
  if (high >= first && high >= second && high > low * 1.3) return first > high * 0.55 ? 'e' : 'i';
  if (low > first && low > second && high < low) return 'u';
  if (second > first * 0.85 && second > high && first > low) return 'a';
  if (first >= second && first > high && first >= low * 0.8) return 'o';
  return 'a';
}

/** Tracks vowels and a short bilabial closure (ま・ば・ぱ) between voiced frames. */
export function createVisemeTracker() {
  let vowel = 'a';
  let quietFor = 0;
  let recent = 0;
  return {
    reset() { vowel = 'a'; quietFor = 0; recent = 0; },
    update(frame, dt = 1 / 60) {
      const rms = Math.max(0, Number(frame?.rms) || 0);
      if (!frame?.bins || rms < 0.045) {
        quietFor += Math.max(0, dt);
        const bilabial = recent > 0.12 && quietFor > 0.015 && quietFor < 0.12;
        if (!bilabial) return { active: false, vowel: null, open: 0, form: 0, level: rms };
        const shape = VOWELS[vowel] ?? VOWELS.a;
        return { active: true, vowel: 'm', open: 0.02, form: shape.form ?? 0, level: rms };
      }
      quietFor = 0;
      recent = Math.max(rms, recent * 0.85);
      vowel = vowelFromSpectrum(frame.bins, frame.sampleRate, frame.fftSize);
      const shape = VOWELS[vowel];
      return { active: true, vowel, open: shape.open, form: shape.form ?? 0, level: rms };
    },
  };
}
