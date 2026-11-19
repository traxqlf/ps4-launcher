import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { hasSystemModifier } from "../hooks/useGamepad";
import { playBack, playNav } from "../utils/ps4Audio";
import type { Game } from "../types";

/**
 * Vue « Bibliothèque » plein écran : tous les jeux de la collection, en grille
 * PS4, avec recherche et tri. Elle se pose par-dessus l'accueil, qui reste
 * inerte tant qu'elle est ouverte.
 */

type LibrarySort = "recent" | "alpha" | "playtime";

const SORTS: { id: LibrarySort; label: string }[] = [
  { id: "recent", label: "Récents" },
  { id: "alpha", label: "Alphabétique (A–Z)" },
  { id: "playtime", label: "Temps de jeu" },
];

const HINT_ICON = "h-[1.05rem] w-[1.05rem] shrink-0 object-contain";

// Stick gauche : même zone morte stricte et même anti-répétition que
// TrophyModal et ProfileModal.
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
  // Toujours le premier jeu de la grille affichée, jamais l'index du ruban.
  const [active, setActive] = useState(0);
  const [columns, setColumns] = useState(5);
  const [entered, setEntered] = useState(false);

  const gridRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const tileRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const previousButtons = useRef<Set<number>>(new Set());
  // La validation qui ouvre la vue (Entrée, Croix / A) ne doit pas être relue
  // par la boucle manette ni par le survol pendant le premier rendu.
  const inputLockUntil = useRef(0);

  const items = useMemo(() => {
    const needle = normalize(query.trim());
    const filtered = needle
      ? games.filter((game) => normalize(game.title).includes(needle))
      : [...games];

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
  }, [games, query, sort]);

  // Apparition : un rendu au repos puis la transition d'opacité.
  useEffect(() => {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setEntered(true));
    });
    return () => cancelAnimationFrame(frame);
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

  // Le verrou court à partir du montage réel, pas du début du rendu.
  useLayoutEffect(() => {
    inputLockUntil.current = performance.now() + 120;
  }, []);

  // Ouverture, nouvelle recherche ou nouveau tri : premier résultat et grille
  // ramenée tout en haut.
  useLayoutEffect(() => {
    setActive(0);
    const scroller = scrollRef.current;
    if (scroller) {
      scroller.scrollTop = 0;
      scroller.scrollLeft = 0;
    }
  }, [query, sort]);

  useEffect(() => {
    if (active > items.length - 1) {
      setActive(Math.max(0, items.length - 1));
    }
  }, [active, items.length]);

  // La tuile active reste visible dans la grille défilante.
  useEffect(() => {
    tileRefs.current[active]?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [active, items.length]);

  const activeGame = items[active] ?? null;

  function move(delta: number) {
    if (items.length === 0) return;
    const next = Math.max(0, Math.min(items.length - 1, active + delta));
    if (next === active) return;
    setActive(next);
    playNav();
  }

  function moveRow(delta: number) {
    if (items.length === 0) return;
    const next = Math.max(
      0,
      Math.min(items.length - 1, active + delta * columns),
    );
    if (next === active) return;
    setActive(next);
    playNav();
  }

  function close() {
    playBack();
    onClose();
  }

  function launch(game: Game | null) {
    if (!game) return;
    onLaunch(game);
  }

  // Clavier : flèches / ZQSD / WASD, Entrée, Y (options), Échap (retour).
  useEffect(() => {
    // Options ouvertes par-dessus : le panneau gère lui-même le clavier.
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
      // AZERTY : « a » est aussi la touche Q du ZQSD. La gauche se limite donc
      // à la flèche et à « q » ; le clavier confirme uniquement avec Entrée
      // (le Croix / A de la manette est lu dans la boucle dédiée).
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
      // Un Entrée maintenu depuis l'ouverture ne relance pas le jeu.
      if (confirm && event.repeat) return;

      if (back) {
        close();
        return;
      }
      if (up) {
        moveRow(-1);
        return;
      }
      if (down) {
        moveRow(1);
        return;
      }
      if (left) {
        move(-1);
        return;
      }
      if (right) {
        move(1);
        return;
      }
      if (options) {
        if (activeGame) onOptions(activeGame);
        return;
      }
      launch(activeGame);
    };

    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  });

  // Données lues par la boucle manette : elle ne redémarre pas à chaque
  // déplacement, sinon un bouton maintenu déclencherait une rafale.
  const latest = useRef({ items, active, columns, onLaunch, onOptions, onClose });
  latest.current = { items, active, columns, onLaunch, onOptions, onClose };

  // Manette : D-pad pour la grille (un appui = un déplacement), stick gauche
  // avec répétition lente, L1 / R1 pour sauter une page, Croix lance, Triangle
  // ou Options ouvre les options, Rond revient au ruban.
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

      // Stick analogique gauche : au-delà de la zone morte, il répète toutes
      // les 180 ms ; le D-pad reste un appui unique.
      const stickUp = axisY < -STICK_DEADZONE;
      const stickDown = axisY > STICK_DEADZONE;
      const stickLeft = axisX < -STICK_DEADZONE;
      const stickRight = axisX > STICK_DEADZONE;

      // L1 / R1 : une page complète vers le haut / le bas. Le nombre de
      // rangées visibles est mesuré sur la grille, avec repli sur une rangée.
      const pageRows = () => {
        const grid = gridRef.current;
        const scroller = grid?.parentElement;
        const first = tileRefs.current[0];
        if (!grid || !scroller || !first) return 1;
        const gap = parseFloat(getComputedStyle(grid).rowGap) || 0;
        const rowHeight = first.offsetHeight + gap;
        if (rowHeight <= 0) return 1;
        return Math.max(1, Math.floor(scroller.clientHeight / rowHeight));
      };

      const state = latest.current;
      const step = (next: number) => {
        if (next === state.active) return;
        setActive(next);
        playNav();
      };

      if (state.items.length > 0) {
        const last = state.items.length - 1;
        const rowStep = (delta: number) =>
          step(
            Math.max(0, Math.min(last, state.active + delta * state.columns)),
          );
        const cellStep = (delta: number) =>
          step(Math.max(0, Math.min(last, state.active + delta)));

        if (fresh(4)) rowStep(-pageRows());
        else if (fresh(5)) rowStep(pageRows());
        else if (fresh(12)) rowStep(-1);
        else if (fresh(13)) rowStep(1);
        else if (fresh(14)) cellStep(-1);
        else if (fresh(15)) cellStep(1);
        else if (now - lastNav >= NAV_COOLDOWN_MS) {
          if (stickUp) {
            lastNav = now;
            rowStep(-1);
          } else if (stickDown) {
            lastNav = now;
            rowStep(1);
          } else if (stickLeft) {
            lastNav = now;
            cellStep(-1);
          } else if (stickRight) {
            lastNav = now;
            cellStep(1);
          }
        }

        if (fresh(0)) state.onLaunch(state.items[state.active]);
        else if (fresh(3) || fresh(9))
          state.onOptions(state.items[state.active]);
        else if (fresh(1)) {
          playBack();
          state.onClose();
        }
      } else if (fresh(1)) {
        playBack();
        state.onClose();
      }

      previousButtons.current = pressed;
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [paused, getGamepads]);

  return (
    <div
      className={`fixed inset-0 z-[70] flex flex-col bg-[#020b20]/95 backdrop-blur-md transition-opacity duration-300 ${
        entered ? "opacity-100" : "opacity-0"
      }`}
      role="dialog"
      aria-modal="true"
      aria-label="Bibliothèque des jeux"
    >
      <header className="flex flex-wrap items-center gap-x-8 gap-y-4 border-b border-white/10 px-10 pb-5 pt-8">
        <div>
          <p className="text-[11px] uppercase tracking-[0.4em] text-white/45">
            Collection
          </p>
          <h1 className="text-3xl font-light tracking-wide text-white">
            Bibliothèque
          </h1>
        </div>

        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Rechercher un jeu"
          spellCheck={false}
          autoComplete="off"
          aria-label="Rechercher un jeu"
          className="min-w-[16rem] flex-1 rounded-md border-2 border-white/20 bg-black/35 px-4 py-2.5 text-sm text-white outline-none transition placeholder:text-white/35 focus:border-white/80"
        />

        <div className="flex items-center gap-2" role="group" aria-label="Trier">
          {SORTS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setSort(option.id)}
              aria-pressed={sort === option.id}
              className={`rounded-full border px-4 py-1.5 text-xs font-medium uppercase tracking-widest transition ${
                sort === option.id
                  ? "border-white bg-white text-[#020b20]"
                  : "border-white/25 text-white/65 hover:border-white/70 hover:text-white"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        <span className="ml-auto text-xs text-white/45">
          {items.length} jeu{items.length > 1 ? "x" : ""}
        </span>
      </header>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-10 py-8"
      >
        {items.length === 0 ? (
          <p className="mt-16 text-center text-sm text-white/55">
            Aucun jeu ne correspond à cette recherche.
          </p>
        ) : (
          <div
            ref={gridRef}
            className="grid grid-cols-4 gap-6 xl:grid-cols-5"
            role="list"
          >
            {items.map((game, index) => {
              const isActive = index === active;
              return (
                <button
                  key={game.id}
                  type="button"
                  role="listitem"
                  ref={(element) => {
                    tileRefs.current[index] = element;
                  }}
                  onMouseEnter={() => {
                    if (performance.now() < inputLockUntil.current) return;
                    setActive(index);
                  }}
                  onClick={() => {
                    setActive(index);
                    launch(game);
                  }}
                  aria-current={isActive ? "true" : undefined}
                  aria-label={`${game.title} — ${formatPlaytime(game.playtime_seconds)}`}
                  className={`group flex flex-col gap-2 rounded-lg p-2 text-left outline-none transition duration-200 ${
                    isActive
                      ? "scale-[1.03] bg-white/10 ring-2 ring-white shadow-[0_0_28px_rgba(255,255,255,0.45)]"
                      : "ring-1 ring-transparent hover:bg-white/5"
                  }`}
                >
                  <span className="block aspect-[3/4] w-full overflow-hidden rounded-md bg-white/5">
                    {game.cover_url ? (
                      <img
                        src={game.cover_url}
                        alt=""
                        draggable={false}
                        className="h-full w-full object-cover object-top"
                      />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center text-4xl font-light text-white/45">
                        {game.title.trim().charAt(0).toUpperCase() || "?"}
                      </span>
                    )}
                  </span>
                  <span className="truncate text-sm font-medium text-white">
                    {game.title}
                  </span>
                  <span className="-mt-1 truncate text-[11px] text-white/45">
                    {formatPlaytime(game.playtime_seconds)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <footer className="flex items-center gap-7 border-t border-white/10 px-10 py-4 text-xs text-white/65">
        <span className="flex items-center gap-2">
          <img src="/buttons/PS4_Cross.png" alt="" className={HINT_ICON} />
          Lancer
        </span>
        <span className="flex items-center gap-2">
          <img src="/buttons/PS4_Triangle.png" alt="" className={HINT_ICON} />
          Options
        </span>
        <span className="flex items-center gap-2">
          <img src="/buttons/PS4_Circle.png" alt="" className={HINT_ICON} />
          Retour
        </span>
        {activeGame ? (
          <span className="ml-auto truncate text-white/40">
            {activeGame.title}
          </span>
        ) : null}
      </footer>
    </div>
  );
}
