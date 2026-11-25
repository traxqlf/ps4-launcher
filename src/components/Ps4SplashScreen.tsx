import { invoke } from "@tauri-apps/api/core";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type SyntheticEvent,
} from "react";
import type { Game } from "../types";

/**
 * Écran de démarrage plein écran, affiché pendant la transition avant que le
 * launcher ne se minimise.
 *
 * Une image dédiée au splash (16:9 / 3:2) remplit tout le viewport en
 * `object-fit: cover`. Si seul un ancien bandeau ultra-large est encore en
 * cache, il est affiché au centre sur un fond flouté plein écran : plus aucune
 * bande noire, et une migration silencieuse vers une vraie image 16:9 est
 * tentée pendant l'ouverture du jeu.
 *
 * Performance : deux `requestAnimationFrame` seulement pour amorcer le fondu,
 * puis plus aucune boucle. Le flou est un filtre GPU statique, jamais animé.
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
  backgroundColor: "#021029",
  overflow: "hidden",
  zIndex: 9999,
  // Purement visuel : l'overlay ne doit jamais intercepter clavier, souris ni
  // manette, même pendant ses dernières frames avant démontage.
  pointerEvents: "none",
  transformOrigin: "center center",
};

// Fond flouté du bandeau ultra-large : remplit les anciennes zones noires.
const BLURRED_BACKDROP_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  objectFit: "cover",
  objectPosition: "center center",
  filter: "blur(28px) brightness(0.45)",
  transform: "scale(1.1)",
  transformOrigin: "center center",
  pointerEvents: "none",
};

// Image 16:9 / 3:2 : elle remplit l'écran sans bandeau ni déformation.
const FULLSCREEN_MEDIA_STYLE: CSSProperties = {
  position: "relative",
  zIndex: 1,
  width: "100%",
  height: "100%",
  objectFit: "cover",
  objectPosition: "center center",
  display: "block",
  transformOrigin: "center center",
};

// Image ultra-large temporaire : entière et centrée devant le fond flouté.
const CONTAINED_MEDIA_STYLE: CSSProperties = {
  ...FULLSCREEN_MEDIA_STYLE,
  objectFit: "contain",
};

const TITLE_STYLE: CSSProperties = {
  fontFamily: "'SST', sans-serif",
  fontWeight: 600,
  letterSpacing: "0.01em",
};

/** Ratio d'une image plein écran standard : 16:9, 16:10 ou 3:2. */
function isFullscreenRatio(ratio: number): boolean {
  return Number.isFinite(ratio) && ratio >= 1.4 && ratio <= 1.9;
}

export function Ps4SplashScreen({ game }: Ps4SplashScreenProps) {
  const [entered, setEntered] = useState(false);
  const [source, setSource] = useState<string | null>(
    game.splash_url ?? game.bg_url ?? null,
  );
  const [ratio, setRatio] = useState<number | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  // Une seule tentative de récupération par splash : aucune boucle réseau.
  const recoveryStarted = useRef(false);

  // Un premier rendu à l'état de repos, puis la transition : le fondu et le
  // léger zoom partent réellement de 0 au lieu de sauter à l'arrivée.
  useEffect(() => {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setEntered(true));
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const recoverFullscreenSplash = useCallback(() => {
    if (recoveryStarted.current) return;
    recoveryStarted.current = true;
    invoke<Game[]>("ensure_game_splash", { gameId: game.id })
      .then((games) => {
        const updated = games.find((entry) => entry.id === game.id);
        const next = updated?.splash_url ?? null;
        if (next) {
          setImageFailed(false);
          setRatio(null);
          setSource((current) => (current === next ? current : next));
        }
      })
      .catch((cause) => {
        console.warn("[splash] récupération 16:9 impossible:", cause);
      });
  }, [game.id]);

  // Ouverture du jeu : si aucun splash dédié n'est encore connu, tente une
  // récupération unique. Le fallback flouté reste affiché pendant ce temps.
  useEffect(() => {
    if (!game.splash_url && game.splash_checked !== true) {
      recoverFullscreenSplash();
    }
  }, [game.id, game.splash_url, game.splash_checked, recoverFullscreenSplash]);

  const handleLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
    const nextRatio = image.naturalWidth / image.naturalHeight;
    setRatio(nextRatio);
    // Ancien cache ultra-large : une image plein écran est recherchée pendant
    // que le fond flouté masque déjà les bandes noires.
    if (nextRatio > 2.1) {
      recoverFullscreenSplash();
    }
  };

  const handleError = () => {
    // Un splash distant peut échouer : retombe sur le fond héros local.
    if (game.bg_url && source !== game.bg_url) {
      setRatio(null);
      setSource(game.bg_url);
      return;
    }
    setImageFailed(true);
  };

  const hasBackground = Boolean(source) && !imageFailed;
  const standardRatio = ratio !== null && isFullscreenRatio(ratio);
  const showBlurredBackdrop = hasBackground && !standardRatio;
  const cover = game.cover_url;

  return (
    <div style={OVERLAY_STYLE}>
      {hasBackground && source ? (
        <>
          {showBlurredBackdrop && (
            <img
              src={source}
              alt=""
              aria-hidden="true"
              draggable={false}
              style={{ ...BLURRED_BACKDROP_STYLE, opacity: entered ? 1 : 0 }}
            />
          )}
          <img
            src={source}
            alt=""
            draggable={false}
            onLoad={handleLoad}
            onError={handleError}
            style={{
              ...(standardRatio
                ? FULLSCREEN_MEDIA_STYLE
                : CONTAINED_MEDIA_STYLE),
              opacity: entered ? 1 : 0,
              transform: entered ? "scale(1)" : "scale(0.985)",
              transition:
                "opacity 900ms ease-out, transform 1800ms cubic-bezier(0.22, 1, 0.36, 1)",
            }}
          />
        </>
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

      {/* Léger voile interne : le texte et la jaquette restent lisibles sans
          jamais créer de bandes noires sur une image plein écran. */}
      <div
        className="absolute inset-0"
        style={{
          zIndex: 2,
          backgroundColor: "rgba(0, 0, 0, 0.18)",
          pointerEvents: "none",
          opacity: entered ? 1 : 0,
          transition: "opacity 900ms ease-out",
        }}
        aria-hidden="true"
      />

      <div role="status" aria-live="polite" className="sr-only">
        Démarrage de {game.title}
      </div>
    </div>
  );
}
