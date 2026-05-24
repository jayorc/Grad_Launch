import type { BrowserContext, Page } from "playwright-core";

type BotMood = "thinking" | "acting" | "waiting" | "done";
type BotAction = { kind: "confirm_continue"; label?: string };
type BotPosition = { left: number; top: number };
type BotState = {
  dragging: boolean;
  listenersBound: boolean;
  offsetX: number;
  offsetY: number;
  position: BotPosition | null;
  stopRequested: boolean;
  continueRequested: boolean;
};

const stopRequestedContexts = new WeakSet<BrowserContext>();
const continueRequestedContexts = new WeakSet<BrowserContext>();

export async function clearUserStopRequest(page: Page) {
  stopRequestedContexts.delete(page.context());

  await page.evaluate(() => {
    const root = document.getElementById("gradlaunch-live-bot") as (HTMLElement & {
      __gradlaunchBotState?: { stopRequested?: boolean };
    }) | null;

    if (!root) {
      return;
    }

    root.removeAttribute("data-gradlaunch-stop-requested");

    if (root.__gradlaunchBotState) {
      root.__gradlaunchBotState.stopRequested = false;
    }
  }).catch(() => undefined);
}

export async function clearUserContinueRequest(page: Page) {
  continueRequestedContexts.delete(page.context());

  await Promise.all(page.context().pages().filter((candidate) => !candidate.isClosed()).map((candidate) => {
    return candidate.evaluate(() => {
      const root = document.getElementById("gradlaunch-live-bot") as (HTMLElement & {
        __gradlaunchBotState?: { continueRequested?: boolean };
      }) | null;

      if (!root) {
        return;
      }

      root.removeAttribute("data-gradlaunch-continue-requested");

      if (root.__gradlaunchBotState) {
        root.__gradlaunchBotState.continueRequested = false;
      }
    }).catch(() => undefined);
  }));
}

export async function updateLiveBot(
  page: Page,
  input: {
    title?: string;
    message: string;
    mood: BotMood;
    step?: string;
    action?: BotAction;
  }
) {
  await page.exposeFunction("__gradlaunchRequestStop", () => {
    stopRequestedContexts.add(page.context());
    return true;
  }).catch(() => undefined);

  await page.exposeFunction("__gradlaunchConfirmContinue", () => {
    continueRequestedContexts.add(page.context());
    return true;
  }).catch(() => undefined);

  await page.evaluate(({ title, message, mood, step, action }) => {
    const rootId = "gradlaunch-live-bot";
    const existing = document.getElementById(rootId);
    const root = existing ?? document.createElement("div");
    const botRoot = root as HTMLElement & {
      __gradlaunchBotState?: BotState;
    };
    const state: BotState = botRoot.__gradlaunchBotState ?? {
      dragging: false,
      listenersBound: false,
      offsetX: 0,
      offsetY: 0,
      position: null,
      stopRequested: false,
      continueRequested: false
    };
    botRoot.__gradlaunchBotState = state;

    if (!existing) {
      root.id = rootId;
      document.documentElement.appendChild(root);
    }

    root.innerHTML = "";

    const style = document.createElement("style");
    style.textContent = `
      #${rootId} {
        all: initial;
        position: fixed;
        right: 18px;
        top: 18px;
        z-index: 2147483647;
        width: min(196px, calc(100vw - 24px));
        max-width: calc(100vw - 24px);
        user-select: none;
        pointer-events: auto;
        font-family: "Avenir Next", "Segoe UI", Arial, sans-serif;
        touch-action: none;
      }
      #${rootId} * { box-sizing: border-box; }
      #${rootId} .gl-bot-shell {
        position: relative;
        width: min(196px, calc(100vw - 24px));
        min-height: 228px;
      }
      #${rootId} .gl-cloud {
        position: absolute;
        left: 4px;
        right: 4px;
        top: 0;
        min-height: 132px;
        padding: 12px 14px 28px;
        border-radius: 22px;
        background: rgba(255, 255, 255, 0.96);
        border: 1px solid rgba(23, 37, 84, 0.14);
        box-shadow: 0 18px 40px rgba(15, 23, 42, 0.18);
        color: #132238;
      }
      #${rootId} .gl-cloud::after {
        content: "";
        position: absolute;
        left: 52px;
        bottom: -10px;
        width: 18px;
        height: 18px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.96);
        border: 1px solid rgba(23, 37, 84, 0.1);
      }
      #${rootId} .gl-cloud::before {
        content: "";
        position: absolute;
        left: 68px;
        bottom: -20px;
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.96);
        border: 1px solid rgba(23, 37, 84, 0.08);
      }
      #${rootId} .gl-step {
        margin: 0 0 4px;
        color: #4b6482;
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        padding-right: 56px;
      }
      #${rootId} .gl-message {
        margin: 0;
        font-size: 12px;
        line-height: 1.45;
        font-weight: 700;
        padding-right: 8px;
        overflow-wrap: anywhere;
      }
      #${rootId} .gl-stop {
        position: absolute;
        top: 12px;
        right: 12px;
        border: 0;
        border-radius: 999px;
        background: #e11d48;
        color: #fff;
        font-size: 10px;
        font-weight: 800;
        line-height: 1;
        padding: 7px 9px;
        cursor: pointer;
        box-shadow: 0 8px 16px rgba(225, 29, 72, 0.25);
      }
      #${rootId} .gl-stop:disabled {
        opacity: 0.82;
        cursor: default;
      }
      #${rootId} .gl-actions {
        display: grid;
        gap: 6px;
        margin-top: 10px;
        padding-right: 4px;
      }
      #${rootId} .gl-confirm {
        border: 0;
        border-radius: 999px;
        background: linear-gradient(180deg, #16a34a, #15803d);
        color: #fff;
        font-size: 10px;
        font-weight: 900;
        line-height: 1.2;
        padding: 8px 10px;
        cursor: pointer;
        box-shadow: 0 10px 20px rgba(21, 128, 61, 0.24);
      }
      #${rootId} .gl-confirm:disabled {
        opacity: 0.84;
        cursor: default;
      }
      #${rootId} .gl-body {
        position: absolute;
        left: 50%;
        top: 146px;
        transform: translateX(-50%);
        width: 86px;
        height: 92px;
        cursor: grab;
      }
      #${rootId} .gl-body:active {
        cursor: grabbing;
      }
      #${rootId} .gl-head {
        position: absolute;
        left: 9px;
        top: 0;
        width: 60px;
        height: 48px;
        border-radius: 20px;
        background: linear-gradient(180deg, #eef7ff, #dcecff);
        border: 2px solid #183b63;
        box-shadow: 0 10px 24px rgba(24, 59, 99, 0.18);
      }
      #${rootId} .gl-face {
        position: absolute;
        left: 11px;
        top: 12px;
        width: 36px;
        height: 16px;
        border-radius: 12px;
        background: #11263f;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
      }
      #${rootId} .gl-eye {
        width: 6px;
        height: 6px;
        border-radius: 999px;
        background: #71d7ff;
      }
      #${rootId} .gl-thinking .gl-eye {
        animation: gl-bot-blink 1.2s ease-in-out infinite;
      }
      #${rootId} .gl-acting .gl-eye {
        background: #4ade80;
      }
      #${rootId} .gl-waiting .gl-eye {
        background: #f59e0b;
      }
      #${rootId} .gl-done .gl-eye {
        background: #60a5fa;
      }
      #${rootId} .gl-antenna {
        position: absolute;
        left: 28px;
        top: -12px;
        width: 4px;
        height: 14px;
        border-radius: 999px;
        background: #183b63;
      }
      #${rootId} .gl-antenna::after {
        content: "";
        position: absolute;
        left: -4px;
        top: -6px;
        width: 12px;
        height: 12px;
        border-radius: 999px;
        background: #71d7ff;
      }
      #${rootId} .gl-torso {
        position: absolute;
        left: 16px;
        top: 50px;
        width: 46px;
        height: 30px;
        border-radius: 16px;
        background: linear-gradient(180deg, #d9ebff, #c7dcf5);
        border: 2px solid #183b63;
      }
      #${rootId} .gl-torso::after {
        content: "";
        position: absolute;
        left: 16px;
        top: 9px;
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: #183b63;
      }
      #${rootId} .gl-drag {
        position: absolute;
        left: 8px;
        right: 8px;
        top: 82px;
        font-size: 10px;
        font-weight: 800;
        color: #48627f;
        text-align: center;
      }
      @keyframes gl-bot-blink {
        0%, 100% { transform: scale(1); opacity: 1; }
        50% { transform: scale(0.55); opacity: 0.65; }
      }
      @media (max-width: 720px) {
        #${rootId} {
          right: 12px;
          top: 12px;
          width: min(176px, calc(100vw - 20px));
        }
        #${rootId} .gl-bot-shell {
          width: min(176px, calc(100vw - 20px));
          min-height: 210px;
        }
        #${rootId} .gl-cloud {
          min-height: 122px;
          padding: 10px 12px 24px;
        }
        #${rootId} .gl-message {
          font-size: 11px;
        }
        #${rootId} .gl-body {
          top: 134px;
          width: 80px;
          height: 88px;
        }
      }
    `;

    const shell = document.createElement("div");
    shell.className = "gl-bot-shell";

    const cloud = document.createElement("div");
    cloud.className = "gl-cloud";

    if (step) {
      const stepLabel = document.createElement("p");
      stepLabel.className = "gl-step";
      stepLabel.textContent = step;
      cloud.appendChild(stepLabel);
    }

    const text = document.createElement("p");
    text.className = "gl-message";
    text.textContent = message;
    cloud.appendChild(text);

    if (action?.kind === "confirm_continue") {
      const actions = document.createElement("div");
      actions.className = "gl-actions";

      const confirm = document.createElement("button");
      confirm.className = "gl-confirm";
      confirm.textContent = action.label ?? "I am logged in, continue";
      confirm.type = "button";
      confirm.onclick = () => {
        state.continueRequested = true;
        root.setAttribute("data-gradlaunch-continue-requested", "true");
        confirm.textContent = "Checking...";
        confirm.disabled = true;
        void (window as typeof window & {
          __gradlaunchConfirmContinue?: () => Promise<boolean>;
        }).__gradlaunchConfirmContinue?.();
      };

      actions.appendChild(confirm);
      cloud.appendChild(actions);
    }

    const stop = document.createElement("button");
    stop.className = "gl-stop";
    stop.textContent = "Quit";
    stop.type = "button";
    stop.onclick = () => {
      state.stopRequested = true;
      root.setAttribute("data-gradlaunch-stop-requested", "true");
      stop.textContent = "Stopping";
      stop.disabled = true;
      void (window as typeof window & {
        __gradlaunchRequestStop?: () => Promise<boolean>;
      }).__gradlaunchRequestStop?.();
    };
    cloud.appendChild(stop);

    const body = document.createElement("div");
    body.className = `gl-body gl-${mood}`;

    const head = document.createElement("div");
    head.className = "gl-head";
    const antenna = document.createElement("div");
    antenna.className = "gl-antenna";
    head.appendChild(antenna);

    const face = document.createElement("div");
    face.className = "gl-face";
    face.appendChild(document.createElement("span")).className = "gl-eye";
    face.appendChild(document.createElement("span")).className = "gl-eye";
    head.appendChild(face);

    const torso = document.createElement("div");
    torso.className = "gl-torso";

    const drag = document.createElement("div");
    drag.className = "gl-drag";
    drag.textContent = title ?? "GradLaunch Bot";

    body.appendChild(head);
    body.appendChild(torso);
    body.appendChild(drag);
    shell.appendChild(cloud);
    shell.appendChild(body);
    root.appendChild(style);
    root.appendChild(shell);

    applySavedPosition(root, state);
    attachDrag(root, body, state);

    function clampPosition(panel: HTMLElement, position: BotPosition) {
      return {
        left: Math.min(Math.max(8, position.left), Math.max(8, window.innerWidth - panel.offsetWidth - 8)),
        top: Math.min(Math.max(8, position.top), Math.max(8, window.innerHeight - panel.offsetHeight - 8))
      };
    }

    function applySavedPosition(panel: HTMLElement, botState: BotState) {
      if (!botState.position) {
        panel.style.left = "";
        panel.style.top = "";
        panel.style.right = "18px";
        panel.style.bottom = "auto";
        return;
      }

      const clamped = clampPosition(panel, botState.position);
      botState.position = clamped;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.left = `${clamped.left}px`;
      panel.style.top = `${clamped.top}px`;
    }

    function attachDrag(panel: HTMLElement, handle: HTMLElement, botState: BotState) {
      handle.onpointerdown = (event) => {
        botState.dragging = true;
        const rect = panel.getBoundingClientRect();
        botState.offsetX = event.clientX - rect.left;
        botState.offsetY = event.clientY - rect.top;
        panel.style.right = "auto";
        panel.style.bottom = "auto";
        handle.setPointerCapture?.(event.pointerId);
        event.preventDefault();
      };

      if (botState.listenersBound) {
        return;
      }

      botState.listenersBound = true;

      document.addEventListener("pointermove", (event) => {
        if (!botState.dragging) {
          return;
        }

        const next = clampPosition(panel, {
          left: event.clientX - botState.offsetX,
          top: event.clientY - botState.offsetY
        });
        botState.position = next;
        panel.style.left = `${next.left}px`;
        panel.style.top = `${next.top}px`;
      });

      document.addEventListener("pointerup", () => {
        botState.dragging = false;
      });

      window.addEventListener("resize", () => {
        if (botState.position) {
          applySavedPosition(panel, botState);
        }
      });
    }
  }, input).catch(() => undefined);
}

export async function didUserRequestStop(page: Page) {
  if (stopRequestedContexts.has(page.context())) {
    return true;
  }

  return page.evaluate(() => {
    const root = document.getElementById("gradlaunch-live-bot") as (HTMLElement & {
      __gradlaunchBotState?: { stopRequested?: boolean };
    }) | null;

    return root?.dataset.gradlaunchStopRequested === "true" || root?.__gradlaunchBotState?.stopRequested === true;
  }).catch(() => false);
}

export async function isLiveBotMounted(page: Page) {
  return page.evaluate(() => {
    const root = document.getElementById("gradlaunch-live-bot");

    if (!(root instanceof HTMLElement) || !root.isConnected) {
      return false;
    }

    const style = window.getComputedStyle(root);
    const rect = root.getBoundingClientRect();

    return style.display !== "none"
      && style.visibility !== "hidden"
      && Number(style.opacity || "1") > 0
      && rect.width > 0
      && rect.height > 0;
  }).catch(() => false);
}

export async function consumeUserContinueConfirmation(page: Page) {
  const contextConfirmed = continueRequestedContexts.has(page.context());
  const pageConfirmations = await Promise.all(page.context().pages().filter((candidate) => !candidate.isClosed()).map((candidate) => {
    return candidate.evaluate(() => {
      const root = document.getElementById("gradlaunch-live-bot") as (HTMLElement & {
        __gradlaunchBotState?: { continueRequested?: boolean };
      }) | null;

      return root?.dataset.gradlaunchContinueRequested === "true" || root?.__gradlaunchBotState?.continueRequested === true;
    }).catch(() => false);
  }));
  const confirmed = contextConfirmed || pageConfirmations.some(Boolean);

  if (confirmed) {
    await clearUserContinueRequest(page);
  }

  return confirmed;
}
