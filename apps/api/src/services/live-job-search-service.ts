import type { Job, StudentProfile } from "@gradlaunch/shared";
import { createId } from "../lib/id";
import { nowIso } from "../lib/time";

type LiveSearchResult = {
  jobs: Job[];
  sources: LiveSourceResult[];
};

type LiveSourceResult = {
  id: string;
  label: string;
  status: "done" | "attention";
  detail: string;
  count: number;
};

type GreenhouseJob = {
  id?: number | string;
  title?: string;
  updated_at?: string;
  location?: { name?: string };
  absolute_url?: string;
  content?: string;
};

type LeverPosting = {
  id?: string;
  text?: string;
  hostedUrl?: string;
  categories?: {
    location?: string;
    commitment?: string;
    team?: string;
  };
  descriptionPlain?: string;
  description?: string;
  lists?: Array<{ text?: string; content?: string }>;
  createdAt?: number;
};

type RemotiveJob = {
  id?: number | string;
  title?: string;
  company_name?: string;
  candidate_required_location?: string;
  job_type?: string;
  category?: string;
  description?: string;
  url?: string;
  publication_date?: string;
  tags?: string[];
};

const requestTimeoutMs = 12000;

export class LiveJobSearchService {
  async fetchDirectJobUrl(url: string): Promise<Job> {
    const result = await this.searchDirectJobUrl(url);
    const job = result.jobs[0];

    if (!job) {
      throw new Error("No job could be parsed from this URL.");
    }

    return job;
  }

  async searchForStudent(student: StudentProfile): Promise<LiveSearchResult> {
    if (process.env.LIVE_JOB_SEARCH_ENABLED === "false") {
      return {
        jobs: [],
        sources: [
          {
            id: "live-disabled",
            label: "Live search disabled",
            status: "attention",
            detail: "Set LIVE_JOB_SEARCH_ENABLED=true to fetch current openings.",
            count: 0
          }
        ]
      };
    }

    const query = buildQuery(student);
    const sourcePromises = [
      this.searchRemotive(query),
      ...getCsvEnv("LIVE_GREENHOUSE_BOARDS").map((board) => this.searchGreenhouseBoard(board)),
      ...getCsvEnv("LIVE_LEVER_COMPANIES").map((company) => this.searchLeverCompany(company)),
      ...getCsvEnv("LIVE_JOB_URLS").map((url) => this.searchDirectJobUrl(url))
    ];
    const settled = await Promise.allSettled(sourcePromises);
    const jobs: Job[] = [];
    const sources: LiveSourceResult[] = [];

    for (const result of settled) {
      if (result.status === "fulfilled") {
        jobs.push(...result.value.jobs);
        sources.push(result.value.source);
      } else {
        sources.push({
          id: createId("source"),
          label: "Live source",
          status: "attention",
          detail: result.reason instanceof Error ? result.reason.message : "A live source failed.",
          count: 0
        });
      }
    }

    return {
      jobs: dedupeJobs(jobs),
      sources
    };
  }

  private async searchRemotive(query: string) {
    const url = `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(query)}`;
    const body = await fetchJson<{ jobs?: RemotiveJob[] }>(url);
    const jobs = (body.jobs ?? []).slice(0, 35).map((job) => mapRemotiveJob(job));

    return {
      jobs,
      source: {
        id: "remotive",
        label: "Remotive",
        status: "done" as const,
        detail: `Fetched ${jobs.length} current remote openings for "${query}".`,
        count: jobs.length
      }
    };
  }

  private async searchGreenhouseBoard(boardToken: string) {
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs?content=true`;
    const body = await fetchJson<{ jobs?: GreenhouseJob[] }>(url);
    const jobs = (body.jobs ?? []).map((job) => mapGreenhouseJob(boardToken, job));

    return {
      jobs,
      source: {
        id: `greenhouse-${boardToken}`,
        label: `Greenhouse: ${boardToken}`,
        status: "done" as const,
        detail: `Fetched ${jobs.length} live jobs from the ${boardToken} Greenhouse board.`,
        count: jobs.length
      }
    };
  }

  private async searchLeverCompany(company: string) {
    const url = `https://api.lever.co/v0/postings/${encodeURIComponent(company)}?mode=json`;
    const postings = await fetchJson<LeverPosting[]>(url);
    const jobs = postings.map((posting) => mapLeverPosting(company, posting));

    return {
      jobs,
      source: {
        id: `lever-${company}`,
        label: `Lever: ${company}`,
        status: "done" as const,
        detail: `Fetched ${jobs.length} live jobs from the ${company} Lever board.`,
        count: jobs.length
      }
    };
  }

  private async searchDirectJobUrl(url: string) {
    const html = await fetchText(url);
    const job = mapGenericJobUrl(url, html);

    return {
      jobs: [job],
      source: {
        id: `url-${job.id}`,
        label: "Direct job URL",
        status: "done" as const,
        detail: `Fetched and parsed ${job.title} at ${job.company}.`,
        count: 1
      }
    };
  }
}

function mapRemotiveJob(job: RemotiveJob): Job {
  const title = cleanText(job.title) || "Remote Software Role";
  const description = stripHtml(job.description ?? "");

  return {
    id: stableJobId("remotive", String(job.id ?? job.url ?? title)),
    title,
    company: cleanText(job.company_name) || "Remote Company",
    location: cleanText(job.candidate_required_location) || "Remote",
    workMode: "remote",
    minExperience: inferMinExperience(description),
    maxExperience: inferMaxExperience(description),
    degreeRequirements: inferDegreeRequirements(description),
    skills: inferSkills(`${title} ${description} ${(job.tags ?? []).join(" ")}`),
    description: description || `Live remote opening from Remotive in ${job.category ?? "software"}.`,
    sourceType: "aggregated_search",
    sourceUrl: job.url ?? "https://remotive.com/remote-jobs",
    createdAt: job.publication_date ? new Date(job.publication_date).toISOString() : nowIso()
  };
}

function mapGreenhouseJob(boardToken: string, job: GreenhouseJob): Job {
  const title = cleanText(job.title) || "Software Role";
  const description = stripHtml(job.content ?? "");

  return {
    id: stableJobId("greenhouse", `${boardToken}-${job.id ?? title}`),
    title,
    company: formatCompanyName(boardToken),
    location: cleanText(job.location?.name) || "Remote",
    workMode: inferWorkMode(`${job.location?.name ?? ""} ${description}`),
    minExperience: inferMinExperience(description),
    maxExperience: inferMaxExperience(description),
    degreeRequirements: inferDegreeRequirements(description),
    skills: inferSkills(`${title} ${description}`),
    description: description || `Live opening from ${formatCompanyName(boardToken)} on Greenhouse.`,
    sourceType: "greenhouse",
    sourceUrl: job.absolute_url ?? `https://boards.greenhouse.io/${boardToken}`,
    createdAt: job.updated_at ? new Date(job.updated_at).toISOString() : nowIso()
  };
}

function mapLeverPosting(company: string, posting: LeverPosting): Job {
  const title = cleanText(posting.text) || "Software Role";
  const description = cleanText([
    posting.descriptionPlain,
    posting.description,
    ...(posting.lists ?? []).map((list) => `${list.text ?? ""} ${list.content ?? ""}`)
  ].filter(Boolean).join(" "));

  return {
    id: stableJobId("lever", `${company}-${posting.id ?? title}`),
    title,
    company: formatCompanyName(company),
    location: cleanText(posting.categories?.location) || "Remote",
    workMode: inferWorkMode(`${posting.categories?.location ?? ""} ${description}`),
    minExperience: inferMinExperience(description),
    maxExperience: inferMaxExperience(description),
    degreeRequirements: inferDegreeRequirements(description),
    skills: inferSkills(`${title} ${description} ${posting.categories?.team ?? ""}`),
    description: description || `Live opening from ${formatCompanyName(company)} on Lever.`,
    sourceType: "lever",
    sourceUrl: posting.hostedUrl ?? `https://jobs.lever.co/${company}`,
    createdAt: posting.createdAt ? new Date(posting.createdAt).toISOString() : nowIso()
  };
}

function mapGenericJobUrl(url: string, html: string): Job {
  const schemaJob = extractJobPostingJsonLd(html);
  const parsed = new URL(url);
  const title = cleanText(schemaJob?.title) || extractTitle(html) || parsed.pathname.split("/").filter(Boolean).at(-1)?.replace(/[-_]/g, " ") || "Software Role";
  const company = cleanText(schemaJob?.hiringOrganization?.name) || formatCompanyName(parsed.hostname.replace(/^www\./, "").split(".")[0] ?? "Company");
  const description = stripHtml(schemaJob?.description ?? extractMetaDescription(html) ?? "");

  return {
    id: stableJobId("url", url),
    title: titleCase(title),
    company,
    location: extractSchemaLocation(schemaJob) || "Remote",
    workMode: inferWorkMode(`${extractSchemaLocation(schemaJob)} ${description}`),
    minExperience: inferMinExperience(description),
    maxExperience: inferMaxExperience(description),
    degreeRequirements: inferDegreeRequirements(description),
    skills: inferSkills(`${title} ${description}`),
    description: description || `Live opening parsed from ${parsed.hostname}.`,
    sourceType: parsed.hostname.includes("greenhouse") ? "greenhouse" : parsed.hostname.includes("lever") ? "lever" : parsed.hostname.includes("ashby") ? "ashby" : "manual_url",
    sourceUrl: url,
    createdAt: nowIso()
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetchWithTimeout(url);

  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}.`);
  }

  return response.json() as Promise<T>;
}

async function fetchText(url: string) {
  const response = await fetchWithTimeout(url);

  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}.`);
  }

  return response.text();
}

async function fetchWithTimeout(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "GradLaunch/0.1 live-job-search"
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}

function buildQuery(student: StudentProfile) {
  return student.targetRoles[0] ?? student.skills[0] ?? "software engineer";
}

function dedupeJobs(jobs: Job[]) {
  const seen = new Set<string>();
  const unique: Job[] = [];

  for (const job of jobs) {
    const key = job.sourceUrl.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(job);
  }

  return unique;
}

function inferSkills(text: string) {
  const knownSkills = [
    "JavaScript",
    "TypeScript",
    "React",
    "Next.js",
    "Node.js",
    "Express",
    "MongoDB",
    "PostgreSQL",
    "Python",
    "Django",
    "FastAPI",
    "Java",
    "Spring",
    "AWS",
    "Docker",
    "Kubernetes",
    "SQL",
    "GraphQL",
    "REST APIs",
    "CSS",
    "HTML",
    "Testing",
    "LLMs",
    "APIs"
  ];
  const normalizedText = text.toLowerCase();
  const skills = knownSkills.filter((skill) => normalizedText.includes(skill.toLowerCase()));

  return skills.length > 0 ? [...new Set(skills)].slice(0, 8) : ["JavaScript", "APIs", "Communication"];
}

function inferDegreeRequirements(description: string) {
  const normalized = description.toLowerCase();
  const degrees = ["B.Tech", "B.E.", "BCA", "MCA"].filter((degree) => normalized.includes(degree.toLowerCase().replace(".", "")) || normalized.includes(degree.toLowerCase()));
  return degrees.length > 0 ? degrees : ["B.Tech", "B.E.", "BCA"];
}

function inferMinExperience(description: string) {
  const match = description.match(/(\d+)\+?\s*(?:years|yrs)/i);
  return match ? Number(match[1]) : 0;
}

function inferMaxExperience(description: string) {
  const minExperience = inferMinExperience(description);
  return minExperience <= 1 ? 2 : Math.min(minExperience + 2, 8);
}

function inferWorkMode(text: string): Job["workMode"] {
  const normalized = text.toLowerCase();

  if (normalized.includes("remote")) {
    return "remote";
  }

  if (normalized.includes("hybrid")) {
    return "hybrid";
  }

  return "onsite";
}

function getCsvEnv(key: string) {
  return (process.env[key] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function stripHtml(value: string) {
  return cleanText(value.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "));
}

function cleanText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function titleCase(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatCompanyName(value: string) {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function stableJobId(source: string, value: string) {
  return `job_${source}_${Buffer.from(value).toString("base64url").slice(0, 24)}`;
}

function extractJobPostingJsonLd(html: string): Record<string, any> | undefined {
  const matches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);

  for (const match of matches) {
    try {
      const parsed = JSON.parse(match[1] ?? "");
      const entries = Array.isArray(parsed) ? parsed : parsed["@graph"] && Array.isArray(parsed["@graph"]) ? parsed["@graph"] : [parsed];
      const jobPosting = entries.find((item: Record<string, unknown>) => item?.["@type"] === "JobPosting");

      if (jobPosting) {
        return jobPosting;
      }
    } catch (_error) {
      // Ignore malformed JSON-LD blocks.
    }
  }

  return undefined;
}

function extractTitle(html: string) {
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1];
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return cleanText(ogTitle ?? title ?? "");
}

function extractMetaDescription(html: string) {
  return html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1];
}

function extractSchemaLocation(schemaJob: Record<string, any> | undefined) {
  const location = Array.isArray(schemaJob?.jobLocation) ? schemaJob?.jobLocation[0] : schemaJob?.jobLocation;
  const address = location?.address;
  return cleanText([address?.addressLocality, address?.addressRegion, address?.addressCountry].filter(Boolean).join(", "));
}
