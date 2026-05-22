"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { DashboardReport } from "@gradlaunch/shared";
import { getDashboard } from "../lib/api";
import { useAuth } from "../providers/auth-provider";
import { AgentActivityCard } from "./agent-activity-card";
import { SectionCard } from "./section-card";
import { StatCard } from "./stat-card";
import { StatusPill } from "./status-pill";
import { ProtectedPage } from "./auth/protected-page";
import { PageHeader } from "./page-header";
import { WorkflowSteps } from "./workflow-steps";

export function DashboardPageClient() {
  const { student } = useAuth();
  const [dashboard, setDashboard] = useState<DashboardReport | null>(null);

  useEffect(() => {
    if (!student) {
      return;
    }

    const token = window.sessionStorage.getItem("gradlaunch_session_token");

    if (!token) {
      setDashboard(null);
      return;
    }

    getDashboard(token).then(setDashboard).catch(() => setDashboard(null));
  }, [student]);

  return (
    <ProtectedPage>
      <PageHeader
        eyebrow="Home"
        title={student ? `Welcome back, ${student.fullName.split(" ")[0]}.` : "Everything in one place."}
        description="GradLaunch turns job applications into a background agent workflow: set your profile, find jobs, launch autopilot, and monitor every saved run."
        actions={
          <div className="button-row">
            <Link className="button button-primary" href="/profile">Start Setup</Link>
            <Link className="button button-secondary" href="/search">Find Jobs</Link>
          </div>
        }
      />

      <section className="hero hero-dashboard">
        <div className="card hero-panel hero-primary">
          <p className="eyebrow">Agent workspace</p>
          <h3 className="hero-title">One control room for a background agent that keeps applying while you move on.</h3>
          <p className="muted">
            GradLaunch now runs as an autonomous worker: prepare context once, launch autopilot, and only step in when a portal truly requires you.
          </p>
          <div className="hero-tags">
            <span className="tag">{student?.degree}</span>
            <span className="tag">{student?.defaultStrictness} matching</span>
            <span className="tag">{student?.automationMode.replaceAll("_", " ")}</span>
          </div>
        </div>
        <div className="card quick-panel">
          <p className="eyebrow">Agent focus</p>
          <ul className="list compact-list">
            {dashboard?.pendingActions?.length ? (
              dashboard.pendingActions.map((item, index) => <li className="list-item soft-list-item" key={`${item}-${index}`}>{item}</li>)
            ) : (
              <li className="list-item soft-list-item">No urgent action items yet. Search for jobs or launch your first autopilot run.</li>
            )}
          </ul>
        </div>
      </section>

      <AgentActivityCard
        eyebrow="Agent Status"
        title="What GradLaunch is doing behind the scenes"
        summary="The product follows the GradLaunch docs flow: setup context, discover jobs, hand work to the background agent, and keep a structured audit trail."
        items={[
          {
            id: "profile",
            label: "Profile context available",
            detail: student?.resumeId
              ? "A resume is linked and can be reused for matching, drafting, and autonomous form filling."
              : "Upload a resume so the agent can prefill and personalize future steps.",
            state: student?.resumeId ? "done" : "attention"
          },
          {
            id: "matching",
            label: "Matching engine ready",
            detail: `Current strictness is ${student?.defaultStrictness ?? "balanced"}, with roles focused on ${student?.targetRoles.join(", ") || "your selected roles"}.`,
            state: "done"
          },
          {
            id: "drafts",
            label: "Application package builder",
            detail: dashboard?.recentApplications?.length
              ? "Saved application records already exist and the background agent can continue from the Applications page."
              : "Your first draft or autopilot run will create a structured application record here.",
            state: dashboard?.recentApplications?.length ? "running" : "queued"
          },
          {
            id: "handoff",
            label: "Manual handoff guardrails",
            detail: "GradLaunch only interrupts you for true blockers like login, OTP, captcha, or an unknown required answer.",
            state: "done"
          }
        ]}
      />

      <SectionCard
        title="How GradLaunch Works"
        description="This is the simplified version of the agent workflow so a student can understand what happens without dealing with configs or internal logic."
      >
        <WorkflowSteps />
      </SectionCard>

      <div className="grid metrics">
        {(dashboard?.metrics ?? []).map((metric) => (
          <StatCard key={metric.label} hint={metric.hint} label={metric.label} value={metric.value} />
        ))}
      </div>

      <div className="grid two-up">
        <SectionCard title="Recent Activity" description="These are the latest saved application records for the current user.">
          <table className="table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Role</th>
                <th>Match</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {(dashboard?.recentApplications ?? []).map((application) => (
                <tr key={application.applicationId}>
                  <td>{application.company}</td>
                  <td>{application.role}</td>
                  <td>{application.matchScore}%</td>
                  <td><StatusPill status={application.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>

        <SectionCard title="Current Setup" description="These settings shape matching, search, and autonomous apply behavior.">
          {student ? (
            <ul className="list compact-list">
              <li className="list-item soft-list-item">Degree: {student.degree}</li>
              <li className="list-item soft-list-item">Graduation year: {student.graduationYear}</li>
              <li className="list-item soft-list-item">Target roles: {student.targetRoles.join(", ")}</li>
              <li className="list-item soft-list-item">Preferred locations: {student.preferredLocations.join(", ")}</li>
              <li className="list-item soft-list-item">Skills: {student.skills.join(", ")}</li>
            </ul>
          ) : null}
        </SectionCard>
      </div>
    </ProtectedPage>
  );
}
