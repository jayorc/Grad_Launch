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
    const [student, resume, applications] = await Promise.all([
      this.students.getById(studentId),
      this.resumes.getLatestByStudent(studentId),
      this.applications.listByStudent(studentId)
    ]);

    if (!student || applications.length === 0) {
      return applications;
    }

    const jobs = await Promise.all(applications.map((application) => this.jobs.getById(application.jobId)));
    const refreshedApplications = await Promise.all(applications.map(async (application, index) => {
      const job = jobs[index];

      if (!job) {
        return application;
      }

      const refreshed = refreshApplicationArtifactsIfNeeded(application, student, job, resume);

      if (refreshed !== application) {
        await this.applications.update(refreshed);
      }

      return refreshed;
    }));

    return refreshedApplications;
  }

  async fillJobInBrowser(input: { studentId: string; jobId: string; submit?: boolean }) {
    console.log("[GradLaunch][ApplicationService] fillJobInBrowser invoked", input);
    const [student, job, existingApplication, capabilities, resume, memory] = await Promise.all([
      this.students.getById(input.studentId),
      this.jobs.getById(input.jobId),
      this.applications.getByStudentAndJob(input.studentId, input.jobId),
      this.aihawk.getCapabilities(),
      this.resumes.getLatestByStudent(input.studentId),
      this.memory.get(input.studentId)
    ]);

    if (!student || !job) {
      throw new Error("Student or job not found.");
    }

    const now = nowIso();
    const recommendation = this.matching.scoreJob(student, job, student.defaultStrictness);
    const application: Application = existingApplication
      ? refreshApplicationArtifactsIfNeeded(existingApplication, student, job, resume)
      : {
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

    const preparationPackage = await this.aihawk.prepareWorkspaceDirectory({
      applicationId: application.id,
      job
    });
    console.log("[GradLaunch][ApplicationService] preparation package ready", {
      applicationId: application.id,
      directory: preparationPackage.directory
    });

    const browserReceipt = await this.aihawk.applyWithBrowser({
      job,
      fields,
      workspacePath: preparationPackage.directory,
      resume,
      student,
      memory,
      submit: input.submit === true,
      planner: existingRuns[0]?.planner
    });
    console.log("[GradLaunch][ApplicationService] browser receipt", {
      applicationId: application.id,
      status: browserReceipt.status,
      message: browserReceipt.message
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
    console.log("[GradLaunch][ApplicationService] final package ready", {
      applicationId: application.id,
      directory: finalPackage.directory,
      status: finalRun.status
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

    const [student, job, runs, resume, memory] = await Promise.all([
      this.students.getById(application.studentId),
      this.jobs.getById(application.jobId),
      this.applications.listRunsByApplication(application.id),
      this.resumes.getLatestByStudent(application.studentId),
      this.memory.get(application.studentId)
    ]);

    if (!student || !job) {
      throw new Error("Student or job not found.");
    }

    const latestRun = runs[0];
    const refreshedApplication = refreshApplicationArtifactsIfNeeded(application, student, job, resume);
    const browserCapability = capabilities.capabilities.find((capability) => capability.id === "browser_apply");
    const wantsAutoSubmit = input.intent === "auto_submit";
    const canAutoSubmit = wantsAutoSubmit && (browserCapability?.status === "available" || browserCapability?.status === "partial");
    const now = nowIso();
    const reviewedFields = normalizeReviewedFields(
      input.reviewedFields,
      latestRun?.filledFields ?? buildFilledFields(student, job, resume, refreshedApplication.generatedArtifacts)
    );
    const browserReceipt = canAutoSubmit
      ? await this.aihawk.applyWithBrowser({
          job,
          fields: reviewedFields,
          workspacePath: latestRun?.workspacePath,
          resume,
          student,
          memory,
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
      ...refreshedApplication,
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
      blockedReason: browserSubmitBlocked ? (browserReceipt?.message ?? "Browser auto-submit is unavailable in this checkout.") : undefined,
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
    const normalizedLabel = normalizeFieldKey(field.label);
    const generatedField = merged.get(normalizedLabel);

    if (shouldUsePrimaryFieldValue(field, generatedField)) {
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
    return input.browserReceipt?.message ?? "Auto-submit was blocked because the connected browser apply worker is unavailable.";
  }

  if (input.externalSubmitted && input.wantsAutoSubmit) {
    return input.browserReceipt?.message ?? "The browser agent completed the final submit step and GradLaunch recorded the receipt.";
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
      source: "gradlaunch"
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
  const plannerAction = input.planner?.lastDecision?.kind;
  const plannerActionReason = input.planner?.lastDecision?.reason;
  const stageCount = input.planner?.stageHistory.length ?? 0;

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
        ? plannerActionReason
          ? `${receipt.message} Planner action: ${plannerActionReason}`
          : receipt.message
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
        ? `${input.planner.summary} Form mode: ${input.planner.formMode}. Stages tracked: ${stageCount}. Last action: ${plannerAction ?? "none"}. Resume token: ${input.planner.resumeToken}.`
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
  const roleTarget = getPreferredRoleTarget(student, job);
  const preferredLocation = getPreferredLocation(student, job);
  const leadSkills = student.skills.slice(0, 4);
  const resumeSource = resume ? `Uploaded resume ${resume.filename} was used as the primary context.` : "No uploaded resume was available, so GradLaunch used the saved profile.";
  const coverLetterExcerpt = buildCoverLetterExcerpt(student, job, roleTarget, preferredLocation);

  return {
    tailoredResumeSummary: `${resumeSource} Focused ${leadSkills.join(", ")} to match the ${job.title} role at ${job.company}.`,
    coverLetterExcerpt,
    shortAnswers: [
      {
        question: "Why are you interested in this role?",
        answer: `This role aligns with my goal of becoming a strong ${roleTarget} and uses skills I have already practiced through projects and coursework.`
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
  const preferredLocation = getPreferredLocation(student, job);
  const city = preferredLocation.split(",")[0]?.trim() || preferredLocation;
  const phoneNumber = extractPhoneNumber(resume?.extractedText) ?? process.env.DEFAULT_STUDENT_PHONE;
  const country = process.env.DEFAULT_STUDENT_COUNTRY
    ?? inferCountryFromPhone(phoneNumber)
    ?? inferCountryFromLocation(preferredLocation)
    ?? "India";
  const roleTarget = getPreferredRoleTarget(student, job);
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
    { label: "Degree", value: sanitizeDegree(student.degree) ?? student.degree },
    { label: "Graduation year", value: sanitizeGraduationYear(student.graduationYear) },
    { label: "Preferred location", value: preferredLocation },
    { label: "Target role", value: roleTarget },
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
      value: `This role aligns with my goal of becoming a strong ${roleTarget} and uses skills I have practiced through projects and coursework.`
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
    ? `GradLaunch created the run trace, but writing the structured package failed: ${input.packageError}`
    : input.packageResult
      ? `Saved ${input.packageResult.files.join(", ")} to ${input.packageResult.directory}.`
      : "Saving the structured application package to the workspace.";

  return [
    {
      id: "adapter",
      label: "Browser runtime checked",
      detail: input.capabilities.repoDetected
        ? browserCapability?.status === "unavailable"
          ? "Local browser automation modules were detected, but the apply engine is missing in this checkout."
          : "Local browser automation modules were detected and the runtime is ready for guided execution."
        : "No local browser runtime was detected, so GradLaunch is using its built-in fallback flow.",
      state: input.capabilities.repoDetected ? "done" : "attention",
      source: "gradlaunch"
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
            ? "GradLaunch prepared the autofill data but stopped before browser submission because the local browser runtime does not include the apply engine."
            : "GradLaunch prepared the autofill data and paused at the student review gate before final submission."
          : "The structured draft is ready to inspect, edit, and submit.",
      state: input.mode === "draft" ? "done" : input.mode === "autopilot" ? "running" : "attention",
      source: "gradlaunch"
    }
  ];
}

function getPreferredRoleTarget(student: StudentProfile, job: Job) {
  const normalizedTargetRole = normalizeRoleLabel(student.targetRoles[0]);
  return normalizedTargetRole ?? normalizeRoleLabel(job.title) ?? "Software Engineer";
}

function getPreferredLocation(student: StudentProfile, job: Job) {
  const candidate = sanitizeLocationLabel(student.preferredLocations[0]);
  return candidate ?? sanitizeLocationLabel(job.location) ?? "India";
}

function normalizeRoleLabel(value: string | undefined) {
  const trimmed = value?.trim();

  if (!trimmed) {
    return undefined;
  }

  const compact = trimmed.replace(/\s+/g, " ");
  const lower = compact.toLowerCase();

  if (lower.length <= 2 || /^(a|an|sw|sde|dev|role)$/i.test(lower)) {
    return undefined;
  }

  if (/backend|back end|back-end/i.test(compact)) {
    return "Back-End Developer";
  }

  if (/frontend|front end|front-end/i.test(compact)) {
    return "Front-End Developer";
  }

  if (/full stack|full-stack/i.test(compact)) {
    return "Full-Stack Developer";
  }

  if (/software engineer|software developer/i.test(compact)) {
    return "Software Engineer";
  }

  return compact
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function sanitizeLocationLabel(value: string | undefined) {
  const trimmed = value?.trim();

  if (!trimmed) {
    return undefined;
  }

  const compact = trimmed.replace(/\s+/g, " ");
  const lower = compact.toLowerCase();

  if (lower.length <= 2 || /^(a|an|na|n a|none|unknown|city|location)$/i.test(lower)) {
    return undefined;
  }

  return compact;
}

function sanitizeDegree(value: string | undefined) {
  const trimmed = value?.trim();

  if (!trimmed) {
    return undefined;
  }

  return trimmed.replace(/\s+/g, " ").replace(/cgpa[:\s-]*[0-9.]+/i, "").trim();
}

function sanitizeGraduationYear(value: number | undefined) {
  if (!value) {
    return "";
  }

  const currentYear = new Date().getUTCFullYear();

  if (value < 2015 || value > currentYear + 6) {
    return "";
  }

  return String(value);
}

function buildCoverLetterExcerpt(student: StudentProfile, job: Job, roleTarget: string, preferredLocation: string) {
  const skillList = student.skills.filter(Boolean).slice(0, 3);
  const skillsText = skillList.length > 0 ? skillList.join(", ") : "modern software development";
  const workModeText = job.workMode === "remote"
    ? "remote collaboration"
    : job.workMode === "hybrid"
      ? "hybrid product teams"
      : "onsite engineering environments";

  return [
    `I am excited to apply for the ${job.title} role at ${job.company}.`,
    `My background in ${skillsText} and my focus on becoming a strong ${roleTarget} make this opportunity especially compelling to me.`,
    `I would be glad to contribute to ${job.company}'s team with a practical, detail-oriented approach to building reliable backend systems and supporting product delivery in ${workModeText}.`,
    `With my academic foundation and hands-on project work, I am confident I can add value while continuing to grow in a role aligned with ${preferredLocation} opportunities.`
  ].join(" ");
}

function shouldUsePrimaryFieldValue(
  primaryField: ApplicationRun["filledFields"][number],
  generatedField: ApplicationRun["filledFields"][number] | undefined
) {
  const primaryValue = primaryField.value.trim();

  if (!primaryValue) {
    return false;
  }

  if (!generatedField) {
    return true;
  }

  const labelKey = normalizeFieldKey(primaryField.label);
  const generatedValue = generatedField.value.trim();

  if (isWeakFieldValue(labelKey, primaryValue) && !isWeakFieldValue(labelKey, generatedValue)) {
    return false;
  }

  return true;
}

function isWeakFieldValue(labelKey: string, value: string) {
  const normalized = value.trim().toLowerCase();

  if (!normalized) {
    return true;
  }

  if (["a", "an", "na", "n a", "none", "unknown"].includes(normalized)) {
    return true;
  }

  if (labelKey === "target role") {
    return normalizeRoleLabel(value) === undefined;
  }

  if (labelKey === "preferred location" || labelKey === "location" || labelKey === "location city" || labelKey === "city") {
    return sanitizeLocationLabel(value) === undefined;
  }

  if (labelKey === "message to the hiring team" || labelKey === "why are you interested in this role") {
    return /\baspiring\s+(a|an|sw|sde|dev)\b/i.test(value) || /\bbecoming a a\b/i.test(value);
  }

  return false;
}

function refreshApplicationArtifactsIfNeeded(
  application: Application,
  student: StudentProfile,
  job: Job,
  resume?: ResumeRecord
) {
  const nextArtifacts = createArtifacts(student, job, resume);
  const nextUploadedDocuments = createUploadedDocumentList(resume);

  if (!shouldRefreshGeneratedArtifacts(application.generatedArtifacts, nextArtifacts) && sameDocuments(application.uploadedDocuments, nextUploadedDocuments)) {
    return application;
  }

  return {
    ...application,
    generatedArtifacts: shouldRefreshGeneratedArtifacts(application.generatedArtifacts, nextArtifacts)
      ? nextArtifacts
      : application.generatedArtifacts,
    uploadedDocuments: nextUploadedDocuments,
    lastUpdatedAt: nowIso()
  };
}

function shouldRefreshGeneratedArtifacts(current: Application["generatedArtifacts"], next: Application["generatedArtifacts"]) {
  const coverLetter = current.coverLetterExcerpt.trim();
  const shortAnswer = current.shortAnswers[0]?.answer?.trim() ?? "";

  if (!coverLetter) {
    return true;
  }

  if (
    coverLetter.includes("where I can bring my")
    || /\baspiring\s+(a|an|sw|sde|dev)\b/i.test(coverLetter)
    || coverLetter.split(/[.!?]+/).filter(Boolean).length < 3
  ) {
    return true;
  }

  if (/\b(becoming a|becoming an)\s+(a|an|sw|sde|dev)\b/i.test(shortAnswer)) {
    return true;
  }

  return false;
}

function sameDocuments(left: string[], right: string[]) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((item, index) => item === right[index]);
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
        ? "Browser auto-apply is unavailable in this browser runtime, so the background agent may stop before the full submit flow."
        : "Browser auto-apply is unavailable in this browser runtime, so autofill stays review-first."
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
      source: "gradlaunch"
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
