"use client";

import type { Job } from "@gradlaunch/shared";
import type { FormEvent } from "react";
import { useState } from "react";
import { intakeJobUrl } from "../lib/api";
import { BrowserFillAction } from "./browser-fill-action";

type JobIntakeFormProps = {
  token: string;
  onJobCreated?: (job: Job) => void;
};

export function JobIntakeForm({ token, onJobCreated }: JobIntakeFormProps) {
  const [jobUrl, setJobUrl] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const result = await intakeJobUrl(token, jobUrl);
      setJob(result);
      setJobUrl("");
      onJobCreated?.(result);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to intake job URL.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="form-stack">
      <form className="form-stack" onSubmit={handleSubmit}>
        <label>
          <span className="kicker">Paste job URL</span>
          <input
            className="input"
            onChange={(event) => setJobUrl(event.target.value)}
            placeholder="https://boards.greenhouse.io/company/jobs/123"
            required
            type="url"
            value={jobUrl}
          />
        </label>
        <button className="button button-primary" disabled={loading} type="submit">
          {loading ? "Extracting..." : "Extract Job"}
        </button>
      </form>
      {error ? <p className="form-error">{error}</p> : null}
      {job ? (
        <article className="job-card rich-job-card">
          <div className="job-card-header">
            <div>
              <p className="eyebrow">Latest extracted job</p>
              <h3>{job.title}</h3>
            </div>
            <span className="tag">{job.sourceType}</span>
          </div>
          <div className="job-meta">
            <span>{job.company}</span>
            <span>{job.location}</span>
            <span>{job.workMode}</span>
          </div>
          <p className="muted">{job.description}</p>
          <BrowserFillAction jobId={job.id} token={token} />
        </article>
      ) : null}
    </div>
  );
}
