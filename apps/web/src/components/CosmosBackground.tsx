import { useEffect, useRef, type ReactElement } from 'react';

/**
 * Decorative starfield only (definition.md law 6: the universe canvas is
 * meaningful, not decorative -- this background carries no typed semantic
 * change and is aria-hidden). Static seeded placement; the only motion is a
 * gentle CSS twinkle gated behind `prefers-reduced-motion: no-preference`.
 */
export function CosmosBackground(): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    let frame = 0;
    const draw = () => {
      const { width, height } = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = '#03101a';
      context.fillRect(0, 0, width, height);
      const palette = ['#B7C3CC', '#8FA3B0', '#E9E3CE', '#33C4B4'];
      // A fixed linear congruential generator: seeded, deterministic, decorative only.
      let seed = 7317;
      const next = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return (seed % 10000) / 10000;
      };
      for (let i = 0; i < 140; i++) {
        const x = next() * width;
        const y = next() * height;
        const bucket = Math.floor(next() * 10);
        const radius = bucket <= 6 ? 0.6 + next() * 0.4 : bucket <= 8 ? 1.0 + next() * 0.6 : 1.4 + next() * 0.8;
        context.globalAlpha = radius > 1.4 ? 0.95 : 0.7;
        context.fillStyle = palette[Math.floor(next() * palette.length)] ?? '#B7C3CC';
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
      }
    };
    draw();
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    });
    observer.observe(canvas);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className="cosmos-background" aria-hidden="true" />;
}
