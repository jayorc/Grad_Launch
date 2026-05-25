import type { FilledField, Job, StudentMemory, StudentProfile } from "@gradlaunch/shared";
import { callLangChainJson, createStudentProfileSummary, isLangChainAnswerEnabled, retrieveProfileAnswer } from "./answer";
import { jsonBlock, normalizeKey, writeBrowserDebug } from "./util";
import type { FillV2Answer, FillV2Field, FillV2Input, FillV2Intent } from "./fill-engine";

type PreparedValue = {
  value: string;
  source: "prepared" | "memory";
};

const fillV2AnswerCache = new Map<string, Awaited<ReturnType<typeof buildFillV2AnswersUncached>>>();
const maxFillV2AnswerCacheEntries = 40;

export async function buildFillV2Answers(input: FillV2Input, fields: FillV2Field[]) {
  const cacheKey = buildFillV2AnswerCacheKey(input, fields);
  const cached = fillV2AnswerCache.get(cacheKey);

  if (cached) {
    await writeBrowserDebug(input.workspacePath, "fill-v2-answer-cache-hit", {
      stageIndex: input.stageIndex,
      answerCount: cached.answers.length,
      unresolvedRequiredLabels: cached.unresolvedRequiredLabels
    });
    return cloneFillV2AnswerResult(cached);
  }

  const built = await buildFillV2AnswersUncached(input, fields);
  rememberFillV2Answers(cacheKey, built);
  return cloneFillV2AnswerResult(built);
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

    const deterministic = resolveDeterministicAnswer(field, input, prepared);

    if (deterministic) {
      answers.set(field.id, deterministic);
      continue;
    }

    if (field.intent === "prose") {
      proseFields.push(field);
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

  return {
    answers: finalAnswers,
    unresolvedRequiredLabels,
    usedLlm: finalAnswers.some((answer) => answer.source === "llm"),
    summary: summarizeAnswerSources(finalAnswers)
  };
}

function buildFillV2AnswerCacheKey(input: FillV2Input, fields: FillV2Field[]) {
  const fieldKey = fields
    .map((field) => [
      field.id,
      normalizeKey(field.label),
      field.intent,
      field.driver,
      field.required ? "required" : "optional",
      field.options.map((option) => normalizeKey(option)).join("|")
    ].join(":"))
    .join("||");
  const preparedKey = input.baseFields
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
    input.student?.degree,
    input.student?.graduationYear
  ].map((value) => normalizeKey(String(value ?? ""))).join("|");
  const resumeKey = normalizeKey((input.resumeText ?? "").slice(0, 1200));
  const jobKey = `${normalizeKey(input.job.title)}|${normalizeKey(input.job.company)}|${normalizeKey(input.job.location)}`;

  return [fieldKey, preparedKey, correctionKey, studentKey, resumeKey, jobKey].join("###");
}

function rememberFillV2Answers(key: string, result: Awaited<ReturnType<typeof buildFillV2AnswersUncached>>) {
  fillV2AnswerCache.delete(key);
  fillV2AnswerCache.set(key, cloneFillV2AnswerResult(result));

  while (fillV2AnswerCache.size > maxFillV2AnswerCacheEntries) {
    const firstKey = fillV2AnswerCache.keys().next().value;

    if (!firstKey) {
      break;
    }

    fillV2AnswerCache.delete(firstKey);
  }
}

function cloneFillV2AnswerResult(result: Awaited<ReturnType<typeof buildFillV2AnswersUncached>>) {
  return {
    ...result,
    answers: result.answers.map((answer) => ({
      ...answer,
      options: answer.options ? [...answer.options] : answer.options
    })),
    unresolvedRequiredLabels: [...result.unresolvedRequiredLabels]
  };
}

function resolveDeterministicAnswer(
  field: FillV2Field,
  input: FillV2Input,
  prepared: Map<string, PreparedValue>
): FillV2Answer | undefined {
  if (isOptionalPhoneCountryCodeField(field)) {
    return undefined;
  }

  const preparedValue = resolvePreparedValue(field, prepared);

  if (preparedValue && isSafePreparedValueForField(field, preparedValue.value)) {
    return createAnswer(field, normalizeAnswer(field, preparedValue.value), preparedValue.source, 0.92);
  }

  const value = resolveProfileValue(field.intent, field, input.student, input.job)
    ?? retrieveProfileAnswer(field, input.student, input.job);

  if (!value) {
    return undefined;
  }

  return createAnswer(field, normalizeAnswer(field, value), "profile", field.intent === "unknown" ? 0.55 : 0.95);
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
      return normalizeCountry(details?.country ?? inferCountryFromPhone(details?.phone) ?? "India");
    case "state":
      return details?.state;
    case "city":
      return formatLocation(details?.city ?? student?.preferredLocations?.[0], details?.state, details?.country);
    case "postal_code":
      return details?.postalCode;
    case "address_1":
      return details?.addressLine1 ?? formatLocation(details?.city, details?.state, details?.country);
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
      return details?.noticePeriodDays !== undefined ? String(details.noticePeriodDays) : undefined;
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
  const prompt = [
    "Return strict JSON only.",
    "You are filling only prose job application fields. Use only the provided student profile, resume excerpt, prepared fields, and job details.",
    "Do not answer factual fields like phone, country, salary, name, email, or dates.",
    "Create a distinct answer for each field. Do not reuse the exact same paragraph.",
    "Keep Message to Hiring Team / comments to 2-4 concise sentences. Keep cover letter fields to 4-6 concise sentences.",
    "",
    "Schema:",
    '{"answers":[{"fieldId":"...","value":"...","reason":"..."}]}',
    "",
    `Job: ${input.job.title} at ${input.job.company}`,
    `Job excerpt: ${input.job.description.slice(0, 1600)}`,
    `Student profile: ${JSON.stringify(createStudentProfileSummary(input.student))}`,
    `Resume excerpt: ${JSON.stringify((input.resumeText ?? "").slice(0, 5000))}`,
    `Prepared fields: ${JSON.stringify(input.baseFields)}`,
    `Memory corrections: ${JSON.stringify(input.memory?.corrections ?? [])}`,
    `Fields: ${JSON.stringify(fields.map((field) => ({
      fieldId: field.id,
      label: field.label,
      context: field.context.slice(0, 300),
      required: field.required
    })))}`
  ].join("\n");
  const content = await callLangChainJson({
    system: "You generate concise, truthful job-application prose using the provided context only.",
    prompt
  });
  const parsed = JSON.parse(jsonBlock(content)) as {
    answers?: Array<{ fieldId?: string; label?: string; value?: string; reason?: string }>;
  };
  const byId = new Map(fields.map((field) => [field.id, field]));
  const byLabel = new Map(fields.map((field) => [normalizeKey(field.label), field]));
  const answers: FillV2Answer[] = [];

  for (const candidate of parsed.answers ?? []) {
    const field = (candidate.fieldId ? byId.get(candidate.fieldId) : undefined)
      ?? (candidate.label ? byLabel.get(normalizeKey(candidate.label)) : undefined);
    const value = candidate.value?.trim();

    if (!field || !value) {
      continue;
    }

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

  if (/\b(message|hiring team|comments?|additional information|let the company know|interest working there|interest in working there)\b/.test(descriptor)) {
    return [
      `Thank you for reviewing my application for the ${job.title} role.`,
      `I am especially interested in contributing ${skills ? `with my experience in ${skills}` : "with strong ownership and problem-solving"}.`,
      "I would be grateful for the opportunity to discuss how I can contribute to the team."
    ].join(" ");
  }

  return undefined;
}

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
  if (/\bcity|location\b/.test(key)) aliases.add("Current location");
  if (/\bctc|salary|compensation\b/.test(key)) {
    aliases.add("Expected CTC");
    aliases.add("Current CTC");
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

function isPreparedSocialUrl(value: string) {
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();

    return /(^|\.)github\.com$/.test(host) || /(^|\.)linkedin\.com$/.test(host);
  } catch (_error) {
    return /\bgithub\.com\b|\blinkedin\.com\b/i.test(value);
  }
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
  return {
    label: field.label,
    value,
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

function isOptionalPhoneCountryCodeField(field: FillV2Field) {
  return !field.required
    && field.intent === "country"
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
  const key = normalizeKey(value);

  if (/\bindia|indian\b/.test(key)) return "India";
  if (/\bunited states|usa|us\b/.test(key)) return "United States";
  if (/\bunited kingdom|uk\b/.test(key)) return "United Kingdom";
  if (/\baustralia\b/.test(key)) return "Australia";
  return value.trim();
}

function formatLocation(city: string | undefined, state: string | undefined, country: string | undefined) {
  return [city, state, country].filter(Boolean).join(", ") || undefined;
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

function choiceYes(options: string[]) {
  return options.find((option) => /\b(i agree|agree|accept|acknowledge|confirm|yes)\b/i.test(option))
    ?? options.find((option) => /^yes\b/i.test(option))
    ?? "Yes";
}

function choiceNo(options: string[]) {
  return options.find((option) => /\b(no thanks|no thank you|decline|do not|don t|dont|not now|skip)\b/i.test(option))
    ?? options.find((option) => /^no\b/i.test(option))
    ?? "No";
}

function matchOption(value: string, options: string[]) {
  const valueKey = normalizeKey(value);

  if (!valueKey || options.length === 0) {
    return undefined;
  }

  return options.find((option) => {
    const optionKey = normalizeKey(option);
    return optionKey === valueKey || optionKey.includes(valueKey) || valueKey.includes(optionKey);
  });
}

function summarizeAnswerSources(answers: FillV2Answer[]) {
  const counts = answers.reduce<Record<string, number>>((acc, answer) => {
    acc[answer.source] = (acc[answer.source] ?? 0) + 1;
    return acc;
  }, {});

  return `Fill V2 answers: ${Object.entries(counts).map(([source, count]) => `${source}=${count}`).join(", ")}.`;
}
