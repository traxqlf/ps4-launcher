import { useEffect, useRef, useState, type RefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isAudioAllowed,
  pauseBgm,
  setAudioAllowed,
  setGameSessionRunning,
} from "../utils/ps4Audio";
import { setGamepadWindowFocused } from "./useGamepad";

/**
 * Verrou audio unique du launcher.
 *
 * Le moteur audio et les bruitages UI suivent uniquement le focus réel de la
 * fenêtre : au retour sur le launcher, la navigation redevient sonore même si
 * un jeu tourne encore en arrière-plan. La musique de thème et la musique du
 * menu restent, elles, coupées pendant toute la session de jeu (état publié
 * par Ps4Home via `setGameAudioBlocked`).
 *
 * L'état est appliqué sans passer par un rendu React, pour couper le son dans
 * le même tick qu'un Alt-Tab ou qu'un lancement.
 */

let gameBlocked = false;
const gameBlockedListeners = new Set<() => void>();

/**
 * Vrai pendant un lancement ou une session de jeu : la musique de fond est
 * coupée. Les bruitages UI, eux, restent autorisés au premier plan.
 */
export function setGameAudioBlocked(blocked: boolean): void {
  if (gameBlocked === blocked) return;
  gameBlocked = blocked;
  setGameSessionRunning(blocked);
  for (const listener of gameBlockedListeners) listener();
}

export function isGameAudioBlocked(): boolean {
  return gameBlocked;
}

export interface AudioGate {
  /** Vrai uniquement quand la fenêtre est au premier plan. */
  canPlayAudio: boolean;
  /** Même valeur, lisible immédiatement (sans attendre le prochain rendu). */
  canPlayAudioRef: RefObject<boolean>;
  /** Fenêtre réellement au premier plan (sans le critère « jeu en cours »). */
  isWindowFocused: boolean;
}

/** Monte la détection de focus et applique le verrou audio global. */
export function useAudioGate(): AudioGate {
  const [canPlayAudio, setCanPlayAudio] = useState(() => isAudioAllowed());
  // État initial : focus réel du document, combiné à la visibilité. Les
  // événements DOM et Tauri prennent ensuite le relais.
  const [isWindowFocused, setIsWindowFocused] = useState(
    () =>
      typeof document === "undefined" ||
      (!document.hidden && document.hasFocus()),
  );
  const canPlayAudioRef = useRef(canPlayAudio);
  // Dernier focus connu (DOM ou Tauri), indépendant de la visibilité : un
  // événement focus natif peut arriver avant que la WebView redevienne
  // visible, et il ne doit pas être perdu.
  const focusIntentRef = useRef(
    typeof document === "undefined" || document.hasFocus(),
  );

  useEffect(() => {
    let disposed = false;
    let unlistenFocus: (() => void) | undefined;

    const commit = () => {
      if (disposed) return;
      const foreground = focusIntentRef.current && !document.hidden;
      // Le moteur et les bruitages UI suivent le premier plan, pas la session
      // de jeu : au retour sur le launcher, les sons de navigation répondent
      // immédiatement même si le jeu continue en arrière-plan.
      const allowed = foreground;

      setAudioAllowed(allowed);
      // La boucle manette et les animations CSS se figent hors premier plan.
      setGamepadWindowFocused(foreground);
      // Une session de jeu coupe toute musique de fond, y compris au retour.
      if (gameBlocked) pauseBgm();

      canPlayAudioRef.current = allowed;
      setIsWindowFocused(foreground);
      setCanPlayAudio(allowed);
    };

    const setFocused = (focused: boolean) => {
      if (focusIntentRef.current === focused) {
        // Le drapeau n'a pas bougé, mais la visibilité ou le jeu a pu changer.
        commit();
        return;
      }
      focusIntentRef.current = focused;
      commit();
    };

    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    const onVisibilityChange = () => {
      // La visibilité seule ne doit pas écraser le dernier focus connu : au
      // retour de minimise, le focus natif peut avoir été reçu juste avant que
      // `document.hidden` repasse à false.
      if (!document.hidden && !focusIntentRef.current && document.hasFocus()) {
        focusIntentRef.current = true;
      }
      commit();
    };
    // Filet de sécurité : une interaction utilisateur prouve que la fenêtre
    // est active, même si aucun événement de focus n'a été reçu.
    const onInteraction = () => {
      if (!focusIntentRef.current && document.hasFocus()) setFocused(true);
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

    // État initial : applique tout de suite focus, visibilité et session.
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
