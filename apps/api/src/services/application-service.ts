import type {
  AgentCapabilities,
  AgentTimelineStep,
  Application,
  BrowserApplyReceipt,
  ApplicationSubmission,
  ApplicationRun,
  CreateApplicationInput,
  SubmitApplicationInput,
  Job,
  ResumeRecord,
  StudentProfile
} from "@gradlaunch/shared";
import { ApplicationRepository } from "../repositories/application-repository";
import { JobRepository } from "../repositories/job-repository";
import { ResumeRepository } from "../repositories/resume-repository";
import { StudentRepository } from "../repositories/student-repository";
import { createId } from "../lib/id";
import { nowIso } from "../lib/time";
import { AIHawkAdapterService, type StructuredApplicationPackageResult } from "./aihawk-adapter-service";
import { AgentOrchestratorService } from "./agent-orchestrator-service";
import { EmailService } from "./email-service";
import { MatchingService } from "./matching-service";
import { StudentMemoryService } from "./student-memory-service";

export class ApplicationService {
  constructor(
    private readonly students = new StudentRepository(),
    private readonly jobs = new JobRepository(),
    private readonly applications = new ApplicationRepository(),
    private readonly resumes = new ResumeRepository(),
    private readonly matching = new MatchingService(),
    private readonly aihawk = new AIHawkAdapterService(),
    private readonly emails = new EmailService(),
    private readonly orchestrator = new AgentOrchestratorService(),
    private readonly memory = new StudentMemoryService()
  ) {}

  async create(input: CreateApplicationInput) {
    const [student, job, existingApplication, capabilities, resume] = await Promise.all([
      this.students.getById(input.studentId),
      this.jobs.getById(input.jobId),
      this.applications.getByStudentAndJob(input.studentId, input.jobId),
      this.aihawk.getCapabilities(),
      this.resumes.getLatestByStudent(input.studentId)
    ]);

    if (!student || !job) {
      throw new Error("Student or job not found.");
    }

    if (existingApplication) {
      throw new Error("An application for this job already exists in your workspace.");
    }

    const recommendation = this.matching.scoreJob(student, job, student.defaultStrictness);
    const now = nowIso();

    const application: Application = {
      id: createId("application"),
      studentId: student.id,
      jobId: job.id,
      status: input.mode === "autopilot" ? "running" : input.mode === "autofill" ? "ready_for_review" : "draft_ready",
      sourceLabel: formatSource(job),
      matchScore: recommendation.score,
      generatedArtifacts: createArtifacts(student, job, resume),
      uploadedDocuments: createUploadedDocumentList(resume),
      lastUpdatedAt: now,
      createdAt: now
    };

    const baseRun: ApplicationRun = {
      id: createId("run"),
      applicationId: application.id,
      status: input.mode === "autopilot" ? "queued" : input.mode === "autofill" ? "needs_review" : "completed",
      startedAt: now,
      completedAt: input.mode === "draft" ? now : undefined,
      adapterId: capabilities.adapterId,
      executionMode: input.mode === "autopilot" ? "autonomous_apply" : input.mode === "autofill" ? "guided_autofill" : "draft_package",
      workspacePath: undefined,
      workspaceFiles: [],
      screenshots: input.mode === "draft" ? [] : ["review-gate.png"],
      blockedReason: undefined,
      filledFields: buildFilledFields(student, job, resume, application.generatedArtifacts),
      timeline: buildApplicationTimeline({
        mode: input.mode,
        student,
        job,
        capabilities,
        hasResume: Boolean(resume),
        filledFieldsCount: 0
      }),
      notes: buildRunNotes({
        mode: input.mode,
        capabilities,
        resume
      })
    };

    const { run } = await this.finalizeRun(baseRun, application, student, job, resume, capabilities, input.mode);

    await this.applications.create(application);
    await this.applications.createRun(run);

    if (input.mode === "autopilot") {
      await this.orchestrator.queueAutonomousApplication({
        studentId: student.id,
        application,
        job
      });
    }

    return {
      application,
      run,
      capabilities
    };
  }

  async listForStudent(studentId: string) {
    return this.applications.listByStudent(studentId);
  }

  async fillJobInBrowser(input: { studentId: string; jobId: string; submit?: boolean }) {
    const [student, job, existingApplication, capabilities, resume] = await Promise.all([
      this.students.getById(input.studentId),
      this.jobs.getById(input.jobId),
      this.applications.getByStudentAndJob(input.studentId, input.jobId),
      this.aihawk.getCapabilities(),
      this.resumes.getLatestByStudent(input.studentId)
    ]);

    if (!student || !job) {
      throw new Error("Student or job not found.");
    }

    const now = nowIso();
    const recommendation = this.matching.scoreJob(student, job, student.defaultStrictness);
    const application: Application = existingApplication ?? {
      id: createId("application"),
      studentId: student.id,
      jobId: job.id,
      status: "ready_for_review",
      sourceLabel: formatSource(job),
      matchScore: recommendation.score,
      generatedArtifacts: createArtifacts(student, job, resume),
      uploadedDocuments: createUploadedDocumentList(resume),
      lastUpdatedAt: now,
      createdAt: now
    };
    const existingRuns = existingApplication ? await this.applications.listRunsByApplication(application.id) : [];
    const fields = mergeFilledFields(
      existingRuns[0]?.filledFields ?? [],
      buildFilledFields(student, job, resume, application.generatedArtifacts)
    );

    const preparingRun: ApplicationRun = {
      id: createId("run"),
      applicationId: application.id,
      status: "running",
      startedAt: now,
      adapterId: capabilities.adapterId,
      executionMode: "browser_apply",
      workspacePath: existingRuns[0]?.workspacePath,
      workspaceFiles: existingRuns[0]?.workspaceFiles ?? [],
      screenshots: existingRuns[0]?.screenshots ?? ["review-gate.png"],
      filledFields: fields,
      planner: existingRuns[0]?.planner,
      timeline: buildBrowserFillTimeline({
        job,
        receipt: undefined,
        workspacePath: existingRuns[0]?.workspacePath,
        planner: existingRuns[0]?.planner
      }),
      notes: ["Opening the exact job URL in Chrome and filling known fields in front of the student."]
    };

    const preparationPackage = await this.aihawk.createStructuredApplicationPackage({
      application,
      run: preparingRun,
      job,
      student,
      resume
    });

    const browserReceipt = await this.aihawk.applyWithBrowser({
      job,
      fields,
      workspacePath: preparationPackage.directory,
      resume,
      submit: input.submit === true,
      planner: existingRuns[0]?.planner
    });
    const completedAt = nowIso();
    const blocked = browserReceipt.status === "blocked";
    const handoffRequired = browserReceipt.status === "handoff_required";
    const needsManualReview = browserReceipt.status === "needs_manual_review";
    const filled = browserReceipt.status === "filled";
    const submitted = browserReceipt.status === "submitted";
    const updatedApplication: Application = {
      ...application,
      status: blocked ? "blocked" : submitted ? "submitted" : filled ? "autofilled" : "ready_for_review",
      lastUpdatedAt: completedAt
    };
    const submission: ApplicationSubmission = {
      intent: "browser_fill",
      outcome: blocked || handoffRequired ? "blocked" : "confirmed",
      externalSubmitted: submitted,
      confirmation: browserReceipt.message,
      submittedAt: completedAt,
      email: {
        status: "skipped",
        provider: "outbox",
        to: student.email,
        subject: `GradLaunch filled ${job.company} - ${job.title}`,
        sentAt: completedAt,
        message: "Email is skipped for fill-only mode. Final submit will send the student confirmation."
      },
      browser: browserReceipt
    };
    const finalRun: ApplicationRun = {
      ...preparingRun,
      status: blocked ? "blocked" : handoffRequired || needsManualReview ? "needs_review" : "completed",
      completedAt,
      workspacePath: preparationPackage.directory,
      screenshots: mergeScreenshots(preparingRun.screenshots, browserReceipt.screenshots),
      blockedReason: blocked || handoffRequired ? browserReceipt.message : undefined,
      planner: browserReceipt.planner,
      timeline: buildBrowserFillTimeline({
        job,
        receipt: browserReceipt,
        workspacePath: preparationPackage.directory,
        planner: browserReceipt.planner
      }),
      notes: [
        browserReceipt.message,
        `Browser fill status: ${browserReceipt.status}.`,
        `Filled fields: ${browserReceipt.filledLabels.length}. Skipped fields: ${browserReceipt.skippedLabels.length}.`
      ],
      submission
    };
    const finalPackage = await this.aihawk.createStructuredApplicationPackage({
      application: updatedApplication,
      run: finalRun,
      job,
      student,
      resume
    });
    const savedRun: ApplicationRun = {
      ...finalRun,
      workspaceFiles: finalPackage.files,
      workspacePath: finalPackage.directory
    };

    if (existingApplication) {
      await this.applications.update(updatedApplication);
    } else {
      await this.applications.create(updatedApplication);
    }

    await this.applications.createRun(savedRun);

    return {
      application: updatedApplication,
      run: savedRun,
      capabilities
    };
  }

  async submit(input: SubmitApplicationInput) {
    const [application, capabilities] = await Promise.all([
      this.applications.getById(input.applicationId),
      this.aihawk.getCapabilities()
    ]);

    if (!application || application.studentId !== input.studentId) {
      throw new Error("Application not found.");
    }

    const [student, job, runs, resume] = await Promise.all([
      this.students.getById(application.studentId),
      this.jobs.getById(application.jobId),
      this.applications.listRunsByApplication(application.id),
      this.resumes.getLatestByStudent(application.studentId)
    ]);

    if (!student || !job) {
      throw new Error("Student or job not found.");
    }

    const latestRun = runs[0];
    const browserCapability = capabilities.capabilities.find((capability) => capability.id === "browser_apply");
    const wantsAutoSubmit = input.intent === "auto_submit";
    const canAutoSubmit = wantsAutoSubmit && (browserCapability?.status === "available" || browserCapability?.status === "partial");
    const now = nowIso();
    const reviewedFields = normalizeReviewedFields(input.reviewedFields, latestRun?.filledFields ?? buildFilledFields(student, job, resume, application.generatedArtifacts));
    const browserReceipt = canAutoSubmit
      ? await this.aihawk.applyWithBrowser({
          job,
          fields: reviewedFields,
          workspacePath: latestRun?.workspacePath,
          resume,
          submit: true,
          planner: latestRun?.planner
        })
      : undefined;
    const browserSubmitBlocked = wantsAutoSubmit && (!canAutoSubmit || browserReceipt?.status !== "submitted");
    const externalSubmitted = wantsAutoSubmit
      ? browserReceipt?.status === "submitted"
      : Boolean(input.confirmExternalSubmit);

    const email = browserSubmitBlocked
      ? {
          status: "skipped" as const,
          provider: "outbox" as const,
          to: student.email,
          subject: `GradLaunch could not submit ${job.company} - ${job.title}`,
          sentAt: now,
          message: browserReceipt?.message ?? "Email was skipped because the auto-submit worker is unavailable."
        }
      : await this.emails.sendApplicationCompletion({
          student,
          job,
          workspacePath: latestRun?.workspacePath,
          externalSubmitted
        });

    const submission: ApplicationSubmission = {
      intent: input.intent,
      outcome: browserSubmitBlocked ? "blocked" : "confirmed",
      externalSubmitted,
      confirmation: buildSubmissionConfirmation({
        blocked: browserSubmitBlocked,
        externalSubmitted,
        wantsAutoSubmit,
        browserCapabilityStatus: browserCapability?.status,
        browserReceipt
      }),
      submittedAt: now,
      email,
      browser: browserReceipt
    };

    const updatedApplication: Application = {
      ...application,
      status: browserSubmitBlocked ? "ready_for_review" : externalSubmitted ? "submitted" : "ready_for_review",
      lastUpdatedAt: now
    };

    const baseRun: ApplicationRun = {
      id: createId("run"),
      applicationId: application.id,
      status: browserSubmitBlocked ? "blocked" : "completed",
      startedAt: now,
      completedAt: now,
      adapterId: capabilities.adapterId,
      executionMode: canAutoSubmit ? "browser_apply" : "guided_autofill",
      workspacePath: latestRun?.workspacePath,
      workspaceFiles: latestRun?.workspaceFiles ?? [],
      screenshots: mergeScreenshots(latestRun?.screenshots, browserReceipt?.screenshots),
      blockedReason: browserSubmitBlocked ? (browserReceipt?.message ?? "AIHawk browser auto-submit is unavailable in this checkout.") : undefined,
      filledFields: reviewedFields,
      planner: browserReceipt?.planner ?? latestRun?.planner,
      timeline: buildSubmissionTimeline({
        submission,
        job,
        workspacePath: latestRun?.workspacePath,
        browserCapabilityStatus: browserCapability?.status
      }),
      notes: buildSubmissionNotes(submission, latestRun?.workspacePath),
      submission
    };

    const packageResult = await this.aihawk.createStructuredApplicationPackage({
      application: updatedApplication,
      run: baseRun,
      job,
      student,
      resume
    });

    const finalRun: ApplicationRun = {
      ...baseRun,
      workspacePath: packageResult.directory,
      workspaceFiles: packageResult.files,
      notes: buildSubmissionNotes(submission, packageResult.directory)
    };

    await this.aihawk.createStructuredApplicationPackage({
      application: updatedApplication,
      run: finalRun,
      job,
      student,
      resume
    });

    await this.applications.update(updatedApplication);
    await this.applications.createRun(finalRun);

    if (input.reviewedFields.length > 0) {
      await this.memory.recordCorrections(application.studentId, reviewedFields);
    }

    return {
      application: updatedApplication,
      run: finalRun,
      capabilities
    };
  }

  async resumeInBrowser(input: { studentId: string; applicationId: string; submit?: boolean }) {
    const application = await this.applications.getById(input.applicationId);

    if (!application || application.studentId !== input.studentId) {
      throw new Error("Application not found.");
    }

    return this.fillJobInBrowser({
      studentId: input.studentId,
      jobId: application.jobId,
      submit: input.submit
    });
  }
  private async finalizeRun(
    baseRun: ApplicationRun,
    application: Application,
    student: StudentProfile,
    job: Job,
    resume: ResumeRecord | undefined,
    capabilities: AgentCapabilities,
    mode: CreateApplicationInput["mode"]
  ) {
    try {
      const packageResult = await this.aihawk.createStructuredApplicationPackage({
        application,
        run: baseRun,
        job,
        student,
        resume
      });

      const finalRun: ApplicationRun = {
        ...baseRun,
        workspacePath: packageResult.directory,
        workspaceFiles: packageResult.files,
        filledFields: buildFilledFields(student, job, resume, application.generatedArtifacts),
        timeline: buildApplicationTimeline({
          mode,
          student,
          job,
          capabilities,
          hasResume: Boolean(resume),
          packageResult,
          filledFieldsCount: baseRun.filledFields.length
        }),
        notes: buildRunNotes({
          mode,
          capabilities,
          resume,
          packageResult
        })
      };

      await this.aihawk.createStructuredApplicationPackage({
        application,
        run: finalRun,
        job,
        student,
        resume
      });

      return {
        run: finalRun,
        packageError: undefined
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to save the structured application package.";

      return {
        run: {
          ...baseRun,
          workspacePath: undefined,
          workspaceFiles: [],
          timeline: buildApplicationTimeline({
            mode,
            student,
            job,
            capabilities,
            hasResume: Boolean(resume),
            packageError: message,
            filledFieldsCount: baseRun.filledFields.length
          }),
          notes: buildRunNotes({
            mode,
            capabilities,
            resume,
            packageError: message
          })
        },
        packageError: message
      };
    }
  }
}

function normalizeReviewedFields(reviewedFields: ApplicationRun["filledFields"], fallbackFields: ApplicationRun["filledFields"]) {
  const fields = reviewedFields.length > 0 ? reviewedFields : fallbackFields;

  return fields
    .map((field) => ({
      label: field.label.trim(),
      value: field.value.trim()
    }))
    .filter((field) => field.label.length > 0);
}

function mergeFilledFields(primaryFields: ApplicationRun["filledFields"], generatedFields: ApplicationRun["filledFields"]) {
  const merged = new Map<string, ApplicationRun["filledFields"][number]>();

  for (const field of generatedFields) {
    merged.set(normalizeFieldKey(field.label), field);
  }

  for (const field of primaryFields) {
    if (field.value.trim()) {
      merged.set(normalizeFieldKey(field.label), field);
    }
  }

  return [...merged.values()];
}

function normalizeFieldKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function mergeScreenshots(existing: string[] | undefined, browserScreenshots: string[] | undefined) {
  const values = [...(existing ?? ["review-gate.png"]), ...(browserScreenshots ?? [])];
  return [...new Set(values)];
}

function buildSubmissionConfirmation(input: {
  blocked: boolean;
  externalSubmitted: boolean;
  wantsAutoSubmit: boolean;
  browserCapabilityStatus?: string;
  browserReceipt?: BrowserApplyReceipt;
}) {
  if (input.blocked) {
    return input.browserReceipt?.message ?? "Auto-submit was blocked because the connected AIHawk browser apply worker is unavailable.";
  }

  if (input.externalSubmitted && input.wantsAutoSubmit) {
    return input.browserReceipt?.message ?? "AIHawk browser apply completed the final submit step and GradLaunch recorded the receipt.";
  }

  if (input.externalSubmitted) {
    return "Student reviewed the prepared fields and confirmed the final job portal submission.";
  }

  return `Student reviewed the package. Browser worker status: ${input.browserCapabilityStatus ?? "unknown"}.`;
}

function buildSubmissionTimeline(input: {
  submission: ApplicationSubmission;
  job: Job;
  workspacePath?: string;
  browserCapabilityStatus?: string;
}): AgentTimelineStep[] {
  const blocked = input.submission.outcome === "blocked";

  return [
    {
      id: "review",
      label: "Student review confirmed",
      detail: "The prepared fields, resume brief, cover-letter excerpt, and short answers were reviewed on the workspace screen.",
      state: "done",
      source: "gradlaunch"
    },
    {
      id: "fill",
      label: "Form values finalized",
      detail: `Final values were locked for ${input.job.title} at ${input.job.company}.`,
      state: "done",
      source: "gradlaunch"
    },
    {
      id: "submit",
      label: input.submission.externalSubmitted ? "Final submit recorded" : "Auto-submit blocked",
      detail: input.submission.confirmation,
      state: blocked ? "attention" : "done",
      source: input.submission.intent === "auto_submit" ? "aihawk" : "gradlaunch"
    },
    {
      id: "workspace",
      label: "Workspace receipt saved",
      detail: input.workspacePath
        ? `Updated the workspace package at ${input.workspacePath}.`
        : "Updated the workspace package with the submission receipt.",
      state: blocked ? "attention" : "done",
      source: "gradlaunch"
    },
    {
      id: "email",
      label: "Student email notification",
      detail: input.submission.email.message ?? `${input.submission.email.status} via ${input.submission.email.provider}.`,
      state: input.submission.email.status === "failed" ? "attention" : "done",
      source: "gradlaunch"
    }
  ];
}

function buildBrowserFillTimeline(input: {
  job: Job;
  receipt?: BrowserApplyReceipt;
  workspacePath?: string;
  planner?: ApplicationRun["planner"];
}): AgentTimelineStep[] {
  const receipt = input.receipt;
  const blocked = receipt?.status === "blocked";
  const handoffRequired = receipt?.status === "handoff_required";
  const filled = receipt?.status === "filled";
  const submitted = receipt?.status === "submitted";

  return [
    {
      id: "open",
      label: "Opening exact job URL",
      detail: `Chrome opens ${input.job.sourceUrl}.`,
      state: receipt ? "done" : "running",
      source: "gradlaunch"
    },
    {
      id: "fill",
      label: "Filling visible form fields",
      detail: receipt
        ? receipt.message
        : "GradLaunch is matching profile values to labels, placeholders, and form names on the page.",
      state: blocked || handoffRequired ? "attention" : receipt ? "done" : "queued",
      source: "gradlaunch"
    },
    {
      id: "pause",
      label: submitted ? "Submission completed" : handoffRequired ? "Waiting for manual handoff" : "Pausing before submit",
      detail: submitted
        ? "Chrome completed the final submit action and saved the browser receipt."
        : filled
          ? "Chrome stays open so the student can inspect the filled form and submit manually."
        : blocked || handoffRequired
          ? receipt.message
          : "The run stops before final submission.",
      state: blocked || handoffRequired ? "attention" : receipt ? "done" : "queued",
      source: "gradlaunch"
    },
    {
      id: "planner",
      label: "Planner checkpoint updated",
      detail: input.planner
        ? `${input.planner.summary} Resume token: ${input.planner.resumeToken}.`
        : "The planner will save a resumable checkpoint after the browser worker updates the workspace.",
      state: input.planner ? "done" : "queued",
      source: "gradlaunch"
    },
    {
      id: "workspace",
      label: "Saving screenshots and receipt",
      detail: input.workspacePath
        ? `Workspace updated at ${input.workspacePath}.`
        : "The workspace will be updated after Chrome finishes filling.",
      state: blocked || handoffRequired ? "attention" : receipt ? "done" : "queued",
      source: "gradlaunch"
    }
  ];
}

function buildSubmissionNotes(submission: ApplicationSubmission, workspacePath?: string) {
  return [
    submission.confirmation,
    workspacePath ? `Submission receipt saved to ${workspacePath}.` : "Submission receipt was recorded in the run trace.",
    `Email status: ${submission.email.status} via ${submission.email.provider}.`
  ];
}

function createArtifacts(student: StudentProfile, job: Job, resume?: ResumeRecord) {
  const roleTarget = student.targetRoles[0] ?? "software engineer";
  const leadSkills = student.skills.slice(0, 4);
  const resumeSource = resume ? `Uploaded resume ${resume.filename} was used as the primary context.` : "No uploaded resume was available, so GradLaunch used the saved profile.";

  return {
    tailoredResumeSummary: `${resumeSource} Focused ${leadSkills.join(", ")} to match the ${job.title} role at ${job.company}.`,
    coverLetterExcerpt: `I am excited to apply for the ${job.title} role at ${job.company}, where I can bring my ${student.skills.slice(0, 3).join(", ")} experience as an aspiring ${roleTarget}.`,
    shortAnswers: [
      {
        question: "Why are you interested in this role?",
        answer: `This role aligns with my goal of becoming a ${student.targetRoles[0]} and uses skills I have already practiced through projects and coursework.`
      },
      {
        question: "What makes you a match?",
        answer: `My background in ${student.skills.slice(0, 4).join(", ")} closely matches the technical expectations in the job description.`
      }
    ]
  };
}

function createUploadedDocumentList(resume?: ResumeRecord) {
  const documents = ["tailored_resume_summary.txt", "cover_letter_excerpt.txt", "short_answers.json"];

  if (resume) {
    documents.unshift(resume.filename);
  }

  return documents;
}

function buildFilledFields(student: StudentProfile, job: Job, resume?: ResumeRecord, artifacts?: Application["generatedArtifacts"]): ApplicationRun["filledFields"] {
  const nameParts = student.fullName.trim().split(/\s+/).filter(Boolean);
  const firstName = nameParts[0] ?? student.fullName;
  const lastName = nameParts.slice(1).join(" ");
  const preferredLocation = student.preferredLocations[0] ?? job.location;
  const city = preferredLocation.split(",")[0]?.trim() || preferredLocation;
  const phoneNumber = extractPhoneNumber(resume?.extractedText) ?? process.env.DEFAULT_STUDENT_PHONE;
  const country = process.env.DEFAULT_STUDENT_COUNTRY
    ?? inferCountryFromPhone(phoneNumber)
    ?? inferCountryFromLocation(preferredLocation)
    ?? "India";
  const linkedInUrl = extractUrl(resume?.extractedText, /linkedin\.com\/[^\s)>,]+/i) ?? process.env.DEFAULT_STUDENT_LINKEDIN;
  const websiteUrl = extractUrl(resume?.extractedText, /(github\.com|portfolio|https?:\/\/(?!.*linkedin)[^\s)>,]+)/i) ?? process.env.DEFAULT_STUDENT_WEBSITE;
  const currentCtc = extractCompensation(resume?.extractedText, /current\s+(?:ctc|salary|compensation)[:\s-]*([^\n,;]+)/i) ?? process.env.DEFAULT_CURRENT_CTC ?? "0 LPA";
  const expectedCtc = student.expectedSalaryLpa ? `${student.expectedSalaryLpa} LPA` : process.env.DEFAULT_EXPECTED_CTC;
  const hiringMessage = artifacts?.coverLetterExcerpt
    ?? `I am interested in the ${job.title} role at ${job.company} and believe my ${student.skills.slice(0, 3).join(", ")} experience is a strong match.`;
  const fields: ApplicationRun["filledFields"] = [
    { label: "First name", value: firstName },
    { label: "Last name", value: lastName },
    { label: "Full name", value: student.fullName },
    { label: "Email", value: student.email },
    { label: "Confirm your email", value: student.email },
    { label: "City", value: city },
    { label: "Location", value: preferredLocation },
    { label: "Location (City)", value: city },
    { label: "Country", value: country },
    { label: "Phone number", value: phoneNumber ?? "" },
    { label: "Phone", value: phoneNumber ?? "" },
    { label: "Mobile", value: phoneNumber ?? "" },
    { label: "Degree", value: student.degree },
    { label: "Graduation year", value: String(student.graduationYear) },
    { label: "Preferred location", value: preferredLocation },
    { label: "Target role", value: student.targetRoles[0] ?? job.title },
    { label: "LinkedIn", value: linkedInUrl ?? "" },
    { label: "Website", value: websiteUrl ?? "" },
    { label: "Work authorization", value: student.visaRequired ? "No" : "Yes" },
    { label: "Legally authorized to work", value: student.visaRequired ? "No" : "Yes" },
    { label: "Visa sponsorship required", value: student.visaRequired ? "Yes" : "No" },
    { label: "Visa required", value: student.visaRequired ? "Yes" : "No" },
    { label: "Current CTC", value: currentCtc },
    { label: "Current salary", value: currentCtc },
    { label: "Expected salary", value: expectedCtc ?? "" },
    { label: "Expected CTC", value: expectedCtc ?? "" },
    { label: "Message to the Hiring Team", value: hiringMessage },
    { label: "Primary skills", value: student.skills.slice(0, 5).join(", ") || "Not provided" },
    { label: "Resume context", value: resume?.filename ?? "Profile data only" },
    {
      label: "Why are you interested in this role?",
      value: `This role aligns with my goal of becoming a ${student.targetRoles[0] ?? job.title} and uses skills I have practiced through projects and coursework.`
    },
    {
      label: "What makes you a match?",
      value: `My background in ${student.skills.slice(0, 4).join(", ")} closely matches the expectations in this job description.`
    }
  ];

  return fields.filter((field) => field.value.trim().length > 0);
}

function inferCountryFromPhone(phone: string | undefined) {
  const normalized = (phone ?? "").replace(/\s+/g, "");

  if (!normalized) {
    return undefined;
  }

  if (normalized.startsWith("+91")) {
    return "India";
  }

  if (normalized.startsWith("+1")) {
    return "United States";
  }

  if (normalized.startsWith("+44")) {
    return "United Kingdom";
  }

  if (normalized.startsWith("+61")) {
    return "Australia";
  }

  return undefined;
}

function inferCountryFromLocation(location: string | undefined) {
  const normalized = (location ?? "").toLowerCase();

  if (!normalized) {
    return undefined;
  }

  if (/\bindia|bengaluru|bangalore|chennai|hyderabad|mumbai|pune|delhi|gurgaon|noida\b/.test(normalized)) {
    return "India";
  }

  if (/\busa|united states|new york|san francisco|seattle|austin|boston\b/.test(normalized)) {
    return "United States";
  }

  if (/\buk|united kingdom|london|manchester\b/.test(normalized)) {
    return "United Kingdom";
  }

  return undefined;
}

function extractPhoneNumber(text?: string) {
  return text?.match(/(?:\+?\d[\s-]?){8,15}/)?.[0]?.replace(/\s+/g, " ").trim();
}

function extractUrl(text: string | undefined, pattern: RegExp) {
  const match = text?.match(pattern)?.[0];

  if (!match) {
    return undefined;
  }

  return match.startsWith("http") ? match : `https://${match}`;
}

function extractCompensation(text: string | undefined, pattern: RegExp) {
  const match = text?.match(pattern)?.[1]?.trim();
  return match?.slice(0, 40);
}

function buildApplicationTimeline(input: {
  mode: CreateApplicationInput["mode"];
  student: StudentProfile;
  job: Job;
  capabilities: AgentCapabilities;
  hasResume: boolean;
  packageResult?: StructuredApplicationPackageResult;
  packageError?: string;
  filledFieldsCount: number;
}): AgentTimelineStep[] {
  const browserCapability = input.capabilities.capabilities.find((capability) => capability.id === "browser_apply");
  const packageStepState = input.packageError ? "attention" : input.packageResult ? "done" : "running";
  const packageDetail = input.packageError
    ? `GradLaunch created the run trace, but writing the AIHawk-style package failed: ${input.packageError}`
    : input.packageResult
      ? `Saved ${input.packageResult.files.join(", ")} to ${input.packageResult.directory}.`
      : "Saving the structured application package to the workspace.";

  return [
    {
      id: "adapter",
      label: "AIHawk adapter checked",
      detail: input.capabilities.repoDetected
        ? browserCapability?.status === "unavailable"
          ? "Local AIHawk modules were detected, but the provider/apply engine is missing in this checkout."
          : "Local AIHawk modules were detected and the adapter is ready for guided execution."
        : "Local AIHawk repo was not detected, so GradLaunch is using its built-in fallback flow.",
      state: input.capabilities.repoDetected ? "done" : "attention",
      source: "aihawk"
    },
    {
      id: "profile",
      label: "Profile and resume loaded",
      detail: input.hasResume
        ? `Loaded student profile plus the latest uploaded resume for ${input.student.fullName}.`
        : `Loaded ${input.student.fullName}'s profile data. No uploaded resume was linked for this run.`,
      state: "done",
      source: "gradlaunch"
    },
    {
      id: "job",
      label: "Job normalized",
      detail: `Prepared ${input.job.title} at ${input.job.company} from the ${formatSource(input.job)} source.`,
      state: "done",
      source: "gradlaunch"
    },
    {
      id: "artifacts",
      label: input.mode === "autopilot" ? "Autopilot package generated" : input.mode === "autofill" ? "Review package generated" : "Draft package generated",
      detail: "Generated a tailored resume summary, a cover-letter excerpt, and reusable short-answer drafts.",
      state: "done",
      source: "gradlaunch"
    },
    {
      id: "fields",
      label: "Known fields prepared",
      detail: `Prepared ${input.filledFieldsCount} mapped values for the application form and review checklist.`,
      state: "done",
      source: "gradlaunch"
    },
    {
      id: "package",
      label: "Structured application package",
      detail: packageDetail,
      state: packageStepState,
      source: "gradlaunch"
    },
    {
      id: "review",
      label: input.mode === "autopilot" ? "Background agent launched" : input.mode === "autofill" ? "Review gate reached" : "Draft ready",
      detail: input.mode === "autopilot"
        ? browserCapability?.status === "unavailable"
          ? "GradLaunch queued the autopilot run, but the browser apply worker is unavailable and the application may still need manual follow-up."
          : "GradLaunch queued the autonomous browser run and will continue in the background until submit or a true protected checkpoint."
        : input.mode === "autofill"
          ? browserCapability?.status === "unavailable"
            ? "GradLaunch prepared the autofill data but stopped before browser submission because the local AIHawk checkout does not include the apply engine."
            : "GradLaunch prepared the autofill data and paused at the student review gate before final submission."
          : "The structured draft is ready to inspect, edit, and submit.",
      state: input.mode === "draft" ? "done" : input.mode === "autopilot" ? "running" : "attention",
      source: input.mode === "draft" ? "gradlaunch" : "aihawk"
    }
  ];
}

function buildRunNotes(input: {
  mode: CreateApplicationInput["mode"];
  capabilities: AgentCapabilities;
  resume?: ResumeRecord;
  packageResult?: StructuredApplicationPackageResult;
  packageError?: string;
}) {
  const browserCapability = input.capabilities.capabilities.find((capability) => capability.id === "browser_apply");
  const notes = [
    input.resume
      ? `Latest resume used: ${input.resume.filename}.`
      : "No uploaded resume was available. The run relied on profile data only."
  ];

  if (browserCapability?.status === "unavailable") {
    notes.push(
      input.mode === "autopilot"
        ? "Browser auto-apply is unavailable in this AIHawk checkout, so the background agent may stop before the full submit flow."
        : "Browser auto-apply is unavailable in this AIHawk checkout, so autofill stays review-first."
    );
  }

  if (input.packageResult) {
    notes.push(`Structured application package saved to ${input.packageResult.directory}.`);
  }

  if (input.packageError) {
    notes.push(`Structured application package failed to save: ${input.packageError}`);
  }

  if (input.mode === "draft") {
    notes.push("Draft mode does not attempt browser interaction.");
  }

  if (input.mode === "autopilot") {
    notes.push("Autopilot mode queued a background browser run that will attempt the full apply flow automatically.");
  }

  return notes;
}

function buildAutopilotFailureTimeline(job: Job, message: string, workspacePath?: string): AgentTimelineStep[] {
  return [
    {
      id: "launch",
      label: "Autopilot launched",
      detail: `Background execution started for ${job.title} at ${job.company}.`,
      state: "done",
      source: "gradlaunch"
    },
    {
      id: "browser",
      label: "Browser agent blocked",
      detail: message,
      state: "attention",
      source: "aihawk"
    },
    {
      id: "workspace",
      label: "Workspace preserved",
      detail: workspacePath
        ? `The latest application state is still available at ${workspacePath}.`
        : "GradLaunch preserved the latest known application state in the run trace.",
      state: "done",
      source: "gradlaunch"
    }
  ];
}

function formatSource(job: Job): string {
  switch (job.sourceType) {
    case "greenhouse":
      return "Greenhouse";
    case "lever":
      return "Lever";
    case "ashby":
      return "Ashby";
    case "aggregated_search":
      return "Search";
    default:
      return "Pasted URL";
  }
}
