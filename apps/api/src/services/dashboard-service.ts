import type { DashboardReport } from "@gradlaunch/shared";
import { ApplicationRepository } from "../repositories/application-repository";
import { JobRepository } from "../repositories/job-repository";

export class DashboardService {
  constructor(
    private readonly applications = new ApplicationRepository(),
    private readonly jobs = new JobRepository()
  ) {}

  async getReport(studentId: string): Promise<DashboardReport> {
    const applications = await this.applications.listByStudent(studentId);

    const metrics = [
      {
        label: "Applications started",
        value: applications.length,
        hint: "All drafts, autopilot runs, and browser sessions created for this student."
      },
      {
        label: "Agent running",
        value: applications.filter((item) => item.status === "queued" || item.status === "running").length,
        hint: "Applications currently being worked in the background."
      },
      {
        label: "Ready for review",
        value: applications.filter((item) => item.status === "ready_for_review").length,
        hint: "Applications waiting on student confirmation or a true manual checkpoint."
      },
      {
        label: "Draft ready",
        value: applications.filter((item) => item.status === "draft_ready").length,
        hint: "Draft packs ready without launching automation."
      },
      {
        label: "Needs retry",
        value: applications.filter((item) => item.status === "blocked" || item.status === "failed").length,
        hint: "Runs that were blocked or failed."
      }
    ];

    const recentApplications = await Promise.all(
      applications.map(async (application) => {
        const job = await this.jobs.getById(application.jobId);

        return {
          applicationId: application.id,
          company: job?.company ?? "Unknown company",
          role: job?.title ?? "Unknown role",
          source: application.sourceLabel,
          matchScore: application.matchScore,
          status: application.status,
          lastUpdatedAt: application.lastUpdatedAt
        };
      })
    );

    const pendingActions = (await Promise.all(
      applications
        .filter((item) => item.status === "queued" || item.status === "running" || item.status === "ready_for_review" || item.status === "blocked")
        .map(async (item) => {
          const job = await this.jobs.getById(item.jobId);
          if (item.status === "queued" || item.status === "running") {
            return `Autopilot is still working on ${job?.company ?? "the company"}.`;
          }

          return item.status === "ready_for_review"
            ? `Review application handoff for ${job?.company ?? "the company"}.`
            : `Retry blocked application for ${job?.company ?? "the company"}.`;
        })
    ));

    return {
      studentId,
      metrics,
      recentApplications,
      pendingActions
    };
  }
}
