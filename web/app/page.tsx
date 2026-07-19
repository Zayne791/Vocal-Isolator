"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./page.module.css";

const API_BASE = process.env.NEXT_PUBLIC_STRIPPER_API_URL;

const WORKING_PHRASES = [
  "Listening to the song…",
  "Finding the singer's voice…",
  "Almost done…",
];

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 15000;
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

  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const phraseTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const instrumentalSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const vocalsSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const vocalGainRef = useRef<GainNode | null>(null);
  const playStartCtxTimeRef = useRef(0);
  const playOffsetRef = useRef(0);
  const playTokenRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  function getAudioContext(): AudioContext {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
    }
    return audioCtxRef.current;
  }

  function stopSources() {
    try {
      instrumentalSourceRef.current?.stop();
    } catch {
      // already stopped/ended - fine
    }
    try {
      vocalsSourceRef.current?.stop();
    } catch {
      // already stopped/ended - fine
    }
    instrumentalSourceRef.current = null;
    vocalsSourceRef.current = null;
  }

  const startPlayback = useCallback(
    (offset: number, current: Stems) => {
      const ctx = getAudioContext();
      const myToken = ++playTokenRef.current;
      stopSources();

      const instrumentalSource = ctx.createBufferSource();
      instrumentalSource.buffer = current.instrumentalBuffer;
      instrumentalSource.connect(ctx.destination);

      const vocalsSource = ctx.createBufferSource();
      vocalsSource.buffer = current.vocalsBuffer;
      const gainNode = ctx.createGain();
      gainNode.gain.value = vocalLevel / 100;
      vocalsSource.connect(gainNode).connect(ctx.destination);

      instrumentalSource.onended = () => {
        if (playTokenRef.current !== myToken) return; // superseded by a later play/pause
        setIsPlaying(false);
        setElapsed(0);
        playOffsetRef.current = 0;
      };

      instrumentalSource.start(0, offset);
      vocalsSource.start(0, offset);

      instrumentalSourceRef.current = instrumentalSource;
      vocalsSourceRef.current = vocalsSource;
      vocalGainRef.current = gainNode;
      playStartCtxTimeRef.current = ctx.currentTime;
      playOffsetRef.current = offset;
      setIsPlaying(true);
    },
    [vocalLevel]
  );

  function pausePlayback() {
    if (!audioCtxRef.current) return;
    const ctx = audioCtxRef.current;
    const duration = stems?.instrumentalBuffer.duration ?? 0;
    const elapsedNow = Math.min(
      playOffsetRef.current + (ctx.currentTime - playStartCtxTimeRef.current),
      duration
    );
    playTokenRef.current++; // invalidate the pending onended from the current sources
    stopSources();
    playOffsetRef.current = elapsedNow;
    setElapsed(elapsedNow);
    setIsPlaying(false);
  }

  function togglePlay() {
    if (!stems) return;
    if (isPlaying) {
      pausePlayback();
      return;
    }
    const ctx = getAudioContext();
    if (ctx.state === "suspended") ctx.resume();
    const duration = stems.instrumentalBuffer.duration;
    const startOffset = playOffsetRef.current >= duration - 0.05 ? 0 : playOffsetRef.current;
    startPlayback(startOffset, stems);
  }

  function handleVocalLevelChange(value: number) {
    setVocalLevel(value);
    if (vocalGainRef.current) {
      vocalGainRef.current.gain.value = value / 100;
    }
  }

  // Live progress readout while playing.
  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }
    const ctx = getAudioContext();
    const duration = stems?.instrumentalBuffer.duration ?? 0;
    const tick = () => {
      const now = playOffsetRef.current + (ctx.currentTime - playStartCtxTimeRef.current);
      setElapsed(Math.min(now, duration));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
      if (phraseTimer.current) clearInterval(phraseTimer.current);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      stopSources();
      audioCtxRef.current?.close();
    };
  }, []);

  function stopTimers() {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    if (phraseTimer.current) clearInterval(phraseTimer.current);
  }

  function resetToIdle() {
    stopTimers();
    stopSources();
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    setPhase("idle");
    setFile(null);
    setStems(null);
    setVocalLevel(DEFAULT_VOCAL_LEVEL);
    setIsPlaying(false);
    setElapsed(0);
    playOffsetRef.current = 0;
    setError("");
    setProgress(8);
    setPhraseIndex(0);
  }

  async function handleDownload() {
    if (!stems) return;
    setIsRendering(true);
    try {
      const length = Math.max(stems.instrumentalBuffer.length, stems.vocalsBuffer.length);
      const offlineCtx = new OfflineAudioContext(2, length, stems.instrumentalBuffer.sampleRate);

      const instrumentalSource = offlineCtx.createBufferSource();
      instrumentalSource.buffer = stems.instrumentalBuffer;
      instrumentalSource.connect(offlineCtx.destination);
      instrumentalSource.start(0);

      const vocalsSource = offlineCtx.createBufferSource();
      vocalsSource.buffer = stems.vocalsBuffer;
      const gainNode = offlineCtx.createGain();
      gainNode.gain.value = vocalLevel / 100;
      vocalsSource.connect(gainNode).connect(offlineCtx.destination);
      vocalsSource.start(0);

      const rendered = await offlineCtx.startRendering();
      const blob = audioBufferToWavBlob(rendered);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${stems.title} (vocals ${vocalLevel}%).wav`;
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

        try {
          const statusResponse = await fetch(`${API_BASE}/status?call_id=${call_id}`, {
            signal: controller.signal,
          });
          const statusBody = await statusResponse.json();
          consecutiveFailures = 0;

          if (statusBody.state === "pending") {
            setProgress((p) => Math.min(p + 4, 92));
            pollTimer.current = setTimeout(pollStatus, POLL_INTERVAL_MS);
            return;
          }

          if (statusBody.state === "error") {
            stopTimers();
            setPhase("error");
            setError(statusBody.message || "Something went wrong separating that song. Please try again.");
            return;
          }

          stopTimers();
          setProgress(100);

          try {
            const ctx = getAudioContext();
            const [instrumentalBuffer, vocalsBuffer] = await Promise.all([
              ctx.decodeAudioData(base64ToArrayBuffer(statusBody.instrumental_base64)),
              ctx.decodeAudioData(base64ToArrayBuffer(statusBody.vocals_base64)),
            ]);
            playOffsetRef.current = 0;
            setElapsed(0);
            setIsPlaying(false);
            setVocalLevel(DEFAULT_VOCAL_LEVEL);
            setStems({
              title: statusBody.title || "song",
              instrumentalBuffer,
              vocalsBuffer,
            });
            setPhase("done");
          } catch {
            setPhase("error");
            setError("Got the separated tracks back, but couldn't load them for playback. Please try again.");
          }
        } catch {
          // A single stalled request (flaky connection, backgrounded tab)
          // shouldn't kill the whole job - only give up after several in a row.
          consecutiveFailures += 1;
          if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
            stopTimers();
            setPhase("error");
            setError("Lost connection while working on that song. Please try again.");
            return;
          }
          setProgress((p) => Math.min(p + 4, 92));
          pollTimer.current = setTimeout(pollStatus, POLL_INTERVAL_MS);
        } finally {
          clearTimeout(abortTimer);
        }
      };

      pollTimer.current = setTimeout(pollStatus, POLL_INTERVAL_MS);
    } catch (err) {
      stopTimers();
      setPhase("error");
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    }
  }

  const duration = stems?.instrumentalBuffer.duration ?? 0;

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
                aria-label={isPlaying ? "Pause" : "Play"}
              >
                {isPlaying ? (
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
                  {formatTime(elapsed)} / {formatTime(duration)}
                </div>
              </div>
            </div>

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
