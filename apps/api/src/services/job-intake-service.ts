import type { IntakeJobUrlInput, Job } from "@gradlaunch/shared";
import { JobRepository } from "../repositories/job-repository";
import { StudentRepository } from "../repositories/student-repository";
import { createId } from "../lib/id";
import { nowIso } from "../lib/time";
import { LiveJobSearchService } from "./live-job-search-service";

export class JobIntakeService {
  constructor(
    private readonly students = new StudentRepository(),
    private readonly jobs = new JobRepository(),
    private readonly liveSearch = new LiveJobSearchService()
  ) {}

  async intakeFromUrl(input: IntakeJobUrlInput): Promise<Job> {
    const student = await this.students.getById(input.studentId);

    if (!student) {
      throw new Error("Student not found.");
    }

    let parsed: URL;

    try {
      parsed = new URL(input.jobUrl);
    } catch (_error) {
      throw new Error("Please provide a valid job URL.");
    }

    if (parsed.hostname === "search.gradlaunch.local") {
      throw new Error("This is an old generated demo URL. Paste the real company job page URL or run a fresh live search.");
    }

    try {
      const job = await this.liveSearch.fetchDirectJobUrl(input.jobUrl);
      return this.jobs.save(job);
    } catch (_error) {
      return this.jobs.save(createFallbackJobFromUrl(parsed, student));
    }
  }
}

function createFallbackJobFromUrl(parsed: URL, student: Awaited<ReturnType<StudentRepository["getById"]>>): Job {
  const slug = parsed.pathname.split("/").filter(Boolean).at(-1) ?? "job-opening";
  const title = titleCase(slug.replace(/[-_]/g, " "));
  const company = titleCase(parsed.hostname.replace(/^www\./, "").split(".")[0] ?? "Company");

  return {
    id: createId("job"),
    title: title || student?.targetRoles[0] || "Job Opening",
    company,
    location: student?.preferredLocations[0] ?? "Remote",
    workMode: student?.workModes[0] ?? "remote",
    minExperience: 0,
    maxExperience: 2,
    degreeRequirements: ["B.Tech", "B.E.", "BCA"],
    skills: student?.skills.slice(0, 6) ?? ["JavaScript", "Communication"],
    description: "Saved from the exact URL provided by the student. GradLaunch will open this URL directly in Chrome for guided filling.",
    sourceType: parsed.hostname.includes("greenhouse")
      ? "greenhouse"
      : parsed.hostname.includes("lever")
        ? "lever"
        : parsed.hostname.includes("ashby")
          ? "ashby"
          : "manual_url",
    sourceUrl: parsed.toString(),
    createdAt: nowIso()
  };
}

function titleCase(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
