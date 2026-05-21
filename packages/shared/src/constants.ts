import type { MatchStrictness } from "./types";

export const STRICTNESS_THRESHOLDS: Record<MatchStrictness, number> = {
  broad: 45,
  balanced: 60,
  strict: 75
};

export const SEARCH_DURATION_OPTIONS = [2, 5, 10];

export const APPLICATION_STATUS_LABELS = {
  queued: "Queued",
  running: "Running",
  draft_ready: "Draft ready",
  autofilled: "Autofilled",
  ready_for_review: "Ready for review",
  submitted: "Submitted",
  blocked: "Blocked",
  failed: "Failed"
} as const;

export const APPLICATION_EXECUTION_MODE_LABELS = {
  draft_package: "Draft package",
  guided_autofill: "Guided autofill",
  browser_apply: "Browser apply",
  autonomous_apply: "Autonomous apply"
} as const;

export const AGENT_CAPABILITY_STATUS_LABELS = {
  available: "Available",
  partial: "Partial",
  unavailable: "Unavailable"
} as const;

export const BROWSER_APPLY_STATUS_LABELS = {
  filled: "Filled",
  submitted: "Submitted",
  needs_manual_review: "Needs review",
  handoff_required: "Manual handoff",
  blocked: "Blocked"
} as const;

export const PLANNER_STATUS_LABELS = {
  idle: "Idle",
  running: "Running",
  handoff_required: "Manual handoff",
  needs_review: "Needs review",
  completed: "Completed",
  blocked: "Blocked"
} as const;
