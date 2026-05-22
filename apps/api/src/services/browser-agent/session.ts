import type { AgentTimelineStep, BrowserApplyStatus, BrowserExecutionSession, BrowserStageSignature, PlannerCheckpoint } from "@gradlaunch/shared";
import { createId } from "../../lib/id";
import { nowIso } from "../../lib/time";
import { AgentRepository } from "../../repositories/agent-repository";

type CreateSessionInput = {
  studentId: string;
  applicationId: string;
  runId: string;
  jobId: string;
  sourceUrl: string;
  workspacePath?: string;
  planner?: PlannerCheckpoint;
  latestMessage: string;
};

type UpdateSessionInput = {
  sessionId?: string;
  status: BrowserExecutionSession["status"];
  latestMessage: string;
  planner?: PlannerCheckpoint;
  currentUrl?: string;
  currentStageIndex?: number;
  currentStageLabel?: string;
  workspacePath?: string;
  lastStageSignature?: BrowserStageSignature;
  browserStatus?: BrowserApplyStatus;
  filledCount?: number;
  manualCount?: number;
  pendingHandoff?: BrowserExecutionSession["pendingHandoff"];
};

export class BrowserExecutionSessionService {
  constructor(private readonly repository = new AgentRepository()) {}

  async createOrReuse(input: CreateSessionInput & { sessionId?: string }) {
    const createdAt = nowIso();
    const existing = input.sessionId
      ? await this.repository.getBrowserExecutionSessionById(input.sessionId)
      : await this.repository.getLatestBrowserExecutionSessionForApplication(input.applicationId);

    const session: BrowserExecutionSession = {
      id: input.sessionId ?? existing?.id ?? createId("browser_session"),
      studentId: input.studentId,
      applicationId: input.applicationId,
      runId: input.runId,
      jobId: input.jobId,
      status: "running",
      sourceUrl: input.sourceUrl,
      currentUrl: existing?.currentUrl ?? input.sourceUrl,
      currentStageIndex: existing?.currentStageIndex,
      currentStageLabel: existing?.currentStageLabel,
      workspacePath: input.workspacePath ?? existing?.workspacePath,
      latestMessage: input.latestMessage,
      latestSteps: buildSessionSteps(input.planner, input.latestMessage),
      lastDecision: input.planner?.lastDecision ?? existing?.lastDecision,
      lastStageSignature: existing?.lastStageSignature,
      pendingHandoff: undefined,
      browserStatus: existing?.browserStatus,
      filledCount: existing?.filledCount ?? 0,
      manualCount: existing?.manualCount ?? 0,
      updatedAt: createdAt,
      createdAt: existing?.createdAt ?? createdAt
    };

    return this.repository.upsertBrowserExecutionSession(session);
  }

  async update(input: UpdateSessionInput) {
    if (!input.sessionId) {
      throw new Error("Browser execution session id is required.");
    }

    return this.repository.updateBrowserExecutionSession(input.sessionId, {
      status: input.status,
      currentUrl: input.currentUrl,
      currentStageIndex: input.currentStageIndex,
      currentStageLabel: input.currentStageLabel,
      workspacePath: input.workspacePath,
      latestMessage: input.latestMessage,
      latestSteps: buildSessionSteps(input.planner, input.latestMessage),
      lastDecision: input.planner?.lastDecision,
      lastStageSignature: input.lastStageSignature,
      browserStatus: input.browserStatus,
      filledCount: input.filledCount,
      manualCount: input.manualCount,
      pendingHandoff: input.pendingHandoff,
      updatedAt: nowIso()
    });
  }
}

function buildSessionSteps(planner: PlannerCheckpoint | undefined, latestMessage: string) {
  if (!planner) {
    const steps: AgentTimelineStep[] = [
      {
        id: "browser-session",
        label: "Browser session active",
        detail: latestMessage,
        state: "running" as const,
        source: "gradlaunch" as const,
        timestamp: nowIso()
      }
    ];

    return steps;
  }

  const relevantTasks = planner.subgoals
    .filter((task) => task.status === "running" || task.status === "needs_user" || task.status === "retrying" || task.status === "completed")
    .slice(-4);

  return relevantTasks.map((task): AgentTimelineStep => ({
    id: task.id,
    label: task.label,
    detail: task.detail || latestMessage,
    state: task.status === "completed" ? "done" : task.status === "needs_user" ? "attention" : "running",
    source: "gradlaunch" as const,
    timestamp: task.lastUpdatedAt
  }));
}
