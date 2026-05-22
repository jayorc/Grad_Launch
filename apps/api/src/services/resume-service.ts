import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { inflateSync } from "node:zlib";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import type { ResumeDraftResponse, ResumeProfileDraft, ResumeRecord, StudentProfile, StudentProfileDetails } from "@gradlaunch/shared";
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
      bio: draft.bio || student.bio || "",
      completeProfile: mergeCompleteProfile(student.completeProfile, draft.completeProfile)
    });

    return { resume, draft };
  }

  async assignExistingResumeToStudent(resumeId: string, studentId: string) {
    const resume = await this.resumes.getById(resumeId);

    if (!resume) {
      return undefined;
    }

    await this.resumes.assignToStudent(resumeId, studentId);
    await this.students.setResumeId(studentId, resumeId);
    return resume;
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
    const heuristicDraft = {
      fullName: cleanName(nameLine),
      email: emailMatch,
      degree,
      graduationYear,
      targetRoles,
      preferredLocations,
      skills,
      bio,
      completeProfile: createHeuristicCompleteProfile(text, student)
    } satisfies ResumeProfileDraft;

    const llmDraft = await this.enrichDraftWithLlm(text, heuristicDraft).catch(() => undefined);

    return mergeDrafts(heuristicDraft, llmDraft);
  }

  private async enrichDraftWithLlm(text: string, draft: ResumeProfileDraft): Promise<ResumeProfileDraft | undefined> {
    if (!process.env.OPENAI_API_KEY) {
      return undefined;
    }

    const endpoint = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1/chat/completions";
    const model = process.env.OPENAI_MODEL ?? process.env.LLM_MODEL ?? "gpt-4o-mini";
    const prompt = [
      "Extract a job-applicant profile from the resume text.",
      "Return strict JSON only.",
      "Do not invent facts missing from the resume.",
      "Keep arrays short and relevant.",
      "Write a strong concise professional bio and headline when the resume contains enough evidence.",
      "If the resume mentions platforms like LinkedIn, GitHub, LeetCode, Kaggle, or portfolio/website and a clear handle is present, you may construct the canonical profile URL.",
      "",
      "Schema:",
      JSON.stringify({
        fullName: "",
        email: "",
        degree: "",
        graduationYear: 0,
        targetRoles: [""],
        preferredLocations: [""],
        skills: [""],
        bio: "",
        completeProfile: {
          headline: "",
          phone: "",
          linkedInUrl: "",
          githubUrl: "",
          portfolioUrl: "",
          websiteUrl: "",
          leetcodeUrl: "",
          kaggleUrl: "",
          city: "",
          state: "",
          country: "",
          nationality: "",
          currentCompany: "",
          currentTitle: "",
          totalExperienceYears: 0,
          workAuthorizationCountries: [""],
          certifications: [""],
          languages: [""],
          achievements: [""],
          educationHistory: [{ school: "", degree: "", fieldOfStudy: "", startYear: 0, endYear: 0, grade: "", city: "", country: "" }],
          employmentHistory: [{ company: "", title: "", startDate: "", endDate: "", current: false, location: "", summary: "" }],
          projectHistory: [{ name: "", role: "", techStack: "", summary: "", url: "" }],
          screeningAnswers: [],
          customFacts: [],
          eeo: {}
        }
      }),
      "",
      `Resume text:\n${text.slice(0, 12000)}`,
      "",
      `Current heuristic draft:\n${JSON.stringify(draft)}`
    ].join("\n");

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "You extract structured student/job-application profile data from resumes."
          },
          {
            role: "user",
            content: prompt
          }
        ]
      })
    });

    if (!response.ok) {
      return undefined;
    }

    const body = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;

    if (!content) {
      return undefined;
    }

    return JSON.parse(extractJsonBlock(content)) as ResumeProfileDraft;
  }
}

function mergeDrafts(base: ResumeProfileDraft, incoming?: ResumeProfileDraft): ResumeProfileDraft {
  if (!incoming) {
    return base;
  }

  return {
    fullName: incoming.fullName || base.fullName,
    email: incoming.email || base.email,
    degree: incoming.degree || base.degree,
    graduationYear: incoming.graduationYear ?? base.graduationYear,
    targetRoles: incoming.targetRoles?.length ? dedupe(incoming.targetRoles) : base.targetRoles,
    preferredLocations: incoming.preferredLocations?.length ? dedupe(incoming.preferredLocations) : base.preferredLocations,
    skills: incoming.skills?.length ? dedupe(incoming.skills) : base.skills,
    bio: incoming.bio || base.bio,
    completeProfile: mergeCompleteProfile(base.completeProfile, incoming.completeProfile)
  };
}

function mergeCompleteProfile(
  base: StudentProfileDetails | undefined,
  incoming: StudentProfileDetails | undefined
): StudentProfileDetails {
  const current = ensureCompleteProfile(base);
  const next = incoming ? ensureCompleteProfile(incoming) : undefined;

  if (!next) {
    return current;
  }

  return {
    ...current,
    ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)),
    workAuthorizationCountries: next.workAuthorizationCountries.length ? dedupe(next.workAuthorizationCountries) : current.workAuthorizationCountries,
    preferredEmploymentTypes: next.preferredEmploymentTypes.length ? dedupe(next.preferredEmploymentTypes) : current.preferredEmploymentTypes,
    certifications: next.certifications.length ? dedupe(next.certifications) : current.certifications,
    languages: next.languages.length ? dedupe(next.languages) : current.languages,
    achievements: next.achievements.length ? dedupe(next.achievements) : current.achievements,
    educationHistory: next.educationHistory.length ? next.educationHistory : current.educationHistory,
    employmentHistory: next.employmentHistory.length ? next.employmentHistory : current.employmentHistory,
    projectHistory: next.projectHistory.length ? next.projectHistory : current.projectHistory,
    screeningAnswers: next.screeningAnswers.length ? next.screeningAnswers : current.screeningAnswers,
    customFacts: next.customFacts.length ? next.customFacts : current.customFacts,
    eeo: {
      ...current.eeo,
      ...next.eeo
    }
  };
}

function ensureCompleteProfile(details?: Partial<StudentProfileDetails>): StudentProfileDetails {
  return {
    ...details,
    workAuthorizationCountries: details?.workAuthorizationCountries ?? [],
    preferredEmploymentTypes: details?.preferredEmploymentTypes ?? [],
    certifications: details?.certifications ?? [],
    languages: details?.languages ?? [],
    achievements: details?.achievements ?? [],
    educationHistory: details?.educationHistory ?? [],
    employmentHistory: details?.employmentHistory ?? [],
    projectHistory: details?.projectHistory ?? [],
    screeningAnswers: details?.screeningAnswers ?? [],
    customFacts: details?.customFacts ?? [],
    eeo: details?.eeo ?? {}
  };
}

function createHeuristicCompleteProfile(text: string, student?: StudentProfile): StudentProfileDetails {
  const urls = extractUrls(text);
  const inferredSocials = inferSocialUrls(text, student);
  const linkedInUrl = urls.find((url) => /linkedin\.com/i.test(url)) ?? inferredSocials.linkedInUrl;
  const githubUrl = urls.find((url) => /github\.com/i.test(url)) ?? inferredSocials.githubUrl;
  const leetcodeUrl = urls.find((url) => /leetcode\.com/i.test(url)) ?? inferredSocials.leetcodeUrl;
  const kaggleUrl = urls.find((url) => /kaggle\.com/i.test(url)) ?? inferredSocials.kaggleUrl;
  const portfolioUrl = urls.find((url) => !/linkedin\.com|github\.com|leetcode\.com|kaggle\.com/i.test(url));
  const phone = extractPhone(text);
  const city = detectLocation(text);
  const headline = detectHeadline(text);
  const certifications = extractSectionBullets(text, ["certification", "certifications"]);
  const achievements = extractSectionBullets(text, ["achievement", "achievements", "award", "awards"]);
  const languages = extractSectionBullets(text, ["languages", "language"]);
  const educationHistory = extractEducationHistory(text, student);
  const employmentHistory = extractEmploymentHistory(text);
  const projectHistory = extractProjectHistory(text);
  const currentEmployment = employmentHistory.find((item) => item.current) ?? employmentHistory[0];

  return ensureCompleteProfile({
    headline,
    phone,
    linkedInUrl,
    githubUrl,
    portfolioUrl,
    websiteUrl: portfolioUrl,
    leetcodeUrl,
    kaggleUrl,
    city: city?.city,
    state: city?.state,
    country: city?.country,
    currentCompany: currentEmployment?.company,
    currentTitle: currentEmployment?.title,
    totalExperienceYears: detectExperienceYears(text),
    certifications,
    languages,
    achievements,
    educationHistory,
    employmentHistory,
    projectHistory
  });
}

function extractUrls(text: string) {
  return dedupe((text.match(/https?:\/\/[^\s)]+/gi) ?? []).map((item) => item.replace(/[),.;]+$/, "")));
}

function inferSocialUrls(text: string, student?: StudentProfile) {
  const normalizedText = text.toLowerCase();
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)?.[0] ?? student?.email;
  const fallbackHandle = email?.split("@")[0]?.replace(/[^a-z0-9._-]+/gi, "").trim();
  const rawHandleMatches = Array.from(
    normalizedText.matchAll(/\b(?:github|linkedin|leetcode|kaggle)[^a-z0-9]{0,8}([a-z0-9._-]{3,40})/gi),
    (match) => match[1]
  );
  const cleanedHandle = rawHandleMatches.find(Boolean)?.replace(/[^a-z0-9._-]+/gi, "") || fallbackHandle;

  return {
    githubUrl: normalizedText.includes("github") && cleanedHandle ? `https://github.com/${cleanedHandle}` : undefined,
    linkedInUrl: normalizedText.includes("linkedin") && cleanedHandle ? `https://www.linkedin.com/in/${cleanedHandle}` : undefined,
    leetcodeUrl: normalizedText.includes("leetcode") && cleanedHandle ? `https://leetcode.com/${cleanedHandle}` : undefined,
    kaggleUrl: normalizedText.includes("kaggle") && cleanedHandle ? `https://www.kaggle.com/${cleanedHandle}` : undefined
  };
}

function extractPhone(text: string) {
  const match = text.match(/(?:\+?\d{1,3}[\s-]?)?(?:\(?\d{2,5}\)?[\s-]?)?\d{3,5}[\s-]?\d{3,5}[\s-]?\d{0,5}/);
  return match?.[0]?.trim();
}

function detectLocation(text: string) {
  const location = LOCATION_KEYWORDS.find((item) => new RegExp(`\\b${item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));

  if (!location) {
    return undefined;
  }

  return {
    city: location === "Remote" ? undefined : location,
    state: undefined,
    country: "India"
  };
}

function detectHeadline(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /(engineer|developer|analyst|scientist|consultant|designer)/i.test(line) && line.length < 90);
}

function detectExperienceYears(text: string) {
  const match = text.match(/(\d+(?:\.\d+)?)\+?\s+(?:years|yrs)\s+(?:of\s+)?experience/i);
  return match ? Number(match[1]) : undefined;
}

function extractSectionBullets(text: string, headings: string[]) {
  const normalized = text.replace(/\r/g, "");
  const headingPattern = headings.join("|");
  const match = normalized.match(new RegExp(`(?:${headingPattern})\\s*:?\\n([\\s\\S]{0,500})`, "i"));

  if (!match?.[1]) {
    return [];
  }

  return dedupe(
    match[1]
      .split(/\n|•|,|;/)
      .map((item) => item.trim())
      .filter((item) => item.length > 1 && item.length < 80)
      .slice(0, 12)
  );
}

function extractEducationHistory(text: string, student?: StudentProfile) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const matches = lines.filter((line) => /(b\.?tech|bachelor|m\.?tech|mca|bca|bsc|msc|university|college|institute)/i.test(line)).slice(0, 4);

  return matches.map((line, index) => ({
    school: line,
    degree: index === 0 ? student?.degree ?? "" : "",
    fieldOfStudy: undefined,
    startYear: undefined,
    endYear: detectGraduationYear(line),
    grade: undefined,
    city: undefined,
    country: undefined
  }));
}

function extractEmploymentHistory(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const matches = lines
    .filter((line) => /\b(intern|engineer|developer|analyst|consultant|manager|specialist)\b/i.test(line))
    .slice(0, 5);

  return matches.map((line, index) => ({
    company: "",
    title: line,
    startDate: undefined,
    endDate: undefined,
    current: index === 0,
    location: undefined,
    summary: undefined
  }));
}

function extractProjectHistory(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const projectIndex = lines.findIndex((line) => /\b(project|projects)\b/i.test(line));

  if (projectIndex === -1) {
    return [];
  }

  return lines
    .slice(projectIndex + 1, projectIndex + 6)
    .filter((line) => line.length > 4)
    .map((line) => ({
      name: line,
      role: undefined,
      techStack: undefined,
      summary: undefined,
      url: extractUrls(line)[0]
    }));
}

function dedupe(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function extractJsonBlock(content: string) {
  const match = content.match(/\{[\s\S]*\}/);
  return match ? match[0] : content;
}

async function extractText(file: Express.Multer.File): Promise<string> {
  if (file.mimetype.includes("pdf") || file.originalname.toLowerCase().endsWith(".pdf")) {
    const parsed = await pdfParse(file.buffer);
    const hiddenLinks = extractPdfHyperlinks(file.buffer);
    return appendHiddenLinks(parsed.text ?? "", hiddenLinks);
  }

  if (
    file.originalname.toLowerCase().endsWith(".docx")
  ) {
    const [rawText, html] = await Promise.all([
      mammoth.extractRawText({ buffer: file.buffer }),
      mammoth.convertToHtml({ buffer: file.buffer })
    ]);
    const hiddenLinks = extractHtmlHyperlinks(html.value ?? "");
    return appendHiddenLinks(rawText.value ?? "", hiddenLinks);
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

function appendHiddenLinks(text: string, links: string[]) {
  const uniqueLinks = dedupe(links);

  if (uniqueLinks.length === 0) {
    return text;
  }

  const existing = new Set(extractUrls(text).map((item) => item.toLowerCase()));
  const missing = uniqueLinks.filter((item) => !existing.has(item.toLowerCase()));

  if (missing.length === 0) {
    return text;
  }

  return `${text.trim()}\n\nHidden hyperlinks:\n${missing.join("\n")}`.trim();
}

function extractHtmlHyperlinks(html: string) {
  const matches = html.matchAll(/href=(["'])(.*?)\1/gi);
  const values: string[] = [];

  for (const match of matches) {
    const href = match[2]?.trim();

    if (!href || href.startsWith("#") || href.startsWith("mailto:")) {
      continue;
    }

    values.push(href);
  }

  return dedupe(values.map(normalizeExtractedUrl));
}

function extractPdfHyperlinks(buffer: Buffer) {
  const values = extractPdfSearchSources(buffer).flatMap(extractPdfUrisFromSource);

  return dedupe(
    values
      .map((item) => item.trim())
      .map(unescapePdfString)
      .map(normalizeExtractedUrl)
      .filter((item) => /^(?:https?:\/\/|mailto:)/i.test(item))
  );
}

function extractPdfSearchSources(buffer: Buffer) {
  const source = buffer.toString("latin1");
  const extracted = [source];
  const streamPattern = /stream\r?\n([\s\S]*?)endstream/g;
  let match: RegExpExecArray | null;

  while ((match = streamPattern.exec(source))) {
    const raw = Buffer.from(match[1] ?? "", "latin1");

    for (const candidate of buildPdfStreamCandidates(raw)) {
      extracted.push(candidate.toString("latin1"));

      try {
        extracted.push(inflateSync(candidate).toString("latin1"));
      } catch (_error) {
        continue;
      }
    }
  }

  return dedupe(extracted);
}

function buildPdfStreamCandidates(raw: Buffer) {
  const variants = [raw];

  if (raw.length > 0 && (raw[raw.length - 1] === 0x0a || raw[raw.length - 1] === 0x0d)) {
    variants.push(raw.subarray(0, raw.length - 1));
  }

  if (
    raw.length > 1 &&
    ((raw[raw.length - 2] === 0x0d && raw[raw.length - 1] === 0x0a) || (raw[raw.length - 2] === 0x0a && raw[raw.length - 1] === 0x0d))
  ) {
    variants.push(raw.subarray(0, raw.length - 2));
  }

  return variants;
}

function extractPdfUrisFromSource(source: string) {
  return [
    ...Array.from(source.matchAll(/\/URI\s*\(([^)]+)\)/g), (match) => match[1]),
    ...Array.from(source.matchAll(/\/URI\s*<([^>]+)>/g), (match) => decodePdfHex(match[1]))
  ];
}

function decodePdfHex(value: string) {
  try {
    return Buffer.from(value.replace(/\s+/g, ""), "hex").toString("utf8");
  } catch (_error) {
    return value;
  }
}

function unescapePdfString(value: string) {
  return value
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
}

function normalizeExtractedUrl(value: string) {
  return value.replace(/[)>.,;]+$/g, "").trim();
}
