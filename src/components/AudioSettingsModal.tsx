/* Paramètres audio — panneau latéral droit du Menu rapide PS4 (Orbis OS).

   Panneau plein écran à droite, gradient bleu roi PlayStation translucide et
   flouté, lignes posées à même le fond et séparées par de fins filets blancs.
   Un unique cadre blanc glisse d'une ligne à l'autre avec le même ressort
   critiquement amorti que le bandeau de jeux de l'accueil (translate3d).

   La navigation (manette, clavier) reste pilotée par `Ps4Home` via `index` et
   `onFocusRow` : ce composant ne gère que le rendu et les gestes souris. */

import { useEffect, useRef, useState } from "react";
import { getInputMode, shouldIgnoreClick } from "../hooks/useGamepad";
import {
  EQ_PRESETS,
  previewEffectsVolume,
  type AudioSettings,
  type EqPresetId,
} from "../utils/ps4Audio";

// Police unique du projet : SST, appliquée en inline sur chaque contrôle.
const SST_STYLE = { fontFamily: "'SST', sans-serif" } as const;

// Glissement du panneau : même courbe d'inertie que la piste du ruban.
const ANIM_MS = 320;
const ANIM_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

/* Cadre de sélection : mêmes constantes de ressort que le bandeau Orbis. */
const FRAME_OMEGA = 15.5;
const FRAME_MAX_DT = 0.032;
// Impulsion initiale : le cadre part avec la réactivité de la console au lieu
// d'attendre que le ressort accélère depuis l'arrêt.
const FRAME_START_IMPULSE = 0.35;

// Bleu électrique Orbis : barres, badges et onglets actifs.
const ORBIS_BLUE = "#0070D1";
const ORBIS_BLUE_LIGHT = "#0082F3";

// Ligne du Menu rapide : surface nue, filet supérieur, focus géré par le cadre.
const ROW_BASE =
  "relative z-10 cursor-pointer border-t border-white/[0.14] px-3 py-3 transition-colors duration-150 ease-out";
const ROW_IDLE = "hover:bg-white/[0.05]";

function rowClass(active: boolean, extra = ""): string {
  return `${ROW_BASE} ${ROW_IDLE} ${active ? "bg-transparent" : ""} ${extra}`;
}

function SectionTitle({ children }: { children: string }) {
  return (
    <p
      style={SST_STYLE}
      className="text-[10px] font-semibold uppercase tracking-[0.26em] text-white/45"
    >
      {children}
    </p>
  );
}

/** Badge carré PS4 : coche blanche + « Activé » / « Désactivé ». */
function StateBadge({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={SST_STYLE}
      className={`flex h-[22px] shrink-0 items-center gap-1.5 rounded-[2px] border px-2 text-[10px] font-semibold uppercase tracking-[0.14em] ${
        on
          ? "border-[#4aa8ff]/80 bg-[#0070D1] text-white shadow-[0_0_10px_rgba(0,130,243,0.45)]"
          : "border-white/30 bg-black/20 text-white/50"
      }`}
    >
      <span
        className={`flex h-[11px] w-[11px] items-center justify-center rounded-[1px] border ${
          on ? "border-white bg-white" : "border-white/40"
        }`}
      >
        {on ? (
          <svg
            viewBox="0 0 12 12"
            className="h-[9px] w-[9px]"
            fill="none"
            stroke="#0b2242"
            strokeWidth="2.4"
            strokeLinecap="square"
          >
            <path d="M2 6.4 4.6 9 10 3.2" />
          </svg>
        ) : null}
      </span>
      {on ? "Activé" : "Désactivé"}
    </span>
  );
}

/** Jauge horizontale PS4 : rail fin, remplissage bleu Orbis, curseur blanc. */
function LevelSlider({
  label,
  value,
  onFocus,
  onChange,
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
      className="relative h-7 flex-1 cursor-pointer touch-none select-none"
    >
      <span className="absolute inset-x-0 top-1/2 h-[4px] -translate-y-1/2 rounded-[1px] bg-white/15" />
      <span
        className="absolute left-0 top-1/2 h-[4px] -translate-y-1/2 rounded-[1px] shadow-[0_0_8px_rgba(0,130,243,0.55)]"
        style={{
          width: `${value}%`,
          background: `linear-gradient(90deg, ${ORBIS_BLUE} 0%, ${ORBIS_BLUE_LIGHT} 100%)`,
        }}
      />
      <span
        className="absolute top-1/2 h-[14px] w-[6px] -translate-y-1/2 rounded-[1px] bg-white shadow-[0_0_8px_rgba(255,255,255,0.55)]"
        style={{
          left: `calc(${value}% + ${3 - 6 * (value / 100)}px)`,
          transform: "translate(-50%, -50%)",
        }}
      />
    </div>
  );
}

/** Fader vertical PS4 : -12…+12 dB depuis le centre, curseur blanc carré. */
function BandFader({
  label,
  value,
  onFocus,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
  onFocus: () => void;
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
      className="relative h-[104px] w-[42px] cursor-pointer touch-none select-none"
    >
      <div className="absolute inset-y-[9px] left-1/2 w-[4px] -translate-x-1/2">
        <span className="absolute inset-0 rounded-[1px] bg-white/15" />
        <span
          aria-hidden="true"
          className="absolute left-1/2 h-px w-[18px] -translate-x-1/2 bg-white/35"
          style={{ top: "50%" }}
        />
        <span
          className="absolute left-0 w-full rounded-[1px] shadow-[0_0_8px_rgba(0,130,243,0.55)]"
          style={
            value >= 0
              ? {
                  bottom: "50%",
                  height: `${ratio * 50}%`,
                  background: `linear-gradient(0deg, ${ORBIS_BLUE} 0%, ${ORBIS_BLUE_LIGHT} 100%)`,
                }
              : {
                  top: "50%",
                  height: `${ratio * 50}%`,
                  background: `linear-gradient(180deg, ${ORBIS_BLUE} 0%, ${ORBIS_BLUE_LIGHT} 100%)`,
                }
          }
        />
        <span
          className="absolute left-1/2 h-[7px] w-[16px] -translate-x-1/2 -translate-y-1/2 rounded-[1px] bg-white shadow-[0_0_8px_rgba(255,255,255,0.55)]"
          style={{ top: `${50 - (value / 12) * 50}%` }}
        />
      </div>
    </div>
  );
}

export interface AudioSettingsModalProps {
  open: boolean;
  index: number;
  settings: AudioSettings;
  muted: boolean;
  onClose: () => void;
  onFocusRow: (index: number) => void;
  onToggleMute: () => void;
  onToggleNormalization: () => void;
  /** 0 → 100, déjà arrondi par le curseur. */
  onThemeVolume: (value: number) => void;
  onEffectsVolume: (value: number) => void;
  onPreset: (id: EqPresetId) => void;
  onBand: (band: "low" | "mid" | "high", value: number) => void;
}

const BANDS = [
  { index: 5, band: "low", label: "Basses", freq: "120 Hz" },
  { index: 6, band: "mid", label: "Médiums", freq: "1 kHz" },
  { index: 7, band: "high", label: "Aigus", freq: "8 kHz" },
] as const;

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

export function AudioSettingsModal({
  open,
  index,
  settings,
  muted,
  onClose,
  onFocusRow,
  onToggleMute,
  onToggleNormalization,
  onThemeVolume,
  onEffectsVolume,
  onPreset,
  onBand,
}: AudioSettingsModalProps) {
  // Le panneau survit à la fermeture pour jouer le glissement GPU.
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);

  /** Survol d'une ligne : ignoré hors mode souris. */
  const hoverRow = (row: number) => {
    if (getInputMode() !== "mouse") return;
    onFocusRow(row);
  };

  const contentRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);
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

  useEffect(() => {
    if (open) {
      setMounted(true);
      // Deux frames : le premier style (hors écran) doit être peint avant que
      // la transition ne parte, sinon la WebView la saute.
      let second = 1;
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(first);
        cancelAnimationFrame(second);
      };
    }

    setShown(false);
    // À la réouverture, le cadre se pose sur la première ligne sans glisser
    // depuis la position de la session précédente.
    frameState.current.placed = false;
    const timer = window.setTimeout(() => setMounted(false), ANIM_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  // Cadre de sélection : un seul élément, déplacé et redimensionné par ressort
  // critiquement amorti — aucune boucle ne tourne une fois le cadre posé.
  useEffect(() => {
    if (!open || !mounted) return;
    const target = rowRefs.current[index];
    const content = contentRef.current;
    const frame = frameRef.current;
    if (!target || !content || !frame) return;

    const targetRect = target.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const goal = {
      x: targetRect.left - contentRect.left,
      y: targetRect.top - contentRect.top,
      w: targetRect.width,
      h: targetRect.height,
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

    // Même impulsion de départ que la piste du ruban : réactivité immédiate.
    state.vx += (goal.x - state.x) * FRAME_OMEGA * FRAME_START_IMPULSE;
    state.vy += (goal.y - state.y) * FRAME_OMEGA * FRAME_START_IMPULSE;
    state.vw += (goal.w - state.w) * FRAME_OMEGA * FRAME_START_IMPULSE;
    state.vh += (goal.h - state.h) * FRAME_OMEGA * FRAME_START_IMPULSE;

    // Solution exacte d'un ressort critiquement amorti (damping = 1).
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
    const tick = (now: number) => {
      const dt = Math.min(
        FRAME_MAX_DT,
        Math.max(0, (now - last) / 1000),
      );
      last = now;
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
  }, [index, open, mounted]);

  if (!mounted) return null;

  const themePercent = Math.round(settings.themeVolume * 100);
  const effectsPercent = Math.round(settings.effectsVolume * 100);
  const attachRow = (rowIndex: number) => (node: HTMLDivElement | null) => {
    rowRefs.current[rowIndex] = node;
  };

  return (
    <div
      className="fixed inset-0 z-[80]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="audio-title"
      style={SST_STYLE}
    >
      <div
        aria-hidden="true"
        onClick={(event) => {
          if (shouldIgnoreClick(event)) return;
          onClose();
        }}
        className="absolute inset-0 bg-[#021029]"
        style={{
          opacity: shown ? 0.45 : 0,
          transitionProperty: "opacity",
          transitionDuration: `${ANIM_MS}ms`,
          transitionTimingFunction: ANIM_EASE,
        }}
      />

      <div
        className="absolute right-0 top-0 flex w-[440px] max-w-full flex-col border-l border-white/[0.18] text-white"
        style={{
          ...SST_STYLE,
          height: "100vh",
          background:
            "linear-gradient(180deg, rgba(0, 67, 156, 0.86) 0%, rgba(0, 38, 99, 0.90) 55%, rgba(2, 16, 41, 0.94) 100%)",
          backdropFilter: "blur(22px)",
          WebkitBackdropFilter: "blur(22px)",
          opacity: shown ? 1 : 0,
          transform: shown
            ? "translate3d(0, 0, 0)"
            : "translate3d(100%, 0, 0)",
          transitionProperty: "transform, opacity",
          transitionDuration: `${ANIM_MS}ms`,
          transitionTimingFunction: ANIM_EASE,
          willChange: "transform",
        }}
      >
        <header className="shrink-0 px-5 pb-4 pt-5">
          <h2
            id="audio-title"
            className="leading-tight text-white"
            style={{
              fontFamily: "'SST', sans-serif",
              fontSize: "26px",
              fontWeight: 300,
            }}
          >
            Paramètres audio
          </h2>
          <p
            style={SST_STYLE}
            className="mt-1 text-[11px] text-white/50"
          >
            Égaliseur · aperçu en direct
          </p>
        </header>

        <div className="flex-1 overflow-y-auto px-5 pb-5">
          <div ref={contentRef} className="relative">
            {/* Cadre blanc unique : glisse et s'étire d'une ligne à l'autre. */}
            <div
              ref={frameRef}
              aria-hidden="true"
              className="pointer-events-none absolute left-0 top-0 z-0 rounded-[1px] border-2 border-white bg-white/[0.10] shadow-[0_0_18px_rgba(120,190,255,0.38)]"
              style={{ width: 0, height: 0, willChange: "transform" }}
            />

            <SectionTitle>Niveaux généraux</SectionTitle>

            <div className="mt-2">
              {/* 0 — Muet */}
              <div
                ref={attachRow(0)}
                role="switch"
                aria-checked={muted}
                tabIndex={-1}
                onMouseEnter={() => hoverRow(0)}
                onClick={(event) => {
                  if (shouldIgnoreClick(event)) return;
                  onFocusRow(0);
                  onToggleMute();
                }}
                className={`flex items-center justify-between gap-2.5 ${rowClass(
                  index === 0,
                )}`}
              >
                <span
                  style={SST_STYLE}
                  className="text-[14px] font-light text-white/90"
                >
                  Muet
                </span>
                <StateBadge on={muted} />
              </div>

              {/* 1 — Musique de thème */}
              <div
                ref={attachRow(1)}
                onMouseEnter={() => hoverRow(1)}
                onClick={(event) => {
                  if (shouldIgnoreClick(event)) return;
                  onFocusRow(1);
                }}
                className={rowClass(index === 1)}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span
                    style={SST_STYLE}
                    className="text-[14px] font-light text-white/90"
                  >
                    Musique de thème
                  </span>
                  <span
                    style={SST_STYLE}
                    className="text-[11px] text-white/55"
                  >
                    {themePercent} %
                  </span>
                </div>
                <div className="mt-1 flex items-center">
                  <LevelSlider
                    label="Volume de la musique de thème"
                    value={themePercent}
                    onFocus={() => onFocusRow(1)}
                    onChange={onThemeVolume}
                  />
                </div>
              </div>

              {/* 2 — Effets système */}
              <div
                ref={attachRow(2)}
                onMouseEnter={() => hoverRow(2)}
                onClick={(event) => {
                  if (shouldIgnoreClick(event)) return;
                  onFocusRow(2);
                }}
                className={rowClass(index === 2)}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span
                    style={SST_STYLE}
                    className="text-[14px] font-light text-white/90"
                  >
                    Effets système
                  </span>
                  <span
                    style={SST_STYLE}
                    className="text-[11px] text-white/55"
                  >
                    {effectsPercent} %
                  </span>
                </div>
                <div className="mt-1 flex items-center">
                  <LevelSlider
                    label="Volume des effets système"
                    value={effectsPercent}
                    onFocus={() => onFocusRow(2)}
                    onChange={(value) => {
                      onEffectsVolume(value);
                      previewEffectsVolume();
                    }}
                  />
                </div>
              </div>

              {/* 3 — Normalisation auto */}
              <div
                ref={attachRow(3)}
                role="switch"
                aria-checked={settings.normalization}
                tabIndex={-1}
                onMouseEnter={() => hoverRow(3)}
                onClick={(event) => {
                  if (shouldIgnoreClick(event)) return;
                  onFocusRow(3);
                  onToggleNormalization();
                }}
                className={`flex items-center justify-between gap-2.5 ${rowClass(
                  index === 3,
                )}`}
              >
                <span
                  style={SST_STYLE}
                  className="text-[14px] font-light text-white/90"
                >
                  Normalisation auto
                </span>
                <StateBadge on={settings.normalization} />
              </div>
            </div>

            <div className="mt-5 flex items-baseline justify-between gap-2">
              <SectionTitle>Égaliseur</SectionTitle>
              <span
                style={SST_STYLE}
                className="text-[10px] uppercase tracking-[0.2em] text-white/35"
              >
                3 bandes
              </span>
            </div>

            {/* 4 — Préréglages */}
            <div
              className="mt-2 cursor-pointer"
              onMouseEnter={() => hoverRow(4)}
              onClick={(event) => {
                if (shouldIgnoreClick(event)) return;
                onFocusRow(4);
              }}
            >
              <div
                ref={attachRow(4)}
                className="flex gap-[2px] rounded-[1px] p-[2px]"
              >
                {EQ_PRESETS.map((preset) => {
                  const active =
                    settings.eqLow === preset.low &&
                    settings.eqMid === preset.mid &&
                    settings.eqHigh === preset.high;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={(event) => {
                        if (shouldIgnoreClick(event)) return;
                        onPreset(preset.id);
                      }}
                      onMouseEnter={() => hoverRow(4)}
                      style={SST_STYLE}
                      className={`flex-1 rounded-[2px] px-1 py-[7px] text-[11px] font-medium transition-colors duration-150 ${
                        active
                          ? "bg-[#0070D1] text-white shadow-[inset_0_0_0_1px_rgba(120,190,255,0.55)]"
                          : "bg-transparent text-white/55 hover:bg-white/10 hover:text-white/85"
                      }`}
                    >
                      {preset.id === "deep" ? "Basses +" : preset.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="mt-3 flex items-start justify-around gap-2 border-t border-white/[0.14] pt-3">
              {BANDS.map((band) => {
                const value =
                  band.band === "low"
                    ? settings.eqLow
                    : band.band === "mid"
                      ? settings.eqMid
                      : settings.eqHigh;
                return (
                  <div
                    key={band.band}
                    className="flex w-[86px] flex-col items-center"
                    onMouseEnter={() => hoverRow(band.index)}
                  >
                    <span
                      style={SST_STYLE}
                      className="mb-1 text-[11px] text-white/80"
                    >
                      {value > 0 ? `+${value}` : value} dB
                    </span>
                    <div ref={attachRow(band.index)}>
                      <BandFader
                        label={`${band.label} ${band.freq}`}
                        value={value}
                        onFocus={() => onFocusRow(band.index)}
                        onChange={(next) => onBand(band.band, next)}
                      />
                    </div>
                    <span
                      style={SST_STYLE}
                      className="mt-1.5 text-[11px] text-white/85"
                    >
                      {band.label}
                    </span>
                    <span
                      style={SST_STYLE}
                      className="text-[10px] text-white/35"
                    >
                      {band.freq}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-white/[0.14] px-5 py-3 text-[11px] text-white/45">
          <span style={SST_STYLE}>↑↓ · ←→ · glisser</span>
          <span style={SST_STYLE} className="flex items-center gap-1.5">
            <img
              src="/buttons/PS4_Circle.png"
              alt=""
              className="h-3.5 w-3.5 object-contain opacity-80"
            />
            Fermer
          </span>
        </footer>
      </div>
    </div>
  );
}
