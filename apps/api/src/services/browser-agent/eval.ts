import type { StageEvaluation, VisibleField } from "./types";

type EvaluateStageInput = {
  visibleFields: VisibleField[];
  outstandingRequired: string[];
  validationMessages: string[];
  submitVisible: boolean;
  submitRequested: boolean;
  allowExternalSubmit: boolean;
};

// Converts the current page's required-field and validation state into a single
// readiness verdict. The engine uses this as the final gate before retrying,
// asking the user, clicking Continue, pausing at review, or submitting.
export function evaluateStageReadiness(input: EvaluateStageInput): StageEvaluation {
  if (input.validationMessages.length > 0) {
    return {
      status: "needs_retry",
      confidence: 0.96,
      reason: `Validation blockers are visible: ${input.validationMessages.join(", ")}.`,
      missingRequiredLabels: input.outstandingRequired,
      validationMessages: input.validationMessages,
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
