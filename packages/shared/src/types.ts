export type MatchStrictness = "broad" | "balanced" | "strict";
export type AutomationMode = "alerts_only" | "draft_and_review" | "autofill_with_review" | "full_autopilot";
export type WorkMode = "remote" | "hybrid" | "onsite";
export type JobSourceType = "greenhouse" | "lever" | "ashby" | "manual_url" | "aggregated_search";
export type ApplicationStatus =
  | "queued"
  | "running"
  | "draft_ready"
  | "autofilled"
  | "ready_for_review"
  | "submitted"
  | "blocked"
  | "failed";
export type RunStatus = "queued" | "running" | "needs_review" | "completed" | "blocked" | "failed";
export type AgentSurface = "gradlaunch" | "aihawk";
export type AgentCapabilityStatus = "available" | "partial" | "unavailable";
export type AgentStepState = "done" | "running" | "queued" | "attention";
export type ApplicationExecutionMode = "draft_package" | "guided_autofill" | "browser_apply" | "autonomous_apply";
export type SubmissionIntent = "browser_fill" | "review_submit" | "auto_submit";
export type SubmissionOutcome = "confirmed" | "blocked";
export type EmailDeliveryStatus = "sent" | "queued" | "skipped" | "failed";
export type BrowserApplyStatus = "filled" | "submitted" | "needs_manual_review" | "handoff_required" | "blocked";
export type PlannerStatus = "idle" | "running" | "handoff_required" | "needs_review" | "completed" | "blocked";
export type PlannerTaskStatus = "pending" | "running" | "completed" | "blocked" | "needs_user" | "retrying" | "skipped";

export interface StudentProfile {
  id: string;
  fullName: string;
  email: string;
  degree: string;
  graduationYear: number;
  targetRoles: string[];
  preferredLocations: string[];
  workModes: WorkMode[];
  skills: string[];
  expectedSalaryLpa?: number;
  visaRequired: boolean;
  automationMode: AutomationMode;
  defaultStrictness: MatchStrictness;
  bio?: string;
  avatarUrl?: string;
  resumeId?: string;
}

export interface StudentAccount {
  id: string;
  studentId: string;
  email: string;
  password: string;
  passwordHash?: string;
  createdAt: string;
}

export interface UserSession {
  id: string;
  studentId: string;
  email: string;
  token: string;
  createdAt: string;
  expiresAt: string;
}

export interface Job {
  id: string;
  title: string;
  company: string;
  location: string;
  workMode: WorkMode;
  minExperience: number;
  maxExperience: number;
  degreeRequirements: string[];
  skills: string[];
  description: string;
  sourceType: JobSourceType;
  sourceUrl: string;
  createdAt: string;
}

export interface SearchSession {
  id: string;
  studentId: string;
  durationMinutes: number;
  strictness: MatchStrictness;
  startedAt: string;
  completedAt: string;
  resultJobIds: string[];
  summary: string;
}

export interface GeneratedArtifacts {
  tailoredResumeSummary: string;
  coverLetterExcerpt: string;
  shortAnswers: Array<{
    question: string;
    answer: string;
  }>;
}

export interface FilledField {
  label: string;
  value: string;
}

export interface AgentTimelineStep {
  id: string;
  label: string;
  detail: string;
  state: AgentStepState;
  source: AgentSurface;
  timestamp?: string;
}

export interface AgentCapability {
  id: string;
  label: string;
  status: AgentCapabilityStatus;
  source: AgentSurface;
  detail: string;
}

export interface AgentCapabilities {
  adapterId: string;
  adapterLabel: string;
  repoDetected: boolean;
  repoPath?: string;
  pythonAvailable: boolean;
  capabilities: AgentCapability[];
  limitations: string[];
}

export interface EmailDelivery {
  status: EmailDeliveryStatus;
  provider: "nodemailer" | "outbox";
  to: string;
  subject: string;
  sentAt?: string;
  message?: string;
}

export interface ApplicationSubmission {
  intent: SubmissionIntent;
  outcome: SubmissionOutcome;
  externalSubmitted: boolean;
  confirmation: string;
  submittedAt: string;
  email: EmailDelivery;
  browser?: BrowserApplyReceipt;
}

export interface BrowserApplyReceipt {
  status: BrowserApplyStatus;
  sourceUrl: string;
  openedAt: string;
  completedAt: string;
  filledLabels: string[];
  skippedLabels: string[];
  screenshots: string[];
  message: string;
  planner?: PlannerCheckpoint;
}

export interface PlannerTask {
  id: string;
  label: string;
  status: PlannerTaskStatus;
  detail: string;
  attempts: number;
  lastUpdatedAt: string;
  completedAt?: string;
}

export interface PlannerCheckpoint {
  sessionId: string;
  resumeToken: string;
  goal: string;
  status: PlannerStatus;
  summary: string;
  currentStep?: string;
  currentStageLabel?: string;
  currentUrl?: string;
  retryCount: number;
  handoffCount: number;
  validationErrors: string[];
  subgoals: PlannerTask[];
  lastUpdatedAt: string;
}

export interface ApplicationRun {
  id: string;
  applicationId: string;
  status: RunStatus;
  startedAt: string;
  completedAt?: string;
  adapterId: string;
  executionMode: ApplicationExecutionMode;
  workspacePath?: string;
  workspaceFiles: string[];
  screenshots: string[];
  blockedReason?: string;
  filledFields: FilledField[];
  timeline: AgentTimelineStep[];
  notes: string[];
  planner?: PlannerCheckpoint;
  submission?: ApplicationSubmission;
}

export interface Application {
  id: string;
  studentId: string;
  jobId: string;
  status: ApplicationStatus;
  sourceLabel: string;
  matchScore: number;
  generatedArtifacts: GeneratedArtifacts;
  uploadedDocuments: string[];
  lastUpdatedAt: string;
  createdAt: string;
}

export interface DashboardMetric {
  label: string;
  value: number;
  hint: string;
}

export interface DashboardApplicationRow {
  applicationId: string;
  company: string;
  role: string;
  source: string;
  matchScore: number;
  status: ApplicationStatus;
  lastUpdatedAt: string;
}

export interface DashboardReport {
  studentId: string;
  metrics: DashboardMetric[];
  recentApplications: DashboardApplicationRow[];
  pendingActions: string[];
}

export interface Recommendation {
  job: Job;
  score: number;
  reasons: string[];
}

export interface StartSearchSessionInput {
  studentId: string;
  durationMinutes: number;
  strictness: MatchStrictness;
}

export interface IntakeJobUrlInput {
  studentId: string;
  jobUrl: string;
}

export interface CreateApplicationInput {
  studentId: string;
  jobId: string;
  mode: "draft" | "autofill" | "autopilot";
}

export interface SubmitApplicationInput {
  applicationId: string;
  studentId: string;
  intent: SubmissionIntent;
  reviewedFields: FilledField[];
  confirmExternalSubmit?: boolean;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface RegisterInput {
  fullName: string;
  email: string;
  password: string;
  degree: string;
  graduationYear: number;
  targetRoles: string[];
  preferredLocations: string[];
  skills: string[];
}

export interface UpdateProfileInput {
  fullName: string;
  degree: string;
  graduationYear: number;
  targetRoles: string[];
  preferredLocations: string[];
  workModes: WorkMode[];
  skills: string[];
  expectedSalaryLpa?: number;
  visaRequired: boolean;
  automationMode: AutomationMode;
  defaultStrictness: MatchStrictness;
  bio?: string;
}

export interface AuthResponse {
  session: UserSession;
  student: StudentProfile;
}

export interface ResumeRecord {
  id: string;
  studentId?: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  extractedText?: string;
  uploadedAt: string;
}

export interface ResumeProfileDraft {
  fullName: string;
  email: string;
  degree: string;
  graduationYear?: number;
  targetRoles: string[];
  preferredLocations: string[];
  skills: string[];
  bio?: string;
}

export interface ResumeDraftResponse {
  resume: ResumeRecord;
  draft: ResumeProfileDraft;
}

export interface SearchSessionResult {
  session: SearchSession;
  recommendations: Recommendation[];
  activity: AgentTimelineStep[];
  capabilities: AgentCapabilities;
}

export interface CreateApplicationResult {
  application: Application;
  run: ApplicationRun;
  capabilities: AgentCapabilities;
}

export interface SubmitApplicationResult {
  application: Application;
  run: ApplicationRun;
  capabilities: AgentCapabilities;
}
