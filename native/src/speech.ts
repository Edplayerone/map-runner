import { setAudioModeAsync } from 'expo-audio';
import * as Speech from 'expo-speech';

let muted = false;

/* Configure the audio session so speech keeps playing with the screen locked
   and ducks (lowers) music from other apps instead of stopping it. */
export async function initAudio(): Promise<void> {
  try {
    await setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'duckOthers',
      interruptionModeAndroid: 'duckOthers',
    });
  } catch (e) {
    console.warn('audio mode setup failed', e);
  }
}

export function setMuted(m: boolean): void {
  muted = m;
  if (m) Speech.stop();
}

export function isMuted(): boolean {
  return muted;
}

export function speak(text: string, interrupt = false): void {
  if (muted || !text) return;
  if (interrupt) Speech.stop();
  Speech.speak(text, { language: 'en-US', rate: 1.0 });
}
