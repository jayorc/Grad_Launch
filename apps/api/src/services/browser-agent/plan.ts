import type { StageExecutionPlan } from "./types";
import type { BrowserAgentObservation } from "./types";
import { classifyPage, rankActions } from "./strategy";

type BuildStageExecutionPlanInput = {
  observation: BrowserAgentObservation;
  resumeAvailable: boolean;
  submitRequested: boolean;
  allowExternalSubmit: boolean;
};

// Builds the action plan for one visible browser stage. It combines page
// classification with ranked actions, then downgrades uncertain actions to
// safe exploration or user handoff instead of guessing.
export function buildStageExecutionPlan(input: BuildStageExecutionPlanInput): StageExecutionPlan {
  const classification = classifyPage(input.observation);
  const rankedActions = rankActions({
    observation: input.observation,
    classification,
    resumeAvailable: input.resumeAvailable,
    submitRequested: input.submitRequested,
    allowExternalSubmit: input.allowExternalSubmit
  });
  const best = rankedActions[0];

  if (!best || best.score < 50) {
    return {
      action: "ask_user",
      confidence: 0.49,
      reason: "The current page is too ambiguous for safe autonomous action.",
      checklist: ["Pause rather than guess.", "Ask the student to expose the application form or review the page."],
      classification,
      rankedActions
    };
  }

  const action = best.score >= 80
    ? best.action
    : best.action === "fill"
      ? "fill"
      : "explore";

  return {
    action,
    confidence: Math.min(best.score / 100, 0.99),
    reason: buildPlanReason(classification, best),
    checklist: buildChecklist(action),
    classification,
    rankedActions
  };
}

// Produces the human-readable reason stored in the planner/debug trace so we
// can later understand why a stage was filled, explored, paused, or uploaded.
function buildPlanReason(
  classification: ReturnType<typeof classifyPage>,
  best: ReturnType<typeof rankActions>[number]
) {
  return [
    `Classified page as ${classification.state} (${Math.round(classification.confidence * 100)}% confidence).`,
    ...best.reasons
  ].join(" ");
}

// Lists the safety checks expected for each selected action. The checklist is
// used by the planner/UI to explain what the bot is about to do.
function buildChecklist(action: StageExecutionPlan["action"]) {
  switch (action) {
    case "ask_user":
      return ["Pause automation.", "Wait for explicit user confirmation before filling resumes."];
    case "wait":
      return ["Wait for transient loading/status text to clear.", "Re-scan the page before taking action."];
    case "explore":
      return ["Probe safely by waiting, dismissing soft gates, and scrolling.", "Re-observe before clicking navigation."];
    case "upload_resume":
      return ["Attach the latest resume.", "Verify upload or wait for the next stage before continuing."];
    case "fill":
      return ["Fill visible fields from trusted profile/resume facts.", "Verify actual DOM state before navigating."];
    case "click_next":
      return ["Only click a high-confidence next/continue control.", "Do not use final submit unless policy allows it."];
    case "submit":
      return ["Confirm final submit policy.", "Submit only when explicitly allowed."];
    case "stop":
    default:
      return ["Pause at review/submit checkpoint.", "Keep the browser open for user review."];
  }
}
