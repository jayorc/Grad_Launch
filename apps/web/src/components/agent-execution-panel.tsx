"use client";

import Link from "next/link";
import type { AgentTimelineStep, ApplicationRun } from "@gradlaunch/shared";

type AgentExecutionPanelProps = {
  mode: "draft" | "autofill" | "autopilot" | "browser_fill" | null;
  pendingSteps: AgentTimelineStep[] | null;
  run: ApplicationRun | null;
  notice: string | null;
  variant: "success" | "duplicate" | "error" | null;
};

export function AgentExecutionPanel({ mode, pendingSteps, run, notice, variant }: AgentExecutionPanelProps) {
  if (!pendingSteps && !run && !notice) {
    return null;
  }

  const isRunning = Boolean(pendingSteps);
  const browserReceipt = run?.submission?.browser;
  const title = getTitle({ isRunning, mode, run, variant });
  const summary = getSummary({ isRunning, mode, run, variant, notice });

  return (
    <section className={`agent-live-panel ${isRunning ? "agent-live-panel-running" : ""}`}>
      <div className="agent-live-head">
        <div>
          <p className="eyebrow">{isRunning ? "Agent Working" : "Agent Output"}</p>
          <h4 className="agent-live-title">{title}</h4>
          <p className="muted">{summary}</p>
        </div>
        <span className={`agent-live-badge ${getBadgeClass({ isRunning, variant })}`}>
          {isRunning ? "Running" : getBadgeLabel(variant, run)}
        </span>
      </div>

      {isRunning ? (
        <div className="agent-loader-row">
          <span className="agent-loader-orb" />
          <p className="muted">GradLaunch is moving through the steps below and keeping the workspace updated while the agent continues in the background.</p>
        </div>
      ) : null}

      {pendingSteps ? (
        <div className="agent-mini-steps">
          {pendingSteps.map((step) => (
            <article className={`agent-mini-step agent-mini-step-${step.state}`} key={step.id}>
              <span className="agent-mini-dot" />
              <div>
                <div className="agent-step-headline">
                  <strong>{step.label}</strong>
                  <span className={`agent-source agent-source-${step.source}`}>{step.source === "aihawk" ? "AIHawk" : "GradLaunch"}</span>
                </div>
                <p className="muted">{step.detail}</p>
              </div>
            </article>
          ))}
        </div>
      ) : null}

      {run ? (
        <div className="agent-result-grid">
          <article className="agent-result-card">
            <p className="detail-label">Workspace folder</p>
            <p className="detail-value detail-wrap path-text">{run.workspacePath ?? "Not recorded yet"}</p>
          </article>
          <article className="agent-result-card">
            <p className="detail-label">Prepared fields</p>
            <p className="detail-value">{run.filledFields.length}</p>
          </article>
          <article className="agent-result-card">
            <p className="detail-label">Saved files</p>
            <p className="detail-value">{run.workspaceFiles.length}</p>
          </article>
        </div>
      ) : null}

      {browserReceipt ? (
        <div className="browser-result-summary">
          <article>
            <p className="detail-label">Browser status</p>
            <p className="detail-value">{browserReceipt.status.replaceAll("_", " ")}</p>
          </article>
          <article>
            <p className="detail-label">Filled on page</p>
            <p className="detail-value">{browserReceipt.filledLabels.length}</p>
          </article>
          <article>
            <p className="detail-label">Needs manual check</p>
            <p className="detail-value">{browserReceipt.skippedLabels.length}</p>
          </article>
          <article>
            <p className="detail-label">Screenshots saved</p>
            <p className="detail-value">{browserReceipt.screenshots.length}</p>
          </article>
        </div>
      ) : null}

      {browserReceipt?.filledLabels.length ? (
        <div className="agent-chip-list" aria-label="Filled fields">
          {browserReceipt.filledLabels.slice(0, 10).map((label) => (
            <span className="agent-chip agent-chip-success" key={label}>{label}</span>
          ))}
        </div>
      ) : null}

      {browserReceipt?.skippedLabels.length ? (
        <p className="agent-live-note agent-live-note-warning">
          Manual check needed for: {browserReceipt.skippedLabels.slice(0, 6).join(", ")}
          {browserReceipt.skippedLabels.length > 6 ? `, and ${browserReceipt.skippedLabels.length - 6} more` : ""}.
        </p>
      ) : null}

      {notice ? <p className={`agent-live-note ${variant ? `agent-live-note-${variant}` : ""}`}>{notice}</p> : null}

      {!isRunning ? (
        <div className="button-row button-row-compact">
          <Link className="button button-secondary" href="/applications">
            {variant === "duplicate" ? "Open Existing Workspace" : mode === "browser_fill" ? "Open Workspace Report" : "View Saved Applications"}
          </Link>
        </div>
      ) : null}
    </section>
  );
}

function getTitle(input: {
  isRunning: boolean;
  mode: AgentExecutionPanelProps["mode"];
  run: ApplicationRun | null;
  variant: AgentExecutionPanelProps["variant"];
}) {
  if (input.isRunning) {
    if (input.mode === "browser_fill") {
      return "Opening Chrome fill session";
    }

    if (input.mode === "autopilot") {
      return "Launching background autopilot";
    }

    return input.mode === "autofill" ? "Preparing guided autofill" : "Preparing draft package";
  }

  if (input.variant === "duplicate") {
    return "Existing application workspace found";
  }

  if (input.variant === "error") {
    return "Agent run could not be completed";
  }

  if (input.run?.executionMode === "browser_apply") {
    return input.run.submission?.browser?.status === "blocked"
      ? "Browser fill needs attention"
      : input.run.submission?.browser?.status === "submitted"
        ? "Application submitted"
        : "Browser fill paused for review";
  }

  if (input.run?.executionMode === "autonomous_apply") {
    return input.run.status === "blocked" ? "Autopilot needs attention" : "Autopilot queued";
  }

  return input.run?.executionMode === "guided_autofill" ? "Autofill package ready for review" : "Draft package saved";
}

function getSummary(input: {
  isRunning: boolean;
  mode: AgentExecutionPanelProps["mode"];
  run: ApplicationRun | null;
  variant: AgentExecutionPanelProps["variant"];
  notice: string | null;
}) {
  if (input.isRunning) {
    if (input.mode === "browser_fill") {
      return "Chrome is opening the exact job URL, filling recognized fields, and only pausing when the flow genuinely needs manual intervention.";
    }

    if (input.mode === "autopilot") {
      return "The agent is packaging the application, launching the browser worker, and continuing toward submit in the background.";
    }

    return input.mode === "autofill"
      ? "The agent is checking capabilities, preparing answers, and pausing before any final submit action."
      : "The agent is packaging the draft artifacts and saving a structured workspace folder.";
  }

  if (input.variant === "duplicate") {
    return "This job already has a saved application record, so GradLaunch is asking you to continue from the saved workspace instead of creating a second one.";
  }

  if (input.variant === "error") {
    return input.notice ?? "Something went wrong while preparing the application.";
  }

  if (input.run?.executionMode === "browser_apply") {
    return input.run.submission?.browser?.status === "submitted"
      ? "The Chrome session opened the exact job URL, completed the form flow, submitted it, and saved the receipt."
      : "The Chrome session opened the exact job URL, filled recognized fields, saved a workspace report, and stopped only where human review was still needed.";
  }

  if (input.run?.executionMode === "autonomous_apply") {
    return "The autonomous agent has the application package and is continuing the browser workflow in the background.";
  }

  return input.run?.workspacePath
    ? "The application package has been saved and can be reviewed from the applications workspace."
    : "The application run completed and is ready to inspect from the applications workspace.";
}

function getBadgeClass(input: { isRunning: boolean; variant: AgentExecutionPanelProps["variant"] }) {
  if (input.isRunning) {
    return "agent-live-badge-running";
  }

  if (input.variant === "duplicate") {
    return "agent-live-badge-warning";
  }

  if (input.variant === "error") {
    return "agent-live-badge-danger";
  }

  return "agent-live-badge-success";
}

function getBadgeLabel(variant: AgentExecutionPanelProps["variant"], run: ApplicationRun | null) {
  if (variant === "duplicate") {
    return "Already saved";
  }

  if (variant === "error") {
    return "Needs attention";
  }

  if (run?.status) {
    return run.status.replaceAll("_", " ");
  }

  return "Ready";
}
