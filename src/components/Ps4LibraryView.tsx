/* Bibliothèque — architecture Orbis OS à deux colonnes (PS4).

   Colonne gauche : catégories PS4. Zone droite : grille de tuiles carrées.
   Un cadre blanc glisse d'une catégorie à une tuile avec le ressort
   critiquement amorti du bandeau de jeux ; la grille défile par translation
   GPU. Aucune boucle ne tourne quand rien ne bouge. */

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  getInputMode,
  hasSystemModifier,
  shouldIgnoreClick,
} from "../hooks/useGamepad";
import { playBack, playNav } from "../utils/ps4Audio";
import type { Game } from "../types";

type LibrarySort = "recent" | "alpha" | "playtime";
type CategoryId = "all" | "installed" | "favorites" | "recent";

const SORTS: { id: LibrarySort; label: string }[] = [
  { id: "recent", label: "Récents" },
  { id: "alpha", label: "Alphabétique (A–Z)" },
  { id: "playtime", label: "Temps de jeu" },
];

const CATEGORIES: { id: CategoryId; label: string }[] = [
  { id: "all", label: "Tout" },
  { id: "installed", label: "Installés" },
  { id: "favorites", label: "Favoris" },
  { id: "recent", label: "Récents" },
];

// Police unique du projet : SST, imposée en inline sur chaque contrôle.
const SST_STYLE = { fontFamily: "'SST', sans-serif" } as const;

// Ouverture, fermeture et défilement : courbe du ruban de jeux.
const ANIM_MS = 320;
const ANIM_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
// Glissement du cadre et des tuiles : inertie douce et nette, sans rebond.
const TILE_EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

/* Cadre de sélection : mêmes constantes de ressort que le bandeau Orbis. */
const FRAME_OMEGA = 15.5;
const FRAME_MAX_DT = 0.032;
const FRAME_START_IMPULSE = 0.35;

// Débord extérieur du cadre autour de la carte complète (jaquette + titre +
// temps de jeu) : il respire sans jamais toucher le texte.
const TILE_FRAME_MARGIN = 10;

const ORBIS_BLUE = "#0070D1";

const HINT_ICON = "h-[1.05rem] w-[1.05rem] shrink-0 object-contain";

// Stick gauche : même zone morte stricte et même anti-répétition que les
// autres fenêtres Orbis.
const STICK_DEADZONE = 0.55;
const NAV_COOLDOWN_MS = 180;

interface Ps4LibraryViewProps {
  games: Game[];
  /** Lecture des manettes : Ps4Home garde l'accès d'origine, jamais masqué ici. */
  getGamepads: (() => (Gamepad | null)[]) | null;
  /** Options de lancement ouvertes ou écran de démarrage : navigation en pause. */
  paused: boolean;
  onClose: () => void;
  onLaunch: (game: Game) => void;
  onOptions: (game: Game) => void;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function formatPlaytime(seconds: number): string {
  if (seconds <= 0) return "Jamais joué";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  return `${(seconds / 3600).toFixed(1).replace(".", ",")} h`;
}

function inCategory(game: Game, category: CategoryId): boolean {
  if (category === "installed") return Boolean(game.exe_path);
  if (category === "favorites") return Boolean(game.pinned);
  if (category === "recent") return game.last_played !== null;
  return true;
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

/** Cadre blanc unique : glisse et s'étire par ressort critiquement amorti. */
function useSlidingFrame() {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const state = useRef<FrameState>({
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
  const raf = useRef(0);

  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    },
    [],
  );

  function place(
    target: HTMLElement | null,
    host: HTMLElement | null,
    margin = 0,
  ) {
    const frame = frameRef.current;
    if (!frame || !target || !host) return;

    // Un ressort encore en vol ne doit jamais repeindre l'ancienne cible
    // après un recalage : on l'arrête avant de mesurer.
    cancelAnimationFrame(raf.current);
    raf.current = 0;

    const targetRect = target.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const goal = {
      x: targetRect.left - hostRect.left - margin,
      y: targetRect.top - hostRect.top - margin,
      w: targetRect.width + margin * 2,
      h: targetRect.height + margin * 2,
    };

    const current = state.current;
    const paint = () => {
      frame.style.transform = `translate3d(${current.x.toFixed(2)}px, ${current.y.toFixed(
        2,
      )}px, 0)`;
      frame.style.width = `${current.w.toFixed(2)}px`;
      frame.style.height = `${current.h.toFixed(2)}px`;
    };

    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    if (!current.placed || reduced) {
      current.x = goal.x;
      current.y = goal.y;
      current.w = goal.w;
      current.h = goal.h;
      current.vx = 0;
      current.vy = 0;
      current.vw = 0;
      current.vh = 0;
      current.placed = true;
      paint();
      return;
    }

    // Même impulsion de départ que la piste du ruban : réactivité immédiate.
    current.vx += (goal.x - current.x) * FRAME_OMEGA * FRAME_START_IMPULSE;
    current.vy += (goal.y - current.y) * FRAME_OMEGA * FRAME_START_IMPULSE;
    current.vw += (goal.w - current.w) * FRAME_OMEGA * FRAME_START_IMPULSE;
    current.vh += (goal.h - current.h) * FRAME_OMEGA * FRAME_START_IMPULSE;

    const step = (
      value: number,
      velocity: number,
      goalValue: number,
      dt: number,
      decay: number,
    ): [number, number] => {
      const displacement = value - goalValue;
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

      [current.x, current.vx] = step(current.x, current.vx, goal.x, dt, decay);
      [current.y, current.vy] = step(current.y, current.vy, goal.y, dt, decay);
      [current.w, current.vw] = step(current.w, current.vw, goal.w, dt, decay);
      [current.h, current.vh] = step(current.h, current.vh, goal.h, dt, decay);
      paint();

      const settled =
        Math.abs(current.x - goal.x) < 0.15 &&
        Math.abs(current.y - goal.y) < 0.15 &&
        Math.abs(current.w - goal.w) < 0.15 &&
        Math.abs(current.h - goal.h) < 0.15 &&
        Math.abs(current.vx) < 0.15 &&
        Math.abs(current.vy) < 0.15 &&
        Math.abs(current.vw) < 0.15 &&
        Math.abs(current.vh) < 0.15;

      if (settled) {
        current.x = goal.x;
        current.y = goal.y;
        current.w = goal.w;
        current.h = goal.h;
        current.vx = 0;
        current.vy = 0;
        current.vw = 0;
        current.vh = 0;
        paint();
        raf.current = 0;
        return;
      }
      raf.current = requestAnimationFrame(tick);
    };

    raf.current = requestAnimationFrame(tick);
  }

  function reset() {
    state.current.placed = false;
    cancelAnimationFrame(raf.current);
    raf.current = 0;
  }

  return { frameRef, place, reset };
}

function Frame({
  frameRef,
  visible,
}: {
  frameRef: RefObject<HTMLDivElement | null>;
  visible: boolean;
}) {
  return (
    <div
      ref={frameRef}
      aria-hidden="true"
      className="pointer-events-none absolute left-0 top-0 z-20 rounded-[2px] border-2 border-white shadow-[0_0_18px_rgba(120,190,255,0.38)]"
      style={{
        width: 0,
        height: 0,
        willChange: "transform",
        opacity: visible ? 1 : 0,
        transition: `opacity ${ANIM_MS}ms ${ANIM_EASE}`,
      }}
    />
  );
}

export function Ps4LibraryView({
  games,
  getGamepads,
  paused,
  onClose,
  onLaunch,
  onOptions,
}: Ps4LibraryViewProps) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<LibrarySort>("recent");
  const [category, setCategory] = useState<CategoryId>("all");
  // 0 = colonne des catégories, 1 = grille des jeux (focus initial).
  const [zone, setZone] = useState<0 | 1>(1);
  const [categoryIndex, setCategoryIndex] = useState(0);
  // Toujours le premier jeu de la grille affichée, jamais l'index du ruban.
  const [active, setActive] = useState(0);
  const [columns, setColumns] = useState(5);
  const [entered, setEntered] = useState(false);
  const [closing, setClosing] = useState(false);
  // Défilement vertical de la grille : translation GPU du rail entier.
  const [offsetY, setOffsetY] = useState(0);

  const gridRef = useRef<HTMLDivElement | null>(null);
  const gridViewportRef = useRef<HTMLDivElement | null>(null);
  const gridRailRef = useRef<HTMLDivElement | null>(null);
  const sideHostRef = useRef<HTMLDivElement | null>(null);
  const tileRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const categoryRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const previousButtons = useRef<Set<number>>(new Set());
  // La validation qui ouvre la vue (Entrée, Croix / A) ne doit pas être relue
  // par la boucle manette ni par le survol pendant le premier rendu.
  const inputLockUntil = useRef(0);

  const sideFrame = useSlidingFrame();
  const gridFrame = useSlidingFrame();

  const counts = useMemo(() => {
    const map: Record<CategoryId, number> = {
      all: games.length,
      installed: 0,
      favorites: 0,
      recent: 0,
    };
    for (const game of games) {
      if (inCategory(game, "installed")) map.installed += 1;
      if (inCategory(game, "favorites")) map.favorites += 1;
      if (inCategory(game, "recent")) map.recent += 1;
    }
    return map;
  }, [games]);

  const items = useMemo(() => {
    const needle = normalize(query.trim());
    const filtered = games.filter(
      (game) =>
        inCategory(game, category) &&
        (!needle || normalize(game.title).includes(needle)),
    );

    if (sort === "alpha") {
      return filtered.sort((a, b) =>
        a.title.localeCompare(b.title, "fr", { sensitivity: "base" }),
      );
    }
    if (sort === "playtime") {
      return filtered.sort(
        (a, b) =>
          b.playtime_seconds - a.playtime_seconds ||
          a.title.localeCompare(b.title, "fr", { sensitivity: "base" }),
      );
    }
    return filtered.sort(
      (a, b) =>
        (b.last_played ?? 0) - (a.last_played ?? 0) ||
        a.title.localeCompare(b.title, "fr", { sensitivity: "base" }),
    );
  }, [games, query, sort, category]);

  const activeGame = items[active] ?? null;

  // Apparition : un rendu au repos puis la transition GPU.
  useEffect(() => {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setEntered(true));
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  // Le verrou court à partir du montage réel, pas du début du rendu.
  useLayoutEffect(() => {
    inputLockUntil.current = performance.now() + 120;
  }, []);

  // Nombre de colonnes réellement affichées (4 ou 5 selon la largeur).
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const measure = () => {
      const template = getComputedStyle(grid).gridTemplateColumns;
      const count = template.split(" ").filter(Boolean).length;
      if (count > 0) setColumns(count);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, []);

  // Nouvelle recherche, catégorie ou tri : premier résultat, grille en haut.
  useLayoutEffect(() => {
    setActive(0);
    setOffsetY(0);
  }, [query, sort, category]);

  useEffect(() => {
    if (active > items.length - 1) {
      setActive(Math.max(0, items.length - 1));
    }
  }, [active, items.length]);

  // Défilement fluide : la tuile active est ramenée vers le centre du cadre.
  useLayoutEffect(() => {
    const viewport = gridViewportRef.current;
    const rail = gridRailRef.current;
    if (!viewport || !rail) return;
    const tile = tileRefs.current[active];
    if (!tile) {
      setOffsetY(0);
      return;
    }
    const desired = tile.offsetTop + tile.offsetHeight / 2 - viewport.clientHeight / 2;
    const max = Math.max(0, rail.offsetHeight - viewport.clientHeight);
    setOffsetY(Math.min(max, Math.max(0, desired)));
  }, [active, items.length, columns]);

  // Cadre de la colonne des catégories.
  useLayoutEffect(() => {
    if (zone !== 0) return;
    sideFrame.place(categoryRefs.current[categoryIndex], sideHostRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zone, categoryIndex, entered]);

  // Cadre de la grille : au-dessus des jaquettes, il englobe toute la carte
  // avec 10 px de débord et suit la tuile active dans le rail translaté.
  useLayoutEffect(() => {
    if (zone !== 1) return;
    gridFrame.place(
      tileRefs.current[active],
      gridRailRef.current,
      TILE_FRAME_MARGIN,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zone, active, items.length, columns, entered]);

  // Les fonctions de navigation sont lues par la boucle manette montée une
  // seule fois : elles passent par des refs, jamais par la fermeture du rendu.
  const zoneRef = useRef<0 | 1>(zone);
  zoneRef.current = zone;
  const categoryIndexRef = useRef(categoryIndex);
  categoryIndexRef.current = categoryIndex;
  const activeRef = useRef(active);
  activeRef.current = active;
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  function applyCategory(next: number) {
    categoryIndexRef.current = next;
    activeRef.current = 0;
    setCategoryIndex(next);
    setCategory(CATEGORIES[next].id);
    setActive(0);
  }

  function selectCategory(index: number) {
    const next = Math.max(0, Math.min(CATEGORIES.length - 1, index));
    if (next !== categoryIndexRef.current) {
      applyCategory(next);
      playNav();
    }
    if (zoneRef.current !== 1) switchZone(1);
  }

  function moveCategory(delta: number) {
    const current = categoryIndexRef.current;
    const next = Math.max(
      0,
      Math.min(CATEGORIES.length - 1, current + delta),
    );
    if (next === current) return;
    applyCategory(next);
    playNav();
  }

  function moveCell(delta: number) {
    const state = latest.current;
    if (state.items.length === 0) return;
    const current = state.active;
    const next = Math.max(0, Math.min(state.items.length - 1, current + delta));
    if (next === current) return;
    activeRef.current = next;
    setActive(next);
    playNav();
  }

  function moveRow(delta: number) {
    const state = latest.current;
    if (state.items.length === 0) return;
    const current = state.active;
    const next = Math.max(
      0,
      Math.min(state.items.length - 1, current + delta * columnsRef.current),
    );
    if (next === current) return;
    activeRef.current = next;
    setActive(next);
    playNav();
  }

  function switchZone(next: 0 | 1) {
    if (next === zoneRef.current) return;
    if (next === 0) {
      sideFrame.reset();
    } else {
      gridFrame.reset();
    }
    zoneRef.current = next;
    setZone(next);
    playNav();
  }

  const closeRef = useRef<() => void>(() => {});
  closeRef.current = () => {
    if (closing) return;
    setClosing(true);
    playBack();
    window.setTimeout(onClose, ANIM_MS);
  };

  // Données lues par la boucle manette : elle ne redémarre pas à chaque
  // déplacement, sinon un bouton maintenu déclencherait une rafale.
  const latest = useRef({
    items,
    active,
    columns,
    zone,
    categoryIndex,
    onLaunch,
    onOptions,
    onClose,
  });
  latest.current = {
    items,
    active,
    columns,
    zone,
    categoryIndex,
    onLaunch,
    onOptions,
    onClose,
  };

  // Clavier : flèches / ZQSD, Entrée, Y / T (options), Échap (retour).
  useEffect(() => {
    if (paused) return;
    const handleKey = (event: KeyboardEvent) => {
      if (hasSystemModifier(event)) return;

      const target = event.target as HTMLElement | null;
      const typing = Boolean(
        target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable),
      );
      if (typing) {
        // La saisie garde ses lettres : seul Échap sort du champ.
        if (event.key === "Escape") {
          event.preventDefault();
          target?.blur();
        }
        return;
      }
      // Touches encore enfoncées à l'ouverture : elles ne doivent pas naviguer.
      if (performance.now() < inputLockUntil.current) return;

      const id = event.key.toLowerCase();
      const up = id === "arrowup" || id === "z" || id === "w";
      const down = id === "arrowdown" || id === "s";
      const left = id === "arrowleft" || id === "q";
      const right = id === "arrowright" || id === "d";
      const confirm = event.key === "Enter";
      const options = id === "y" || id === "t";
      const back = id === "escape" || id === "b" || id === "backspace";

      if (!up && !down && !left && !right && !confirm && !options && !back) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (confirm && event.repeat) return;

      if (back) {
        closeRef.current();
        return;
      }
      if (up) {
        if (zone === 0) moveCategory(-1);
        else moveRow(-1);
        return;
      }
      if (down) {
        if (zone === 0) moveCategory(1);
        else moveRow(1);
        return;
      }
      if (left) {
        if (zone === 1 && active % columns === 0) switchZone(0);
        else if (zone === 1) moveCell(-1);
        return;
      }
      if (right) {
        if (zone === 0) switchZone(1);
        else moveCell(1);
        return;
      }
      if (options) {
        if (activeGame) onOptions(activeGame);
        return;
      }
      if (zone === 0) {
        switchZone(1);
        return;
      }
      if (activeGame) onLaunch(activeGame);
    };

    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  });

  // Manette : D-pad / stick pour naviguer, L1 / R1 pour changer de colonne,
  // Croix lance, Triangle ou Options ouvre les options, Rond revient.
  useEffect(() => {
    if (paused) return;
    let frame = 0;
    let lastNav = 0;

    const tick = (now: number) => {
      const pressed = new Set<number>();
      let axisX = 0;
      let axisY = 0;

      for (const pad of getGamepads?.() ?? []) {
        if (!pad?.connected) continue;
        pad.buttons.forEach((button, index) => {
          if (button.pressed) pressed.add(index);
        });
        const x = pad.axes[0] ?? 0;
        const y = pad.axes[1] ?? 0;
        if (Math.abs(x) > Math.abs(axisX)) axisX = x;
        if (Math.abs(y) > Math.abs(axisY)) axisY = y;
      }

      // Le bouton qui a ouvert la bibliothèque est encore enfoncé : on le
      // mémorise sans agir, puis la vue reprend la navigation normalement.
      if (now < inputLockUntil.current) {
        previousButtons.current = pressed;
        frame = requestAnimationFrame(tick);
        return;
      }

      const fresh = (button: number) =>
        pressed.has(button) && !previousButtons.current.has(button);

      const stickUp = axisY < -STICK_DEADZONE;
      const stickDown = axisY > STICK_DEADZONE;
      const stickLeft = axisX < -STICK_DEADZONE;
      const stickRight = axisX > STICK_DEADZONE;

      const state = latest.current;

      // Colonne active : catégories à gauche, grille à droite.
      if (fresh(4)) switchZone(0);
      else if (fresh(5)) switchZone(1);

      if (state.zone === 0) {
        if (fresh(12)) moveCategory(-1);
        else if (fresh(13)) moveCategory(1);
        else if (fresh(14)) switchZone(1);
        else if (now - lastNav >= NAV_COOLDOWN_MS) {
          if (stickUp) {
            lastNav = now;
            moveCategory(-1);
          } else if (stickDown) {
            lastNav = now;
            moveCategory(1);
          } else if (stickRight) {
            lastNav = now;
            switchZone(1);
          }
        }
      } else {
        if (fresh(12)) moveRow(-1);
        else if (fresh(13)) moveRow(1);
        else if (fresh(14)) {
          if (state.active % state.columns === 0) switchZone(0);
          else moveCell(-1);
        } else if (fresh(15)) moveCell(1);
        else if (now - lastNav >= NAV_COOLDOWN_MS) {
          if (stickUp) {
            lastNav = now;
            moveRow(-1);
          } else if (stickDown) {
            lastNav = now;
            moveRow(1);
          } else if (stickLeft) {
            lastNav = now;
            if (state.active % state.columns === 0) switchZone(0);
            else moveCell(-1);
          } else if (stickRight) {
            lastNav = now;
            moveCell(1);
          }
        }
      }

      if (fresh(0)) {
        if (state.zone === 0) switchZone(1);
        else if (state.items[state.active]) state.onLaunch(state.items[state.active]);
      } else if (fresh(3) || fresh(9)) {
        if (state.items[state.active]) state.onOptions(state.items[state.active]);
      } else if (fresh(1)) {
        closeRef.current();
      }

      previousButtons.current = pressed;
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, getGamepads]);

  return (
    <div
      className="fixed inset-0 z-[70] flex flex-col overflow-hidden text-white"
      role="dialog"
      aria-modal="true"
      aria-label="Bibliothèque des jeux"
      style={{
        ...SST_STYLE,
        background:
          "linear-gradient(180deg, #003791 0%, #00439C 42%, #021029 100%)",
        opacity: entered && !closing ? 1 : 0,
        transform:
          entered && !closing
            ? "translate3d(0, 0, 0)"
            : "translate3d(0, 20px, 0)",
        transitionProperty: "opacity, transform",
        transitionDuration: `${ANIM_MS}ms`,
        transitionTimingFunction: ANIM_EASE,
      }}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-3 px-9 pb-4 pt-6">
        <h1
          className="text-[28px] leading-none tracking-wide text-white"
          style={{ ...SST_STYLE, fontWeight: 700 }}
        >
          Bibliothèque
        </h1>

        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Rechercher un jeu"
          spellCheck={false}
          autoComplete="off"
          aria-label="Rechercher un jeu"
          style={{ ...SST_STYLE, fontWeight: 600 }}
          className="min-w-[15rem] max-w-[22rem] flex-1 rounded-[2px] border border-white/25 bg-[rgba(2,16,41,0.42)] px-4 py-2 text-[14px] text-white outline-none transition-colors duration-150 placeholder:text-white/35 focus:border-white"
        />

        <div
          className="flex items-stretch gap-[2px] rounded-[2px] border border-white/25 bg-[rgba(2,16,41,0.42)] p-[2px]"
          role="group"
          aria-label="Trier"
        >
          {SORTS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={(event) => {
                if (shouldIgnoreClick(event)) return;
                setSort(option.id);
              }}
              aria-pressed={sort === option.id}
              style={{
                ...SST_STYLE,
                fontWeight: 600,
                backgroundColor: sort === option.id ? ORBIS_BLUE : "transparent",
                boxShadow:
                  sort === option.id
                    ? "inset 0 0 0 1px rgba(120,190,255,0.55)"
                    : "none",
              }}
              className={`rounded-[2px] px-3 py-1.5 text-[12px] transition-colors duration-150 ${
                sort === option.id
                  ? "text-white"
                  : "text-white/60 hover:bg-white/10 hover:text-white/90"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        <span
          className="ml-auto text-[14px] text-white/70"
          style={{ ...SST_STYLE, fontWeight: 700 }}
        >
          {items.length} jeu{items.length > 1 ? "x" : ""}
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Colonne des catégories PS4 */}
        <aside className="flex w-[260px] shrink-0 flex-col px-5 pb-4">
          <p
            className="mb-2 px-3 text-[10px] uppercase tracking-[0.26em] text-white/45"
            style={{ ...SST_STYLE, fontWeight: 600 }}
          >
            Catégories
          </p>
          <div ref={sideHostRef} className="relative">
            <Frame frameRef={sideFrame.frameRef} visible={zone === 0} />
            {CATEGORIES.map((entry, index) => {
              const isActive = entry.id === category;
              return (
                <button
                  key={entry.id}
                  type="button"
                  ref={(node) => {
                    categoryRefs.current[index] = node;
                  }}
                  onClick={(event) => {
                    if (shouldIgnoreClick(event)) return;
                    selectCategory(index);
                    setZone(1);
                  }}
                  aria-current={isActive ? "true" : undefined}
                  style={{
                    ...SST_STYLE,
                    fontWeight: isActive ? 700 : 600,
                  }}
                  className={`relative z-10 flex w-full items-center justify-between gap-3 border-t border-white/[0.15] px-3 py-3 text-left text-[15px] transition-colors duration-150 first:border-t-0 ${
                    isActive ? "text-white" : "text-white/60 hover:text-white"
                  }`}
                >
                  <span>{entry.label}</span>
                  <span
                    className="text-[12px] text-white/45"
                    style={{ ...SST_STYLE, fontWeight: 600 }}
                  >
                    {counts[entry.id]}
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        <div aria-hidden="true" className="my-4 w-px shrink-0 bg-white/[0.15]" />

        {/* Grille de tuiles carrées */}
        <div
          ref={gridViewportRef}
          className="relative min-h-0 flex-1 overflow-hidden px-8 py-4"
        >
          <div
            ref={gridRailRef}
            className="relative will-change-transform"
            style={{
              transform: `translate3d(0, -${offsetY}px, 0)`,
              transition: `transform ${ANIM_MS}ms ${TILE_EASE}`,
            }}
          >
            <Frame frameRef={gridFrame.frameRef} visible={zone === 1} />
            {items.length === 0 ? (
              <p
                className="mt-16 text-center text-[14px] text-white/55"
                style={{ ...SST_STYLE, fontWeight: 600 }}
              >
                Aucun jeu ne correspond à cette recherche.
              </p>
            ) : (
              <div
                ref={gridRef}
                className="relative z-10 grid grid-cols-4 gap-x-6 gap-y-7 xl:grid-cols-5"
                role="list"
              >
                {items.map((game, index) => {
                  const isActive = index === active && zone === 1;
                  return (
                    <button
                      key={game.id}
                      type="button"
                      role="listitem"
                      ref={(node) => {
                        tileRefs.current[index] = node;
                      }}
                      onMouseEnter={() => {
                        if (getInputMode() !== "mouse") return;
                        if (performance.now() < inputLockUntil.current) return;
                        zoneRef.current = 1;
                        setZone(1);
                        setActive(index);
                      }}
                      onClick={(event) => {
                        if (shouldIgnoreClick(event)) return;
                        zoneRef.current = 1;
                        setZone(1);
                        setActive(index);
                        onLaunch(game);
                      }}
                      aria-current={isActive ? "true" : undefined}
                      aria-label={`${game.title} — ${formatPlaytime(game.playtime_seconds)}`}
                      className="group flex flex-col gap-2 text-left outline-none"
                      style={{
                        transform: isActive ? "scale(1.03)" : "scale(1)",
                        transformOrigin: "center center",
                        transition: `transform ${ANIM_MS}ms ${TILE_EASE}`,
                      }}
                    >
                      <span
                        className={`block aspect-square w-full overflow-hidden rounded-[2px] border bg-white/5 transition-colors duration-150 ${
                          isActive ? "border-transparent" : "border-white/25"
                        }`}
                      >
                        {game.cover_url ? (
                          <img
                            src={game.cover_url}
                            alt=""
                            draggable={false}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <span
                            className="flex h-full w-full items-center justify-center text-3xl text-white/40"
                            style={{ ...SST_STYLE, fontWeight: 700 }}
                          >
                            {game.title.trim().charAt(0).toUpperCase() || "?"}
                          </span>
                        )}
                      </span>
                      <span
                        className="truncate text-[15px] text-white"
                        style={{ ...SST_STYLE, fontWeight: 700 }}
                      >
                        {game.title}
                      </span>
                      <span
                        className="-mt-1 truncate text-[12px] text-white/60"
                        style={{ ...SST_STYLE, fontWeight: 600 }}
                      >
                        {formatPlaytime(game.playtime_seconds)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center gap-x-7 gap-y-2 border-t border-white/[0.15] px-9 py-3 text-[13px] text-white/70">
        <span className="flex items-center gap-2">
          <img src="/buttons/PS4_Cross.png" alt="" className={HINT_ICON} />
          <span style={{ ...SST_STYLE, fontWeight: 600 }}>
            {zone === 0 ? "Choisir" : "Lancer"}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <img src="/buttons/PS4_Triangle.png" alt="" className={HINT_ICON} />
          <span style={{ ...SST_STYLE, fontWeight: 600 }}>Options</span>
        </span>
        <span className="flex items-center gap-2">
          <img src="/buttons/PS4_Circle.png" alt="" className={HINT_ICON} />
          <span style={{ ...SST_STYLE, fontWeight: 600 }}>Retour</span>
        </span>
        <span className="flex items-center gap-2">
          <img src="/buttons/PS4_Dpad.png" alt="" className={HINT_ICON} />
          <span style={{ ...SST_STYLE, fontWeight: 600 }}>Parcourir</span>
        </span>
        <span className="flex items-center gap-1.5">
          <img src="/buttons/PS4_L1.png" alt="" className={HINT_ICON} />
          <img src="/buttons/PS4_R1.png" alt="" className={HINT_ICON} />
          <span style={{ ...SST_STYLE, fontWeight: 600 }}>
            Catégories / Jeux
          </span>
        </span>
        {activeGame ? (
          <span
            className="ml-auto truncate text-white/40"
            style={{ ...SST_STYLE, fontWeight: 600 }}
          >
            {activeGame.title}
          </span>
        ) : null}
      </footer>
    </div>
  );
}
