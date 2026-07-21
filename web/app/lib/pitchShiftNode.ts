// Thin wrapper around the pitch-shift AudioWorkletNode - loading the
// worklet module (once per context), transferring decoded audio into it,
// and exposing a small play/pause/seek/position API so page.tsx doesn't
// need to know about the underlying postMessage protocol.

import type { PlaybackHandle } from "./playbackHandle";

const WORKLET_URL = "/worklets/pitch-shift-processor.js";
const loadedModules = new WeakSet<BaseAudioContext>();

async function ensureWorkletModule(context: BaseAudioContext): Promise<void> {
  if (loadedModules.has(context)) return;
  if (!("audioWorklet" in context)) {
    throw new Error("AudioWorklet isn't supported in this browser.");
  }
  await context.audioWorklet.addModule(WORKLET_URL);
  loadedModules.add(context);
}

export async function createPitchShiftNode(
  context: BaseAudioContext,
  buffer: AudioBuffer,
  options?: { autoPlay?: boolean }
): Promise<PlaybackHandle> {
  await ensureWorkletModule(context);

  const node = new AudioWorkletNode(context, "pitch-shift-processor", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });

  const pitchParam = node.parameters.get("pitchSemitones");
  const sampleRate = context.sampleRate;

  let endedCallback: (() => void) | null = null;
  let positionCallback: ((seconds: number) => void) | null = null;
  let resolveLoaded: () => void;
  const loadedPromise = new Promise<void>((resolve) => {
    resolveLoaded = resolve;
  });

  node.port.onmessage = (event: MessageEvent) => {
    const msg = event.data;
    if (msg.type === "loaded") {
      resolveLoaded();
    } else if (msg.type === "ended") {
      endedCallback?.();
    } else if (msg.type === "position") {
      positionCallback?.(msg.sourcePositionFrames / sampleRate);
    }
  };

  // Transfer (not copy) each channel's samples into the worklet - cheap
  // regardless of song length. Copy out of the AudioBuffer first since
  // transferring detaches the underlying ArrayBuffer, and the same
  // decoded AudioBuffer is reused elsewhere (offline download render).
  const channelData: Float32Array[] = [];
  const transferList: ArrayBuffer[] = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const copy = new Float32Array(buffer.getChannelData(ch));
    channelData.push(copy);
    transferList.push(copy.buffer);
  }
  node.port.postMessage({ type: "load", channelData, autoPlay: options?.autoPlay ?? false }, transferList);

  return {
    node,
    supportsPitchShift: true,
    setPitchSemitones(value: number) {
      pitchParam?.setValueAtTime(value, context.currentTime);
    },
    play() {
      node.port.postMessage({ type: "play" });
    },
    pause() {
      node.port.postMessage({ type: "pause" });
    },
    seekToSeconds(seconds: number) {
      node.port.postMessage({ type: "seek", positionFrames: Math.round(seconds * sampleRate) });
    },
    onEnded(cb) {
      endedCallback = cb;
    },
    onPosition(cb) {
      positionCallback = cb;
    },
    whenLoaded: () => loadedPromise,
    destroy() {
      node.port.onmessage = null;
      node.disconnect();
    },
  };
}
