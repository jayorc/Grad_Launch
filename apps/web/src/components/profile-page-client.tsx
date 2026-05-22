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
        title="Set up your resume and preferences"
        description="This keeps everything in one simple profile page. Upload your resume, set preferences, choose your automation level, and let GradLaunch use that everywhere."
      />
      <div className="grid two-up">
        <SectionCard title="Personal Profile" description="These answers are the everyday version of the agent's config and resume context.">
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
