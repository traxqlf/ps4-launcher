import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type WheelEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  playBack,
  playConfirm,
  playDialogYes,
  playError,
  playNav,
  playSystemMessage,
} from "../utils/ps4Audio";
import {
  hasSystemModifier,
  isMenuKey,
  isTypingTarget,
} from "../hooks/useGamepad";
import type { TrophyReport } from "./TrophyModal";
import type { Game, UserProfile } from "../types";
import { avatarSrc, invalidateAvatarCache } from "../utils/avatar";

interface ProfileModalProps {
  profile: UserProfile;
  games: Game[];
  onProfileChange: (profile: UserProfile) => void;
  onClose: () => void;
}

type TrophyKey = "platinum" | "gold" | "silver" | "bronze";

// Zones de texte du Profil : elles ne prennent le focus DOM qu'en mode édition.
type EditingField = "username" | "sgdb" | "steamId" | "steamKey";

function textFieldAt(index: number): EditingField | null {
  if (index === 2) return "username";
  if (index === 3) return "sgdb";
  if (index === 4) return "steamId";
  if (index === 5) return "steamKey";
  return null;
}

/**
 * Position statique d'un élément dans le rail. `offsetTop` ignore le
 * `translate3d` du rail : la mesure reste stable pendant toute la transition
 * CSS, sans boucle de recalcul entre la position et l'offset.
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

const TROPHY_ROWS: { key: TrophyKey; label: string; icon: string }[] = [
  { key: "platinum", label: "Platine", icon: "/trophies/platinum.png" },
  { key: "gold", label: "Or", icon: "/trophies/gold.png" },
  { key: "silver", label: "Argent", icon: "/trophies/silver.png" },
  { key: "bronze", label: "Bronze", icon: "/trophies/bronze.png" },
];

const HINT_ICON = "h-6 w-6 shrink-0 object-contain";
const ITEM_COUNT = 7;

// Curseur PS4 : bordure blanche épaisse, fond bleu PSN et halo.
const SELECTED =
  "border-[3px] border-white bg-[#00439c]/60 shadow-[0_0_22px_rgba(255,255,255,0.55)]";
const IDLE =
  "border-2 border-white/30 bg-[#001b44]/50 hover:border-[3px] hover:border-white hover:bg-[#00439c]/60 hover:shadow-[0_0_22px_rgba(255,255,255,0.5)]";

function formatHours(seconds: number): string {
  if (seconds <= 0) return "0 h";
  return `${(seconds / 3600).toFixed(1).replace(".", ",")} h`;
}

function PlayerSilhouette() {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="currentColor"
      className="h-full w-full text-white/45"
      aria-hidden="true"
    >
      <circle cx="32" cy="22" r="11" />
      <path d="M32 37c10.5 0 19 6.3 19 14.5V57H13v-5.5C13 43.3 21.5 37 32 37z" />
    </svg>
  );
}

export function ProfileModal({
  profile,
  games,
  onProfileChange,
  onClose,
}: ProfileModalProps) {
  const [username, setUsername] = useState(profile.username);
  const [avatar, setAvatar] = useState(profile.avatar_data_url);
  const [sgdbKey, setSgdbKey] = useState(profile.steamgriddb_api_key ?? "");
  const [steamId, setSteamId] = useState(profile.steam_id ?? "");
  const [steamKey, setSteamKey] = useState(profile.steam_api_key ?? "");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{
    counts: Record<TrophyKey, number>;
    unlocked: number;
    total: number;
  } | null>(null);
  const [cursor, setCursor] = useState(0);
  // `null` = curseur PS4 seul ; sinon la zone de texte capte le clavier.
  const [editingField, setEditingField] = useState<EditingField | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);
  // Position du rail vertical : le contenu glisse en bloc, comme le ruban.
  const [offsetY, setOffsetY] = useState(0);
  const wheelAtRef = useRef(0);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const editingFieldRef = useRef<EditingField | null>(null);
  editingFieldRef.current = editingField;
  // Les effets clavier/manette sont posés une seule fois : on passe par des
  // refs pour toujours appeler la version à jour (sinon pseudo/statut figés).
  const saveProfileRef = useRef<() => void>(() => {});
  const changeAvatarRef = useRef<() => void>(() => {});
  const activateRef = useRef<(index: number) => void>(() => {});
  const endEditRef = useRef<(kind: "confirm" | "cancel") => void>(() => {});

  const realGamepads = useRef<(() => (Gamepad | null)[]) | null>(null);
  if (realGamepads.current === null) {
    realGamepads.current = navigator.getGamepads
      ? navigator.getGamepads.bind(navigator)
      : null;
  }

  const closeRef = useRef<() => void>(() => {});
  closeRef.current = () => {
    if (closing) return;
    setClosing(true);
    playBack();
    window.setTimeout(onClose, 200);
  };

  const totalSeconds = games.reduce(
    (sum, game) => sum + game.playtime_seconds,
    0,
  );
  const progress =
    summary && summary.total > 0 ? (summary.unlocked / summary.total) * 100 : 0;
  const appidKey = [
    ...new Set(
      games.flatMap((game) => (game.steam_appid ? [game.steam_appid] : [])),
    ),
  ]
    .sort()
    .join(",");

  useEffect(() => {
    panelRef.current?.focus();
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Somme des trophées débloqués, jeu Steam par jeu Steam (cache Rust en secours).
  useEffect(() => {
    let cancelled = false;
    const appids = appidKey ? appidKey.split(",") : [];
    Promise.all(
      // `markNew: false` : ce simple compteur ne doit pas consommer les
      // notifications de trophées de l'écran d'accueil.
      appids.map((steamAppid) =>
        invoke<TrophyReport>("get_game_trophies", {
          steamAppid,
          markNew: false,
        }).catch(() => null),
      ),
    ).then((reports) => {
      if (cancelled) return;
      const counts: Record<TrophyKey, number> = {
        platinum: 0,
        gold: 0,
        silver: 0,
        bronze: 0,
      };
      let unlocked = 0;
      let total = 0;
      for (const report of reports) {
        if (!report) continue;
        counts.platinum += report.counts.platinum;
        counts.gold += report.counts.gold;
        counts.silver += report.counts.silver;
        counts.bronze += report.counts.bronze;
        unlocked += report.unlocked;
        total += report.total;
      }
      setSummary({ counts, unlocked, total });
    });
    return () => {
      cancelled = true;
    };
  }, [appidKey]);

  // Le hook gamepad global d'App écoute encore Croix/Rond : on lui masque les
  // manettes pour que valider un champ ne lance pas un jeu en arrière-plan.
  useEffect(() => {
    const target = navigator as Navigator & {
      getGamepads?: () => (Gamepad | null)[];
    };
    if (!target.getGamepads) return;
    target.getGamepads = () => [];
    return () => {
      delete (target as { getGamepads?: unknown }).getGamepads;
    };
  }, []);

  /**
   * Navigation PS4 : les zones de texte ne reçoivent JAMAIS le focus DOM ici,
   * sinon elles capturent Bas/S et bloquent l'accès aux champs suivants.
   */
  function focusItem(index: number) {
    setCursor(index);
    if (textFieldAt(index)) {
      (document.activeElement as HTMLElement | null)?.blur?.();
      return;
    }
    itemRefs.current[index]?.focus({ preventScroll: true });
  }

  function moveCursor(delta: number) {
    playNav();
    focusItem((cursorRef.current + delta + ITEM_COUNT) % ITEM_COUNT);
  }

  /** Molette : même pas que Haut/Bas, avec un anti-rebond de 60 ms. */
  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    // Pendant l'édition, la caméra reste verrouillée sur le champ courant.
    if (editingFieldRef.current) return;
    if (Math.abs(event.deltaY) < 4) return;
    const time = performance.now();
    if (time - wheelAtRef.current < 60) return;
    wheelAtRef.current = time;
    moveCursor(event.deltaY > 0 ? 1 : -1);
  }

  /** Croix / A / Entrée / clic : passage en édition, focus au tick suivant. */
  function beginEdit(field: EditingField, index: number) {
    setCursor(index);
    if (editingFieldRef.current === field) return;
    playDialogYes();
    setEditingField(field);
    window.requestAnimationFrame(() => {
      const input = itemRefs.current[index] as HTMLInputElement | null;
      if (!input) return;
      input.focus({ preventScroll: true });
      const end = input.value.length;
      input.setSelectionRange(end, end);
    });
  }

  /** Entrée / Échap / Rond : on quitte l'édition en gardant la même ligne. */
  function endEdit(kind: "confirm" | "cancel") {
    if (!editingFieldRef.current) return;
    if (kind === "confirm") playDialogYes();
    else playBack();
    setEditingField(null);
    (document.activeElement as HTMLElement | null)?.blur?.();
  }

  function activate(index: number) {
    if (index === 0 || index === 1) {
      changeAvatarRef.current();
      return;
    }
    if (index === 6) {
      saveProfileRef.current();
      return;
    }
    const field = textFieldAt(index);
    if (field) {
      beginEdit(field, index);
      return;
    }
    playConfirm();
    itemRefs.current[index]?.focus({ preventScroll: true });
  }

  // Rail vertical : l'élément actif est placé au point focal (~35 % du haut),
  // puis tout le contenu se déplace en une seule transformation GPU. Seuls
  // `offsetTop` / `offsetHeight` sont lus : jamais de rect au sein du rail
  // animé, et le calcul ne se relance qu'au changement de curseur ou de
  // hauteur de fenêtre (aucune dépendance à `offsetY`).
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const rail = railRef.current;
    if (!viewport || !rail) return;

    const update = () => {
      const target = itemRefs.current[cursorRef.current];
      if (!target) {
        setOffsetY(0);
        return;
      }
      const topInRail = offsetWithinRail(target, rail);
      const focusLine = viewport.clientHeight * 0.35;
      const desired = topInRail + target.offsetHeight / 2 - focusLine;
      const max = Math.max(0, rail.offsetHeight - viewport.clientHeight);
      setOffsetY(Math.min(max, Math.max(0, desired)));
    };

    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [cursor]);

  // Manette : Haut/Bas navigue, Croix valide, Rond ferme. Le polling lit la
  // vraie API (realGamepads) alors qu'elle est masquée pour les autres hooks.
  useEffect(() => {
    let frame = 0;
    let lastNav = 0;
    let lastConfirm = false;
    let lastBack = false;

    const tick = (time: number) => {
      frame = requestAnimationFrame(tick);
      const pads = realGamepads.current?.() ?? [];
      let up = false;
      let down = false;
      let confirm = false;
      let back = false;

      for (const pad of pads) {
        if (!pad?.connected) continue;
        const axisY = pad.axes[1] ?? 0;
        // Zone morte stricte : le stick au repos ne doit jamais faire défiler.
        const stickUp = Math.abs(axisY) > 0.55 && axisY < 0;
        const stickDown = Math.abs(axisY) > 0.55 && axisY > 0;
        up = up || Boolean(pad.buttons[12]?.pressed) || stickUp;
        down = down || Boolean(pad.buttons[13]?.pressed) || stickDown;
        confirm = confirm || Boolean(pad.buttons[0]?.pressed);
        back = back || Boolean(pad.buttons[1]?.pressed);
      }

      // En édition, la manette ne déplace plus le curseur : Croix valide,
      // Rond termine la saisie sans fermer la fenêtre Profil.
      if (editingFieldRef.current) {
        if (confirm && !lastConfirm) endEditRef.current("confirm");
        if (back && !lastBack) endEditRef.current("cancel");
        lastConfirm = confirm;
        lastBack = back;
        return;
      }

      if ((up || down) && time - lastNav >= 180) {
        lastNav = time;
        moveCursor(up ? -1 : 1);
      }
      if (confirm && !lastConfirm) activateRef.current(cursorRef.current);
      if (back && !lastBack) closeRef.current();
      lastConfirm = confirm;
      lastBack = back;
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (hasSystemModifier(event)) return;
      const id = event.key.toLowerCase();

      // Mode édition : seules Entrée (valider) et Échap (terminer) sortent du
      // champ. Z/Q/S/D, flèches, espace, suppression et caractères restent au
      // texte, sans aucune navigation de menu.
      if (editingFieldRef.current) {
        if (id === "enter") {
          event.preventDefault();
          event.stopImmediatePropagation();
          endEditRef.current("confirm");
          return;
        }
        if (id === "escape") {
          event.preventDefault();
          event.stopImmediatePropagation();
          endEditRef.current("cancel");
          return;
        }
        return;
      }

      if (isTypingTarget(event.target)) {
        // Champ readOnly encore focalisé par un clic : aucune capture de menu.
        return;
      }

      if (event.key === "Enter") {
        // Entrée valide la ligne courante (et bloque le lancement global).
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) activateRef.current(cursorRef.current);
        return;
      }
      if (!isMenuKey(id)) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      // Une action ne part qu'une fois par pression (contrairement aux directions).
      const isDirection =
        id === "arrowup" || id === "z" || id === "arrowdown" || id === "s";
      if (event.repeat && !isDirection) return;

      if (id === "a") {
        activateRef.current(cursorRef.current);
        return;
      }
      if (id === "b" || id === "escape") {
        closeRef.current();
        return;
      }
      if (id === "arrowup" || id === "z") {
        moveCursor(-1);
        return;
      }
      if (id === "arrowdown" || id === "s") moveCursor(1);
      // q, d, x, y, o : avalés, aucune action dans cette fenêtre.
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function changeAvatar() {
    if (uploading) return;
    playConfirm();
    setUploading(true);
    setError(null);
    try {
      const path = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
      });
      if (typeof path !== "string") return;
      const next = await invoke<UserProfile>("update_avatar", {
        filePath: path,
      });
      invalidateAvatarCache();
      setAvatar(next.avatar_data_url);
      onProfileChange(next);
      setNotice("Avatar mis à jour");
      playSystemMessage();
    } catch (cause) {
      playError();
      setError(String(cause));
    } finally {
      setUploading(false);
    }
  }

  async function saveProfile() {
    if (saving) return;
    const trimmed = username.trim();
    if (!trimmed) {
      playError();
      setError("Le pseudo ne peut pas être vide.");
      return;
    }
    playDialogYes();
    setSaving(true);
    setError(null);
    try {
      const next = await invoke<UserProfile>("update_profile", {
        username: trimmed,
        bio: "En ligne",
        steamgriddbApiKey: sgdbKey,
        steamId: steamId.trim(),
        steamApiKey: steamKey.trim(),
      });
      setUsername(next.username);
      setSgdbKey(next.steamgriddb_api_key ?? "");
      setSteamId(next.steam_id ?? "");
      setSteamKey(next.steam_api_key ?? "");
      onProfileChange(next);
      setNotice("Profil enregistré");
      playSystemMessage();
    } catch (cause) {
      playError();
      setError(String(cause));
    } finally {
      setSaving(false);
    }
  }

  saveProfileRef.current = () => {
    void saveProfile();
  };
  changeAvatarRef.current = () => {
    void changeAvatar();
  };
  activateRef.current = activate;
  endEditRef.current = endEdit;

  const clock = now.toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const cursorOnTextField = textFieldAt(cursor) !== null;

  return (
    <div
      className={`fixed inset-0 z-[70] flex flex-col bg-gradient-to-b from-[#001b44] via-[#003078] to-[#001233] text-white transition-opacity duration-200 ${
        visible && !closing ? "opacity-100" : "opacity-0"
      }`}
      onWheel={handleWheel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="profile-title"
    >
      <header className="flex items-start justify-between gap-8 border-b border-white/25 px-6 py-7 md:px-16">
        <div>
          <p className="text-[18px] uppercase tracking-[0.4em] text-white/55">
            PlayStation Network
          </p>
          <h1
            id="profile-title"
            className="mt-2 text-[40px] font-light leading-none tracking-wide"
          >
            Profil
          </h1>
        </div>

        <div className="flex items-center gap-8">
          <time className="text-[24px] font-light tabular-nums">{clock}</time>
          <button
            type="button"
            onClick={() => closeRef.current()}
            className="flex items-center gap-3 border-2 border-transparent px-4 py-2 text-[20px] text-white/80 transition hover:border-[3px] hover:border-white hover:bg-[#00439c]/60 hover:text-white hover:shadow-[0_0_22px_rgba(255,255,255,0.5)]"
          >
            <img src="/buttons/PS4_Circle.png" alt="" className={HINT_ICON} />
            Fermer
          </button>
        </div>
      </header>

      <main
        ref={panelRef}
        tabIndex={-1}
        className="relative flex-1 overflow-hidden outline-none"
      >
        <div ref={viewportRef} className="absolute inset-0 overflow-hidden">
          <div
            ref={railRef}
            className="relative px-6 py-8 will-change-transform transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] md:px-16 md:py-10"
            style={{ transform: `translate3d(0, -${offsetY}px, 0)` }}
          >
            <div className="grid gap-10 lg:grid-cols-[minmax(0,420px)_1fr] lg:gap-16">
          <div>
            <div className="flex items-start gap-6">
              <div className="relative h-[130px] w-[130px] shrink-0">
                <button
                  ref={(element) => {
                    itemRefs.current[0] = element;
                  }}
                  type="button"
                  onClick={changeAvatar}
                  disabled={uploading}
                  onFocus={() => setCursor(0)}
                  aria-label="Modifier l'avatar"
                  className={`block h-full w-full overflow-hidden rounded-[2px] border-[3px] border-white transition disabled:opacity-60 ${
                    cursor === 0
                      ? "bg-[#00439c]/60 shadow-[0_0_22px_rgba(255,255,255,0.55)]"
                      : "bg-white/10 shadow-[0_0_22px_rgba(255,255,255,0.35)] hover:bg-[#00439c]/60 hover:shadow-[0_0_28px_rgba(255,255,255,0.65)]"
                  }`}
                >
                  {avatar ? (
                    <img
                      src={avatarSrc(avatar) ?? ""}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <PlayerSilhouette />
                  )}
                </button>
                <span
                  className="pointer-events-none absolute -bottom-1 -right-1 h-7 w-7 rounded-full border-[3px] border-[#001b44] bg-emerald-400 shadow-[0_0_14px_rgba(52,211,153,0.9)]"
                  title="En ligne"
                />
              </div>

              <div className="min-w-0">
                <p className="text-[18px] uppercase tracking-[0.25em] text-white/55">
                  Joueur
                </p>
                <p className="mt-2 truncate text-[40px] font-light leading-none tracking-wide">
                  {username.trim() || "Thibault"}
                </p>
                <p className="mt-3 flex items-center gap-2 text-[19px] text-white/70">
                  <span className="h-4 w-4 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.9)]" />
                  <span className="truncate">En ligne</span>
                </p>
              </div>
            </div>

            <button
              ref={(element) => {
                itemRefs.current[1] = element;
              }}
              type="button"
              onClick={changeAvatar}
              disabled={uploading}
              onFocus={() => setCursor(1)}
              className={`mt-7 w-full rounded-[2px] px-8 py-4 text-[22px] font-medium outline-none transition disabled:opacity-60 ${
                cursor === 1 ? SELECTED : IDLE
              }`}
            >
              {uploading ? "Importation…" : "Modifier l'avatar"}
            </button>

            <div className="mt-10 space-y-7">
              <label className="block">
                <span className="text-[18px] uppercase tracking-[0.22em] text-white/55">
                  Pseudo
                </span>
                <input
                  ref={(element) => {
                    itemRefs.current[2] = element;
                  }}
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  onFocus={() => setCursor(2)}
                  onClick={() => beginEdit("username", 2)}
                  onBlur={() => {
                    if (editingField === "username") setEditingField(null);
                  }}
                  readOnly={editingField !== "username"}
                  tabIndex={-1}
                  maxLength={40}
                  className={`mt-3 w-full rounded-[2px] px-5 py-3 text-[40px] font-light tracking-wide outline-none transition ${
                    cursor === 2 ? SELECTED : IDLE
                  }`}
                />
              </label>

              <div className="border-t border-white/20 pt-7">
                <label className="block">
                  <span className="text-[18px] leading-snug uppercase tracking-[0.22em] text-white/55">
                    Clé API SteamGridDB (jaquettes 4K optionnelles)
                  </span>
                  <input
                    ref={(element) => {
                      itemRefs.current[3] = element;
                    }}
                    value={sgdbKey}
                    onChange={(event) => setSgdbKey(event.target.value)}
                    onFocus={() => setCursor(3)}
                    onClick={() => beginEdit("sgdb", 3)}
                    onBlur={() => {
                      if (editingField === "sgdb") setEditingField(null);
                    }}
                    readOnly={editingField !== "sgdb"}
                    tabIndex={-1}
                    maxLength={64}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="Jeton personnel SteamGridDB"
                    className={`mt-3 w-full rounded-[2px] px-5 py-3 text-[24px] tracking-wide outline-none transition placeholder:text-[20px] placeholder:text-white/30 ${
                      cursor === 3 ? SELECTED : IDLE
                    }`}
                  />
                </label>
                <p className="mt-3 text-[16px] leading-snug text-white/55">
                  {sgdbKey.trim()
                    ? "Les prochaines actualisations téléchargent la meilleure jaquette et le fond 4K (3840 × 1240) de SteamGridDB."
                    : "Sans clé, les visuels Retina officiels du CDN Steam (600 × 900 et 3840 × 1240) sont utilisés."}
                </p>
              </div>

              <div className="border-t border-white/20 pt-7">
                <span className="text-[18px] leading-snug uppercase tracking-[0.22em] text-white/55">
                  Synchronisation Steam (optionnel)
                </span>

                <label className="mt-4 block">
                  <span className="text-[15px] uppercase tracking-[0.18em] text-white/45">
                    SteamID64
                  </span>
                  <input
                    ref={(element) => {
                      itemRefs.current[4] = element;
                    }}
                    value={steamId}
                    onChange={(event) => setSteamId(event.target.value)}
                    onFocus={() => setCursor(4)}
                    onClick={() => beginEdit("steamId", 4)}
                    onBlur={() => {
                      if (editingField === "steamId") setEditingField(null);
                    }}
                    readOnly={editingField !== "steamId"}
                    tabIndex={-1}
                    maxLength={17}
                    spellCheck={false}
                    autoComplete="off"
                    inputMode="numeric"
                    placeholder="7656119…"
                    className={`mt-2 w-full rounded-[2px] px-5 py-3 text-[24px] tracking-wide outline-none transition placeholder:text-[20px] placeholder:text-white/30 ${
                      cursor === 4 ? SELECTED : IDLE
                    }`}
                  />
                </label>

                <label className="mt-5 block">
                  <span className="text-[15px] uppercase tracking-[0.18em] text-white/45">
                    Clé Web API Steam
                  </span>
                  <input
                    ref={(element) => {
                      itemRefs.current[5] = element;
                    }}
                    value={steamKey}
                    onChange={(event) => setSteamKey(event.target.value)}
                    onFocus={() => setCursor(5)}
                    onClick={() => beginEdit("steamKey", 5)}
                    onBlur={() => {
                      if (editingField === "steamKey") setEditingField(null);
                    }}
                    readOnly={editingField !== "steamKey"}
                    tabIndex={-1}
                    maxLength={64}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="32 caractères hexadécimaux"
                    className={`mt-2 w-full rounded-[2px] px-5 py-3 text-[24px] tracking-wide outline-none transition placeholder:text-[20px] placeholder:text-white/30 ${
                      cursor === 5 ? SELECTED : IDLE
                    }`}
                  />
                </label>

                <p className="mt-3 text-[16px] leading-snug text-white/55">
                  Avec ces deux valeurs, les trophées sont croisés avec votre
                  compte Steam (titres français, icônes officielles et dates de
                  déblocage). Les fichiers de sauvegarde locaux restent lus dans
                  tous les cas.
                </p>
              </div>
            </div>

            <button
              ref={(element) => {
                itemRefs.current[6] = element;
              }}
              type="button"
              onClick={() => {
                saveProfileRef.current();
              }}
              disabled={saving}
              onFocus={() => setCursor(6)}
              className={`mt-8 w-full rounded-[2px] px-8 py-4 text-[22px] font-medium outline-none transition disabled:opacity-60 ${
                cursor === 6 ? SELECTED : IDLE
              }`}
            >
              {saving ? "Enregistrement…" : "Enregistrer"}
            </button>

            <div className="mt-5 min-h-[28px] text-[18px]">
              {notice ? (
                <span className="text-emerald-300">{notice}</span>
              ) : error ? (
                <span className="text-red-300">{error}</span>
              ) : null}
            </div>
          </div>

          <div>
            <section className="border-b border-white/25 pb-9">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <h2 className="text-[36px] font-light leading-none tracking-wide">
                  Trophées
                </h2>
                <p className="text-[40px] font-light leading-none tabular-nums">
                  {summary ? `${Math.round(progress)} %` : "…"}
                </p>
              </div>

              <div className="mt-5 h-3 w-full bg-white/20">
                <div
                  className="h-full bg-white transition-[width] duration-500"
                  style={{ width: `${progress}%` }}
                />
              </div>

              <div className="mt-8 grid grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-4">
                {TROPHY_ROWS.map((row) => (
                  <div key={row.key} className="flex items-center gap-3">
                    <img
                      src={row.icon}
                      alt=""
                      className="h-9 w-9 object-contain"
                    />
                    <div>
                      <p className="text-[24px] font-medium leading-none tabular-nums">
                        {summary ? summary.counts[row.key] : "…"}
                      </p>
                      <p className="mt-1.5 text-[18px] text-white/60">
                        {row.label}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="mt-8">
              <h2 className="text-[36px] font-light leading-none tracking-wide">
                Temps de jeu total
              </h2>
              <p className="mt-4 text-[44px] font-light leading-none tabular-nums">
                {formatHours(totalSeconds)}
              </p>
              <p className="mt-3 text-[19px] text-white/60">
                {games.length} jeu{games.length > 1 ? "x" : ""} installé
                {games.length > 1 ? "s" : ""}
              </p>
            </section>
          </div>
            </div>
          </div>
        </div>
      </main>

      <footer className="border-t border-white/25 px-6 py-5 md:px-16">
        <div className="flex flex-wrap items-center gap-x-10 gap-y-3 text-[18px] text-white/85">
          {editingField ? (
            <>
              <span className="flex items-center gap-3">
                <span className="rounded-[4px] border border-white/40 bg-white/10 px-2 py-0.5 text-[15px] tracking-wide">
                  Enter
                </span>
                Valider
              </span>
              <span className="flex items-center gap-3">
                <img
                  src="/buttons/PS4_Circle.png"
                  alt=""
                  className={HINT_ICON}
                />
                Terminer
              </span>
            </>
          ) : cursorOnTextField ? (
            <>
              <span className="flex items-center gap-3">
                <img
                  src="/buttons/PS4_Cross.png"
                  alt=""
                  className={HINT_ICON}
                />
                Modifier
              </span>
              <span className="flex items-center gap-3">
                <img
                  src="/buttons/PS4_Circle.png"
                  alt=""
                  className={HINT_ICON}
                />
                Retour
              </span>
            </>
          ) : (
            <>
              <span className="flex items-center gap-3">
                <img
                  src="/buttons/PS4_Cross.png"
                  alt=""
                  className={HINT_ICON}
                />
                Sélectionner
              </span>
              <span className="flex items-center gap-2">
                <img
                  src="/buttons/PS4_Dpad_Up.png"
                  alt=""
                  className={HINT_ICON}
                />
                <img
                  src="/buttons/PS4_Dpad_Down.png"
                  alt=""
                  className={HINT_ICON}
                />
                Naviguer
              </span>
              <span className="flex items-center gap-3">
                <img
                  src="/buttons/PS4_Circle.png"
                  alt=""
                  className={HINT_ICON}
                />
                Fermer
              </span>
            </>
          )}
        </div>
      </footer>
    </div>
  );
}
