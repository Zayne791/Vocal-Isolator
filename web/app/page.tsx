"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./page.module.css";

const API_BASE = process.env.NEXT_PUBLIC_STRIPPER_API_URL;

const WORKING_PHRASES = [
  "Listening to the song…",
  "Finding the singer's voice…",
  "Almost done…",
];

type Phase = "idle" | "working" | "done" | "error";

type DoneResult = {
  filename: string;
  audioUrl: string;
};

function base64ToBlobUrl(base64: string, mimeType: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [phraseIndex, setPhraseIndex] = useState(0);
  const [progress, setProgress] = useState(8);
  const [result, setResult] = useState<DoneResult | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const phraseTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
      if (phraseTimer.current) clearInterval(phraseTimer.current);
    };
  }, []);

  function stopTimers() {
    if (pollTimer.current) clearInterval(pollTimer.current);
    if (phraseTimer.current) clearInterval(phraseTimer.current);
  }

  function resetToIdle() {
    stopTimers();
    setPhase("idle");
    setFile(null);
    setResult(null);
    setError("");
    setProgress(8);
    setPhraseIndex(0);
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

      pollTimer.current = setInterval(async () => {
        setProgress((p) => Math.min(p + 4, 92));

        try {
          const statusResponse = await fetch(`${API_BASE}/status?call_id=${call_id}`);
          const statusBody = await statusResponse.json();

          if (statusBody.state === "pending") {
            return;
          }

          stopTimers();

          if (statusBody.state === "error") {
            setPhase("error");
            setError(statusBody.message || "Something went wrong separating that song. Please try again.");
            return;
          }

          setProgress(100);
          setResult({
            filename: statusBody.filename,
            audioUrl: base64ToBlobUrl(statusBody.audio_base64, "audio/mpeg"),
          });
          setPhase("done");
        } catch {
          stopTimers();
          setPhase("error");
          setError("Lost connection while working on that song. Please try again.");
        }
      }, 3000);
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
            <p className={styles.statusCopy}>Working on it…</p>
          </>
        ) : null}

        {phase === "done" && result ? (
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
              <div className={styles.trackArt} aria-hidden="true"></div>
              <div className={styles.trackMeta}>
                <div className={styles.trackName}>{result.filename}</div>
                <div className={styles.trackSub}>MP3</div>
              </div>
            </div>
            <a className={styles.downloadLink} href={result.audioUrl} download={result.filename}>
              Download MP3
            </a>
            <button className={styles.ghostButton} onClick={resetToIdle}>
              Do another song
            </button>
          </>
        ) : null}
      </div>
    </main>
  );
}
