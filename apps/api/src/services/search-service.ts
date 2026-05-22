import type { AgentTimelineStep, SearchSession, SearchSessionResult, StartSearchSessionInput, StudentProfile } from "@gradlaunch/shared";
import { JobRepository } from "../repositories/job-repository";
import { SearchSessionRepository } from "../repositories/search-session-repository";
import { StudentRepository } from "../repositories/student-repository";
import { nowIso } from "../lib/time";
import { AIHawkAdapterService } from "./aihawk-adapter-service";
import { LiveJobSearchService } from "./live-job-search-service";
import { MatchingService } from "./matching-service";
import { createId } from "../lib/id";

export class SearchService {
  constructor(
    private readonly students = new StudentRepository(),
    private readonly jobs = new JobRepository(),
    private readonly sessions = new SearchSessionRepository(),
    private readonly matching = new MatchingService(),
    private readonly aihawk = new AIHawkAdapterService(),
    private readonly liveSearch = new LiveJobSearchService()
  ) {}

  async startSession(input: StartSearchSessionInput): Promise<SearchSessionResult> {
    const student = await this.students.getById(input.studentId);

    if (!student) {
      throw new Error("Student not found.");
    }

    const capabilities = await this.aihawk.getCapabilities();
    const liveResult = await this.liveSearch.searchForStudent(student);
    await Promise.all(liveResult.jobs.map((job) => this.jobs.save(job)));

    const recommendations = this.matching.filterRecommended(student, liveResult.jobs, input.strictness);
    const resultJobIds = recommendations.map((item) => item.job.id);
    const startedAt = nowIso();

    const session: SearchSession = {
      id: createId("session"),
      studentId: input.studentId,
      durationMinutes: input.durationMinutes,
      strictness: input.strictness,
      startedAt,
      completedAt: startedAt,
      resultJobIds,
      summary: `Fetched ${liveResult.jobs.length} live openings from ${liveResult.sources.length} sources and shortlisted ${recommendations.length} jobs for ${input.strictness} matching.`
    };

    await this.sessions.create(session);

    return {
      session,
      recommendations,
      activity: buildSearchTimeline({
        student,
        capabilities,
        totalJobs: liveResult.jobs.length,
        sourceResults: liveResult.sources,
        strictness: input.strictness,
        recommendations: recommendations.length,
        durationMinutes: input.durationMinutes
      }),
      capabilities
    };
  }
}

function buildSearchTimeline(input: {
  student: StudentProfile;
  capabilities: SearchSessionResult["capabilities"];
  totalJobs: number;
  sourceResults: Array<{ label: string; status: "done" | "attention"; detail: string; count: number }>;
  strictness: StartSearchSessionInput["strictness"];
  recommendations: number;
  durationMinutes: number;
}): AgentTimelineStep[] {
  const browserCapability = input.capabilities.capabilities.find((capability) => capability.id === "browser_apply");

  return [
    {
      id: "adapter",
      label: "Browser runtime checked",
      detail: input.capabilities.repoDetected
        ? browserCapability?.status === "unavailable"
          ? "Local browser automation modules were detected, but search is running in GradLaunch mode because browser/apply plugins are missing."
          : "Local browser automation modules were detected and the runtime is available for downstream draft flows."
        : "No local browser runtime was detected, so the search session is running entirely on GradLaunch services.",
      state: input.capabilities.repoDetected ? "done" : "attention",
      source: "gradlaunch"
    },
    {
      id: "profile",
      label: "Student context loaded",
      detail: `Loaded ${input.student.fullName}'s target roles, preferred locations, work modes, and skills for this ${input.durationMinutes}-minute run.`,
      state: "done",
      source: "gradlaunch"
    },
    {
      id: "sources",
      label: "Live job sources fetched",
      detail: buildSourceDetail(input.sourceResults, input.totalJobs),
      state: input.totalJobs > 0 ? "done" : "attention",
      source: "gradlaunch"
    },
    {
      id: "ranking",
      label: "Matching threshold applied",
      detail: `${input.strictness} matching kept ${input.recommendations} jobs above the recommendation threshold.`,
      state: "done",
      source: "gradlaunch"
    },
    {
      id: "queue",
      label: "Review queue prepared",
      detail: input.recommendations > 0
        ? "Recommended jobs are ready for draft or guided autofill review."
        : "No jobs cleared the threshold in this run. Try a broader search or import a job URL.",
      state: input.recommendations > 0 ? "done" : "attention",
      source: "gradlaunch"
    }
  ];
}

function buildSourceDetail(sourceResults: Array<{ label: string; status: "done" | "attention"; detail: string; count: number }>, totalJobs: number) {
  if (sourceResults.length === 0) {
    return "No live sources are configured yet. Add LIVE_GREENHOUSE_BOARDS, LIVE_LEVER_COMPANIES, or LIVE_JOB_URLS in .env.";
  }

  const successfulSources = sourceResults.filter((source) => source.count > 0);
  const attentionSources = sourceResults.filter((source) => source.status === "attention");

  if (totalJobs === 0) {
    return attentionSources[0]?.detail ?? "Live sources responded, but no current openings were found for this profile.";
  }

  return `${successfulSources.map((source) => `${source.label}: ${source.count}`).join(" • ")}. Total live openings: ${totalJobs}.`;
}
