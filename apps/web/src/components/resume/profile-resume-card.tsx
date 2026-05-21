"use client";

import type { ChangeEvent } from "react";
import { useState } from "react";
import type { ResumeDraftResponse } from "@gradlaunch/shared";
import { uploadStudentResume } from "../../lib/api";
import { useAuth } from "../../providers/auth-provider";

export function ProfileResumeCard() {
  const { session, refreshSession } = useAuth();
  const [result, setResult] = useState<ResumeDraftResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file || !session?.token) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await uploadStudentResume(session.token, file);
      setResult(response);
      await refreshSession();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Unable to upload resume.");
    } finally {
      setLoading(false);
      event.target.value = "";
    }
  }

  return (
    <div className="form-stack">
      <label className="upload-dropzone">
        <span className="kicker">Upload resume</span>
        <strong>{loading ? "Uploading..." : "Choose PDF, DOCX, or TXT"}</strong>
        <span className="muted">GradLaunch will store the resume and refresh profile fields from it.</span>
        <input accept=".pdf,.doc,.docx,.txt" className="hidden-input" onChange={handleFileChange} type="file" />
      </label>
      {error ? <p className="form-error">{error}</p> : null}
      {result ? (
        <div className="soft-panel">
          <p className="detail-label">Latest parsed resume</p>
          <p className="detail-value">{result.resume.filename}</p>
          <p className="muted">
            Parsed: {result.draft.fullName || "No name found"} • {result.draft.email || "No email found"} •{" "}
            {result.draft.degree || "No degree found"}
          </p>
          <p className="muted">
            Roles: {result.draft.targetRoles.length > 0 ? result.draft.targetRoles.join(", ") : "No target roles detected yet"}
          </p>
          <p className="muted">
            Skills: {result.draft.skills.length > 0 ? result.draft.skills.join(", ") : "No skills detected yet"}
          </p>
        </div>
      ) : null}
    </div>
  );
}
