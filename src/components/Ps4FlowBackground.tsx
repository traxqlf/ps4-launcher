import { useEffect, useRef } from "react";

/**
 * Fond « Flow » PS4 : dégradé atmosphérique CSS fixe, rubans lumineux et
 * poussières bokeh dessinés sur un canvas 2D natif. Aucune dépendance externe.
 *
 * La boucle est plafonnée à 30 images/s et s'arrête complètement quand le fond
 * est masqué (`paused`) ou que le launcher est minimisé (`document.hidden`).
 */

const PARTICLE_COUNT = 28;
const DPR_CAP = 1.5;
const FRAME_INTERVAL = 1000 / 30;
const TAU = Math.PI * 2;

interface Wave {
  baseline: number;
  amplitude: number;
  thickness: number;
  speed: number;
  phase: number;
  frequency: number;
  color: string;
  opacity: number;
}

// Cinq rubans déphasés : bleu cyan, bleu électrique et blanc glacé.
const WAVES: Wave[] = [
  {
    baseline: 0.24,
    amplitude: 0.052,
    thickness: 0.075,
    speed: 0.11,
    phase: 0.3,
    frequency: 0.9,
    color: "56, 189, 248",
    opacity: 0.1,
  },
  {
    baseline: 0.42,
    amplitude: 0.062,
    thickness: 0.095,
    speed: -0.085,
    phase: 2.1,
    frequency: 0.7,
    color: "0, 114, 206",
    opacity: 0.15,
  },
  {
    baseline: 0.6,
    amplitude: 0.045,
    thickness: 0.07,
    speed: 0.072,
    phase: 4.3,
    frequency: 1.25,
    color: "235, 249, 255",
    opacity: 0.06,
  },
  {
    baseline: 0.76,
    amplitude: 0.055,
    thickness: 0.105,
    speed: -0.062,
    phase: 1.2,
    frequency: 0.62,
    color: "0, 114, 206",
    opacity: 0.13,
  },
  {
    baseline: 0.9,
    amplitude: 0.036,
    thickness: 0.065,
    speed: 0.094,
    phase: 5.1,
    frequency: 1.05,
    color: "56, 189, 248",
    opacity: 0.08,
  },
];

interface Particle {
  x: number;
  y: number;
  radius: number;
  velocityX: number;
  velocityY: number;
  phase: number;
  twinkleSpeed: number;
}

function rgba(color: string, alpha: number): string {
  return `rgba(${color}, ${alpha})`;
}

function createParticles(width: number, height: number): Particle[] {
  return Array.from({ length: PARTICLE_COUNT }, () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    // Diamètre final de 1 à 2,5 px.
    radius: 0.5 + Math.random() * 0.75,
    velocityX: 3 + Math.random() * 7,
    velocityY: 1.5 + Math.random() * 4.5,
    phase: Math.random() * TAU,
    twinkleSpeed: 0.5 + Math.random() * 1.2,
  }));
}

export function Ps4FlowBackground({ paused = false }: { paused?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const startRef = useRef<() => void>(() => {});
  const stopRef = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    let width = 0;
    let height = 0;
    let particles: Particle[] = [];
    let frame = 0;
    let last = 0;
    let elapsed = 0;

    const drawWaves = (time: number) => {
      for (const wave of WAVES) {
        const baseline = wave.baseline * height;
        const amplitude = wave.amplitude * height;
        const thickness = wave.thickness * height;

        const gradient = context.createLinearGradient(
          0,
          baseline - amplitude,
          0,
          baseline + thickness + amplitude,
        );
        gradient.addColorStop(0, rgba(wave.color, 0));
        gradient.addColorStop(
          0.24,
          rgba("240, 251, 255", wave.opacity * 0.55),
        );
        gradient.addColorStop(0.58, rgba(wave.color, wave.opacity));
        gradient.addColorStop(1, rgba(wave.color, 0));

        const steps = Math.min(160, Math.max(48, Math.round(width / 16)));
        const xs: number[] = [];
        const upper: number[] = [];

        for (let index = 0; index <= steps; index += 1) {
          const x = (index / steps) * width;
          const angle = (x / width) * TAU * wave.frequency;
          const primary = Math.sin(angle + time * wave.speed + wave.phase);
          const secondary = Math.sin(
            angle * 2.35 - time * wave.speed * 0.65 + wave.phase * 1.7,
          );
          xs.push(x);
          upper.push(baseline + (primary + secondary * 0.35) * amplitude);
        }

        context.beginPath();
        context.moveTo(xs[0], upper[0]);
        for (let index = 1; index < upper.length; index += 1) {
          context.lineTo(xs[index], upper[index]);
        }
        for (let index = upper.length - 1; index >= 0; index -= 1) {
          const lip =
            0.72 +
            0.28 *
              Math.sin(
                (xs[index] / width) * TAU * wave.frequency * 1.7 +
                  time * wave.speed * 0.8 +
                  wave.phase,
              );
          context.lineTo(xs[index], upper[index] + thickness * lip);
        }
        context.closePath();
        context.fillStyle = gradient;
        context.fill();
      }
    };

    const drawParticles = (time: number, delta: number) => {
      for (const particle of particles) {
        particle.x += particle.velocityX * delta;
        particle.y += particle.velocityY * delta;
        if (particle.x > width + 4) {
          particle.x = -4;
          particle.y = Math.random() * height;
        }
        if (particle.y > height + 4) {
          particle.y = -4;
          particle.x = Math.random() * width;
        }

        const twinkle =
          0.5 + 0.5 * Math.sin(time * particle.twinkleSpeed + particle.phase);
        const alpha = 0.28 + 0.5 * twinkle;

        context.fillStyle = rgba("210, 245, 255", alpha * 0.14);
        context.beginPath();
        context.arc(
          particle.x,
          particle.y,
          particle.radius * 3.2,
          0,
          TAU,
        );
        context.fill();

        context.fillStyle = rgba("245, 252, 255", alpha);
        context.beginPath();
        context.arc(particle.x, particle.y, particle.radius, 0, TAU);
        context.fill();
      }
    };

    const draw = (time: number, delta: number) => {
      if (width <= 0 || height <= 0) return;
      context.clearRect(0, 0, width, height);
      context.save();
      context.globalCompositeOperation = "lighter";
      drawWaves(time);
      drawParticles(time, delta);
      context.restore();
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      particles = createParticles(width, height);
      if (!pausedRef.current && !document.hidden) draw(elapsed, 0);
    };

    const stop = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };

    const tick = (now: number) => {
      if (pausedRef.current || document.hidden) {
        frame = 0;
        return;
      }
      const delta = now - last;
      if (delta < FRAME_INTERVAL) {
        frame = requestAnimationFrame(tick);
        return;
      }
      const dt = Math.min(0.05, delta / 1000);
      last = now;
      elapsed += dt;
      draw(elapsed, dt);
      frame = requestAnimationFrame(tick);
    };

    const start = () => {
      if (frame || pausedRef.current || document.hidden || reducedMotion) return;
      last = performance.now();
      frame = requestAnimationFrame(tick);
    };

    startRef.current = start;
    stopRef.current = stop;

    resize();
    start();

    const onResize = () => resize();
    const onVisibilityChange = () => {
      if (document.hidden) stop();
      else start();
    };

    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stop();
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      startRef.current = () => {};
      stopRef.current = () => {};
    };
  }, []);

  useEffect(() => {
    if (paused) stopRef.current();
    else startRef.current();
  }, [paused]);

  return (
    <div
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
      aria-hidden="true"
    >
      <div className="ps4-flow-atmosphere absolute inset-0" />
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      <div className="ps4-flow-vignette absolute inset-0" />
    </div>
  );
}
