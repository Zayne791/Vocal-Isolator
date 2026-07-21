import type { PlaybackHandle } from "./playbackHandle";

// Plain AudioBufferSourceNode playback - no AudioWorklet, no
// ScriptProcessorNode, nothing that varies across browser DSP
// implementations. Used as the guaranteed-to-work fallback when the
// pitch-shift worklet can't be set up: playback always works, it just
// can't change key (the wheel gets disabled in that case).
//
// AudioBufferSourceNode is one-shot (start() can only be called once
// per instance), so "pause" is implemented by stopping it and
// remembering the offset, then starting a fresh node from that offset
// on the next play() - the standard pattern for this API.
export function createNativePlaybackNode(context: BaseAudioContext, buffer: AudioBuffer): PlaybackHandle {
  const output = context.createGain();
  let currentSource: AudioBufferSourceNode | null = null;
  let startedAtContextTime = 0;
  let offsetSeconds = 0;
  let playing = false;
  let endedCallback: (() => void) | null = null;
  let positionCallback: ((seconds: number) => void) | null = null;
  let positionTimer: ReturnType<typeof setInterval> | null = null;

  function currentPositionSeconds(): number {
    if (!playing) return offsetSeconds;
    return offsetSeconds + (context.currentTime - startedAtContextTime);
  }

  function stopCurrentSource() {
    if (currentSource) {
      currentSource.onended = null;
      try {
        currentSource.stop();
      } catch {
        // Already stopped or never started - nothing to do.
      }
      currentSource.disconnect();
      currentSource = null;
    }
  }

  function clearPositionTimer() {
    if (positionTimer) {
      clearInterval(positionTimer);
      positionTimer = null;
    }
  }

  function play() {
    if (playing) return;
    stopCurrentSource();
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(output);
    source.onended = () => {
      if (currentSource === source) {
        playing = false;
        offsetSeconds = 0;
        clearPositionTimer();
        endedCallback?.();
      }
    };
    source.start(0, Math.min(offsetSeconds, buffer.duration));
    currentSource = source;
    startedAtContextTime = context.currentTime;
    playing = true;
    clearPositionTimer();
    positionTimer = setInterval(() => positionCallback?.(currentPositionSeconds()), 200);
  }

  function pause() {
    if (!playing) return;
    offsetSeconds = currentPositionSeconds();
    playing = false;
    stopCurrentSource();
    clearPositionTimer();
  }

  return {
    node: output,
    supportsPitchShift: false,
    setPitchSemitones() {
      // No-op: this fallback path has no pitch-shifting capability.
    },
    play,
    pause,
    seekToSeconds(seconds: number) {
      offsetSeconds = seconds;
    },
    onEnded(cb) {
      endedCallback = cb;
    },
    onPosition(cb) {
      positionCallback = cb;
    },
    whenLoaded: () => Promise.resolve(),
    destroy() {
      stopCurrentSource();
      clearPositionTimer();
      output.disconnect();
    },
  };
}
