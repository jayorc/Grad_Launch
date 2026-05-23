import { request as httpRequest } from "node:http";
import { lstat, mkdir, readFile, readlink, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AgentHandoffKind, BrowserApplyReceipt } from "@gradlaunch/shared";
import { chromium, type Browser, type BrowserContext, type Dialog, type Frame, type Page } from "playwright-core";
import { getBrowserWorkspaceStorageDir, getLoggedBrowserProfileDir, getManagedBrowserProfileDir } from "../../config/storage";
import { nowIso } from "../../lib/time";
import { buildStageAnswerPlan } from "./answer";
import { evaluateStageReadiness } from "./eval";
import { attachResume, fillFormField } from "./fill";
import { buildStageExecutionPlan } from "./plan";
import {
  bumpPlannerRetries,
  completePlannerStage,
  createPlannerCheckpoint,
  markPlannerTask,
  notePlannerHandoff,
  plannerActionFromBrowserAction,
  plannerEnterStage,
  recordPlannerDecision,
  recordPlannerObservation,
  recordPlannerStageOutcome,
  recordPlannerValidation,
  setPlannerStatus
} from "./planner";
import { reflectOnStageAnswers } from "./reflect";
import {
  autoResolveConsentControls,
  clickFinalSubmit,
  clickNextStageControl,
  clickSoftGate,
  detectProtectedCheckpoint,
  getStageSignature,
  discoverVisibleFields,
  getActivePage,
  getPageFingerprint,
  matchesSavedStageSignature,
  getVisibleRequiredEmptyLabels,
  getVisibleValidationMessages,
  hasFileUpload,
  hasFinalSubmitControl,
  observeBrowserPage
} from "./observe";
import type { BrowserApplyInput, BrowserAvailability, HandoffRequest } from "./types";
import { BrowserExecutionSessionService } from "./session";
import { clearUserStopRequest, didUserRequestStop, updateLiveBot } from "./ui";
import { pathExists, writeBrowserDebug } from "./util";

const defaultChromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

type BrowserLaunchMode = "logged_cdp" | "logged_profile" | "managed_cdp" | "managed_profile" | "ephemeral";
type BrowserLaunchResult = {
  browser: Browser | undefined;
  context: BrowserContext;
  keepContextOpen: boolean;
  attachedToExistingBrowser: boolean;
  launchMode: BrowserLaunchMode;
};

export class BrowserAgentEngine {
  private readonly executionSessions = new BrowserExecutionSessionService();

  async getAvailability(): Promise<BrowserAvailability> {
    const loggedCdpUrl = shouldPreferLoggedBrowser() ? await resolveLoggedChromeCdpUrl() : undefined;

    if (loggedCdpUrl) {
      return {
        available: true,
        message: `Browser worker can attach to the logged Chrome session at ${loggedCdpUrl}.`
      };
    }

    if (process.env.BROWSER_AUTOFILL_ENABLED === "false") {
      return {
        available: false,
        message: "Browser autofill is disabled by BROWSER_AUTOFILL_ENABLED=false."
      };
    }

    const cdpUrl = await resolveManagedChromeCdpUrl();
    const chromePath = resolveChromePath();
    const chromeExists = await pathExists(chromePath);
    const loggedProfileDir = shouldPreferLoggedBrowser() ? getLoggedBrowserProfileDir() : undefined;

    if (chromeExists && loggedProfileDir && await pathExists(loggedProfileDir)) {
      const loggedProfileLocked = await isBrowserProfileLocked(loggedProfileDir, { clearStaleGradLaunchLock: true });

      if (loggedProfileLocked && shouldRequireLoggedBrowser()) {
        return {
          available: false,
          chromePath,
          message: buildLockedLoggedProfileMessage(loggedProfileDir)
        };
      }

      if (loggedProfileLocked) {
        return {
          available: true,
          chromePath,
          message: `The logged Chrome profile at ${loggedProfileDir} is already open without remote debugging, so GradLaunch will skip it and use the managed browser profile.`
        };
      }

      return {
        available: true,
        chromePath,
        message: `Browser worker will try the logged Chrome profile at ${loggedProfileDir} before the managed GradLaunch profile.`
      };
    }

    if (cdpUrl) {
      return {
        available: true,
        message: `Browser worker can attach to the managed GradLaunch browser session at ${cdpUrl}.`
      };
    }

    if (!chromeExists) {
      return {
        available: false,
        chromePath,
        message: `Chrome executable was not found at ${chromePath}.`
      };
    }

    return {
      available: true,
      chromePath,
      message: `Browser worker can launch the managed GradLaunch browser at ${chromePath}.`
    };
  }

  async apply(input: BrowserApplyInput): Promise<BrowserApplyReceipt> {
    const availability = await this.getAvailability();
    const openedAt = nowIso();
    const screenshots: string[] = [];
    const planner = createPlannerCheckpoint(input.job, input.planner);
    const sourceValidation = validateSourceUrl(input.job.sourceUrl);

    if (!sourceValidation.valid) {
      markPlannerTask(planner, "open_job_page", "blocked", sourceValidation.message);
      setPlannerStatus(planner, "blocked", sourceValidation.message);
      return blockedReceipt(input, openedAt, screenshots, planner, sourceValidation.message);
    }

    if (!availability.available) {
      markPlannerTask(planner, "open_job_page", "blocked", availability.message);
      setPlannerStatus(planner, "blocked", availability.message);
      return blockedReceipt(input, openedAt, screenshots, planner, availability.message);
    }

    const browserWorkspaceDir = getBrowserWorkspaceStorageDir();
    const workspacePath = input.workspacePath ?? join(browserWorkspaceDir, "runs");
    await mkdir(workspacePath, { recursive: true });
    await mkdir(browserWorkspaceDir, { recursive: true });
    await writeBrowserDebug(workspacePath, "browser-agent-start", {
      sourceUrl: input.job.sourceUrl,
      job: `${input.job.title} at ${input.job.company}`,
      fieldCount: input.fields.length,
      submit: input.submit
    });

    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let keepContextOpen = false;
    let attachedToExistingBrowser = false;
    let launchMode: BrowserLaunchMode = "ephemeral";
    let executionSessionId = input.executionSessionId;
    const resumeUrl = sanitizeBrowserResumeUrl(input.planner?.currentUrl);

    try {
      ({ browser, context, keepContextOpen, attachedToExistingBrowser, launchMode } = await launchContext(availability.chromePath));
      installContextSafety(context, workspacePath);
      console.log(
        `[GradLaunch][Browser] Mode=${launchMode} headless=${process.env.BROWSER_HEADLESS === "true"}`
      );
      await writeBrowserDebug(workspacePath, "browser-launch-mode", {
        mode: launchMode,
        attachedToExistingBrowser,
        keepContextOpen,
        preferLoggedProfile: shouldPreferLoggedBrowser()
      });
      const page = await openOrResumePage(context, input.job.sourceUrl, resumeUrl);
      await clearUserStopRequest(page);
      if (input.studentId && input.applicationId && input.runId) {
        const session = await this.executionSessions.createOrReuse({
          sessionId: executionSessionId,
          studentId: input.studentId,
          applicationId: input.applicationId,
          runId: input.runId,
          jobId: input.job.id,
          sourceUrl: input.job.sourceUrl,
          workspacePath,
          planner,
          latestMessage: "Opening the job page and reading the first stage."
        });
        executionSessionId = session.id;
      }
      await updateLiveBot(page, {
        title: "GradLaunch Bot",
        step: "Starting",
        mood: "thinking",
        message: "Opening the job page and reading the first stage."
      });
      page.setDefaultTimeout(Number(process.env.BROWSER_STEP_TIMEOUT_MS ?? 2500));
      markPlannerTask(planner, "open_job_page", "running", "Opening the target application URL in a new Chrome tab.");
      setPlannerStatus(planner, "running", "Opening the job page in a new Chrome tab.");
      await navigateToJobPage(page, resumeUrl ?? input.job.sourceUrl, workspacePath);
      let activePage = await getActivePage(context, page);
      markPlannerTask(planner, "open_job_page", "completed", "Job page opened successfully in a visible Chrome session.");
      planner.currentUrl = activePage.url();
      planner.currentStep = "prepare_application";
      planner.lastUpdatedAt = nowIso();
      await updateExecutionSession(this.executionSessions, executionSessionId, {
        status: "running",
        latestMessage: "The job page is open and the agent is scanning the current stage.",
        planner,
        currentUrl: activePage.url(),
        currentStageIndex: 0,
        currentStageLabel: "Opening",
        workspacePath,
        lastStageSignature: await getStageSignature(activePage),
        filledCount: 0,
        manualCount: 0
      });
      await saveScreenshot(activePage, workspacePath, screenshots, "browser-opened.png");
      await updateLiveBot(activePage, {
        step: "Page Opened",
        mood: "thinking",
        message: "Scanning the page to understand what this form needs."
      });
      await clickSoftGate(activePage);

      let initialCheckpoint = await detectProtectedCheckpoint(activePage);

      if (initialCheckpoint.blocked && initialCheckpoint.kind === "login") {
        const loginRecovery = await tryResolveLoginWithExistingProfile({
          context,
          page: activePage,
          sourceUrl: input.job.sourceUrl,
          studentEmail: resolveApplicantEmail(input),
          workspacePath,
          stageIndex: 0,
          reason: initialCheckpoint.reason
        });
        activePage = loginRecovery.activePage;
        initialCheckpoint = await detectProtectedCheckpoint(activePage);
      }

      if (initialCheckpoint.blocked) {
        await updateExecutionSession(this.executionSessions, executionSessionId, {
          status: "waiting",
          latestMessage: initialCheckpoint.reason ?? "The browser session is waiting for manual verification.",
          planner,
          currentUrl: activePage.url(),
          currentStageIndex: 0,
          currentStageLabel: "Protected checkpoint",
          workspacePath,
          lastStageSignature: await getStageSignature(activePage),
          pendingHandoff: {
            kind: mapCheckpointToHandoff(initialCheckpoint.kind) ?? "review",
            title: "Manual handoff required",
            detail: initialCheckpoint.reason ?? "A protected checkpoint must be cleared in the browser.",
            requestedAt: nowIso()
          }
        });
        const handoff = await waitForHumanIntervention({
          context,
          page: activePage,
          stageIndex: 0,
          workspacePath,
          screenshots,
          planner,
          reason: initialCheckpoint.reason ?? "Human intervention needed before GradLaunch can continue.",
          handoffKind: mapCheckpointToHandoff(initialCheckpoint.kind)
        });
        activePage = handoff.activePage;

        if (!handoff.resolved) {
          await updateExecutionSession(this.executionSessions, executionSessionId, {
            status: "waiting",
            latestMessage: "The browser session is waiting for login or verification to be completed.",
            planner,
            currentUrl: activePage.url(),
            currentStageIndex: 0,
            currentStageLabel: "Protected checkpoint",
            workspacePath,
            lastStageSignature: await getStageSignature(activePage),
            pendingHandoff: {
              kind: mapCheckpointToHandoff(initialCheckpoint.kind) ?? "review",
              title: "Manual handoff required",
              detail: initialCheckpoint.reason ?? "Login or verification is still required in the portal.",
              requestedAt: nowIso()
            }
          });
          return {
            status: "handoff_required",
            sourceUrl: input.job.sourceUrl,
            openedAt,
            completedAt: nowIso(),
            filledLabels: [],
            skippedLabels: input.fields.map((field) => field.label),
            screenshots,
            message: "GradLaunch paused for login or verification, but the gate did not clear before the handoff timeout.",
            planner
          };
        }
      }

      const filledLabels: string[] = [];
      const skippedLabels: string[] = [];
      const seenFilled = new Set<string>();
      const seenSkipped = new Set<string>();
      const maxStages = Number(process.env.BROWSER_MAX_FORM_STAGES ?? 8);
      const loopThreshold = Number(process.env.BROWSER_MAX_SAME_SCREEN_RETRIES ?? 2);
      let stageCount = 0;
      let resumeUploaded = false;
      let lastFingerprint = "";
      let sameScreenAttempts = 0;

      for (let stageIndex = 0; stageIndex < maxStages; stageIndex += 1) {
        if (!hasOpenPage(context)) {
          return await handleGracefulStop({
            reason: "The browser window was closed. GradLaunch saved the latest checkpoint so you can resume later.",
            input,
            openedAt,
            screenshots,
            planner,
            workspacePath,
            executionSessions: this.executionSessions,
            executionSessionId,
            activePage: undefined,
            filledLabels,
            skippedLabels,
            stageIndex
          });
        }

        stageCount = stageIndex + 1;
        activePage = await getActivePage(context, activePage);
        if (await didUserRequestStop(activePage)) {
          return await handleGracefulStop({
            reason: "GradLaunch stopped because you clicked Quit in the live bot.",
            input,
            openedAt,
            screenshots,
            planner,
            workspacePath,
            executionSessions: this.executionSessions,
            executionSessionId,
            activePage,
            filledLabels,
            skippedLabels,
            stageIndex
          });
        }
        plannerEnterStage(planner, activePage, stageIndex);
        await updateLiveBot(activePage, {
          step: `Stage ${stageIndex + 1}`,
          mood: "thinking",
          message: "Thinking through this stage and mapping the visible fields."
        });
        await saveScreenshot(activePage, workspacePath, screenshots, `browser-stage-${stageIndex + 1}-start.png`);
        await clickSoftGate(activePage);

        let protectedCheckpoint = await detectProtectedCheckpoint(activePage);

        if (protectedCheckpoint.blocked && protectedCheckpoint.kind === "login") {
          const loginRecovery = await tryResolveLoginWithExistingProfile({
            context,
            page: activePage,
            sourceUrl: input.job.sourceUrl,
            studentEmail: resolveApplicantEmail(input),
            workspacePath,
            stageIndex,
            reason: protectedCheckpoint.reason
          });
          activePage = loginRecovery.activePage;
          protectedCheckpoint = await detectProtectedCheckpoint(activePage);
        }

        if (protectedCheckpoint.blocked) {
          await updateExecutionSession(this.executionSessions, executionSessionId, {
            status: "waiting",
            latestMessage: protectedCheckpoint.reason ?? `The browser session is waiting on Stage ${stageIndex + 1}.`,
            planner,
            currentUrl: activePage.url(),
            currentStageIndex: stageIndex,
            currentStageLabel: `Stage ${stageIndex + 1}`,
            workspacePath,
            lastStageSignature: await getStageSignature(activePage),
            filledCount: filledLabels.length,
            manualCount: skippedLabels.length,
            pendingHandoff: {
              kind: mapCheckpointToHandoff(protectedCheckpoint.kind) ?? "review",
              title: "Manual handoff required",
              detail: protectedCheckpoint.reason ?? "A protected checkpoint must be cleared in the browser.",
              requestedAt: nowIso()
            }
          });
          const handoff = await waitForHumanIntervention({
            context,
            page: activePage,
            stageIndex,
            workspacePath,
            screenshots,
            planner,
            reason: protectedCheckpoint.reason ?? "Human intervention needed before GradLaunch can continue.",
            handoffKind: mapCheckpointToHandoff(protectedCheckpoint.kind)
          });
          activePage = handoff.activePage;

          if (!handoff.resolved) {
            return {
              status: "handoff_required",
              sourceUrl: input.job.sourceUrl,
              openedAt,
              completedAt: nowIso(),
              filledLabels,
              skippedLabels,
              screenshots,
              message: "The job portal still needs manual attention before GradLaunch can continue.",
              planner
            };
          }

          continue;
        }

        const visibleFields = await discoverVisibleFields(activePage);
        const observation = await observeBrowserPage(activePage, visibleFields);
        const stageSignature = await getStageSignature(activePage, observation);
        const stagePlan = buildStageExecutionPlan({
          observation,
          resumeAvailable: Boolean(input.resume?.storagePath),
          submitRequested: input.submit,
          allowExternalSubmit: process.env.BROWSER_ALLOW_EXTERNAL_SUBMIT === "true"
        });
        const requiredLabels = visibleFields.filter((field) => field.required).map((field) => field.label);
        recordPlannerObservation({
          planner,
          page: activePage,
          stageIndex,
          visibleFieldLabels: visibleFields.map((field) => field.label),
          requiredFieldLabels: requiredLabels
        });

        const fingerprint = await getPageFingerprint(activePage);

        if (fingerprint === lastFingerprint) {
          sameScreenAttempts += 1;
        } else {
          sameScreenAttempts = 0;
          lastFingerprint = fingerprint;
        }

        await writeBrowserDebug(workspacePath, "stage-plan", {
          stageIndex,
          pageState: observation.pageState,
          action: stagePlan.action,
          confidence: stagePlan.confidence,
          reason: stagePlan.reason,
          checklist: stagePlan.checklist
        });
        await updateLiveBot(activePage, {
          step: `Stage ${stageIndex + 1}`,
          mood: stagePlan.action === "ask_user" ? "waiting" : "thinking",
          message: stagePlan.reason
        });
        await updateExecutionSession(this.executionSessions, executionSessionId, {
          status: stagePlan.action === "ask_user" ? "waiting" : "running",
          latestMessage: stagePlan.reason,
          planner,
          currentUrl: activePage.url(),
          currentStageIndex: stageIndex,
          currentStageLabel: `Stage ${stageIndex + 1}`,
          workspacePath,
          lastStageSignature: stageSignature,
          filledCount: filledLabels.length,
          manualCount: skippedLabels.length
        });

        if (stagePlan.action === "ask_user" && (observation.pageState === "login" || observation.pageState === "account_gate")) {
          const loginRecovery = await tryResolveLoginWithExistingProfile({
            context,
            page: activePage,
            sourceUrl: input.job.sourceUrl,
            studentEmail: resolveApplicantEmail(input),
            workspacePath,
            stageIndex,
            reason: stagePlan.reason
          });

          if (loginRecovery.resolved) {
            activePage = loginRecovery.activePage;
            markPlannerTask(planner, "authenticate_if_needed", "running", "Login gate cleared using the existing browser profile. Resuming autonomous execution.");
            setPlannerStatus(planner, "running", "Login gate cleared using the existing browser profile.");
            continue;
          }

          const handoff = await waitForHumanIntervention({
            context,
            page: loginRecovery.activePage,
            stageIndex,
            workspacePath,
            screenshots,
            planner,
            reason: "Sign in is still required. Use Google/email in the open browser if the existing profile does not complete it automatically.",
            handoffKind: "login"
          });
          activePage = handoff.activePage;

          if (!handoff.resolved) {
            return {
              status: "handoff_required",
              sourceUrl: input.job.sourceUrl,
              openedAt,
              completedAt: nowIso(),
              filledLabels,
              skippedLabels,
              screenshots,
              message: "The job portal still needs login before GradLaunch can continue.",
              planner
            };
          }

          continue;
        }

        if (sameScreenAttempts > loopThreshold) {
          const message = `The agent saw the same screen repeatedly after ${sameScreenAttempts + 1} attempts and paused to avoid looping.`;
          bumpPlannerRetries(planner, "retry_alternative_path", message, activePage, stageIndex);
          setPlannerStatus(planner, "needs_review", message);
          await updateExecutionSession(this.executionSessions, executionSessionId, {
            status: "resumable",
            latestMessage: message,
            planner,
            currentUrl: activePage.url(),
            currentStageIndex: stageIndex,
            currentStageLabel: `Stage ${stageIndex + 1}`,
            workspacePath,
            lastStageSignature: stageSignature,
            filledCount: filledLabels.length,
            manualCount: skippedLabels.length
          });
          return {
            status: "needs_manual_review",
            sourceUrl: input.job.sourceUrl,
            openedAt,
            completedAt: nowIso(),
            filledLabels,
            skippedLabels,
            screenshots,
            message,
            planner
          };
        }

        if (!resumeUploaded && input.resume?.storagePath && await pathExists(input.resume.storagePath) && await hasFileUpload(activePage)) {
          if (await didUserRequestStop(activePage)) {
            return await handleGracefulStop({
              reason: "GradLaunch stopped because you clicked Quit in the live bot.",
              input,
              openedAt,
              screenshots,
              planner,
              workspacePath,
              executionSessions: this.executionSessions,
              executionSessionId,
              activePage,
              filledLabels,
              skippedLabels,
              stageIndex
            });
          }
          await updateLiveBot(activePage, {
            step: `Stage ${stageIndex + 1}`,
            mood: "acting",
            message: "Attaching your resume before filling the rest of the stage."
          });
          recordPlannerDecision({
            planner,
            page: activePage,
            stageIndex,
            kind: "upload_resume",
            source: "heuristic",
            reason: "Resume upload field detected on this screen.",
            fieldLabels: ["Resume upload"]
          });
          await writeBrowserDebug(workspacePath, "resume-upload-attempt", {
            stageIndex,
            resumePath: input.resume.storagePath
          });
          resumeUploaded = await attachResume(activePage, input.resume.storagePath);
          await writeBrowserDebug(workspacePath, "resume-upload-result", {
            stageIndex,
            uploaded: resumeUploaded
          });

          if (resumeUploaded && !seenFilled.has("resume upload")) {
            seenFilled.add("resume upload");
            filledLabels.push("Resume upload");
          }
        }

        let answerPlan: Awaited<ReturnType<typeof buildStageAnswerPlan>> | undefined;

        if (stagePlan.action === "fill" && visibleFields.length > 0) {
          answerPlan = await buildStageAnswerPlan({
            job: input.job,
            visibleFields,
            baseFields: input.fields,
            student: input.student,
            memory: input.memory,
            resumeText: input.resume?.extractedText,
            workspacePath
          });
          recordPlannerDecision({
            planner,
            page: activePage,
            stageIndex,
            kind: plannerActionFromBrowserAction("fill"),
            source: answerPlan.usedLlm ? "llm" : "heuristic",
            reason: answerPlan.summary ?? "Visible fields detected, so the agent is filling the current stage.",
            fieldLabels: answerPlan.answers.map((field) => field.label)
          });
          await updateLiveBot(activePage, {
            step: `Stage ${stageIndex + 1}`,
            mood: "acting",
            message: answerPlan.summary ?? `Filling ${answerPlan.answers.length} mapped answers on this stage.`
          });

          for (const field of answerPlan.answers) {
            if (await didUserRequestStop(activePage)) {
              return await handleGracefulStop({
                reason: "GradLaunch stopped because you clicked Quit in the live bot.",
                input,
                openedAt,
                screenshots,
                planner,
                workspacePath,
                executionSessions: this.executionSessions,
                executionSessionId,
                activePage,
                filledLabels,
                skippedLabels,
                stageIndex
              });
            }

            const filled = await fillFormField(activePage, field);
            const key = field.label.toLowerCase().trim();
            await writeBrowserDebug(workspacePath, filled ? "filled-field" : "failed-to-fill-field", {
              stageIndex,
              fieldId: field.fieldId,
              label: field.label,
              inputType: field.inputType,
              valuePreview: field.value.length > 80 ? `${field.value.slice(0, 77)}...` : field.value
            });

            if (filled) {
              if (!seenFilled.has(key)) {
                seenFilled.add(key);
                filledLabels.push(field.label);
              }
            } else if (!seenSkipped.has(key)) {
              seenSkipped.add(key);
              skippedLabels.push(field.label);
            }
          }

          await autoResolveConsentControls(activePage);
        }

        const submitVisible = await hasFinalSubmitControl(activePage);
        let outstandingRequired = await getVisibleRequiredEmptyLabels(activePage);
        let validationMessages = await getVisibleValidationMessages(activePage);
        const uploadStillPending = Boolean(
          input.resume?.storagePath
          && await pathExists(input.resume.storagePath)
          && await hasFileUpload(activePage)
          && !resumeUploaded
        );

        if (uploadStillPending && !outstandingRequired.some((label) => label.toLowerCase().includes("resume upload"))) {
          outstandingRequired = [...outstandingRequired, "Resume upload"];
        }

        let evaluation = evaluateStageReadiness({
          visibleFields,
          outstandingRequired,
          validationMessages,
          submitVisible,
          submitRequested: input.submit,
          allowExternalSubmit: process.env.BROWSER_ALLOW_EXTERNAL_SUBMIT === "true"
        });

        await writeBrowserDebug(workspacePath, "stage-evaluation", {
          stageIndex,
          status: evaluation.status,
          confidence: evaluation.confidence,
          reason: evaluation.reason,
          missingRequiredLabels: evaluation.missingRequiredLabels,
          validationMessages: evaluation.validationMessages
        });
        await updateLiveBot(activePage, {
          step: `Stage ${stageIndex + 1}`,
          mood: evaluation.status === "needs_user" ? "waiting" : evaluation.status === "needs_retry" ? "thinking" : "acting",
          message: evaluation.reason
        });

        if (stagePlan.action === "fill" && evaluation.status === "needs_retry") {
          const reflection = await reflectOnStageAnswers({
            job: input.job,
            student: input.student,
            memory: input.memory,
            visibleFields,
            attemptedAnswers: answerPlan?.answers ?? [],
            missingRequiredLabels: evaluation.missingRequiredLabels,
            validationMessages: evaluation.validationMessages,
            workspacePath
          }).catch(() => undefined);

          if (reflection?.improved) {
            await updateLiveBot(activePage, {
              step: `Stage ${stageIndex + 1}`,
              mood: "thinking",
              message: reflection.summary
            });
            recordPlannerDecision({
              planner,
              page: activePage,
              stageIndex,
              kind: "recover_validation",
              source: "llm",
              reason: reflection.summary,
              fieldLabels: reflection.answers.map((field) => field.label)
            });

            for (const field of reflection.answers) {
              if (await didUserRequestStop(activePage)) {
                return await handleGracefulStop({
                  reason: "GradLaunch stopped because you clicked Quit in the live bot.",
                  input,
                  openedAt,
                  screenshots,
                  planner,
                  workspacePath,
                  executionSessions: this.executionSessions,
                  executionSessionId,
                  activePage,
                  filledLabels,
                  skippedLabels,
                  stageIndex
                });
              }
              await fillFormField(activePage, field);
            }

            await autoResolveConsentControls(activePage);
            outstandingRequired = await getVisibleRequiredEmptyLabels(activePage);
            validationMessages = await getVisibleValidationMessages(activePage);
            evaluation = evaluateStageReadiness({
              visibleFields,
              outstandingRequired,
              validationMessages,
              submitVisible: await hasFinalSubmitControl(activePage),
              submitRequested: input.submit,
              allowExternalSubmit: process.env.BROWSER_ALLOW_EXTERNAL_SUBMIT === "true"
            });
          }
        }

        if (evaluation.status === "needs_user") {
          recordPlannerValidation(planner, evaluation.missingRequiredLabels);
          await updateExecutionSession(this.executionSessions, executionSessionId, {
            status: "waiting",
            latestMessage: `The browser session needs manual answers on Stage ${stageIndex + 1}.`,
            planner,
            currentUrl: activePage.url(),
            currentStageIndex: stageIndex,
            currentStageLabel: `Stage ${stageIndex + 1}`,
            workspacePath,
            lastStageSignature: await getStageSignature(activePage),
            filledCount: filledLabels.length,
            manualCount: skippedLabels.length,
            pendingHandoff: {
              kind: "missing_data",
              title: "Manual answers required",
              detail: `Required answers are still missing: ${evaluation.missingRequiredLabels.join(", ")}.`,
              requestedAt: nowIso()
            }
          });
          const handoff = await waitForHumanIntervention({
            context,
            page: activePage,
            stageIndex,
            workspacePath,
            screenshots,
            planner,
            reason: `GradLaunch needs your help with required answers on this screen: ${evaluation.missingRequiredLabels.join(", ")}.`,
            handoffKind: "missing_data",
            watchFields: evaluation.missingRequiredLabels
          });
          activePage = handoff.activePage;

          if (!handoff.resolved) {
            await updateExecutionSession(this.executionSessions, executionSessionId, {
              status: "waiting",
              latestMessage: `The browser session is waiting for manual answers on Stage ${stageIndex + 1}.`,
              planner,
              currentUrl: activePage.url(),
              currentStageIndex: stageIndex,
              currentStageLabel: `Stage ${stageIndex + 1}`,
              workspacePath,
              lastStageSignature: await getStageSignature(activePage),
              filledCount: filledLabels.length,
              manualCount: skippedLabels.length,
              pendingHandoff: {
                kind: "missing_data",
                title: "Manual answers required",
                detail: `Required answers are still missing: ${evaluation.missingRequiredLabels.join(", ")}.`,
                requestedAt: nowIso()
              }
            });
            return {
              status: "handoff_required",
              sourceUrl: input.job.sourceUrl,
              openedAt,
              completedAt: nowIso(),
              filledLabels,
              skippedLabels,
              screenshots,
              message: `GradLaunch paused because this screen still needs manual answers: ${evaluation.missingRequiredLabels.join(", ")}.`,
              planner
            };
          }

          continue;
        }

        if (evaluation.status === "needs_retry") {
          await updateLiveBot(activePage, {
            step: `Stage ${stageIndex + 1}`,
            mood: "waiting",
            message: `I hit a validation blocker and need a manual review: ${evaluation.validationMessages.join(", ")}.`
          });
          bumpPlannerRetries(planner, "recover_from_validation_errors", `Validation blockers appeared: ${evaluation.validationMessages.join(", ")}.`, activePage, stageIndex);
          await updateExecutionSession(this.executionSessions, executionSessionId, {
            status: "resumable",
            latestMessage: `Validation blockers stopped the agent on Stage ${stageIndex + 1}.`,
            planner,
            currentUrl: activePage.url(),
            currentStageIndex: stageIndex,
            currentStageLabel: `Stage ${stageIndex + 1}`,
            workspacePath,
            lastStageSignature: await getStageSignature(activePage),
            filledCount: filledLabels.length,
            manualCount: skippedLabels.length
          });
          return {
            status: "needs_manual_review",
            sourceUrl: input.job.sourceUrl,
            openedAt,
            completedAt: nowIso(),
            filledLabels,
            skippedLabels,
            screenshots,
            message: `GradLaunch found validation blockers after filling: ${evaluation.validationMessages.join(", ")}.`,
            planner
          };
        }

        if (evaluation.status === "ready_to_submit" || evaluation.status === "ready_for_review") {
          if (await didUserRequestStop(activePage)) {
            return await handleGracefulStop({
              reason: "GradLaunch stopped because you clicked Quit in the live bot.",
              input,
              openedAt,
              screenshots,
              planner,
              workspacePath,
              executionSessions: this.executionSessions,
              executionSessionId,
              activePage,
              filledLabels,
              skippedLabels,
              stageIndex
            });
          }

          if (input.submit && process.env.BROWSER_ALLOW_EXTERNAL_SUBMIT === "true") {
            await updateLiveBot(activePage, {
              step: `Stage ${stageIndex + 1}`,
              mood: "acting",
              message: "The form looks ready. Submitting now."
            });
            recordPlannerDecision({
              planner,
              page: activePage,
              stageIndex,
              kind: plannerActionFromBrowserAction("submit"),
              source: "heuristic",
              reason: "Final submit control detected and external submit is allowed."
            });
            const clicked = await clickFinalSubmit(activePage);

            if (!clicked) {
              setPlannerStatus(planner, "needs_review", "Final submit control was detected but could not be clicked safely.");
              return {
                status: "needs_manual_review",
                sourceUrl: input.job.sourceUrl,
                openedAt,
                completedAt: nowIso(),
                filledLabels,
                skippedLabels,
                screenshots,
                message: "GradLaunch reached the final submit step, but could not safely click submit.",
                planner
              };
            }

            await activePage.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => undefined);
            await activePage.waitForTimeout(1500).catch(() => undefined);
            await saveScreenshot(activePage, workspacePath, screenshots, "browser-submitted.png");
            markPlannerTask(planner, "reach_submit_gate", "completed", "Final submit action completed.");
            markPlannerTask(planner, "save_checkpoint", "completed", "Saved the final submitted planner state.");
            setPlannerStatus(planner, "completed", "Planner completed the submission flow successfully.");
            recordPlannerStageOutcome({
              planner,
              page: activePage,
              stageIndex,
              outcome: "submitted",
              filledFieldLabels: filledLabels
            });
            await updateExecutionSession(this.executionSessions, executionSessionId, {
              status: "submitted",
              latestMessage: "The browser agent submitted the application successfully.",
              planner,
              currentUrl: activePage.url(),
              currentStageIndex: stageIndex,
              currentStageLabel: `Stage ${stageIndex + 1}`,
              workspacePath,
              lastStageSignature: await getStageSignature(activePage),
              browserStatus: "submitted",
              filledCount: filledLabels.length,
              manualCount: skippedLabels.length,
              pendingHandoff: undefined
            });
            return {
              status: "submitted",
              sourceUrl: input.job.sourceUrl,
              openedAt,
              completedAt: nowIso(),
              filledLabels,
              skippedLabels,
              screenshots,
              message: "Chrome opened the job page, filled recognized fields, and submitted the application.",
              planner
            };
          }

          await updateLiveBot(activePage, {
            step: "Review Ready",
            mood: "done",
            message: "The form is filled and ready for your final review."
          });
          markPlannerTask(planner, "reach_submit_gate", "completed", "Reached the review/submit checkpoint safely.");
          markPlannerTask(planner, "save_checkpoint", "completed", "Saved planner state so the run can continue from the latest checkpoint.");
          setPlannerStatus(planner, "completed", "Planner completed the form fill and paused at the review gate.");
          recordPlannerStageOutcome({
            planner,
            page: activePage,
            stageIndex,
            outcome: input.submit ? "review" : "review",
            filledFieldLabels: filledLabels
          });
          keepContextOpen = shouldKeepBrowserOpenForReview();
          await maybeKeepBrowserOpen(context);
          await saveScreenshot(activePage, workspacePath, screenshots, "browser-filled.png");
          const manualAdvance = await waitForManualProgress({
            context,
            page: activePage,
            stageIndex,
            planner,
            workspacePath,
            baselineSignature: await getStageSignature(activePage),
            prompt: "This stage looks ready. If you move ahead manually, I will detect it and continue filling."
          });

          if (manualAdvance.resumed) {
            activePage = manualAdvance.activePage;
            continue;
          }

          await updateExecutionSession(this.executionSessions, executionSessionId, {
            status: "review_ready",
            latestMessage: "The form is filled and ready for review in the open browser.",
            planner,
            currentUrl: activePage.url(),
            currentStageIndex: stageIndex,
            currentStageLabel: `Stage ${stageIndex + 1}`,
            workspacePath,
            lastStageSignature: await getStageSignature(activePage),
            browserStatus: "filled",
            filledCount: filledLabels.length,
            manualCount: skippedLabels.length,
            pendingHandoff: undefined
          });
          return {
            status: "filled",
            sourceUrl: input.job.sourceUrl,
            openedAt,
            completedAt: nowIso(),
            filledLabels,
            skippedLabels,
            screenshots,
            message: `The form is filled across ${stageCount} stage${stageCount === 1 ? "" : "s"} and is ready for review or direct submit.`,
            planner
          };
        }

        recordPlannerDecision({
          planner,
          page: activePage,
          stageIndex,
          kind: plannerActionFromBrowserAction("click_next"),
          source: "heuristic",
          reason: `Page classified as ${observation.pageState}; continuing to the next logical stage.`
        });
        await updateLiveBot(activePage, {
          step: `Stage ${stageIndex + 1}`,
          mood: "acting",
          message: "This stage looks complete. Moving to the next step."
        });
        if (await didUserRequestStop(activePage)) {
          return await handleGracefulStop({
            reason: "GradLaunch stopped because you clicked Quit in the live bot.",
            input,
            openedAt,
            screenshots,
            planner,
            workspacePath,
            executionSessions: this.executionSessions,
            executionSessionId,
            activePage,
            filledLabels,
            skippedLabels,
            stageIndex
          });
        }
        const navigation = await clickNextStageControl(context, activePage, { allowApplyStart: true });

        if (!navigation.clicked) {
          const manualAdvance = await waitForManualProgress({
            context,
            page: activePage,
            stageIndex,
            planner,
            workspacePath,
            baselineSignature: await getStageSignature(activePage),
            prompt: "I could not move this stage automatically. If you advance the portal manually, I will detect it and continue."
          });

          if (manualAdvance.resumed) {
            activePage = manualAdvance.activePage;
            continue;
          }

          await updateLiveBot(activePage, {
            step: `Stage ${stageIndex + 1}`,
            mood: "waiting",
            message: "I could not find a safe next action here, so I am pausing for review."
          });
          setPlannerStatus(planner, "needs_review", "GradLaunch could not find a confident next-step control on this page.");
          await updateExecutionSession(this.executionSessions, executionSessionId, {
            status: "resumable",
            latestMessage: "The agent could not confirm a safe next-step control on this page.",
            planner,
            currentUrl: activePage.url(),
            currentStageIndex: stageIndex,
            currentStageLabel: `Stage ${stageIndex + 1}`,
            workspacePath,
            lastStageSignature: await getStageSignature(activePage),
            filledCount: filledLabels.length,
            manualCount: skippedLabels.length
          });
          return {
            status: "needs_manual_review",
            sourceUrl: input.job.sourceUrl,
            openedAt,
            completedAt: nowIso(),
            filledLabels,
            skippedLabels,
            screenshots,
            message: "GradLaunch could not confidently find the next action on this page.",
            planner
          };
        }

        activePage = await getActivePage(context, navigation.page);
        completePlannerStage(planner, activePage, stageIndex);
      }

      setPlannerStatus(planner, "needs_review", "GradLaunch reached the maximum supported stage count and paused for review.");
      await updateLiveBot(activePage ?? page, {
        step: "Paused",
        mood: "waiting",
        message: "I reached the stage limit for this application and paused for review."
      });
      await updateExecutionSession(this.executionSessions, executionSessionId, {
        status: "resumable",
        latestMessage: "The agent reached the configured stage limit and paused for review.",
        planner,
        currentUrl: (activePage ?? page).url(),
        currentStageIndex: stageCount - 1,
        currentStageLabel: `Stage ${stageCount}`,
        workspacePath,
        lastStageSignature: await getStageSignature(activePage ?? page),
        filledCount: filledLabels.length,
        manualCount: skippedLabels.length
      });
      return {
        status: "needs_manual_review",
        sourceUrl: input.job.sourceUrl,
        openedAt,
        completedAt: nowIso(),
        filledLabels: [],
        skippedLabels: input.fields.map((field) => field.label),
        screenshots,
        message: "GradLaunch reached the stage limit for this application and paused for review.",
        planner
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Browser worker failed during the application flow.";
      if (context) {
        const fallbackPage = context.pages().find((candidate) => !candidate.isClosed());
        if (fallbackPage) {
          await updateLiveBot(fallbackPage, {
            step: "Blocked",
            mood: "waiting",
            message
          });
        }
      }
      markPlannerTask(planner, "finish_current_section", "blocked", message);
      setPlannerStatus(planner, "blocked", message);
      await updateExecutionSession(this.executionSessions, executionSessionId, {
        status: "blocked",
        latestMessage: message,
        planner,
        currentUrl: context?.pages().find((candidate) => !candidate.isClosed())?.url(),
        workspacePath,
        filledCount: 0,
        manualCount: input.fields.length
      });
      return blockedReceipt(input, openedAt, screenshots, planner, message);
    } finally {
      if (context && !keepContextOpen && !attachedToExistingBrowser) {
        await context.close().catch(() => undefined);
      }

      if (browser && !keepContextOpen && !attachedToExistingBrowser) {
        await browser.close().catch(() => undefined);
      }
    }
  }
}

async function openOrResumePage(context: BrowserContext, sourceUrl: string, resumeUrl: string | undefined) {
  const candidateUrls = [resumeUrl, sourceUrl].filter((value): value is string => Boolean(value));

  for (const candidate of context.pages().filter((page) => !page.isClosed()).reverse()) {
    if (candidateUrls.some((url) => candidate.url() === url || (url && candidate.url().startsWith(url)))) {
      return candidate;
    }
  }

  return context.newPage();
}

async function navigateToJobPage(page: Page, targetUrl: string, workspacePath: string) {
  let gotoError: string | undefined;

  await page.bringToFront().catch(() => undefined);
  await writeBrowserDebug(workspacePath, "job-navigation-start", {
    fromUrl: page.url(),
    targetUrl
  });

  try {
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: Number(process.env.BROWSER_NAVIGATION_TIMEOUT_MS ?? 45000)
    });
  } catch (error) {
    gotoError = error instanceof Error ? error.message : String(error);
    await writeBrowserDebug(workspacePath, "job-navigation-goto-failed", {
      currentUrl: page.url(),
      targetUrl,
      error: gotoError
    });
  }

  await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => undefined);

  if (!isBlankBrowserUrl(page.url())) {
    await writeBrowserDebug(workspacePath, "job-navigation-complete", {
      strategy: "goto",
      currentUrl: page.url(),
      targetUrl
    });
    return;
  }

  await writeBrowserDebug(workspacePath, "job-navigation-retry-location", {
    currentUrl: page.url(),
    targetUrl
  });
  await page.evaluate((url) => {
    window.location.assign(url);
  }, targetUrl).catch(() => undefined);
  await page.waitForLoadState("domcontentloaded", { timeout: Number(process.env.BROWSER_NAVIGATION_TIMEOUT_MS ?? 45000) }).catch(() => undefined);

  if (!isBlankBrowserUrl(page.url())) {
    await writeBrowserDebug(workspacePath, "job-navigation-complete", {
      strategy: "window-location",
      currentUrl: page.url(),
      targetUrl
    });
    return;
  }

  await writeBrowserDebug(workspacePath, "job-navigation-retry-address-bar", {
    currentUrl: page.url(),
    targetUrl
  });
  await page.bringToFront().catch(() => undefined);
  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+L`).catch(() => undefined);
  await page.keyboard.type(targetUrl).catch(() => undefined);
  await page.keyboard.press("Enter").catch(() => undefined);
  await page.waitForLoadState("domcontentloaded", { timeout: Number(process.env.BROWSER_NAVIGATION_TIMEOUT_MS ?? 45000) }).catch(() => undefined);

  if (!isBlankBrowserUrl(page.url())) {
    await writeBrowserDebug(workspacePath, "job-navigation-complete", {
      strategy: "address-bar",
      currentUrl: page.url(),
      targetUrl
    });
    return;
  }

  throw new Error(
    `Chrome opened a controlled tab, but the job URL did not load and the tab stayed on ${page.url()}. ${gotoError ? `Initial navigation failed: ${gotoError}` : "Initial navigation did not change the tab URL."}`
  );
}

function isBlankBrowserUrl(value: string) {
  return value === "about:blank" || value === "chrome://newtab/" || value.startsWith("chrome://new-tab-page");
}

function sanitizeBrowserResumeUrl(value: string | undefined) {
  if (!value || value === "about:blank" || value.startsWith("chrome://newtab")) {
    return undefined;
  }

  if (looksLikeLoginUrl(value)) {
    return undefined;
  }

  return value;
}

async function tryResolveLoginWithExistingProfile(input: {
  context: BrowserContext;
  page: Page;
  sourceUrl: string;
  studentEmail?: string;
  workspacePath: string;
  stageIndex: number;
  reason?: string;
}) {
  if (process.env.BROWSER_LOGIN_PROFILE_RECOVERY === "false") {
    return {
      resolved: false,
      activePage: input.page
    };
  }

  let activePage = input.page;
  await writeBrowserDebug(input.workspacePath, "login-profile-recovery-start", {
    stageIndex: input.stageIndex,
    url: activePage.url(),
    sourceUrl: input.sourceUrl,
    reason: input.reason,
    hasStudentEmail: Boolean(input.studentEmail)
  });

  await updateLiveBot(activePage, {
    step: `Stage ${input.stageIndex + 1}`,
    mood: "acting",
    message: "Trying the existing logged-in browser profile before asking you to sign in manually."
  });

  activePage = await tryLoginButtonsInCurrentProfile({
    context: input.context,
    page: activePage,
    studentEmail: input.studentEmail,
    workspacePath: input.workspacePath,
    stageIndex: input.stageIndex
  });

  if (await loginGateCleared(activePage)) {
    await writeBrowserDebug(input.workspacePath, "login-profile-recovery-resolved", {
      stageIndex: input.stageIndex,
      strategy: "current-tab-login-button",
      url: activePage.url()
    });
    return {
      resolved: true,
      activePage
    };
  }

  const freshPage = await input.context.newPage();
  activePage = freshPage;
  await activePage.bringToFront().catch(() => undefined);
  await writeBrowserDebug(input.workspacePath, "login-profile-recovery-fresh-tab", {
    stageIndex: input.stageIndex,
    sourceUrl: input.sourceUrl
  });
  await updateLiveBot(activePage, {
    step: `Stage ${input.stageIndex + 1}`,
    mood: "acting",
    message: "Opening the original job in a fresh tab inside the logged browser profile."
  });
  await activePage.goto(input.sourceUrl, {
    waitUntil: "domcontentloaded",
    timeout: Number(process.env.BROWSER_NAVIGATION_TIMEOUT_MS ?? 45000)
  }).catch(() => undefined);
  await activePage.waitForTimeout(1000).catch(() => undefined);
  await clickSoftGate(activePage);

  if (await loginGateCleared(activePage)) {
    await writeBrowserDebug(input.workspacePath, "login-profile-recovery-resolved", {
      stageIndex: input.stageIndex,
      strategy: "fresh-job-tab",
      url: activePage.url()
    });
    return {
      resolved: true,
      activePage
    };
  }

  activePage = await tryLoginButtonsInCurrentProfile({
    context: input.context,
    page: activePage,
    studentEmail: input.studentEmail,
    workspacePath: input.workspacePath,
    stageIndex: input.stageIndex
  });

  const resolved = await loginGateCleared(activePage);
  await writeBrowserDebug(input.workspacePath, resolved ? "login-profile-recovery-resolved" : "login-profile-recovery-unresolved", {
    stageIndex: input.stageIndex,
    strategy: "fresh-tab-login-button",
    url: activePage.url()
  });

  return {
    resolved,
    activePage
  };
}

async function tryLoginButtonsInCurrentProfile(input: {
  context: BrowserContext;
  page: Page;
  studentEmail?: string;
  workspacePath: string;
  stageIndex: number;
}) {
  let activePage = input.page;

  activePage = await clickLoginEntryPoint({
    context: input.context,
    page: activePage,
    mode: "google",
    workspacePath: input.workspacePath,
    stageIndex: input.stageIndex
  });
  activePage = await maybeClickGoogleAccount(activePage, input.studentEmail);
  await maybeContinueGoogleOAuthConsent(activePage);

  if (await loginGateCleared(activePage)) {
    return activePage;
  }

  if (input.studentEmail) {
    activePage = await clickLoginEntryPoint({
      context: input.context,
      page: activePage,
      mode: "email",
      workspacePath: input.workspacePath,
      stageIndex: input.stageIndex
    });
    await fillLoginEmailOnly(activePage, input.studentEmail);
  }

  return await getActivePage(input.context, activePage);
}

async function clickLoginEntryPoint(input: {
  context: BrowserContext;
  page: Page;
  mode: "google" | "email";
  workspacePath: string;
  stageIndex: number;
}) {
  if (input.mode === "google" && isGoogleAuthUrl(input.page.url())) {
    return input.page;
  }

  const popupPromise = input.context.waitForEvent("page", { timeout: 2500 }).catch(() => undefined);
  const clicked = await clickLoginControl(input.page, input.mode);
  const popup = clicked ? await popupPromise : undefined;

  await writeBrowserDebug(input.workspacePath, clicked ? "login-entry-clicked" : "login-entry-not-found", {
    stageIndex: input.stageIndex,
    mode: input.mode,
    url: input.page.url(),
    popupOpened: Boolean(popup)
  });

  const activePage = popup ?? await getActivePage(input.context, input.page);
  await activePage.bringToFront().catch(() => undefined);
  await activePage.waitForLoadState("domcontentloaded", { timeout: 6000 }).catch(() => undefined);
  await activePage.waitForTimeout(1200).catch(() => undefined);
  return activePage;
}

async function clickLoginControl(page: Page, mode: "google" | "email") {
  for (const frame of page.frames()) {
    const marker = `gl-login-${mode}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const found = await frame.evaluate(({ marker, mode }) => {
      const candidates = Array.from(document.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit'], div, span")) as HTMLElement[];
      let best: HTMLElement | undefined;
      let bestScore = 0;

      for (const candidate of candidates) {
        if (!isVisible(candidate)) {
          continue;
        }

        const text = normalize([
          candidate.innerText,
          candidate.textContent,
          candidate.getAttribute("aria-label"),
          candidate.getAttribute("title"),
          candidate instanceof HTMLInputElement ? candidate.value : ""
        ].filter(Boolean).join(" "));

        if (!text || text.length > 120) {
          continue;
        }

        const score = scoreCandidate(text, candidate, mode);

        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }

      if (!best || bestScore < 70) {
        return false;
      }

      best.setAttribute("data-gradlaunch-login-target", marker);
      return true;

      function scoreCandidate(text: string, element: HTMLElement, targetMode: "google" | "email") {
        let score = 0;

        if (targetMode === "google") {
          if (/\b(google|gmail)\b/.test(text)) {
            score += 80;
          }

          if (/\b(sign in|signin|log in|login|continue|use|connect)\b/.test(text)) {
            score += 25;
          }
        } else {
          if (/\b(email|e mail|mail)\b/.test(text)) {
            score += 80;
          }

          if (/\b(sign in|signin|log in|login|continue|use|magic link|one time)\b/.test(text)) {
            score += 25;
          }
        }

        if (element.matches("button, a, [role='button'], input[type='button'], input[type='submit']")) {
          score += 20;
        }

        if (/\b(password|forgot|create account|register|sign up)\b/.test(text)) {
          score -= 30;
        }

        return score;
      }

      function isVisible(element: HTMLElement) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0 && rect.width > 0 && rect.height > 0;
      }

      function normalize(value: string) {
        return value.toLowerCase().replace(/[^a-z0-9@._+-]+/g, " ").trim();
      }
    }, { marker, mode }).catch(() => false);

    if (!found) {
      continue;
    }

    const target = frame.locator(`[data-gradlaunch-login-target="${marker}"]`).first();

    try {
      await target.click({ force: true, timeout: 1200 });
      return true;
    } catch (_error) {
      const box = await target.boundingBox().catch(() => undefined);

      if (!box) {
        return false;
      }

      await frame.page().mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => undefined);
      return true;
    } finally {
      await target.evaluate((element) => {
        if (element instanceof HTMLElement) {
          element.removeAttribute("data-gradlaunch-login-target");
        }
      }).catch(() => undefined);
    }
  }

  return false;
}

async function maybeClickGoogleAccount(page: Page, studentEmail: string | undefined) {
  if (!studentEmail || !isGoogleAuthUrl(page.url())) {
    return page;
  }

  for (const frame of page.frames()) {
    const account = frame.locator(`text=${studentEmail}`).first();

    if (await account.isVisible({ timeout: 600 }).catch(() => false)) {
      await account.click({ force: true, timeout: 1200 }).catch(() => undefined);
      await page.waitForLoadState("domcontentloaded", { timeout: 6000 }).catch(() => undefined);
      await page.waitForTimeout(1200).catch(() => undefined);
      return page;
    }

    const clicked = await frame.evaluate((emailSource) => {
      const pattern = new RegExp(emailSource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const candidates = Array.from(document.querySelectorAll("button, a, [role='button'], div")) as HTMLElement[];

      for (const candidate of candidates) {
        const text = candidate.innerText || candidate.textContent || "";

        if (pattern.test(text) && isVisible(candidate)) {
          candidate.click();
          return true;
        }
      }

      return false;

      function isVisible(element: HTMLElement) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      }
    }, studentEmail).catch(() => false);

    if (clicked) {
      await page.waitForLoadState("domcontentloaded", { timeout: 6000 }).catch(() => undefined);
      await page.waitForTimeout(1200).catch(() => undefined);
      return page;
    }
  }

  await fillLoginEmailOnly(page, studentEmail);
  return page;
}

async function maybeContinueGoogleOAuthConsent(page: Page) {
  if (!isGoogleAuthUrl(page.url())) {
    return false;
  }

  for (const frame of page.frames()) {
    const clicked = await frame.evaluate(() => {
      const hasVisiblePassword = Array.from(document.querySelectorAll("input[type='password']")).some((control) => isVisible(control));
      const hasVisibleIdentifier = Array.from(document.querySelectorAll("input")).some((control) => {
        if (!(control instanceof HTMLInputElement) || !isVisible(control)) {
          return false;
        }

        const descriptor = normalize([
          control.type,
          control.autocomplete,
          control.name,
          control.id,
          control.placeholder,
          control.getAttribute("aria-label")
        ].filter(Boolean).join(" "));
        return /\b(email|phone|identifier|username)\b/.test(descriptor);
      });

      if (hasVisiblePassword || hasVisibleIdentifier) {
        return false;
      }

      const candidates = Array.from(document.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit']")) as HTMLElement[];

      for (const candidate of candidates) {
        if (!isVisible(candidate)) {
          continue;
        }

        const text = normalize([
          candidate.innerText,
          candidate.textContent,
          candidate.getAttribute("aria-label"),
          candidate.getAttribute("title"),
          candidate instanceof HTMLInputElement ? candidate.value : ""
        ].filter(Boolean).join(" "));

        if (/\b(continue|allow|next)\b/.test(text) && !/\b(create|forgot|cancel|back|privacy|terms)\b/.test(text)) {
          candidate.click();
          return true;
        }
      }

      return false;

      function isVisible(element: Element | null) {
        if (!(element instanceof HTMLElement)) {
          return false;
        }

        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0 && rect.width > 0 && rect.height > 0;
      }

      function normalize(value: string) {
        return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      }
    }).catch(() => false);

    if (!clicked) {
      continue;
    }

    await page.waitForLoadState("domcontentloaded", { timeout: 6000 }).catch(() => undefined);
    await page.waitForTimeout(1200).catch(() => undefined);
    return true;
  }

  return false;
}

async function fillLoginEmailOnly(page: Page, email: string) {
  for (const frame of page.frames()) {
    const filled = await frame.evaluate((emailValue) => {
      const controls = Array.from(document.querySelectorAll("input")) as HTMLInputElement[];
      const target = controls.find((control) => {
        if (control.disabled || !isVisible(control)) {
          return false;
        }

        const descriptor = normalize([
          control.type,
          control.autocomplete,
          control.name,
          control.id,
          control.placeholder,
          control.getAttribute("aria-label")
        ].filter(Boolean).join(" "));

        return /\b(email|username|user name|login)\b/.test(descriptor) && !/\b(password|otp|code)\b/.test(descriptor);
      });

      if (!target) {
        return false;
      }

      target.focus();
      setNativeValue(target, emailValue);
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return true;

      function setNativeValue(control: HTMLInputElement, value: string) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");

        if (descriptor?.set) {
          descriptor.set.call(control, value);
        } else {
          control.value = value;
        }
      }

      function isVisible(element: HTMLElement) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      }

      function normalize(value: string) {
        return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      }
    }, email).catch(() => false);

    if (!filled) {
      continue;
    }

    const nextClicked = await clickLoginContinue(frame);

    if (!nextClicked) {
      await frame.page().keyboard.press("Enter").catch(() => undefined);
    }

    await page.waitForLoadState("domcontentloaded", { timeout: 6000 }).catch(() => undefined);
    await page.waitForTimeout(1200).catch(() => undefined);
    return true;
  }

  return false;
}

async function clickLoginContinue(frame: Frame) {
  const marker = `gl-login-continue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const found = await frame.evaluate((targetMarker) => {
    const candidates = Array.from(document.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']")) as HTMLElement[];
    let best: HTMLElement | undefined;
    let bestScore = 0;

    for (const candidate of candidates) {
      if (!isVisible(candidate)) {
        continue;
      }

      const text = normalize([
        candidate.innerText,
        candidate.textContent,
        candidate.getAttribute("aria-label"),
        candidate instanceof HTMLInputElement ? candidate.value : ""
      ].filter(Boolean).join(" "));
      let score = 0;

      if (/\b(continue|next|sign in|log in|submit)\b/.test(text)) {
        score += 100;
      }

      if (/\b(google|facebook|github|sso|forgot|create account|sign up)\b/.test(text)) {
        score -= 70;
      }

      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    if (!best || bestScore < 70) {
      return false;
    }

    best.setAttribute("data-gradlaunch-login-continue-target", targetMarker);
    return true;

    function isVisible(element: HTMLElement) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    }

    function normalize(value: string) {
      return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    }
  }, marker).catch(() => false);

  if (!found) {
    return false;
  }

  const target = frame.locator(`[data-gradlaunch-login-continue-target="${marker}"]`).first();
  await target.click({ force: true, timeout: 1200 }).catch(() => undefined);
  await target.evaluate((element) => {
    if (element instanceof HTMLElement) {
      element.removeAttribute("data-gradlaunch-login-continue-target");
    }
  }).catch(() => undefined);
  return true;
}

async function loginGateCleared(page: Page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 4000 }).catch(() => undefined);
  await page.waitForTimeout(600).catch(() => undefined);

  if (isBlankBrowserUrl(page.url()) || isGoogleAuthUrl(page.url())) {
    return false;
  }

  const checkpoint = await detectProtectedCheckpoint(page);

  if (checkpoint.blocked) {
    return false;
  }

  const visibleFields = await discoverVisibleFields(page).catch(() => []);
  const observation = await observeBrowserPage(page, visibleFields).catch(() => undefined);

  return Boolean(observation && observation.pageState !== "login" && observation.pageState !== "account_gate");
}

function resolveApplicantEmail(input: BrowserApplyInput) {
  return [input.student?.email, ...input.fields.filter((field) => /email/i.test(field.label)).map((field) => field.value)]
    .find((value): value is string => typeof value === "string" && isLikelyEmail(value));
}

function looksLikeLoginUrl(value: string) {
  try {
    const parsed = new URL(value);
    const haystack = `${parsed.hostname} ${parsed.pathname} ${parsed.search}`.toLowerCase();
    return /\b(login|signin|sign-in|sign_in|auth|oauth|sso|account)\b/.test(haystack);
  } catch (_error) {
    return false;
  }
}

function isGoogleAuthUrl(value: string) {
  try {
    const parsed = new URL(value);
    return /(^|\.)accounts\.google\.com$/i.test(parsed.hostname);
  } catch (_error) {
    return false;
  }
}

function isLikelyEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

async function updateExecutionSession(
  sessions: BrowserExecutionSessionService,
  sessionId: string | undefined,
  input: Parameters<BrowserExecutionSessionService["update"]>[0]
) {
  if (!sessionId) {
    return;
  }

  await sessions.update({
    ...input,
    sessionId
  }).catch(() => undefined);
}

function hasOpenPage(context: BrowserContext) {
  return context.pages().some((page) => !page.isClosed());
}

async function handleGracefulStop(input: {
  reason: string;
  input: BrowserApplyInput;
  openedAt: string;
  screenshots: string[];
  planner: ReturnType<typeof createPlannerCheckpoint>;
  workspacePath: string;
  executionSessions: BrowserExecutionSessionService;
  executionSessionId?: string;
  activePage?: Page;
  filledLabels: string[];
  skippedLabels: string[];
  stageIndex: number;
}): Promise<BrowserApplyReceipt> {
  const page = input.activePage && !input.activePage.isClosed() ? input.activePage : undefined;

  if (page) {
    await updateLiveBot(page, {
      step: "Paused",
      mood: "waiting",
      message: input.reason
    });
    await saveScreenshot(page, input.workspacePath, input.screenshots, "browser-paused.png");
    recordPlannerDecision({
      planner: input.planner,
      page,
      stageIndex: input.stageIndex,
      kind: "stop",
      source: "system",
      reason: input.reason
    });
  }

  markPlannerTask(input.planner, "save_checkpoint", "completed", "Saved the latest resumable checkpoint before pausing the browser run.");
  setPlannerStatus(input.planner, "needs_review", input.reason);

  await updateExecutionSession(input.executionSessions, input.executionSessionId, {
    status: "resumable",
    latestMessage: input.reason,
    planner: input.planner,
    currentUrl: page?.url() ?? input.planner.currentUrl ?? input.input.job.sourceUrl,
    currentStageIndex: input.stageIndex,
    currentStageLabel: input.planner.currentStageLabel ?? `Stage ${input.stageIndex + 1}`,
    workspacePath: input.workspacePath,
    lastStageSignature: page ? await getStageSignature(page).catch(() => undefined) : undefined,
    filledCount: input.filledLabels.length,
    manualCount: input.skippedLabels.length
  });

  return {
    status: "needs_manual_review",
    sourceUrl: input.input.job.sourceUrl,
    openedAt: input.openedAt,
    completedAt: nowIso(),
    filledLabels: input.filledLabels,
    skippedLabels: input.skippedLabels,
    screenshots: input.screenshots,
    message: input.reason,
    planner: input.planner
  };
}

async function waitForManualProgress(input: {
  context: BrowserContext;
  page: Page;
  stageIndex: number;
  planner: ReturnType<typeof createPlannerCheckpoint>;
  workspacePath: string;
  baselineSignature: Awaited<ReturnType<typeof getStageSignature>>;
  prompt: string;
}) {
  const timeoutMs = Number(process.env.BROWSER_MANUAL_RESUME_TIMEOUT_MS ?? 45000);
  const pollMs = Number(process.env.BROWSER_MANUAL_RESUME_POLL_MS ?? 900);
  const startedAt = Date.now();
  let activePage = input.page;

  await updateLiveBot(activePage, {
    step: `Stage ${input.stageIndex + 1}`,
    mood: "waiting",
    message: input.prompt
  });
  markPlannerTask(input.planner, "save_checkpoint", "completed", "Saved checkpoint while waiting for manual stage progress.");

  while (Date.now() - startedAt < timeoutMs) {
    if (!hasOpenPage(input.context)) {
      return {
        resumed: false,
        activePage
      };
    }

    await activePage.waitForTimeout(pollMs).catch(() => undefined);
    activePage = await getActivePage(input.context, activePage);
    if (await didUserRequestStop(activePage)) {
      return {
        resumed: false,
        activePage
      };
    }

    const stillSameStage = await matchesSavedStageSignature(activePage, input.baselineSignature).catch(() => true);

    if (stillSameStage) {
      continue;
    }

    const protectedCheckpoint = await detectProtectedCheckpoint(activePage);

    if (protectedCheckpoint.blocked) {
      continue;
    }

    const nextSignature = await getStageSignature(activePage);
    recordPlannerStageOutcome({
      planner: input.planner,
      page: activePage,
      stageIndex: input.stageIndex,
      outcome: "advanced",
      filledFieldLabels: []
    });
    await writeBrowserDebug(input.workspacePath, "manual-stage-progress-detected", {
      stageIndex: input.stageIndex,
      from: input.baselineSignature,
      to: nextSignature,
      url: activePage.url()
    });
    await updateLiveBot(activePage, {
      step: `Stage ${input.stageIndex + 1}`,
      mood: "thinking",
      message: "I detected manual progress. Re-scanning this new stage now."
    });

    return {
      resumed: true,
      activePage
    };
  }

  return {
    resumed: false,
    activePage
  };
}

async function launchContext(chromePath: string | undefined): Promise<BrowserLaunchResult> {
  const launchOptions = {
    executablePath: chromePath,
    headless: process.env.BROWSER_HEADLESS === "true",
    args: ["--disable-blink-features=AutomationControlled"]
  };
  const loggedCdpUrl = shouldPreferLoggedBrowser() ? await resolveLoggedChromeCdpUrl() : undefined;

  if (loggedCdpUrl) {
    return connectToChromeCdp(loggedCdpUrl, "logged_cdp");
  }

  if (shouldPreferLoggedBrowser() && process.env.BROWSER_USE_PERSISTENT_PROFILE !== "false") {
    const loggedProfileDir = getLoggedBrowserProfileDir();

    if (loggedProfileDir && await pathExists(loggedProfileDir)) {
      if (await isBrowserProfileLocked(loggedProfileDir, { clearStaleGradLaunchLock: true })) {
        const message = buildLockedLoggedProfileMessage(loggedProfileDir);

        if (shouldRequireLoggedBrowser()) {
          throw new Error(message);
        }

        console.warn(`[GradLaunch][Browser] ${message} Falling back to managed profile.`);
      } else {
        try {
          const loggedProfileName = await resolveLoggedChromeProfileName(loggedProfileDir);
          const context = await chromium.launchPersistentContext(loggedProfileDir, {
            ...launchOptions,
            args: [
              ...launchOptions.args,
              `--profile-directory=${loggedProfileName}`,
              `--remote-debugging-port=${resolveLoggedChromeDebugPort()}`
            ],
            viewport: { width: 1280, height: 900 }
          });

          return {
            browser: undefined,
            context,
            keepContextOpen: false,
            attachedToExistingBrowser: false,
            launchMode: "logged_profile" satisfies BrowserLaunchMode
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);

          if (shouldRequireLoggedBrowser()) {
            throw new Error(
              `GradLaunch could not use the logged Chrome profile at ${loggedProfileDir}. ${message}. Start your normal Chrome with remote debugging on port ${resolveLoggedChromeDebugPort()}, or close Chrome so GradLaunch can launch that logged profile.`
            );
          }

          console.warn(
            `[GradLaunch][Browser] Could not use logged Chrome profile at ${loggedProfileDir}; falling back to managed profile. ${message}`
          );
        }
      }
    }
  }

  const cdpUrl = await resolveManagedChromeCdpUrl();

  if (cdpUrl) {
    return connectToChromeCdp(cdpUrl, "managed_cdp");
  }

  if (process.env.BROWSER_USE_PERSISTENT_PROFILE !== "false") {
    try {
      const context = await chromium.launchPersistentContext(getManagedBrowserProfileDir(), {
        ...launchOptions,
        args: [
          ...launchOptions.args,
          `--remote-debugging-port=${resolveManagedChromeDebugPort()}`
        ],
        viewport: { width: 1280, height: 900 }
      });

      return {
        browser: undefined,
        context,
        keepContextOpen: true,
        attachedToExistingBrowser: false,
        launchMode: "managed_profile" satisfies BrowserLaunchMode
      };
    } catch (error) {
      if (shouldFallbackFromLockedProfile(error)) {
        throw new Error(
          "GradLaunch could not reopen the managed browser profile because another GradLaunch browser session is already using it. Keep that window open and try again."
        );
      }

      throw error;
    }
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  return {
    browser,
    context,
    keepContextOpen: false,
    attachedToExistingBrowser: false,
    launchMode: "ephemeral" satisfies BrowserLaunchMode
  };
}

async function connectToChromeCdp(cdpUrl: string, launchMode: Extract<BrowserLaunchMode, "logged_cdp" | "managed_cdp">): Promise<BrowserLaunchResult> {
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];

  if (!context) {
    throw new Error("GradLaunch attached to Chrome, but no browser context was available.");
  }

  return {
    browser,
    context,
    keepContextOpen: true,
    attachedToExistingBrowser: true,
    launchMode
  };
}

function installContextSafety(context: BrowserContext, workspacePath: string) {
  for (const page of context.pages()) {
    installPageSafety(page, workspacePath);
  }

  context.on("page", (page) => {
    installPageSafety(page, workspacePath);
  });
}

function installPageSafety(page: Page, workspacePath: string) {
  page.on("dialog", (dialog) => {
    void handleDialogSafely(dialog, page, workspacePath);
  });

  page.on("pageerror", (error) => {
    void writeBrowserDebug(workspacePath, "page-error", {
      url: page.url(),
      message: error.message,
      stack: error.stack
    });
  });

  page.on("crash", () => {
    void writeBrowserDebug(workspacePath, "page-crash", {
      url: page.url()
    });
  });
}

async function handleDialogSafely(dialog: Dialog, page: Page, workspacePath: string) {
  const payload = {
    url: page.url(),
    type: dialog.type(),
    message: dialog.message(),
    defaultValue: dialog.defaultValue()
  };

  await writeBrowserDebug(workspacePath, "dialog-opened", payload);

  try {
    if (dialog.type() === "beforeunload") {
      // Let the browser/tab close proceed when a site asks for beforeunload confirmation.
      await dialog.accept();
    } else {
      await dialog.accept();
    }
    await writeBrowserDebug(workspacePath, "dialog-handled", payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeBrowserDebug(workspacePath, "dialog-handle-failed", {
      ...payload,
      error: message
    });
  }
}

async function waitForHumanIntervention(input: HandoffRequest) {
  const timeoutMs = Number(process.env.BROWSER_HANDOFF_TIMEOUT_MS ?? 180000);
  const pollMs = Number(process.env.BROWSER_HANDOFF_POLL_MS ?? 1200);
  const startedAt = Date.now();
  let activePage = input.page;

  await maybeKeepBrowserOpen(input.context);
  await updateLiveBot(activePage, {
    step: `Stage ${input.stageIndex + 1}`,
    mood: "waiting",
    message: input.reason
  });
  await saveScreenshot(activePage, input.workspacePath, input.screenshots, "browser-handoff-needed.png");
  notePlannerHandoff(input.planner, input.reason, activePage, input.stageIndex, input.handoffKind ?? "review");

  while (Date.now() - startedAt < timeoutMs) {
    if (!hasOpenPage(input.context)) {
      return {
        resolved: false,
        activePage
      };
    }

    await activePage.waitForTimeout(pollMs).catch(() => undefined);
    activePage = await getActivePage(input.context, activePage);
    if (await didUserRequestStop(activePage)) {
      return {
        resolved: false,
        activePage
      };
    }
    const protectedCheckpoint = await detectProtectedCheckpoint(activePage);

    if (protectedCheckpoint.blocked) {
      continue;
    }

    if (input.watchFields?.length) {
      const outstanding = await getVisibleRequiredEmptyLabels(activePage);
      const watchSet = new Set(input.watchFields.map((label) => label.toLowerCase().trim()));

      if (outstanding.some((label) => watchSet.has(label.toLowerCase().trim()))) {
        continue;
      }
    }

    markPlannerTask(input.planner, "authenticate_if_needed", "running", "Protected checkpoint cleared. Resuming autonomous execution.");
    setPlannerStatus(input.planner, "running", "Manual checkpoint cleared and the planner resumed.");
    await updateLiveBot(activePage, {
      step: `Stage ${input.stageIndex + 1}`,
      mood: "thinking",
      message: "Manual step complete. Re-planning the next move now."
    });
    return {
      resolved: true,
      activePage
    };
  }

  setPlannerStatus(input.planner, "handoff_required", "Planner paused because the protected checkpoint still needs the student.");
  return {
    resolved: false,
    activePage
  };
}

async function saveScreenshot(page: Page, workspacePath: string, screenshots: string[], filename: string) {
  const path = join(workspacePath, filename);

  try {
    await page.screenshot({
      path,
      fullPage: false,
      animations: "disabled",
      timeout: Number(process.env.BROWSER_SCREENSHOT_TIMEOUT_MS ?? 1500)
    });
    screenshots.push(filename);
  } catch (_error) {
    // Ignore screenshot failures.
  }
}

function blockedReceipt(input: BrowserApplyInput, openedAt: string, screenshots: string[], planner: ReturnType<typeof createPlannerCheckpoint>, message: string): BrowserApplyReceipt {
  return {
    status: "blocked",
    sourceUrl: input.job.sourceUrl,
    openedAt,
    completedAt: nowIso(),
    filledLabels: [],
    skippedLabels: input.fields.map((field) => field.label),
    screenshots,
    message,
    planner
  };
}

async function maybeKeepBrowserOpen(context: BrowserContext) {
  if (shouldKeepBrowserOpenForReview()) {
    const pages = context.pages().filter((page) => !page.isClosed());
    const activePage = pages.at(-1) ?? pages[0];
    await activePage?.bringToFront().catch(() => undefined);
  }
}

function shouldKeepBrowserOpenForReview() {
  return process.env.BROWSER_KEEP_OPEN_ON_REVIEW !== "false" && process.env.BROWSER_HEADLESS !== "true";
}

function shouldFallbackFromLockedProfile(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /Opening in existing browser session|profile is already in use|user data directory is already in use/i.test(message);
}

function resolveChromePath() {
  return process.env.CHROME_EXECUTABLE_PATH ?? defaultChromePath;
}

function shouldPreferLoggedBrowser() {
  return process.env.BROWSER_PREFER_LOGGED_PROFILE !== "false";
}

function shouldRequireLoggedBrowser() {
  return process.env.BROWSER_REQUIRE_LOGGED_PROFILE === "true";
}

async function isBrowserProfileLocked(profileDir: string, options: { clearStaleGradLaunchLock?: boolean } = {}) {
  const state = await getBrowserProfileLockState(profileDir);

  if (!state.locked) {
    return false;
  }

  if (state.stale && options.clearStaleGradLaunchLock && await canClearStaleGradLaunchProfileLock(profileDir)) {
    await clearBrowserProfileSingletonFiles(profileDir);
    return false;
  }

  return true;
}

async function getBrowserProfileLockState(profileDir: string) {
  const singletonFiles = ["SingletonLock", "SingletonSocket", "SingletonCookie"];
  let locked = false;
  let lockPid: number | undefined;

  for (const filename of singletonFiles) {
    try {
      await lstat(join(profileDir, filename));
      locked = true;

      if (filename === "SingletonLock") {
        lockPid = await readBrowserProfileLockPid(profileDir);
      }
    } catch (_error) {
      // Missing singleton files mean Chrome is not currently holding this profile.
    }
  }

  if (!locked) {
    return {
      locked: false,
      stale: false,
      lockPid
    };
  }

  return {
    locked: true,
    stale: lockPid ? !isProcessRunning(lockPid) : true,
    lockPid
  };
}

async function readBrowserProfileLockPid(profileDir: string) {
  try {
    const target = await readlink(join(profileDir, "SingletonLock"));
    const match = target.match(/-(\d+)$/);
    return match ? Number(match[1]) : undefined;
  } catch (_error) {
    return undefined;
  }
}

function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

async function canClearStaleGradLaunchProfileLock(profileDir: string) {
  return process.env.BROWSER_CLEAR_STALE_LOGGED_PROFILE_LOCKS !== "false"
    && await pathExists(join(profileDir, ".gradlaunch-profile-source.json"));
}

async function clearBrowserProfileSingletonFiles(profileDir: string) {
  for (const filename of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    await rm(join(profileDir, filename), { force: true }).catch(() => undefined);
  }
}

function buildLockedLoggedProfileMessage(profileDir: string) {
  return `The logged Chrome profile at ${profileDir} is already open, but GradLaunch cannot attach because remote debugging is not available on ${resolveLoggedChromeCdpHint()}. Close the old GradLaunch Chrome window, or quit Chrome and retry. Stale copied-profile locks are cleared automatically.`;
}

function resolveLoggedChromeCdpHint() {
  return process.env.BROWSER_LOGGED_CDP_URL?.trim() || `http://127.0.0.1:${resolveLoggedChromeDebugPort()}`;
}

async function resolveLoggedChromeCdpUrl() {
  const configuredValue = process.env.BROWSER_LOGGED_CDP_URL?.trim();
  const candidates = configuredValue
    ? [normalizeChromeCdpUrl(configuredValue)]
    : process.env.BROWSER_PROBE_LOGGED_CDP === "false"
      ? []
      : [`http://127.0.0.1:${resolveLoggedChromeDebugPort()}`];

  for (const candidate of candidates) {
    if (candidate && await canConnectToChromeCdp(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function resolveManagedChromeCdpUrl() {
  const configuredValue = process.env.BROWSER_CDP_URL?.trim();

  if (configuredValue) {
    return normalizeChromeCdpUrl(configuredValue);
  }

  const autoDetectUrl = `http://127.0.0.1:${resolveManagedChromeDebugPort()}`;
  return await canConnectToChromeCdp(autoDetectUrl) ? autoDetectUrl : undefined;
}

async function canConnectToChromeCdp(baseUrl: string) {
  try {
    const versionUrl = new URL("/json/version", baseUrl);
    const response = await requestJson(versionUrl);
    return typeof response.Browser === "string" && response.Browser.length > 0;
  } catch (_error) {
    return false;
  }
}

function requestJson(url: URL): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest(
      url,
      {
        method: "GET",
        timeout: 500
      },
      (response) => {
        const chunks: Buffer[] = [];

        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            resolvePromise(JSON.parse(text) as Record<string, unknown>);
          } catch (error) {
            rejectPromise(error);
          }
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("Timed out probing Chrome CDP."));
    });
    request.on("error", rejectPromise);
    request.end();
  });
}

function resolveManagedChromeDebugPort() {
  return Number(process.env.BROWSER_MANAGED_DEBUG_PORT ?? 9333);
}

function resolveLoggedChromeDebugPort() {
  return Number(process.env.BROWSER_LOGGED_DEBUG_PORT ?? 9222);
}

function normalizeChromeCdpUrl(value: string) {
  const trimmed = value.trim();

  if (/^\d+$/.test(trimmed)) {
    return `http://127.0.0.1:${trimmed}`;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `http://${trimmed}`;
}

async function resolveLoggedChromeProfileName(profileDir: string) {
  const configuredProfileName = process.env.BROWSER_LOGGED_PROFILE_NAME?.trim();

  if (configuredProfileName) {
    return configuredProfileName;
  }

  try {
    const text = await readFile(join(profileDir, "Local State"), "utf8");
    const localState = JSON.parse(text) as {
      profile?: {
        last_used?: unknown;
        last_active_profiles?: unknown;
      };
    };
    const lastUsed = localState.profile?.last_used;

    if (typeof lastUsed === "string" && lastUsed.trim()) {
      return lastUsed.trim();
    }

    const lastActiveProfiles = localState.profile?.last_active_profiles;

    if (Array.isArray(lastActiveProfiles)) {
      const firstProfile = lastActiveProfiles.find((profile): profile is string => typeof profile === "string" && profile.trim().length > 0);

      if (firstProfile) {
        return firstProfile.trim();
      }
    }
  } catch (_error) {
    // Chrome can still start its default profile if Local State cannot be read.
  }

  return "Default";
}

function validateSourceUrl(value: string) {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch (_error) {
    return {
      valid: false,
      message: "This job does not have a valid application URL. Import a real job page URL or run a fresh live search."
    };
  }

  if (parsed.hostname === "search.gradlaunch.local") {
    return {
      valid: false,
      message: "This is an old generated demo job URL, not a real job opening. Run a fresh live search or paste the real company job URL before auto-submit."
    };
  }

  if (!["http:", "https:", "data:"].includes(parsed.protocol)) {
    return {
      valid: false,
      message: "GradLaunch can only auto-submit web job pages with http or https URLs."
    };
  }

  return {
    valid: true,
    message: "Source URL is valid."
  };
}

function mapCheckpointToHandoff(kind: "captcha" | "login" | "otp" | "verification" | undefined): AgentHandoffKind | undefined {
  switch (kind) {
    case "captcha":
      return "captcha";
    case "login":
      return "login";
    case "otp":
      return "otp";
    case "verification":
      return "verification";
    default:
      return undefined;
  }
}
