declare module "soundtouchjs" {
  export class PitchShifter {
    constructor(
      context: BaseAudioContext,
      buffer: AudioBuffer,
      bufferSize?: number,
      onEnd?: () => void
    );
    tempo: number;
    rate: number;
    pitch: number;
    pitchSemitones: number;
    percentagePlayed: number;
    readonly node: AudioNode;
    readonly duration: number;
    readonly sampleRate: number;
    readonly timePlayed: number;
    connect(node: AudioNode): void;
    disconnect(): void;
    on(eventName: "play", callback: (detail: { timePlayed: number; formattedTimePlayed: string; percentagePlayed: number }) => void): void;
    off(eventName?: string): void;
  }
}
