import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { setGlobalGamepadLock } from "../hooks/useGamepad";
import { playBack, playConfirm, playError, playNav } from "../utils/ps4Audio";

/**
 * Modale « Ajouter un jeu » : un fichier à la main, un dossier entier à
 * scanner, ou une détection automatique des jeux déjà installés (Steam, Epic,
 * GOG). Le back liste les exécutables, le front coche ceux à garder.
 */

interface ScannedGame {
  path: string;
  title: string;
  platform?: string;
}

interface DetectedGame {
  path: string;
  title: string;
  platform: string;
  steamAppid: string | null;
}

const PLATFORM_LABELS: Record<string, string> = {
  steam: "Steam",
  epic: "Epic",
  gog: "GOG",
  macos: "macOS",
};

interface AddGameModalProps {
  isOpen: boolean;
  busy: boolean;
  onClose: () => void;
  onBrowse: () => void;
  onImport: (paths: string[]) => void;
}

// Standard W3C : 0 Croix / A, 1 Rond / B, 12–15 croix directionnelle.
const BUTTON_CONFIRM = 0;
const BUTTON_BACK = 1;
const DPAD_UP = 12;
const DPAD_DOWN = 13;
const DPAD_LEFT = 14;
const DPAD_RIGHT = 15;
// Stick gauche : même zone morte stricte et même cooldown que les autres
// écrans (TrophyModal, ProfileModal, Bibliothèque).
const STICK_DEADZONE = 0.55;
const NAV_COOLDOWN_MS = 180;

/**
 * Éléments du panneau atteignables à la manette, dans l'ordre du DOM :
 * Parcourir, Scanner, Détecter, Tout cocher, chaque case, Annuler, Importer.
 * Les éléments
 * désactivés sont ignorés. Le bouton de fermeture reste hors du parcours
 * (Rond / B ferme déjà la fenêtre).
 */
function focusableItems(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>("[data-gp-focusable]:not([disabled])"),
  );
}

export function AddGameModal({
  isOpen,
  busy,
  onClose,
  onBrowse,
  onImport,
}: AddGameModalProps) {
  const [scanning, setScanning] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [results, setResults] = useState<ScannedGame[] | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState<string | null>(null);

  const dialogRef = useRef<HTMLElement | null>(null);
  // La boucle manette tourne une seule fois par ouverture : elle lit les
  // actions et l'état de chargement par des refs pour ne pas redémarrer.
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Fermeture : on repart d'une modale vierge au prochain affichage.
  useEffect(() => {
    if (isOpen) return;
    setScanning(false);
    setDetecting(false);
    setResults(null);
    setChecked({});
    setMessage(null);
  }, [isOpen]);

  // La manette ne doit pas naviguer le ruban derrière la modale.
  useEffect(() => {
    if (!isOpen) return;
    setGlobalGamepadLock(true);
    return () => setGlobalGamepadLock(false);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [isOpen, busy, onClose]);

  // À l'ouverture, Croix doit pouvoir agir tout de suite sur le premier bouton.
  useEffect(() => {
    if (!isOpen) return;
    const frame = requestAnimationFrame(() => {
      focusableItems(dialogRef.current)[0]?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  // Manette : D-pad / stick gauche pour parcourir champs et boutons, Croix
  // active l'élément focalisé (ou entre dans un champ), Rond ferme la modale
  // ou quitte la saisie en cours.
  useEffect(() => {
    if (!isOpen) return;

    let frame = 0;
    let lastNav = 0;
    let upHeld = false;
    let downHeld = false;
    let leftHeld = false;
    let rightHeld = false;
    let confirmHeld = false;
    let backHeld = false;

    const moveFocus = (delta: number) => {
      const nodes = focusableItems(dialogRef.current);
      if (nodes.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const current = active ? nodes.indexOf(active) : -1;
      const next =
        current < 0
          ? delta > 0
            ? 0
            : nodes.length - 1
          : (current + delta + nodes.length) % nodes.length;
      nodes[next]?.focus();
      playNav();
    };

    const activateFocused = () => {
      const nodes = focusableItems(dialogRef.current);
      const active = document.activeElement as HTMLElement | null;
      if (active && nodes.includes(active)) {
        playConfirm();
        active.click();
        return;
      }
      nodes[0]?.focus();
    };

    const goBack = () => {
      const active = document.activeElement as HTMLElement | null;
      // Champ texte en cours d'édition : Rond sort de la saisie, la modale
      // reste ouverte.
      const editingText =
        active instanceof HTMLInputElement &&
        active.type !== "checkbox" &&
        active.type !== "radio";
      if (active && editingText) {
        active.blur();
        playBack();
        return;
      }
      if (busyRef.current) {
        playError();
        return;
      }
      playBack();
      closeRef.current();
    };

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);

      const pressed = new Set<number>();
      let axisX = 0;
      let axisY = 0;

      for (const pad of navigator.getGamepads?.() ?? []) {
        if (!pad?.connected) continue;
        pad.buttons.forEach((button, index) => {
          if (button.pressed) pressed.add(index);
        });
        const x = pad.axes[0] ?? 0;
        const y = pad.axes[1] ?? 0;
        if (Math.abs(x) > Math.abs(axisX)) axisX = x;
        if (Math.abs(y) > Math.abs(axisY)) axisY = y;
      }

      const dpadUp = pressed.has(DPAD_UP);
      const dpadDown = pressed.has(DPAD_DOWN);
      const dpadLeft = pressed.has(DPAD_LEFT);
      const dpadRight = pressed.has(DPAD_RIGHT);
      const stickUp = axisY < -STICK_DEADZONE;
      const stickDown = axisY > STICK_DEADZONE;
      const stickLeft = axisX < -STICK_DEADZONE;
      const stickRight = axisX > STICK_DEADZONE;

      // D-pad : un appui = un déplacement. Stick : répétition après 180 ms.
      if ((dpadUp && !upHeld) || (dpadLeft && !leftHeld)) {
        moveFocus(-1);
      } else if ((dpadDown && !downHeld) || (dpadRight && !rightHeld)) {
        moveFocus(1);
      } else if (
        (stickUp || stickDown || stickLeft || stickRight) &&
        now - lastNav >= NAV_COOLDOWN_MS
      ) {
        lastNav = now;
        moveFocus(stickUp || stickLeft ? -1 : 1);
      }

      const confirm = pressed.has(BUTTON_CONFIRM);
      const back = pressed.has(BUTTON_BACK);
      if (confirm && !confirmHeld) activateFocused();
      if (back && !backHeld) goBack();

      upHeld = dpadUp;
      downHeld = dpadDown;
      leftHeld = dpadLeft;
      rightHeld = dpadRight;
      confirmHeld = confirm;
      backHeld = back;
    };

    frame = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  async function detectInstalled() {
    if (detecting || scanning || busy) return;
    setMessage(null);
    setDetecting(true);
    try {
      const found = await invoke<DetectedGame[]>("detect_installed_pc_games");
      const items: ScannedGame[] = found.map((game) => ({
        path: game.path,
        title: game.title,
        platform: game.platform,
      }));
      setResults(items);
      setChecked(Object.fromEntries(items.map((game) => [game.path, true])));
      if (items.length === 0) {
        setMessage(
          "Aucun jeu installé détecté (Steam, Epic Games, GOG).",
        );
      }
    } catch (cause) {
      playError();
      setMessage(String(cause));
    } finally {
      setDetecting(false);
    }
  }

  async function scanDirectory() {
    if (scanning || busy) return;
    setMessage(null);
    try {
      const directory = await open({
        directory: true,
        multiple: false,
        title: "Choisir un dossier de jeux",
      });
      if (typeof directory !== "string") return;

      setScanning(true);
      const found = await invoke<ScannedGame[]>("scan_games_directory", {
        dirPath: directory,
      });
      setResults(found);
      setChecked(Object.fromEntries(found.map((game) => [game.path, true])));
      if (found.length === 0) {
        setMessage("Aucun exécutable détecté dans ce dossier.");
      }
    } catch (cause) {
      playError();
      setMessage(String(cause));
    } finally {
      setScanning(false);
    }
  }

  if (!isOpen) return null;

  const detected = results ?? [];
  const selectedPaths = detected
    .filter((game) => checked[game.path])
    .map((game) => game.path);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-6 backdrop-blur-sm"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Ajouter un jeu"
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-2xl overflow-hidden rounded-2xl border border-white/10 bg-[#101828]/95 text-white shadow-[0_30px_80px_rgba(0,0,0,0.65)] backdrop-blur-md"
      >
        <header className="flex items-center justify-between border-b border-white/10 px-6 py-4">
          <h2 className="text-lg font-bold tracking-wide">Ajouter un jeu</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Fermer"
            className="flex h-8 w-8 items-center justify-center rounded-full border border-white/20 text-white/70 transition hover:border-white/60 hover:text-white disabled:opacity-40"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>

        <div className="space-y-4 px-6 py-5">
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              data-gp-focusable=""
              onClick={onBrowse}
              disabled={busy}
              className="rounded-lg border border-white/20 px-4 py-2.5 text-sm font-medium outline-none transition hover:border-white/70 hover:bg-white/10 focus:border-white focus:bg-white/10 focus:ring-2 focus:ring-white/70 disabled:opacity-40"
            >
              Parcourir un fichier
            </button>
            <button
              type="button"
              data-gp-focusable=""
              onClick={() => void scanDirectory()}
              disabled={busy || scanning}
              className="rounded-lg border border-white/60 bg-white/10 px-4 py-2.5 text-sm font-medium outline-none transition hover:bg-white/20 focus:border-white focus:bg-white/20 focus:ring-2 focus:ring-white/70 disabled:opacity-40"
            >
              {scanning ? "Scan en cours…" : "Scanner un dossier"}
            </button>
            <button
              type="button"
              data-gp-focusable=""
              onClick={() => void detectInstalled()}
              disabled={busy || scanning || detecting}
              className="rounded-lg border border-white/20 px-4 py-2.5 text-sm font-medium outline-none transition hover:border-white/70 hover:bg-white/10 focus:border-white focus:bg-white/10 focus:ring-2 focus:ring-white/70 disabled:opacity-40"
            >
              {detecting
                ? "Détection en cours…"
                : "Détecter les jeux installés (Steam / Epic / GOG)"}
            </button>
          </div>

          {message ? (
            <p className="text-sm text-white/70" role="alert">
              {message}
            </p>
          ) : null}

          {results && detected.length > 0 ? (
            <div className="rounded-xl border border-white/10 bg-black/20">
              <div className="flex items-center justify-between border-b border-white/10 px-4 py-2 text-xs uppercase tracking-widest text-white/50">
                <span>{detected.length} jeu(x) détecté(s)</span>
                <button
                  type="button"
                  data-gp-focusable=""
                  disabled={busy}
                  onClick={() =>
                    setChecked(
                      selectedPaths.length === detected.length
                        ? {}
                        : Object.fromEntries(
                            detected.map((game) => [game.path, true]),
                          ),
                    )
                  }
                  className="rounded normal-case tracking-normal text-white/70 underline-offset-4 outline-none transition hover:text-white hover:underline focus:text-white focus:ring-2 focus:ring-white/70 disabled:opacity-40"
                >
                  {selectedPaths.length === detected.length
                    ? "Tout décocher"
                    : "Tout cocher"}
                </button>
              </div>

              <ul className="max-h-[46vh] overflow-y-auto">
                {detected.map((game) => (
                  <li key={game.path}>
                    <label className="flex cursor-pointer items-start gap-3 border-b border-white/5 px-4 py-2.5 last:border-b-0 transition hover:bg-white/5">
                      <input
                        type="checkbox"
                        data-gp-focusable=""
                        checked={checked[game.path] ?? false}
                        disabled={busy}
                        onChange={(event) =>
                          setChecked((current) => ({
                            ...current,
                            [game.path]: event.target.checked,
                          }))
                        }
                        className="mt-1 h-4 w-4 shrink-0 accent-white outline-none focus:ring-2 focus:ring-white"
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold">
                          {game.title}
                        </span>
                        <span className="block truncate text-xs text-white/45">
                          {game.path}
                        </span>
                      </span>
                      {game.platform ? (
                        <span className="ml-auto mt-0.5 shrink-0 rounded-full border border-white/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-white/65">
                          {PLATFORM_LABELS[game.platform] ?? game.platform}
                        </span>
                      ) : null}
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-3 border-t border-white/10 px-6 py-4">
          <button
            type="button"
            data-gp-focusable=""
            onClick={onClose}
            disabled={busy}
            className="rounded-lg px-4 py-2 text-sm text-white/70 outline-none transition hover:text-white focus:text-white focus:ring-2 focus:ring-white/70 disabled:opacity-40"
          >
            Annuler
          </button>
          <button
            type="button"
            data-gp-focusable=""
            onClick={() => onImport(selectedPaths)}
            disabled={busy || selectedPaths.length === 0}
            className="rounded-lg bg-white px-5 py-2 text-sm font-semibold text-[#101828] outline-none transition hover:bg-white/85 focus:ring-2 focus:ring-white/80 focus:ring-offset-2 focus:ring-offset-[#101828] disabled:opacity-40"
          >
            {busy
              ? "Import…"
              : `Importer la sélection (${selectedPaths.length})`}
          </button>
        </footer>
      </section>
    </div>
  );
}
