import type { AgentGoalStatus, AgentTask, AgentTaskStatus, Application, Job, PlannerCheckpoint, StudentProfile } from "@gradlaunch/shared";
import { nowIso } from "../lib/time";
import { ApplicationRepository } from "../repositories/application-repository";
import { JobRepository } from "../repositories/job-repository";
import { ResumeRepository } from "../repositories/resume-repository";
import { StudentRepository } from "../repositories/student-repository";
import { MatchingService } from "./matching-service";
import { BrowserAgentAdapterService } from "./browser-agent-adapter-service";
import { AgentOrchestratorService } from "./agent-orchestrator-service";
import { PolicyEngineService } from "./policy-engine-service";
import { StudentMemoryService } from "./student-memory-service";
import { ApplicationService } from "./application-service";

type TaskExecutionResult = {
  status: Extract<AgentTaskStatus, "completed" | "waiting" | "blocked">;
  summary: string;
  goalStatus?: Extract<AgentGoalStatus, "running" | "waiting" | "completed" | "blocked">;
  result?: Record<string, unknown>;
};

export class AgentTaskHandlerService {
  constructor(
    private readonly students = new StudentRepository(),
    private readonly jobs = new JobRepository(),
    private readonly applications = new ApplicationRepository(),
    private readonly resumes = new ResumeRepository(),
    private readonly matching = new MatchingService(),
    private readonly browserAgent = new BrowserAgentAdapterService(),
    private readonly orchestrator = new AgentOrchestratorService(),
    private readonly policy = new PolicyEngineService(),
    private readonly memory = new StudentMemoryService()
  ) {}

  async handle(task: AgentTask): Promise<TaskExecutionResult> {
    switch (task.kind) {
      case "rank_application":
        return this.handleRanking(task);
      case "prepare_application_draft":
        return this.handleDrafting(task);
      case "plan_application":
        return this.handlePlanning(task);
      case "execute_browser_apply":
        return this.handleBrowserExecution(task);
      case "send_notification":
        return this.handleNotification(task);
      case "recover_autonomy":
        return this.handleRecovery(task);
      case "refresh_job_discovery":
      case "intake_job_url":
        return this.handlePlaceholder(task);
      default:
        return {
          status: "blocked",
          goalStatus: "blocked",
          summary: `Unsupported task kind: ${task.kind}.`
        };
    }
  }

  private async handleRanking(task: AgentTask): Promise<TaskExecutionResult> {
    const context = await this.getApplicationContext(task);
    const recommendation = this.matching.scoreJob(context.student, context.job, context.student.defaultStrictness);

    if (recommendation.score !== context.application.matchScore) {
      await this.applications.update({
        ...context.application,
        matchScore: recommendation.score,
        lastUpdatedAt: nowIso()
      });
    }

    await this.orchestrator.createEvent({
      studentId: context.student.id,
      goalId: task.goalId,
      taskId: task.id,
      applicationId: context.application.id,
      type: "task.completed",
      message: `Ranking worker refreshed the match score to ${recommendation.score}.`,
      metadata: {
        reasons: recommendation.reasons
      }
    });

    await this.orchestrator.queueTask({
      goalId: task.goalId,
      studentId: context.student.id,
      applicationId: context.application.id,
      workerType: "drafting",
      kind: "prepare_application_draft",
      title: "Prepare autonomous draft context",
      priority: 80,
      payload: {
        recommendationScore: recommendation.score
      }
    });

    return {
      status: "completed",
      goalStatus: "running",
      summary: `Match score refreshed to ${recommendation.score}. Drafting worker queued next.`,
      result: {
        matchScore: recommendation.score
      }
    };
  }

  private async handleDrafting(task: AgentTask): Promise<TaskExecutionResult> {
    const context = await this.getApplicationContext(task);
    const latestResume = await this.resumes.getLatestByStudent(context.student.id);

    await this.orchestrator.createEvent({
      studentId: context.student.id,
      goalId: task.goalId,
      taskId: task.id,
      applicationId: context.application.id,
      type: "task.completed",
      message: "Drafting worker confirmed that the autonomous application package is ready for planning.",
      metadata: {
        hasResume: Boolean(latestResume),
        shortAnswerCount: context.application.generatedArtifacts.shortAnswers.length
      }
    });

    await this.orchestrator.queueTask({
      goalId: task.goalId,
      studentId: context.student.id,
      applicationId: context.application.id,
      workerType: "application_planner",
      kind: "plan_application",
      title: "Evaluate policy and pick the next safe action",
      priority: 100,
      payload: {
        resumeId: latestResume?.id
      }
    });

    return {
      status: "completed",
      goalStatus: "running",
      summary: "Draft context verified. Planner worker queued."
    };
  }

  private async handlePlanning(task: AgentTask): Promise<TaskExecutionResult> {
    const context = await this.getApplicationContext(task);
    const capabilities = await this.browserAgent.getCapabilities();
    const runs = await this.applications.listRunsByApplication(context.application.id);
    const latestRun = runs[0];
    const memory = await this.memory.get(context.student.id);
    const decision = this.policy.evaluateApplicationAutonomy({
      scope: "plan_application",
      student: context.student,
      job: context.job,
      application: context.application,
      capabilities,
      planner: latestRun?.planner,
      memory
    });

    decision.taskId = task.id;
    await this.orchestrator.recordPolicyDecision(decision);

    if (decision.action === "allow") {
      await this.orchestrator.queueTask({
        goalId: task.goalId,
        studentId: context.student.id,
        applicationId: context.application.id,
        workerType: "browser_executor",
        kind: "execute_browser_apply",
        title: "Run browser executor toward submit",
        priority: 100,
        payload: {
          applicationId: context.application.id
        }
      });

      await this.orchestrator.updateGoal(task.goalId, {
        status: "running",
        summary: "Policy approved autonomous execution. Browser worker queued."
      });

      return {
        status: "completed",
        goalStatus: "running",
        summary: decision.reason,
        result: {
          policyAction: decision.action,
          confidence: decision.confidence
        }
      };
    }

    const status = decision.action === "block" ? "blocked" : "waiting";
    const goalStatus = decision.action === "block" ? "blocked" : "waiting";
    const applicationStatus = decision.action === "block" ? "blocked" : "ready_for_review";

    await this.applications.update({
      ...context.application,
      status: applicationStatus,
      lastUpdatedAt: nowIso()
    });

    await this.orchestrator.createHandoff({
      goalId: task.goalId,
      studentId: context.student.id,
      taskId: task.id,
      applicationId: context.application.id,
      kind: decision.action === "pause" ? "policy" : "review",
      title: decision.action === "block" ? "Autonomous flow blocked by policy" : "Autonomous flow paused for review",
      detail: decision.reason
    });

    await this.memory.recordHandoff(context.student.id, decision.action === "pause" ? "policy" : "review", decision.reason);
    await this.orchestrator.queueTask({
      goalId: task.goalId,
      studentId: context.student.id,
      applicationId: context.application.id,
      workerType: "notifications",
      kind: "send_notification",
      title: "Record autonomous planner outcome",
      priority: 40,
      payload: {
        outcome: decision.action,
        reason: decision.reason
      }
    });

    return {
      status,
      goalStatus,
      summary: decision.reason,
      result: {
        policyAction: decision.action,
        confidence: decision.confidence
      }
    };
  }

  private async handleBrowserExecution(task: AgentTask): Promise<TaskExecutionResult> {
    const context = await this.getApplicationContext(task);
    const result = await new ApplicationService().submit({
      applicationId: context.application.id,
      studentId: context.student.id,
      intent: "auto_submit",
      reviewedFields: [],
      confirmExternalSubmit: false
    });

    const browserStatus = result.run.submission?.browser?.status;

    if (result.application.status === "submitted" || browserStatus === "submitted") {
      await this.memory.recordSubmissionOutcome({
        studentId: context.student.id,
        sourceType: context.job.sourceType,
        success: true,
        note: `Autonomous browser executor submitted ${context.job.company} - ${context.job.title}.`
      });

      await this.orchestrator.queueTask({
        goalId: task.goalId,
        studentId: context.student.id,
        applicationId: context.application.id,
        workerType: "notifications",
        kind: "send_notification",
        title: "Record successful autonomous outcome",
        priority: 30,
        payload: {
          outcome: "submitted"
        }
      });

      return {
        status: "completed",
        goalStatus: "completed",
        summary: result.run.submission?.confirmation ?? "Autonomous browser run submitted successfully.",
        result: {
          browserStatus
        }
      };
    }

    const handoffKind = inferHandoffKind(
      result.run.blockedReason ?? result.run.submission?.browser?.message,
      result.run.submission?.browser?.planner
    );
    const blocked = result.application.status === "blocked" || browserStatus === "blocked";

    await this.memory.recordSubmissionOutcome({
      studentId: context.student.id,
      sourceType: context.job.sourceType,
      success: false,
      note: result.run.blockedReason ?? result.run.submission?.browser?.message
    });
    await this.memory.recordHandoff(context.student.id, handoffKind, result.run.blockedReason ?? result.run.submission?.browser?.message);

    await this.orchestrator.createHandoff({
      goalId: task.goalId,
      studentId: context.student.id,
      taskId: task.id,
      applicationId: context.application.id,
      kind: handoffKind,
      title: blocked ? "Browser executor blocked" : "Browser executor needs manual handoff",
      detail: result.run.blockedReason ?? result.run.submission?.browser?.message ?? "Manual intervention is required."
    });

    await this.orchestrator.queueTask({
      goalId: task.goalId,
      studentId: context.student.id,
      applicationId: context.application.id,
      workerType: "notifications",
      kind: "send_notification",
      title: "Record blocked autonomous outcome",
      priority: 30,
      payload: {
        outcome: blocked ? "blocked" : "waiting",
        browserStatus
      }
    });

    return {
      status: blocked ? "blocked" : "waiting",
      goalStatus: blocked ? "blocked" : "waiting",
      summary: result.run.blockedReason ?? result.run.submission?.browser?.message ?? "Manual intervention is required.",
      result: {
        browserStatus
      }
    };
  }

  private async handleNotification(task: AgentTask): Promise<TaskExecutionResult> {
    const outcome = typeof task.payload.outcome === "string" ? task.payload.outcome : "recorded";

    await this.orchestrator.createEvent({
      studentId: task.studentId,
      goalId: task.goalId,
      taskId: task.id,
      applicationId: task.applicationId,
      type: "task.completed",
      message: `Notification worker recorded autonomous outcome: ${outcome}.`,
      metadata: task.payload
    });

    return {
      status: "completed",
      summary: `Notification outcome recorded: ${outcome}.`
    };
  }

  private async handleRecovery(task: AgentTask): Promise<TaskExecutionResult> {
    await this.orchestrator.createEvent({
      studentId: task.studentId,
      goalId: task.goalId,
      taskId: task.id,
      applicationId: task.applicationId,
      type: "task.waiting",
      message: "Recovery worker noted a blocked autonomous run and is waiting for a future resume strategy.",
      metadata: task.payload
    });

    return {
      status: "waiting",
      goalStatus: "waiting",
      summary: "Recovery worker parked this run for a future resume strategy."
    };
  }

  private async handlePlaceholder(task: AgentTask): Promise<TaskExecutionResult> {
    await this.orchestrator.createEvent({
      studentId: task.studentId,
      goalId: task.goalId,
      taskId: task.id,
      applicationId: task.applicationId,
      type: "task.completed",
      message: `${task.workerType} worker scaffold is available and ready for future expansion.`,
      metadata: {
        kind: task.kind
      }
    });

    return {
      status: "completed",
      summary: `${task.workerType} worker scaffold executed.`
    };
  }

  private async getApplicationContext(task: AgentTask): Promise<{
    student: StudentProfile;
    application: Application;
    job: Job;
  }> {
    const applicationId = typeof task.applicationId === "string" ? task.applicationId : String(task.payload.applicationId ?? "");
    const application = await this.applications.getById(applicationId);

    if (!application) {
      throw new Error("Application not found for autonomous task.");
    }

    const [student, job] = await Promise.all([
      this.students.getById(application.studentId),
      this.jobs.getById(application.jobId)
    ]);

    if (!student || !job) {
      throw new Error("Student or job not found for autonomous task.");
    }

    return {
      student,
      application,
      job
    };
  }
}

function inferHandoffKind(message: string | undefined, planner?: PlannerCheckpoint) {
  const plannerAction = planner?.lastDecision?.kind;

  if (plannerAction === "wait_for_captcha") {
    return "captcha" as const;
  }

  if (plannerAction === "wait_for_otp") {
    return "otp" as const;
  }

  if (plannerAction === "wait_for_login") {
    return "login" as const;
  }

  if (plannerAction === "wait_for_verification") {
    return "verification" as const;
  }

  if (plannerAction === "wait_for_user_input") {
    return "missing_data" as const;
  }

  const value = (message ?? "").toLowerCase();

  if (value.includes("captcha")) {
    return "captcha" as const;
  }

  if (value.includes("otp")) {
    return "otp" as const;
  }

  if (value.includes("login") || value.includes("password") || value.includes("sign in")) {
    return "login" as const;
  }

  if (value.includes("verification")) {
    return "verification" as const;
  }

  return "review" as const;
}
