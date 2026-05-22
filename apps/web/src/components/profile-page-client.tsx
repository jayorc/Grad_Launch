"use client";

import { useAuth } from "../providers/auth-provider";
import { ProtectedPage } from "./auth/protected-page";
import { PageHeader } from "./page-header";
import { ProfileForm } from "./profile-form";
import { ProfileResumeCard } from "./resume/profile-resume-card";
import { SectionCard } from "./section-card";

export function ProfilePageClient() {
  const { student } = useAuth();

  return (
    <ProtectedPage>
      <PageHeader
        eyebrow="Setup"
        title="Build your complete profile"
        description="Store your resume context, personal details, links, compensation, work authorization, structured history, and reusable answers once so GradLaunch can reuse them across many different job forms."
      />
      <div className="grid two-up">
        <SectionCard title="Complete Profile" description="This is the reusable answer bank GradLaunch consults first before asking an LLM or pausing for manual help.">
          <ProfileForm />
        </SectionCard>
        <SectionCard title="Resume and identity" description="Upload a resume and let GradLaunch read useful profile data from it automatically before the background agent starts filling forms.">
          <ProfileResumeCard />
          {student ? (
            <ul className="list compact-list">
              <li className="list-item soft-list-item">{student.fullName}</li>
              <li className="list-item soft-list-item">{student.email}</li>
              <li className="list-item soft-list-item">{student.bio || "No bio yet."}</li>
              <li className="list-item soft-list-item">Automation mode: {student.automationMode.replaceAll("_", " ")}</li>
              <li className="list-item soft-list-item">Default strictness: {student.defaultStrictness}</li>
              <li className="list-item soft-list-item">Resume linked: {student.resumeId ? "Yes" : "No"}</li>
            </ul>
          ) : null}
        </SectionCard>
      </div>
    </ProtectedPage>
  );
}
