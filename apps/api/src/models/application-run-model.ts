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
            type: new Schema(
              {
                sessionId: { type: String, required: true },
                resumeToken: { type: String, required: true },
                goal: { type: String, required: true },
                status: { type: String, required: true },
                summary: { type: String, required: true },
                currentStep: { type: String, required: false },
                currentStageLabel: { type: String, required: false },
                currentUrl: { type: String, required: false },
                retryCount: { type: Number, required: true, default: 0 },
                handoffCount: { type: Number, required: true, default: 0 },
                validationErrors: { type: [String], default: [] },
                subgoals: {
                  type: [
                    new Schema(
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
                    )
                  ],
                  default: []
                },
                lastUpdatedAt: { type: String, required: true }
              },
              { _id: false }
            ),
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
      type: new Schema(
        {
          sessionId: { type: String, required: true },
          resumeToken: { type: String, required: true },
          goal: { type: String, required: true },
          status: { type: String, required: true },
          summary: { type: String, required: true },
          currentStep: { type: String, required: false },
          currentStageLabel: { type: String, required: false },
          currentUrl: { type: String, required: false },
          retryCount: { type: Number, required: true, default: 0 },
          handoffCount: { type: Number, required: true, default: 0 },
          validationErrors: { type: [String], default: [] },
          subgoals: {
            type: [
              new Schema(
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
              )
            ],
            default: []
          },
          lastUpdatedAt: { type: String, required: true }
        },
        { _id: false }
      ),
      required: false
    },
    submission: { type: submissionSchema, required: false }
  },
  { timestamps: true, versionKey: false }
);

export const ApplicationRunModel =
  mongoose.models.ApplicationRun ?? mongoose.model("ApplicationRun", applicationRunSchema);
