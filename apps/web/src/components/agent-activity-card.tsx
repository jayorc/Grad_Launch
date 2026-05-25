"use client";

import type { AgentStepState, AgentTimelineStep } from "@gradlaunch/shared";

type AgentActivityState = AgentStepState;

export type AgentActivityItem = {
  id: string;
  label: string;
  detail: string;
  state: AgentActivityState;
  source?: AgentTimelineStep["source"];
};

type AgentActivityCardProps = {
  eyebrow: string;
  title: string;
  summary: string;
  items: AgentActivityItem[];
};

export function AgentActivityCard({ eyebrow, title, summary, items }: AgentActivityCardProps) {
  return (
    <section className="agent-card">
      <div className="agent-card-head">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h3 className="agent-card-title">{title}</h3>
          <p className="muted">{summary}</p>
        </div>
        <span className="agent-pill">Agent active</span>
      </div>
      <div className="agent-timeline">
        {items.map((item) => (
          <article className={`agent-step agent-step-${item.state}`} key={item.id}>
            <span className="agent-step-dot" />
            <div>
              <div className="agent-step-headline">
                <strong>{item.label}</strong>
                {item.source ? <span className={`agent-source agent-source-${item.source}`}>{formatSource(item.source)}</span> : null}
              </div>
              <p className="muted">{item.detail}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function formatSource(_source: AgentTimelineStep["source"]) {
  return "GradLaunch";
}
