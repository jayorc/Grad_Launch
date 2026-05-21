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
export type AgentGoalType = "autonomous_application" | "job_discovery";
export type AgentGoalStatus = "queued" | "running" | "waiting" | "completed" | "blocked" | "failed" | "cancelled";
export type AgentWorkerType =
  | "discovery"
  | "intake"
  | "ranking"
  | "drafting"
  | "application_planner"
  | "browser_executor"
  | "recovery"
  | "notifications";
export type AgentTaskKind =
  | "refresh_job_discovery"
  | "intake_job_url"
  | "rank_application"
  | "prepare_application_draft"
  | "plan_application"
  | "execute_browser_apply"
  | "recover_autonomy"
  | "send_notification";
export type AgentTaskStatus = "queued" | "running" | "waiting" | "completed" | "blocked" | "failed" | "cancelled";
export type AgentHandoffKind = "login" | "otp" | "captcha" | "verification" | "review" | "missing_data" | "policy";
export type AgentHandoffStatus = "open" | "resolved" | "expired";
export type PolicyAction = "allow" | "review" | "pause" | "block";
export type PolicyScope = "plan_application" | "execute_browser_apply" | "submit_application";
export type TaskRunStatus = "running" | "completed" | "failed" | "cancelled";
export type AgentEventType =
  | "goal.created"
  | "goal.updated"
  | "task.queued"
  | "task.started"
  | "task.completed"
  | "task.failed"
  | "task.waiting"
  | "handoff.created"
  | "handoff.resolved"
  | "policy.decided"
  | "memory.updated";

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

export interface AgentGoal {
  id: string;
  studentId: string;
  applicationId?: string;
  type: AgentGoalType;
  status: AgentGoalStatus;
  title: string;
  summary: string;
  currentTaskId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AgentTask {
  id: string;
  goalId: string;
  studentId: string;
  applicationId?: string;
  workerType: AgentWorkerType;
  kind: AgentTaskKind;
  status: AgentTaskStatus;
  title: string;
  priority: number;
  payload: Record<string, unknown>;
  result?: Record<string, unknown>;
  runAfter: string;
  attemptCount: number;
  maxAttempts: number;
  leasedTo?: string;
  leaseExpiresAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AgentTaskRun {
  id: string;
  taskId: string;
  workerType: AgentWorkerType;
  status: TaskRunStatus;
  leaseOwner: string;
  summary: string;
  errorMessage?: string;
  inputSnapshot?: Record<string, unknown>;
  outputSnapshot?: Record<string, unknown>;
  startedAt: string;
  completedAt?: string;
}

export interface AgentHandoff {
  id: string;
  goalId: string;
  studentId: string;
  taskId?: string;
  applicationId?: string;
  status: AgentHandoffStatus;
  kind: AgentHandoffKind;
  title: string;
  detail: string;
  requestedAt: string;
  resolvedAt?: string;
}

export interface PolicyDecision {
  id: string;
  studentId: string;
  applicationId?: string;
  taskId?: string;
  scope: PolicyScope;
  action: PolicyAction;
  reason: string;
  confidence: number;
  facts: string[];
  createdAt: string;
}

export interface StudentMemory {
  studentId: string;
  successfulApplicationCount: number;
  blockedSourceTypes: string[];
  recentHandoffKinds: AgentHandoffKind[];
  corrections: Array<{
    label: string;
    value: string;
    updatedAt: string;
  }>;
  notes: string[];
  lastUpdatedAt: string;
}

export interface AgentEvent {
  id: string;
  studentId: string;
  type: AgentEventType;
  message: string;
  goalId?: string;
  taskId?: string;
  applicationId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
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

export interface AgentControlPlaneSnapshot {
  goals: AgentGoal[];
  tasks: AgentTask[];
  handoffs: AgentHandoff[];
  recentEvents: AgentEvent[];
  memory?: StudentMemory;
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
