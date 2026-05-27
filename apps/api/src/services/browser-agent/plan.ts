import type { StageEvaluation, StageExecutionPlan, VisibleField } from "./types";
import type { BrowserAgentObservation } from "./types";
import { classifyPage, rankActions } from "./strategy";
import { isTransientStatusMessage } from "./util";

type BuildStageExecutionPlanInput = {
  observation: BrowserAgentObservation;
  resumeAvailable: boolean;
  submitRequested: boolean;
  allowExternalSubmit: boolean;
};

type EvaluateStageInput = {
  visibleFields: VisibleField[];
  outstandingRequired: string[];
  validationMessages: string[];
  submitVisible: boolean;
  submitRequested: boolean;
  allowExternalSubmit: boolean;
};

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
      : best.action === "click_next" && best.score >= 72
        ? "click_next"
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

export function evaluateStageReadiness(input: EvaluateStageInput): StageEvaluation {
  const validationMessages = input.validationMessages.filter((message) => !isTransientStatusMessage(message));

  if (validationMessages.length > 0) {
    return {
      status: "needs_retry",
      confidence: 0.96,
      reason: `Validation blockers are visible: ${validationMessages.join(", ")}.`,
      missingRequiredLabels: input.outstandingRequired,
      validationMessages,
      suggestedAction: "fill"
    };
  }

  if (input.outstandingRequired.length > 0) {
    return {
      status: "needs_user",
      confidence: 0.94,
      reason: `Required answers are still missing: ${input.outstandingRequired.join(", ")}.`,
      missingRequiredLabels: input.outstandingRequired,
      validationMessages: [],
      suggestedAction: "ask_user"
    };
  }

  if (input.submitVisible) {
    return {
      status: input.submitRequested && input.allowExternalSubmit ? "ready_to_submit" : "ready_for_review",
      confidence: 0.9,
      reason: input.submitRequested && input.allowExternalSubmit
        ? "The stage is complete and a final submit control is visible."
        : "The stage is complete and the form is at a review/submit gate.",
      missingRequiredLabels: [],
      validationMessages: [],
      suggestedAction: input.submitRequested && input.allowExternalSubmit ? "submit" : "stop"
    };
  }

  return {
    status: "ready_to_continue",
    confidence: 0.82,
    reason: input.visibleFields.length > 0
      ? "Visible fields are satisfied and no blocking validation errors were found."
      : "No blocking form fields remain on this page.",
    missingRequiredLabels: [],
    validationMessages: [],
    suggestedAction: "click_next"
  };
}

function buildPlanReason(
  classification: ReturnType<typeof classifyPage>,
  best: ReturnType<typeof rankActions>[number]
) {
  return [
    `Classified page as ${classification.state} (${Math.round(classification.confidence * 100)}% confidence).`,
    ...best.reasons
  ].join(" ");
}

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
