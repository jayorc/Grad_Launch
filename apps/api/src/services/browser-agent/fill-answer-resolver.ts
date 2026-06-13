import type { FilledField, Job, StudentMemory, StudentProfile } from "@gradlaunch/shared";
import { callLangChainJson, createStudentProfileSummary, isLangChainAnswerEnabled, retrieveProfileAnswer } from "./answer";
import { jsonBlock, logBrowserLlmTrace, normalizeKey, writeBrowserDebug } from "./util";
import type { FillV2Answer, FillV2Field, FillV2Input, FillV2Intent } from "./fill-engine";
import { readV2FieldCurrentValue } from "./fill-field-drivers";

type PreparedValue = {
  value: string;
  source: "prepared" | "memory";
};

export async function buildFillV2Answers(input: FillV2Input, fields: FillV2Field[]) {
  return buildFillV2AnswersUncached(input, fields);
}

async function buildFillV2AnswersUncached(input: FillV2Input, fields: FillV2Field[]) {
  const prepared = createPreparedMap(input.baseFields, input.memory);
  const answers = new Map<string, FillV2Answer>();
  const unresolvedRequiredLabels: string[] = [];
  const proseFields: FillV2Field[] = [];

  for (const field of fields) {
    if (field.driver === "file") {
      continue;
    }

    const acceptedExisting = await resolveAcceptedExistingAnswer(field, input);

    if (acceptedExisting) {
      answers.set(field.id, acceptedExisting);
      continue;
    }

    const deterministic = resolveDeterministicAnswer(field, input, prepared);

    if (deterministic) {
      answers.set(field.id, deterministic);
      continue;
    }

    if (field.intent === "prose") {
      if (isResumeUploadLikeField(field)) {
        continue;
      }

      if (isTextProseField(field)) {
        const existingValue = await readExistingProseValue(input, field);

        if (existingValue) {
          answers.set(field.id, createAnswer(field, existingValue, "memory", 0.98));
          continue;
        }

        proseFields.push(field);
      } else if (field.required) {
        unresolvedRequiredLabels.push(field.label);
      }

      continue;
    }

    const requiredFallback = field.required
      ? resolveRequiredBestEffortFallback(field, input.student, input.job)
      : undefined;

    if (requiredFallback) {
      answers.set(field.id, createAnswer(field, normalizeAnswer(field, requiredFallback), "fallback", field.intent === "unknown" ? 0.6 : 0.72));
      continue;
    }

    if (field.required) {
      unresolvedRequiredLabels.push(field.label);
    }
  }

  if (proseFields.length > 0 && isLangChainAnswerEnabled()) {
    await input.onStatus?.(`Asking LangChain for prose field(s): ${proseFields.map((field) => field.label).join(", ")} using stored profile and resume context.`);
    const llmAnswers = await askLangChainForProseAnswers(input, proseFields).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      await writeBrowserDebug(input.workspacePath, "fill-v2-llm-prose-error", {
        stageIndex: input.stageIndex,
        message,
        fields: proseFields.map((field) => field.label)
      });
      await input.onStatus?.(`LangChain did not answer prose fields: ${message}. Using local fallback text only where safe.`);
      return [];
    });

    for (const answer of llmAnswers) {
      answers.set(answer.fieldId ?? answer.label, answer);
    }

    if (llmAnswers.length > 0) {
      await input.onStatus?.(`LangChain returned prose answer(s) for: ${llmAnswers.map((answer) => answer.label).join(", ")}.`);
    }
  }

  for (const field of proseFields) {
    if (answers.has(field.id)) {
      continue;
    }

    const fallback = resolveProseFallback(field, input.student, input.job);

    if (fallback) {
      answers.set(field.id, createAnswer(field, fallback, "fallback", 0.58));
      continue;
    }

    if (field.required) {
      unresolvedRequiredLabels.push(field.label);
    }
  }

  const finalAnswers = [...answers.values()];
  const answerById = new Map(finalAnswers.map((answer) => [answer.fieldId ?? answer.label, answer]));

  await writeBrowserDebug(input.workspacePath, "fill-v2-answer-plan", {
    stageIndex: input.stageIndex,
    answerCount: finalAnswers.length,
    unresolvedRequiredLabels,
    answers: finalAnswers.map((answer) => ({
      label: answer.label,
      intent: answer.intent,
      source: answer.source,
      inputType: answer.inputType,
      valuePreview: answer.value.length > 80 ? `${answer.value.slice(0, 77)}...` : answer.value
    }))
  });
  await writeBrowserDebug(input.workspacePath, "fill-v2-field-resolution-trace", {
    stageIndex: input.stageIndex,
    fields: fields.map((field) => {
      const answer = answerById.get(field.id);

      return {
        fieldId: field.id,
        label: field.label,
        driver: field.driver,
        widgetKind: field.widgetKind,
        valueKind: field.valueKind,
        confidence: field.confidence,
        required: field.required,
        metadata: {
          labelSource: field.labelSource,
          placeholder: field.placeholder,
          autocomplete: field.autocomplete,
          name: field.name,
          sectionLabel: field.sectionLabel,
          helpText: field.helpText,
          domPathSignature: field.domPathSignature
        },
        signature: field.signature,
        intentCandidates: field.intentCandidates,
        chosenSource: answer?.source ?? null,
        chosenValuePreview: answer
          ? answer.value.length > 120
            ? `${answer.value.slice(0, 117)}...`
            : answer.value
          : null,
        chosenIntent: answer?.intent ?? null,
        unresolved: !answer && field.required
      };
    }).slice(0, 120)
  });

  return {
    answers: finalAnswers,
    unresolvedRequiredLabels,
    usedLlm: finalAnswers.some((answer) => answer.source === "llm"),
    summary: summarizeAnswerSources(finalAnswers)
  };
}

async function resolveAcceptedExistingAnswer(field: FillV2Field, input: FillV2Input) {
  if (field.intent !== "preferred_work_location") {
    return undefined;
  }

  const existingValue = await readV2FieldCurrentValue(input.page, field);

  if (!existingValue || !isAcceptableExistingPreferredLocation(existingValue, input)) {
    return undefined;
  }

  return createAnswer(field, existingValue, "memory", 0.98);
}

function isAcceptableExistingPreferredLocation(value: string, input: FillV2Input) {
  const actual = canonicalLocationKey(value);

  if (!actual) {
    return false;
  }

  const details = input.student?.completeProfile;
  const allowed = [
    ...(input.student?.preferredLocations ?? []),
    preferredLocationFromJob(input.job.location),
    details?.city
  ].filter((item): item is string => Boolean(item?.trim()));

  return allowed.some((candidate) => {
    const expected = canonicalLocationKey(candidate);
    return Boolean(expected && (actual === expected || actual.includes(expected) || expected.includes(actual)));
  });
}

async function readExistingProseValue(input: FillV2Input, field: FillV2Field) {
  const value = await readV2FieldCurrentValue(input.page, field);
  const cleanValue = value?.trim();

  if (!cleanValue || !isMeaningfulExistingProseValue(field, cleanValue)) {
    return undefined;
  }

  return cleanValue;
}

function isMeaningfulExistingProseValue(field: FillV2Field, value: string) {
  const key = normalizeKey(value);
  const labelKey = normalizeKey(field.label);
  const placeholderKey = normalizeKey(field.placeholder);

  if (value.length < 12 || isUnsafeProseValue(value)) {
    return false;
  }

  if (key === labelKey || key === placeholderKey) {
    return false;
  }

  return !/^(select|search|choose|enter answer|type answer|value is required|required)$/i.test(value.trim());
}

function resolveDeterministicAnswer(
  field: FillV2Field,
  input: FillV2Input,
  prepared: Map<string, PreparedValue>
): FillV2Answer | undefined {
  if (isOptionalPhoneCountryCodeField(field)) {
    return undefined;
  }

  if (field.intent === "prose") {
    return undefined;
  }

  const profileFirstValue = shouldPreferProfileValue(field)
    ? resolveProfileAnswerValue(field, input)
    : undefined;

  if (profileFirstValue) {
    return createAnswer(field, normalizeAnswer(field, profileFirstValue), "profile", field.intent === "unknown" ? 0.55 : 0.95);
  }

  const preparedValue = resolvePreparedValue(field, prepared);

  if (preparedValue && isSafePreparedValueForField(field, preparedValue.value)) {
    return createAnswer(field, normalizeAnswer(field, preparedValue.value), preparedValue.source, 0.92);
  }

  const value = resolveProfileAnswerValue(field, input);

  if (!value) {
    return undefined;
  }

  return createAnswer(field, normalizeAnswer(field, value), "profile", field.intent === "unknown" ? 0.55 : 0.95);
}

function isTextProseField(field: FillV2Field) {
  return !["choice", "native_select", "custom_select", "file"].includes(field.driver);
}

function resolveProfileAnswerValue(field: FillV2Field, input: FillV2Input) {
  if (isSensitiveGovernmentIdField(field)) {
    return undefined;
  }

  const explicit = resolveProfileValue(field.intent, field, input.student, input.job);

  if (explicit) {
    return explicit;
  }

  if (field.intent === "unknown") {
    return undefined;
  }

  const retrieved = retrieveProfileAnswer(field, input.student, input.job);

  return retrieved && isSafeRetrievedProfileValueForField(field, retrieved) ? retrieved : undefined;
}

function shouldPreferProfileValue(field: FillV2Field) {
  return [
    "first_name",
    "middle_name",
    "last_name",
    "full_name",
    "email",
    "confirm_email",
    "phone",
    "country",
    "state",
    "city",
    "preferred_work_location",
    "postal_code",
    "address_1",
    "address_2",
    "current_ctc",
    "expected_ctc",
    "notice_period",
    "total_experience",
    "work_company",
    "work_title"
  ].includes(field.intent);
}

function resolveProfileValue(
  intent: FillV2Intent,
  field: FillV2Field,
  student: StudentProfile | undefined,
  job: Job
) {
  const details = student?.completeProfile;
  const fullName = student?.fullName?.trim();
  const nameParts = fullName?.split(/\s+/).filter(Boolean) ?? [];
  const education = details?.educationHistory?.[0];
  const employment = details?.employmentHistory?.[0];

  switch (intent) {
    case "first_name":
      return nameParts[0];
    case "middle_name":
      return undefined;
    case "last_name":
      return nameParts.length > 1 ? nameParts.slice(1).join(" ") : nameParts[0];
    case "full_name":
      return fullName;
    case "email":
    case "confirm_email":
      return student?.email;
    case "phone":
      return normalizePhone(details?.phone, details?.country ?? details?.nationality);
    case "country":
      return normalizeCountryOrUndefined(details?.country)
        ?? inferCountryFromPhone(details?.phone)
        ?? normalizeCountryOrUndefined(details?.nationality)
        ?? "India";
    case "state":
      return details?.state;
    case "city":
      return formatLocation(
        details?.city ?? inferCityFromAddress(details?.addressLine1) ?? inferCityFromAddress(details?.addressLine2),
        details?.state,
        normalizeCountryOrUndefined(details?.country) ?? inferCountryFromPhone(details?.phone)
      )
        ?? details?.city
        ?? inferCityFromAddress(details?.addressLine1)
        ?? inferCityFromAddress(details?.addressLine2);
    case "preferred_work_location":
      return normalizePreferredLocation(student, job)
        ?? formatLocation(
          details?.city ?? inferCityFromAddress(details?.addressLine1) ?? inferCityFromAddress(details?.addressLine2),
          details?.state,
          normalizeCountryOrUndefined(details?.country) ?? inferCountryFromPhone(details?.phone)
        )
        ?? "Bhiwani, Haryana, India";
    case "postal_code":
      return details?.postalCode;
    case "address_1":
      return details?.addressLine1 ?? formatLocation(details?.city, details?.state, normalizeCountryOrUndefined(details?.country) ?? inferCountryFromPhone(details?.phone));
    case "address_2":
      return details?.addressLine2;
    case "linkedin":
      return normalizeUrl(details?.linkedInUrl);
    case "github":
      return normalizeUrl(details?.githubUrl);
    case "portfolio":
      return normalizeUrl(details?.portfolioUrl ?? details?.websiteUrl);
    case "website":
      return normalizeUrl(details?.websiteUrl ?? details?.portfolioUrl);
    case "expected_ctc":
      return formatSalary(student?.expectedSalaryLpa, field);
    case "current_ctc":
      return formatSalary(details?.currentSalaryLpa, field);
    case "notice_period":
      return formatNoticePeriod(details?.noticePeriodDays, field);
    case "total_experience":
      return formatExperienceYears(details?.totalExperienceYears, field);
    case "office_work_choice":
      return choiceYes(field.options) ?? "Yes";
    case "bond_obligation_choice":
      return choiceNo(field.options) ?? "No";
    case "previous_employer_choice":
      return hasWorkedAtCompany(student, job.company) ? choiceYes(field.options) ?? "Yes" : choiceNo(field.options) ?? "No";
    case "shift_flexibility_choice":
      return choiceYes(field.options) ?? "Yes";
    case "notice_buyout_choice":
      return choiceNo(field.options) ?? "No";
    case "government_id":
      return undefined;
    case "degree_name":
      return cleanDegree(education?.fieldOfStudy) ?? cleanDegree(education?.degree) ?? cleanDegree(student?.degree);
    case "degree_type":
      return matchDegreeType(student?.degree ?? education?.degree, field.options);
    case "university":
      return education?.school;
    case "education_start":
      return formatYearDate(education?.startYear ?? (student?.graduationYear ? student.graduationYear - 4 : undefined), "start");
    case "education_end":
      return formatYearDate(education?.endYear ?? student?.graduationYear, "end");
    case "work_experience_choice":
      return hasWorkHistory(student) ? choiceYes(field.options) : choiceNo(field.options);
    case "work_company":
      return details?.currentCompany ?? employment?.company;
    case "work_title":
      return details?.currentTitle ?? employment?.title;
    case "work_start":
      return employment?.startDate;
    case "work_end":
      return employment?.endDate;
    case "work_current_choice":
      return details?.currentCompany ? choiceYes(field.options) : choiceNo(field.options);
    case "consent":
      return choiceYes(field.options);
    case "marketing_opt_in":
    case "preferred_name_choice":
      return choiceNo(field.options);
    case "work_authorization":
      return student?.visaRequired ? choiceNo(field.options) : choiceYes(field.options);
    case "sponsorship":
      return student?.visaRequired || details?.sponsorshipRequired ? choiceYes(field.options) : choiceNo(field.options);
    case "relocation":
      return details?.openToRelocate === undefined ? undefined : details.openToRelocate ? choiceYes(field.options) : choiceNo(field.options);
    case "prose":
    case "unknown":
      return undefined;
  }
}

async function askLangChainForProseAnswers(input: FillV2Input, fields: FillV2Field[]): Promise<FillV2Answer[]> {
  const answers: FillV2Answer[] = [];

  for (const requestedField of fields) {
    const variationToken = `${requestedField.id}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const prompt = [
      "Answer this one prose field and return JSON only.",
      "Write one fresh field-specific response using the supplied job, student, resume, prepared fields, and memory.",
      "",
      "Schema:",
      '{"fieldId":"...","label":"...","value":"...","reason":"..."}',
      "",
      `Variation token: ${variationToken}`,
      `Job: ${input.job.title} at ${input.job.company}`,
      `Job excerpt: ${input.job.description.slice(0, 1600)}`,
      `Student profile: ${JSON.stringify(createStudentProfileSummary(input.student))}`,
      `Resume excerpt: ${JSON.stringify((input.resumeText ?? "").slice(0, 5000))}`,
      `Prepared fields: ${JSON.stringify(input.baseFields)}`,
      `Memory corrections: ${JSON.stringify(input.memory?.corrections ?? [])}`,
      `Field: ${JSON.stringify({
        fieldId: requestedField.id,
        label: requestedField.label,
        context: requestedField.context.slice(0, 300),
        required: requestedField.required,
        maxLength: requestedField.maxLength
      })}`
    ].join("\n");

    const content = await callLangChainJson({
      system: "You write concise job-application prose and return JSON.",
      prompt,
      workspacePath: input.workspacePath,
      traceLabel: `fill-v2-prose-${requestedField.id}`,
      temperatureOverride: 0.95
    });
    const parsed = JSON.parse(jsonBlock(content)) as {
      fieldId?: string;
      label?: string;
      value?: string;
      reason?: string;
      answer?: { fieldId?: string; label?: string; value?: string; reason?: string };
    };
    const candidate = parsed.answer ?? parsed;
    const field = requestedField;
    const value = candidate.value?.trim();

    if (!value || isUnsafeProseValue(value)) {
      await logBrowserLlmTrace(input.workspacePath, "fill-v2-prose-field-discarded", {
        requestedFieldId: requestedField.id,
        requestedLabel: requestedField.label,
        returnedFieldId: candidate.fieldId ?? "",
        returnedLabel: candidate.label ?? "",
        returnedReason: candidate.reason ?? "",
        matchedFieldId: field.id,
        matchedLabel: field.label,
        value: value ?? "",
        discardedBecause: !value ? "empty_value" : "unsafe_file_like_value"
      });
      continue;
    }

    await logBrowserLlmTrace(input.workspacePath, "fill-v2-prose-field", {
      requestedFieldId: requestedField.id,
      requestedLabel: requestedField.label,
      returnedFieldId: candidate.fieldId ?? "",
      returnedLabel: candidate.label ?? "",
      returnedReason: candidate.reason ?? "",
      matchedFieldId: field.id,
      matchedLabel: field.label,
      mappingMode: candidate.fieldId?.trim() === requestedField.id || normalizeKey(candidate.label ?? "") === normalizeKey(requestedField.label)
        ? "requested_field_confirmed"
        : "requested_field_forced",
      answer: value
    });

    answers.push({
      ...createAnswer(field, value, "llm", 0.84),
      reason: candidate.reason ?? "LangChain generated a field-specific prose answer from profile and resume context."
    });
  }

  return answers;
}

function resolveProseFallback(field: FillV2Field, student: StudentProfile | undefined, job: Job) {
  const descriptor = normalizeKey(`${field.label} ${field.context}`);
  const skills = student?.skills?.slice(0, 4).filter(Boolean).join(", ");
  const role = student?.targetRoles?.[0] ?? job.title;
  const bio = student?.bio?.trim();

  if (/\b(cover letter|motivation|why)\b/.test(descriptor)) {
    return [
      `I am excited to apply for the ${job.title} role at ${job.company}.`,
      bio || `My background in ${student?.degree || role} and hands-on skills in ${skills || "software development"} align well with this opportunity.`,
      "I would value the chance to contribute with ownership, practical problem-solving, and a strong learning mindset."
    ].join(" ");
  }

  if (/\b(technical expertise|overall technical|expertise|tell us)\b/.test(descriptor)) {
    return [
      `My strongest technical areas are ${skills || "software development, problem-solving, and building practical applications"}.`,
      "I focus on writing maintainable code, understanding product requirements clearly, and learning quickly when a role needs a new tool or framework."
    ].join(" ");
  }

  if (/\b(reason for job change|job change reason|reason.*change)\b/.test(descriptor)) {
    return `I am looking for a role where I can keep growing as a ${role}, contribute to meaningful engineering work, and take on stronger ownership in a collaborative team.`;
  }

  if (/\b(message|hiring team|comments?|additional information|let the company know|interest working there|interest in working there)\b/.test(descriptor)) {
    return [
      `Thank you for reviewing my application for the ${job.title} role.`,
      `I am especially interested in contributing ${skills ? `with my experience in ${skills}` : "with strong ownership and problem-solving"}.`,
      "I would be grateful for the opportunity to discuss how I can contribute to the team."
    ].join(" ");
  }

  return undefined;
}

function resolveRequiredBestEffortFallback(field: FillV2Field, student: StudentProfile | undefined, job: Job) {
  if (isSensitiveGovernmentIdField(field)) {
    return undefined;
  }

  const descriptor = normalizeKey(`${field.label} ${field.context}`);
  const details = student?.completeProfile;

  if (field.driver === "choice") {
    if (/\b(privacy|terms|consent|agree|acknowledge|declaration|read and understand)\b/.test(descriptor)) {
      return choiceYes(field.options) ?? "Yes";
    }

    if (/\b(bond|obligation|buyout|previously associated|associated previously|previous employer|worked previously)\b/.test(descriptor)) {
      return choiceNo(field.options) ?? "No";
    }

    if (/\b(open|flexible|available|willing|work from office|hybrid|shift|night|relocat)\b/.test(descriptor)) {
      return choiceYes(field.options) ?? "Yes";
    }

    return choiceNo(field.options) ?? "No";
  }

  if (!shouldAllowRequiredFallback(field)) {
    return undefined;
  }

  switch (field.intent) {
    case "current_ctc":
      return formatSalary(details?.currentSalaryLpa, field);
    case "expected_ctc":
      return formatSalary(student?.expectedSalaryLpa, field);
    case "preferred_work_location":
      return normalizePreferredLocation(student, job);
    case "work_company":
      return details?.currentCompany ?? details?.employmentHistory?.[0]?.company;
    case "work_title":
      return details?.currentTitle ?? details?.employmentHistory?.[0]?.title;
    case "notice_buyout_choice":
      return "No";
    case "notice_period":
      return formatNoticePeriod(details?.noticePeriodDays, field);
    case "total_experience":
      return formatExperienceYears(details?.totalExperienceYears, field);
    case "prose":
      return isClearProseFallbackField(field) ? resolveProseFallback(field, student, job) : undefined;
    case "unknown":
      return undefined;
    default:
      return undefined;
  }
}

function shouldAllowRequiredFallback(field: FillV2Field) {
  if (field.driver === "choice") {
    return true;
  }

  if (field.intent === "unknown") {
    return false;
  }

  if (field.intent === "prose") {
    return isClearProseFallbackField(field);
  }

  if (!isTextLikeField(field)) {
    return true;
  }

  if (!STRICT_REQUIRED_TEXT_INTENTS.has(field.intent)) {
    return false;
  }

  return field.confidence >= 0.8;
}

function isClearProseFallbackField(field: FillV2Field) {
  const descriptor = normalizeKey(`${field.label} ${field.context}`);
  if (isResumeUploadLikeField(field)) {
    return false;
  }

  return /\b(cover letter|motivation|why|message|hiring team|additional information|comments?|technical expertise|overall technical|reason for job change|job change reason)\b/.test(descriptor);
}

function isTextLikeField(field: FillV2Field) {
  return ["text", "textarea", "number", "contenteditable", "email", "phone"].includes(field.driver);
}

const STRICT_REQUIRED_TEXT_INTENTS = new Set<FillV2Field["intent"]>([
  "current_ctc",
  "expected_ctc",
  "preferred_work_location",
  "work_company",
  "work_title",
  "notice_period",
  "total_experience",
  "prose"
]);

function createPreparedMap(baseFields: FilledField[], memory: StudentMemory | undefined) {
  const map = new Map<string, PreparedValue>();

  for (const field of baseFields) {
    addPrepared(map, field.label, field.value, "prepared");
  }

  for (const correction of memory?.corrections ?? []) {
    addPrepared(map, correction.label, correction.value, "memory");
  }

  return map;
}

function addPrepared(map: Map<string, PreparedValue>, label: string, value: string | undefined, source: PreparedValue["source"]) {
  const cleanValue = value?.trim();

  if (!cleanValue) {
    return;
  }

  for (const alias of aliasesFor(label)) {
    map.set(normalizeKey(alias), { value: cleanValue, source });
  }

  map.set(normalizeKey(label), { value: cleanValue, source });
}

function resolvePreparedValue(field: FillV2Field, prepared: Map<string, PreparedValue>) {
  if (isSensitiveGovernmentIdField(field)) {
    return undefined;
  }

  const keys = [
    field.label,
    field.intent.replace(/_/g, " "),
    ...aliasesFor(field.label)
  ].map(normalizeKey);

  return keys.map((key) => prepared.get(key)).find(Boolean);
}

function aliasesFor(label: string) {
  const key = normalizeKey(label);
  const aliases = new Set([label]);

  if (/\bphone|mobile|contact\b/.test(key)) aliases.add("Phone number");
  if (/\bemail\b/.test(key)) aliases.add("Email");
  if (/\bcountry\b/.test(key)) aliases.add("Country");
  if (/\bpreferred\b/.test(key) && /\b(location|city)\b/.test(key)) {
    aliases.add("Preferred location");
  } else if (/\bcity|location\b/.test(key)) {
    aliases.add("Current location");
    aliases.add("Location (City)");
  }
  if (/\b(expected|desired|target|asking|minimum)\b/.test(key) && /\bctc|salary|compensation\b/.test(key)) {
    aliases.add("Expected CTC");
    aliases.add("Expected salary");
  } else if (/\b(current|present|existing|last|previous|annual)\b/.test(key) && /\bctc|salary|compensation\b/.test(key)) {
    aliases.add("Current CTC");
    aliases.add("Current salary");
  }
  if (/\blinkedin\b/.test(key)) aliases.add("LinkedIn URL");
  if (/\bgithub\b/.test(key)) aliases.add("GitHub URL");
  if (/\bportfolio\b/.test(key)) aliases.add("Portfolio URL");
  if (/\bwebsite\b/.test(key)) aliases.add("Website URL");
  if (/\b(let the company know|interest working there|interest in working there|hiring team|cover letter|why are you interested)\b/.test(key)) {
    aliases.add("Message to the Hiring Team");
    aliases.add("Cover Letter");
    aliases.add("Why are you interested in this role?");
  }

  return [...aliases];
}

function isSafePreparedValueForField(field: FillV2Field, value: string) {
  const key = normalizeKey(value);

  if (isSensitiveGovernmentIdField(field)) {
    return false;
  }

  if (field.intent === "prose" && isUnsafeProseValue(value)) {
    return false;
  }

  if (["city", "preferred_work_location", "state", "postal_code", "address_1", "address_2"].includes(field.intent)) {
    if (looksLikePhoneNumber(value) || /@/.test(value) || /^https?:\/\//i.test(value)) {
      return false;
    }
  }

  if (field.intent === "city" || field.intent === "preferred_work_location") {
    return hasLetter(value) && !isCountryOnlyValue(value);
  }

  if (field.intent === "state") {
    return hasLetter(value) && !isCountryOnlyValue(value);
  }

  if (field.intent === "country") {
    return /\b(india|united states|usa|united kingdom|uk|canada|australia|germany|france|singapore)\b/.test(key);
  }

  if (field.intent === "phone") {
    return value.replace(/\D+/g, "").length >= 7;
  }

  if (field.intent === "email" || field.intent === "confirm_email") {
    return /@/.test(value);
  }

  if ((field.intent === "website" || field.intent === "portfolio") && isPreparedSocialUrl(value)) {
    return false;
  }

  return true;
}

function isSafeRetrievedProfileValueForField(field: FillV2Field, value: string) {
  if (!isSafePreparedValueForField(field, value)) {
    return false;
  }

  if (field.intent === "work_company" || field.intent === "work_title" || field.intent === "university") {
    return /[a-z]/i.test(value) && !/^\d+(?:\.\d+)?$/.test(value.trim());
  }

  return true;
}

function looksLikePhoneNumber(value: string) {
  const compact = value.trim();
  const digits = compact.replace(/\D+/g, "");

  if (digits.length < 7) {
    return false;
  }

  const letters = compact.replace(/[^a-z]/gi, "");
  return /^\+?[\d\s().-]+$/.test(compact) || letters.length <= 2;
}

function hasLetter(value: string) {
  return /[a-z]/i.test(value);
}

function isCountryOnlyValue(value: string) {
  const key = normalizeKey(value);
  return /^(india|bharat|united states|usa|us|united kingdom|uk|australia|canada)$/.test(key);
}

function isSensitiveGovernmentIdField(field: FillV2Field) {
  return field.intent === "government_id"
    || /\baadhaar|aadhar|pan card|government id|national id|identity number\b/.test(normalizeKey(`${field.label} ${field.context}`));
}

function isPreparedSocialUrl(value: string) {
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();

    return /(^|\.)github\.com$/.test(host) || /(^|\.)linkedin\.com$/.test(host);
  } catch (_error) {
    return /\bgithub\.com\b|\blinkedin\.com\b/i.test(value);
  }
}

function isResumeUploadLikeField(field: FillV2Field) {
  const descriptor = normalizeKey(`${field.label} ${field.context} ${field.domPathSignature ?? ""}`);
  const label = normalizeKey(field.label);

  return /^(resume|cv|curriculum vitae|upload resume|upload cv)$/.test(label)
    || /\b(resume upload|upload resume|upload cv|from device|from computer|drag and drop)\b/.test(descriptor);
}

function isUnsafeProseValue(value: string) {
  const trimmed = value.trim();
  const normalized = normalizeKey(trimmed);

  return /^[\w .()[\]-]+\.(pdf|doc|docx|rtf|txt)$/i.test(trimmed)
    || /\b(uploaded resume|pre filled based on uploaded resume|resume file|cv file)\b/.test(normalized);
}

function normalizeAnswer(field: FillV2Field, value: string) {
  if (field.intent === "country") {
    return normalizeCountry(value);
  }

  if (field.intent === "phone") {
    return normalizePhone(value, "India") ?? value;
  }

  if (field.driver === "choice" || field.driver === "native_select" || field.driver === "custom_select") {
    return matchOption(value, field.options) ?? value;
  }

  return value.trim();
}

function createAnswer(field: FillV2Field, value: string, source: FillV2Answer["source"], confidence: number): FillV2Answer {
  const fittedValue = fitAnswerToFieldLimit(field, value);

  return {
    label: field.label,
    value: fittedValue,
    fieldId: field.id,
    inputType: field.inputType,
    options: field.options,
    required: field.required,
    reason: `${source} answer for ${field.intent}.`,
    intent: field.intent,
    source,
    confidence
  };
}

function fitAnswerToFieldLimit(field: FillV2Field, value: string) {
  const cleanValue = value.trim();
  const maxLength = field.maxLength;

  if (!maxLength || maxLength <= 0 || isExactValueField(field)) {
    return cleanValue;
  }

  const target = maxLength < 20
    ? maxLength
    : maxLength <= 120
      ? Math.max(1, maxLength - 5)
      : Math.max(1, maxLength - 10);

  if (cleanValue.length <= target) {
    return cleanValue;
  }

  const truncated = cleanValue.slice(0, target).trimEnd();
  const lastSpace = truncated.lastIndexOf(" ");
  const wordSafe = lastSpace >= Math.floor(target * 0.65) ? truncated.slice(0, lastSpace) : truncated;

  return wordSafe.replace(/[.,;:!?-]+$/, "").trim() || truncated;
}

function isExactValueField(field: FillV2Field) {
  return [
    "first_name",
    "middle_name",
    "last_name",
    "full_name",
    "email",
    "confirm_email",
    "phone",
    "linkedin",
    "github",
    "portfolio",
    "website",
    "postal_code"
  ].includes(field.intent);
}

function isOptionalPhoneCountryCodeField(field: FillV2Field) {
  return field.intent === "country"
    && /\b(country code|country region code|search by country\/region or code|search by country region or code|dial code|phone code)\b/.test(normalizeKey(`${field.label} ${field.context}`));
}

function normalizePhone(value: string | undefined, countryHint: string | undefined) {
  const clean = value?.trim();

  if (!clean) {
    return undefined;
  }

  if (/^\+/.test(clean)) {
    return clean.replace(/\s+/g, "");
  }

  const digits = clean.replace(/\D+/g, "");

  if (digits.length < 7) {
    return clean;
  }

  const dial = inferDialCode(countryHint) ?? (digits.length === 10 ? "+91" : undefined);

  return dial ? `${dial}${digits.slice(-10)}` : clean;
}

function inferDialCode(value: string | undefined) {
  const key = normalizeKey(value);

  if (/\bindia|indian\b/.test(key)) return "+91";
  if (/\bunited states|usa|us|canada\b/.test(key)) return "+1";
  if (/\bunited kingdom|uk|britain|england\b/.test(key)) return "+44";
  if (/\baustralia\b/.test(key)) return "+61";
  return undefined;
}

function inferCountryFromPhone(value: string | undefined) {
  const digits = value?.replace(/\D+/g, "") ?? "";

  if (digits.startsWith("91") || digits.length === 10) {
    return "India";
  }

  return undefined;
}

function normalizeCountry(value: string) {
  return normalizeCountryOrUndefined(value) ?? value.trim();
}

function normalizeCountryOrUndefined(value: string | undefined) {
  const key = normalizeKey(value);

  if (/\bindia|indian\b/.test(key)) return "India";
  if (/\bunited states|usa|us\b/.test(key)) return "United States";
  if (/\bunited kingdom|uk\b/.test(key)) return "United Kingdom";
  if (/\baustralia\b/.test(key)) return "Australia";
  if (/\bcanada\b/.test(key)) return "Canada";
  if (/\bgermany\b/.test(key)) return "Germany";
  if (/\bfrance\b/.test(key)) return "France";
  if (/\bsingapore\b/.test(key)) return "Singapore";
  return undefined;
}

function formatLocation(city: string | undefined, state: string | undefined, country: string | undefined) {
  return [city, state, country].filter(Boolean).join(", ") || undefined;
}

function normalizePreferredLocation(student: StudentProfile | undefined, job: Job) {
  const details = student?.completeProfile;
  const jobLocation = preferredLocationFromJob(job.location);
  const preferredLocations = student?.preferredLocations?.map((value) => value.trim()).filter(Boolean) ?? [];
  const jobMatchedPreferred = preferredLocationMentionedInJob(preferredLocations, job);
  const preferred = preferredLocations[0];
  const profileLocation = formatLocation(
    details?.city ?? inferCityFromAddress(details?.addressLine1) ?? inferCityFromAddress(details?.addressLine2),
    details?.state,
    normalizeCountryOrUndefined(details?.country) ?? inferCountryFromPhone(details?.phone)
  );

  return jobLocation ?? jobMatchedPreferred ?? preferred ?? profileLocation;
}

function preferredLocationMentionedInJob(preferredLocations: string[], job: Job) {
  const jobText = normalizeKey([
    job.location,
    job.title,
    job.company,
    job.description?.slice(0, 5000)
  ].filter(Boolean).join(" "));

  if (!jobText) {
    return undefined;
  }

  for (const location of preferredLocations) {
    const normalized = preferredLocationFromJob(location);
    const aliases = locationAliasesForJobMatch(normalized ?? location);

    if (aliases.some((alias) => alias && jobText.includes(alias))) {
      return normalized ?? location;
    }
  }

  return undefined;
}

function locationAliasesForJobMatch(value: string) {
  const key = normalizeKey(value);
  const aliases = new Set<string>([key]);

  if (/\bbengaluru|bangalore|banglore\b/.test(key)) {
    aliases.add("bengaluru");
    aliases.add("bangalore");
    aliases.add("banglore");
  }

  if (/\bgurugram|gurgaon\b/.test(key)) {
    aliases.add("gurugram");
    aliases.add("gurgaon");
  }

  return [...aliases].filter(Boolean);
}

function canonicalLocationKey(value: string | undefined) {
  const key = normalizeKey(value);

  if (!key) {
    return "";
  }

  if (/\bgurugram|gurgaon\b/.test(key)) return "gurugram";
  if (/\bbengaluru|bangalore|banglore\b/.test(key)) return "bengaluru";
  if (/\bbhiwani\b/.test(key)) return "bhiwani";
  if (/\bnoida\b/.test(key)) return "noida";
  if (/\bhyderabad\b/.test(key)) return "hyderabad";
  if (/\bpune\b/.test(key)) return "pune";
  if (/\bmumbai\b/.test(key)) return "mumbai";
  if (/\bdelhi|new delhi\b/.test(key)) return "delhi";
  if (/\bchennai\b/.test(key)) return "chennai";
  if (/\bkolkata\b/.test(key)) return "kolkata";

  return key
    .replace(/\b(india|australia|canada|united states|usa|united kingdom|uk)\b/g, " ")
    .replace(/\b(haryana|bihar|maharashtra|karnataka|uttar pradesh|telangana|tamil nadu|west bengal|new south wales|california|washington|texas|new york)\b/g, " ")
    .replace(/\b(city|location|state|region|country)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function preferredLocationFromJob(value: string | undefined) {
  const clean = value?.trim();

  if (!clean) {
    return undefined;
  }

  const key = normalizeKey(clean);

  if (/\bremote\b/.test(key)) return "Remote";
  if (/\bpune\b/.test(key)) return "Pune";
  if (/\bbengaluru|bangalore|banglore\b/.test(key)) return "Bengaluru";
  if (/\bnagpur\b/.test(key)) return "Nagpur";
  if (/\bgurugram|gurgaon\b/.test(key)) return "Gurugram";
  if (/\bhyderabad\b/.test(key)) return "Hyderabad";
  if (/\bnoida\b/.test(key)) return "Noida";
  if (/\bmumbai\b/.test(key)) return "Mumbai";
  if (/\bdelhi|new delhi\b/.test(key)) return "Delhi";
  if (/\bchennai\b/.test(key)) return "Chennai";
  if (/\bkolkata\b/.test(key)) return "Kolkata";

  return clean.split(/[,|/]/)[0]?.trim() || clean;
}

function inferCityFromAddress(value: string | undefined) {
  const key = normalizeKey(value);

  if (/\bbhiwani\b/.test(key)) return "Bhiwani";
  if (/\bgurugram|gurgaon\b/.test(key)) return "Gurugram";
  if (/\bdelhi|new delhi\b/.test(key)) return "Delhi";
  if (/\bnoida\b/.test(key)) return "Noida";
  if (/\bpune\b/.test(key)) return "Pune";
  if (/\bmumbai\b/.test(key)) return "Mumbai";
  if (/\bhyderabad\b/.test(key)) return "Hyderabad";
  if (/\bbengaluru|bangalore|banglore\b/.test(key)) return "Bengaluru";
  if (/\bchennai\b/.test(key)) return "Chennai";
  if (/\bkolkata\b/.test(key)) return "Kolkata";
  return undefined;
}

function normalizeUrl(value: string | undefined) {
  const clean = value?.trim();

  if (!clean) {
    return undefined;
  }

  return /^https?:\/\//i.test(clean) ? clean : `https://${clean}`;
}

function formatSalary(value: number | undefined, field: FillV2Field) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const descriptor = normalizeKey(`${field.label} ${field.context}`);
  return /\b(lpa|lakhs?|lakh per annum)\b/.test(descriptor) || field.driver === "number" ? String(value) : `${value} LPA`;
}

function formatExperienceYears(value: number | undefined, field: FillV2Field) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return field.driver === "custom_select" || field.inputType === "autocomplete"
    ? `${value} ${value === 1 ? "year" : "years"}`
    : String(value);
}

function formatNoticePeriod(value: number | undefined, field: FillV2Field) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return field.driver === "custom_select" || field.inputType === "autocomplete"
    ? `${value} ${value === 1 ? "day" : "days"}`
    : String(value);
}

function cleanDegree(value: string | undefined) {
  const clean = value?.trim();
  return clean || undefined;
}

function matchDegreeType(value: string | undefined, options: string[]) {
  const key = normalizeKey(value);

  if (!key) {
    return undefined;
  }

  const desired = /\b(btech|b tech|bachelor|bachelors|be|b e)\b/.test(key)
    ? "Bachelor"
    : /\b(mtech|m tech|master|masters|ms|m s)\b/.test(key)
      ? "Master"
      : value ?? "";

  return matchOption(desired, options) ?? desired;
}

function formatYearDate(year: number | undefined, side: "start" | "end") {
  if (!year) {
    return undefined;
  }

  return `${year}-${side === "start" ? "08" : "05"}-01`;
}

function hasWorkHistory(student: StudentProfile | undefined) {
  const details = student?.completeProfile;

  return Boolean(
    details?.currentCompany
    || details?.currentTitle
    || (details?.totalExperienceYears ?? 0) > 0
    || (details?.employmentHistory?.length ?? 0) > 0
  );
}

function hasWorkedAtCompany(student: StudentProfile | undefined, company: string | undefined) {
  const companyKey = normalizeKey(company);

  if (!companyKey) {
    return false;
  }

  const details = student?.completeProfile;
  const candidates = [
    details?.currentCompany,
    ...(details?.employmentHistory ?? []).map((item) => item.company)
  ].map(normalizeKey).filter(Boolean);

  return candidates.some((candidate) => candidate.includes(companyKey) || companyKey.includes(candidate));
}

function choiceYes(options: string[]) {
  return options.find((option) => /^(yes|true|agree|i agree|accept|acknowledge|confirm)$/i.test(option.trim()))
    ?? options.find((option) => option.length <= 60 && /\b(i agree|agree|accept|acknowledge|confirm|yes)\b/i.test(option))
    ?? "Yes";
}

function choiceNo(options: string[]) {
  return options.find((option) => /^(no|false|decline|do not|don t|dont|not now|skip)$/i.test(option.trim()))
    ?? options.find((option) => option.length <= 60 && /\b(no thanks|no thank you|decline|do not|don t|dont|not now|skip|no)\b/i.test(option))
    ?? "No";
}

function matchOption(value: string, options: string[]) {
  const valueKey = normalizeKey(value);

  if (!valueKey || options.length === 0) {
    return undefined;
  }

  const exact = options.find((option) => normalizeKey(option) === valueKey);

  if (exact) {
    return exact;
  }

  return options.find((option) => {
    const optionKey = normalizeKey(option);

    if (/^(yes|no|true|false|agree|accept|decline)$/.test(valueKey) && optionKey.length > 20) {
      return false;
    }

    return optionKey.includes(valueKey) || valueKey.includes(optionKey);
  });
}

function summarizeAnswerSources(answers: FillV2Answer[]) {
  const counts = answers.reduce<Record<string, number>>((acc, answer) => {
    acc[answer.source] = (acc[answer.source] ?? 0) + 1;
    return acc;
  }, {});

  return `Fill V2 answers: ${Object.entries(counts).map(([source, count]) => `${source}=${count}`).join(", ")}.`;
}
