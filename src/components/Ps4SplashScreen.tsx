import { useEffect, useState, type CSSProperties } from "react";
import type { Game } from "../types";

/**
 * Écran de démarrage plein écran, affiché pendant la transition avant que le
 * launcher ne se minimise : fond du jeu, ou dégradé PS4 avec la jaquette et le
 * titre quand le jeu n'a pas d'arrière-plan dédié.
 *
 * Géométrie : un conteneur plein écran noir verrouille le viewport, et un cadre
 * 16:9 strict y est centré. L'image est en `object-fit: contain`, donc elle est
 * toujours visible en entier — jamais rognée, jamais décalée dans un angle,
 * quel que soit le ratio de la fenêtre (16:10, 16:9, fenêtre redimensionnée).
 *
 * Performance : deux `requestAnimationFrame` seulement pour amorcer le fondu,
 * puis plus aucune boucle. Aucun travail une fois le jeu lancé.
 */

interface Ps4SplashScreenProps {
  game: Game;
}

// Conteneur plein écran verrouillé : rien ne peut déborder du viewport.
const OVERLAY_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  width: "100vw",
  height: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: "#000000",
  overflow: "hidden",
  zIndex: 9999,
};

// Cadre 16:9 exact, toujours intégralement contenu dans le viewport.
const FRAME_STYLE: CSSProperties = {
  position: "relative",
  aspectRatio: "16 / 9",
  width: "min(100vw, calc(100vh * 16 / 9))",
  height: "min(100vh, calc(100vw * 9 / 16))",
  maxWidth: "100%",
  maxHeight: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  overflow: "hidden",
  // Fond subtil derrière une image qui n'est pas nativement 16:9.
  backgroundColor: "#021029",
  transformOrigin: "center center",
};

// Image du splash : toute l'image, centrée, sans étirement ni rognage.
const MEDIA_STYLE: CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "contain",
  objectPosition: "center center",
  display: "block",
  transformOrigin: "center center",
};

const TITLE_STYLE: CSSProperties = {
  fontFamily: "'SST', sans-serif",
  fontWeight: 600,
  letterSpacing: "0.01em",
};

export function Ps4SplashScreen({ game }: Ps4SplashScreenProps) {
  const [entered, setEntered] = useState(false);

  // Un premier rendu à l'état de repos, puis la transition : le fondu et le
  // léger zoom partent réellement de 0 au lieu de sauter à l'arrivée. Le zoom
  // reste sous 1 pendant toute l'animation : aucun cadrage ne peut rogner.
  useEffect(() => {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setEntered(true));
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const background = game.bg_url;
  const cover = game.cover_url;

  return (
    <div style={OVERLAY_STYLE}>
      <div style={FRAME_STYLE}>
        {background ? (
          <img
            src={background}
            alt=""
            draggable={false}
            style={{
              ...MEDIA_STYLE,
              opacity: entered ? 1 : 0,
              transform: entered ? "scale(1)" : "scale(0.985)",
              transition:
                "opacity 900ms ease-out, transform 1800ms cubic-bezier(0.22, 1, 0.36, 1)",
            }}
          />
        ) : (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-[#001845] via-[#002b75] to-[#000d24]"
            style={{ transformOrigin: "center center" }}
          >
            <div className="flex flex-col items-center px-10 text-center">
              {cover ? (
                <img
                  src={cover}
                  alt=""
                  draggable={false}
                  className="h-52 w-52 rounded-lg shadow-[0_25px_60px_rgba(0,0,0,0.6)]"
                  style={{
                    width: "13rem",
                    height: "13rem",
                    maxWidth: "100%",
                    objectFit: "contain",
                    objectPosition: "center center",
                    display: "block",
                    transformOrigin: "center center",
                    opacity: entered ? 1 : 0,
                    transform: entered ? "scale(1)" : "scale(0.97)",
                    transition:
                      "opacity 900ms ease-out, transform 1200ms cubic-bezier(0.22, 1, 0.36, 1)",
                  }}
                />
              ) : (
                <div
                  className="flex h-52 w-52 items-center justify-center rounded-lg border border-white/15 bg-[#0d2a5c] text-5xl text-white/80 shadow-[0_25px_60px_rgba(0,0,0,0.6)]"
                  style={{
                    ...TITLE_STYLE,
                    transformOrigin: "center center",
                    opacity: entered ? 1 : 0,
                    transition: "opacity 900ms ease-out",
                  }}
                >
                  {(game.title.trim().charAt(0) || "?").toUpperCase()}
                </div>
              )}
              <h1
                className="mt-7 max-w-3xl text-3xl tracking-wide text-white drop-shadow-[0_4px_18px_rgba(0,0,0,0.7)]"
                style={{
                  ...TITLE_STYLE,
                  transformOrigin: "center center",
                  opacity: entered ? 1 : 0,
                  transition: "opacity 1100ms ease-out 120ms",
                }}
              >
                {game.title}
              </h1>
            </div>
          </div>
        )}

        {/* Léger voile interne au cadre : le texte reste lisible sur un fond
            clair, et les bandes noires du 16:9 ne sont jamais éclaircies. */}
        <div
          className="absolute inset-0"
          style={{
            backgroundColor: "rgba(0, 0, 0, 0.22)",
            pointerEvents: "none",
            opacity: entered ? 1 : 0,
            transition: "opacity 900ms ease-out",
          }}
          aria-hidden="true"
        />
      </div>

      <div role="status" aria-live="polite" className="sr-only">
        Démarrage de {game.title}
      </div>
    </div>
  );
}
