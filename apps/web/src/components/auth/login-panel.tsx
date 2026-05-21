"use client";

import type { ChangeEvent, FormEvent } from "react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { parseResumeDraft } from "../../lib/api";
import { useAuth } from "../../providers/auth-provider";

type RegisterFields = {
  fullName: string;
  email: string;
  password: string;
  degree: string;
  graduationYear: string;
  targetRoles: string;
  preferredLocations: string;
  skills: string;
};

type LoginFields = {
  email: string;
  password: string;
};

const emptyLoginFields: LoginFields = {
  email: "",
  password: ""
};

const emptyRegisterFields: RegisterFields = {
  fullName: "",
  email: "",
  password: "",
  degree: "",
  graduationYear: "",
  targetRoles: "",
  preferredLocations: "",
  skills: ""
};

export function LoginPanel() {
  const { loginUser, registerUser, isAuthenticated } = useAuth();
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resumeLoading, setResumeLoading] = useState(false);
  const [loginFields, setLoginFields] = useState<LoginFields>(emptyLoginFields);
  const [registerFields, setRegisterFields] = useState<RegisterFields>(emptyRegisterFields);

  useEffect(() => {
    if (isAuthenticated) {
      router.replace("/");
    }
  }, [isAuthenticated, router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (mode === "login") {
        await loginUser({
          email: loginFields.email,
          password: loginFields.password
        });
      } else {
        await registerUser({
          fullName: registerFields.fullName,
          email: registerFields.email,
          password: registerFields.password,
          degree: registerFields.degree,
          graduationYear: Number(registerFields.graduationYear || new Date().getFullYear()),
          targetRoles: splitList(registerFields.targetRoles),
          preferredLocations: splitList(registerFields.preferredLocations),
          skills: splitList(registerFields.skills)
        });
      }

      router.push("/");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to continue.");
    } finally {
      setLoading(false);
    }
  }

  async function handleResumeChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    setResumeLoading(true);
    setError(null);

    try {
      const result = await parseResumeDraft(file);
      setRegisterFields((current) => ({
        ...current,
        fullName: result.draft.fullName || current.fullName,
        email: result.draft.email || current.email,
        degree: result.draft.degree || current.degree,
        graduationYear: result.draft.graduationYear ? String(result.draft.graduationYear) : current.graduationYear,
        targetRoles: result.draft.targetRoles.length > 0 ? result.draft.targetRoles.join(", ") : current.targetRoles,
        preferredLocations: result.draft.preferredLocations.length > 0
          ? result.draft.preferredLocations.join(", ")
          : current.preferredLocations,
        skills: result.draft.skills.length > 0 ? result.draft.skills.join(", ") : current.skills
      }));
    } catch (resumeError) {
      setError(resumeError instanceof Error ? resumeError.message : "Unable to parse resume.");
    } finally {
      setResumeLoading(false);
      event.target.value = "";
    }
  }

  function updateLoginField(key: keyof LoginFields, value: string) {
    setLoginFields((current) => ({
      ...current,
      [key]: value
    }));
  }

  function updateRegisterField(key: keyof RegisterFields, value: string) {
    setRegisterFields((current) => ({
      ...current,
      [key]: value
    }));
  }

  return (
    <div className="auth-grid">
      <section className="card section-card auth-card">
        <div className="auth-card-head">
          <div>
            <p className="eyebrow">{mode === "login" ? "Welcome back" : "Create account"}</p>
            <h2 className="auth-title">
              {mode === "login" ? "Access your GradLaunch workspace" : "Set up your GradLaunch profile"}
            </h2>
            <p className="muted auth-copy">
              {mode === "login"
                ? "Login to continue your job search, drafts, and application tracking."
                : "Create a clean professional profile. You can also upload a resume to prefill the form."}
            </p>
          </div>
          <div className="soft-panel auth-note">
            <p className="detail-label">Demo account</p>
            <p className="detail-value">aarav@example.com</p>
            <p className="detail-value">gradlaunch123</p>
          </div>
        </div>

        <div className="auth-toggle">
          <button className={`button ${mode === "login" ? "button-primary" : "button-secondary"}`} onClick={() => setMode("login")} type="button">
            Login
          </button>
          <button className={`button ${mode === "register" ? "button-primary" : "button-secondary"}`} onClick={() => setMode("register")} type="button">
            Register
          </button>
        </div>

        <form className="form-stack" onSubmit={handleSubmit}>
          {mode === "register" ? (
            <>
              <label className="upload-dropzone">
                <span className="kicker">Resume upload</span>
                <strong>{resumeLoading ? "Reading resume..." : "Upload resume to prefill your profile"}</strong>
                <span className="muted">GradLaunch will extract your email, name, degree, skills, and likely target roles.</span>
                <input accept=".pdf,.doc,.docx,.txt" className="hidden-input" onChange={handleResumeChange} type="file" />
              </label>
              <label>
                <span className="kicker">Full name</span>
                <input className="input" name="fullName" onChange={(event) => updateRegisterField("fullName", event.target.value)} required value={registerFields.fullName} />
              </label>
              <label>
                <span className="kicker">Degree</span>
                <input className="input" name="degree" onChange={(event) => updateRegisterField("degree", event.target.value)} placeholder="B.Tech in Computer Science" required value={registerFields.degree} />
              </label>
              <label>
                <span className="kicker">Graduation year</span>
                <input className="input" name="graduationYear" onChange={(event) => updateRegisterField("graduationYear", event.target.value)} required type="number" value={registerFields.graduationYear} />
              </label>
              <label>
                <span className="kicker">Target roles</span>
                <input className="input" name="targetRoles" onChange={(event) => updateRegisterField("targetRoles", event.target.value)} placeholder="Software Engineer, Frontend Engineer" required value={registerFields.targetRoles} />
              </label>
              <label>
                <span className="kicker">Preferred locations</span>
                <input className="input" name="preferredLocations" onChange={(event) => updateRegisterField("preferredLocations", event.target.value)} placeholder="Bengaluru, Remote" required value={registerFields.preferredLocations} />
              </label>
              <label>
                <span className="kicker">Skills</span>
                <input className="input" name="skills" onChange={(event) => updateRegisterField("skills", event.target.value)} placeholder="React, TypeScript, Node.js" required value={registerFields.skills} />
              </label>
            </>
          ) : null}
          <label>
            <span className="kicker">Email</span>
            <input
              className="input"
              name="email"
              onChange={(event) => {
                if (mode === "register") {
                  updateRegisterField("email", event.target.value);
                  return;
                }

                updateLoginField("email", event.target.value);
              }}
              required
              type="email"
              value={mode === "register" ? registerFields.email : loginFields.email}
            />
          </label>
          <label>
            <span className="kicker">Password</span>
            <input
              className="input"
              name="password"
              onChange={(event) => {
                if (mode === "register") {
                  updateRegisterField("password", event.target.value);
                  return;
                }

                updateLoginField("password", event.target.value);
              }}
              required
              type="password"
              value={mode === "register" ? registerFields.password : loginFields.password}
            />
          </label>
          <button className="button button-primary" disabled={loading} type="submit">
            {loading ? "Please wait..." : mode === "login" ? "Login" : "Create account"}
          </button>
          {error ? <p className="form-error">{error}</p> : null}
        </form>
      </section>
    </div>
  );
}

function splitList(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
