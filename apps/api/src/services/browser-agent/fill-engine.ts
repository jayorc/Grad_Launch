import type { FilledField, Job, StudentMemory, StudentProfile } from "@gradlaunch/shared";
import type { Page } from "./browser-driver";
import { getVisibleRequiredEmptyLabels, getVisibleValidationMessages } from "./observe";
import type { BrowserFillField, StageAnswerPlan, VisibleField } from "./types";
import { dedupeLabels, normalizeKey, writeBrowserDebug } from "./util";
import { buildFillV2Answers } from "./fill-answer-resolver";
import { collectFillV2FieldDebug, fillV2Field, verifyV2Field } from "./fill-field-drivers";
import { buildFillV2FieldGraph } from "./fill-field-graph";

export type FillAttempt = {
  field: BrowserFillField;
  filled: boolean;
  verified: boolean;
  alreadySatisfied: boolean;
  round: number;
};

export type FillStageResult = {
  stopped: boolean;
  answerPlan?: StageAnswerPlan;
  attempts: FillAttempt[];
  failedFields: BrowserFillField[];
  visibleFields: VisibleField[];
  outstandingRequired: string[];
  validationMessages: string[];
};

type FillV2AutonomousAttempt = Omit<FillAttempt, "field"> & {
  field: FillV2Answer;
};

export type FillV2DriverKind =
  | "text"
  | "textarea"
  | "date"
  | "number"
  | "email"
  | "phone"
  | "native_select"
  | "custom_select"
  | "choice"
  | "file"
  | "contenteditable";

export type FillV2Intent =
  | "first_name"
  | "middle_name"
  | "last_name"
  | "full_name"
  | "email"
  | "confirm_email"
  | "phone"
  | "country"
  | "state"
  | "city"
  | "preferred_work_location"
  | "postal_code"
  | "address_1"
  | "address_2"
  | "linkedin"
  | "github"
  | "portfolio"
  | "website"
  | "current_ctc"
  | "expected_ctc"
  | "notice_period"
  | "total_experience"
  | "office_work_choice"
  | "bond_obligation_choice"
  | "previous_employer_choice"
  | "shift_flexibility_choice"
  | "notice_buyout_choice"
  | "government_id"
  | "degree_name"
  | "degree_type"
  | "university"
  | "education_start"
  | "education_end"
  | "work_experience_choice"
  | "work_company"
  | "work_title"
  | "work_start"
  | "work_end"
  | "work_current_choice"
  | "consent"
  | "marketing_opt_in"
  | "preferred_name_choice"
  | "work_authorization"
  | "sponsorship"
  | "relocation"
  | "prose"
  | "unknown";

export type FillV2IntentCandidate = {
  intent: FillV2Intent;
  score: number;
  reasons: string[];
};

export type FillV2WidgetKind =
  | "text_input"
  | "textarea"
  | "numeric_input"
  | "email_input"
  | "phone_input"
  | "date_input"
  | "choice_group"
  | "native_select"
  | "combobox"
  | "autocomplete"
  | "contenteditable"
  | "file_input"
  | "unknown";

export type FillV2ValueKind =
  | "name"
  | "email"
  | "phone"
  | "country"
  | "location"
  | "money"
  | "number"
  | "date"
  | "yes_no"
  | "choice"
  | "url"
  | "prose"
  | "experience"
  | "authorization"
  | "consent"
  | "identifier"
  | "text"
  | "unknown";

export type FillV2FieldSignature = {
  semanticLabel: string;
  normalizedLabel: string;
  section: string;
  widgetKind: FillV2WidgetKind;
  valueKind: FillV2ValueKind;
  expectedFormat?: string;
  options: string[];
};

export type FillV2PortalPattern = NonNullable<StudentMemory["portalPatterns"]>[number];

export type FillV2Field = VisibleField & {
  driver: FillV2DriverKind;
  intent: FillV2Intent;
  adapterId: string;
  confidence: number;
  widgetKind: FillV2WidgetKind;
  valueKind: FillV2ValueKind;
  intentCandidates: FillV2IntentCandidate[];
  signature: FillV2FieldSignature;
  portalPattern?: FillV2PortalPattern;
};

export type FillV2Answer = BrowserFillField & {
  intent: FillV2Intent;
  source: "profile" | "prepared" | "memory" | "llm" | "fallback";
  confidence: number;
};

export type FillV2Input = {
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
  onStatus?: (message: string) => Promise<void>;
};

export type FillV2Adapter = {
  id: string;
  label: string;
  matches: (input: { url: string; pageText: string }) => boolean;
  cleanupBeforeFill?: (input: FillV2Input, fields: FillV2Field[]) => Promise<boolean>;
  selectQuery?: (field: FillV2Field, answer: FillV2Answer) => string;
  fillCustomSelect?: (input: {
    page: Page;
    field: FillV2Field;
    answer: FillV2Answer;
  }) => Promise<boolean>;
};

export async function runFillEngine(input: FillV2Input): Promise<FillStageResult> {
  let { adapter, fields } = await buildFillV2FieldGraph(input);

  await input.onStatus?.(`Fill Engine V2 detected ${adapter.label} and ${fields.length} fillable field(s).`);

  if (await adapter.cleanupBeforeFill?.(input, fields)) {
    ({ adapter, fields } = await buildFillV2FieldGraph(input));
  }

  const answerBuild = await buildFillV2Answers(input, fields);
  const answerPlan: StageAnswerPlan = {
    answers: answerBuild.answers,
    unresolvedRequiredLabels: answerBuild.unresolvedRequiredLabels,
    usedLlm: answerBuild.usedLlm,
    summary: answerBuild.summary
  };
  const attempts: FillV2AutonomousAttempt[] = [];

  await input.onStatus?.(answerPlan.summary ?? "Fill Engine V2 built the answer plan.");
  attempts.push(...await fillAnswersOnce(input, fields, answerBuild.answers, adapter, 0));

  let blockers = await collectBlockers(input);
  let failedFields = failedAnswers(attempts);

  if (shouldDoRepairPass(blockers, failedFields) && !(await input.shouldStop?.())) {
    const nextGraph = await buildFillV2FieldGraph(input);
    adapter = nextGraph.adapter;
    fields = nextGraph.fields;
    const repairBuild = await buildFillV2Answers(input, fields);
    const verifiedKeys = new Set(attempts.filter((attempt) => attempt.verified).map((attempt) => answerKey(attempt.field)));
    const repairAnswers = repairBuild.answers.filter((answer) => {
      if (verifiedKeys.has(answerKey(answer))) {
        return false;
      }

      return answer.required || blockers.outstandingRequired.some((label) => labelsMatch(label, answer.label));
    });

    if (repairAnswers.length > 0) {
      await input.onStatus?.(`Validation still shows missing fields, retrying only: ${repairAnswers.map((answer) => answer.label).join(", ")}.`);
      attempts.push(...await fillAnswersOnce(input, fields, repairAnswers, adapter, 1));
      blockers = await collectBlockers(input);
      failedFields = failedAnswers(attempts);
    }
  }

  await writeBrowserDebug(input.workspacePath, "fill-v2-result", {
    stageIndex: input.stageIndex,
    attempts: attempts.map((attempt) => ({
      label: attempt.field.label,
      source: attempt.field.source,
      intent: attempt.field.intent,
      filled: attempt.filled,
      verified: attempt.verified,
      alreadySatisfied: attempt.alreadySatisfied,
      round: attempt.round
    })),
    outstandingRequired: blockers.outstandingRequired,
    validationMessages: blockers.validationMessages
  });

  return {
    stopped: false,
    answerPlan: {
      ...answerPlan,
      unresolvedRequiredLabels: dedupeLabels([
        ...answerPlan.unresolvedRequiredLabels,
        ...blockers.outstandingRequired
      ])
    },
    attempts,
    failedFields,
    visibleFields: fields,
    outstandingRequired: blockers.outstandingRequired,
    validationMessages: blockers.validationMessages
  };
}

async function fillAnswersOnce(
  input: FillV2Input,
  fields: FillV2Field[],
  answers: FillV2Answer[],
  adapter: Awaited<ReturnType<typeof buildFillV2FieldGraph>>["adapter"],
  round: number
) {
  const attempts: FillV2AutonomousAttempt[] = [];

  for (const answer of dedupeAnswers(answers)) {
    if (await input.shouldStop?.()) {
      break;
    }

    const field = fields.find((candidate) => candidate.id === answer.fieldId);

    if (!field || !shouldFillAnswer(answer)) {
      continue;
    }

    const shouldTraceLocationField = field.intent === "city"
      || field.intent === "preferred_work_location"
      || field.intent === "state"
      || field.intent === "country";
    const before = await verifyV2Field(input.page, field, answer);
    const beforeDebug = shouldTraceLocationField ? await collectFillV2FieldDebug(input.page, field).catch(() => undefined) : undefined;

    if (before) {
      attempts.push({
        field: answer,
        filled: true,
        verified: true,
        alreadySatisfied: true,
        round
      });
      continue;
    }

    const filled = await fillV2Field(input.page, field, answer, adapter);
    await input.page.waitForTimeout(filled ? 60 : 120).catch(() => undefined);
    const verified = await verifyV2Field(input.page, field, answer);
    const afterDebug = shouldTraceLocationField ? await collectFillV2FieldDebug(input.page, field).catch(() => undefined) : undefined;

    attempts.push({
      field: answer,
      filled,
      verified,
      alreadySatisfied: false,
      round
    });

    await writeBrowserDebug(input.workspacePath, verified ? "fill-v2-field-verified" : "fill-v2-field-unverified", {
      stageIndex: input.stageIndex,
      round,
      label: answer.label,
      intent: answer.intent,
      source: answer.source,
      inputType: answer.inputType,
      valuePreview: answer.value.length > 80 ? `${answer.value.slice(0, 77)}...` : answer.value,
      filled,
      verified,
      fieldDebugBefore: beforeDebug,
      fieldDebugAfter: afterDebug
    });
  }

  return attempts;
}

async function collectBlockers(input: FillV2Input) {
  const [outstandingRequired, validationMessages] = await Promise.all([
    getVisibleRequiredEmptyLabels(input.page).catch(() => []),
    getVisibleValidationMessages(input.page).catch(() => [])
  ]);

  return {
    outstandingRequired: dedupeLabels(outstandingRequired),
    validationMessages: dedupeLabels(validationMessages)
  };
}

function failedAnswers(attempts: FillV2AutonomousAttempt[]) {
  return attempts
    .filter((attempt) => !attempt.verified && (attempt.field.required || attempt.field.source !== "fallback"))
    .map((attempt) => attempt.field);
}

function shouldDoRepairPass(
  blockers: { outstandingRequired: string[]; validationMessages: string[] },
  failedFields: FillV2Answer[]
) {
  return failedFields.length > 0 || blockers.outstandingRequired.length > 0 || blockers.validationMessages.some((message) => /\b(required|invalid|please select|please enter)\b/i.test(message));
}

function shouldFillAnswer(answer: FillV2Answer) {
  if (!answer.value.trim()) {
    return false;
  }

  if (answer.intent === "unknown" && answer.source !== "prepared" && answer.source !== "memory" && !answer.required) {
    return false;
  }

  return answer.confidence >= 0.55;
}

function dedupeAnswers(answers: FillV2Answer[]) {
  const byKey = new Map<string, FillV2Answer>();

  for (const answer of answers) {
    const key = answerKey(answer);
    const existing = byKey.get(key);

    if (!existing || answer.confidence > existing.confidence || (answer.required && !existing.required)) {
      byKey.set(key, answer);
    }
  }

  return [...byKey.values()];
}

function answerKey(answer: FillV2Answer) {
  return `${answer.intent}:${normalizeKey(answer.label)}`;
}

function labelsMatch(left: string, right: string) {
  const leftKey = normalizeKey(left);
  const rightKey = normalizeKey(right);

  if (!leftKey || !rightKey) {
    return false;
  }

  return leftKey === rightKey || leftKey.includes(rightKey) || rightKey.includes(leftKey);
}
