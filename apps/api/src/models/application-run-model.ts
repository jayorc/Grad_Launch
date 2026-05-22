import mongoose, { Schema } from "mongoose";

const filledFieldSchema = new Schema(
  {
    label: { type: String, required: true },
    value: { type: String, required: true }
  },
  { _id: false }
);

const timelineStepSchema = new Schema(
  {
    id: { type: String, required: true },
    label: { type: String, required: true },
    detail: { type: String, required: true },
    state: { type: String, required: true },
    source: { type: String, required: true },
    timestamp: { type: String, required: false }
  },
  { _id: false }
);

const emailDeliverySchema = new Schema(
  {
    status: { type: String, required: true },
    provider: { type: String, required: true },
    to: { type: String, required: true },
    subject: { type: String, required: true },
    sentAt: { type: String, required: false },
    message: { type: String, required: false }
  },
  { _id: false }
);

const plannerDecisionSchema = new Schema(
  {
    kind: { type: String, required: true },
    source: { type: String, required: true },
    stageIndex: { type: Number, required: true },
    stageLabel: { type: String, required: true },
    url: { type: String, required: true },
    reason: { type: String, required: true },
    fieldLabels: { type: [String], default: [] },
    createdAt: { type: String, required: true }
  },
  { _id: false }
);

const plannerStageSchema = new Schema(
  {
    stageIndex: { type: Number, required: true },
    label: { type: String, required: true },
    url: { type: String, required: true },
    visibleFieldLabels: { type: [String], default: [] },
    requiredFieldLabels: { type: [String], default: [] },
    filledFieldLabels: { type: [String], default: [] },
    outcome: { type: String, required: true },
    decision: { type: plannerDecisionSchema, required: false },
    lastUpdatedAt: { type: String, required: true }
  },
  { _id: false }
);

const plannerTaskSchema = new Schema(
  {
    id: { type: String, required: true },
    label: { type: String, required: true },
    status: { type: String, required: true },
    detail: { type: String, required: true },
    attempts: { type: Number, required: true, default: 0 },
    lastUpdatedAt: { type: String, required: true },
    completedAt: { type: String, required: false }
  },
  { _id: false }
);

const plannerCheckpointSchema = new Schema(
  {
    sessionId: { type: String, required: true },
    resumeToken: { type: String, required: true },
    goal: { type: String, required: true },
    status: { type: String, required: true },
    summary: { type: String, required: true },
    formMode: { type: String, required: true, default: "unknown" },
    currentStep: { type: String, required: false },
    currentStageLabel: { type: String, required: false },
    currentUrl: { type: String, required: false },
    retryCount: { type: Number, required: true, default: 0 },
    handoffCount: { type: Number, required: true, default: 0 },
    validationErrors: { type: [String], default: [] },
    subgoals: { type: [plannerTaskSchema], default: [] },
    lastDecision: { type: plannerDecisionSchema, required: false },
    stageHistory: { type: [plannerStageSchema], default: [] },
    lastUpdatedAt: { type: String, required: true }
  },
  { _id: false }
);

const submissionSchema = new Schema(
  {
    intent: { type: String, required: true },
    outcome: { type: String, required: true },
    externalSubmitted: { type: Boolean, required: true },
    confirmation: { type: String, required: true },
    submittedAt: { type: String, required: true },
    email: { type: emailDeliverySchema, required: true },
    browser: {
      type: new Schema(
        {
          status: { type: String, required: true },
          sourceUrl: { type: String, required: true },
          openedAt: { type: String, required: true },
          completedAt: { type: String, required: true },
          filledLabels: { type: [String], default: [] },
          skippedLabels: { type: [String], default: [] },
          screenshots: { type: [String], default: [] },
          message: { type: String, required: true },
          planner: {
            type: plannerCheckpointSchema,
            required: false
          }
        },
        { _id: false }
      ),
      required: false
    }
  },
  { _id: false }
);

const applicationRunSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    applicationId: { type: String, required: true, index: true },
    status: { type: String, required: true },
    startedAt: { type: String, required: true },
    completedAt: { type: String, required: false },
    adapterId: { type: String, required: true },
    executionMode: { type: String, required: true },
    workspacePath: { type: String, required: false },
    workspaceFiles: { type: [String], default: [] },
    screenshots: { type: [String], default: [] },
    blockedReason: { type: String, required: false },
    filledFields: { type: [filledFieldSchema], default: [] },
    timeline: { type: [timelineStepSchema], default: [] },
    notes: { type: [String], default: [] },
    planner: {
      type: plannerCheckpointSchema,
      required: false
    },
    submission: { type: submissionSchema, required: false }
  },
  { timestamps: true, versionKey: false }
);

export const ApplicationRunModel =
  mongoose.models.ApplicationRun ?? mongoose.model("ApplicationRun", applicationRunSchema);
