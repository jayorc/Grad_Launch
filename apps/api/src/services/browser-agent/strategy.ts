import type { Page } from "playwright-core";
import {
  clickSoftGate,
  detectProtectedCheckpoint,
  discoverVisibleFields,
  getVisibleValidationMessages,
  hasFileUpload,
  observeBrowserPage
} from "./observe";
import type {
  ActionScore,
  BrowserAgentObservation,
  BrowserPageState,
  PageClassification,
  RecoveryPlan
} from "./types";
import { isTransientStatusMessage, normalizeKey, writeBrowserDebug } from "./util";

// strategy.ts is the decision layer between observation and action. It turns a
// page snapshot into: "what state is this page in?", "what should the agent do
// next?", and "how should we recover if the page still has blockers?".
type RankActionsInput = {
  observation: BrowserAgentObservation;
  classification: PageClassification;
  resumeAvailable: boolean;
  submitRequested: boolean;
  allowExternalSubmit: boolean;
};

type RecoveryInput = {
  classification?: PageClassification;
  outstandingRequired: string[];
  validationMessages: string[];
  uploadStillPending: boolean;
  failedFieldCount: number;
};

// Classifies the current browser snapshot into a page state such as login,
// captcha, loading, resume upload, normal form fill, validation error, review,
// submit, start, empty, or unknown. It assigns confidence and blocking flags so
// the engine knows whether autonomous action is safe.
export function classifyPage(observation: BrowserAgentObservation): PageClassification {
  // Classification is score-based rather than a single hardcoded branch.
  // Multiple states can match the same page; the most confident state wins.
  const text = normalizeKey([
    observation.title,
    observation.pageText,
    observation.url,
    ...observation.controls.map((control) => `${control.text} ${control.label}`),
    ...observation.validationMessages
  ].join(" "));
  const states: PageClassification[] = [];
  const visibleFieldCount = observation.visibleFields.length;
  const meaningfulValidation = observation.validationMessages.filter((message) => !isTransientStatusMessage(message));

  if (observation.pageState === "login" || /\b(sign in|log in|login|forgot password|create account|password)\b/.test(text) && /\b(password|email or phone|username)\b/.test(text)) {
    states.push({
      state: "login",
      confidence: 0.98,
      blocking: true,
      reasons: ["A login or identity confirmation panel is visible."]
    });
  }

  if (observation.pageState === "captcha" || /\b(captcha|verify you are human|human verification|security check|i am not a robot|cloudflare challenge)\b/.test(text)) {
    states.push({
      state: "captcha",
      confidence: 0.97,
      blocking: true,
      reasons: ["A CAPTCHA or human verification challenge is visible."]
    });
  }

  if (meaningfulValidation.length > 0 || observation.pageState === "validation_error") {
    states.push({
      state: "validation_error",
      confidence: 0.92,
      blocking: false,
      reasons: [`Visible validation message(s): ${meaningfulValidation.join(", ") || "invalid fields"}.`]
    });
  }

  if (observation.pageState === "loading" || (visibleFieldCount === 0 && /\b(active loading indicator|loading|please wait|processing|uploading|saving|submitting|one moment)\b/.test(text))) {
    states.push({
      state: "loading",
      confidence: 0.86,
      blocking: false,
      reasons: ["The page appears to be processing or waiting for dynamic content."]
    });
  }

  if (observation.pageState === "resume_upload") {
    states.push({
      state: "resume_upload",
      confidence: 0.93,
      blocking: false,
      reasons: ["A resume/CV upload step or application-method upload choice is visible."]
    });
  }

  if (observation.pageState === "submit") {
    states.push({
      state: "submit",
      confidence: 0.9,
      blocking: false,
      reasons: ["A final submit gate is visible."]
    });
  }

  if (observation.pageState === "review") {
    states.push({
      state: "review",
      confidence: 0.9,
      blocking: false,
      reasons: ["A review checkpoint is visible."]
    });
  }

  if (visibleFieldCount > 0 && !["login", "captcha"].includes(observation.pageState)) {
    const state: BrowserPageState = observation.pageState === "consent" || observation.pageState === "questionnaire"
      ? observation.pageState
      : "form_fill";
    states.push({
      state,
      confidence: observation.visibleFields.some((field) => field.required) ? 0.91 : 0.84,
      blocking: false,
      reasons: [`${visibleFieldCount} visible fillable field(s) were detected.`]
    });
  }

  if (observation.pageState === "start") {
    states.push({
      state: "start",
      confidence: 0.78,
      blocking: false,
      reasons: ["The page looks like a pre-application start screen."]
    });
  }

  if (observation.pageState === "empty") {
    states.push({
      state: "empty",
      confidence: 0.7,
      blocking: false,
      reasons: ["No readable controls or fields are currently visible."]
    });
  }

  const best = states.sort((left, right) => right.confidence - left.confidence)[0];

  return best ?? {
    state: "unknown",
    confidence: 0.42,
    blocking: false,
    reasons: ["The page did not confidently match a known application state."]
  };
}

// Scores all safe next actions for the classified page. High-risk states like
// login/CAPTCHA rank manual handoff highest, clear form pages rank fill highest,
// and uncertain pages rank safe exploration instead of blind navigation.
export function rankActions(input: RankActionsInput): ActionScore[] {
  // Ranking keeps dangerous actions behind safer ones. For example, login and
  // CAPTCHA always become ask_user, while ambiguous pages become exploration
  // instead of blind clicks.
  const { classification, observation } = input;
  const scores: ActionScore[] = [];
  const hasFields = observation.visibleFields.length > 0;
  const hasRequiredFields = observation.visibleFields.some((field) => field.required);

  if (classification.state === "login") {
    scores.push({
      action: "ask_user",
      score: 98,
      reasons: ["Login must stay manual; the agent should not type credentials or continue observing into filling."]
    });
  }

  if (classification.state === "captcha" || classification.state === "blocked") {
    scores.push({
      action: "ask_user",
      score: 97,
      reasons: ["Protected checkpoints require manual handoff."]
    });
  }

  if (classification.state === "loading") {
    scores.push({
      action: "wait",
      score: 88,
      reasons: ["Waiting and re-reading is safer than treating loader text as validation."]
    });
  }

  if (classification.state === "resume_upload" && input.resumeAvailable) {
    scores.push({
      action: "upload_resume",
      score: 94,
      reasons: ["Resume upload is visible and a resume file is available."]
    });
  }

  if (hasFields && !classification.blocking && classification.state !== "loading") {
    scores.push({
      action: "fill",
      score: hasRequiredFields ? 92 : 84,
      reasons: [
        `${observation.visibleFields.length} visible input field(s) can be mapped and verified.`,
        hasRequiredFields ? "Required fields are present, so filling should happen before navigation." : "Optional fields are present and can still be filled from known profile facts."
      ]
    });
  }

  if (classification.state === "submit") {
    scores.push({
      action: input.submitRequested && input.allowExternalSubmit ? "submit" : "stop",
      score: input.submitRequested && input.allowExternalSubmit ? 88 : 94,
      reasons: [input.submitRequested && input.allowExternalSubmit ? "External submit is allowed." : "Stop at final review/submit gate for user review."]
    });
  }

  if (classification.state === "review") {
    scores.push({
      action: "stop",
      score: 91,
      reasons: ["Review pages should pause rather than navigate blindly."]
    });
  }

  if (!hasFields && classification.state === "start") {
    scores.push({
      action: "click_next",
      score: 76,
      reasons: ["No form fields are visible and an application start state was detected."]
    });
  }

  if (!hasFields && ["unknown", "empty", "validation_error"].includes(classification.state)) {
    scores.push({
      action: "explore",
      score: classification.state === "validation_error" ? 68 : 62,
      reasons: ["The page is ambiguous, so the agent should probe safely before clicking workflow navigation."]
    });
  }

  if (scores.length === 0) {
    scores.push({
      action: "explore",
      score: 54,
      reasons: ["No confident direct action was found."]
    });
  }

  return scores.sort((left, right) => right.score - left.score);
}

// Converts remaining blockers after filling into a normalized recovery plan.
// The engine uses this to choose wait, retry upload, repair required fields,
// inspect validation, ask the LLM, or hand off to the user.
export function classifyRecovery(input: RecoveryInput): RecoveryPlan {
  // Recovery plans are normalized failure reasons. The engine can then decide
  // whether to wait, retry upload, repair fields, ask the LLM, or hand off to
  // the user without duplicating error parsing everywhere.
  const meaningfulValidation = input.validationMessages.filter((message) => !isTransientStatusMessage(message));

  if (input.classification?.state === "login") {
    return {
      kind: "login_gate",
      confidence: 0.98,
      reason: "A login gate is still visible.",
      actions: ["ask-user"]
    };
  }

  if (input.classification?.state === "captcha") {
    return {
      kind: "captcha",
      confidence: 0.98,
      reason: "A CAPTCHA or human verification gate is visible.",
      actions: ["ask-user"]
    };
  }

  if (input.uploadStillPending) {
    return {
      kind: "resume_upload_missing",
      confidence: 0.9,
      reason: "A resume upload control is still visible and no upload has been verified.",
      actions: ["retry-upload", "re-scan-fields", "ask-user"]
    };
  }

  if (input.validationMessages.some(isTransientStatusMessage) || input.classification?.state === "loading") {
    return {
      kind: "network_delay",
      confidence: 0.82,
      reason: "Only transient loading/status text is visible.",
      actions: ["wait", "re-scan-fields"]
    };
  }

  if (input.outstandingRequired.length > 0) {
    return {
      kind: "missing_required",
      confidence: 0.9,
      reason: `Required answer(s) are still missing: ${input.outstandingRequired.join(", ")}.`,
      actions: ["re-scan-fields", "retry-fill", "resolve-known-choice", "ask-user"]
    };
  }

  if (meaningfulValidation.some((message) => /\b(format|invalid|valid email|valid phone|must be|characters|date)\b/i.test(message))) {
    return {
      kind: "format_error",
      confidence: 0.86,
      reason: `Format validation is visible: ${meaningfulValidation.join(", ")}.`,
      actions: ["inspect-validation", "retry-fill", "ask-user"]
    };
  }

  if (meaningfulValidation.length > 0 || input.failedFieldCount > 0) {
    return {
      kind: "unknown_validation",
      confidence: 0.74,
      reason: meaningfulValidation.length > 0
        ? `Validation is visible: ${meaningfulValidation.join(", ")}.`
        : "Some attempted fields could not be verified.",
      actions: ["inspect-validation", "explore-page", "ask-user"]
    };
  }

  return {
    kind: "none",
    confidence: 0.99,
    reason: "No recovery blocker was detected.",
    actions: []
  };
}

// Performs a reversible page probe when classification is weak. It waits for
// dynamic content, dismisses soft gates, scrolls to reveal lazy sections, then
// re-observes the page and reports whether a useful action became visible.
export async function probeAndReobservePage(input: {
  page: Page;
  workspacePath: string;
  stageIndex: number;
}) {
  // Exploration mode performs only reversible, low-risk actions. It waits,
  // dismisses soft gates, scrolls to reveal lazy fields, then observes again.
  // It must not submit or click primary workflow buttons.
  await input.page.waitForLoadState("domcontentloaded", { timeout: 1200 }).catch(() => undefined);
  await input.page.waitForTimeout(500).catch(() => undefined);
  await clickSoftGate(input.page).catch(() => undefined);
  await input.page.evaluate(() => {
    window.scrollBy({ top: Math.max(320, window.innerHeight * 0.75), behavior: "auto" });
  }).catch(() => undefined);
  await input.page.waitForTimeout(450).catch(() => undefined);

  const protectedCheckpoint = await detectProtectedCheckpoint(input.page).catch(() => ({ blocked: false as const }));
  const visibleFields = await discoverVisibleFields(input.page).catch(() => []);
  const observation = await observeBrowserPage(input.page, visibleFields);
  const uploadVisible = await hasFileUpload(input.page).catch(() => false);
  const validationMessages = await getVisibleValidationMessages(input.page).catch(() => []);
  const classification = classifyPage({
    ...observation,
    validationMessages
  });

  await writeBrowserDebug(input.workspacePath, "safe-page-probe", {
    stageIndex: input.stageIndex,
    url: input.page.url(),
    protectedCheckpoint,
    uploadVisible,
    fieldCount: visibleFields.length,
    pageState: observation.pageState,
    classifiedState: classification.state,
    confidence: classification.confidence,
    validationMessages
  });

  return {
    protectedCheckpoint,
    visibleFields,
    observation: {
      ...observation,
      validationMessages
    },
    classification,
    uploadVisible,
    recovered: !protectedCheckpoint.blocked
      && (visibleFields.length > 0 || uploadVisible || ["start", "review", "submit", "resume_upload"].includes(classification.state))
  };
}
