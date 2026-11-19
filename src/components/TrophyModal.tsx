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
  playEnterMenu,
  playNav,
} from "../utils/ps4Audio";
import {
  hasSystemModifier,
  isMenuKey,
  isTypingTarget,
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

// Virtualisation de la liste : hauteur fixe des lignes et fenêtre glissante
// rendue autour de la sélection (5 trophées au-dessus, 10 en dessous). Les
// cales conservent la hauteur totale du rail pour un défilement continu.
const TROPHY_ROW_HEIGHT = 108;
const TROPHY_WINDOW_ABOVE = 5;
const TROPHY_WINDOW_BELOW = 10;

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
        cursor === start ? pieces.length > 0 && after >= 4 : before >= 3 && after >= 3;
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
  return trophy.id === PLATINUM_ID || trophy.rank === "platinum" || trophy.rank === "platine";
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

export function TrophyModal({ game, onClose }: TrophyModalProps) {
  const [report, setReport] = useState<TrophyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [detailOpen, setDetailOpen] = useState(false);
  // Trophées masqués révélés un par un avec Carré (jamais persisté).
  const [revealedIds, setRevealedIds] = useState<Set<string>>(() => new Set());

  const listRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef<(HTMLLIElement | null)[]>([]);
  // Rail vertical : la liste entière glisse, sans défilement natif.
  const [offsetY, setOffsetY] = useState(0);
  const wheelAtRef = useRef(0);

  const trophies = report?.trophies ?? [];

  const closeRef = useRef<() => void>(() => {});
  const backRef = useRef<() => void>(() => {});
  const revealRef = useRef<() => void>(() => {});
  const trophiesRef = useRef<Trophy[]>(trophies);
  const selectedIndexRef = useRef(0);
  const detailOpenRef = useRef(false);

  trophiesRef.current = trophies;
  selectedIndexRef.current = selectedIndex;
  detailOpenRef.current = detailOpen;

  closeRef.current = () => {
    playBack();
    onClose();
  };

  backRef.current = () => {
    if (detailOpen) {
      playBack();
      setDetailOpen(false);
      return;
    }
    closeRef.current();
  };

  revealRef.current = () => {
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

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!game.steam_appid) {
      setReport(null);
      setError("Steam AppID manquant. Lancez « Actualiser les jaquettes ».");
      return;
    }

    let cancelled = false;
    setReport(null);
    setError(null);
    setSelectedIndex(0);
    setDetailOpen(false);
    setRevealedIds(new Set());

    invoke<TrophyReport>("get_game_trophies", {
      steamAppid: game.steam_appid,
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
  }, [game.steam_appid]);

  // Rail vertical : la ligne active est amenée au point focal (~35 % du haut)
  // et toute la liste glisse avec elle. La mesure ne lit que des coordonnées
  // statiques (`offsetTop` / `offsetHeight`) et ne tourne qu'au changement de
  // sélection, de nombre de trophées ou de taille de fenêtre. Aucun état
  // d'offset n'entre dans les dépendances : pas de boucle de mesure.
  useLayoutEffect(() => {
    const viewport = listRef.current;
    const rail = railRef.current;
    if (!viewport || !rail) return;

    const update = () => {
      const row = rowsRef.current[selectedIndexRef.current];
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
  }, [selectedIndex, trophies.length]);

  const moveSelection = (delta: 1 | -1) => {
    // La fiche de détail garde la main : on ne navigue pas derrière elle.
    if (detailOpenRef.current) return;
    const total = trophiesRef.current.length;
    if (total === 0) return;
    const current = selectedIndexRef.current;
    const next = Math.min(total - 1, Math.max(0, current + delta));
    if (next === current) return;
    selectedIndexRef.current = next;
    setSelectedIndex(next);
    playNav();
  };

  /** Molette : même pas que Haut/Bas, avec un anti-rebond de 60 ms. */
  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (detailOpenRef.current) return;
    if (Math.abs(event.deltaY) < 4) return;
    const time = performance.now();
    if (time - wheelAtRef.current < 60) return;
    wheelAtRef.current = time;
    moveSelection(event.deltaY > 0 ? 1 : -1);
  };

  const openDetail = () => {
    if (trophiesRef.current.length === 0) return;
    playEnterMenu();
    setDetailOpen(true);
  };

  // Manette : croix directionnelle / stick pour naviguer, Croix / Rond.
  // Le hook global d'App lit aussi les manettes (Croix lançait le jeu, Gauche
  // et Droite changeaient de jeu) : on lui renvoie une liste vide le temps de
  // l'écran et on interroge la vraie API pour notre propre navigation.
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

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      let up = false;
      let down = false;
      let cross = false;
      let circle = false;
      let square = false;

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
      }

      if ((up || down) && now - lastNav >= 180) {
        lastNav = now;
        moveSelection(down ? 1 : -1);
      }

      if (cross && !crossHeld) openDetail();
      if (circle && !circleHeld) backRef.current();
      if (square && !squareHeld) revealRef.current();
      crossHeld = cross;
      circleHeld = circle;
      squareHeld = square;
    };

    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      if (api) target.getGamepads = api;
    };
    // Les actions passent par des refs : l'écouteur reste monté une seule fois.
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
      if (!isMenuKey(id)) return;

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
      if (id === "x") {
        revealRef.current();
        return;
      }
      if (id === "a" || id === "enter") openDetail();
      // q, d, y, o : avalés, l'écran n'a pas d'autre action.
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

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={`Trophées de ${game.title}`}
      className="ps4-trophies fixed inset-0 z-50 flex flex-col overflow-hidden bg-gradient-to-b from-[#001840] via-[#002868] to-[#000e26] text-white outline-none"
      onWheel={handleWheel}
    >
      <header className="relative z-10 shrink-0 px-12 pt-8">
        <div className="flex items-start justify-between gap-8">
          <h2 className="text-[42px] font-light leading-none tracking-wide">
            Trophées
          </h2>

          <div className="w-[300px] shrink-0 text-right">
            <div className="flex items-baseline justify-between text-[13px] tracking-wide">
              <span className="uppercase text-white/60">Progression</span>
              <span className="tabular-nums text-white">
                {report ? formatPercent(report.progress) : "0,0 %"}
              </span>
            </div>
            <div className="mt-2 h-2.5 w-full overflow-hidden rounded-[2px] bg-white/20">
              <div
                className="h-full bg-white transition-[width] duration-500"
                style={{ width: `${report?.progress ?? 0}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-white/55">
              {report
                ? `${report.unlocked} / ${report.total} trophées${
                    report.offline ? " · cache hors ligne" : ""
                  }`
                : "—"}
            </p>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-4">
          <div className="flex items-center gap-4">
            <div className="relative h-[72px] w-[54px] shrink-0 overflow-hidden rounded-[2px] border border-white/25 bg-white/10">
              {game.cover_url ? (
                <img
                  src={game.cover_url}
                  alt=""
                  draggable={false}
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-2xl font-black text-white/40">
                  {game.title.slice(0, 1).toUpperCase()}
                </span>
              )}
              <span className="absolute bottom-0 left-0 bg-white px-1.5 py-[1px] text-[9px] font-bold leading-tight tracking-[0.12em] text-[#002868]">
                PS4
              </span>
            </div>
            <div className="min-w-0 max-w-[280px]">
              <p className="truncate text-[17px] font-medium tracking-wide text-white">
                {game.title}
              </p>
              <p className="mt-1 text-[11px] uppercase tracking-[0.28em] text-white/45">
                Trophées du jeu
              </p>
            </div>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-x-8 gap-y-3">
            {COUNT_ITEMS.map((item) => (
              <div key={item.key} className="flex items-center gap-2.5">
                <img src={item.icon} alt="" className="h-8 w-8 object-contain" />
                <div className="leading-none">
                  <span className="text-[22px] font-light tabular-nums text-white">
                    {report?.counts[item.key] ?? 0}
                  </span>
                  <span className="ml-2 text-[10px] uppercase tracking-[0.22em] text-white/55">
                    {item.label}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </header>

      <div className="relative z-10 mx-12 mt-5 h-px shrink-0 bg-white/15" />

      <div
        ref={listRef}
        className="ps4-trophies-scroll relative z-10 mt-3 min-h-0 flex-1 overflow-hidden px-12 pb-4"
      >
        <div
          ref={railRef}
          className="relative will-change-transform transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
          style={{ transform: `translate3d(0, -${offsetY}px, 0)` }}
        >
          {error ? (
            <p className="px-2 py-12 text-center text-sm text-red-200">
              {error}
            </p>
          ) : !report ? (
            <p className="px-2 py-12 text-center text-sm text-white/60">
              Chargement des trophées…
            </p>
          ) : trophies.length === 0 ? (
            <p className="px-2 py-12 text-center text-sm text-white/60">
              Aucun trophée disponible pour ce jeu.
            </p>
          ) : (
            <ul className="flex flex-col">
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
                  className="shrink-0 border-b border-white/15"
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (!isFocused) {
                        selectedIndexRef.current = index;
                        setSelectedIndex(index);
                        playNav();
                      }
                      openDetail();
                    }}
                    aria-current={isFocused ? "true" : undefined}
                    className={`flex h-full w-full items-center gap-5 overflow-hidden rounded-[2px] px-5 py-3.5 text-left transition duration-200 ${
                      isFocused
                        ? "border-[3px] border-white bg-[#004ba8]/75 shadow-[0_0_24px_rgba(255,255,255,0.5)]"
                        : "border-[3px] border-transparent hover:bg-white/10"
                    } ${trophy.unlocked || isFocused ? "" : "opacity-70"}`}
                  >
                    <div className="flex h-[68px] w-[68px] shrink-0 items-center justify-center rounded-[2px] border border-white/20 bg-white/10 p-2">
                      <img
                        src={maskedTrophy ? LOCKED_ICON : trophyImage(trophy)}
                        alt=""
                        draggable={false}
                        className={`h-full w-full object-contain ${
                          maskedTrophy ? "opacity-70" : trophyImageClass(trophy)
                        }`}
                      />
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[22px] font-medium leading-tight text-white">
                        {maskedTrophy ? "Trophée masqué" : displayName(trophy)}
                      </p>
                      <p className="mt-1.5 line-clamp-2 text-[16px] leading-snug text-white/75">
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
                          className="h-6 w-6 object-contain"
                        />
                        <span className="text-[15px] font-medium text-white">
                          {meta.label}
                        </span>
                      </div>
                      <p className="mt-1.5 text-[13px] tabular-nums text-white/70">
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
                style={{ height: (trophies.length - windowEnd) * TROPHY_ROW_HEIGHT }}
              />
            ) : null}
            </ul>
          )}
        </div>
      </div>

      <footer className="relative z-10 flex shrink-0 items-center gap-8 border-t border-white/15 px-12 py-3 text-xs text-white/65">
        <span className="flex items-center gap-2">
          <img src="/buttons/PS4_Cross.png" alt="" className={HINT_ICON} />
          Détails
        </span>
        <span className="flex items-center gap-2">
          <img src="/buttons/PS4_Circle.png" alt="" className={HINT_ICON} />
          Fermer
        </span>
        <span className="flex items-center gap-1.5">
          <img src="/buttons/PS4_Dpad_Up.png" alt="" className={HINT_ICON} />
          <img src="/buttons/PS4_Dpad_Down.png" alt="" className={HINT_ICON} />
          Parcourir
        </span>
        {focusedHidden ? (
          <span className="flex items-center gap-2">
            <img
              src="/buttons/PS4_Square.png"
              alt=""
              className={HINT_ICON}
            />
            {focusedMasked
              ? "Afficher les informations"
              : "Masquer les informations"}
          </span>
        ) : null}
        <span className="ml-auto truncate text-white/40">{game.title}</span>
      </footer>

      {detailOpen && focused ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/55 px-12 py-10">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Détails du trophée ${displayName(focused)}`}
            className="w-full max-w-[760px] rounded-[2px] border-[3px] border-white bg-[#002868]/95 px-9 py-8 shadow-[0_0_40px_rgba(0,0,0,0.65)]"
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
                  <span className="text-[13px] uppercase tracking-[0.24em] text-white/60">
                    {rankMeta(focused.rank).label}
                  </span>
                </div>

                <h3 className="mt-2 text-[30px] font-medium leading-tight text-white">
                  {focusedMasked ? "Trophée masqué" : displayName(focused)}
                </h3>

                <p className="mt-3 text-[17px] leading-snug text-white/80">
                  {focusedMasked
                    ? "Appuyez sur Carré pour révéler ce trophée."
                    : focused.description.trim()
                      ? focused.description
                      : focused.unlocked
                        ? "Description indisponible"
                        : "Trophée masqué • Verrouillé"}
                </p>

                <div className="mt-5 flex items-center gap-3 text-[14px]">
                  <span className="rounded-[2px] bg-white/15 px-2.5 py-1 text-white/85">
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

            <div className="mt-7 flex items-center gap-7 border-t border-white/15 pt-4 text-[12px] text-white/60">
              <span className="flex items-center gap-2">
                <img src="/buttons/PS4_Circle.png" alt="" className="h-5 w-5 object-contain" />
                Retour
              </span>
              <span className="ml-auto truncate">{game.title}</span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
