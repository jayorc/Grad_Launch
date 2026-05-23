import type { FilledField, Job, StudentMemory, StudentProfile } from "@gradlaunch/shared";
import { cityFromLocationLabel, inferCountryFromPhoneNumber, resolveBestProfileLocation } from "../location-resolver";
import { createStudentProfileSummary, retrieveProfileAnswer } from "./profile-knowledge";
import type { StageAnswerPlan, VisibleField } from "./types";
import { dedupeLabels, jsonBlock, normalizeKey, writeBrowserDebug } from "./util";

type BuildAnswerPlanInput = {
  job: Job;
  visibleFields: VisibleField[];
  baseFields: FilledField[];
  student?: StudentProfile;
  memory?: StudentMemory;
  resumeText?: string;
  workspacePath: string;
};

export async function buildStageAnswerPlan(input: BuildAnswerPlanInput): Promise<StageAnswerPlan> {
  const deterministicAnswers = createDeterministicAnswerMap(input.visibleFields, input.baseFields, input.student, input.job, input.memory, input.resumeText);

  if (shouldUseLlm() && input.visibleFields.length > 0) {
    const llmPlan = await askLlmForStageAnswers(input).catch(() => undefined);

    if (llmPlan) {
      const answers = normalizeChoiceAnswers(input.visibleFields
        .map((field) => llmPlan.answers.get(field.id) ?? deterministicAnswers.get(field.id))
        .filter((value): value is NonNullable<typeof value> => Boolean(value)), input);

      return {
        answers,
        unresolvedRequiredLabels: resolveUnansweredRequiredLabels(input.visibleFields, answers),
        usedLlm: llmPlan.answers.size > 0,
        summary: llmPlan.summary
      };
    }
  }

  const answers = normalizeChoiceAnswers([...deterministicAnswers.values()], input);

  return {
    answers,
    unresolvedRequiredLabels: resolveUnansweredRequiredLabels(input.visibleFields, answers),
    usedLlm: false,
    summary: deterministicAnswers.size > 0 ? "Using stored GradLaunch profile facts and prepared answers for the visible fields." : undefined
  };
}

function createDeterministicAnswerMap(
  visibleFields: VisibleField[],
  baseFields: FilledField[],
  student: StudentProfile | undefined,
  job: Job,
  memory: StudentMemory | undefined,
  resumeText: string | undefined
) {
  const prepared = createPreparedValueMap(baseFields, memory);

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
    if (field.inputType === "file") {
      continue;
    }

    const fieldKey = normalizeKey(field.label);
    const value = resolvePreparedChoiceValue(field, prepared, student, job, resumeText)
      ?? resolveLocationFieldValue(field, prepared, student, job, resumeText)
      ?? resolvePreparedValue(field.label, prepared)
      ?? fallbackForVisibleField(field, student, job)
      ?? retrieveProfileAnswer(field, student, job);

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
      reason: prepared.has(fieldKey) || getFieldAliases(field.label).some((alias) => prepared.has(normalizeKey(alias)))
        ? "Matched a prepared GradLaunch field or remembered correction."
        : "Used a direct profile fallback for a common field."
    });
  }

  return answers;
}

function resolvePreparedChoiceValue(
  field: VisibleField,
  prepared: Map<string, string>,
  student: StudentProfile | undefined,
  job: Job,
  resumeText: string | undefined
) {
  if (field.inputType !== "checkbox" && field.inputType !== "radio" && !isCountryOptionLabel(field.label)) {
    return undefined;
  }

  const option = normalizeKey(field.label);

  if (!option) {
    return undefined;
  }

  const resolvedLocation = resolveBestProfileLocation({
    student,
    job,
    resumeText,
    preparedLocations: getPreparedLocationHints(prepared),
    countryHint: resolveCountryHint(prepared, student, resumeText),
    phone: resolvePreparedPhone(prepared)
  });
  const desiredRawValues = [
    prepared.get("country"),
    prepared.get("current country"),
    prepared.get("location country"),
    prepared.get("country where you currently reside"),
    resolvedLocation?.country,
    student?.completeProfile?.country,
    ...(student?.completeProfile?.workAuthorizationCountries ?? [])
  ].filter((value): value is string => Boolean(value?.trim()));
  const desiredValues = desiredRawValues.map((value) => normalizeKey(value));

  if (field.inputType === "checkbox" && /\b(select|country|countries|working in|role in which you are applying)\b/.test(normalizeKey(`${field.label} ${field.context}`))) {
    const desiredCountry = desiredRawValues.find((value) => /\bindia|australia|united states|usa|united kingdom|uk\b/i.test(value));

    if (desiredCountry) {
      return normalizeCountryAnswer(desiredCountry);
    }
  }

  if (desiredValues.some((value) => value === option || value.includes(option) || option.includes(value))) {
    return field.label;
  }

  return undefined;
}

function normalizeCountryAnswer(value: string) {
  const normalized = normalizeKey(value);

  if (/\bindia\b/.test(normalized)) {
    return "India";
  }

  if (/\baustralia\b/.test(normalized)) {
    return "Australia";
  }

  if (/\bunited states\b|\busa\b|\bus\b/.test(normalized)) {
    return "United States";
  }

  if (/\bunited kingdom\b|\buk\b/.test(normalized)) {
    return "United Kingdom";
  }

  return value.trim();
}

function resolveLocationFieldValue(
  field: VisibleField,
  prepared: Map<string, string>,
  student: StudentProfile | undefined,
  job: Job,
  resumeText: string | undefined,
  proposedValue?: string
) {
  const fieldLabel = normalizeKey(field.label);
  const label = normalizeKey([field.label, field.context].join(" "));

  if (/\b(authorized|authorization|sponsor|sponsorship|work permit|remote|relocat|employed|stripe affiliate|whatsapp|sms|text messages|opt in)\b/.test(label)) {
    return undefined;
  }

  if (!/\b(location|city|current city|current location)\b/.test(label) || (/\bcountry\b/.test(fieldLabel) && !/\bcity\b/.test(fieldLabel))) {
    return undefined;
  }

  const preparedLocations = proposedValue
    ? [proposedValue, ...getPreparedLocationHints(prepared)]
    : getPreparedLocationHints(prepared);
  const resolved = resolveBestProfileLocation({
    student,
    job,
    resumeText,
    proposedLocation: proposedValue,
    preparedLocations,
    countryHint: resolveCountryHint(prepared, student, resumeText),
    phone: resolvePreparedPhone(prepared)
  });

  if (!resolved) {
    return undefined;
  }

  const needsSelectablePlace = field.inputType === "combobox"
    || label.includes("location")
    || label.includes("autocomplete")
    || label.includes("search");

  return needsSelectablePlace ? resolved.label : resolved.city;
}

function normalizeChoiceAnswers(
  answers: Array<{
    label: string;
    value: string;
    fieldId: string;
    inputType?: string;
    options?: string[];
    required?: boolean;
    reason?: string;
  }>,
  input: BuildAnswerPlanInput
) {
  const prepared = createPreparedValueMap(input.baseFields, input.memory);
  const resolvedLocation = resolveBestProfileLocation({
    student: input.student,
    job: input.job,
    resumeText: input.resumeText,
    preparedLocations: getPreparedLocationHints(prepared),
    countryHint: resolveCountryHint(prepared, input.student, input.resumeText),
    phone: resolvePreparedPhone(prepared)
  });
  const desiredCountry = normalizeCountryAnswer(
    resolvedLocation?.country
      ?? resolveCountryHint(prepared, input.student, input.resumeText)
      ?? input.student?.completeProfile?.country
      ?? "India"
  );
  const desiredCountryKey = normalizeKey(desiredCountry);
  const countryOptionIds = new Set(
    input.visibleFields
      .filter((field) => isCountryOptionLabel(field.label))
      .map((field) => field.id)
  );
  const hasCountryGroupQuestion = answers.some((answer) => {
    const visibleField = input.visibleFields.find((field) => field.id === answer.fieldId);
    return Boolean(visibleField && !isCountryOptionLabel(visibleField.label) && isCountryChoiceGroupQuestion(`${visibleField.label} ${visibleField.context}`));
  });

  return answers
    .flatMap((answer) => {
      const visibleField = input.visibleFields.find((field) => field.id === answer.fieldId);
      const labelKey = normalizeKey(answer.label);
      const valueKey = normalizeKey(answer.value);
      const inputType = visibleField?.inputType ?? answer.inputType ?? "";

      if (hasCountryGroupQuestion && countryOptionIds.has(answer.fieldId)) {
        return [];
      }

      if (countryOptionIds.has(answer.fieldId)) {
        if (labelKey === desiredCountryKey) {
          return [{
            ...answer,
            value: desiredCountry,
            reason: "Selected only the profile-matched country option."
          }];
        }

        return [];
      }

      if ((inputType === "checkbox" || inputType === "radio") && isCountryListQuestion(`${answer.label} ${visibleField?.context ?? ""}`)) {
        return [{
          ...answer,
          value: desiredCountry,
          reason: "Selected the profile-matched country for this country choice group."
        }];
      }

      if (isCountryOptionLabel(answer.label) && /^(yes|true|agree|accept|select|selected)$/i.test(valueKey)) {
        return labelKey === desiredCountryKey
          ? [{ ...answer, value: desiredCountry }]
          : [];
      }

      return [answer];
    });
}

function resolveUnansweredRequiredLabels(
  visibleFields: VisibleField[],
  answers: Array<{ fieldId?: string; label: string; value: string }>
) {
  const answeredIds = new Set(answers.map((answer) => answer.fieldId).filter(Boolean));
  const hasCountryChoiceAnswer = answers.some((answer) => {
    return isCountryChoiceGroupQuestion(answer.label) || isCountryOptionLabel(answer.label);
  });

  return dedupeLabels(
    visibleFields
      .filter((field) => field.required && !answeredIds.has(field.id))
      .filter((field) => !(hasCountryChoiceAnswer && isCountryOptionLabel(field.label)))
      .map((field) => field.label)
  );
}

function isCountryListQuestion(value: string) {
  return /\b(country|countries|working in|role in which you are applying|currently reside)\b/.test(normalizeKey(value));
}

function isCountryChoiceGroupQuestion(value: string) {
  const normalized = normalizeKey(value);

  return /\b(country|countries)\b/.test(normalized)
    && /\b(anticipate|working in|role in which you are applying|selected in your previous response|previous response)\b/.test(normalized)
    && !/\bcurrently reside\b/.test(normalized);
}

function isCountryOptionLabel(value: string) {
  return /^(australia|belgium|brazil|canada|france|germany|india|indonesia|ireland|israel|italy|japan|luxembourg|malaysia|mexico|new zealand|poland|portugal|romania|singapore|south korea|spain|sweden|switzerland|thailand|the netherlands|netherlands|uae|uk|us|united states|united kingdom)$/i.test(value.trim());
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

  if (label.includes("work authorization") || label.includes("authorized to work")) {
    return student?.visaRequired ? "No" : "Yes";
  }

  if (label.includes("visa sponsorship") || label.includes("sponsorship") || label.includes("work permit")) {
    return student?.visaRequired ? "Yes" : "No";
  }

  if (/\b(remote|work remotely|work remote)\b/.test(label)) {
    return student?.workModes.some((mode) => /remote|hybrid/i.test(mode)) ? "Yes" : "No";
  }

  if (/\b(employed by|worked for|work for)\b/.test(label) && new RegExp(job.company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(field.label)) {
    const currentCompany = student?.completeProfile?.currentCompany ?? student?.completeProfile?.employmentHistory?.[0]?.company;
    return currentCompany && new RegExp(job.company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(currentCompany) ? "Yes" : "No";
  }

  if (/\b(whatsapp|sms updates|text messages|opt in)\b/.test(label)) {
    return "No";
  }

  if (label.includes("location") || label.includes("city")) {
    return student?.preferredLocations[0];
  }

  if (label.includes("country")) {
    return student?.completeProfile?.country;
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

  if (/\b(remote|work remotely|work remote)\b/.test(label)) {
    return student?.workModes.some((mode) => /remote|hybrid/i.test(mode)) ? "Yes" : "No";
  }

  if (/\b(employed by|worked for|work for)\b/.test(label) && new RegExp(job.company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(field.label)) {
    const currentCompany = student?.completeProfile?.currentCompany ?? student?.completeProfile?.employmentHistory?.[0]?.company;
    return currentCompany && new RegExp(job.company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(currentCompany) ? "Yes" : "No";
  }

  if (/\b(whatsapp|sms updates|text messages|opt in)\b/.test(label)) {
    return "No";
  }

  return undefined;
}

function addPreparedValue(prepared: Map<string, string>, label: string, value: string) {
  const cleanValue = value.trim();

  if (!cleanValue) {
    return;
  }

  for (const alias of getFieldAliases(label)) {
    prepared.set(normalizeKey(alias), cleanValue);
  }

  prepared.set(normalizeKey(label), cleanValue);
}

function createPreparedValueMap(baseFields: FilledField[], memory: StudentMemory | undefined) {
  const prepared = new Map<string, string>();

  for (const field of baseFields) {
    addPreparedValue(prepared, field.label, field.value.trim());
  }

  for (const correction of memory?.corrections ?? []) {
    addPreparedValue(prepared, correction.label, correction.value.trim());
  }

  return prepared;
}

function getPreparedLocationHints(prepared: Map<string, string>) {
  return [
    prepared.get("current location"),
    prepared.get("location city"),
    prepared.get("location"),
    prepared.get("preferred location"),
    prepared.get("city")
  ].filter((value): value is string => Boolean(value?.trim()));
}

function resolveCountryHint(prepared: Map<string, string>, student: StudentProfile | undefined, resumeText: string | undefined) {
  return prepared.get("country")
    ?? prepared.get("current country")
    ?? prepared.get("location country")
    ?? prepared.get("country where you currently reside")
    ?? student?.completeProfile?.country
    ?? inferCountryFromPhoneNumber(resolvePreparedPhone(prepared))
    ?? inferCountryFromPhoneNumber(resumeText);
}

function resolvePreparedPhone(prepared: Map<string, string>) {
  return prepared.get("phone number") ?? prepared.get("phone") ?? prepared.get("mobile");
}

function resolvePreparedValue(label: string, prepared: Map<string, string>) {
  const normalizedLabel = normalizeKey(label);

  if (/\b(authorized|eligible|work authorization|legally work)\b/.test(normalizedLabel)) {
    return prepared.get("work authorization") ?? prepared.get("legally authorized to work");
  }

  if (/\b(sponsorship|sponsor|work permit|visa)\b/.test(normalizedLabel)) {
    return prepared.get("visa sponsorship required") ?? prepared.get("visa required");
  }

  if (/\b(remote|work remotely|employed by|worked for|stripe affiliate|whatsapp|sms updates|text messages|opt in)\b/.test(normalizedLabel)) {
    return undefined;
  }

  for (const alias of getFieldAliases(label)) {
    const direct = prepared.get(normalizeKey(alias));

    if (direct) {
      return direct;
    }
  }

  if (/\b(country)\b/.test(normalizedLabel)) {
    return prepared.get("country");
  }

  if (/\b(location|city)\b/.test(normalizedLabel)) {
    const location = prepared.get("location city") ?? prepared.get("city") ?? prepared.get("location") ?? prepared.get("preferred location");
    return cityFromLocationLabel(location) ?? location;
  }

  return undefined;
}

function getFieldAliases(label: string) {
  const normalizedLabel = label.toLowerCase().trim();
  const aliases = new Set([label]);

  if (normalizedLabel.includes("first name")) {
    aliases.add("First name");
    aliases.add("Given name");
  }

  if (normalizedLabel.includes("last name")) {
    aliases.add("Last name");
    aliases.add("Surname");
    aliases.add("Family name");
  }

  if (normalizedLabel.includes("full name") || normalizedLabel === "name") {
    aliases.add("Name");
    aliases.add("Full name");
  }

  if (normalizedLabel.includes("email")) {
    aliases.add("Email");
    aliases.add("Email address");
  }

  if (normalizedLabel.includes("phone") || normalizedLabel.includes("mobile") || normalizedLabel.includes("contact")) {
    aliases.add("Phone");
    aliases.add("Phone number");
    aliases.add("Mobile");
    aliases.add("Contact number");
  }

  if (normalizedLabel.includes("country")) {
    aliases.add("Country");
    aliases.add("Country/Region");
  }

  if (normalizedLabel.includes("location")) {
    aliases.add("Location");
    aliases.add("Location (City)");
    aliases.add("City");
    aliases.add("Current location");
  }

  if (normalizedLabel.includes("city")) {
    aliases.add("City");
    aliases.add("Location (City)");
  }

  if (normalizedLabel.includes("country")) {
    aliases.add("Country");
    aliases.add("Current country");
    aliases.add("Country where you currently reside");
  }

  if (normalizedLabel.includes("employer") || normalizedLabel.includes("company")) {
    aliases.add("Employer");
    aliases.add("Current company");
    aliases.add("Current employer");
    aliases.add("Current or previous employer");
  }

  if (normalizedLabel.includes("job title") || normalizedLabel.includes("title") || normalizedLabel.includes("designation")) {
    aliases.add("Current title");
    aliases.add("Job title");
    aliases.add("Current or previous job title");
  }

  if (normalizedLabel.includes("school") || normalizedLabel.includes("university") || normalizedLabel.includes("college")) {
    aliases.add("School");
    aliases.add("University");
    aliases.add("Most recent school you attended");
  }

  if (normalizedLabel.includes("authorized") || normalizedLabel.includes("work authorization") || normalizedLabel.includes("eligible")) {
    aliases.add("Work authorization");
    aliases.add("Legally authorized to work");
  }

  if (normalizedLabel.includes("visa") || normalizedLabel.includes("sponsorship")) {
    aliases.add("Visa sponsorship required");
    aliases.add("Visa required");
    aliases.add("Require sponsorship");
  }

  return [...aliases];
}

async function askLlmForStageAnswers(input: BuildAnswerPlanInput) {
  const prompt = [
    "You are helping fill a job application form.",
    "Return strict JSON only.",
    "Choose answers using the student context first, then prepared application fields, then memory corrections.",
    "Do not invent personal facts that are not present.",
    "For current city/location autocomplete fields, use a concrete candidate location from profile, resume, address, or work history with city, region, and country. Do not copy the job office location if it conflicts with the candidate's country/profile location.",
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
    `Student: ${JSON.stringify(createStudentProfileSummary(input.student))}`,
    `Resume excerpt: ${JSON.stringify((input.resumeText ?? "").slice(0, 6000))}`,
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
  const prepared = createPreparedValueMap(input.baseFields, input.memory);
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
    let value = String(candidate.value ?? "").trim();
    const resolvedLocationValue = visibleField
      ? resolveLocationFieldValue(visibleField, prepared, input.student, input.job, input.resumeText, value)
      : undefined;

    if (resolvedLocationValue) {
      value = resolvedLocationValue;
    }

    if (!visibleField || visibleField.inputType === "file" || !value) {
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
          content: [
            "You generate safe, personalized answers for job application forms using only the provided context.",
            "Use the resume excerpt and stored profile to write polished but concise answers for summary, bio, motivation, achievements, project, and experience fields.",
            "When a field asks for a short paragraph, tailor it to the job without inventing facts."
          ].join(" ")
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
