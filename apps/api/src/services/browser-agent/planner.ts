import type {
  AgentHandoffKind,
  Job,
  PlannerActionKind,
  PlannerCheckpoint,
  PlannerDecision,
  PlannerDecisionSource,
  PlannerStageOutcome,
  PlannerStageSnapshot,
  PlannerTask
} from "@gradlaunch/shared";
import type { Page } from "playwright-core";
import { nowIso } from "../../lib/time";
import { dedupeLabels } from "./util";

// Creates a fresh planner checkpoint or safely clones an existing one for a
// resumed run. The planner is the durable explanation of the browser agent's
// goal, current stage, retries, handoffs, decisions, and validation blockers.
export function createPlannerCheckpoint(job: Job, existing?: PlannerCheckpoint): PlannerCheckpoint {
  if (existing) {
    return {
      ...existing,
      formMode: existing.formMode ?? "unknown",
      subgoals: existing.subgoals.map((task) => ({ ...task })),
      validationErrors: [...existing.validationErrors],
      lastDecision: existing.lastDecision ? clonePlannerDecision(existing.lastDecision) : undefined,
      stageHistory: Array.isArray(existing.stageHistory) ? existing.stageHistory.map(clonePlannerStage) : []
    };
  }

  const now = nowIso();
  return {
    sessionId: `planner-${job.id}`,
    resumeToken: `${job.id}:${now}`,
    goal: `Complete the ${job.title} application at ${job.company} autonomously until a protected or review checkpoint.`,
    status: "idle",
    summary: "Planner is ready to start the application flow.",
    formMode: "unknown",
    retryCount: 0,
    handoffCount: 0,
    validationErrors: [],
    subgoals: [
      createPlannerTask("open_job_page", "Open job page", now),
      createPlannerTask("authenticate_if_needed", "Handle login if needed", now),
      createPlannerTask("finish_current_section", "Finish active section", now),
      createPlannerTask("recover_from_validation_errors", "Recover from validation errors", now),
      createPlannerTask("retry_alternative_path", "Retry alternative path", now),
      createPlannerTask("reach_submit_gate", "Reach submit/review gate", now),
      createPlannerTask("save_checkpoint", "Save checkpoint", now)
    ],
    stageHistory: [],
    lastUpdatedAt: now
  };
}

// Updates one planner subgoal with status, detail, attempts, and completion
// time. The engine calls this whenever a major browser task starts or finishes.
export function markPlannerTask(planner: PlannerCheckpoint, id: string, status: PlannerTask["status"], detail: string) {
  const now = nowIso();
  const task = planner.subgoals.find((item) => item.id === id);

  if (!task) {
    return;
  }

  task.status = status;
  task.detail = detail;
  task.lastUpdatedAt = now;

  if (status === "running" || status === "retrying" || status === "needs_user" || status === "blocked") {
    task.attempts += 1;
  }

  if (status === "completed") {
    task.completedAt = now;
  }

  planner.lastUpdatedAt = now;
}

// Sets the high-level planner status/summary shown in receipts, saved sessions,
// and live UI state.
export function setPlannerStatus(planner: PlannerCheckpoint, status: PlannerCheckpoint["status"], summary: string) {
  planner.status = status;
  planner.summary = summary;
  planner.lastUpdatedAt = nowIso();
}

// Marks the beginning of a form stage and ensures the stage has a history entry
// before observation/fill decisions are recorded.
export function plannerEnterStage(planner: PlannerCheckpoint, page: Page, stageIndex: number) {
  planner.currentStep = `stage_${stageIndex + 1}`;
  planner.currentStageLabel = `Section ${stageIndex + 1}`;
  planner.currentUrl = page.url();
  updatePlannerFormMode(planner, stageIndex);
  ensurePlannerStage(planner, page, stageIndex);
  planner.lastUpdatedAt = nowIso();
  markPlannerTask(planner, "finish_current_section", "running", `Reading ${planner.currentStageLabel} and planning the next safe action.`);
  setPlannerStatus(planner, "running", `Planner is working through ${planner.currentStageLabel}.`);
}

// Records that the current section advanced successfully and updates planner
// state so the next loop iteration starts on the following stage.
export function completePlannerStage(planner: PlannerCheckpoint, page: Page, stageIndex: number) {
  recordPlannerStageOutcome({
    planner,
    page,
    stageIndex,
    outcome: "advanced"
  });
  planner.currentStep = `stage_${stageIndex + 2}`;
  planner.currentStageLabel = `Section ${stageIndex + 2}`;
  planner.currentUrl = page.url();
  planner.lastUpdatedAt = nowIso();
  markPlannerTask(planner, "finish_current_section", "completed", `Completed Section ${stageIndex + 1} and advanced to the next stage.`);
  markPlannerTask(planner, "save_checkpoint", "completed", `Saved checkpoint after Section ${stageIndex + 1}.`);
  setPlannerStatus(planner, "running", `Section ${stageIndex + 1} completed. Moving to the next stage.`);
}

// Saves the visible and required field labels seen on the current page. This is
// the trace used to understand what the agent thought was fillable.
export function recordPlannerObservation(input: {
  planner: PlannerCheckpoint;
  page: Page;
  stageIndex: number;
  visibleFieldLabels?: string[];
  requiredFieldLabels?: string[];
}) {
  const stage = ensurePlannerStage(input.planner, input.page, input.stageIndex);
  updatePlannerFormMode(input.planner, input.stageIndex);
  stage.visibleFieldLabels = dedupeLabels([...(input.visibleFieldLabels ?? [])]);
  stage.requiredFieldLabels = dedupeLabels([...(input.requiredFieldLabels ?? [])]);
  stage.url = input.page.url();
  stage.lastUpdatedAt = nowIso();
  input.planner.lastUpdatedAt = stage.lastUpdatedAt;
}

// Stores the selected action, source, reason, and affected fields for a stage.
// This answers "why did the bot choose this action?" in debug output.
export function recordPlannerDecision(input: {
  planner: PlannerCheckpoint;
  page: Page;
  stageIndex: number;
  kind: PlannerActionKind;
  source: PlannerDecisionSource;
  reason: string;
  fieldLabels?: string[];
}) {
  const stage = ensurePlannerStage(input.planner, input.page, input.stageIndex);
  const decision: PlannerDecision = {
    kind: input.kind,
    source: input.source,
    stageIndex: input.stageIndex,
    stageLabel: stage.label,
    url: input.page.url(),
    reason: input.reason,
    fieldLabels: dedupeLabels(input.fieldLabels ?? []),
    createdAt: nowIso()
  };

  stage.decision = decision;
  stage.lastUpdatedAt = decision.createdAt;
  input.planner.lastDecision = decision;
  input.planner.currentUrl = decision.url;
  input.planner.currentStageLabel = stage.label;
  input.planner.lastUpdatedAt = decision.createdAt;
}

// Records the result of a stage such as advanced, review, submit, or handoff,
// including fields that were filled or still required.
export function recordPlannerStageOutcome(input: {
  planner: PlannerCheckpoint;
  page: Page;
  stageIndex: number;
  outcome: PlannerStageOutcome;
  filledFieldLabels?: string[];
  requiredFieldLabels?: string[];
}) {
  const stage = ensurePlannerStage(input.planner, input.page, input.stageIndex);
  stage.outcome = input.outcome;
  stage.url = input.page.url();
  stage.filledFieldLabels = dedupeLabels([...stage.filledFieldLabels, ...(input.filledFieldLabels ?? [])]);
  stage.requiredFieldLabels = dedupeLabels([...stage.requiredFieldLabels, ...(input.requiredFieldLabels ?? [])]);
  stage.lastUpdatedAt = nowIso();
  input.planner.lastUpdatedAt = stage.lastUpdatedAt;
}

// Records a manual handoff event and updates planner status/tasks so the run is
// resumable after login, CAPTCHA, OTP, missing data, or review.
export function notePlannerHandoff(
  planner: PlannerCheckpoint,
  reason: string,
  page: Page,
  stageIndex: number,
  handoffKind: AgentHandoffKind
) {
  planner.handoffCount += 1;
  planner.currentUrl = page.url();
  planner.currentStageLabel = `Section ${stageIndex + 1}`;
  recordPlannerDecision({
    planner,
    page,
    stageIndex,
    kind: plannerActionFromHandoffKind(handoffKind),
    source: "system",
    reason
  });
  recordPlannerStageOutcome({
    planner,
    page,
    stageIndex,
    outcome: "handoff"
  });
  markPlannerTask(planner, "authenticate_if_needed", "needs_user", reason);
  markPlannerTask(planner, "save_checkpoint", "completed", "Saved checkpoint before handing control to the student.");
  setPlannerStatus(planner, "handoff_required", reason);
}

// Records unresolved required/validation labels and marks the planner as
// needing review instead of allowing blind navigation.
export function recordPlannerValidation(planner: PlannerCheckpoint, labels: string[]) {
  planner.validationErrors = dedupeLabels([...planner.validationErrors, ...labels]);
  markPlannerTask(
    planner,
    "recover_from_validation_errors",
    "blocked",
    `Validation or required-answer blockers were found: ${labels.join(", ")}.`
  );
  setPlannerStatus(planner, "needs_review", `Planner stopped because required inputs still need attention: ${labels.join(", ")}.`);
}

// Increments retry counters and records the reason an alternative path or
// validation-recovery attempt was needed.
export function bumpPlannerRetries(planner: PlannerCheckpoint, taskId: string, detail: string, page?: Page, stageIndex?: number) {
  planner.retryCount += 1;
  markPlannerTask(planner, taskId, "retrying", detail);

  if (page && typeof stageIndex === "number") {
    recordPlannerDecision({
      planner,
      page,
      stageIndex,
      kind: taskId === "recover_from_validation_errors" ? "recover_validation" : "recover_same_screen",
      source: "system",
      reason: detail
    });
  }

  setPlannerStatus(planner, "running", detail);
}

// Maps a UI/user handoff type into the planner action taxonomy used for stage
// decisions and saved trace data.
export function plannerActionFromHandoffKind(kind: AgentHandoffKind): PlannerActionKind {
  switch (kind) {
    case "login":
      return "wait_for_login";
    case "captcha":
      return "wait_for_captcha";
    case "otp":
      return "wait_for_otp";
    case "verification":
      return "wait_for_verification";
    case "missing_data":
      return "wait_for_user_input";
    case "review":
    case "policy":
      return "pause_for_review";
    default:
      return "wait_for_user_input";
  }
}

// Maps browser execution actions into planner action names so strategy output,
// debug logs, and planner history use one consistent vocabulary.
export function plannerActionFromBrowserAction(kind: "fill" | "click_next" | "upload_resume" | "submit" | "ask_user" | "stop"): PlannerActionKind {
  switch (kind) {
    case "fill":
      return "fill_fields";
    case "click_next":
      return "navigate_next";
    case "upload_resume":
      return "upload_resume";
    case "submit":
      return "submit_application";
    case "ask_user":
      return "wait_for_user_input";
    case "stop":
    default:
      return "pause_for_review";
  }
}

// Creates one initial planner task with pending status for the checkpoint's
// fixed set of subgoals.
function createPlannerTask(id: string, label: string, timestamp: string): PlannerTask {
  return {
    id,
    label,
    status: "pending",
    detail: "Waiting to start.",
    attempts: 0,
    lastUpdatedAt: timestamp
  };
}

// Finds or creates the stage-history row for the current browser stage.
function ensurePlannerStage(planner: PlannerCheckpoint, page: Page, stageIndex: number) {
  const label = `Section ${stageIndex + 1}`;
  const existingStage = planner.stageHistory.find((stage) => stage.stageIndex === stageIndex);

  if (existingStage) {
    existingStage.label = label;
    existingStage.url = page.url();
    existingStage.lastUpdatedAt = nowIso();
    return existingStage;
  }

  const stage: PlannerStageSnapshot = {
    stageIndex,
    label,
    url: page.url(),
    visibleFieldLabels: [],
    requiredFieldLabels: [],
    filledFieldLabels: [],
    outcome: "observed",
    lastUpdatedAt: nowIso()
  };
  planner.stageHistory.push(stage);
  planner.lastUpdatedAt = stage.lastUpdatedAt;
  return stage;
}

// Updates the planner's single-stage/multi-stage hint based on how many stages
// the engine has visited.
function updatePlannerFormMode(planner: PlannerCheckpoint, stageIndex: number) {
  if (stageIndex > 0) {
    planner.formMode = "multi_stage";
  } else if (planner.formMode === "unknown") {
    planner.formMode = "single_stage";
  }
}

// Deep-clones a planner decision so resumed runs do not mutate old checkpoint
// objects by reference.
function clonePlannerDecision(decision: PlannerDecision): PlannerDecision {
  return {
    ...decision,
    fieldLabels: [...decision.fieldLabels]
  };
}

// Deep-clones a planner stage snapshot, including its nested decision object,
// for safe reuse in resumed checkpoints.
function clonePlannerStage(stage: PlannerStageSnapshot): PlannerStageSnapshot {
  return {
    ...stage,
    visibleFieldLabels: [...stage.visibleFieldLabels],
    requiredFieldLabels: [...stage.requiredFieldLabels],
    filledFieldLabels: [...stage.filledFieldLabels],
    decision: stage.decision ? clonePlannerDecision(stage.decision) : undefined
  };
}
