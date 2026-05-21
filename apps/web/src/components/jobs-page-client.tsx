"use client";

import { useEffect, useState } from "react";
import type { AgentCapabilities, Job } from "@gradlaunch/shared";
import { getAgentCapabilities, getJobs } from "../lib/api";
import { AgentCapabilityPanel } from "./agent-capability-panel";
import { BrowserFillAction } from "./browser-fill-action";
import { useAuth } from "../providers/auth-provider";
import { ApplyActions } from "./apply-actions";
import { JobIntakeForm } from "./job-intake-form";
import { PageHeader } from "./page-header";
import { SectionCard } from "./section-card";
import { ProtectedPage } from "./auth/protected-page";

export function JobsPageClient() {
  const { session } = useAuth();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(null);

  useEffect(() => {
    const token = session?.token;

    if (!token) {
      setJobs([]);
      setCapabilities(null);
      return;
    }

    getJobs(token).then(setJobs).catch(() => setJobs([]));
    getAgentCapabilities(token).then(setCapabilities).catch(() => setCapabilities(null));
  }, [session?.token]);

  function handleJobCreated(job: Job) {
    setJobs((current) => {
      const nextJobs = [job, ...current.filter((item) => item.sourceUrl !== job.sourceUrl)];
      return nextJobs;
    });
  }

  const visibleJobs = jobs.filter((job) => !isPlaceholderJobUrl(job.sourceUrl));
  const hiddenPlaceholderCount = jobs.length - visibleJobs.length;
  const browserApplyCapability = capabilities?.capabilities.find((capability) => capability.id === "browser_apply");

  return (
    <ProtectedPage>
      <PageHeader
        eyebrow="Review Jobs"
        title="Choose a job and let the agent run"
        description="Each opening stays readable: review the role, create a draft, or launch autopilot. If the site asks for login or OTP, GradLaunch hands control to you and then resumes."
      />
      <AgentCapabilityPanel
        capabilities={capabilities}
        title="Automation Capabilities"
        description="GradLaunch checks the local AIHawk adapter here so you can see whether the next step can be a real autonomous browser action or only a review-first package."
      />
      <SectionCard title="Add Job from Link" description="Paste any real company job URL and GradLaunch will normalize it into a clean workspace card.">
        {session ? <JobIntakeForm onJobCreated={handleJobCreated} token={session.token} /> : null}
      </SectionCard>
      <SectionCard title="Available Openings" description="The clutter is removed here: job details first, actions second, live execution in the floating companion.">
        {hiddenPlaceholderCount > 0 ? (
          <div className="empty-state">Hidden {hiddenPlaceholderCount} old generated demo opening{hiddenPlaceholderCount === 1 ? "" : "s"}. Run live search or paste real company job URLs to apply.</div>
        ) : null}
        {visibleJobs.length > 0 ? (
          <div className="card-grid">
            {visibleJobs.map((job) => (
              <article className="job-card rich-job-card" key={job.id}>
                <div className="job-card-header">
                  <div>
                    <p className="eyebrow">{job.company}</p>
                    <h3>{job.title}</h3>
                  </div>
                  <span className="tag tag-subtle">{job.sourceType}</span>
                </div>
                <div className="job-meta">
                  <span>{job.location}</span>
                  <span>{job.workMode}</span>
                  <span>{job.minExperience} to {job.maxExperience} yrs</span>
                </div>
                <p className="muted">{job.description}</p>
                <div className="tag-row">
                  {job.skills.slice(0, 5).map((skill) => (
                    <span className="tag" key={skill}>{skill}</span>
                  ))}
                </div>
                {session ? (
                  <BrowserFillAction
                    jobId={job.id}
                    token={session.token}
                    browserReady={browserApplyCapability?.status !== "unavailable"}
                    browserMessage={browserApplyCapability?.detail}
                  />
                ) : null}
                {session ? <ApplyActions jobId={job.id} token={session.token} /> : null}
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state">No live jobs yet. Paste a real job URL or run a search session to build your list.</div>
        )}
      </SectionCard>
    </ProtectedPage>
  );
}

function isPlaceholderJobUrl(value: string) {
  try {
    return new URL(value).hostname === "search.gradlaunch.local";
  } catch (_error) {
    return true;
  }
}
