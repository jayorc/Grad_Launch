import type {
  AgentControlPlaneSnapshot,
  AgentEvent,
  AgentGoal,
  AgentGoalStatus,
  AgentHandoff,
  AgentTask,
  AgentTaskRun,
  AgentTaskStatus,
  PolicyDecision,
  StudentMemory
} from "@gradlaunch/shared";
import { isMemoryMode } from "../lib/data-mode";
import {
  AgentEventModel,
  AgentGoalModel,
  AgentHandoffModel,
  AgentTaskModel,
  AgentTaskRunModel,
  PolicyDecisionModel,
  StudentMemoryModel
} from "../models/agent-models";
import { db } from "./in-memory-db";

type ClaimTaskInput = {
  leaseOwner: string;
  leaseMs: number;
};

type ListTaskOptions = {
  goalId?: string;
  studentId?: string;
  status?: AgentTaskStatus;
  limit?: number;
};

export class AgentRepository {
  async createGoal(goal: AgentGoal): Promise<AgentGoal> {
    if (isMemoryMode()) {
      db.agentGoals.push(goal);
      return goal;
    }

    await AgentGoalModel.create(goal);
    return goal;
  }

  async updateGoal(goalId: string, patch: Partial<AgentGoal>): Promise<AgentGoal> {
    if (isMemoryMode()) {
      const index = db.agentGoals.findIndex((goal) => goal.id === goalId);

      if (index === -1) {
        throw new Error("Goal not found.");
      }

      db.agentGoals[index] = {
        ...db.agentGoals[index],
        ...patch
      };

      return db.agentGoals[index];
    }

    const goal = await AgentGoalModel.findOneAndUpdate(
      { id: goalId },
      { $set: patch },
      { new: true }
    ).lean();

    if (!goal) {
      throw new Error("Goal not found.");
    }

    return mapGoal(goal as Record<string, unknown>);
  }

  async getGoalById(goalId: string): Promise<AgentGoal | undefined> {
    if (isMemoryMode()) {
      return db.agentGoals.find((goal) => goal.id === goalId);
    }

    const goal = await AgentGoalModel.findOne({ id: goalId }).lean();
    return goal ? mapGoal(goal as Record<string, unknown>) : undefined;
  }

  async getActiveGoalForApplication(applicationId: string): Promise<AgentGoal | undefined> {
    const activeStatuses: AgentGoalStatus[] = ["queued", "running", "waiting"];

    if (isMemoryMode()) {
      return db.agentGoals.find((goal) => goal.applicationId === applicationId && activeStatuses.includes(goal.status));
    }

    const goal = await AgentGoalModel.findOne({
      applicationId,
      status: { $in: activeStatuses }
    }).sort({ createdAt: -1 }).lean();

    return goal ? mapGoal(goal as Record<string, unknown>) : undefined;
  }

  async listGoalsByStudent(studentId: string, limit = 20): Promise<AgentGoal[]> {
    if (isMemoryMode()) {
      return [...db.agentGoals]
        .filter((goal) => goal.studentId === studentId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, limit);
    }

    const goals = await AgentGoalModel.find({ studentId }).sort({ updatedAt: -1 }).limit(limit).lean();
    return goals.map((goal) => mapGoal(goal as Record<string, unknown>));
  }

  async createTask(task: AgentTask): Promise<AgentTask> {
    if (isMemoryMode()) {
      db.agentTasks.push(task);
      return task;
    }

    await AgentTaskModel.create(task);
    return task;
  }

  async updateTask(taskId: string, patch: Partial<AgentTask>): Promise<AgentTask> {
    if (isMemoryMode()) {
      const index = db.agentTasks.findIndex((task) => task.id === taskId);

      if (index === -1) {
        throw new Error("Task not found.");
      }

      db.agentTasks[index] = {
        ...db.agentTasks[index],
        ...patch
      };

      return db.agentTasks[index];
    }

    const task = await AgentTaskModel.findOneAndUpdate(
      { id: taskId },
      { $set: patch },
      { new: true }
    ).lean();

    if (!task) {
      throw new Error("Task not found.");
    }

    return mapTask(task as Record<string, unknown>);
  }

  async getTaskById(taskId: string): Promise<AgentTask | undefined> {
    if (isMemoryMode()) {
      return db.agentTasks.find((task) => task.id === taskId);
    }

    const task = await AgentTaskModel.findOne({ id: taskId }).lean();
    return task ? mapTask(task as Record<string, unknown>) : undefined;
  }

  async listTasks(options: ListTaskOptions): Promise<AgentTask[]> {
    if (isMemoryMode()) {
      return [...db.agentTasks]
        .filter((task) => (options.goalId ? task.goalId === options.goalId : true))
        .filter((task) => (options.studentId ? task.studentId === options.studentId : true))
        .filter((task) => (options.status ? task.status === options.status : true))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, options.limit ?? 50);
    }

    const query: Record<string, unknown> = {};

    if (options.goalId) {
      query.goalId = options.goalId;
    }

    if (options.studentId) {
      query.studentId = options.studentId;
    }

    if (options.status) {
      query.status = options.status;
    }

    const tasks = await AgentTaskModel.find(query).sort({ updatedAt: -1 }).limit(options.limit ?? 50).lean();
    return tasks.map((task) => mapTask(task as Record<string, unknown>));
  }

  async claimNextRunnableTask(input: ClaimTaskInput): Promise<AgentTask | undefined> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + input.leaseMs).toISOString();
    const nowIso = now.toISOString();

    if (isMemoryMode()) {
      const task = [...db.agentTasks]
        .filter((candidate) => candidate.status === "queued" || (candidate.status === "running" && isExpired(candidate.leaseExpiresAt, nowIso)))
        .filter((candidate) => candidate.runAfter <= nowIso)
        .filter((candidate) => candidate.attemptCount < candidate.maxAttempts)
        .sort(compareRunnableTasks)[0];

      if (!task) {
        return undefined;
      }

      task.status = "running";
      task.attemptCount += 1;
      task.leasedTo = input.leaseOwner;
      task.leaseExpiresAt = leaseExpiresAt;
      task.updatedAt = nowIso;
      return task;
    }

    const task = await AgentTaskModel.findOneAndUpdate(
      {
        runAfter: { $lte: nowIso },
        $expr: { $lt: ["$attemptCount", "$maxAttempts"] },
        $or: [
          { status: "queued" },
          { status: "running", leaseExpiresAt: { $lte: nowIso } }
        ]
      },
      {
        $set: {
          status: "running",
          leasedTo: input.leaseOwner,
          leaseExpiresAt,
          updatedAt: nowIso
        },
        $inc: {
          attemptCount: 1
        }
      },
      {
        sort: { priority: -1, runAfter: 1, createdAt: 1 },
        new: true
      }
    ).lean();

    return task ? mapTask(task as Record<string, unknown>) : undefined;
  }

  async createTaskRun(run: AgentTaskRun): Promise<AgentTaskRun> {
    if (isMemoryMode()) {
      db.agentTaskRuns.push(run);
      return run;
    }

    await AgentTaskRunModel.create(run);
    return run;
  }

  async updateTaskRun(runId: string, patch: Partial<AgentTaskRun>): Promise<AgentTaskRun> {
    if (isMemoryMode()) {
      const index = db.agentTaskRuns.findIndex((run) => run.id === runId);

      if (index === -1) {
        throw new Error("Task run not found.");
      }

      db.agentTaskRuns[index] = {
        ...db.agentTaskRuns[index],
        ...patch
      };

      return db.agentTaskRuns[index];
    }

    const run = await AgentTaskRunModel.findOneAndUpdate(
      { id: runId },
      { $set: patch },
      { new: true }
    ).lean();

    if (!run) {
      throw new Error("Task run not found.");
    }

    return mapTaskRun(run as Record<string, unknown>);
  }

  async createHandoff(handoff: AgentHandoff): Promise<AgentHandoff> {
    if (isMemoryMode()) {
      db.agentHandoffs.push(handoff);
      return handoff;
    }

    await AgentHandoffModel.create(handoff);
    return handoff;
  }

  async resolveHandoff(handoffId: string, resolvedAt: string): Promise<AgentHandoff> {
    if (isMemoryMode()) {
      const index = db.agentHandoffs.findIndex((handoff) => handoff.id === handoffId);

      if (index === -1) {
        throw new Error("Handoff not found.");
      }

      db.agentHandoffs[index] = {
        ...db.agentHandoffs[index],
        status: "resolved",
        resolvedAt
      };

      return db.agentHandoffs[index];
    }

    const handoff = await AgentHandoffModel.findOneAndUpdate(
      { id: handoffId },
      { $set: { status: "resolved", resolvedAt } },
      { new: true }
    ).lean();

    if (!handoff) {
      throw new Error("Handoff not found.");
    }

    return mapHandoff(handoff as Record<string, unknown>);
  }

  async listOpenHandoffsByStudent(studentId: string, limit = 20): Promise<AgentHandoff[]> {
    if (isMemoryMode()) {
      return [...db.agentHandoffs]
        .filter((handoff) => handoff.studentId === studentId && handoff.status === "open")
        .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))
        .slice(0, limit);
    }

    const handoffs = await AgentHandoffModel.find({ studentId, status: "open" })
      .sort({ requestedAt: -1 })
      .limit(limit)
      .lean();
    return handoffs.map((handoff) => mapHandoff(handoff as Record<string, unknown>));
  }

  async createPolicyDecision(decision: PolicyDecision): Promise<PolicyDecision> {
    if (isMemoryMode()) {
      db.policyDecisions.push(decision);
      return decision;
    }

    await PolicyDecisionModel.create(decision);
    return decision;
  }

  async getStudentMemory(studentId: string): Promise<StudentMemory | undefined> {
    if (isMemoryMode()) {
      return db.studentMemories.find((memory) => memory.studentId === studentId);
    }

    const memory = await StudentMemoryModel.findOne({ studentId }).lean();
    return memory ? mapMemory(memory as Record<string, unknown>) : undefined;
  }

  async saveStudentMemory(memory: StudentMemory): Promise<StudentMemory> {
    if (isMemoryMode()) {
      const index = db.studentMemories.findIndex((item) => item.studentId === memory.studentId);

      if (index === -1) {
        db.studentMemories.push(memory);
      } else {
        db.studentMemories[index] = memory;
      }

      return memory;
    }

    await StudentMemoryModel.findOneAndUpdate(
      { studentId: memory.studentId },
      { $set: memory },
      { upsert: true, new: true }
    );

    return memory;
  }

  async createEvent(event: AgentEvent): Promise<AgentEvent> {
    if (isMemoryMode()) {
      db.agentEvents.push(event);
      return event;
    }

    await AgentEventModel.create(event);
    return event;
  }

  async listEventsByStudent(studentId: string, limit = 25): Promise<AgentEvent[]> {
    if (isMemoryMode()) {
      return [...db.agentEvents]
        .filter((event) => event.studentId === studentId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, limit);
    }

    const events = await AgentEventModel.find({ studentId }).sort({ createdAt: -1 }).limit(limit).lean();
    return events.map((event) => mapEvent(event as Record<string, unknown>));
  }

  async getControlPlaneSnapshot(studentId: string): Promise<AgentControlPlaneSnapshot> {
    const [goals, tasks, handoffs, recentEvents, memory] = await Promise.all([
      this.listGoalsByStudent(studentId, 10),
      this.listTasks({ studentId, limit: 20 }),
      this.listOpenHandoffsByStudent(studentId, 10),
      this.listEventsByStudent(studentId, 20),
      this.getStudentMemory(studentId)
    ]);

    return {
      goals,
      tasks,
      handoffs,
      recentEvents,
      memory
    };
  }
}

function compareRunnableTasks(left: AgentTask, right: AgentTask) {
  if (left.priority !== right.priority) {
    return right.priority - left.priority;
  }

  if (left.runAfter !== right.runAfter) {
    return left.runAfter.localeCompare(right.runAfter);
  }

  return left.createdAt.localeCompare(right.createdAt);
}

function isExpired(value: string | undefined, nowIso: string) {
  return !value || value <= nowIso;
}

function mapGoal(goal: Record<string, unknown>): AgentGoal {
  return {
    id: String(goal.id),
    studentId: String(goal.studentId),
    applicationId: typeof goal.applicationId === "string" ? goal.applicationId : undefined,
    type: String(goal.type) as AgentGoal["type"],
    status: String(goal.status) as AgentGoal["status"],
    title: String(goal.title),
    summary: String(goal.summary),
    currentTaskId: typeof goal.currentTaskId === "string" ? goal.currentTaskId : undefined,
    metadata: isRecord(goal.metadata) ? goal.metadata : undefined,
    createdAt: String(goal.createdAt),
    updatedAt: String(goal.updatedAt),
    completedAt: typeof goal.completedAt === "string" ? goal.completedAt : undefined
  };
}

function mapTask(task: Record<string, unknown>): AgentTask {
  return {
    id: String(task.id),
    goalId: String(task.goalId),
    studentId: String(task.studentId),
    applicationId: typeof task.applicationId === "string" ? task.applicationId : undefined,
    workerType: String(task.workerType) as AgentTask["workerType"],
    kind: String(task.kind) as AgentTask["kind"],
    status: String(task.status) as AgentTask["status"],
    title: String(task.title),
    priority: Number(task.priority ?? 50),
    payload: isRecord(task.payload) ? task.payload : {},
    result: isRecord(task.result) ? task.result : undefined,
    runAfter: String(task.runAfter),
    attemptCount: Number(task.attemptCount ?? 0),
    maxAttempts: Number(task.maxAttempts ?? 3),
    leasedTo: typeof task.leasedTo === "string" ? task.leasedTo : undefined,
    leaseExpiresAt: typeof task.leaseExpiresAt === "string" ? task.leaseExpiresAt : undefined,
    lastError: typeof task.lastError === "string" ? task.lastError : undefined,
    createdAt: String(task.createdAt),
    updatedAt: String(task.updatedAt),
    completedAt: typeof task.completedAt === "string" ? task.completedAt : undefined
  };
}

function mapTaskRun(run: Record<string, unknown>): AgentTaskRun {
  return {
    id: String(run.id),
    taskId: String(run.taskId),
    workerType: String(run.workerType) as AgentTaskRun["workerType"],
    status: String(run.status) as AgentTaskRun["status"],
    leaseOwner: String(run.leaseOwner),
    summary: String(run.summary ?? ""),
    errorMessage: typeof run.errorMessage === "string" ? run.errorMessage : undefined,
    inputSnapshot: isRecord(run.inputSnapshot) ? run.inputSnapshot : undefined,
    outputSnapshot: isRecord(run.outputSnapshot) ? run.outputSnapshot : undefined,
    startedAt: String(run.startedAt),
    completedAt: typeof run.completedAt === "string" ? run.completedAt : undefined
  };
}

function mapHandoff(handoff: Record<string, unknown>): AgentHandoff {
  return {
    id: String(handoff.id),
    goalId: String(handoff.goalId),
    studentId: String(handoff.studentId),
    taskId: typeof handoff.taskId === "string" ? handoff.taskId : undefined,
    applicationId: typeof handoff.applicationId === "string" ? handoff.applicationId : undefined,
    status: String(handoff.status) as AgentHandoff["status"],
    kind: String(handoff.kind) as AgentHandoff["kind"],
    title: String(handoff.title),
    detail: String(handoff.detail),
    requestedAt: String(handoff.requestedAt),
    resolvedAt: typeof handoff.resolvedAt === "string" ? handoff.resolvedAt : undefined
  };
}

function mapMemory(memory: Record<string, unknown>): StudentMemory {
  return {
    studentId: String(memory.studentId),
    successfulApplicationCount: Number(memory.successfulApplicationCount ?? 0),
    blockedSourceTypes: Array.isArray(memory.blockedSourceTypes) ? memory.blockedSourceTypes.map(String) : [],
    recentHandoffKinds: Array.isArray(memory.recentHandoffKinds)
      ? memory.recentHandoffKinds.map((kind) => String(kind) as StudentMemory["recentHandoffKinds"][number])
      : [],
    corrections: Array.isArray(memory.corrections)
      ? memory.corrections.map((entry) => {
          const next = entry as Record<string, unknown>;
          return {
            label: String(next.label ?? ""),
            value: String(next.value ?? ""),
            updatedAt: String(next.updatedAt ?? "")
          };
        })
      : [],
    notes: Array.isArray(memory.notes) ? memory.notes.map(String) : [],
    lastUpdatedAt: String(memory.lastUpdatedAt ?? "")
  };
}

function mapEvent(event: Record<string, unknown>): AgentEvent {
  return {
    id: String(event.id),
    studentId: String(event.studentId),
    type: String(event.type) as AgentEvent["type"],
    message: String(event.message),
    goalId: typeof event.goalId === "string" ? event.goalId : undefined,
    taskId: typeof event.taskId === "string" ? event.taskId : undefined,
    applicationId: typeof event.applicationId === "string" ? event.applicationId : undefined,
    metadata: isRecord(event.metadata) ? event.metadata : undefined,
    createdAt: String(event.createdAt)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
