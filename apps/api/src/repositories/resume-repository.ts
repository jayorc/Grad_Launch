import type { ResumeRecord } from "@gradlaunch/shared";
import { isMemoryMode } from "../lib/data-mode";
import { ResumeModel } from "../models/resume-model";
import { db } from "./in-memory-db";

export class ResumeRepository {
  async create(resume: ResumeRecord): Promise<ResumeRecord> {
    if (isMemoryMode()) {
      db.resumes.push(resume);
      return resume;
    }

    await ResumeModel.create(resume);
    return resume;
  }

  async getLatestByStudent(studentId: string): Promise<ResumeRecord | undefined> {
    if (isMemoryMode()) {
      return [...db.resumes]
        .filter((resume) => resume.studentId === studentId)
        .sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt))[0];
    }

    const resume = await ResumeModel.findOne({ studentId }).sort({ uploadedAt: -1 }).lean();
    return resume ? mapResume(resume as Record<string, unknown>) : undefined;
  }

  async getById(resumeId: string): Promise<ResumeRecord | undefined> {
    if (isMemoryMode()) {
      return db.resumes.find((resume) => resume.id === resumeId);
    }

    const resume = await ResumeModel.findOne({ id: resumeId }).lean();
    return resume ? mapResume(resume as Record<string, unknown>) : undefined;
  }

  async assignToStudent(resumeId: string, studentId: string): Promise<void> {
    if (isMemoryMode()) {
      const resume = db.resumes.find((item) => item.id === resumeId);

      if (resume) {
        resume.studentId = studentId;
      }

      return;
    }

    await ResumeModel.updateOne({ id: resumeId }, { $set: { studentId } });
  }
}

function mapResume(resume: Record<string, unknown>): ResumeRecord {
  return {
    id: String(resume.id),
    studentId: typeof resume.studentId === "string" ? resume.studentId : undefined,
    filename: String(resume.filename),
    mimeType: String(resume.mimeType),
    sizeBytes: Number(resume.sizeBytes),
    storagePath: String(resume.storagePath),
    extractedText: typeof resume.extractedText === "string" ? resume.extractedText : undefined,
    uploadedAt:
      typeof resume.uploadedAt === "string"
        ? resume.uploadedAt
        : new Date(resume.uploadedAt as Date | string | number).toISOString()
  };
}
