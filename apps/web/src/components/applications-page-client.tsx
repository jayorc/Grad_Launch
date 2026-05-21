"use client";

import { useEffect, useState } from "react";
import type { AgentCapabilities, AgentTimelineStep, Application, ApplicationRun, FilledField, Job, SubmissionIntent } from "@gradlaunch/shared";
import { getAgentCapabilities, getApplicationRuns, getApplications, getJobs, resumeApplicationInBrowser, submitApplication } from "../lib/api";
import { useAgentConsole } from "../providers/agent-console-provider";
import { useAuth } from "../providers/auth-provider";
import { AgentCapabilityPanel } from "./agent-capability-panel";
import { ApplicationRunTrace } from "./application-run-trace";
import { PageHeader } from "./page-header";
import { StatusPill } from "./status-pill";
import { ProtectedPage } from "./auth/protected-page";

export function ApplicationsPageClient() {
  const { session } = useAuth();
  const { beginExecution, completeExecution } = useAgentConsole();
  const [applications, setApplications] = useState<Application[]>([]);
  const [jobsById, setJobsById] = useState<Record<string, Job>>({});
  const [runsByApplication, setRunsByApplication] = useState<Record<string, ApplicationRun[]>>({});
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(null);
  const [selectedApplicationId, setSelectedApplicationId] = useState<string | null>(null);
  const [editableFields, setEditableFields] = useState<FilledField[]>([]);
  const [submitState, setSubmitState] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);
  const [submitSteps, setSubmitSteps] = useState<AgentTimelineStep[] | null>(null);

  async function loadApplicationWorkspace(sessionToken: string, cancelled: { value: boolean }) {
    try {
      const [applicationList, jobs, agentCapabilities] = await Promise.all([
        getApplications(sessionToken),
        getJobs(sessionToken),
        getAgentCapabilities(sessionToken)
      ]);

      if (cancelled.value) {
        return;
      }

      setApplications(applicationList);
      setJobsById(Object.fromEntries(jobs.map((job) => [job.id, job])));
      setCapabilities(agentCapabilities);

      const runEntries = await Promise.all(
        applicationList.map(async (application) => [application.id, await getApplicationRuns(sessionToken, application.id)] as const)
      );

      if (cancelled.value) {
        return;
      }

      setRunsByApplication(Object.fromEntries(runEntries));
    } catch (_error) {
      if (cancelled.value) {
        return;
      }

      setApplications([]);
      setJobsById({});
      setRunsByApplication({});
      setCapabilities(null);
    }
  }

  useEffect(() => {
    const token = session?.token;

    if (!token) {
      setApplications([]);
      setJobsById({});
      setRunsByApplication({});
      setCapabilities(null);
      return;
    }

    const sessionToken = token;
    const cancelled = { value: false };

    void loadApplicationWorkspace(sessionToken, cancelled);

    return () => {
      cancelled.value = true;
    };
  }, [session?.token]);

  useEffect(() => {
    if (applications.length === 0) {
      setSelectedApplicationId(null);
      return;
    }

    setSelectedApplicationId((current) => {
      if (current && applications.some((application) => application.id === current)) {
        return current;
      }

      return applications[0]?.id ?? null;
    });
  }, [applications]);

  const selectedApplication = selectedApplicationId
    ? applications.find((application) => application.id === selectedApplicationId) ?? null
    : null;
  const selectedJob = selectedApplication ? jobsById[selectedApplication.jobId] : undefined;
  const selectedRun = selectedApplication ? runsByApplication[selectedApplication.id]?.[0] : undefined;
  const browserApplyCapability = capabilities?.capabilities.find((capability) => capability.id === "browser_apply");
  const placeholderJobMessage = selectedJob && isPlaceholderJobUrl(selectedJob.sourceUrl)
    ? "This saved workspace came from an old generated demo URL. Run a fresh live search or paste the real company job page URL before auto-submit."
    : null;
  const canAutoSubmit = !placeholderJobMessage && (browserApplyCapability?.status === "available" || browserApplyCapability?.status === "partial");
  const hasActiveAutopilot = applications.some((application) => application.status === "queued" || application.status === "running");

  useEffect(() => {
    const token = session?.token;

    if (!token || !hasActiveAutopilot) {
      return undefined;
    }

    const cancelled = { value: false };
    const interval = window.setInterval(() => {
      void loadApplicationWorkspace(token, cancelled);
    }, 5000);

    return () => {
      cancelled.value = true;
      window.clearInterval(interval);
    };
  }, [hasActiveAutopilot, session?.token]);

  useEffect(() => {
    setEditableFields(selectedRun?.filledFields ?? []);
    setSubmitState("idle");
    setSubmitMessage(null);
    setSubmitSteps(null);
  }, [selectedRun?.id]);

  async function handleSubmit(intent: SubmissionIntent) {
    if (!session?.token || !selectedApplication) {
      return;
    }

    setSubmitState("submitting");
    setSubmitMessage(null);
    setSubmitSteps(createSubmitPendingSteps(intent));

    try {
      const result = await submitApplication(session.token, selectedApplication.id, {
        intent,
        reviewedFields: editableFields,
        confirmExternalSubmit: intent === "review_submit"
      });

      setApplications((items) => items.map((item) => (item.id === result.application.id ? result.application : item)));
      setRunsByApplication((items) => ({
        ...items,
        [result.application.id]: [result.run, ...(items[result.application.id] ?? [])]
      }));
      setSubmitState(result.run.status === "blocked" ? "error" : "success");
      setSubmitMessage(result.run.submission?.confirmation ?? "Application flow updated.");
    } catch (error) {
      setSubmitState("error");
      setSubmitMessage(error instanceof Error ? error.message : "Unable to complete the application.");
    } finally {
      setSubmitSteps(null);
    }
  }

  async function handleResumeBrowser(submit: boolean) {
    if (!session?.token || !selectedApplication) {
      return;
    }

    const steps = createResumePendingSteps(submit);
    setSubmitState("submitting");
    setSubmitMessage(null);
    setSubmitSteps(steps);
    beginExecution({
      mode: "browser_fill",
      title: submit ? "Resuming planner to submit gate" : "Resuming planner checkpoint",
      message: submit
        ? "GradLaunch is reopening the browser flow from the latest saved checkpoint and will continue toward the submit gate."
        : "GradLaunch is reopening the browser flow from the latest saved checkpoint and will continue until the next safe pause or protected checkpoint.",
      steps
    });

    try {
      const result = await resumeApplicationInBrowser(session.token, selectedApplication.id, submit);
      setApplications((items) => items.map((item) => (item.id === result.application.id ? result.application : item)));
      setRunsByApplication((items) => ({
        ...items,
        [result.application.id]: [result.run, ...(items[result.application.id] ?? [])]
      }));
      setSubmitState(result.run.status === "blocked" ? "error" : "success");
      setSubmitMessage(result.run.submission?.browser?.message ?? "Planner resumed from the saved checkpoint.");
      completeExecution({
        mode: "browser_fill",
        title: "Planner checkpoint resumed",
        message: result.run.submission?.browser?.message ?? "Planner resumed from the saved checkpoint.",
        run: result.run,
        steps: result.run.timeline,
        variant: result.run.status === "blocked" ? "error" : "success"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to resume the planner from this checkpoint.";
      setSubmitState("error");
      setSubmitMessage(message);
      completeExecution({
        mode: "browser_fill",
        title: "Planner resume needs attention",
        message,
        run: null,
        steps,
        variant: "error"
      });
    } finally {
      setSubmitSteps(null);
    }
  }

  function handleFieldChange(index: number, key: keyof FilledField, value: string) {
    setEditableFields((fields) => fields.map((field, fieldIndex) => (fieldIndex === index ? { ...field, [key]: value } : field)));
  }

  function handleAddField() {
    setEditableFields((fields) => [...fields, { label: "Additional field", value: "" }]);
  }

  function handleRemoveField(index: number) {
    setEditableFields((fields) => fields.filter((_field, fieldIndex) => fieldIndex !== index));
  }

  return (
    <ProtectedPage>
      <PageHeader
        eyebrow="Saved Applications"
        title="See everything GradLaunch has saved for you"
        description="Every application keeps a visible run trace so you can see what the agent prepared, what fields were mapped, and whether the background autopilot is still progressing."
      />
      <AgentCapabilityPanel
        capabilities={capabilities}
        title="Automation Capabilities"
        description="This status applies to every saved application below, so you always know whether a run used fallback packaging or a connected AIHawk adapter."
      />
      {applications.length > 0 ? (
        <div className="workspace-layout">
          <section className="card section-card workspace-list-card">
            <div className="section-header">
              <div>
                <p className="eyebrow">Saved Workspaces</p>
                <p className="section-description">Choose one application on the left and GradLaunch will show the agent trace, saved folder, prepared fields, and any live autopilot progress here.</p>
              </div>
            </div>

            {hasActiveAutopilot ? (
              <p className="muted">Autopilot is active on one or more applications. This page refreshes every 5 seconds while those runs are still working.</p>
            ) : null}

            <div className="workspace-list">
              {applications.map((application) => {
                const job = jobsById[application.jobId];
                const isActive = application.id === selectedApplicationId;

                return (
                  <button
                    className={`workspace-list-item ${isActive ? "workspace-list-item-active" : ""}`}
                    key={application.id}
                    onClick={() => setSelectedApplicationId(application.id)}
                    type="button"
                  >
                    <div className="workspace-list-head">
                      <div>
                        <p className="eyebrow">{job?.company ?? application.sourceLabel}</p>
                        <h3>{job?.title ?? "Saved Application"}</h3>
                      </div>
                      <StatusPill status={application.status} />
                    </div>
                    <div className="workspace-list-meta">
                      <span>{application.matchScore}% match</span>
                      <span>{application.sourceLabel}</span>
                      <span>{formatTimestamp(application.lastUpdatedAt)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="card section-card workspace-detail-card">
            {selectedApplication ? (
              <>
                <div className="workspace-detail-head">
                  <div>
                    <p className="eyebrow">Selected Workspace</p>
                    <h3 className="workspace-detail-title">
                      {selectedJob ? `${selectedJob.company} • ${selectedJob.title}` : selectedApplication.sourceLabel}
                    </h3>
                    <p className="muted">
                      Updated {formatTimestamp(selectedApplication.lastUpdatedAt)} • {selectedApplication.sourceLabel}
                    </p>
                  </div>
                  <StatusPill status={selectedApplication.status} />
                </div>

                <div className="workspace-stat-grid">
                  <article className="workspace-stat-card">
                    <p className="detail-label">Match score</p>
                    <p className="workspace-stat-value">{selectedApplication.matchScore}%</p>
                  </article>
                  <article className="workspace-stat-card">
                    <p className="detail-label">Prepared fields</p>
                    <p className="workspace-stat-value">{selectedRun?.filledFields.length ?? 0}</p>
                  </article>
                  <article className="workspace-stat-card">
                    <p className="detail-label">Saved files</p>
                    <p className="workspace-stat-value">{selectedRun?.workspaceFiles.length ?? selectedApplication.uploadedDocuments.length}</p>
                  </article>
                </div>

                <ApplicationJourney
                  application={selectedApplication}
                  run={selectedRun}
                  submitting={submitState === "submitting"}
                />

                <ReviewCompletionPanel
                  applicationStatus={selectedApplication.status}
                  canAutoSubmit={canAutoSubmit}
                  fields={editableFields}
                  run={selectedRun}
                  submitMessage={submitMessage}
                  submitState={submitState}
                  submitSteps={submitSteps}
                  unsupportedReason={placeholderJobMessage}
                  onResumeBrowser={() => handleResumeBrowser(false)}
                  onResumeBrowserAndSubmit={() => handleResumeBrowser(true)}
                  onAutoSubmit={() => handleSubmit("auto_submit")}
                  onAddField={handleAddField}
                  onFieldChange={handleFieldChange}
                  onRemoveField={handleRemoveField}
                  onReviewSubmit={() => handleSubmit("review_submit")}
                />

                <div className="workspace-info-grid">
                  <div className="soft-panel">
                    <p className="detail-label">Workspace folder</p>
                    <p className="detail-value detail-wrap path-text">{selectedRun?.workspacePath ?? "Workspace path not recorded yet."}</p>
                  </div>
                  <div className="soft-panel">
                    <p className="detail-label">Workspace files</p>
                    <div className="workspace-file-list">
                      {selectedRun?.workspaceFiles.length
                        ? selectedRun.workspaceFiles.map((file) => <span className="file-chip" key={file}>{file}</span>)
                        : selectedApplication.uploadedDocuments.map((file) => <span className="file-chip" key={file}>{file}</span>)}
                    </div>
                  </div>
                </div>

                <div className="detail-grid">
                  <div>
                    <p className="detail-label">Tailored resume brief</p>
                    <p className="detail-value detail-wrap">{selectedApplication.generatedArtifacts.tailoredResumeSummary}</p>
                  </div>
                  <div>
                    <p className="detail-label">Cover letter excerpt</p>
                    <p className="detail-value detail-wrap">{selectedApplication.generatedArtifacts.coverLetterExcerpt}</p>
                  </div>
                </div>

                <div className="soft-panel">
                  <p className="detail-label">Saved answers</p>
                  <p className="detail-value detail-wrap">
                    {selectedApplication.generatedArtifacts.shortAnswers.length > 0
                      ? selectedApplication.generatedArtifacts.shortAnswers.map((answer) => answer.question).join(", ")
                      : "No short answers saved yet"}
                  </p>
                </div>

                {selectedRun ? (
                  <ApplicationRunTrace run={selectedRun} />
                ) : (
                  <div className="empty-state">No run trace saved yet for this application.</div>
                )}
              </>
            ) : (
              <div className="empty-state">Select an application to open its workspace.</div>
            )}
          </section>
        </div>
      ) : (
        <div className="empty-state">No application activity yet. Start from Jobs or Search to create your first application flow.</div>
      )}
    </ProtectedPage>
  );
}

function ApplicationJourney({
  application,
  run,
  submitting
}: {
  application: Application;
  run?: ApplicationRun;
  submitting: boolean;
}) {
  const isAutopilotActive = application.status === "queued" || application.status === "running";
  const finalStep = run?.submission?.externalSubmitted
    ? "submitted"
    : run?.submission?.outcome === "blocked"
      ? "blocked"
      : application.status;
  const steps = [
    { id: "prepared", label: "Package", state: "done" },
    { id: "agent", label: "Agent", state: isAutopilotActive ? "running" : application.status === "ready_for_review" ? "current" : "done" },
    { id: "fill", label: "Fill", state: isAutopilotActive || submitting ? "running" : run?.submission ? "done" : "waiting" },
    { id: "email", label: "Email", state: run?.submission?.email.status === "failed" ? "attention" : run?.submission ? "done" : "waiting" },
    { id: "complete", label: finalStep === "submitted" ? "Submitted" : finalStep === "blocked" ? "Blocked" : "Complete", state: finalStep === "submitted" ? "done" : finalStep === "blocked" ? "attention" : "waiting" }
  ];

  return (
    <section className="application-journey" aria-label="Application progress">
      {steps.map((step) => (
        <div className={`journey-step journey-step-${step.state}`} key={step.id}>
          <span className="journey-dot" />
          <span>{step.label}</span>
        </div>
      ))}
    </section>
  );
}

function ReviewCompletionPanel({
  applicationStatus,
  canAutoSubmit,
  fields,
  run,
  submitMessage,
  submitState,
  submitSteps,
  unsupportedReason,
  onAddField,
  onAutoSubmit,
  onFieldChange,
  onRemoveField,
  onResumeBrowser,
  onResumeBrowserAndSubmit,
  onReviewSubmit
}: {
  applicationStatus: Application["status"];
  canAutoSubmit: boolean;
  fields: FilledField[];
  run?: ApplicationRun;
  submitMessage: string | null;
  submitState: "idle" | "submitting" | "success" | "error";
  submitSteps: AgentTimelineStep[] | null;
  unsupportedReason: string | null;
  onAddField: () => void;
  onAutoSubmit: () => void;
  onFieldChange: (index: number, key: keyof FilledField, value: string) => void;
  onRemoveField: (index: number) => void;
  onResumeBrowser: () => void;
  onResumeBrowserAndSubmit: () => void;
  onReviewSubmit: () => void;
}) {
  const isSubmitted = run?.submission?.externalSubmitted;
  const isAutopilotActive = applicationStatus === "queued" || applicationStatus === "running";

  return (
    <section className="completion-panel">
      <div className="completion-head">
        <div>
          <p className="eyebrow">Review and Complete</p>
          <h4>{isAutopilotActive ? "Autopilot in progress" : "Final form checkpoint"}</h4>
        </div>
        {run?.submission ? <span className="tag tag-subtle">{run.submission.email.status} email</span> : null}
      </div>

      {isAutopilotActive ? (
        <div className="submission-receipt submission-receipt-filled">
          <strong>Background agent is still working</strong>
          <p className="muted">GradLaunch is continuing this application behind the scenes. The manual controls below stay locked until the run either submits or asks for a real handoff.</p>
        </div>
      ) : null}

      {run?.submission?.browser?.status === "filled" ? (
        <div className="submission-receipt submission-receipt-filled">
          <strong>Form filled and ready</strong>
          <p className="muted">GradLaunch finished the form. Review the live browser page or continue directly to submit.</p>
        </div>
      ) : null}

      {run?.submission ? (
        <div className={`submission-receipt submission-receipt-${run.submission.outcome}`}>
          <strong>{run.submission.externalSubmitted ? "Final submit confirmed" : "Review package confirmed"}</strong>
          <p className="muted">{run.submission.confirmation}</p>
          <p className="muted">
            Email: {run.submission.email.status} via {run.submission.email.provider}
            {run.submission.email.sentAt ? ` • ${formatTimestamp(run.submission.email.sentAt)}` : ""}
          </p>
        </div>
      ) : null}

      <div className="review-form-grid">
        {fields.map((field, index) => (
          <article className="review-field" key={`${field.label}-${index}`}>
            <input
              aria-label="Field label"
              className="review-label-input"
              disabled={submitState === "submitting" || Boolean(isSubmitted) || isAutopilotActive}
              onChange={(event) => onFieldChange(index, "label", event.target.value)}
              value={field.label}
            />
            <input
              disabled={submitState === "submitting" || Boolean(isSubmitted) || isAutopilotActive}
              onChange={(event) => onFieldChange(index, "value", event.target.value)}
              value={field.value}
            />
            {!isSubmitted ? (
              <button
                className="text-button"
                disabled={submitState === "submitting" || isAutopilotActive}
                onClick={() => onRemoveField(index)}
                type="button"
              >
                Remove
              </button>
            ) : null}
          </article>
        ))}
      </div>

      {!isSubmitted ? (
        <button
          className="button button-secondary button-fit"
          disabled={submitState === "submitting" || isAutopilotActive}
          onClick={onAddField}
          type="button"
        >
          Add missing field
        </button>
      ) : null}

      {submitSteps ? (
        <div className="mini-live-trace">
          {submitSteps.map((step) => (
            <article className={`agent-step agent-step-${step.state}`} key={step.id}>
              <span className="agent-step-dot" />
              <div>
                <strong>{step.label}</strong>
                <p className="muted">{step.detail}</p>
              </div>
            </article>
          ))}
        </div>
      ) : null}

      {submitMessage ? <p className={`completion-message completion-message-${submitState}`}>{submitMessage}</p> : null}

      <div className="button-row completion-actions">
        <button
          className="button button-secondary"
          disabled={submitState === "submitting" || Boolean(isSubmitted) || Boolean(unsupportedReason) || isAutopilotActive}
          onClick={onResumeBrowser}
          type="button"
        >
          Review Filled Form
        </button>
        <button
          className="button button-secondary"
          disabled={submitState === "submitting" || Boolean(isSubmitted) || !canAutoSubmit || Boolean(unsupportedReason) || isAutopilotActive}
          onClick={onResumeBrowserAndSubmit}
          type="button"
        >
          Submit Directly
        </button>
        <button
          className="button button-primary"
          disabled={submitState === "submitting" || Boolean(isSubmitted) || isAutopilotActive}
          onClick={onReviewSubmit}
          type="button"
        >
          {submitState === "submitting" ? "Completing..." : "Reviewed and Submitted"}
        </button>
        <button
          className="button button-secondary"
          disabled={!canAutoSubmit || submitState === "submitting" || Boolean(isSubmitted) || isAutopilotActive}
          onClick={onAutoSubmit}
          title={canAutoSubmit ? "Open Chrome, fill recognized fields, and click the detected submit control" : "Chrome browser worker is not available on this machine"}
          type="button"
        >
          Auto-submit with AIHawk
        </button>
      </div>

      {unsupportedReason ? (
        <p className="completion-message completion-message-error">{unsupportedReason}</p>
      ) : isAutopilotActive ? (
        <p className="muted compact-help">Autopilot has control right now. If the portal needs you for login, OTP, captcha, or a required unknown answer, this panel will unlock with the saved checkpoint.</p>
      ) : !canAutoSubmit ? (
        <p className="muted compact-help">Auto-submit needs the local Chrome browser worker. Review submit still records the final confirmation and sends the student email.</p>
      ) : (
        <p className="muted compact-help">Auto-submit opens Chrome, fills recognized fields, saves screenshots, and records a receipt. Portals with login, captcha, or unknown steps pause for manual review.</p>
      )}
    </section>
  );
}

function createSubmitPendingSteps(intent: SubmissionIntent): AgentTimelineStep[] {
  return [
    {
      id: "review",
      label: "Locking reviewed fields",
      detail: "Saving the final form values shown on this screen.",
      state: "running",
      source: "gradlaunch"
    },
    {
      id: "submit",
      label: intent === "auto_submit" ? "Calling AIHawk submit worker" : "Recording final submit confirmation",
      detail: intent === "auto_submit"
        ? "GradLaunch is opening Chrome, filling recognized fields, and attempting the final submit control."
        : "GradLaunch is recording that the student reviewed the values and completed the final submit step.",
      state: "queued",
      source: intent === "auto_submit" ? "aihawk" : "gradlaunch"
    },
    {
      id: "email",
      label: "Sending email notification",
      detail: "Preparing the confirmation email and workspace receipt.",
      state: "queued",
      source: "gradlaunch"
    }
  ];
}

function createResumePendingSteps(submit: boolean): AgentTimelineStep[] {
  return [
    {
      id: "checkpoint",
      label: "Load saved checkpoint",
      detail: "Restoring the latest planner state, prepared fields, and workspace path from the selected application.",
      state: "running",
      source: "gradlaunch"
    },
    {
      id: "browser",
      label: "Re-open browser flow",
      detail: "Launching Chrome on the saved application path and reconnecting the planner-executor loop.",
      state: "queued",
      source: "gradlaunch"
    },
    {
      id: "recover",
      label: "Continue unfinished subgoals",
      detail: "The planner will finish the current section, recover validation blockers, and retry alternate paths when safe.",
      state: "queued",
      source: "gradlaunch"
    },
    {
      id: "gate",
      label: submit ? "Drive to submit gate" : "Drive to safe pause",
      detail: submit
        ? "The planner will continue until the submit gate or next protected checkpoint."
        : "The planner will continue until the next safe pause or protected checkpoint.",
      state: "queued",
      source: "gradlaunch"
    }
  ];
}

function formatTimestamp(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function isPlaceholderJobUrl(value: string) {
  try {
    return new URL(value).hostname === "search.gradlaunch.local";
  } catch (_error) {
    return true;
  }
}
