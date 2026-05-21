import type {
  AgentControlPlaneSnapshot,
  AgentEvent,
  AgentEventType,
  AgentGoal,
  AgentGoalStatus,
  AgentHandoff,
  AgentHandoffKind,
  AgentTask,
  AgentTaskKind,
  AgentTaskStatus,
  AgentWorkerType,
  Application,
  Job,
  PolicyDecision
} from "@gradlaunch/shared";
import { createId } from "../lib/id";
import { nowIso } from "../lib/time";
import { AgentRepository } from "../repositories/agent-repository";

type QueueTaskInput = {
  goalId: string;
  studentId: string;
  applicationId?: string;
  workerType: AgentWorkerType;
  kind: AgentTaskKind;
  title: string;
  priority?: number;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  runAfter?: string;
};

export class AgentOrchestratorService {
  constructor(private readonly repository = new AgentRepository()) {}

  async queueAutonomousApplication(input: { studentId: string; application: Application; job: Job }): Promise<AgentGoal> {
    const existingGoal = await this.repository.getActiveGoalForApplication(input.application.id);

    if (existingGoal) {
      return existingGoal;
    }

    const timestamp = nowIso();
    const goal: AgentGoal = {
      id: createId("goal"),
      studentId: input.studentId,
      applicationId: input.application.id,
      type: "autonomous_application",
      status: "queued",
      title: `Autonomous apply for ${input.job.company}`,
      summary: `GradLaunch queued the autonomous application workflow for ${input.job.title}.`,
      metadata: {
        jobId: input.job.id,
        sourceType: input.job.sourceType
      },
      createdAt: timestamp,
      updatedAt: timestamp
    };

    await this.repository.createGoal(goal);
    await this.createEvent({
      studentId: input.studentId,
      goalId: goal.id,
      applicationId: input.application.id,
      type: "goal.created",
      message: `Created autonomous goal for ${input.job.company} - ${input.job.title}.`,
      metadata: { type: goal.type }
    });

    const rankingTask = await this.queueTask({
      goalId: goal.id,
      studentId: input.studentId,
      applicationId: input.application.id,
      workerType: "ranking",
      kind: "rank_application",
      title: "Re-rank application for autonomous queue",
      priority: 90,
      payload: {
        jobId: input.job.id
      }
    });

    return this.repository.updateGoal(goal.id, {
      status: "running",
      summary: "Autonomous workflow started and queued for ranking.",
      currentTaskId: rankingTask.id,
      updatedAt: nowIso()
    });
  }

  async queueTask(input: QueueTaskInput): Promise<AgentTask> {
    const task: AgentTask = {
      id: createId("task"),
      goalId: input.goalId,
      studentId: input.studentId,
      applicationId: input.applicationId,
      workerType: input.workerType,
      kind: input.kind,
      status: "queued",
      title: input.title,
      priority: input.priority ?? 50,
      payload: input.payload ?? {},
      runAfter: input.runAfter ?? nowIso(),
      attemptCount: 0,
      maxAttempts: input.maxAttempts ?? 3,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };

    await this.repository.createTask(task);
    await this.repository.updateGoal(task.goalId, {
      currentTaskId: task.id,
      updatedAt: nowIso()
    });
    await this.createEvent({
      studentId: task.studentId,
      goalId: task.goalId,
      taskId: task.id,
      applicationId: task.applicationId,
      type: "task.queued",
      message: `${task.workerType} queued: ${task.title}.`,
      metadata: {
        kind: task.kind,
        priority: task.priority
      }
    });

    return task;
  }

  async createEvent(input: Omit<AgentEvent, "id" | "createdAt"> & { createdAt?: string }): Promise<AgentEvent> {
    const event: AgentEvent = {
      id: createId("event"),
      studentId: input.studentId,
      type: input.type,
      message: input.message,
      goalId: input.goalId,
      taskId: input.taskId,
      applicationId: input.applicationId,
      metadata: input.metadata,
      createdAt: input.createdAt ?? nowIso()
    };

    return this.repository.createEvent(event);
  }

  async recordPolicyDecision(decision: PolicyDecision) {
    await this.repository.createPolicyDecision(decision);
    await this.createEvent({
      studentId: decision.studentId,
      applicationId: decision.applicationId,
      taskId: decision.taskId,
      type: "policy.decided",
      message: `Policy decision: ${decision.action}. ${decision.reason}`,
      metadata: {
        scope: decision.scope,
        confidence: decision.confidence,
        facts: decision.facts
      }
    });
  }

  async createHandoff(input: {
    goalId: string;
    studentId: string;
    taskId?: string;
    applicationId?: string;
    kind: AgentHandoffKind;
    title: string;
    detail: string;
  }): Promise<AgentHandoff> {
    const handoff: AgentHandoff = {
      id: createId("handoff"),
      goalId: input.goalId,
      studentId: input.studentId,
      taskId: input.taskId,
      applicationId: input.applicationId,
      status: "open",
      kind: input.kind,
      title: input.title,
      detail: input.detail,
      requestedAt: nowIso()
    };

    await this.repository.createHandoff(handoff);
    await this.createEvent({
      studentId: input.studentId,
      goalId: input.goalId,
      taskId: input.taskId,
      applicationId: input.applicationId,
      type: "handoff.created",
      message: `${input.kind} handoff requested. ${input.detail}`,
      metadata: {
        title: input.title
      }
    });

    return handoff;
  }

  async updateGoal(goalId: string, patch: Partial<AgentGoal>) {
    return this.repository.updateGoal(goalId, {
      ...patch,
      updatedAt: patch.updatedAt ?? nowIso()
    });
  }

  async updateTask(taskId: string, patch: Partial<AgentTask>) {
    return this.repository.updateTask(taskId, {
      ...patch,
      updatedAt: patch.updatedAt ?? nowIso()
    });
  }

  async getTask(taskId: string) {
    return this.repository.getTaskById(taskId);
  }

  async getGoal(goalId: string) {
    return this.repository.getGoalById(goalId);
  }

  async getControlPlaneSnapshot(studentId: string): Promise<AgentControlPlaneSnapshot> {
    return this.repository.getControlPlaneSnapshot(studentId);
  }
}
