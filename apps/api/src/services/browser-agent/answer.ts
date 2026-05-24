import type { FilledField, Job, StudentMemory, StudentProfile } from "@gradlaunch/shared";
import { cityFromLocationLabel, inferCountryFromPhoneNumber, resolveBestProfileLocation } from "../location-resolver";
import { createStudentProfileSummary, retrieveProfileAnswer } from "./profile-knowledge";
import { fieldSemanticText, hasSemanticConcept, inferSemanticFieldIntent, semanticKey } from "./semantic-nlp";
import type { StageAnswerPlan, VisibleField } from "./types";
import { dedupeLabels, jsonBlock, normalizeKey, writeBrowserDebug } from "./util";

// answer.ts decides what value should go into each visible field. It prefers
// trusted deterministic profile/resume facts for identity/contact/location
// fields, then uses the LLM only as an optional semantic matcher/writer for
// fields that deterministic data cannot cover safely.
type BuildAnswerPlanInput = {
  job: Job;
  visibleFields: VisibleField[];
  baseFields: FilledField[];
  student?: StudentProfile;
  memory?: StudentMemory;
  resumeText?: string;
  workspacePath: string;
};

type AnswerCandidate = {
  label: string;
  value: string;
  fieldId: string;
  inputType: string;
  options: string[];
  placeholder?: string;
  name?: string;
  ariaLabel?: string;
  autocomplete?: string;
  role?: string;
  required: boolean;
  reason: string;
};

// Builds the answer plan for one visible stage. It maps every observed field to
// a trusted value from prepared fields, profile, resume, memory, or optionally
// the LLM, then reports which required labels still have no answer.
export async function buildStageAnswerPlan(input: BuildAnswerPlanInput): Promise<StageAnswerPlan> {
  // Build a deterministic plan first so fields like email, phone, country,
  // profile links, and legal names never get overwritten by hallucinated LLM
  // output. The LLM can improve mapping, but trusted facts still win.
  const deterministicAnswers = createDeterministicAnswerMap(input.visibleFields, input.baseFields, input.student, input.job, input.memory, input.resumeText);

  if (shouldUseLlm() && input.visibleFields.length > 0) {
    const llmPlan = await askLlmForStageAnswers(input).catch(() => undefined);

    if (llmPlan) {
      const answers = normalizeChoiceAnswers(input.visibleFields
        .map((field) => chooseStageAnswer(field, deterministicAnswers.get(field.id), llmPlan.answers.get(field.id)))
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

// Chooses between deterministic and LLM-proposed answers for one field. Trusted
// identity/contact/location facts stay deterministic; LLM values are accepted
// only when they pass validation and are safe for the field.
function chooseStageAnswer(field: VisibleField, deterministic: AnswerCandidate | undefined, llm: AnswerCandidate | undefined) {
  // For high-trust profile fields we either use stored data or leave the field
  // unresolved. This is safer than letting the LLM invent personal data.
  if (deterministic && shouldPreferDeterministicAnswer(field)) {
    return deterministic;
  }

  if (!deterministic && shouldRequireTrustedProfileFact(field)) {
    return undefined;
  }

  if (llm && !shouldRejectAnswerValue(field, llm.value)) {
    return llm;
  }

  return deterministic;
}

// Identifies fields where missing deterministic data is safer than allowing an
// LLM guess, such as names, email, phone, and profile URLs.
function shouldRequireTrustedProfileFact(field: VisibleField) {
  const label = semanticKey(fieldSemanticText(field));

  return hasSemanticConcept(label, [
    "first name",
    "given name",
    "last name",
    "surname",
    "family name",
    "full name",
    "legal name",
    "email",
    "phone",
    "mobile",
    "contact number",
    "linkedin",
    "github",
    "portfolio",
    "website",
    "profile url",
    "leetcode",
    "kaggle"
  ]);
}

// Marks fields where deterministic profile/resume data should override LLM
// output because wrong values would be high-impact or easy to know exactly.
function shouldPreferDeterministicAnswer(field: VisibleField) {
  const label = semanticKey(fieldSemanticText(field));

  return hasSemanticConcept(label, [
    "first name",
    "given name",
    "last name",
    "surname",
    "family name",
    "full name",
    "email",
    "phone",
    "mobile",
    "contact number",
    "linkedin",
    "github",
    "portfolio",
    "website",
    "url",
    "leetcode",
    "kaggle",
    "city",
    "location",
    "country",
    "work authorization",
    "authorized to work",
    "visa sponsorship"
  ])
    || field.inputType === "checkbox"
    || field.inputType === "radio"
    || field.inputType === "select"
    || field.inputType === "combobox";
}

// Rejects answers that do not fit the field's type, options, or trusted URL
// expectations. This prevents malformed dates, wrong profile links, and
// dropdown values that are not present in the portal.
function shouldRejectAnswerValue(field: VisibleField, value: string) {
  const label = semanticKey(fieldSemanticText(field));
  const valueKey = normalizeKey(value);

  if (isLikelyLocationValue(value) && !isLocationAnswerField(field)) {
    return true;
  }

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

// Creates deterministic answer candidates for all visible fields by resolving
// each field against prepared data, profile facts, resume text, job context, and
// memory corrections before the LLM is considered.
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

    if (shouldRejectAnswerValue(field, value)) {
      continue;
    }

    answers.set(field.id, {
      label: field.label,
      value,
      fieldId: field.id,
      inputType: field.inputType,
      options: field.options,
      placeholder: field.placeholder,
      name: field.name,
      ariaLabel: field.ariaLabel,
      autocomplete: field.autocomplete,
      role: field.role,
      required: field.required,
      reason: prepared.has(fieldKey) || getFieldAliases(field.label).some((alias) => prepared.has(normalizeKey(alias)))
        ? "Matched a prepared GradLaunch field or remembered correction."
        : "Used a direct profile fallback for a common field."
    });
  }

  return answers;
}

// Resolves one field to the best deterministic value. The resolver order is
// deliberate: choices, address/location, education, trusted profile values,
// prepared aliases, fallbacks, and profile knowledge.
function resolveDeterministicFieldValue(
  field: VisibleField,
  prepared: Map<string, string>,
  student: StudentProfile | undefined,
  job: Job,
  resumeText: string | undefined
) {
  // Candidate order matters. Choice/address/location/education resolvers run
  // before generic fallbacks so known structured facts can be normalized to the
  // exact option or format a portal expects.
  const label = semanticKey(fieldSemanticText(field));

  if (/\bmiddle name\b/.test(label)) {
    return prepared.get("middle name") ?? prepared.get("legal middle name");
  }

  const candidates = [
    resolveTalentNetworkFieldValue(field, student, job),
    resolveChoiceFieldValue(field, student),
    resolvePreparedChoiceValue(field, prepared, student, job, resumeText),
    resolveAddressFieldValue(field, prepared, student, job, resumeText),
    resolveLocationFieldValue(field, prepared, student, job, resumeText),
    resolveEducationFieldValue(field, prepared, student, resumeText),
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

// Resolves talent-network dropdowns such as Area of interest, Skills, and
// Experience level from profile/job facts. This prevents generic select fields
// from accidentally receiving location answers just because location is known.
function resolveTalentNetworkFieldValue(field: VisibleField, student: StudentProfile | undefined, job: Job) {
  const intent = inferSemanticFieldIntent(fieldSemanticText(field));

  if (intent === "skills") {
    const skills = student?.skills ?? [];

    return skills.map((skill: string) => skill.trim()).find(Boolean);
  }

  if (intent === "area_interest") {
    return student?.targetRoles?.[0]
      ?? student?.completeProfile?.headline
      ?? job.title;
  }

  if (intent === "experience_level") {
    const years = student?.completeProfile?.totalExperienceYears ?? 0;

    if (years <= 1 || !student?.completeProfile?.employmentHistory?.length) {
      return "Entry Level";
    }

    if (years <= 3) {
      return "Early Professional";
    }

    return "Experienced Professional";
  }

  if (intent === "community_interest") {
    return undefined;
  }

  return undefined;
}

// Handles checkbox/radio country options and similar choice fields using the
// candidate's resolved profile location instead of generic Yes/No answers.
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

// Returns only high-confidence profile values for free-text identity/contact
// and URL fields, skipping option-backed fields that need option matching.
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
    return details?.phone;
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

// Normalizes common country aliases into the visible country names expected by
// dropdowns and country checkbox groups.
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

// Resolves common yes/no or consent-style option-backed fields from profile and
// policy rules, such as work experience, marketing opt-in, and privacy consent.
function resolveChoiceFieldValue(field: VisibleField, student: StudentProfile | undefined) {
  const descriptor = normalizeKey(`${field.label} ${field.context} ${field.options.join(" ")}`);
  const intent = inferSemanticFieldIntent(fieldSemanticText(field));

  if (!isOptionBackedField(field)) {
    return undefined;
  }

  if (["skills", "area_interest", "experience_level", "community_interest"].includes(intent ?? "")) {
    return undefined;
  }

  if (/\b(preferred name|different from your legal name|select yes below otherwise please select no)\b/.test(descriptor)) {
    return findNegativeChoiceOption(field.options) ?? "No";
  }

  if (field.inputType !== "combobox" && /\b(talent network|career opportunities|upcoming events|job alerts|recruiting updates|keep you up to date|marketing updates)\b/.test(descriptor)) {
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

// Resolves address, state/province, and postal-code fields using complete
// profile details first, then prepared fields, resolved location, and resume.
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

// Resolves education fields such as degree type, degree name, university, and
// start/end dates from structured education history and resume text.
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

// Resolves city/current-location autocomplete fields into concrete candidate
// locations. Search widgets receive full location labels; plain city fields get
// only the city name.
function resolveLocationFieldValue(
  field: VisibleField,
  prepared: Map<string, string>,
  student: StudentProfile | undefined,
  job: Job,
  resumeText: string | undefined,
  proposedValue?: string
) {
  const fieldLabel = normalizeKey(field.label);
  const label = normalizeKey(fieldSemanticText(field));

  if (/\b(authorized|authorization|sponsor|sponsorship|work permit|remote|relocat|employed|stripe affiliate|whatsapp|sms|text messages|opt in|skill|area of interest|experience level|community)\b/.test(label)) {
    return undefined;
  }

  if (!isLocationAnswerField(field) || (/\bcountry\b/.test(fieldLabel) && !/\bcity\b/.test(fieldLabel))) {
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

// Cleans and filters answer candidates for choice-heavy pages, especially
// country checkbox groups, so only the intended option is selected.
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

// Computes required field labels that still have no planned answer after
// country-group normalization and deduplication.
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

// Detects a country-list question where the value should be one country choice
// rather than a generic boolean.
function isCountryListQuestion(value: string) {
  return /\b(country|countries|working in|role in which you are applying|currently reside)\b/.test(normalizeKey(value));
}

// Detects standalone option labels like Yes/No/Accept so they can be treated as
// answer choices, not as field questions.
function isStandaloneChoiceOptionLabel(value: string) {
  return /^(yes|no|no thanks|no thank you|yes please|i agree|agree|accept|decline|not now|skip|continue)$/i.test(value.trim());
}

// Detects multi-country follow-up questions that should use the candidate's
// intended country instead of selecting every visible country option.
function isCountryChoiceGroupQuestion(value: string) {
  const normalized = normalizeKey(value);

  return /\b(country|countries)\b/.test(normalized)
    && /\b(anticipate|working in|role in which you are applying|selected in your previous response|previous response)\b/.test(normalized)
    && !/\bcurrently reside\b/.test(normalized);
}

// Detects labels that are themselves country options in checkbox/radio lists.
function isCountryOptionLabel(value: string) {
  return /^(australia|belgium|brazil|canada|france|germany|india|indonesia|ireland|israel|italy|japan|luxembourg|malaysia|mexico|new zealand|poland|portugal|romania|singapore|south korea|spain|sweden|switzerland|thailand|the netherlands|netherlands|uae|uk|us|united states|united kingdom)$/i.test(value.trim());
}

// Provides conservative fallback answers for common legal/consent/role fields
// when no prepared or profile-specific value exists.
function fallbackForVisibleField(field: VisibleField, student: StudentProfile | undefined, job: Job) {
  const label = normalizeKey(fieldSemanticText(field));
  const descriptor = normalizeKey(`${fieldSemanticText(field)} ${field.options.join(" ")}`);

  const talentNetworkValue = resolveTalentNetworkFieldValue(field, student, job);

  if (talentNetworkValue) {
    return talentNetworkValue;
  }

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
    && !["skills", "area_interest", "experience_level", "community_interest"].includes(inferSemanticFieldIntent(fieldSemanticText(field)) ?? "")
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

  if (isLocationAnswerField(field)) {
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

// Returns true only when a field is actually asking for a candidate location,
// city, state/province, country, or address. Generic custom selects like Skills
// and Area of interest must never receive location values.
function isLocationAnswerField(field: VisibleField) {
  const intent = inferSemanticFieldIntent(fieldSemanticText(field));
  const descriptor = normalizeKey(fieldSemanticText(field));

  if (["skills", "area_interest", "experience_level", "community_interest"].includes(intent ?? "")) {
    return false;
  }

  return ["location", "city", "state", "country"].includes(intent ?? "")
    || /\b(current location|preferred location|place of residence|where do you live|address line|street address|city|state|province|country)\b/.test(descriptor);
}

// Detects values that look like a city/state/country/address answer. The agent
// uses this as a guard so location data cannot be applied to unrelated selects.
function isLikelyLocationValue(value: string) {
  const normalized = normalizeKey(value);

  return /\b(india|bihar|maharashtra|karnataka|haryana|uttar pradesh|telangana|tamil nadu|west bengal|aurangabad|bhiwani|bengaluru|bangalore|banglore|gurugram|gurgaon|delhi|noida|hyderabad|pune|mumbai|chennai|kolkata|united states|usa|canada|australia|united kingdom|uk)\b/.test(normalized)
    || normalized.split(/\s+/).length >= 3 && /\b(city|state|country|india)\b/.test(normalized);
}

// Finds the best negative/no-style option from a list of visible choices.
function findNegativeChoiceOption(options: string[]) {
  return options.find((option) => /\b(no thanks|no thank you|decline|do not|don t|dont|not now|skip)\b/i.test(option))
    ?? options.find((option) => /^no\b/i.test(option));
}

// Finds the best affirmative/yes/consent-style option from a list of visible
// choices.
function findAffirmativeChoiceOption(options: string[]) {
  return options.find((option) => /\b(i agree|agree|accept|acknowledge|confirm|yes)\b/i.test(option))
    ?? options.find((option) => /^yes\b/i.test(option));
}

// Checks whether an intended choice answer corresponds to one of the field's
// visible option labels.
function choiceValueMatchesOption(value: string, options: string[]) {
  return Boolean(findMatchingOption(value, options));
}

// Normalizes a candidate answer for its field, preferring the exact visible
// option label when the field exposes options.
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

// Returns true for controls whose accepted values must come from a visible
// option list rather than arbitrary free text.
function isOptionBackedField(field: VisibleField) {
  return field.inputType === "radio"
    || field.inputType === "checkbox"
    || field.inputType === "select"
    || field.inputType === "combobox";
}

// Filters placeholder options out of a select/radio/checkbox option list.
function meaningfulOptions(options: string[]) {
  return options
    .map((option) => option.trim())
    .filter((option) => {
      const normalized = normalizeKey(option);
      return Boolean(normalized) && !/^(select|select an option|choose|choose one|please select|none selected|not selected)$/.test(normalized);
    });
}

// Matches an answer value against a field's visible options using exact,
// semantic yes/no, degree-type, and strict country matching.
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

// Stores one prepared value under the field label and all known aliases so
// later resolvers can find it despite label wording differences.
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

// Builds the prepared-value map from application fields and remembered user
// corrections, giving later resolvers a fast canonical lookup table.
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

// Pulls likely location strings from prepared fields in priority order for the
// location resolver.
function getPreparedLocationHints(prepared: Map<string, string>) {
  return [
    prepared.get("current location"),
    prepared.get("location city"),
    prepared.get("location"),
    prepared.get("preferred location"),
    prepared.get("city")
  ].filter((value): value is string => Boolean(value?.trim()));
}

// Resolves the best country hint from prepared fields, profile country, phone
// number, or resume text.
function resolveCountryHint(prepared: Map<string, string>, student: StudentProfile | undefined, resumeText: string | undefined) {
  return prepared.get("country")
    ?? prepared.get("current country")
    ?? prepared.get("location country")
    ?? prepared.get("country where you currently reside")
    ?? student?.completeProfile?.country
    ?? inferCountryFromPhoneNumber(resolvePreparedPhone(prepared))
    ?? inferCountryFromPhoneNumber(resumeText);
}

// Reads the prepared phone number under common aliases so location/country
// inference can use phone-country hints.
function resolvePreparedPhone(prepared: Map<string, string>) {
  return prepared.get("phone number") ?? prepared.get("phone") ?? prepared.get("mobile");
}

// Converts a raw degree string into the closest visible degree-level option,
// such as Bachelor's, Master's, or Doctorate.
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

// Formats education years into a stable ISO-like date value for start/end date
// fields.
function formatEducationDate(year: number | undefined, kind: "start" | "end") {
  if (!year || !Number.isFinite(year)) {
    return undefined;
  }

  const month = kind === "start" ? "08" : "05";
  return `${year}-${month}-01`;
}

// Extracts a postal/ZIP code from resume text as a fallback for address forms.
function extractPostalCode(text: string | undefined) {
  const match = text?.match(/\b\d{6}\b|\b\d{5}(?:-\d{4})?\b/);
  return match?.[0];
}

// Finds the strongest university/college/institute line from resume text.
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

// Chooses the best higher-education institution from profile, prepared fields,
// and resume candidates.
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

// Cleans degree/field-of-study text while avoiding school-board values that do
// not belong in college degree fields.
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

// Detects secondary-school board values that should not be used as college or
// degree answers.
function isSchoolBoardValue(valueKey: string) {
  return /\b(cbse|icse|isc|state board|senior secondary|higher secondary|secondary school|high school|intermediate|public school|12th|10th|xii|x)\b/.test(valueKey);
}

// Scores whether a resume/profile line is likely to be a higher-education
// institution instead of a school board or unrelated text.
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

// Resolves a generic prepared answer by label aliases, while blocking prepared
// values for fields that require special handling such as URLs or policy
// questions.
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

// Resolves a prepared LinkedIn/GitHub/portfolio/etc. URL and validates that it
// matches the requested profile platform.
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

// Detects whether a visible field is asking for a profile/link URL.
function isProfileUrlField(field: VisibleField) {
  return isProfileUrlLabel(normalizeKey([field.label, field.context, field.options.join(" ")].join(" ")));
}

// Detects profile/link URL wording in a normalized label/context string.
function isProfileUrlLabel(normalizedLabel: string) {
  return /\b(linkedin|linked in|github|git hub|portfolio|website|web site|personal site|homepage|profile url|profile link|url|leetcode|kaggle)\b/.test(normalizedLabel);
}

// Returns trusted URL candidates from structured profile data for the requested
// platform or generic website/portfolio field.
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

// Returns prepared URL candidates from saved fields/memory for the requested
// platform or generic website/portfolio field.
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

// Validates a profile URL against a visible field's label/context/options.
function isAcceptedProfileUrlForField(field: VisibleField, value: string) {
  return isAcceptedProfileUrlForLabel(normalizeKey([field.label, field.context, field.options.join(" ")].join(" ")), value);
}

// Validates that a URL belongs to the requested platform and points to a
// meaningful profile path, not a homepage/login/search page.
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

// Canonicalizes a profile URL by adding protocol if needed and trimming trailing
// path slashes.
function normalizeProfileUrl(value: string | undefined) {
  const url = parseProfileUrl(value);

  if (!url) {
    return undefined;
  }

  const path = url.pathname.replace(/\/+$/g, "");
  return `${url.protocol}//${url.host}${path}${url.search}${url.hash}`;
}

// Safely parses a possible profile URL from text, allowing missing protocol but
// rejecting non-URL strings.
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

// Checks whether a generic URL has enough host/path information to be useful as
// a profile, website, or portfolio answer.
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

// Validates LinkedIn profile URLs and rejects generic LinkedIn pages.
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

// Validates GitHub profile URLs and rejects generic GitHub product/navigation
// pages.
function isGitHubProfileUrl(url: URL) {
  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  const pathParts = getUrlPathParts(url);

  if (host !== "github.com") {
    return false;
  }

  return Boolean(pathParts[0]) && !["about", "blog", "collections", "enterprise", "events", "explore", "features", "login", "marketplace", "new", "pricing", "search", "signup", "topics"].includes(pathParts[0]);
}

// Validates profile URLs for platforms that only need a specific host plus a
// non-empty path, such as LeetCode or Kaggle.
function isSpecificPlatformProfileUrl(url: URL, expectedHost: string) {
  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  return host === expectedHost && getUrlPathParts(url).length > 0;
}

// Splits URL path segments into clean parts for profile-platform validation.
function getUrlPathParts(url: URL) {
  return url.pathname.split("/").map((part) => part.trim()).filter(Boolean);
}

// Expands a field label into common aliases so prepared values can match forms
// that use different wording for the same profile fact.
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

  return [...aliases];
}

// Asks the configured LLM to semantically map visible fields to answer values.
// The prompt requires strict JSON and forbids inventing personal facts.
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
  const visibleByLabel = new Map(input.visibleFields.flatMap((field) => [
    [normalizeKey(field.label), field] as const,
    [semanticKey(fieldSemanticText(field)), field] as const
  ]));
  const prepared = createPreparedValueMap(input.baseFields, input.memory);
  const answers = new Map<string, {
    label: string;
    value: string;
    fieldId: string;
    inputType: string;
    options: string[];
    placeholder?: string;
    name?: string;
    ariaLabel?: string;
    autocomplete?: string;
    role?: string;
    required: boolean;
    reason: string;
  }>();

  for (const candidate of parsed.answers ?? []) {
    const visibleField = (candidate.fieldId ? visibleById.get(candidate.fieldId) : undefined)
      ?? (candidate.label ? visibleByLabel.get(normalizeKey(candidate.label)) ?? visibleByLabel.get(semanticKey(candidate.label)) : undefined);
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
      placeholder: visibleField.placeholder,
      name: visibleField.name,
      ariaLabel: visibleField.ariaLabel,
      autocomplete: visibleField.autocomplete,
      role: visibleField.role,
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

// Sends an answer-planning prompt to the OpenAI-compatible chat endpoint and
// returns the response content for strict JSON parsing.
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

// Checks whether LLM answer planning is enabled and an API key is available.
function shouldUseLlm() {
  return process.env.LLM_ANSWER_ENABLED === "true" && Boolean(process.env.OPENAI_API_KEY);
}
