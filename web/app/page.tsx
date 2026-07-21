"use client";

import { useEffect, useRef, useState } from "react";
import KeyWheel from "./components/KeyWheel";
import { detectKey, shortestSemitoneDistance, type Mode } from "./lib/keyDetection";
import { createNativePlaybackNode } from "./lib/nativePlayback";
import type { PlaybackHandle } from "./lib/playbackHandle";
import { createPitchShiftNode } from "./lib/pitchShiftNode";
import styles from "./page.module.css";

// Tries the pitch-shift AudioWorklet first; if it can't be set up for any
// reason (unsupported browser, a failed module load, ...), falls back to
// plain playback so the song is never left completely silent - it just
// can't change key in that case.
async function buildPlaybackHandle(context: BaseAudioContext, buffer: AudioBuffer): Promise<PlaybackHandle> {
  try {
    return await createPitchShiftNode(context, buffer);
  } catch (err) {
    console.error("Pitch-shift playback unavailable, falling back to plain playback:", err);
    return createNativePlaybackNode(context, buffer);
  }
}

const API_BASE = process.env.NEXT_PUBLIC_STRIPPER_API_URL;

const WORKING_PHRASES = [
  "Listening to the song…",
  "Finding the singer's voice…",
  "Almost done…",
];

const POLL_INTERVAL_MS = 3000;
// Generous on purpose: unlike the tiny {"state":"pending"} polls, the
// final poll's response carries two full mp3 stems as base64, which can
// take a while to download on a slow connection. A too-short timeout here
// aborts that download mid-flight and forces a full retry from scratch.
const POLL_TIMEOUT_MS = 60000;
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

// 0% = fully removed (this app's original default), 100% = the singer
// back at their original level, 150% = boosted above original.
const MIN_VOCAL_LEVEL = 0;
const MAX_VOCAL_LEVEL = 150;
const DEFAULT_VOCAL_LEVEL = 0;

type Phase = "idle" | "working" | "done" | "error";

type Stems = {
  title: string;
  instrumentalBuffer: AudioBuffer;
  vocalsBuffer: AudioBuffer;
};

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Minimal 16-bit PCM WAV encoder, so downloads don't depend on any
// third-party mp3 encoder library just to export a client-side mix.
function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const blockAlign = numChannels * 2;
  const dataSize = numFrames * blockAlign;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  const channelData: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) channelData.push(buffer.getChannelData(ch));

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channelData[ch][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([out], { type: "audio/wav" });
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [phraseIndex, setPhraseIndex] = useState(0);
  const [progress, setProgress] = useState(8);
  const [stems, setStems] = useState<Stems | null>(null);
  const [vocalLevel, setVocalLevel] = useState(DEFAULT_VOCAL_LEVEL);
  const [isPlaying, setIsPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [isRendering, setIsRendering] = useState(false);
  const [detectedTonic, setDetectedTonic] = useState<number | null>(null);
  const [detectedMode, setDetectedMode] = useState<Mode | null>(null);
  const [selectedTonic, setSelectedTonic] = useState<number | null>(null);
  // False while the decoded audio is still being handed off to the
  // playback graph - keeps the play button disabled with a "Loading"
  // label instead of letting playback start against a not-yet-ready graph.
  const [playbackReady, setPlaybackReady] = useState(false);
  // False if the pitch-shift worklet couldn't be set up and playback fell
  // back to the plain (non-key-changeable) path - disables the wheel with
  // an explanation instead of pretending it still does something.
  const [pitchShiftAvailable, setPitchShiftAvailable] = useState(true);

  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const phraseTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const instrumentalNodeRef = useRef<PlaybackHandle | null>(null);
  const vocalsNodeRef = useRef<PlaybackHandle | null>(null);
  const vocalGainRef = useRef<GainNode | null>(null);

  function getAudioContext(): AudioContext {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
    }
    return audioCtxRef.current;
  }

  const duration = stems?.instrumentalBuffer.duration || 0;

  // How far, in semitones, the currently selected key sits from the
  // detected one - 0 until a key is picked on the wheel (or before
  // detection finishes, since the wheel starts pointed at the detected key).
  const semitoneShift =
    detectedTonic !== null && selectedTonic !== null
      ? shortestSemitoneDistance(detectedTonic, selectedTonic)
      : 0;

  // Build the playback graph from the fully-decoded stems, preferring a
  // pitch-shift AudioWorklet (tempo-preserving pitch shift, running on
  // the dedicated audio thread rather than fighting React for main-thread
  // time) so both the key wheel and the vocal-level slider can be driven
  // live, the same "no extra network round-trip per control move" way the
  // original <audio>-element graph worked. Falls back to plain playback
  // (see buildPlaybackHandle) if the worklet can't be used, so the song
  // is never left silent.
  useEffect(() => {
    if (!stems) return;
    let cancelled = false;

    const ctx = getAudioContext();
    const gainNode = ctx.createGain();
    gainNode.gain.value = DEFAULT_VOCAL_LEVEL / 100;

    Promise.all([
      buildPlaybackHandle(ctx, stems.instrumentalBuffer),
      buildPlaybackHandle(ctx, stems.vocalsBuffer),
    ]).then(async ([instrumentalHandle, vocalsHandle]) => {
      if (cancelled) {
        instrumentalHandle.destroy();
        vocalsHandle.destroy();
        return;
      }

      instrumentalHandle.node.connect(ctx.destination);
      vocalsHandle.node.connect(gainNode).connect(ctx.destination);

      instrumentalHandle.onEnded(() => {
        vocalsHandle.pause();
        instrumentalHandle.seekToSeconds(0);
        vocalsHandle.seekToSeconds(0);
        setIsPlaying(false);
        setElapsed(0);
      });
      instrumentalHandle.onPosition((seconds) => setElapsed(seconds));

      await Promise.all([instrumentalHandle.whenLoaded(), vocalsHandle.whenLoaded()]);
      if (cancelled) {
        instrumentalHandle.destroy();
        vocalsHandle.destroy();
        return;
      }

      instrumentalNodeRef.current = instrumentalHandle;
      vocalsNodeRef.current = vocalsHandle;
      setPitchShiftAvailable(instrumentalHandle.supportsPitchShift && vocalsHandle.supportsPitchShift);
      setPlaybackReady(true);
    }).catch((err) => {
      if (cancelled) return;
      console.error("Failed to set up playback:", err);
      setError("Couldn't set up playback for this song. Try reloading the page.");
    });

    vocalGainRef.current = gainNode;

    return () => {
      cancelled = true;
      instrumentalNodeRef.current?.destroy();
      vocalsNodeRef.current?.destroy();
      gainNode.disconnect();
      instrumentalNodeRef.current = null;
      vocalsNodeRef.current = null;
      vocalGainRef.current = null;
    };
  }, [stems]);

  // Detect the song's key once the stems are decoded. Deferred a tick so
  // the "Your song is ready" UI paints first - the wheel shows a
  // "Detecting..." state in the meantime.
  useEffect(() => {
    if (!stems) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const instData = stems.instrumentalBuffer.getChannelData(0);
      const vocData = stems.vocalsBuffer.getChannelData(0);
      const length = Math.min(instData.length, vocData.length);
      const mix = new Float32Array(length);
      for (let i = 0; i < length; i++) mix[i] = instData[i] + vocData[i];
      const result = detectKey(mix, stems.instrumentalBuffer.sampleRate);
      if (cancelled) return;
      setDetectedTonic(result.tonic);
      setDetectedMode(result.mode);
      setSelectedTonic(result.tonic);
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [stems]);

  // Apply the selected key live - just updates an AudioParam the worklet
  // picks up on its next render quantum, no need to rebuild the graph or
  // interrupt playback.
  useEffect(() => {
    instrumentalNodeRef.current?.setPitchSemitones(semitoneShift);
    vocalsNodeRef.current?.setPitchSemitones(semitoneShift);
  }, [semitoneShift, playbackReady]);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
      if (phraseTimer.current) clearInterval(phraseTimer.current);
      audioCtxRef.current?.close();
    };
  }, []);

  function stopTimers() {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    if (phraseTimer.current) clearInterval(phraseTimer.current);
  }

  function togglePlay() {
    const instrumentalHandle = instrumentalNodeRef.current;
    const vocalsHandle = vocalsNodeRef.current;
    if (!instrumentalHandle || !vocalsHandle) return;

    if (isPlaying) {
      instrumentalHandle.pause();
      vocalsHandle.pause();
      setIsPlaying(false);
      return;
    }

    const ctx = getAudioContext();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});

    instrumentalHandle.play();
    vocalsHandle.play();
    setIsPlaying(true);
  }

  function handleVocalLevelChange(value: number) {
    setVocalLevel(value);
    if (vocalGainRef.current) {
      vocalGainRef.current.gain.value = value / 100;
    }
  }

  function resetToIdle() {
    stopTimers();
    setPhase("idle");
    setFile(null);
    setStems(null);
    setVocalLevel(DEFAULT_VOCAL_LEVEL);
    setIsPlaying(false);
    setElapsed(0);
    setError("");
    setProgress(8);
    setPhraseIndex(0);
    setDetectedTonic(null);
    setDetectedMode(null);
    setSelectedTonic(null);
    setPlaybackReady(false);
    setPitchShiftAvailable(true);
  }

  async function handleDownload() {
    if (!stems) return;
    setIsRendering(true);
    setError("");
    try {
      const { instrumentalBuffer, vocalsBuffer } = stems;
      const length = Math.max(instrumentalBuffer.length, vocalsBuffer.length);
      // Tempo stays 1 (only pitch changes), so the rendered length is the
      // same regardless of the chosen key.
      const offlineCtx = new OfflineAudioContext(2, length, instrumentalBuffer.sampleRate);

      const buildOfflineHandle = (buf: AudioBuffer) =>
        createPitchShiftNode(offlineCtx, buf, { autoPlay: true }).catch((err) => {
          console.error("Pitch-shift render unavailable, falling back to plain render:", err);
          const handle = createNativePlaybackNode(offlineCtx, buf);
          handle.play();
          return handle;
        });

      const [instrumentalHandle, vocalsHandle] = await Promise.all([
        buildOfflineHandle(instrumentalBuffer),
        buildOfflineHandle(vocalsBuffer),
      ]);
      const appliedShift = instrumentalHandle.supportsPitchShift && vocalsHandle.supportsPitchShift ? semitoneShift : 0;
      instrumentalHandle.setPitchSemitones(appliedShift);
      vocalsHandle.setPitchSemitones(appliedShift);
      instrumentalHandle.node.connect(offlineCtx.destination);
      const gainNode = offlineCtx.createGain();
      gainNode.gain.value = vocalLevel / 100;
      vocalsHandle.node.connect(gainNode);
      gainNode.connect(offlineCtx.destination);

      // Rendering must not start until both worklets have actually
      // received their audio (and, per autoPlay, are already marked
      // playing) - otherwise startRendering() could race ahead of the
      // still-in-flight buffer transfer and render silence.
      await Promise.all([instrumentalHandle.whenLoaded(), vocalsHandle.whenLoaded()]);

      const rendered = await offlineCtx.startRendering();
      const blob = audioBufferToWavBlob(rendered);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const keySuffix = appliedShift === 0 ? "" : `, key ${appliedShift > 0 ? "+" : ""}${appliedShift}`;
      a.download = `${stems.title} (vocals ${vocalLevel}%${keySuffix}).wav`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("Couldn't render that mix for download. Please try again.");
    } finally {
      setIsRendering(false);
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (!API_BASE) {
      setPhase("error");
      setError(
        "This site isn't finished being set up yet (missing API address). Ask Zayne to check NEXT_PUBLIC_STRIPPER_API_URL."
      );
      return;
    }

    if (!file) {
      setPhase("error");
      setError("Choose a song file first.");
      return;
    }

    setError("");
    setPhase("working");
    setPhraseIndex(0);
    setProgress(8);

    phraseTimer.current = setInterval(() => {
      setPhraseIndex((i) => (i + 1) % WORKING_PHRASES.length);
    }, 6000);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const startResponse = await fetch(`${API_BASE}/start`, {
        method: "POST",
        body: formData,
      });

      if (!startResponse.ok) {
        const body = await startResponse.json().catch(() => null);
        throw new Error(body?.error || "Couldn't start on that file. Please try again.");
      }

      const { call_id } = await startResponse.json();

      let consecutiveFailures = 0;

      const pollStatus = async () => {
        const controller = new AbortController();
        const abortTimer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);

        // Network I/O only in here - failures here are transient (flaky
        // connection, backgrounded tab) and worth retrying a few times.
        let statusBody: Record<string, unknown>;
        try {
          const statusResponse = await fetch(`${API_BASE}/status?call_id=${call_id}`, {
            signal: controller.signal,
          });
          statusBody = await statusResponse.json();
          consecutiveFailures = 0;
        } catch {
          consecutiveFailures += 1;
          if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
            stopTimers();
            setPhase("error");
            setError("Lost connection while working on that song. Please try again.");
            return;
          }
          setProgress((p) => Math.min(p + 4, 92));
          pollTimer.current = setTimeout(pollStatus, POLL_INTERVAL_MS);
          return;
        } finally {
          clearTimeout(abortTimer);
        }

        if (statusBody.state === "pending") {
          setProgress((p) => Math.min(p + 4, 92));
          pollTimer.current = setTimeout(pollStatus, POLL_INTERVAL_MS);
          return;
        }

        if (statusBody.state === "error") {
          stopTimers();
          setPhase("error");
          setError((statusBody.message as string) || "Something went wrong separating that song. Please try again.");
          return;
        }

        // We have the finished result - from here on, any failure (a bad
        // payload, a browser quirk decoding the audio) is a real, fatal
        // error, not a network hiccup. It must never fall back into the
        // retry path above, or the UI would silently loop "working"
        // forever instead of ever surfacing the problem.
        stopTimers();
        try {
          const ctx = getAudioContext();
          const [instrumentalBuffer, vocalsBuffer] = await Promise.all([
            ctx.decodeAudioData(base64ToArrayBuffer(statusBody.instrumental_base64 as string)),
            ctx.decodeAudioData(base64ToArrayBuffer(statusBody.vocals_base64 as string)),
          ]);
          setProgress(100);
          setElapsed(0);
          setIsPlaying(false);
          setVocalLevel(DEFAULT_VOCAL_LEVEL);
          setDetectedTonic(null);
          setDetectedMode(null);
          setSelectedTonic(null);
          setPlaybackReady(false);
          setPitchShiftAvailable(true);
          setStems({
            title: (statusBody.title as string) || "song",
            instrumentalBuffer,
            vocalsBuffer,
          });
          setPhase("done");
        } catch (err) {
          console.error("Failed to load separated tracks for playback:", err);
          setPhase("error");
          setError("Got the separated tracks back, but couldn't load them for playback. Please try again.");
        }
      };

      pollTimer.current = setTimeout(pollStatus, POLL_INTERVAL_MS);
    } catch (err) {
      stopTimers();
      setPhase("error");
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    }
  }

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <p className={styles.brand}>
          Neville&apos;s <span>Song Stripper</span>
        </p>

        {phase === "idle" || phase === "error" ? (
          <form className={styles.form} onSubmit={handleSubmit}>
            <h1 className={styles.headline}>Choose a song to upload</h1>
            <p className={styles.subline}>
              Pick an MP3 (or other audio file) from your device.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*,video/mp4,.mp3,.m4a,.wav,.aac,.ogg,.flac,.mp4"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              style={{ display: "none" }}
              aria-label="Choose a song file"
            />
            <button
              type="button"
              className={`${styles.field} ${file ? "" : styles.fieldEmpty}`}
              onClick={() => fileInputRef.current?.click()}
            >
              {file ? file.name : "Tap to choose a file"}
            </button>
            {phase === "error" && <div className={styles.errorBanner}>{error}</div>}
            <button className={styles.cta} type="submit">
              Remove the singer
            </button>
          </form>
        ) : null}

        {phase === "working" ? (
          <>
            <div className={styles.eq} aria-hidden="true">
              <span></span><span></span><span></span><span></span><span></span><span></span>
            </div>
            <h1 className={styles.headline}>{WORKING_PHRASES[phraseIndex]}</h1>
            <p className={styles.subline}>
              This takes a minute or two. Feel free to leave this open.
            </p>
            <div className={styles.progressTrack}>
              <div className={styles.progressFill} style={{ width: `${progress}%` }} />
            </div>
            <p className={styles.statusCopy}>Working on it… {progress}%</p>
          </>
        ) : null}

        {phase === "done" && stems ? (
          <>
            <div className={styles.check} aria-hidden="true">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
                <path
                  d="M5 13l4 4L19 7"
                  stroke="#3cf28f"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <h1 className={styles.headline}>Your song is ready</h1>

            <div className={styles.trackCard}>
              <button
                type="button"
                className={styles.playButton}
                onClick={togglePlay}
                disabled={!playbackReady}
                aria-label={!playbackReady ? "Loading" : isPlaying ? "Pause" : "Play"}
              >
                {!playbackReady ? (
                  <span className={styles.spinner} aria-hidden="true" />
                ) : isPlaying ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="5" y="4" width="5" height="16" rx="1" />
                    <rect x="14" y="4" width="5" height="16" rx="1" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M7 4l14 8-14 8V4z" />
                  </svg>
                )}
              </button>
              <div className={styles.trackMeta}>
                <div className={styles.trackName}>{stems.title}</div>
                <div className={styles.trackSub}>
                  {playbackReady ? `${formatTime(elapsed)} / ${formatTime(duration)}` : "Preparing playback…"}
                </div>
              </div>
            </div>

            <div className={styles.sectionLabel}>Key</div>
            {playbackReady && !pitchShiftAvailable ? (
              <p className={styles.subline} style={{ marginTop: 0 }}>
                Key changing isn&apos;t available in this browser, but playback still works.
              </p>
            ) : (
              <KeyWheel
                detectedTonic={detectedTonic}
                detectedMode={detectedMode}
                selectedTonic={selectedTonic}
                onSelectTonic={setSelectedTonic}
                disabled={detectedTonic === null}
              />
            )}

            <div className={styles.sliderBlock}>
              <div className={styles.sliderLabelRow}>
                <span>Vocals</span>
                <span>{vocalLevel}%</span>
              </div>
              <input
                type="range"
                className={styles.slider}
                min={MIN_VOCAL_LEVEL}
                max={MAX_VOCAL_LEVEL}
                step={5}
                value={vocalLevel}
                onChange={(e) => handleVocalLevelChange(Number(e.target.value))}
                aria-label="Vocal volume"
              />
              <div className={styles.sliderLabelRow}>
                <span className={styles.trackSub}>Removed</span>
                <span className={styles.trackSub}>Original</span>
                <span className={styles.trackSub}>Boosted</span>
              </div>
            </div>

            <button className={styles.cta} type="button" onClick={handleDownload} disabled={isRendering}>
              {isRendering ? "Preparing download…" : "Download this mix"}
            </button>
            {error && <div className={styles.errorBanner}>{error}</div>}
            <button className={styles.ghostButton} onClick={resetToIdle}>
              Do another song
            </button>
          </>
        ) : null}
      </div>
    </main>
  );
}
