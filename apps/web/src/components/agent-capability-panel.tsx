import { AGENT_CAPABILITY_STATUS_LABELS, type AgentCapabilities } from "@gradlaunch/shared";

type AgentCapabilityPanelProps = {
  capabilities: AgentCapabilities | null;
  title: string;
  description: string;
};

export function AgentCapabilityPanel({ capabilities, title, description }: AgentCapabilityPanelProps) {
  return (
    <section className="card section-card capability-card">
      <div className="section-header">
        <div>
          <p className="eyebrow">{title}</p>
          <p className="section-description">{description}</p>
        </div>
        <div className="capability-headline">
          <span
            className={`capability-chip ${
              capabilities
                ? capabilities.repoDetected
                  ? "capability-chip-available"
                  : "capability-chip-partial"
                : "capability-chip-subtle"
            }`}
          >
            {capabilities ? (capabilities.repoDetected ? "Local AIHawk connected" : "Fallback mode") : "Checking adapter"}
          </span>
          {capabilities?.pythonAvailable ? <span className="capability-chip capability-chip-subtle">Python ready</span> : null}
        </div>
      </div>

      {capabilities ? (
        <>
          <div className="capability-grid">
            {capabilities.capabilities.map((capability) => (
              <article className={`capability-item capability-item-${capability.status}`} key={capability.id}>
                <div className="capability-item-head">
                  <strong>{capability.label}</strong>
                  <span className={`capability-status capability-status-${capability.status}`}>
                    {AGENT_CAPABILITY_STATUS_LABELS[capability.status]}
                  </span>
                </div>
                <p className="muted">{capability.detail}</p>
              </article>
            ))}
          </div>
          {capabilities.limitations.length > 0 ? (
            <div className="soft-panel">
              <p className="detail-label">Current limitations</p>
              <ul className="list compact-list">
                {capabilities.limitations.map((limitation) => (
                  <li className="list-item soft-list-item" key={limitation}>{limitation}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : (
        <div className="soft-panel">
          <p className="muted">Checking the local AIHawk adapter and GradLaunch runtime capabilities.</p>
        </div>
      )}
    </section>
  );
}
