import { useEffect, useState } from "react";
import type { Game } from "../types";

/**
 * Écran de démarrage plein écran, affiché pendant la transition avant que le
 * launcher ne se minimise : fond du jeu en zoom lent, ou dégradé PS4 avec la
 * jaquette et le titre quand le jeu n'a pas d'arrière-plan dédié.
 */

interface Ps4SplashScreenProps {
  game: Game;
}

export function Ps4SplashScreen({ game }: Ps4SplashScreenProps) {
  const [entered, setEntered] = useState(false);

  // Un premier rendu à l'état de repos, puis la transition : le zoom et le
  // fondu partent réellement de 0 au lieu de sauter directement à l'arrivée.
  useEffect(() => {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setEntered(true));
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const background = game.bg_url;
  const cover = game.cover_url;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-black">
      {background ? (
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{
            backgroundImage: `url("${background}")`,
            opacity: entered ? 1 : 0,
            transform: entered ? "scale(1.05)" : "scale(1)",
            transition:
              "opacity 900ms ease-out, transform 1800ms cubic-bezier(0.22, 1, 0.36, 1)",
          }}
          aria-hidden="true"
        />
      ) : (
        <>
          <div
            className="absolute inset-0 bg-gradient-to-b from-[#001845] via-[#002b75] to-[#000d24]"
            aria-hidden="true"
          />
          <div className="relative flex flex-col items-center px-10 text-center">
            {cover ? (
              <img
                src={cover}
                alt=""
                className="h-52 w-52 rounded-lg object-cover shadow-[0_25px_60px_rgba(0,0,0,0.6)]"
                style={{
                  opacity: entered ? 1 : 0,
                  transform: entered ? "scale(1)" : "scale(0.97)",
                  transition:
                    "opacity 900ms ease-out, transform 1200ms cubic-bezier(0.22, 1, 0.36, 1)",
                }}
              />
            ) : (
              <div
                className="flex h-52 w-52 items-center justify-center rounded-lg border border-white/15 bg-[#0d2a5c] text-5xl font-semibold text-white/80 shadow-[0_25px_60px_rgba(0,0,0,0.6)]"
                style={{
                  opacity: entered ? 1 : 0,
                  transition: "opacity 900ms ease-out",
                }}
              >
                {(game.title.trim().charAt(0) || "?").toUpperCase()}
              </div>
            )}
            <h1
              className="mt-7 max-w-3xl text-3xl font-semibold tracking-wide text-white drop-shadow-[0_4px_18px_rgba(0,0,0,0.7)]"
              style={{
                opacity: entered ? 1 : 0,
                transition: "opacity 1100ms ease-out 120ms",
              }}
            >
              {game.title}
            </h1>
          </div>
        </>
      )}

      {/* Léger voile : le texte et la jaquette restent lisibles sur un fond clair. */}
      <div
        className="absolute inset-0 bg-black/25"
        style={{ opacity: entered ? 1 : 0, transition: "opacity 900ms ease-out" }}
        aria-hidden="true"
      />

      <div
        role="status"
        aria-live="polite"
        className="sr-only"
      >
        Démarrage de {game.title}
      </div>
    </div>
  );
}
