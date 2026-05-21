import { APPLICATION_EXECUTION_MODE_LABELS, BROWSER_APPLY_STATUS_LABELS, PLANNER_STATUS_LABELS, type ApplicationRun } from "@gradlaunch/shared";

type ApplicationRunTraceProps = {
  run: ApplicationRun;
};

export function ApplicationRunTrace({ run }: ApplicationRunTraceProps) {
  return (
    <section className="run-trace">
      <div className="run-trace-head">
        <div>
          <p className="eyebrow">Execution Trace</p>
          <p className="muted">Run status: {formatRunStatus(run.status)} • {APPLICATION_EXECUTION_MODE_LABELS[run.executionMode]}</p>
        </div>
        <span className="tag tag-subtle">{run.adapterId}</span>
      </div>

      <div className="run-trace-grid">
        <div className="run-trace-main">
          <div className="agent-timeline agent-timeline-compact">
            {run.timeline.map((step) => (
              <article className={`agent-step agent-step-${step.state}`} key={step.id}>
                <span className="agent-step-dot" />
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
        </div>

        <div className="run-trace-side">
          <div className="soft-panel">
            <p className="detail-label">Prepared fields</p>
            <div className="field-grid">
              {run.filledFields.map((field) => (
                <article className="field-card" key={`${field.label}-${field.value}`}>
                  <p className="detail-label">{field.label}</p>
                  <p className="detail-value detail-wrap">{field.value}</p>
                </article>
              ))}
            </div>
          </div>

          {run.notes.length > 0 ? (
            <div className="soft-panel">
              <p className="detail-label">Run notes</p>
              <ul className="list compact-list">
                {run.notes.map((note) => (
                  <li className="list-item soft-list-item" key={note}>{note}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {run.screenshots.length > 0 ? (
            <div className="soft-panel">
              <p className="detail-label">Review assets</p>
              <p className="detail-value detail-wrap">{run.screenshots.join(", ")}</p>
            </div>
          ) : null}

          {run.submission?.browser ? (
            <div className="soft-panel">
              <p className="detail-label">Browser worker receipt</p>
              <p className="detail-value detail-wrap">{run.submission.browser.message}</p>
              <p className="muted">
                {BROWSER_APPLY_STATUS_LABELS[run.submission.browser.status]} • Filled {run.submission.browser.filledLabels.length} fields • skipped {run.submission.browser.skippedLabels.length}
              </p>
            </div>
          ) : null}

          {run.planner ? (
            <div className="soft-panel">
              <p className="detail-label">Planner checkpoint</p>
              <p className="detail-value detail-wrap">{run.planner.summary}</p>
              <p className="muted">
                {PLANNER_STATUS_LABELS[run.planner.status]} • retries {run.planner.retryCount} • handoffs {run.planner.handoffCount}
              </p>
              <div className="workspace-file-list">
                {run.planner.subgoals.map((task) => (
                  <span className="file-chip" key={task.id}>{task.label}: {task.status.replaceAll("_", " ")}</span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function formatRunStatus(status: ApplicationRun["status"]) {
  return status.replaceAll("_", " ");
}
