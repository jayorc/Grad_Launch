import type { Job, StudentMemory, StudentProfile } from "@gradlaunch/shared";
import type { BrowserFillField, StageReflectionResult, VisibleField } from "./types";
import { jsonBlock, normalizeKey, writeBrowserDebug } from "./util";

type ReflectStageInput = {
  job: Job;
  student?: StudentProfile;
  memory?: StudentMemory;
  visibleFields: VisibleField[];
  attemptedAnswers: BrowserFillField[];
  missingRequiredLabels: string[];
  validationMessages: string[];
  workspacePath: string;
};

export async function reflectOnStageAnswers(input: ReflectStageInput): Promise<StageReflectionResult | undefined> {
  if (!shouldUseReflection(input)) {
    return undefined;
  }

  const prompt = [
    "You are the reflection agent for a job application workflow.",
    "A previous answer set did not fully satisfy the current stage.",
    "Return strict JSON only.",
    "Use only provided context. Do not invent personal facts.",
    "",
    "Schema:",
    "{",
    '  "summary": "short summary",',
    '  "answers": [{"fieldId":"...", "label":"...", "value":"...", "reason":"..."}]',
    "}",
    "",
    `Job: ${input.job.title} at ${input.job.company}`,
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
    `Memory corrections: ${JSON.stringify(input.memory?.corrections ?? [])}`,
    `Attempted answers: ${JSON.stringify(input.attemptedAnswers)}`,
    `Missing required labels: ${JSON.stringify(input.missingRequiredLabels)}`,
    `Validation messages: ${JSON.stringify(input.validationMessages)}`,
    `Visible fields: ${JSON.stringify(input.visibleFields)}`
  ].join("\n");

  const content = await callOpenAiCompatible(prompt);
  const parsed = JSON.parse(jsonBlock(content)) as {
    summary?: string;
    answers?: Array<{ fieldId?: string; label?: string; value?: string; reason?: string }>;
  };
  const visibleById = new Map(input.visibleFields.map((field) => [field.id, field]));
  const visibleByLabel = new Map(input.visibleFields.map((field) => [normalizeKey(field.label), field]));
  const answers: BrowserFillField[] = [];

  for (const candidate of parsed.answers ?? []) {
    const visibleField = (candidate.fieldId ? visibleById.get(candidate.fieldId) : undefined)
      ?? (candidate.label ? visibleByLabel.get(normalizeKey(candidate.label)) : undefined);
    const value = String(candidate.value ?? "").trim();

    if (!visibleField || !value) {
      continue;
    }

    answers.push({
      label: visibleField.label,
      value,
      fieldId: visibleField.id,
      inputType: visibleField.inputType,
      options: visibleField.options,
      required: visibleField.required,
      reason: String(candidate.reason ?? "Reflection suggested an alternative answer.")
    });
  }

  await writeBrowserDebug(input.workspacePath, "reflection-stage-plan", {
    answerCount: answers.length,
    summary: parsed.summary,
    missingRequiredLabels: input.missingRequiredLabels,
    validationMessages: input.validationMessages
  });

  return {
    answers,
    summary: String(parsed.summary ?? "Reflection generated a revised answer set."),
    improved: answers.length > 0
  };
}

function shouldUseReflection(input: ReflectStageInput) {
  return process.env.LLM_ANSWER_ENABLED === "true"
    && Boolean(process.env.OPENAI_API_KEY)
    && (input.missingRequiredLabels.length > 0 || input.validationMessages.length > 0);
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
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You are a reflection agent that improves browser form-filling plans using only supplied context."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`Reflection LLM request failed with status ${response.status}`);
  }

  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Reflection LLM response did not include content.");
  }

  return content;
}
