import { request as httpRequest } from "node:http";
import { constants as fsConstants } from "node:fs";
import { access, appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentHandoffKind,
  BrowserApplyReceipt,
  FilledField,
  Job,
  PlannerActionKind,
  PlannerCheckpoint,
  PlannerDecision,
  PlannerDecisionSource,
  PlannerStageOutcome,
  PlannerStageSnapshot,
  PlannerTask,
  ResumeRecord,
  StudentMemory,
  StudentProfile
} from "@gradlaunch/shared";
import { chromium, type Browser, type BrowserContext, type Frame, type Locator, type Page } from "playwright-core";
import { getBrowserWorkspaceStorageDir, getManagedBrowserProfileDir } from "../config/storage";
import { nowIso } from "../lib/time";
import { BrowserAgentEngine } from "./browser-agent/engine";

type BrowserApplyInput = {
  studentId?: string;
  applicationId?: string;
  runId?: string;
  executionSessionId?: string;
  job: Job;
  fields: FilledField[];
  workspacePath?: string;
  resume?: ResumeRecord;
  student?: StudentProfile;
  memory?: StudentMemory;
  submit: boolean;
  planner?: PlannerCheckpoint;
};

type BrowserAvailability = {
  available: boolean;
  chromePath?: string;
  message: string;
};

type BrowserAgentStep = {
  label: string;
  detail: string;
  state: "done" | "running" | "queued" | "attention";
};

type VisibleField = {
  id: string;
  label: string;
  required: boolean;
  tagName: string;
  inputType: string;
  options: string[];
  context: string;
};

type BrowserFillField = FilledField & {
  fieldId?: string;
  inputType?: string;
  options?: string[];
};

type MultiStageFillResult = {
  activePage: Page;
  filledLabels: string[];
  skippedLabels: string[];
  blockedReason?: string;
  handoffRequired?: boolean;
  stageCount: number;
};

type DynamicFillPlan = {
  fields: BrowserFillField[];
  unresolvedRequiredLabels: string[];
  llmSummary?: string;
  llmAnswerCount: number;
  nextActionAfterFill?: "click_next" | "pause" | "submit_gate";
};

type LlmStageFillAnswer = {
  fieldId: string;
  label: string;
  value: string;
  confidence: number;
  reason?: string;
};

type LlmStageFillPlan = {
  answers: LlmStageFillAnswer[];
  needsUser: Array<{
    fieldId?: string;
    label: string;
    reason: string;
  }>;
  nextActionAfterFill?: "click_next" | "pause" | "submit_gate";
  summary?: string;
};

type StageNavigationResult = {
  activePage: Page;
  moved: boolean;
  blockedReason?: string;
};

type ObservedControl = {
  id: string;
  text: string;
  tagName: string;
  role: string;
  inputType: string;
  label: string;
  disabled: boolean;
};

type BrowserPageState =
  | "start"
  | "resume_upload"
  | "login"
  | "questionnaire"
  | "consent"
  | "review"
  | "submit"
  | "account_gate"
  | "empty"
  | "unknown";

type BrowserFieldGroup = {
  label: string;
  fieldIds: string[];
  fieldLabels: string[];
  required: boolean;
};

type AtsAdapterHint = {
  id: string;
  label: string;
};

type BrowserAgentObservation = {
  url: string;
  title: string;
  pageText: string;
  visibleFields: VisibleField[];
  controls: ObservedControl[];
  pageState: BrowserPageState;
  validationMessages: string[];
  groupedFields: BrowserFieldGroup[];
  adapter?: AtsAdapterHint;
};

type BrowserAgentAction =
  | { kind: "fill"; reason: string; source: PlannerDecisionSource }
  | { kind: "click"; controlId: string; reason: string; source: PlannerDecisionSource }
  | { kind: "upload_resume"; controlId?: string; reason: string; source: PlannerDecisionSource }
  | { kind: "ask_user"; fields: string[]; reason: string; source: PlannerDecisionSource }
  | { kind: "stop"; reason: string; source: PlannerDecisionSource };

type AtsCredentials = {
  username?: string;
  password?: string;
};

type AccountGateResult = {
  handled: boolean;
  activePage: Page;
  filledLabels: string[];
  blockedReason?: string;
};

type HumanInterventionWaitResult = {
  resolved: boolean;
  activePage: Page;
};

type ProtectedCheckpointDetection = {
  blocked: boolean;
  kind?: "captcha" | "login" | "otp" | "verification";
  reason?: string;
};

const defaultChromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const transientLabels = ["resume context", "primary skills"];
export class BrowserApplyService {
  private readonly engine = new BrowserAgentEngine();

  async getAvailability(): Promise<BrowserAvailability> {
    return this.engine.getAvailability();
  }

  async apply(input: BrowserApplyInput): Promise<BrowserApplyReceipt> {
    return this.engine.apply(input);
  }
}

async function fillTextField(page: Page, field: BrowserFillField) {
  const label = field.label.trim();
  const value = field.value.trim();

  if (!label || !value) {
    return false;
  }

  const aliases = getFieldAliases(label);
  const quickFilled = await fillWithPlaywrightLocators(page, aliases, value);

  if (quickFilled) {
    return true;
  }

  for (const frame of page.frames()) {
    const filled = await fillByScoredDomMatch(frame, aliases, value);

    if (filled) {
      return true;
    }
  }

  return false;
}

async function fillFormField(page: Page, field: BrowserFillField) {
  const filledByAgentTarget = await fillByAgentFieldId(page, field);

  if (filledByAgentTarget) {
    return true;
  }

  if (field.inputType === "radio" || field.inputType === "checkbox") {
    return await fillChoiceField(page, field);
  }

  return await fillTextField(page, field) || await fillChoiceField(page, field);
}

async function fillByAgentFieldId(page: Page, field: BrowserFillField) {
  if (!field.fieldId || !field.value.trim()) {
    return false;
  }

  for (const frame of page.frames()) {
    const filled = await frame.evaluate(
      ({ fieldId, fieldValue }) => {
        const control = findControl(fieldId);

        if (
          !control
          || control instanceof HTMLInputElement && ["hidden", "file", "submit", "button"].includes(control.type)
          || "disabled" in control && control.disabled
        ) {
          return false;
        }

        const normalizedValue = normalize(fieldValue);
        (control as HTMLElement).scrollIntoView?.({ block: "center", inline: "center" });

        if (control instanceof HTMLSelectElement) {
          const option = Array.from(control.options).find((item) => normalize(item.text) === normalizedValue || normalize(item.value) === normalizedValue)
            ?? Array.from(control.options).find((item) => normalize(item.text).includes(normalizedValue) || normalizedValue.includes(normalize(item.text)));

          if (!option) {
            return false;
          }

          control.value = option.value;
          dispatch(control);
          return true;
        }

        if (control instanceof HTMLInputElement && ["radio", "checkbox"].includes(control.type)) {
          const group = control.name
            ? getSearchRoots().flatMap((root) => Array.from(root.querySelectorAll(`input[name="${CSS.escape(control.name)}"]`))) as HTMLInputElement[]
            : [control];
          const target = group.find((item) => normalize(getOptionText(item)) === normalizedValue || normalize(item.value) === normalizedValue)
            ?? group.find((item) => normalize(getOptionText(item)).includes(normalizedValue) || normalizedValue.includes(normalize(getOptionText(item))))
            ?? (isPositive(normalizedValue) ? control : undefined);

          if (!target) {
            return false;
          }

          if (!target.checked) {
            target.click();
          }

          dispatch(target);
          return true;
        }

        control.focus();
        clearValue(control);
        setNativeValue(control, fieldValue);
        dispatch(control);
        commitAutocomplete(control, fieldValue);
        return normalize(control.value) === normalizedValue || normalize(control.value).includes(normalizedValue);

        function normalize(value: string) {
          return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        }

        function dispatch(element: Element) {
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          element.dispatchEvent(new Event("blur", { bubbles: true }));
        }

        function clearValue(control: HTMLInputElement | HTMLTextAreaElement) {
          setNativeValue(control, "");
          control.dispatchEvent(new Event("input", { bubbles: true }));
        }

        function getOptionText(input: HTMLInputElement) {
          if (input.id) {
            const label = queryFirst(`label[for="${CSS.escape(input.id)}"]`, input);

            if (label?.textContent?.trim()) {
              return label.textContent.trim();
            }
          }

          return input.closest("label")?.textContent?.trim() || input.parentElement?.textContent?.trim() || input.value;
        }

        function isPositive(value: string) {
          return /^(yes|true|agree|accept|consent|confirm|i agree)$/.test(value);
        }

        function setNativeValue(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
          const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

          if (descriptor?.set) {
            descriptor.set.call(control, value);
          } else {
            control.value = value;
          }
        }

        function commitAutocomplete(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
          if (!(control instanceof HTMLInputElement)) {
            return;
          }

          const descriptor = normalize([
            control.getAttribute("role") ?? "",
            control.getAttribute("aria-autocomplete") ?? "",
            control.getAttribute("autocomplete") ?? "",
            control.getAttribute("list") ?? "",
            control.getAttribute("name") ?? "",
            control.getAttribute("id") ?? "",
            control.getAttribute("placeholder") ?? ""
          ].join(" "));

          if (!/\b(combobox|autocomplete|search|city|location)\b/.test(descriptor)) {
            return;
          }

          setNativeValue(control, value);
          control.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true }));
          control.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowDown", code: "ArrowDown", bubbles: true }));
          control.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
          control.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
          control.dispatchEvent(new Event("change", { bubbles: true }));
        }

        function findControl(targetFieldId: string) {
          for (const root of getSearchRoots()) {
            const match = root.querySelector(`[data-gradlaunch-field-id="${CSS.escape(targetFieldId)}"]`);

            if (match instanceof HTMLInputElement || match instanceof HTMLTextAreaElement || match instanceof HTMLSelectElement) {
              return match;
            }
          }

          return null;
        }

        function queryFirst(selector: string, control: Element) {
          const root = control.getRootNode();

          if (root instanceof Document || root instanceof ShadowRoot || root instanceof Element) {
            const withinRoot = root.querySelector(selector);

            if (withinRoot) {
              return withinRoot;
            }
          }

          for (const searchRoot of getSearchRoots()) {
            const match = searchRoot.querySelector(selector);

            if (match) {
              return match;
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
      },
      { fieldId: field.fieldId, fieldValue: field.value }
    ).catch(() => false);

    if (filled) {
      return true;
    }
  }

  return false;
}

async function fillChoiceField(page: Page, field: BrowserFillField) {
  const aliases = getFieldAliases(field.label).map(normalizeKey);
  const value = field.value.trim();

  if (!value) {
    return false;
  }

  for (const frame of page.frames()) {
    const filled = await frame.evaluate(
      ({ labelAliases, fieldValue }) => {
        const normalizedValue = normalize(fieldValue);
        const controls = getSearchRoots().flatMap((root) => Array.from(root.querySelectorAll("input[type='radio'], input[type='checkbox']"))) as HTMLInputElement[];
        let bestControl: HTMLInputElement | undefined;
        let bestScore = 0;

        for (const control of controls) {
          const rect = control.getBoundingClientRect();

          if (rect.width <= 0 || rect.height <= 0 || control.disabled) {
            continue;
          }

          const descriptor = normalize([
            control.getAttribute("aria-label"),
            control.getAttribute("name"),
            control.id,
            findLabelText(control),
            findNearbyText(control)
          ].filter(Boolean).join(" "));
          const optionText = normalize(findOptionText(control));
          const score = scoreChoice(descriptor, optionText, labelAliases, normalizedValue, control.type);

          if (score > bestScore) {
            bestScore = score;
            bestControl = control;
          }
        }

        if (!bestControl || bestScore < 48) {
          return false;
        }

        if (bestControl.type === "checkbox" && /^(no|false|none|not applicable|do not|dont|don t|decline)$/.test(normalizedValue)) {
          if (bestControl.checked) {
            bestControl.click();
          }
          return true;
        }

        if (!bestControl.checked) {
          bestControl.click();
        }

        bestControl.dispatchEvent(new Event("input", { bubbles: true }));
        bestControl.dispatchEvent(new Event("change", { bubbles: true }));
        return true;

        function normalize(value: string) {
          return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        }

        function findLabelText(control: HTMLInputElement) {
          if (control.id) {
            const root = control.getRootNode();
            const label = ((root instanceof Document || root instanceof ShadowRoot || root instanceof Element)
              ? root.querySelector(`label[for="${CSS.escape(control.id)}"]`)
              : null)
              ?? getSearchRoots().map((searchRoot) => searchRoot.querySelector(`label[for="${CSS.escape(control.id)}"]`)).find(Boolean)
              ?? null;

            if (label?.textContent) {
              return label.textContent;
            }
          }

          return control.closest("label")?.textContent ?? "";
        }

        function findOptionText(control: HTMLInputElement) {
          return [
            findLabelText(control),
            control.parentElement?.textContent,
            control.value
          ].filter(Boolean).join(" ");
        }

        function findNearbyText(control: HTMLInputElement) {
          return [
            control.closest("fieldset")?.textContent,
            control.closest("[role='group']")?.textContent,
            control.parentElement?.previousElementSibling?.textContent,
            control.parentElement?.parentElement?.previousElementSibling?.textContent
          ].filter(Boolean).join(" ");
        }

        function scoreChoice(descriptor: string, optionText: string, fieldAliases: string[], targetValue: string, type: string) {
          let score = 0;
          const positive = /^(yes|true|agree|authorized|available|willing|i agree)$/;
          const negative = /^(no|false|not applicable|n a)$/;

          for (const alias of fieldAliases) {
            if (descriptor.includes(alias)) {
              score += alias.length <= 4 ? 18 : 38;
            }
          }

          if (optionText === targetValue) {
            score += 70;
          } else if (optionText.includes(targetValue) || targetValue.includes(optionText)) {
            score += 52;
          }

          if (type === "checkbox" && positive.test(targetValue)) {
            score += 45;
          }

          if (negative.test(targetValue)) {
            score = 0;
          }

          return score;
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
      },
      { labelAliases: aliases, fieldValue: value }
    ).catch(() => false);

    if (filled) {
      return true;
    }
  }

  return false;
}

async function fillMultiStageApplication(input: {
  context: BrowserContext;
  page: Page;
  fields: FilledField[];
  job: Job;
  resume?: ResumeRecord;
  student?: StudentProfile;
  memory?: StudentMemory;
  screenshots: string[];
  workspacePath: string;
  allowFinalSubmit: boolean;
  planner: PlannerCheckpoint;
}): Promise<MultiStageFillResult> {
  const maxStages = Number(process.env.BROWSER_MAX_FORM_STAGES ?? 8);
  const filledLabels: string[] = [];
  const skippedLabels: string[] = [];
  const filledKeys = new Set<string>();
  const skippedKeys = new Set<string>();
  let activePage = input.page;
  let stageCount = 0;
  let resumeUploaded = false;
  let lastScreenKey = "";
  let sameScreenAttempts = 0;
  const allowExternalSubmit = input.allowFinalSubmit && process.env.BROWSER_ALLOW_EXTERNAL_SUBMIT === "true";

  for (let stageIndex = 0; stageIndex < maxStages; stageIndex += 1) {
    stageCount = stageIndex + 1;
    activePage = await getActivePage(input.context, activePage);
    plannerEnterStage(input.planner, activePage, stageIndex);
    await updateBrowserAgent(activePage, createStageOverlaySteps(stageIndex, "running", "Reading the current screen and detecting visible fields."));
    await clickSoftGate(activePage);

    const protectedCheckpoint = await detectProtectedCheckpoint(activePage);

    if (protectedCheckpoint.blocked) {
      recordPlannerDecision({
        planner: input.planner,
        page: activePage,
        stageIndex,
        kind: plannerActionFromHandoffKind(protectedCheckpoint.kind ?? inferHandoffKindFromReason(protectedCheckpoint.reason ?? "")),
        source: "system",
        reason: protectedCheckpoint.reason ?? "A protected checkpoint needs the student before GradLaunch can continue."
      });
      const handoff = await waitForHumanIntervention({
        context: input.context,
        page: activePage,
        stageIndex,
        workspacePath: input.workspacePath,
        screenshots: input.screenshots,
        reason: protectedCheckpoint.reason ?? "Human intervention needed: complete the login, captcha, OTP, or verification step in the open browser. GradLaunch is monitoring the page and will resume automatically once it clears.",
        handoffKind: protectedCheckpoint.kind,
        planner: input.planner
      });
      activePage = handoff.activePage;

      if (!handoff.resolved) {
        markPlannerTask(input.planner, "save_checkpoint", "completed", "Saved the planner state while waiting for a protected checkpoint.");
        return {
          activePage,
          filledLabels,
          skippedLabels,
          blockedReason: "The job portal still needs manual attention before GradLaunch can continue, such as login, captcha, OTP, or human verification.",
          handoffRequired: true,
          stageCount
        };
      }

      continue;
    }

    if (!resumeUploaded && input.resume?.storagePath && await pathExists(input.resume.storagePath) && await hasFileUpload(activePage)) {
      await updateBrowserAgent(activePage, createStageOverlaySteps(stageIndex, "running", "Resume upload field detected on this screen. Attaching the latest resume now."));
      markPlannerTask(input.planner, "finish_current_section", "running", "Uploading the student's resume for the current section.");
      resumeUploaded = await attachResume(activePage, input.resume.storagePath);

      if (resumeUploaded) {
        const key = normalizeKey("Resume upload");

        if (!filledKeys.has(key)) {
          filledKeys.add(key);
          filledLabels.push("Resume upload");
        }

        await activePage.waitForTimeout(Number(process.env.BROWSER_RESUME_PARSE_WAIT_MS ?? 1200));
        activePage = await getActivePage(input.context, activePage);
        markPlannerTask(input.planner, "finish_current_section", "running", "Resume upload completed. Re-reading the current section.");
      }
    }

    const visibleFields = await discoverVisibleFields(activePage);
    const screenKey = await getPageFingerprint(activePage);
    await writeBrowserDebug(input.workspacePath, "screen-scan", {
      stage: stageIndex + 1,
      url: activePage.url(),
      visibleFieldCount: visibleFields.length,
      visibleFields: visibleFields.map((field) => ({
        id: field.id,
        label: field.label,
        required: field.required,
        inputType: field.inputType,
        options: field.options,
        context: truncateForLog(field.context, 500)
      }))
    });
    await updateBrowserAgent(activePage, createStageOverlaySteps(
      stageIndex,
      "running",
      `I can see ${visibleFields.length} field${visibleFields.length === 1 ? "" : "s"}: ${summarizeVisibleFields(visibleFields)}. I am classifying this screen and asking the LLM how to fill it.`
    ));
    recordPlannerObservation({
      planner: input.planner,
      page: activePage,
      stageIndex,
      visibleFieldLabels: visibleFields.map((field) => field.label)
    });
    const observation = await observeBrowserPage(activePage, visibleFields);
    await writeBrowserDebug(input.workspacePath, "page-observation", {
      stage: stageIndex + 1,
      pageState: observation.pageState,
      adapter: observation.adapter?.id,
      validationMessages: observation.validationMessages,
      groupedFields: observation.groupedFields
    });
    await updateBrowserAgent(activePage, createStageOverlaySteps(
      stageIndex,
      "running",
      `This screen looks like ${observation.pageState.replaceAll("_", " ")}${observation.adapter ? ` on ${observation.adapter.label}` : ""}.`
    ));
    const agentAction = await decideBrowserAgentAction({
      observation,
      fields: input.fields,
      job: input.job,
      resumeAvailable: Boolean(input.resume?.storagePath && await pathExists(input.resume.storagePath)),
      allowExternalSubmit
    });

    if (agentAction.kind !== "fill") {
      recordPlannerDecision({
        planner: input.planner,
        page: activePage,
        stageIndex,
        kind: mapAgentActionToPlannerAction(agentAction.kind),
        source: agentAction.source,
        reason: agentAction.reason,
        fieldLabels: agentAction.kind === "ask_user" ? agentAction.fields : []
      });
      await updateBrowserAgent(activePage, createStageOverlaySteps(stageIndex, agentAction.kind === "ask_user" ? "attention" : "running", agentAction.reason));

      if (agentAction.kind === "ask_user") {
        await markFieldsNeedingInput(activePage, agentAction.fields);
        const handoff = await waitForHumanIntervention({
          context: input.context,
          page: activePage,
          stageIndex,
          workspacePath: input.workspacePath,
          screenshots: input.screenshots,
          reason: agentAction.reason,
          watchFields: agentAction.fields,
          handoffKind: inferHandoffKindFromReason(agentAction.reason),
          planner: input.planner
        });
        activePage = handoff.activePage;

        if (!handoff.resolved) {
          recordPlannerStageOutcome({
            planner: input.planner,
            page: activePage,
            stageIndex,
            outcome: "handoff",
            requiredFieldLabels: agentAction.fields
          });
          markPlannerTask(input.planner, "save_checkpoint", "completed", "Saved the planner state while waiting for user-supplied form values.");
          return {
            activePage,
            filledLabels,
            skippedLabels: [...skippedLabels, ...agentAction.fields],
            blockedReason: agentAction.reason,
            handoffRequired: true,
            stageCount
          };
        }

        continue;
      }

      if (agentAction.kind === "stop") {
        recordPlannerStageOutcome({
          planner: input.planner,
          page: activePage,
          stageIndex,
          outcome: "review"
        });
        markPlannerTask(input.planner, "save_checkpoint", "completed", "Saved the latest planner checkpoint before pausing for review.");
        setPlannerStatus(input.planner, "needs_review", agentAction.reason);
        return {
          activePage,
          filledLabels,
          skippedLabels,
          stageCount
        };
      }

      if (agentAction.kind === "upload_resume") {
        if (!input.resume?.storagePath || !await pathExists(input.resume.storagePath)) {
          recordPlannerStageOutcome({
            planner: input.planner,
            page: activePage,
            stageIndex,
            outcome: "blocked"
          });
          return {
            activePage,
            filledLabels,
            skippedLabels,
            blockedReason: "The agent found a resume upload path, but no uploaded student resume is available in GradLaunch.",
            stageCount
          };
        }

        const uploaded = await attachResume(activePage, input.resume.storagePath, agentAction.controlId);

        if (!uploaded) {
          recordPlannerStageOutcome({
            planner: input.planner,
            page: activePage,
            stageIndex,
            outcome: "blocked"
          });
          markPlannerTask(input.planner, "finish_current_section", "blocked", "Resume upload path was detected but the upload could not be completed automatically.");
          return {
            activePage,
            filledLabels,
            skippedLabels,
            blockedReason: "The agent found a resume upload path but could not attach the resume automatically. The upload widget may be protected or outside browser automation control.",
            stageCount
          };
        }

        const key = normalizeKey("Resume upload");

        if (!filledKeys.has(key)) {
          filledKeys.add(key);
          filledLabels.push("Resume upload");
        }

        await activePage.waitForTimeout(Number(process.env.BROWSER_RESUME_PARSE_WAIT_MS ?? 1200));
        activePage = await getActivePage(input.context, activePage);
        recordPlannerStageOutcome({
          planner: input.planner,
          page: activePage,
          stageIndex,
          outcome: "filled",
          filledFieldLabels: ["Resume upload"]
        });
        markPlannerTask(input.planner, "finish_current_section", "running", "Resume upload completed. Continuing the current section.");
        continue;
      }

      if (agentAction.kind === "click") {
        const beforeFingerprint = await getPageFingerprint(activePage);
        const clicked = await clickObservedControlAndWait({
          context: input.context,
          page: activePage,
          controlId: agentAction.controlId,
          beforeFingerprint
        });

        activePage = clicked.activePage;

        if (!clicked.moved && !await hasApplicationStartModal(activePage)) {
          recordPlannerStageOutcome({
            planner: input.planner,
            page: activePage,
            stageIndex,
            outcome: "blocked"
          });
          markPlannerTask(input.planner, "retry_alternative_path", "blocked", `A visible control was clicked but the flow did not advance: ${agentAction.reason}`);
          return {
            activePage,
            filledLabels,
            skippedLabels,
            blockedReason: `The agent clicked a visible control, but the page did not advance. Reason: ${agentAction.reason}`,
            stageCount
          };
        }

        recordPlannerStageOutcome({
          planner: input.planner,
          page: activePage,
          stageIndex,
          outcome: "advanced"
        });
        continue;
      }
    }

    const accountGate = await handleAccountGate({
      context: input.context,
      page: activePage,
      fields: input.fields,
      visibleFields,
      resume: input.resume,
      stageIndex
    });

    if (accountGate.handled) {
      activePage = accountGate.activePage;

      for (const label of accountGate.filledLabels) {
        const key = normalizeKey(label);

        if (!filledKeys.has(key)) {
          filledKeys.add(key);
          filledLabels.push(label);
        }
      }

      if (accountGate.blockedReason) {
        if (shouldOfferHumanHandoff(accountGate.blockedReason)) {
          recordPlannerDecision({
            planner: input.planner,
            page: activePage,
            stageIndex,
            kind: plannerActionFromHandoffKind(inferHandoffKindFromReason(accountGate.blockedReason)),
            source: "system",
            reason: accountGate.blockedReason,
            fieldLabels: visibleFields.map((field) => field.label)
          });
          const handoff = await waitForHumanIntervention({
            context: input.context,
            page: activePage,
            stageIndex,
            workspacePath: input.workspacePath,
            screenshots: input.screenshots,
            reason: accountGate.blockedReason,
            handoffKind: inferHandoffKindFromReason(accountGate.blockedReason),
            planner: input.planner
          });
          activePage = handoff.activePage;

          if (handoff.resolved) {
            continue;
          }
        }

        await updateBrowserAgent(activePage, createStageOverlaySteps(stageIndex, "attention", accountGate.blockedReason));
        recordPlannerStageOutcome({
          planner: input.planner,
          page: activePage,
          stageIndex,
          outcome: shouldOfferHumanHandoff(accountGate.blockedReason) ? "handoff" : "blocked"
        });
        return {
          activePage,
          filledLabels,
          skippedLabels,
          blockedReason: accountGate.blockedReason,
          handoffRequired: shouldOfferHumanHandoff(accountGate.blockedReason),
          stageCount
        };
      }

      continue;
    }

    if (visibleFields.length === 0) {
      recordPlannerDecision({
        planner: input.planner,
        page: activePage,
        stageIndex,
        kind: "navigate_apply",
        source: "system",
        reason: "No visible form fields are on the page yet, so the planner is opening the application entry path."
      });
      await updateBrowserAgent(activePage, createStageOverlaySteps(stageIndex, "running", "No form fields are visible yet. Clicking the job site's Apply/start button to open the application form."));
      markPlannerTask(input.planner, "retry_alternative_path", "running", "No visible fields yet, so the planner is opening the application path.");
      await pushScreenshot(input.screenshots, activePage, input.workspacePath, `browser-stage-${stageIndex + 1}-start.png`);

      const beforeStartFingerprint = await getPageFingerprint(activePage);
      const startResult = await clickNextStageControl(input.context, activePage, { allowApplyStart: true });

      if (!startResult.clicked) {
        await updateBrowserAgent(activePage, createStageOverlaySteps(stageIndex, "done", "No form fields or start/apply button were found. GradLaunch is pausing for review."));
        recordPlannerStageOutcome({
          planner: input.planner,
          page: activePage,
          stageIndex,
          outcome: "review"
        });
        return {
          activePage,
          filledLabels,
          skippedLabels,
          stageCount
        };
      }

      const startNavigation = await waitForStageMovement({
        context: input.context,
        page: startResult.page,
        fallbackPage: activePage,
        beforeFingerprint: beforeStartFingerprint
      });
      activePage = startNavigation.activePage;

      if (!startNavigation.moved && !await hasApplicationStartModal(activePage)) {
        const blockedReason = "GradLaunch clicked Apply, but the application form did not open. The job site may require login, may have blocked a popup, or may need manual interaction.";

        if (shouldOfferHumanHandoff(blockedReason)) {
          recordPlannerDecision({
            planner: input.planner,
            page: activePage,
            stageIndex,
            kind: plannerActionFromHandoffKind(inferHandoffKindFromReason(blockedReason)),
            source: "system",
            reason: blockedReason
          });
          const handoff = await waitForHumanIntervention({
            context: input.context,
            page: activePage,
            stageIndex,
            workspacePath: input.workspacePath,
            screenshots: input.screenshots,
            reason: blockedReason,
            handoffKind: inferHandoffKindFromReason(blockedReason),
            planner: input.planner
          });
          activePage = handoff.activePage;

          if (handoff.resolved) {
            continue;
          }
        }

        await updateBrowserAgent(activePage, createStageOverlaySteps(stageIndex, "attention", "The Apply button did not open the application form. Login, popup blocking, or site validation may need manual attention."));
        recordPlannerStageOutcome({
          planner: input.planner,
          page: activePage,
          stageIndex,
          outcome: "handoff"
        });
        return {
          activePage,
          filledLabels,
          skippedLabels,
          blockedReason,
          handoffRequired: true,
          stageCount
        };
      }

      if (await hasApplicationStartModal(activePage)) {
        recordPlannerStageOutcome({
          planner: input.planner,
          page: activePage,
          stageIndex,
          outcome: "advanced"
        });
        continue;
      }

      recordPlannerStageOutcome({
        planner: input.planner,
        page: activePage,
        stageIndex,
        outcome: "advanced"
      });
      continue;
    }

    const fillPlan = await buildDynamicFillPlan({
      page: activePage,
      baseFields: input.fields,
      visibleFields,
      job: input.job,
      resume: input.resume,
      student: input.student,
      memory: input.memory,
      workspacePath: input.workspacePath
    });
    let filledOnStage = 0;
    const filledOnStageLabels: string[] = [];

    if (screenKey === lastScreenKey) {
      sameScreenAttempts += 1;
      bumpPlannerRetries(
        input.planner,
        "retry_alternative_path",
        "Planner saw the same screen again and is attempting a different recovery path.",
        activePage,
        stageIndex
      );
    } else {
      sameScreenAttempts = 0;
      lastScreenKey = screenKey;
    }

    recordPlannerDecision({
      planner: input.planner,
      page: activePage,
      stageIndex,
      kind: "fill_fields",
      source: fillPlan.llmSummary ? "llm" : "system",
      reason: fillPlan.llmSummary
        ? `Prepared a field-fill plan for ${visibleFields.length} visible field${visibleFields.length === 1 ? "" : "s"}. ${fillPlan.llmSummary}`
        : `Prepared a fallback field-fill plan for ${visibleFields.length} visible field${visibleFields.length === 1 ? "" : "s"}.`,
      fieldLabels: visibleFields.map((field) => field.label)
    });

    await updateBrowserAgent(activePage, createStageOverlaySteps(
      stageIndex,
      "running",
      fillPlan.llmSummary
        ? fillPlan.llmAnswerCount > 0
          ? `LLM plan ready (${fillPlan.llmAnswerCount} answer${fillPlan.llmAnswerCount === 1 ? "" : "s"}): ${fillPlan.llmSummary}`
          : fillPlan.llmSummary
        : `I found ${visibleFields.length} visible field${visibleFields.length === 1 ? "" : "s"} (${summarizeVisibleFields(visibleFields)}), but the LLM did not return a usable plan yet.`
    ));
    const shouldNarrateFieldLevel = fillPlan.fields.length <= Number(process.env.BROWSER_VERBOSE_FIELD_UPDATES_MAX ?? 3);

    for (const field of limitFieldsToVisibleLabels(fillPlan.fields, visibleFields)) {
      if (shouldSkipField(field)) {
        continue;
      }

      if (shouldNarrateFieldLevel) {
        await updateBrowserAgent(activePage, createStageOverlaySteps(
          stageIndex,
          "running",
          `I am filling "${field.label}" with ${previewFieldValue(field.value)}.`
        ));
      }
      await writeBrowserDebug(input.workspacePath, "filling-field", {
        fieldId: field.fieldId,
        label: field.label,
        valuePreview: previewFieldValue(field.value)
      });
      const filled = await fillFormField(activePage, field);
      const key = normalizeKey(field.label);

      if (filled) {
        filledOnStage += 1;
        filledOnStageLabels.push(field.label);

        if (!filledKeys.has(key)) {
          filledKeys.add(key);
          filledLabels.push(field.label);
        }
        await writeBrowserDebug(input.workspacePath, "filled-field", {
          fieldId: field.fieldId,
          label: field.label
        });
      } else if (!skippedKeys.has(key) && await isLikelyVisibleField(activePage, field.label)) {
        skippedKeys.add(key);
        skippedLabels.push(field.label);
        await writeBrowserDebug(input.workspacePath, "failed-to-fill-field", {
          fieldId: field.fieldId,
          label: field.label
        });
      }
    }

    const autoResolvedConsent = await autoResolveConsentControls(activePage);

    if (autoResolvedConsent > 0) {
      filledOnStage += autoResolvedConsent;

      if (!filledKeys.has(normalizeKey("Consent confirmation"))) {
        filledKeys.add(normalizeKey("Consent confirmation"));
        filledLabels.push("Consent confirmation");
      }

      await updateBrowserAgent(
        activePage,
        createStageOverlaySteps(stageIndex, "running", `Accepted ${autoResolvedConsent} consent or acknowledgement field${autoResolvedConsent === 1 ? "" : "s"} automatically and re-checking the page.`)
      );
    }

    const visibleRequiredEmptyLabels = await getVisibleRequiredEmptyLabels(activePage);
    const unresolvedRequiredLabels = fillPlan.unresolvedRequiredLabels.length > 0
      ? await getOutstandingWatchedFields(activePage, fillPlan.unresolvedRequiredLabels)
      : [];
    const hasOutstandingRequiredFields = visibleRequiredEmptyLabels.length > 0 || unresolvedRequiredLabels.length > 0;

    if (sameScreenAttempts >= Number(process.env.BROWSER_MAX_SAME_SCREEN_ATTEMPTS ?? 2) && filledOnStage === 0 && hasOutstandingRequiredFields) {
      await markFieldsNeedingInput(activePage, visibleFields.map((field) => field.label));
      recordPlannerObservation({
        planner: input.planner,
        page: activePage,
        stageIndex,
        visibleFieldLabels: visibleFields.map((field) => field.label),
        requiredFieldLabels: dedupeLabels([...visibleRequiredEmptyLabels, ...unresolvedRequiredLabels])
      });
      recordPlannerStageOutcome({
        planner: input.planner,
        page: activePage,
        stageIndex,
        outcome: "blocked",
        requiredFieldLabels: dedupeLabels([...visibleRequiredEmptyLabels, ...unresolvedRequiredLabels])
      });
      await updateBrowserAgent(activePage, createStageOverlaySteps(
        stageIndex,
        "attention",
        `I asked the LLM about this same screen ${sameScreenAttempts + 1} times, but no fields were filled. I am stopping so you can inspect the backend LLM conversation.`
      ));

      return {
        activePage,
        filledLabels,
        skippedLabels,
        blockedReason: `The agent saw the same screen repeatedly after LLM planning and stopped to avoid looping. Visible fields: ${summarizeVisibleFields(visibleFields)}.`,
        stageCount
      };
    }

    if (visibleFields.length > 0 && fillPlan.fields.length === 0) {
      const labels = dedupeLabels(visibleFields.map((field) => field.label));

      if (!hasOutstandingRequiredFields) {
        await updateBrowserAgent(activePage, createStageOverlaySteps(
          stageIndex,
          "running",
          "No required inputs are waiting on this step. I am skipping optional fields and moving to the next stage."
        ));
      } else {
        await markFieldsNeedingInput(activePage, labels);
        recordPlannerObservation({
          planner: input.planner,
          page: activePage,
          stageIndex,
          visibleFieldLabels: visibleFields.map((field) => field.label),
          requiredFieldLabels: labels
        });
        recordPlannerStageOutcome({
          planner: input.planner,
          page: activePage,
          stageIndex,
          outcome: "blocked",
          requiredFieldLabels: labels
        });
        await updateBrowserAgent(activePage, createStageOverlaySteps(
          stageIndex,
          "attention",
          `I read the screen but received 0 usable LLM answers for: ${labels.slice(0, 4).join(", ")}${labels.length > 4 ? "..." : ""}. Check the backend LLM log.`
        ));

        return {
          activePage,
          filledLabels,
          skippedLabels: [...skippedLabels, ...labels],
          blockedReason: `The agent read visible fields but the LLM returned 0 usable answers: ${labels.join(", ")}. Check the backend [GradLaunch LLM] logs for the prompt/response.`,
          stageCount
        };
      }
    }

    if (visibleRequiredEmptyLabels.length > 0 && filledOnStage === 0) {
      const requiredLabels = dedupeLabels([
        ...unresolvedRequiredLabels,
        ...visibleRequiredEmptyLabels
      ]);
      const manualResolvableLabels = requiredLabels.filter((label) => {
        const visibleField = visibleFields.find((field) => normalizeKey(field.label) === normalizeKey(label));
        return isManualResolvableFieldLabel(label, visibleField?.inputType);
      });

      for (const label of requiredLabels) {
        const key = normalizeKey(label);

        if (!skippedKeys.has(key)) {
          skippedKeys.add(key);
          skippedLabels.push(label);
        }
      }

      if (manualResolvableLabels.length > 0 && manualResolvableLabels.length === requiredLabels.length) {
        const reason = createManualFieldHandoffReason(manualResolvableLabels);

        await markFieldsNeedingInput(activePage, manualResolvableLabels);
        recordPlannerObservation({
          planner: input.planner,
          page: activePage,
          stageIndex,
          visibleFieldLabels: visibleFields.map((field) => field.label),
          requiredFieldLabels: requiredLabels
        });
        recordPlannerDecision({
          planner: input.planner,
          page: activePage,
          stageIndex,
          kind: "wait_for_user_input",
          source: "system",
          reason,
          fieldLabels: manualResolvableLabels
        });
        await updateBrowserAgent(activePage, createStageOverlaySteps(stageIndex, "attention", reason));
        await pushScreenshot(input.screenshots, activePage, input.workspacePath, `browser-stage-${stageIndex + 1}-manual-handoff.png`);
        const handoff = await waitForHumanIntervention({
          context: input.context,
          page: activePage,
          stageIndex,
          workspacePath: input.workspacePath,
          screenshots: input.screenshots,
          reason,
          watchFields: manualResolvableLabels,
          resolveWhenWatchFieldsClear: true,
          handoffKind: "missing_data",
          planner: input.planner
        });
        activePage = handoff.activePage;

        if (handoff.resolved) {
          continue;
        }

        markPlannerTask(input.planner, "save_checkpoint", "completed", "Saved the planner state while waiting for manual confirmation on required fields.");
        return {
          activePage,
          filledLabels,
          skippedLabels,
          blockedReason: reason,
          handoffRequired: true,
          stageCount
        };
      }

      await markFieldsNeedingInput(activePage, requiredLabels);
      recordPlannerObservation({
        planner: input.planner,
        page: activePage,
        stageIndex,
        visibleFieldLabels: visibleFields.map((field) => field.label),
        requiredFieldLabels: requiredLabels
      });
      recordPlannerDecision({
        planner: input.planner,
        page: activePage,
        stageIndex,
        kind: "recover_validation",
        source: "system",
        reason: `Required fields still need safe answers: ${requiredLabels.join(", ")}.`,
        fieldLabels: requiredLabels
      });
      recordPlannerStageOutcome({
        planner: input.planner,
        page: activePage,
        stageIndex,
        outcome: "blocked",
        requiredFieldLabels: requiredLabels
      });
      await updateBrowserAgent(activePage, createStageOverlaySteps(
        stageIndex,
        "attention",
        `The LLM did not produce usable answers for required fields: ${requiredLabels.slice(0, 3).join(", ")}${requiredLabels.length > 3 ? "..." : ""}.`
      ));
      await pushScreenshot(input.screenshots, activePage, input.workspacePath, `browser-stage-${stageIndex + 1}-llm-no-fill.png`);
      recordPlannerValidation(input.planner, requiredLabels);

      return {
        activePage,
        filledLabels,
        skippedLabels,
        blockedReason: `The LLM did not produce usable answers for required fields on this page: ${requiredLabels.join(", ")}. Check the API key/model response, or use BROWSER_LLM_FIELD_FILL_MODE=fallback to allow non-LLM matching while debugging.`,
        stageCount
      };
    }

    if (unresolvedRequiredLabels.length > 0) {
      const manualResolvableLabels = unresolvedRequiredLabels.filter((label) => {
        const visibleField = visibleFields.find((field) => normalizeKey(field.label) === normalizeKey(label));
        return isManualResolvableFieldLabel(label, visibleField?.inputType);
      });

      for (const label of unresolvedRequiredLabels) {
        const key = normalizeKey(label);

        if (!skippedKeys.has(key)) {
          skippedKeys.add(key);
          skippedLabels.push(label);
        }
      }

      if (manualResolvableLabels.length > 0 && manualResolvableLabels.length === unresolvedRequiredLabels.length) {
        const reason = createManualFieldHandoffReason(manualResolvableLabels);

        await markFieldsNeedingInput(activePage, manualResolvableLabels);
        recordPlannerObservation({
          planner: input.planner,
          page: activePage,
          stageIndex,
          visibleFieldLabels: visibleFields.map((field) => field.label),
          requiredFieldLabels: unresolvedRequiredLabels
        });
        recordPlannerDecision({
          planner: input.planner,
          page: activePage,
          stageIndex,
          kind: "wait_for_user_input",
          source: "system",
          reason,
          fieldLabels: manualResolvableLabels
        });
        await updateBrowserAgent(activePage, createStageOverlaySteps(stageIndex, "attention", reason));
        await pushScreenshot(input.screenshots, activePage, input.workspacePath, `browser-stage-${stageIndex + 1}-manual-handoff.png`);
        const handoff = await waitForHumanIntervention({
          context: input.context,
          page: activePage,
          stageIndex,
          workspacePath: input.workspacePath,
          screenshots: input.screenshots,
          reason,
          watchFields: manualResolvableLabels,
          resolveWhenWatchFieldsClear: true,
          handoffKind: "missing_data",
          planner: input.planner
        });
        activePage = handoff.activePage;

        if (handoff.resolved) {
          continue;
        }

        markPlannerTask(input.planner, "save_checkpoint", "completed", "Saved the planner state while waiting for manual field confirmation.");
        return {
          activePage,
          filledLabels,
          skippedLabels,
          blockedReason: reason,
          handoffRequired: true,
          stageCount
        };
      }

      await markFieldsNeedingInput(activePage, unresolvedRequiredLabels);
      recordPlannerObservation({
        planner: input.planner,
        page: activePage,
        stageIndex,
        visibleFieldLabels: visibleFields.map((field) => field.label),
        requiredFieldLabels: unresolvedRequiredLabels
      });
      recordPlannerDecision({
        planner: input.planner,
        page: activePage,
        stageIndex,
        kind: "recover_validation",
        source: "system",
        reason: `Planner is pausing because required fields still need trusted answers: ${unresolvedRequiredLabels.join(", ")}.`,
        fieldLabels: unresolvedRequiredLabels
      });
      recordPlannerStageOutcome({
        planner: input.planner,
        page: activePage,
        stageIndex,
        outcome: "blocked",
        requiredFieldLabels: unresolvedRequiredLabels
      });
      await updateBrowserAgent(activePage, createStageOverlaySteps(
        stageIndex,
        "attention",
        `Needs human input for: ${unresolvedRequiredLabels.slice(0, 3).join(", ")}${unresolvedRequiredLabels.length > 3 ? "..." : ""}.`
      ));
      await pushScreenshot(input.screenshots, activePage, input.workspacePath, `browser-stage-${stageIndex + 1}-needs-input.png`);
      recordPlannerValidation(input.planner, unresolvedRequiredLabels);

      return {
        activePage,
        filledLabels,
        skippedLabels,
        blockedReason: `GradLaunch found required fields it cannot answer safely yet: ${unresolvedRequiredLabels.join(", ")}. Add these to the profile/resume, enable Ollama, or set APPLICATION_ANSWER_BANK_JSON.`,
        stageCount
      };
    }

    await updateBrowserAgent(activePage, createStageOverlaySteps(stageIndex, "running", `Filled ${filledOnStage} field${filledOnStage === 1 ? "" : "s"} on this step. Looking for a safe next/review button.`));
    markPlannerTask(
      input.planner,
      "finish_current_section",
      "running",
      `Filled ${filledOnStage} field${filledOnStage === 1 ? "" : "s"} on ${input.planner.currentStageLabel ?? `section ${stageIndex + 1}`}.`
    );
    recordPlannerObservation({
      planner: input.planner,
      page: activePage,
      stageIndex,
      visibleFieldLabels: visibleFields.map((field) => field.label),
      requiredFieldLabels: dedupeLabels([...visibleRequiredEmptyLabels, ...unresolvedRequiredLabels])
    });
    recordPlannerStageOutcome({
      planner: input.planner,
      page: activePage,
      stageIndex,
      outcome: "filled",
      filledFieldLabels: filledOnStageLabels
    });
    await pushScreenshot(input.screenshots, activePage, input.workspacePath, `browser-stage-${stageIndex + 1}.png`);
    const postFillValidationMessages = await getVisibleValidationMessages(activePage);

    if (postFillValidationMessages.length > 0 && filledOnStage === 0 && fillPlan.nextActionAfterFill !== "click_next") {
      recordPlannerDecision({
        planner: input.planner,
        page: activePage,
        stageIndex,
        kind: "recover_validation",
        source: "system",
        reason: `Validation feedback is visible on the current screen: ${postFillValidationMessages.join(", ")}.`
      });
      recordPlannerStageOutcome({
        planner: input.planner,
        page: activePage,
        stageIndex,
        outcome: "blocked"
      });
      return {
        activePage,
        filledLabels,
        skippedLabels,
        blockedReason: `The current step shows validation feedback and the agent could not safely repair it yet: ${postFillValidationMessages.join(", ")}.`,
        stageCount
      };
    }

    const submitGateCheckpoint = await detectProtectedCheckpoint(activePage);

    if (submitGateCheckpoint.blocked) {
      recordPlannerDecision({
        planner: input.planner,
        page: activePage,
        stageIndex,
        kind: plannerActionFromHandoffKind(submitGateCheckpoint.kind ?? inferHandoffKindFromReason(submitGateCheckpoint.reason ?? "")),
        source: "system",
        reason: submitGateCheckpoint.reason ?? "Human intervention needed before GradLaunch can continue."
      });
      await updateBrowserAgent(activePage, createStageOverlaySteps(stageIndex, "attention", submitGateCheckpoint.reason ?? "Human intervention needed before GradLaunch can continue."));
      const handoff = await waitForHumanIntervention({
        context: input.context,
        page: activePage,
        stageIndex,
        workspacePath: input.workspacePath,
        screenshots: input.screenshots,
        reason: submitGateCheckpoint.reason ?? "Human intervention needed: complete the login, captcha, OTP, or verification step in the open browser. GradLaunch is monitoring the page and will resume automatically once it clears.",
        handoffKind: submitGateCheckpoint.kind,
        planner: input.planner
      });
      activePage = handoff.activePage;

      if (handoff.resolved) {
        continue;
      }

      markPlannerTask(input.planner, "save_checkpoint", "completed", "Saved the planner state while waiting for a protected checkpoint before submission.");
      return {
        activePage,
        filledLabels,
        skippedLabels,
        blockedReason: submitGateCheckpoint.reason ?? "The job portal still needs manual attention before GradLaunch can continue.",
        handoffRequired: true,
        stageCount
      };
    }

    if (await hasFinalSubmitControl(activePage)) {
      if (!allowExternalSubmit) {
        recordPlannerDecision({
          planner: input.planner,
          page: activePage,
          stageIndex,
          kind: "reach_review",
          source: "system",
          reason: "The final submit control is visible, so the planner is pausing at the review gate."
        });
        recordPlannerStageOutcome({
          planner: input.planner,
          page: activePage,
          stageIndex,
          outcome: "review"
        });
        await updateBrowserAgent(activePage, createStageOverlaySteps(stageIndex, "done", "Final submit control is visible. GradLaunch is pausing here because external submit is not enabled."));
        markPlannerTask(input.planner, "reach_submit_gate", "completed", "Reached the submit gate and paused for review.");
        return {
          activePage,
          filledLabels,
          skippedLabels,
          stageCount
        };
      }

      recordPlannerDecision({
        planner: input.planner,
        page: activePage,
        stageIndex,
        kind: "submit_application",
        source: "system",
        reason: "The final submit control is visible and external submit is enabled, so the planner is submitting now."
      });
      recordPlannerStageOutcome({
        planner: input.planner,
        page: activePage,
        stageIndex,
        outcome: "submitted"
      });
      await updateBrowserAgent(activePage, createStageOverlaySteps(stageIndex, "running", "Final submit control is visible and external submit is enabled. Submitting now."));
      markPlannerTask(input.planner, "reach_submit_gate", "running", "Final submit control is visible. Executing the submit step.");
      return {
        activePage,
        filledLabels,
        skippedLabels,
        stageCount
      };
    }

    if (fillPlan.nextActionAfterFill === "pause") {
      recordPlannerDecision({
        planner: input.planner,
        page: activePage,
        stageIndex,
        kind: "pause_for_review",
        source: "llm",
        reason: "The stage planner recommended pausing on this screen for review after filling."
      });
      recordPlannerStageOutcome({
        planner: input.planner,
        page: activePage,
        stageIndex,
        outcome: "review"
      });
      return {
        activePage,
        filledLabels,
        skippedLabels,
        stageCount
      };
    }

    const nextStage = await advanceToNextStage({
      context: input.context,
      page: activePage,
      stageIndex,
      allowApplyStart: false
    });

    if (!nextStage.moved) {
      if (nextStage.blockedReason && shouldOfferHumanHandoff(nextStage.blockedReason)) {
        recordPlannerDecision({
          planner: input.planner,
          page: activePage,
          stageIndex,
          kind: plannerActionFromHandoffKind(inferHandoffKindFromReason(nextStage.blockedReason)),
          source: "system",
          reason: nextStage.blockedReason
        });
        const handoff = await waitForHumanIntervention({
          context: input.context,
          page: activePage,
          stageIndex,
          workspacePath: input.workspacePath,
          screenshots: input.screenshots,
          reason: nextStage.blockedReason,
          handoffKind: inferHandoffKindFromReason(nextStage.blockedReason),
          planner: input.planner
        });
        activePage = handoff.activePage;

        if (handoff.resolved) {
          continue;
        }
      }

      await updateBrowserAgent(activePage, createStageOverlaySteps(stageIndex, "done", "No safe next button was found. GradLaunch is pausing for review."));
      recordPlannerStageOutcome({
        planner: input.planner,
        page: activePage,
        stageIndex,
        outcome: nextStage.blockedReason ? "handoff" : "review"
      });
      return {
        activePage,
        filledLabels,
        skippedLabels,
        blockedReason: nextStage.blockedReason,
        handoffRequired: Boolean(nextStage.blockedReason && shouldOfferHumanHandoff(nextStage.blockedReason)),
        stageCount
      };
    }

    recordPlannerDecision({
      planner: input.planner,
      page: nextStage.activePage,
      stageIndex,
      kind: "navigate_next",
      source: "system",
      reason: `Completed ${input.planner.currentStageLabel ?? `Section ${stageIndex + 1}`} and advanced to the next application stage.`
    });
    activePage = nextStage.activePage;
    completePlannerStage(input.planner, activePage, stageIndex);
  }

  await updateBrowserAgent(activePage, [
    createBrowserAgentStep("Stage limit reached", `GradLaunch handled ${maxStages} stages and paused to avoid unsafe looping.`, "attention"),
    createBrowserAgentStep("Review needed", "Please inspect the open browser before continuing.", "running")
  ]);

  return {
    activePage,
    filledLabels,
    skippedLabels,
    blockedReason: `GradLaunch reached the configured limit of ${maxStages} form stages and paused to avoid unsafe looping.`,
    stageCount: maxStages
  };
}

function createStageOverlaySteps(stageIndex: number, state: BrowserAgentStep["state"], detail: string): BrowserAgentStep[] {
  const currentStage = `Step ${stageIndex + 1}`;

  return [
    createBrowserAgentStep("I opened the job page", "Chrome is holding the exact application URL/window.", "done"),
    createBrowserAgentStep("I am reading the screen", "I scan visible inputs, buttons, labels, nearby text, and uploaded files before choosing an action.", "done"),
    createBrowserAgentStep(currentStage, detail, state),
    createBrowserAgentStep("Next action", "I will fill answers, upload files, continue, or pause for you if the page asks for password, OTP, captcha, or private data.", state === "done" ? "done" : "queued"),
    createBrowserAgentStep("Submit safety", "I will not make a real final submission unless BROWSER_ALLOW_EXTERNAL_SUBMIT=true.", "queued")
  ];
}

function createHumanHandoffSteps(stageIndex: number | undefined, detail: string, secondsRemaining: number): BrowserAgentStep[] {
  const stageLabel = typeof stageIndex === "number" ? `Step ${stageIndex + 1}` : "Current step";

  return [
    createBrowserAgentStep("I opened the job page", "Chrome is holding the exact application URL/window.", "done"),
    createBrowserAgentStep("Human handoff active", "Complete the login, captcha, OTP, or other protected checkpoint in the open browser. I am monitoring the page and will resume automatically once it clears.", "attention"),
    createBrowserAgentStep(stageLabel, `${detail} Waiting up to ${secondsRemaining}s for manual intervention.`, "running"),
    createBrowserAgentStep("Automatic resume", "As soon as the page clears the gate, I will take control again and continue the flow.", "queued"),
    createBrowserAgentStep("Submit safety", "I still will not make a real final submission unless BROWSER_ALLOW_EXTERNAL_SUBMIT=true.", "queued")
  ];
}

function createCompletionOverlaySteps(stageCount: number, detail: string): BrowserAgentStep[] {
  return [
    createBrowserAgentStep("I opened the job page", "Chrome is holding the exact application URL/window.", "done"),
    createBrowserAgentStep("I filled the form", `GradLaunch completed ${stageCount} form stage${stageCount === 1 ? "" : "s"} and reached the final review point.`, "done"),
    createBrowserAgentStep("Form ready", detail, "done"),
    createBrowserAgentStep("Review option", "Inspect the filled form in this browser window before the final action.", "queued"),
    createBrowserAgentStep("Submit option", "Use the submit action on this page when you are ready to finish.", "queued")
  ];
}

function summarizeVisibleFields(fields: VisibleField[]) {
  if (fields.length === 0) {
    return "none";
  }

  return fields
    .slice(0, 6)
    .map((field) => field.label.replace(/\s+/g, " ").trim())
    .join(", ") + (fields.length > 6 ? "..." : "");
}

function previewFieldValue(value: string) {
  const trimmed = value.replace(/\s+/g, " ").trim();

  if (!trimmed) {
    return "an empty answer";
  }

  if (/@/.test(trimmed)) {
    return `"${trimmed.replace(/^(.{2}).*(@.*)$/, "$1...$2")}"`;
  }

  if (trimmed.length > 80) {
    return `"${trimmed.slice(0, 80)}..."`;
  }

  return `"${trimmed}"`;
}

function createBrowserAgentStep(label: string, detail: string, state: BrowserAgentStep["state"]): BrowserAgentStep {
  return {
    label,
    detail,
    state
  };
}

async function waitForHumanIntervention(input: {
  context: BrowserContext;
  page: Page;
  stageIndex?: number;
  workspacePath: string;
  screenshots?: string[];
  reason: string;
  handoffKind?: AgentHandoffKind;
  watchFields?: string[];
  resolveWhenWatchFieldsClear?: boolean;
  planner: PlannerCheckpoint;
}): Promise<HumanInterventionWaitResult> {
  const timeoutMs = Number(process.env.BROWSER_HANDOFF_TIMEOUT_MS ?? 180000);
  const pollMs = Number(process.env.BROWSER_HANDOFF_POLL_MS ?? 1200);
  const startedAt = Date.now();
  let activePage = input.page;
  let lastCountdownBucket = -1;

  await maybeKeepBrowserOpen(input.context);
  await pushScreenshot(input.screenshots ?? [], activePage, input.workspacePath, "browser-handoff-needed.png");
  notePlannerHandoff(input.planner, input.reason, activePage, input.stageIndex, input.handoffKind);

  while (Date.now() - startedAt < timeoutMs) {
    const secondsRemaining = Math.max(1, Math.ceil((timeoutMs - (Date.now() - startedAt)) / 1000));
    const countdownBucket = Math.floor(secondsRemaining / 5);

    if (countdownBucket !== lastCountdownBucket) {
      lastCountdownBucket = countdownBucket;
      await updateBrowserAgent(activePage, createHumanHandoffSteps(input.stageIndex, input.reason, secondsRemaining));
    }

    await activePage.waitForTimeout(pollMs).catch(() => undefined);
    activePage = await getActivePage(input.context, activePage);

    const protectedCheckpoint = await detectProtectedCheckpoint(activePage);

    if (input.watchFields?.length) {
      const outstandingFields = await getOutstandingWatchedFields(activePage, input.watchFields);

      if (outstandingFields.length === 0 && input.resolveWhenWatchFieldsClear) {
        await updateBrowserAgent(
          activePage,
          createStageOverlaySteps(input.stageIndex ?? 0, "running", "Manual checkpoint cleared. I am resuming the autonomous form flow now.")
        );
        markPlannerTask(input.planner, "authenticate_if_needed", "running", "Protected checkpoint cleared. Resuming autonomous execution.");
        setPlannerStatus(input.planner, "running", "Manual checkpoint cleared and the planner resumed.");
        return {
          resolved: true,
          activePage
        };
      }

      if (outstandingFields.length > 0) {
        continue;
      }
    }

    if (protectedCheckpoint.blocked) {
      continue;
    }

    await updateBrowserAgent(
      activePage,
      createStageOverlaySteps(input.stageIndex ?? 0, "running", "Manual checkpoint cleared. I am resuming the autonomous form flow now.")
    );
    markPlannerTask(input.planner, "authenticate_if_needed", "running", "Protected checkpoint cleared. Resuming autonomous execution.");
    setPlannerStatus(input.planner, "running", "Manual checkpoint cleared and the planner resumed.");
    return {
      resolved: true,
      activePage
    };
  }

  await updateBrowserAgent(
    activePage,
    createStageOverlaySteps(input.stageIndex ?? 0, "attention", "Manual checkpoint is still waiting on the student. GradLaunch is pausing here and keeping the browser available for review.")
  );
  setPlannerStatus(input.planner, "handoff_required", "Planner paused because the protected checkpoint still needs the student.");
  return {
    resolved: false,
    activePage
  };
}

async function getOutstandingWatchedFields(page: Page, labels: string[]) {
  const outstanding = await getVisibleRequiredEmptyLabels(page);
  const outstandingKeys = new Set(outstanding.map(normalizeKey));
  const outstandingWatchedIds = await page.evaluate((watchedLabels) => {
    return watchedLabels.filter((label) => {
      const control = document.getElementById(label) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;

      if (!control) {
        return false;
      }

      const rect = control.getBoundingClientRect();

      if (rect.width <= 0 || rect.height <= 0) {
        return false;
      }

      if (control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type)) {
        const group = control.name
          ? Array.from(document.querySelectorAll(`input[name="${CSS.escape(control.name)}"]`)) as HTMLInputElement[]
          : [control];
        return !group.some((item) => item.checked);
      }

      return !control.value.trim();
    });
  }, labels).catch(() => []);
  const outstandingIdKeys = new Set(outstandingWatchedIds.map(normalizeKey));
  return labels.filter((label) => outstandingKeys.has(normalizeKey(label)) || outstandingIdKeys.has(normalizeKey(label)));
}

function shouldOfferHumanHandoff(reason: string) {
  return /login|log in|sign in|password|otp|verification|captcha|human|manual interaction|manual attention|popup/i.test(reason);
}

function createPlannerCheckpoint(job: Job, existing?: PlannerCheckpoint): PlannerCheckpoint {
  if (existing) {
    return {
      ...existing,
      formMode: existing.formMode ?? "unknown",
      subgoals: existing.subgoals.map((task) => ({ ...task })),
      validationErrors: [...existing.validationErrors],
      lastDecision: existing.lastDecision ? clonePlannerDecision(existing.lastDecision) : undefined,
      stageHistory: Array.isArray(existing.stageHistory) ? existing.stageHistory.map(clonePlannerStage) : []
    };
  }

  const now = nowIso();
  return {
    sessionId: `planner-${job.id}`,
    resumeToken: `${job.id}:${now}`,
    goal: `Complete the ${job.title} application at ${job.company} autonomously until a protected or final review checkpoint.`,
    status: "idle",
    summary: "Planner is ready to start the application flow.",
    formMode: "unknown",
    retryCount: 0,
    handoffCount: 0,
    validationErrors: [],
    subgoals: [
      createPlannerTask("open_job_page", "Open job page", now),
      createPlannerTask("authenticate_if_needed", "Handle login if needed", now),
      createPlannerTask("finish_current_section", "Finish active section", now),
      createPlannerTask("recover_from_validation_errors", "Recover from validation errors", now),
      createPlannerTask("retry_alternative_path", "Retry alternative path", now),
      createPlannerTask("reach_submit_gate", "Reach submit/review gate", now),
      createPlannerTask("save_checkpoint", "Save checkpoint", now)
    ],
    stageHistory: [],
    lastUpdatedAt: now
  };
}

function clonePlannerDecision(decision: PlannerDecision): PlannerDecision {
  return {
    ...decision,
    fieldLabels: [...decision.fieldLabels]
  };
}

function clonePlannerStage(stage: PlannerStageSnapshot): PlannerStageSnapshot {
  return {
    ...stage,
    visibleFieldLabels: [...stage.visibleFieldLabels],
    requiredFieldLabels: [...stage.requiredFieldLabels],
    filledFieldLabels: [...stage.filledFieldLabels],
    decision: stage.decision ? clonePlannerDecision(stage.decision) : undefined
  };
}

function createPlannerTask(id: string, label: string, timestamp: string): PlannerTask {
  return {
    id,
    label,
    status: "pending",
    detail: "Waiting to start.",
    attempts: 0,
    lastUpdatedAt: timestamp
  };
}

function markPlannerTask(planner: PlannerCheckpoint, id: string, status: PlannerTask["status"], detail: string) {
  const now = nowIso();
  const task = planner.subgoals.find((item) => item.id === id);

  if (!task) {
    return;
  }

  task.status = status;
  task.detail = detail;
  task.lastUpdatedAt = now;

  if (status === "running" || status === "retrying" || status === "needs_user" || status === "blocked") {
    task.attempts += 1;
  }

  if (status === "completed") {
    task.completedAt = now;
  }

  planner.lastUpdatedAt = now;
}

function setPlannerStatus(planner: PlannerCheckpoint, status: PlannerCheckpoint["status"], summary: string) {
  planner.status = status;
  planner.summary = summary;
  planner.lastUpdatedAt = nowIso();
}

function ensurePlannerStage(planner: PlannerCheckpoint, page: Page, stageIndex: number) {
  const label = `Section ${stageIndex + 1}`;
  const existingStage = planner.stageHistory.find((stage) => stage.stageIndex === stageIndex);

  if (existingStage) {
    existingStage.label = label;
    existingStage.url = page.url();
    existingStage.lastUpdatedAt = nowIso();
    return existingStage;
  }

  const stage: PlannerStageSnapshot = {
    stageIndex,
    label,
    url: page.url(),
    visibleFieldLabels: [],
    requiredFieldLabels: [],
    filledFieldLabels: [],
    outcome: "observed",
    lastUpdatedAt: nowIso()
  };
  planner.stageHistory.push(stage);
  planner.lastUpdatedAt = stage.lastUpdatedAt;
  return stage;
}

function updatePlannerFormMode(planner: PlannerCheckpoint, stageIndex: number) {
  if (stageIndex > 0) {
    planner.formMode = "multi_stage";
    return;
  }

  if (planner.formMode === "unknown") {
    planner.formMode = "single_stage";
  }
}

function recordPlannerObservation(input: {
  planner: PlannerCheckpoint;
  page: Page;
  stageIndex: number;
  visibleFieldLabels?: string[];
  requiredFieldLabels?: string[];
}) {
  const stage = ensurePlannerStage(input.planner, input.page, input.stageIndex);
  updatePlannerFormMode(input.planner, input.stageIndex);
  stage.visibleFieldLabels = dedupeLabels([...(input.visibleFieldLabels ?? [])]);
  stage.requiredFieldLabels = dedupeLabels([...(input.requiredFieldLabels ?? stage.requiredFieldLabels)]);
  stage.url = input.page.url();
  stage.lastUpdatedAt = nowIso();
  input.planner.lastUpdatedAt = stage.lastUpdatedAt;
}

function recordPlannerDecision(input: {
  planner: PlannerCheckpoint;
  page: Page;
  stageIndex: number;
  kind: PlannerActionKind;
  source: PlannerDecisionSource;
  reason: string;
  fieldLabels?: string[];
}) {
  const stage = ensurePlannerStage(input.planner, input.page, input.stageIndex);
  const decision: PlannerDecision = {
    kind: input.kind,
    source: input.source,
    stageIndex: input.stageIndex,
    stageLabel: stage.label,
    url: input.page.url(),
    reason: input.reason,
    fieldLabels: dedupeLabels(input.fieldLabels ?? []),
    createdAt: nowIso()
  };

  stage.decision = decision;
  stage.lastUpdatedAt = decision.createdAt;
  input.planner.lastDecision = decision;
  input.planner.currentUrl = decision.url;
  input.planner.currentStageLabel = stage.label;
  input.planner.lastUpdatedAt = decision.createdAt;
}

function recordPlannerStageOutcome(input: {
  planner: PlannerCheckpoint;
  page: Page;
  stageIndex: number;
  outcome: PlannerStageOutcome;
  filledFieldLabels?: string[];
  requiredFieldLabels?: string[];
}) {
  const stage = ensurePlannerStage(input.planner, input.page, input.stageIndex);
  stage.outcome = input.outcome;
  stage.url = input.page.url();
  stage.filledFieldLabels = dedupeLabels([...stage.filledFieldLabels, ...(input.filledFieldLabels ?? [])]);
  stage.requiredFieldLabels = dedupeLabels([...stage.requiredFieldLabels, ...(input.requiredFieldLabels ?? [])]);
  stage.lastUpdatedAt = nowIso();
  input.planner.lastUpdatedAt = stage.lastUpdatedAt;
}

function plannerEnterStage(planner: PlannerCheckpoint, page: Page, stageIndex: number) {
  planner.currentStep = `stage_${stageIndex + 1}`;
  planner.currentStageLabel = `Section ${stageIndex + 1}`;
  planner.currentUrl = page.url();
  updatePlannerFormMode(planner, stageIndex);
  ensurePlannerStage(planner, page, stageIndex);
  planner.lastUpdatedAt = nowIso();
  markPlannerTask(planner, "finish_current_section", "running", `Reading ${planner.currentStageLabel} and planning the next safe action.`);
  setPlannerStatus(planner, "running", `Planner is working through ${planner.currentStageLabel}.`);
}

function completePlannerStage(planner: PlannerCheckpoint, page: Page, stageIndex: number) {
  recordPlannerStageOutcome({
    planner,
    page,
    stageIndex,
    outcome: "advanced"
  });
  planner.currentStep = `stage_${stageIndex + 2}`;
  planner.currentStageLabel = `Section ${stageIndex + 2}`;
  planner.currentUrl = page.url();
  planner.lastUpdatedAt = nowIso();
  markPlannerTask(planner, "finish_current_section", "completed", `Completed Section ${stageIndex + 1} and advanced to the next stage.`);
  markPlannerTask(planner, "save_checkpoint", "completed", `Saved checkpoint after Section ${stageIndex + 1}.`);
  setPlannerStatus(planner, "running", `Section ${stageIndex + 1} completed. Moving to the next stage.`);
}

function notePlannerHandoff(
  planner: PlannerCheckpoint,
  reason: string,
  page: Page,
  stageIndex?: number,
  handoffKind?: AgentHandoffKind
) {
  planner.handoffCount += 1;
  planner.currentUrl = page.url();
  planner.currentStageLabel = typeof stageIndex === "number" ? `Section ${stageIndex + 1}` : planner.currentStageLabel;
  if (typeof stageIndex === "number") {
    recordPlannerDecision({
      planner,
      page,
      stageIndex,
      kind: plannerActionFromHandoffKind(handoffKind ?? inferHandoffKindFromReason(reason)),
      source: "system",
      reason
    });
    recordPlannerStageOutcome({
      planner,
      page,
      stageIndex,
      outcome: "handoff"
    });
  }
  markPlannerTask(planner, "authenticate_if_needed", "needs_user", reason);
  markPlannerTask(planner, "save_checkpoint", "completed", "Saved checkpoint before handing the browser to the student.");
  setPlannerStatus(planner, "handoff_required", reason);
}

function recordPlannerValidation(planner: PlannerCheckpoint, labels: string[]) {
  planner.validationErrors = dedupeLabels([...planner.validationErrors, ...labels]);
  markPlannerTask(
    planner,
    "recover_from_validation_errors",
    "blocked",
    `Validation or required-answer blockers were found: ${labels.join(", ")}.`
  );
  setPlannerStatus(planner, "needs_review", `Planner stopped because required inputs still need attention: ${labels.join(", ")}.`);
}

function bumpPlannerRetries(planner: PlannerCheckpoint, taskId: string, detail: string, page?: Page, stageIndex?: number) {
  planner.retryCount += 1;
  markPlannerTask(planner, taskId, "retrying", detail);
  if (page && typeof stageIndex === "number") {
    recordPlannerDecision({
      planner,
      page,
      stageIndex,
      kind: taskId === "recover_from_validation_errors" ? "recover_validation" : "recover_same_screen",
      source: "system",
      reason: detail
    });
  }
  setPlannerStatus(planner, "running", detail);
}

function plannerActionFromHandoffKind(kind: AgentHandoffKind): PlannerActionKind {
  switch (kind) {
    case "login":
      return "wait_for_login";
    case "captcha":
      return "wait_for_captcha";
    case "otp":
      return "wait_for_otp";
    case "verification":
      return "wait_for_verification";
    case "missing_data":
      return "wait_for_user_input";
    case "review":
    case "policy":
      return "pause_for_review";
    default:
      return "wait_for_user_input";
  }
}

function inferHandoffKindFromReason(reason: string): AgentHandoffKind {
  const normalizedReason = reason.toLowerCase();

  if (normalizedReason.includes("captcha") || normalizedReason.includes("human")) {
    return "captcha";
  }

  if (normalizedReason.includes("otp") || normalizedReason.includes("passcode") || normalizedReason.includes("2fa") || normalizedReason.includes("mfa")) {
    return "otp";
  }

  if (normalizedReason.includes("verification")) {
    return "verification";
  }

  if (normalizedReason.includes("login") || normalizedReason.includes("log in") || normalizedReason.includes("sign in") || normalizedReason.includes("password")) {
    return "login";
  }

  if (normalizedReason.includes("missing") || normalizedReason.includes("input") || normalizedReason.includes("answer")) {
    return "missing_data";
  }

  return "review";
}

function mapAgentActionToPlannerAction(kind: BrowserAgentAction["kind"]): PlannerActionKind {
  switch (kind) {
    case "fill":
      return "fill_fields";
    case "click":
      return "navigate_apply";
    case "upload_resume":
      return "upload_resume";
    case "ask_user":
      return "wait_for_user_input";
    case "stop":
      return "pause_for_review";
    default:
      return "scan_page";
  }
}

async function updateBrowserAgent(page: Page, steps: BrowserAgentStep[]) {
  await page.evaluate((agentSteps) => {
    const rootId = "gradlaunch-browser-agent";
    const existing = document.getElementById(rootId);
    const root = existing ?? document.createElement("aside");

    if (!existing) {
      root.id = rootId;
      root.setAttribute("aria-live", "polite");
      document.documentElement.appendChild(root);
    }

    const previousLeft = root.style.left;
    const previousTop = root.style.top;
    root.innerHTML = "";
    root.style.left = previousLeft;
    root.style.top = previousTop;
    const style = document.createElement("style");
    style.textContent = `
      #${rootId} {
        all: initial;
        position: fixed;
        right: 14px;
        top: 14px;
        z-index: 2147483647;
        width: min(380px, calc(100vw - 28px));
        max-height: min(520px, calc(100vh - 28px));
        overflow: auto;
        padding: 12px;
        border: 1px solid rgba(15, 91, 215, 0.24);
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.96);
        box-shadow: 0 16px 40px rgba(15, 23, 42, 0.2);
        color: #102033;
        font-family: Avenir Next, Segoe UI, Helvetica, Arial, sans-serif;
        pointer-events: auto;
        user-select: none;
      }
      #${rootId} * { box-sizing: border-box; }
      #${rootId}.gl-dragged {
        right: auto;
        bottom: auto;
      }
      #${rootId} .gl-drag-handle {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin: -2px -2px 8px;
        padding: 4px;
        cursor: move;
      }
      #${rootId} .gl-eyebrow {
        margin: 0 0 4px;
        color: #0f5bd7;
        font-size: 10px;
        font-weight: 800;
        letter-spacing: .12em;
        text-transform: uppercase;
      }
      #${rootId} .gl-title {
        margin: 0;
        color: #102033;
        font-size: 14px;
        line-height: 1.28;
        font-weight: 800;
      }
      #${rootId} .gl-move-pill {
        flex: none;
        padding: 5px 7px;
        border-radius: 999px;
        background: rgba(15, 91, 215, .08);
        color: #0a3e96;
        font-size: 10px;
        font-weight: 800;
      }
      #${rootId} .gl-scan {
        height: 5px;
        margin-bottom: 8px;
        overflow: hidden;
        border-radius: 999px;
        background: rgba(15, 91, 215, 0.1);
      }
      #${rootId} .gl-scan span {
        display: block;
        width: 48%;
        height: 100%;
        border-radius: 999px;
        background: linear-gradient(90deg, rgba(15, 91, 215, 0), rgba(15, 91, 215, .9), rgba(17, 133, 109, .9));
        animation: gl-browser-scan 1.45s ease-in-out infinite;
      }
      #${rootId} .gl-steps {
        display: grid;
        gap: 8px;
      }
      #${rootId} .gl-chat-label {
        margin: 0 0 6px;
        color: #71839a;
        font-size: 10px;
        font-weight: 800;
        letter-spacing: .08em;
        text-transform: uppercase;
      }
      #${rootId} .gl-step {
        display: block;
        padding: 8px 9px;
        border: 1px solid rgba(35, 69, 104, 0.11);
        border-radius: 14px 14px 14px 5px;
        background: rgba(248, 251, 255, 0.9);
      }
      #${rootId} .gl-step-running {
        background: linear-gradient(135deg, rgba(15, 91, 215, .09), rgba(17, 133, 109, .08));
        border-color: rgba(15, 91, 215, .22);
      }
      #${rootId} .gl-step-attention {
        background: rgba(255, 247, 237, .96);
        border-color: rgba(183, 110, 17, .25);
      }
      #${rootId} .gl-dot {
        display: inline-block;
        width: 7px;
        height: 7px;
        margin: 0 6px 1px 0;
        border-radius: 999px;
        background: rgba(92, 113, 135, .45);
      }
      #${rootId} .gl-step-running .gl-dot {
        background: #0f5bd7;
        box-shadow: 0 0 0 8px rgba(15, 91, 215, .12);
      }
      #${rootId} .gl-step-done .gl-dot { background: #11856d; }
      #${rootId} .gl-step-attention .gl-dot { background: #b76e11; }
      #${rootId} .gl-step strong {
        display: inline;
        color: #102033;
        font-size: 12px;
        line-height: 1.25;
      }
      #${rootId} .gl-agent-name {
        display: inline-block;
        margin-right: 4px;
        color: #0f5bd7;
        font-size: 10px;
        font-weight: 900;
        text-transform: uppercase;
      }
      #${rootId} .gl-step p {
        margin: 4px 0 0;
        color: #5c7187;
        font-size: 11px;
        line-height: 1.38;
      }
      #${rootId} .gl-handoff-modal {
        position: fixed;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgba(7, 16, 31, 0.26);
        pointer-events: none;
      }
      #${rootId} .gl-handoff-card {
        width: min(420px, calc(100vw - 48px));
        padding: 18px 18px 16px;
        border: 1px solid rgba(183, 110, 17, 0.28);
        border-radius: 22px;
        background: linear-gradient(180deg, rgba(255, 252, 246, 0.98), rgba(255, 246, 232, 0.98));
        box-shadow: 0 28px 60px rgba(15, 23, 42, 0.22);
      }
      #${rootId} .gl-handoff-eyebrow {
        margin: 0 0 8px;
        color: #a35f0c;
        font-size: 10px;
        font-weight: 900;
        letter-spacing: .12em;
        text-transform: uppercase;
      }
      #${rootId} .gl-handoff-title {
        margin: 0 0 8px;
        color: #102033;
        font-size: 20px;
        line-height: 1.15;
        font-weight: 900;
      }
      #${rootId} .gl-handoff-detail {
        margin: 0;
        color: #334a62;
        font-size: 13px;
        line-height: 1.5;
      }
      #${rootId} .gl-handoff-hint {
        margin: 12px 0 0;
        color: #6a5a34;
        font-size: 11px;
        line-height: 1.45;
      }
      #${rootId} .gl-completion-modal {
        position: fixed;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgba(7, 16, 31, 0.18);
        pointer-events: none;
      }
      #${rootId} .gl-completion-card {
        width: min(440px, calc(100vw - 48px));
        padding: 18px 18px 16px;
        border: 1px solid rgba(15, 91, 215, 0.2);
        border-radius: 22px;
        background: linear-gradient(180deg, rgba(248, 252, 255, 0.98), rgba(240, 248, 255, 0.98));
        box-shadow: 0 28px 60px rgba(15, 23, 42, 0.2);
        pointer-events: auto;
      }
      #${rootId} .gl-completion-eyebrow {
        margin: 0 0 8px;
        color: #0f5bd7;
        font-size: 10px;
        font-weight: 900;
        letter-spacing: .12em;
        text-transform: uppercase;
      }
      #${rootId} .gl-completion-title {
        margin: 0 0 8px;
        color: #102033;
        font-size: 19px;
        line-height: 1.15;
        font-weight: 900;
      }
      #${rootId} .gl-completion-detail {
        margin: 0;
        color: #334a62;
        font-size: 13px;
        line-height: 1.5;
      }
      #${rootId} .gl-completion-actions {
        display: flex;
        gap: 10px;
        margin-top: 14px;
      }
      #${rootId} .gl-completion-button {
        appearance: none;
        border: 0;
        border-radius: 14px;
        padding: 11px 14px;
        font: inherit;
        font-size: 12px;
        font-weight: 800;
        cursor: pointer;
      }
      #${rootId} .gl-completion-button-secondary {
        background: rgba(15, 91, 215, 0.08);
        color: #0a3e96;
      }
      #${rootId} .gl-completion-button-primary {
        background: linear-gradient(135deg, #0f5bd7, #11856d);
        color: white;
      }
      #${rootId} .gl-completion-feedback {
        margin: 10px 0 0;
        color: #49607a;
        font-size: 11px;
        line-height: 1.4;
      }
      @keyframes gl-browser-scan {
        from { transform: translateX(-110%); }
        to { transform: translateX(260%); }
      }
    `;
    root.appendChild(style);

    const handle = document.createElement("div");
    handle.className = "gl-drag-handle";

    const heading = document.createElement("div");
    const eyebrow = document.createElement("p");
    eyebrow.className = "gl-eyebrow";
    eyebrow.textContent = "GradLaunch live agent";
    heading.appendChild(eyebrow);

    const title = document.createElement("p");
    title.className = "gl-title";
    title.textContent = "Agent chat: live application run";
    heading.appendChild(title);
    handle.appendChild(heading);

    const movePill = document.createElement("span");
    movePill.className = "gl-move-pill";
    movePill.textContent = "Drag";
    handle.appendChild(movePill);
    root.appendChild(handle);

    const scan = document.createElement("div");
    scan.className = "gl-scan";
    scan.appendChild(document.createElement("span"));
    root.appendChild(scan);

    const list = document.createElement("div");
    list.className = "gl-steps";
    const chatLabel = document.createElement("p");
    chatLabel.className = "gl-chat-label";
    chatLabel.textContent = "Agent conversation";
    list.appendChild(chatLabel);

    for (const step of agentSteps) {
      const item = document.createElement("article");
      item.className = `gl-step gl-step-${step.state}`;

      const dot = document.createElement("span");
      dot.className = "gl-dot";
      const speaker = document.createElement("span");
      speaker.className = "gl-agent-name";
      speaker.textContent = step.state === "attention" ? "Pause" : "Agent";
      const label = document.createElement("strong");
      label.textContent = step.label;
      const detail = document.createElement("p");
      detail.textContent = step.detail;
      item.appendChild(dot);
      item.appendChild(speaker);
      item.appendChild(label);
      item.appendChild(detail);
      list.appendChild(item);
    }

    root.appendChild(list);

    const attentionStep = agentSteps.find((step) => step.state === "attention");
    const protectedAttentionStep = attentionStep && /captcha|otp|verification|password|login|log in|sign in|security check|protected checkpoint|human intervention needed/i.test(`${attentionStep.label} ${attentionStep.detail}`)
      ? attentionStep
      : undefined;
    const completionStep = !attentionStep
      ? agentSteps.find((step) => /form is filled|ready for your final review|submit directly|form ready/i.test(`${step.label} ${step.detail}`))
      : undefined;

    if (protectedAttentionStep) {
      const modal = document.createElement("div");
      modal.className = "gl-handoff-modal";

      const modalCard = document.createElement("div");
      modalCard.className = "gl-handoff-card";

      const modalEyebrow = document.createElement("p");
      modalEyebrow.className = "gl-handoff-eyebrow";
      modalEyebrow.textContent = "Manual intervention needed";
      modalCard.appendChild(modalEyebrow);

      const modalTitle = document.createElement("h2");
      modalTitle.className = "gl-handoff-title";
      modalTitle.textContent = protectedAttentionStep.label;
      modalCard.appendChild(modalTitle);

      const modalDetail = document.createElement("p");
      modalDetail.className = "gl-handoff-detail";
      modalDetail.textContent = protectedAttentionStep.detail;
      modalCard.appendChild(modalDetail);

      const modalHint = document.createElement("p");
      modalHint.className = "gl-handoff-hint";
      modalHint.textContent = "Complete the step in this browser window. GradLaunch is monitoring the page and this popup will close automatically when the run resumes.";
      modalCard.appendChild(modalHint);

      modal.appendChild(modalCard);
      root.appendChild(modal);
    } else if (completionStep) {
      const modal = document.createElement("div");
      modal.className = "gl-completion-modal";

      const modalCard = document.createElement("div");
      modalCard.className = "gl-completion-card";

      const eyebrow = document.createElement("p");
      eyebrow.className = "gl-completion-eyebrow";
      eyebrow.textContent = "Form filled";
      modalCard.appendChild(eyebrow);

      const title = document.createElement("h2");
      title.className = "gl-completion-title";
      title.textContent = "Ready for review or direct submit";
      modalCard.appendChild(title);

      const detail = document.createElement("p");
      detail.className = "gl-completion-detail";
      detail.textContent = completionStep.detail;
      modalCard.appendChild(detail);

      const actions = document.createElement("div");
      actions.className = "gl-completion-actions";

      const reviewButton = document.createElement("button");
      reviewButton.type = "button";
      reviewButton.className = "gl-completion-button gl-completion-button-secondary";
      reviewButton.textContent = "Review form";

      const submitButton = document.createElement("button");
      submitButton.type = "button";
      submitButton.className = "gl-completion-button gl-completion-button-primary";
      submitButton.textContent = "Submit directly";

      const feedback = document.createElement("p");
      feedback.className = "gl-completion-feedback";
      feedback.textContent = "Review the filled page, then submit when you are ready.";

      reviewButton.onclick = () => {
        modal.remove();
      };

      submitButton.onclick = () => {
        const clicked = clickVisibleSubmitControl();
        feedback.textContent = clicked
          ? "GradLaunch clicked the visible final submit control."
          : "No visible final submit control was found on this page yet.";
      };

      actions.appendChild(reviewButton);
      actions.appendChild(submitButton);
      modalCard.appendChild(actions);
      modalCard.appendChild(feedback);
      modal.appendChild(modalCard);
      root.appendChild(modal);
    }

    attachDrag(root, handle);

    function clickVisibleSubmitControl() {
      const controls = Array.from(document.querySelectorAll("button, input[type='submit'], input[type='button'], a")) as Array<HTMLButtonElement | HTMLInputElement | HTMLAnchorElement>;
      const candidate = controls.find((control) => {
        const rect = control.getBoundingClientRect();

        if (rect.width <= 0 || rect.height <= 0 || control.getAttribute("aria-disabled") === "true") {
          return false;
        }

        if ("disabled" in control && control.disabled) {
          return false;
        }

        const text = `${control.textContent ?? ""} ${"value" in control ? control.value : ""} ${control.getAttribute("aria-label") ?? ""}`.toLowerCase();
        return /\b(submit application|submit my application|submit|send application|send my application)\b/.test(text);
      });

      if (!candidate) {
        return false;
      }

      candidate.click();
      return true;
    }

    function attachDrag(panel: HTMLElement, handleElement: HTMLElement) {
      let dragging = false;
      let offsetX = 0;
      let offsetY = 0;

      handleElement.onmousedown = (event) => {
        dragging = true;
        const rect = panel.getBoundingClientRect();
        offsetX = event.clientX - rect.left;
        offsetY = event.clientY - rect.top;
        panel.classList.add("gl-dragged");
        event.preventDefault();
      };

      document.onmousemove = (event) => {
        if (!dragging) {
          return;
        }

        const left = Math.min(Math.max(8, event.clientX - offsetX), window.innerWidth - panel.offsetWidth - 8);
        const top = Math.min(Math.max(8, event.clientY - offsetY), window.innerHeight - panel.offsetHeight - 8);
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
      };

      document.onmouseup = () => {
        dragging = false;
      };
    }
  }, steps).catch(() => undefined);
}

async function isLikelyVisibleField(page: Page, label: string) {
  const aliases = getFieldAliases(label).map(normalizeKey);

  return page.evaluate((normalizedAliases) => {
    const controls = getControls();

    return controls.some((control) => {
      if (control instanceof HTMLInputElement && ["hidden", "file", "submit", "button"].includes(control.type)) {
        return false;
      }

      const rect = control.getBoundingClientRect();

      if (rect.width <= 0 || rect.height <= 0) {
        return false;
      }

      const descriptor = normalize([
        control.getAttribute("aria-label"),
        control.getAttribute("placeholder"),
        control.getAttribute("name"),
        control.id,
        control.closest("label, div, section, article")?.textContent
      ].filter(Boolean).join(" "));

      if (!descriptor) {
        return false;
      }

      return normalizedAliases.some((alias) => descriptor.includes(alias) || alias.includes(descriptor));
    });

    function normalize(value: string) {
      return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    }

    function getControls() {
      const roots = getSearchRoots();
      return roots.flatMap((root) => Array.from(root.querySelectorAll("input, textarea, select"))) as Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>;
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
  }, aliases).catch(() => false);
}

async function getVisibleRequiredEmptyLabels(page: Page) {
  const labels: string[] = [];

  for (const frame of page.frames()) {
    const frameLabels = await frame.evaluate(() => {
      const searchRoots = getSearchRoots();
      const controls = searchRoots.flatMap((root) => Array.from(root.querySelectorAll("input, textarea, select"))) as Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>;

      return controls
        .filter((control) => {
          if (control instanceof HTMLInputElement && ["hidden", "file", "submit", "button"].includes(control.type)) {
            return false;
          }

          const rect = control.getBoundingClientRect();

          if (rect.width <= 0 || rect.height <= 0 || !isRequired(control)) {
            return false;
          }

          if (control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type)) {
            const group = control.name
              ? searchRoots.flatMap((root) => Array.from(root.querySelectorAll(`input[name="${CSS.escape(control.name)}"]`))) as HTMLInputElement[]
              : [control];
            return !group.some((item) => item.checked);
          }

          return !control.value.trim();
        })
        .map((control) => findFieldLabel(control))
        .filter(Boolean);

      function isRequired(control: Element) {
        const label = findFieldLabel(control);
        return (control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).required
          || control.getAttribute("aria-required") === "true"
          || /\*/.test(label)
          || control.closest(".required, [class*='required'], [data-required='true']");
      }

      function findFieldLabel(control: Element) {
        if (control.id) {
          const label = queryFirst(`label[for="${CSS.escape(control.id)}"]`, control);

          if (label?.textContent?.trim()) {
            return clean(label.textContent);
          }
        }

        const ariaLabelledBy = control.getAttribute("aria-labelledby");

        if (ariaLabelledBy) {
          const labelled = describedByText(ariaLabelledBy);

          if (labelled.trim()) {
            return clean(labelled);
          }
        }

        const labelParent = control.closest("label");

        if (labelParent?.textContent?.trim()) {
          return clean(labelParent.textContent);
        }

        const containerText = clean([
          control.closest(".mat-mdc-form-field, .mat-form-field, .form-group, .form-field, .field, [role='group']")?.querySelector("label, legend, .mat-mdc-floating-label, .mdc-floating-label, .mat-form-field-label")?.textContent,
          control.previousElementSibling?.textContent,
          control.parentElement?.previousElementSibling?.textContent,
          control.parentElement?.parentElement?.previousElementSibling?.textContent,
          control.closest("fieldset")?.textContent,
          control.closest("[role='group']")?.textContent
        ].filter(Boolean).join(" "));

        if (containerText.trim()) {
          return containerText;
        }

        const direct = [
          control.getAttribute("aria-label"),
          control.getAttribute("placeholder"),
          control.getAttribute("name"),
          isSyntheticFieldToken(control.id) ? "" : control.id
        ].filter(Boolean).join(" ");

        if (direct.trim()) {
          return clean(direct);
        }

        return "";
      }

      function describedByText(ids: string) {
        return ids
          .split(/\s+/)
          .map((id) => getElementById(id)?.textContent ?? "")
          .join(" ");
      }

      function clean(value: string | null | undefined) {
        return (value ?? "").replace(/\s+/g, " ").replace(/\*/g, "").trim().slice(0, 120);
      }

      function isSyntheticFieldToken(value: string | null | undefined) {
        const token = (value ?? "").trim();
        return /^(mat-input-\d+|input[_-]?\d+|field[_-]?\d+|ctl\d+|ember\d+|cdk-[a-z0-9-]+|mui-\d+|react-select-\d+-input)$/i.test(token);
      }

      function queryFirst(selector: string, control: Element) {
        const root = control.getRootNode();

        if (root instanceof Document || root instanceof ShadowRoot || root instanceof Element) {
          const withinRoot = root.querySelector(selector);

          if (withinRoot) {
            return withinRoot;
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
    }).catch(() => []);

    labels.push(...frameLabels);
  }

  return dedupeLabels(labels);
}

async function autoResolveConsentControls(page: Page) {
  let resolvedCount = 0;

  for (const frame of page.frames()) {
    const resolved = await frame.evaluate(() => {
      const controls = getSearchRoots().flatMap((root) => Array.from(root.querySelectorAll("input[type='checkbox'], input[type='radio']"))) as HTMLInputElement[];
      let count = 0;

      for (const control of controls) {
        const rect = control.getBoundingClientRect();

        if (rect.width <= 0 || rect.height <= 0 || control.disabled || control.checked) {
          continue;
        }

        const descriptor = normalize([
          findLabelText(control),
          control.getAttribute("aria-label"),
          control.getAttribute("name"),
          control.id,
          control.closest("label, fieldset, [role='group'], .mat-mdc-form-field, .mat-form-field")?.textContent
        ].filter(Boolean).join(" "));

        if (!/\b(terms|privacy|consent|agree|acknowledge|accept|declaration|storage and handling|i agree)\b/.test(descriptor)) {
          continue;
        }

        if (/\b(country|countries|location|locations|remote|relocat|work permit|sponsor|sponsorship|whatsapp|sms|text messages)\b/.test(descriptor)) {
          continue;
        }

        control.click();
        control.dispatchEvent(new Event("input", { bubbles: true }));
        control.dispatchEvent(new Event("change", { bubbles: true }));
        count += 1;
      }

      return count;

      function findLabelText(control: HTMLInputElement) {
        if (control.id) {
          const root = control.getRootNode();
          const label = ((root instanceof Document || root instanceof ShadowRoot || root instanceof Element)
            ? root.querySelector(`label[for="${CSS.escape(control.id)}"]`)
            : null)
            ?? getSearchRoots().map((searchRoot) => searchRoot.querySelector(`label[for="${CSS.escape(control.id)}"]`)).find(Boolean)
            ?? null;

          if (label?.textContent?.trim()) {
            return label.textContent.trim();
          }
        }

        return control.closest("label")?.textContent?.trim()
          || control.parentElement?.textContent?.trim()
          || "";
      }

      function normalize(value: string) {
        return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
    }).catch(() => 0);

    resolvedCount += resolved;
  }

  return resolvedCount;
}

async function getVisibleValidationMessages(page: Page) {
  const messages: string[] = [];

  for (const frame of page.frames()) {
    const frameMessages = await frame.evaluate(() => {
      const selectors = [
        "[role='alert']",
        "[aria-live='assertive']",
        ".error",
        ".errors",
        ".field-error",
        ".validation-error",
        ".form-error"
      ];
      const values = new Set<string>();

      for (const selector of selectors) {
        const elements = Array.from(document.querySelectorAll(selector));

        for (const element of elements) {
          const htmlElement = element as HTMLElement;
          const rect = htmlElement.getBoundingClientRect();
          const text = element.textContent?.replace(/\s+/g, " ").trim();

          if (!text || rect.width <= 0 || rect.height <= 0) {
            continue;
          }

          values.add(text.length > 160 ? `${text.slice(0, 157)}...` : text);
        }
      }

      return Array.from(values).slice(0, 4);
    }).catch(() => []);

    messages.push(...frameMessages);
  }

  return dedupeLabels(messages);
}

async function markFieldsNeedingInput(page: Page, labels: string[]) {
  await page.evaluate((fieldLabels) => {
    const normalizedLabels = fieldLabels.map(normalize).filter(Boolean);
    const controls = getSearchRoots().flatMap((root) => Array.from(root.querySelectorAll("input, textarea, select"))) as Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>;

    for (const control of controls) {
      const descriptor = normalize([
        control.getAttribute("aria-label"),
        control.getAttribute("placeholder"),
        control.getAttribute("name"),
        control.id,
        findLabelText(control),
        control.closest("fieldset")?.textContent,
        control.parentElement?.textContent
      ].filter(Boolean).join(" "));

      if (!descriptor || !normalizedLabels.some((label) => descriptor.includes(label) || label.includes(descriptor))) {
        continue;
      }

      control.style.outline = "3px solid #b76e11";
      control.style.outlineOffset = "3px";
      control.scrollIntoView({ block: "center", inline: "center" });
    }

    function normalize(value: string) {
      return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    }

    function findLabelText(control: Element) {
      if (control.id) {
        const searchRoots = getSearchRoots();
        const root = control.getRootNode();
        const label = ((root instanceof Document || root instanceof ShadowRoot || root instanceof Element)
          ? root.querySelector(`label[for="${CSS.escape(control.id)}"]`)
          : null)
          ?? searchRoots.map((searchRoot) => searchRoot.querySelector(`label[for="${CSS.escape(control.id)}"]`)).find(Boolean)
          ?? null;

        if (label?.textContent) {
          return label.textContent;
        }
      }

      return control.closest("label")?.textContent ?? control.previousElementSibling?.textContent ?? "";
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
  }, labels).catch(() => undefined);
}

async function hasFinalSubmitControl(page: Page) {
  const protectedCheckpoint = await detectProtectedCheckpoint(page);

  if (protectedCheckpoint.blocked) {
    return false;
  }

  return page.evaluate(() => {
    const controls = getSearchRoots().flatMap((root) => Array.from(root.querySelectorAll("button, input[type='submit'], input[type='button'], a"))) as Array<HTMLButtonElement | HTMLInputElement | HTMLAnchorElement>;

    return controls.some((control) => {
      const rect = control.getBoundingClientRect();

      if (rect.width <= 0 || rect.height <= 0 || control.getAttribute("aria-disabled") === "true") {
        return false;
      }

      if ("disabled" in control && control.disabled) {
        return false;
      }

      const text = `${control.textContent ?? ""} ${"value" in control ? control.value : ""} ${control.getAttribute("aria-label") ?? ""}`.toLowerCase();
      return /\b(submit application|submit my application|submit|send application|send my application)\b/.test(text);
    });

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
  }).catch(() => false);
}

async function clickNextStageControl(context: BrowserContext, page: Page, options: { allowApplyStart: boolean }) {
  const labels = [
    "Continue",
    "Next",
    "Save and continue",
    "Save & continue",
    "Continue to review",
    "Review application",
    "Review",
    "Proceed",
    "Start application",
    "Start",
    ...(options.allowApplyStart ? ["Apply", "Apply now", "Apply for this job", "Apply for this position"] : []),
    "I'm interested",
    "I’m interested"
  ];

  for (const label of labels) {
    const clicked = await clickRoleControl(context, page, label, options);

    if (clicked.clicked) {
      return clicked;
    }
  }

  return clickDomNextControl(context, page, options);
}

async function clickRoleControl(context: BrowserContext, page: Page, label: string, options: { allowApplyStart: boolean }) {
  const locators = [
    page.getByRole("button", { name: label, exact: false }),
    page.getByRole("link", { name: label, exact: false })
  ];

  for (const locator of locators) {
    const count = await locator.count().catch(() => 0);

    for (let index = 0; index < Math.min(count, 4); index += 1) {
      const candidate = locator.nth(index);

      try {
        const text = await candidate.innerText({ timeout: 700 }).catch(() => label);

        if (isFinalSubmitText(text) || (!options.allowApplyStart && isApplyStartText(text))) {
          continue;
        }

        await candidate.scrollIntoViewIfNeeded({ timeout: 1000 });
        const nextPagePromise = context.waitForEvent("page", { timeout: 2500 }).catch(() => undefined);
        await candidate.click({ timeout: 1500 });
        const nextPage = await nextPagePromise;
        return {
          clicked: true,
          page: nextPage ?? page
        };
      } catch (_error) {
        // Try the next candidate.
      }
    }
  }

  return {
    clicked: false,
    page
  };
}

async function clickDomNextControl(context: BrowserContext, page: Page, options: { allowApplyStart: boolean }) {
  const nextPagePromise = context.waitForEvent("page", { timeout: 2500 }).catch(() => undefined);
  const clicked = await page.evaluate((allowApplyStart) => {
    const controls = getSearchRoots().flatMap((root) => Array.from(root.querySelectorAll("button, input[type='button'], input[type='submit'], a"))) as Array<HTMLButtonElement | HTMLInputElement | HTMLAnchorElement>;
    const candidates = controls
      .map((control, index) => ({ control, index, score: scoreControl(control) }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score);
    const best = candidates[0];

    if (!best) {
      return false;
    }

    best.control.scrollIntoView({ block: "center", inline: "center" });
    best.control.click();
    return true;

    function scoreControl(control: HTMLButtonElement | HTMLInputElement | HTMLAnchorElement) {
      const rect = control.getBoundingClientRect();

      if (rect.width <= 0 || rect.height <= 0 || control.getAttribute("aria-disabled") === "true") {
        return 0;
      }

      if ("disabled" in control && control.disabled) {
        return 0;
      }

      const text = `${control.textContent ?? ""} ${"value" in control ? control.value : ""} ${control.getAttribute("aria-label") ?? ""}`.toLowerCase();

      if (/\b(submit application|submit my application|submit|send application|send my application)\b/.test(text)) {
        return 0;
      }

      if (/save\s*(and|&)\s*continue|continue to review|review application/.test(text)) {
        return 100;
      }

      if (/\bcontinue\b|\bnext\b|\breview\b|\bproceed\b/.test(text)) {
        return 90;
      }

      if (/i'm interested|i’m interested|start application/.test(text)) {
        return 70;
      }

      if (allowApplyStart && /\bapply\b|apply now|apply for this job|apply for this position/.test(text)) {
        return 70;
      }

      return 0;
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
  }, options.allowApplyStart).catch(() => false);

  if (!clicked) {
    return {
      clicked: false,
      page
    };
  }

  const nextPage = await nextPagePromise;
  return {
    clicked: true,
    page: nextPage ?? page
  };
}

async function getPageFingerprint(page: Page) {
  return page.evaluate(() => {
    const controls = getSearchRoots().flatMap((root) => Array.from(root.querySelectorAll("input, textarea, select"))) as Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>;
    const visibleControlKeys = controls
      .filter((control) => {
        const rect = control.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !(control instanceof HTMLInputElement && control.type === "hidden");
      })
      .slice(0, 20)
      .map((control) => [
        control.tagName,
        control.getAttribute("type"),
        control.getAttribute("name"),
        control.id,
        control.getAttribute("placeholder"),
        control.getAttribute("aria-label")
      ].filter(Boolean).join(":"));

    return `${window.location.href}|${visibleControlKeys.join("|")}`;

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
  }).catch(() => page.url());
}

function isFinalSubmitText(value: string) {
  return /\b(submit application|submit my application|submit|send application|send my application)\b/i.test(value);
}

function isApplyStartText(value: string) {
  return /\bapply\b|apply now|apply for this job|apply for this position/i.test(value);
}

async function observeBrowserPage(page: Page, visibleFields: VisibleField[]): Promise<BrowserAgentObservation> {
  const validationMessages = await getVisibleValidationMessages(page);
  const domObservation = await page.evaluate(() => {
    const searchRoots = getSearchRoots();
    const candidates = searchRoots.flatMap((root) => Array.from(root.querySelectorAll("button, a, input, textarea, select, [role='button'], [role='link']"))) as HTMLElement[];
    const controls: ObservedControl[] = [];

    for (const [index, element] of candidates.entries()) {
      const rect = element.getBoundingClientRect();

      if (rect.width <= 0 || rect.height <= 0) {
        continue;
      }

      const id = `gl-agent-control-${index}`;
      element.setAttribute("data-gradlaunch-control-id", id);
      const input = element instanceof HTMLInputElement ? element : undefined;
      const label = findControlLabel(element);
      const text = [
        element.textContent,
        input?.value,
        element.getAttribute("aria-label"),
        element.getAttribute("placeholder"),
        label
      ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

      controls.push({
        id,
        text,
        tagName: element.tagName.toLowerCase(),
        role: element.getAttribute("role") ?? "",
        inputType: input?.type ?? "",
        label,
        disabled: Boolean((element as HTMLButtonElement | HTMLInputElement).disabled) || element.getAttribute("aria-disabled") === "true"
      });
    }

    return {
      title: document.title,
      pageText: document.body?.innerText?.replace(/\s+/g, " ").slice(0, 3000) ?? "",
      controls
    };

    function findControlLabel(element: Element) {
      if (element.id) {
        const root = element.getRootNode();
        const directLabel = ((root instanceof Document || root instanceof ShadowRoot || root instanceof Element)
          ? root.querySelector(`label[for="${CSS.escape(element.id)}"]`)
          : null)
          ?? searchRoots.map((searchRoot) => searchRoot.querySelector(`label[for="${CSS.escape(element.id)}"]`)).find(Boolean)
          ?? null;

        if (directLabel?.textContent?.trim()) {
          return directLabel.textContent.trim();
        }
      }

      return element.closest("label")?.textContent?.trim()
        ?? element.getAttribute("aria-label")
        ?? element.getAttribute("placeholder")
        ?? element.getAttribute("name")
        ?? "";
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
  }).catch(() => ({ title: "", pageText: "", controls: [] as ObservedControl[] }));

  const adapter = resolveAtsAdapter(page.url());
  const groupedFields = groupVisibleFields(visibleFields);
  const pageState = classifyBrowserPageState({
    url: page.url(),
    title: domObservation.title,
    pageText: domObservation.pageText,
    visibleFields,
    controls: domObservation.controls.filter((control) => !control.disabled),
    validationMessages,
    groupedFields,
    adapter
  });

  return {
    url: page.url(),
    title: domObservation.title,
    pageText: domObservation.pageText,
    visibleFields,
    controls: domObservation.controls.filter((control) => !control.disabled),
    pageState,
    validationMessages,
    groupedFields,
    adapter
  };
}

function resolveAtsAdapter(url: string): AtsAdapterHint | undefined {
  const hostname = safeHostname(url);

  if (/smartrecruiters\.com$/i.test(hostname)) {
    return { id: "smartrecruiters", label: "SmartRecruiters" };
  }

  if (/greenhouse\.io$/i.test(hostname)) {
    return { id: "greenhouse", label: "Greenhouse" };
  }

  if (/lever\.co$/i.test(hostname)) {
    return { id: "lever", label: "Lever" };
  }

  if (/myworkdayjobs\.com$/i.test(hostname) || /workday/i.test(hostname)) {
    return { id: "workday", label: "Workday" };
  }

  if (/ashbyhq\.com$/i.test(hostname)) {
    return { id: "ashby", label: "Ashby" };
  }

  return undefined;
}

function groupVisibleFields(visibleFields: VisibleField[]): BrowserFieldGroup[] {
  const groups = new Map<string, BrowserFieldGroup>();

  for (const field of visibleFields) {
    const groupLabel = deriveFieldGroupLabel(field);
    const key = normalizeKey(groupLabel);

    if (!key) {
      continue;
    }

    const existing = groups.get(key) ?? {
      label: groupLabel,
      fieldIds: [],
      fieldLabels: [],
      required: false
    };

    existing.fieldIds.push(field.id);
    existing.fieldLabels.push(field.label);
    existing.required = existing.required || field.required;
    groups.set(key, existing);
  }

  return [...groups.values()]
    .filter((group) => group.fieldIds.length > 1)
    .map((group) => ({
      ...group,
      fieldLabels: dedupeLabels(group.fieldLabels)
    }))
    .slice(0, 8);
}

function deriveFieldGroupLabel(field: VisibleField) {
  const context = field.context.replace(/\s+/g, " ").trim();

  if (context) {
    const trimmedContext = context.split(/\.\s+/)[0]?.trim() ?? context;

    if (trimmedContext.length >= 6) {
      return trimmedContext.slice(0, 120);
    }
  }

  const label = field.label.replace(/\s+/g, " ").trim();
  const beforeColon = label.split(":")[0]?.trim() ?? label;
  return beforeColon.slice(0, 120);
}

function classifyBrowserPageState(input: Omit<BrowserAgentObservation, "pageState">): BrowserPageState {
  const text = normalizeKey([
    input.title,
    input.pageText,
    ...input.validationMessages
  ].join(" "));
  const hasVisibleFields = input.visibleFields.length > 0;
  const hasPasswordField = input.visibleFields.some((field) => field.inputType === "password" || /\bpassword\b/i.test(field.label));
  const hasResumeUploadField = input.visibleFields.some((field) => field.inputType === "file")
    || input.controls.some((control) => /upload resume|upload cv|attach resume|choose file|select resume|autofill with resume/.test(normalizeKey(`${control.text} ${control.label}`)));
  const hasConsentLanguage = /\b(privacy|terms|consent|agree|acknowledge|declaration|data processing|equal opportunity|eeo|voluntary self identification)\b/.test(text);
  const hasReviewLanguage = /\b(review your application|review application|application review|confirm your application|preview)\b/.test(text);
  const hasSubmitLanguage = /\b(submit application|submit my application|send application|complete application)\b/.test(text);
  const hasApplyStart = input.controls.some((control) => isApplyStartText(`${control.text} ${control.label}`));
  const hasQuestionnaireHints = input.groupedFields.length > 0
    || input.visibleFields.some((field) => field.options.length > 0 || field.inputType === "radio" || field.inputType === "checkbox")
    || /\b(questionnaire|screening question|additional question|work authorization|salary expectation|notice period)\b/.test(text);

  if (hasPasswordField || /\b(sign in|log in|login|password)\b/.test(text)) {
    return "login";
  }

  if (hasResumeUploadField && !hasVisibleFields) {
    return "resume_upload";
  }

  if (hasSubmitLanguage) {
    return "submit";
  }

  if (hasReviewLanguage) {
    return "review";
  }

  if (hasConsentLanguage && hasVisibleFields) {
    return "consent";
  }

  if (hasQuestionnaireHints && hasVisibleFields) {
    return "questionnaire";
  }

  if (hasApplyStart && !hasVisibleFields) {
    return "start";
  }

  if (hasVisibleFields) {
    return "account_gate";
  }

  if (!text && input.controls.length === 0) {
    return "empty";
  }

  return "unknown";
}

async function decideBrowserAgentAction(input: {
  observation: BrowserAgentObservation;
  fields: FilledField[];
  job: Job;
  resumeAvailable: boolean;
  allowExternalSubmit: boolean;
}): Promise<BrowserAgentAction> {
  const hasVisiblePasswordField = input.observation.visibleFields.some((field) => field.inputType === "password" || /\bpassword\b/i.test(field.label));

  if (input.observation.pageState === "submit" && !input.allowExternalSubmit) {
    return {
      kind: "stop",
      reason: "The page is already at a submit/review gate, so the agent should pause instead of guessing another step.",
      source: "system"
    };
  }

  if (input.observation.pageState === "consent" || input.observation.pageState === "questionnaire") {
    return {
      kind: "fill",
      reason: `This screen looks like a ${input.observation.pageState} step, so the agent should fill grouped questions before trying to navigate.`,
      source: "system"
    };
  }

  // When the page already shows fillable inputs, the agent should enter the
  // field-fill planner directly instead of letting the higher-level action
  // planner invent a "wait/click elsewhere" step.
  if (input.observation.visibleFields.length > 0 && !hasVisiblePasswordField) {
    return {
      kind: "fill",
      reason: `Visible fields detected (${summarizeVisibleFields(input.observation.visibleFields)}), so the agent is switching directly into field filling.`,
      source: "system"
    };
  }

  if (process.env.BROWSER_AGENT_LLM_ENABLED === "true" && isLlmProviderConfigured()) {
    const llmAction = await decideBrowserAgentActionWithLlm(input).catch(() => undefined);

    if (llmAction && isValidBrowserAgentAction(llmAction, input.observation, input.allowExternalSubmit)) {
      return llmAction;
    }
  }

  return decideBrowserAgentActionHeuristically(input);
}

function isValidBrowserAgentAction(action: BrowserAgentAction, observation: BrowserAgentObservation, allowExternalSubmit: boolean) {
  if (action.kind === "click" || action.kind === "upload_resume") {
    const control = action.controlId
      ? observation.controls.find((candidate) => candidate.id === action.controlId)
      : undefined;

    if (action.controlId && !control) {
      return false;
    }

    if (action.kind === "click" && control && isObservedFinalSubmitControl(control)) {
      return allowExternalSubmit && observation.visibleFields.length === 0;
    }

    return true;
  }

  return true;
}

function isObservedFinalSubmitControl(control: ObservedControl) {
  return isFinalSubmitText(`${control.text} ${control.label}`);
}

function decideBrowserAgentActionHeuristically(input: {
  observation: BrowserAgentObservation;
  fields: FilledField[];
  job: Job;
  resumeAvailable: boolean;
  allowExternalSubmit: boolean;
}): BrowserAgentAction {
  const text = normalizeKey(input.observation.pageText);
  const controls = input.observation.controls.map((control) => ({
    ...control,
    normalized: normalizeKey(`${control.text} ${control.label}`)
  }));

  const passwordField = input.observation.visibleFields.find((field) => field.inputType === "password" || /\bpassword\b/i.test(field.label));
  const hostname = safeHostname(input.observation.url);
  const isLinkedIn = /(^|\.)linkedin\.com$/i.test(hostname);

  if (input.observation.validationMessages.length > 0 && input.observation.visibleFields.length > 0) {
    return {
      kind: "fill",
      reason: `Validation errors are visible (${input.observation.validationMessages.join(", ")}), so the agent should repair the current form step before navigating.`,
      source: "heuristic"
    };
  }

  if (input.observation.pageState === "review" || input.observation.pageState === "submit") {
    return {
      kind: input.allowExternalSubmit ? "fill" : "stop",
      reason: input.allowExternalSubmit
        ? "The page is at a review/submit gate, so the agent will let the stage executor handle the final submission logic."
        : "The page is already at a review/submit gate, so the agent should pause for review.",
      source: "heuristic"
    };
  }

  if (passwordField) {
    const credentials = getAtsCredentialsForHost(hostname, input.fields);

    if (!credentials.password) {
      return {
        kind: "ask_user",
        fields: ["Password"],
        reason: isLinkedIn
          ? "LinkedIn requires the student's password or an active signed-in browser session. The agent cannot guess or bypass this."
          : "This portal requires an account password. The agent needs saved credentials or manual student input.",
        source: "heuristic"
      };
    }

    return {
      kind: "fill",
      reason: "Saved account credentials are available, so the form filler can populate the login fields.",
      source: "heuristic"
    };
  }

  if (input.resumeAvailable) {
    const uploadControl = controls.find((control) => /autofill with resume|upload resume|upload cv|attach resume|choose file|select resume/.test(control.normalized));

    if (uploadControl) {
      return {
        kind: "upload_resume",
        controlId: uploadControl.id,
        reason: `Detected resume upload action: ${uploadControl.text || uploadControl.label}.`,
        source: "heuristic"
      };
    }
  }

  if (input.observation.visibleFields.length > 0) {
    return {
      kind: "fill",
      reason: "Visible form fields are available, so the agent will fill the current stage.",
      source: "heuristic"
    };
  }

  const startControl = controls.find((control) => /apply now|apply for this job|apply for this position|start application|begin application|\bapply\b/.test(control.normalized));

  if (startControl) {
    return {
      kind: "click",
      controlId: startControl.id,
      reason: `Detected application start action: ${startControl.text || startControl.label}.`,
      source: "heuristic"
    };
  }

  const nextControl = controls.find((control) => /continue|next|proceed|review application|save and continue|save continue/.test(control.normalized));

  if (nextControl) {
    return {
      kind: "click",
      controlId: nextControl.id,
      reason: `Detected stage navigation action: ${nextControl.text || nextControl.label}.`,
      source: "heuristic"
    };
  }

  if (/captcha|verify you are human|i m not a robot|i am not a robot|recaptcha|hcaptcha|turnstile|cloudflare|security check|press and hold|otp|verification code|one time passcode|one time code|two factor|2fa|mfa/.test(text)) {
    return {
      kind: "ask_user",
      fields: ["Human verification"],
      reason: "Human intervention needed: complete the captcha, OTP, or security verification in the open browser. GradLaunch is monitoring the page and will resume automatically once the checkpoint clears.",
      source: "heuristic"
    };
  }

  return {
    kind: "fill",
    reason: "No higher-confidence action was detected; trying normal field filling.",
    source: "heuristic"
  };
}

async function decideBrowserAgentActionWithLlm(input: {
  observation: BrowserAgentObservation;
  fields: FilledField[];
  job: Job;
  resumeAvailable: boolean;
  allowExternalSubmit: boolean;
}): Promise<BrowserAgentAction | undefined> {
  const messages = [
    {
      role: "system",
      content: [
        "You are a browser job-application agent.",
        "Choose exactly one next action from the current page observation.",
        "Never bypass captcha, OTP, passwords, payment, identity, or security checks.",
        "Classify the page state from the observation and choose an action that matches that state.",
        "Prefer upload_resume when a resume upload/autofill control is visible and resumeAvailable is true.",
        "Prefer click for Apply/Continue/Next/Review buttons when no fields should be filled yet.",
        "Prefer fill when normal text/select/radio fields are visible.",
        "If validation errors are visible on the current screen, prefer fill over click so the agent repairs the current state first.",
        "Prefer ask_user for password, login MFA, OTP, captcha, payment, or identity verification.",
        "Return compact JSON only: {\"kind\":\"fill|click|upload_resume|ask_user|stop\",\"controlId\":\"optional\",\"fields\":[\"optional\"],\"reason\":\"short\"}."
      ].join(" ")
    },
    {
      role: "user",
      content: JSON.stringify({
        url: input.observation.url,
        title: input.observation.title,
        pageText: input.observation.pageText,
        pageState: input.observation.pageState,
        visibleFields: input.observation.visibleFields,
        groupedFields: input.observation.groupedFields,
        validationMessages: input.observation.validationMessages,
        controls: input.observation.controls.slice(0, 60),
        resumeAvailable: input.resumeAvailable,
        allowExternalSubmit: input.allowExternalSubmit,
        job: {
          title: input.job.title,
          company: input.job.company
        }
      })
    }
  ];
  const content = getLlmProvider() === "ollama"
    ? await callOllamaAnswer(messages)
    : await callOpenAiAnswer(messages);

  if (!content) {
    return undefined;
  }

  const parsed = parseJsonObject(content) as Partial<BrowserAgentAction> & { fields?: unknown } | undefined;

  if (!parsed) {
    return undefined;
  }

  if (parsed.kind === "fill") {
    return { kind: "fill", reason: String(parsed.reason ?? "LLM chose to fill visible fields."), source: "llm" };
  }

  if (parsed.kind === "click" && typeof parsed.controlId === "string") {
    return { kind: "click", controlId: parsed.controlId, reason: String(parsed.reason ?? "LLM selected a navigation control."), source: "llm" };
  }

  if (parsed.kind === "upload_resume") {
    return {
      kind: "upload_resume",
      controlId: typeof parsed.controlId === "string" ? parsed.controlId : undefined,
      reason: String(parsed.reason ?? "LLM selected resume upload."),
      source: "llm"
    };
  }

  if (parsed.kind === "ask_user") {
    return {
      kind: "ask_user",
      fields: Array.isArray(parsed.fields) ? parsed.fields.map(String) : ["Manual input"],
      reason: String(parsed.reason ?? "LLM determined manual input is required."),
      source: "llm"
    };
  }

  if (parsed.kind === "stop") {
    return { kind: "stop", reason: String(parsed.reason ?? "LLM chose to stop for review."), source: "llm" };
  }

  return undefined;
}

function parseJsonObject(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch (_error) {
    const match = value.match(/\{[\s\S]*\}/);

    if (!match) {
      return undefined;
    }

    try {
      return JSON.parse(match[0]) as unknown;
    } catch (_innerError) {
      return undefined;
    }
  }
}

async function clickObservedControlAndWait(input: {
  context: BrowserContext;
  page: Page;
  controlId: string;
  beforeFingerprint: string;
}) {
  const clicked = await input.page.locator(`[data-gradlaunch-control-id="${input.controlId}"]`).first().click({ timeout: 1500 }).then(() => true).catch(() => false);

  if (!clicked) {
    return {
      activePage: input.page,
      moved: false
    };
  }

  return waitForStageMovement({
    context: input.context,
    page: input.page,
    fallbackPage: input.page,
    beforeFingerprint: input.beforeFingerprint
  });
}

function safeHostname(value: string) {
  try {
    return new URL(value).hostname;
  } catch (_error) {
    return "";
  }
}

async function handleAccountGate(input: {
  context: BrowserContext;
  page: Page;
  fields: FilledField[];
  visibleFields: VisibleField[];
  resume?: ResumeRecord;
  stageIndex: number;
}): Promise<AccountGateResult> {
  const hasPasswordField = input.visibleFields.some((field) => field.inputType === "password" || /\bpassword\b/i.test(field.label));
  const accountGateText = await input.page.locator("body").innerText({ timeout: 1200 }).catch(() => "");
  const looksLikeAccountGate = hasPasswordField || /log into|login|log in|first time applicant|create account|sign up|sign in/i.test(accountGateText);
  const hostname = new URL(input.page.url()).hostname;
  const isLinkedIn = /(^|\.)linkedin\.com$/i.test(hostname);

  if (!looksLikeAccountGate) {
    return {
      handled: false,
      activePage: input.page,
      filledLabels: []
    };
  }

  const credentials = await getAtsCredentialsForPage(input.page, input.fields);
  const filledUsername = await fillFormField(input.page, {
    label: "Username",
    value: credentials.username ?? getFieldValue(input.fields, "email") ?? ""
  });

  if (hasPasswordField && credentials.password) {
    await updateBrowserAgent(input.page, createStageOverlaySteps(input.stageIndex, "running", `${isLinkedIn ? "LinkedIn" : "Existing account"} login detected. Filling saved credentials.`));
    const filledPassword = await fillFormField(input.page, {
      label: "Password",
      value: credentials.password
    });

    if (filledUsername || filledPassword) {
      const loginNavigation = await clickLoginAndWait(input.context, input.page);

      if (loginNavigation.moved) {
        return {
          handled: true,
          activePage: loginNavigation.activePage,
          filledLabels: ["ATS login"]
        };
      }
    }
  }

  if (isLinkedIn && hasPasswordField) {
    await markFieldsNeedingInput(input.page, ["Password"]);
    return {
      handled: true,
      activePage: input.page,
      filledLabels: filledUsername ? ["Login email"] : [],
      blockedReason: "LinkedIn requires the student's password or an active signed-in browser session. Add linkedin.com credentials in ATS_CREDENTIALS_JSON, sign in manually in the open browser, or use the company application URL instead."
    };
  }

  if (input.resume?.storagePath && await pathExists(input.resume.storagePath) && await hasResumeAutofillPath(input.page)) {
    await updateBrowserAgent(input.page, createStageOverlaySteps(input.stageIndex, "running", "Account gate detected. Using first-time applicant resume upload path."));
    const uploaded = await attachResume(input.page, input.resume.storagePath);

    if (uploaded) {
      const activePage = await getActivePage(input.context, input.page);
      await activePage.waitForTimeout(Number(process.env.BROWSER_RESUME_PARSE_WAIT_MS ?? 2500));
      return {
        handled: true,
        activePage: await getActivePage(input.context, activePage),
        filledLabels: ["Resume upload"]
      };
    }
  }

  if (hasPasswordField) {
    await markFieldsNeedingInput(input.page, ["Password"]);
    return {
      handled: true,
      activePage: input.page,
      filledLabels: filledUsername ? ["Login email"] : [],
      blockedReason: "This job portal needs an account password. Add ATS_CREDENTIALS_JSON for this host, or use the first-time applicant upload path manually."
    };
  }

  return {
    handled: false,
    activePage: input.page,
    filledLabels: []
  };
}

async function clickLoginAndWait(context: BrowserContext, page: Page) {
  const beforeFingerprint = await getPageFingerprint(page);
  const loginLabels = ["Log in", "Login", "Sign in", "Sign In", "Continue"];

  for (const label of loginLabels) {
    const clicked = await clickRoleControl(context, page, label, { allowApplyStart: false });

    if (!clicked.clicked) {
      continue;
    }

    return waitForStageMovement({
      context,
      page: clicked.page,
      fallbackPage: page,
      beforeFingerprint
    });
  }

  return {
    activePage: page,
    moved: false
  };
}

async function getAtsCredentialsForPage(page: Page, fields: FilledField[]): Promise<AtsCredentials> {
  const hostname = new URL(page.url()).hostname;
  return getAtsCredentialsForHost(hostname, fields);
}

function getAtsCredentialsForHost(hostname: string, fields: FilledField[]): AtsCredentials {
  const email = getFieldValue(fields, "email");
  const credentialsByHost = parseAtsCredentials();
  const hostCredential = credentialsByHost[hostname]
    ?? Object.entries(credentialsByHost).find(([host]) => hostname === host || hostname.endsWith(`.${host}`))?.[1];

  return {
    username: hostCredential?.username ?? process.env.ATS_DEFAULT_USERNAME ?? email,
    password: hostCredential?.password ?? process.env.ATS_DEFAULT_PASSWORD
  };
}

function parseAtsCredentials() {
  const raw = process.env.ATS_CREDENTIALS_JSON;

  if (!raw) {
    return {} as Record<string, AtsCredentials>;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, AtsCredentials>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function getFieldValue(fields: FilledField[], label: string) {
  const target = normalizeKey(label);
  return fields.find((field) => normalizeKey(field.label) === target)?.value;
}

async function hasApplicationStartModal(page: Page) {
  const bodyText = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
  return /start your application|autofill with resume|apply manually|use my last application/i.test(bodyText);
}

async function hasResumeAutofillPath(page: Page) {
  const bodyText = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
  return /autofill with resume|upload resume|select your resume|choose file|first time applicant/i.test(bodyText)
    || await hasFileUpload(page);
}

async function advanceToNextStage(input: {
  context: BrowserContext;
  page: Page;
  stageIndex: number;
  allowApplyStart: boolean;
}): Promise<StageNavigationResult> {
  const beforeFingerprint = await getPageFingerprint(input.page);
  const nextResult = await clickNextStageControl(input.context, input.page, { allowApplyStart: input.allowApplyStart });

  if (!nextResult.clicked) {
    return {
      activePage: input.page,
      moved: false
    };
  }

  const movement = await waitForStageMovement({
    context: input.context,
    page: nextResult.page,
    fallbackPage: input.page,
    beforeFingerprint
  });

  if (!movement.moved) {
    const validationMessages = await getVisibleValidationMessages(movement.activePage);
    const retryMovement = await retryAlternativeStageAdvance({
      context: input.context,
      page: movement.activePage,
      beforeFingerprint,
      allowApplyStart: input.allowApplyStart
    });

    if (retryMovement.moved) {
      return retryMovement;
    }

    await updateBrowserAgent(movement.activePage, createStageOverlaySteps(input.stageIndex, "attention", "The page did not move after Next. A required field or portal validation may need manual attention."));
    return {
      activePage: retryMovement.activePage,
      moved: false,
      blockedReason: validationMessages.length > 0
        ? `GradLaunch found validation blockers after trying to continue: ${validationMessages.join(", ")}.`
        : "GradLaunch clicked the next control, but the form did not advance. A required field, validation message, login, or site-specific question likely needs manual review."
    };
  }

  return movement;
}

async function retryAlternativeStageAdvance(input: {
  context: BrowserContext;
  page: Page;
  beforeFingerprint: string;
  allowApplyStart: boolean;
}): Promise<StageNavigationResult> {
  await clickSoftGate(input.page);
  const alternative = await clickDomNextControl(input.context, input.page, { allowApplyStart: input.allowApplyStart });

  if (!alternative.clicked) {
    return {
      activePage: input.page,
      moved: false
    };
  }

  return waitForStageMovement({
    context: input.context,
    page: alternative.page,
    fallbackPage: input.page,
    beforeFingerprint: input.beforeFingerprint
  });
}

async function waitForStageMovement(input: {
  context: BrowserContext;
  page: Page;
  fallbackPage: Page;
  beforeFingerprint: string;
}): Promise<StageNavigationResult> {
  let activePage = input.page;
  await activePage.waitForLoadState("domcontentloaded", { timeout: Number(process.env.BROWSER_STAGE_LOAD_TIMEOUT_MS ?? 3500) }).catch(() => undefined);

  for (let attempt = 0; attempt < Number(process.env.BROWSER_STAGE_MOVEMENT_ATTEMPTS ?? 6); attempt += 1) {
    await activePage.waitForTimeout(Number(process.env.BROWSER_STAGE_TRANSITION_WAIT_MS ?? 250));
    activePage = await getActivePage(input.context, activePage);

    const afterFingerprint = await getPageFingerprint(activePage);

    if (input.beforeFingerprint !== afterFingerprint || activePage !== input.fallbackPage) {
      return {
        activePage,
        moved: true
      };
    }
  }

  return {
    activePage,
    moved: false
  };
}

async function buildDynamicFillPlan(input: {
  page: Page;
  baseFields: FilledField[];
  visibleFields: VisibleField[];
  job: Job;
  resume?: ResumeRecord;
  student?: StudentProfile;
  memory?: StudentMemory;
  workspacePath: string;
}): Promise<DynamicFillPlan> {
  const valueBank = createValueBank(input.baseFields);
  const fieldsByLabel = new Map<string, BrowserFillField>();
  const unresolvedRequiredLabels: string[] = [];
  const deterministicAnswers = createProfileFallbackAnswerMap(input.visibleFields, input.baseFields, input.job);
  const answerableVisibleFields = input.visibleFields.filter((field) => field.inputType !== "file" && !isSensitiveOrBlockedField(field.label));
  const requiredAnswerableFields = answerableVisibleFields.filter((field) => field.required);
  const deterministicCoversAllRequired = requiredAnswerableFields.length > 0 && requiredAnswerableFields.every((field) => deterministicAnswers.has(field.id));
  const llmConfigured = process.env.LLM_ANSWER_ENABLED === "true" && isLlmProviderConfigured();
  const llmDrivenOnly = process.env.BROWSER_LLM_FIELD_FILL_MODE === "llm_only" && llmConfigured;
  const shouldQueryLlm = llmConfigured && answerableVisibleFields.length > 0;
  const llmStagePlan = shouldQueryLlm
    ? await buildLlmStageFillPlan(input).catch(async (error) => {
      await writeBrowserDebug(input.workspacePath, "stage-fill-plan-error", {
        message: error instanceof Error ? error.message : String(error)
      });
      return undefined;
    })
    : undefined;
  const llmAnswers = createLlmAnswerMap(llmStagePlan, input.visibleFields);
  const usedProfileFallback = deterministicAnswers.size > 0;

  if (usedProfileFallback) {
    await writeBrowserDebug(input.workspacePath, "profile-fallback-prepared", {
      answers: [...deterministicAnswers.values()].map((field) => ({
        fieldId: field.fieldId,
        label: field.label,
        valuePreview: truncateForLog(field.value, 120)
      })),
      deterministicCoversAllRequired
    });
  }

  if (!shouldQueryLlm) {
    await writeBrowserDebug(input.workspacePath, "stage-fill-plan-skipped", {
      reason: deterministicCoversAllRequired
        ? "Deterministic profile facts cover all visible required fields."
        : "LLM is disabled or not configured.",
      llm: getLlmDebugStatus()
    });
  }

  const llmNeedsAnswerForRequiredFields = llmDrivenOnly && !llmStagePlan && deterministicAnswers.size === 0;

  if (!llmDrivenOnly) {
    for (const field of input.baseFields) {
      fieldsByLabel.set(normalizeKey(field.label), field);
    }
  }

  for (const discoveredField of input.visibleFields) {
    if (llmNeedsAnswerForRequiredFields) {
      if (discoveredField.required && !isSensitiveOrBlockedField(discoveredField.label)) {
        unresolvedRequiredLabels.push(discoveredField.label);
      }

      continue;
    }

    const llmResolvedField = llmAnswers.get(discoveredField.id);
    const deterministicResolvedField = deterministicAnswers.get(discoveredField.id);
    const fallbackValue = resolveSafeFallbackValue(discoveredField.label)
      ?? resolveDeterministicProfileValue(discoveredField.label, valueBank)
      ?? resolveAnswerBankValue(discoveredField.label)
      ?? (llmDrivenOnly
        ? undefined
        : await resolveLlmFieldValue({
          field: discoveredField,
          fields: input.baseFields,
          job: input.job,
          resume: input.resume,
          student: input.student,
          memory: input.memory
        }));
    const resolvedField = deterministicResolvedField ?? llmResolvedField ?? (fallbackValue
      ? {
        label: discoveredField.label,
        value: fallbackValue,
        fieldId: discoveredField.id,
        inputType: discoveredField.inputType,
        options: discoveredField.options
      }
      : undefined);

    if (!resolvedField) {
      if (discoveredField.required && !isSensitiveOrBlockedField(discoveredField.label)) {
        unresolvedRequiredLabels.push(discoveredField.label);
      }

      continue;
    }

    fieldsByLabel.set(normalizeKey(discoveredField.label), {
      ...resolvedField,
      label: discoveredField.label,
      fieldId: discoveredField.id,
      inputType: discoveredField.inputType,
      options: discoveredField.options
    });
  }

  return {
    fields: [...fieldsByLabel.values()],
    unresolvedRequiredLabels: dedupeLabels([
      ...unresolvedRequiredLabels,
      ...(llmStagePlan?.needsUser ?? [])
        .filter((item) => input.visibleFields.some((field) => normalizeKey(field.label) === normalizeKey(item.label)))
        .map((item) => item.label)
    ]),
    llmSummary: llmStagePlan?.summary ?? (usedProfileFallback ? "Using stored GradLaunch profile facts first for obvious fields so the form can move faster." : undefined),
    llmAnswerCount: llmAnswers.size,
    nextActionAfterFill: llmStagePlan?.nextActionAfterFill
  };
}

function createProfileFallbackAnswerMap(visibleFields: VisibleField[], fields: FilledField[], job: Job) {
  const answerMap = new Map<string, BrowserFillField>();
  const valueBank = createValueBank(fields);

  for (const visibleField of visibleFields) {
    if (visibleField.inputType === "file" || isSensitiveOrBlockedField(visibleField.label)) {
      continue;
    }

    const value = resolveDynamicValue(visibleField.label, valueBank)
      ?? resolveAnswerBankValue(visibleField.label)
      ?? resolveHeuristicUnknownValue(visibleField, fields, job);

    if (!value) {
      continue;
    }

    answerMap.set(visibleField.id, {
      label: visibleField.label,
      value,
      fieldId: visibleField.id,
      inputType: visibleField.inputType,
      options: visibleField.options
    });
  }

  return answerMap;
}

async function buildLlmStageFillPlan(input: {
  page: Page;
  baseFields: FilledField[];
  visibleFields: VisibleField[];
  job: Job;
  resume?: ResumeRecord;
  student?: StudentProfile;
  memory?: StudentMemory;
  workspacePath: string;
}): Promise<LlmStageFillPlan | undefined> {
  if (process.env.LLM_ANSWER_ENABLED !== "true" || !isLlmProviderConfigured()) {
    await writeBrowserDebug(input.workspacePath, "stage-fill-plan-skipped", {
      reason: "LLM is disabled or provider is not configured.",
      llm: getLlmDebugStatus()
    });
    return undefined;
  }

  const answerableFields = input.visibleFields.filter((field) => field.inputType !== "file");

  if (answerableFields.length === 0) {
    await writeBrowserDebug(input.workspacePath, "stage-fill-plan-skipped", {
      reason: "No answerable non-file fields were visible."
    });
    return undefined;
  }

  const pageText = await input.page.locator("body").innerText({ timeout: 1200 })
    .then((text) => text.replace(/\s+/g, " ").slice(0, 4500))
    .catch(() => "");
  const visibleFieldPayload = answerableFields.map((field) => ({
    fieldId: field.id,
    label: field.label,
    context: field.context,
    required: field.required,
    tagName: field.tagName,
    inputType: field.inputType,
    options: field.options
  }));
  const knowledgebase = createProfileKnowledgeBase(input.baseFields, input.resume, input.job, input.student, input.memory);
  const studentKnowledgeText = createStudentKnowledgeText(input.baseFields, input.resume, input.job, input.student, input.memory);
  const pageObservation = await observeBrowserPage(input.page, input.visibleFields);
  const messages = [
    {
      role: "system",
      content: [
        "You are the GradLaunch autonomous browser form-filling brain.",
        "You receive the current web application stage, the student's stored GradLaunch profile, memory corrections, resume knowledgebase, the job description, and visible form fields.",
        "Return a concrete fill plan for this exact screen.",
        "Use the stored GradLaunch student facts and corrections before relying on looser resume inference.",
        "Use only provided facts. Do not invent degrees, employers, legal/work authorization, certifications, compensation, dates, identity numbers, or contact details.",
        "If a field is normal and answerable, include it in answers using the exact visible fieldId and exact visible field label.",
        "If a field has options, the value must be exactly one option string.",
        "If a field asks for password, OTP, captcha, security code, government ID, payment, bank, protected demographic data, or unknown mandatory facts, put it in needsUser instead of answers.",
        "Short text answers should be professional and specific to the student and job.",
        "Return JSON only with this shape: {\"answers\":[{\"fieldId\":\"exact fieldId\",\"label\":\"exact field label\",\"value\":\"answer\",\"confidence\":0.0,\"reason\":\"short\"}],\"needsUser\":[{\"fieldId\":\"exact fieldId\",\"label\":\"exact field label\",\"reason\":\"short\"}],\"nextActionAfterFill\":\"click_next|pause|submit_gate\",\"summary\":\"short\"}."
      ].join(" ")
    },
    {
      role: "user",
      content: JSON.stringify({
        currentPage: {
          url: input.page.url(),
          text: pageText,
          state: pageObservation.pageState,
          adapter: pageObservation.adapter,
          validationMessages: pageObservation.validationMessages
        },
        visibleFields: visibleFieldPayload,
        groupedFields: pageObservation.groupedFields,
        studentKnowledgeText,
        knowledgebase,
        job: {
          title: input.job.title,
          company: input.job.company,
          location: input.job.location,
          workMode: input.job.workMode,
          skills: input.job.skills,
          degreeRequirements: input.job.degreeRequirements,
          description: input.job.description
        }
      })
    }
  ];
  await writeBrowserDebug(input.workspacePath, "stage-fill-plan-conversation", {
    provider: getLlmProvider(),
    model: getLlmProvider() === "ollama" ? process.env.OLLAMA_MODEL : process.env.LLM_MODEL,
    url: input.page.url(),
    messages: messages.map((message) => ({
      role: message.role,
      content: truncateForLog(message.content, Number(process.env.LLM_DEBUG_MESSAGE_CHARS ?? 12000))
    }))
  });
  const content = getLlmProvider() === "ollama"
    ? await callOllamaAnswer(messages, input.workspacePath)
    : await callOpenAiAnswer(messages, input.workspacePath);

  if (!content) {
    await writeBrowserDebug(input.workspacePath, "stage-fill-plan-empty-response", {
      url: input.page.url(),
      fields: visibleFieldPayload.map((field) => field.label)
    });
    return undefined;
  }

  await writeBrowserDebug(input.workspacePath, "stage-fill-plan-response", {
    content: truncateForLog(content, 4000)
  });
  const plan = parseLlmStageFillPlan(content, answerableFields);

  if (!plan) {
    await writeBrowserDebug(input.workspacePath, "stage-fill-plan-parse-failed", {
      content: truncateForLog(content, 4000)
    });
  } else {
    await writeBrowserDebug(input.workspacePath, "stage-fill-plan-parsed", {
      answers: plan.answers.map((answer) => ({
        fieldId: answer.fieldId,
        label: answer.label,
        valuePreview: truncateForLog(answer.value, 120),
        confidence: answer.confidence
      })),
      needsUser: plan.needsUser
    });
  }

  return plan;
}

function createProfileKnowledgeBase(
  fields: FilledField[],
  resume: ResumeRecord | undefined,
  job: Job,
  student?: StudentProfile,
  memory?: StudentMemory
) {
  const answerBank = Object.fromEntries(getApplicationAnswerBank().entries());
  const profileFacts = fields
    .filter((field) => !shouldSkipField(field))
    .map((field) => ({
      label: field.label,
      value: field.value
    }));

  return {
    storedStudentProfile: student
      ? {
        fullName: student.fullName,
        email: student.email,
        degree: student.degree,
        graduationYear: student.graduationYear,
        targetRoles: student.targetRoles,
        preferredLocations: student.preferredLocations,
        workModes: student.workModes,
        skills: student.skills,
        expectedSalaryLpa: student.expectedSalaryLpa,
        visaRequired: student.visaRequired,
        automationMode: student.automationMode,
        bio: student.bio
      }
      : undefined,
    profileFacts,
    memory: memory
      ? {
        recentCorrections: memory.corrections.slice(0, 12),
        recentHandoffKinds: memory.recentHandoffKinds,
        notes: memory.notes.slice(0, 8)
      }
      : undefined,
    answerBank,
    resume: {
      filename: resume?.filename,
      extractedText: resume?.extractedText?.slice(0, Number(process.env.LLM_RESUME_CONTEXT_CHARS ?? 4000))
    },
    generatedContext: {
      targetRole: getFieldValue(fields, "Target role") ?? job.title,
      primarySkills: getFieldValue(fields, "Primary skills"),
      hiringMessage: getFieldValue(fields, "Message to the Hiring Team")
    }
  };
}

function createStudentKnowledgeText(
  fields: FilledField[],
  resume: ResumeRecord | undefined,
  job: Job,
  student?: StudentProfile,
  memory?: StudentMemory
) {
  const profileLines = fields
    .filter((field) => !shouldSkipField(field))
    .map((field) => `- ${field.label}: ${field.value}`)
    .join("\n");
  const storedProfileLines = student
    ? [
      `- Full name: ${student.fullName}`,
      `- Email: ${student.email}`,
      `- Degree: ${student.degree}`,
      `- Graduation year: ${student.graduationYear}`,
      `- Target roles: ${student.targetRoles.join(", ") || "Not provided"}`,
      `- Preferred locations: ${student.preferredLocations.join(", ") || "Not provided"}`,
      `- Work modes: ${student.workModes.join(", ") || "Not provided"}`,
      `- Skills: ${student.skills.join(", ") || "Not provided"}`,
      `- Expected salary (LPA): ${student.expectedSalaryLpa ?? "Not provided"}`,
      `- Visa required: ${student.visaRequired ? "Yes" : "No"}`,
      `- Bio: ${student.bio || "Not provided"}`
    ].join("\n")
    : "";
  const correctionLines = memory?.corrections.length
    ? memory.corrections
      .slice(0, 12)
      .map((item) => `- ${item.label}: ${item.value}`)
      .join("\n")
    : "";
  const memoryNotes = memory?.notes.length
    ? memory.notes.slice(0, 8).map((note) => `- ${note}`).join("\n")
    : "";
  const answerBankLines = [...getApplicationAnswerBank().entries()]
    .map(([label, value]) => `- ${label}: ${value}`)
    .join("\n");

  return [
    "Stored GradLaunch student profile:",
    storedProfileLines || "- No stored student profile available.",
    "",
    "Logged-in student / prepared application facts:",
    profileLines || "- No prepared profile facts available.",
    "",
    "Memory corrections from past applications:",
    correctionLines || "- No saved corrections available.",
    "",
    "Recent memory notes:",
    memoryNotes || "- No recent notes available.",
    "",
    "Answer bank:",
    answerBankLines || "- No answer bank configured.",
    "",
    "Resume text:",
    resume?.extractedText?.slice(0, Number(process.env.LLM_RESUME_CONTEXT_CHARS ?? 4000)) || "No resume text available.",
    "",
    "Target job:",
    `- Title: ${job.title}`,
    `- Company: ${job.company}`,
    `- Location: ${job.location}`,
    `- Work mode: ${job.workMode}`,
    `- Description: ${job.description}`
  ].join("\n");
}

function createLlmAnswerMap(plan: LlmStageFillPlan | undefined, visibleFields: VisibleField[]) {
  const answerMap = new Map<string, BrowserFillField>();

  if (!plan) {
    return answerMap;
  }

  const visibleById = new Map(visibleFields.map((field) => [field.id, field]));
  const visibleByKey = new Map(visibleFields.map((field) => [normalizeKey(field.label), field]));

  for (const answer of plan.answers) {
    const visibleField = visibleById.get(answer.fieldId) ?? visibleByKey.get(normalizeKey(answer.label));

    if (!visibleField || isSensitiveOrBlockedField(visibleField.label) || !answer.value.trim()) {
      continue;
    }

    const normalizedConfidence = Number.isFinite(answer.confidence) ? answer.confidence : 0;

    if (normalizedConfidence < Number(process.env.LLM_FIELD_MIN_CONFIDENCE ?? 0.45)) {
      continue;
    }

    const value = visibleField.options.length > 0
      ? coerceToOption(answer.value, visibleField.options)
      : answer.value.trim();

    if (!value || value.length > 2000) {
      continue;
    }

    answerMap.set(visibleField.id, {
      label: visibleField.label,
      value,
      fieldId: visibleField.id,
      inputType: visibleField.inputType,
      options: visibleField.options
    });
  }

  return answerMap;
}

function parseLlmStageFillPlan(content: string, visibleFields: VisibleField[]): LlmStageFillPlan | undefined {
  const parsed = parseJsonObject(content) as {
    answers?: unknown;
    needsUser?: unknown;
    nextActionAfterFill?: unknown;
    summary?: unknown;
  } | undefined;

  if (!parsed) {
    return undefined;
  }

  const visibleById = new Map(visibleFields.map((field) => [field.id, field]));
  const visibleByKey = new Map(visibleFields.map((field) => [normalizeKey(field.label), field]));
  const answers = Array.isArray(parsed.answers)
    ? parsed.answers.flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }

      const raw = item as Record<string, unknown>;
      const fieldId = typeof raw.fieldId === "string" ? raw.fieldId.trim() : "";
      const label = typeof raw.label === "string" ? raw.label.trim() : "";
      const value = typeof raw.value === "string" ? raw.value.trim() : "";
      const confidence = typeof raw.confidence === "number" ? raw.confidence : Number(raw.confidence ?? 0.7);
      const visibleField = visibleById.get(fieldId) ?? visibleByKey.get(normalizeKey(label));

      if (!visibleField || !value) {
        return [];
      }

      return [{
        fieldId: visibleField.id,
        label: visibleField.label,
        value,
        confidence,
        reason: typeof raw.reason === "string" ? raw.reason.slice(0, 240) : undefined
      }];
    })
    : [];
  const needsUser = Array.isArray(parsed.needsUser)
    ? parsed.needsUser.flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }

      const raw = item as Record<string, unknown>;
      const fieldId = typeof raw.fieldId === "string" ? raw.fieldId.trim() : "";
      const label = typeof raw.label === "string" ? raw.label.trim() : "";
      const visibleField = visibleById.get(fieldId) ?? visibleByKey.get(normalizeKey(label));

      if (!visibleField) {
        return [];
      }

      return [{
        fieldId: visibleField.id,
        label: visibleField.label,
        reason: typeof raw.reason === "string" ? raw.reason.slice(0, 240) : "The LLM marked this field as needing student input."
      }];
    })
    : [];
  const nextActionAfterFill = parsed.nextActionAfterFill === "click_next" || parsed.nextActionAfterFill === "pause" || parsed.nextActionAfterFill === "submit_gate"
    ? parsed.nextActionAfterFill
    : undefined;

  return {
    answers,
    needsUser,
    nextActionAfterFill,
    summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 180) : undefined
  };
}

function limitFieldsToVisibleLabels(fields: BrowserFillField[], visibleFields: VisibleField[]) {
  const visibleKeys = new Set<string>();
  const visibleIds = new Set(visibleFields.map((field) => field.id));

  for (const visibleField of visibleFields) {
    visibleKeys.add(normalizeKey(visibleField.label));

    for (const alias of getFieldAliases(visibleField.label)) {
      visibleKeys.add(normalizeKey(alias));
    }
  }

  return fields.filter((field) => {
    if (field.fieldId && visibleIds.has(field.fieldId)) {
      return true;
    }

    const fieldKeys = [field.label, ...getFieldAliases(field.label)].map(normalizeKey);
    return fieldKeys.some((key) => visibleKeys.has(key));
  });
}

async function discoverVisibleFields(page: Page) {
  const allFields: VisibleField[] = [];

  for (const [frameIndex, frame] of page.frames().entries()) {
    const frameFields = await frame.evaluate((currentFrameIndex) => {
      const searchRoots = getSearchRoots();
      const controls = searchRoots.flatMap((root) => Array.from(root.querySelectorAll("input, textarea, select"))) as Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>;

      return controls
        .filter((control) => {
          if (control instanceof HTMLInputElement && ["hidden", "file", "submit", "button"].includes(control.type)) {
            return false;
          }

          const rect = control.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .map((control, index) => {
          const id = `gl-agent-field-${currentFrameIndex}-${index}`;
          control.setAttribute("data-gradlaunch-field-id", id);
          const label = findFieldLabel(control);
          const context = findFieldContext(control);

          return {
            id,
            label,
            required: control.required || control.getAttribute("aria-required") === "true" || /\*/.test(`${label} ${context}`) || Boolean(control.closest(".required, [class*='required'], [data-required='true']")),
            tagName: control.tagName.toLowerCase(),
            inputType: control instanceof HTMLInputElement ? control.type : control.tagName.toLowerCase(),
            options: findOptions(control),
            context
          };
        })
        .filter((field) => field.label.trim().length > 0 || field.context.trim().length > 0)
        .map((field) => ({
          ...field,
          label: field.label.trim() || field.context.trim().slice(0, 120)
        }));

      function findFieldLabel(control: Element) {
        if (control.id) {
          const label = queryFirst(`label[for="${CSS.escape(control.id)}"]`, control);

          if (label?.textContent?.trim()) {
            return clean(label.textContent);
          }
        }

        const ariaLabelledBy = control.getAttribute("aria-labelledby");

        if (ariaLabelledBy) {
          const labelled = describedByText(ariaLabelledBy);

          if (labelled.trim()) {
            return clean(labelled);
          }
        }

        const labelParent = control.closest("label");

        if (labelParent?.textContent?.trim()) {
          return clean(labelParent.textContent);
        }

        const containerText = clean([
          control.closest(".mat-mdc-form-field, .mat-form-field, .form-group, .form-field, .field, [role='group']")?.querySelector("label, legend, .mat-mdc-floating-label, .mdc-floating-label, .mat-form-field-label")?.textContent,
          control.previousElementSibling?.textContent,
          control.parentElement?.previousElementSibling?.textContent,
          control.parentElement?.parentElement?.previousElementSibling?.textContent,
          control.closest("fieldset")?.querySelector("legend")?.textContent,
          control.closest("fieldset")?.textContent,
          control.closest("[role='group']")?.textContent,
          control.parentElement?.textContent
        ].filter(Boolean).join(" "));

        if (containerText.trim()) {
          return containerText;
        }

        const direct = [
          control.getAttribute("aria-label"),
          control.getAttribute("placeholder"),
          control.getAttribute("name"),
          isSyntheticFieldToken(control.id) ? "" : control.id
        ].filter(Boolean).join(" ");

        if (direct.trim()) {
          return clean(direct);
        }

        return "";
      }

      function findFieldContext(control: Element) {
        return clean([
          control.getAttribute("aria-describedby") ? describedByText(control.getAttribute("aria-describedby") ?? "") : "",
          control.previousElementSibling?.textContent,
          control.parentElement?.previousElementSibling?.textContent,
          control.parentElement?.parentElement?.previousElementSibling?.textContent,
          control.closest("fieldset")?.textContent,
          control.closest("[role='group']")?.textContent,
          control.parentElement?.textContent
        ].filter(Boolean).join(" "));
      }

      function describedByText(ids: string) {
        return ids
          .split(/\s+/)
          .map((id) => getElementById(id)?.textContent ?? "")
          .join(" ");
      }

      function clean(value: string | null | undefined) {
        return (value ?? "").replace(/\s+/g, " ").replace(/\*/g, "").trim().slice(0, 500);
      }

      function isSyntheticFieldToken(value: string | null | undefined) {
        const token = (value ?? "").trim();
        return /^(mat-input-\d+|input[_-]?\d+|field[_-]?\d+|ctl\d+|ember\d+|cdk-[a-z0-9-]+|mui-\d+|react-select-\d+-input)$/i.test(token);
      }

      function queryFirst(selector: string, control: Element) {
        const root = control.getRootNode();

        if (root instanceof Document || root instanceof ShadowRoot || root instanceof Element) {
          const withinRoot = root.querySelector(selector);

          if (withinRoot) {
            return withinRoot;
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

      function findOptions(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
        if (control instanceof HTMLSelectElement) {
          return Array.from(control.options).map((option) => option.textContent?.trim() ?? "").filter(Boolean);
        }

        if (control instanceof HTMLInputElement && ["radio", "checkbox"].includes(control.type)) {
          const name = control.name;
          const group = name
            ? searchRoots.flatMap((root) => Array.from(root.querySelectorAll(`input[name="${CSS.escape(name)}"]`))) as HTMLInputElement[]
            : [control];

          return group.map((item) => {
            if (item.id) {
              const root = item.getRootNode();
              const label = ((root instanceof Document || root instanceof ShadowRoot || root instanceof Element)
                ? root.querySelector(`label[for="${CSS.escape(item.id)}"]`)
                : null)
                ?? searchRoots.map((searchRoot) => searchRoot.querySelector(`label[for="${CSS.escape(item.id)}"]`)).find(Boolean)
                ?? null;

              if (label?.textContent?.trim()) {
                return label.textContent.trim();
              }
            }

            return item.closest("label")?.textContent?.trim() || item.parentElement?.textContent?.trim() || item.value;
          }).filter(Boolean);
        }

        return [];
      }
    }, frameIndex).catch(() => []);

    allFields.push(...frameFields);
  }

  const unique = new Map<string, VisibleField>();

  for (const field of allFields) {
    unique.set(field.id, field);
  }

  return [...unique.values()];
}

function createValueBank(fields: FilledField[]) {
  const bank = new Map<string, string>();

  for (const field of fields) {
    if (!field.value.trim()) {
      continue;
    }

    for (const alias of getFieldAliases(field.label)) {
      bank.set(normalizeKey(alias), field.value);
    }

    bank.set(normalizeKey(field.label), field.value);
  }

  const fullName = bank.get("full name") ?? bank.get("name");

  if (fullName) {
    const nameParts = fullName.split(/\s+/).filter(Boolean);
    const firstName = nameParts[0];
    const lastName = nameParts.slice(1).join(" ");

    if (firstName && !bank.has("first name")) {
      bank.set("first name", firstName);
    }

    if (lastName && !bank.has("last name")) {
      bank.set("last name", lastName);
    }
  }

  const location = bank.get("preferred location") ?? bank.get("location") ?? bank.get("city");

  if (location) {
    const city = location.split(",")[0]?.trim();

    if (city && !bank.has("city")) {
      bank.set("city", city);
      bank.set("location city", city);
    }
  }

  if (!bank.has("country")) {
    const phone = bank.get("phone number") ?? bank.get("phone") ?? bank.get("mobile");
    const inferredCountry = inferCountryFromPhone(phone);

    if (inferredCountry) {
      bank.set("country", inferredCountry);
    }
  }

  return bank;
}

function inferCountryFromPhone(phone: string | undefined) {
  const normalized = (phone ?? "").replace(/\s+/g, "");

  if (!normalized) {
    return process.env.DEFAULT_STUDENT_COUNTRY;
  }

  if (normalized.startsWith("+91")) {
    return "India";
  }

  if (normalized.startsWith("+1")) {
    return "United States";
  }

  if (normalized.startsWith("+44")) {
    return "United Kingdom";
  }

  if (normalized.startsWith("+61")) {
    return "Australia";
  }

  return process.env.DEFAULT_STUDENT_COUNTRY;
}

function resolveDynamicValue(label: string, valueBank: Map<string, string>) {
  const aliases = getFieldAliases(label).map(normalizeKey);

  for (const alias of aliases) {
    const value = valueBank.get(alias);

    if (value) {
      return value;
    }
  }

  const normalizedLabel = normalizeKey(label);

  for (const [key, value] of valueBank.entries()) {
    if (normalizedLabel.includes(key) || key.includes(normalizedLabel)) {
      return value;
    }
  }

  if (normalizedLabel.includes("confirm") && normalizedLabel.includes("email")) {
    return valueBank.get("email");
  }

  if (/\b(username|user name|login id|login email)\b/.test(normalizedLabel)) {
    return valueBank.get("email");
  }

  if (normalizedLabel.includes("message") || normalizedLabel.includes("hiring team")) {
    return valueBank.get("message to the hiring team") ?? valueBank.get("cover letter");
  }

  if (normalizedLabel.includes("why")) {
    return valueBank.get("why are you interested in this role");
  }

  if (/\b(authorized|eligible|work authorization|legally work)\b/.test(normalizedLabel)) {
    return valueBank.get("work authorization") ?? valueBank.get("legally authorized to work");
  }

  if (/\b(sponsorship|visa)\b/.test(normalizedLabel)) {
    return valueBank.get("visa sponsorship required") ?? valueBank.get("visa required");
  }

  if (/\b(terms|privacy|consent|agree|acknowledge)\b/.test(normalizedLabel)) {
    return "Yes";
  }

  if (/\b(current ctc|current salary|current compensation|current package)\b/.test(normalizedLabel)) {
    return valueBank.get("current ctc") ?? valueBank.get("current salary");
  }

  if (/\b(expected ctc|expected salary|expected compensation|expected package|salary expectation)\b/.test(normalizedLabel)) {
    return valueBank.get("expected ctc") ?? valueBank.get("expected salary");
  }

  return undefined;
}

function resolveSafeFallbackValue(label: string) {
  const normalizedLabel = normalizeKey(label);

  if (/\b(terms|privacy|consent|agree|acknowledge|accept|declaration)\b/.test(normalizedLabel)) {
    return "Yes";
  }

  return undefined;
}

function resolveDeterministicProfileValue(label: string, valueBank: Map<string, string>) {
  const normalizedLabel = normalizeKey(label);

  if (/\b(first name|last name|full name|name|email|username|user name|login email|phone|mobile|contact number|phone number|city|location|linkedin|portfolio|website|authorized|eligible|work authorization|visa|sponsorship|current salary|current compensation|current ctc|expected salary|expected compensation|expected ctc)\b/.test(normalizedLabel)) {
    return resolveDynamicValue(label, valueBank);
  }

  return undefined;
}

function resolveAnswerBankValue(label: string) {
  const normalizedLabel = normalizeKey(label);
  const answerBank = getApplicationAnswerBank();

  for (const [key, value] of answerBank.entries()) {
    if (!value.trim()) {
      continue;
    }

    const normalizedKey = normalizeKey(key);

    if (normalizedLabel === normalizedKey || normalizedLabel.includes(normalizedKey) || normalizedKey.includes(normalizedLabel)) {
      return value;
    }
  }

  return undefined;
}

function getApplicationAnswerBank() {
  const bank = new Map<string, string>();
  const raw = process.env.APPLICATION_ANSWER_BANK_JSON;

  if (!raw) {
    return bank;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        bank.set(key, value);
      } else if (typeof value === "number" || typeof value === "boolean") {
        bank.set(key, String(value));
      }
    }
  } catch (_error) {
    return bank;
  }

  return bank;
}

function isSensitiveOrBlockedField(label: string) {
  return /\b(password|captcha|otp|verification code|security code|ssn|social security|aadhaar|pan|passport|credit card|bank|payment)\b/i.test(label);
}

function isManualResolvableFieldLabel(label: string, inputType?: string) {
  const normalizedLabel = normalizeKey(label);

  if (/\b(captcha|otp|verification|password|login|log in|sign in|two factor|2fa|mfa|security check|authenticator)\b/.test(normalizedLabel)) {
    return true;
  }

  return inputType === "password";
}

function createManualFieldHandoffReason(labels: string[]) {
  const summary = labels.slice(0, 2).join(", ") + (labels.length > 2 ? "..." : "");
  return `Human intervention needed: complete the protected checkpoint in the open browser. Waiting on: ${summary}. GradLaunch is monitoring the page and will resume automatically once it clears.`;
}

function dedupeLabels(labels: string[]) {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const label of labels) {
    const key = normalizeKey(label);

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(label);
  }

  return deduped;
}

async function resolveLlmFieldValue(input: {
  field: VisibleField;
  fields: FilledField[];
  job: Job;
  resume?: ResumeRecord;
  student?: StudentProfile;
  memory?: StudentMemory;
}) {
  if (process.env.LLM_ANSWER_ENABLED !== "true" || !isLlmProviderConfigured()) {
    return resolveHeuristicUnknownValue(input.field, input.fields, input.job);
  }

  if (!shouldAskLlmForField(input.field)) {
    return resolveHeuristicUnknownValue(input.field, input.fields, input.job);
  }

  const answer = await callLlmAnswerService(input).catch(() => undefined);
  return answer ?? resolveHeuristicUnknownValue(input.field, input.fields, input.job);
}

function isLlmProviderConfigured() {
  const provider = getLlmProvider();

  if (provider === "ollama") {
    return Boolean(process.env.OLLAMA_MODEL);
  }

  return Boolean(process.env.OPENAI_API_KEY);
}

function getLlmProvider() {
  return (process.env.LLM_PROVIDER ?? "openai").toLowerCase() === "ollama" ? "ollama" : "openai";
}

function shouldAskLlmForField(field: VisibleField) {
  const label = normalizeKey(field.label);

  if (!label || label.length < 3) {
    return false;
  }

  if (/\b(password|captcha|otp|verification code|security code|ssn|social security|credit card|bank|payment)\b/.test(label)) {
    return false;
  }

  return field.inputType !== "file";
}

async function callLlmAnswerService(input: {
  field: VisibleField;
  fields: FilledField[];
  job: Job;
  resume?: ResumeRecord;
  student?: StudentProfile;
  memory?: StudentMemory;
}) {
  const provider = getLlmProvider();
  const profileFacts = input.fields
    .filter((field) => !shouldSkipField(field))
    .slice(0, 24)
    .map((field) => `${field.label}: ${field.value}`)
    .join("\n");
  const storedProfileFacts = input.student
    ? [
      `Full name: ${input.student.fullName}`,
      `Email: ${input.student.email}`,
      `Degree: ${input.student.degree}`,
      `Graduation year: ${input.student.graduationYear}`,
      `Target roles: ${input.student.targetRoles.join(", ") || "Not provided"}`,
      `Preferred locations: ${input.student.preferredLocations.join(", ") || "Not provided"}`,
      `Work modes: ${input.student.workModes.join(", ") || "Not provided"}`,
      `Skills: ${input.student.skills.join(", ") || "Not provided"}`,
      `Expected salary (LPA): ${input.student.expectedSalaryLpa ?? "Not provided"}`,
      `Visa required: ${input.student.visaRequired ? "Yes" : "No"}`,
      `Bio: ${input.student.bio || "Not provided"}`
    ].join("\n")
    : "No stored student profile available.";
  const correctionFacts = input.memory?.corrections.length
    ? input.memory.corrections.slice(0, 12).map((item) => `${item.label}: ${item.value}`).join("\n")
    : "No saved corrections available.";
  const resumeText = input.resume?.extractedText?.slice(0, Number(process.env.LLM_RESUME_CONTEXT_CHARS ?? 4000)) ?? "No resume text available.";
  const options = input.field.options.length ? `\nAllowed options: ${input.field.options.join(" | ")}` : "";
  const messages = [
    {
      role: "system",
      content: [
        "You answer job application form fields for a student using only the provided profile, resume, and job description.",
        "Prefer the stored GradLaunch student profile and saved corrections before using looser resume inference.",
        "Be truthful. Do not invent degrees, employers, dates, legal status, certifications, salary, or work authorization.",
        "If the answer is unknown, return an empty string.",
        "If the field asks for private/sensitive information, return an empty string.",
        "For student fresher salary fields, current CTC can be 0 LPA only if the profile/resume does not show employment.",
        "For expected compensation, use the profile answer when available; otherwise return empty string.",
        "If options are provided, return exactly one of the option strings.",
        "Return only compact JSON: {\"answer\":\"...\"}."
      ].join(" ")
    },
    {
      role: "user",
      content: [
        `Field/question: ${input.field.label}`,
        `Input type: ${input.field.inputType}${options}`,
        `Required: ${input.field.required ? "yes" : "no"}`,
        "",
        "Stored GradLaunch student profile:",
        storedProfileFacts,
        "",
        "Saved corrections from past application runs:",
        correctionFacts,
        "",
        "Student/profile facts:",
        profileFacts,
        "",
        "Resume text:",
        resumeText,
        "",
        "Job:",
        `${input.job.title} at ${input.job.company}`,
        input.job.description
      ].join("\n")
    }
  ];

  const content = provider === "ollama"
    ? await callOllamaAnswer(messages)
    : await callOpenAiAnswer(messages);

  if (!content) {
    return undefined;
  }

  return parseLlmAnswer(content, input.field.options);
}

async function callOpenAiAnswer(messages: Array<{ role: string; content: string }>, workspacePath?: string) {
  const endpoint = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1/chat/completions";
  const model = process.env.LLM_MODEL ?? "gpt-4o-mini";
  const requestBody = {
    model,
    temperature: 0.2,
    messages,
    response_format: { type: "json_object" }
  };
  let response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const firstError = await response.text().catch(() => "");
    await writeBrowserDebug(workspacePath, "openai-compatible-error", {
      status: response.status,
      statusText: response.statusText,
      body: truncateForLog(firstError, 1200),
      retryingWithoutJsonMode: true
    });
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages
      })
    });

    if (!response.ok) {
      const secondError = await response.text().catch(() => "");
      await writeBrowserDebug(workspacePath, "openai-compatible-error-after-retry", {
        status: response.status,
        statusText: response.statusText,
        body: truncateForLog(secondError, 1200)
      });
      return undefined;
    }
  }

  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content;
}

async function callOllamaAnswer(messages: Array<{ role: string; content: string }>, workspacePath?: string) {
  const baseUrl = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
  const model = process.env.OLLAMA_MODEL ?? "qwen2.5:7b";
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      stream: false,
      format: "json",
      messages,
      options: {
        temperature: 0.2
      }
    })
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    await writeBrowserDebug(workspacePath, "ollama-error", {
      status: response.status,
      statusText: response.statusText,
      body: truncateForLog(errorBody, 1200)
    });
    return undefined;
  }

  const body = await response.json() as { message?: { content?: string } };
  return body.message?.content;
}

function parseLlmAnswer(content: string, options: string[]) {
  try {
    const parsed = JSON.parse(content) as { answer?: unknown };
    const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";

    if (!answer || answer.length > 1200) {
      return undefined;
    }

    if (options.length > 0) {
      return coerceToOption(answer, options);
    }

    return answer;
  } catch (_error) {
    return undefined;
  }
}

async function writeBrowserDebug(workspacePath: string | undefined, event: string, payload: unknown) {
  if (process.env.BROWSER_AGENT_DEBUG === "false") {
    return;
  }

  const entry = {
    at: nowIso(),
    event,
    payload
  };
  const line = `[GradLaunch Agent] ${event} ${JSON.stringify(payload, null, 2)}`;
  console.log(line);

  if (!workspacePath) {
    return;
  }

  await appendFile(join(workspacePath, "browser-agent-debug.log"), `${JSON.stringify(entry)}\n`).catch(() => undefined);
}

function getLlmDebugStatus() {
  return {
    provider: getLlmProvider(),
    model: getLlmProvider() === "ollama" ? process.env.OLLAMA_MODEL : process.env.LLM_MODEL,
    configured: isLlmProviderConfigured(),
    answerEnabled: process.env.LLM_ANSWER_ENABLED === "true",
    browserPlannerEnabled: process.env.BROWSER_AGENT_LLM_ENABLED === "true",
    baseUrl: getLlmProvider() === "ollama" ? process.env.OLLAMA_BASE_URL : process.env.OPENAI_BASE_URL,
    apiKeyPresent: Boolean(process.env.OPENAI_API_KEY)
  };
}

function truncateForLog(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}... [truncated]` : value;
}

function resolveHeuristicUnknownValue(field: VisibleField, fields: FilledField[], job: Job) {
  const label = normalizeKey(field.label);
  const valueBank = createValueBank(fields);

  if (field.options.length > 0) {
    const lowerOptions = field.options.map((option) => ({ raw: option, normalized: normalizeKey(option) }));

    if (/\b(authorized|eligible|work authorization|legally work)\b/.test(label)) {
      return lowerOptions.find((option) => /\byes\b|authorized|eligible/.test(option.normalized))?.raw;
    }

    if (/\b(sponsorship|visa)\b/.test(label)) {
      const visaRequired = valueBank.get("visa sponsorship required") ?? valueBank.get("visa required");
      return chooseYesNoOption(lowerOptions, /yes|true|required/.test(normalizeKey(visaRequired ?? "")));
    }

    if (/\b(remote|hybrid|onsite|work mode)\b/.test(label)) {
      return lowerOptions.find((option) => normalizeKey(job.workMode).includes(option.normalized) || option.normalized.includes(normalizeKey(job.workMode)))?.raw;
    }

    if (/\b(terms|privacy|consent|agree|acknowledge)\b/.test(label)) {
      return lowerOptions.find((option) => /\byes\b|agree|accept|consent|confirm/.test(option.normalized))?.raw;
    }
  }

  if (/\b(terms|privacy|consent|agree|acknowledge)\b/.test(label)) {
    return "Yes";
  }

  if (/\b(cover letter|message|additional information|anything else)\b/.test(label)) {
    return valueBank.get("message to the hiring team");
  }

  return undefined;
}

function chooseYesNoOption(options: Array<{ raw: string; normalized: string }>, wantsYes: boolean) {
  const yesOption = options.find((option) => /\byes\b|true|required/.test(option.normalized));
  const noOption = options.find((option) => /\bno\b|false|not required|do not/.test(option.normalized));
  return wantsYes ? yesOption?.raw : noOption?.raw;
}

function coerceToOption(answer: string, options: string[]) {
  const normalizedAnswer = normalizeKey(answer);
  const direct = options.find((option) => normalizeKey(option) === normalizedAnswer)
    ?? options.find((option) => normalizeKey(option).includes(normalizedAnswer) || normalizedAnswer.includes(normalizeKey(option)));

  return direct;
}

async function fillByScoredDomMatch(frame: Frame, aliases: string[], value: string) {
  return frame.evaluate(
    ({ labelAliases, fieldValue }) => {
      const normalizedAliases = labelAliases.map(normalize).filter(Boolean);
      const controls = getSearchRoots().flatMap((root) => Array.from(root.querySelectorAll("input, textarea, select"))) as Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>;
      let bestControl: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | undefined;
      let bestScore = 0;

      for (const control of controls) {
        if (isUnsupportedControl(control)) {
          continue;
        }

        const directDescriptor = normalize([
          control.getAttribute("aria-label"),
          control.getAttribute("placeholder"),
          control.getAttribute("name"),
          control.id,
          findLabelText(control)
        ].filter(Boolean).join(" "));
        const nearbyDescriptor = normalize(findNearbyText(control));
        const score = scoreControl(directDescriptor, nearbyDescriptor, normalizedAliases);

        if (score > bestScore) {
          bestScore = score;
          bestControl = control;
        }
      }

      if (!bestControl || bestScore < 30) {
        return false;
      }

      if (bestControl instanceof HTMLSelectElement) {
        const option = Array.from(bestControl.options).find((item) => normalize(item.text).includes(normalize(fieldValue)) || normalize(fieldValue).includes(normalize(item.text)));

        if (!option) {
          return false;
        }

        bestControl.value = option.value;
      } else {
        setNativeValue(bestControl, fieldValue);
      }

      bestControl.dispatchEvent(new Event("input", { bubbles: true }));
      bestControl.dispatchEvent(new Event("change", { bubbles: true }));
      bestControl.dispatchEvent(new Event("blur", { bubbles: true }));
      return true;

      function normalize(value: string) {
        return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      }

      function isUnsupportedControl(control: Element) {
        return control instanceof HTMLInputElement && ["hidden", "file", "checkbox", "radio", "submit", "button"].includes(control.type);
      }

      function findLabelText(control: Element) {
        if (control.id) {
          const root = control.getRootNode();
          const label = ((root instanceof Document || root instanceof ShadowRoot || root instanceof Element)
            ? root.querySelector(`label[for="${CSS.escape(control.id)}"]`)
            : null)
            ?? getSearchRoots().map((searchRoot) => searchRoot.querySelector(`label[for="${CSS.escape(control.id)}"]`)).find(Boolean)
            ?? null;

          if (label?.textContent) {
            return label.textContent;
          }
        }

        return control.closest("label, div, section, article")?.textContent ?? "";
      }

      function findNearbyText(control: Element) {
        const pieces = [
          control.previousElementSibling?.textContent,
          control.parentElement?.previousElementSibling?.textContent,
          control.parentElement?.textContent,
          control.closest("tr")?.textContent,
          control.closest("form")?.textContent
        ];

        return pieces.filter(Boolean).join(" ");
      }

      function scoreControl(directDescriptor: string, nearbyDescriptor: string, aliases: string[]) {
        let score = 0;
        const combinedDescriptor = `${directDescriptor} ${nearbyDescriptor}`;

        for (const alias of aliases) {
          if (!alias) {
            continue;
          }

          if (alias === "name" && /\b(first name|last name|given name|family name|surname)\b/.test(combinedDescriptor)) {
            continue;
          }

          if (directDescriptor === alias) {
            score = Math.max(score, 100);
          } else if (directDescriptor.includes(alias)) {
            score = Math.max(score, alias.length <= 4 ? 52 : 86);
          } else if (alias.includes(directDescriptor) && directDescriptor.length > 2) {
            score = Math.max(score, 68);
          }

          if (nearbyDescriptor === alias) {
            score = Math.max(score, 58);
          } else if (nearbyDescriptor.includes(alias)) {
            score = Math.max(score, alias.length <= 4 ? 32 : 48);
          }
        }

        return score;
      }

      function setNativeValue(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
        const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

        if (descriptor?.set) {
          descriptor.set.call(control, value);
        } else {
          control.value = value;
        }
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
    },
    { labelAliases: aliases, fieldValue: value }
  );
}

async function fillWithPlaywrightLocators(page: Page, aliases: string[], value: string) {
  const candidates = page.frames().flatMap((frame) =>
    aliases.flatMap((alias) => [
      frame.getByLabel(alias, { exact: false }).first(),
      frame.getByPlaceholder(alias, { exact: false }).first(),
      frame.getByRole("textbox", { name: alias, exact: false }).first(),
      frame.getByRole("combobox", { name: alias, exact: false }).first()
    ])
  );

  const locatorTimeout = Number(process.env.BROWSER_LOCATOR_FILL_TIMEOUT_MS ?? 450);

  for (const candidate of candidates) {
    try {
      await candidate.fill(value, { timeout: locatorTimeout });
      await candidate.dispatchEvent("input");
      await candidate.dispatchEvent("change");
      return true;
    } catch (_error) {
      try {
        await candidate.click({ timeout: locatorTimeout });
        await candidate.press(process.platform === "darwin" ? "Meta+A" : "Control+A", { timeout: locatorTimeout });
        await candidate.fill(value, { timeout: locatorTimeout });
        await candidate.press("Enter", { timeout: locatorTimeout });
        return true;
      } catch (_fallbackError) {
        // Try the next strategy.
      }
    }
  }

  return false;
}

function getFieldAliases(label: string) {
  const normalizedLabel = label.toLowerCase().trim();
  const aliases = new Set([label]);

  if (normalizedLabel.includes("first name")) {
    aliases.add("First name");
    aliases.add("First Name");
    aliases.add("firstName");
    aliases.add("Given name");
  }

  if (normalizedLabel.includes("last name")) {
    aliases.add("Last name");
    aliases.add("Last Name");
    aliases.add("lastName");
    aliases.add("Surname");
    aliases.add("Family name");
  }

  if (normalizedLabel.includes("full name") || normalizedLabel === "name") {
    aliases.add("Name");
    aliases.add("Full name");
    aliases.add("Full Name");
    aliases.add("Your name");
  }

  if (normalizedLabel.includes("email")) {
    aliases.add("Email");
    aliases.add("email");
    aliases.add("Email address");
    aliases.add("E-mail");
  }

  if (normalizedLabel.includes("username") || normalizedLabel.includes("user name") || normalizedLabel.includes("login")) {
    aliases.add("Username");
    aliases.add("User name");
    aliases.add("Email");
    aliases.add("Email address");
    aliases.add("Login");
  }

  if (normalizedLabel.includes("password")) {
    aliases.add("Password");
    aliases.add("password");
    aliases.add("Current password");
  }

  if (normalizedLabel.includes("confirm") && normalizedLabel.includes("email")) {
    aliases.add("Confirm your email");
    aliases.add("Confirm email");
    aliases.add("Confirm Email");
    aliases.add("confirmEmail");
    aliases.add("Confirm your email address");
  }

  if (normalizedLabel.includes("phone") || normalizedLabel.includes("mobile") || normalizedLabel.includes("contact")) {
    aliases.add("Phone");
    aliases.add("Phone number");
    aliases.add("phoneNumber");
    aliases.add("Mobile");
    aliases.add("Mobile number");
    aliases.add("Mobile no");
    aliases.add("Contact number");
    aliases.add("WhatsApp number");
  }

  if (normalizedLabel.includes("country")) {
    aliases.add("Country");
    aliases.add("Country/Region");
    aliases.add("Country region");
    aliases.add("Country or region");
    aliases.add("Nationality");
  }

  if (normalizedLabel.includes("location")) {
    aliases.add("Location");
    aliases.add("City");
    aliases.add("Location (City)");
  }

  if (normalizedLabel === "city" || normalizedLabel.includes("city")) {
    aliases.add("City");
    aliases.add("Current city");
  }

  if (normalizedLabel.includes("hiring team") || normalizedLabel.includes("message")) {
    aliases.add("Message to the Hiring Team");
    aliases.add("Message");
    aliases.add("Cover letter");
    aliases.add("Let the company know");
  }

  if (normalizedLabel.includes("linkedin")) {
    aliases.add("LinkedIn");
    aliases.add("Linkedin");
    aliases.add("linkedin");
    aliases.add("LinkedIn profile");
  }

  if (normalizedLabel.includes("website")) {
    aliases.add("Website");
    aliases.add("Portfolio");
    aliases.add("Personal website");
  }

  if (normalizedLabel.includes("authorized") || normalizedLabel.includes("work authorization") || normalizedLabel.includes("eligible")) {
    aliases.add("Work authorization");
    aliases.add("Legally authorized to work");
    aliases.add("Are you legally authorized to work");
    aliases.add("Eligible to work");
  }

  if (normalizedLabel.includes("visa") || normalizedLabel.includes("sponsorship")) {
    aliases.add("Visa sponsorship required");
    aliases.add("Visa required");
    aliases.add("Will you now or in the future require sponsorship");
    aliases.add("Require sponsorship");
  }

  if (normalizedLabel.includes("current") && (normalizedLabel.includes("salary") || normalizedLabel.includes("compensation") || normalizedLabel.includes("ctc"))) {
    aliases.add("Current CTC");
    aliases.add("Current salary");
    aliases.add("Current compensation");
    aliases.add("Current package");
    aliases.add("Current CTC (LPA)");
    aliases.add("Current CTC in LPA");
  } else if (normalizedLabel.includes("expected") && (normalizedLabel.includes("salary") || normalizedLabel.includes("compensation") || normalizedLabel.includes("ctc"))) {
    aliases.add("Expected salary");
    aliases.add("Expected compensation");
    aliases.add("Expected CTC");
    aliases.add("Expected package");
    aliases.add("Expected CTC (LPA)");
  } else if (normalizedLabel.includes("salary") || normalizedLabel.includes("compensation") || normalizedLabel.includes("ctc")) {
    aliases.add("Expected salary");
    aliases.add("Expected compensation");
  }

  return [...aliases];
}

function normalizeKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function attachResume(page: Page, resumePath: string, controlId?: string) {
  if (controlId && await clickUploadCandidate(page, page.locator(`[data-gradlaunch-control-id="${controlId}"]`).first(), resumePath)) {
    return true;
  }

  if (await attachResumeToExistingInputs(page, resumePath)) {
    return true;
  }

  return attachResumeViaFileChooser(page, resumePath);
}

async function attachResumeToExistingInputs(page: Page, resumePath: string) {
  const fileInput = page.locator("input[type='file']");

  try {
    const count = await fileInput.count();
    let uploaded = false;

    for (let index = 0; index < Math.min(count, 4); index += 1) {
      try {
        await fileInput.nth(index).setInputFiles(resumePath, { timeout: 2000 });
        uploaded = true;
      } catch (_error) {
        // Some ATS pages expose duplicate hidden upload controls.
      }
    }

    if (uploaded) {
      return true;
    }
  } catch (_error) {
    return false;
  }

  return false;
}

async function attachResumeViaFileChooser(page: Page, resumePath: string) {
  const uploadLabels = ["Autofill with Resume", "Upload", "Upload resume", "Select your resume", "Choose file", "Attach resume", "Attach"];

  for (const label of uploadLabels) {
    const locators = [
      page.getByRole("button", { name: label, exact: false }),
      page.getByRole("link", { name: label, exact: false }),
      page.getByText(label, { exact: false })
    ];

    for (const locator of locators) {
      const count = await locator.count().catch(() => 0);

      for (let index = 0; index < Math.min(count, 3); index += 1) {
        const candidate = locator.nth(index);

        if (await clickUploadCandidate(page, candidate, resumePath)) {
          return true;
        }
      }
    }
  }

  return false;
}

async function clickUploadCandidate(page: Page, candidate: Locator, resumePath: string) {
  const marker = `gl-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    await candidate.scrollIntoViewIfNeeded({ timeout: 800 });
    const foundAssociatedInput = await candidate.evaluate((element, targetMarker) => {
      const candidates = new Set<HTMLInputElement>();

      const addIfFileInput = (candidate: Element | null | undefined) => {
        if (candidate instanceof HTMLInputElement && candidate.type === "file" && !candidate.disabled) {
          candidates.add(candidate);
        }
      };

      addIfFileInput(element.querySelector("input[type='file']"));
      addIfFileInput(element.closest("label")?.querySelector("input[type='file']"));
      addIfFileInput(element.closest("form, section, article, fieldset, [role='group'], div")?.querySelector("input[type='file']"));

      if (element instanceof HTMLLabelElement && element.htmlFor) {
        addIfFileInput(document.getElementById(element.htmlFor));
      }

      if (element instanceof HTMLElement) {
        let ancestor: Element | null = element;

        for (let depth = 0; depth < 6 && ancestor; depth += 1) {
          addIfFileInput(ancestor.querySelector("input[type='file']"));
          addIfFileInput(ancestor.previousElementSibling?.querySelector("input[type='file']"));
          addIfFileInput(ancestor.nextElementSibling?.querySelector("input[type='file']"));
          ancestor = ancestor.parentElement;
        }
      }

      const target = [...candidates].sort((first, second) => score(second) - score(first))[0];

      if (!target) {
        return false;
      }

      target.setAttribute("data-gradlaunch-upload-target", targetMarker);
      return true;

      function score(input: HTMLInputElement) {
        const descriptor = [
          input.accept,
          input.name,
          input.id,
          input.getAttribute("aria-label"),
          input.getAttribute("data-testid"),
          input.closest("label, section, article, fieldset, [role='group'], div")?.textContent
        ].filter(Boolean).join(" ").toLowerCase();

        let total = 0;

        if (/resume|cv|curriculum vitae/.test(descriptor)) {
          total += 80;
        }

        if (/pdf|doc|docx/.test(input.accept)) {
          total += 12;
        }

        if (/cover letter/.test(descriptor)) {
          total -= 60;
        }

        return total;
      }
    }, marker).catch(() => false);

    if (foundAssociatedInput) {
      const input = page.locator(`[data-gradlaunch-upload-target="${marker}"]`).first();
      await input.setInputFiles(resumePath, { timeout: 2500 });
      return await input.evaluate((control) => {
        return control instanceof HTMLInputElement && (control.files?.length ?? 0) > 0;
      }).catch(() => false);
    }

    return attachResumeToExistingInputs(page, resumePath);
  } catch (_error) {
    return false;
  } finally {
    await page.locator(`[data-gradlaunch-upload-target="${marker}"]`).first().evaluate((control) => {
      if (control instanceof HTMLElement) {
        control.removeAttribute("data-gradlaunch-upload-target");
      }
    }).catch(() => undefined);
  }
}

async function hasFileUpload(page: Page) {
  return page.locator("input[type='file']").count().then((count) => count > 0).catch(() => false);
}

async function getActivePage(context: BrowserContext, fallbackPage: Page) {
  await fallbackPage.waitForTimeout(500).catch(() => undefined);
  const pages = context.pages().filter((page) => !page.isClosed());
  const page = pages.includes(fallbackPage) ? fallbackPage : pages.at(-1) ?? fallbackPage;
  page.setDefaultTimeout(Number(process.env.BROWSER_STEP_TIMEOUT_MS ?? 2500));
  await page.bringToFront().catch(() => undefined);
  return page;
}

async function clickSoftGate(page: Page) {
  const labels = ["Accept", "Accept all", "Continue", "I agree"];

  for (const label of labels) {
    try {
      await page.getByRole("button", { name: label, exact: false }).first().click({ timeout: 800 });
      return;
    } catch (_error) {
      // Cookie banners and soft gates vary by site.
    }
  }
}

async function clickFinalSubmit(page: Page) {
  const roleLabels = ["Submit application", "Submit Application", "Submit", "Apply"];

  for (const label of roleLabels) {
    try {
      await page.getByRole("button", { name: label, exact: false }).last().click({ timeout: 1500 });
      return true;
    } catch (_error) {
      // Continue to selector-based matching.
    }
  }

  const submitSelectors = [
    "button[type='submit']",
    "input[type='submit']",
    "button:has-text('Submit application')",
    "button:has-text('Submit Application')",
    "button:has-text('Submit')",
    "button:has-text('Apply')",
    "input[value*='Submit']",
    "input[value*='Apply']"
  ];

  for (const selector of submitSelectors) {
    try {
      const control = page.locator(selector).last();
      await control.scrollIntoViewIfNeeded({ timeout: 1200 });
      await control.click({ timeout: 1500 });
      return true;
    } catch (_error) {
      // Keep trying lower-confidence selectors.
    }
  }

  return page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll("button, input[type='submit'], input[type='button']")) as Array<HTMLButtonElement | HTMLInputElement>;
    const submitControl = controls.find((control) => {
      const text = `${control.textContent ?? ""} ${control.value ?? ""}`.toLowerCase();
      return /submit|apply|send application/.test(text);
    }) ?? controls.find((control) => control instanceof HTMLButtonElement && control.type === "submit");

    if (!submitControl) {
      return false;
    }

    submitControl.click();
    return true;
  });
}

async function looksBlocked(page: Page) {
  const checkpoint = await detectProtectedCheckpoint(page);
  return checkpoint.blocked;
}

async function detectProtectedCheckpoint(page: Page): Promise<ProtectedCheckpointDetection> {
  return page.evaluate(() => {
    function normalize(value: string) {
      return value.toLowerCase().replace(/\s+/g, " ").trim();
    }

    function isVisible(element: Element | null) {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0 && rect.width > 0 && rect.height > 0;
    }

    function getResponseValue(name: string) {
      const field = document.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLTextAreaElement | null;
      return field?.value?.trim() ?? "";
    }

    function hasVisibleSelector(selector: string) {
      return Array.from(document.querySelectorAll(selector)).some((element) => isVisible(element));
    }

    const bodyText = normalize(document.body?.innerText ?? "");
    const iframeCaptcha = Array.from(document.querySelectorAll("iframe")).some((frame) => {
      if (!isVisible(frame)) {
        return false;
      }

      const descriptor = normalize(`${frame.getAttribute("src") ?? ""} ${frame.getAttribute("title") ?? ""} ${frame.getAttribute("name") ?? ""} ${frame.getAttribute("aria-label") ?? ""}`);
      return /recaptcha|hcaptcha|turnstile|cloudflare|captcha|robot|challenge/.test(descriptor);
    });

    const visiblePasswordField = Array.from(document.querySelectorAll("input[type='password']")).some((field) => isVisible(field));
    const visibleOtpField = Array.from(document.querySelectorAll("input, textarea")).some((field) => {
      if (!isVisible(field)) {
        return false;
      }

      const descriptor = normalize([
        field.getAttribute("autocomplete") ?? "",
        field.getAttribute("name") ?? "",
        field.getAttribute("id") ?? "",
        field.getAttribute("aria-label") ?? "",
        field.getAttribute("placeholder") ?? "",
        field.getAttribute("inputmode") ?? ""
      ].join(" "));

      return /one-time-code|one time passcode|one time code|otp|verification code|security code|authenticator|two factor|2fa|mfa/.test(descriptor);
    });

    const recaptchaSolved = getResponseValue("g-recaptcha-response").length > 0;
    const hcaptchaSolved = getResponseValue("h-captcha-response").length > 0;
    const turnstileSolved = getResponseValue("cf-turnstile-response").length > 0;
    const hasSolvedCaptchaResponse = recaptchaSolved || hcaptchaSolved || turnstileSolved;

    const explicitCaptchaText = /captcha|verify you are human|human verification|security check|i am not a robot|i'm not a robot|press and hold|complete the security check|challenge expired/.test(bodyText);
    const visibleCaptchaWidget = hasVisibleSelector(".g-recaptcha, .h-captcha, .cf-turnstile, iframe[title*='captcha' i], iframe[title*='robot' i], iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='turnstile'], iframe[src*='challenges.cloudflare'], [aria-label*='captcha' i], [title*='captcha' i]");

    if ((explicitCaptchaText || visibleCaptchaWidget || iframeCaptcha) && !hasSolvedCaptchaResponse) {
      return {
        blocked: true,
        kind: "captcha" as const,
        reason: "Human intervention needed: complete the captcha or security check in the open browser. GradLaunch is monitoring the page and will resume automatically once verification clears."
      };
    }

    if (visiblePasswordField && /sign in|log in|login|password|continue with email|continue with google|account/.test(bodyText)) {
      return {
        blocked: true,
        kind: "login" as const,
        reason: "Human intervention needed: sign in to the job portal in the open browser. GradLaunch is monitoring the page and will resume automatically after login."
      };
    }

    if (visibleOtpField || /otp|verification code|one time passcode|one-time passcode|one time code|two factor|2fa|mfa|enter the code we sent|security code|authenticator app/.test(bodyText)) {
      return {
        blocked: true,
        kind: "otp" as const,
        reason: "Human intervention needed: complete the OTP or verification code step in the open browser. GradLaunch is monitoring the page and will resume automatically once the code step clears."
      };
    }

    if (/manual verification|manual attention|security challenge|protected checkpoint|additional verification/.test(bodyText)) {
      return {
        blocked: true,
        kind: "verification" as const,
        reason: "Human intervention needed: complete the verification step in the open browser. GradLaunch is monitoring the page and will resume automatically once the page is clear."
      };
    }

    return { blocked: false };
  }).catch(() => ({ blocked: false }));
}

async function pushScreenshot(screenshots: string[], page: Page, workspacePath: string, filename: string) {
  const screenshot = await saveScreenshot(page, workspacePath, filename);

  if (screenshot) {
    screenshots.push(screenshot);
  }
}

async function saveScreenshot(page: Page, workspacePath: string, filename: string) {
  const path = join(workspacePath, filename);

  try {
    await page.screenshot({
      path,
      fullPage: false,
      animations: "disabled",
      timeout: Number(process.env.BROWSER_SCREENSHOT_TIMEOUT_MS ?? 1500)
    });
    return filename;
  } catch (_error) {
    try {
      await page.screenshot({
        path,
        fullPage: false,
        timeout: Number(process.env.BROWSER_SCREENSHOT_FALLBACK_TIMEOUT_MS ?? 800)
      });
      return filename;
    } catch (_fallbackError) {
      return undefined;
    }
  }
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

function shouldSkipField(field: FilledField) {
  const normalizedLabel = field.label.toLowerCase().trim();
  return transientLabels.some((label) => normalizedLabel === label);
}

function resolveChromePath() {
  return process.env.CHROME_EXECUTABLE_PATH ?? defaultChromePath;
}

async function resolveManagedChromeCdpUrl() {
  const configuredValue = process.env.BROWSER_CDP_URL?.trim();

  if (configuredValue) {
    return configuredValue;
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

async function pathExists(path: string) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch (_error) {
    return false;
  }
}
