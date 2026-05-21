import type { Job } from "@gradlaunch/shared";
import { isMemoryMode } from "../lib/data-mode";
import { JobModel } from "../models/job-model";
import { db } from "./in-memory-db";

export class JobRepository {
  async list(): Promise<Job[]> {
    if (isMemoryMode()) {
      return [...db.jobs].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    }

    const jobs = await JobModel.find().sort({ createdAt: -1 }).lean();
    return jobs.map((job) => mapJob(job as Record<string, unknown>));
  }

  async getById(jobId: string): Promise<Job | undefined> {
    if (isMemoryMode()) {
      return db.jobs.find((job) => job.id === jobId);
    }

    const job = await JobModel.findOne({ id: jobId }).lean();
    return job ? mapJob(job as Record<string, unknown>) : undefined;
  }

  async save(job: Job): Promise<Job> {
    if (isMemoryMode()) {
      const existingIndex = db.jobs.findIndex((item) => item.sourceUrl === job.sourceUrl);

      if (existingIndex >= 0) {
        db.jobs[existingIndex] = job;
      } else {
        db.jobs.push(job);
      }

      return job;
    }

    await JobModel.findOneAndUpdate(
      { sourceUrl: job.sourceUrl },
      { $set: job },
      { new: true, upsert: true }
    );

    return job;
  }
}

function mapJob(job: Record<string, unknown>): Job {
  return {
    id: String(job.id),
    title: String(job.title),
    company: String(job.company),
    location: String(job.location),
    workMode: String(job.workMode) as Job["workMode"],
    minExperience: Number(job.minExperience),
    maxExperience: Number(job.maxExperience),
    degreeRequirements: Array.isArray(job.degreeRequirements) ? job.degreeRequirements.map(String) : [],
    skills: Array.isArray(job.skills) ? job.skills.map(String) : [],
    description: String(job.description),
    sourceType: String(job.sourceType) as Job["sourceType"],
    sourceUrl: String(job.sourceUrl),
    createdAt: String(job.createdAt)
  };
}
