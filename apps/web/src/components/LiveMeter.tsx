"use client";

import { useEffect, useRef } from "react";

let sharedCtx: AudioContext | null = null;
function audioContext() {
  if (!sharedCtx) sharedCtx = new AudioContext();
  if (sharedCtx.state === "suspended") void sharedCtx.resume();
  return sharedCtx;
}

/**
 * A scrolling live waveform for one person in the call, drawn in their colour.
 * Flat when they are quiet, alive when they speak — the same picture the
 * exported cover will show.
 */
export function LiveMeter({ stream, color, height = 72 }: { stream: MediaStream | null; color: string; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !stream || stream.getAudioTracks().length === 0) return;
    const ctx = canvas.getContext("2d")!;
    const ac = audioContext();
    const source = ac.createMediaStreamSource(stream);
    const analyser = ac.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const history: number[] = [];
    let raf = 0;
    let lastPush = 0;

    const frame = (t: number) => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      if (t - lastPush > 40) {
        history.push(Math.min(1, rms * 3.2));
        lastPush = t;
      }
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = height;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const step = 4;
      const bars = Math.floor(w / step);
      while (history.length > bars) history.shift();
      ctx.fillStyle = color;
      const mid = h / 2;
      for (let i = 0; i < history.length; i++) {
        const amp = Math.max(1.5, history[i] * (mid - 2));
        const x = w - (history.length - i) * step;
        ctx.fillRect(x, mid - amp, 2.5, amp * 2);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      source.disconnect();
      analyser.disconnect();
    };
  }, [stream, color, height]);

  return <canvas ref={canvasRef} style={{ width: "100%", height, display: "block" }} aria-hidden />;
}
