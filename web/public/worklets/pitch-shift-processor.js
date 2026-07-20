// Runs SoundTouch's pitch-shift DSP on the dedicated audio rendering
// thread (AudioWorkletGlobalScope), not the main thread - avoids the
// jitter/dropouts that ran here previously via a ScriptProcessorNode,
// which had to fight the main thread's React renders for CPU time.
//
// Only the pure-JS pieces of soundtouchjs are used (SoundTouch,
// SimpleFilter, WebAudioBufferSource) - not its PitchShifter/
// getWebAudioNode helpers, which are ScriptProcessorNode-specific.
import { SimpleFilter, SoundTouch, WebAudioBufferSource } from "/vendor/soundtouch.js";

// How often (in output frames) to report the playhead position back to
// the main thread. Every render quantum (128 frames) would flood the
// message port for no benefit - the UI only needs to update a couple of
// times a second.
const POSITION_REPORT_INTERVAL_FRAMES = 4096;

class PitchShiftProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: "pitchSemitones",
        defaultValue: 0,
        minValue: -24,
        maxValue: 24,
        automationRate: "k-rate",
      },
    ];
  }

  constructor() {
    super();
    this._filter = null;
    this._soundtouch = null;
    this._ready = false;
    // The node stays permanently connected to the graph (connecting/
    // disconnecting an AudioWorkletNode isn't a reliable way to gate
    // processing - source-like nodes can keep running regardless).
    // Play/pause is this explicit flag instead: paused just means "keep
    // outputting silence without advancing the read position".
    this._playing = false;
    this._framesSinceReport = 0;
    this._scratch = null;

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === "load") {
        const buffer = {
          numberOfChannels: msg.channelData.length,
          getChannelData: (ch) => msg.channelData[ch],
        };
        const source = new WebAudioBufferSource(buffer);
        this._soundtouch = new SoundTouch();
        this._soundtouch.tempo = 1;
        this._filter = new SimpleFilter(source, this._soundtouch);
        this._ready = true;
        // Setting this here (rather than via a separate "play" message)
        // keeps offline (download) rendering race-free: the main thread
        // only needs to await the "loaded" ack, at which point playback
        // has already started atomically - no risk of startRendering()
        // racing ahead of a still-in-flight "play" message.
        this._playing = !!msg.autoPlay;
        this.port.postMessage({ type: "loaded" });
      } else if (msg.type === "play") {
        this._playing = true;
      } else if (msg.type === "pause") {
        this._playing = false;
      } else if (msg.type === "seek") {
        if (this._filter) this._filter.sourcePosition = msg.positionFrames;
        this._framesSinceReport = 0;
      }
    };
  }

  process(_inputs, outputs, parameters) {
    const output = outputs[0];
    const left = output[0];
    const right = output.length > 1 ? output[1] : output[0];
    const frameCount = left.length;

    if (!this._ready || !this._playing) {
      return true;
    }

    this._soundtouch.pitchSemitones = parameters.pitchSemitones[0];

    if (!this._scratch || this._scratch.length < frameCount * 2) {
      this._scratch = new Float32Array(frameCount * 2);
    }
    const framesExtracted = this._filter.extract(this._scratch, frameCount);

    for (let i = 0; i < framesExtracted; i++) {
      left[i] = this._scratch[i * 2];
      right[i] = this._scratch[i * 2 + 1];
    }
    for (let i = framesExtracted; i < frameCount; i++) {
      left[i] = 0;
      right[i] = 0;
    }

    if (framesExtracted === 0) {
      this._playing = false;
      this.port.postMessage({ type: "ended" });
      return true;
    }

    this._framesSinceReport += frameCount;
    if (this._framesSinceReport >= POSITION_REPORT_INTERVAL_FRAMES) {
      this._framesSinceReport = 0;
      this.port.postMessage({ type: "position", sourcePositionFrames: this._filter.sourcePosition });
    }

    return true;
  }
}

registerProcessor("pitch-shift-processor", PitchShiftProcessor);
