import { useEffect, useRef } from "react";
import { hasSystemModifier, isTypingTarget } from "../hooks/useGamepad";

interface BootScreenProps {
  /** Vrai pendant les 500 ms de fondu vers le menu. */
  fading: boolean;
  /** Demande la fin du boot (naturelle, clic, touche ou Croix). */
  onSkip: () => void;
}

const BOOT_DURATION_MS = 3200;

// Icônes officielles des boutons PS4, posées sur le cercle du logo de démarrage.
const BOOT_ICON = "absolute h-10 w-10 object-contain";

const BOOT_STYLES = `
@keyframes ps4-boot-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes ps4-boot-emblem {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes ps4-boot-subtitle {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes ps4-boot-glow {
  from { opacity: 0; transform: scale(0.9); }
  to { opacity: 1; transform: scale(1); }
}
.ps4-boot-light { animation: ps4-boot-fade 2s ease-out 0.1s both; }
.ps4-boot-particles { animation: ps4-boot-fade 2.4s ease-out 0.35s both; }
.ps4-boot-emblem {
  animation: ps4-boot-emblem 1.2s cubic-bezier(0.22, 0.8, 0.24, 1) 0.45s both;
  filter: drop-shadow(0 0 26px rgba(150, 205, 255, 0.55));
}
.ps4-boot-subtitle { animation: ps4-boot-subtitle 0.9s ease-out 1.3s both; }
.ps4-boot-halo {
  background: radial-gradient(circle, rgba(90, 170, 255, 0.35), transparent 65%);
  animation: ps4-boot-glow 1.6s ease-out 0.4s both;
}
@media (prefers-reduced-motion: reduce) {
  .ps4-boot-light,
  .ps4-boot-particles,
  .ps4-boot-emblem,
  .ps4-boot-subtitle,
  .ps4-boot-halo {
    animation-duration: 0.01ms;
    animation-delay: 0ms;
  }
}
`;

export function BootScreen({ fading, onSkip }: BootScreenProps) {
  const skipRef = useRef(onSkip);
  skipRef.current = onSkip;

  useEffect(() => {
    const timer = window.setTimeout(() => skipRef.current(), BOOT_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (hasSystemModifier(event) || event.repeat) return;
      if (isTypingTarget(event.target)) return;

      const id = event.key.toLowerCase();
      // Le boot se saute avec Croix (A, Entrée) comme avec Rond (B, Échap).
      const isSkipKey =
        id === "a" ||
        id === "b" ||
        id === "enter" ||
        id === "escape" ||
        event.key === " ";
      if (!isSkipKey) return;

      event.preventDefault();
      // Empêche le hook gamepad global de valider/lancer pendant le boot.
      event.stopImmediatePropagation();
      skipRef.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  return (
    <div
      onPointerDown={() => skipRef.current()}
      role="status"
      aria-live="polite"
      className={`fixed inset-0 z-[60] flex items-center justify-center overflow-hidden bg-black transition-opacity duration-500 ease-out ${
        fading ? "opacity-0" : "opacity-100"
      }`}
    >
      <style>{BOOT_STYLES}</style>

      <div
        className="ps4-boot-light absolute inset-0"
        style={{
          background:
            "radial-gradient(62% 62% at 50% 44%, rgba(70, 150, 255, 0.5), transparent 70%)," +
            "radial-gradient(120% 120% at 50% 55%, #0a3a8f 0%, #00245d 38%, #001538 68%, #000000 100%)",
        }}
        aria-hidden="true"
      />

      <div className="ps4-boot-particles absolute inset-0" aria-hidden="true">
        <div className="ps4-particles absolute inset-0 opacity-60" />
      </div>

      <div className="relative flex flex-col items-center">
        <div className="ps4-boot-emblem relative flex h-32 w-32 items-center justify-center">
          <div className="ps4-boot-halo absolute inset-[-46px] rounded-full blur-2xl" aria-hidden="true" />
          <div
            className="relative h-28 w-28 rounded-full border border-white/15"
            aria-hidden="true"
          >
            <img
              src="/buttons/PS4_Triangle.png"
              alt=""
              className={`${BOOT_ICON} left-1/2 top-0 -translate-x-1/2 -translate-y-1/2`}
            />
            <img
              src="/buttons/PS4_Circle.png"
              alt=""
              className={`${BOOT_ICON} right-0 top-1/2 -translate-y-1/2 translate-x-1/2`}
            />
            <img
              src="/buttons/PS4_Cross.png"
              alt=""
              className={`${BOOT_ICON} bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2`}
            />
            <img
              src="/buttons/PS4_Square.png"
              alt=""
              className={`${BOOT_ICON} left-0 top-1/2 -translate-x-1/2 -translate-y-1/2`}
            />
          </div>
        </div>

        <p className="ps4-boot-subtitle mt-10 text-[11px] font-light tracking-[0.42em] text-white/45">
          Préparation du système…
        </p>
      </div>
    </div>
  );
}
