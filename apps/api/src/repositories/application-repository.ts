import type { Application, ApplicationRun } from "@gradlaunch/shared";
import { isMemoryMode } from "../lib/data-mode";
import { ApplicationModel } from "../models/application-model";
import { ApplicationRunModel } from "../models/application-run-model";
import { db } from "./in-memory-db";

export class ApplicationRepository {
  async create(application: Application): Promise<Application> {
    if (isMemoryMode()) {
      db.applications.push(application);
      return application;
    }

    await ApplicationModel.create(application);
    return application;
  }

  async createRun(run: ApplicationRun): Promise<ApplicationRun> {
    if (isMemoryMode()) {
      db.applicationRuns.push(run);
      return run;
    }

    await ApplicationRunModel.create(run);
    return run;
  }

  async update(application: Application): Promise<Application> {
    if (isMemoryMode()) {
      const index = db.applications.findIndex((item) => item.id === application.id);

      if (index === -1) {
        throw new Error("Application not found.");
      }

      db.applications[index] = application;
      return application;
    }

    const updatedApplication = await ApplicationModel.findOneAndUpdate(
      { id: application.id },
      { $set: application },
      { new: true }
    ).lean();

    if (!updatedApplication) {
      throw new Error("Application not found.");
    }

    return mapApplication(updatedApplication as Record<string, unknown>);
  }

  async listByStudent(studentId: string): Promise<Application[]> {
    if (isMemoryMode()) {
      return db.applications
        .filter((application) => application.studentId === studentId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    }

    const applications = await ApplicationModel.find({ studentId }).sort({ createdAt: -1 }).lean();
    return applications.map((application) => mapApplication(application as Record<string, unknown>));
  }

  async getById(applicationId: string): Promise<Application | undefined> {
    if (isMemoryMode()) {
      return db.applications.find((application) => application.id === applicationId);
    }

    const application = await ApplicationModel.findOne({ id: applicationId }).lean();
    return application ? mapApplication(application as Record<string, unknown>) : undefined;
  }

  async getByStudentAndJob(studentId: string, jobId: string): Promise<Application | undefined> {
    if (isMemoryMode()) {
      return db.applications.find((application) => application.studentId === studentId && application.jobId === jobId);
    }

    const application = await ApplicationModel.findOne({ studentId, jobId }).lean();
    return application ? mapApplication(application as Record<string, unknown>) : undefined;
  }

  async listRunsByApplication(applicationId: string): Promise<ApplicationRun[]> {
    if (isMemoryMode()) {
      return db.applicationRuns
        .filter((run) => run.applicationId === applicationId)
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    }

    const runs = await ApplicationRunModel.find({ applicationId }).sort({ createdAt: -1 }).lean();
    return runs.map((run) => ({
      id: String(run.id),
      applicationId: String(run.applicationId),
      status: String(run.status) as ApplicationRun["status"],
      startedAt: String(run.startedAt),
      completedAt: typeof run.completedAt === "string" ? run.completedAt : undefined,
      adapterId: String(run.adapterId),
      executionMode: String(run.executionMode) as ApplicationRun["executionMode"],
      workspacePath: typeof run.workspacePath === "string" ? run.workspacePath : undefined,
      workspaceFiles: Array.isArray(run.workspaceFiles) ? run.workspaceFiles.map(String) : [],
      screenshots: Array.isArray(run.screenshots) ? run.screenshots.map(String) : [],
      blockedReason: typeof run.blockedReason === "string" ? run.blockedReason : undefined,
      filledFields: Array.isArray(run.filledFields)
        ? run.filledFields.map((field) => ({ label: String(field.label), value: String(field.value) }))
        : [],
      timeline: Array.isArray(run.timeline)
        ? run.timeline.map((step) => ({
            id: String(step.id),
            label: String(step.label),
            detail: String(step.detail),
            state: String(step.state) as ApplicationRun["timeline"][number]["state"],
            source: String(step.source) as ApplicationRun["timeline"][number]["source"],
            timestamp: typeof step.timestamp === "string" ? step.timestamp : undefined
          }))
        : [],
      notes: Array.isArray(run.notes) ? run.notes.map(String) : [],
      planner: mapPlanner(run.planner as Record<string, unknown> | undefined),
      submission: mapSubmission(run.submission as Record<string, unknown> | undefined)
    }));
  }
}

type StoredSubmission = NonNullable<ApplicationRun["submission"]>;

function mapSubmission(submission: Record<string, unknown> | undefined): ApplicationRun["submission"] {
  if (!submission) {
    return undefined;
  }

  const email = submission.email as Record<string, unknown> | undefined;

  if (!email) {
    return undefined;
  }

  return {
    intent: String(submission.intent) as StoredSubmission["intent"],
    outcome: String(submission.outcome) as StoredSubmission["outcome"],
    externalSubmitted: Boolean(submission.externalSubmitted),
    confirmation: String(submission.confirmation ?? ""),
    submittedAt: String(submission.submittedAt ?? ""),
    email: {
      status: String(email.status) as StoredSubmission["email"]["status"],
      provider: String(email.provider) as StoredSubmission["email"]["provider"],
      to: String(email.to ?? ""),
      subject: String(email.subject ?? ""),
      sentAt: typeof email.sentAt === "string" ? email.sentAt : undefined,
      message: typeof email.message === "string" ? email.message : undefined
    },
    browser: mapBrowserReceipt(submission.browser as Record<string, unknown> | undefined)
  };
}

function mapBrowserReceipt(browser: Record<string, unknown> | undefined): StoredSubmission["browser"] {
  if (!browser) {
    return undefined;
  }

  return {
    status: String(browser.status) as NonNullable<StoredSubmission["browser"]>["status"],
    sourceUrl: String(browser.sourceUrl ?? ""),
    openedAt: String(browser.openedAt ?? ""),
    completedAt: String(browser.completedAt ?? ""),
    filledLabels: Array.isArray(browser.filledLabels) ? browser.filledLabels.map(String) : [],
    skippedLabels: Array.isArray(browser.skippedLabels) ? browser.skippedLabels.map(String) : [],
    screenshots: Array.isArray(browser.screenshots) ? browser.screenshots.map(String) : [],
    message: String(browser.message ?? ""),
    planner: mapPlanner(browser.planner as Record<string, unknown> | undefined)
  };
}

function mapPlanner(planner: Record<string, unknown> | undefined): ApplicationRun["planner"] {
  if (!planner) {
    return undefined;
  }

  return {
    sessionId: String(planner.sessionId ?? ""),
    resumeToken: String(planner.resumeToken ?? ""),
    goal: String(planner.goal ?? ""),
    status: String(planner.status ?? "idle") as NonNullable<ApplicationRun["planner"]>["status"],
    summary: String(planner.summary ?? ""),
    currentStep: typeof planner.currentStep === "string" ? planner.currentStep : undefined,
    currentStageLabel: typeof planner.currentStageLabel === "string" ? planner.currentStageLabel : undefined,
    currentUrl: typeof planner.currentUrl === "string" ? planner.currentUrl : undefined,
    retryCount: Number(planner.retryCount ?? 0),
    handoffCount: Number(planner.handoffCount ?? 0),
    validationErrors: Array.isArray(planner.validationErrors) ? planner.validationErrors.map(String) : [],
    subgoals: Array.isArray(planner.subgoals)
      ? planner.subgoals.map((task) => {
          const nextTask = task as Record<string, unknown>;
          return {
            id: String(nextTask.id ?? ""),
            label: String(nextTask.label ?? ""),
            status: String(nextTask.status ?? "pending") as NonNullable<ApplicationRun["planner"]>["subgoals"][number]["status"],
            detail: String(nextTask.detail ?? ""),
            attempts: Number(nextTask.attempts ?? 0),
            lastUpdatedAt: String(nextTask.lastUpdatedAt ?? ""),
            completedAt: typeof nextTask.completedAt === "string" ? nextTask.completedAt : undefined
          };
        })
      : [],
    lastUpdatedAt: String(planner.lastUpdatedAt ?? "")
  };
}

function mapApplication(application: Record<string, unknown>): Application {
  const generatedArtifacts = application.generatedArtifacts as Record<string, unknown> | undefined;
  const shortAnswers = Array.isArray(generatedArtifacts?.shortAnswers)
    ? generatedArtifacts?.shortAnswers.map((item) => {
        const answer = item as Record<string, unknown>;
        return {
          question: String(answer.question),
          answer: String(answer.answer)
        };
      })
    : [];

  return {
    id: String(application.id),
    studentId: String(application.studentId),
    jobId: String(application.jobId),
    status: String(application.status) as Application["status"],
    sourceLabel: String(application.sourceLabel),
    matchScore: Number(application.matchScore),
    generatedArtifacts: {
      tailoredResumeSummary: String(generatedArtifacts?.tailoredResumeSummary ?? ""),
      coverLetterExcerpt: String(generatedArtifacts?.coverLetterExcerpt ?? ""),
      shortAnswers
    },
    uploadedDocuments: Array.isArray(application.uploadedDocuments) ? application.uploadedDocuments.map(String) : [],
    lastUpdatedAt: String(application.lastUpdatedAt),
    createdAt: String(application.createdAt)
  };
}
