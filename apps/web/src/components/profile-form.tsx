"use client";

import type { AutomationMode, MatchStrictness, StudentProfile, WorkMode } from "@gradlaunch/shared";
import type { ChangeEvent, FormEvent } from "react";
import { useEffect, useState } from "react";
import { useAuth } from "../providers/auth-provider";

type ProfileFormState = {
  fullName: string;
  bio: string;
  degree: string;
  graduationYear: string;
  targetRoles: string;
  preferredLocations: string;
  skills: string;
  expectedSalaryLpa: string;
  automationMode: AutomationMode;
  defaultStrictness: MatchStrictness;
  workModes: WorkMode[];
  visaRequired: boolean;
};

export function ProfileForm() {
  const { student, saveProfile } = useAuth();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [formState, setFormState] = useState<ProfileFormState | null>(null);

  useEffect(() => {
    if (!student) {
      setFormState(null);
      return;
    }

    setFormState(createFormState(student));
  }, [student]);

  if (!student || !formState) {
    return null;
  }

  const currentStudent = student;
  const currentFormState = formState;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      await saveProfile({
        fullName: currentFormState.fullName,
        degree: currentFormState.degree,
        graduationYear: Number(currentFormState.graduationYear || currentStudent.graduationYear),
        targetRoles: splitList(currentFormState.targetRoles),
        preferredLocations: splitList(currentFormState.preferredLocations),
        workModes: currentFormState.workModes.length > 0 ? currentFormState.workModes : ["remote"],
        skills: splitList(currentFormState.skills),
        expectedSalaryLpa: toOptionalNumber(currentFormState.expectedSalaryLpa),
        visaRequired: currentFormState.visaRequired,
        automationMode: currentFormState.automationMode,
        defaultStrictness: currentFormState.defaultStrictness,
        bio: currentFormState.bio
      });

      setMessage("Profile saved.");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to save profile.");
    } finally {
      setLoading(false);
    }
  }

  function updateField<Key extends keyof ProfileFormState>(key: Key, value: ProfileFormState[Key]) {
    setFormState((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        [key]: value
      };
    });
  }

  function handleInputChange(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) {
    const { name, value } = event.target;

    if (name === "automationMode") {
      updateField("automationMode", value as AutomationMode);
      return;
    }

    if (name === "defaultStrictness") {
      updateField("defaultStrictness", value as MatchStrictness);
      return;
    }

    updateField(name as keyof Omit<ProfileFormState, "workModes" | "visaRequired" | "automationMode" | "defaultStrictness">, value);
  }

  function handleWorkModeChange(mode: WorkMode, checked: boolean) {
    const nextModes = checked
      ? [...new Set([...currentFormState.workModes, mode])]
      : currentFormState.workModes.filter((item) => item !== mode);

    updateField("workModes", nextModes);
  }

  return (
    <form className="form-stack" onSubmit={handleSubmit}>
      <label>
        <span className="kicker">Full name</span>
        <input className="input" name="fullName" onChange={handleInputChange} required value={currentFormState.fullName} />
      </label>
      <label>
        <span className="kicker">Bio</span>
        <textarea className="input textarea" name="bio" onChange={handleInputChange} value={currentFormState.bio} />
      </label>
      <label>
        <span className="kicker">Degree</span>
        <input className="input" name="degree" onChange={handleInputChange} required value={currentFormState.degree} />
      </label>
      <label>
        <span className="kicker">Graduation year</span>
        <input className="input" name="graduationYear" onChange={handleInputChange} required type="number" value={currentFormState.graduationYear} />
      </label>
      <label>
        <span className="kicker">Target roles</span>
        <input className="input" name="targetRoles" onChange={handleInputChange} required value={currentFormState.targetRoles} />
      </label>
      <label>
        <span className="kicker">Preferred locations</span>
        <input className="input" name="preferredLocations" onChange={handleInputChange} required value={currentFormState.preferredLocations} />
      </label>
      <label>
        <span className="kicker">Skills</span>
        <input className="input" name="skills" onChange={handleInputChange} required value={currentFormState.skills} />
      </label>
      <label>
        <span className="kicker">Expected salary (LPA)</span>
        <input className="input" name="expectedSalaryLpa" onChange={handleInputChange} type="number" value={currentFormState.expectedSalaryLpa} />
      </label>
      <label>
        <span className="kicker">Automation mode</span>
        <select className="select" name="automationMode" onChange={handleInputChange} value={currentFormState.automationMode}>
          <option value="alerts_only">Alerts only</option>
          <option value="draft_and_review">Draft and review</option>
          <option value="autofill_with_review">Autofill with review</option>
          <option value="full_autopilot">Full autopilot</option>
        </select>
      </label>
      <label>
        <span className="kicker">Default strictness</span>
        <select className="select" name="defaultStrictness" onChange={handleInputChange} value={currentFormState.defaultStrictness}>
          <option value="broad">Broad</option>
          <option value="balanced">Balanced</option>
          <option value="strict">Strict</option>
        </select>
      </label>
      <fieldset className="checkbox-group">
        <legend className="kicker">Work modes</legend>
        <label><input checked={currentFormState.workModes.includes("remote")} onChange={(event) => handleWorkModeChange("remote", event.target.checked)} type="checkbox" value="remote" /> Remote</label>
        <label><input checked={currentFormState.workModes.includes("hybrid")} onChange={(event) => handleWorkModeChange("hybrid", event.target.checked)} type="checkbox" value="hybrid" /> Hybrid</label>
        <label><input checked={currentFormState.workModes.includes("onsite")} onChange={(event) => handleWorkModeChange("onsite", event.target.checked)} type="checkbox" value="onsite" /> Onsite</label>
      </fieldset>
      <label className="checkbox-line">
        <input checked={currentFormState.visaRequired} onChange={(event) => updateField("visaRequired", event.target.checked)} type="checkbox" />
        Visa sponsorship needed
      </label>
      <button className="button button-primary" disabled={loading} type="submit">
        {loading ? "Saving..." : "Save profile"}
      </button>
      {message ? <p className="muted">{message}</p> : null}
      {error ? <p className="muted">{error}</p> : null}
    </form>
  );
}

function splitList(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function createFormState(student: StudentProfile): ProfileFormState {
  return {
    fullName: student.fullName,
    bio: student.bio ?? "",
    degree: student.degree,
    graduationYear: String(student.graduationYear),
    targetRoles: student.targetRoles.join(", "),
    preferredLocations: student.preferredLocations.join(", "),
    skills: student.skills.join(", "),
    expectedSalaryLpa: student.expectedSalaryLpa ? String(student.expectedSalaryLpa) : "",
    automationMode: student.automationMode,
    defaultStrictness: student.defaultStrictness,
    workModes: student.workModes,
    visaRequired: student.visaRequired
  };
}

function toOptionalNumber(value: string) {
  if (!value || value === "") {
    return undefined;
  }

  return Number(value);
}
