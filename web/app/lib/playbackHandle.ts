// Shared shape for the two playback backends (AudioWorklet-based
// pitch-shifting, and the plain-native fallback) so page.tsx can drive
// either one identically.
export type PlaybackHandle = {
  node: AudioNode;
  supportsPitchShift: boolean;
  setPitchSemitones(value: number): void;
  play(): void;
  pause(): void;
  seekToSeconds(seconds: number): void;
  onEnded(cb: () => void): void;
  onPosition(cb: (seconds: number) => void): void;
  whenLoaded(): Promise<void>;
  destroy(): void;
};
