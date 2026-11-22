import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { AddGameModal } from "./components/AddGameModal";
import { BootScreen } from "./components/BootScreen";
import { Ps4Home } from "./components/Ps4Home";
import { Ps4Notification, notify } from "./components/Ps4Notification";
import { useAudioGate } from "./hooks/useAudioGate";
import { useGamepad } from "./hooks/useGamepad";
import { useInputModeTracking } from "./hooks/useInputMode";
import {
  playBack,
  playDialogYes,
  playError,
  playLoginJingle,
  playNav,
  playNotification,
  resumeBgm,
  startLoginTheme,
} from "./utils/ps4Audio";
import type { Game } from "./types";
import "./App.css";

type BootPhase = "running" | "fading" | "done";

/** Tuile du Store : présente dans le ruban, absente de la liste persistée. */
type PermanentTile = Game & { isPermanent: true; image: string };

// Toujours injectée en index 0 du ruban : ni supprimable, ni déplaçable.
const STORE_TILE: PermanentTile = {
  id: "playstation_store",
  title: "PlayStation Store",
  isPermanent: true,
  image: "/images/psstore_large.png",
  exe_path: "",
  steam_appid: null,
  cover_url: "/images/psstore_large.png",
  bg_url: null,
  last_played: null,
  playtime_seconds: 0,
  launch_options: "",
};

// Verrouillée tout à droite du ruban : ouvre la grille de toute la collection.
const LIBRARY_TILE: PermanentTile = {
  id: "library",
  title: "Bibliothèque",
  isPermanent: true,
  image: "/images/LibraryNew.png",
  exe_path: "",
  steam_appid: null,
  cover_url: "/images/LibraryNew.png",
  bg_url: null,
  last_played: null,
  playtime_seconds: 0,
  launch_options: "",
};

// Comme sur PS4, l'accueil ne montre que les jeux les plus récents.
const RIBBON_LIMIT = 12;

function isPermanentTile(tile: Game | null | undefined): boolean {
  return Boolean(tile && (tile as Partial<PermanentTile>).isPermanent);
}

/**
 * Les 12 jeux du ruban : épinglés d'abord (juste après le Store), puis les
 * plus récents, dans l'ordre d'activité.
 */
function recentGames(games: Game[]): Game[] {
  return [...games]
    .sort((a, b) => {
      const pinned = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
      if (pinned !== 0) return pinned;
      return (
        (b.last_played ?? 0) - (a.last_played ?? 0) ||
        a.title.localeCompare(b.title, "fr", { sensitivity: "base" })
      );
    })
    .slice(0, RIBBON_LIMIT);
}

function App() {
  const [games, setGames] = useState<Game[]>([]);
  // Index 0 = PlayStation Store : le focus de démarrage se pose sur le premier
  // jeu, immédiatement à sa droite.
  const [selectedIndex, setSelectedIndex] = useState(1);
  // Ruban : Store permanent, les 12 jeux les plus récents, Bibliothèque.
  const tiles: Game[] = [STORE_TILE, ...recentGames(games), LIBRARY_TILE];
  const lastTileIndex = tiles.length - 1;
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Verrou synchrone du lancement : `busy` n'est pas encore visible pour un
  // second appel qui arrive dans le même tick (clavier + clic + manette).
  const launchInFlightRef = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bootPhase, setBootPhase] = useState<BootPhase>("running");
  // Modale « Ajouter un jeu » : fichier seul ou dossier scanné.
  const [addOpen, setAddOpen] = useState(false);
  // Verrou audio global : fenêtre au premier plan et hors session de jeu.
  // Il couvre aussi l'écran de boot, monté avant Ps4Home.
  useAudioGate();
  // Bascule manette / souris : un seul jeu d'écouteurs souris pour l'application.
  useInputModeTracking();

  useEffect(() => {
    // Purge d'abord les musiques dont la provenance n'est plus conforme ; les
    // fichiers absents sont oubliés. Aucun accès réseau à cette étape.
    invoke<Game[]>("revalidate_game_themes")
      .catch((cause) => {
        console.warn("[thèmes] revalidation impossible:", cause);
        return invoke<Game[]>("get_games");
      })
      .then(setGames)
      .catch((cause) => setError(String(cause)));
  }, []);

  // Étape 1 : le thème de connexion couvre le chargement, avant l'accueil.
  useEffect(() => {
    startLoginTheme();
  }, []);

  // F11 : bascule plein écran / fenêtré, pratique pour tester le rendu fenêtré.
  useEffect(() => {
    function toggleFullscreen(event: KeyboardEvent) {
      if (event.key !== "F11") return;
      event.preventDefault();
      const appWindow = getCurrentWindow();
      void appWindow
        .isFullscreen()
        .then((fullscreen) => appWindow.setFullscreen(!fullscreen))
        .catch((cause) => console.warn("[plein écran] bascule impossible:", cause));
    }
    window.addEventListener("keydown", toggleFullscreen);
    return () => window.removeEventListener("keydown", toggleFullscreen);
  }, []);

  // Le Store comptant pour une tuile, la dernière position sélectionnable vaut
  // `games.length`. On ne recadre qu'après une suppression, jamais au premier
  // chargement : sinon le focus retomberait sur le Store avant l'arrivée des jeux.
  const previousGameCount = useRef(0);
  useEffect(() => {
    if (previousGameCount.current > 0) {
      // La dernière tuile est la Bibliothèque : elle reste toujours atteignable.
      setSelectedIndex((index) => Math.min(index, lastTileIndex));
    }
    previousGameCount.current = games.length;
  }, [games.length, lastTileIndex]);

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), 6000);
    return () => window.clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    if (bootPhase !== "fading") return;
    const timer = window.setTimeout(() => setBootPhase("done"), 500);
    return () => window.clearTimeout(timer);
  }, [bootPhase]);

  function finishBoot() {
    if (bootPhase !== "running") return;
    // Étape 2 : fondu du thème de chargement puis jingle de connexion. La
    // musique du menu attend la fin du jingle (resumeBgm la diffère).
    playLoginJingle();
    resumeBgm();
    setBootPhase("fading");
  }

  async function loadArtwork(gameId: string) {
    setGames(await invoke<Game[]>("fetch_game_artwork", { gameId }));
  }

  async function browseGame() {
    if (busy) return;
    // Le sélecteur natif prend la main : la modale s'efface le temps du choix.
    setAddOpen(false);
    setBusy(true);
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "Exécutable Windows", extensions: ["exe"] }],
      });
      if (typeof path !== "string") return;

      const knownIds = new Set(games.map((game) => game.id));
      const next = await invoke<Game[]>("add_game", { exePath: path });
      setGames(next);
      setPendingDeleteId(null);

      const addedIndex = next.findIndex((game) => !knownIds.has(game.id));
      if (addedIndex < 0) return;
      // +1 : la tuile du Store occupe la position 0 du ruban. Un nouveau jeu
      // sans activité récente peut ne pas figurer dans les 12 premières cases.
      const ribbonIndex = recentGames(next).findIndex(
        (game) => game.id === next[addedIndex].id,
      );
      if (ribbonIndex >= 0) setSelectedIndex(ribbonIndex + 1);
      notify({
        icon: "game",
        title: "Jeu ajouté",
        subtitle: next[addedIndex].title,
      });

      setBusy(false);
      setRefreshing(true);
      try {
        await loadArtwork(next[addedIndex].id);
      } finally {
        setRefreshing(false);
      }
    } catch (cause) {
      playError();
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  /** Import d'un scan : `add_game` puis le pipeline de visuels déjà en place. */
  async function importScanned(paths: string[]) {
    if (busy || paths.length === 0) return;
    setBusy(true);
    let library = games;
    let imported = 0;
    let artworkMisses = 0;

    try {
      for (const path of paths) {
        const knownIds = new Set(library.map((game) => game.id));
        library = await invoke<Game[]>("add_game", { exePath: path });
        const added = library.find((game) => !knownIds.has(game.id));
        // Chemin déjà en bibliothèque : `add_game` renvoie la liste inchangée.
        if (!added) continue;

        imported += 1;
        setGames(library);
        try {
          library = await invoke<Game[]>("fetch_game_artwork", {
            gameId: added.id,
          });
          setGames(library);
        } catch (cause) {
          artworkMisses += 1;
          console.warn(`[visuels] ${added.title}:`, cause);
        }
      }

      if (imported === 0) {
        setError("Ces jeux sont déjà dans la bibliothèque.");
        return;
      }

      notify({
        icon: "game",
        title: imported > 1 ? `${imported} jeux ajoutés` : "Jeu ajouté",
        subtitle:
          artworkMisses > 0
            ? `${artworkMisses} visuel(s) introuvable(s)`
            : "Bibliothèque mise à jour",
      });
      setAddOpen(false);
    } catch (cause) {
      playError();
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function refreshArtwork() {
    const game = tiles[selectedIndex];
    if (!game || isPermanentTile(game) || busy || refreshing) return;
    setRefreshing(true);
    try {
      await loadArtwork(game.id);
      playNotification();
    } catch (cause) {
      playError();
      setError(String(cause));
    } finally {
      setRefreshing(false);
    }
  }

  /** Lance un jeu précis (ruban ou Bibliothèque) et repose le focus dessus. */
  async function launchGame(gameId: string) {
    if (busy || launchInFlightRef.current) return;
    // Le son de démarrage et la coupure de la musique sont joués par Ps4Home,
    // avec l'écran de démarrage, 1,8 s avant cet appel.
    launchInFlightRef.current = true;
    setBusy(true);
    try {
      setGames(await invoke<Game[]>("launch_game", { id: gameId }));
      // Le back a remonté ce jeu en première position, juste après le Store :
      // au retour du jeu, le focus est déjà posé dessus, comme sur PS4.
      setSelectedIndex(1);
    } catch (cause) {
      playError();
      setError(String(cause));
      resumeBgm();
      // Le splash attend le lancement : une erreur doit le refermer tout de suite.
      throw cause;
    } finally {
      launchInFlightRef.current = false;
      setBusy(false);
    }
  }

  async function launchSelected() {
    const tile = tiles[selectedIndex];
    if (busy || !tile) return;

    // Les tuiles permanentes ne lancent aucun processus : Ps4Home ouvre seul le
    // Store ou la Bibliothèque.
    if (isPermanentTile(tile)) return;

    await launchGame(tile.id);
  }

  async function deleteSelected() {
    if (busy || !pendingDeleteId) return;
    playDialogYes();
    setBusy(true);
    try {
      setGames(await invoke<Game[]>("remove_game", { id: pendingDeleteId }));
      setPendingDeleteId(null);
    } catch (cause) {
      playError();
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  function select(index: number) {
    setSelectedIndex(index);
    setPendingDeleteId(null);
  }

  /** Épingle / désépingle un jeu et garde ce même jeu sélectionné. */
  function toggleGamePin(id: string) {
    const game = games.find((item) => item.id === id);
    if (!game) return;
    void (async () => {
      try {
        const list = await invoke<Game[]>("set_game_pinned", {
          id,
          pinned: !game.pinned,
        });
        setGames(list);
        const ordered = [STORE_TILE, ...recentGames(list), LIBRARY_TILE];
        const index = ordered.findIndex((tile) => tile.id === id);
        if (index >= 0) {
          setSelectedIndex(index);
          setPendingDeleteId(null);
        }
      } catch (cause) {
        playError();
        setError(String(cause));
      }
    })();
  }

  function requestDelete() {
    // Les tuiles permanentes ne figurent jamais dans la liste persistée.
    const game = tiles[selectedIndex];
    if (game && !isPermanentTile(game)) setPendingDeleteId(game.id);
  }

  useGamepad({
    onLeft: () => {
      if (bootPhase !== "done") return;
      if (selectedIndex <= 0) {
        playError();
        return;
      }
      playNav();
      select(selectedIndex - 1);
    },
    onRight: () => {
      if (bootPhase !== "done") return;
      // Dernière tuile = la Bibliothèque, toujours atteignable.
      if (selectedIndex >= lastTileIndex) {
        playError();
        return;
      }
      playNav();
      select(selectedIndex + 1);
    },
    onConfirm: () => {
      if (bootPhase !== "done") {
        finishBoot();
        return;
      }
      // Le ruban et le tiroir valident eux-mêmes leur action : Ps4Home lance
      // via startLaunch pour jouer l'écran de démarrage avant le processus.
    },
    onBack: () => {
      if (bootPhase !== "done") return;
      playBack();
      if (pendingDeleteId) setPendingDeleteId(null);
      else setError(null);
    },
  }, { suspendable: true });

  const selected = tiles[selectedIndex] ?? null;
  const selectedGame = selected && !isPermanentTile(selected) ? selected : null;

  return (
    <>
      <Ps4Notification />
      <AddGameModal
        isOpen={addOpen}
        busy={busy}
        onClose={() => setAddOpen(false)}
        onBrowse={() => void browseGame()}
        onImport={(paths) => void importScanned(paths)}
      />
      {bootPhase !== "running" ? (
        <Ps4Home
          games={tiles}
          selectedIndex={selectedIndex}
          ready={bootPhase === "done"}
          pendingDeleteId={pendingDeleteId}
          busy={busy}
          error={error}
          onSelect={select}
          onAdd={() => {
            if (!busy) setAddOpen(true);
          }}
          onLaunch={launchSelected}
          allGames={games}
          addOpen={addOpen}
          onTogglePin={toggleGamePin}
          onLaunchGame={(gameId) => launchGame(gameId)}
          onRequestDelete={requestDelete}
          onConfirmDelete={deleteSelected}
          onCancelDelete={() => setPendingDeleteId(null)}
        />
      ) : null}
      {bootPhase !== "done" ? (
        <BootScreen fading={bootPhase === "fading"} onSkip={finishBoot} />
      ) : null}
      {selectedGame && bootPhase === "done" ? (
        <button
          type="button"
          onClick={refreshArtwork}
          disabled={refreshing}
          className="fixed bottom-8 left-8 z-30 rounded-full border border-white/20 bg-black/20 px-5 py-2 text-xs font-medium uppercase tracking-widest text-white/60 backdrop-blur transition hover:border-white/60 hover:text-white disabled:opacity-40"
        >
          {refreshing ? "Recherche…" : "Actualiser les images"}
        </button>
      ) : null}
    </>
  );
}

export default App;
