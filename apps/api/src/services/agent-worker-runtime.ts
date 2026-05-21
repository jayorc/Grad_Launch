import type { AgentTask, AgentTaskRun } from "@gradlaunch/shared";
import { createId } from "../lib/id";
import { nowIso } from "../lib/time";
import { AgentRepository } from "../repositories/agent-repository";
import { AgentOrchestratorService } from "./agent-orchestrator-service";
import { AgentTaskHandlerService } from "./agent-task-handler-service";

type RuntimeOptions = {
  pollIntervalMs?: number;
  leaseMs?: number;
};

export class AgentWorkerRuntime {
  private timer: NodeJS.Timeout | undefined;
  private readonly workerId = `agent-runtime-${process.pid}`;
  private busy = false;

  constructor(
    private readonly repository = new AgentRepository(),
    private readonly orchestrator = new AgentOrchestratorService(),
    private readonly handlers = new AgentTaskHandlerService(),
    private readonly options: RuntimeOptions = {}
  ) {}

  start() {
    if (this.timer) {
      return;
    }

    const interval = this.options.pollIntervalMs ?? Number(process.env.AGENT_WORKER_POLL_MS ?? 2500);
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
    void this.tick();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick() {
    if (this.busy) {
      return;
    }

    this.busy = true;

    try {
      const task = await this.repository.claimNextRunnableTask({
        leaseOwner: this.workerId,
        leaseMs: this.options.leaseMs ?? Number(process.env.AGENT_TASK_LEASE_MS ?? 120000)
      });

      if (!task) {
        return;
      }

      await this.executeTask(task);
    } finally {
      this.busy = false;
    }
  }

  private async executeTask(task: AgentTask) {
    const run: AgentTaskRun = {
      id: createId("task_run"),
      taskId: task.id,
      workerType: task.workerType,
      status: "running",
      leaseOwner: this.workerId,
      summary: `Started ${task.workerType} task.`,
      inputSnapshot: task.payload,
      startedAt: nowIso()
    };

    await this.repository.createTaskRun(run);
    await this.orchestrator.createEvent({
      studentId: task.studentId,
      goalId: task.goalId,
      taskId: task.id,
      applicationId: task.applicationId,
      type: "task.started",
      message: `Started ${task.workerType} task: ${task.title}.`,
      metadata: {
        kind: task.kind,
        attempt: task.attemptCount
      }
    });

    try {
      const result = await this.handlers.handle(task);
      const completedAt = nowIso();

      await this.repository.updateTaskRun(run.id, {
        status: "completed",
        summary: result.summary,
        outputSnapshot: result.result,
        completedAt
      });

      await this.orchestrator.updateTask(task.id, {
        status: result.status,
        result: result.result,
        leasedTo: undefined,
        leaseExpiresAt: undefined,
        completedAt: result.status === "completed" ? completedAt : undefined,
        lastError: undefined
      });

      if (result.goalStatus) {
        await this.orchestrator.updateGoal(task.goalId, {
          status: result.goalStatus,
          summary: result.summary,
          completedAt: result.goalStatus === "completed" ? completedAt : undefined
        });
      }

      await this.orchestrator.createEvent({
        studentId: task.studentId,
        goalId: task.goalId,
        taskId: task.id,
        applicationId: task.applicationId,
        type: result.status === "completed" ? "task.completed" : "task.waiting",
        message: result.summary,
        metadata: result.result
      });
    } catch (error) {
      await this.handleTaskFailure(task, run, error);
    }
  }

  private async handleTaskFailure(task: AgentTask, run: AgentTaskRun, error: unknown) {
    const now = nowIso();
    const message = error instanceof Error ? error.message : "Unknown agent task failure.";
    const willRetry = task.attemptCount < task.maxAttempts;

    await this.repository.updateTaskRun(run.id, {
      status: "failed",
      summary: message,
      errorMessage: message,
      completedAt: now
    });

    await this.orchestrator.updateTask(task.id, {
      status: willRetry ? "queued" : "failed",
      lastError: message,
      leasedTo: undefined,
      leaseExpiresAt: undefined,
      runAfter: willRetry ? new Date(Date.now() + task.attemptCount * 15_000).toISOString() : task.runAfter,
      completedAt: willRetry ? undefined : now
    });

    await this.orchestrator.updateGoal(task.goalId, {
      status: willRetry ? "running" : "failed",
      summary: willRetry
        ? `Task failed and will retry: ${message}`
        : `Task failed permanently: ${message}`,
      completedAt: willRetry ? undefined : now
    });

    await this.orchestrator.createEvent({
      studentId: task.studentId,
      goalId: task.goalId,
      taskId: task.id,
      applicationId: task.applicationId,
      type: "task.failed",
      message: willRetry
        ? `Task failed and was re-queued: ${message}`
        : `Task failed permanently: ${message}`,
      metadata: {
        attempts: task.attemptCount,
        maxAttempts: task.maxAttempts
      }
    });
  }
}
