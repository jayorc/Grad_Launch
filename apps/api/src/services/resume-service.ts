import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import type { ResumeDraftResponse, ResumeProfileDraft, ResumeRecord, StudentProfile } from "@gradlaunch/shared";
import { getResumeStorageDir } from "../config/storage";
import { createId } from "../lib/id";
import { nowIso } from "../lib/time";
import { ResumeRepository } from "../repositories/resume-repository";
import { StudentRepository } from "../repositories/student-repository";

const KNOWN_SKILLS = [
  "JavaScript",
  "TypeScript",
  "React",
  "Next.js",
  "Node.js",
  "Express",
  "MongoDB",
  "Python",
  "SQL",
  "AWS",
  "Java",
  "C++",
  "HTML",
  "CSS",
  "REST APIs",
  "LLMs"
];

const ROLE_KEYWORDS = [
  "Software Engineer",
  "Frontend Engineer",
  "Backend Engineer",
  "Full Stack Developer",
  "AI Engineer",
  "Data Analyst"
];

const LOCATION_KEYWORDS = ["Remote", "Bengaluru", "Hyderabad", "Pune", "Mumbai", "Delhi", "Chennai", "Noida", "Gurugram"];

export class ResumeService {
  constructor(
    private readonly resumes = new ResumeRepository(),
    private readonly students = new StudentRepository()
  ) {}

  async createDraftFromUpload(file: Express.Multer.File): Promise<ResumeDraftResponse> {
    const resume = await this.persistResume(file);
    const draft = await this.extractDraft(file, resume.extractedText ?? "");

    return { resume, draft };
  }

  async uploadForStudent(studentId: string, file: Express.Multer.File): Promise<ResumeDraftResponse> {
    const student = await this.students.getById(studentId);

    if (!student) {
      throw new Error("Student not found.");
    }

    const resume = await this.persistResume(file, studentId);
    const draft = await this.extractDraft(file, resume.extractedText ?? "", student);
    await this.students.setResumeId(studentId, resume.id);
    await this.students.update(studentId, {
      fullName: draft.fullName || student.fullName,
      degree: draft.degree || student.degree,
      graduationYear: draft.graduationYear ?? student.graduationYear,
      targetRoles: draft.targetRoles.length > 0 ? draft.targetRoles : student.targetRoles,
      preferredLocations: draft.preferredLocations.length > 0 ? draft.preferredLocations : student.preferredLocations,
      workModes: student.workModes,
      skills: draft.skills.length > 0 ? draft.skills : student.skills,
      expectedSalaryLpa: student.expectedSalaryLpa,
      visaRequired: student.visaRequired,
      automationMode: student.automationMode,
      defaultStrictness: student.defaultStrictness,
      bio: draft.bio || student.bio || ""
    });

    return { resume, draft };
  }

  private async persistResume(file: Express.Multer.File, studentId?: string): Promise<ResumeRecord> {
    const storageDir = getResumeStorageDir();
    await mkdir(storageDir, { recursive: true });

    const extension = extname(file.originalname) || guessExtension(file.mimetype);
    const filename = `${createId("resume")}${extension}`;
    const storagePath = join(storageDir, filename);
    await writeFile(storagePath, file.buffer);

    const extractedText = await safeExtractText(file);
    const resume: ResumeRecord = {
      id: createId("resume"),
      studentId,
      filename: file.originalname,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      storagePath,
      extractedText,
      uploadedAt: nowIso()
    };

    await this.resumes.create(resume);
    return resume;
  }

  private async extractDraft(
    file: Express.Multer.File,
    extractedText: string,
    student?: StudentProfile
  ): Promise<ResumeProfileDraft> {
    const text = extractedText || file.buffer.toString("utf-8");
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const emailMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)?.[0] ?? student?.email ?? "";
    const nameLine =
      lines.find((line) => /^[A-Za-z][A-Za-z\s.'-]{3,}$/.test(line) && !line.toLowerCase().includes("resume")) ??
      student?.fullName ??
      "";
    const degree =
      lines.find((line) => /(b\.?tech|bachelor|b\.?e\.?|m\.?tech|bca|mca|bsc|msc)/i.test(line)) ??
      student?.degree ??
      "";
    const graduationYear = detectGraduationYear(text) ?? student?.graduationYear;
    const skills = KNOWN_SKILLS.filter((skill) => text.toLowerCase().includes(skill.toLowerCase()));
    const targetRoles = ROLE_KEYWORDS.filter((role) => text.toLowerCase().includes(role.toLowerCase()));
    const preferredLocations = LOCATION_KEYWORDS.filter((location) => text.toLowerCase().includes(location.toLowerCase()));
    const bio = lines.slice(0, 3).join(" ").slice(0, 240);

    return {
      fullName: cleanName(nameLine),
      email: emailMatch,
      degree,
      graduationYear,
      targetRoles,
      preferredLocations,
      skills,
      bio
    };
  }
}

async function extractText(file: Express.Multer.File): Promise<string> {
  if (file.mimetype.includes("pdf") || file.originalname.toLowerCase().endsWith(".pdf")) {
    const parsed = await pdfParse(file.buffer);
    return parsed.text ?? "";
  }

  if (
    file.originalname.toLowerCase().endsWith(".docx")
  ) {
    const parsed = await mammoth.extractRawText({ buffer: file.buffer });
    return parsed.value ?? "";
  }

  return file.buffer.toString("utf-8");
}

async function safeExtractText(file: Express.Multer.File) {
  try {
    return await extractText(file);
  } catch (_error) {
    return file.mimetype.startsWith("text/") || file.originalname.toLowerCase().endsWith(".txt")
      ? file.buffer.toString("utf-8")
      : "";
  }
}

function detectGraduationYear(text: string): number | undefined {
  const matches = text.match(/\b(20[2-4][0-9])\b/g);
  if (!matches?.length) {
    return undefined;
  }

  return Number(matches.sort()[0]);
}

function cleanName(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function guessExtension(mimeType: string) {
  if (mimeType.includes("pdf")) {
    return ".pdf";
  }

  if (mimeType.includes("word")) {
    return ".docx";
  }

  return ".txt";
}
