import type { Page } from "playwright-core";

type BotMood = "thinking" | "acting" | "waiting" | "done";

export async function updateLiveBot(
  page: Page,
  input: {
    title?: string;
    message: string;
    mood: BotMood;
    step?: string;
  }
) {
  await page.evaluate(({ title, message, mood, step }) => {
    const rootId = "gradlaunch-live-bot";
    const existing = document.getElementById(rootId);
    const root = existing ?? document.createElement("div");
    const botRoot = root as HTMLElement & {
      __gradlaunchBotState?: {
        dragging: boolean;
        listenersBound: boolean;
        offsetX: number;
        offsetY: number;
        position: { left: number; top: number } | null;
      };
    };
    const state = botRoot.__gradlaunchBotState ?? {
      dragging: false,
      listenersBound: false,
      offsetX: 0,
      offsetY: 0,
      position: null
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
        bottom: 18px;
        z-index: 2147483647;
        width: 154px;
        user-select: none;
        pointer-events: auto;
        font-family: "Avenir Next", "Segoe UI", Arial, sans-serif;
      }
      #${rootId} * { box-sizing: border-box; }
      #${rootId} .gl-bot-shell {
        position: relative;
        width: 154px;
        min-height: 164px;
      }
      #${rootId} .gl-cloud {
        position: absolute;
        left: 4px;
        right: 4px;
        top: 0;
        padding: 10px 12px;
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
      }
      #${rootId} .gl-message {
        margin: 0;
        font-size: 12px;
        line-height: 1.35;
        font-weight: 700;
      }
      #${rootId} .gl-body {
        position: absolute;
        right: 28px;
        bottom: 0;
        width: 78px;
        height: 88px;
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
        left: 14px;
        top: 82px;
        font-size: 10px;
        font-weight: 800;
        color: #48627f;
      }
      @keyframes gl-bot-blink {
        0%, 100% { transform: scale(1); opacity: 1; }
        50% { transform: scale(0.55); opacity: 0.65; }
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

    function applySavedPosition(panel: HTMLElement, botState: typeof state) {
      if (!botState.position) {
        panel.style.left = "";
        panel.style.top = "";
        panel.style.right = "18px";
        panel.style.bottom = "18px";
        return;
      }

      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.left = `${botState.position.left}px`;
      panel.style.top = `${botState.position.top}px`;
    }

    function attachDrag(panel: HTMLElement, handle: HTMLElement, botState: typeof state) {
      handle.onmousedown = (event) => {
        botState.dragging = true;
        const rect = panel.getBoundingClientRect();
        botState.offsetX = event.clientX - rect.left;
        botState.offsetY = event.clientY - rect.top;
        panel.style.right = "auto";
        panel.style.bottom = "auto";
        event.preventDefault();
      };

      if (botState.listenersBound) {
        return;
      }

      botState.listenersBound = true;

      document.addEventListener("mousemove", (event) => {
        if (!botState.dragging) {
          return;
        }

        const left = Math.min(Math.max(8, event.clientX - botState.offsetX), window.innerWidth - panel.offsetWidth - 8);
        const top = Math.min(Math.max(8, event.clientY - botState.offsetY), window.innerHeight - panel.offsetHeight - 8);
        botState.position = { left, top };
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
      });

      document.addEventListener("mouseup", () => {
        botState.dragging = false;
      });
    }
  }, input).catch(() => undefined);
}
