/* Écran Trophées — architecture Orbis OS à deux niveaux (PS4).

   Niveau 1 : liste des jeux et progression globale. Niveau 2 : trophées du
   jeu sélectionné. Un unique cadre blanc glisse d'une ligne à l'autre avec le
   ressort critiquement amorti du bandeau de jeux (translate3d), et les deux
   vues s'échangent par une translation GPU. */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type WheelEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  playBack,
  playConfirm,
  playEnterMenu,
  playNav,
} from "../utils/ps4Audio";
import {
  hasSystemModifier,
  isMenuKey,
  isTypingTarget,
  shouldIgnoreClick,
} from "../hooks/useGamepad";
import type { Game } from "../types";

interface TrophyModalProps {
  game: Game;
  onClose: () => void;
}

export interface Trophy {
  id: string;
  name: string;
  description: string;
  percent: number;
  rank: string;
  unlocked: boolean;
  /** Succès masqué : nom et description cachés jusqu'à révélation (Carré). */
  hidden?: boolean;
  /** Icône officielle couleur fournie par Steam. */
  icon?: string;
  /** Icône officielle grisée, affichée tant que le trophée est verrouillé. */
  icongray?: string;
  /** Date de déblocage en secondes Unix. */
  unlocked_at?: number | null;
}

export interface TrophyReport {
  appid: string;
  progress: number;
  unlocked: number;
  total: number;
  counts: {
    bronze: number;
    silver: number;
    gold: number;
    platinum: number;
  };
  trophies: Trophy[];
  /** Trophées débloqués depuis la vérification précédente. */
  new_trophies?: Trophy[];
  offline: boolean;
}

// Police unique du projet : SST, imposée en inline sur chaque contrôle.
const SST_STYLE = { fontFamily: "'SST', sans-serif" } as const;

// Glissement des vues : même courbe d'inertie que la piste du ruban.
const ANIM_MS = 320;
const ANIM_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

/* Cadre de sélection : mêmes constantes de ressort que le bandeau Orbis. */
const FRAME_OMEGA = 15.5;
const FRAME_MAX_DT = 0.032;
const FRAME_START_IMPULSE = 0.35;

const ORBIS_BLUE = "#0070D1";
const ORBIS_BLUE_LIGHT = "#0082F3";

const RANK_META: Record<string, { label: string; icon: string }> = {
  bronze: { label: "Bronze", icon: "/trophies/bronze.png" },
  argent: { label: "Argent", icon: "/trophies/silver.png" },
  or: { label: "Or", icon: "/trophies/gold.png" },
  platinum: { label: "Platine", icon: "/trophies/platinum.png" },
  // Ancien identifiant, conservé pour les rapports déjà en cache.
  platine: { label: "Platine", icon: "/trophies/platinum.png" },
};

// Trophée Platine ajouté par le launcher (Steam n'en fournit pas).
const PLATINUM_ID = "ps4_platinum_trophy";

const LOCKED_ICON = "/trophies/hide.png";

// Virtualisation de la liste détaillée : hauteur fixe des lignes et fenêtre
// glissante rendue autour de la sélection (5 trophées au-dessus, 10 en dessous).
const TROPHY_ROW_HEIGHT = 108;
const TROPHY_WINDOW_ABOVE = 5;
const TROPHY_WINDOW_BELOW = 10;
// Niveau 1 : les jeux sont peu nombreux, toutes les lignes sont montées.
const GAME_ROW_HEIGHT = 96;

// Icônes officielles des boutons PS4 (modale non mise à l'échelle).
const HINT_ICON = "h-6 w-6 shrink-0 object-contain";

const COUNT_ITEMS = [
  { key: "platinum", label: "Platine", icon: "/trophies/platinum.png" },
  { key: "gold", label: "Or", icon: "/trophies/gold.png" },
  { key: "silver", label: "Argent", icon: "/trophies/silver.png" },
  { key: "bronze", label: "Bronze", icon: "/trophies/bronze.png" },
] as const;

/** Petits mots anglais qui restent collés quand Steam ne donne que l'identifiant. */
const FUNCTION_WORDS = new Set([
  "of",
  "the",
  "for",
  "is",
  "in",
  "on",
  "to",
  "and",
]);

/**
 * Même découpe que côté Rust : un bloc comme « Kingofthecups » est séparé sur
 * les petits mots, mais uniquement s'ils sont encadrés de fragments francs,
 * pour ne pas éclater « Champion » ou « Island ».
 */
function splitGlued(word: string): string[] {
  const chars = [...word];
  if (chars.length < 8) return [word];

  const pieces: string[] = [];
  let start = 0;
  let cursor = 0;
  while (cursor < chars.length) {
    let matched = 0;
    for (const wordFn of FUNCTION_WORDS) {
      const len = wordFn.length;
      if (cursor + len > chars.length) continue;
      if (chars.slice(cursor, cursor + len).join("").toLowerCase() !== wordFn) {
        continue;
      }
      const before = cursor - start;
      const after = chars.length - (cursor + len);
      const boundaryOk =
        cursor === start
          ? pieces.length > 0 && after >= 4
          : before >= 3 && after >= 3;
      if (boundaryOk) {
        matched = len;
        break;
      }
    }

    if (matched > 0) {
      if (cursor > start) pieces.push(chars.slice(start, cursor).join(""));
      pieces.push(chars.slice(cursor, cursor + matched).join(""));
      cursor += matched;
      start = cursor;
    } else {
      cursor += 1;
    }
  }

  if (start < chars.length) pieces.push(chars.slice(start).join(""));
  return pieces;
}

/** Filet de sécurité pour les noms encore collés renvoyés par Steam. */
export function formatTrophyName(raw: string): string {
  const spaced = raw
    .replace(/[_\-.]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  const words = spaced.split(/\s+/).filter(Boolean).flatMap(splitGlued);
  if (words.length === 0) return raw.trim();

  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index > 0 && FUNCTION_WORDS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function displayName(trophy: Trophy): string {
  // Un nom déjà lisible (avec espaces) est conservé tel quel.
  return /\s/.test(trophy.name) ? trophy.name : formatTrophyName(trophy.name);
}

function rarityLabel(percent: number): string {
  if (percent < 5) return "Ultra rare";
  if (percent < 15) return "Très rare";
  if (percent < 50) return "Rare";
  return "Courant";
}

function rarityColor(percent: number): string {
  if (percent < 5) return "#7FD4FF";
  if (percent < 15) return "#F5C451";
  if (percent < 50) return "#4AA8FF";
  return "#FFFFFF";
}

function formatPercent(percent: number): string {
  return `${percent.toFixed(1).replace(".", ",")} %`;
}

/**
 * Position statique d'une ligne dans le rail. `offsetTop` ne dépend pas du
 * `translate3d` appliqué au rail : contrairement à `getBoundingClientRect`, il
 * ne change pas pendant la transition CSS et ne peut donc pas boucler.
 */
function offsetWithinRail(element: HTMLElement, rail: HTMLElement): number {
  let top = 0;
  let node: HTMLElement | null = element;
  while (node && node !== rail) {
    top += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return top;
}

function formatUnlockDate(seconds: number | null | undefined): string {
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

/** Icône officielle quand Steam la fournit, sinon le visuel PS4 du grade. */
function trophyImage(trophy: Trophy): string {
  const fallback = (RANK_META[trophy.rank] ?? RANK_META.bronze).icon;
  if (trophy.unlocked) return trophy.icon || fallback;
  return trophy.icongray || LOCKED_ICON;
}

function isPlatinum(trophy: Trophy): boolean {
  return (
    trophy.id === PLATINUM_ID ||
    trophy.rank === "platinum" ||
    trophy.rank === "platine"
  );
}

/** Le Platine brille bleu/blanc une fois obtenu, reste terne sinon. */
function trophyImageClass(trophy: Trophy): string {
  if (isPlatinum(trophy)) {
    return trophy.unlocked
      ? "[filter:drop-shadow(0_0_9px_rgba(150,200,255,0.95))_drop-shadow(0_0_26px_rgba(255,255,255,0.55))]"
      : "opacity-60";
  }
  return trophy.unlocked ? "" : "opacity-80";
}

function rarityText(trophy: Trophy): string {
  return `${rarityLabel(trophy.percent)} · ${formatPercent(trophy.percent)}`;
}

/** Pyramide de rareté PS4, teintée selon la proportion de joueurs. */
function RarityPyramid({ percent }: { percent: number }) {
  return (
    <svg
      viewBox="0 0 24 16"
      className="h-[13px] w-[19px] shrink-0"
      aria-hidden="true"
    >
      <path
        d="M12 1.6 22.6 14.4H1.4z"
        fill={rarityColor(percent)}
        fillOpacity="0.9"
      />
      <path
        d="M12 1.6 22.6 14.4H1.4z"
        fill="none"
        stroke="rgba(255,255,255,0.55)"
        strokeWidth="1"
      />
    </svg>
  );
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="h-[4px] w-full overflow-hidden rounded-[1px] bg-white/15">
      <div
        className="h-full rounded-[1px]"
        style={{
          width: `${Math.max(0, Math.min(100, percent))}%`,
          background: `linear-gradient(90deg, ${ORBIS_BLUE} 0%, ${ORBIS_BLUE_LIGHT} 100%)`,
          boxShadow: "0 0 10px rgba(0,130,243,0.55)",
          transition: `width ${ANIM_MS}ms ${ANIM_EASE}`,
        }}
      />
    </div>
  );
}

interface FrameState {
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  vy: number;
  vw: number;
  vh: number;
  placed: boolean;
}

export function TrophyModal({ game, onClose }: TrophyModalProps) {
  const [games, setGames] = useState<Game[]>([game]);
  const [stats, setStats] = useState<Record<string, TrophyReport | null>>({});
  const [level, setLevel] = useState(0);
  const [gamesCursor, setGamesCursor] = useState(0);
  const [activeGameId, setActiveGameId] = useState<string | null>(null);
  const [report, setReport] = useState<TrophyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [detailOpen, setDetailOpen] = useState(false);
  const [revealedIds, setRevealedIds] = useState<Set<string>>(() => new Set());
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);
  // Entrée de la vue : translation GPU au changement de niveau.
  const [viewOffset, setViewOffset] = useState(34);
  const [viewVisible, setViewVisible] = useState(false);
  // Synchronisation manuelle (bouton dédié, Options ou Triangle).
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef<(HTMLElement | null)[]>([]);
  const frameState = useRef<FrameState>({
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    vx: 0,
    vy: 0,
    vw: 0,
    vh: 0,
    placed: false,
  });
  const frameRaf = useRef(0);
  // Rail vertical : la liste entière glisse, sans défilement natif.
  const [offsetY, setOffsetY] = useState(0);
  const wheelAtRef = useRef(0);

  const activeGame =
    games.find((item) => item.id === activeGameId) ??
    games.find((item) => item.id === game.id) ??
    games[0] ??
    game;
  const trophies = report?.trophies ?? [];
  const cursor = level === 0 ? gamesCursor : selectedIndex;

  const levelRef = useRef(level);
  levelRef.current = level;
  const gamesRef = useRef<Game[]>([game]);
  gamesRef.current = games;
  const gamesCursorRef = useRef(0);
  gamesCursorRef.current = gamesCursor;
  const selectedIndexRef = useRef(0);
  selectedIndexRef.current = selectedIndex;
  const detailOpenRef = useRef(false);
  detailOpenRef.current = detailOpen;
  const trophiesRef = useRef<Trophy[]>([]);
  trophiesRef.current = trophies;
  const activeGameRef = useRef<Game>(game);
  activeGameRef.current = activeGame;

  const closeRef = useRef<() => void>(() => {});
  const backRef = useRef<() => void>(() => {});
  const revealRef = useRef<() => void>(() => {});
  const activateRef = useRef<() => void>(() => {});
  const syncRef = useRef<() => void>(() => {});
  const syncingRef = useRef(false);

  closeRef.current = () => {
    if (closing) return;
    setClosing(true);
    playBack();
    window.setTimeout(onClose, ANIM_MS);
  };

  useEffect(() => {
    panelRef.current?.focus();
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    animateView(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function animateView(direction: 1 | -1) {
    setViewVisible(false);
    setViewOffset(direction * 34);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        setViewOffset(0);
        setViewVisible(true);
      });
    });
  }

  // Niveau 1 : tous les jeux du launcher (repli sur le jeu ouvert).
  useEffect(() => {
    let cancelled = false;
    invoke<Game[]>("get_games")
      .then((list) => {
        if (cancelled) return;
        const target = list.length > 0 ? list : [game];
        gamesRef.current = target;
        setGames(target);
        const index = target.findIndex((item) => item.id === game.id);
        if (index >= 0) {
          gamesCursorRef.current = index;
          setGamesCursor(index);
        }
      })
      .catch(() => {
        if (cancelled) return;
        gamesRef.current = [game];
        setGames([game]);
      });
    return () => {
      cancelled = true;
    };
    // Le jeu sélectionné change d'identité à chaque rafraîchissement du ruban.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.id]);

  // Progression de chaque jeu pour la vue principale (sans consommer les
  // notifications de trophées : `markNew: false`).
  useEffect(() => {
    let cancelled = false;
    for (const entry of games) {
      if (!entry.steam_appid) continue;
      invoke<TrophyReport>("get_game_trophies", {
        steamAppid: entry.steam_appid,
        markNew: false,
      })
        .then((data) => {
          if (cancelled) return;
          setStats((previous) => ({ ...previous, [entry.id]: data }));
        })
        .catch(() => {
          if (cancelled) return;
          setStats((previous) => ({ ...previous, [entry.id]: null }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [games]);

  // Niveau 2 : rapport complet du jeu ouvert (notifications comprises).
  useEffect(() => {
    if (level !== 1) return;
    const target = activeGameRef.current;
    if (!target.steam_appid) {
      setReport(null);
      setError("Steam AppID manquant. Lancez « Actualiser les jaquettes ».");
      return;
    }

    let cancelled = false;
    setReport(null);
    setError(null);
    invoke<TrophyReport>("get_game_trophies", {
      steamAppid: target.steam_appid,
      markNew: true,
    })
      .then((data) => {
        if (!cancelled) setReport(data);
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [level, activeGameId]);

  // Rail vertical : la ligne active est amenée au point focal (~35 % du haut)
  // et toute la liste glisse avec elle. La mesure ne lit que des coordonnées
  // statiques (`offsetTop` / `offsetHeight`) et ne tourne qu'au changement de
  // sélection ou de taille de fenêtre.
  useLayoutEffect(() => {
    const viewport = listRef.current;
    const rail = railRef.current;
    if (!viewport || !rail) return;

    const update = () => {
      const row = rowsRef.current[cursor];
      if (!row) {
        setOffsetY(0);
        return;
      }
      const topInRail = offsetWithinRail(row, rail);
      const focusLine = viewport.clientHeight * 0.35;
      const desired = topInRail + row.offsetHeight / 2 - focusLine;
      const max = Math.max(0, rail.offsetHeight - viewport.clientHeight);
      setOffsetY(Math.min(max, Math.max(0, desired)));
    };

    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [cursor, level, trophies.length, games.length]);

  // Cadre de sélection : un seul élément blanc, déplacé et redimensionné par
  // ressort critiquement amorti — la boucle s'arrête dès qu'il est posé.
  useEffect(() => {
    const row = rowsRef.current[cursor];
    const rail = railRef.current;
    const frame = frameRef.current;
    if (!row || !rail || !frame) return;

    const goal = {
      x: row.offsetLeft,
      y: offsetWithinRail(row, rail),
      w: row.offsetWidth,
      h: row.offsetHeight,
    };

    const state = frameState.current;
    const paint = () => {
      frame.style.transform = `translate3d(${state.x.toFixed(2)}px, ${state.y.toFixed(
        2,
      )}px, 0)`;
      frame.style.width = `${state.w.toFixed(2)}px`;
      frame.style.height = `${state.h.toFixed(2)}px`;
    };

    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    if (!state.placed || reduced) {
      state.x = goal.x;
      state.y = goal.y;
      state.w = goal.w;
      state.h = goal.h;
      state.vx = 0;
      state.vy = 0;
      state.vw = 0;
      state.vh = 0;
      state.placed = true;
      paint();
      return;
    }

    state.vx += (goal.x - state.x) * FRAME_OMEGA * FRAME_START_IMPULSE;
    state.vy += (goal.y - state.y) * FRAME_OMEGA * FRAME_START_IMPULSE;
    state.vw += (goal.w - state.w) * FRAME_OMEGA * FRAME_START_IMPULSE;
    state.vh += (goal.h - state.h) * FRAME_OMEGA * FRAME_START_IMPULSE;

    const step = (
      current: number,
      velocity: number,
      goalValue: number,
      dt: number,
      decay: number,
    ): [number, number] => {
      const displacement = current - goalValue;
      const temp = (velocity + FRAME_OMEGA * displacement) * dt;
      return [
        goalValue + (displacement + temp) * decay,
        (velocity - FRAME_OMEGA * temp) * decay,
      ];
    };

    let last = performance.now();
    const tick = (time: number) => {
      const dt = Math.min(FRAME_MAX_DT, Math.max(0, (time - last) / 1000));
      last = time;
      const decay = dt > 0 ? Math.exp(-FRAME_OMEGA * dt) : 1;

      [state.x, state.vx] = step(state.x, state.vx, goal.x, dt, decay);
      [state.y, state.vy] = step(state.y, state.vy, goal.y, dt, decay);
      [state.w, state.vw] = step(state.w, state.vw, goal.w, dt, decay);
      [state.h, state.vh] = step(state.h, state.vh, goal.h, dt, decay);
      paint();

      const settled =
        Math.abs(state.x - goal.x) < 0.15 &&
        Math.abs(state.y - goal.y) < 0.15 &&
        Math.abs(state.w - goal.w) < 0.15 &&
        Math.abs(state.h - goal.h) < 0.15 &&
        Math.abs(state.vx) < 0.15 &&
        Math.abs(state.vy) < 0.15 &&
        Math.abs(state.vw) < 0.15 &&
        Math.abs(state.vh) < 0.15;

      if (settled) {
        state.x = goal.x;
        state.y = goal.y;
        state.w = goal.w;
        state.h = goal.h;
        state.vx = 0;
        state.vy = 0;
        state.vw = 0;
        state.vh = 0;
        paint();
        frameRaf.current = 0;
        return;
      }
      frameRaf.current = requestAnimationFrame(tick);
    };

    cancelAnimationFrame(frameRaf.current);
    frameRaf.current = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frameRaf.current);
      frameRaf.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, level, trophies.length, games.length]);

  function openGame(target: Game) {
    if (target.id !== activeGameRef.current.id) {
      setSelectedIndex(0);
      selectedIndexRef.current = 0;
      setDetailOpen(false);
      setRevealedIds(new Set());
    }
    setActiveGameId(target.id);
    levelRef.current = 1;
    setLevel(1);
    frameState.current.placed = false;
    setOffsetY(0);
    animateView(1);
    playEnterMenu();
  }

  function moveSelection(delta: 1 | -1) {
    if (detailOpenRef.current) return;
    if (levelRef.current === 0) {
      const total = gamesRef.current.length;
      if (total === 0) return;
      const next = Math.min(total - 1, Math.max(0, gamesCursorRef.current + delta));
      if (next === gamesCursorRef.current) return;
      gamesCursorRef.current = next;
      setGamesCursor(next);
      playNav();
      return;
    }
    const total = trophiesRef.current.length;
    if (total === 0) return;
    const next = Math.min(
      total - 1,
      Math.max(0, selectedIndexRef.current + delta),
    );
    if (next === selectedIndexRef.current) return;
    selectedIndexRef.current = next;
    setSelectedIndex(next);
    playNav();
  }

  /** Molette : même pas que Haut/Bas, avec un anti-rebond de 60 ms. */
  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    if (detailOpenRef.current) return;
    if (Math.abs(event.deltaY) < 4) return;
    const time = performance.now();
    if (time - wheelAtRef.current < 60) return;
    wheelAtRef.current = time;
    moveSelection(event.deltaY > 0 ? 1 : -1);
  }

  function openDetail() {
    if (levelRef.current !== 1) return;
    if (trophiesRef.current.length === 0) return;
    playConfirm();
    setDetailOpen(true);
  }

  backRef.current = () => {
    if (detailOpenRef.current) {
      playBack();
      setDetailOpen(false);
      return;
    }
    if (levelRef.current === 1) {
      playBack();
      levelRef.current = 0;
      setLevel(0);
      frameState.current.placed = false;
      setOffsetY(0);
      animateView(-1);
      return;
    }
    closeRef.current();
  };

  revealRef.current = () => {
    if (levelRef.current !== 1) return;
    const trophy = trophiesRef.current[selectedIndexRef.current];
    if (!trophy || trophy.unlocked || !trophy.hidden) return;
    playNav();
    setRevealedIds((previous) => {
      const next = new Set(previous);
      if (next.has(trophy.id)) next.delete(trophy.id);
      else next.add(trophy.id);
      return next;
    });
  };

  activateRef.current = () => {
    if (levelRef.current === 0) {
      const target = gamesRef.current[gamesCursorRef.current];
      if (target) openGame(target);
      return;
    }
    openDetail();
  };

  /** Relit tous les succès locaux puis Steam, sans jamais bloquer l'interface. */
  async function syncTrophiesNow() {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    setSyncNote(null);
    playConfirm();

    try {
      if (levelRef.current === 0) {
        // Niveau 1 : tous les jeux ; le back résout l'AppID si nécessaire.
        const entries = gamesRef.current;
        let updated = 0;
        let failed = 0;
        for (const entry of entries) {
          try {
            const data = await invoke<TrophyReport>("sync_game_trophies", {
              gameId: entry.id,
            });
            setStats((previous) => ({ ...previous, [entry.id]: data }));
            updated += 1;
          } catch {
            failed += 1;
          }
        }
        if (entries.length === 0) {
          setSyncNote("Aucun jeu dans la bibliothèque");
        } else {
          setSyncNote(
            failed === 0
              ? `${updated} jeu${updated > 1 ? "x" : ""} synchronisé${
                  updated > 1 ? "s" : ""
                }`
              : `${updated} synchronisé${
                  updated > 1 ? "s" : ""
                } · ${failed} sans succès`,
          );
        }
      } else {
        const target = activeGameRef.current;
        const data = await invoke<TrophyReport>("sync_game_trophies", {
          gameId: target.id,
        });
        setReport(data);
        setStats((previous) => ({ ...previous, [target.id]: data }));
        setError(null);
        setSyncNote(
          `${data.unlocked} / ${data.total} trophées à jour${
            data.offline ? " · cache hors ligne" : ""
          }`,
        );
      }
    } catch (cause) {
      setSyncNote(`Synchronisation impossible : ${String(cause)}`);
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }

  syncRef.current = () => {
    void syncTrophiesNow();
  };

  // Manette : croix directionnelle / stick pour naviguer, Croix / Rond / Carré.
  // Le hook global d'App lit aussi les manettes : on lui renvoie une liste vide
  // le temps de l'écran et on interroge la vraie API pour notre navigation.
  useEffect(() => {
    const target = navigator as unknown as {
      getGamepads?: () => (Gamepad | null)[];
    };
    const api = target.getGamepads;
    const readPads = api ? api.bind(navigator) : null;
    if (api) target.getGamepads = () => [];

    let frame = 0;
    let lastNav = 0;
    let crossHeld = false;
    let circleHeld = false;
    let squareHeld = false;
    let triangleHeld = false;

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      let up = false;
      let down = false;
      let cross = false;
      let circle = false;
      let square = false;
      let triangle = false;

      for (const pad of readPads?.() ?? []) {
        if (!pad?.connected) continue;
        const axisY = pad.axes[1] ?? 0;
        // Zone morte stricte : le stick au repos ne doit jamais faire défiler.
        const stickUp = Math.abs(axisY) > 0.55 && axisY < 0;
        const stickDown = Math.abs(axisY) > 0.55 && axisY > 0;
        up = up || Boolean(pad.buttons[12]?.pressed) || stickUp;
        down = down || Boolean(pad.buttons[13]?.pressed) || stickDown;
        cross = cross || Boolean(pad.buttons[0]?.pressed);
        circle = circle || Boolean(pad.buttons[1]?.pressed);
        square = square || Boolean(pad.buttons[2]?.pressed);
        triangle = triangle || Boolean(pad.buttons[3]?.pressed);
      }

      if ((up || down) && now - lastNav >= 180) {
        lastNav = now;
        moveSelection(down ? 1 : -1);
      }

      if (cross && !crossHeld) activateRef.current();
      if (circle && !circleHeld) backRef.current();
      if (square && !squareHeld) revealRef.current();
      if (triangle && !triangleHeld) syncRef.current();
      crossHeld = cross;
      circleHeld = circle;
      squareHeld = square;
      triangleHeld = triangle;
    };

    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      if (api) target.getGamepads = api;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Neutralise les raccourcis globaux (lancer, navigation) sous l'overlay.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (hasSystemModifier(event)) return;
      const id = event.key.toLowerCase();

      if (isTypingTarget(event.target)) {
        // Aucun champ ici, mais on garde le même contrat que les autres fenêtres.
        if (id === "escape") {
          event.preventDefault();
          event.stopImmediatePropagation();
          backRef.current();
        }
        return;
      }
      // « R » et Tab révèlent les trophées masqués en plus de Carré (X).
      if (!isMenuKey(id) && id !== "r" && event.key !== "Tab") return;

      event.preventDefault();
      event.stopImmediatePropagation();

      // Une action ne part qu'une fois par pression (contrairement aux directions).
      const isDirection =
        id === "arrowup" || id === "z" || id === "arrowdown" || id === "s";
      if (event.repeat && !isDirection) return;

      if (id === "b" || id === "escape" || id === "backspace") {
        backRef.current();
        return;
      }
      if (id === "arrowup" || id === "z") {
        moveSelection(-1);
        return;
      }
      if (id === "arrowdown" || id === "s") {
        moveSelection(1);
        return;
      }
      if (id === "x" || id === "r" || event.key === "Tab") {
        revealRef.current();
        return;
      }
      // Options (Y / O) : synchronisation manuelle des trophées.
      if (id === "y" || id === "o") {
        syncRef.current();
        return;
      }
      if (id === "a" || id === "enter") activateRef.current();
      // q, d : avalés, l'écran n'a pas d'autre action.
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rankMeta = (rank: string) => RANK_META[rank] ?? RANK_META.bronze;
  const focused = trophies[selectedIndex];
  // Un succès masqué et verrouillé reste anonyme tant que Carré ne l'a pas
  // révélé : ni nom, ni description, ni visuel d'origine.
  const isMasked = (trophy: Trophy) =>
    Boolean(trophy.hidden && !trophy.unlocked && !revealedIds.has(trophy.id));
  const focusedHidden = Boolean(focused?.hidden && !focused.unlocked);
  const focusedMasked = focused ? isMasked(focused) : false;

  // Seuls ~16 trophées sont montés dans le DOM, quelle que soit la taille du jeu.
  const windowStart = Math.max(0, selectedIndex - TROPHY_WINDOW_ABOVE);
  const windowEnd = Math.min(
    trophies.length,
    selectedIndex + TROPHY_WINDOW_BELOW + 1,
  );
  const visibleTrophies = trophies.slice(windowStart, windowEnd);

  // Totaux de tous les jeux, pour l'en-tête du niveau 1.
  const globalCounts = { platinum: 0, gold: 0, silver: 0, bronze: 0 };
  let globalUnlocked = 0;
  let globalTotal = 0;
  for (const entry of Object.values(stats)) {
    if (!entry) continue;
    globalCounts.platinum += entry.counts.platinum;
    globalCounts.gold += entry.counts.gold;
    globalCounts.silver += entry.counts.silver;
    globalCounts.bronze += entry.counts.bronze;
    globalUnlocked += entry.unlocked;
    globalTotal += entry.total;
  }
  const globalPercent =
    globalTotal > 0 ? (globalUnlocked / globalTotal) * 100 : 0;
  const globalPoints =
    globalCounts.platinum * 180 +
    globalCounts.gold * 90 +
    globalCounts.silver * 30 +
    globalCounts.bronze * 15;
  const globalLevel = Math.floor(globalPoints / 300) + 1;

  function gamePercent(entry: Game): number {
    return stats[entry.id]?.progress ?? 0;
  }

  // Action manuelle : même action au clic, à Options et au Triangle.
  const syncButton = (
    <button
      type="button"
      onClick={(event) => {
        if (shouldIgnoreClick(event)) return;
        syncRef.current();
      }}
      disabled={syncing}
      aria-label="Synchroniser les trophées"
      className="flex items-center gap-2 rounded-[2px] border border-white/40 bg-white/10 px-3 py-1.5 text-[12px] text-white outline-none transition-colors duration-200 hover:bg-white/20 disabled:opacity-60"
      style={{ ...SST_STYLE, fontWeight: 700 }}
    >
      <img
        src="/buttons/PS4_Triangle.png"
        alt=""
        className={`h-4 w-4 shrink-0 object-contain ${syncing ? "animate-pulse" : ""}`}
      />
      <span className={syncing ? "animate-pulse" : undefined}>
        {syncing ? "Synchronisation…" : "Synchroniser les trophées"}
      </span>
    </button>
  );

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Trophées"
      className="ps4-trophies fixed inset-0 z-50 flex flex-col overflow-hidden text-white outline-none"
      style={{
        ...SST_STYLE,
        background:
          "linear-gradient(180deg, #003791 0%, #00439C 42%, #021029 100%)",
        opacity: visible && !closing ? 1 : 0,
        transform:
          visible && !closing
            ? "translate3d(0, 0, 0)"
            : "translate3d(0, 22px, 0)",
        transitionProperty: "opacity, transform",
        transitionDuration: `${ANIM_MS}ms`,
        transitionTimingFunction: ANIM_EASE,
      }}
      onWheel={handleWheel}
    >
      <div
        className="flex min-h-0 flex-1 flex-col"
        style={{
          opacity: viewVisible ? 1 : 0,
          transform: `translate3d(${viewOffset}px, 0, 0)`,
          transition: `transform ${ANIM_MS}ms ${ANIM_EASE}, opacity ${ANIM_MS}ms ${ANIM_EASE}`,
        }}
      >
        <header className="shrink-0 px-10 pt-6">
          {level === 0 ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <h2
                    className="text-[38px] leading-none tracking-wide text-white"
                    style={{ ...SST_STYLE, fontWeight: 700 }}
                  >
                    Trophées
                  </h2>
                  <span
                    className="flex h-[28px] items-center gap-1.5 rounded-[2px] border border-white/40 bg-white/10 px-2.5"
                    style={{ ...SST_STYLE, fontWeight: 700 }}
                    title={`Niveau de trophées ${globalLevel}`}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      className="h-4 w-4"
                      fill="#F5C451"
                      aria-hidden="true"
                    >
                      <path d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9z" />
                    </svg>
                    <span className="text-[14px]">{globalLevel}</span>
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-x-7 gap-y-2">
                  {COUNT_ITEMS.map((item) => (
                    <div key={item.key} className="flex items-center gap-2">
                      <img
                        src={item.icon}
                        alt=""
                        className="h-7 w-7 object-contain"
                      />
                      <span
                        className="text-[20px] text-white"
                        style={{ ...SST_STYLE, fontWeight: 700 }}
                      >
                        {globalCounts[item.key]}
                      </span>
                      <span
                        className="text-[10px] uppercase tracking-[0.2em] text-white/60"
                        style={{ ...SST_STYLE, fontWeight: 600 }}
                      >
                        {item.label}
                      </span>
                    </div>
                  ))}
                  {syncButton}
                </div>
              </div>

              {syncNote ? (
                <p
                  className="mt-2 text-[12px] text-white/70"
                  style={{ ...SST_STYLE, fontWeight: 600 }}
                  role="status"
                >
                  {syncNote}
                </p>
              ) : null}

              <div className="mt-4 flex items-center gap-4">
                <div className="max-w-[420px] flex-1">
                  <ProgressBar percent={globalPercent} />
                </div>
                <span
                  className="text-[15px] text-white"
                  style={{ ...SST_STYLE, fontWeight: 700 }}
                >
                  {formatPercent(globalPercent)}
                </span>
                <span
                  className="text-[13px] text-white/60"
                  style={{ ...SST_STYLE, fontWeight: 600 }}
                >
                  {globalUnlocked} / {globalTotal} trophées
                </span>
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
                <div className="flex items-center gap-4">
                  <div className="h-[56px] w-[56px] shrink-0 overflow-hidden rounded-[2px] border border-white/30 bg-white/10">
                    {activeGame.cover_url ? (
                      <img
                        src={activeGame.cover_url}
                        alt=""
                        draggable={false}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center text-xl font-bold text-white/40">
                        {activeGame.title.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 max-w-[360px]">
                    <h2
                      className="truncate text-[26px] leading-tight text-white"
                      style={{ ...SST_STYLE, fontWeight: 700 }}
                    >
                      {activeGame.title}
                    </h2>
                    <p
                      className="mt-1 text-[12px] text-white/60"
                      style={{ ...SST_STYLE, fontWeight: 600 }}
                    >
                      {report
                        ? `${report.unlocked} / ${report.total} trophées${
                            report.offline ? " · cache hors ligne" : ""
                          }`
                        : "Chargement des trophées…"}
                    </p>
                  </div>
                </div>

                <div className="ml-auto flex flex-wrap items-center gap-x-6 gap-y-2">
                  {COUNT_ITEMS.map((item) => (
                    <div key={item.key} className="flex items-center gap-2">
                      <img
                        src={item.icon}
                        alt=""
                        className="h-6 w-6 object-contain"
                      />
                      <span
                        className="text-[18px] text-white"
                        style={{ ...SST_STYLE, fontWeight: 700 }}
                      >
                        {report?.counts[item.key] ?? 0}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-4">
                <div className="max-w-[420px] flex-1">
                  <ProgressBar percent={report?.progress ?? 0} />
                </div>
                <span
                  className="text-[15px] text-white"
                  style={{ ...SST_STYLE, fontWeight: 700 }}
                >
                  {formatPercent(report?.progress ?? 0)}
                </span>
                {syncButton}
                {syncNote ? (
                  <span
                    className="text-[12px] text-white/70"
                    style={{ ...SST_STYLE, fontWeight: 600 }}
                    role="status"
                  >
                    {syncNote}
                  </span>
                ) : null}
              </div>
            </>
          )}
        </header>

        <div
          ref={listRef}
          className="ps4-trophies-scroll relative mt-3 min-h-0 flex-1 overflow-hidden px-10 pb-2"
        >
          <div
            ref={railRef}
            className="relative will-change-transform transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
            style={{ transform: `translate3d(0, -${offsetY}px, 0)` }}
          >
            {/* Cadre blanc unique : glisse et s'étire d'une ligne à l'autre. */}
            <div
              ref={frameRef}
              aria-hidden="true"
              className="pointer-events-none absolute left-0 top-0 z-0 rounded-[2px] border-2 border-white bg-white/[0.10] shadow-[0_0_18px_rgba(120,190,255,0.38)]"
              style={{ width: 0, height: 0, willChange: "transform" }}
            />

            {level === 0 ? (
              <ul className="relative flex flex-col">
                {games.map((entry, index) => {
                  const entryReport = stats[entry.id] ?? null;
                  const percent = gamePercent(entry);
                  const isFocused = index === gamesCursor;
                  return (
                    <li
                      key={entry.id}
                      ref={(node) => {
                        rowsRef.current[index] = node;
                      }}
                      style={{ height: GAME_ROW_HEIGHT }}
                      className="relative z-10 shrink-0 border-t border-white/[0.14] first:border-t-0"
                    >
                      <button
                        type="button"
                        onClick={(event) => {
                          if (shouldIgnoreClick(event)) return;
                          if (!isFocused) {
                            gamesCursorRef.current = index;
                            setGamesCursor(index);
                            playNav();
                          }
                          openGame(entry);
                        }}
                        aria-current={isFocused ? "true" : undefined}
                        className="flex h-full w-full items-center gap-5 px-4 text-left outline-none"
                      >
                        <div className="h-[62px] w-[62px] shrink-0 overflow-hidden rounded-[2px] border border-white/30 bg-white/10">
                          {entry.cover_url ? (
                            <img
                              src={entry.cover_url}
                              alt=""
                              draggable={false}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <span
                              className="flex h-full w-full items-center justify-center text-lg text-white/40"
                              style={{ ...SST_STYLE, fontWeight: 700 }}
                            >
                              {entry.title.slice(0, 1).toUpperCase()}
                            </span>
                          )}
                        </div>

                        <div className="min-w-0 flex-1">
                          <p
                            className="truncate text-[19px] leading-tight text-white"
                            style={{ ...SST_STYLE, fontWeight: 700 }}
                          >
                            {entry.title}
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                            {COUNT_ITEMS.map((item) => (
                              <span
                                key={item.key}
                                className="flex items-center gap-1.5"
                              >
                                <img
                                  src={item.icon}
                                  alt=""
                                  className="h-4 w-4 object-contain"
                                />
                                <span
                                  className="text-[12px] text-white/85"
                                  style={{ ...SST_STYLE, fontWeight: 700 }}
                                >
                                  {entryReport?.counts[item.key] ?? 0}
                                </span>
                              </span>
                            ))}
                          </div>
                          <div className="mt-2 max-w-[420px]">
                            <ProgressBar percent={percent} />
                          </div>
                        </div>

                        <div className="w-[92px] shrink-0 text-right">
                          <p
                            className="text-[22px] leading-none text-white"
                            style={{ ...SST_STYLE, fontWeight: 700 }}
                          >
                            {entryReport ? formatPercent(percent) : "—"}
                          </p>
                          <p
                            className="mt-1 text-[11px] text-white/55"
                            style={{ ...SST_STYLE, fontWeight: 600 }}
                          >
                            {entryReport
                              ? `${entryReport.unlocked} / ${entryReport.total}`
                              : entry.steam_appid
                                ? "Chargement"
                                : "Pas de trophées"}
                          </p>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : error ? (
              <p
                className="px-2 py-12 text-center text-[15px] text-red-200"
                style={{ ...SST_STYLE, fontWeight: 600 }}
              >
                {error}
              </p>
            ) : !report ? (
              <p
                className="px-2 py-12 text-center text-[15px] text-white/60"
                style={{ ...SST_STYLE, fontWeight: 600 }}
              >
                Chargement des trophées…
              </p>
            ) : trophies.length === 0 ? (
              <p
                className="px-2 py-12 text-center text-[15px] text-white/60"
                style={{ ...SST_STYLE, fontWeight: 600 }}
              >
                Aucun trophée disponible pour ce jeu.
              </p>
            ) : (
              <ul className="relative flex flex-col">
                {windowStart > 0 ? (
                  <li
                    aria-hidden="true"
                    className="shrink-0"
                    style={{ height: windowStart * TROPHY_ROW_HEIGHT }}
                  />
                ) : null}
                {visibleTrophies.map((trophy, offset) => {
                  const index = windowStart + offset;
                  const meta = rankMeta(trophy.rank);
                  const isFocused = index === selectedIndex;
                  const description = trophy.description.trim();
                  const maskedTrophy = isMasked(trophy);

                  return (
                    <li
                      key={trophy.id}
                      ref={(node) => {
                        rowsRef.current[index] = node;
                      }}
                      style={{ height: TROPHY_ROW_HEIGHT }}
                      className="relative z-10 shrink-0 border-t border-white/[0.14] first:border-t-0"
                    >
                      <button
                        type="button"
                        onClick={(event) => {
                          if (shouldIgnoreClick(event)) return;
                          if (!isFocused) {
                            selectedIndexRef.current = index;
                            setSelectedIndex(index);
                            playNav();
                          }
                          openDetail();
                        }}
                        aria-current={isFocused ? "true" : undefined}
                        className="flex h-full w-full items-center gap-5 overflow-hidden px-4 py-3 text-left outline-none"
                      >
                        <div className="flex h-[64px] w-[64px] shrink-0 items-center justify-center rounded-[2px] border border-white/25 bg-white/10 p-2">
                          <img
                            src={maskedTrophy ? LOCKED_ICON : trophyImage(trophy)}
                            alt=""
                            draggable={false}
                            className={`h-full w-full object-contain ${
                              maskedTrophy
                                ? "opacity-70"
                                : trophyImageClass(trophy)
                            }`}
                          />
                        </div>

                        <div className="min-w-0 flex-1">
                          <p
                            className="truncate text-[20px] leading-tight text-white"
                            style={{ ...SST_STYLE, fontWeight: 700 }}
                          >
                            {maskedTrophy ? "Trophée masqué" : displayName(trophy)}
                          </p>
                          <p
                            className="mt-1 line-clamp-2 text-[14px] leading-snug text-white/75"
                            style={{ ...SST_STYLE, fontWeight: 600 }}
                          >
                            {maskedTrophy
                              ? "Appuyez sur Carré pour révéler ce trophée."
                              : description
                                ? description
                                : trophy.unlocked
                                  ? "Description indisponible"
                                  : "Trophée masqué • Verrouillé"}
                          </p>
                        </div>

                        <div className="shrink-0 pl-2 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <img
                              src={meta.icon}
                              alt=""
                              className="h-5 w-5 object-contain"
                            />
                            <span
                              className="text-[14px] text-white"
                              style={{ ...SST_STYLE, fontWeight: 700 }}
                            >
                              {meta.label}
                            </span>
                          </div>
                          <p
                            className="mt-1.5 flex items-center justify-end gap-1.5 text-[12px] text-white/70"
                            style={{ ...SST_STYLE, fontWeight: 600 }}
                          >
                            <RarityPyramid percent={trophy.percent} />
                            {rarityText(trophy)}
                          </p>
                        </div>
                      </button>
                    </li>
                  );
                })}
                {windowEnd < trophies.length ? (
                  <li
                    aria-hidden="true"
                    className="shrink-0"
                    style={{
                      height: (trophies.length - windowEnd) * TROPHY_ROW_HEIGHT,
                    }}
                  />
                ) : null}
              </ul>
            )}
          </div>
        </div>
      </div>

      <footer className="relative z-10 flex shrink-0 flex-wrap items-center gap-x-8 gap-y-2 border-t border-white/[0.14] px-10 py-3 text-[13px] text-white/70">
        <span className="flex items-center gap-2">
          <img src="/buttons/PS4_Cross.png" alt="" className={HINT_ICON} />
          {level === 0 ? "Ouvrir" : "Détails"}
        </span>
        {level === 1 && focusedHidden ? (
          <span className="flex items-center gap-2">
            <img src="/buttons/PS4_Square.png" alt="" className={HINT_ICON} />
            <span style={{ ...SST_STYLE, fontWeight: 600 }}>
              {focusedMasked
                ? "Afficher les informations"
                : "Masquer les informations"}
            </span>
          </span>
        ) : null}
        <span className="flex items-center gap-2">
          <img src="/buttons/PS4_Circle.png" alt="" className={HINT_ICON} />
          <span style={{ ...SST_STYLE, fontWeight: 600 }}>
            {level === 0 ? "Fermer" : "Retour"}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <img src="/buttons/PS4_Triangle.png" alt="" className={HINT_ICON} />
          <span style={{ ...SST_STYLE, fontWeight: 600 }}>
            {syncing ? "Synchronisation…" : "Synchroniser"}
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <img src="/buttons/PS4_Dpad_Up.png" alt="" className={HINT_ICON} />
          <img src="/buttons/PS4_Dpad_Down.png" alt="" className={HINT_ICON} />
          <span style={{ ...SST_STYLE, fontWeight: 600 }}>Parcourir</span>
        </span>
        <span
          className="ml-auto truncate text-white/40"
          style={{ ...SST_STYLE, fontWeight: 600 }}
        >
          {level === 0 ? "Trophées" : activeGame.title}
        </span>
      </footer>

      {detailOpen && focused ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/55 px-10 py-10">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Détails du trophée ${displayName(focused)}`}
            className="w-full max-w-[760px] rounded-[2px] border-2 border-white px-9 py-8 shadow-[0_0_40px_rgba(0,0,0,0.65)]"
            style={{
              background:
                "linear-gradient(180deg, rgba(0,67,156,0.96) 0%, rgba(0,38,99,0.97) 55%, rgba(2,16,41,0.98) 100%)",
            }}
          >
            <div className="flex items-start gap-7">
              <div className="flex h-[120px] w-[120px] shrink-0 items-center justify-center rounded-[2px] border border-white/25 bg-white/10 p-3">
                <img
                  src={focusedMasked ? LOCKED_ICON : trophyImage(focused)}
                  alt=""
                  className={`h-full w-full object-contain ${
                    focusedMasked ? "opacity-70" : trophyImageClass(focused)
                  }`}
                />
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2.5">
                  <img
                    src={rankMeta(focused.rank).icon}
                    alt=""
                    className="h-6 w-6 object-contain"
                  />
                  <span
                    className="text-[13px] uppercase tracking-[0.24em] text-white/65"
                    style={{ ...SST_STYLE, fontWeight: 600 }}
                  >
                    {rankMeta(focused.rank).label}
                  </span>
                </div>

                <h3
                  className="mt-2 text-[28px] leading-tight text-white"
                  style={{ ...SST_STYLE, fontWeight: 700 }}
                >
                  {focusedMasked ? "Trophée masqué" : displayName(focused)}
                </h3>

                <p
                  className="mt-3 text-[16px] leading-snug text-white/80"
                  style={{ ...SST_STYLE, fontWeight: 600 }}
                >
                  {focusedMasked
                    ? "Appuyez sur Carré pour révéler ce trophée."
                    : focused.description.trim()
                      ? focused.description
                      : focused.unlocked
                        ? "Description indisponible"
                        : "Trophée masqué • Verrouillé"}
                </p>

                <div
                  className="mt-5 flex flex-wrap items-center gap-3 text-[14px]"
                  style={{ ...SST_STYLE, fontWeight: 600 }}
                >
                  <span className="flex items-center gap-2 rounded-[2px] border border-white/25 bg-white/10 px-2.5 py-1 text-white/85">
                    <RarityPyramid percent={focused.percent} />
                    {rarityText(focused)}
                  </span>
                  <span className="text-white/65">
                    {focused.unlocked
                      ? formatUnlockDate(focused.unlocked_at)
                        ? `Débloqué le ${formatUnlockDate(focused.unlocked_at)}`
                        : "Débloqué"
                      : "Verrouillé"}
                  </span>
                </div>
              </div>
            </div>

            <div className="mt-7 flex items-center gap-7 border-t border-white/[0.14] pt-4 text-[12px] text-white/60">
              <span
                className="flex items-center gap-2"
                style={{ ...SST_STYLE, fontWeight: 600 }}
              >
                <img
                  src="/buttons/PS4_Circle.png"
                  alt=""
                  className="h-5 w-5 object-contain"
                />
                Retour
              </span>
              <span
                className="ml-auto truncate"
                style={{ ...SST_STYLE, fontWeight: 600 }}
              >
                {activeGame.title}
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
