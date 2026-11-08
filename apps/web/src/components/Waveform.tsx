"use client";

import { useEffect, useRef } from "react";

export interface WaveTrack {
  color: string;
  peaks: number[];
}

interface Props {
  tracks: WaveTrack[];
  height?: number;
  /** Playhead position, 0..1. */
  progress?: number;
  /** Selected range, 0..1, drawn brighter than the rest. */
  selection?: { start: number; end: number };
  /** Called with 0..1 when the user clicks or drags on the wave. */
  onSeek?: (fraction: number) => void;
  background?: string;
  className?: string;
}

/**
 * The Oku waveform: one mirrored band per speaker, stacked, in that speaker's colour.
 * Used on the landing page, in the Studio timeline and as the cover preview.
 */
export function Waveform({ tracks, height = 160, progress, selection, onSeek, background, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = height;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (background) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, w, h);
      }
      const n = tracks.length || 1;
      const gap = 6;
      const bandH = (h - gap * (n - 1)) / n;
      const barW = 2;
      const step = 3;
      const bars = Math.floor(w / step);

      tracks.forEach((t, ti) => {
        const top = ti * (bandH + gap);
        const mid = top + bandH / 2;
        for (let i = 0; i < bars; i++) {
          const frac = i / bars;
          const idx = Math.min(t.peaks.length - 1, Math.floor(frac * t.peaks.length));
          const p = t.peaks[idx] ?? 0;
          const amp = Math.max(1, p * (bandH / 2 - 2));
          let alpha = 1;
          if (selection) alpha = frac >= selection.start && frac <= selection.end ? 1 : 0.28;
          if (progress != null && frac > progress) alpha *= 0.55;
          ctx.globalAlpha = alpha;
          ctx.fillStyle = t.color;
          ctx.fillRect(i * step, mid - amp, barW, amp * 2);
        }
      });
      ctx.globalAlpha = 1;

      if (selection) {
        ctx.fillStyle = "rgba(23,26,43,0.9)";
        ctx.fillRect(selection.start * w - 1, 0, 2, h);
        ctx.fillRect(selection.end * w - 1, 0, 2, h);
      }
      if (progress != null) {
        ctx.fillStyle = "#171a2b";
        ctx.fillRect(progress * w - 1, 0, 2, h);
      }
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [tracks, height, progress, selection, background]);

  const seekFromEvent = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!onSeek) return;
    const rect = e.currentTarget.getBoundingClientRect();
    onSeek(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
  };

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: "100%", height, display: "block", cursor: onSeek ? "pointer" : "default", touchAction: "none" }}
      onPointerDown={(e) => {
        if (!onSeek) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        seekFromEvent(e);
      }}
      onPointerMove={(e) => {
        if (onSeek && e.buttons & 1) seekFromEvent(e);
      }}
      role={onSeek ? "slider" : "img"}
      aria-label="Waveform"
    />
  );
}
