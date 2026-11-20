import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { avatarSrc } from "../utils/avatar";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { TrophyModal, type TrophyReport } from "./TrophyModal";
import { ProfileModal } from "./ProfileModal";
import { notify } from "./Ps4Notification";
import { Ps4Clock } from "./Ps4Clock";
import { Ps4LibraryView } from "./Ps4LibraryView";
import { Ps4FlowBackground } from "./Ps4FlowBackground";
import { Ps4SplashScreen } from "./Ps4SplashScreen";
import {
  hasSystemModifier,
  isMenuKey,
  isTypingTarget,
  setGlobalGamepadLock,
  useGamepad,
} from "../hooks/useGamepad";
import {
  applyEqPreset,
  EQ_PRESETS,
  getAudioSettings,
  isBgmMuted,
  pauseBgm,
  playBack,
  playConfirm,
  playDialogYes,
  playEnterMenu,
  playError,
  playGameStart,
  playNav,
  playNegative,
  playNotification,
  playSystemMessage,
  playThemeMusic,
  playTrophy,
  resumeAudioEngine,
  resumeBgm,
  stopThemeMusic,
  suspendAudioEngine,
  toggleMuteBgm,
  updateAudioSettings,
  type AudioSettings,
} from "../utils/ps4Audio";
import type { Game, UserProfile } from "../types";
import "../index.css";

interface Ps4HomeProps {
  games: Game[];
  /** Collection complète (la vue Bibliothèque dépasse les 12 tuiles du ruban). */
  allGames: Game[];
  /** Modale « Ajouter un jeu » : elle est rendue par App, au-dessus du ruban. */
  addOpen: boolean;
  /** Faux pendant les 500 ms de fondu du boot : aucune entrée n'est encore lue. */
  ready: boolean;
  selectedIndex: number;
  pendingDeleteId: string | null;
  busy: boolean;
  error: string | null;
  onSelect: (index: number) => void;
  onAdd: () => void;
  /** Épingle / désépingle un jeu en tête du ruban. */
  onTogglePin: (gameId: string) => void;
  onLaunch: () => void;
  onLaunchGame: (gameId: string) => void;
  onRequestDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}

type HomeLevel = "ribbon" | "system" | "info";

// Éléments interactifs du tiroir, disposés comme à l'écran : « Démarrer » sous
// la jaquette à gauche, la colonne des cartes à droite, puis la rangée du bas.
type DrawerFocus =
  | "start"
  | "trophies"
  | "launch_options"
  | "refresh_art"
  | "pin_game"
  | "remove_game";

// Index 0 du tiroir : la carte Trophées, tout en haut de la colonne de droite.
// C'est toujours là que le curseur repart à l'ouverture.
const DRAWER_TOP: DrawerFocus = "trophies";

// Tuiles permanentes injectées par App : ce ne sont pas des jeux.
const STORE_ID = "playstation_store";
const LIBRARY_ID = "library";

// Seule fonction de la tuile permanente : ouvrir ce site dans le navigateur
// par défaut du système. Aucun processus de jeu n'est lancé.
const PS_STORE_URL = "https://steamrip.com";

/**
 * Tuile verrouillée (Store, Bibliothèque) : pas de suppression, pas de
 * trophées, pas d'options de lancement ni de jaquette à actualiser.
 */
function isPermanentTile(game: Game | null | undefined): boolean {
  if (!game) return false;
  return (
    (game as Game & { isPermanent?: boolean }).isPermanent === true ||
    game.id === STORE_ID ||
    game.id === LIBRARY_ID
  );
}

function isStoreGame(game: Game | null | undefined): boolean {
  return game?.id === STORE_ID;
}

function isLibraryGame(game: Game | null | undefined): boolean {
  return game?.id === LIBRARY_ID;
}

const TROPHY_COUNTS = [
  { key: "platinum", label: "Platine", icon: "/trophies/platinum.png" },
  { key: "gold", label: "Or", icon: "/trophies/gold.png" },
  { key: "silver", label: "Argent", icon: "/trophies/silver.png" },
  { key: "bronze", label: "Bronze", icon: "/trophies/bronze.png" },
] as const;

// Ruban : on conserve les dimensions d'origine (200 u de base, tuile phare à
// 330 u). Les transforms reproduisent cette mise en page sans jamais modifier
// le layout Flexbox.
const TILE_SIZE = 200;
const ACTIVE_TILE_SIZE = 330;
const ACTIVE_SCALE = ACTIVE_TILE_SIZE / TILE_SIZE;
const PREVIOUS_OPACITY = 0.72;
const NEIGHBOUR_PUSH = ACTIVE_TILE_SIZE - TILE_SIZE;
const SPRING_OMEGA = 15.5;
const MAX_FRAME_DT = 0.032;
// Impulsion initiale : la piste démarre avec la réactivité de la console au
// lieu d'attendre que le ressort accélère depuis l'arrêt.
const START_IMPULSE = 0.35;
// Durée de l'écran de démarrage avant de lancer réellement l'exécutable.
const SPLASH_MS = 1800;

const du = (value: number) => `calc(${value} * var(--u))`;

// Tuiles permanentes : leurs visuels doivent être prêts avant le premier
// survol, sans attendre que les jeux soient chargés.
const PERMANENT_TILE_IMAGES = ["/images/psstore_large.png", "/images/LibraryNew.png"];

// Les fonds 4K et les jaquettes sont décodés une fois en arrière-plan : le
// changement de sélection ne bloque plus le thread principal au moment
// d'afficher la nouvelle image.
const preloadedImageUrls = new Set<string>();
const preloadedImages: HTMLImageElement[] = [];

function preloadImage(url: string | null | undefined) {
  if (!url || preloadedImageUrls.has(url)) return;
  preloadedImageUrls.add(url);
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  preloadedImages.push(image);
  const decoded = image.decode?.();
  decoded?.catch(() => {
    preloadedImageUrls.delete(url);
    const index = preloadedImages.indexOf(image);
    if (index >= 0) preloadedImages.splice(index, 1);
  });
}

for (const url of PERMANENT_TILE_IMAGES) preloadImage(url);

interface TileMotion {
  scale: number;
  scaleVelocity: number;
  offsetX: number;
  offsetXVelocity: number;
  opacity: number;
  opacityVelocity: number;
}

// Icônes officielles des boutons PS4, alignées sur la taille du pied de page.
const HINT_ICON =
  "h-[calc(38*var(--u))] w-[calc(38*var(--u))] shrink-0 object-contain";

// Barre de fonctions : le focus est un cadre blanc unique, sans fond permanent.
// Trophées, Ajouter un jeu, Profil, Audio, Alimentation.
const HEADER_COUNT = 5;
// Panneau de mixage : Muet, Volume musique, Volume bruits, Normalisation,
// Préréglage, Basses, Médiums, Aigus.
const AUDIO_ROW_COUNT = 8;
const HEADER_TRANSITION =
  "color 200ms ease, opacity 200ms ease, border-color 200ms ease, background-color 200ms ease, box-shadow 200ms ease, transform 200ms ease, filter 200ms ease";

// Police officielle PS4 : appliquée en inline dans la modale audio en plus de
// la règle globale, pour qu'aucun contrôle n'hérite d'une autre famille.
const SST_STYLE = { fontFamily: "'SST', sans-serif" } as const;

// Curseur PS4 : liseré blanc lumineux sur l'élément actif du tiroir. Les
// préfixes « ! » priment sur les bordures/fonds définis dans index.css.
const DRAWER_FOCUS_STYLE =
  "!border-[3px] !border-white !bg-white/10 shadow-[0_0_22px_rgba(255,255,255,0.55)]";

// Grades PS4 : mêmes visuels que l'écran Trophées pour la notification.
const TROPHY_GRADES: Record<string, { label: string; icon: string }> = {
  bronze: { label: "Bronze", icon: "/trophies/bronze.png" },
  argent: { label: "Argent", icon: "/trophies/silver.png" },
  or: { label: "Or", icon: "/trophies/gold.png" },
  platinum: { label: "Platine", icon: "/trophies/platinum.png" },
  platine: { label: "Platine", icon: "/trophies/platinum.png" },
};

interface TrophyToast {
  id: string;
  name: string;
  rank: string;
  icon: string;
}

/** Émis par le back à la fermeture réelle du jeu, durée réelle incluse. */
interface GameSessionEnded {
  gameId: string;
  durationSeconds: number;
  /** Code de sortie du processus lancé, absent s'il a été tué par un signal. */
  exitCode?: number | null;
  /** Session très courte terminée avec un code non nul. */
  crashed?: boolean;
}

function formatPlaytime(seconds: number): string {
  if (seconds <= 0) return "Jamais joué";
  if (seconds < 3600) {
    const minutes = Math.max(1, Math.round(seconds / 60));
    return `${minutes} min jouées`;
  }
  return `${(seconds / 3600).toFixed(1).replace(".", ",")} h jouées`;
}

/** Curseur horizontal style Centre de contrôle : clic, glisser, pas de 5 %. */
function GlassSlider({
  value,
  onChange,
  onFocus,
  label,
}: {
  value: number;
  onChange: (value: number) => void;
  onFocus: () => void;
  label: string;
}) {
  const apply = (clientX: number, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    onChange(Math.round((ratio * 100) / 5) * 5);
  };

  return (
    <div
      role="slider"
      tabIndex={-1}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      style={SST_STYLE}
      onPointerDown={(event) => {
        onFocus();
        event.currentTarget.setPointerCapture(event.pointerId);
        apply(event.clientX, event.currentTarget);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          apply(event.clientX, event.currentTarget);
        }
      }}
      className="relative h-5 flex-1 cursor-pointer touch-none overflow-hidden rounded-full border border-sky-300/15 bg-[#031338]/80 shadow-[inset_0_1px_2px_rgba(0,0,0,0.35)] outline-none"
    >
      <div
        className="h-full rounded-full bg-gradient-to-r from-[#0072ce] via-[#00a2ff] to-white shadow-[0_0_12px_rgba(0,162,255,0.55)] transition-[width] duration-150 ease-out"
        style={{ width: `${value}%` }}
      />
    </div>
  );
}

/** Fader vertical -12…+12 dB : remplissage depuis le centre, graduation fine. */
function GlassFader({
  value,
  onChange,
  onFocus,
  active,
  label,
}: {
  value: number;
  onChange: (value: number) => void;
  onFocus: () => void;
  active: boolean;
  label: string;
}) {
  const ratio = Math.min(1, Math.abs(value) / 12);

  const apply = (clientY: number, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    if (rect.height <= 0) return;
    const ratioY = Math.min(
      1,
      Math.max(0, 1 - (clientY - rect.top) / rect.height),
    );
    onChange(Math.round(ratioY * 24 - 12));
  };

  return (
    <div
      role="slider"
      tabIndex={-1}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={-12}
      aria-valuemax={12}
      aria-valuenow={value}
      style={SST_STYLE}
      onPointerDown={(event) => {
        onFocus();
        event.currentTarget.setPointerCapture(event.pointerId);
        apply(event.clientY, event.currentTarget);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          apply(event.clientY, event.currentTarget);
        }
      }}
      className={`relative mx-auto h-24 w-10 cursor-pointer touch-none rounded-xl outline-none transition-all duration-200 ease-out ${
        active
          ? "bg-sky-400/[0.08] shadow-[0_0_0_1px_rgba(125,211,252,0.45),0_0_18px_rgba(0,114,206,0.45)]"
          : "hover:bg-sky-300/[0.06]"
      }`}
    >
      <span
        aria-hidden="true"
        style={SST_STYLE}
        className="absolute right-0.5 top-1/2 -translate-y-1/2 text-[8px] leading-none text-sky-200/35"
      >
        0
      </span>
      <div className="absolute inset-y-1.5 left-1/2 w-2 -translate-x-1/2">
        <div className="absolute inset-0 rounded-full border border-sky-300/10 bg-[#031338]/80 shadow-[inset_0_1px_2px_rgba(0,0,0,0.35)]" />
        {[0, 25, 50, 75, 100].map((top) => (
          <span
            key={top}
            aria-hidden="true"
            className={`absolute left-1/2 h-px -translate-x-1/2 ${
              top === 50 ? "w-3 bg-sky-200/50" : "w-1 bg-sky-200/20"
            }`}
            style={{ top: `${top}%` }}
          />
        ))}
        <div
          className="absolute left-0 w-full rounded-full bg-gradient-to-t from-[#0072ce] via-[#00a2ff] to-white shadow-[0_0_12px_rgba(0,162,255,0.55)]"
          style={
            value >= 0
              ? { bottom: "50%", height: `${ratio * 50}%` }
              : { top: "50%", height: `${ratio * 50}%` }
          }
        />
        <span
          aria-hidden="true"
          className="absolute left-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-sky-100/80 bg-gradient-to-b from-white to-sky-100 shadow-[0_1px_4px_rgba(0,12,36,0.5),0_0_8px_rgba(0,162,255,0.4)]"
          style={{ top: `${50 - (value / 12) * 50}%` }}
        />
      </div>
    </div>
  );
}

/** Icône batterie PS4 : coque et trois barres, affichée dès qu'une manette répond. */
function ControllerBattery({ level }: { level: number }) {
  const bars = level >= 75 ? 3 : level >= 40 ? 2 : level >= 15 ? 1 : 0;
  return (
    <span
      role="img"
      aria-label={`Batterie de la manette : ${level} %`}
      title={`Manette : ${level} %`}
      className="flex items-center"
    >
      <span className="relative flex h-[calc(22*var(--u))] w-[calc(46*var(--u))] items-center gap-[calc(3*var(--u))] rounded-[calc(3*var(--u))] border border-white/60 px-[calc(3*var(--u))]">
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className={`h-[calc(10*var(--u))] flex-1 rounded-[1px] ${
              index < bars ? "bg-white" : "bg-white/20"
            }`}
          />
        ))}
        <span className="absolute -right-[calc(5*var(--u))] h-[calc(8*var(--u))] w-[calc(3*var(--u))] rounded-r-[1px] bg-white/60" />
      </span>
    </span>
  );
}

export function Ps4Home({
  games,
  allGames,
  addOpen,
  ready,
  selectedIndex,
  pendingDeleteId,
  busy,
  error,
  onSelect,
  onAdd,
  onTogglePin,
  onLaunch,
  onLaunchGame,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
}: Ps4HomeProps) {
  const [level, setLevel] = useState<HomeLevel>("ribbon");
  const [trophiesOpen, setTrophiesOpen] = useState(false);
  const [liveGames, setLiveGames] = useState<Record<string, Game>>({});
  const [reports, setReports] = useState<Record<string, TrophyReport>>({});
  const [refreshingArtwork, setRefreshingArtwork] = useState(false);
  const [trophyQueue, setTrophyQueue] = useState<TrophyToast[]>([]);
  const [trophyToast, setTrophyToast] = useState<TrophyToast | null>(null);
  const [toastVisible, setToastVisible] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  // Jeu en cours de démarrage : l'écran plein écran reste affiché jusqu'à la
  // minimisation du launcher (ou le retour au launcher en fin de session).
  const [launchingGame, setLaunchingGame] = useState<Game | null>(null);
  const [bgmMuted, setBgmMuted] = useState(isBgmMuted);
  // Pourcentage de batterie de la manette (None hors Windows / sans manette).
  const [batteryLevel, setBatteryLevel] = useState<number | null>(null);
  const [regeneratingTheme, setRegeneratingTheme] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  // Panneau « Paramètres audio et égaliseur » ouvert depuis le haut-parleur.
  const [audioOpen, setAudioOpen] = useState(false);
  const [audioIndex, setAudioIndex] = useState(0);
  const [audioSettings, setAudioSettingsState] =
    useState<AudioSettings>(getAudioSettings);
  const audioIndexRef = useRef(0);
  audioIndexRef.current = audioIndex;
  // Jeu concerné par les options : celui du ruban, ou une tuile de la grille.
  const [optionsGame, setOptionsGame] = useState<Game | null>(null);
  // Vue Bibliothèque plein écran, ouverte depuis sa tuile permanente.
  const [libraryOpen, setLibraryOpen] = useState(false);
  // Le launcher minimisé pour un jeu ne doit pas animer le fond en arrière-plan.
  const [appHidden, setAppHidden] = useState(() => document.hidden);
  const [optionsDraft, setOptionsDraft] = useState("");
  const [optionsCursor, setOptionsCursor] = useState(0);
  const [savingOptions, setSavingOptions] = useState(false);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  // Horodatage de la dernière copie : affiche « Copié ✓ » pendant 2 s.
  const [copiedAt, setCopiedAt] = useState<number | null>(null);
  const [drawerFocus, setDrawerFocus] = useState<DrawerFocus>("trophies");
  const drawerFocusRef = useRef<DrawerFocus>(drawerFocus);
  drawerFocusRef.current = drawerFocus;
  const lastDrawerNav = useRef(0);
  const drawerKeyDownRef = useRef<(event: KeyboardEvent) => void>(() => {});
  // Barre de fonctions : 0 Trophées, 1 Ajouter un jeu, 2 Profil, 3 Audio,
  // 4 Alimentation.
  const [headerIndex, setHeaderIndex] = useState(0);
  const headerIndexRef = useRef(0);
  headerIndexRef.current = headerIndex;
  const lastHeaderNav = useRef(0);
  const headerKeyDownRef = useRef<(event: KeyboardEvent) => void>(() => {});
  // Maintient les manettes masquées après fermeture, le temps que Croix soit relâché.
  const [padsGuard, setPadsGuard] = useState(false);
  // Une modale refermée (Trophées, Profil) ne doit pas rejouer l'appui qui l'a
  // fermée : l'accueil reste verrouillé jusqu'au relâchement de Croix / Rond.
  const [modalGuard, setModalGuard] = useState(false);
  // Bandeau « Démarrer » replié puis déployé sous la jaquette active.
  const [startDeployed, setStartDeployed] = useState(false);
  // Une validation clavier peut aussi activer le bouton qui a le focus : on
  // n'ouvre qu'une seule fenêtre par appui.
  const lastStoreOpen = useRef(0);

  // Mise à jour du logiciel système : détection unique au démarrage, puis
  // bandeau PS4 cliquable en haut à gauche.
  const [systemUpdate, setSystemUpdate] = useState<Update | null>(null);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const updateCheckStarted = useRef(false);

  useEffect(() => {
    // Production uniquement : en dev, la vérification interrogerait la release
    // publiée alors que le binaire local n'est pas signé.
    if (import.meta.env.DEV || updateCheckStarted.current) return;
    updateCheckStarted.current = true;
    let cancelled = false;

    const lookForUpdate = async () => {
      try {
        const found = await check();
        if (cancelled || !found) return;
        setSystemUpdate(found);
        playSystemMessage();
      } catch (caught) {
        console.error("[mise à jour] vérification impossible:", caught);
      }
    };

    void lookForUpdate();
    return () => {
      cancelled = true;
    };
  }, []);

  // Clic sur le bandeau : téléchargement, installation, puis redémarrage du
  // launcher. En cas d'échec le bandeau reste affiché pour réessayer.
  const installSystemUpdate = async () => {
    if (!systemUpdate || installingUpdate) return;
    setInstallingUpdate(true);
    setUpdateError(null);
    playDialogYes();
    try {
      await systemUpdate.downloadAndInstall();
      await relaunch();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      console.error("[mise à jour] installation impossible:", caught);
      setInstallingUpdate(false);
      setUpdateError(message);
      playError();
    }
  };

  // Moteur du ruban : les refs DOM et l'état physique restent hors de React,
  // seule la sélection change d'un rendu à l'autre.
  const ribbonRef = useRef<HTMLDivElement | null>(null);
  const tileRefs = useRef<(HTMLElement | null)[]>([]);
  const activeIndexRef = useRef(0);
  const motion = useRef({
    x: 0,
    velocity: 0,
    tiles: [] as TileMotion[],
  });

  const infoScrollRef = useRef<HTMLDivElement | null>(null);
  const optionsInputRef = useRef<HTMLInputElement | null>(null);
  const optionsPathRef = useRef<HTMLInputElement | null>(null);
  const optionsCopyRef = useRef<HTMLButtonElement | null>(null);
  const optionsSaveRef = useRef<HTMLButtonElement | null>(null);
  const optionsCancelRef = useRef<HTMLButtonElement | null>(null);
  const optionsCursorRef = useRef(optionsCursor);
  optionsCursorRef.current = optionsCursor;
  const saveOptionsRef = useRef<() => void>(() => {});
  const closeOptionsRef = useRef<() => void>(() => {});

  // Le panneau masque les manettes aux hooks globaux : on lit la vraie API ici.
  const realGamepads = useRef<(() => (Gamepad | null)[]) | null>(null);
  if (realGamepads.current === null) {
    realGamepads.current = navigator.getGamepads
      ? navigator.getGamepads.bind(navigator)
      : null;
  }

  // `liveGames` porte les temps de jeu et visuels rafraîchis ; l'épinglage fait
  // foi côté App et doit toujours suivre la liste du ruban.
  const displayGames = games.map((game) => {
    const live = liveGames[game.id];
    return live ? { ...live, pinned: game.pinned } : game;
  });
  const displayGamesRef = useRef<Game[]>(displayGames);
  displayGamesRef.current = displayGames;
  const liveGamesRef = useRef(liveGames);
  liveGamesRef.current = liveGames;
  // Index borné aux jeux réels : les cases vides ne sont jamais sélectionnables.
  const activeIndex =
    displayGames.length === 0
      ? 0
      : Math.max(0, Math.min(selectedIndex, displayGames.length - 1));
  const emptySlots = Math.max(4, 8 - displayGames.length);
  const selected = displayGames[activeIndex] ?? null;
  activeIndexRef.current = displayGames.length > 0 ? activeIndex : -1;

  useLayoutEffect(() => {
    const track = ribbonRef.current;
    if (!track) return;

    const count = displayGames.length + emptySlots;
    tileRefs.current.length = count;

    // Le pas est mesuré dans le DOM : il suit --u et reste exact après un
    // redimensionnement, sans jamais toucher au layout pendant l'animation.
    let step = 0;
    let unit = 1;
    const measure = () => {
      const first = tileRefs.current[0];
      if (!first) return;
      const second = tileRefs.current[1];
      const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
      step =
        second && second.offsetLeft > first.offsetLeft
          ? second.offsetLeft - first.offsetLeft
          : first.offsetWidth + gap;
      unit = first.offsetWidth / TILE_SIZE || 1;
    };
    measure();

    const targetFor = (index: number) => {
      const active = activeIndexRef.current;
      if (active < 0) return { scale: 1, offsetX: 0, opacity: 1 };
      return {
        scale: index === active ? ACTIVE_SCALE : 1,
        offsetX: index > active ? NEIGHBOUR_PUSH * unit : 0,
        opacity: index < active ? PREVIOUS_OPACITY : 1,
      };
    };

    const active = activeIndexRef.current;
    motion.current = {
      x: active >= 0 ? -active * step : 0,
      velocity: 0,
      tiles: Array.from({ length: count }, (_, index) => {
        const target = targetFor(index);
        tileRefs.current[index]?.style.setProperty(
          "transform-origin",
          "top left",
        );
        return {
          scale: target.scale,
          scaleVelocity: 0,
          offsetX: target.offsetX,
          offsetXVelocity: 0,
          opacity: target.opacity,
          opacityVelocity: 0,
        };
      }),
    };

    const render = () => {
      const state = motion.current;
      track.style.transform = `translate3d(${state.x.toFixed(2)}px, 0, 0)`;
      for (let index = 0; index < state.tiles.length; index += 1) {
        const element = tileRefs.current[index];
        const tile = state.tiles[index];
        if (!element) continue;
        element.style.transform = `translate3d(${tile.offsetX.toFixed(
          2,
        )}px, 0, 0) scale(${tile.scale.toFixed(4)})`;
        element.style.opacity = tile.opacity.toFixed(3);
      }
    };
    render();

    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    let frame = 0;
    let last = performance.now();
    let lastActive = activeIndexRef.current;

    // Solution exacte d'un ressort critiquement amorti (damping = 1) :
    // aucun rebond, vitesse conservée d'une frame à l'autre.
    const spring = (
      current: number,
      velocity: number,
      target: number,
      dt: number,
      decay: number,
    ): [number, number] => {
      const displacement = current - target;
      const temp = (velocity + SPRING_OMEGA * displacement) * dt;
      return [
        target + (displacement + temp) * decay,
        (velocity - SPRING_OMEGA * temp) * decay,
      ];
    };

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const dt = reduced
        ? 0
        : Math.min(MAX_FRAME_DT, Math.max(0, (now - last) / 1000));
      last = now;
      const state = motion.current;
      const active = activeIndexRef.current;
      const targetX = active >= 0 ? -active * step : 0;
      const decay = dt > 0 ? Math.exp(-SPRING_OMEGA * dt) : 1;
      const activeChanged = active !== lastActive;
      lastActive = active;

      if (reduced) {
        state.x = targetX;
        state.velocity = 0;
      } else {
        if (activeChanged) {
          state.velocity +=
            (targetX - state.x) * SPRING_OMEGA * START_IMPULSE;
        }
        [state.x, state.velocity] = spring(
          state.x,
          state.velocity,
          targetX,
          dt,
          decay,
        );
      }

      for (let index = 0; index < state.tiles.length; index += 1) {
        const tile = state.tiles[index];
        const target = targetFor(index);
        if (reduced) {
          tile.scale = target.scale;
          tile.offsetX = target.offsetX;
          tile.opacity = target.opacity;
          tile.scaleVelocity = 0;
          tile.offsetXVelocity = 0;
          tile.opacityVelocity = 0;
        } else {
          if (activeChanged) {
            tile.scaleVelocity +=
              (target.scale - tile.scale) * SPRING_OMEGA * START_IMPULSE;
            tile.offsetXVelocity +=
              (target.offsetX - tile.offsetX) *
              SPRING_OMEGA *
              START_IMPULSE;
            tile.opacityVelocity +=
              (target.opacity - tile.opacity) *
              SPRING_OMEGA *
              START_IMPULSE;
          }
          [tile.scale, tile.scaleVelocity] = spring(
            tile.scale,
            tile.scaleVelocity,
            target.scale,
            dt,
            decay,
          );
          [tile.offsetX, tile.offsetXVelocity] = spring(
            tile.offsetX,
            tile.offsetXVelocity,
            target.offsetX,
            dt,
            decay,
          );
          [tile.opacity, tile.opacityVelocity] = spring(
            tile.opacity,
            tile.opacityVelocity,
            target.opacity,
            dt,
            decay,
          );
        }
      }

      render();
    };

    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, [displayGames.length, emptySlots]);

  const artworkKey = displayGames
    .map((game) => `${game.cover_url ?? ""}\n${game.bg_url ?? ""}`)
    .join("\n");

  useEffect(() => {
    for (const url of PERMANENT_TILE_IMAGES) preloadImage(url);
    for (const game of displayGames) {
      preloadImage(game.cover_url);
      preloadImage(game.bg_url);
    }
    // Le décodage ne dépend que des URLs, pas des autres champs des jeux.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artworkKey]);

  useEffect(() => {
    const onVisibilityChange = () => setAppHidden(document.hidden);
    onVisibilityChange();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    // Minimisé pour un jeu : le moteur Web Audio est suspendu. Au retour au
    // premier plan, il reprend avec la musique du menu.
    const onFocus = () => {
      resumeAudioEngine();
      resumeBgm();
    };
    const onBlur = () => {
      suspendAudioEngine();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    invoke<UserProfile>("get_profile")
      .then(setProfile)
      .catch((cause) => console.error("Chargement du profil:", cause));
  }, []);

  // Batterie de la manette (XInput sous Windows) : rafraîchie toutes les 5 s,
  // pour faire apparaître l'icône dès la connexion et suivre la décharge.
  useEffect(() => {
    let disposed = false;
    const read = () => {
      invoke<number | null>("get_controller_battery")
        .then((level) => {
          if (!disposed) setBatteryLevel(level);
        })
        .catch(() => {});
    };
    read();
    const timer = window.setInterval(read, 5000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!localError) return;
    const timer = window.setTimeout(() => setLocalError(null), 6000);
    return () => window.clearTimeout(timer);
  }, [localError]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const applyGames = (list: Game[]) => {
      if (disposed) return;
      setLiveGames(Object.fromEntries(list.map((game) => [game.id, game])));
    };

    const refresh = () => {
      invoke<Game[]>("get_games")
        .then(applyGames)
        .catch((cause) =>
          console.error("Rafraîchissement des temps de jeu:", cause),
        );
    };

    // Le back émet `games-updated` à la fermeture réelle du jeu (tous processus
    // terminés) : la liste est dans le payload, l'affichage suit immédiatement.
    const handleUpdated = (payload: Game[]) => {
      resumeBgm();
      if (Array.isArray(payload)) applyGames(payload);
      else refresh();
    };

    listen<Game[]>("games-updated", (event) => handleUpdated(event.payload))
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((cause) => console.error("Écoute games-updated:", cause));

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Fin de session : le back a restauré la fenêtre et mesuré la durée réelle.
  // On réactive l'audio, on crédite le temps de jeu puis on persiste aussitôt.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const creditPlaytime = (payload: GameSessionEnded) => {
      if (disposed || typeof payload?.gameId !== "string") return;
      // Le launcher retrouve la main : le moteur audio et la musique reviennent.
      resumeAudioEngine();
      resumeBgm();
      setLaunchingGame(null);

      if (payload.crashed) {
        notify({
          icon: "game",
          title: "Le jeu n'a pas pu démarrer correctement",
          subtitle: `Code d'erreur : ${payload.exitCode ?? "inconnu"}`,
        });
      }

      const seconds = Math.max(0, Math.round(payload.durationSeconds ?? 0));
      if (seconds === 0) return;

      const known =
        liveGamesRef.current[payload.gameId] ??
        displayGamesRef.current.find((game) => game.id === payload.gameId);
      if (!known) return;

      notify({
        icon: "playtime",
        title: "Session terminée",
        subtitle: `${known.title} · ${formatPlaytime(seconds)}`,
      });

      // Affichage immédiat, puis liste faisant foi une fois écrite sur disque.
      setLiveGames({
        ...liveGamesRef.current,
        [payload.gameId]: {
          ...known,
          playtime_seconds: (known.playtime_seconds ?? 0) + seconds,
        },
      });

      void invoke<Game[]>("add_playtime", { gameId: payload.gameId, seconds })
        .then((list) => {
          if (disposed) return;
          setLiveGames(Object.fromEntries(list.map((game) => [game.id, game])));
        })
        .catch((cause) =>
          console.error("Enregistrement du temps de jeu:", cause),
        );
    };

    listen<GameSessionEnded>("game-session-ended", (event) =>
      creditPlaytime(event.payload),
    )
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((cause) => console.error("Écoute game-session-ended:", cause));

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // À la fermeture du jeu, on synchronise les trophées : le back croise les
  // fichiers locaux et le compte Steam, puis signale les nouveautés.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const syncTrophies = async (gameId: string) => {
      const game = displayGamesRef.current.find((item) => item.id === gameId);
      if (!game?.steam_appid) return;
      try {
        const report = await invoke<TrophyReport>("get_game_trophies", {
          steamAppid: game.steam_appid,
          markNew: true,
        });
        if (disposed) return;
        setReports((previous) => ({ ...previous, [gameId]: report }));
        const fresh = report.new_trophies ?? [];
        if (fresh.length > 0) {
          setTrophyQueue((previous) => [
            ...previous,
            ...fresh.map((trophy) => ({
              id: trophy.id,
              name: trophy.name,
              rank: trophy.rank,
              icon: trophy.icon || "",
            })),
          ]);
        }
      } catch (cause) {
        console.error("Synchronisation des trophées:", cause);
      }
    };

    listen<string>("game-closed", (event) => {
      if (typeof event.payload === "string") void syncTrophies(event.payload);
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((cause) => console.error("Écoute game-closed:", cause));

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Une notification à la fois, cinq secondes chacune (comme sur PS4).
  useEffect(() => {
    if (trophyToast || trophyQueue.length === 0) return;
    setTrophyToast(trophyQueue[0]);
    setTrophyQueue((previous) => previous.slice(1));
  }, [trophyQueue, trophyToast]);

  useEffect(() => {
    if (!trophyToast) {
      setToastVisible(false);
      return;
    }
    playTrophy();
    const frame = requestAnimationFrame(() => setToastVisible(true));
    const timer = window.setTimeout(() => setTrophyToast(null), 5000);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [trophyToast]);

  const selectedId = selected?.id ?? null;
  const selectedBackground = selected?.bg_url ?? null;
  const isOccludedByGameBg = Boolean(selectedBackground);
  const selectedReport = selected ? (reports[selected.id] ?? null) : null;
  const selectedLaunchArgs = (selected?.launch_options ?? "").trim();
  // Tuile permanente : aucune action de modification ni de suppression.
  const selectedIsStore = isStoreGame(selected);
  const selectedIsLibrary = isLibraryGame(selected);
  const selectedIsPermanent = isPermanentTile(selected);
  const confirming =
    selected !== null && !selectedIsPermanent && pendingDeleteId === selected.id;
  const canOpenTrophies = selected !== null && selected.steam_appid !== null;
  const systemFocused = level === "system";
  // Toute fenêtre posée sur l'accueil (Trophées, Profil, Options de lancement,
  // Audio, Bibliothèque, Ajouter un jeu) fige le ruban et les hooks globaux.
  const modalOpen =
    trophiesOpen ||
    profileOpen ||
    optionsOpen ||
    audioOpen ||
    libraryOpen ||
    addOpen;
  // Toutes les entrées de Ps4Home sont neutralisées pendant une modale, un
  // démarrage de jeu, la Bibliothèque, et jusqu'au relâchement des boutons qui
  // ont refermé l'écran précédent.
  const inputBlocked =
    !ready ||
    modalOpen ||
    modalGuard ||
    launchingGame !== null ||
    libraryOpen;

  // Le hook gamepad global d'App ne doit ni changer de jeu ni lancer pendant
  // que la barre de fonctions tient la navigation, qu'un jeu démarre ou qu'une
  // modale est ouverte (elle lit elle-même les manettes).
  useEffect(() => {
    setGlobalGamepadLock(
      !ready || level === "system" || modalOpen || launchingGame !== null,
    );
    return () => setGlobalGamepadLock(false);
  }, [ready, level, modalOpen, launchingGame]);

  /* ────────── Musiques de thème : file d'attente et lecture ────────── */

  const themeActiveRef = useRef(false);
  const themeSrcRef = useRef<string | null>(null);
  // Identifie la demande courante : un chargement périmé ne doit pas modifier
  // l'état si la modale ou le tiroir a été fermé entre-temps.
  const themeRequestRef = useRef(0);
  const themePausedBgmRef = useRef(false);
  const themeQueueRef = useRef<{ id: string; title: string }[]>([]);
  const themeQueuedRef = useRef(new Set<string>());
  const themeFailedRef = useRef(new Set<string>());
  const themeRunningRef = useRef(false);
  const allGamesRef = useRef(allGames);
  allGamesRef.current = allGames;
  const launchingGameRef = useRef(launchingGame);
  launchingGameRef.current = launchingGame;

  /** Fondu d'entrée PS4 (800 ms), en boucle, via le moteur Web Audio. */
  function startThemeAudio(path: string) {
    const src = convertFileSrc(path);
    if (themeActiveRef.current && themeSrcRef.current === src) return;

    themeActiveRef.current = true;
    themeSrcRef.current = src;
    // Le thème du jeu remplace la musique du menu pendant le tiroir.
    if (!themePausedBgmRef.current) {
      pauseBgm();
      themePausedBgmRef.current = true;
    }

    const request = themeRequestRef.current + 1;
    themeRequestRef.current = request;
    void playThemeMusic(src, path)
      .then((started) => {
        if (started || themeRequestRef.current !== request) return;
        themeActiveRef.current = false;
        themeSrcRef.current = null;
        if (themePausedBgmRef.current) {
          themePausedBgmRef.current = false;
          if (!launchingGameRef.current) resumeBgm();
        }
        console.warn("[thème] musique indisponible:", path);
      })
      .catch((cause) => console.warn("[thème] lecture impossible:", cause));
  }

  /** Fondu de sortie rapide (300 ms), puis arrêt des sources.
   *  La musique du menu reprend tout de suite, sauf pendant un lancement. */
  function stopThemeAudio() {
    themeRequestRef.current += 1;
    const wasActive = themeActiveRef.current;
    themeActiveRef.current = false;
    themeSrcRef.current = null;

    if (wasActive && themePausedBgmRef.current) {
      themePausedBgmRef.current = false;
      // Un lancement a déjà coupé la musique : ne pas la relancer sous le splash.
      if (!launchingGameRef.current) resumeBgm();
    }
    if (!wasActive) return;
    stopThemeMusic(300);
  }

  async function pumpThemeQueue() {
    if (themeRunningRef.current) return;
    themeRunningRef.current = true;
    try {
      while (themeQueueRef.current.length > 0) {
        const next = themeQueueRef.current.shift();
        if (!next) break;
        try {
          const path = await invoke<string>("fetch_game_theme_auto", {
            gameId: next.id,
            gameTitle: next.title,
          });
          const list = await invoke<Game[]>("set_game_theme_audio", {
            gameId: next.id,
            themeAudioPath: path,
          });
          setLiveGames(Object.fromEntries(list.map((game) => [game.id, game])));
        } catch (cause) {
          // Session sans réseau : on n'insiste pas avant le prochain démarrage.
          themeFailedRef.current.add(next.id);
          console.warn(`[thème] ${next.title}:`, cause);
        }
      }
    } finally {
      themeRunningRef.current = false;
    }
  }

  // File séquentielle : un téléchargement à la fois, sans bloquer l'interface.
  useEffect(() => {
    for (const game of allGames) {
      if (isPermanentTile(game)) continue;
      if (game.themeAudioPath) continue;
      if (
        themeQueuedRef.current.has(game.id) ||
        themeFailedRef.current.has(game.id)
      ) {
        continue;
      }
      themeQueuedRef.current.add(game.id);
      themeQueueRef.current.push({ id: game.id, title: game.title });
    }
    void pumpThemeQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allGames]);

  // Lecture dans le tiroir d'informations uniquement, hors lancement et muet.
  useEffect(() => {
    const path = selected?.themeAudioPath ?? null;
    // Le panneau audio ouvre aussi le thème du jeu sélectionné : l'utilisateur
    // entend immédiatement l'effet des bandes et des volumes.
    const shouldPlay =
      (level === "info" || audioOpen) &&
      Boolean(path) &&
      !bgmMuted &&
      !launchingGame &&
      !libraryOpen;
    if (shouldPlay && path) startThemeAudio(path);
    else stopThemeAudio();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    level,
    selected?.id,
    selected?.themeAudioPath,
    bgmMuted,
    launchingGame,
    libraryOpen,
    audioOpen,
  ]);

  async function regenerateTheme() {
    const game = optionsGame;
    if (!game || regeneratingTheme) return;
    setRegeneratingTheme(true);
    // La file ne doit pas doubler le téléchargement de ce jeu.
    themeQueueRef.current = themeQueueRef.current.filter(
      (item) => item.id !== game.id,
    );
    themeFailedRef.current.delete(game.id);
    try {
      await invoke<Game[]>("clear_game_theme", { gameId: game.id });
      const path = await invoke<string>("fetch_game_theme_auto", {
        gameId: game.id,
        gameTitle: game.title,
      });
      const list = await invoke<Game[]>("set_game_theme_audio", {
        gameId: game.id,
        themeAudioPath: path,
      });
      setLiveGames(Object.fromEntries(list.map((item) => [item.id, item])));
      themeQueuedRef.current.add(game.id);
      playNotification();
    } catch (cause) {
      themeFailedRef.current.add(game.id);
      playError();
      setOptionsError(`Musique auto: ${String(cause)}`);
    } finally {
      setRegeneratingTheme(false);
    }
  }

  // Rond / Échap utilisés pour fermer une modale peuvent encore être enfoncés
  // à l'instant du démontage : on attend leur relâchement (comme pour les
  // options de lancement) avant de rendre la main au ruban et à la barre.
  useEffect(() => {
    if (!modalGuard || modalOpen) return;
    const startedAt = performance.now();
    let frame = 0;
    const tick = (time: number) => {
      const stillPressed = (realGamepads.current?.() ?? []).some(
        (pad) => pad?.connected && pad.buttons.some((button) => button.pressed),
      );
      if (time - startedAt < 200 || stillPressed) {
        frame = requestAnimationFrame(tick);
        return;
      }
      setModalGuard(false);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [modalGuard, modalOpen]);

  // Le tiroir s'ouvre toujours sur son sommet, même après avoir été déroulé.
  useEffect(() => {
    if (level !== "info") return;
    infoScrollRef.current?.scrollTo({ top: 0 });
  }, [level, selected?.id]);

  useEffect(() => {
    setTrophiesOpen(false);
    setOptionsOpen(false);
    setOptionsGame(null);
    setOptionsError(null);
    // Nouveau jeu sélectionné : le tiroir repart de son premier élément (les
    // tuiles permanentes n'en ont qu'un).
    const top: DrawerFocus = isPermanentTile(selected) ? "start" : DRAWER_TOP;
    drawerFocusRef.current = top;
    setDrawerFocus(top);
    setLevel("ribbon");
  }, [selected?.id]);

  // Crossfade du fond, dérivé pendant le rendu : aucune frame de retard et
  // aucune minuterie. L'ancienne image ne sert de sous-couche qu'entre deux
  // jeux ; sans nouveau fond (tuiles permanentes), elle disparaît dans la même
  // frame que la sélection, laissant apparaître immédiatement le fond PS4.
  const lastBackgroundRef = useRef<string | null>(selectedBackground);
  const underBackgroundRef = useRef<string | null>(null);
  if (lastBackgroundRef.current !== selectedBackground) {
    underBackgroundRef.current =
      selectedBackground && lastBackgroundRef.current
        ? lastBackgroundRef.current
        : null;
    lastBackgroundRef.current = selectedBackground;
  }
  const underBackground = underBackgroundRef.current;

  // Le bandeau « Démarrer » se déploie au lieu d'apparaître d'un coup ; il
  // reste en place d'un jeu à l'autre, puis se replie quand aucun jeu n'est
  // sélectionné (suppression), afin de ne pas rejouer un repli visible.
  useEffect(() => {
    if (!selectedId) {
      setStartDeployed(false);
      return;
    }
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setStartDeployed(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [selectedId]);

  useEffect(() => {
    if (!optionsOpen) return;
    const frame = requestAnimationFrame(() => optionsInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [optionsOpen]);

  // Retour visuel du bouton de copie, remis à zéro après 2 secondes.
  useEffect(() => {
    if (copiedAt === null) return;
    const timer = window.setTimeout(() => setCopiedAt(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copiedAt]);

  // Le hook gamepad global d'App lance le jeu sur Croix : on masque les
  // manettes tant que le panneau est ouvert, sans fenêtre où elles réapparaissent.
  const padsPatched = useRef(false);

  function maskGamepads() {
    const target = navigator as Navigator & {
      getGamepads?: () => (Gamepad | null)[];
    };
    if (padsPatched.current || !target.getGamepads) return;
    target.getGamepads = () => [];
    padsPatched.current = true;
  }

  function releaseGamepads() {
    if (!padsPatched.current) return;
    delete (navigator as { getGamepads?: unknown }).getGamepads;
    padsPatched.current = false;
  }

  const wasOptionsOpen = useRef(false);
  useEffect(() => {
    if (optionsOpen) {
      wasOptionsOpen.current = true;
      return;
    }
    if (!wasOptionsOpen.current) return;
    wasOptionsOpen.current = false;
    setPadsGuard(true);
  }, [optionsOpen]);

  // Le Croix utilisé pour enregistrer est peut-être encore enfoncé : on attend
  // son relâchement avant de rendre les manettes aux hooks globaux.
  useEffect(() => {
    if (!padsGuard || optionsOpen) return;
    const startedAt = performance.now();
    let frame = 0;
    const tick = (time: number) => {
      const stillPressed = (realGamepads.current?.() ?? []).some(
        (pad) => pad?.connected && pad.buttons.some((button) => button.pressed),
      );
      if (time - startedAt < 250 || stillPressed) {
        frame = requestAnimationFrame(tick);
        return;
      }
      releaseGamepads();
      setPadsGuard(false);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [padsGuard, optionsOpen]);

  useEffect(() => () => releaseGamepads(), []);

  useEffect(() => {
    if (!optionsOpen) return;
    let frame = 0;
    let lastNav = 0;
    let lastConfirm = false;
    let lastBack = false;

    const tick = (time: number) => {
      frame = requestAnimationFrame(tick);
      let up = false;
      let down = false;
      let left = false;
      let right = false;
      let confirm = false;
      let back = false;

      for (const pad of realGamepads.current?.() ?? []) {
        if (!pad?.connected) continue;
        up = up || Boolean(pad.buttons[12]?.pressed) || pad.axes[1] < -0.5;
        down = down || Boolean(pad.buttons[13]?.pressed) || pad.axes[1] > 0.5;
        left = left || Boolean(pad.buttons[14]?.pressed) || pad.axes[0] < -0.5;
        right = right || Boolean(pad.buttons[15]?.pressed) || pad.axes[0] > 0.5;
        confirm = confirm || Boolean(pad.buttons[0]?.pressed);
        back = back || Boolean(pad.buttons[1]?.pressed);
      }

      if ((up || down || left || right) && time - lastNav >= 180) {
        lastNav = time;
        moveOptionsCursor(up || left ? -1 : 1);
      }
      if (confirm && !lastConfirm) activateOptionItem();
      if (back && !lastBack) closeOptionsRef.current();
      lastConfirm = confirm;
      lastBack = back;
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionsOpen]);

  useEffect(() => {
    if (!optionsOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (hasSystemModifier(event)) return;
      const id = event.key.toLowerCase();

      if (isTypingTarget(event.target)) {
        // Saisie des arguments : ZQSD / A / B / Y / X restent du texte.
        if (id === "escape") {
          event.preventDefault();
          event.stopImmediatePropagation();
          (document.activeElement as HTMLElement | null)?.blur?.();
          closeOptionsRef.current();
        } else if (id === "enter") {
          event.preventDefault();
          event.stopImmediatePropagation();
          saveOptionsRef.current();
        } else if (
          event.target === optionsInputRef.current &&
          (id === "arrowup" || id === "arrowdown")
        ) {
          // Champ mono-ligne : Haut / Bas sortent de la saisie vers les
          // autres éléments du panneau (Gauche / Droite déplacent le curseur).
          event.preventDefault();
          event.stopImmediatePropagation();
          moveOptionsCursor(id === "arrowup" ? -1 : 1);
        }
        return;
      }

      if (event.key === "Enter") {
        // Bloque le lancement de jeu global et valide l'élément focalisé.
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) activateOptionItem();
        return;
      }
      if (!isMenuKey(id)) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      // Une action ne part qu'une fois par pression (contrairement aux directions).
      const isDirection =
        id === "arrowup" ||
        id === "z" ||
        id === "arrowdown" ||
        id === "s" ||
        id === "arrowleft" ||
        id === "q" ||
        id === "arrowright" ||
        id === "d";
      if (event.repeat && !isDirection) return;

      if (id === "a") {
        activateOptionItem();
        return;
      }
      if (id === "b" || id === "escape") {
        closeOptionsRef.current();
        return;
      }
      if (id === "arrowup" || id === "z" || id === "arrowleft" || id === "q") {
        moveOptionsCursor(-1);
        return;
      }
      if (
        id === "arrowdown" ||
        id === "s" ||
        id === "arrowright" ||
        id === "d"
      )
        moveOptionsCursor(1);
      // x, y, o : avalés, aucune action dans ce panneau.
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionsOpen]);

  useEffect(() => {
    if (level !== "info" || !selected?.steam_appid) return;
    const gameId = selected.id;
    if (reports[gameId]) return;

    let cancelled = false;
    invoke<TrophyReport>("get_game_trophies", {
      steamAppid: selected.steam_appid,
    })
      .then((report) => {
        if (cancelled || !report) return;
        setReports((previous) => ({ ...previous, [gameId]: report }));
      })
      .catch((cause) => {
        if (cancelled) return;
        setLocalError(`Trophées indisponibles: ${String(cause)}`);
      });

    return () => {
      cancelled = true;
    };
  }, [level, selected?.id, selected?.steam_appid, reports]);

  function openInfo() {
    // Tuile permanente : pas de tiroir d'informations, pas d'options, pas de
    // trophées. Bas / Triangle n'ont donc aucun effet sur cette case.
    if (!selected || isPermanentTile(selected)) return;
    // Le curseur repart toujours du haut du tiroir, jamais de l'élément
    // précédemment survolé ou validé.
    drawerFocusRef.current = DRAWER_TOP;
    setDrawerFocus(DRAWER_TOP);
    setLevel("info");
    playNav();
  }

  function openTrophies() {
    if (!canOpenTrophies) return;
    playEnterMenu();
    setTrophiesOpen(true);
  }

  function openProfile() {
    playEnterMenu();
    setProfileOpen(true);
  }

  function focusHeader(index: number) {
    headerIndexRef.current = index;
    setHeaderIndex(index);
  }

  function moveHeader(delta: number) {
    const next = Math.max(0, Math.min(HEADER_COUNT - 1, headerIndexRef.current + delta));
    if (next === headerIndexRef.current) return;
    focusHeader(next);
    playNav();
  }

  function leaveHeader() {
    playNav();
    setLevel("ribbon");
  }

  function activateHeader() {
    if (headerIndexRef.current === 0) openTrophies();
    else if (headerIndexRef.current === 1) addGame();
    else if (headerIndexRef.current === 2) openProfile();
    else if (headerIndexRef.current === 3) openAudio();
    else void quitApplication();
  }

  function headerFocusClass(index: number) {
    if (!systemFocused) return "border-transparent";
    return headerIndex === index
      ? "border-white bg-white/15 !text-white !opacity-100 shadow-[0_0_calc(22*var(--u))_rgba(255,255,255,0.5)]"
      : "border-transparent !opacity-75";
  }

  // Éléments navigables : arguments, Copier, Enregistrer, Annuler. La case
  // d'emplacement reste hors du parcours (tabIndex -1) pour ne pas piéger les
  // flèches dans un champ en lecture seule.
  function focusOptionItem(index: number) {
    setOptionsCursor(index);
    const targets = [
      optionsInputRef.current,
      optionsCopyRef.current,
      optionsSaveRef.current,
      optionsCancelRef.current,
    ];
    targets[index]?.focus();
  }

  function moveOptionsCursor(delta: number) {
    playNav();
    focusOptionItem((optionsCursorRef.current + delta + 4) % 4);
  }

  function activateOptionItem() {
    const index = optionsCursorRef.current;
    // Aucun élément du parcours actif (focus dans la case d'emplacement).
    if (index < 0) return;
    if (index === 0) {
      playConfirm();
      optionsInputRef.current?.focus();
      return;
    }
    if (index === 1) {
      void copyGamePath();
      return;
    }
    if (index === 2) {
      saveOptionsRef.current();
      return;
    }
    closeOptionsRef.current();
  }

  function openLaunchOptions(target?: Game) {
    const game = target ?? selected;
    if (!game || isPermanentTile(game)) return;
    playEnterMenu();
    maskGamepads();
    setOptionsGame(game);
    setOptionsDraft(game.launch_options ?? "");
    setOptionsError(null);
    setCopiedAt(null);
    // Le panneau repart sur son premier élément (arguments), jamais sur
    // l'action précédemment sélectionnée.
    optionsCursorRef.current = 0;
    setOptionsCursor(0);
    setOptionsOpen(true);
  }

  function closeLaunchOptions() {
    if (savingOptions) return;
    playBack();
    setOptionsOpen(false);
    setOptionsError(null);
  }

  async function saveLaunchOptions() {
    const game = optionsGame;
    if (!game || isPermanentTile(game) || savingOptions) return;
    setSavingOptions(true);
    setOptionsError(null);
    try {
      const list = await invoke<Game[]>("update_launch_options", {
        id: game.id,
        launchOptions: optionsDraft,
      });
      setLiveGames(Object.fromEntries(list.map((game) => [game.id, game])));
      playConfirm();
      setOptionsOpen(false);
    } catch (cause) {
      playError();
      setOptionsError(String(cause));
    } finally {
      setSavingOptions(false);
    }
  }

  saveOptionsRef.current = () => {
    void saveLaunchOptions();
  };
  closeOptionsRef.current = closeLaunchOptions;

  /* ─────────────── Alimentation : fermeture immédiate ─────────────── */

  const quittingRef = useRef(false);

  /** Ferme le launcher sans modale : son de confirmation puis quit_app. */
  async function quitApplication() {
    if (quittingRef.current) return;
    quittingRef.current = true;
    playDialogYes();
    // Laisse le jingle de confirmation démarrer avant de couper le processus.
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    try {
      await invoke("quit_app");
    } catch (cause) {
      console.error("Fermeture via quit_app impossible :", cause);
      try {
        await getCurrentWindow().close();
      } catch (error) {
        console.error("Fermeture de la fenêtre impossible :", error);
        quittingRef.current = false;
      }
    }
  }

  /* ─────────────── Mixage audio et égaliseur ─────────────── */

  const lastAudioNav = useRef(0);

  function openAudio() {
    playEnterMenu();
    audioIndexRef.current = 0;
    setAudioIndex(0);
    setAudioSettingsState(getAudioSettings());
    setAudioOpen(true);
  }

  function closeAudio() {
    playBack();
    setAudioOpen(false);
  }

  function focusAudioRow(index: number) {
    audioIndexRef.current = index;
    setAudioIndex(index);
  }

  function moveAudioRow(delta: number) {
    const next =
      (audioIndexRef.current + delta + AUDIO_ROW_COUNT) % AUDIO_ROW_COUNT;
    focusAudioRow(next);
    playNav();
  }

  function toggleNormalization() {
    setAudioSettingsState(
      updateAudioSettings({
        normalization: !getAudioSettings().normalization,
      }),
    );
    playNav();
  }

  /** Ajuste la ligne active : curseurs par pas de 5 %, bandes par pas de 1 dB. */
  function adjustAudioRow(direction: -1 | 1) {
    const row = audioIndexRef.current;
    const current = getAudioSettings();

    if (row === 0) {
      // Le clic de confirmation doit rester audible après réactivation.
      toggleBgm();
      return;
    }

    if (row === 1) {
      setAudioSettingsState(
        updateAudioSettings({
          themeVolume: current.themeVolume + direction * 0.05,
        }),
      );
    } else if (row === 2) {
      setAudioSettingsState(
        updateAudioSettings({
          effectsVolume: current.effectsVolume + direction * 0.05,
        }),
      );
    } else if (row === 3) {
      toggleNormalization();
      return;
    } else if (row === 4) {
      const match = EQ_PRESETS.findIndex(
        (preset) =>
          preset.low === current.eqLow &&
          preset.mid === current.eqMid &&
          preset.high === current.eqHigh,
      );
      const next =
        EQ_PRESETS[
          (match + direction + EQ_PRESETS.length) % EQ_PRESETS.length
        ];
      setAudioSettingsState(applyEqPreset(next.id));
    } else if (row === 5) {
      setAudioSettingsState(
        updateAudioSettings({ eqLow: current.eqLow + direction }),
      );
    } else if (row === 6) {
      setAudioSettingsState(
        updateAudioSettings({ eqMid: current.eqMid + direction }),
      );
    } else {
      setAudioSettingsState(
        updateAudioSettings({ eqHigh: current.eqHigh + direction }),
      );
    }
    playNav();
  }

  function activateAudioRow() {
    const row = audioIndexRef.current;
    if (row === 0) {
      toggleBgm();
      return;
    }
    if (row === 3) {
      toggleNormalization();
      return;
    }
    // Croix pousse aussi les curseurs, comme la croix directionnelle.
    adjustAudioRow(1);
  }

  /** Halo de focus « Liquid Glass » sur le contrôle actif. */
  function audioSectionClass(index: number) {
    return index === audioIndex
      ? "border-sky-300/40 bg-sky-400/[0.12] shadow-[0_0_0_1px_rgba(125,211,252,0.25),0_0_20px_rgba(0,114,206,0.35)]"
      : "border-sky-300/10 bg-[#041029]/30 hover:border-sky-300/25 hover:bg-[#0f347a]/40";
  }

  function setAudioBand(band: "low" | "mid" | "high", value: number) {
    const db = Math.max(-12, Math.min(12, value));
    setAudioSettingsState(
      updateAudioSettings(
        band === "low"
          ? { eqLow: db }
          : band === "mid"
            ? { eqMid: db }
            : { eqHigh: db },
      ),
    );
  }

  // Clavier du panneau : ↑↓ / Z S changent de ligne, ←→ / Q D ajustent, Rond ferme.
  useEffect(() => {
    if (!audioOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (hasSystemModifier(event)) return;
      const id = event.key.toLowerCase();
      const up = id === "arrowup" || id === "z";
      const down = id === "arrowdown" || id === "s";
      const left = id === "arrowleft" || id === "q";
      const right = id === "arrowright" || id === "d";
      const confirm = id === "a" || event.key === "Enter";
      const cancel = id === "b" || id === "escape" || id === "backspace";
      if (!up && !down && !left && !right && !confirm && !cancel) return;

      // La modale garde la main : aucun raccourci global ne passe.
      event.preventDefault();
      event.stopImmediatePropagation();

      if (cancel) {
        closeAudio();
        return;
      }
      if (up || down) {
        const now = performance.now();
        if (event.repeat && now - lastAudioNav.current < 150) return;
        lastAudioNav.current = now;
        moveAudioRow(up ? -1 : 1);
        return;
      }
      if (left || right) {
        // Les bascules ne réagissent qu'à un nouvel appui.
        const row = audioIndexRef.current;
        if ((row === 0 || row === 3) && event.repeat) return;
        adjustAudioRow(left ? -1 : 1);
        return;
      }
      if (!event.repeat) activateAudioRow();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioOpen]);

  // Manette : D-pad / stick pour les lignes et les curseurs, Croix / Rond.
  useEffect(() => {
    if (!audioOpen) return;
    let frame = 0;
    let lastMove = 0;
    let lastAdjust = 0;
    let lastConfirm = false;
    let lastCancel = false;
    let lastLeft = false;
    let lastRight = false;

    const tick = (time: number) => {
      frame = requestAnimationFrame(tick);
      let up = false;
      let down = false;
      let left = false;
      let right = false;
      let confirm = false;
      let cancel = false;

      for (const pad of realGamepads.current?.() ?? []) {
        if (!pad?.connected) continue;
        up = up || Boolean(pad.buttons[12]?.pressed) || pad.axes[1] < -0.5;
        down =
          down || Boolean(pad.buttons[13]?.pressed) || pad.axes[1] > 0.5;
        left = left || Boolean(pad.buttons[14]?.pressed) || pad.axes[0] < -0.5;
        right =
          right || Boolean(pad.buttons[15]?.pressed) || pad.axes[0] > 0.5;
        confirm = confirm || Boolean(pad.buttons[0]?.pressed);
        cancel = cancel || Boolean(pad.buttons[1]?.pressed);
      }

      if ((up || down) && time - lastMove >= 180) {
        lastMove = time;
        moveAudioRow(up ? -1 : 1);
      }

      const row = audioIndexRef.current;
      if (row === 0 || row === 3) {
        if (left && !lastLeft) adjustAudioRow(-1);
        if (right && !lastRight) adjustAudioRow(1);
      } else if ((left || right) && time - lastAdjust >= 110) {
        lastAdjust = time;
        adjustAudioRow(left ? -1 : 1);
      }

      if (confirm && !lastConfirm) activateAudioRow();
      if (cancel && !lastCancel) closeAudio();
      lastConfirm = confirm;
      lastCancel = cancel;
      lastLeft = left;
      lastRight = right;
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioOpen]);

  /**
   * Copie le chemin de l'exécutable : API Clipboard quand la WebView
   * l'autorise, sinon sélection du champ puis copie native du document.
   */
  async function copyGamePath() {
    const gamePath = optionsGame?.exe_path ?? "";
    if (!gamePath) {
      playError();
      return;
    }

    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(gamePath);
        copied = true;
      }
    } catch {
      copied = false;
    }

    if (!copied) {
      const field = optionsPathRef.current;
      if (field) {
        field.focus();
        field.select();
        try {
          copied = document.execCommand("copy");
        } catch {
          copied = false;
        }
      }
    }

    if (!copied) {
      playError();
      return;
    }
    playDialogYes();
    setCopiedAt(performance.now());
  }

  function selectGame(index: number) {
    const target = displayGames[index] ?? null;
    // Un clic sur une tuile permanente ouvre directement son écran, sans tiroir.
    if (isPermanentTile(target)) {
      if (index !== activeIndex) {
        playNav();
        onSelect(index);
      }
      if (isLibraryGame(target)) {
        playEnterMenu();
        setLevel("ribbon");
        setLibraryOpen(true);
      } else {
        openStore();
      }
      return;
    }
    if (level === "ribbon" && index === activeIndex) {
      openInfo();
      return;
    }
    if (index !== activeIndex) {
      playNav();
      onSelect(index);
    }
    setLevel("ribbon");
  }

  /**
   * Ouvre la boutique dans le navigateur par défaut : plugin opener (Tauri),
   * avec repli sur `window.open` si la WebView refuse l'ouverture externe.
   */
  function openStore() {
    const now = performance.now();
    if (now - lastStoreOpen.current < 500) return;
    lastStoreOpen.current = now;
    playDialogYes();
    void openUrl(PS_STORE_URL).catch((cause) => {
      console.error("Ouverture du PlayStation Store:", cause);
      window.open(PS_STORE_URL, "_blank", "noopener,noreferrer");
    });
  }

  // Action de lancement la plus récente : la tâche différée ne capture pas la
  // version du rendu qui a démarré l'écran (ruban ou Bibliothèque).
  const launchActionRef = useRef<() => void | Promise<void>>(() => {});
  const onLaunchRef = useRef(onLaunch);
  onLaunchRef.current = onLaunch;
  const onLaunchGameRef = useRef(onLaunchGame);
  onLaunchGameRef.current = onLaunchGame;

  /** Ouvre la grille complète : la tuile Bibliothèque ne lance aucun processus. */
  function openLibrary() {
    if (!selectedIsLibrary || libraryOpen) return;
    playEnterMenu();
    setLevel("ribbon");
    setLibraryOpen(true);
  }

  /** Démarre l'écran de démarrage puis, après l'animation, le jeu demandé. */
  function startLaunch(game: Game, action: () => void | Promise<void>) {
    if (isPermanentTile(game) || launchingGame || busy) return;
    launchActionRef.current = action;
    // Le splash coupe immédiatement le thème du tiroir : la ref est mise à jour
    // tout de suite pour que stopThemeAudio ne relance pas la musique du menu.
    launchingGameRef.current = game;
    setLaunchingGame(game);
    playGameStart();
    pauseBgm();
    stopThemeAudio();
  }

  function launchSelected() {
    // Tuile permanente : le Store ouvre le site, la Bibliothèque sa grille.
    if (selectedIsStore) {
      openStore();
      return;
    }
    if (selectedIsLibrary) {
      openLibrary();
      return;
    }
    if (!selected) return;
    startLaunch(selected, () => onLaunchRef.current());
  }

  /** Lancement depuis la grille : la vue se referme sur l'écran de démarrage. */
  function launchFromLibrary(game: Game) {
    if (isPermanentTile(game) || launchingGame || busy) return;
    setLibraryOpen(false);
    startLaunch(game, () => onLaunchGameRef.current(game.id));
  }

  // Après l'animation, on lance l'exécutable : Rust minimise la fenêtre, ce qui
  // masque l'écran de démarrage. L'événement `game-session-ended` le masque
  // aussi au retour, si le launcher n'a pas déjà repris la main.
  useEffect(() => {
    if (!launchingGame) return;
    const timer = window.setTimeout(() => {
      void Promise.resolve(launchActionRef.current()).finally(() => {
        setLaunchingGame(null);
      });
    }, SPLASH_MS);
    return () => window.clearTimeout(timer);
  }, [launchingGame]);

  function addGame() {
    playEnterMenu();
    onAdd();
  }

  function requestDelete() {
    // Tuiles permanentes : aucune suppression possible.
    if (isPermanentTile(selected)) return;
    playNegative();
    onRequestDelete();
  }

  function confirmDelete() {
    playDialogYes();
    onConfirmDelete();
  }

  function cancelDelete() {
    playBack();
    onCancelDelete();
  }

  function backToRibbon() {
    playBack();
    setLevel("ribbon");
  }

  /**
   * Survol souris : on ne suit que le déplacement réel du pointeur. Un
   * `mouseenter` suffirait à voler le focus quand le tiroir glisse sous un
   * pointeur immobile (il atterrissait alors sur « Supprimer du launcher »).
   */
  function focusDrawerFromPointer(next: DrawerFocus) {
    if (drawerFocusRef.current === next) return;
    drawerFocusRef.current = next;
    setDrawerFocus(next);
  }

  /** Déplace le curseur interne du tiroir selon la grille affichée. */
  function drawerStep(direction: "up" | "down" | "left" | "right") {
    // Une tuile permanente n'a qu'une action : Haut rend la main au ruban, le
    // reste est inerte (la tuile ne peut pas être déplacée ni modifiée).
    if (isPermanentTile(selected)) {
      if (direction === "up") backToRibbon();
      return;
    }

    const current = drawerFocusRef.current;
    let next: DrawerFocus | null = null;

    if (direction === "left") {
      if (current === "remove_game") next = "pin_game";
      else if (current === "pin_game") next = "refresh_art";
      else if (current !== "start") next = "start";
    } else if (direction === "right") {
      if (current === "start") next = "trophies";
      else if (current === "refresh_art") next = "pin_game";
      else if (current === "pin_game") next = "remove_game";
    } else if (direction === "down") {
      if (current === "start") next = "trophies";
      else if (current === "trophies") next = "launch_options";
      else if (current === "launch_options") next = "refresh_art";
    } else if (
      current === "refresh_art" ||
      current === "pin_game" ||
      current === "remove_game"
    ) {
      next = "launch_options";
    } else if (current === "launch_options") {
      next = "trophies";
    } else {
      // Haut depuis le sommet du tiroir : retour au bandeau principal.
      backToRibbon();
      return;
    }

    if (!next || next === current) return;
    drawerFocusRef.current = next;
    setDrawerFocus(next);
    playNav();
  }

  /** Valide l'élément du tiroir qui porte le curseur. */
  function activateDrawerFocus() {
    // Seule l'ouverture (site ou Bibliothèque) est proposée pour une tuile
    // permanente.
    if (isPermanentTile(selected)) {
      launchSelected();
      return;
    }

    switch (drawerFocusRef.current) {
      case "start":
        launchSelected();
        return;
      case "trophies":
        openTrophies();
        return;
      case "launch_options":
        openLaunchOptions();
        return;
      case "refresh_art":
        if (refreshingArtwork || busy) return;
        playConfirm();
        void refreshArtwork();
        return;
      case "pin_game":
        togglePin();
        return;
      case "remove_game":
        // Pendant la confirmation, la rangée Oui / Non remplace le bouton.
        if (pendingDeleteId) {
          confirmDelete();
          return;
        }
        onRequestDelete();
        return;
    }
  }

  drawerKeyDownRef.current = (event) => {
    if (hasSystemModifier(event)) return;
    if (isTypingTarget(event.target)) return;

    const id = event.key.toLowerCase();
    const up = id === "arrowup" || id === "z";
    const down = id === "arrowdown" || id === "s";
    const left = id === "arrowleft" || id === "q";
    const right = id === "arrowright" || id === "d";
    const confirm = id === "a" || event.key === "Enter";
    const back = id === "b" || id === "escape" || id === "backspace";
    if (!up && !down && !left && !right && !confirm && !back) return;

    // Zone verrouillée : aucun raccourci global (ruban, lancement) ne passe.
    event.preventDefault();
    event.stopImmediatePropagation();

    if (back) {
      if (pendingDeleteId) cancelDelete();
      else backToRibbon();
      return;
    }
    if (confirm) {
      if (event.repeat) return;
      activateDrawerFocus();
      return;
    }

    // Appui maintenu : répétition lente, comme la croix directionnelle.
    const now = performance.now();
    if (event.repeat && now - lastDrawerNav.current < 160) return;
    lastDrawerNav.current = now;

    drawerStep(up ? "up" : down ? "down" : left ? "left" : "right");
  };

  // Écouteur en phase capture : il passe avant le hook gamepad global d'App,
  // qui sinon change de jeu (et ferme le tiroir) sur Gauche / Droite.
  useEffect(() => {
    if (level !== "info" || inputBlocked) return;
    const onKeyDown = (event: KeyboardEvent) => drawerKeyDownRef.current(event);
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [level, inputBlocked]);

  headerKeyDownRef.current = (event) => {
    if (hasSystemModifier(event)) return;
    if (isTypingTarget(event.target)) return;

    const id = event.key.toLowerCase();
    const up = id === "arrowup" || id === "z" || id === "w";
    const down = id === "arrowdown" || id === "s";
    // A reste la validation : la gauche clavier est Q ou la flèche.
    const left = id === "arrowleft" || id === "q";
    const right = id === "arrowright" || id === "d";
    const confirm = id === "a" || id === "enter";
    const back = id === "b" || id === "escape" || id === "backspace";
    if (!up && !down && !left && !right && !confirm && !back) return;

    // Zone verrouillée : aucun raccourci global (ruban, lancement) ne passe.
    event.preventDefault();
    event.stopImmediatePropagation();

    if (back || down) {
      // Un appui maintenu ne doit pas enchaîner plusieurs sorties.
      if (event.repeat) return;
      leaveHeader();
      return;
    }
    if (confirm) {
      if (!event.repeat) activateHeader();
      return;
    }
    if (up) return;

    // Appui maintenu : répétition lente, comme la croix directionnelle.
    const now = performance.now();
    if (event.repeat && now - lastHeaderNav.current < 160) return;
    lastHeaderNav.current = now;
    moveHeader(left ? -1 : 1);
  };

  // Capture : ce listener passe avant le hook gamepad global d'App.
  useEffect(() => {
    if (level !== "system" || inputBlocked) return;
    const onKeyDown = (event: KeyboardEvent) => headerKeyDownRef.current(event);
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [level, inputBlocked]);

  function toggleBgm() {
    if (bgmMuted) {
      // Réactiver d'abord : le clic de confirmation doit être audible.
      setBgmMuted(toggleMuteBgm());
      playNav();
      return;
    }
    playNav();
    setBgmMuted(toggleMuteBgm());
  }

  function togglePin() {
    if (!selected || isPermanentTile(selected) || busy) return;
    playConfirm();
    onTogglePin(selected.id);
  }

  async function refreshArtwork() {
    if (!selected || isPermanentTile(selected) || refreshingArtwork) return;
    setRefreshingArtwork(true);
    try {
      const list = await invoke<Game[]>("fetch_game_artwork", {
        gameId: selected.id,
      });
      setLiveGames(Object.fromEntries(list.map((game) => [game.id, game])));
      playNotification();
      setReports((previous) => {
        const next = { ...previous };
        delete next[selected.id];
        return next;
      });
    } catch (cause) {
      playError();
      setLocalError(String(cause));
    } finally {
      setRefreshingArtwork(false);
    }
  }

  /**
   * Saut direct sur le ruban (gâchettes) : l'index est borné entre le
   * PlayStation Store (0) et la tuile Bibliothèque (dernière tuile).
   */
  function jumpRibbon(index: number) {
    if (displayGames.length === 0) return;
    const next = Math.max(0, Math.min(displayGames.length - 1, index));
    if (next === activeIndex) return;
    playNav();
    onSelect(next);
  }

  // Gauche/Droite sont gérés par App sur le ruban et par la barre de fonctions
  // quand le focus est dans le menu du haut.
  useGamepad({
    onLeft:
      inputBlocked || level !== "system" ? undefined : () => moveHeader(-1),
    onRight:
      inputBlocked || level !== "system" ? undefined : () => moveHeader(1),
    onUp:
      inputBlocked || level === "system"
        ? undefined
        : () => {
            if (level === "info") drawerStep("up");
            else {
              playNav();
              setLevel("system");
            }
          },
    onDown: inputBlocked
      ? undefined
      : () => {
          if (level === "info") drawerStep("down");
          else if (level === "system") leaveHeader();
          else if (selected) openInfo();
        },
    onConfirm: inputBlocked
      ? undefined
      : level === "system"
        ? activateHeader
        : level === "info"
          ? activateDrawerFocus
          : launchSelected,
    onOptions: inputBlocked
      ? undefined
      : level === "system"
        ? openProfile
        : () => {
            if (level === "info") {
              playBack();
              setLevel("ribbon");
            } else openInfo();
          },
    onBack: inputBlocked
      ? undefined
      : () => {
          // Rond annule d'abord la confirmation de suppression, sans quitter le tiroir.
          if (pendingDeleteId) {
            playBack();
            onCancelDelete();
          } else if (level === "system") {
            leaveHeader();
          } else if (level !== "ribbon") {
            playBack();
            setLevel("ribbon");
          }
        },
    // Gâchettes uniquement sur le ruban : le menu du haut et le tiroir gardent
    // leur navigation propre.
    onL1:
      inputBlocked || level !== "ribbon"
        ? undefined
        : () => jumpRibbon(activeIndex - 4),
    onR1:
      inputBlocked || level !== "ribbon"
        ? undefined
        : () => jumpRibbon(activeIndex + 4),
    onL2:
      inputBlocked || level !== "ribbon" ? undefined : () => jumpRibbon(0),
    onR2:
      inputBlocked || level !== "ribbon"
        ? undefined
        : () => jumpRibbon(displayGames.length - 1),
  });

  return (
    <div className="ps4-app relative h-screen w-screen select-none overflow-hidden text-white antialiased">
      {/* Fond Flow : monté une seule fois, jamais re-créé pendant la navigation. */}
      <Ps4FlowBackground paused={isOccludedByGameBg || appHidden} />

      {/* Calque des fonds de jeux au-dessus du Flow : z-1. */}
      <div
        className="pointer-events-none absolute inset-0 z-[1]"
        aria-hidden="true"
      >
        {/* Ancienne image, sous-couche du fondu entre deux jeux uniquement. */}
        {underBackground ? (
          <div
            className="absolute inset-0 bg-cover bg-center"
            style={{ backgroundImage: `url("${underBackground}")` }}
          />
        ) : null}

        {selectedBackground ? (
          <div
            key={selectedBackground}
            className="ps4-game-bg absolute inset-0 bg-cover bg-center"
            style={{ backgroundImage: `url("${selectedBackground}")` }}
          />
        ) : null}

        <div
          className={`absolute inset-0 transition-colors duration-500 ${
            systemFocused
              ? "bg-[#020b20]/75"
              : selectedBackground
                ? "bg-[#020b20]/10"
                : "bg-transparent"
          }`}
        />
        <div className="ps4-shade-top absolute inset-0" />
        {selectedBackground ? (
          <div className="ps4-shade-game absolute inset-0" />
        ) : null}
        <div className="ps4-vignette absolute inset-0" />
      </div>

      {/* Mise à jour système : bandeau PS4 en haut à gauche, affiché jusqu'au
          clic. Le son système accompagne son apparition. */}
      {systemUpdate ? (
        <div className="absolute left-0 top-8 z-[55] w-[21rem]" style={SST_STYLE}>
          <button
            type="button"
            onClick={() => void installSystemUpdate()}
            disabled={installingUpdate}
            title={
              updateError ??
              "Mise à jour du logiciel système disponible — Cliquez pour installer"
            }
            className="pointer-events-auto relative flex w-full items-center gap-3 rounded-r-xl bg-[#101828]/90 py-3 pl-5 pr-6 text-left shadow-[0_18px_40px_rgba(0,0,0,0.55)] backdrop-blur-md transition hover:bg-[#1b2b4b]/90 disabled:cursor-default"
          >
            <span
              aria-hidden="true"
              className="absolute left-0 top-1/2 h-11 w-[3px] -translate-y-1/2 rounded-r-full bg-white"
            />
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10 text-white">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden="true">
                <path
                  d="M12 4.2v8.6m0 0 3.4-3.4M12 12.8 8.6 9.4"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M4.8 15.2v2.4a2 2 0 0 0 2 2h10.4a2 2 0 0 0 2-2v-2.4"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-bold leading-tight text-white">
                Mise à jour du logiciel système disponible
              </span>
              <span className="mt-0.5 block truncate text-xs font-normal text-white/65">
                {updateError
                  ? "Échec de l'installation — cliquez pour réessayer"
                  : installingUpdate
                    ? "Installation en cours…"
                    : "Cliquez pour installer"}
              </span>
            </span>
          </button>
        </div>
      ) : null}

      <div className="ps4-screen z-10">
        {/* Zone 1 — barre système */}
        <header className="ps4-topbar">
          <div className="ps4-top-left">
            <button
              type="button"
              onClick={openTrophies}
              onMouseEnter={() => focusHeader(0)}
              disabled={!canOpenTrophies}
              title={
                canOpenTrophies
                  ? "Trophées du jeu sélectionné"
                  : "Sélectionnez un jeu avec un AppID Steam"
              }
              style={{ transition: HEADER_TRANSITION }}
              className={`ps4-top-button rounded-[calc(6*var(--u))] border-2 px-[calc(14*var(--u))] py-[calc(8*var(--u))] ${headerFocusClass(0)}`}
            >
              <img
                src="/trophies/hide.png"
                alt=""
                className="ps4-top-icon object-contain brightness-0 invert"
              />
              <span>Trophées</span>
            </button>

            <button
              type="button"
              onClick={addGame}
              onMouseEnter={() => focusHeader(1)}
              disabled={busy}
              style={{ transition: HEADER_TRANSITION }}
              className={`ps4-top-button rounded-[calc(6*var(--u))] border-2 px-[calc(14*var(--u))] py-[calc(8*var(--u))] ${headerFocusClass(1)}`}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
                strokeLinecap="round"
                className={`ps4-plus ${
                  systemFocused && headerIndex === 1 ? "!text-white" : ""
                }`}
                aria-hidden="true"
              >
                <path d="M12 5.5v13M5.5 12h13" />
              </svg>
              <span>Ajouter un jeu</span>
            </button>
          </div>

          <div className="ps4-top-right">
            <button
              type="button"
              onClick={openProfile}
              onMouseEnter={() => focusHeader(2)}
              title={
                profile
                  ? `${profile.username} — En ligne`
                  : "Profil du joueur"
              }
              aria-label="Ouvrir le profil du joueur"
              style={{ transition: HEADER_TRANSITION }}
              className={`ps4-user flex items-center gap-[calc(18*var(--u))] rounded-[calc(6*var(--u))] border-2 py-[calc(4*var(--u))] pl-[calc(4*var(--u))] pr-[calc(16*var(--u))] hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70 ${headerFocusClass(2)}`}
            >
              <span className="ps4-avatar overflow-hidden">
                {profile?.avatar_data_url ? (
                  <img
                    src={avatarSrc(profile.avatar_data_url) ?? ""}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  (profile?.username ?? "Thibault").slice(0, 1).toUpperCase()
                )}
              </span>
              <span className="ps4-username">
                {profile?.username ?? "Thibault"}
              </span>
              <span
                className="ps4-online"
                style={{
                  background: "#3ddc84",
                  boxShadow: "0 0 calc(10 * var(--u)) rgba(61, 220, 132, 0.9)",
                }}
                aria-hidden="true"
              />
            </button>

            <button
              type="button"
              onClick={openAudio}
              onMouseEnter={() => focusHeader(3)}
              title="Paramètres audio et égaliseur"
              aria-label="Paramètres audio et égaliseur"
              aria-pressed={bgmMuted}
              style={{ transition: HEADER_TRANSITION }}
              className={`ps4-top-icon-button rounded-[calc(6*var(--u))] border-2 px-[calc(10*var(--u))] py-[calc(6*var(--u))] ${headerFocusClass(3)}`}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="ps4-mute-icon"
                aria-hidden="true"
              >
                <path d="M4 9.5h3.5L13 5.5v13L7.5 14.5H4z" />
                {bgmMuted ? (
                  <path d="M17 9.5l5 5M22 9.5l-5 5" />
                ) : (
                  <>
                    <path d="M16.5 9a4.2 4.2 0 0 1 0 6" />
                    <path d="M19.2 6.5a8 8 0 0 1 0 11" />
                  </>
                )}
              </svg>
            </button>

            {batteryLevel !== null ? (
              <ControllerBattery level={batteryLevel} />
            ) : null}
            <Ps4Clock />

            <button
              type="button"
              onClick={() => void quitApplication()}
              onMouseEnter={() => focusHeader(4)}
              title="Alimentation"
              aria-label="Alimentation"
              style={{ transition: HEADER_TRANSITION }}
              className={`ps4-top-icon-button rounded-[calc(6*var(--u))] border-2 px-[calc(10*var(--u))] py-[calc(6*var(--u))] ${headerFocusClass(4)}`}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
                strokeLinecap="round"
                className="h-[calc(40*var(--u))] w-[calc(40*var(--u))]"
                aria-hidden="true"
              >
                <path d="M12 3.2v8.6" />
                <path d="M7.4 6.1a7.4 7.4 0 1 0 9.2 0" />
              </svg>
            </button>
          </div>
        </header>

        <main className="ps4-main">
          {/* Zone 2 — ruban principal */}
          <div
            className={`ps4-ribbon ${
              level === "info"
                ? "is-hidden"
                : level === "system"
                  ? "is-dimmed"
                  : ""
            }`}
            inert={level === "info" ? true : undefined}
          >
            {/* Piste défilante : la tuile active reste ancrée à gauche. */}
            <div
              ref={ribbonRef}
              className="ps4-ribbon-track"
              style={{ transition: "none" }}
            >
              {displayGames.map((game, index) => {
                const active = index === activeIndex;
                return (
                  <button
                    key={game.id}
                    type="button"
                    ref={(element) => {
                      tileRefs.current[index] = element;
                    }}
                    onClick={() => selectGame(index)}
                    aria-label={
                      isPermanentTile(game)
                        ? `Ouvrir ${game.title}`
                        : active
                          ? `Informations sur ${game.title}`
                          : `Sélectionner ${game.title}`
                    }
                    aria-current={active ? "true" : undefined}
                    className={`ps4-tile ${
                      active
                        ? "brightness-100"
                        : "brightness-90 hover:brightness-100"
                    }`}
                    style={{
                      transformOrigin: "top left",
                      transition: "border-color 200ms ease, filter 200ms ease",
                      willChange: "transform, opacity",
                    }}
                  >
                    {game.cover_url ? (
                      <img
                        src={game.cover_url}
                        alt=""
                        draggable={false}
                        className="h-full w-full object-cover object-top"
                        style={{ objectPosition: "top" }}
                      />
                    ) : (
                      <span className="ps4-tile-fallback" aria-hidden="true">
                        {game.title.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                  </button>
                );
              })}

              {/* Cases vides décoratives : elles comblent le ruban sans interaction. */}
              {Array.from({ length: emptySlots }, (_, index) => (
                <div
                  key={`empty-${index}`}
                  ref={(element) => {
                    tileRefs.current[displayGames.length + index] = element;
                  }}
                  className="ps4-empty"
                  style={{
                    transformOrigin: "top left",
                    willChange: "transform, opacity",
                  }}
                  aria-hidden
                />
              ))}
            </div>

            {/* Cadre blanc : bordure, halo et bouton Démarrer de la tuile phare.
                La barre de fonctions prend le relais quand elle a le focus. */}
            <div className={`ps4-phare ${selected && !systemFocused ? "" : "hidden"}`}>
              <div className="ps4-phare-border" aria-hidden="true" />
              <div
                className="ps4-start-slot"
                style={{
                  maxHeight: startDeployed ? du(90) : 0,
                  opacity: startDeployed ? 1 : 0,
                  transform: startDeployed
                    ? "translateY(0)"
                    : `translateY(${du(-8)})`,
                  transition:
                    "max-height 360ms cubic-bezier(0.16, 1, 0.3, 1), opacity 360ms cubic-bezier(0.16, 1, 0.3, 1), transform 360ms cubic-bezier(0.16, 1, 0.3, 1)",
                  pointerEvents: startDeployed ? "auto" : "none",
                }}
              >
                <button
                  type="button"
                  onClick={launchSelected}
                  disabled={busy || !selected}
                  className="ps4-start"
                >
                  {busy ? "Lancement…" : "Démarrer"}
                </button>
              </div>
            </div>

            <div className="ps4-title-slot">
              {selected ? (
                <h1
                  key={selectedId}
                  className="ps4-title"
                  style={{
                    animationDuration: "360ms",
                    animationTimingFunction:
                      "cubic-bezier(0.16, 1, 0.3, 1)",
                  }}
                >
                  {selected.title}
                </h1>
              ) : null}
            </div>
          </div>

          {/* Zone 3 — tiroir d'informations */}
          <div
            className="ps4-info"
            data-open={level === "info" ? "true" : "false"}
            aria-hidden={level !== "info"}
            inert={level === "info" ? undefined : true}
          >
            <div className="ps4-info-shade" aria-hidden="true" />

            {selected ? (
              <div ref={infoScrollRef} className="ps4-info-scroll">
                <div className="ps4-info-head">
                  <div className="min-w-0">
                    <p className="ps4-info-eyebrow">Jeu</p>
                    <h2 className="ps4-info-title">{selected.title}</h2>
                  </div>
                  <button
                    type="button"
                    onClick={backToRibbon}
                    className="ps4-back"
                  >
                    <img
                      src="/buttons/PS4_Circle.png"
                      alt=""
                      className="h-[calc(28*var(--u))] w-[calc(28*var(--u))] shrink-0 object-contain"
                    />
                    Retour
                  </button>
                </div>

                <div className="ps4-info-sep" aria-hidden="true" />

                <div className="ps4-info-body">
                  <div className="ps4-info-cover-col">
                    <div className="ps4-info-cover">
                      {selected.cover_url ? (
                        <img
                          src={selected.cover_url}
                          alt=""
                          draggable={false}
                          className="h-full w-full object-cover object-top"
                          style={{ objectPosition: "top" }}
                        />
                      ) : (
                        <span
                          className="ps4-info-cover-fallback"
                          aria-hidden="true"
                        >
                          {selected.title.slice(0, 1).toUpperCase()}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={launchSelected}
                      onPointerMove={() => focusDrawerFromPointer("start")}
                      disabled={busy}
                      className={`ps4-info-start ${
                        drawerFocus === "start" ? DRAWER_FOCUS_STYLE : ""
                      }`}
                    >
                      {busy ? "Lancement…" : "Démarrer"}
                    </button>
                  </div>

                  <div className="ps4-info-details">
                    <>
                    <div className="ps4-playtime">
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={1.6}
                        className="ps4-playtime-icon"
                        aria-hidden="true"
                      >
                        <circle cx="12" cy="12" r="9" />
                        <path
                          d="M12 7v5l3 2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      <span>
                        Temps de jeu :{" "}
                        {formatPlaytime(selected.playtime_seconds)}
                      </span>
                    </div>

                    <button
                      type="button"
                      onClick={openTrophies}
                      onPointerMove={() => focusDrawerFromPointer("trophies")}
                      disabled={!canOpenTrophies}
                      className={`ps4-trophy-panel ${
                        drawerFocus === "trophies" ? DRAWER_FOCUS_STYLE : ""
                      }`}
                    >
                      <div className="ps4-trophy-head">
                        <div className="ps4-trophy-label">
                          <img
                            src="/trophies/hide.png"
                            alt=""
                            className="ps4-trophy-icon brightness-0 invert opacity-90"
                          />
                          <span>Trophées</span>
                        </div>
                        <span className="ps4-trophy-progress-value">
                          {selectedReport
                            ? `${selectedReport.progress.toFixed(1)} %`
                            : canOpenTrophies
                              ? "…"
                              : "—"}
                        </span>
                      </div>

                      <div className="ps4-progress">
                        <div
                          className="ps4-progress-fill"
                          style={{ width: `${selectedReport?.progress ?? 0}%` }}
                        />
                      </div>

                      <div className="ps4-trophy-counts">
                        {TROPHY_COUNTS.map((item) => (
                          <div key={item.key} className="ps4-trophy-count">
                            <img src={item.icon} alt="" />
                            <strong>
                              {selectedReport?.counts[item.key] ?? 0}
                            </strong>
                            <span>{item.label}</span>
                          </div>
                        ))}
                      </div>

                      <p className="ps4-trophy-note">
                        {canOpenTrophies
                          ? "Ouvrir la liste des trophées"
                          : "Actualisez les jaquettes pour détecter l'AppID Steam"}
                      </p>
                    </button>

                    <button
                      type="button"
                      onClick={() => openLaunchOptions()}
                      onPointerMove={() =>
                        focusDrawerFromPointer("launch_options")
                      }
                      disabled={busy}
                      className={`mt-[calc(20*var(--u))] flex w-full flex-col gap-[calc(8*var(--u))] border-2 border-white/30 bg-black/25 px-[calc(28*var(--u))] py-[calc(20*var(--u))] text-left transition hover:border-white/85 hover:bg-white/10 disabled:opacity-50 ${
                        drawerFocus === "launch_options"
                          ? DRAWER_FOCUS_STYLE
                          : ""
                      }`}
                    >
                      <span className="flex w-full min-w-0 items-center justify-between gap-[calc(24*var(--u))]">
                        <span className="flex min-w-0 flex-1 items-center gap-[calc(14*var(--u))] pr-[calc(8*var(--u))] text-[calc(28*var(--u))]">
                          <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={1.5}
                            strokeLinecap="round"
                            className="h-[calc(34*var(--u))] w-[calc(34*var(--u))] shrink-0 text-white/85"
                            aria-hidden="true"
                          >
                            <path d="M4 7h8M18 7h2M4 12h3M13 12h7M4 17h8M18 17h2" />
                            <circle cx="15" cy="7" r="3" />
                            <circle cx="10" cy="12" r="3" />
                            <circle cx="15" cy="17" r="3" />
                          </svg>
                          <span className="min-w-0 truncate">
                            Options de lancement et emplacement
                          </span>
                        </span>
                        <span className="shrink-0 text-[calc(22*var(--u))] text-white/55">
                          Configurer
                        </span>
                      </span>
                      <span
                        className={`truncate pl-[calc(48*var(--u))] text-[calc(22*var(--u))] ${
                          selectedLaunchArgs
                            ? "text-white/75"
                            : "text-white/45"
                        }`}
                      >
                        {selectedLaunchArgs || "Aucun argument personnalisé"}
                      </span>
                    </button>

                    <div className="ps4-info-actions">
                      <button
                        type="button"
                        onClick={refreshArtwork}
                        onPointerMove={() =>
                          focusDrawerFromPointer("refresh_art")
                        }
                        disabled={refreshingArtwork || busy}
                        className={`ps4-info-action ${
                          drawerFocus === "refresh_art" ? DRAWER_FOCUS_STYLE : ""
                        }`}
                      >
                        {refreshingArtwork
                          ? "Actualisation…"
                          : "Actualiser les jaquettes"}
                      </button>

                      <button
                        type="button"
                        onClick={togglePin}
                        onPointerMove={() => focusDrawerFromPointer("pin_game")}
                        disabled={busy}
                        className={`ps4-info-action ${
                          drawerFocus === "pin_game" ? DRAWER_FOCUS_STYLE : ""
                        }`}
                      >
                        {selected.pinned
                          ? "Désépingler du ruban"
                          : "Épingler en tête du ruban"}
                      </button>

                      {confirming ? (
                        <div className="ps4-delete-confirm">
                          <span>Supprimer ?</span>
                          <button
                            type="button"
                            onClick={confirmDelete}
                            disabled={busy}
                            className="ps4-info-action is-danger"
                          >
                            Oui
                          </button>
                          <button
                            type="button"
                            onClick={cancelDelete}
                            className="ps4-info-action"
                          >
                            Non
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={requestDelete}
                          onPointerMove={() =>
                            focusDrawerFromPointer("remove_game")
                          }
                          disabled={busy}
                          className={`ps4-info-action is-danger ${
                            drawerFocus === "remove_game"
                              ? DRAWER_FOCUS_STYLE
                              : ""
                          }`}
                        >
                          Supprimer du launcher
                        </button>
                      )}
                    </div>
                      </>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </main>

        <footer className="ps4-footer">
          <div className="ps4-hints">
            {systemFocused ? (
              <>
                <span className="ps4-hint">
                  <img
                    src="/buttons/PS4_Cross.png"
                    alt=""
                    className={HINT_ICON}
                  />
                  Sélectionner
                </span>
                <span className="ps4-hint">
                  <img
                    src="/buttons/PS4_Dpad.png"
                    alt=""
                    className={HINT_ICON}
                  />
                  Naviguer
                </span>
                <span className="ps4-hint">
                  <img
                    src="/buttons/PS4_Circle.png"
                    alt=""
                    className={HINT_ICON}
                  />
                  Retour
                </span>
              </>
            ) : level === "info" ? (
              <>
                <span className="ps4-hint">
                  <img
                    src="/buttons/PS4_Cross.png"
                    alt=""
                    className={HINT_ICON}
                  />
                  Sélectionner
                </span>
                <span className="ps4-hint">
                  <img
                    src="/buttons/PS4_Circle.png"
                    alt=""
                    className={HINT_ICON}
                  />
                  Retour
                </span>
              </>
            ) : selectedIsPermanent ? (
              // Tuile permanente : ni Informations (Bas) ni Options (Triangle).
              <span className="ps4-hint">
                <img
                  src="/buttons/PS4_Cross.png"
                  alt=""
                  className={HINT_ICON}
                />
                Démarrer
              </span>
            ) : (
              <>
                <span className="ps4-hint">
                  <img
                    src="/buttons/PS4_Cross.png"
                    alt=""
                    className={HINT_ICON}
                  />
                  Démarrer
                </span>
                <span className="ps4-hint">
                  <img
                    src="/buttons/PS4_Dpad_Down.png"
                    alt=""
                    className={HINT_ICON}
                  />
                  Informations
                </span>
                <span className="ps4-hint">
                  <img
                    src="/buttons/PS4_Triangle.png"
                    alt=""
                    className={HINT_ICON}
                  />
                  Options
                </span>
              </>
            )}
          </div>
        </footer>

        {error || localError ? (
          <div className="ps4-notification" role="alert">
            <span className="ps4-notification-icon" aria-hidden="true">
              !
            </span>
            <div>
              <p className="ps4-notification-title">Erreur</p>
              <p className="ps4-notification-detail">
                {localError ?? error}
              </p>
            </div>
          </div>
        ) : null}
      </div>

      {audioOpen ? (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-[#010817]/70 p-4 backdrop-blur-[2px]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="audio-title"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeAudio();
          }}
        >
          <div
            style={SST_STYLE}
            className="max-h-[92vh] w-[410px] max-w-[90vw] overflow-y-auto rounded-[22px] border border-sky-400/25 bg-gradient-to-b from-[#0b2a66]/90 via-[#071b44]/92 to-[#041029]/95 p-4 text-sky-50 shadow-[0_20px_50px_rgba(0,12,36,0.85),inset_0_1px_1px_rgba(125,211,252,0.3)] backdrop-blur-2xl"
          >
            <div className="flex items-start justify-between gap-2.5">
              <div>
                <h2
                  id="audio-title"
                  style={SST_STYLE}
                  className="text-sm font-semibold leading-tight tracking-[-0.01em]"
                >
                  Paramètres audio
                </h2>
                <p
                  style={SST_STYLE}
                  className="mt-0.5 text-xs text-sky-200/55"
                >
                  Égaliseur · aperçu en direct
                </p>
              </div>
              <button
                type="button"
                onClick={closeAudio}
                aria-label="Fermer les paramètres audio"
                style={SST_STYLE}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-sky-300/25 bg-sky-400/10 text-sky-100/70 transition-all duration-200 ease-out hover:bg-sky-400/20 hover:text-white"
              >
                <svg
                  viewBox="0 0 24 24"
                  className="h-3 w-3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>

            <div className="mt-3 rounded-2xl border border-sky-300/15 bg-[#0f347a]/35 p-3 shadow-[inset_0_1px_1px_rgba(125,211,252,0.18)]">
              <h3
                style={SST_STYLE}
                className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-sky-200/45"
              >
                Niveaux généraux
              </h3>

              <div className="space-y-2.5">
                <div
                  role="switch"
                  aria-checked={!bgmMuted}
                  tabIndex={-1}
                  onMouseEnter={() => focusAudioRow(0)}
                  onClick={() => {
                    focusAudioRow(0);
                    toggleBgm();
                  }}
                  style={SST_STYLE}
                  className={`flex cursor-pointer items-center justify-between gap-2.5 rounded-xl border px-2.5 py-1.5 outline-none transition-all duration-200 ease-out ${audioSectionClass(0)}`}
                >
                  <span style={SST_STYLE} className="text-sm text-sky-50/85">
                    Muet
                  </span>
                  <span
                    aria-hidden="true"
                    className={`relative h-6 w-10 shrink-0 rounded-full border transition-all duration-200 ease-out ${
                      bgmMuted
                        ? "border-sky-300/20 bg-[#05173a]/80"
                        : "border-sky-200/40 bg-gradient-to-r from-[#0072ce] to-[#00a2ff] shadow-[0_0_10px_rgba(0,162,255,0.45)]"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 h-5 w-5 rounded-full bg-gradient-to-b from-white to-sky-100 shadow-[0_1px_3px_rgba(0,12,36,0.45)] transition-transform duration-200 ease-out ${
                        bgmMuted ? "translate-x-0.5" : "translate-x-[18px]"
                      }`}
                    />
                  </span>
                </div>

                <div
                  onMouseEnter={() => focusAudioRow(1)}
                  onClick={() => focusAudioRow(1)}
                  style={SST_STYLE}
                  className={`rounded-xl border px-2.5 py-1.5 transition-all duration-200 ease-out ${audioSectionClass(1)}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      style={SST_STYLE}
                      className="text-xs text-sky-100/70"
                    >
                      Musique de thème
                    </span>
                    <span
                      style={SST_STYLE}
                      className="text-xs tabular-nums text-sky-200/60"
                    >
                      {Math.round(audioSettings.themeVolume * 100)} %
                    </span>
                  </div>
                  <div className="mt-1.5 flex items-center">
                    <GlassSlider
                      label="Volume de la musique de thème"
                      value={Math.round(audioSettings.themeVolume * 100)}
                      onFocus={() => focusAudioRow(1)}
                      onChange={(value) => {
                        setAudioSettingsState(
                          updateAudioSettings({ themeVolume: value / 100 }),
                        );
                      }}
                    />
                  </div>
                </div>

                <div
                  onMouseEnter={() => focusAudioRow(2)}
                  onClick={() => focusAudioRow(2)}
                  style={SST_STYLE}
                  className={`rounded-xl border px-2.5 py-1.5 transition-all duration-200 ease-out ${audioSectionClass(2)}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      style={SST_STYLE}
                      className="text-xs text-sky-100/70"
                    >
                      Effets système
                    </span>
                    <span
                      style={SST_STYLE}
                      className="text-xs tabular-nums text-sky-200/60"
                    >
                      {Math.round(audioSettings.effectsVolume * 100)} %
                    </span>
                  </div>
                  <div className="mt-1.5 flex items-center">
                    <GlassSlider
                      label="Volume des effets système"
                      value={Math.round(audioSettings.effectsVolume * 100)}
                      onFocus={() => focusAudioRow(2)}
                      onChange={(value) => {
                        setAudioSettingsState(
                          updateAudioSettings({ effectsVolume: value / 100 }),
                        );
                      }}
                    />
                  </div>
                </div>

                <div
                  role="switch"
                  aria-checked={audioSettings.normalization}
                  tabIndex={-1}
                  onMouseEnter={() => focusAudioRow(3)}
                  onClick={() => {
                    focusAudioRow(3);
                    toggleNormalization();
                  }}
                  style={SST_STYLE}
                  className={`flex cursor-pointer items-center justify-between gap-2.5 rounded-xl border px-2.5 py-1.5 outline-none transition-all duration-200 ease-out ${audioSectionClass(3)}`}
                >
                  <span
                    style={SST_STYLE}
                    className="text-sm text-sky-50/85"
                  >
                    Normalisation auto
                  </span>
                  <span
                    aria-hidden="true"
                    className={`relative h-6 w-10 shrink-0 rounded-full border transition-all duration-200 ease-out ${
                      audioSettings.normalization
                        ? "border-sky-200/40 bg-gradient-to-r from-[#0072ce] to-[#00a2ff] shadow-[0_0_10px_rgba(0,162,255,0.45)]"
                        : "border-sky-300/20 bg-[#05173a]/80"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 h-5 w-5 rounded-full bg-gradient-to-b from-white to-sky-100 shadow-[0_1px_3px_rgba(0,12,36,0.45)] transition-transform duration-200 ease-out ${
                        audioSettings.normalization
                          ? "translate-x-[18px]"
                          : "translate-x-0.5"
                      }`}
                    />
                  </span>
                </div>
              </div>
            </div>

            <div className="mt-2.5 rounded-2xl border border-sky-300/15 bg-[#0f347a]/35 p-3 shadow-[inset_0_1px_1px_rgba(125,211,252,0.18)]">
              <div className="flex items-center justify-between gap-2">
                <h3
                  style={SST_STYLE}
                  className="text-xs font-semibold uppercase tracking-[0.16em] text-sky-200/45"
                >
                  Égaliseur
                </h3>
                <span
                  style={SST_STYLE}
                  className="text-xs text-sky-200/35"
                >
                  3 bandes
                </span>
              </div>

              <div
                onMouseEnter={() => focusAudioRow(4)}
                onClick={() => focusAudioRow(4)}
                style={SST_STYLE}
                className={`mt-2 flex gap-0.5 rounded-full border p-0.5 transition-all duration-200 ease-out ${
                  audioIndex === 4
                    ? "border-sky-300/40 bg-[#0f347a]/70 shadow-[0_0_0_1px_rgba(125,211,252,0.25),0_0_18px_rgba(0,114,206,0.35)]"
                    : "border-sky-300/15 bg-[#041029]/45"
                }`}
              >
                {EQ_PRESETS.map((preset) => {
                  const active =
                    audioSettings.eqLow === preset.low &&
                    audioSettings.eqMid === preset.mid &&
                    audioSettings.eqHigh === preset.high;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => {
                        focusAudioRow(4);
                        setAudioSettingsState(applyEqPreset(preset.id));
                        playNav();
                      }}
                      onMouseEnter={() => focusAudioRow(4)}
                      style={SST_STYLE}
                      className={`flex-1 rounded-full px-1.5 py-1 text-xs font-medium transition-all duration-200 ease-out ${
                        active
                          ? "bg-gradient-to-b from-sky-300/35 via-sky-400/20 to-sky-500/15 text-white shadow-[inset_0_1px_1px_rgba(186,230,253,0.5)]"
                          : "text-sky-100/60 hover:text-white"
                      }`}
                    >
                      {preset.id === "deep" ? "Basses +" : preset.label}
                    </button>
                  );
                })}
              </div>

              <div className="mt-3 flex items-start justify-around gap-1.5">
                {(
                  [
                    {
                      index: 5,
                      band: "low",
                      label: "Basses",
                      freq: "120 Hz",
                      value: audioSettings.eqLow,
                    },
                    {
                      index: 6,
                      band: "mid",
                      label: "Médiums",
                      freq: "1 kHz",
                      value: audioSettings.eqMid,
                    },
                    {
                      index: 7,
                      band: "high",
                      label: "Aigus",
                      freq: "8 kHz",
                      value: audioSettings.eqHigh,
                    },
                  ] as const
                ).map((band) => (
                  <div
                    key={band.band}
                    className="flex w-20 flex-col items-center"
                    onMouseEnter={() => focusAudioRow(band.index)}
                  >
                    <span
                      style={SST_STYLE}
                      className="mb-1 text-xs tabular-nums text-sky-100/80"
                    >
                      {band.value > 0 ? `+${band.value}` : band.value} dB
                    </span>
                    <GlassFader
                      label={`${band.label} ${band.freq}`}
                      value={band.value}
                      active={audioIndex === band.index}
                      onFocus={() => focusAudioRow(band.index)}
                      onChange={(value) => setAudioBand(band.band, value)}
                    />
                    <span
                      style={SST_STYLE}
                      className="mt-1.5 text-xs text-sky-50/85"
                    >
                      {band.label}
                    </span>
                    <span
                      style={SST_STYLE}
                      className="text-xs text-sky-200/40"
                    >
                      {band.freq}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-3 flex items-center justify-between gap-2 text-xs text-sky-200/40">
              <span style={SST_STYLE}>↑↓ · ←→ · glisser</span>
              <span
                style={SST_STYLE}
                className="flex items-center gap-1.5"
              >
                <img
                  src="/buttons/PS4_Circle.png"
                  alt=""
                  className="h-3.5 w-3.5 object-contain opacity-80"
                />
                Fermer
              </span>
            </div>
          </div>
        </div>
      ) : null}

      {libraryOpen ? (
        <Ps4LibraryView
          games={allGames.map((game) => liveGames[game.id] ?? game)}
          getGamepads={realGamepads.current}
          paused={optionsOpen || launchingGame !== null}
          onClose={() => setLibraryOpen(false)}
          onLaunch={launchFromLibrary}
          onOptions={(game) => openLaunchOptions(game)}
        />
      ) : null}

      {optionsOpen && optionsGame ? (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 px-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby="launch-options-title"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeLaunchOptions();
          }}
        >
          <div className="w-full max-w-[calc(920*var(--u))] border-2 border-white/35 bg-gradient-to-b from-[#003078]/95 to-[#001233]/95 px-[calc(46*var(--u))] py-[calc(38*var(--u))] shadow-[0_0_calc(60*var(--u))_rgba(0,0,0,0.55)]">
            <p className="text-[calc(18*var(--u))] uppercase tracking-[0.35em] text-white/55">
              Jeu
            </p>
            <h2
              id="launch-options-title"
              className="mt-[calc(8*var(--u))] text-[calc(44*var(--u))] font-light leading-none tracking-wide"
            >
              Options de lancement et emplacement
            </h2>
            <p className="mt-[calc(10*var(--u))] truncate text-[calc(22*var(--u))] text-white/60">
              {optionsGame.title}
            </p>

            <div
              className="mt-[calc(26*var(--u))] h-[calc(2*var(--u))] bg-white/35"
              aria-hidden="true"
            />

            <label className="mt-[calc(24*var(--u))] block">
              <span className="text-[calc(20*var(--u))] uppercase tracking-[0.22em] text-white/55">
                Arguments passés à l'exécutable
              </span>
              <input
                ref={optionsInputRef}
                value={optionsDraft}
                onChange={(event) => setOptionsDraft(event.target.value)}
                onFocus={() => setOptionsCursor(0)}
                placeholder="Ex : -dx11 -novid -windowed"
                spellCheck={false}
                autoComplete="off"
                className={`mt-[calc(12*var(--u))] w-full border-[3px] bg-black/35 px-[calc(22*var(--u))] py-[calc(14*var(--u))] text-[calc(30*var(--u))] font-light tracking-wide outline-none transition placeholder:text-white/35 ${
                  optionsCursor === 0
                    ? "border-white shadow-[0_0_calc(28*var(--u))_rgba(255,255,255,0.55)]"
                    : "border-white/45"
                }`}
              />
            </label>

            <p className="mt-[calc(14*var(--u))] text-[calc(20*var(--u))] text-white/50">
              Séparez les arguments par des espaces. Utilisez des guillemets
              pour les valeurs qui en contiennent.
            </p>

            <div className="mt-[calc(24*var(--u))]">
              <span className="text-[calc(20*var(--u))] uppercase tracking-[0.22em] text-white/55">
                Emplacement du fichier
              </span>
              {/* Lecture seule : le champ est un input, donc les raccourcis
                  ZQSD / A / B / Y / X de Ps4Home sont ignorés pendant la
                  sélection (Ctrl+C / Cmd+C passent tels quels). */}
              <div className="mt-[calc(12*var(--u))] flex items-stretch gap-[calc(12*var(--u))]">
                <input
                  ref={optionsPathRef}
                  type="text"
                  readOnly
                  tabIndex={-1}
                  value={optionsGame.exe_path}
                  aria-label="Emplacement du fichier"
                  spellCheck={false}
                  autoComplete="off"
                  onFocus={(event) => {
                    // Le focus souris dans la case n'active aucun élément du
                    // parcours : on retire l'encadré blanc des boutons.
                    setOptionsCursor(-1);
                    event.currentTarget.select();
                  }}
                  onClick={(event) => event.currentTarget.select()}
                  onKeyDown={(event) => {
                    // Champ en lecture seule : les flèches et ZQSD relancent
                    // aussitôt la navigation au lieu d'y rester bloquées.
                    const id = event.key.toLowerCase();
                    const toArgs =
                      id === "arrowup" ||
                      id === "z" ||
                      id === "arrowleft" ||
                      id === "q";
                    const toCopy =
                      id === "arrowdown" ||
                      id === "s" ||
                      id === "arrowright" ||
                      id === "d";
                    if (!toArgs && !toCopy) return;
                    event.preventDefault();
                    event.stopPropagation();
                    playNav();
                    focusOptionItem(toArgs ? 0 : 1);
                  }}
                  className="min-w-0 flex-1 cursor-text select-all overflow-x-auto whitespace-nowrap border border-white/25 bg-black/35 px-[calc(18*var(--u))] py-[calc(12*var(--u))] text-[calc(20*var(--u))] text-white/90 outline-none transition [scrollbar-width:thin] focus:border-white"
                />
                <button
                  ref={optionsCopyRef}
                  type="button"
                  onClick={() => void copyGamePath()}
                  onFocus={() => setOptionsCursor(1)}
                  disabled={!optionsGame.exe_path}
                  className={`min-w-[calc(150*var(--u))] shrink-0 border-[3px] px-[calc(20*var(--u))] py-[calc(10*var(--u))] text-[calc(24*var(--u))] outline-none transition disabled:opacity-40 ${
                    optionsCursor === 1
                      ? "border-white bg-[#00439c]/70 shadow-[0_0_calc(26*var(--u))_rgba(255,255,255,0.5)]"
                      : "border-transparent bg-white/10 hover:border-white hover:bg-[#00439c]/60"
                  }`}
                >
                  {copiedAt !== null ? "Copié ✓" : "Copier"}
                </button>
              </div>
            </div>

            <div className="mt-[calc(14*var(--u))] min-h-[calc(26*var(--u))] text-[calc(20*var(--u))] text-red-200">
              {optionsError}
            </div>

            <div className="mt-[calc(16*var(--u))] flex flex-wrap items-center gap-[calc(18*var(--u))]">
              <button
                ref={optionsSaveRef}
                type="button"
                onClick={() => saveOptionsRef.current()}
                onFocus={() => setOptionsCursor(2)}
                disabled={savingOptions}
                className={`flex items-center gap-[calc(12*var(--u))] border-[3px] px-[calc(28*var(--u))] py-[calc(12*var(--u))] text-[calc(26*var(--u))] outline-none transition disabled:opacity-50 ${
                  optionsCursor === 2
                    ? "border-white bg-[#00439c]/70 shadow-[0_0_calc(26*var(--u))_rgba(255,255,255,0.5)]"
                    : "border-transparent bg-white/10 hover:border-white hover:bg-[#00439c]/60"
                }`}
              >
                <img
                  src="/buttons/PS4_Cross.png"
                  alt=""
                  className="h-[calc(30*var(--u))] w-[calc(30*var(--u))] shrink-0 object-contain"
                />
                {savingOptions ? "Enregistrement…" : "Enregistrer"}
              </button>

              <button
                ref={optionsCancelRef}
                type="button"
                onClick={closeLaunchOptions}
                onFocus={() => setOptionsCursor(3)}
                className={`flex items-center gap-[calc(12*var(--u))] border-[3px] px-[calc(28*var(--u))] py-[calc(12*var(--u))] text-[calc(26*var(--u))] outline-none transition ${
                  optionsCursor === 3
                    ? "border-white bg-[#00439c]/70 shadow-[0_0_calc(26*var(--u))_rgba(255,255,255,0.5)]"
                    : "border-transparent bg-white/10 hover:border-white hover:bg-[#00439c]/60"
                }`}
              >
                <img
                  src="/buttons/PS4_Circle.png"
                  alt=""
                  className="h-[calc(30*var(--u))] w-[calc(30*var(--u))] shrink-0 object-contain"
                />
                Annuler
              </button>

              <button
                type="button"
                onClick={() => void regenerateTheme()}
                onFocus={() => setOptionsCursor(-1)}
                disabled={savingOptions || regeneratingTheme}
                className="ml-auto text-[calc(20*var(--u))] text-white/50 underline-offset-4 outline-none transition hover:text-white hover:underline disabled:opacity-40"
              >
                {regeneratingTheme
                  ? "Régénération de la musique…"
                  : "Régénérer la musique auto"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {trophyToast ? (
        <div
          role="status"
          aria-live="polite"
          className={`fixed right-8 top-8 z-[65] flex w-[440px] items-center gap-4 rounded-[3px] border border-white/70 bg-gradient-to-b from-[#001b3d]/95 to-[#000a1c]/95 px-5 py-4 shadow-[0_14px_44px_rgba(0,0,0,0.65)] backdrop-blur transition duration-300 ${
            toastVisible
              ? "translate-y-0 opacity-100"
              : "-translate-y-3 opacity-0"
          }`}
          style={{ fontFamily: "'SST', sans-serif" }}
        >
          <img
            src={
              trophyToast.icon ||
              (TROPHY_GRADES[trophyToast.rank] ?? TROPHY_GRADES.bronze).icon
            }
            alt=""
            className="h-14 w-14 shrink-0 object-contain"
          />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] uppercase tracking-[0.28em] text-white/60">
              Trophée obtenu
            </p>
            <p className="mt-1 truncate text-[20px] font-medium leading-tight text-white">
              {trophyToast.name}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 border-l border-white/20 pl-4">
            <img
              src={
                (TROPHY_GRADES[trophyToast.rank] ?? TROPHY_GRADES.bronze).icon
              }
              alt=""
              className="h-7 w-7 object-contain"
            />
            <span className="text-[14px] text-white/85">
              {(TROPHY_GRADES[trophyToast.rank] ?? TROPHY_GRADES.bronze).label}
            </span>
          </div>
        </div>
      ) : null}

      {trophiesOpen && selected ? (
        <TrophyModal
          game={selected}
          onClose={() => {
            setModalGuard(true);
            setTrophiesOpen(false);
          }}
        />
      ) : null}

      {launchingGame ? <Ps4SplashScreen game={launchingGame} /> : null}

      {profileOpen ? (
        <ProfileModal
          profile={
            profile ?? {
              username: "Thibault",
              bio: "En ligne",
              avatar_data_url: null,
              steamgriddb_api_key: "",
              steam_id: "",
              steam_api_key: "",
            }
          }
          games={displayGames}
          onProfileChange={setProfile}
          onClose={() => {
            setModalGuard(true);
            setProfileOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}
