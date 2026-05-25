import type {
  AgentCapabilities,
  BrowserApplyReceipt,
  FilledField,
  Job,
  PlannerCheckpoint,
  ResumeRecord,
  StudentMemory,
  StudentProfile
} from "@gradlaunch/shared";
import { BrowserAgentEngine } from "./browser-agent/engine";

export class BrowserAgentAdapterService {
  constructor(private readonly browserAgent = new BrowserAgentEngine()) {}

  async getCapabilities(): Promise<AgentCapabilities> {
    const browserAvailability = await this.browserAgent.getAvailability();

    return {
      adapterId: "gradlaunch-browser-agent",
      adapterLabel: "GradLaunch Browser Agent",
      capabilities: [
        {
          id: "browser_apply",
          label: "Autonomous browser agent",
          status: browserAvailability.available ? "available" : "unavailable",
          source: "gradlaunch",
          detail: browserAvailability.available
            ? "GradLaunch can launch Chrome and fill job forms with the built-in browser agent."
            : browserAvailability.message
        },
        {
          id: "manual_handoff",
          label: "Manual handoff gates",
          status: "available",
          source: "gradlaunch",
          detail: "Login, captcha, OTP, verification, and unknown required data pause the browser run instead of guessing."
        }
      ],
      limitations: browserAvailability.available
        ? ["Application answers are kept in profile/run context; persistent browser artifacts are opt-in only."]
        : [browserAvailability.message]
    };
  }

  async applyWithBrowser(input: {
    studentId?: string;
    applicationId?: string;
    runId?: string;
    executionSessionId?: string;
    job: Job;
    fields: FilledField[];
    resume?: ResumeRecord;
    student?: StudentProfile;
    memory?: StudentMemory;
    submit: boolean;
    planner?: PlannerCheckpoint;
  }): Promise<BrowserApplyReceipt> {
    return this.browserAgent.apply(input);
  }
}
