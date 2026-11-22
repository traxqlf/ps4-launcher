import { useEffect, useRef } from "react";

export interface GamepadHandlers {
  onLeft?: () => void;
  onRight?: () => void;
  onUp?: () => void;
  onDown?: () => void;
  onConfirm?: () => void;
  onBack?: () => void;
  onOptions?: () => void;
  onSquare?: () => void;
  onL1?: () => void;
  onR1?: () => void;
  onL2?: () => void;
  onR2?: () => void;
}

type Direction = "up" | "down" | "left" | "right";

export type InputMode = "mouse" | "gamepad";

const COOLDOWN_MS = 180;
// Seuil de réveil manette : tout bouton ou stick qui dépasse ces valeurs
// rebascule l'interface en mode manette (curseur masqué).
const ACTIVITY_BUTTON = 0.1;
const ACTIVITY_AXIS = 0.25;
const STICK_DEADZONE = 0.6;
const DPAD_UP = 12;
const DPAD_DOWN = 13;
const DPAD_LEFT = 14;
const DPAD_RIGHT = 15;
const BUTTON_CONFIRM = 0;
const BUTTON_BACK = 1;
const BUTTON_SQUARE = 2;
// Standard W3C : 3 = Triangle / Y, 9 = Options / Start / Menu. Le bouton
// physique Options est donc 9 ; 3 reste un raccourci secondaire (Triangle ouvre
// l'écran d'informations sur PS4).
const BUTTON_TRIANGLE = 3;
const BUTTON_OPTIONS = 9;
// Gâchettes hautes et basses (standard W3C).
const BUTTON_L1 = 4;
const BUTTON_R1 = 5;
const BUTTON_L2 = 6;
const BUTTON_R2 = 7;
const TRIGGER_THRESHOLD = 0.6;

/**
 * Gâchette basse enfoncée : bouton numérique, valeur analogique du bouton
 * (standard W3C), ou axe dédié sur les manettes à mapping non standard.
 * L'axe n'est lu que si la manette expose plus de quatre axes, pour ne jamais
 * confondre L2 / R2 avec le stick droit.
 */
function triggerDown(pad: Gamepad, button: number, axis: number): boolean {
  const state = pad.buttons[button];
  if (state?.pressed === true) return true;
  if ((state?.value ?? 0) > TRIGGER_THRESHOLD) return true;
  if ((pad.mapping || "").toLowerCase() === "standard") return false;
  if (pad.axes.length <= 4) return false;
  return (pad.axes[axis] ?? 0) > TRIGGER_THRESHOLD;
}

/**
 * Clavier ZQSD + flèches. Les touches de direction sont suivies dans la boucle
 * rAF (comme le stick) : un appui maintenu fait défiler en continu.
 */
const DIRECTION_KEYS: Record<string, Direction> = {
  arrowup: "up",
  z: "up",
  w: "up",
  arrowdown: "down",
  s: "down",
  arrowleft: "left",
  q: "left",
  arrowright: "right",
  d: "right",
};

export interface GamepadOptions {
  /**
   * Hook global (App) : suspendu quand une zone locale (menu du haut) prend la
   * main, pour que Croix / Gauche / Droite n'agisse pas aussi sur le ruban.
   */
  suspendable?: boolean;
}

let globalInputLocked = false;
// Deux causes distinctes de suspension, combinées en un seul drapeau : une
// session de jeu (splash puis partie) et une fenêtre en arrière-plan (pilotée
// par le verrou audio `useAudioGate`).
let gamepadGameSuspended = false;
let gamepadBackgroundSuspended = false;
let gamepadSuspended = false;

/** Bloque les hooks globaux pendant qu'une zone locale navigue. */
export function setGlobalGamepadLock(locked: boolean) {
  globalInputLocked = locked;
}

// Mode d'entrée global : la manette masque le curseur, la souris le restaure.
let inputMode: InputMode = "mouse";

export function getInputMode(): InputMode {
  return inputMode;
}

/** Applique le mode d'entrée et la classe CSS qui masque / restaure le pointeur. */
export function setInputMode(mode: InputMode) {
  if (inputMode === mode) return;
  inputMode = mode;
  if (typeof document !== "undefined") {
    const gamepadMode = mode === "gamepad";
    document.documentElement.classList.toggle("input-mode-gamepad", gamepadMode);
    document.body?.classList.toggle("input-mode-gamepad", gamepadMode);
  }
}

/**
 * Vrai quand un clic doit être ignoré : en mode manette, seul le clic réel
 * d'une souris (`detail > 0`) est bloqué, afin qu'aucune action ni bruitage ne
 * parte de l'élément situé sous le pointeur invisible. L'activation clavier
 * (`detail === 0`) et l'activation programmée par la manette
 * (`element.click()`, également `detail === 0`) restent opérationnelles.
 */
export function shouldIgnoreClick(event: { detail: number }): boolean {
  return inputMode !== "mouse" && event.detail > 0;
}

// Référence native capturée avant les masquages locaux (panneau d'options) :
// la détection du mode manette doit continuer à voir la vraie manette.
const nativeGetGamepads =
  typeof navigator !== "undefined" && typeof navigator.getGamepads === "function"
    ? navigator.getGamepads.bind(navigator)
    : null;

/** Vrai dès qu'un bouton est pressé ou qu'un stick dépasse la zone morte. */
function gamepadActivity(): boolean {
  for (const pad of nativeGetGamepads?.() ?? []) {
    if (!pad?.connected) continue;
    if (
      pad.buttons.some(
        (button) => button.pressed || button.value > ACTIVITY_BUTTON,
      )
    ) {
      return true;
    }
    if (pad.axes.some((axis) => Math.abs(axis) > ACTIVITY_AXIS)) return true;
  }
  return false;
}

// Une session de jeu arrête complètement le polling : plus aucune boucle
// requestAnimationFrame ne tourne tant que le launcher est en arrière-plan.
const suspensionListeners = new Set<(suspended: boolean) => void>();

/** Prévient les écouteurs souris globaux des suspensions de la boucle manette. */
export function subscribeGamepadSuspension(
  listener: (suspended: boolean) => void,
): () => void {
  suspensionListeners.add(listener);
  return () => {
    suspensionListeners.delete(listener);
  };
}

function syncSuspension() {
  const next = gamepadGameSuspended || gamepadBackgroundSuspended;
  if (gamepadSuspended === next) return;
  gamepadSuspended = next;
  for (const listener of suspensionListeners) listener(next);
}

/** Suspend (ou relance) la boucle manette pendant une session de jeu. */
export function setGamepadSuspended(suspended: boolean) {
  if (gamepadGameSuspended === suspended) return;
  gamepadGameSuspended = suspended;
  syncSuspension();
}

/**
 * Suspend la boucle manette quand la fenêtre passe en arrière-plan : plus aucun
 * requestAnimationFrame ne tourne (0 % CPU launcher). La manette reste lue
 * pendant le splash, la fenêtre étant alors au premier plan.
 */
export function setGamepadBackgroundSuspended(suspended: boolean) {
  if (gamepadBackgroundSuspended === suspended) return;
  gamepadBackgroundSuspended = suspended;
  syncSuspension();
}

/** Vrai pendant une session de jeu : aucune entrée du launcher n'est lue. */
export function isGamepadSuspended(): boolean {
  return gamepadSuspended;
}

/**
 * Retour haptique PS4 (dual-rumble). Ne lève jamais d'erreur : l'API peut
 * manquer (macOS, manette filaire sans vibreur, navigateur sans support), dans
 * ce cas le son système reste seul.
 */
export function triggerHaptic(
  durationMs = 120,
  weakMagnitude = 0.35,
  strongMagnitude = 0.6,
) {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.getGamepads !== "function"
  ) {
    return;
  }

  try {
    for (const pad of navigator.getGamepads() ?? []) {
      if (!pad?.connected) continue;
      const actuator = (
        pad as Gamepad & {
          vibrationActuator?: {
            playEffect?: (
              type: string,
              params: Record<string, number>,
            ) => Promise<unknown> | undefined;
          };
        }
      ).vibrationActuator;
      if (!actuator?.playEffect) continue;

      const effect = actuator.playEffect("dual-rumble", {
        startDelay: 0,
        duration: durationMs,
        weakMagnitude,
        strongMagnitude,
      });
      if (effect && typeof effect.catch === "function") {
        void effect.catch(() => {});
      }
    }
  } catch {
    // Vibreur indisponible : on ne perturbe jamais le son ni la navigation.
  }
}

// Boutons d'action : un seul déclenchement par pression (pas de répétition).
const CONFIRM_KEYS = new Set(["a", "enter"]);
const BACK_KEYS = new Set(["b", "escape", "backspace"]);
const OPTIONS_KEYS = new Set(["y", "o"]);
const SQUARE_KEYS = new Set(["x"]);

/** Identifiant de touche insensible à la casse et à la disposition du clavier. */
function keyId(key: string): string {
  return key.toLowerCase();
}

/**
 * Vrai si la frappe part vers un champ de saisie (input, textarea, select ou
 * contenu éditable) : aucun raccourci ZQSD / A / B / Y / X ne doit alors partir.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const candidates: (EventTarget | Element | null)[] = [
    target,
    document.activeElement,
  ];
  return candidates.some((candidate) => {
    const element = candidate as HTMLElement | null;
    if (!element || typeof element.tagName !== "string") return false;
    return (
      element.isContentEditable ||
      element.tagName === "INPUT" ||
      element.tagName === "TEXTAREA" ||
      element.tagName === "SELECT"
    );
  });
}

/** Vrai si la touche fait partie du mappage manette (à avaler par les modales). */
export function isMenuKey(key: string): boolean {
  const id = keyId(key);
  return (
    id in DIRECTION_KEYS ||
    CONFIRM_KEYS.has(id) ||
    BACK_KEYS.has(id) ||
    OPTIONS_KEYS.has(id) ||
    SQUARE_KEYS.has(id)
  );
}

/** Vrai si une touche modifier système accompagne la frappe (Cmd, Ctrl, Alt). */
export function hasSystemModifier(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey || event.altKey;
}

export function useGamepad(
  handlers: GamepadHandlers,
  options?: GamepadOptions,
) {
  const suspendable = options?.suspendable === true;
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    let frame = 0;
    let animating = false;
    let lastNav = 0;
    let confirmHeld = false;
    let backHeld = false;
    let optionsHeld = false;
    let squareHeld = false;
    let l1Held = false;
    let r1Held = false;
    let l2Held = false;
    let r2Held = false;
    // Touches réellement enfoncées (identifiants minuscules) : deux touches
    // peuvent pointer la même direction (ex. flèche haute + Z).
    const heldKeys = new Set<string>();

    const heldDirection = (direction: Direction) => {
      for (const key of heldKeys) {
        if (DIRECTION_KEYS[key] === direction) return true;
      }
      return false;
    };

    const stepDirection = (
      now: number,
      left: boolean,
      right: boolean,
      up: boolean,
      down: boolean,
    ) => {
      if (!(left || right || up || down)) return;
      if (now - lastNav < COOLDOWN_MS) return;
      const current = handlersRef.current;
      const handler = left
        ? current.onLeft
        : right
          ? current.onRight
          : up
            ? current.onUp
            : current.onDown;
      if (!handler) return;
      lastNav = now;
      handler();
    };

    const syncActionEdges = () => {
      let confirm = false;
      let back = false;
      let options = false;
      let square = false;
      let l1 = false;
      let r1 = false;
      let l2 = false;
      let r2 = false;

      for (const pad of navigator.getGamepads?.() ?? []) {
        if (!pad?.connected) continue;
        const pressed = (index: number) => pad.buttons[index]?.pressed === true;
        confirm = confirm || pressed(BUTTON_CONFIRM);
        back = back || pressed(BUTTON_BACK);
        options =
          options || pressed(BUTTON_OPTIONS) || pressed(BUTTON_TRIANGLE);
        square = square || pressed(BUTTON_SQUARE);
        l1 = l1 || pressed(BUTTON_L1);
        r1 = r1 || pressed(BUTTON_R1);
        l2 = l2 || triggerDown(pad, BUTTON_L2, 2);
        r2 = r2 || triggerDown(pad, BUTTON_R2, 5);
      }

      confirmHeld = confirm;
      backHeld = back;
      optionsHeld = options;
      squareHeld = square;
      l1Held = l1;
      r1Held = r1;
      l2Held = l2;
      r2Held = r2;
    };

    const tick = (now: number) => {
      // Jeu en cours : la boucle s'arrête net au lieu de continuer à vide.
      if (gamepadSuspended) {
        animating = false;
        frame = 0;
        return;
      }
      // Toute activité manette masque immédiatement le curseur, y compris
      // pendant qu'une zone locale (modale, menu du haut) tient la navigation.
      if (gamepadActivity()) setInputMode("gamepad");
      frame = requestAnimationFrame(tick);

      // Zone locale active : on garde les fronts à jour pour qu'un bouton
      // maintenu pendant le verrouillage ne parte pas au déverrouillage.
      if (suspendable && globalInputLocked) {
        heldKeys.clear();
        syncActionEdges();
        return;
      }

      let left = heldDirection("left");
      let right = heldDirection("right");
      let up = heldDirection("up");
      let down = heldDirection("down");
      let confirm = false;
      let back = false;
      let options = false;
      let square = false;
      let l1 = false;
      let r1 = false;
      let l2 = false;
      let r2 = false;

      for (const pad of navigator.getGamepads?.() ?? []) {
        if (!pad?.connected) continue;
        const pressed = (index: number) => pad.buttons[index]?.pressed === true;
        left = left || pressed(DPAD_LEFT) || pad.axes[0] < -STICK_DEADZONE;
        right = right || pressed(DPAD_RIGHT) || pad.axes[0] > STICK_DEADZONE;
        up = up || pressed(DPAD_UP) || pad.axes[1] < -STICK_DEADZONE;
        down = down || pressed(DPAD_DOWN) || pad.axes[1] > STICK_DEADZONE;
        confirm = confirm || pressed(BUTTON_CONFIRM);
        back = back || pressed(BUTTON_BACK);
        options =
          options || pressed(BUTTON_OPTIONS) || pressed(BUTTON_TRIANGLE);
        square = square || pressed(BUTTON_SQUARE);
        l1 = l1 || pressed(BUTTON_L1);
        r1 = r1 || pressed(BUTTON_R1);
        l2 = l2 || triggerDown(pad, BUTTON_L2, 2);
        r2 = r2 || triggerDown(pad, BUTTON_R2, 5);
      }

      stepDirection(now, left, right, up, down);

      if (confirm && !confirmHeld) handlersRef.current.onConfirm?.();
      confirmHeld = confirm;

      if (back && !backHeld) handlersRef.current.onBack?.();
      backHeld = back;

      if (options && !optionsHeld) handlersRef.current.onOptions?.();
      optionsHeld = options;

      if (square && !squareHeld) handlersRef.current.onSquare?.();
      squareHeld = square;

      if (l1 && !l1Held) handlersRef.current.onL1?.();
      l1Held = l1;

      if (r1 && !r1Held) handlersRef.current.onR1?.();
      r1Held = r1;

      if (l2 && !l2Held) handlersRef.current.onL2?.();
      l2Held = l2;

      if (r2 && !r2Held) handlersRef.current.onR2?.();
      r2Held = r2;
    };

    const startLoop = () => {
      if (animating || gamepadSuspended) return;
      animating = true;
      frame = requestAnimationFrame(tick);
    };

    const stopLoop = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      animating = false;
    };

    const onSuspended = (suspended: boolean) => {
      if (suspended) {
        heldKeys.clear();
        stopLoop();
      } else {
        lastNav = 0;
        startLoop();
      }
    };

    suspensionListeners.add(onSuspended);
    startLoop();

    const onKeyDown = (event: KeyboardEvent) => {
      if (gamepadSuspended) return;
      if (hasSystemModifier(event)) return;
      if (suspendable && globalInputLocked) return;

      const id = keyId(event.key);

      if (isTypingTarget(event.target)) {
        // En saisie, seul Échap agit : il quitte proprement le champ. Les
        // lettres continuent d'écrire (A, B, X, Y, Z, Q, S, D restent du texte).
        if (id === "escape") {
          event.stopPropagation();
          const active = document.activeElement as HTMLElement | null;
          if (active && typeof active.blur === "function") active.blur();
        }
        return;
      }

      const direction = DIRECTION_KEYS[id];
      if (direction) {
        event.preventDefault();
        heldKeys.add(id);
        // Réponse immédiate : un tap très bref peut se terminer avant le tick.
        stepDirection(
          performance.now(),
          heldDirection("left"),
          heldDirection("right"),
          heldDirection("up"),
          heldDirection("down"),
        );
        return;
      }

      if (event.repeat) return;

      const current = handlersRef.current;

      if (CONFIRM_KEYS.has(id)) {
        event.preventDefault();
        current.onConfirm?.();
      } else if (BACK_KEYS.has(id)) {
        event.preventDefault();
        current.onBack?.();
      } else if (OPTIONS_KEYS.has(id)) {
        event.preventDefault();
        current.onOptions?.();
      } else if (SQUARE_KEYS.has(id)) {
        event.preventDefault();
        current.onSquare?.();
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      const id = keyId(event.key);
      if (id in DIRECTION_KEYS) heldKeys.delete(id);
    };

    const onBlur = () => heldKeys.clear();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

    return () => {
      suspensionListeners.delete(onSuspended);
      stopLoop();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
}
