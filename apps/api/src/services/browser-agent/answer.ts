import type { FilledField, Job, StudentMemory, StudentProfile } from "@gradlaunch/shared";
import type { StageAnswerPlan, VisibleField } from "./types";
import { dedupeLabels, jsonBlock, normalizeKey, writeBrowserDebug } from "./util";

type BuildAnswerPlanInput = {
  job: Job;
  visibleFields: VisibleField[];
  baseFields: FilledField[];
  student?: StudentProfile;
  memory?: StudentMemory;
  workspacePath: string;
};

export async function buildStageAnswerPlan(input: BuildAnswerPlanInput): Promise<StageAnswerPlan> {
  const deterministicAnswers = createDeterministicAnswerMap(input.visibleFields, input.baseFields, input.student, input.job, input.memory);
  const requiredWithoutAnswer = input.visibleFields
    .filter((field) => field.required && !deterministicAnswers.has(field.id))
    .map((field) => field.label);

  if (shouldUseLlm() && input.visibleFields.length > 0) {
    const llmPlan = await askLlmForStageAnswers(input).catch(() => undefined);

    if (llmPlan) {
      const answers = input.visibleFields
        .map((field) => llmPlan.answers.get(field.id) ?? deterministicAnswers.get(field.id))
        .filter((value): value is NonNullable<typeof value> => Boolean(value));
      const unresolvedRequiredLabels = dedupeLabels(
        input.visibleFields
          .filter((field) => field.required && !answers.some((answer) => answer.fieldId === field.id))
          .map((field) => field.label)
      );

      return {
        answers,
        unresolvedRequiredLabels,
        usedLlm: llmPlan.answers.size > 0,
        summary: llmPlan.summary
      };
    }
  }

  return {
    answers: [...deterministicAnswers.values()],
    unresolvedRequiredLabels: dedupeLabels(requiredWithoutAnswer),
    usedLlm: false,
    summary: deterministicAnswers.size > 0 ? "Using stored GradLaunch profile facts and prepared answers for the visible fields." : undefined
  };
}

function createDeterministicAnswerMap(
  visibleFields: VisibleField[],
  baseFields: FilledField[],
  student: StudentProfile | undefined,
  job: Job,
  memory: StudentMemory | undefined
) {
  const prepared = new Map<string, string>();

  for (const field of baseFields) {
    prepared.set(normalizeKey(field.label), field.value.trim());
  }

  for (const correction of memory?.corrections ?? []) {
    prepared.set(normalizeKey(correction.label), correction.value.trim());
  }

  const answers = new Map<string, {
    label: string;
    value: string;
    fieldId: string;
    inputType: string;
    options: string[];
    required: boolean;
    reason: string;
  }>();

  for (const field of visibleFields) {
    const fieldKey = normalizeKey(field.label);
    const value = prepared.get(fieldKey)
      ?? fallbackForVisibleField(field, student, job);

    if (!value) {
      continue;
    }

    answers.set(field.id, {
      label: field.label,
      value,
      fieldId: field.id,
      inputType: field.inputType,
      options: field.options,
      required: field.required,
      reason: prepared.has(fieldKey)
        ? "Matched a prepared GradLaunch field or remembered correction."
        : "Used a direct profile fallback for a common field."
    });
  }

  return answers;
}

function fallbackForVisibleField(field: VisibleField, student: StudentProfile | undefined, job: Job) {
  const label = normalizeKey(field.label);

  if (label.includes("full name") || label === "name") {
    return student?.fullName;
  }

  if (label.includes("email")) {
    return student?.email;
  }

  if (label.includes("phone")) {
    return undefined;
  }

  if (label.includes("location") || label.includes("city")) {
    return student?.preferredLocations[0];
  }

  if (label.includes("role") || label.includes("position")) {
    return job.title;
  }

  if (label.includes("company")) {
    return job.company;
  }

  if (label.includes("degree")) {
    return student?.degree;
  }

  if (label.includes("graduation")) {
    return student?.graduationYear ? String(student.graduationYear) : undefined;
  }

  if (label.includes("work authorization") || label.includes("authorized to work")) {
    return student?.visaRequired ? "No" : "Yes";
  }

  if (label.includes("visa sponsorship") || label.includes("sponsorship")) {
    return student?.visaRequired ? "Yes" : "No";
  }

  return undefined;
}

async function askLlmForStageAnswers(input: BuildAnswerPlanInput) {
  const prompt = [
    "You are helping fill a job application form.",
    "Return strict JSON only.",
    "Choose answers using the student context first, then prepared application fields, then memory corrections.",
    "Do not invent personal facts that are not present.",
    "",
    "Schema:",
    "{",
    '  "summary": "short summary",',
    '  "answers": [{"fieldId":"...", "label":"...", "value":"...", "reason":"..."}]',
    "}",
    "",
    `Job: ${input.job.title} at ${input.job.company}`,
    `Description excerpt: ${input.job.description.slice(0, 1200)}`,
    "",
    `Student: ${JSON.stringify({
      fullName: input.student?.fullName,
      email: input.student?.email,
      degree: input.student?.degree,
      graduationYear: input.student?.graduationYear,
      targetRoles: input.student?.targetRoles,
      preferredLocations: input.student?.preferredLocations,
      workModes: input.student?.workModes,
      skills: input.student?.skills,
      bio: input.student?.bio
    })}`,
    `Prepared fields: ${JSON.stringify(input.baseFields)}`,
    `Corrections: ${JSON.stringify(input.memory?.corrections ?? [])}`,
    `Notes: ${JSON.stringify((input.memory?.notes ?? []).slice(0, 10))}`,
    "",
    `Visible fields: ${JSON.stringify(input.visibleFields)}`
  ].join("\n");

  const content = await callOpenAiCompatible(prompt);
  const parsed = JSON.parse(jsonBlock(content)) as {
    summary?: string;
    answers?: Array<{ fieldId?: string; label?: string; value?: string; reason?: string }>;
  };
  const visibleById = new Map(input.visibleFields.map((field) => [field.id, field]));
  const visibleByLabel = new Map(input.visibleFields.map((field) => [normalizeKey(field.label), field]));
  const answers = new Map<string, {
    label: string;
    value: string;
    fieldId: string;
    inputType: string;
    options: string[];
    required: boolean;
    reason: string;
  }>();

  for (const candidate of parsed.answers ?? []) {
    const visibleField = (candidate.fieldId ? visibleById.get(candidate.fieldId) : undefined)
      ?? (candidate.label ? visibleByLabel.get(normalizeKey(candidate.label)) : undefined);
    const value = String(candidate.value ?? "").trim();

    if (!visibleField || !value) {
      continue;
    }

    answers.set(visibleField.id, {
      label: visibleField.label,
      value,
      fieldId: visibleField.id,
      inputType: visibleField.inputType,
      options: visibleField.options,
      required: visibleField.required,
      reason: String(candidate.reason ?? "LLM selected a personalized answer.")
    });
  }

  await writeBrowserDebug(input.workspacePath, "llm-stage-answer-plan", {
    visibleFieldCount: input.visibleFields.length,
    answerCount: answers.size,
    summary: parsed.summary
  });

  return {
    summary: parsed.summary,
    answers
  };
}

async function callOpenAiCompatible(prompt: string) {
  const endpoint = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1/chat/completions";
  const model = process.env.OPENAI_MODEL ?? process.env.LLM_MODEL ?? "gpt-4o-mini";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You generate safe, personalized answers for job application forms using only the provided context."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`LLM request failed with status ${response.status}`);
  }

  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("LLM response did not include content.");
  }

  return content;
}

function shouldUseLlm() {
  return process.env.LLM_ANSWER_ENABLED === "true" && Boolean(process.env.OPENAI_API_KEY);
}
