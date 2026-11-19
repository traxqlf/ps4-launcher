import { useEffect, useState } from "react";

/**
 * Horloge de la barre système (format HH:MM, locale française).
 *
 * L'état et l'intervalle d'une seconde vivent ici : seul ce petit composant se
 * re-rend chaque seconde, l'écran d'accueil complet reste figé.
 */
export function Ps4Clock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const clock = now.toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return <time className="ps4-clock">{clock}</time>;
}
