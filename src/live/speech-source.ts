/** Mic vowels own the mouth while the microphone is on and a voice is present.
 *  Silence, and a stopped microphone, leave the camera jaw in charge. */

export interface SpectrumFrame {
  bins: ArrayLike<number>;
  sampleRate: number;
  fftSize: number;
  rms: number;
}

export type SpeechVowel = 'a' | 'i' | 'u' | 'e' | 'o' | 'm';

export interface VisemeTracker {
  reset(): void;
  update(frame: { bins?: ArrayLike<number>; sampleRate?: number; fftSize?: number; rms?: number } | null, dt?: number): {
    active: boolean;
    vowel: string | null;
    open: number;
    form: number;
    level: number;
  };
}

const VOWELS = new Set<SpeechVowel>(['a', 'i', 'u', 'e', 'o', 'm']);
const isVowel = (value: string | null): value is SpeechVowel => !!value && VOWELS.has(value as SpeechVowel);

export function driveSpeech(
  avatar: { setSpeaking(on: boolean): void; setViseme(vowel: SpeechVowel | null): void; setVoiceLevel(value: number): void },
  params: Record<string, number>,
  source: { micOn: boolean; frame: SpectrumFrame | null; dt: number },
  tracker: VisemeTracker,
): 'mic' | 'camera' {
  if (!source.micOn || !source.frame) {
    tracker.reset();
    avatar.setSpeaking(false);
    avatar.setViseme(null);
    return 'camera';
  }
  const viseme = tracker.update(source.frame, source.dt);
  if (!viseme.active || !isVowel(viseme.vowel)) {
    avatar.setSpeaking(false);
    avatar.setViseme(null);
    return 'camera';
  }
  avatar.setSpeaking(true);
  avatar.setViseme(viseme.vowel);
  avatar.setVoiceLevel(source.frame.rms);
  params.mouthOpen = 0;
  params.mouthForm = 0;
  return 'mic';
}
