import type { Job, StudentProfile } from "@gradlaunch/shared";
import type { VisibleField } from "./types";
import { normalizeKey } from "./util";

type ProfileKnowledgeEntry = {
  value: string;
  terms: string[];
};

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

  push(entries, student.fullName, ["full name", "legal name", "name", "candidate name"]);
  push(entries, details?.headline ?? student.targetRoles[0], ["headline", "professional headline", "title", "profile headline"]);
  push(entries, student.email, ["email", "email address", "primary email"]);
  push(entries, details?.alternateEmail, ["alternate email", "secondary email"]);
  push(entries, details?.phone, ["phone", "mobile", "mobile number", "phone number", "contact number"]);
  push(entries, details?.linkedInUrl, ["linkedin", "linkedin url", "linkedin profile"]);
  push(entries, details?.githubUrl, ["github", "github url", "github profile"]);
  push(entries, details?.portfolioUrl, ["portfolio", "portfolio url", "personal portfolio"]);
  push(entries, details?.websiteUrl, ["website", "personal website"]);
  push(entries, details?.leetcodeUrl, ["leetcode", "leetcode profile"]);
  push(entries, details?.kaggleUrl, ["kaggle", "kaggle profile"]);
  push(entries, [details?.addressLine1, details?.addressLine2].filter(Boolean).join(", "), ["address", "street address", "address line"]);
  push(entries, details?.city ?? student.preferredLocations[0], ["city", "current city", "location city", "location", "location city", "current location"]);
  push(entries, details?.state, ["state", "province", "region"]);
  push(entries, details?.country, ["country", "current country", "location country", "country where you currently reside", "currently reside"]);
  push(entries, details?.postalCode, ["postal code", "zip code", "pincode"]);
  push(entries, student.degree, ["degree", "highest degree", "education degree"]);
  push(entries, primaryEducation?.school, ["college", "university", "school", "institution", "most recent school you attended", "recent school"]);
  push(entries, primaryEducation?.fieldOfStudy, ["field of study", "major", "specialization", "branch"]);
  push(entries, primaryEducation?.grade, ["grade", "cgpa", "gpa", "percentage"]);
  push(entries, student.graduationYear ? String(student.graduationYear) : undefined, ["graduation year", "passing year", "year of graduation"]);
  push(entries, currentEmployment?.company ?? details?.currentCompany, ["current company", "company", "current organization", "employer", "current employer", "previous employer", "current or previous employer", "most recent employer"]);
  push(entries, currentEmployment?.title ?? details?.currentTitle, ["current title", "designation", "job title", "current designation", "current or previous job title", "previous job title", "most recent job title"]);
  push(entries, details?.totalExperienceYears !== undefined ? String(details.totalExperienceYears) : undefined, ["years of experience", "experience", "total experience"]);
  push(entries, details?.noticePeriodDays !== undefined ? String(details.noticePeriodDays) : undefined, ["notice period", "notice period days", "joining period"]);
  push(entries, details?.currentSalaryLpa !== undefined ? String(details.currentSalaryLpa) : undefined, ["current ctc", "current salary", "present ctc", "current compensation"]);
  push(entries, student.expectedSalaryLpa !== undefined ? String(student.expectedSalaryLpa) : undefined, ["expected ctc", "expected salary", "salary expectation", "expected compensation"]);
  push(entries, details?.nationality, ["nationality", "citizenship"]);
  push(entries, details?.pronouns, ["pronouns"]);
  push(entries, details?.gender, ["gender"]);
  push(entries, details?.dateOfBirth, ["date of birth", "dob", "birth date"]);
  push(entries, yesNo(student.visaRequired ? false : true), ["work authorization", "authorized to work", "legally authorized"]);
  push(entries, yesNo(student.visaRequired || details?.sponsorshipRequired), ["visa sponsorship", "require sponsorship", "sponsorship required"]);
  push(entries, workAuthCountries, ["work authorization countries", "authorized countries", "eligible countries"]);
  push(entries, yesNo(details?.openToRelocate), ["relocate", "open to relocate", "willing to relocate"]);
  push(entries, yesNo(details?.willingToTravel), ["travel", "willing to travel"]);
  push(entries, student.workModes.join(", "), ["work mode", "preferred work mode", "onsite remote hybrid"]);
  push(entries, details?.preferredEmploymentTypes.join(", "), ["employment type", "job type", "preferred employment type"]);
  push(entries, student.targetRoles.join(", "), ["target role", "desired role", "preferred role", "role"]);
  push(entries, student.skills.join(", "), ["skills", "primary skills", "tech stack", "technologies"]);
  push(entries, certifications, ["certifications", "licenses"]);
  push(entries, languages, ["languages", "spoken languages"]);
  push(entries, achievements, ["achievements", "awards", "accomplishments"]);
  push(entries, student.bio, ["bio", "summary", "about me", "professional summary"]);
  push(entries, primaryProject?.name, ["project", "project name", "featured project"]);
  push(entries, primaryProject?.summary, ["project summary", "project description"]);
  push(entries, job.title, ["role applying for", "position applied for"]);
  push(entries, job.company, ["company applying to"]);

  for (const screening of details?.screeningAnswers ?? []) {
    push(entries, screening.answer, [screening.question, normalizeKey(screening.question)]);
  }

  for (const fact of details?.customFacts ?? []) {
    push(entries, fact.value, [fact.label, normalizeKey(fact.label)]);
  }

  push(entries, details?.eeo.ethnicity, ["ethnicity", "race", "ethnic background"]);
  push(entries, details?.eeo.veteranStatus, ["veteran", "protected veteran", "veteran status"]);
  push(entries, details?.eeo.disabilityStatus, ["disability", "disability status"]);

  return entries;
}

function push(entries: ProfileKnowledgeEntry[], value: string | undefined, aliases: string[]) {
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
