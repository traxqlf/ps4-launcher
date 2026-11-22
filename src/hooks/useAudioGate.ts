import { useEffect, useRef, useState, type RefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isAudioAllowed, setAudioAllowed } from "../utils/ps4Audio";
import { setGamepadBackgroundSuspended } from "./useGamepad";

/**
 * Verrou audio unique du launcher.
 *
 * Une seule condition autorise le son :
 *   fenêtre au premier plan (`!document.hidden`, focus Tauri et DOM confirmés)
 *   ET aucun jeu en cours de lancement ou d'exécution.
 *
 * L'état est publié par Ps4Home (`setGameAudioBlocked`) dès le clic sur
 * « Démarrer » et jusqu'à la fin réelle de la session. Il est lu ici sans
 * passer par un rendu React, pour couper le son dans le même tick qu'un
 * Alt-Tab ou qu'un lancement.
 */

let gameBlocked = false;
const gameBlockedListeners = new Set<() => void>();

/** Vrai pendant un lancement ou une session de jeu : aucun son autorisé. */
export function setGameAudioBlocked(blocked: boolean): void {
  if (gameBlocked === blocked) return;
  gameBlocked = blocked;
  for (const listener of gameBlockedListeners) listener();
}

export function isGameAudioBlocked(): boolean {
  return gameBlocked;
}

export interface AudioGate {
  /** Vrai uniquement au premier plan et hors lancement/session de jeu. */
  canPlayAudio: boolean;
  /** Même valeur, lisible immédiatement (sans attendre le prochain rendu). */
  canPlayAudioRef: RefObject<boolean>;
  /** Fenêtre réellement au premier plan (sans le critère « jeu en cours »). */
  isWindowFocused: boolean;
}

/** Monte la détection de focus et applique le verrou audio global. */
export function useAudioGate(): AudioGate {
  const [canPlayAudio, setCanPlayAudio] = useState(() => isAudioAllowed());
  // Au montage, la fenêtre Tauri vient d'être affichée : on part du principe
  // qu'elle est active. Seuls les événements réels ferment le verrou, pour
  // qu'un `document.hasFocus()` capricieux au démarrage ne rende pas l'app muette.
  const [isWindowFocused, setIsWindowFocused] = useState(
    () => typeof document === "undefined" || !document.hidden,
  );
  const canPlayAudioRef = useRef(canPlayAudio);
  const foregroundRef = useRef(isWindowFocused);
  const appliedRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    let unlistenFocus: (() => void) | undefined;

    const commit = () => {
      if (disposed) return;
      const foreground = foregroundRef.current && !document.hidden;
      const allowed = foreground && !gameBlocked;

      // Le moteur audio est verrouillé immédiatement : la coupure ne dépend
      // pas du cycle de rendu React.
      setAudioAllowed(allowed);
      // En arrière-plan, aucune boucle requestAnimationFrame ne tourne (0 % CPU).
      setGamepadBackgroundSuspended(!foreground);

      if (appliedRef.current && allowed === canPlayAudioRef.current) return;
      appliedRef.current = true;
      canPlayAudioRef.current = allowed;
      setIsWindowFocused(foregroundRef.current);
      setCanPlayAudio(allowed);
    };

    const setFocused = (focused: boolean) => {
      if (foregroundRef.current === focused) {
        // Le drapeau n'a pas bougé, mais la visibilité ou le jeu a pu changer.
        commit();
        return;
      }
      foregroundRef.current = focused;
      commit();
    };

    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    const onVisibilityChange = () => {
      if (document.hidden) {
        setFocused(false);
        return;
      }
      // Retour de minimise : le navigateur ne rejoue pas toujours un `focus`,
      // `document.hasFocus()` fait foi à cet instant.
      setFocused(document.hasFocus());
    };
    // Filet de sécurité : une interaction utilisateur prouve que la fenêtre
    // est active, même si aucun événement de focus n'a été reçu.
    const onInteraction = () => {
      if (!foregroundRef.current && document.hasFocus()) setFocused(true);
    };

    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pointerdown", onInteraction, true);
    window.addEventListener("keydown", onInteraction, true);
    document.addEventListener("visibilitychange", onVisibilityChange);

    // Source principale sous Windows : Tauri signale le focus réel de la
    // fenêtre, y compris quand la WebView reste « visible ».
    const appWindow = getCurrentWindow();
    void appWindow
      .onFocusChanged(({ payload }) => setFocused(payload))
      .then((stop) => {
        if (disposed) stop();
        else unlistenFocus = stop;
      })
      .catch((cause) =>
        console.warn("[audio] focus Tauri indisponible:", cause),
      );

    const onGameBlocked = () => commit();
    gameBlockedListeners.add(onGameBlocked);

    // État initial : le launcher est ouvert au premier plan.
    commit();

    return () => {
      disposed = true;
      gameBlockedListeners.delete(onGameBlocked);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pointerdown", onInteraction, true);
      window.removeEventListener("keydown", onInteraction, true);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      unlistenFocus?.();
    };
  }, []);

  return { canPlayAudio, canPlayAudioRef, isWindowFocused };
}
