import mongoose, { Schema } from "mongoose";

const mixed = Schema.Types.Mixed;

const agentGoalSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    studentId: { type: String, required: true, index: true },
    applicationId: { type: String, required: false, index: true },
    type: { type: String, required: true },
    status: { type: String, required: true, index: true },
    title: { type: String, required: true },
    summary: { type: String, required: true },
    currentTaskId: { type: String, required: false },
    metadata: { type: mixed, required: false },
    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
    completedAt: { type: String, required: false }
  },
  { timestamps: true, versionKey: false }
);

const agentTaskSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    goalId: { type: String, required: true, index: true },
    studentId: { type: String, required: true, index: true },
    applicationId: { type: String, required: false, index: true },
    workerType: { type: String, required: true, index: true },
    kind: { type: String, required: true },
    status: { type: String, required: true, index: true },
    title: { type: String, required: true },
    priority: { type: Number, required: true, default: 50, index: true },
    payload: { type: mixed, required: true, default: {} },
    result: { type: mixed, required: false },
    runAfter: { type: String, required: true, index: true },
    attemptCount: { type: Number, required: true, default: 0 },
    maxAttempts: { type: Number, required: true, default: 3 },
    leasedTo: { type: String, required: false, index: true },
    leaseExpiresAt: { type: String, required: false, index: true },
    lastError: { type: String, required: false },
    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
    completedAt: { type: String, required: false }
  },
  { timestamps: true, versionKey: false }
);

const agentTaskRunSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    taskId: { type: String, required: true, index: true },
    workerType: { type: String, required: true },
    status: { type: String, required: true, index: true },
    leaseOwner: { type: String, required: true },
    summary: { type: String, required: true },
    errorMessage: { type: String, required: false },
    inputSnapshot: { type: mixed, required: false },
    outputSnapshot: { type: mixed, required: false },
    startedAt: { type: String, required: true },
    completedAt: { type: String, required: false }
  },
  { timestamps: true, versionKey: false }
);

const agentHandoffSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    goalId: { type: String, required: true, index: true },
    studentId: { type: String, required: true, index: true },
    taskId: { type: String, required: false, index: true },
    applicationId: { type: String, required: false, index: true },
    status: { type: String, required: true, index: true },
    kind: { type: String, required: true },
    title: { type: String, required: true },
    detail: { type: String, required: true },
    requestedAt: { type: String, required: true },
    resolvedAt: { type: String, required: false }
  },
  { timestamps: true, versionKey: false }
);

const policyDecisionSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    studentId: { type: String, required: true, index: true },
    applicationId: { type: String, required: false, index: true },
    taskId: { type: String, required: false, index: true },
    scope: { type: String, required: true },
    action: { type: String, required: true, index: true },
    reason: { type: String, required: true },
    confidence: { type: Number, required: true },
    facts: { type: [String], default: [] },
    createdAt: { type: String, required: true }
  },
  { timestamps: true, versionKey: false }
);

const memoryCorrectionSchema = new Schema(
  {
    label: { type: String, required: true },
    value: { type: String, required: true },
    updatedAt: { type: String, required: true }
  },
  { _id: false }
);

const portalPatternSchema = new Schema(
  {
    id: { type: String, required: true },
    domain: { type: String, required: true },
    urlPattern: { type: String, required: false },
    fieldLabel: { type: String, required: true },
    normalizedLabel: { type: String, required: false },
    autocomplete: { type: String, required: false },
    widgetKind: { type: String, required: false },
    valueKind: { type: String, required: false },
    domPathSignature: { type: String, required: false },
    strategy: { type: String, required: true },
    queryMode: { type: String, required: false },
    successCount: { type: Number, required: true, default: 0 },
    verificationEvidence: { type: [String], default: [] },
    failureReason: { type: String, required: false },
    notes: { type: [String], default: [] },
    lastUsedAt: { type: String, required: true }
  },
  { _id: false }
);

const studentMemorySchema = new Schema(
  {
    studentId: { type: String, required: true, unique: true, index: true },
    successfulApplicationCount: { type: Number, required: true, default: 0 },
    blockedSourceTypes: { type: [String], default: [] },
    recentHandoffKinds: { type: [String], default: [] },
    portalPatterns: { type: [portalPatternSchema], default: [] },
    corrections: { type: [memoryCorrectionSchema], default: [] },
    notes: { type: [String], default: [] },
    lastUpdatedAt: { type: String, required: true }
  },
  { timestamps: true, versionKey: false }
);

const agentEventSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    studentId: { type: String, required: true, index: true },
    type: { type: String, required: true, index: true },
    message: { type: String, required: true },
    goalId: { type: String, required: false, index: true },
    taskId: { type: String, required: false, index: true },
    applicationId: { type: String, required: false, index: true },
    metadata: { type: mixed, required: false },
    createdAt: { type: String, required: true }
  },
  { timestamps: true, versionKey: false }
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

const browserStageSignatureSchema = new Schema(
  {
    url: { type: String, required: true },
    title: { type: String, required: true },
    fingerprint: { type: String, required: true },
    visibleFieldLabels: { type: [String], default: [] },
    requiredFieldLabels: { type: [String], default: [] },
    controlLabels: { type: [String], default: [] },
    progressText: { type: String, required: false },
    savedAt: { type: String, required: true }
  },
  { _id: false }
);

const pendingHandoffSchema = new Schema(
  {
    kind: { type: String, required: true },
    title: { type: String, required: true },
    detail: { type: String, required: true },
    requestedAt: { type: String, required: true }
  },
  { _id: false }
);

const browserExecutionSessionSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    studentId: { type: String, required: true, index: true },
    applicationId: { type: String, required: true, index: true },
    runId: { type: String, required: true, index: true },
    jobId: { type: String, required: true, index: true },
    status: { type: String, required: true, index: true },
    sourceUrl: { type: String, required: true },
    currentUrl: { type: String, required: false },
    currentStageIndex: { type: Number, required: false },
    currentStageLabel: { type: String, required: false },
    workspacePath: { type: String, required: false },
    latestMessage: { type: String, required: true },
    latestSteps: { type: [timelineStepSchema], default: [] },
    lastDecision: { type: plannerDecisionSchema, required: false },
    lastStageSignature: { type: browserStageSignatureSchema, required: false },
    pendingHandoff: { type: pendingHandoffSchema, required: false },
    browserStatus: { type: String, required: false },
    filledCount: { type: Number, required: true, default: 0 },
    manualCount: { type: Number, required: true, default: 0 },
    updatedAt: { type: String, required: true },
    createdAt: { type: String, required: true }
  },
  { timestamps: true, versionKey: false }
);

export const AgentGoalModel = mongoose.models.AgentGoal ?? mongoose.model("AgentGoal", agentGoalSchema);
export const AgentTaskModel = mongoose.models.AgentTask ?? mongoose.model("AgentTask", agentTaskSchema);
export const AgentTaskRunModel = mongoose.models.AgentTaskRun ?? mongoose.model("AgentTaskRun", agentTaskRunSchema);
export const AgentHandoffModel = mongoose.models.AgentHandoff ?? mongoose.model("AgentHandoff", agentHandoffSchema);
export const PolicyDecisionModel =
  mongoose.models.PolicyDecision ?? mongoose.model("PolicyDecision", policyDecisionSchema);
export const StudentMemoryModel =
  mongoose.models.StudentMemory ?? mongoose.model("StudentMemory", studentMemorySchema);
export const AgentEventModel = mongoose.models.AgentEvent ?? mongoose.model("AgentEvent", agentEventSchema);
export const BrowserExecutionSessionModel =
  mongoose.models.BrowserExecutionSession ?? mongoose.model("BrowserExecutionSession", browserExecutionSessionSchema);
