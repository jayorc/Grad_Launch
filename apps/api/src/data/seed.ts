import type {
  Application,
  ApplicationRun,
  Job,
  StudentAccount,
  SearchSession,
  StudentProfile,
  UserSession
} from "@gradlaunch/shared";

export const seedStudents: StudentProfile[] = [
  {
    id: "student_1",
    fullName: "Aarav Sharma",
    email: "aarav@example.com",
    degree: "B.Tech in Computer Science",
    graduationYear: 2026,
    targetRoles: ["Software Engineer", "Frontend Engineer", "Full Stack Developer"],
    preferredLocations: ["Bengaluru", "Remote", "Hyderabad"],
    workModes: ["remote", "hybrid"],
    skills: ["JavaScript", "TypeScript", "React", "Node.js", "MongoDB", "Express", "CSS"],
    expectedSalaryLpa: 10,
    visaRequired: false,
    automationMode: "full_autopilot",
    defaultStrictness: "balanced",
    bio: "Final-year CS student building frontend and API projects for early-career software roles."
  }
];

export const seedAccounts: StudentAccount[] = [
  {
    id: "account_1",
    studentId: "student_1",
    email: "aarav@example.com",
    password: "gradlaunch123",
    createdAt: "2026-05-19T08:00:00.000Z"
  }
];

export const seedSessions: UserSession[] = [];

export const seedJobs: Job[] = [
  {
    id: "job_1",
    title: "Software Engineer Intern",
    company: "LaunchGrid",
    location: "Bengaluru",
    workMode: "hybrid",
    minExperience: 0,
    maxExperience: 1,
    degreeRequirements: ["B.Tech", "B.E.", "B.Sc"],
    skills: ["JavaScript", "React", "Node.js", "CSS"],
    description: "Build internal products for early-career hiring workflows.",
    sourceType: "greenhouse",
    sourceUrl: "https://boards.greenhouse.io/launchgrid/jobs/123",
    createdAt: "2026-05-19T09:00:00.000Z"
  },
  {
    id: "job_2",
    title: "Frontend Engineer",
    company: "HireOrbit",
    location: "Remote",
    workMode: "remote",
    minExperience: 0,
    maxExperience: 2,
    degreeRequirements: ["B.Tech", "BCA", "MCA"],
    skills: ["TypeScript", "React", "Next.js", "Testing"],
    description: "Ship polished candidate-facing experiences for career products.",
    sourceType: "lever",
    sourceUrl: "https://jobs.lever.co/hireorbit/456",
    createdAt: "2026-05-18T11:30:00.000Z"
  },
  {
    id: "job_3",
    title: "Backend Engineer - Node.js",
    company: "CampusFlow",
    location: "Hyderabad",
    workMode: "hybrid",
    minExperience: 1,
    maxExperience: 3,
    degreeRequirements: ["B.Tech", "B.E."],
    skills: ["Node.js", "MongoDB", "Express", "REST APIs"],
    description: "Own backend workflows for university placement automation.",
    sourceType: "ashby",
    sourceUrl: "https://jobs.ashbyhq.com/campusflow/789",
    createdAt: "2026-05-17T08:15:00.000Z"
  },
  {
    id: "job_4",
    title: "AI Application Engineer",
    company: "SkillForge",
    location: "Pune",
    workMode: "onsite",
    minExperience: 0,
    maxExperience: 2,
    degreeRequirements: ["B.Tech", "B.E.", "M.Tech"],
    skills: ["Python", "APIs", "LLMs", "JavaScript"],
    description: "Build AI-assisted workflows for screening and application support.",
    sourceType: "aggregated_search",
    sourceUrl: "https://careers.skillforge.ai/jobs/ai-application-engineer",
    createdAt: "2026-05-18T16:20:00.000Z"
  }
];

export const seedSearchSessions: SearchSession[] = [
  {
    id: "session_1",
    studentId: "student_1",
    durationMinutes: 5,
    strictness: "balanced",
    startedAt: "2026-05-19T10:00:00.000Z",
    completedAt: "2026-05-19T10:05:00.000Z",
    resultJobIds: ["job_1", "job_2"],
    summary: "2 recommended jobs found from supported sources."
  }
];

export const seedApplications: Application[] = [
  {
    id: "application_1",
    studentId: "student_1",
    jobId: "job_1",
    status: "ready_for_review",
    sourceLabel: "Greenhouse",
    matchScore: 89,
    generatedArtifacts: {
      tailoredResumeSummary: "Highlighted React and Node.js coursework for internship-fit alignment.",
      coverLetterExcerpt: "I am excited to bring my frontend and API experience to LaunchGrid's hiring platform.",
      shortAnswers: [
        {
          question: "Why are you a fit for this role?",
          answer: "My coursework and projects center on React, Node.js, and building user-facing workflows."
        }
      ]
    },
    uploadedDocuments: ["aarav_resume_v3.pdf"],
    lastUpdatedAt: "2026-05-19T10:14:00.000Z",
    createdAt: "2026-05-19T10:10:00.000Z"
  }
];

export const seedApplicationRuns: ApplicationRun[] = [
  {
    id: "run_1",
    applicationId: "application_1",
    status: "needs_review",
    startedAt: "2026-05-19T10:10:00.000Z",
    adapterId: "aihawk-local",
    executionMode: "guided_autofill",
    workspacePath: "/Users/jaykumargupta/Codes/gradlaunch/storage/applications/application_1-launchgrid-software-engineer-intern",
    workspaceFiles: [
      "job_application.json",
      "run_trace.json",
      "job_description.json",
      "student_profile_snapshot.json",
      "short_answers.json",
      "README.txt"
    ],
    screenshots: ["launchgrid-review-step.png"],
    filledFields: [
      { label: "Full name", value: "Aarav Sharma" },
      { label: "Email", value: "aarav@example.com" },
      { label: "Location", value: "Bengaluru" }
    ],
    timeline: [
      {
        id: "adapter",
        label: "AIHawk adapter checked",
        detail: "Local AIHawk modules were detected, but the provider/apply engine is missing in this checkout.",
        state: "done",
        source: "aihawk"
      },
      {
        id: "profile",
        label: "Profile and resume loaded",
        detail: "Loaded the student profile and saved resume context.",
        state: "done",
        source: "gradlaunch"
      },
      {
        id: "review",
        label: "Review gate reached",
        detail: "Autofill values were prepared and paused for review before submission.",
        state: "attention",
        source: "aihawk"
      }
    ],
    notes: [
      "Latest resume used: aarav_resume_v3.pdf.",
      "Browser auto-apply is unavailable in this AIHawk checkout, so autofill stays review-first."
    ]
  }
];
