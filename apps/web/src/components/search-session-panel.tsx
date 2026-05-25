"use client";

import { SEARCH_DURATION_OPTIONS, type AgentCapabilities, type MatchStrictness, type Recommendation } from "@gradlaunch/shared";
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { getAgentCapabilities, startSearchSession } from "../lib/api";
import { AgentActivityCard, type AgentActivityItem } from "./agent-activity-card";
import { AgentCapabilityPanel } from "./agent-capability-panel";
import { ApplyActions } from "./apply-actions";

type SearchSessionPanelProps = {
  token: string;
};

type SearchState = {
  summary: string;
  recommendations: Recommendation[];
  activity: AgentActivityItem[];
};

export function SearchSessionPanel({ token }: SearchSessionPanelProps) {
  const [strictness, setStrictness] = useState<MatchStrictness>("balanced");
  const [duration, setDuration] = useState<number>(5);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<SearchState | null>(null);
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(null);

  useEffect(() => {
    getAgentCapabilities(token).then(setCapabilities).catch(() => setCapabilities(null));
  }, [token]);

  async function handleSearch() {
    setLoading(true);
    setError(null);

    try {
      await animateSearch(setState, strictness, duration, capabilities);
      const result = await startSearchSession(token, strictness, duration);
      setCapabilities(result.capabilities);

      setState({
        summary: result.session.summary,
        recommendations: result.recommendations,
        activity: result.activity
      });
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : "Unable to run search session.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="search-layout">
      <div className="grid search-side-stack">
        <section className="card section-card search-controls-card">
          <div className="section-header">
            <div>
              <p className="eyebrow">Search Controls</p>
              <p className="muted">Choose the strictness, set a time box, and let GradLaunch fetch current openings before ranking them.</p>
            </div>
          </div>
          <div className="form-stack">
            <label>
              <span className="kicker">Match strictness</span>
              <select className="select" value={strictness} onChange={(event) => setStrictness(event.target.value as MatchStrictness)}>
                <option value="broad">Broad</option>
                <option value="balanced">Balanced</option>
                <option value="strict">Strict</option>
              </select>
            </label>
            <label>
              <span className="kicker">Search duration</span>
              <select className="select" value={duration} onChange={(event) => setDuration(Number(event.target.value))}>
                {SEARCH_DURATION_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option} minutes
                  </option>
                ))}
              </select>
            </label>
            <button className="button button-primary" disabled={loading} onClick={handleSearch} type="button">
              {loading ? "Searching..." : "Run Search Session"}
            </button>
            {error ? <p className="form-error">{error}</p> : null}
          </div>
          <div className="soft-panel">
            <p className="detail-label">What happens</p>
            <p className="muted">Search runs call live sources, save current openings to your database, rank them with your strictness setting, and prepare the selected jobs for guided fill or full autopilot.</p>
          </div>
        </section>

        <AgentCapabilityPanel
          capabilities={capabilities}
          title="Automation Capabilities"
          description="This panel shows what the local browser runtime can really do right now before you start a run."
        />
      </div>

      <div className="grid">
        <AgentActivityCard
          eyebrow="Agent Run"
          title="Live search activity"
          summary={state?.summary ?? "Run a search session to see how GradLaunch scans, ranks, and prepares jobs for review."}
          items={state?.activity ?? createIdleActivity(capabilities)}
        />

        <section className="card section-card">
          <div className="section-header">
            <div>
              <p className="eyebrow">Recommended Jobs</p>
              <p className="muted">{state?.summary ?? "Run a search session to see fresh recommendations."}</p>
            </div>
          </div>
          <div className="grid">
            {state?.recommendations?.length ? (
              state.recommendations.map((recommendation) => (
                <article className="job-card rich-job-card" key={recommendation.job.id}>
                  <div className="job-card-header">
                    <div>
                      <p className="eyebrow">{recommendation.job.company}</p>
                      <h3>{recommendation.job.title}</h3>
                    </div>
                    <span className="tag">{recommendation.score}% match</span>
                  </div>
                  <div className="job-meta">
                    <span>{recommendation.job.location}</span>
                    <span>{recommendation.job.workMode}</span>
                    <span>{recommendation.job.sourceType}</span>
                  </div>
                  <p className="muted">{recommendation.job.description}</p>
                  <ul className="list compact-list">
                    {recommendation.reasons.map((reason) => (
                      <li className="list-item soft-list-item" key={reason}>{reason}</li>
                    ))}
                  </ul>
                  <ApplyActions jobId={recommendation.job.id} token={token} />
                </article>
              ))
            ) : (
              <div className="empty-state">No recommendations yet. Start a search session to populate this panel.</div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

async function animateSearch(
  setState: Dispatch<SetStateAction<SearchState | null>>,
  strictness: MatchStrictness,
  duration: number,
  capabilities: AgentCapabilities | null
) {
  const phases: AgentActivityItem[] = [
    {
      id: "adapter",
      label: "Checking browser runtime",
      detail: isBrowserReady(capabilities)
        ? "GradLaunch browser runtime is available for downstream fill and submit flows."
        : "Search can still run, but browser automation is unavailable in this runtime.",
      state: "running",
      source: "gradlaunch"
    },
    {
      id: "profile",
      label: "Loading student context",
      detail: "Reading resume-derived fields, job preferences, and prior application behavior.",
      state: "queued",
      source: "gradlaunch"
    },
    {
      id: "sources",
      label: "Scanning sources",
      detail: `Running a ${duration}-minute ${strictness} search across live job sources and saved direct URLs.`,
      state: "queued",
      source: "gradlaunch"
    },
    {
      id: "ranking",
      label: "Ranking matches",
      detail: "Deduplicating jobs and calculating fit scores before anything is shown to the student.",
      state: "queued",
      source: "gradlaunch"
    },
    {
      id: "review",
      label: "Preparing apply queue",
      detail: "Packaging jobs so you can move straight into a draft, guided fill, or background autopilot run.",
      state: "queued",
      source: "gradlaunch"
    }
  ];

  for (let index = 0; index < phases.length; index += 1) {
    setState({
      summary: "GradLaunch is running the search workflow...",
      recommendations: [],
      activity: phases.map((phase, phaseIndex) => ({
        ...phase,
        state: phaseIndex < index ? "done" : phaseIndex === index ? "running" : "queued"
      }))
    });
    await wait(280);
  }
}

function createIdleActivity(capabilities: AgentCapabilities | null): AgentActivityItem[] {
  return [
    {
      id: "adapter",
      label: "Browser runtime ready",
      detail: isBrowserReady(capabilities)
        ? "GradLaunch browser runtime is ready. The capability panel shows which automation layers are available."
        : "GradLaunch can still search, rank, and package jobs transparently, but browser automation is unavailable.",
      state: isBrowserReady(capabilities) ? "done" : "attention",
      source: "gradlaunch"
    },
    {
      id: "profile",
      label: "Profile ready",
      detail: "GradLaunch uses your resume, preferences, and previous activity as search context.",
      state: "done",
      source: "gradlaunch"
    },
    {
      id: "sources",
      label: "Live sources waiting",
      detail: "Remotive, configured Greenhouse boards, configured Lever companies, and direct URLs will be checked when you start a run.",
      state: "queued",
      source: "gradlaunch"
    },
    {
      id: "ranking",
      label: "Ranking engine idle",
      detail: "Strictness controls how aggressively the agent filters and scores openings.",
      state: "queued",
      source: "gradlaunch"
    },
    {
      id: "review",
      label: "Review queue empty",
      detail: "Matched jobs will appear here with next actions once a run completes.",
      state: "queued",
      source: "gradlaunch"
    }
  ];
}

function isBrowserReady(capabilities: AgentCapabilities | null) {
  const browserCapability = capabilities?.capabilities.find((capability) => capability.id === "browser_apply");
  return browserCapability?.status === "available" || browserCapability?.status === "partial";
}

function wait(durationMs: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, durationMs);
  });
}
