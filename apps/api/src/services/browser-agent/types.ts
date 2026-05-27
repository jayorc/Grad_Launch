import type {
  AgentHandoffKind,
  BrowserExecutionSession,
  BrowserStageSignature,
  FilledField,
  Job,
  PlannerCheckpoint,
  PlannerDecisionSource,
  ResumeRecord,
  StudentMemory,
  StudentProfile
} from "@gradlaunch/shared";
import type { BrowserContext, Page } from "./browser-driver";

export type BrowserApplyInput = {
  studentId?: string;
  applicationId?: string;
  runId?: string;
  executionSessionId?: string;
  job: Job;
  fields: FilledField[];
  workspacePath?: string;
  resume?: ResumeRecord;
  student?: StudentProfile;
  memory?: StudentMemory;
  submit: boolean;
  planner?: PlannerCheckpoint;
};

export type BrowserAvailability = {
  available: boolean;
  chromePath?: string;
  message: string;
};

export type VisibleField = {
  id: string;
  label: string;
  required: boolean;
  tagName: string;
  inputType: string;
  options: string[];
  context: string;
  maxLength?: number;
  name?: string;
  placeholder?: string;
  autocomplete?: string;
  ariaLabel?: string;
  ariaDescribedBy?: string;
  pattern?: string;
  inputMode?: string;
  sectionLabel?: string;
  helpText?: string;
  labelSource?: string;
  domPathSignature?: string;
};

export type ObservedControl = {
  id: string;
  text: string;
  tagName: string;
  role: string;
  inputType: string;
  label: string;
  disabled: boolean;
};

export type BrowserPageState =
  | "start"
  | "resume_upload"
  | "login"
  | "captcha"
  | "loading"
  | "validation_error"
  | "form_fill"
  | "questionnaire"
  | "consent"
  | "review"
  | "submit"
  | "account_gate"
  | "blocked"
  | "empty"
  | "unknown";

export type BrowserFieldGroup = {
  label: string;
  fieldIds: string[];
  fieldLabels: string[];
  required: boolean;
};

export type AtsAdapterHint = {
  id: string;
  label: string;
};

export type BrowserAgentObservation = {
  url: string;
  title: string;
  pageText: string;
  visibleFields: VisibleField[];
  controls: ObservedControl[];
  pageState: BrowserPageState;
  validationMessages: string[];
  groupedFields: BrowserFieldGroup[];
  adapter?: AtsAdapterHint;
};

export type StageReadinessSignals = {
  outstandingRequired: string[];
  validationMessages: string[];
  uploadVisible: boolean;
  submitVisible: boolean;
};

export type StagePageSnapshot = {
  visibleFields: VisibleField[];
  observation: BrowserAgentObservation;
} & StageReadinessSignals;

export type NavigationCandidate = {
  id: string;
  label: string;
  role: string;
  score: number;
  strategy: "role_button" | "role_link" | "dom_control";
};

export type TransitionWaitResult = {
  changed: boolean;
  activePage: Page;
  reason: string;
  signatureBefore: BrowserStageSignature;
  signatureAfter: BrowserStageSignature;
  outcome: "advanced" | "review_ready" | "submit_ready" | "same_stage";
};

export type BrowserExecutionSessionState = BrowserExecutionSession;

export type BrowserAgentAction =
  | { kind: "fill"; reason: string; source: PlannerDecisionSource }
  | { kind: "click_next"; reason: string; source: PlannerDecisionSource }
  | { kind: "upload_resume"; reason: string; source: PlannerDecisionSource }
  | { kind: "submit"; reason: string; source: PlannerDecisionSource }
  | { kind: "ask_user"; fields: string[]; reason: string; source: PlannerDecisionSource }
  | { kind: "stop"; reason: string; source: PlannerDecisionSource };

export type AutonomousActionKind = BrowserAgentAction["kind"] | "wait" | "explore";

export type BrowserFillField = FilledField & {
  fieldId?: string;
  inputType?: string;
  options?: string[];
  required?: boolean;
  reason?: string;
};

export type StageAnswerPlan = {
  answers: BrowserFillField[];
  unresolvedRequiredLabels: string[];
  usedLlm: boolean;
  summary?: string;
};

export type StageExecutionPlan = {
  action: AutonomousActionKind;
  confidence: number;
  reason: string;
  checklist: string[];
  classification?: PageClassification;
  rankedActions?: ActionScore[];
};

export type PageClassification = {
  state: BrowserPageState;
  confidence: number;
  blocking: boolean;
  reasons: string[];
};

export type ActionScore = {
  action: AutonomousActionKind;
  score: number;
  reasons: string[];
};

export type RecoveryErrorKind =
  | "missing_required"
  | "format_error"
  | "network_delay"
  | "blocked_by_modal"
  | "captcha"
  | "login_gate"
  | "duplicate_submission"
  | "unknown_validation"
  | "dynamic_field_not_loaded"
  | "navigation_failed"
  | "resume_upload_missing"
  | "none";

export type RecoveryPlan = {
  kind: RecoveryErrorKind;
  confidence: number;
  reason: string;
  actions: Array<
    | "wait"
    | "re-scan-fields"
    | "retry-fill"
    | "retry-upload"
    | "resolve-known-choice"
    | "inspect-validation"
    | "explore-page"
    | "ask-user"
  >;
};

export type StageEvaluation = {
  status: "ready_to_continue" | "needs_retry" | "needs_user" | "ready_for_review" | "ready_to_submit";
  confidence: number;
  reason: string;
  missingRequiredLabels: string[];
  validationMessages: string[];
  suggestedAction: "fill" | "click_next" | "ask_user" | "submit" | "stop";
};

export type StageReflectionResult = {
  answers: BrowserFillField[];
  summary: string;
  improved: boolean;
};

export type ProtectedCheckpointDetection = {
  blocked: boolean;
  kind?: "captcha" | "login" | "otp" | "verification";
  reason?: string;
};

export type HumanInterventionWaitResult = {
  resolved: boolean;
  activePage: Page;
};

export type StageExecutionContext = {
  context: BrowserContext;
  page: Page;
  workspacePath: string;
  screenshots: string[];
};

export type HandoffRequest = {
  context: BrowserContext;
  page: Page;
  stageIndex: number;
  workspacePath: string;
  screenshots: string[];
  planner: PlannerCheckpoint;
  reason: string;
  handoffKind?: AgentHandoffKind;
  watchFields?: string[];
};
