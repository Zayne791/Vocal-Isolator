"use client";

import { useCallback, useRef } from "react";
import { PITCH_CLASS_NAMES, shortestSemitoneDistance, type Mode } from "../lib/keyDetection";
import styles from "./KeyWheel.module.css";

const SIZE = 208;
const CENTER = SIZE / 2;
const LABEL_RADIUS = 82;
const NEEDLE_RADIUS = 62;
const TICK_OUTER_RADIUS = 96;
const TICK_INNER_RADIUS = 88;

function angleForPitchClass(pitchClass: number): number {
  return (pitchClass * Math.PI) / 6; // 30deg steps, 0 = up (12 o'clock)
}

function pointOnCircle(angleRad: number, radius: number): { x: number; y: number } {
  return {
    x: CENTER + radius * Math.sin(angleRad),
    y: CENTER - radius * Math.cos(angleRad),
  };
}

function pitchClassFromClientPoint(
  clientX: number,
  clientY: number,
  rect: DOMRect
): number {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = clientX - cx;
  const dy = clientY - cy;
  const angle = Math.atan2(dx, -dy); // 0 = up, clockwise positive
  const normalized = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return Math.round(normalized / (Math.PI / 6)) % 12;
}

type KeyWheelProps = {
  detectedTonic: number | null;
  detectedMode: Mode | null;
  selectedTonic: number | null;
  onSelectTonic: (tonic: number) => void;
  disabled?: boolean;
};

export default function KeyWheel({
  detectedTonic,
  detectedMode,
  selectedTonic,
  onSelectTonic,
  disabled,
}: KeyWheelProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const draggingRef = useRef(false);

  const applyPointFromEvent = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      onSelectTonic(pitchClassFromClientPoint(clientX, clientY, rect));
    },
    [onSelectTonic]
  );

  function handlePointerDown(event: React.PointerEvent<SVGSVGElement>) {
    if (disabled || detectedTonic === null) return;
    draggingRef.current = true;
    (event.target as Element).setPointerCapture?.(event.pointerId);
    applyPointFromEvent(event.clientX, event.clientY);
  }

  function handlePointerMove(event: React.PointerEvent<SVGSVGElement>) {
    if (!draggingRef.current) return;
    applyPointFromEvent(event.clientX, event.clientY);
  }

  function handlePointerUp() {
    draggingRef.current = false;
  }

  function step(delta: number) {
    if (detectedTonic === null || selectedTonic === null) return;
    onSelectTonic(((selectedTonic + delta) % 12 + 12) % 12);
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (disabled || detectedTonic === null) return;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      step(1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault();
      step(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      onSelectTonic(detectedTonic);
    }
  }

  const shift =
    detectedTonic !== null && selectedTonic !== null
      ? shortestSemitoneDistance(detectedTonic, selectedTonic)
      : 0;
  const resultName =
    selectedTonic !== null && detectedMode
      ? `${PITCH_CLASS_NAMES[selectedTonic]} ${detectedMode}`
      : null;
  const detectedName =
    detectedTonic !== null && detectedMode ? `${PITCH_CLASS_NAMES[detectedTonic]} ${detectedMode}` : null;

  const needleAngle = selectedTonic !== null ? angleForPitchClass(selectedTonic) : 0;
  const needleTip = pointOnCircle(needleAngle, NEEDLE_RADIUS);
  const originMarker = detectedTonic !== null ? pointOnCircle(angleForPitchClass(detectedTonic), TICK_INNER_RADIUS) : null;

  return (
    <div className={styles.block}>
      <div className={styles.wheelWrap}>
        <svg
          ref={svgRef}
          className={`${styles.wheel} ${disabled ? styles.wheelDisabled : ""}`}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          width={SIZE}
          height={SIZE}
          role="slider"
          aria-label="Song key"
          aria-valuemin={-6}
          aria-valuemax={6}
          aria-valuenow={shift}
          aria-valuetext={resultName ?? "Detecting key"}
          tabIndex={disabled ? -1 : 0}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onKeyDown={handleKeyDown}
        >
          <circle cx={CENTER} cy={CENTER} r={TICK_OUTER_RADIUS + 8} className={styles.wheelBg} />

          {PITCH_CLASS_NAMES.map((name, pitchClass) => {
            const angle = angleForPitchClass(pitchClass);
            const tickOuter = pointOnCircle(angle, TICK_OUTER_RADIUS);
            const tickInner = pointOnCircle(angle, TICK_INNER_RADIUS);
            const labelPoint = pointOnCircle(angle, LABEL_RADIUS);
            const isSelected = pitchClass === selectedTonic;
            const isOrigin = pitchClass === detectedTonic;
            return (
              <g
                key={name}
                className={styles.tickGroup}
                onClick={() => !disabled && detectedTonic !== null && onSelectTonic(pitchClass)}
              >
                <line
                  x1={tickInner.x}
                  y1={tickInner.y}
                  x2={tickOuter.x}
                  y2={tickOuter.y}
                  className={isOrigin ? styles.tickOrigin : styles.tick}
                />
                <text
                  x={labelPoint.x}
                  y={labelPoint.y}
                  className={`${styles.tickLabel} ${isSelected ? styles.tickLabelSelected : ""}`}
                  textAnchor="middle"
                  dominantBaseline="middle"
                >
                  {name}
                </text>
              </g>
            );
          })}

          {originMarker && selectedTonic !== detectedTonic && (
            <circle cx={originMarker.x} cy={originMarker.y} r={3.5} className={styles.originDot} />
          )}

          {selectedTonic !== null && (
            <g className={styles.needle}>
              <line x1={CENTER} y1={CENTER} x2={needleTip.x} y2={needleTip.y} />
              <circle cx={needleTip.x} cy={needleTip.y} r={6} />
            </g>
          )}

          <circle cx={CENTER} cy={CENTER} r={4} className={styles.hub} />
        </svg>

        <div className={styles.centerReadout} aria-hidden="true">
          {resultName ? (
            <>
              <span className={styles.centerKey}>{resultName}</span>
              <span className={styles.centerShift}>
                {shift === 0 ? "original key" : `${shift > 0 ? "+" : ""}${shift} semitone${Math.abs(shift) === 1 ? "" : "s"}`}
              </span>
            </>
          ) : (
            <span className={styles.centerKey}>Detecting…</span>
          )}
        </div>
      </div>

      <div className={styles.controls}>
        <button
          type="button"
          className={styles.stepButton}
          onClick={() => step(-1)}
          disabled={disabled || detectedTonic === null}
          aria-label="Transpose down a semitone"
        >
          −
        </button>
        <div className={styles.controlsMeta}>
          {detectedName ? (
            <>
              <span className={styles.detectedLabel}>Detected key: {detectedName}</span>
              {selectedTonic !== detectedTonic && (
                <button
                  type="button"
                  className={styles.resetLink}
                  onClick={() => detectedTonic !== null && onSelectTonic(detectedTonic)}
                >
                  Reset to detected key
                </button>
              )}
            </>
          ) : (
            <span className={styles.detectedLabel}>Listening for the key…</span>
          )}
        </div>
        <button
          type="button"
          className={styles.stepButton}
          onClick={() => step(1)}
          disabled={disabled || detectedTonic === null}
          aria-label="Transpose up a semitone"
        >
          +
        </button>
      </div>
    </div>
  );
}
