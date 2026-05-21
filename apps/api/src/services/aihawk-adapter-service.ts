import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentCapabilities, Application, ApplicationRun, BrowserApplyReceipt, FilledField, Job, PlannerCheckpoint, ResumeRecord, StudentProfile } from "@gradlaunch/shared";
import { getApplicationArtifactStorageDir } from "../config/storage";
import { BrowserApplyService } from "./browser-apply-service";

type StructuredApplicationPackageInput = {
  application: Application;
  run: ApplicationRun;
  job: Job;
  student: StudentProfile;
  resume?: ResumeRecord;
};

export type StructuredApplicationPackageResult = {
  directory: string;
  files: string[];
};

const currentDir = dirname(fileURLToPath(import.meta.url));
const defaultAIHawkRepoPath = resolve(currentDir, "../../../../../Jobs_Applier_AI_Agent_AIHawk");

export class AIHawkAdapterService {
  constructor(private readonly browserApply = new BrowserApplyService()) {}

  async getCapabilities(): Promise<AgentCapabilities> {
    const repoPath = resolveAIHawkRepoPath();
    const repoDetected = await pathExists(repoPath);
    const pythonAvailable = hasCommand("python3") || hasCommand("python");
    const browserAvailability = await this.browserApply.getAvailability();

    if (!repoDetected) {
      return {
        adapterId: "aihawk-local",
        adapterLabel: "AIHawk Local Adapter",
        repoDetected: false,
        repoPath,
        pythonAvailable,
        capabilities: [
          {
            id: "local_repo",
            label: "Local AIHawk checkout",
            status: "unavailable",
            source: "aihawk",
            detail: "The AIHawk repository was not found at the configured path."
          },
          {
            id: "structured_package",
            label: "Structured application package",
            status: "available",
            source: "gradlaunch",
            detail: "GradLaunch can still save AIHawk-style application packages for each run."
          },
          {
            id: "browser_apply",
            label: "Browser autofill worker",
            status: browserAvailability.available ? "partial" : "unavailable",
            source: "aihawk",
            detail: browserAvailability.available
              ? "GradLaunch can launch Chrome and use AIHawk-style workspace packages for browser autofill."
              : browserAvailability.message
          }
        ],
        limitations: [
          "GradLaunch is running its built-in matching and drafting flow because the local AIHawk checkout was not detected.",
          "Autofill remains review-first until a real browser apply worker is connected."
        ]
      };
    }

    const mainPyPath = join(repoPath, "main.py");
    const resumeFacadePath = join(repoPath, "src", "libs", "resume_and_cover_builder", "resume_facade.py");
    const resumeGeneratorPath = join(repoPath, "src", "libs", "resume_and_cover_builder", "resume_generator.py");
    const jobParserPath = join(repoPath, "src", "libs", "resume_and_cover_builder", "llm", "llm_job_parser.py");
    const jobApplicationPath = join(repoPath, "src", "job_application.py");

    const [mainSource, hasResumeFacade, hasResumeGenerator, hasJobParser, hasJobApplication] =
      await Promise.all([
        safeReadFile(mainPyPath),
        pathExists(resumeFacadePath),
        pathExists(resumeGeneratorPath),
        pathExists(jobParserPath),
        pathExists(jobApplicationPath)
      ]);

    const providerImportsCommented =
      mainSource.includes("# from ai_hawk.bot_facade") ||
      mainSource.includes("# from ai_hawk.job_manager") ||
      mainSource.includes("# from ai_hawk.llm.llm_manager");

    const browserApplyReady = browserAvailability.available;
    const limitations: string[] = [];

    if (providerImportsCommented || !hasJobApplication) {
      limitations.push(
        "This AIHawk checkout does not include provider-specific apply plugins, so GradLaunch uses its generic Chrome autofill worker and blocks when a portal needs human action."
      );
    }

    if (!browserApplyReady) {
      limitations.push(browserAvailability.message);
    }

    if (!pythonAvailable) {
      limitations.push("Python is not available in the runtime, so local AIHawk scripts cannot be executed from the API.");
    }

    limitations.push(
      "Resume and cover-letter modules exist locally, but this build only exposes capability detection plus GradLaunch packaging, not full AIHawk script execution."
    );

    return {
      adapterId: "aihawk-local",
      adapterLabel: "AIHawk Local Adapter",
      repoDetected: true,
      repoPath,
      pythonAvailable,
      capabilities: [
        {
          id: "local_repo",
          label: "Local AIHawk checkout",
          status: "available",
          source: "aihawk",
          detail: "GradLaunch detected the local AIHawk repository and can inspect its available modules."
        },
        {
          id: "resume_tailoring",
          label: "Resume tailoring modules",
          status: hasResumeFacade && hasResumeGenerator ? "partial" : "unavailable",
          source: "aihawk",
          detail:
            hasResumeFacade && hasResumeGenerator
              ? "Resume and cover-letter generation modules exist in the AIHawk repo, but they are not yet executed automatically from GradLaunch."
              : "The resume tailoring modules were not fully detected in the AIHawk repo."
        },
        {
          id: "job_page_parse",
          label: "Job page fetch and parse",
          status: hasJobParser ? "partial" : "unavailable",
          source: "aihawk",
          detail: hasJobParser
            ? "AIHawk job parsing code is present locally, but GradLaunch is not yet running it as a production ingestion worker."
            : "The AIHawk job parsing module was not found."
        },
        {
          id: "structured_package",
          label: "Structured application package",
          status: "available",
          source: "gradlaunch",
          detail: "GradLaunch saves AIHawk-style application packages and run traces for every application flow."
        },
        {
          id: "browser_apply",
          label: "Browser autofill worker",
          status: browserApplyReady ? "partial" : "unavailable",
          source: "gradlaunch",
          detail: browserApplyReady
            ? `${browserAvailability.message} Provider-specific AIHawk plugins are still absent, so complex portals may pause for manual review.`
            : browserAvailability.message
        }
      ],
      limitations
    };
  }

  async applyWithBrowser(input: {
    job: Job;
    fields: FilledField[];
    workspacePath?: string;
    resume?: ResumeRecord;
    submit: boolean;
    planner?: PlannerCheckpoint;
  }): Promise<BrowserApplyReceipt> {
    return this.browserApply.apply(input);
  }

  async createStructuredApplicationPackage(
    input: StructuredApplicationPackageInput
  ): Promise<StructuredApplicationPackageResult> {
    const packageDir = join(
      getApplicationArtifactStorageDir(),
      `${input.application.id}-${slugify(input.job.company)}-${slugify(input.job.title)}`
    );

    await mkdir(packageDir, { recursive: true });

    const files: string[] = [];

    await writeJson(join(packageDir, "job_application.json"), {
      applicationId: input.application.id,
      studentId: input.application.studentId,
      jobId: input.application.jobId,
      status: input.application.status,
      sourceLabel: input.application.sourceLabel,
      matchScore: input.application.matchScore,
      generatedArtifacts: input.application.generatedArtifacts,
      uploadedDocuments: input.application.uploadedDocuments,
      run: {
        id: input.run.id,
        status: input.run.status,
        executionMode: input.run.executionMode,
        filledFields: input.run.filledFields,
        submission: input.run.submission,
        notes: input.run.notes
      },
      createdAt: input.application.createdAt,
      updatedAt: input.application.lastUpdatedAt
    });
    files.push("job_application.json");

    await writeJson(join(packageDir, "job_description.json"), input.job);
    files.push("job_description.json");

    await writeJson(join(packageDir, "student_profile_snapshot.json"), {
      id: input.student.id,
      fullName: input.student.fullName,
      email: input.student.email,
      degree: input.student.degree,
      graduationYear: input.student.graduationYear,
      targetRoles: input.student.targetRoles,
      preferredLocations: input.student.preferredLocations,
      workModes: input.student.workModes,
      skills: input.student.skills,
      automationMode: input.student.automationMode,
      defaultStrictness: input.student.defaultStrictness
    });
    files.push("student_profile_snapshot.json");

    await writeJson(join(packageDir, "run_trace.json"), {
      id: input.run.id,
      status: input.run.status,
      executionMode: input.run.executionMode,
      adapterId: input.run.adapterId,
      startedAt: input.run.startedAt,
      completedAt: input.run.completedAt,
      blockedReason: input.run.blockedReason,
      filledFields: input.run.filledFields,
      timeline: input.run.timeline,
      planner: input.run.planner,
      notes: input.run.notes,
      submission: input.run.submission,
      screenshots: input.run.screenshots
    });
    files.push("run_trace.json");

    await writeJson(join(packageDir, "reviewed_fields.json"), input.run.filledFields);
    files.push("reviewed_fields.json");

    if (input.run.planner) {
      await writeJson(join(packageDir, "planner_checkpoint.json"), input.run.planner);
      files.push("planner_checkpoint.json");
    }

    if (input.run.submission) {
      await writeJson(join(packageDir, "submission_receipt.json"), input.run.submission);
      files.push("submission_receipt.json");
    }

    await writeJson(join(packageDir, "short_answers.json"), input.application.generatedArtifacts.shortAnswers);
    files.push("short_answers.json");

    await writeFile(
      join(packageDir, "tailored_resume_summary.txt"),
      `${input.application.generatedArtifacts.tailoredResumeSummary}\n`,
      "utf-8"
    );
    files.push("tailored_resume_summary.txt");

    await writeFile(
      join(packageDir, "cover_letter_excerpt.txt"),
      `${input.application.generatedArtifacts.coverLetterExcerpt}\n`,
      "utf-8"
    );
    files.push("cover_letter_excerpt.txt");

    await writeFile(
      join(packageDir, "README.txt"),
      [
        "GradLaunch application package",
        "",
        "This folder follows the structured application saver concept used by AIHawk.",
        "It keeps the normalized job, profile snapshot, generated answers, and the run trace together.",
        "",
        "Files:",
        "- job_application.json",
        "- job_description.json",
        "- student_profile_snapshot.json",
        "- run_trace.json",
        "- reviewed_fields.json",
        input.run.submission ? "- submission_receipt.json" : undefined,
        "- short_answers.json"
      ].filter(Boolean).join("\n"),
      "utf-8"
    );
    files.push("README.txt");

    if (input.resume && (await pathExists(input.resume.storagePath))) {
      const resumeFilename = sanitizeFilename(input.resume.filename);
      await copyFile(input.resume.storagePath, join(packageDir, resumeFilename));
      files.push(resumeFilename);
    }

    for (const screenshot of input.run.screenshots) {
      if ((await pathExists(join(packageDir, screenshot))) && !files.includes(screenshot)) {
        files.push(screenshot);
      }
    }

    return {
      directory: packageDir,
      files
    };
  }
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function pathExists(path: string) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch (_error) {
    return false;
  }
}

function hasCommand(command: string) {
  const result = spawnSync(command, ["--version"], { encoding: "utf-8" });
  return result.status === 0;
}

function resolveAIHawkRepoPath() {
  return process.env.AIHAWK_REPO_PATH
    ? resolve(process.env.AIHAWK_REPO_PATH)
    : defaultAIHawkRepoPath;
}

async function safeReadFile(path: string) {
  try {
    return await readFile(path, "utf-8");
  } catch (_error) {
    return "";
  }
}

function sanitizeFilename(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
