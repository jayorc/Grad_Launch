import type {
  AgentCapabilities,
  Application,
  Job,
  PlannerCheckpoint,
  PolicyAction,
  PolicyDecision,
  PolicyScope,
  StudentMemory,
  StudentProfile
} from "@gradlaunch/shared";
import { createId } from "../lib/id";
import { nowIso } from "../lib/time";

type ApplicationPolicyInput = {
  scope: PolicyScope;
  student: StudentProfile;
  job: Job;
  application: Application;
  memory?: StudentMemory;
  capabilities: AgentCapabilities;
  planner?: PlannerCheckpoint;
};

export class PolicyEngineService {
  evaluateApplicationAutonomy(input: ApplicationPolicyInput): PolicyDecision {
    const facts: string[] = [];
    const browserCapability = input.capabilities.capabilities.find((capability) => capability.id === "browser_apply");
    let action: PolicyAction = "allow";
    let confidence = 0.88;
    let reason = "Policy checks passed for autonomous execution.";

    facts.push(`automation_mode=${input.student.automationMode}`);
    facts.push(`job_source=${input.job.sourceType}`);
    facts.push(`match_score=${input.application.matchScore}`);
    facts.push(`browser_capability=${browserCapability?.status ?? "unknown"}`);
    facts.push(`planner_form_mode=${input.planner?.formMode ?? "unknown"}`);
    facts.push(`planner_last_action=${input.planner?.lastDecision?.kind ?? "none"}`);
    facts.push(`planner_stage_count=${input.planner?.stageHistory.length ?? 0}`);
    facts.push(`planner_retries=${input.planner?.retryCount ?? 0}`);
    facts.push(`planner_handoffs=${input.planner?.handoffCount ?? 0}`);

    if (input.student.automationMode !== "full_autopilot") {
      action = "review";
      confidence = 0.95;
      reason = "Student automation mode does not allow autonomous submission.";
    } else if (browserCapability?.status === "unavailable") {
      action = "review";
      confidence = 0.97;
      reason = "Browser execution is unavailable, so GradLaunch should stop at review instead of auto-submitting.";
    } else if (
      input.planner?.status === "handoff_required"
      || input.planner?.lastDecision?.kind === "wait_for_login"
      || input.planner?.lastDecision?.kind === "wait_for_captcha"
      || input.planner?.lastDecision?.kind === "wait_for_otp"
      || input.planner?.lastDecision?.kind === "wait_for_verification"
      || input.planner?.lastDecision?.kind === "wait_for_user_input"
    ) {
      action = "pause";
      confidence = 0.93;
      reason = input.planner?.lastDecision?.reason ?? "The saved planner state already indicates that human attention is required.";
    } else if (input.planner?.status === "needs_review" || input.planner?.lastDecision?.kind === "pause_for_review") {
      action = "review";
      confidence = 0.94;
      reason = input.planner?.summary ?? "The planner reached a review gate before autonomous submission.";
    } else if (input.planner?.validationErrors.length) {
      action = "review";
      confidence = 0.9;
      reason = "The planner still has unresolved validation errors for required fields.";
      facts.push(`validation_errors=${input.planner.validationErrors.join("|")}`);
    } else if ((input.planner?.retryCount ?? 0) >= 3) {
      action = "review";
      confidence = 0.88;
      reason = "The planner needed too many retries on the same application path, so GradLaunch should stop for review.";
    } else if ((input.planner?.handoffCount ?? 0) >= 2) {
      action = "pause";
      confidence = 0.9;
      reason = "The planner has already needed multiple manual handoffs on this run.";
    } else if (input.application.matchScore < 55) {
      action = "review";
      confidence = 0.78;
      reason = "The match score is too low for fully autonomous submission.";
    } else if (input.job.sourceType === "manual_url" && input.scope !== "plan_application") {
      action = "review";
      confidence = 0.81;
      reason = "Direct manual URLs should be reviewed before high-impact execution.";
    }

    if (input.memory?.blockedSourceTypes.includes(input.job.sourceType)) {
      action = action === "allow" ? "review" : action;
      confidence = Math.max(confidence, 0.84);
      facts.push(`memory_blocked_source=${input.job.sourceType}`);
      reason = action === "review"
        ? "Past failures on similar source types suggest a review gate before execution."
        : reason;
    }

    return {
      id: createId("policy"),
      studentId: input.student.id,
      applicationId: input.application.id,
      scope: input.scope,
      action,
      reason,
      confidence,
      facts,
      createdAt: nowIso()
    };
  }
}
