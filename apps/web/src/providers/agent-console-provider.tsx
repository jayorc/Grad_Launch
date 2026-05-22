"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AgentTimelineStep, ApplicationRun, BrowserExecutionSession } from "@gradlaunch/shared";
import { getAgentControlPlane } from "../lib/api";
import { useAuth } from "./auth-provider";

type AgentConsoleMode = "draft" | "autofill" | "autopilot" | "browser_fill" | null;
type AgentConsoleVariant = "success" | "duplicate" | "error" | null;

type AgentConsoleState = {
  open: boolean;
  mode: AgentConsoleMode;
  title: string;
  message: string | null;
  steps: AgentTimelineStep[];
  run: ApplicationRun | null;
  variant: AgentConsoleVariant;
  updatedAt: number | null;
};

type AgentConsoleContextValue = {
  panel: AgentConsoleState;
  beginExecution: (input: {
    mode: AgentConsoleMode;
    title: string;
    message: string | null;
    steps: AgentTimelineStep[];
  }) => void;
  updateExecution: (input: {
    title?: string;
    message?: string | null;
    steps?: AgentTimelineStep[];
    run?: ApplicationRun | null;
    variant?: AgentConsoleVariant;
  }) => void;
  completeExecution: (input: {
    mode: AgentConsoleMode;
    title: string;
    message: string | null;
    run: ApplicationRun | null;
    steps: AgentTimelineStep[];
    variant: AgentConsoleVariant;
  }) => void;
  setOpen: (open: boolean) => void;
  clear: () => void;
};

const defaultPanel: AgentConsoleState = {
  open: false,
  mode: null,
  title: "Agent standing by",
  message: "Start a draft or browser run and the live execution conversation will appear here.",
  steps: [],
  run: null,
  variant: null,
  updatedAt: null
};

const storageKey = "gradlaunch_agent_console";
const liveBrowserStatuses = new Set<BrowserExecutionSession["status"]>(["running", "waiting"]);

const AgentConsoleContext = createContext<AgentConsoleContextValue | null>(null);

export function AgentConsoleProvider({ children }: { children: ReactNode }) {
  const [panel, setPanel] = useState<AgentConsoleState>(defaultPanel);
  const { session } = useAuth();

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(storageKey);

      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as AgentConsoleState;
      setPanel({
        ...defaultPanel,
        ...parsed
      });
    } catch (_error) {
      window.sessionStorage.removeItem(storageKey);
    }
  }, []);

  useEffect(() => {
    window.sessionStorage.setItem(storageKey, JSON.stringify(panel));
  }, [panel]);

  useEffect(() => {
    const token = session?.token;
    const shouldTrackBrowserRun = panel.open && panel.mode === "browser_fill" && panel.run === null && panel.variant !== "error";

    if (!token) {
      return undefined;
    }

    const authToken = token;

    let cancelled = false;
    let pollTimer: number | undefined;
    let requestInFlight = false;
    let failureCount = 0;

    function scheduleNextPoll(delayMs: number) {
      if (cancelled) {
        return;
      }

      window.clearTimeout(pollTimer);
      pollTimer = window.setTimeout(() => {
        void hydrateFromServer();
      }, delayMs);
    }

    async function hydrateFromServer() {
      if (cancelled || requestInFlight) {
        return;
      }

      requestInFlight = true;

      try {
        const snapshot = await getAgentControlPlane(authToken);
        const latestSession = [...snapshot.browserSessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
        failureCount = 0;

        if (!latestSession || cancelled) {
          if (shouldTrackBrowserRun) {
            scheduleNextPoll(document.hidden ? 8000 : 3000);
          }
          return;
        }

        const shouldContinuePolling = liveBrowserStatuses.has(latestSession.status) || shouldTrackBrowserRun;

        setPanel((current) => {
          const serverUpdatedAt = Date.parse(latestSession.updatedAt);

          if (current.updatedAt && current.updatedAt >= serverUpdatedAt) {
            return current;
          }

          return buildPanelFromBrowserSession(latestSession);
        });
        if (shouldContinuePolling) {
          scheduleNextPoll(document.hidden ? 8000 : 3000);
        }
      } catch (_error) {
        failureCount += 1;
        const backoffMs = Math.min(3000 * 2 ** (failureCount - 1), 20000);
        if (shouldTrackBrowserRun) {
          scheduleNextPoll(backoffMs);
        }
      } finally {
        requestInFlight = false;
      }
    }

    void hydrateFromServer();

    return () => {
      cancelled = true;
      window.clearTimeout(pollTimer);
    };
  }, [panel.mode, panel.open, panel.run, panel.variant, session?.token]);

  const beginExecution = useCallback((input: {
    mode: AgentConsoleMode;
    title: string;
    message: string | null;
    steps: AgentTimelineStep[];
  }) => {
    setPanel({
      open: true,
      mode: input.mode,
      title: input.title,
      message: input.message,
      steps: input.steps,
      run: null,
      variant: null,
      updatedAt: Date.now()
    });
  }, []);

  const updateExecution = useCallback((input: {
    title?: string;
    message?: string | null;
    steps?: AgentTimelineStep[];
    run?: ApplicationRun | null;
    variant?: AgentConsoleVariant;
  }) => {
    setPanel((current) => ({
      ...current,
      open: true,
      title: input.title ?? current.title,
      message: input.message === undefined ? current.message : input.message,
      steps: input.steps ?? current.steps,
      run: input.run === undefined ? current.run : input.run,
      variant: input.variant === undefined ? current.variant : input.variant,
      updatedAt: Date.now()
    }));
  }, []);

  const completeExecution = useCallback((input: {
    mode: AgentConsoleMode;
    title: string;
    message: string | null;
    run: ApplicationRun | null;
    steps: AgentTimelineStep[];
    variant: AgentConsoleVariant;
  }) => {
    setPanel({
      open: true,
      mode: input.mode,
      title: input.title,
      message: input.message,
      steps: input.steps,
      run: input.run,
      variant: input.variant,
      updatedAt: Date.now()
    });
  }, []);

  const setPanelOpen = useCallback((open: boolean) => {
    setPanel((current) => ({
      ...current,
      open
    }));
  }, []);

  const clear = useCallback(() => {
    setPanel(defaultPanel);
  }, []);

  const value: AgentConsoleContextValue = useMemo(() => ({
    panel,
    beginExecution,
    updateExecution,
    completeExecution,
    setOpen: setPanelOpen,
    clear
  }), [beginExecution, clear, completeExecution, panel, setPanelOpen, updateExecution]);

  return <AgentConsoleContext.Provider value={value}>{children}</AgentConsoleContext.Provider>;
}

function buildPanelFromBrowserSession(session: BrowserExecutionSession): AgentConsoleState {
  return {
    open: true,
    mode: "browser_fill",
    title: session.status === "waiting"
      ? "Browser session waiting"
      : session.status === "review_ready"
        ? "Browser session ready for review"
        : session.status === "submitted"
          ? "Browser session submitted"
          : session.status === "blocked"
            ? "Browser session blocked"
            : session.status === "resumable"
              ? "Browser session ready to resume"
              : "Browser session running",
    message: session.latestMessage,
    steps: session.latestSteps,
    run: null,
    variant: session.status === "blocked" ? "error" : null,
    updatedAt: Date.parse(session.updatedAt)
  };
}

export function useAgentConsole() {
  const context = useContext(AgentConsoleContext);

  if (!context) {
    throw new Error("useAgentConsole must be used inside AgentConsoleProvider.");
  }

  return context;
}
