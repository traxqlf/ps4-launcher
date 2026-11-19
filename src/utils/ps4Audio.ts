/* Bruitages officiels PS4 (Orbis OS) + musique du menu. */

import { invoke } from "@tauri-apps/api/core";
import { triggerHaptic } from "../hooks/useGamepad";

const DUPLICATE_WINDOW_MS = 35;
const BGM_SRC = "/sounds/MainMenuSoundPs4.mp3";
const LOGIN_THEME_SRC = "/sounds/loginPs4.mp3";
const LOGIN_JINGLE_SRC = "/sounds/snd_log_login-se_log_login.wav";
const BGM_VOLUME = 0.35;
const BGM_FADE_MS = 1500;
// Fondu sortant du thème de chargement à l'arrivée sur l'accueil.
const LOGIN_FADE_MS = 250;
const BGM_MUTED_KEY = "ps4-launcher:bgm-muted";
const AUDIO_SETTINGS_KEY = "ps4-launcher:audio-settings";
const GAMEPAD_POLL_MS = 200;

/* ─────────────── Mixage : réglages persistants ─────────────── */

export type EqPresetId = "balanced" | "deep" | "ps4" | "clear";

export interface AudioSettings {
  /** 0 → 1 : plafonné à 100 %, jamais au-delà. */
  themeVolume: number;
  /** 0 → 1, appliqué au bus des bruitages système. */
  effectsVolume: number;
  /** Compresseur dynamique d'égalisation des pistes YouTube. */
  normalization: boolean;
  eqPreset: EqPresetId;
  eqLow: number;
  eqMid: number;
  eqHigh: number;
}

export const EQ_PRESETS: {
  id: EqPresetId;
  label: string;
  low: number;
  mid: number;
  high: number;
}[] = [
  { id: "balanced", label: "Équilibré", low: 0, mid: 0, high: 0 },
  { id: "deep", label: "Basses profondes", low: 6, mid: -1, high: 2 },
  { id: "ps4", label: "Ambiance PS4", low: 3, mid: -2, high: 4 },
  { id: "clear", label: "Clair", low: -2, mid: 3, high: 5 },
];

const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  themeVolume: 0.85,
  effectsVolume: 0.65,
  normalization: true,
  eqPreset: "balanced",
  eqLow: 0,
  eqMid: 0,
  eqHigh: 0,
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function loadAudioSettings(): AudioSettings {
  if (typeof window === "undefined") return { ...DEFAULT_AUDIO_SETTINGS };
  try {
    const raw = window.localStorage.getItem(AUDIO_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_AUDIO_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AudioSettings>;
    const preset = EQ_PRESETS.some((item) => item.id === parsed.eqPreset)
      ? (parsed.eqPreset as EqPresetId)
      : DEFAULT_AUDIO_SETTINGS.eqPreset;
    const read = (value: unknown, fallback: number, min: number, max: number) =>
      typeof value === "number" && Number.isFinite(value)
        ? clamp(value, min, max)
        : fallback;
    return {
      // Une ancienne valeur > 100 % (ex. 150) est ramenée à 100 %.
      themeVolume: read(parsed.themeVolume, 0.85, 0, 1),
      effectsVolume: read(parsed.effectsVolume, 0.65, 0, 1),
      normalization:
        typeof parsed.normalization === "boolean"
          ? parsed.normalization
          : DEFAULT_AUDIO_SETTINGS.normalization,
      eqPreset: preset,
      eqLow: read(parsed.eqLow, 0, -12, 12),
      eqMid: read(parsed.eqMid, 0, -12, 12),
      eqHigh: read(parsed.eqHigh, 0, -12, 12),
    };
  } catch {
    return { ...DEFAULT_AUDIO_SETTINGS };
  }
}

let audioSettings = loadAudioSettings();

const SOUND_SOURCES = {
  cursor: "/sounds/snd_log_cursor.wav",
  confirm: "/sounds/snd_decide.wav",
  dialog: "/sounds/snd_dlg_yes.wav",
  enterMenu: "/sounds/snd_enter_menu.wav",
  back: "/sounds/snd_back_menu.wav",
  negative: "/sounds/snd_dlg_show_negative.wav",
  error: "/sounds/snd_msg_ng_psbutton.wav",
  trophy: "/sounds/snd_msg_trophy.wav",
  notification: "/sounds/snd_msg_notification.wav",
  system: "/sounds/snd_msg_system_msg.wav",
} as const;

type SoundName = keyof typeof SOUND_SOURCES;

let context: AudioContext | null = null;
let master: GainNode | null = null;
let effectsBus: GainNode | null = null;
const buffers: Partial<Record<SoundName, AudioBuffer>> = {};
// Gain de normalisation calculé au décodage : les WAV PS4 ont des niveaux très bas.
const gains: Partial<Record<SoundName, number>> = {};
const lastPlayed: Partial<Record<SoundName, number>> = {};
let preloading = false;

function readBgmMuted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(BGM_MUTED_KEY) === "1";
  } catch {
    return false;
  }
}

let bgmMuted = readBgmMuted();

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Constructor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Constructor) return null;

  try {
    if (!context) {
      context = new Constructor();
      master = context.createGain();
      master.gain.value = bgmMuted ? 0 : 1;
      master.connect(context.destination);

      // Bus des bruitages : volume réglable dans le panneau de mixage.
      effectsBus = context.createGain();
      effectsBus.gain.value = audioSettings.effectsVolume;
      effectsBus.connect(master);

      // La manette ne compte pas comme geste utilisateur : on débloque l'audio
      // au premier clic / touche pour que les bruitages suivants sortent.
      const unlock = () => {
        if (context?.state === "suspended") void context.resume();
      };
      window.addEventListener("pointerdown", unlock, { once: true });
      window.addEventListener("keydown", unlock, { once: true });
    }
    if (context.state === "suspended") void context.resume().catch(() => {});
    return context;
  } catch {
    return null;
  }
}

function decodeAudio(
  audio: AudioContext,
  data: ArrayBuffer,
): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    const result = audio.decodeAudioData(data, resolve, reject);
    if (result && typeof result.then === "function") {
      result.then(resolve, reject);
    }
  });
}

/** Précharge et normalise tous les bruitages : lecture sans latence ensuite. */
function preloadSounds() {
  if (preloading) return;
  const audio = getContext();
  if (!audio) return;
  preloading = true;

  for (const [name, source] of Object.entries(SOUND_SOURCES) as [
    SoundName,
    string,
  ][]) {
    void fetch(source)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then((data) => decodeAudio(audio, data))
      .then((buffer) => {
        let peak = 0;
        for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
          const samples = buffer.getChannelData(channel);
          for (let index = 0; index < samples.length; index += 1) {
            const value = Math.abs(samples[index]);
            if (value > peak) peak = value;
          }
        }
        buffers[name] = buffer;
        gains[name] = peak > 0 ? 0.9 / peak : 1;
      })
      .catch((cause) => console.warn(`[ps4Audio] ${source}:`, cause));
  }
}

function allow(name: SoundName): boolean {
  const now = performance.now();
  if (now - (lastPlayed[name] ?? 0) < DUPLICATE_WINDOW_MS) return false;
  lastPlayed[name] = now;
  return true;
}

function play(name: SoundName, volume: number) {
  if (bgmMuted) return;
  const audio = getContext();
  if (!audio) return;

  const buffer = buffers[name];
  if (!buffer) {
    // Contexte créé après le préchargement (politique autoplay) : on rattrape.
    preloadSounds();
    return;
  }

  const source = audio.createBufferSource();
  source.buffer = buffer;
  const amp = audio.createGain();
  amp.gain.value = volume * (gains[name] ?? 1);
  source.connect(amp);
  amp.connect(effectsBus ?? master ?? audio.destination);
  source.start();
}

/* ─────────────── Mixage : API de réglages ─────────────── */

export function getAudioSettings(): AudioSettings {
  return { ...audioSettings };
}

/**
 * Applique un changement de réglage, le persiste dans localStorage et met à
 * jour en direct le bus des bruitages, le gain du thème et l'égaliseur.
 */
export function updateAudioSettings(
  patch: Partial<AudioSettings>,
): AudioSettings {
  const next: AudioSettings = { ...audioSettings, ...patch };
  audioSettings = {
    ...next,
    themeVolume: clamp(next.themeVolume, 0, 1),
    effectsVolume: clamp(next.effectsVolume, 0, 1),
    eqLow: clamp(next.eqLow, -12, 12),
    eqMid: clamp(next.eqMid, -12, 12),
    eqHigh: clamp(next.eqHigh, -12, 12),
  };

  try {
    window.localStorage.setItem(
      AUDIO_SETTINGS_KEY,
      JSON.stringify(audioSettings),
    );
  } catch {
    // localStorage indisponible : le réglage reste en mémoire pour la session.
  }

  // Chaque interaction réveille le contexte (WKWebView le suspend au repos).
  if (context?.state === "suspended") void context.resume().catch(() => {});
  applyAudioSettings();
  return getAudioSettings();
}

/** Choisit un préréglage d'égaliseur et applique ses trois bandes. */
export function applyEqPreset(id: EqPresetId): AudioSettings {
  const preset = EQ_PRESETS.find((item) => item.id === id);
  if (!preset) return getAudioSettings();
  return updateAudioSettings({
    eqPreset: preset.id,
    eqLow: preset.low,
    eqMid: preset.mid,
    eqHigh: preset.high,
  });
}

/* ─────────────── Thème de jeu : moteur Web Audio natif ─────────────── */

// Le thème n'utilise plus de balise <audio> : fetch → decodeAudioData →
// AudioBufferSourceNode. Sur WKWebView, createMediaElementSource sur une URL
// `asset://` ne capte pas le flux et l'égaliseur resterait sans effet.

let themeLow: BiquadFilterNode | null = null;
let themeMid: BiquadFilterNode | null = null;
let themeHigh: BiquadFilterNode | null = null;
let themeCompressor: DynamicsCompressorNode | null = null;
let themeVolumeGain: GainNode | null = null;
let themeFadeGain: GainNode | null = null;
// Voix actuellement audibles : une seule en pratique, mais la précédente peut
// survivre le temps de son fondu de sortie lors d'un changement de thème.
const themeVoices = new Set<AudioBufferSourceNode>();
let themeStopTimer = 0;
// Jeton d'annulation : un chargement obsolète ne doit jamais démarrer.
let themeLoadToken = 0;
let themeBuffer: AudioBuffer | null = null;
let themeBufferSrc: string | null = null;
let routedNormalization: boolean | null = null;

/** Construit la chaîne une seule fois : filtres → compresseur → gains. */
function ensureThemeChain(audio: AudioContext): boolean {
  if (themeLow && themeVolumeGain && themeFadeGain) return true;

  try {
    const low = audio.createBiquadFilter();
    low.type = "lowshelf";
    low.frequency.value = 120;

    const mid = audio.createBiquadFilter();
    mid.type = "peaking";
    mid.frequency.value = 1000;
    mid.Q.value = 1;

    const high = audio.createBiquadFilter();
    high.type = "highshelf";
    high.frequency.value = 8000;

    const compressor = audio.createDynamicsCompressor();
    compressor.threshold.value = -24;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;
    compressor.knee.value = 12;

    const volume = audio.createGain();
    volume.gain.value = clamp(audioSettings.themeVolume, 0, 1);

    const fade = audio.createGain();
    fade.gain.value = 0;

    low.connect(mid);
    mid.connect(high);
    high.connect(volume);
    volume.connect(fade);
    fade.connect(audio.destination);

    themeLow = low;
    themeMid = mid;
    themeHigh = high;
    themeCompressor = compressor;
    themeVolumeGain = volume;
    themeFadeGain = fade;
    routedNormalization = null;
    routeThemeNormalization();
    return true;
  } catch (cause) {
    console.warn("[ps4Audio] chaîne Web Audio du thème indisponible:", cause);
    return false;
  }
}

/** Insère / retire le compresseur entre les aigus et le gain musique. */
function routeThemeNormalization() {
  const high = themeHigh;
  const compressor = themeCompressor;
  const volume = themeVolumeGain;
  if (!high || !compressor || !volume) return;
  if (routedNormalization === audioSettings.normalization) return;

  try {
    high.disconnect();
  } catch {
    // Déjà déconnecté : rien à faire.
  }
  try {
    compressor.disconnect();
  } catch {
    // Déjà déconnecté : rien à faire.
  }

  if (audioSettings.normalization) {
    high.connect(compressor);
    compressor.connect(volume);
  } else {
    high.connect(volume);
  }
  routedNormalization = audioSettings.normalization;
}

function applyAudioSettings() {
  if (effectsBus) effectsBus.gain.value = audioSettings.effectsVolume;
  routeThemeNormalization();

  const audio = context;
  if (
    !audio ||
    !themeLow ||
    !themeMid ||
    !themeHigh ||
    !themeVolumeGain
  ) {
    return;
  }

  // Lissage 20 ms : le curseur agit à l'oreille sans clics de raccord.
  const now = audio.currentTime;
  const smooth = 0.02;
  themeLow.gain.setTargetAtTime(audioSettings.eqLow, now, smooth);
  themeMid.gain.setTargetAtTime(audioSettings.eqMid, now, smooth);
  themeHigh.gain.setTargetAtTime(audioSettings.eqHigh, now, smooth);
  themeVolumeGain.gain.setTargetAtTime(
    clamp(audioSettings.themeVolume, 0, 1),
    now,
    smooth,
  );
}

/** Stoppe immédiatement toutes les voix (changement de piste, fermeture). */
function killThemeVoices() {
  window.clearTimeout(themeStopTimer);
  themeStopTimer = 0;
  for (const voice of themeVoices) {
    try {
      voice.stop();
    } catch {
      // Déjà arrêtée : rien à faire.
    }
    try {
      voice.disconnect();
    } catch {
      // Déjà déconnectée : rien à faire.
    }
  }
  themeVoices.clear();
}

async function loadThemeBuffer(
  audio: AudioContext,
  src: string,
  filePath?: string,
): Promise<AudioBuffer | null> {
  try {
    const response = await fetch(src);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.arrayBuffer();
    return await decodeAudio(audio, data);
  } catch (cause) {
    console.warn("[ps4Audio] fetch du thème:", cause);
  }

  // Repli : sur WKWebView, fetch d'un custom scheme peut être refusé alors que
  // le fichier est bien lisible côté Rust. Le base64 évite un plugin fs.
  if (!filePath) return null;
  try {
    const encoded = await invoke<string>("read_theme_audio", {
      themePath: filePath,
    });
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return await decodeAudio(audio, bytes.buffer);
  } catch (cause) {
    console.warn("[ps4Audio] lecture du thème via Rust:", cause);
    return null;
  }
}

function startThemeSource(
  audio: AudioContext,
  buffer: AudioBuffer,
  fadeMs: number,
) {
  const low = themeLow;
  const fade = themeFadeGain;
  if (!low || !fade) return;

  killThemeVoices();

  const source = audio.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.connect(low);
  source.onended = () => {
    themeVoices.delete(source);
    try {
      source.disconnect();
    } catch {
      // Déjà déconnectée : rien à faire.
    }
  };

  const now = audio.currentTime;
  fade.gain.cancelScheduledValues(now);
  fade.gain.setValueAtTime(0, now);
  fade.gain.linearRampToValueAtTime(1, now + Math.max(0.05, fadeMs / 1000));

  source.start(now);
  themeVoices.add(source);
}

/**
 * Charge (ou réutilise) le thème et le joue en boucle à travers l'égaliseur.
 * Renvoie `false` si le fichier ne peut pas être lu ou décodé.
 */
export async function playThemeMusic(
  src: string,
  filePath?: string,
  fadeMs = 800,
): Promise<boolean> {
  const audio = getContext();
  if (!audio) return false;
  if (audio.state === "suspended") void audio.resume().catch(() => {});
  if (!ensureThemeChain(audio)) return false;

  const token = ++themeLoadToken;
  let buffer = themeBufferSrc === src ? themeBuffer : null;
  if (!buffer) {
    buffer = await loadThemeBuffer(audio, src, filePath);
    if (!buffer) return false;
  }
  // Un arrêt ou un autre thème a été demandé pendant le décodage.
  if (token !== themeLoadToken) return false;

  themeBuffer = buffer;
  themeBufferSrc = src;
  startThemeSource(audio, buffer, fadeMs);
  return true;
}

/** Fondu de sortie (300 ms par défaut), puis arrêt des sources. */
export function stopThemeMusic(fadeMs = 300): void {
  // Annule tout chargement / démarrage encore en vol.
  themeLoadToken += 1;
  const audio = context;
  const fade = themeFadeGain;

  if (!audio || !fade || themeVoices.size === 0) {
    if (fade && audio) fade.gain.setValueAtTime(0, audio.currentTime);
    return;
  }

  const now = audio.currentTime;
  fade.gain.cancelScheduledValues(now);
  fade.gain.setValueAtTime(fade.gain.value, now);
  fade.gain.linearRampToValueAtTime(
    0,
    now + Math.max(0.05, fadeMs / 1000),
  );

  window.clearTimeout(themeStopTimer);
  themeStopTimer = window.setTimeout(() => {
    killThemeVoices();
    // Le PCM décodé est volumineux : on le libère une fois le thème arrêté.
    themeBuffer = null;
    themeBufferSrc = null;
  }, fadeMs + 50);
}

/** Curseur : ruban, listes, barre système et tiroir. */
export function playNav() {
  if (!allow("cursor")) return;
  play("cursor", 0.42);
}

/** Validation simple (Croix / A / Entrée). */
export function playConfirm() {
  if (!allow("confirm")) return;
  play("confirm", 0.48);
}

/** Confirmation d'une action engageante (enregistrer, supprimer). */
export function playDialogYes() {
  if (!allow("dialog")) return;
  play("dialog", 0.5);
}

/** Ouverture d'un écran ou d'un menu. */
export function playEnterMenu() {
  if (!allow("enterMenu")) return;
  play("enterMenu", 0.5);
}

/** Retour / fermeture (Rond / B / Échap). */
export function playBack() {
  if (!allow("back")) return;
  play("back", 0.46);
}

/** Dialogue négatif (confirmation de suppression). */
export function playNegative() {
  if (!allow("negative")) return;
  play("negative", 0.46);
}

/** Action impossible, erreur ou butée de navigation. */
export function playError() {
  // Butée : petite secousse sèche, même si le son est coupé.
  triggerHaptic(70, 0.4, 0.55);
  if (!allow("error")) return;
  play("error", 0.5);
}

/** Démarrage d'un jeu : retour haptique seul, sans bruitage. */
export function playGameStart() {
  triggerHaptic(180, 0.5, 0.75);
}

/** Notification de trophée débloqué. */
export function playTrophy() {
  triggerHaptic(90, 0.25, 0.35);
  if (!allow("trophy")) return;
  play("trophy", 0.58);
}

/** Notification système (jaquettes actualisées). */
export function playNotification() {
  if (!allow("notification")) return;
  play("notification", 0.5);
}

/** Message système (profil enregistré, avatar mis à jour). */
export function playSystemMessage() {
  if (!allow("system")) return;
  play("system", 0.5);
}

/* ─────────────── Connexion : thème de chargement puis jingle ─────────────── */

let loginTheme: HTMLAudioElement | null = null;
let loginThemeStarted = false;
let loginJingle: HTMLAudioElement | null = null;
let loginJingleActive = false;
let loginJinglePlayed = false;
let loginFadeTimer = 0;
let bgm: HTMLAudioElement | null = null;
let bgmRequested = false;
let fadeTimer = 0;
let unlockWatcher: number | null = null;
let bgmWarned = false;

/**
 * Étape 1 : thème de connexion pendant le chargement, une seule fois par
 * session. Il reste porté par le module audio, donc le démontage de l'écran de
 * chargement ne le coupe pas.
 */
export function startLoginTheme() {
  if (loginThemeStarted || typeof window === "undefined") return;
  loginThemeStarted = true;
  if (bgmMuted) return;

  try {
    const audio = new Audio(LOGIN_THEME_SRC);
    audio.volume = 0.55;
    loginTheme = audio;
    void audio.play().catch((cause) => {
      if (loginTheme === audio) loginTheme = null;
      console.warn("[ps4Audio] thème de connexion:", cause);
    });
  } catch (cause) {
    console.warn("[ps4Audio] thème de connexion indisponible:", cause);
  }
}

/**
 * Étape 2 : à l'arrivée sur l'accueil, le thème s'efface en 250 ms puis on
 * joue le jingle de connexion une seule fois. La musique du menu attend sa fin.
 */
export function playLoginJingle() {
  if (loginJinglePlayed || typeof window === "undefined") return;
  loginJinglePlayed = true;
  fadeOutLoginTheme();
  if (bgmMuted) return;

  try {
    const audio = new Audio(LOGIN_JINGLE_SRC);
    audio.volume = 1;
    loginJingle = audio;
    loginJingleActive = true;
    audio.addEventListener(
      "ended",
      () => {
        if (loginJingle === audio) loginJingle = null;
        loginJingleActive = false;
        resumeBgm();
      },
      { once: true },
    );
    void audio.play().catch((cause) => {
      if (loginJingle === audio) loginJingle = null;
      loginJingleActive = false;
      resumeBgm();
      console.warn("[ps4Audio] jingle de connexion:", cause);
    });
  } catch (cause) {
    loginJingleActive = false;
    resumeBgm();
    console.warn("[ps4Audio] jingle de connexion indisponible:", cause);
  }
}

/** Coupe immédiatement les sons de connexion (mute global ou jeu lancé). */
function stopLoginSounds() {
  window.clearInterval(loginFadeTimer);
  loginFadeTimer = 0;

  if (loginTheme) {
    loginTheme.pause();
    loginTheme.currentTime = 0;
    loginTheme = null;
  }
  if (loginJingle) {
    loginJingle.pause();
    loginJingle.currentTime = 0;
    loginJingle = null;
  }
  loginJingleActive = false;
}

/** Fondu rapide du thème, puis pause et retour au début. */
function fadeOutLoginTheme() {
  const audio = loginTheme;
  if (!audio || audio.paused) {
    loginTheme = null;
    return;
  }

  const from = audio.volume;
  const startedAt = performance.now();
  window.clearInterval(loginFadeTimer);
  loginFadeTimer = window.setInterval(() => {
    const ratio = Math.min(1, (performance.now() - startedAt) / LOGIN_FADE_MS);
    audio.volume = Math.max(0, from * (1 - ratio));
    if (ratio < 1) return;
    window.clearInterval(loginFadeTimer);
    loginFadeTimer = 0;
    audio.pause();
    audio.currentTime = 0;
    if (loginTheme === audio) loginTheme = null;
  }, 40);
}

function getBgm(): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  if (!bgm) {
    try {
      bgm = new Audio(BGM_SRC);
      bgm.loop = true;
      bgm.preload = "auto";
      bgm.volume = 0;
      bgm.muted = bgmMuted;
    } catch (cause) {
      console.warn("[ps4Audio] musique du menu indisponible:", cause);
      return null;
    }
  }
  return bgm;
}

function fadeBgmTo(target: number) {
  const audio = bgm;
  if (!audio) return;
  window.clearInterval(fadeTimer);
  const from = audio.volume;
  const startedAt = performance.now();
  fadeTimer = window.setInterval(() => {
    if (!bgm || bgm !== audio) {
      window.clearInterval(fadeTimer);
      return;
    }
    const ratio = Math.min(1, (performance.now() - startedAt) / BGM_FADE_MS);
    audio.volume = Math.max(0, Math.min(1, from + (target - from) * ratio));
    if (ratio >= 1) window.clearInterval(fadeTimer);
  }, 40);
}

function unlockAudioContext() {
  if (context?.state === "suspended") void context.resume();
}

function tryUnlock() {
  stopUnlockWatcher();
  unlockAudioContext();
  if (bgmRequested && !bgmMuted) playBgmWithFade();
}

function stopUnlockWatcher() {
  if (unlockWatcher === null) return;
  window.clearInterval(unlockWatcher);
  unlockWatcher = null;
  window.removeEventListener("pointerdown", tryUnlock, true);
  window.removeEventListener("keydown", tryUnlock, true);
}

/**
 * Sécurité autoplay : tant que la musique n'a pas démarré, on guette le premier
 * clic / touche / bouton manette pour relancer la lecture.
 */
function watchUnlock() {
  if (unlockWatcher !== null) return;
  window.addEventListener("pointerdown", tryUnlock, true);
  window.addEventListener("keydown", tryUnlock, true);
  unlockWatcher = window.setInterval(() => {
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (pad?.connected && pad.buttons.some((button) => button.pressed)) {
        tryUnlock();
        return;
      }
    }
  }, GAMEPAD_POLL_MS);
}

function playBgmWithFade() {
  const audio = getBgm();
  if (!audio) return;
  audio.muted = false;
  audio.volume = 0;
  watchUnlock();
  void audio
    .play()
    .then(() => {
      fadeBgmTo(BGM_VOLUME);
      stopUnlockWatcher();
    })
    .catch((cause) => {
      if (bgmWarned) return;
      bgmWarned = true;
      console.warn("[ps4Audio] musique du menu:", cause);
    });
}

/**
 * Suspend le moteur Web Audio (fenêtre minimisée pour un jeu) : les sources,
 * filtres et bruitages ne consomment plus de ressource OS et ne peuvent pas
 * entrer en conflit avec le moteur audio du jeu.
 */
export function suspendAudioEngine(): void {
  const audio = context;
  if (!audio || audio.state !== "running") return;
  void audio.suspend().catch(() => {});
}

/** Réactive le moteur Web Audio au retour du launcher au premier plan. */
export function resumeAudioEngine(): void {
  const audio = context;
  if (!audio || audio.state !== "suspended") return;
  void audio.resume().catch(() => {});
}

/** Suspend la musique (jeu lancé) sans perdre le choix de l'utilisateur. */
export function pauseBgm() {
  bgmRequested = false;
  window.clearInterval(fadeTimer);
  stopUnlockWatcher();
  bgm?.pause();
  stopLoginSounds();
}

/** Reprend la musique du menu si elle n'est pas coupée. */
export function resumeBgm() {
  bgmRequested = true;
  if (bgmMuted) return;
  // Le jingle de connexion garde la main jusqu'à sa fin.
  if (loginJingleActive) return;
  if (bgm && !bgm.paused) return;
  playBgmWithFade();
}

/** Coupe / réactive la musique et tous les bruitages. Renvoie l'état muet. */
export function toggleMuteBgm(): boolean {
  bgmMuted = !bgmMuted;
  try {
    window.localStorage.setItem(BGM_MUTED_KEY, bgmMuted ? "1" : "0");
  } catch {
    // localStorage indisponible : le choix reste en mémoire pour la session.
  }

  const audio = getBgm();
  if (audio) audio.muted = bgmMuted;

  if (master && context) {
    master.gain.setTargetAtTime(bgmMuted ? 0 : 1, context.currentTime, 0.01);
  }

  if (bgmMuted) {
    stopLoginSounds();
    stopUnlockWatcher();
  } else if (bgmRequested && (!audio || audio.paused)) {
    playBgmWithFade();
  }

  return bgmMuted;
}

export function isBgmMuted(): boolean {
  return bgmMuted;
}

// Démarre le téléchargement / décodage dès l'ouverture, bien avant le premier clic.
if (typeof window !== "undefined") {
  preloadSounds();
}
