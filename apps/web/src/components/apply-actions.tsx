"use client";

import { useState } from "react";
import type { AgentTimelineStep } from "@gradlaunch/shared";
import { createApplication as createApplicationRequest } from "../lib/api";
import { useAgentConsole } from "../providers/agent-console-provider";

type ApplyActionsProps = {
  token: string;
  jobId: string;
};

export function ApplyActions({ token, jobId }: ApplyActionsProps) {
  const [message, setMessage] = useState<string | null>(null);
  const [loadingMode, setLoadingMode] = useState<"draft" | "autofill" | "autopilot" | null>(null);
  const [pendingSteps, setPendingSteps] = useState<AgentTimelineStep[] | null>(null);
  const { beginExecution, completeExecution } = useAgentConsole();

  async function handleCreateApplication(mode: "draft" | "autofill" | "autopilot") {
    const steps = createPendingSteps(mode);
    setLoadingMode(mode);
    setMessage(null);
    setPendingSteps(steps);
    beginExecution({
      mode,
      title: mode === "autopilot" ? "Launching background autopilot" : mode === "autofill" ? "Preparing autofill workspace" : "Preparing draft workspace",
      message: mode === "autopilot"
        ? "The agent is collecting profile context, building the application package, and handing it to the background browser worker."
        : mode === "autofill"
          ? "The agent is collecting profile context, mapping reusable answers, and preparing a review-first application package."
          : "The agent is packaging a readable draft workspace with tailored answers and saved artifacts.",
      steps
    });

    try {
      const result = await createApplicationRequest(token, jobId, mode);
      const successMessage =
        mode === "autopilot"
          ? "Autopilot started. GradLaunch will keep working in the background and update the application workspace as the browser agent progresses."
          : mode === "autofill"
          ? "Autofill data was prepared and paused at the review gate before any final submit."
          : "Draft package was created and saved to the application workspace.";
      setMessage(successMessage);
      completeExecution({
        mode,
        title: mode === "autopilot" ? "Autopilot launched" : mode === "autofill" ? "Autofill workspace ready" : "Draft workspace ready",
        message: successMessage,
        run: result.run,
        steps: result.run.timeline,
        variant: "success"
      });
    } catch (error) {
      const nextMessage = error instanceof Error ? error.message : "Unable to create application.";
      const variant = nextMessage.includes("already exists") ? "duplicate" : "error";
      const userMessage =
        variant === "duplicate"
          ? "This job already has an application workspace. Open Saved Applications to continue from there."
          : nextMessage
      setMessage(userMessage);
      completeExecution({
        mode,
        title: variant === "duplicate" ? "Workspace already exists" : "Application setup needs attention",
        message: userMessage,
        run: null,
        steps,
        variant
      });
    } finally {
      setLoadingMode(null);
      setPendingSteps(null);
    }
  }

  return (
    <div className="action-stack">
      <div className="button-row">
        <button
          className="button button-secondary"
          disabled={loadingMode !== null}
          onClick={() => handleCreateApplication("draft")}
          type="button"
        >
          {loadingMode === "draft" ? "Creating..." : "Create Draft"}
        </button>
        <button
          className="button button-primary"
          disabled={loadingMode !== null}
          onClick={() => handleCreateApplication("autopilot")}
          type="button"
        >
          {loadingMode === "autopilot" ? "Launching..." : "Launch Autopilot"}
        </button>
        <button
          className="button button-secondary"
          disabled={loadingMode !== null}
          onClick={() => handleCreateApplication("autofill")}
          type="button"
        >
          {loadingMode === "autofill" ? "Starting..." : "Prepare Review Fill"}
        </button>
      </div>
      {pendingSteps ? <p className="action-inline-status">Agent is preparing your workspace. Follow the live companion in the corner.</p> : null}
      {message && !pendingSteps ? <p className="action-inline-status">{message}</p> : null}
    </div>
  );
}

function createPendingSteps(mode: "draft" | "autofill" | "autopilot"): AgentTimelineStep[] {
  return [
    {
      id: "adapter",
      label: "Checking browser runtime",
      detail: "Verifying which local browser automation capabilities are available for this run.",
      state: "running",
      source: "gradlaunch"
    },
    {
      id: "profile",
      label: "Loading student context",
      detail: "Collecting saved profile data, resume context, and role preferences.",
      state: "queued",
      source: "gradlaunch"
    },
    {
      id: "artifacts",
      label: mode === "autopilot" ? "Preparing autopilot package" : mode === "autofill" ? "Preparing review package" : "Preparing draft package",
      detail: mode === "autopilot"
        ? "Generating reusable answers, a structured application record, and the background execution handoff."
        : "Generating reusable answers and a structured application record.",
      state: "queued",
      source: "gradlaunch"
    },
    {
      id: "fields",
      label: "Preparing known fields",
      detail: "Mapping the values that can be filled without hiding anything from the student.",
      state: "queued",
      source: "gradlaunch"
    },
    {
      id: "launch",
      label: mode === "autopilot" ? "Launch background agent" : "Hold for next action",
      detail: mode === "autopilot"
        ? "Persisting the application workspace and starting the autonomous browser worker behind the scenes."
        : "The workspace will be ready for the next manual or guided step.",
      state: "queued",
      source: "gradlaunch"
    }
  ];
}
