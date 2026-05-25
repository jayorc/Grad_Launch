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
import type { Page } from "./browser-driver";
import { nowIso } from "../../lib/time";
import { dedupeLabels } from "./util";

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

export function setPlannerStatus(planner: PlannerCheckpoint, status: PlannerCheckpoint["status"], summary: string) {
  planner.status = status;
  planner.summary = summary;
  planner.lastUpdatedAt = nowIso();
}

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

function updatePlannerFormMode(planner: PlannerCheckpoint, stageIndex: number) {
  if (stageIndex > 0) {
    planner.formMode = "multi_stage";
  } else if (planner.formMode === "unknown") {
    planner.formMode = "single_stage";
  }
}

function clonePlannerDecision(decision: PlannerDecision): PlannerDecision {
  return {
    ...decision,
    fieldLabels: [...decision.fieldLabels]
  };
}

function clonePlannerStage(stage: PlannerStageSnapshot): PlannerStageSnapshot {
  return {
    ...stage,
    visibleFieldLabels: [...stage.visibleFieldLabels],
    requiredFieldLabels: [...stage.requiredFieldLabels],
    filledFieldLabels: [...stage.filledFieldLabels],
    decision: stage.decision ? clonePlannerDecision(stage.decision) : undefined
  };
}
