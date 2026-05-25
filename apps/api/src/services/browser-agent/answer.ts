import { ChatOpenAI } from "@langchain/openai";
import type { FilledField, Job, StudentMemory, StudentProfile } from "@gradlaunch/shared";
import { cityFromLocationLabel, inferCountryFromPhoneNumber, resolveBestProfileLocation } from "../location-resolver";
import type { BrowserFillField, StageAnswerPlan, StageReflectionResult, VisibleField } from "./types";
import { dedupeLabels, jsonBlock, normalizeKey, writeBrowserDebug } from "./util";

type BuildAnswerPlanInput = {
  job: Job;
  visibleFields: VisibleField[];
  baseFields: FilledField[];
  student?: StudentProfile;
  memory?: StudentMemory;
  resumeText?: string;
  workspacePath: string;
  onStatus?: (message: string) => Promise<void>;
};

type AnswerCandidate = {
  label: string;
  value: string;
  fieldId: string;
  inputType: string;
  options: string[];
  required: boolean;
  reason: string;
};

type LangChainJsonInput = {
  prompt: string;
  system: string;
};

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

const stageAnswerPlanCache = new Map<string, StageAnswerPlan>();
const maxStageAnswerPlanCacheEntries = 40;

export async function buildStageAnswerPlan(input: BuildAnswerPlanInput): Promise<StageAnswerPlan> {
  const cacheKey = buildStageAnswerPlanCacheKey(input);
  const cached = stageAnswerPlanCache.get(cacheKey);

  if (cached) {
    await writeBrowserDebug(input.workspacePath, "answer-plan-cache-hit", {
      visibleFieldCount: input.visibleFields.length,
      answerCount: cached.answers.length,
      unresolvedRequiredLabels: cached.unresolvedRequiredLabels
    });
    return cloneStageAnswerPlan(cached);
  }

  const deterministicAnswers = createDeterministicAnswerMap(input.visibleFields, input.baseFields, input.student, input.job, input.memory, input.resumeText);
  const deterministicLabels = [...deterministicAnswers.values()].map((answer) => answer.label);
  const missingRequiredLabels = resolveUnansweredRequiredLabels(input.visibleFields, [...deterministicAnswers.values()]);
  const llmRequestedLabels = input.visibleFields
    .filter((field) => shouldAskLlmForField(field))
    .map((field) => field.label);
  const shouldAskLlm = shouldUseLlm()
    && input.visibleFields.length > 0
    && (
      missingRequiredLabels.length > 0
      || llmRequestedLabels.length > 0
    );
  const langChainContext = {
    enabled: shouldUseLlm(),
    hasProfile: Boolean(input.student),
    hasCompleteProfile: Boolean(input.student?.completeProfile),
    hasResumeText: Boolean(input.resumeText?.trim()),
    preparedFieldCount: input.baseFields.length,
    correctionCount: input.memory?.corrections.length ?? 0,
    visibleFieldLabels: input.visibleFields.map((field) => field.label),
    deterministicLabels,
    missingRequiredLabels
  };

  await writeBrowserDebug(input.workspacePath, "answer-plan-context", langChainContext);

  await input.onStatus?.(
    deterministicAnswers.size > 0
      ? `Using stored/profile answers for: ${deterministicLabels.slice(0, 8).join(", ")}${deterministicLabels.length > 8 ? "..." : ""}.`
      : "No stored/profile answers matched this screen yet."
  );

  if (shouldAskLlm) {
    await input.onStatus?.(
      missingRequiredLabels.length > 0
        ? `Asking LangChain for missing required field(s): ${missingRequiredLabels.join(", ")} using profile=${langChainContext.hasProfile ? "yes" : "no"}, resume=${langChainContext.hasResumeText ? "yes" : "no"}, prepared fields=${langChainContext.preparedFieldCount}.`
        : `Asking LangChain for long-answer field(s): ${llmRequestedLabels.join(", ")} using profile=${langChainContext.hasProfile ? "yes" : "no"}, resume=${langChainContext.hasResumeText ? "yes" : "no"}, prepared fields=${langChainContext.preparedFieldCount}.`
    );
    const llmPlan = await askLlmForStageAnswers(input).catch(async (error) => {
      const message = error instanceof Error ? error.message : "Unknown LangChain error";
      await writeBrowserDebug(input.workspacePath, "langchain-answer-error", {
        message,
        missingRequiredLabels,
        hasProfile: langChainContext.hasProfile,
        hasResumeText: langChainContext.hasResumeText,
        preparedFieldCount: langChainContext.preparedFieldCount
      });
      await input.onStatus?.(`LangChain failed: ${message}. Continuing with stored/profile answers only.`);
      return undefined;
    });

    if (llmPlan) {
      const llmLabels = [...llmPlan.answers.values()].map((answer) => answer.label);

      await input.onStatus?.(
        llmLabels.length > 0
          ? `LangChain returned answers for: ${llmLabels.slice(0, 8).join(", ")}${llmLabels.length > 8 ? "..." : ""}.`
          : "LangChain replied, but did not provide usable answers for the visible fields."
      );

      const answers = normalizeChoiceAnswers(input.visibleFields
        .map((field) => chooseStageAnswer(field, deterministicAnswers.get(field.id), llmPlan.answers.get(field.id)))
        .filter((value): value is NonNullable<typeof value> => Boolean(value)), input);

      const planned = {
        answers,
        unresolvedRequiredLabels: resolveUnansweredRequiredLabels(input.visibleFields, answers),
        usedLlm: llmPlan.answers.size > 0,
        summary: `Profile/prepared answers: ${deterministicAnswers.size}. LangChain answers: ${llmPlan.answers.size}. ${llmPlan.summary ?? ""}`.trim()
      };

      rememberStageAnswerPlan(cacheKey, planned);
      return cloneStageAnswerPlan(planned);
    }

    await input.onStatus?.("LangChain did not return usable answers, so I am continuing with stored/profile answers only.");
  } else if (missingRequiredLabels.length > 0) {
    const reason = shouldUseLlm()
      ? "the missing fields were not selected for LLM fallback"
      : "LangChain is disabled or the API key is not visible to this API process";
    await writeBrowserDebug(input.workspacePath, "langchain-answer-skipped", {
      reason,
      missingRequiredLabels,
      enabled: shouldUseLlm()
    });
    await input.onStatus?.(`Still missing required field(s): ${missingRequiredLabels.join(", ")}. LangChain was not called because ${reason}.`);
  }

  const answers = normalizeChoiceAnswers([...deterministicAnswers.values()], input);

  const planned = {
    answers,
    unresolvedRequiredLabels: resolveUnansweredRequiredLabels(input.visibleFields, answers),
    usedLlm: false,
    summary: deterministicAnswers.size > 0 ? "Using stored GradLaunch profile facts and prepared answers for the visible fields." : undefined
  };

  rememberStageAnswerPlan(cacheKey, planned);
  return cloneStageAnswerPlan(planned);
}

function buildStageAnswerPlanCacheKey(input: BuildAnswerPlanInput) {
  const visibleFieldKey = input.visibleFields
    .map((field) => [
      normalizeKey(field.label),
      normalizeKey(field.inputType),
      field.required ? "required" : "optional",
      normalizeKey(field.context),
      field.options.map((option) => normalizeKey(option)).join("|")
    ].join(":"))
    .join("||");
  const preparedFieldKey = input.baseFields
    .map((field) => `${normalizeKey(field.label)}=${normalizeKey(field.value)}`)
    .sort()
    .join("||");
  const correctionKey = (input.memory?.corrections ?? [])
    .map((correction) => `${normalizeKey(correction.label)}=${normalizeKey(correction.value)}`)
    .sort()
    .join("||");
  const studentKey = [
    input.student?.email,
    input.student?.fullName,
    input.student?.completeProfile?.phone,
    input.student?.completeProfile?.city,
    input.student?.completeProfile?.country,
    input.student?.completeProfile?.linkedInUrl,
    input.student?.completeProfile?.websiteUrl,
    input.student?.completeProfile?.portfolioUrl,
    input.student?.degree,
    input.student?.graduationYear
  ].map((value) => normalizeKey(String(value ?? ""))).join("|");
  const resumeKey = normalizeKey((input.resumeText ?? "").slice(0, 1200));
  const jobKey = `${normalizeKey(input.job.title)}|${normalizeKey(input.job.company)}|${normalizeKey(input.job.location)}`;

  return [visibleFieldKey, preparedFieldKey, correctionKey, studentKey, resumeKey, jobKey].join("###");
}

function rememberStageAnswerPlan(cacheKey: string, plan: StageAnswerPlan) {
  stageAnswerPlanCache.delete(cacheKey);
  stageAnswerPlanCache.set(cacheKey, cloneStageAnswerPlan(plan));

  while (stageAnswerPlanCache.size > maxStageAnswerPlanCacheEntries) {
    const firstKey = stageAnswerPlanCache.keys().next().value;

    if (!firstKey) {
      break;
    }

    stageAnswerPlanCache.delete(firstKey);
  }
}

function cloneStageAnswerPlan(plan: StageAnswerPlan): StageAnswerPlan {
  return {
    ...plan,
    answers: plan.answers.map((answer) => ({
      ...answer,
      options: answer.options ? [...answer.options] : answer.options
    })),
    unresolvedRequiredLabels: [...plan.unresolvedRequiredLabels]
  };
}

function shouldAskLlmForField(field: VisibleField) {
  if (field.inputType === "file") {
    return false;
  }

  const descriptor = normalizeKey(`${field.label} ${field.context} ${field.options.join(" ")}`);

  return ["textarea", "text"].includes(field.inputType)
    && /\b(cover letter|motivation|why|summary|bio|about|describe|explain|additional information|message|comments?)\b/.test(descriptor);
}

function chooseStageAnswer(field: VisibleField, deterministic: AnswerCandidate | undefined, llm: AnswerCandidate | undefined) {
  if (deterministic && shouldPreferDeterministicAnswer(field)) {
    return deterministic;
  }

  if (llm && !shouldRejectAnswerValue(field, llm.value)) {
    return llm;
  }

  return deterministic;
}

function shouldPreferDeterministicAnswer(field: VisibleField) {
  const label = normalizeKey([field.label, field.context, field.options.join(" ")].join(" "));

  return /\b(first name|given name|last name|surname|family name|full name|email|phone|mobile|contact number|salary|ctc|compensation|linkedin|linked in|github|git hub|portfolio|website|personal site|homepage|url|leetcode|kaggle|city|location|country|work authorization|authorized to work|visa|sponsorship)\b/.test(label)
    || field.inputType === "checkbox"
    || field.inputType === "radio"
    || field.inputType === "select"
    || field.inputType === "combobox";
}

function shouldRejectAnswerValue(field: VisibleField, value: string) {
  const label = normalizeKey(field.label);
  const valueKey = normalizeKey(value);

  if (isProfileUrlField(field) && !isAcceptedProfileUrlForField(field, value)) {
    return true;
  }

  const isDateField = field.inputType === "date"
    || (/\b(start date|end date|from date|completion date|graduation date|date of birth|dob)\b/.test(label)
      && !/\b(up to date|keep you up to date)\b/.test(label));

  if (isDateField && !/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(value.trim())) {
    return true;
  }

  if (/\b(degree name|qualification|field of study|major)\b/.test(label) && isSchoolBoardValue(valueKey)) {
    return true;
  }

  if (/\b(university|college|institution)\b/.test(label) && isSchoolBoardValue(valueKey)) {
    return true;
  }

  if (/\b(university|college|school|institution)\b/.test(label) && /\b(b tech|btech|bachelor|computer science|degree)\b/.test(valueKey) && !/\b(university|college|institute|school)\b/.test(valueKey)) {
    return true;
  }

  if (isOptionBackedField(field) && meaningfulOptions(field.options).length > 0) {
    return !findMatchingOption(value, field.options, field);
  }

  return false;
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

  const answers = new Map<string, AnswerCandidate>();

  for (const field of visibleFields) {
    if (field.inputType === "file") {
      continue;
    }

    const fieldKey = normalizeKey(field.label);
    const value = resolveDeterministicFieldValue(field, prepared, student, job, resumeText);

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

function resolveDeterministicFieldValue(
  field: VisibleField,
  prepared: Map<string, string>,
  student: StudentProfile | undefined,
  job: Job,
  resumeText: string | undefined
) {
  const label = normalizeKey(field.label);

  if (/\bmiddle name\b/.test(label)) {
    return prepared.get("middle name") ?? prepared.get("legal middle name");
  }

  if (field.inputType === "tel" || field.inputType === "phone" || /^\+\d{1,4}$/.test(field.label.trim())) {
    return resolveProfilePhone(student) ?? normalizePhoneWithCountryHint(resolvePreparedPhone(prepared), resolveCountryHint(prepared, student, resumeText));
  }

  const profileCompensation = resolveProfileCompensationValue(field, student);

  if (profileCompensation) {
    return profileCompensation;
  }

  const candidates = [
    resolveChoiceFieldValue(field, student),
    resolvePreparedChoiceValue(field, prepared, student, job, resumeText),
    resolveCountryFieldValue(field, prepared, student, job, resumeText),
    resolveAddressFieldValue(field, prepared, student, job, resumeText),
    resolveLocationFieldValue(field, prepared, student, job, resumeText),
    resolveEducationFieldValue(field, prepared, student, resumeText),
    resolveLongAnswerFallback(field, student, job),
    resolveTrustedProfileValue(field, student),
    resolvePreparedValue(field.label, prepared),
    fallbackForVisibleField(field, student, job),
    retrieveProfileAnswer(field, student, job)
  ];

  for (const candidate of candidates) {
    const normalized = normalizeAnswerForField(field, candidate);

    if (normalized && !shouldRejectAnswerValue(field, normalized)) {
      return normalized;
    }
  }

  return undefined;
}

function resolveCountryFieldValue(
  field: VisibleField,
  prepared: Map<string, string>,
  student: StudentProfile | undefined,
  job: Job,
  resumeText: string | undefined
) {
  const label = normalizeKey(`${field.label} ${field.context}`);

  if (!/\bcountry\b/.test(label) || /\bcity\b/.test(label)) {
    return undefined;
  }

  const resolved = resolveBestProfileLocation({
    student,
    job,
    resumeText,
    preparedLocations: getPreparedLocationHints(prepared),
    countryHint: resolveCountryHint(prepared, student, resumeText),
    phone: resolvePreparedPhone(prepared)
  });

  return student?.completeProfile?.country
    ?? prepared.get("country")
    ?? prepared.get("current country")
    ?? prepared.get("location country")
    ?? resolved?.country
    ?? resolveCountryHint(prepared, student, resumeText)
    ?? "India";
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

function resolveProfileCompensationValue(field: VisibleField, student: StudentProfile | undefined) {
  if (!student) {
    return undefined;
  }

  const label = normalizeKey(`${field.label} ${field.context} ${field.options.join(" ")}`);

  if (!/\b(ctc|salary|compensation|package|pay)\b/.test(label)) {
    return undefined;
  }

  if (/\b(expected|expectation|desired|target|asking|minimum)\b/.test(label)) {
    return formatSalaryForVisibleField(field, student.expectedSalaryLpa);
  }

  if (/\b(current|present|existing|last|previous|annual)\b/.test(label)) {
    return formatSalaryForVisibleField(field, student.completeProfile?.currentSalaryLpa);
  }

  return undefined;
}

function formatSalaryForVisibleField(field: VisibleField, value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const descriptor = normalizeKey(`${field.label} ${field.context}`);

  if (field.inputType === "number" || /\b(lpa|ctc|lakhs?|lakh per annum)\b/.test(descriptor)) {
    return String(value);
  }

  return `${value} LPA`;
}

function resolveTrustedProfileValue(field: VisibleField, student: StudentProfile | undefined) {
  if (!student) {
    return undefined;
  }

  const details = student.completeProfile;
  const label = normalizeKey([field.label, field.context, field.options.join(" ")].join(" "));

  if (isOptionBackedField(field)) {
    return undefined;
  }

  if (/\b(email|email address)\b/.test(label)) {
    return student.email;
  }

  if (/\b(phone|mobile|contact number)\b/.test(label)) {
    return resolveProfilePhone(student);
  }

  const profileCompensation = resolveProfileCompensationValue(field, student);

  if (profileCompensation) {
    return profileCompensation;
  }

  if (/\b(first name|given name)\b/.test(label)) {
    return student.fullName.trim().split(/\s+/).filter(Boolean)[0];
  }

  if (/\b(last name|surname|family name)\b/.test(label)) {
    const parts = student.fullName.trim().split(/\s+/).filter(Boolean);
    return parts.length > 1 ? parts.slice(1).join(" ") : undefined;
  }

  if (/\b(full name|legal name|candidate name)\b/.test(label) || label === "name") {
    return student.fullName;
  }

  if (!isProfileUrlField(field)) {
    return undefined;
  }

  const candidates = getTrustedProfileUrlCandidates(label, details);

  for (const candidate of candidates) {
    const normalized = normalizeProfileUrl(candidate);

    if (normalized && isAcceptedProfileUrlForField(field, normalized)) {
      return normalized;
    }
  }

  return undefined;
}

function resolveLongAnswerFallback(field: VisibleField, student: StudentProfile | undefined, job: Job) {
  const descriptor = normalizeKey(`${field.label} ${field.context}`);

  if (!["textarea", "text"].includes(field.inputType) || !/\b(cover letter|motivation|message|hiring team|additional information|why)\b/.test(descriptor)) {
    return undefined;
  }

  const role = student?.targetRoles[0] ?? job.title;
  const skills = student?.skills.slice(0, 6).join(", ");
  const education = [student?.degree, student?.graduationYear ? `Class of ${student.graduationYear}` : undefined]
    .filter(Boolean)
    .join(", ");
  const profileLine = [
    education ? `I am a ${education}` : undefined,
    skills ? `with hands-on experience in ${skills}` : undefined
  ].filter(Boolean).join(" ");
  const bio = student?.bio?.trim();

  return [
    `I am excited to apply for the ${job.title} role at ${job.company}.`,
    bio || profileLine || `My background is aligned with ${role} roles, and I am eager to contribute to the team.`,
    "I would welcome the opportunity to bring strong ownership, learning agility, and practical engineering skills to this position."
  ].join(" ");
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

function resolveChoiceFieldValue(field: VisibleField, student: StudentProfile | undefined) {
  const descriptor = normalizeKey(`${field.label} ${field.context} ${field.options.join(" ")}`);

  if (!isOptionBackedField(field)) {
    return undefined;
  }

  if (/\b(preferred name|different from your legal name|select yes below otherwise please select no)\b/.test(descriptor)) {
    return findNegativeChoiceOption(field.options) ?? "No";
  }

  if (/\b(talent network|career opportunities|upcoming events|job alerts|recruiting updates|keep you up to date|marketing updates)\b/.test(descriptor)) {
    return findNegativeChoiceOption(field.options) ?? "No";
  }

  if (/\b(past working experience|prior work experience|work experience|employment experience|professional experience)\b/.test(descriptor)) {
    const hasWorkHistory = Boolean(
      student?.completeProfile?.currentCompany
      || student?.completeProfile?.currentTitle
      || (student?.completeProfile?.totalExperienceYears ?? 0) > 0
      || (student?.completeProfile?.employmentHistory?.length ?? 0) > 0
    );

    return hasWorkHistory
      ? findAffirmativeChoiceOption(field.options) ?? "Yes"
      : findNegativeChoiceOption(field.options) ?? "No";
  }

  if (/\b(china|south korea|korea)\b/.test(descriptor) && /\b(resident|residence|currently reside|citizen|national)\b/.test(descriptor)) {
    return findNegativeChoiceOption(field.options) ?? "No";
  }

  if (/\b(privacy|terms|consent|agree|acknowledge|accept|declaration|data processing|read and understand)\b/.test(descriptor)
    && !/\b(talent network|career opportunities|upcoming events|job alerts|marketing|whatsapp|sms|text messages)\b/.test(descriptor)) {
    return findAffirmativeChoiceOption(field.options) ?? "Yes";
  }

  return undefined;
}

function resolveAddressFieldValue(
  field: VisibleField,
  prepared: Map<string, string>,
  student: StudentProfile | undefined,
  job: Job,
  resumeText: string | undefined
) {
  const label = normalizeKey(`${field.label} ${field.context}`);
  const details = student?.completeProfile;
  const preparedPrimaryLocation = prepared.get("location")
    ?? prepared.get("location city")
    ?? prepared.get("current location")
    ?? prepared.get("preferred location")
    ?? prepared.get("city");
  const resolved = resolveBestProfileLocation({
    student,
    job,
    resumeText,
    proposedLocation: preparedPrimaryLocation,
    preparedLocations: getPreparedLocationHints(prepared),
    countryHint: resolveCountryHint(prepared, student, resumeText),
    phone: resolvePreparedPhone(prepared)
  });

  if (/\b(address line 1|street address|address 1|address)\b/.test(label) && !/\b(address line 2|address 2)\b/.test(label)) {
    return details?.addressLine1
      ?? prepared.get("address line 1")
      ?? prepared.get("street address")
      ?? resolved?.label
      ?? prepared.get("location");
  }

  if (/\b(address line 2|address 2|apartment|suite)\b/.test(label)) {
    return details?.addressLine2
      ?? prepared.get("address line 2")
      ?? resolved?.region
      ?? prepared.get("state")
      ?? prepared.get("province");
  }

  if (/\b(state|province|region)\b/.test(label)) {
    return details?.state
      ?? prepared.get("state")
      ?? prepared.get("province")
      ?? resolved?.region;
  }

  if (/\b(zip|postal|postcode|pin code|pincode)\b/.test(label)) {
    return details?.postalCode
      ?? prepared.get("postal code")
      ?? prepared.get("zip code")
      ?? extractPostalCode(resumeText);
  }

  return undefined;
}

function resolveEducationFieldValue(
  field: VisibleField,
  prepared: Map<string, string>,
  student: StudentProfile | undefined,
  resumeText: string | undefined
) {
  const label = normalizeKey(field.label);
  const education = student?.completeProfile?.educationHistory?.[0];
  const graduationYear = student?.graduationYear ?? education?.endYear;

  if (/\b(type of degree|degree type|level of education|education level)\b/.test(label)) {
    return degreeTypeFromValue(student?.degree ?? education?.degree ?? prepared.get("degree"), field.options);
  }

  if (/\b(degree name|degree|qualification)\b/.test(label) && !/\b(type of degree|degree type)\b/.test(label)) {
    return cleanEducationDegreeName(education?.fieldOfStudy)
      ?? cleanEducationDegreeName(education?.degree)
      ?? cleanEducationDegreeName(prepared.get("degree"))
      ?? cleanEducationDegreeName(student?.degree);
  }

  if (/\b(university|college|school|institution)\b/.test(label)) {
    return chooseHigherEducationInstitution([
      education?.school,
      prepared.get("university"),
      prepared.get("college"),
      prepared.get("school"),
      extractUniversityFromResume(resumeText)
    ]);
  }

  if (/\b(start date|start year|from date|begin date|education start)\b/.test(label)) {
    const startYear = education?.startYear ?? (graduationYear ? graduationYear - 4 : undefined);
    return formatEducationDate(startYear, "start");
  }

  if (/\b(end date|end year|completion date|graduation date|education end)\b/.test(label)) {
    return formatEducationDate(education?.endYear ?? graduationYear, "end");
  }

  return undefined;
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
  const preparedPrimaryLocation = proposedValue
    ?? prepared.get("location")
    ?? prepared.get("location city")
    ?? prepared.get("current location")
    ?? prepared.get("preferred location")
    ?? prepared.get("city");
  const resolved = resolveBestProfileLocation({
    student,
    job,
    resumeText,
    proposedLocation: preparedPrimaryLocation,
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

      if ((inputType === "checkbox" || inputType === "radio") && isStandaloneChoiceOptionLabel(answer.label) && !choiceValueMatchesOption(answer.value, [answer.label])) {
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

function isStandaloneChoiceOptionLabel(value: string) {
  return /^(yes|no|no thanks|no thank you|yes please|i agree|agree|accept|decline|not now|skip|continue)$/i.test(value.trim());
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
  const descriptor = normalizeKey(`${field.label} ${field.context} ${field.options.join(" ")}`);

  if (
    (field.inputType === "checkbox" || field.inputType === "radio")
    && /\b(privacy|terms|consent|agree|acknowledge|accept|declaration|data processing|read and understand)\b/.test(descriptor)
    && !/\b(talent network|career opportunities|upcoming events|job alerts|marketing|whatsapp|sms|text messages)\b/.test(descriptor)
  ) {
    return findAffirmativeChoiceOption(field.options) ?? field.label;
  }

  if (
    isOptionBackedField(field)
    && /\b(talent network|career opportunities|upcoming events|job alerts|recruiting updates|keep you up to date|marketing updates)\b/.test(descriptor)
  ) {
    return findNegativeChoiceOption(field.options) ?? "No";
  }

  if (
    isOptionBackedField(field)
    && /\b(preferred name|different from your legal name|select yes below otherwise please select no)\b/.test(descriptor)
  ) {
    return findNegativeChoiceOption(field.options) ?? "No";
  }

  if (isOptionBackedField(field) && /\b(past working experience|prior work experience|work experience|employment experience|professional experience)\b/.test(descriptor)) {
    const hasWorkHistory = Boolean(
      student?.completeProfile?.currentCompany
      || student?.completeProfile?.currentTitle
      || (student?.completeProfile?.totalExperienceYears ?? 0) > 0
      || (student?.completeProfile?.employmentHistory?.length ?? 0) > 0
    );

    return hasWorkHistory
      ? findAffirmativeChoiceOption(field.options) ?? "Yes"
      : findNegativeChoiceOption(field.options) ?? "No";
  }

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

function findNegativeChoiceOption(options: string[]) {
  return options.find((option) => /\b(no thanks|no thank you|decline|do not|don t|dont|not now|skip)\b/i.test(option))
    ?? options.find((option) => /^no\b/i.test(option));
}

function findAffirmativeChoiceOption(options: string[]) {
  return options.find((option) => /\b(i agree|agree|accept|acknowledge|confirm|yes)\b/i.test(option))
    ?? options.find((option) => /^yes\b/i.test(option));
}

function choiceValueMatchesOption(value: string, options: string[]) {
  return Boolean(findMatchingOption(value, options));
}

function normalizeAnswerForField(field: VisibleField, value: string | undefined) {
  const cleanValue = value?.trim();

  if (!cleanValue) {
    return undefined;
  }

  const matchedOption = findMatchingOption(cleanValue, field.options, field);

  if (matchedOption) {
    return matchedOption;
  }

  return cleanValue;
}

function isOptionBackedField(field: VisibleField) {
  return field.inputType === "radio"
    || field.inputType === "checkbox"
    || field.inputType === "select"
    || field.inputType === "combobox";
}

function meaningfulOptions(options: string[]) {
  return options
    .map((option) => option.trim())
    .filter((option) => {
      const normalized = normalizeKey(option);
      return Boolean(normalized) && !/^(select|select an option|choose|choose one|please select|none selected|not selected)$/.test(normalized);
    });
}

function findMatchingOption(value: string, options: string[], field?: VisibleField) {
  const normalizedValue = normalizeKey(value);
  const normalizedLabel = normalizeKey(`${field?.label ?? ""} ${field?.context ?? ""}`);
  const candidates = meaningfulOptions(options);

  if (!normalizedValue || candidates.length === 0) {
    return undefined;
  }

  const direct = candidates.find((option) => {
    const normalizedOption = normalizeKey(option);

    if (!normalizedOption) {
      return false;
    }

    return normalizedOption === normalizedValue
      || normalizedOption.includes(normalizedValue)
      || normalizedValue.includes(normalizedOption);
  });

  if (direct) {
    return direct;
  }

  if (/^(yes|true|agree|accept|consent|confirm|i agree)$/.test(normalizedValue)) {
    return findAffirmativeChoiceOption(candidates);
  }

  if (/^(no|false|decline|do not|don t|dont|not now|no thanks)$/.test(normalizedValue)) {
    return findNegativeChoiceOption(candidates);
  }

  if (/\b(type of degree|degree type|education level|level of education)\b/.test(normalizedLabel)) {
    return degreeTypeFromValue(value, candidates);
  }

  if (/\bcountry\b/.test(normalizedLabel) || isCountryOptionLabel(value)) {
    const normalizedCountry = normalizeCountryAnswer(value);
    const countryKey = normalizeKey(normalizedCountry);
    return candidates.find((option) => {
      const optionKey = normalizeKey(option);
      return optionKey === countryKey || (countryKey === "india" && optionKey === "in");
    });
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

function resolveProfilePhone(student: StudentProfile | undefined) {
  const details = student?.completeProfile;

  return normalizePhoneWithCountryHint(details?.phone, details?.country ?? details?.nationality);
}

function normalizePhoneWithCountryHint(value: string | undefined, countryHint: string | undefined) {
  const cleanValue = value?.trim();

  if (!cleanValue) {
    return undefined;
  }

  const compact = cleanValue.replace(/\s+/g, " ");

  if (/^\+/.test(compact)) {
    return compact;
  }

  const digits = compact.replace(/\D+/g, "");
  const dialCode = inferDialCodeFromCountryHint(countryHint) ?? inferDefaultDialCodeForLocalPhone(digits);

  if (dialCode && digits.length >= 7 && digits.length <= 10) {
    return `${dialCode}-${digits}`;
  }

  return compact;
}

function inferDialCodeFromCountryHint(value: string | undefined) {
  const normalized = normalizeKey(value ?? "");

  if (!normalized) {
    return undefined;
  }

  if (/\bindia|indian\b/.test(normalized)) {
    return "+91";
  }

  if (/\bunited states|usa|us|canada\b/.test(normalized)) {
    return "+1";
  }

  if (/\bunited kingdom|uk|britain|england\b/.test(normalized)) {
    return "+44";
  }

  if (/\baustralia\b/.test(normalized)) {
    return "+61";
  }

  return undefined;
}

function inferDefaultDialCodeForLocalPhone(digits: string) {
  return digits.length === 10 ? "+91" : undefined;
}

function degreeTypeFromValue(value: string | undefined, options: string[] = []) {
  const normalized = normalizeKey(value ?? "");
  const candidates = meaningfulOptions(options);

  if (!normalized) {
    return undefined;
  }

  const degreeKind =
    /\b(b tech|btech|b e|be|bachelor|undergraduate|ug)\b/.test(normalized)
      ? "bachelor"
      : /\b(m tech|mtech|m e|me|master|postgraduate|pg|mca|msc)\b/.test(normalized)
        ? "master"
        : /\b(phd|ph d|doctorate|doctoral)\b/.test(normalized)
          ? "doctor"
          : undefined;

  if (!degreeKind) {
    return value?.trim();
  }

  const matched = candidates.find((option) => {
    const optionKey = normalizeKey(option);

    if (degreeKind === "bachelor") {
      return /\b(bachelor|bachelors|undergraduate|ug|b tech|btech|b e|be)\b/.test(optionKey);
    }

    if (degreeKind === "master") {
      return /\b(master|masters|postgraduate|pg|m tech|mtech|m e|me|mca|msc)\b/.test(optionKey);
    }

    return /\b(phd|ph d|doctor|doctorate|doctoral)\b/.test(optionKey);
  });

  if (matched) {
    return matched;
  }

  return degreeKind === "bachelor" ? "Bachelor's Degree" : degreeKind === "master" ? "Master's Degree" : "Doctorate";
}

function formatEducationDate(year: number | undefined, kind: "start" | "end") {
  if (!year || !Number.isFinite(year)) {
    return undefined;
  }

  const month = kind === "start" ? "08" : "05";
  return `${year}-${month}-01`;
}

function extractPostalCode(text: string | undefined) {
  const match = text?.match(/\b\d{6}\b|\b\d{5}(?:-\d{4})?\b/);
  return match?.[0];
}

function extractUniversityFromResume(text: string | undefined) {
  const lines = (text ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const match = lines
    .filter((line) => /\b(university|college|institute|school|nit|iit|iiit)\b/i.test(line) && line.length <= 140)
    .map((line) => ({
      line,
      score: scoreEducationInstitutionLine(line)
    }))
    .sort((left, right) => right.score - left.score)[0]?.line;

  if (!match) {
    return undefined;
  }

  return match.replace(/\s+[|•-]\s+.*$/g, "").trim();
}

function chooseHigherEducationInstitution(values: Array<string | undefined>) {
  const candidates = values
    .map((value) => value?.replace(/\s+/g, " ").trim())
    .filter((value): value is string => Boolean(value));

  return candidates
    .map((value) => ({
      value,
      score: scoreEducationInstitutionLine(value)
    }))
    .sort((left, right) => right.score - left.score)[0]?.value;
}

function cleanEducationDegreeName(value: string | undefined) {
  const cleanValue = value?.replace(/\s+/g, " ").trim();

  if (!cleanValue || isSchoolBoardValue(normalizeKey(cleanValue))) {
    return undefined;
  }

  const normalized = normalizeKey(cleanValue);

  if (/\b(computer science|computer engineering|information technology|electronics|mechanical|civil|electrical|data science|software engineering)\b/.test(normalized)) {
    return cleanValue
      .replace(/\bbachelor(?:'s)?(?: degree)?\s+(?:of|in)?\s*/i, "")
      .replace(/\bb\.?\s*tech\s+(?:in)?\s*/i, "")
      .trim() || cleanValue;
  }

  return cleanValue;
}

function isSchoolBoardValue(valueKey: string) {
  return /\b(cbse|icse|isc|state board|senior secondary|higher secondary|secondary school|high school|intermediate|public school|12th|10th|xii|x)\b/.test(valueKey);
}

function scoreEducationInstitutionLine(value: string) {
  const normalized = normalizeKey(value);
  let score = 0;

  if (/\b(national institute of technology|indian institute of technology|indian institute of information technology|nit|iit|iiit)\b/.test(normalized)) {
    score += 120;
  }

  if (/\b(university|college|institute|institution)\b/.test(normalized)) {
    score += 80;
  }

  if (/\b(b tech|btech|bachelor|computer science|engineering)\b/.test(normalized)) {
    score += 25;
  }

  if (isSchoolBoardValue(normalized)) {
    score -= 90;
  }

  if (/\bschool\b/.test(normalized) && !/\b(school of engineering|school of technology|business school)\b/.test(normalized)) {
    score -= 55;
  }

  return score;
}

function resolvePreparedValue(label: string, prepared: Map<string, string>) {
  const normalizedLabel = normalizeKey(label);

  if (isProfileUrlLabel(normalizedLabel)) {
    return resolvePreparedProfileUrlValue(normalizedLabel, prepared);
  }

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

function resolvePreparedProfileUrlValue(normalizedLabel: string, prepared: Map<string, string>) {
  const candidates = getPreparedProfileUrlCandidates(normalizedLabel, prepared);

  for (const candidate of candidates) {
    const normalized = normalizeProfileUrl(candidate);

    if (normalized && isAcceptedProfileUrlForLabel(normalizedLabel, normalized)) {
      return normalized;
    }
  }

  return undefined;
}

function isProfileUrlField(field: VisibleField) {
  return isProfileUrlLabel(normalizeKey([field.label, field.context, field.options.join(" ")].join(" ")));
}

function isProfileUrlLabel(normalizedLabel: string) {
  return /\b(linkedin|linked in|github|git hub|portfolio|website|web site|personal site|homepage|profile url|profile link|url|leetcode|kaggle)\b/.test(normalizedLabel);
}

function getTrustedProfileUrlCandidates(
  normalizedLabel: string,
  details: StudentProfile["completeProfile"] | undefined
) {
  if (!details) {
    return [];
  }

  if (/\b(linkedin|linked in)\b/.test(normalizedLabel)) {
    return [details.linkedInUrl];
  }

  if (/\b(github|git hub)\b/.test(normalizedLabel)) {
    return [details.githubUrl];
  }

  if (/\bleetcode\b/.test(normalizedLabel)) {
    return [details.leetcodeUrl];
  }

  if (/\bkaggle\b/.test(normalizedLabel)) {
    return [details.kaggleUrl];
  }

  if (/\b(portfolio|personal site|homepage)\b/.test(normalizedLabel)) {
    return [details.portfolioUrl, details.websiteUrl, details.githubUrl];
  }

  return [details.websiteUrl, details.portfolioUrl, details.githubUrl];
}

function getPreparedProfileUrlCandidates(normalizedLabel: string, prepared: Map<string, string>) {
  if (/\b(linkedin|linked in)\b/.test(normalizedLabel)) {
    return [
      prepared.get("linkedin"),
      prepared.get("linkedin url"),
      prepared.get("linkedin profile"),
      prepared.get("linked in")
    ];
  }

  if (/\b(github|git hub)\b/.test(normalizedLabel)) {
    return [
      prepared.get("github"),
      prepared.get("github url"),
      prepared.get("github profile"),
      prepared.get("git hub")
    ];
  }

  if (/\bleetcode\b/.test(normalizedLabel)) {
    return [prepared.get("leetcode"), prepared.get("leetcode url"), prepared.get("leetcode profile")];
  }

  if (/\bkaggle\b/.test(normalizedLabel)) {
    return [prepared.get("kaggle"), prepared.get("kaggle url"), prepared.get("kaggle profile")];
  }

  if (/\b(portfolio|personal site|homepage)\b/.test(normalizedLabel)) {
    return [
      prepared.get("portfolio"),
      prepared.get("portfolio url"),
      prepared.get("personal portfolio"),
      prepared.get("website"),
      prepared.get("website url"),
      prepared.get("personal website"),
      prepared.get("github"),
      prepared.get("github url")
    ];
  }

  return [
    prepared.get("website"),
    prepared.get("website url"),
    prepared.get("personal website"),
    prepared.get("portfolio"),
    prepared.get("portfolio url"),
    prepared.get("github"),
    prepared.get("github url")
  ];
}

function isAcceptedProfileUrlForField(field: VisibleField, value: string) {
  return isAcceptedProfileUrlForLabel(normalizeKey([field.label, field.context, field.options.join(" ")].join(" ")), value);
}

function isAcceptedProfileUrlForLabel(normalizedLabel: string, value: string) {
  const url = parseProfileUrl(value);

  if (!url) {
    return false;
  }

  if (/\b(linkedin|linked in)\b/.test(normalizedLabel)) {
    return isLinkedInProfileUrl(url);
  }

  if (/\b(github|git hub)\b/.test(normalizedLabel)) {
    return isGitHubProfileUrl(url);
  }

  if (/\bleetcode\b/.test(normalizedLabel)) {
    return isSpecificPlatformProfileUrl(url, "leetcode.com");
  }

  if (/\bkaggle\b/.test(normalizedLabel)) {
    return isSpecificPlatformProfileUrl(url, "kaggle.com");
  }

  return hasMeaningfulProfileUrlTarget(url);
}

function normalizeProfileUrl(value: string | undefined) {
  const url = parseProfileUrl(value);

  if (!url) {
    return undefined;
  }

  const path = url.pathname.replace(/\/+$/g, "");
  return `${url.protocol}//${url.host}${path}${url.search}${url.hash}`;
}

function parseProfileUrl(value: string | undefined) {
  const cleanValue = value?.trim().replace(/[),.;]+$/g, "");

  if (!cleanValue || !/[a-z0-9.-]+\.[a-z]{2,}/i.test(cleanValue)) {
    return undefined;
  }

  try {
    return new URL(/^https?:\/\//i.test(cleanValue) ? cleanValue : `https://${cleanValue}`);
  } catch (_error) {
    return undefined;
  }
}

function hasMeaningfulProfileUrlTarget(url: URL) {
  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  const pathParts = getUrlPathParts(url);

  if (host === "github.com") {
    return isGitHubProfileUrl(url);
  }

  if (host === "linkedin.com") {
    return isLinkedInProfileUrl(url);
  }

  if (host === "leetcode.com") {
    return isSpecificPlatformProfileUrl(url, "leetcode.com");
  }

  if (host === "kaggle.com") {
    return isSpecificPlatformProfileUrl(url, "kaggle.com");
  }

  return Boolean(pathParts.length > 0 || url.hostname.split(".").length > 2);
}

function isLinkedInProfileUrl(url: URL) {
  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  const pathParts = getUrlPathParts(url);

  if (host !== "linkedin.com") {
    return false;
  }

  if (pathParts[0] === "in" || pathParts[0] === "pub") {
    return Boolean(pathParts[1]);
  }

  return pathParts.length > 1 && !["feed", "login", "jobs", "company", "school"].includes(pathParts[0] ?? "");
}

function isGitHubProfileUrl(url: URL) {
  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  const pathParts = getUrlPathParts(url);

  if (host !== "github.com") {
    return false;
  }

  return Boolean(pathParts[0]) && !["about", "blog", "collections", "enterprise", "events", "explore", "features", "login", "marketplace", "new", "pricing", "search", "signup", "topics"].includes(pathParts[0]);
}

function isSpecificPlatformProfileUrl(url: URL, expectedHost: string) {
  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  return host === expectedHost && getUrlPathParts(url).length > 0;
}

function getUrlPathParts(url: URL) {
  return url.pathname.split("/").map((part) => part.trim()).filter(Boolean);
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

  if (normalizedLabel.includes("linkedin") || normalizedLabel.includes("linked in")) {
    aliases.add("LinkedIn");
    aliases.add("LinkedIn URL");
    aliases.add("LinkedIn profile");
  }

  if (normalizedLabel.includes("github") || normalizedLabel.includes("git hub")) {
    aliases.add("GitHub");
    aliases.add("GitHub URL");
    aliases.add("GitHub profile");
  }

  if (normalizedLabel.includes("portfolio")) {
    aliases.add("Portfolio");
    aliases.add("Portfolio URL");
    aliases.add("Personal portfolio");
  }

  if (normalizedLabel.includes("website") || normalizedLabel.includes("web site") || normalizedLabel.includes("personal site") || normalizedLabel.includes("homepage")) {
    aliases.add("Website");
    aliases.add("Website URL");
    aliases.add("Personal website");
    aliases.add("Portfolio");
  }

  if (normalizedLabel.includes("leetcode")) {
    aliases.add("LeetCode");
    aliases.add("LeetCode URL");
    aliases.add("LeetCode profile");
  }

  if (normalizedLabel.includes("kaggle")) {
    aliases.add("Kaggle");
    aliases.add("Kaggle URL");
    aliases.add("Kaggle profile");
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

  if (normalizedLabel.includes("cover letter") || normalizedLabel.includes("hiring team") || normalizedLabel.includes("message")) {
    aliases.add("Cover Letter");
    aliases.add("Cover letter");
    aliases.add("Message to the Hiring Team");
    aliases.add("Message");
    aliases.add("Additional information");
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
    "For every visible long-answer field such as cover letter, motivation, why, summary, bio, message to hiring team, comments, or additional information, return a field-specific answer.",
    "Do not reuse the exact same paragraph across different long-answer fields. Tailor each answer to the field label, job title, company, and available student skills/projects.",
    "For Message to the Hiring Team, write 2-4 concise sentences. For cover letter fields, write 4-6 concise sentences.",
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
      ?? (candidate.label ? visibleByLabel.get(normalizeKey(candidate.label)) : undefined)
      ?? bestVisibleFieldForLlmCandidate(candidate, input.visibleFields);
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

function bestVisibleFieldForLlmCandidate(
  candidate: { label?: string; value?: string },
  visibleFields: VisibleField[]
) {
  const candidateLabel = normalizeKey(candidate.label ?? "");

  if (!candidateLabel) {
    return undefined;
  }

  let best: VisibleField | undefined;
  let bestScore = 0;

  for (const field of visibleFields) {
    if (field.inputType === "file") {
      continue;
    }

    const fieldLabel = normalizeKey(`${field.label} ${field.context}`);
    let score = tokenOverlapScore(candidateLabel, fieldLabel);

    if (fieldLabel.includes(candidateLabel) || candidateLabel.includes(normalizeKey(field.label))) {
      score += 60;
    }

    if (shouldAskLlmForField(field) && /\b(cover letter|motivation|why|summary|bio|about|describe|explain|additional information|message|comments?|hiring team)\b/.test(candidateLabel)) {
      score += 35;
    }

    if (score > bestScore) {
      best = field;
      bestScore = score;
    }
  }

  return bestScore >= 45 ? best : undefined;
}

function tokenOverlapScore(left: string, right: string) {
  const leftTokens = semanticAnswerTokens(left);
  const rightTokens = semanticAnswerTokens(right);

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let overlap = 0;

  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }

  return Math.round((overlap / Math.max(1, new Set([...leftTokens, ...rightTokens]).size)) * 100);
}

function semanticAnswerTokens(value: string) {
  return new Set(
    normalizeKey(value)
      .split(" ")
      .filter((token) => token.length > 1 && !/^(the|your|field|required|answer|question|please|enter|provide|write|to|for|a|an)$/.test(token))
  );
}

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

  const content = await callReflectionOpenAiCompatible(prompt);
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

async function callOpenAiCompatible(prompt: string) {
  const content = await callLangChainJson({
    prompt,
    system: [
      "You generate safe, personalized answers for job application forms using only the provided context.",
      "Use the resume excerpt and stored profile to write polished but concise answers for summary, bio, motivation, achievements, project, and experience fields.",
      "When a field asks for a short paragraph, tailor it to the job without inventing facts."
    ].join(" ")
  });

  if (!content) {
    throw new Error("LangChain response did not include content.");
  }

  return content;
}

function shouldUseLlm() {
  return isLangChainAnswerEnabled();
}

export async function callLangChainJson(input: LangChainJsonInput) {
  const baseURL = getOpenAiCompatibleBaseUrl();
  const model = new ChatOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL ?? process.env.LLM_MODEL ?? "gpt-4o-mini",
    temperature: Number(process.env.LLM_TEMPERATURE ?? 0.35),
    configuration: baseURL
      ? { baseURL }
      : undefined,
    maxRetries: Number(process.env.LANGCHAIN_MAX_RETRIES ?? 1),
    timeout: Number(process.env.LANGCHAIN_TIMEOUT_MS ?? 30_000)
  });
  const jsonModel = model.withConfig({
    response_format: { type: "json_object" }
  });
  const messages: Array<["system" | "human", string]> = [
    ["system", input.system],
    ["human", input.prompt]
  ];
  const response = await jsonModel.invoke(messages).catch(async (error) => {
    if (isJsonModeError(error)) {
      return model.invoke(messages);
    }

    throw error;
  });

  return messageContentToString(response.content);
}

export function isLangChainAnswerEnabled() {
  return process.env.LLM_ANSWER_ENABLED !== "false"
    && Boolean(process.env.OPENAI_API_KEY);
}

export function retrieveProfileAnswer(field: VisibleField, student: StudentProfile | undefined, job: Job) {
  if (!student) {
    return undefined;
  }

  const query = normalizeKey([field.label, field.context, field.options.join(" ")].join(" "));
  const entries = buildProfileKnowledgeEntries(student, job);
  let best: { score: number; value: string } | undefined;

  for (const entry of entries) {
    const score = scoreKnowledgeMatch(query, entry.terms);

    if (!best || score > best.score) {
      best = { score, value: coerceToFieldValue(entry.value, field) };
    }
  }

  return best && best.score >= 18 ? best.value : undefined;
}

export function createStudentProfileSummary(student: StudentProfile | undefined) {
  if (!student) {
    return undefined;
  }

  return {
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
    bio: student.bio,
    completeProfile: student.completeProfile
  };
}

type ProfileKnowledgeEntry = {
  value: string;
  terms: string[];
};

function buildProfileKnowledgeEntries(student: StudentProfile, job: Job): ProfileKnowledgeEntry[] {
  const details = student.completeProfile;
  const entries: ProfileKnowledgeEntry[] = [];
  const primaryEducation = details?.educationHistory[0];
  const currentEmployment = details?.employmentHistory.find((item) => item.current) ?? details?.employmentHistory[0];
  const primaryProject = details?.projectHistory[0];
  const workAuthCountries = details?.workAuthorizationCountries.join(", ");
  const achievements = details?.achievements.join(", ");
  const certifications = details?.certifications.join(", ");
  const languages = details?.languages.join(", ");

  pushKnowledge(entries, student.fullName, ["full name", "legal name", "name", "candidate name"]);
  pushKnowledge(entries, details?.headline ?? student.targetRoles[0], ["headline", "professional headline", "title", "profile headline"]);
  pushKnowledge(entries, student.email, ["email", "email address", "primary email"]);
  pushKnowledge(entries, details?.alternateEmail, ["alternate email", "secondary email"]);
  pushKnowledge(entries, details?.phone, ["phone", "mobile", "mobile number", "phone number", "contact number"]);
  pushKnowledge(entries, details?.linkedInUrl, ["linkedin", "linkedin url", "linkedin profile"]);
  pushKnowledge(entries, details?.githubUrl, ["github", "github url", "github profile"]);
  pushKnowledge(entries, details?.portfolioUrl, ["portfolio", "portfolio url", "personal portfolio"]);
  pushKnowledge(entries, details?.websiteUrl, ["website", "personal website"]);
  pushKnowledge(entries, details?.leetcodeUrl, ["leetcode", "leetcode profile"]);
  pushKnowledge(entries, details?.kaggleUrl, ["kaggle", "kaggle profile"]);
  pushKnowledge(entries, [details?.addressLine1, details?.addressLine2].filter(Boolean).join(", "), ["address", "street address", "address line"]);
  pushKnowledge(entries, details?.city ?? student.preferredLocations[0], ["city", "current city", "location city", "location", "current location"]);
  pushKnowledge(entries, details?.state, ["state", "province", "region"]);
  pushKnowledge(entries, details?.country, ["country", "current country", "location country", "country where you currently reside", "currently reside"]);
  pushKnowledge(entries, details?.postalCode, ["postal code", "zip code", "pincode"]);
  pushKnowledge(entries, student.degree, ["degree", "highest degree", "education degree"]);
  pushKnowledge(entries, primaryEducation?.school, ["college", "university", "school", "institution", "most recent school you attended", "recent school"]);
  pushKnowledge(entries, primaryEducation?.fieldOfStudy, ["field of study", "major", "specialization", "branch"]);
  pushKnowledge(entries, primaryEducation?.grade, ["grade", "cgpa", "gpa", "percentage"]);
  pushKnowledge(entries, student.graduationYear ? String(student.graduationYear) : undefined, ["graduation year", "passing year", "year of graduation"]);
  pushKnowledge(entries, currentEmployment?.company ?? details?.currentCompany, ["current company", "company", "current organization", "employer", "current employer", "previous employer", "current or previous employer", "most recent employer"]);
  pushKnowledge(entries, currentEmployment?.title ?? details?.currentTitle, ["current title", "designation", "job title", "current designation", "current or previous job title", "previous job title", "most recent job title"]);
  pushKnowledge(entries, details?.totalExperienceYears !== undefined ? String(details.totalExperienceYears) : undefined, ["years of experience", "experience", "total experience"]);
  pushKnowledge(entries, details?.noticePeriodDays !== undefined ? String(details.noticePeriodDays) : undefined, ["notice period", "notice period days", "joining period"]);
  pushKnowledge(entries, details?.currentSalaryLpa !== undefined ? String(details.currentSalaryLpa) : undefined, ["current ctc", "current salary", "present ctc", "current compensation"]);
  pushKnowledge(entries, student.expectedSalaryLpa !== undefined ? String(student.expectedSalaryLpa) : undefined, ["expected ctc", "expected salary", "salary expectation", "expected compensation"]);
  pushKnowledge(entries, details?.nationality, ["nationality", "citizenship"]);
  pushKnowledge(entries, details?.pronouns, ["pronouns"]);
  pushKnowledge(entries, details?.gender, ["gender"]);
  pushKnowledge(entries, details?.dateOfBirth, ["date of birth", "dob", "birth date"]);
  pushKnowledge(entries, yesNo(student.visaRequired ? false : true), ["work authorization", "authorized to work", "legally authorized"]);
  pushKnowledge(entries, yesNo(student.visaRequired || details?.sponsorshipRequired), ["visa sponsorship", "require sponsorship", "sponsorship required"]);
  pushKnowledge(entries, workAuthCountries, ["work authorization countries", "authorized countries", "eligible countries"]);
  pushKnowledge(entries, yesNo(details?.openToRelocate), ["relocate", "open to relocate", "willing to relocate"]);
  pushKnowledge(entries, yesNo(details?.willingToTravel), ["travel", "willing to travel"]);
  pushKnowledge(entries, student.workModes.join(", "), ["work mode", "preferred work mode", "onsite remote hybrid"]);
  pushKnowledge(entries, details?.preferredEmploymentTypes.join(", "), ["employment type", "job type", "preferred employment type"]);
  pushKnowledge(entries, student.targetRoles.join(", "), ["target role", "desired role", "preferred role", "role"]);
  pushKnowledge(entries, student.skills.join(", "), ["skills", "primary skills", "tech stack", "technologies"]);
  pushKnowledge(entries, certifications, ["certifications", "licenses"]);
  pushKnowledge(entries, languages, ["languages", "spoken languages"]);
  pushKnowledge(entries, achievements, ["achievements", "awards", "accomplishments"]);
  pushKnowledge(entries, student.bio, ["bio", "summary", "about me", "professional summary"]);
  pushKnowledge(entries, primaryProject?.name, ["project", "project name", "featured project"]);
  pushKnowledge(entries, primaryProject?.summary, ["project summary", "project description"]);
  pushKnowledge(entries, job.title, ["role applying for", "position applied for"]);
  pushKnowledge(entries, job.company, ["company applying to"]);

  for (const screening of details?.screeningAnswers ?? []) {
    pushKnowledge(entries, screening.answer, [screening.question, normalizeKey(screening.question)]);
  }

  for (const fact of details?.customFacts ?? []) {
    pushKnowledge(entries, fact.value, [fact.label, normalizeKey(fact.label)]);
  }

  pushKnowledge(entries, details?.eeo.ethnicity, ["ethnicity", "race", "ethnic background"]);
  pushKnowledge(entries, details?.eeo.veteranStatus, ["veteran", "protected veteran", "veteran status"]);
  pushKnowledge(entries, details?.eeo.disabilityStatus, ["disability", "disability status"]);

  return entries;
}

function pushKnowledge(entries: ProfileKnowledgeEntry[], value: string | undefined, aliases: string[]) {
  const cleanValue = value?.trim();

  if (!cleanValue) {
    return;
  }

  const terms = aliases
    .map((alias) => normalizeKey(alias))
    .filter(Boolean);

  entries.push({
    value: cleanValue,
    terms
  });
}

function scoreKnowledgeMatch(query: string, terms: string[]) {
  let score = 0;

  for (const term of terms) {
    if (!term) {
      continue;
    }

    if (query.includes(term)) {
      score += term.split(" ").length > 1 ? 24 : 12;
      continue;
    }

    const queryTokens = new Set(query.split(" ").filter(Boolean));
    const termTokens = term.split(" ").filter(Boolean);
    const overlap = termTokens.filter((token) => queryTokens.has(token)).length;

    score += overlap * 6;
  }

  return score;
}

function coerceToFieldValue(value: string, field: VisibleField) {
  if (field.options.length === 0) {
    return value;
  }

  const normalizedValue = normalizeKey(value);
  const exact = field.options.find((option) => normalizeKey(option) === normalizedValue);

  if (exact) {
    return exact;
  }

  const fuzzy = field.options.find((option) => {
    const normalizedOption = normalizeKey(option);
    return normalizedOption.includes(normalizedValue) || normalizedValue.includes(normalizedOption);
  });

  return fuzzy ?? value;
}

function yesNo(value: boolean | undefined) {
  if (value === undefined) {
    return undefined;
  }

  return value ? "Yes" : "No";
}

function messageContentToString(content: unknown) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text?: unknown }).text ?? "");
        }

        return "";
      })
      .join("")
      .trim();
  }

  return "";
}

function getOpenAiCompatibleBaseUrl() {
  const raw = process.env.OPENAI_BASE_URL?.trim();

  if (!raw) {
    return undefined;
  }

  return raw
    .replace(/\/chat\/completions\/?$/i, "")
    .replace(/\/responses\/?$/i, "")
    .replace(/\/+$/g, "");
}

function isJsonModeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");

  return /response_format|json_object|json mode|unsupported.*json|does not support/i.test(message);
}

function shouldUseReflection(input: ReflectStageInput) {
  return process.env.LLM_ANSWER_ENABLED === "true"
    && Boolean(process.env.OPENAI_API_KEY)
    && (input.missingRequiredLabels.length > 0 || input.validationMessages.length > 0);
}

async function callReflectionOpenAiCompatible(prompt: string) {
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
