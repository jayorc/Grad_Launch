import { request as httpRequest } from "node:http";
import { cp, lstat, mkdir, readFile, readlink, rm } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import type { AgentHandoffKind, BrowserApplyReceipt } from "@gradlaunch/shared";
import { getBrowserWorkspaceStorageDir, getLoggedBrowserProfileDir, getManagedBrowserProfileDir } from "../../config/storage";
import { nowIso } from "../../lib/time";
import { runFillEngine } from "./fill-engine";
import { reflectOnStageAnswers } from "./answer";
import { attachResume, collectLegacyFillFieldDebug, continueAfterResumeUploadIfReady, resolveKnownRequiredChoice } from "./fill";
import { fillRepairFieldV2 } from "./fill-field-drivers";
import { buildStageExecutionPlan, evaluateStageReadiness } from "./plan";
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
import { classifyRecovery, probeAndReobservePage } from "./strategy";
import {
  autoResolveConsentControls,
  clickFinalSubmit,
  clickNextStageControl,
  clickSoftGate,
  collectStageSnapshot,
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
import { chromium, type Browser, type BrowserContext, type Dialog, type Page } from "./browser-driver";
import type { BrowserAgentObservation, BrowserApplyInput, BrowserAvailability, BrowserFillField, HandoffRequest, StageAnswerPlan } from "./types";
import { BrowserExecutionSessionService } from "./session";
import { clearUserContinueRequest, clearUserStopRequest, consumeUserContinueConfirmation, didUserRequestStop, isLiveBotMounted, updateLiveBot } from "./ui";
import { dedupeLabels, normalizeKey, pathExists, writeBrowserDebug } from "./util";

const defaultChromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

type BrowserLaunchMode = "logged_cdp" | "logged_profile" | "logged_profile_clone" | "managed_cdp" | "managed_profile" | "ephemeral";
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

      if (loggedProfileLocked) {
        if (shouldUseLoggedProfileCloneOnLock()) {
          return {
            available: true,
            chromePath,
            message: "The controlled logged Chrome profile is locked, and profile cloning was explicitly enabled, so GradLaunch will open a controlled runtime copy."
          };
        }

        if (shouldRequireLoggedBrowser()) {
          return {
            available: false,
            chromePath,
            message: buildLockedLoggedProfileMessage()
          };
        }

        if (shouldAllowManagedFallbackOnLockedLoggedProfile()) {
          return {
            available: true,
            chromePath,
            message: "The controlled logged Chrome profile is already open without remote debugging, so GradLaunch will use the managed persistent profile and pause for login confirmation if needed."
          };
        }

        return {
          available: false,
          chromePath,
          message: buildLockedLoggedProfileMessage()
        };
      }

      return {
        available: true,
        chromePath,
        message: "Browser worker will open the controlled logged Chrome profile; login cookies from this GradLaunch-owned profile will persist across runs."
      };
    }

    if (shouldPreferLoggedBrowser() && shouldRequireLoggedBrowser()) {
      return {
        available: false,
        chromePath,
        message: "No prepared logged Chrome profile found. Either run `npm run browser:prepare-logged-profile` or set `BROWSER_REQUIRE_LOGGED_PROFILE=false` to use manual login handoff."
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
    const resumeUrl = sanitizeBrowserResumeUrl(input.planner?.currentUrl, input.job.sourceUrl);

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
      await clearUserContinueRequest(page);
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
        await updateExecutionSession(this.executionSessions, executionSessionId, {
          status: "waiting",
          latestMessage: initialCheckpoint.reason ?? "The browser session is waiting for login in the controlled Chrome window.",
          planner,
          currentUrl: activePage.url(),
          currentStageIndex: 0,
          currentStageLabel: "Login required",
          workspacePath,
          lastStageSignature: await getStageSignature(activePage),
          pendingHandoff: {
            kind: "login",
            title: "Login required",
            detail: "Complete login in this Chrome window, then click the GradLaunch continue button.",
            requestedAt: nowIso()
          }
        });
        const loginHandoff = await waitForLoginConfirmation({
          context,
          page: activePage,
          stageIndex: 0,
          workspacePath,
          screenshots,
          planner,
          reason: initialCheckpoint.reason ?? "Please sign in in this controlled Chrome window. When the job form is visible, click I am logged in, continue.",
          handoffKind: "login",
          sourceUrl: input.job.sourceUrl
        });
        activePage = loginHandoff.activePage;
        initialCheckpoint = await detectProtectedCheckpoint(activePage);

        if (!loginHandoff.resolved) {
          await updateExecutionSession(this.executionSessions, executionSessionId, {
            status: "waiting",
            latestMessage: "The browser session is waiting for login confirmation before filling starts.",
            planner,
            currentUrl: activePage.url(),
            currentStageIndex: 0,
            currentStageLabel: "Login required",
            workspacePath,
            lastStageSignature: await getStageSignature(activePage),
            pendingHandoff: {
              kind: "login",
              title: "Login required",
              detail: "Login still needs to be completed or confirmed before GradLaunch can fill the form.",
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
            message: "GradLaunch opened the job URL in Chrome and is waiting for you to finish login, click the in-browser continue button, and expose the application form.",
            planner
          };
        }
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
      const seenStageVisitKeys = new Set<string>();
      const resumeUploadAttemptsByStage = new Map<string, number>();

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
          await updateExecutionSession(this.executionSessions, executionSessionId, {
            status: "waiting",
            latestMessage: protectedCheckpoint.reason ?? `Stage ${stageIndex + 1} is waiting for login in the controlled Chrome window.`,
            planner,
            currentUrl: activePage.url(),
            currentStageIndex: stageIndex,
            currentStageLabel: `Stage ${stageIndex + 1}`,
            workspacePath,
            lastStageSignature: await getStageSignature(activePage),
            filledCount: filledLabels.length,
            manualCount: skippedLabels.length,
            pendingHandoff: {
              kind: "login",
              title: "Login required",
              detail: "Complete login in this Chrome window, then click the GradLaunch continue button.",
              requestedAt: nowIso()
            }
          });
          const loginHandoff = await waitForLoginConfirmation({
            context,
            page: activePage,
            stageIndex,
            workspacePath,
            screenshots,
            planner,
            reason: protectedCheckpoint.reason ?? "Please sign in in this controlled Chrome window. When the job form is visible, click I am logged in, continue.",
            handoffKind: "login",
            sourceUrl: input.job.sourceUrl
          });
          activePage = loginHandoff.activePage;
          protectedCheckpoint = await detectProtectedCheckpoint(activePage);

          if (!loginHandoff.resolved) {
            return {
              status: "handoff_required",
              sourceUrl: input.job.sourceUrl,
              openedAt,
              completedAt: nowIso(),
              filledLabels,
              skippedLabels,
              screenshots,
              message: "The job portal still needs login confirmation before GradLaunch can continue filling.",
              planner
            };
          }

          continue;
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

        const stageSnapshot = await collectStageSnapshot(activePage);
        let stageVisibleFields = stageSnapshot.visibleFields;
        let observation = stageSnapshot.observation;
        const stageSignature = await getStageSignature(activePage, observation);
        const stagePlan = buildStageExecutionPlan({
          observation,
          resumeAvailable: Boolean(input.resume?.storagePath),
          submitRequested: input.submit,
          allowExternalSubmit: process.env.BROWSER_ALLOW_EXTERNAL_SUBMIT === "true"
        });
        const requiredLabels = stageVisibleFields.filter((field) => field.required).map((field) => field.label);
        recordPlannerObservation({
          planner,
          page: activePage,
          stageIndex,
          visibleFieldLabels: stageVisibleFields.map((field) => field.label),
          requiredFieldLabels: requiredLabels
        });

        const fingerprint = await getPageFingerprint(activePage);
        seenStageVisitKeys.add(stageVisitKey(stageSignature));

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
          checklist: stagePlan.checklist,
          classification: stagePlan.classification,
          rankedActions: stagePlan.rankedActions
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

        let stageAction = stagePlan.action;
        let activeClassification = stagePlan.classification;

        if (stageAction === "ask_user" && (observation.pageState === "login" || stagePlan.classification?.state === "login" || observation.pageState === "account_gate")) {
          const loginHandoff = await waitForLoginConfirmation({
            context,
            page: activePage,
            stageIndex,
            workspacePath,
            screenshots,
            planner,
            reason: "Sign in is required. Use Google/email in this controlled Chrome window, then click I am logged in, continue when the job form is visible.",
            handoffKind: "login",
            sourceUrl: input.job.sourceUrl
          });
          activePage = loginHandoff.activePage;

          if (!loginHandoff.resolved) {
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

          markPlannerTask(planner, "authenticate_if_needed", "running", "Login gate cleared after user confirmation. Resuming autonomous execution.");
          setPlannerStatus(planner, "running", "Login gate cleared after user confirmation.");
          continue;
        }

        if (stageAction === "ask_user") {
          const handoff = await waitForHumanIntervention({
            context,
            page: activePage,
            stageIndex,
            workspacePath,
            screenshots,
            planner,
            reason: stagePlan.reason,
            handoffKind: stagePlan.classification?.state === "captcha" ? "captcha" : "review"
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
              message: stagePlan.reason,
              planner
            };
          }

          continue;
        }

        if (stageAction === "wait") {
          await updateLiveBot(activePage, {
            step: `Stage ${stageIndex + 1}`,
            mood: "thinking",
            message: "The portal still looks busy, so I am waiting and re-reading instead of treating the loader as a validation error."
          });
          await activePage.waitForTimeout(Number(process.env.BROWSER_DYNAMIC_WAIT_MS ?? 1400)).catch(() => undefined);
          continue;
        }

        if (stageAction === "explore") {
          const probe = await probeAndReobservePage({
            page: activePage,
            workspacePath,
            stageIndex
          });
          activePage = await getActivePage(context, activePage);

          if (probe.protectedCheckpoint.blocked) {
            const handoff = await waitForHumanIntervention({
              context,
              page: activePage,
              stageIndex,
              workspacePath,
              screenshots,
              planner,
              reason: probe.protectedCheckpoint.reason ?? "Manual attention is required before GradLaunch can continue.",
              handoffKind: mapCheckpointToHandoff(probe.protectedCheckpoint.kind)
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
                message: probe.protectedCheckpoint.reason ?? "The page still needs manual attention.",
                planner
              };
            }

            continue;
          }

          stageVisibleFields = probe.visibleFields;
          observation = probe.observation;
          activeClassification = probe.classification;

          if (probe.uploadVisible && input.resume?.storagePath && await pathExists(input.resume.storagePath)) {
            stageAction = "upload_resume";
          } else if (stageVisibleFields.length > 0) {
            stageAction = "fill";
          } else if (["review", "submit"].includes(probe.classification.state)) {
            stageAction = "stop";
          } else if (probe.classification.state === "start") {
            stageAction = "click_next";
          } else if (probe.classification.state === "loading" || probe.classification.state === "empty") {
            await updateLiveBot(activePage, {
              step: `Stage ${stageIndex + 1}`,
              mood: "thinking",
              message: "The portal is still rendering the application controls, so I am waiting and re-scanning."
            });
            await activePage.waitForTimeout(Number(process.env.BROWSER_DYNAMIC_WAIT_MS ?? 1400)).catch(() => undefined);
            continue;
          } else {
            await updateLiveBot(activePage, {
              step: `Stage ${stageIndex + 1}`,
              mood: "waiting",
              message: "I safely probed the page but still could not identify a confident form action."
            });
            setPlannerStatus(planner, "needs_review", "Safe exploration did not reveal a confident form action.");
            return {
              status: "needs_manual_review",
              sourceUrl: input.job.sourceUrl,
              openedAt,
              completedAt: nowIso(),
              filledLabels,
              skippedLabels,
              screenshots,
              message: "GradLaunch safely explored the page but could not confidently decide the next form action.",
              planner
            };
          }
        }

        const shouldPauseForSameScreenLoop = sameScreenAttempts > loopThreshold
          && stageAction !== "fill"
          && stageVisibleFields.length === 0;

        if (sameScreenAttempts > loopThreshold && !shouldPauseForSameScreenLoop) {
          await writeBrowserDebug(workspacePath, "same-screen-loop-guard-deferred", {
            stageIndex,
            sameScreenAttempts,
            stageAction,
            visibleFieldCount: stageVisibleFields.length,
            reason: "The same page is still fillable, so GradLaunch will continue field repair instead of pausing as a navigation loop."
          });
        }

        if (shouldPauseForSameScreenLoop) {
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

        if (stageAction === "stop") {
          await updateLiveBot(activePage, {
            step: "Review Ready",
            mood: "done",
            message: "This page looks like a review or submit checkpoint, so I am pausing instead of navigating away."
          });
          markPlannerTask(planner, "reach_submit_gate", "completed", "Reached a review/submit checkpoint safely.");
          markPlannerTask(planner, "save_checkpoint", "completed", "Saved planner state at the review checkpoint.");
          setPlannerStatus(planner, "completed", "Planner paused at the review/submit checkpoint.");
          recordPlannerStageOutcome({
            planner,
            page: activePage,
            stageIndex,
            outcome: "review",
            filledFieldLabels: filledLabels
          });
          keepContextOpen = shouldKeepBrowserOpenForReview();
          await maybeKeepBrowserOpen(context);
          await saveScreenshot(activePage, workspacePath, screenshots, "browser-filled.png");
          await updateExecutionSession(this.executionSessions, executionSessionId, {
            status: "review_ready",
            latestMessage: "The form is ready for review in the open browser.",
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
            message: "The form is filled and paused at a review or submit checkpoint.",
            planner
          };
        }

        const resumeAvailableOnDisk = Boolean(input.resume?.storagePath && await pathExists(input.resume.storagePath));
        const shouldAttemptResumeUpload = Boolean(
          !resumeUploaded
          && resumeAvailableOnDisk
          && (stageAction === "upload_resume" || await hasFileUpload(activePage))
        );

        if (shouldAttemptResumeUpload && input.resume?.storagePath) {
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
            reason: stageAction === "upload_resume"
              ? "The page was classified as a resume upload stage."
              : "Resume upload field detected on this screen.",
            fieldLabels: ["Resume upload"]
          });
          await writeBrowserDebug(workspacePath, "resume-upload-attempt", {
            stageIndex,
            resumePath: input.resume.storagePath,
            requiresTransition: isResumeMethodChoiceObservation(observation)
          });
          resumeUploaded = await attachResume(activePage, input.resume.storagePath);
          await writeBrowserDebug(workspacePath, "resume-upload-result", {
            stageIndex,
            uploaded: resumeUploaded
          });

          if (resumeUploaded && isResumeMethodChoiceObservation(observation)) {
            const stageKey = `${stageSignature.url}:${stageSignature.progressText ?? ""}:${stageSignature.controlLabels.join("|")}`;
            const attempts = (resumeUploadAttemptsByStage.get(stageKey) ?? 0) + 1;
            resumeUploadAttemptsByStage.set(stageKey, attempts);
            await updateLiveBot(activePage, {
              step: `Stage ${stageIndex + 1}`,
              mood: "thinking",
              message: "Resume selected. Waiting for the portal to process it and open the next application step."
            });
            const completion = await waitForResumeUploadCompletion({
              context,
              page: activePage,
              stageIndex,
              planner,
              workspacePath,
              resumePath: input.resume.storagePath,
              baselineSignature: stageSignature
            });
            activePage = completion.activePage;
            await writeBrowserDebug(workspacePath, "resume-upload-completion", {
              stageIndex,
              completed: completion.completed,
              reason: completion.reason,
              attempts
            });

            if (completion.completed) {
              if (!seenFilled.has("resume upload")) {
                seenFilled.add("resume upload");
                filledLabels.push("Resume upload");
              }

              continue;
            }

            resumeUploaded = false;

            if (attempts < 2) {
              await updateLiveBot(activePage, {
                step: `Stage ${stageIndex + 1}`,
                mood: "acting",
                message: "The portal did not move after the first upload attempt, so I am retrying the From Device upload path once."
              });
              continue;
            }

            const message = `GradLaunch selected the resume upload path, but the portal stayed on the same application-method screen: ${completion.reason}`;
            setPlannerStatus(planner, "needs_review", message);
            await updateExecutionSession(this.executionSessions, executionSessionId, {
              status: "resumable",
              latestMessage: message,
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
              message,
              planner
            };
          }

          if (resumeUploaded && !seenFilled.has("resume upload")) {
            seenFilled.add("resume upload");
            filledLabels.push("Resume upload");
          }

          if (resumeUploaded) {
            const refreshedSnapshot = await collectStageSnapshot(activePage);
            stageVisibleFields = refreshedSnapshot.visibleFields;
            observation = refreshedSnapshot.observation;
            activeClassification = buildStageExecutionPlan({
              observation,
              resumeAvailable: Boolean(input.resume?.storagePath),
              submitRequested: input.submit,
              allowExternalSubmit: process.env.BROWSER_ALLOW_EXTERNAL_SUBMIT === "true"
            }).classification ?? activeClassification;

            if (stageVisibleFields.length > 0) {
              stageAction = "fill";
            }
          }
        }

        let answerPlan: StageAnswerPlan | undefined;
        let failedRequiredAfterRetries: BrowserFillField[] = [];

        if (stageAction === "fill" && stageVisibleFields.length > 0) {
          const autonomousFill = await runFillEngine({
            page: activePage,
            stageIndex,
            visibleFields: stageVisibleFields,
            baseFields: input.fields,
            job: input.job,
            student: input.student,
            memory: input.memory,
            resumeText: input.resume?.extractedText,
            workspacePath,
            shouldStop: () => didUserRequestStop(activePage),
            onStatus: (message) => updateLiveBot(activePage, {
              step: `Stage ${stageIndex + 1}`,
              mood: "thinking",
              message
            })
          });

          if (autonomousFill.stopped) {
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

          answerPlan = autonomousFill.answerPlan;
          failedRequiredAfterRetries = autonomousFill.failedFields;
          stageVisibleFields = autonomousFill.visibleFields;

          if (!answerPlan) {
            await writeBrowserDebug(workspacePath, "autonomous-fill-no-plan", {
              stageIndex,
              visibleFieldCount: autonomousFill.visibleFields.length
            });
          } else {
            recordPlannerDecision({
              planner,
              page: activePage,
              stageIndex,
              kind: plannerActionFromBrowserAction("fill"),
              source: answerPlan.usedLlm ? "llm" : "heuristic",
              reason: answerPlan.summary ?? "The autonomous form solver mapped and filled the current stage.",
              fieldLabels: answerPlan.answers.map((field) => field.label)
            });
            await updateLiveBot(activePage, {
              step: `Stage ${stageIndex + 1}`,
              mood: "acting",
              message: answerPlan.summary ?? `Autonomous fill verified ${autonomousFill.attempts.filter((attempt) => attempt.verified).length} field answer(s) on this stage.`
            });
          }

          for (const attempt of autonomousFill.attempts) {
            const key = attempt.field.label.toLowerCase().trim();
            const verified = attempt.verified;
            await writeBrowserDebug(workspacePath, verified ? "filled-field" : "failed-to-fill-field", {
              stageIndex,
              round: attempt.round,
              fieldId: attempt.field.fieldId,
              label: attempt.field.label,
              inputType: attempt.field.inputType,
              alreadySatisfied: attempt.alreadySatisfied,
              valuePreview: attempt.field.value.length > 80 ? `${attempt.field.value.slice(0, 77)}...` : attempt.field.value
            });

            if (verified) {
              if (!seenFilled.has(key)) {
                seenFilled.add(key);
                filledLabels.push(attempt.field.label);
              }
            } else if (!seenSkipped.has(key)) {
              seenSkipped.add(key);
              skippedLabels.push(attempt.field.label);
            }
          }

          if (autonomousFill.outstandingRequired.length > 0 || autonomousFill.validationMessages.length > 0) {
            await writeBrowserDebug(workspacePath, "autonomous-fill-blockers", {
              stageIndex,
              outstandingRequired: autonomousFill.outstandingRequired,
              validationMessages: autonomousFill.validationMessages,
              failedLabels: failedRequiredAfterRetries.map((field) => field.label)
            });
          }

          await autoResolveConsentControls(activePage);
        }

        const submitVisible = await hasFinalSubmitControl(activePage);
        let outstandingRequired = await getVisibleRequiredEmptyLabels(activePage);
        let validationMessages = await getVisibleValidationMessages(activePage);
        let uploadStillPending = Boolean(
          input.resume?.storagePath
          && await pathExists(input.resume.storagePath)
          && await hasFileUpload(activePage)
          && !resumeUploaded
        );

        if (uploadStillPending && input.resume?.storagePath) {
          await writeBrowserDebug(workspacePath, "resume-upload-retry-before-evaluation", {
            stageIndex,
            resumePath: input.resume.storagePath
          });
          resumeUploaded = await attachResume(activePage, input.resume.storagePath);
          await writeBrowserDebug(workspacePath, "resume-upload-retry-result", {
            stageIndex,
            uploaded: resumeUploaded
          });
          uploadStillPending = Boolean(
            input.resume?.storagePath
            && await pathExists(input.resume.storagePath)
            && await hasFileUpload(activePage)
            && !resumeUploaded
          );

          if (resumeUploaded && !seenFilled.has("resume upload")) {
            seenFilled.add("resume upload");
            filledLabels.push("Resume upload");
          }

          if (resumeUploaded) {
            outstandingRequired = await getVisibleRequiredEmptyLabels(activePage);
            validationMessages = await getVisibleValidationMessages(activePage);
          }
        }

        if (uploadStillPending && !outstandingRequired.some((label) => label.toLowerCase().includes("resume upload"))) {
          outstandingRequired = [...outstandingRequired, "Resume upload"];
        }

        const removedEmptyExperience = await cleanupEmptyWorkHistoryCardsIfNoProfileHistory({
          page: activePage,
          input,
          outstandingRequired,
          workspacePath,
          stageIndex
        });

        if (removedEmptyExperience) {
          await updateLiveBot(activePage, {
            step: `Stage ${stageIndex + 1}`,
            mood: "acting",
            message: "Removed an empty work-experience card because the stored profile has no work history."
          });
          outstandingRequired = await getVisibleRequiredEmptyLabels(activePage);
          validationMessages = await getVisibleValidationMessages(activePage);
        }

        let completionGuardLabels: string[] = [];
        const guardedReadiness = await applyCurrentPageCompletionGuard({
          page: activePage,
          failedFields: failedRequiredAfterRetries,
          outstandingRequired,
          workspacePath,
          stageIndex
        });
        outstandingRequired = guardedReadiness.outstandingRequired;
        completionGuardLabels = guardedReadiness.guardLabels;
        outstandingRequired = pruneNonActionableRequiredLabels(outstandingRequired, input.job);

        let evaluation = evaluateStageReadiness({
          visibleFields: stageVisibleFields,
          outstandingRequired,
          validationMessages,
          submitVisible,
          submitRequested: input.submit,
          allowExternalSubmit: process.env.BROWSER_ALLOW_EXTERNAL_SUBMIT === "true"
        });
        let recoveryPlan = classifyRecovery({
          classification: activeClassification,
          outstandingRequired,
          validationMessages,
          uploadStillPending,
          failedFieldCount: failedRequiredAfterRetries.length
        });
        await writeBrowserDebug(workspacePath, "recovery-plan", {
          stageIndex,
          kind: recoveryPlan.kind,
          confidence: recoveryPlan.confidence,
          reason: recoveryPlan.reason,
          actions: recoveryPlan.actions
        });

        if (recoveryPlan.kind === "network_delay") {
          await updateLiveBot(activePage, {
            step: `Stage ${stageIndex + 1}`,
            mood: "thinking",
            message: "The page appears to be processing changes, so I am waiting and re-scanning before deciding."
          });
          await activePage.waitForTimeout(Number(process.env.BROWSER_DYNAMIC_WAIT_MS ?? 1400)).catch(() => undefined);
          continue;
        }

        if (evaluation.status === "needs_user" || evaluation.status === "needs_retry") {
          const repairedKnownChoice = await resolveKnownRequiredChoice(activePage, [
            ...evaluation.missingRequiredLabels,
            ...evaluation.validationMessages
          ]);

          if (repairedKnownChoice) {
            await writeBrowserDebug(workspacePath, "known-choice-required-repair-result", {
              stageIndex,
              repaired: true,
              blockers: [
                ...evaluation.missingRequiredLabels,
                ...evaluation.validationMessages
              ]
            });
            outstandingRequired = await getVisibleRequiredEmptyLabels(activePage);
            validationMessages = await getVisibleValidationMessages(activePage);
            outstandingRequired = pruneNonActionableRequiredLabels(outstandingRequired, input.job);
            evaluation = evaluateStageReadiness({
              visibleFields: stageVisibleFields,
              outstandingRequired,
              validationMessages,
              submitVisible: await hasFinalSubmitControl(activePage),
              submitRequested: input.submit,
              allowExternalSubmit: process.env.BROWSER_ALLOW_EXTERNAL_SUBMIT === "true"
            });
            recoveryPlan = classifyRecovery({
              classification: activeClassification,
              outstandingRequired,
              validationMessages,
              uploadStillPending,
              failedFieldCount: failedRequiredAfterRetries.length
            });
          }
        }

        if (answerPlan && evaluation.status === "needs_user") {
          const autocompleteRepairs = answerPlan.answers.filter((field) => {
            const label = field.label.toLowerCase();
            const missing = evaluation.missingRequiredLabels.some((missingLabel) => {
              const normalizedMissing = missingLabel.toLowerCase();
              return normalizedMissing.includes(label) || label.includes(normalizedMissing);
            });

            return missing && (
              field.inputType === "combobox"
              || /\b(city|location|place|residence|school|university|college)\b/i.test(`${field.label} ${field.value}`)
            );
          });

          if (autocompleteRepairs.length > 0) {
            await writeBrowserDebug(workspacePath, "autocomplete-required-repair-start", {
              stageIndex,
              missingRequiredLabels: evaluation.missingRequiredLabels,
              fieldLabels: autocompleteRepairs.map((field) => field.label)
            });

            for (const field of autocompleteRepairs) {
              await attemptRepairFieldFill(activePage, field, {
                workspacePath,
                stageIndex,
                repairKind: "autocomplete"
              });
              await activePage.waitForTimeout(450).catch(() => undefined);
            }

            outstandingRequired = await getVisibleRequiredEmptyLabels(activePage);
            validationMessages = await getVisibleValidationMessages(activePage);
            evaluation = evaluateStageReadiness({
              visibleFields: stageVisibleFields,
              outstandingRequired,
              validationMessages,
              submitVisible,
              submitRequested: input.submit,
              allowExternalSubmit: process.env.BROWSER_ALLOW_EXTERNAL_SUBMIT === "true"
            });
            await writeBrowserDebug(workspacePath, "autocomplete-required-repair-result", {
              stageIndex,
              status: evaluation.status,
              missingRequiredLabels: evaluation.missingRequiredLabels,
              validationMessages: evaluation.validationMessages
            });
          }
        }

        if (answerPlan && (evaluation.status === "needs_user" || evaluation.status === "needs_retry")) {
          const choiceRepairs = answerPlan.answers.filter((field) => {
            if (field.inputType !== "radio" && field.inputType !== "checkbox") {
              return false;
            }

            const fieldLabel = field.label.toLowerCase();
            const blockerText = [...evaluation.missingRequiredLabels, ...evaluation.validationMessages].join(" ").toLowerCase();

            return blockerText.includes(fieldLabel)
              || fieldLabel.includes(blockerText)
              || /\b(this field is required|there are some errors|please correct)\b/i.test(blockerText);
          });

          if (choiceRepairs.length > 0) {
            await writeBrowserDebug(workspacePath, "choice-required-repair-start", {
              stageIndex,
              missingRequiredLabels: evaluation.missingRequiredLabels,
              validationMessages: evaluation.validationMessages,
              fieldLabels: choiceRepairs.map((field) => field.label)
            });

            for (const field of choiceRepairs) {
              await attemptRepairFieldFill(activePage, field, {
                workspacePath,
                stageIndex,
                repairKind: "choice"
              });
              await activePage.waitForTimeout(500).catch(() => undefined);
            }

            outstandingRequired = await getVisibleRequiredEmptyLabels(activePage);
            validationMessages = await getVisibleValidationMessages(activePage);

            if (outstandingRequired.length === 0 && isStaleChoiceValidation(validationMessages, choiceRepairs)) {
              validationMessages = [];
            }

            evaluation = evaluateStageReadiness({
              visibleFields: stageVisibleFields,
              outstandingRequired,
              validationMessages,
              submitVisible,
              submitRequested: input.submit,
              allowExternalSubmit: process.env.BROWSER_ALLOW_EXTERNAL_SUBMIT === "true"
            });
            await writeBrowserDebug(workspacePath, "choice-required-repair-result", {
              stageIndex,
              status: evaluation.status,
              missingRequiredLabels: evaluation.missingRequiredLabels,
              validationMessages: evaluation.validationMessages
            });
          }
        }

        if (evaluation.status === "needs_user" || evaluation.status === "needs_retry") {
          const directRepairs = dedupeRepairFields([
            ...(answerPlan?.answers ?? []).filter((field) => shouldRepairMissingField(field, evaluation.missingRequiredLabels)),
            ...buildMissingProfileRepairFields(evaluation.missingRequiredLabels, input)
          ]);

          if (directRepairs.length > 0) {
            await writeBrowserDebug(workspacePath, "direct-required-repair-start", {
              stageIndex,
              missingRequiredLabels: evaluation.missingRequiredLabels,
              fieldLabels: directRepairs.map((field) => field.label)
            });
            await updateLiveBot(activePage, {
              step: `Stage ${stageIndex + 1}`,
              mood: "acting",
              message: `Retrying known profile answers for: ${directRepairs.map((field) => field.label).slice(0, 5).join(", ")}.`
            });

            for (const field of directRepairs) {
              await attemptRepairFieldFill(activePage, field, {
                workspacePath,
                stageIndex,
                repairKind: "direct"
              });
              await activePage.waitForTimeout(250).catch(() => undefined);
            }

            outstandingRequired = await getVisibleRequiredEmptyLabels(activePage);
            validationMessages = await getVisibleValidationMessages(activePage);
            evaluation = evaluateStageReadiness({
              visibleFields: stageVisibleFields,
              outstandingRequired,
              validationMessages,
              submitVisible: await hasFinalSubmitControl(activePage),
              submitRequested: input.submit,
              allowExternalSubmit: process.env.BROWSER_ALLOW_EXTERNAL_SUBMIT === "true"
            });
            await writeBrowserDebug(workspacePath, "direct-required-repair-result", {
              stageIndex,
              status: evaluation.status,
              missingRequiredLabels: evaluation.missingRequiredLabels,
              validationMessages: evaluation.validationMessages
            });
          }
        }

        if (answerPlan && evaluation.status === "needs_retry" && outstandingRequired.length === 0 && isStaleChoiceValidation(validationMessages, answerPlan.answers)) {
          validationMessages = [];
          evaluation = evaluateStageReadiness({
            visibleFields: stageVisibleFields,
            outstandingRequired,
            validationMessages,
            submitVisible,
            submitRequested: input.submit,
            allowExternalSubmit: process.env.BROWSER_ALLOW_EXTERNAL_SUBMIT === "true"
          });
          await writeBrowserDebug(workspacePath, "stale-choice-validation-ignored", {
            stageIndex,
            reason: "A required radio/checkbox answer is selected, and only a stale generic validation banner remains."
          });
        }

        const finalGuardedReadiness = await applyCurrentPageCompletionGuard({
          page: activePage,
          failedFields: failedRequiredAfterRetries,
          outstandingRequired,
          workspacePath,
          stageIndex
        });

        if (finalGuardedReadiness.guardLabels.length > 0 || finalGuardedReadiness.outstandingRequired.length !== outstandingRequired.length) {
          outstandingRequired = finalGuardedReadiness.outstandingRequired;
          completionGuardLabels = finalGuardedReadiness.guardLabels;
          outstandingRequired = pruneNonActionableRequiredLabels(outstandingRequired, input.job);
          evaluation = evaluateStageReadiness({
            visibleFields: stageVisibleFields,
            outstandingRequired,
            validationMessages,
            submitVisible: await hasFinalSubmitControl(activePage),
            submitRequested: input.submit,
            allowExternalSubmit: process.env.BROWSER_ALLOW_EXTERNAL_SUBMIT === "true"
          });
        }

        await writeBrowserDebug(workspacePath, "stage-evaluation", {
          stageIndex,
          status: evaluation.status,
          confidence: evaluation.confidence,
          reason: evaluation.reason,
          missingRequiredLabels: evaluation.missingRequiredLabels,
          validationMessages: evaluation.validationMessages,
          completionGuardLabels
        });
        await updateLiveBot(activePage, {
          step: `Stage ${stageIndex + 1}`,
          mood: evaluation.status === "needs_user" ? "waiting" : evaluation.status === "needs_retry" ? "thinking" : "acting",
          message: evaluation.reason
        });

        if (stageAction === "fill" && evaluation.status === "needs_retry" && process.env.BROWSER_STAGE_REFLECTION_ENABLED === "true") {
          const reflection = await reflectOnStageAnswers({
            job: input.job,
            student: input.student,
            memory: input.memory,
            visibleFields: stageVisibleFields,
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
              await attemptRepairFieldFill(activePage, field, {
                workspacePath,
                stageIndex,
                repairKind: "stage"
              });
            }

            await autoResolveConsentControls(activePage);
            outstandingRequired = await getVisibleRequiredEmptyLabels(activePage);
            validationMessages = await getVisibleValidationMessages(activePage);
            evaluation = evaluateStageReadiness({
              visibleFields: stageVisibleFields,
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
        const allowApplyStart = shouldAllowApplyStartNavigation({
          observation,
          classificationState: activeClassification?.state,
          stageAction,
          visibleFieldCount: stageVisibleFields.length
        });
        const navigation = await clickNextStageControl(context, activePage, { allowApplyStart });

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
        const nextStageSignature = await getStageSignature(activePage);

        if (seenStageVisitKeys.has(stageVisitKey(nextStageSignature))) {
          const message = "The next action returned to a previously seen application screen, so GradLaunch paused to avoid a back/forward loop.";
          bumpPlannerRetries(planner, "retry_alternative_path", message, activePage, stageIndex);
          await updateLiveBot(activePage, {
            step: `Stage ${stageIndex + 1}`,
            mood: "waiting",
            message
          });
          await updateExecutionSession(this.executionSessions, executionSessionId, {
            status: "resumable",
            latestMessage: message,
            planner,
            currentUrl: activePage.url(),
            currentStageIndex: stageIndex,
            currentStageLabel: `Stage ${stageIndex + 1}`,
            workspacePath,
            lastStageSignature: nextStageSignature,
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

  if (!isHttpUrl(targetUrl)) {
    throw new Error(`GradLaunch refused to navigate to a non-job browser URL: ${targetUrl}`);
  }

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

function isHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_error) {
    return false;
  }
}

function stageVisitKey(signature: Awaited<ReturnType<typeof getStageSignature>>) {
  return [
    signature.url,
    signature.progressText ?? "",
    signature.fingerprint
  ].join("|");
}

function sanitizeBrowserResumeUrl(value: string | undefined, sourceUrl: string) {
  if (!value) {
    return undefined;
  }

  let parsed: URL;
  let source: URL;

  try {
    parsed = new URL(value);
    source = new URL(sourceUrl);
  } catch (_error) {
    return undefined;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }

  if (looksLikeLoginUrl(value) || looksLikePersonalBrowsingUrl(value)) {
    return undefined;
  }

  if (!isSameSiteOrSubdomain(parsed.hostname, source.hostname)) {
    return undefined;
  }

  return parsed.toString();
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

  const stageSnapshot = await collectStageSnapshot(page).catch(() => undefined);
  const observation = stageSnapshot?.observation;

  return Boolean(observation && observation.pageState !== "login" && observation.pageState !== "account_gate");
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

function looksLikePersonalBrowsingUrl(value: string) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return /(^|\.)youtube\.com$/.test(host)
      || /(^|\.)youtu\.be$/.test(host)
      || /(^|\.)gmail\.com$/.test(host)
      || /(^|\.)googlemail\.com$/.test(host)
      || /(^|\.)workspace\.google\.com$/.test(host)
      || /(^|\.)mail\.google\.com$/.test(host);
  } catch (_error) {
    return true;
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

function sameHostname(left: string, right: string) {
  try {
    return new URL(left).hostname === new URL(right).hostname;
  } catch (_error) {
    return false;
  }
}

function isSameSiteOrSubdomain(leftHost: string, rightHost: string) {
  const left = leftHost.toLowerCase();
  const right = rightHost.toLowerCase();

  if (left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`)) {
    return true;
  }

  const leftSite = approximateSiteDomain(left);
  const rightSite = approximateSiteDomain(right);
  return Boolean(leftSite && rightSite && leftSite === rightSite);
}

function approximateSiteDomain(hostname: string) {
  const parts = hostname.split(".").filter(Boolean);

  if (parts.length < 2) {
    return hostname;
  }

  return parts.slice(-2).join(".");
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

async function waitForResumeUploadCompletion(input: {
  context: BrowserContext;
  page: Page;
  stageIndex: number;
  planner: ReturnType<typeof createPlannerCheckpoint>;
  workspacePath: string;
  resumePath: string;
  baselineSignature: Awaited<ReturnType<typeof getStageSignature>>;
}) {
  const timeoutMs = Number(process.env.BROWSER_RESUME_UPLOAD_TIMEOUT_MS ?? 30000);
  const pollMs = Number(process.env.BROWSER_RESUME_UPLOAD_POLL_MS ?? 1000);
  const startedAt = Date.now();
  let activePage = input.page;
  let lastReason = "Waiting for the upload widget to finish processing.";

  while (Date.now() - startedAt < timeoutMs) {
    await activePage.waitForLoadState("domcontentloaded", { timeout: pollMs }).catch(() => undefined);
    await activePage.waitForTimeout(pollMs).catch(() => undefined);
    activePage = await getActivePage(input.context, activePage);

    const protectedCheckpoint = await detectProtectedCheckpoint(activePage);

    if (protectedCheckpoint.blocked) {
      return {
        completed: false,
        activePage,
        reason: protectedCheckpoint.reason ?? "A protected checkpoint appeared after selecting the resume file."
      };
    }

    const stageSnapshot = await collectStageSnapshot(activePage).catch(() => undefined);
    const visibleFields = stageSnapshot?.visibleFields ?? [];
    const observation = stageSnapshot?.observation;

    if (!observation) {
      lastReason = "The page is still loading or temporarily unreadable after selecting the resume.";
      continue;
    }

    const validationMessages = stageSnapshot?.validationMessages ?? [];
    const isLoading = validationMessages.some((message) => /loading|please wait|processing|uploading/i.test(message))
      || /loading|please wait|processing|uploading/i.test(observation.pageText);
    const methodChoiceStillVisible = isResumeMethodChoiceObservation(observation);

    if (isLoading || isTransientBlankObservation(observation)) {
      lastReason = "The portal is still processing the selected resume.";
      continue;
    }

    if (methodChoiceStillVisible) {
      if (await continueAfterResumeUploadIfReady(activePage, input.resumePath)) {
        lastReason = "Clicked the resume upload Continue button and waiting for the next application step.";
        continue;
      }

      lastReason = "The application-method choices are still visible after selecting the resume.";
      continue;
    }

    if (visibleFields.length > 0 || isActionablePostUploadState(observation)) {
      recordPlannerStageOutcome({
        planner: input.planner,
        page: activePage,
        stageIndex: input.stageIndex,
        outcome: "advanced",
        filledFieldLabels: ["Resume upload"]
      });
      return {
        completed: true,
        activePage,
        reason: `Resume upload moved the application flow to ${observation.pageState}.`
      };
    }

    const signatureAfter = await getStageSignature(activePage, observation);

    if (
      signatureAfter.url !== input.baselineSignature.url
      || signatureAfter.progressText !== input.baselineSignature.progressText
      || signatureAfter.fingerprint !== input.baselineSignature.fingerprint
    ) {
      return {
        completed: true,
        activePage,
        reason: "Resume upload changed the application stage signature."
      };
    }

    lastReason = `Current page state is still ${observation.pageState}.`;
  }

  return {
    completed: false,
    activePage,
    reason: lastReason
  };
}

function isResumeMethodChoiceObservation(observation: BrowserAgentObservation) {
  const text = normalizeAgentText([
    observation.title,
    observation.pageText,
    ...observation.controls.map((control) => `${control.text} ${control.label}`)
  ].join(" "));

  return /\b(choose an option to apply|application method|application methods|how would you like to apply|apply with)\b/.test(text)
    && /\b(from device|from computer|upload from device|upload from computer|select from device)\b/.test(text)
    && /\b(without resume|without cv|copy paste|copy and paste)\b/.test(text);
}

function shouldAllowApplyStartNavigation(input: {
  observation: BrowserAgentObservation;
  classificationState?: string;
  stageAction: string;
  visibleFieldCount: number;
}) {
  if (input.observation.pageState === "start" || input.classificationState === "start") {
    return true;
  }

  if (input.stageAction !== "click_next") {
    return false;
  }

  const hasApplyControl = input.observation.controls.some((control) => {
    const text = normalizeAgentText(`${control.text} ${control.label}`);
    return /\b(apply|apply now|apply for this job|apply for this position|start application|continue application|begin application|i m interested|im interested)\b/.test(text)
      && !/\b(sign in|signin|log in|login|google|email|password|forgot|create account|register|sign up)\b/.test(text);
  });

  return hasApplyControl && input.visibleFieldCount === 0;
}

function isTransientBlankObservation(observation: BrowserAgentObservation) {
  return observation.visibleFields.length === 0
    && observation.controls.length === 0
    && normalizeAgentText(observation.pageText).length < 25;
}

function isActionablePostUploadState(observation: BrowserAgentObservation) {
  return observation.pageState === "questionnaire"
    || observation.pageState === "consent"
    || observation.pageState === "form_fill"
    || observation.pageState === "review"
    || observation.pageState === "submit"
    || observation.pageState === "account_gate"
    || observation.pageState === "login";
}

async function applyCurrentPageCompletionGuard(input: {
  page: Page;
  failedFields: BrowserFillField[];
  outstandingRequired: string[];
  workspacePath: string;
  stageIndex: number;
}) {
  const pageRequiredLabels = await getVisibleRequiredEmptyLabels(input.page);
  const stillEmptyAttemptedLabels = input.failedFields.length > 0
    ? await getStillEmptyAttemptedRequiredLabels(input.page, input.failedFields)
    : [];
  const guardLabels = dedupeLabels(stillEmptyAttemptedLabels);
  const outstandingRequired = dedupeLabels([...input.outstandingRequired, ...pageRequiredLabels, ...guardLabels]);

  const newlyGuardedLabels = dedupeLabels([...pageRequiredLabels, ...guardLabels])
    .filter((label) => !input.outstandingRequired.some((existing) => normalizeKey(existing) === normalizeKey(label)));

  if (newlyGuardedLabels.length > 0) {
    await writeBrowserDebug(input.workspacePath, "stage-completion-guard", {
      stageIndex: input.stageIndex,
      guardLabels: newlyGuardedLabels,
      reason: "Visible required or application-critical fields are still empty, so navigation is blocked for this stage."
    });
  }

  return {
    outstandingRequired,
    guardLabels: dedupeLabels([...pageRequiredLabels, ...guardLabels])
  };
}

async function getStillEmptyAttemptedRequiredLabels(page: Page, failedFields: BrowserFillField[]) {
  const requiredFields = failedFields.filter((field) => {
    if (!field.required && !isLikelyRequiredAttemptedLabel(field.label)) {
      return false;
    }

    return !/\b(address line 2|address 2|middle name|preferred name|apt|suite)\b/i.test(field.label);
  });

  if (requiredFields.length === 0) {
    return [];
  }

  const missingLabels: string[] = [];

  for (const frame of page.frames()) {
    const frameMissing = await frame.evaluate((fields) => {
      const searchRoots = getSearchRoots();
      const missing: string[] = [];

      for (const field of fields) {
        const control = findBestControl(field);

        if (control && isEmptyControl(control)) {
          missing.push(field.label);
        }
      }

      return missing;

      function findBestControl(field: { label: string; inputType?: string; fieldId?: string }) {
        const labelKey = normalize(field.label);
        const controls = searchRoots.flatMap((root) => Array.from(root.querySelectorAll("input, textarea, select"))) as Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>;
        let best: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | undefined;
        let bestScore = 0;

        for (const control of controls) {
          if (!isUsableControl(control, field.inputType)) {
            continue;
          }

          const descriptor = normalize([
            control.getAttribute("aria-label"),
            control.getAttribute("placeholder"),
            control.getAttribute("name"),
            control.id,
            labelledByText(control),
            findLabelText(control),
            findNearbyLabelText(control),
            compactContainerText(control)
          ].filter(Boolean).join(" "));
          const idMatches = Boolean(field.fieldId && [
            control.getAttribute("data-gradlaunch-v2-field-id"),
            control.getAttribute("data-gradlaunch-fast-field-id"),
            control.getAttribute("data-gradlaunch-field-id")
          ].includes(field.fieldId));
          const score = scoreDescriptor(descriptor, labelKey, field.inputType, control) + (idMatches ? 140 : 0);

          if (score > bestScore) {
            best = control;
            bestScore = score;
          }
        }

        return bestScore >= 58 ? best : undefined;
      }

      function isUsableControl(
        control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
        wantedType: string | undefined
      ) {
        if (control.disabled) {
          return false;
        }

        if (control instanceof HTMLInputElement && ["hidden", "file", "submit", "button", "checkbox", "radio"].includes(control.type)) {
          return false;
        }

        if (wantedType === "select" && !(control instanceof HTMLSelectElement) && !(control instanceof HTMLInputElement && isCustomSelectLike(control))) {
          return false;
        }

        if (wantedType && wantedType !== "select" && control instanceof HTMLSelectElement) {
          return false;
        }

        const rect = control.getBoundingClientRect();
        const style = window.getComputedStyle(control);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      }

      function isEmptyControl(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
        if (control instanceof HTMLSelectElement) {
          const selected = control.selectedOptions[0];
          const selectedText = normalize(`${selected?.textContent ?? ""} ${selected?.value ?? ""} ${control.value}`);
          return isEmptySelectText(selectedText);
        }

        if (control instanceof HTMLInputElement && isCustomSelectLike(control)) {
          const actual = normalize(control.value);

          if (actual && !isEmptySelectText(actual)) {
            return false;
          }

          const container = control.closest("[role='combobox'], [aria-haspopup='listbox'], [data-radix-select-trigger], [data-headlessui-state], [class*='select'], [class*='combobox']")
            ?? control.parentElement;
          const selectedText = normalize([
            control.getAttribute("data-value"),
            control.getAttribute("aria-valuetext"),
            container?.getAttribute("data-value"),
            container?.getAttribute("aria-valuetext"),
            container?.textContent
          ].filter(Boolean).join(" "));

          return isEmptySelectText(selectedText);
        }

        return !control.value.trim();
      }

      function isEmptySelectText(value: string) {
        return !value
          || /^(select|select an option|choose|choose an option|please select|none selected)$/.test(value)
          || /\b(options available|total results|use the up and down keys|press enter to select|press escape to exit|not selected|results found|no results found)\b/.test(value);
      }

      function isCustomSelectLike(control: HTMLInputElement) {
        const popup = control.getAttribute("aria-haspopup") ?? "";
        const role = control.getAttribute("role") ?? "";
        const expanded = control.getAttribute("aria-expanded");

        if (role === "combobox" || /^(listbox|menu|dialog|tree|true)$/i.test(popup) || expanded !== null) {
          return true;
        }

        let ancestor = control.parentElement;

        for (let depth = 0; depth < 3 && ancestor; depth += 1) {
          const ancestorRole = ancestor.getAttribute("role") ?? "";
          const ancestorPopup = ancestor.getAttribute("aria-haspopup") ?? "";
          const ancestorExpanded = ancestor.getAttribute("aria-expanded");
          const className = String(ancestor.getAttribute("class") ?? "");

          if (
            ancestorRole === "combobox"
            || /^(listbox|menu|dialog|tree|true)$/i.test(ancestorPopup)
            || ancestorExpanded !== null
            || ancestor.hasAttribute("data-radix-select-trigger")
            || ancestor.hasAttribute("data-headlessui-state")
            || /\b(combobox|select__control|select-control|select-trigger|select-input)\b/i.test(className)
          ) {
            return true;
          }

          ancestor = ancestor.parentElement;
        }

        return false;
      }

      function scoreDescriptor(
        descriptor: string,
        wantedLabel: string,
        wantedType: string | undefined,
        control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      ) {
        if (!descriptor || !wantedLabel) {
          return 0;
        }

        let score = 0;

        if (descriptor === wantedLabel) {
          score += 150;
        } else if (descriptor.includes(wantedLabel)) {
          score += 118;
        } else if (wantedLabel.includes(descriptor) && descriptor.length > 3) {
          score += 92;
        }

        const tokens = wantedLabel
          .split(" ")
          .filter((token) => token.length > 1 && !/^(select|option|your|please|field|number)$/.test(token));
        score += tokens.reduce((sum, token) => sum + (descriptor.includes(token) ? 20 : 0), 0);

        if (/\b(home email|email|e mail)\b/.test(wantedLabel) && /\b(email|e mail)\b/.test(descriptor)) {
          score = Math.max(score, 88);
        }

        if (/\b(phone|mobile|contact)\b/.test(wantedLabel) && /\b(phone|mobile|contact|telephone)\b/.test(descriptor)) {
          score = Math.max(score, 88);
        }

        if (/\b(address line 1|street address|address)\b/.test(wantedLabel) && /\b(address|street)\b/.test(descriptor)) {
          score = Math.max(score, 86);
        }

        if (/\bcity\b/.test(wantedLabel) && /\b(city|town|locality)\b/.test(descriptor)) {
          score = Math.max(score, 86);
        }

        if (/\b(state|province|region)\b/.test(wantedLabel) && /\b(state|province|region)\b/.test(descriptor)) {
          score = Math.max(score, 86);
        }

        if (/\bcountry\b/.test(wantedLabel) && /\bcountry\b/.test(descriptor)) {
          score = Math.max(score, 86);
        }

        if (/\b(degree name|major|field of study)\b/.test(wantedLabel) && /\b(degree|major|field of study|course)\b/.test(descriptor)) {
          score = Math.max(score, 84);
        }

        if (/\b(type of degree|degree type|education level)\b/.test(wantedLabel) && /\b(degree|education|level)\b/.test(descriptor)) {
          score = Math.max(score, 84);
        }

        if (/\b(university|college|school|institution)\b/.test(wantedLabel) && /\b(university|college|school|institution|institute)\b/.test(descriptor)) {
          score = Math.max(score, 86);
        }

        if (/\b(start date|from date)\b/.test(wantedLabel) && /\b(start|from|date)\b/.test(descriptor)) {
          score = Math.max(score, 84);
        }

        if (/\b(end date|to date|completion date|graduation date)\b/.test(wantedLabel) && /\b(end|to|completion|graduation|date)\b/.test(descriptor)) {
          score = Math.max(score, 84);
        }

        if (/\b(work experience|past working experience|professional experience)\b/.test(wantedLabel) && /\b(work|working|professional|experience)\b/.test(descriptor)) {
          score = Math.max(score, 86);
        }

        if (wantedType === "select" && control instanceof HTMLSelectElement) {
          score += 18;
        }

        if (wantedType && control instanceof HTMLInputElement && normalize(control.type) === normalize(wantedType)) {
          score += 12;
        }

        return score;
      }

      function labelledByText(control: Element) {
        const labelledBy = control.getAttribute("aria-labelledby");

        if (!labelledBy) {
          return "";
        }

        return labelledBy
          .split(/\s+/)
          .map((id) => getElementById(id)?.textContent ?? "")
          .join(" ");
      }

      function findLabelText(control: Element) {
        if (control.id) {
          const label = queryFirst(`label[for="${CSS.escape(control.id)}"]`, control);

          if (label?.textContent?.trim()) {
            return label.textContent.trim();
          }
        }

        return control.closest("label")?.textContent?.trim()
          || control.closest("fieldset")?.querySelector("legend")?.textContent?.trim()
          || "";
      }

      function findNearbyLabelText(control: Element) {
        let ancestor: Element | null = control.parentElement;

        for (let depth = 0; depth < 4 && ancestor; depth += 1) {
          const label = Array.from(ancestor.querySelectorAll("label, legend, h1, h2, h3, h4, [class*='label'], [class*='Label']"))
            .map((item) => clean(item.textContent ?? ""))
            .find((text) => text && text.length <= 140);

          if (label) {
            return label;
          }

          const previous = ancestor.previousElementSibling?.textContent?.trim();

          if (previous) {
            return previous;
          }

          ancestor = ancestor.parentElement;
        }

        return "";
      }

      function compactContainerText(control: Element) {
        const container = control.closest("label, fieldset, [role='group'], [class*='field'], [class*='input'], [class*='form'], section, article, div");
        const text = clean(container?.textContent ?? "");

        return text.length <= 220 ? text : "";
      }

      function clean(value: string | null | undefined) {
        return (value ?? "").replace(/\s+/g, " ").replace(/\*/g, " ").trim();
      }

      function normalize(value: string | null | undefined) {
        return clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      }

      function queryFirst(selector: string, control: Element) {
        const root = control.getRootNode();

        if (root instanceof Document || root instanceof ShadowRoot || root instanceof Element) {
          const match = root.querySelector(selector);

          if (match) {
            return match;
          }
        }

        for (const searchRoot of searchRoots) {
          const match = searchRoot.querySelector(selector);

          if (match) {
            return match;
          }
        }

        return null;
      }

      function getElementById(id: string) {
        for (const searchRoot of searchRoots) {
          if ("getElementById" in searchRoot && typeof searchRoot.getElementById === "function") {
            const match = searchRoot.getElementById(id);

            if (match) {
              return match;
            }
          } else {
            const match = searchRoot.querySelector(`#${CSS.escape(id)}`);

            if (match) {
              return match;
            }
          }
        }

        return null;
      }

      function getSearchRoots() {
        const roots: Array<Document | ShadowRoot> = [document];

        for (let index = 0; index < roots.length; index += 1) {
          const root = roots[index];
          const elements = Array.from(root.querySelectorAll("*")) as HTMLElement[];

          for (const element of elements) {
            if (element.shadowRoot) {
              roots.push(element.shadowRoot);
            }
          }
        }

        return roots;
      }
    }, requiredFields.map((field) => ({
      label: field.label,
      inputType: field.inputType,
      fieldId: field.fieldId
    }))).catch(() => []);

    missingLabels.push(...frameMissing);
  }

  return dedupeLabels(missingLabels);
}

function isLikelyRequiredAttemptedLabel(label: string) {
  const normalized = normalizeBrowserAgentLabel(label);

  if (/\b(country code|country region code|search by country region or code|search by country\/region or code|dial code|phone code)\b/.test(normalized)) {
    return false;
  }

  return /\b(address line 1|street address|country|state|province|city|zip|postal|email|phone|mobile|degree name|type of degree|degree type|university|college|school|institution|start date|end date|graduation date|work experience|past working experience)\b/.test(normalized)
    && !/\b(address line 2|middle name|preferred first|preferred last|preferred name)\b/.test(normalized);
}

async function cleanupEmptyWorkHistoryCardsIfNoProfileHistory(input: {
  page: Page;
  input: BrowserApplyInput;
  outstandingRequired: string[];
  workspacePath: string;
  stageIndex: number;
}) {
  if (profileHasWorkHistory(input.input)) {
    return false;
  }

  const blockerText = normalizeBrowserAgentLabel(input.outstandingRequired.join(" "));

  if (!/\b(title|company|from|to|start date|end date|work history|work experience|experience|employment)\b/.test(blockerText)) {
    return false;
  }

  const result = await input.page.evaluate(() => {
    const candidates = collectCandidateCards();
    let removed = 0;
    const removedTexts: string[] = [];

    for (const card of candidates) {
      if (removed > 2) {
        break;
      }

      const rawText = visibleText(card);
      const text = normalize(rawText);

      if (!looksLikeEmptyWorkHistoryCard(card, text)) {
        continue;
      }

      const action = Array.from(card.querySelectorAll("button, a, [role='button']"))
        .find((element): element is HTMLElement => {
          if (!(element instanceof HTMLElement) || !isVisible(element)) {
            return false;
          }

          const actionText = normalize(element.innerText || element.textContent || element.getAttribute("aria-label") || "");
          return /\b(cancel|remove|delete|discard|clear)\b/.test(actionText);
        });

      if (!action) {
        continue;
      }

      action.click();
      removed += 1;
      removedTexts.push(rawText.slice(0, 240));
    }

    return { removed, removedTexts };

    function collectCandidateCards() {
      const selectors = [
        "fieldset",
        "section",
        "article",
        "[role='group']",
        "[data-testid*='experience' i]",
        "[class*='experience' i]",
        "[class*='employment' i]",
        "[class*='work' i]"
      ].join(",");
      const roots = new Set<HTMLElement>();

      for (const element of Array.from(document.querySelectorAll(selectors))) {
        if (element instanceof HTMLElement && isVisible(element)) {
          roots.add(element);
        }
      }

      for (const label of Array.from(document.querySelectorAll("label"))) {
        const labelText = normalize(label.textContent ?? "");

        if (!/\b(title|company|from|to|start date|end date)\b/.test(labelText)) {
          continue;
        }

        const card = label.closest("fieldset, section, article, [role='group'], [data-testid], [class*='card' i], [class*='experience' i], [class*='employment' i]");

        if (card instanceof HTMLElement && isVisible(card)) {
          roots.add(card);
        }
      }

      return [...roots]
        .filter((element) => {
          const text = visibleText(element);
          return text.length > 20 && text.length < 2600;
        })
        .sort((left, right) => visibleText(left).length - visibleText(right).length);
    }

    function looksLikeEmptyWorkHistoryCard(card: HTMLElement, text: string) {
      const hasWorkContext = /\b(experience|employment|work history|work experience|professional experience)\b/.test(text);
      const hasWorkLabels = /\b(title|job title|position)\b/.test(text)
        && /\b(company|employer)\b/.test(text)
        && /\b(from|start date)\b/.test(text)
        && /\b(to|end date)\b/.test(text);
      const hasCurrentCheckbox = /\b(i currently work here|current position|currently work)\b/.test(text);

      if (!(hasWorkLabels || (hasWorkContext && hasCurrentCheckbox))) {
        return false;
      }

      const controls = Array.from(card.querySelectorAll("input:not([type='hidden']), textarea, select"))
        .filter((control): control is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement => {
          return (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement) && isVisible(control);
        });

      return !controls.some((control) => {
        if (control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type)) {
          return control.checked;
        }

        const value = control instanceof HTMLSelectElement
          ? (control.selectedOptions[0]?.textContent ?? control.value)
          : control.value;

        return Boolean(normalize(value).replace(/\b(select|select an option|choose|none selected)\b/g, "").trim());
      });
    }

    function visibleText(element: HTMLElement) {
      return (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
    }

    function isVisible(element: Element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
    }

    function normalize(value: string | null | undefined) {
      return (value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    }
  }).catch(() => ({ removed: 0, removedTexts: [] as string[] }));

  if (result.removed <= 0) {
    return false;
  }

  await input.page.waitForTimeout(350).catch(() => undefined);
  await writeBrowserDebug(input.workspacePath, "empty-work-history-cards-removed", {
    stageIndex: input.stageIndex,
    removed: result.removed,
    removedTexts: result.removedTexts
  });
  return true;
}

function profileHasWorkHistory(input: BrowserApplyInput) {
  const details = input.student?.completeProfile;

  return Boolean(
    details?.currentCompany
    || details?.currentTitle
    || (details?.totalExperienceYears ?? 0) > 0
    || (details?.employmentHistory?.length ?? 0) > 0
  );
}

function isStaleChoiceValidation(
  validationMessages: string[],
  answers: Array<{ label: string; value: string; inputType?: string }>
) {
  if (validationMessages.length === 0) {
    return false;
  }

  const choiceAnswers = answers.filter((answer) => answer.inputType === "radio" || answer.inputType === "checkbox");

  if (choiceAnswers.length === 0) {
    return false;
  }

  const validationText = normalizeAgentText(validationMessages.join(" "));

  if (!/\b(there are some errors|please correct|this field is required|required)\b/.test(validationText)) {
    return false;
  }

  if (/\b(invalid|email|phone|resume|cv|upload|file|location|city|country|format|characters|max|min)\b/.test(validationText)) {
    return false;
  }

  const choiceText = normalizeAgentText(choiceAnswers.map((answer) => `${answer.label} ${answer.value}`).join(" "));

  return validationMessages.length <= 2
    || choiceText.split(" ").some((token) => token.length > 5 && validationText.includes(token));
}

async function attemptRepairFieldFill(
  page: Page,
  field: BrowserFillField,
  context: {
    workspacePath: string;
    stageIndex: number;
    repairKind: string;
  }
) {
  const trace = shouldTraceRepairField(field);
  const beforeDebug = trace ? await collectLegacyFillFieldDebug(page, field) : undefined;
  const filled = await fillRepairFieldV2(page, field);
  const afterDebug = trace ? await collectLegacyFillFieldDebug(page, field) : undefined;

  if (trace) {
    await writeBrowserDebug(context.workspacePath, filled ? "repair-field-filled" : "repair-field-unfilled", {
      stageIndex: context.stageIndex,
      repairKind: context.repairKind,
      label: field.label,
      inputType: field.inputType,
      valuePreview: field.value?.slice(0, 80),
      beforeDebug,
      afterDebug
    });
  }

  return filled;
}

function shouldTraceRepairField(field: BrowserFillField) {
  const descriptor = normalizeKey(`${field.label} ${field.inputType ?? ""} ${field.value ?? ""}`);
  return field.inputType === "combobox"
    || /\b(city|location|country|state|province|region|residence|place of residence)\b/.test(descriptor);
}

function shouldRepairMissingField(field: BrowserFillField, missingRequiredLabels: string[]) {
  if (!field.value?.trim() || ["file", "radio", "checkbox"].includes(normalizeKey(field.inputType ?? ""))) {
    return false;
  }

  return missingRequiredLabels.some((missingLabel) => labelsReferToSameField(field.label, missingLabel));
}

function buildMissingProfileRepairFields(missingLabels: string[], input: BrowserApplyInput): BrowserFillField[] {
  const fields: BrowserFillField[] = [];

  for (const label of missingLabels) {
    const value = resolveProfileRepairValue(label, input);

    if (!value) {
      continue;
    }

    fields.push({
      label,
      value,
      required: true,
      inputType: inferRepairInputType(label),
      options: []
    });
  }

  return fields;
}

function resolveProfileRepairValue(label: string, input: BrowserApplyInput) {
  const normalized = normalizeBrowserAgentLabel(label);
  const prepared = new Map(input.fields.map((field) => [normalizeKey(field.label), field.value.trim()]).filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1])));
  const student = input.student;
  const details = student?.completeProfile;
  const nameParts = student?.fullName.trim().split(/\s+/).filter(Boolean) ?? [];

  if (isNonFieldRequiredLabel(label, input.job)) {
    return undefined;
  }

  if (/\bemail\b/.test(normalized)) {
    return student?.email ?? prepared.get("email") ?? prepared.get("email address");
  }

  if (/\bfirst name|given name\b/.test(normalized)) {
    return prepared.get("first name") ?? prepared.get("legal first name") ?? nameParts[0];
  }

  if (/\blast name|surname|family name\b/.test(normalized)) {
    return prepared.get("last name") ?? prepared.get("legal last name") ?? (nameParts.length > 1 ? nameParts.slice(1).join(" ") : nameParts[0]);
  }

  if (/\bphone|mobile|telephone|contact number\b/.test(normalized)) {
    return details?.phone ?? prepared.get("phone number") ?? prepared.get("phone") ?? prepared.get("mobile");
  }

  if (/\bcountry\b/.test(normalized) && !/\bcity\b/.test(normalized)) {
    return details?.country
      ?? prepared.get("country")
      ?? prepared.get("current country")
      ?? prepared.get("location country")
      ?? (details?.phone?.replace(/\D+/g, "").startsWith("91") ? "India" : undefined)
      ?? "India";
  }

  if (/\bcity|location|place of residence|residence\b/.test(normalized)) {
    return [
      details?.city ?? prepared.get("city") ?? prepared.get("location city") ?? prepared.get("current location") ?? input.student?.preferredLocations[0],
      details?.state ?? prepared.get("state"),
      details?.country ?? prepared.get("country")
    ].filter(Boolean).join(", ");
  }

  if (/\blinkedin|linked in\b/.test(normalized)) {
    return details?.linkedInUrl ?? prepared.get("linkedin") ?? prepared.get("linkedin url");
  }

  if (/\bwebsite|portfolio|url\b/.test(normalized)) {
    return details?.portfolioUrl ?? details?.websiteUrl ?? prepared.get("portfolio") ?? prepared.get("website");
  }

  if (/\bcover letter|message|hiring team|additional information|why\b/.test(normalized)) {
    return [
      `I am excited to apply for the ${input.job.title} role at ${input.job.company}.`,
      student?.bio ?? `My background in ${student?.degree ?? "engineering"} and skills in ${(student?.skills ?? []).slice(0, 5).join(", ") || "software development"} align well with this opportunity.`,
      "I would welcome the opportunity to contribute with ownership, learning agility, and practical problem-solving."
    ].join(" ");
  }

  return prepared.get(normalized);
}

function inferRepairInputType(label: string) {
  const normalized = normalizeBrowserAgentLabel(label);

  if (/\bphone|mobile|telephone|contact number\b/.test(normalized)) {
    return "tel";
  }

  if (/\bcover letter|message|hiring team|additional information|why\b/.test(normalized)) {
    return "textarea";
  }

  if (/\bcity|location|place of residence|residence\b/.test(normalized)) {
    return "autocomplete";
  }

  if (/\bcountry\b/.test(normalized)) {
    return "autocomplete";
  }

  if (/\bemail\b/.test(normalized)) {
    return "email";
  }

  return "text";
}

function dedupeRepairFields(fields: BrowserFillField[]) {
  const byKey = new Map<string, BrowserFillField>();

  for (const field of fields) {
    const key = `${inferRepairIntent(normalizeBrowserAgentLabel(field.label)) ?? normalizeBrowserAgentLabel(field.label)}:${normalizeKey(field.value)}`;
    const existing = byKey.get(key);

    if (!existing || field.label.length < existing.label.length) {
      byKey.set(key, field);
    }
  }

  return [...byKey.values()];
}

function pruneNonActionableRequiredLabels(labels: string[], job: BrowserApplyInput["job"]) {
  return labels.filter((label) => !isNonFieldRequiredLabel(label, job));
}

function isNonFieldRequiredLabel(label: string, job: BrowserApplyInput["job"]) {
  const normalized = normalizeBrowserAgentLabel(label);

  if (!normalized) {
    return true;
  }

  const jobTitle = normalizeBrowserAgentLabel(job.title);
  const company = normalizeBrowserAgentLabel(job.company);

  return normalized === jobTitle
    || normalized === company
    || /\b(country code|country region code|search by country region or code|search by country\/region or code|dial code|phone code)\b/.test(normalized)
    || /^(facebook|x fka twitter|twitter|website|personal website|portfolio website|github|instagram)$/.test(normalized)
    || /\b(facebook|x fka twitter|twitter)\b/.test(normalized)
    || /^(easy apply|personal information|experience|education|your profiles|resume|privacy notice|imprint)$/.test(normalized);
}

function labelsReferToSameField(left: string, right: string) {
  const leftKey = normalizeBrowserAgentLabel(left);
  const rightKey = normalizeBrowserAgentLabel(right);

  if (!leftKey || !rightKey) {
    return false;
  }

  if (leftKey === rightKey || leftKey.includes(rightKey) || rightKey.includes(leftKey)) {
    return true;
  }

  const leftIntent = inferRepairIntent(leftKey);
  const rightIntent = inferRepairIntent(rightKey);

  return Boolean(leftIntent && rightIntent && leftIntent === rightIntent);
}

function inferRepairIntent(label: string) {
  if (/\bemail\b/.test(label) && /\b(confirm|verify|retype|repeat|again)\b/.test(label)) {
    return "confirm_email";
  }

  if (/\bfirst name|given name\b/.test(label)) return "first_name";
  if (/\blast name|surname|family name\b/.test(label)) return "last_name";
  if (/\bemail\b/.test(label)) return "email";
  if (/\bphone|mobile|telephone|contact number\b/.test(label)) return "phone";
  if (/\bcity|location|place of residence|residence\b/.test(label)) return "city";
  if (/\bcover letter|message|hiring team|additional information\b/.test(label)) return "message";
  if (/\blinkedin|github|portfolio|website|url\b/.test(label)) return "profile_url";
  return undefined;
}

function normalizeAgentText(value: string) {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeBrowserAgentLabel(label: string) {
  return normalizeKey(label.replace(/\bselect an option\b/gi, " ").replace(/\*/g, " "));
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

    const visibleFields = await discoverVisibleFields(activePage).catch(() => []);
    const observation = await observeBrowserPage(activePage, visibleFields).catch(() => undefined);
    const validationMessages = await getVisibleValidationMessages(activePage).catch(() => []);
    const looksTransient = !observation
      || isTransientBlankObservation(observation)
      || validationMessages.some((message) => /loading|please wait|processing|uploading/i.test(message))
      || /loading|please wait|processing|uploading/i.test(observation.pageText);

    if (looksTransient) {
      await writeBrowserDebug(input.workspacePath, "manual-stage-progress-transient", {
        stageIndex: input.stageIndex,
        url: activePage.url(),
        validationMessages
      });
      continue;
    }

    const protectedCheckpoint = await detectProtectedCheckpoint(activePage);

    if (protectedCheckpoint.blocked) {
      await writeBrowserDebug(input.workspacePath, "manual-stage-protected-checkpoint", {
        stageIndex: input.stageIndex,
        url: activePage.url(),
        kind: protectedCheckpoint.kind,
        reason: protectedCheckpoint.reason
      });
      await updateLiveBot(activePage, {
        step: `Stage ${input.stageIndex + 1}`,
        mood: "waiting",
        message: protectedCheckpoint.reason ?? "A protected login or verification step is active. Complete it manually, then use the GradLaunch continue control."
      });
      return {
        resumed: false,
        activePage
      };
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
        const message = buildLockedLoggedProfileMessage();

        if (shouldUseLoggedProfileCloneOnLock()) {
          const clone = await prepareLoggedRuntimeProfile(loggedProfileDir);
          const cloneLocked = await isBrowserProfileLocked(clone.profileDir, { clearStaleGradLaunchLock: true });

          if (cloneLocked) {
            const cloneMessage = `The controlled runtime copy of the logged Chrome profile at ${clone.profileDir} is already open but cannot be attached on ${resolveLoggedChromeCdpHint()}. Close the old GradLaunch Chrome window and retry.`;

            if (shouldRequireLoggedBrowser()) {
              throw new Error(cloneMessage);
            }

            console.warn(`[GradLaunch][Browser] ${cloneMessage} Falling back to managed profile.`);
          } else {
            try {
              const context = await chromium.launchPersistentContext(clone.profileDir, {
                ...launchOptions,
                args: [
                  ...launchOptions.args,
                  `--profile-directory=${clone.profileName}`,
                  `--remote-debugging-port=${resolveLoggedChromeDebugPort()}`
                ],
                viewport: { width: 1280, height: 900 }
              });

              return {
                browser: undefined,
                context,
                keepContextOpen: true,
                attachedToExistingBrowser: false,
                launchMode: "logged_profile_clone" satisfies BrowserLaunchMode
              };
            } catch (error) {
              const cloneMessage = error instanceof Error ? error.message : String(error);

              if (shouldRequireLoggedBrowser()) {
                throw new Error(
                  `GradLaunch could not launch the controlled runtime copy of the logged profile at ${clone.profileDir}. ${cloneMessage}`
                );
              }

              console.warn(
                `[GradLaunch][Browser] Could not launch logged runtime profile at ${clone.profileDir}; falling back to managed profile. ${cloneMessage}`
              );
            }
          }
        }

        if (shouldRequireLoggedBrowser()) {
          throw new Error(message);
        }

        if (!shouldAllowManagedFallbackOnLockedLoggedProfile()) {
          throw new Error(message);
        }

        console.warn(`[GradLaunch][Browser] ${message} Falling back to managed persistent profile because BROWSER_ALLOW_MANAGED_FALLBACK_ON_LOCK=true.`);
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
            keepContextOpen: true,
            attachedToExistingBrowser: false,
            launchMode: "logged_profile" satisfies BrowserLaunchMode
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);

          console.warn(
            `[GradLaunch][Browser] Could not use logged Chrome profile at ${loggedProfileDir}; falling back to managed profile. ${message}`
          );
        }
      }
    }
  }

  if (shouldPreferLoggedBrowser() && shouldRequireLoggedBrowser()) {
    throw new Error("GradLaunch is configured to require a logged Chrome profile, but no usable logged profile could be opened or attached. Run `npm run browser:prepare-logged-profile`, or set `BROWSER_REQUIRE_LOGGED_PROFILE=false` to use manual login handoff.");
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

async function waitForLoginConfirmation(input: HandoffRequest & { sourceUrl: string }) {
  const timeoutMs = Number(process.env.BROWSER_LOGIN_HANDOFF_TIMEOUT_MS ?? process.env.BROWSER_HANDOFF_TIMEOUT_MS ?? 1800000);
  const pollMs = Number(process.env.BROWSER_HANDOFF_POLL_MS ?? 1200);
  const startedAt = Date.now();
  let activePage = input.page;
  let lastBotStateKey = "";
  const pausedLoginMessage = `${input.reason} GradLaunch is fully paused and will not resume until you click this button.`;

  await maybeKeepBrowserOpen(input.context);
  await clearUserContinueRequest(activePage);
  await showLoginHandoffBot(activePage, input.stageIndex, pausedLoginMessage, "I am logged in, continue");
  lastBotStateKey = buildLoginHandoffBotStateKey(activePage, pausedLoginMessage, "I am logged in, continue");
  await saveScreenshot(activePage, input.workspacePath, input.screenshots, "browser-login-needed.png");
  notePlannerHandoff(input.planner, input.reason, activePage, input.stageIndex, "login");
  await writeBrowserDebug(input.workspacePath, "login-confirmation-wait-start", {
    stageIndex: input.stageIndex,
    currentUrl: activePage.url(),
    sourceUrl: input.sourceUrl
  });

  while (Date.now() - startedAt < timeoutMs) {
    if (!hasOpenPage(input.context)) {
      return {
        resolved: false,
        activePage
      };
    }

    await activePage.waitForTimeout(pollMs).catch(() => undefined);
    activePage = await getLoginHandoffPage(input.context, activePage, input.sourceUrl);

    if (await didUserRequestStop(activePage)) {
      return {
        resolved: false,
        activePage
      };
    }

    const confirmed = await consumeUserContinueConfirmation(activePage);

    let readiness = await readApplicationReadiness(activePage).catch(() => undefined);
    const readyMessage = readiness?.ready
      ? "Login looks complete and the application form is visible. Click Continue filling and I will resume from this exact page."
      : pausedLoginMessage;
    const readyLabel = readiness?.ready ? "Continue filling" : "I am logged in, continue";
    const botStateKey = buildLoginHandoffBotStateKey(activePage, readyMessage, readyLabel);
    const botMounted = await isLiveBotMounted(activePage);

    if (!botMounted || botStateKey !== lastBotStateKey) {
      await showLoginHandoffBot(activePage, input.stageIndex, readyMessage, readyLabel);
      lastBotStateKey = botStateKey;
      await writeBrowserDebug(input.workspacePath, botMounted ? "login-handoff-bot-updated" : "login-handoff-bot-reattached", {
        stageIndex: input.stageIndex,
        currentUrl: activePage.url(),
        pageState: readiness?.pageState,
        visibleFieldCount: readiness?.visibleFieldCount
      });
    }

    if (!confirmed) {
      continue;
    }

    const continuationReadiness = await verifyLoginContinuationReady({
      context: input.context,
      page: activePage,
      sourceUrl: input.sourceUrl,
      workspacePath: input.workspacePath
    });
    activePage = continuationReadiness.activePage;
    await writeBrowserDebug(input.workspacePath, continuationReadiness.ready ? "login-confirmation-verified" : "login-confirmation-not-ready", {
      stageIndex: input.stageIndex,
      currentUrl: activePage.url(),
      reason: continuationReadiness.reason,
      pageState: continuationReadiness.pageState,
      visibleFieldCount: continuationReadiness.visibleFieldCount
    });

    if (!continuationReadiness.ready) {
      await showLoginHandoffBot(activePage, input.stageIndex, continuationReadiness.reason, "Check again");
      lastBotStateKey = buildLoginHandoffBotStateKey(activePage, continuationReadiness.reason, "Check again");
      continue;
    }

    markPlannerTask(input.planner, "authenticate_if_needed", "running", "Login confirmed and the application page is visible. Resuming autonomous execution.");
    setPlannerStatus(input.planner, "running", "Login confirmed; GradLaunch is resuming from the current page.");
    await updateLiveBot(activePage, {
      step: `Stage ${input.stageIndex + 1}`,
      mood: "thinking",
      message: "Login confirmed. I can see the application flow now, so I am re-planning before filling."
    });
    return {
      resolved: true,
      activePage
    };
  }

  setPlannerStatus(input.planner, "handoff_required", "Planner paused because login still needs user confirmation.");
  await writeBrowserDebug(input.workspacePath, "login-confirmation-timeout", {
    stageIndex: input.stageIndex,
    currentUrl: activePage.url(),
    timeoutMs
  });
  return {
    resolved: false,
    activePage
  };
}

async function verifyLoginContinuationReady(input: {
  context: BrowserContext;
  page: Page;
  sourceUrl: string;
  workspacePath: string;
}) {
  let activePage = input.page;
  const readyPage = await findReadyApplicationPage(input.context);

  if (readyPage) {
    return readyPage;
  }

  let readiness = await readApplicationReadiness(activePage);

  if (readiness.ready || readiness.blocked) {
    return {
      ...readiness,
      activePage
    };
  }

  await writeBrowserDebug(input.workspacePath, "login-confirmation-reopen-source-url", {
    currentUrl: activePage.url(),
    sourceUrl: input.sourceUrl,
    reason: readiness.reason
  });
  await navigateToJobPage(activePage, input.sourceUrl, input.workspacePath).catch((error) => {
    void writeBrowserDebug(input.workspacePath, "login-confirmation-reopen-source-url-failed", {
      currentUrl: activePage.url(),
      sourceUrl: input.sourceUrl,
      error: error instanceof Error ? error.message : String(error)
    });
  });
  readiness = await readApplicationReadiness(activePage);

  return {
    ...readiness,
    activePage
  };
}

async function showLoginHandoffBot(page: Page, stageIndex: number, message: string, label: string) {
  await updateLiveBot(page, {
    step: `Stage ${stageIndex + 1}`,
    mood: "waiting",
    message,
    action: {
      kind: "confirm_continue",
      label
    }
  });
}

function buildLoginHandoffBotStateKey(page: Page, message: string, label: string) {
  return `${page.url()}::${page.isClosed() ? "closed" : "open"}::${message}::${label}`;
}

async function getLoginHandoffPage(context: BrowserContext, fallbackPage: Page, sourceUrl: string) {
  const readyApplicationPage = await findReadyApplicationPage(context).catch(() => undefined);

  if (readyApplicationPage?.activePage) {
    return readyApplicationPage.activePage;
  }

  const pages = context.pages().filter((page) => !page.isClosed());
  const candidates = pages.length > 0 ? pages : [fallbackPage];
  const scored = candidates.map((page, index) => ({
    page,
    score: scoreLoginHandoffPage(page.url(), sourceUrl, page === fallbackPage, index)
  }));
  const best = scored.sort((left, right) => right.score - left.score)[0]?.page ?? fallbackPage;

  best.setDefaultTimeout(Number(process.env.BROWSER_STEP_TIMEOUT_MS ?? 2500));
  await best.bringToFront().catch(() => undefined);
  return best;
}

function scoreLoginHandoffPage(url: string, sourceUrl: string, isFallback: boolean, index: number) {
  let score = index;

  if (isGoogleAuthUrl(url)) {
    score += 1000;
  }

  if (looksLikeLoginUrl(url)) {
    score += 850;
  }

  if (sameHostname(url, sourceUrl)) {
    score += 500;
  }

  if (!isBlankBrowserUrl(url)) {
    score += 100;
  }

  if (isFallback) {
    score += 25;
  }

  return score;
}

async function findReadyApplicationPage(context: BrowserContext) {
  const pages = context.pages().filter((page) => !page.isClosed()).reverse();

  for (const page of pages) {
    const readiness = await readApplicationReadiness(page).catch(() => undefined);

    if (readiness?.ready) {
      await page.bringToFront().catch(() => undefined);
      return {
        ...readiness,
        activePage: page
      };
    }
  }

  return undefined;
}

async function readApplicationReadiness(page: Page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 4000 }).catch(() => undefined);
  await page.waitForTimeout(700).catch(() => undefined);

  if (isBlankBrowserUrl(page.url())) {
    return {
      ready: false,
      blocked: false,
      reason: "The tab is still blank. Open or reload the job page, finish login, then click Check again.",
      visibleFieldCount: 0
    };
  }

  if (isGoogleAuthUrl(page.url())) {
    return {
      ready: false,
      blocked: true,
      reason: "Google login is still open. Finish choosing the account/password step, then click Check again.",
      pageState: "login",
      visibleFieldCount: 0
    };
  }

  const checkpoint = await detectProtectedCheckpoint(page);

  if (checkpoint.blocked) {
    return {
      ready: false,
      blocked: true,
      reason: checkpoint.reason ?? "The page still looks like a protected login or verification gate. Complete it, then click Check again.",
      pageState: checkpoint.kind ?? "login",
      visibleFieldCount: 0
    };
  }

  const stageSnapshot = await collectStageSnapshot(page).catch(() => undefined);
  const visibleFields = stageSnapshot?.visibleFields ?? [];
  const observation = stageSnapshot?.observation;
  const pageState = observation?.pageState;

  if (!observation) {
    return {
      ready: false,
      blocked: false,
      reason: "Login may be complete, but GradLaunch cannot read the application page yet. Keep the job page open and click Check again.",
      visibleFieldCount: visibleFields.length
    };
  }

  if (pageState === "login" || pageState === "account_gate") {
    return {
      ready: false,
      blocked: true,
      reason: "The portal still looks like a login/account page. Finish login in this same window, then click Check again.",
      pageState,
      visibleFieldCount: visibleFields.length
    };
  }

  if (visibleFields.length > 0) {
    return {
      ready: true,
      blocked: false,
      reason: "Visible application fields were found.",
      pageState,
      visibleFieldCount: visibleFields.length
    };
  }

  if (pageState === "resume_upload" && stageSnapshot?.uploadVisible) {
    return {
      ready: true,
      blocked: false,
      reason: "A resume upload step is visible.",
      pageState,
      visibleFieldCount: visibleFields.length
    };
  }

  if (pageState === "review" || pageState === "submit" || pageState === "questionnaire" || pageState === "consent") {
    return {
      ready: true,
      blocked: false,
      reason: `The application flow is visible at the ${pageState} stage.`,
      pageState,
      visibleFieldCount: visibleFields.length
    };
  }

  if (await hasFinalSubmitControl(page)) {
    return {
      ready: true,
      blocked: false,
      reason: "A final submit/review control is visible.",
      pageState,
      visibleFieldCount: visibleFields.length
    };
  }

  if (observation.controls.some((control) => isApplicationProgressControl(control.text || control.label))) {
    return {
      ready: true,
      blocked: false,
      reason: "An application continue/apply control is visible.",
      pageState,
      visibleFieldCount: visibleFields.length
    };
  }

  return {
    ready: false,
    blocked: false,
    reason: "Login no longer appears blocked, but the job application form is not visible yet. Reopen the job posting in this window, then click Check again.",
    pageState,
    visibleFieldCount: visibleFields.length
  };
}

function isApplicationProgressControl(value: string | undefined) {
  const normalized = (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  if (!normalized) {
    return false;
  }

  if (/\b(sign in|signin|log in|login|google|email|password|forgot|create account|register|sign up)\b/.test(normalized)) {
    return false;
  }

  return /\b(apply|start application|continue application|continue|next|proceed|review application|save and continue)\b/.test(normalized);
}

async function waitForHumanIntervention(input: HandoffRequest) {
  const timeoutMs = Number(process.env.BROWSER_HANDOFF_TIMEOUT_MS ?? 180000);
  const pollMs = Number(process.env.BROWSER_HANDOFF_POLL_MS ?? 1200);
  const startedAt = Date.now();
  let activePage = input.page;
  let lastBotTarget = "";

  await maybeKeepBrowserOpen(input.context);
  await updateLiveBot(activePage, {
    step: `Stage ${input.stageIndex + 1}`,
    mood: "waiting",
    message: input.reason
  });
  lastBotTarget = buildHandoffBotTarget(activePage, input.reason);
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
    const botTarget = buildHandoffBotTarget(activePage, input.reason);

    if (botTarget !== lastBotTarget || !await isLiveBotMounted(activePage)) {
      await updateLiveBot(activePage, {
        step: `Stage ${input.stageIndex + 1}`,
        mood: "waiting",
        message: input.reason
      });
      lastBotTarget = botTarget;
    }

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

      const stillEmptyWatchedFields = await getStillEmptyAttemptedRequiredLabels(activePage, input.watchFields.map((label) => ({
        label,
        value: "",
        required: true
      })));

      if (stillEmptyWatchedFields.length > 0) {
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

function buildHandoffBotTarget(page: Page, message: string) {
  return `${page.url()}::${page.isClosed() ? "closed" : "open"}::${message}`;
}

async function saveScreenshot(page: Page, workspacePath: string, screenshots: string[], filename: string) {
  if (process.env.BROWSER_SAVE_SCREENSHOTS !== "true") {
    return;
  }

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

function shouldUseLoggedProfileCloneOnLock() {
  return process.env.BROWSER_ALLOW_LOGGED_PROFILE_CLONE_ON_LOCK === "true";
}

function shouldAllowManagedFallbackOnLockedLoggedProfile() {
  return process.env.BROWSER_ALLOW_MANAGED_FALLBACK_ON_LOCK === "true";
}

async function prepareLoggedRuntimeProfile(sourceProfileDir: string) {
  const profileName = await resolveLoggedChromeProfileName(sourceProfileDir);
  const runtimeProfileDir = join(getBrowserWorkspaceStorageDir(), "logged-runtime-profile");
  const runtimeProfileExists = await pathExists(join(runtimeProfileDir, "Local State"))
    && await pathExists(join(runtimeProfileDir, profileName));
  const refreshRequested = process.env.BROWSER_REFRESH_LOGGED_RUNTIME_PROFILE === "true";

  if (!runtimeProfileExists || refreshRequested) {
    await rm(runtimeProfileDir, { recursive: true, force: true });
    await mkdir(runtimeProfileDir, { recursive: true });
    await copyIfPresent(join(sourceProfileDir, "Local State"), join(runtimeProfileDir, "Local State"));
    await copyIfPresent(join(sourceProfileDir, "First Run"), join(runtimeProfileDir, "First Run"));
    await cp(join(sourceProfileDir, profileName), join(runtimeProfileDir, profileName), {
      recursive: true,
      force: true,
      filter: shouldCopyChromeProfilePath(join(sourceProfileDir, profileName))
    });
  }

  await clearBrowserProfileSingletonFiles(runtimeProfileDir);
  return {
    profileDir: runtimeProfileDir,
    profileName
  };
}

async function copyIfPresent(source: string, dest: string) {
  try {
    await cp(source, dest, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function shouldCopyChromeProfilePath(sourceProfileDir: string) {
  const ignoredNames = new Set([
    "Cache",
    "Code Cache",
    "Crashpad",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "GPUCache",
    "GrShaderCache",
    "GraphiteDawnCache",
    "ShaderCache"
  ]);

  return (source: string) => {
    const name = basename(source);

    if (name.startsWith("Singleton")) {
      return false;
    }

    if (ignoredNames.has(name)) {
      return false;
    }

    const parts = relative(sourceProfileDir, source).split(sep);
    return !parts.some((part) => ignoredNames.has(part));
  };
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

function buildLockedLoggedProfileMessage() {
  return `The controlled logged Chrome profile is already open, but GradLaunch cannot safely control it because remote debugging is not available on ${resolveLoggedChromeCdpHint()}. Close that Chrome window and retry, or launch it with --remote-debugging-port=${resolveLoggedChromeDebugPort()}. GradLaunch will not clone cookies or attach to an uncontrolled browser.`;
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
