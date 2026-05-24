import type { FilledField, Job, StudentMemory, StudentProfile } from "@gradlaunch/shared";
import type { Page } from "playwright-core";
import { buildStageAnswerPlan } from "./answer";
import { fillFormField } from "./fill";
import { discoverVisibleFields, getVisibleRequiredEmptyLabels, getVisibleValidationMessages } from "./observe";
import { fieldSemanticText, semanticKey, semanticSimilarity } from "./semantic-nlp";
import type { BrowserFillField, StageAnswerPlan, VisibleField } from "./types";
import { dedupeLabels, normalizeKey, writeBrowserDebug } from "./util";

// Autonomous fill is the page-level solver. It does not trust a single fill
// pass. For every stage it builds an answer plan, fills by field type, verifies
// committed DOM values, repairs failed known fields, and returns only after the
// current screen has been re-read.
type AutonomousStageFillInput = {
  page: Page;
  stageIndex: number;
  visibleFields: VisibleField[];
  baseFields: FilledField[];
  job: Job;
  student?: StudentProfile;
  memory?: StudentMemory;
  resumeText?: string;
  workspacePath: string;
  shouldStop?: () => Promise<boolean>;
};

export type AutonomousFieldAttempt = {
  field: BrowserFillField;
  filled: boolean;
  verified: boolean;
  alreadySatisfied: boolean;
  round: number;
};

export type AutonomousStageFillResult = {
  stopped: boolean;
  answerPlan?: StageAnswerPlan;
  attempts: AutonomousFieldAttempt[];
  failedFields: BrowserFillField[];
  visibleFields: VisibleField[];
  outstandingRequired: string[];
  validationMessages: string[];
};

type FieldVerification = {
  satisfied: boolean;
  reason: string;
};

type SemanticFieldIntent =
  | "first_name"
  | "middle_name"
  | "last_name"
  | "full_name"
  | "address_1"
  | "address_2"
  | "country"
  | "state"
  | "city"
  | "postal_code"
  | "email"
  | "phone"
  | "degree_name"
  | "degree_type"
  | "university"
  | "education_start"
  | "education_end"
  | "work_experience"
  | "profile_url"
  | "consent"
  | "preferred_name_choice";

// Runs the full autonomous fill cycle for one page/stage. It builds answers,
// fills fields with type-specific strategies, verifies each result, re-scans
// dynamic fields, repairs failed known fields, and returns remaining blockers.
export async function runAutonomousStageFill(input: AutonomousStageFillInput): Promise<AutonomousStageFillResult> {
  const maxRounds = Number(process.env.BROWSER_AUTONOMOUS_FILL_ROUNDS ?? 3);
  const attempts: AutonomousFieldAttempt[] = [];
  const answerMap = new Map<string, BrowserFillField>();
  let latestPlan: StageAnswerPlan | undefined;
  // Start with a fresh runtime graph because many ATS pages re-render fields
  // after resume parsing, dropdown selection, or validation.
  let visibleFields = await discoverRuntimeVisibleFields(input.page, input.visibleFields);
  let failedFields: BrowserFillField[] = [];
  let lastBlockerKey = "";
  let lastPlanSignature = "";

  await writeBrowserDebug(input.workspacePath, "autonomous-form-graph", {
    stageIndex: input.stageIndex,
    fieldCount: visibleFields.length,
    fields: visibleFields.map((field) => ({
      id: field.id,
      label: field.label,
      placeholder: field.placeholder,
      name: field.name,
      ariaLabel: field.ariaLabel,
      inputType: field.inputType,
      required: field.required,
      options: field.options.slice(0, 8),
      context: field.context.slice(0, 160)
    })).slice(0, 40)
  });

  for (let round = 0; round < maxRounds; round += 1) {
    if (await input.shouldStop?.()) {
      return {
        stopped: true,
        answerPlan: latestPlan,
        attempts,
        failedFields,
        visibleFields,
        outstandingRequired: [],
        validationMessages: []
      };
    }

    const planSignature = getVisibleFieldPlanSignature(visibleFields);

    // Rebuild answers only when the visible field graph changes. This keeps
    // retry rounds fast while still adapting when new required fields appear.
    if (!latestPlan || planSignature !== lastPlanSignature) {
      latestPlan = await buildStageAnswerPlan({
        job: input.job,
        visibleFields,
        baseFields: input.baseFields,
        student: input.student,
        memory: input.memory,
        resumeText: input.resumeText,
        workspacePath: input.workspacePath
      });
      lastPlanSignature = planSignature;
    } else {
      await writeBrowserDebug(input.workspacePath, "autonomous-fill-plan-cache-hit", {
        stageIndex: input.stageIndex,
        round,
        visibleFieldCount: visibleFields.length
      });
    }

    for (const answer of latestPlan.answers) {
      answerMap.set(fieldAttemptKey(answer), answer);
    }

    // Rounds get narrower over time: first try all known answers, then retry
    // only failed or required fields. That avoids repeatedly rewriting fields
    // that already verified.
    const roundAnswers = latestPlan.answers.filter((field) => shouldAttemptField(field, attempts, round));

    await writeBrowserDebug(input.workspacePath, "autonomous-fill-round", {
      stageIndex: input.stageIndex,
      round,
      visibleFieldCount: visibleFields.length,
      answerCount: latestPlan.answers.length,
      attemptCount: roundAnswers.length,
      summary: latestPlan.summary,
      unresolvedRequiredLabels: latestPlan.unresolvedRequiredLabels
    });

    if (roundAnswers.length === 0) {
      break;
    }

    let roundProgress = 0;
    const roundFailures: BrowserFillField[] = [];

    for (const field of roundAnswers) {
      if (await input.shouldStop?.()) {
        return {
          stopped: true,
          answerPlan: latestPlan,
          attempts,
          failedFields,
          visibleFields,
          outstandingRequired: [],
          validationMessages: []
        };
      }

      // Verification before filling preserves prefilled portal values that are
      // already accepted by the site.
      const before = await verifyFieldAnswer(input.page, field);

      if (before.satisfied) {
        attempts.push({
          field,
          filled: true,
          verified: true,
          alreadySatisfied: true,
          round
        });
        roundProgress += 1;
        continue;
      }

      // fillFormField performs the field-type-specific strategy selection:
      // text, native select, custom select, autocomplete, radio, checkbox, etc.
      const filled = await fillFormField(input.page, field);
      await input.page.waitForTimeout(180).catch(() => undefined);
      const after = await verifyFieldAnswer(input.page, field);
      const verified = after.satisfied;

      attempts.push({
        field,
        filled,
        verified,
        alreadySatisfied: false,
        round
      });

      await writeBrowserDebug(input.workspacePath, verified ? "autonomous-field-verified" : "autonomous-field-unverified", {
        stageIndex: input.stageIndex,
        round,
        fieldId: field.fieldId,
        label: field.label,
        inputType: field.inputType,
        valuePreview: field.value.length > 80 ? `${field.value.slice(0, 77)}...` : field.value,
        filled,
        verificationReason: after.reason
      });

      if (verified) {
        roundProgress += 1;
      } else {
        roundFailures.push(field);
      }
    }

    failedFields = roundFailures;
    // Re-observe after each round because answering one question can reveal
    // additional required fields or mutate input ids.
    visibleFields = await discoverRuntimeVisibleFields(input.page, await discoverVisibleFields(input.page));
    const outstandingRequired = await getVisibleRequiredEmptyLabels(input.page);
    const validationMessages = await getVisibleValidationMessages(input.page);
    const blockerKey = normalizeKey([...outstandingRequired, ...validationMessages].join(" "));

    await writeBrowserDebug(input.workspacePath, "autonomous-fill-round-result", {
      stageIndex: input.stageIndex,
      round,
      roundProgress,
      failedLabels: roundFailures.map((field) => field.label),
      outstandingRequired,
      validationMessages
    });

    if (outstandingRequired.length === 0 && validationMessages.length === 0 && roundFailures.length === 0) {
      break;
    }

    if (roundProgress === 0 && blockerKey && blockerKey === lastBlockerKey) {
      break;
    }

    lastBlockerKey = blockerKey;
  }

  if (latestPlan) {
    // Hard verification is a second safety net for critical profile facts such
    // as country, city, email, phone, education, and work-experience choices.
    // It catches fields that looked filled but were not accepted by the portal.
    const repair = await verifyAndRepairKnownFields({
      ...input,
      fields: [...answerMap.values()],
      startRound: maxRounds,
      alreadyVerifiedKeys: new Set(
        attempts
          .filter((attempt) => attempt.verified)
          .map((attempt) => fieldAttemptKey(attempt.field))
      )
    });

    attempts.push(...repair.attempts);
    visibleFields = repair.visibleFields;
    failedFields = repair.failedFields;

    if (repair.attempts.length > 0 || repair.failedFields.length > 0) {
      await writeBrowserDebug(input.workspacePath, "autonomous-hard-verification-result", {
        stageIndex: input.stageIndex,
        attempted: repair.attempts.length,
        repaired: repair.attempts.filter((attempt) => attempt.verified && !attempt.alreadySatisfied).length,
        failedLabels: repair.failedFields.map((field) => field.label)
      });
    }
  }

  const outstandingRequired = await getVisibleRequiredEmptyLabels(input.page);
  const validationMessages = await getVisibleValidationMessages(input.page);
  const answerPlan = latestPlan
    ? {
        ...latestPlan,
        answers: [...answerMap.values()],
        unresolvedRequiredLabels: dedupeLabels([
          ...latestPlan.unresolvedRequiredLabels,
          ...outstandingRequired
        ])
      }
    : undefined;

  return {
    stopped: false,
    answerPlan,
    attempts,
    failedFields,
    visibleFields,
    outstandingRequired,
    validationMessages
  };
}

// Performs the hard verification/repair pass after normal fill rounds. It
// focuses on required and high-value profile facts that portals often mark as
// visually filled but not actually accepted.
async function verifyAndRepairKnownFields(input: AutonomousStageFillInput & {
  fields: BrowserFillField[];
  startRound: number;
  alreadyVerifiedKeys: Set<string>;
}) {
  // Repair works from the latest DOM, not stale field handles. Each candidate
  // is remapped to the current visible field graph before retrying.
  const maxRepairRounds = Number(process.env.BROWSER_AUTONOMOUS_REPAIR_ROUNDS ?? 2);
  const repairAttempts: AutonomousFieldAttempt[] = [];
  const failedFields: BrowserFillField[] = [];
  let visibleFields = await discoverRuntimeVisibleFields(input.page, await discoverVisibleFields(input.page));
  const candidates = dedupeRepairFields(input.fields)
    .filter((field) => shouldHardVerifyField(field))
    .filter((field) => !input.alreadyVerifiedKeys.has(fieldAttemptKey(field)) || shouldReverifyCriticalField(field));

  if (candidates.length === 0) {
    return {
      attempts: repairAttempts,
      failedFields,
      visibleFields
    };
  }

  await writeBrowserDebug(input.workspacePath, "autonomous-hard-verification-start", {
    stageIndex: input.stageIndex,
    fieldLabels: candidates.map((field) => field.label)
  });

  for (const originalField of candidates) {
    if (await input.shouldStop?.()) {
      break;
    }

    let field = remapFieldToVisibleField(originalField, visibleFields);
    let verification = await verifyFieldAnswer(input.page, field);

    if (verification.satisfied) {
      repairAttempts.push({
        field,
        filled: true,
        verified: true,
        alreadySatisfied: true,
        round: input.startRound
      });
      continue;
    }

    let repaired = false;
    let lastVerification = verification;

    for (let repairRound = 0; repairRound < maxRepairRounds; repairRound += 1) {
      if (await input.shouldStop?.()) {
        break;
      }

      const filled = await fillFormField(input.page, field);
      await input.page.waitForTimeout(repairRound === 0 ? 260 : 520).catch(() => undefined);
      lastVerification = await verifyFieldAnswer(input.page, field);
      const verified = lastVerification.satisfied;

      repairAttempts.push({
        field,
        filled,
        verified,
        alreadySatisfied: false,
        round: input.startRound + repairRound
      });

      await writeBrowserDebug(input.workspacePath, verified ? "autonomous-repair-field-verified" : "autonomous-repair-field-unverified", {
        stageIndex: input.stageIndex,
        round: input.startRound + repairRound,
        originalLabel: originalField.label,
        fieldId: field.fieldId,
        label: field.label,
        inputType: field.inputType,
        semanticIntent: inferSemanticFieldIntent(field.label, field.value),
        valuePreview: field.value.length > 80 ? `${field.value.slice(0, 77)}...` : field.value,
        filled,
        verificationReason: lastVerification.reason
      });

      if (verified) {
        repaired = true;
        break;
      }

      visibleFields = await discoverRuntimeVisibleFields(input.page, await discoverVisibleFields(input.page));
      field = remapFieldToVisibleField(originalField, visibleFields);
      verification = await verifyFieldAnswer(input.page, field);

      if (verification.satisfied) {
        repairAttempts.push({
          field,
          filled: true,
          verified: true,
          alreadySatisfied: true,
          round: input.startRound + repairRound
        });
        repaired = true;
        break;
      }
    }

    if (!repaired) {
      failedFields.push(field);
    }
  }

  visibleFields = await discoverRuntimeVisibleFields(input.page, await discoverVisibleFields(input.page));

  return {
    attempts: repairAttempts,
    failedFields,
    visibleFields
  };
}

// Deduplicates repair candidates by semantic field key, preferring required
// fields and shorter/cleaner labels when multiple answers refer to the same
// logical control.
function dedupeRepairFields(fields: BrowserFillField[]) {
  const byKey = new Map<string, BrowserFillField>();

  for (const field of fields) {
    const key = fieldAttemptKey(field);
    const existing = byKey.get(key);

    if (!existing || (field.required && !existing.required) || field.label.length < existing.label.length) {
      byKey.set(key, field);
    }
  }

  return [...byKey.values()];
}

// Decides whether a field should be included in hard verification. Optional
// low-risk fields are skipped; required and semantically important fields are
// rechecked.
function shouldHardVerifyField(field: BrowserFillField) {
  if (!field.value.trim() || field.inputType === "file") {
    return false;
  }

  if (isOptionalLowRiskField(field.label)) {
    return false;
  }

  return Boolean(field.required || inferSemanticFieldIntent(field.label, field.value));
}

// Identifies critical profile facts that should be reverified even if an
// earlier attempt appeared successful.
function shouldReverifyCriticalField(field: BrowserFillField) {
  const intent = inferSemanticFieldIntent(field.label, field.value);

  return Boolean(intent && [
    "address_1",
    "country",
    "state",
    "city",
    "postal_code",
    "email",
    "phone",
    "degree_name",
    "degree_type",
    "university",
    "education_start",
    "education_end",
    "work_experience"
  ].includes(intent));
}

// Filters optional fields that should not block the agent if they remain empty
// or unverifiable.
function isOptionalLowRiskField(label: string) {
  return /\b(address line 2|address 2|middle name|preferred first|preferred last|preferred name)\b/i.test(label);
}

// Remaps an old answer to the best currently visible field after the page has
// re-rendered or validation has replaced DOM nodes.
function remapFieldToVisibleField(field: BrowserFillField, visibleFields: VisibleField[]) {
  // Sites frequently replace nodes after validation. Remapping keeps the
  // original answer but updates field id/type/options to the current DOM node.
  const best = visibleFields
    .map((visibleField) => ({
      field: visibleField,
      score: scoreVisibleFieldForAnswer(field, visibleField)
    }))
    .sort((left, right) => right.score - left.score)[0];

  if (!best || best.score < 54) {
    return field;
  }

  return {
    ...field,
    fieldId: best.field.id,
    label: best.field.label,
    inputType: best.field.inputType,
    options: best.field.options,
    placeholder: best.field.placeholder,
    name: best.field.name,
    ariaLabel: best.field.ariaLabel,
    autocomplete: best.field.autocomplete,
    role: best.field.role,
    required: field.required || best.field.required,
    reason: field.reason
      ? `${field.reason} Remapped to the current live DOM field.`
      : "Remapped to the current live DOM field."
  };
}

// Scores how well a newly observed field matches an existing planned answer
// using id, semantic intent, label similarity, type, and required status.
function scoreVisibleFieldForAnswer(answer: BrowserFillField, visibleField: VisibleField) {
  const answerLabel = normalizeSemanticLabel(fieldSemanticText(answer));
  const visibleLabel = normalizeSemanticLabel(fieldSemanticText(visibleField));
  const answerIntent = inferSemanticFieldIntent(fieldSemanticText(answer), answer.value);
  const visibleIntent = inferSemanticFieldIntent(fieldSemanticText(visibleField), answer.value);
  let score = 0;

  if (answer.fieldId && answer.fieldId === visibleField.id) {
    score += 80;
  }

  if (answerIntent && visibleIntent && answerIntent === visibleIntent) {
    score += 110;
  }

  if (answerLabel && visibleLabel) {
    if (answerLabel === visibleLabel) {
      score += 90;
    } else if (visibleLabel.includes(answerLabel) || answerLabel.includes(visibleLabel)) {
      score += 68;
    }

    score += tokenSimilarityScore(answerLabel, visibleLabel, 55);
    score += Math.round(semanticSimilarity(answerLabel, visibleLabel) * 42);
  }

  if (normalizeFieldInputType(answer.inputType) === normalizeFieldInputType(visibleField.inputType)) {
    score += 24;
  }

  if (visibleField.required) {
    score += 8;
  }

  if (answerIntent && visibleIntent && answerIntent !== visibleIntent) {
    score -= 85;
  }

  if (isOptionalLowRiskField(visibleField.label) && !isOptionalLowRiskField(answer.label)) {
    score -= 60;
  }

  return score;
}

// Decides whether the current round should attempt a field. Verified fields are
// skipped; later rounds focus on failed or required fields.
function shouldAttemptField(field: BrowserFillField, attempts: AutonomousFieldAttempt[], round: number) {
  if (!field.value.trim() || field.inputType === "file") {
    return false;
  }

  const key = fieldAttemptKey(field);
  const previous = attempts.filter((attempt) => fieldAttemptKey(attempt.field) === key);

  if (previous.some((attempt) => attempt.verified)) {
    return false;
  }

  if (round === 0) {
    return true;
  }

  return previous.length > 0 || field.required;
}

// Builds the stable key used to group attempts for the same logical answer.
function fieldAttemptKey(field: BrowserFillField) {
  if (isChoiceInputType(field.inputType) && isStandaloneChoiceLabel(field.label)) {
    return `${normalizeFieldInputType(field.inputType)}:${normalizeSemanticLabel(field.label)}`;
  }

  return `${normalizeFieldInputType(field.inputType)}:${inferSemanticFieldIntent(fieldSemanticText(field), field.value) ?? normalizeSemanticLabel(fieldSemanticText(field))}`;
}

// Builds the stable key used to deduplicate visible fields discovered from the
// observer and fresh runtime DOM scan.
function semanticVisibleFieldKey(field: VisibleField) {
  if (isChoiceInputType(field.inputType) && isStandaloneChoiceLabel(field.label)) {
    return `${normalizeFieldInputType(field.inputType)}:${normalizeSemanticLabel(field.label)}`;
  }

  return `${normalizeFieldInputType(field.inputType)}:${inferSemanticFieldIntent(fieldSemanticText(field)) ?? normalizeSemanticLabel(fieldSemanticText(field))}`;
}

// Returns true for radio/checkbox input types, which require group-level
// handling instead of plain text filling.
function isChoiceInputType(inputType: string | undefined) {
  return inputType === "radio" || inputType === "checkbox";
}

// Detects labels that are actual choice options, such as Yes/No or country
// names, so they are grouped correctly during dedupe and verification.
function isStandaloneChoiceLabel(label: string) {
  const normalized = normalizeKey(label);

  return /^(yes|no|no thanks|no thank you|i agree|agree|accept|decline|not now|skip|continue|true|false)$/.test(normalized)
    || /^(australia|belgium|brazil|canada|france|germany|india|indonesia|ireland|israel|italy|japan|luxembourg|malaysia|mexico|new zealand|poland|portugal|romania|singapore|south korea|spain|sweden|switzerland|thailand|the netherlands|netherlands|uae|uk|us|united states|united kingdom)$/.test(normalized);
}

// Normalizes input types into the smaller set used by attempt/field keys.
function normalizeFieldInputType(inputType: string | undefined) {
  const normalized = normalizeKey(inputType ?? "");

  if (normalized === "combobox") {
    return "select";
  }

  return normalized || "text";
}

// Removes placeholder and validation words from labels before semantic
// comparison.
function normalizeSemanticLabel(label: string) {
  return semanticKey(label)
    .replace(/\b(select an option|choose an option|please select|none selected|required|field required)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Creates a signature for the currently visible field graph. When this changes,
// the answer plan must be rebuilt because the page likely revealed new fields.
function getVisibleFieldPlanSignature(fields: VisibleField[]) {
  return fields
    .map((field) => [
      normalizeKey(field.label),
      field.inputType,
      field.required ? "required" : "optional",
      semanticKey(`${field.placeholder ?? ""} ${field.name ?? ""} ${field.ariaLabel ?? ""}`),
      field.options.map((option) => normalizeKey(option)).join("/")
    ].join(":"))
    .sort()
    .join("|");
}

// Re-scans the live DOM for current visible fields, merges those with the seed
// observer fields, and deduplicates by semantic key.
async function discoverRuntimeVisibleFields(page: Page, seedFields: VisibleField[]) {
  // The observer gives the first field list, then this runtime scan supplements
  // it with fresh ids and current input types from every frame/shadow root.
  const runtimeFields: VisibleField[] = [];

  for (const frame of page.frames()) {
    const frameFields = await frame.evaluate(() => {
      const searchRoots = getSearchRoots();
      const controls = searchRoots.flatMap((root) => Array.from(root.querySelectorAll("input, textarea, select"))) as Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>;
      const fields: VisibleField[] = [];

      for (const [index, control] of controls.entries()) {
        if (!isUsableControl(control)) {
          continue;
        }

        const label = clean(findFieldLabel(control) || findNearbyLabel(control));

        if (!label || isNoiseLabel(label)) {
          continue;
        }

        const id = control.getAttribute("data-gradlaunch-field-id") || `gl-runtime-field-${index}-${normalizeId(label)}`;
        control.setAttribute("data-gradlaunch-field-id", id);

        fields.push({
          id,
          label,
          placeholder: clean(control.getAttribute("placeholder")),
          name: clean(control.getAttribute("name")),
          ariaLabel: clean(control.getAttribute("aria-label")),
          autocomplete: control instanceof HTMLInputElement ? clean(control.getAttribute("autocomplete")) : "",
          role: clean(control.getAttribute("role")),
          required: isRequired(control, label),
          tagName: control.tagName.toLowerCase(),
          inputType: control instanceof HTMLSelectElement
            ? getVisibleCustomSelectProxy(control) ? "combobox" : "select"
            : control instanceof HTMLInputElement
              ? normalizeInputType(control)
              : "textarea",
          options: control instanceof HTMLSelectElement
            ? Array.from(control.options).map((option) => clean(option.textContent ?? option.value)).filter(Boolean).slice(0, 20)
            : control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type)
              ? [label]
              : [],
          context: clean(findFieldContext(control))
        });
      }

      return fields;

      function isUsableControl(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
        if (control.disabled || control.getAttribute("aria-disabled") === "true") {
          return false;
        }

        if (isInactiveFormBranch(control)) {
          return false;
        }

        if (control instanceof HTMLInputElement && ["hidden", "file", "submit", "button", "image", "reset"].includes(control.type)) {
          return false;
        }

        const rect = control.getBoundingClientRect();
        const style = window.getComputedStyle(control);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
          || control instanceof HTMLSelectElement && Boolean(getVisibleCustomSelectProxy(control));
      }

      function isInactiveFormBranch(control: Element) {
        if (control.closest(".datasetField__row--sample") || control.hasAttribute("hidden")) {
          return true;
        }

        if (control.parentElement?.closest("[hidden], [aria-hidden='true']")) {
          return true;
        }

        const id = control.getAttribute("id") ?? "";
        const name = control.getAttribute("name") ?? "";
        return /(^|-)sample($|-)/i.test(id) || /(^|-)sample($|-)/i.test(name);
      }

      function getVisibleCustomSelectProxy(control: HTMLSelectElement) {
        if (!isCustomSelectElement(control)) {
          return undefined;
        }

        const candidates = [
          control.nextElementSibling,
          control.parentElement?.querySelector("[role='combobox']"),
          control.parentElement?.querySelector(".select2 [role='combobox']"),
          control.id ? getElementById(`select2-${control.id}-container`)?.closest("[role='combobox']") : null,
          control.id ? queryFirst(`.select2Container${CSS.escape(control.id)}`, control) : null,
          control.id ? queryFirst(`[aria-labelledby~="${CSS.escape(`${control.id}-label`)}"][role='combobox']`, control) : null
        ];

        for (const candidate of candidates) {
          const element = candidate instanceof HTMLElement
            ? candidate
            : candidate instanceof Element
              ? candidate.querySelector("[role='combobox']") as HTMLElement | null
              : null;

          if (element && isVisibleElement(element)) {
            return element;
          }
        }

        return undefined;
      }

      function isCustomSelectElement(control: HTMLSelectElement) {
        const className = String(control.getAttribute("class") ?? "");
        return control.getAttribute("aria-hidden") === "true"
          || /\b(select2-hidden-accessible|select2|autocomplete|combobox)\b/i.test(className)
          || Boolean(control.parentElement?.querySelector(".select2, [role='combobox'], [aria-haspopup='true'], [aria-haspopup='listbox']"));
      }

      function isVisibleElement(element: Element) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      }

      function normalizeInputType(control: HTMLInputElement) {
        const descriptor = normalize(`${control.type} ${control.getAttribute("role") ?? ""} ${control.getAttribute("aria-haspopup") ?? ""} ${control.getAttribute("aria-expanded") ?? ""} ${control.className}`);

        if (/\b(combobox|listbox|autocomplete|select)\b/.test(descriptor) || control.getAttribute("role") === "combobox") {
          return "combobox";
        }

        return control.type || "text";
      }

      function isRequired(control: Element, label: string) {
        const context = findFieldContext(control);

        return (control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).required
          || control.getAttribute("aria-required") === "true"
          || control.getAttribute("aria-invalid") === "true"
          || /\*/.test(label)
          || /\*/.test(context)
          || Boolean(control.closest(".required, [class*='required'], [data-required='true']"))
          || /\b(this field is required|required field|please select|please enter|cannot be blank)\b/i.test(context);
      }

      function findFieldLabel(control: Element) {
        if (control.id) {
          const label = queryFirst(`label[for="${CSS.escape(control.id)}"]`, control);

          if (label?.textContent?.trim()) {
            return label.textContent.trim();
          }
        }

        const labelledBy = control.getAttribute("aria-labelledby");

        if (labelledBy) {
          const text = labelledBy
            .split(/\s+/)
            .map((id) => getElementById(id)?.textContent ?? "")
            .join(" ")
            .trim();

          if (text) {
            return text;
          }
        }

        return control.closest("label")?.textContent?.trim()
          || control.closest("fieldset")?.querySelector("legend")?.textContent?.trim()
          || control.getAttribute("aria-label")
          || control.getAttribute("placeholder")
          || control.getAttribute("name")
          || "";
      }

      function findNearbyLabel(control: Element) {
        let ancestor: Element | null = control.parentElement;

        for (let depth = 0; depth < 5 && ancestor; depth += 1) {
          const labels = Array.from(ancestor.querySelectorAll("label, legend, h1, h2, h3, h4, [class*='label'], [class*='Label']")) as HTMLElement[];
          const nearest = labels
            .map((element) => ({
              text: clean(element.innerText || element.textContent || ""),
              distance: distanceBetween(element, control)
            }))
            .filter((item) => item.text && item.text.length <= 140)
            .sort((left, right) => left.distance - right.distance)[0];

          if (nearest?.text) {
            return nearest.text;
          }

          const previous = ancestor.previousElementSibling?.textContent?.trim();

          if (previous) {
            return previous;
          }

          ancestor = ancestor.parentElement;
        }

        return "";
      }

      function findFieldContext(control: Element) {
        const container = control.closest("label, fieldset, [role='group'], [role='radiogroup'], [class*='field'], [class*='input'], [class*='form'], section, article, div");
        return container?.textContent ?? "";
      }

      function distanceBetween(label: Element, control: Element) {
        const labelRect = label.getBoundingClientRect();
        const controlRect = control.getBoundingClientRect();
        return Math.abs(labelRect.bottom - controlRect.top) + Math.abs(labelRect.left - controlRect.left) / 4;
      }

      function isNoiseLabel(label: string) {
        const key = normalize(label);
        return !key
          || key.length > 140
          || /\b(results found|no results found|show details|skip to content|required fields are marked)\b/.test(key);
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

      function clean(value: string | null | undefined) {
        return (value ?? "").replace(/\s+/g, " ").replace(/\*/g, "").trim().slice(0, 180);
      }

      function normalize(value: string | null | undefined) {
        return clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      }

      function normalizeId(value: string) {
        return normalize(value).replace(/\s+/g, "-").replace(/^-+|-+$/g, "");
      }
    }).catch(() => [] as VisibleField[]);

    runtimeFields.push(...frameFields);
  }

  // Keep grouped choice metadata from the initial observer, but let the fresh
  // DOM scan win for normal inputs. This prevents old re-rendered field ids
  // from being treated as the current visible controls.
  runtimeFields.push(...seedFields);

  const byKey = new Map<string, VisibleField>();

  for (const field of runtimeFields) {
    const key = semanticVisibleFieldKey(field);
    const existing = byKey.get(key);

    byKey.set(key, existing
      ? {
          ...existing,
          id: existing.id || field.id,
          label: existing.label || field.label,
          placeholder: existing.placeholder || field.placeholder,
          name: existing.name || field.name,
          ariaLabel: existing.ariaLabel || field.ariaLabel,
          autocomplete: existing.autocomplete || field.autocomplete,
          role: existing.role || field.role,
          required: existing.required || field.required,
          options: existing.options.length >= field.options.length ? existing.options : field.options,
          context: existing.context.length >= field.context.length ? existing.context : field.context
        }
      : field);
  }

  return [...byKey.values()];
}

// Verifies one planned answer against the live DOM after a fill attempt. This
// deliberately checks the committed browser state, not our own memory: invalid
// ARIA/error text fails the field, selects must have non-placeholder values,
// custom widgets can verify through their rendered token text, and radio or
// checkbox groups must have the expected visible option selected. The
// autonomous loop uses this result to decide whether to repair the field before
// any Continue/Next navigation is allowed.
async function verifyFieldAnswer(page: Page, field: BrowserFillField): Promise<FieldVerification> {
  if (!field.value.trim()) {
    return {
      satisfied: false,
      reason: "No answer value was available."
    };
  }

  for (const frame of page.frames()) {
    const verified = await frame.evaluate((field) => {
      const searchRoots = getSearchRoots();
      const match = findBestControl(field);

      if (!match.control) {
        return {
          satisfied: false,
          reason: match.bestDescriptor
            ? `No matching visible control was found. Best score ${match.bestScore} for "${match.bestDescriptor.slice(0, 120)}".`
            : "No matching visible control was found."
        };
      }

      return verifyControl(match.control, field);

      function findBestControl(field: { label: string; value: string; fieldId?: string; inputType?: string; semanticIntent?: string; aliases?: string[] }) {
        const labelKey = normalize(field.label);
        const controls = searchRoots.flatMap((root) => Array.from(root.querySelectorAll("input, textarea, select"))) as Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>;
        let best: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | undefined;
        let bestScore = 0;
        let bestDescriptor = "";

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
            findNearbyLabel(control),
            findFieldContext(control)
          ].filter(Boolean).join(" "));
          const idMatches = Boolean(field.fieldId && control.getAttribute("data-gradlaunch-field-id") === field.fieldId);
          const score = scoreDescriptor(descriptor, labelKey, field.inputType, control, field.semanticIntent, field.aliases ?? []) + (idMatches ? 140 : 0);

          if (score > bestScore) {
            best = control;
            bestScore = score;
            bestDescriptor = descriptor;
          }
        }

        return {
          control: bestScore >= (field.semanticIntent ? 48 : 58) ? best : undefined,
          bestScore,
          bestDescriptor
        };
      }

      function verifyControl(
        control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
        field: { label: string; value: string; inputType?: string }
      ) {
        const expected = normalize(field.value);
        const label = normalize(field.label);
        const blockingValidation = getBlockingValidation(control);

        if (blockingValidation) {
          return {
            satisfied: false,
            reason: `Matched control is still invalid: ${blockingValidation}.`
          };
        }

        if (control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type)) {
          const selectedText = normalize(getSelectedChoiceText(control));

          if (!selectedText) {
            return {
              satisfied: false,
              reason: "Choice group has no selected option."
            };
          }

          if (matchesExpected(selectedText, expected, label)) {
            return {
              satisfied: true,
              reason: "Selected choice matches expected answer."
            };
          }

          return {
            satisfied: false,
            reason: `Selected choice "${selectedText}" does not match expected "${expected}".`
          };
        }

        if (control instanceof HTMLSelectElement) {
          const selected = control.selectedOptions[0];
          const actual = normalize(`${selected?.textContent ?? ""} ${selected?.value ?? ""} ${control.value} ${getCustomSelectRenderedText(control)}`);

          if (isEmptyValue(actual)) {
            return {
              satisfied: false,
              reason: "Select still has an empty placeholder value."
            };
          }

          if (matchesExpected(actual, expected, label) || acceptsAnyNonEmptyAnswer(label, expected, actual)) {
            return {
              satisfied: true,
              reason: "Select has a committed non-empty matching value."
            };
          }

          return {
            satisfied: false,
            reason: `Select value "${actual}" does not match expected "${expected}".`
          };
        }

        const actual = normalize(control.value);

        if (isEmptyValue(actual)) {
          const metadata = normalize(getCommittedWidgetText(control));

          if (metadata && (matchesExpected(metadata, expected, label) || acceptsAnyNonEmptyAnswer(label, expected, metadata))) {
            return {
              satisfied: true,
              reason: "Custom widget metadata has a committed value."
            };
          }

          return {
            satisfied: false,
            reason: "Text field is still empty."
          };
        }

        if (control instanceof HTMLInputElement && control.type === "date") {
          return {
            satisfied: true,
            reason: "Date field has a committed value."
          };
        }

        if (matchesExpected(actual, expected, label) || acceptsAnyNonEmptyAnswer(label, expected, actual)) {
          return {
            satisfied: true,
            reason: "Text value matches expected answer."
          };
        }

        return {
          satisfied: false,
          reason: `Text value "${actual}" does not match expected "${expected}".`
        };
      }

      function getBlockingValidation(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
        if (control.getAttribute("aria-invalid") === "true") {
          return "aria-invalid=true";
        }

        const describedBy = control.getAttribute("aria-describedby") ?? "";
        const describedText = describedBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ");

        if (isBlockingValidationText(normalize(describedText))) {
          return clean(describedText).slice(0, 120);
        }

        const container = findFieldContainer(control);

        if (!container) {
          return "";
        }

        const errorElements = Array.from(container.querySelectorAll("[role='alert'], [aria-live='assertive'], .error, .field-error, .validation-error, [class*='error'], [class*='invalid']")) as HTMLElement[];
        const visibleError = errorElements.find((item) => isVisibleElement(item) && isBlockingValidationText(normalize(item.innerText || item.textContent || "")));

        if (visibleError) {
          return clean(visibleError.innerText || visibleError.textContent || "").slice(0, 120);
        }

        const text = normalize(container.textContent ?? "");

        if (isBlockingValidationText(text) && getFillControlCount(container) <= getAllowedControlCount(control)) {
          return "nearby required validation";
        }

        return "";
      }

      function findFieldContainer(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
        let ancestor: HTMLElement | null = control;
        let best: HTMLElement | undefined;
        let bestScore = Number.NEGATIVE_INFINITY;

        for (let depth = 0; depth < 7 && ancestor; depth += 1) {
          const text = normalize(ancestor.innerText || ancestor.textContent || "");
          const controlCount = getFillControlCount(ancestor);
          let score = 0;

          if (ancestor.matches("label, fieldset, [role='group'], [role='radiogroup'], [class*='field'], [class*='Field'], [class*='input'], [class*='Input'], [class*='question'], [class*='Question'], [data-testid*='field']")) {
            score += 50;
          }

          if (ancestor.querySelector("label, legend, h1, h2, h3, h4")) {
            score += 25;
          }

          if (isBlockingValidationText(text)) {
            score += 35;
          }

          score -= Math.max(0, controlCount - getAllowedControlCount(control)) * 20;
          score -= Math.min(text.length / 180, 50);
          score -= depth * 4;

          if (score > bestScore) {
            bestScore = score;
            best = ancestor;
          }

          ancestor = ancestor.parentElement;
        }

        return best;
      }

      function getAllowedControlCount(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
        if (control instanceof HTMLInputElement && ["radio", "checkbox"].includes(control.type)) {
          return 18;
        }

        return 3;
      }

      function getFillControlCount(container: Element) {
        return Array.from(container.querySelectorAll("input:not([type='hidden']):not([type='submit']):not([type='button']):not([type='file']), textarea, select, [role='combobox'], [contenteditable='true']"))
          .filter((item) => item instanceof HTMLElement && isVisibleElement(item)).length;
      }

      function isBlockingValidationText(text: string) {
        return /\b(this field is required|field is required|required field|cannot be blank|please select|please enter|select a valid|invalid value|invalid selection|value is required|missing required)\b/.test(text);
      }

      function isVisibleElement(element: HTMLElement) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
      }

      function acceptsAnyNonEmptyAnswer(label: string, expected: string, actual: string) {
        if (!actual || isEmptyValue(actual)) {
          return false;
        }

        if (/\b(date|year)\b/.test(label) && /\d/.test(actual)) {
          return true;
        }

        if (/\b(degree|education level)\b/.test(label) && semanticDegreeMatch(actual, expected)) {
          return true;
        }

        if (/\b(work experience|past working experience|professional experience)\b/.test(label) && semanticYesNoMatch(actual, expected)) {
          return true;
        }

        if (/\b(location|city|country|state|province|university|college|school|institution)\b/.test(label)) {
          return locationOrEntityMatch(actual, expected);
        }

        return false;
      }

      function matchesExpected(actual: string, expected: string, label: string) {
        if (!actual || !expected) {
          return false;
        }

        if (/\bcountry\b/.test(label)) {
          const expectedCountry = countryKey(expected);
          const actualCountry = countryKey(actual);

          if (expectedCountry) {
            return actualCountry === expectedCountry || hasPhrase(actual, expectedCountry);
          }
        }

        if (actual === expected || actual.includes(expected) || expected.includes(actual)) {
          return true;
        }

        if (/\b(email|phone|mobile|linkedin|github|portfolio|website|url)\b/.test(label)) {
          return false;
        }

        return semanticDegreeMatch(actual, expected)
          || semanticYesNoMatch(actual, expected)
          || locationOrEntityMatch(actual, expected);
      }

      function semanticDegreeMatch(actual: string, expected: string) {
        if (/\b(bachelor|b tech|btech|undergraduate|ug)\b/.test(expected)) {
          return /\b(bachelor|b tech|btech|undergraduate|ug)\b/.test(actual);
        }

        if (/\b(master|m tech|mtech|postgraduate|pg|mca|msc)\b/.test(expected)) {
          return /\b(master|m tech|mtech|postgraduate|pg|mca|msc)\b/.test(actual);
        }

        return false;
      }

      function semanticYesNoMatch(actual: string, expected: string) {
        if (/^(yes|true|1)\b/.test(expected)) {
          return /^yes\b|true|1|experience/.test(actual);
        }

        if (/^(no|false|0)\b/.test(expected)) {
          return /^no\b|false|0|fresher|none/.test(actual);
        }

        return false;
      }

      function locationOrEntityMatch(actual: string, expected: string) {
        const aliases = getLocationAliases(expected);

        return aliases.some((alias) => alias.length > 2 && hasPhrase(actual, alias))
          || expected.split(" ").filter((token) => token.length > 3).some((token) => hasPhrase(actual, token));
      }

      function countryKey(value: string) {
        if (hasPhrase(value, "india")) {
          return "india";
        }

        if (hasPhrase(value, "australia")) {
          return "australia";
        }

        if (hasPhrase(value, "united states") || hasPhrase(value, "usa") || value === "us") {
          return "united states";
        }

        if (hasPhrase(value, "united kingdom") || hasPhrase(value, "uk")) {
          return "united kingdom";
        }

        if (hasPhrase(value, "indonesia")) {
          return "indonesia";
        }

        return undefined;
      }

      function getSelectedChoiceText(control: HTMLInputElement) {
        const group = control.name
          ? Array.from(document.querySelectorAll(`input[name="${CSS.escape(control.name)}"]`)) as HTMLInputElement[]
          : [control];
        const selected = group.find((item) => item.checked || item.getAttribute("aria-checked") === "true") ?? control;

        if (!selected.checked && selected.getAttribute("aria-checked") !== "true") {
          return "";
        }

        return getOptionText(selected);
      }

      function getOptionText(control: HTMLInputElement) {
        if (control.id) {
          const label = queryFirst(`label[for="${CSS.escape(control.id)}"]`, control);

          if (label?.textContent?.trim()) {
            return label.textContent.trim();
          }
        }

        return control.closest("label")?.textContent?.trim()
          || control.parentElement?.textContent?.trim()
          || control.getAttribute("aria-label")
          || control.value
          || "";
      }

      function getCommittedWidgetText(control: Element) {
        const container = control.closest("[role='combobox'], [aria-haspopup='listbox'], [data-radix-select-trigger], [data-headlessui-state], [class*='select'], [class*='combobox'], [class*='autocomplete'], [class*='field'], [class*='input']")
          ?? control.parentElement;

        return [
          control instanceof HTMLSelectElement ? getCustomSelectRenderedText(control) : "",
          control.getAttribute("data-value"),
          control.getAttribute("aria-valuetext"),
          container?.getAttribute("data-value"),
          container?.getAttribute("aria-valuetext"),
          Array.from(container?.querySelectorAll("input[type='hidden'], [aria-selected='true'], [data-selected='true'], [data-state='checked'], [class*='selected'], [class*='single'], [class*='chip'], [class*='tag'], [class*='pill']") ?? [])
            .map((item) => item instanceof HTMLInputElement ? item.value : item.textContent ?? "")
            .join(" "),
          container?.textContent
        ].filter(Boolean).join(" ");
      }

      function isUsableControl(
        control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
        wantedType: string | undefined
      ) {
        if (control.disabled || control.getAttribute("aria-disabled") === "true") {
          return false;
        }

        if (isInactiveFormBranch(control)) {
          return false;
        }

        if (control instanceof HTMLInputElement && ["hidden", "file", "submit", "button", "image", "reset"].includes(control.type)) {
          return false;
        }

        if ((wantedType === "select" || wantedType === "combobox") && !(control instanceof HTMLSelectElement) && !(control instanceof HTMLInputElement && isCustomSelectLike(control))) {
          return false;
        }

        const rect = control.getBoundingClientRect();
        const style = window.getComputedStyle(control);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
          || control instanceof HTMLSelectElement && Boolean(getVisibleCustomSelectProxy(control));
      }

      function isInactiveFormBranch(control: Element) {
        if (control.closest(".datasetField__row--sample") || control.hasAttribute("hidden")) {
          return true;
        }

        if (control.parentElement?.closest("[hidden], [aria-hidden='true']")) {
          return true;
        }

        const id = control.getAttribute("id") ?? "";
        const name = control.getAttribute("name") ?? "";
        return /(^|-)sample($|-)/i.test(id) || /(^|-)sample($|-)/i.test(name);
      }

      function getCustomSelectRenderedText(control: HTMLSelectElement) {
        const proxy = getVisibleCustomSelectProxy(control);
        const rendered = control.id ? document.getElementById(`select2-${control.id}-container`) : null;
        return [
          rendered?.textContent,
          rendered?.getAttribute("title"),
          proxy?.textContent,
          proxy?.getAttribute("title"),
          proxy?.getAttribute("aria-valuetext")
        ].filter(Boolean).join(" ");
      }

      function getVisibleCustomSelectProxy(control: HTMLSelectElement) {
        if (!isCustomSelectElement(control)) {
          return undefined;
        }

        const candidates = [
          control.nextElementSibling,
          control.parentElement?.querySelector("[role='combobox']"),
          control.parentElement?.querySelector(".select2 [role='combobox']"),
          control.id ? document.getElementById(`select2-${control.id}-container`)?.closest("[role='combobox']") : null,
          control.id ? queryFirst(`.select2Container${CSS.escape(control.id)}`, control) : null,
          control.id ? queryFirst(`[aria-labelledby~="${CSS.escape(`${control.id}-label`)}"][role='combobox']`, control) : null
        ];

        for (const candidate of candidates) {
          const element = candidate instanceof HTMLElement
            ? candidate
            : candidate instanceof Element
              ? candidate.querySelector("[role='combobox']") as HTMLElement | null
              : null;

          if (element && isVisibleElement(element)) {
            return element;
          }
        }

        return undefined;
      }

      function isCustomSelectElement(control: HTMLSelectElement) {
        const className = String(control.getAttribute("class") ?? "");
        return control.getAttribute("aria-hidden") === "true"
          || /\b(select2-hidden-accessible|select2|autocomplete|combobox)\b/i.test(className)
          || Boolean(control.parentElement?.querySelector(".select2, [role='combobox'], [aria-haspopup='true'], [aria-haspopup='listbox']"));
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
        control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
        semanticIntent: string | undefined,
        aliases: string[]
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
        score += tokenSimilarityScore(wantedLabel, descriptor, 50);

        for (const alias of aliases) {
          const normalizedAlias = normalize(alias);

          if (normalizedAlias && descriptor.includes(normalizedAlias)) {
            score = Math.max(score, normalizedAlias === descriptor ? 118 : 92);
          }
        }

        if (semanticIntent && descriptorMatchesSemanticIntent(descriptor, semanticIntent)) {
          score = Math.max(score, 96);
        }

        if (/\b(email|e mail)\b/.test(wantedLabel) && /\b(email|e mail)\b/.test(descriptor)) {
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

        if (/\b(degree|major|field of study|education)\b/.test(wantedLabel) && /\b(degree|major|field of study|course|education)\b/.test(descriptor)) {
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

        return score;
      }

      function tokenSimilarityScore(left: string, right: string, maxScore: number) {
        const leftTokens = semanticTokens(left);
        const rightTokens = semanticTokens(right);

        if (leftTokens.size === 0 || rightTokens.size === 0) {
          return 0;
        }

        let overlap = 0;

        for (const token of leftTokens) {
          if (rightTokens.has(token)) {
            overlap += 1;
          }
        }

        const union = new Set([...leftTokens, ...rightTokens]).size;

        return Math.round((overlap / union) * maxScore);
      }

      function semanticTokens(value: string) {
        return new Set(
          normalize(value)
            .split(" ")
            .filter((token) => token.length > 1 && !/^(select|option|choose|please|your|the|field|required|number|name|date)$/.test(token))
        );
      }

      function descriptorMatchesSemanticIntent(descriptor: string, intent: string) {
        const patterns: Record<string, RegExp> = {
          first_name: /\b(first|given|legal first)\b/,
          middle_name: /\bmiddle\b/,
          last_name: /\b(last|surname|family|legal last)\b/,
          full_name: /\b(full name|candidate name|legal name)\b/,
          address_1: /\b(address line 1|address 1|street address|address)\b/,
          address_2: /\b(address line 2|address 2|apartment|apt|suite)\b/,
          country: /\bcountry\b/,
          state: /\b(state|province|region)\b/,
          city: /\b(city|town|locality)\b/,
          postal_code: /\b(zip|postal|postcode|pin code|pincode)\b/,
          email: /\b(email|e mail)\b/,
          phone: /\b(phone|mobile|telephone|contact)\b/,
          degree_name: /\b(degree name|field of study|major|course|qualification)\b/,
          degree_type: /\b(type of degree|degree type|education level|level of education)\b/,
          university: /\b(university|college|school|institution|institute)\b/,
          education_start: /\b(start|from|begin).*\b(date|year)\b|\b(date|year).*\b(start|from|begin)\b/,
          education_end: /\b(end|to|completion|graduation).*\b(date|year)\b|\b(date|year).*\b(end|to|completion|graduation)\b/,
          work_experience: /\b(work|working|professional|employment).*\bexperience\b|\bexperience\b/,
          profile_url: /\b(linkedin|github|portfolio|website|url|leetcode|kaggle)\b/,
          consent: /\b(consent|agree|acknowledge|terms|privacy|declaration|accept)\b/,
          preferred_name_choice: /\b(preferred name|different from your legal name)\b/
        };

        return Boolean(patterns[intent]?.test(descriptor));
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

      function findNearbyLabel(control: Element) {
        let ancestor: Element | null = control.parentElement;

        for (let depth = 0; depth < 5 && ancestor; depth += 1) {
          const controlRect = control.getBoundingClientRect();
          const label = Array.from(ancestor.querySelectorAll("label, legend, h1, h2, h3, h4, [class*='label'], [class*='Label']"))
            .map((element) => {
              const rect = element.getBoundingClientRect();
              return {
                text: clean(element.textContent ?? ""),
                distance: Math.abs(rect.bottom - controlRect.top) + Math.abs(rect.left - controlRect.left) / 4
              };
            })
            .filter((item) => item.text && item.text.length <= 140)
            .sort((left, right) => left.distance - right.distance)[0]?.text;

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

      function findFieldContext(control: Element) {
        const container = control.closest("label, fieldset, [role='group'], [role='radiogroup'], [class*='field'], [class*='input'], [class*='form'], section, article, div");
        return container?.textContent ?? "";
      }

      function getLocationAliases(value: string) {
        const normalized = normalize(value);
        const withoutCountry = normalized.replace(/\b(india|australia|canada|united states|usa|united kingdom|uk)\b/g, " ").replace(/\s+/g, " ").trim();
        const withoutRegion = withoutCountry.replace(/\b(bihar|haryana|maharashtra|karnataka|uttar pradesh|telangana|tamil nadu|west bengal|new south wales|california|washington|texas)\b/g, " ").replace(/\s+/g, " ").trim();
        const aliases = new Set([normalized, withoutCountry, withoutRegion, normalized.split(" ")[0]].filter(Boolean));

        if (normalized.includes("bhiwani")) {
          aliases.add("bhiwani");
          aliases.add("bhiwani haryana");
        }

        if (normalized.includes("aurangabad")) {
          aliases.add("aurangabad");
          aliases.add("aurangabad bihar");
        }

        if (normalized.includes("bengaluru") || normalized.includes("bangalore") || normalized.includes("banglore")) {
          aliases.add("bengaluru");
          aliases.add("bangalore");
        }

        if (normalized.includes("gurugram") || normalized.includes("gurgaon")) {
          aliases.add("gurugram");
          aliases.add("gurgaon");
        }

        return [...aliases];
      }

      function hasPhrase(text: string, phrase: string) {
        const normalizedPhrase = normalize(phrase);

        if (!text || !normalizedPhrase) {
          return false;
        }

        return new RegExp(`(^| )${escapeRegExp(normalizedPhrase)}( |$)`).test(text);
      }

      function isEmptyValue(value: string) {
        return !value
          || /^(select|select an option|choose|choose an option|please select|none selected|search|type to search)$/.test(value)
          || /\b(options available|total results|use the up and down keys|press enter to select|press escape to exit|not selected|results found|no results found)\b/.test(value);
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

      function clean(value: string | null | undefined) {
        return (value ?? "").replace(/\s+/g, " ").replace(/\*/g, " ").trim();
      }

      function normalize(value: string | null | undefined) {
        return clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      }

      function escapeRegExp(value: string) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
    }, {
      label: field.label,
      value: field.value,
      fieldId: field.fieldId,
      inputType: field.inputType,
      semanticIntent: inferSemanticFieldIntent(field.label, field.value),
      aliases: getSemanticFieldAliases(field.label, field.value)
    }).catch(() => ({
      satisfied: false,
      reason: "Verification script failed."
    }));

    if (verified.satisfied) {
      return verified;
    }
  }

  return {
    satisfied: false,
    reason: "No frame verified the field."
  };
}

// Infers the canonical profile/form intent represented by a label/value pair,
// such as city, country, email, degree type, or consent.
function inferSemanticFieldIntent(label: string, value = ""): SemanticFieldIntent | undefined {
  const text = normalizeKey(`${label} ${value}`);

  if (!text) {
    return undefined;
  }

  if (/\b(address line 2|address 2|apartment|apt|suite)\b/.test(text)) {
    return "address_2";
  }

  if (/\b(address line 1|address 1|street address|address)\b/.test(text)) {
    return "address_1";
  }

  if (/\b(postal|postcode|zip|pin code|pincode)\b/.test(text)) {
    return "postal_code";
  }

  if (/\b(country|current country|country region)\b/.test(text)) {
    return "country";
  }

  if (/\b(state|province|region)\b/.test(text)) {
    return "state";
  }

  if (/\b(city|current city|town|locality|place of residence|location city)\b/.test(text)) {
    return "city";
  }

  if (/\b(email|e mail)\b/.test(text)) {
    return "email";
  }

  if (/\b(phone|mobile|telephone|contact number)\b/.test(text)) {
    return "phone";
  }

  if (/\b(first name|given name|legal first)\b/.test(text)) {
    return "first_name";
  }

  if (/\b(middle name|legal middle)\b/.test(text)) {
    return "middle_name";
  }

  if (/\b(last name|surname|family name|legal last)\b/.test(text)) {
    return "last_name";
  }

  if (/\b(full name|candidate name|legal name)\b/.test(text)) {
    return "full_name";
  }

  if (/\b(type of degree|degree type|education level|level of education)\b/.test(text)) {
    return "degree_type";
  }

  if (/\b(degree name|field of study|major|qualification|course of study)\b/.test(text)) {
    return "degree_name";
  }

  if (/\b(university|college|institution|institute|school)\b/.test(text)) {
    return "university";
  }

  if (/\b(start date|start year|from date|begin date|education start)\b/.test(text)) {
    return "education_start";
  }

  if (/\b(end date|end year|completion date|graduation date|education end)\b/.test(text)) {
    return "education_end";
  }

  if (/\b(past working experience|prior work experience|work experience|employment experience|professional experience)\b/.test(text)) {
    return "work_experience";
  }

  if (/\b(linkedin|linked in|github|git hub|portfolio|website|web site|url|leetcode|kaggle)\b/.test(text)) {
    return "profile_url";
  }

  if (/\b(preferred name|different from your legal name)\b/.test(text)) {
    return "preferred_name_choice";
  }

  if (/\b(privacy|terms|consent|agree|acknowledge|accept|declaration|data processing|read and understand)\b/.test(text)) {
    return "consent";
  }

  return undefined;
}

// Returns common alias labels for a semantic intent so matching can survive
// different ATS wording.
function getSemanticFieldAliases(label: string, value = "") {
  const intent = inferSemanticFieldIntent(label, value);
  const aliases: Record<SemanticFieldIntent, string[]> = {
    first_name: ["first name", "given name", "legal first name"],
    middle_name: ["middle name", "legal middle name"],
    last_name: ["last name", "surname", "family name", "legal last name"],
    full_name: ["full name", "legal name", "candidate name"],
    address_1: ["address line 1", "address 1", "street address", "address"],
    address_2: ["address line 2", "address 2", "apartment", "suite"],
    country: ["country", "country region", "current country"],
    state: ["state", "province", "region", "state province"],
    city: ["city", "current city", "town", "locality", "place of residence", "location city"],
    postal_code: ["zip code", "postal code", "postcode", "pin code", "pincode"],
    email: ["email", "email address", "home email", "e mail"],
    phone: ["phone", "phone number", "mobile", "telephone", "contact number"],
    degree_name: ["degree name", "field of study", "major", "qualification", "course of study"],
    degree_type: ["type of degree", "degree type", "education level", "level of education"],
    university: ["university", "college", "institution", "institute", "school"],
    education_start: ["start date", "start year", "from date", "begin date"],
    education_end: ["end date", "end year", "completion date", "graduation date"],
    work_experience: ["work experience", "past working experience", "professional experience", "employment experience"],
    profile_url: ["linkedin", "github", "portfolio", "website", "url", "leetcode", "kaggle"],
    consent: ["consent", "agree", "acknowledge", "accept", "terms", "privacy"],
    preferred_name_choice: ["preferred name", "different from your legal name"]
  };

  return intent ? aliases[intent] : [];
}

// Scores token overlap between two normalized strings for fuzzy field remapping
// and verification matching.
function tokenSimilarityScore(left: string, right: string, maxScore: number) {
  const leftTokens = semanticTokens(left);
  const rightTokens = semanticTokens(right);

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let overlap = 0;

  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }

  const union = new Set([...leftTokens, ...rightTokens]).size;

  return Math.round((overlap / union) * maxScore);
}

// Splits a label/value into meaningful tokens while removing generic form words
// that would distort similarity scoring.
function semanticTokens(value: string) {
  return new Set(
    normalizeKey(value)
      .split(" ")
      .filter((token) => token.length > 1 && !/^(select|option|choose|please|your|the|field|required|number|name|date)$/.test(token))
  );
}
