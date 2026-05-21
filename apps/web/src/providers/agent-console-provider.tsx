"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AgentTimelineStep, ApplicationRun } from "@gradlaunch/shared";

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

const AgentConsoleContext = createContext<AgentConsoleContextValue | null>(null);

export function AgentConsoleProvider({ children }: { children: ReactNode }) {
  const [panel, setPanel] = useState<AgentConsoleState>(defaultPanel);

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

export function useAgentConsole() {
  const context = useContext(AgentConsoleContext);

  if (!context) {
    throw new Error("useAgentConsole must be used inside AgentConsoleProvider.");
  }

  return context;
}
