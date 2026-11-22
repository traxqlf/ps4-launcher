import { useEffect } from "react";
import {
  getInputMode,
  isGamepadSuspended,
  setInputMode,
  subscribeGamepadSuspension,
} from "./useGamepad";

// Déplacement réel minimal (px) avant de rendre la main à la souris : un
// tremblement du pointeur immobile ne doit pas faire clignoter le curseur.
const MOUSE_WAKE_DISTANCE = 3;

/**
 * Écouteurs souris globaux, montés une seule fois par App. Ils rendent la main
 * au curseur dès un vrai déplacement (> 3 px), un clic ou la molette, et sont
 * retirés pendant une session de jeu ou une fenêtre en arrière-plan (0 % CPU).
 *
 * Les écouteurs sont posés en phase de capture sur window : en mode manette,
 * tous les descendants de body sont en pointer-events: none, donc la cible
 * réelle d'un mousemove est body / html. Seul un écouteur window en capture
 * garantit de recevoir l'événement dans cette configuration.
 */
export function useInputModeTracking() {
  useEffect(() => {
    // Point de référence du dernier réveil (ou de l'entrée en mode manette).
    // La distance est mesurée depuis lui, pas depuis l'événement précédent :
    // un déplacement lent (moins de 3 px par événement) finit ainsi par
    // dépasser le seuil au lieu de rester invisible.
    let anchorX: number | null = null;
    let anchorY: number | null = null;
    let detach: (() => void) | null = null;

    const onMove = (event: MouseEvent) => {
      if (getInputMode() === "mouse") {
        anchorX = event.clientX;
        anchorY = event.clientY;
        return;
      }

      // Premier mouvement depuis le passage en mode manette : il ne sert qu'à
      // poser la référence, jamais à réveiller le curseur.
      if (anchorX === null || anchorY === null) {
        anchorX = event.clientX;
        anchorY = event.clientY;
        return;
      }

      if (
        Math.hypot(event.clientX - anchorX, event.clientY - anchorY) >
        MOUSE_WAKE_DISTANCE
      ) {
        setInputMode("mouse");
        anchorX = event.clientX;
        anchorY = event.clientY;
      }
    };
    const onPress = () => setInputMode("mouse");

    const attach = () => {
      if (detach) return;
      anchorX = null;
      anchorY = null;
      window.addEventListener("mousemove", onMove, { capture: true });
      window.addEventListener("mousedown", onPress, { capture: true });
      // Molette passive : on ne bloque jamais le défilement, on réveille juste
      // le curseur.
      window.addEventListener("wheel", onPress, {
        capture: true,
        passive: true,
      });
      detach = () => {
        window.removeEventListener("mousemove", onMove, { capture: true });
        window.removeEventListener("mousedown", onPress, { capture: true });
        window.removeEventListener("wheel", onPress, { capture: true });
        detach = null;
      };
    };

    if (!isGamepadSuspended()) attach();
    const unsubscribe = subscribeGamepadSuspension((suspended) => {
      if (suspended) detach?.();
      else attach();
    });

    return () => {
      unsubscribe();
      detach?.();
    };
  }, []);
}
