import type { StageExecutionPlan } from "./types";
import type { BrowserAgentObservation } from "./types";

type BuildStageExecutionPlanInput = {
  observation: BrowserAgentObservation;
  resumeAvailable: boolean;
  submitRequested: boolean;
  allowExternalSubmit: boolean;
};

export function buildStageExecutionPlan(input: BuildStageExecutionPlanInput): StageExecutionPlan {
  const { observation } = input;

  if (observation.pageState === "login") {
    return {
      action: "ask_user",
      confidence: 0.98,
      reason: "The page appears to require login or identity confirmation before autonomous progress is safe.",
      checklist: ["Wait for the student to complete login or verification.", "Resume once the checkpoint clears."]
    };
  }

  if (observation.pageState === "resume_upload" && input.resumeAvailable) {
    return {
      action: "upload_resume",
      confidence: 0.92,
      reason: "A resume upload step is visible and a resume file is available.",
      checklist: ["Attach the latest resume.", "Re-scan the page after upload."]
    };
  }

  if (observation.visibleFields.length > 0) {
    return {
      action: "fill",
      confidence: 0.9,
      reason: `There are ${observation.visibleFields.length} visible input fields on the current stage.`,
      checklist: ["Fill visible fields using stored context first.", "Run validation and required-field checks before navigating."]
    };
  }

  if (observation.pageState === "submit") {
    return {
      action: input.submitRequested && input.allowExternalSubmit ? "submit" : "stop",
      confidence: input.submitRequested && input.allowExternalSubmit ? 0.88 : 0.94,
      reason: input.submitRequested && input.allowExternalSubmit
        ? "The page appears to be at a final submit gate and external submit is enabled."
        : "The page appears to be at a final submit gate, so the agent should stop for review.",
      checklist: ["Confirm the page is stable.", "Submit or pause based on policy."]
    };
  }

  if (observation.pageState === "review") {
    return {
      action: "stop",
      confidence: 0.9,
      reason: "The page appears to be a review checkpoint rather than a new fill stage.",
      checklist: ["Pause for review or final submission."]
    };
  }

  return {
    action: "click_next",
    confidence: 0.68,
    reason: "No fillable fields are visible, so the next likely step is to continue the workflow.",
    checklist: ["Look for a safe next-step control.", "Avoid final submit unless policy allows it."]
  };
}
