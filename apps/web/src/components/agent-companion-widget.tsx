"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { BROWSER_APPLY_STATUS_LABELS } from "@gradlaunch/shared";
import { usePathname } from "next/navigation";
import { useAgentConsole } from "../providers/agent-console-provider";
import { useAuth } from "../providers/auth-provider";

type DragPosition = {
  x: number;
  y: number;
};

const positionStorageKey = "gradlaunch_agent_widget_position";

export function AgentCompanionWidget() {
  const pathname = usePathname();
  const { isAuthenticated } = useAuth();
  const { panel, setOpen, clear } = useAgentConsole();
  const widgetRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<DragPosition | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(positionStorageKey);

      if (!raw) {
        return;
      }

      setPosition(JSON.parse(raw) as DragPosition);
    } catch (_error) {
      window.localStorage.removeItem(positionStorageKey);
    }
  }, []);

  useEffect(() => {
    if (!position) {
      return;
    }

    window.localStorage.setItem(positionStorageKey, JSON.stringify(position));
  }, [position]);

  useEffect(() => {
    if (!dragging) {
      return undefined;
    }

    function handlePointerMove(event: PointerEvent) {
      setPosition({
        x: Math.max(12, event.clientX - dragOffset.current.x),
        y: Math.max(12, event.clientY - dragOffset.current.y)
      });
    }

    function handlePointerUp() {
      setDragging(false);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [dragging]);

  const browserReceipt = panel.run?.submission?.browser;
  const status = useMemo(() => {
    if (panel.variant === "error") {
      return "Needs attention";
    }

    if (browserReceipt?.status === "handoff_required") {
      return "Manual handoff";
    }

    if (panel.run?.status === "running") {
      return "Running";
    }

    if (panel.steps.some((step) => step.state === "running")) {
      return "Running";
    }

    if (panel.variant === "duplicate") {
      return "Already exists";
    }

    if (panel.run) {
      return "Saved";
    }

    return "Idle";
  }, [browserReceipt?.status, panel.run, panel.steps, panel.variant]);

  const visibleConversation = panel.steps.slice(0, panel.steps.length > 4 ? 4 : panel.steps.length);
  const showWidget = pathname !== "/login" && isAuthenticated;

  if (!showWidget) {
    return null;
  }

  const style = position
    ? {
        left: `${position.x}px`,
        top: `${position.y}px`,
        right: "auto",
        bottom: "auto"
      }
    : undefined;

  function handlePointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    const bounds = widgetRef.current?.getBoundingClientRect();

    if (!bounds) {
      return;
    }

    dragOffset.current = {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top
    };
    setDragging(true);
  }

  return (
    <aside
      className={`agent-companion ${panel.open ? "agent-companion-open" : "agent-companion-closed"} ${dragging ? "agent-companion-dragging" : ""}`}
      ref={widgetRef}
      style={style}
    >
      <div className="agent-companion-shell">
        <button
          aria-label="Drag agent companion"
          className="agent-companion-handle"
          onPointerDown={handlePointerDown}
          type="button"
        >
          <RobotAvatar active={status === "Running"} />
          <div className="agent-companion-handle-copy">
            <p className="eyebrow">Agent Companion</p>
            <strong>{panel.title}</strong>
          </div>
          <span className={`agent-companion-state agent-companion-state-${status.toLowerCase().replace(/\s+/g, "-")}`}>{status}</span>
        </button>

        <div className="agent-companion-actions">
          <button className="agent-companion-icon" onClick={() => setMinimized((value) => !value)} type="button">
            {minimized ? "Open" : "Hide"}
          </button>
          <button className="agent-companion-icon" onClick={() => setOpen(!panel.open)} type="button">
            {panel.open ? "Dock" : "Show"}
          </button>
          <button className="agent-companion-icon" onClick={clear} type="button">
            Clear
          </button>
        </div>

        {panel.open && !minimized ? (
          <div className="agent-companion-body">
            <p className="agent-companion-message">
              {panel.message ?? "I’m waiting for the next job search, draft, or browser automation run."}
            </p>

            <div className="agent-companion-conversation">
              {visibleConversation.length > 0 ? (
                visibleConversation.map((step) => (
                  <article className={`agent-companion-bubble agent-companion-bubble-${step.state}`} key={step.id}>
                    <strong>{step.label}</strong>
                    <p>{step.detail}</p>
                  </article>
                ))
              ) : (
                <article className="agent-companion-bubble agent-companion-bubble-queued">
                  <strong>Waiting for work</strong>
                  <p>Run a draft, guided fill, browser apply, or autopilot flow and I’ll narrate the execution here.</p>
                </article>
              )}
            </div>

            {browserReceipt ? (
              <div className="agent-companion-summary">
                <span className="agent-chip agent-chip-info">{BROWSER_APPLY_STATUS_LABELS[browserReceipt.status]}</span>
                <span className="agent-chip">{browserReceipt.filledLabels.length} filled</span>
                <span className="agent-chip">{browserReceipt.skippedLabels.length} manual</span>
              </div>
            ) : panel.run ? (
              <div className="agent-companion-summary">
                <span className="agent-chip">{panel.run.executionMode.replaceAll("_", " ")}</span>
                <span className="agent-chip">{panel.run.filledFields.length} prepared</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function RobotAvatar({ active }: { active: boolean }) {
  return (
    <span className={`agent-robot ${active ? "agent-robot-active" : ""}`} aria-hidden="true">
      <span className="agent-robot-antenna" />
      <span className="agent-robot-head">
        <span className="agent-robot-eye" />
        <span className="agent-robot-eye" />
      </span>
    </span>
  );
}
