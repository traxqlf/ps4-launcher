import { useEffect, useState } from "react";
import { isBgmMuted, playNotification } from "../utils/ps4Audio";

/**
 * Bandeau de notification façon Orbis OS : glisse depuis le bord gauche, reste
 * 4 secondes, puis repart hors écran. Une seule notification à la fois, les
 * suivantes attendent en file.
 */

export type Ps4NotificationIcon =
  | "gamepad"
  | "gamepad-off"
  | "game"
  | "playtime"
  | "info";

export interface Ps4NotificationInput {
  title: string;
  subtitle?: string;
  icon?: Ps4NotificationIcon;
}

interface Ps4NotificationItem extends Ps4NotificationInput {
  id: number;
}

const DISPLAY_MS = 4000;
const SLIDE_MS = 420;
// Au-delà, on jette les plus anciennes : une rafale d'événements ne doit pas
// faire défiler un bandeau pendant des minutes.
const MAX_QUEUE = 8;

const queue: Ps4NotificationItem[] = [];
const listeners = new Set<() => void>();
let nextId = 0;

function publish() {
  for (const listener of listeners) listener();
}

/** Ajoute une notification à la file ; elle s'affiche dès que la place est libre. */
export function notify(input: Ps4NotificationInput) {
  nextId += 1;
  queue.push({ icon: "info", ...input, id: nextId });
  while (queue.length > MAX_QUEUE) queue.shift();
  publish();
}

/** Nom lisible d'une manette : « DualSense Wireless Controller ». */
function describeGamepad(gamepad: Gamepad | null | undefined): string {
  const id = gamepad?.id?.replace(/\s*\(.*?\)\s*/g, " ").trim();
  return id ? id : "Manette sans fil";
}

function GamepadIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden="true">
      <path
        d="M7.5 7h9a4.5 4.5 0 0 1 4.37 3.4l.9 3.6a2.7 2.7 0 0 1-4.72 2.5L15.6 15H8.4l-1.45 1.5a2.7 2.7 0 0 1-4.72-2.5l.9-3.6A4.5 4.5 0 0 1 7.5 7Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M8 10.4v2.4M6.8 11.6h2.4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="15.4" cy="10.8" r="0.9" fill="currentColor" />
      <circle cx="17.4" cy="12.6" r="0.9" fill="currentColor" />
      {off ? (
        <path
          d="M4.5 4.5 19.5 19.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      ) : null}
    </svg>
  );
}

function GameIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden="true">
      <rect
        x="3.2"
        y="4.6"
        width="17.6"
        height="14.8"
        rx="2.4"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M8 12.2h4M10 10.2v4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="15.8" cy="11" r="0.9" fill="currentColor" />
      <circle cx="17.4" cy="13" r="0.9" fill="currentColor" />
    </svg>
  );
}

function PlaytimeIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.4" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 7.6V12l3 1.9"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.4" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 11v5.2"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <circle cx="12" cy="8" r="1.05" fill="currentColor" />
    </svg>
  );
}

function NotificationIcon({ icon }: { icon: Ps4NotificationIcon }) {
  switch (icon) {
    case "gamepad":
      return <GamepadIcon off={false} />;
    case "gamepad-off":
      return <GamepadIcon off />;
    case "game":
      return <GameIcon />;
    case "playtime":
      return <PlaytimeIcon />;
    default:
      return <InfoIcon />;
  }
}

export function Ps4Notification() {
  const [current, setCurrent] = useState<Ps4NotificationItem | null>(null);
  const [shown, setShown] = useState(false);
  // Incrémenté à chaque ajout dans la file : relance le dépilement à l'inactivité.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const listener = () => setVersion((value) => value + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  // Dépilement : une notification à la fois, la file attend son tour.
  useEffect(() => {
    if (current) return;
    const next = queue.shift();
    if (!next) return;
    setShown(false);
    setCurrent(next);
  }, [current, version]);

  // Cycle de vie d'une notification : entrée, maintien, sortie.
  useEffect(() => {
    if (!current) return;
    if (!isBgmMuted()) playNotification();

    setShown(false);
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setShown(true));
    });
    const slideOut = window.setTimeout(() => setShown(false), DISPLAY_MS);
    const release = window.setTimeout(
      () => setCurrent(null),
      DISPLAY_MS + SLIDE_MS,
    );

    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(slideOut);
      window.clearTimeout(release);
    };
  }, [current]);

  // Connexion / déconnexion d'une manette, quel que soit l'écran affiché.
  useEffect(() => {
    const handleConnected = (event: Event) => {
      const pad = (event as GamepadEvent).gamepad;
      notify({
        icon: "gamepad",
        title: "Manette sans fil connectée",
        subtitle: describeGamepad(pad),
      });
    };
    const handleDisconnected = (event: Event) => {
      const pad = (event as GamepadEvent).gamepad;
      notify({
        icon: "gamepad-off",
        title: "Manette sans fil déconnectée",
        subtitle: describeGamepad(pad),
      });
    };

    window.addEventListener("gamepadconnected", handleConnected);
    window.addEventListener("gamepaddisconnected", handleDisconnected);
    return () => {
      window.removeEventListener("gamepadconnected", handleConnected);
      window.removeEventListener("gamepaddisconnected", handleDisconnected);
    };
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed left-0 top-8 z-[60] will-change-transform"
      style={{
        transform: shown ? "translateX(0)" : "translateX(-100%)",
        transition: `transform ${SLIDE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
      }}
    >
      {current ? (
        <div className="relative flex w-[21rem] items-center gap-3 rounded-r-xl bg-[#101828]/90 py-3 pl-5 pr-6 shadow-[0_18px_40px_rgba(0,0,0,0.55)] backdrop-blur-md">
          <span
            aria-hidden="true"
            className="absolute left-0 top-1/2 h-11 w-[3px] -translate-y-1/2 rounded-r-full bg-white"
          />
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10 text-white">
            <NotificationIcon icon={current.icon ?? "info"} />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold leading-tight text-white">
              {current.title}
            </p>
            {current.subtitle ? (
              <p className="mt-0.5 truncate text-xs font-normal text-white/65">
                {current.subtitle}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
