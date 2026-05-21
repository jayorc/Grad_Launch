"use client";

import { useEffect, useMemo, useState } from "react";
import type { AgentTimelineStep } from "@gradlaunch/shared";
import { fillJobInBrowser } from "../lib/api";
import { useAgentConsole } from "../providers/agent-console-provider";

type BrowserFillActionProps = {
  token: string;
  jobId: string;
};

export function BrowserFillAction({ token, jobId }: BrowserFillActionProps) {
  const [loading, setLoading] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const pendingSteps = useMemo(() => loading ? createBrowserFillSteps(elapsedSeconds) : null, [elapsedSeconds, loading]);
  const { beginExecution, completeExecution, updateExecution } = useAgentConsole();

  useEffect(() => {
    if (!loading) {
      return undefined;
    }

    setElapsedSeconds(0);
    const interval = window.setInterval(() => {
      setElapsedSeconds((seconds) => seconds + 1);
    }, 1000);

    return () => window.clearInterval(interval);
  }, [loading]);

  async function handleFill(submit: boolean) {
    const initialMessage = submit
      ? "Chrome will open visibly. GradLaunch will keep navigating stages and attempt the final submit when the backend allows real submission."
      : "Chrome will open visibly. GradLaunch will keep navigating stages, hand control to you only for login or OTP if needed, and otherwise keep going automatically.";

    setLoading(true);
    setMessage(initialMessage);
    beginExecution({
      mode: "browser_fill",
      title: submit ? "Browser agent running to submit" : "Browser agent running with assisted handoff",
      message: initialMessage,
      steps: createBrowserFillSteps(0)
    });

    try {
      const result = await fillJobInBrowser(token, jobId, submit);
      const browserStatus = result.run.submission?.browser?.status;
      const nextVariant = browserStatus === "blocked" ? "error" : "success";
      const nextMessage = result.run.submission?.browser?.message ?? "Browser fill completed. Open Applications to inspect the saved run trace.";
      setMessage(nextMessage);
      completeExecution({
        mode: "browser_fill",
        title: browserStatus === "handoff_required" ? "Manual handoff still needed" : "Browser run updated",
        message: nextMessage,
        run: result.run,
        steps: result.run.timeline,
        variant: nextVariant
      });
    } catch (error) {
      const nextMessage = error instanceof Error ? error.message : "Unable to open and fill this job in Chrome.";
      setMessage(nextMessage);
      completeExecution({
        mode: "browser_fill",
        title: "Browser run needs attention",
        message: nextMessage,
        run: null,
        steps: pendingSteps ?? createBrowserFillSteps(elapsedSeconds),
        variant: "error"
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!pendingSteps) {
      return;
    }

    updateExecution({
      steps: pendingSteps,
      message: pendingSteps.find((step) => step.state === "running")?.detail ?? message
    });
  }, [message, pendingSteps, updateExecution]);

  return (
    <div className="action-stack">
      <div className="button-row button-row-compact">
        <button className="button button-primary" disabled={loading} onClick={() => handleFill(false)} type="button">
          {loading ? "Agent running..." : "Assisted Browser Fill"}
        </button>
        <button className="button button-secondary" disabled={loading} onClick={() => handleFill(true)} type="button">
          Run to Submit
        </button>
      </div>
      {pendingSteps ? <p className="action-inline-status">Browser agent is active. Watch the draggable companion and the live Chrome window.</p> : null}
      {message && !pendingSteps ? <p className="action-inline-status">{message}</p> : null}
    </div>
  );
}

function createBrowserFillSteps(elapsedSeconds: number): AgentTimelineStep[] {
  const activeIndex = elapsedSeconds < 3 ? 0 : elapsedSeconds < 6 ? 1 : elapsedSeconds < 10 ? 2 : elapsedSeconds < 15 ? 3 : elapsedSeconds < 20 ? 4 : 5;
  const steps: AgentTimelineStep[] = [
    {
      id: "open",
      label: "Open exact URL",
      detail: "Launching visible Chrome on the job page you provided.",
      state: "queued",
      source: "gradlaunch"
    },
    {
      id: "resume",
      label: "Read current screen",
      detail: "Detecting visible fields, file uploads, choices, and stage buttons from the live page.",
      state: "queued",
      source: "gradlaunch"
    },
    {
      id: "detect",
      label: "Resolve answers",
      detail: "Matching profile/resume data and asking the LLM for unknown safe questions when enabled.",
      state: "queued",
      source: "gradlaunch"
    },
    {
      id: "fill",
      label: "Fill profile answers",
      detail: "Matching discovered fields to your profile, contact details, links, and generated answers.",
      state: "queued",
      source: "gradlaunch"
    },
    {
      id: "workspace",
      label: "Navigate stages",
      detail: "Clicking Apply, Next, Continue, and Review controls until the form is complete or a protected checkpoint appears.",
      state: "queued",
      source: "gradlaunch"
    },
    {
      id: "pause",
      label: "Finish or handoff",
      detail: "Submitting automatically when allowed, or pausing only when the portal still needs human attention.",
      state: "queued",
      source: "gradlaunch"
    }
  ];

  return steps.map((step, index) => ({
    ...step,
    state: index < activeIndex ? "done" : index === activeIndex ? "running" : "queued"
  }));
}
