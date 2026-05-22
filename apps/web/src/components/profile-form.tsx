"use client";

import type {
  AutomationMode,
  MatchStrictness,
  ProfileCustomFact,
  ProfileEducationRecord,
  ProfileEmploymentRecord,
  ProfileProjectRecord,
  ProfileScreeningAnswer,
  StudentProfile,
  StudentProfileDetails,
  WorkMode
} from "@gradlaunch/shared";
import type { ChangeEvent, FormEvent } from "react";
import { useEffect, useState } from "react";
import { useAuth } from "../providers/auth-provider";

type ProfileFormState = {
  fullName: string;
  bio: string;
  degree: string;
  graduationYear: string;
  targetRoles: string;
  preferredLocations: string;
  skills: string;
  expectedSalaryLpa: string;
  automationMode: AutomationMode;
  defaultStrictness: MatchStrictness;
  workModes: WorkMode[];
  visaRequired: boolean;
  headline: string;
  phone: string;
  alternateEmail: string;
  linkedInUrl: string;
  githubUrl: string;
  portfolioUrl: string;
  websiteUrl: string;
  leetcodeUrl: string;
  kaggleUrl: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  country: string;
  postalCode: string;
  nationality: string;
  pronouns: string;
  gender: string;
  dateOfBirth: string;
  currentCompany: string;
  currentTitle: string;
  totalExperienceYears: string;
  noticePeriodDays: string;
  currentSalaryLpa: string;
  sponsorshipRequired: boolean;
  openToRelocate: boolean;
  willingToTravel: boolean;
  workAuthorizationCountries: string;
  preferredEmploymentTypes: string;
  certifications: string;
  languages: string;
  achievements: string;
  educationHistory: string;
  employmentHistory: string;
  projectHistory: string;
  screeningAnswers: string;
  customFacts: string;
  ethnicity: string;
  veteranStatus: string;
  disabilityStatus: string;
};

export function ProfileForm() {
  const { student, saveProfile } = useAuth();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [formState, setFormState] = useState<ProfileFormState | null>(null);

  useEffect(() => {
    if (!student) {
      setFormState(null);
      return;
    }

    setFormState(createFormState(student));
  }, [student]);

  if (!student || !formState) {
    return null;
  }

  const currentStudent = student;
  const currentFormState = formState;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      const completeProfile: StudentProfileDetails = {
        headline: currentFormState.headline.trim() || undefined,
        phone: currentFormState.phone.trim() || undefined,
        alternateEmail: currentFormState.alternateEmail.trim() || undefined,
        linkedInUrl: currentFormState.linkedInUrl.trim() || undefined,
        githubUrl: currentFormState.githubUrl.trim() || undefined,
        portfolioUrl: currentFormState.portfolioUrl.trim() || undefined,
        websiteUrl: currentFormState.websiteUrl.trim() || undefined,
        leetcodeUrl: currentFormState.leetcodeUrl.trim() || undefined,
        kaggleUrl: currentFormState.kaggleUrl.trim() || undefined,
        addressLine1: currentFormState.addressLine1.trim() || undefined,
        addressLine2: currentFormState.addressLine2.trim() || undefined,
        city: currentFormState.city.trim() || undefined,
        state: currentFormState.state.trim() || undefined,
        country: currentFormState.country.trim() || undefined,
        postalCode: currentFormState.postalCode.trim() || undefined,
        nationality: currentFormState.nationality.trim() || undefined,
        pronouns: currentFormState.pronouns.trim() || undefined,
        gender: currentFormState.gender.trim() || undefined,
        dateOfBirth: currentFormState.dateOfBirth.trim() || undefined,
        currentCompany: currentFormState.currentCompany.trim() || undefined,
        currentTitle: currentFormState.currentTitle.trim() || undefined,
        totalExperienceYears: toOptionalNumber(currentFormState.totalExperienceYears),
        noticePeriodDays: toOptionalNumber(currentFormState.noticePeriodDays),
        currentSalaryLpa: toOptionalNumber(currentFormState.currentSalaryLpa),
        sponsorshipRequired: currentFormState.sponsorshipRequired,
        openToRelocate: currentFormState.openToRelocate,
        willingToTravel: currentFormState.willingToTravel,
        workAuthorizationCountries: splitFlexibleList(currentFormState.workAuthorizationCountries),
        preferredEmploymentTypes: splitFlexibleList(currentFormState.preferredEmploymentTypes),
        certifications: splitFlexibleList(currentFormState.certifications),
        languages: splitFlexibleList(currentFormState.languages),
        achievements: splitFlexibleList(currentFormState.achievements),
        educationHistory: parseEducationHistory(currentFormState.educationHistory),
        employmentHistory: parseEmploymentHistory(currentFormState.employmentHistory),
        projectHistory: parseProjectHistory(currentFormState.projectHistory),
        screeningAnswers: parseScreeningAnswers(currentFormState.screeningAnswers),
        customFacts: parseCustomFacts(currentFormState.customFacts),
        eeo: {
          ethnicity: currentFormState.ethnicity.trim() || undefined,
          veteranStatus: currentFormState.veteranStatus.trim() || undefined,
          disabilityStatus: currentFormState.disabilityStatus.trim() || undefined
        }
      };

      await saveProfile({
        fullName: currentFormState.fullName,
        degree: currentFormState.degree,
        graduationYear: Number(currentFormState.graduationYear || currentStudent.graduationYear),
        targetRoles: splitFlexibleList(currentFormState.targetRoles),
        preferredLocations: splitFlexibleList(currentFormState.preferredLocations),
        workModes: currentFormState.workModes.length > 0 ? currentFormState.workModes : ["remote"],
        skills: splitFlexibleList(currentFormState.skills),
        expectedSalaryLpa: toOptionalNumber(currentFormState.expectedSalaryLpa),
        visaRequired: currentFormState.visaRequired,
        automationMode: currentFormState.automationMode,
        defaultStrictness: currentFormState.defaultStrictness,
        bio: currentFormState.bio,
        completeProfile
      });

      setMessage("Complete profile saved.");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to save profile.");
    } finally {
      setLoading(false);
    }
  }

  function updateField<Key extends keyof ProfileFormState>(key: Key, value: ProfileFormState[Key]) {
    setFormState((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        [key]: value
      };
    });
  }

  function handleInputChange(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) {
    const { name, value } = event.target;

    if (name === "automationMode") {
      updateField("automationMode", value as AutomationMode);
      return;
    }

    if (name === "defaultStrictness") {
      updateField("defaultStrictness", value as MatchStrictness);
      return;
    }

    updateField(name as keyof Omit<ProfileFormState, "workModes" | "visaRequired" | "automationMode" | "defaultStrictness" | "sponsorshipRequired" | "openToRelocate" | "willingToTravel">, value);
  }

  function handleWorkModeChange(mode: WorkMode, checked: boolean) {
    const nextModes = checked
      ? [...new Set([...currentFormState.workModes, mode])]
      : currentFormState.workModes.filter((item) => item !== mode);

    updateField("workModes", nextModes);
  }

  return (
    <form className="form-stack" onSubmit={handleSubmit}>
      <p className="kicker">Core identity</p>
      <label>
        <span className="kicker">Full name</span>
        <input className="input" name="fullName" onChange={handleInputChange} required value={currentFormState.fullName} />
      </label>
      <label>
        <span className="kicker">Professional headline</span>
        <input className="input" name="headline" onChange={handleInputChange} value={currentFormState.headline} />
      </label>
      <label>
        <span className="kicker">Bio / summary</span>
        <textarea className="input textarea" name="bio" onChange={handleInputChange} value={currentFormState.bio} />
      </label>

      <p className="kicker">Contact and links</p>
      <label>
        <span className="kicker">Phone</span>
        <input className="input" name="phone" onChange={handleInputChange} value={currentFormState.phone} />
      </label>
      <label>
        <span className="kicker">Alternate email</span>
        <input className="input" name="alternateEmail" onChange={handleInputChange} value={currentFormState.alternateEmail} />
      </label>
      <label>
        <span className="kicker">LinkedIn URL</span>
        <input className="input" name="linkedInUrl" onChange={handleInputChange} value={currentFormState.linkedInUrl} />
      </label>
      <label>
        <span className="kicker">GitHub URL</span>
        <input className="input" name="githubUrl" onChange={handleInputChange} value={currentFormState.githubUrl} />
      </label>
      <label>
        <span className="kicker">Portfolio URL</span>
        <input className="input" name="portfolioUrl" onChange={handleInputChange} value={currentFormState.portfolioUrl} />
      </label>
      <label>
        <span className="kicker">Website URL</span>
        <input className="input" name="websiteUrl" onChange={handleInputChange} value={currentFormState.websiteUrl} />
      </label>
      <label>
        <span className="kicker">LeetCode URL</span>
        <input className="input" name="leetcodeUrl" onChange={handleInputChange} value={currentFormState.leetcodeUrl} />
      </label>
      <label>
        <span className="kicker">Kaggle URL</span>
        <input className="input" name="kaggleUrl" onChange={handleInputChange} value={currentFormState.kaggleUrl} />
      </label>

      <p className="kicker">Location and identity</p>
      <label>
        <span className="kicker">Address line 1</span>
        <input className="input" name="addressLine1" onChange={handleInputChange} value={currentFormState.addressLine1} />
      </label>
      <label>
        <span className="kicker">Address line 2</span>
        <input className="input" name="addressLine2" onChange={handleInputChange} value={currentFormState.addressLine2} />
      </label>
      <label>
        <span className="kicker">City</span>
        <input className="input" name="city" onChange={handleInputChange} value={currentFormState.city} />
      </label>
      <label>
        <span className="kicker">State</span>
        <input className="input" name="state" onChange={handleInputChange} value={currentFormState.state} />
      </label>
      <label>
        <span className="kicker">Country</span>
        <input className="input" name="country" onChange={handleInputChange} value={currentFormState.country} />
      </label>
      <label>
        <span className="kicker">Postal code</span>
        <input className="input" name="postalCode" onChange={handleInputChange} value={currentFormState.postalCode} />
      </label>
      <label>
        <span className="kicker">Nationality</span>
        <input className="input" name="nationality" onChange={handleInputChange} value={currentFormState.nationality} />
      </label>
      <label>
        <span className="kicker">Pronouns</span>
        <input className="input" name="pronouns" onChange={handleInputChange} value={currentFormState.pronouns} />
      </label>
      <label>
        <span className="kicker">Gender</span>
        <input className="input" name="gender" onChange={handleInputChange} value={currentFormState.gender} />
      </label>
      <label>
        <span className="kicker">Date of birth</span>
        <input className="input" name="dateOfBirth" onChange={handleInputChange} placeholder="YYYY-MM-DD" value={currentFormState.dateOfBirth} />
      </label>

      <p className="kicker">Career preferences</p>
      <label>
        <span className="kicker">Degree</span>
        <input className="input" name="degree" onChange={handleInputChange} required value={currentFormState.degree} />
      </label>
      <label>
        <span className="kicker">Graduation year</span>
        <input className="input" name="graduationYear" onChange={handleInputChange} required type="number" value={currentFormState.graduationYear} />
      </label>
      <label>
        <span className="kicker">Target roles</span>
        <input className="input" name="targetRoles" onChange={handleInputChange} required value={currentFormState.targetRoles} />
      </label>
      <label>
        <span className="kicker">Preferred locations</span>
        <input className="input" name="preferredLocations" onChange={handleInputChange} required value={currentFormState.preferredLocations} />
      </label>
      <label>
        <span className="kicker">Preferred employment types</span>
        <input className="input" name="preferredEmploymentTypes" onChange={handleInputChange} value={currentFormState.preferredEmploymentTypes} />
      </label>
      <label>
        <span className="kicker">Skills</span>
        <input className="input" name="skills" onChange={handleInputChange} required value={currentFormState.skills} />
      </label>
      <label>
        <span className="kicker">Certifications</span>
        <input className="input" name="certifications" onChange={handleInputChange} value={currentFormState.certifications} />
      </label>
      <label>
        <span className="kicker">Languages</span>
        <input className="input" name="languages" onChange={handleInputChange} value={currentFormState.languages} />
      </label>
      <label>
        <span className="kicker">Achievements</span>
        <textarea className="input textarea" name="achievements" onChange={handleInputChange} value={currentFormState.achievements} />
      </label>

      <p className="kicker">Current work and compensation</p>
      <label>
        <span className="kicker">Current company</span>
        <input className="input" name="currentCompany" onChange={handleInputChange} value={currentFormState.currentCompany} />
      </label>
      <label>
        <span className="kicker">Current title</span>
        <input className="input" name="currentTitle" onChange={handleInputChange} value={currentFormState.currentTitle} />
      </label>
      <label>
        <span className="kicker">Total experience (years)</span>
        <input className="input" name="totalExperienceYears" onChange={handleInputChange} type="number" value={currentFormState.totalExperienceYears} />
      </label>
      <label>
        <span className="kicker">Notice period (days)</span>
        <input className="input" name="noticePeriodDays" onChange={handleInputChange} type="number" value={currentFormState.noticePeriodDays} />
      </label>
      <label>
        <span className="kicker">Current salary (LPA)</span>
        <input className="input" name="currentSalaryLpa" onChange={handleInputChange} type="number" value={currentFormState.currentSalaryLpa} />
      </label>
      <label>
        <span className="kicker">Expected salary (LPA)</span>
        <input className="input" name="expectedSalaryLpa" onChange={handleInputChange} type="number" value={currentFormState.expectedSalaryLpa} />
      </label>

      <p className="kicker">Authorization and mobility</p>
      <fieldset className="checkbox-group">
        <legend className="kicker">Work modes</legend>
        <label><input checked={currentFormState.workModes.includes("remote")} onChange={(event) => handleWorkModeChange("remote", event.target.checked)} type="checkbox" value="remote" /> Remote</label>
        <label><input checked={currentFormState.workModes.includes("hybrid")} onChange={(event) => handleWorkModeChange("hybrid", event.target.checked)} type="checkbox" value="hybrid" /> Hybrid</label>
        <label><input checked={currentFormState.workModes.includes("onsite")} onChange={(event) => handleWorkModeChange("onsite", event.target.checked)} type="checkbox" value="onsite" /> Onsite</label>
      </fieldset>
      <label className="checkbox-line">
        <input checked={currentFormState.visaRequired} onChange={(event) => updateField("visaRequired", event.target.checked)} type="checkbox" />
        Visa sponsorship needed
      </label>
      <label className="checkbox-line">
        <input checked={currentFormState.sponsorshipRequired} onChange={(event) => updateField("sponsorshipRequired", event.target.checked)} type="checkbox" />
        Usually answer “Yes” when asked if sponsorship is required
      </label>
      <label className="checkbox-line">
        <input checked={currentFormState.openToRelocate} onChange={(event) => updateField("openToRelocate", event.target.checked)} type="checkbox" />
        Open to relocate
      </label>
      <label className="checkbox-line">
        <input checked={currentFormState.willingToTravel} onChange={(event) => updateField("willingToTravel", event.target.checked)} type="checkbox" />
        Willing to travel
      </label>
      <label>
        <span className="kicker">Authorized work countries</span>
        <input className="input" name="workAuthorizationCountries" onChange={handleInputChange} value={currentFormState.workAuthorizationCountries} />
      </label>

      <p className="kicker">Structured history</p>
      <label>
        <span className="kicker">Education history</span>
        <textarea className="input textarea" name="educationHistory" onChange={handleInputChange} placeholder="One per line: School | Degree | Field | StartYear | EndYear | Grade | City | Country" value={currentFormState.educationHistory} />
      </label>
      <label>
        <span className="kicker">Employment history</span>
        <textarea className="input textarea" name="employmentHistory" onChange={handleInputChange} placeholder="One per line: Company | Title | StartDate | EndDate/current | Location | Summary" value={currentFormState.employmentHistory} />
      </label>
      <label>
        <span className="kicker">Projects</span>
        <textarea className="input textarea" name="projectHistory" onChange={handleInputChange} placeholder="One per line: Project | Role | Tech stack | Summary | URL" value={currentFormState.projectHistory} />
      </label>

      <p className="kicker">Reusable answers</p>
      <label>
        <span className="kicker">Screening answers</span>
        <textarea className="input textarea" name="screeningAnswers" onChange={handleInputChange} placeholder="One per line: Question | Answer" value={currentFormState.screeningAnswers} />
      </label>
      <label>
        <span className="kicker">Custom facts</span>
        <textarea className="input textarea" name="customFacts" onChange={handleInputChange} placeholder="One per line: Label | Value" value={currentFormState.customFacts} />
      </label>

      <p className="kicker">EEO / optional declarations</p>
      <label>
        <span className="kicker">Ethnicity</span>
        <input className="input" name="ethnicity" onChange={handleInputChange} placeholder="Example: Prefer not to say" value={currentFormState.ethnicity} />
      </label>
      <label>
        <span className="kicker">Veteran status</span>
        <input className="input" name="veteranStatus" onChange={handleInputChange} placeholder="Example: Not a protected veteran" value={currentFormState.veteranStatus} />
      </label>
      <label>
        <span className="kicker">Disability status</span>
        <input className="input" name="disabilityStatus" onChange={handleInputChange} placeholder="Example: Prefer not to say" value={currentFormState.disabilityStatus} />
      </label>

      <p className="kicker">Agent preferences</p>
      <label>
        <span className="kicker">Automation mode</span>
        <select className="select" name="automationMode" onChange={handleInputChange} value={currentFormState.automationMode}>
          <option value="alerts_only">Alerts only</option>
          <option value="draft_and_review">Draft and review</option>
          <option value="autofill_with_review">Autofill with review</option>
          <option value="full_autopilot">Full autopilot</option>
        </select>
      </label>
      <label>
        <span className="kicker">Default strictness</span>
        <select className="select" name="defaultStrictness" onChange={handleInputChange} value={currentFormState.defaultStrictness}>
          <option value="broad">Broad</option>
          <option value="balanced">Balanced</option>
          <option value="strict">Strict</option>
        </select>
      </label>

      <button className="button button-primary" disabled={loading} type="submit">
        {loading ? "Saving..." : "Save complete profile"}
      </button>
      {message ? <p className="muted">{message}</p> : null}
      {error ? <p className="muted">{error}</p> : null}
    </form>
  );
}

function createFormState(student: StudentProfile): ProfileFormState {
  const details = student.completeProfile;

  return {
    fullName: student.fullName,
    bio: student.bio ?? "",
    degree: student.degree,
    graduationYear: String(student.graduationYear),
    targetRoles: joinList(student.targetRoles),
    preferredLocations: joinList(student.preferredLocations),
    skills: joinList(student.skills),
    expectedSalaryLpa: student.expectedSalaryLpa ? String(student.expectedSalaryLpa) : "",
    automationMode: student.automationMode,
    defaultStrictness: student.defaultStrictness,
    workModes: student.workModes,
    visaRequired: student.visaRequired,
    headline: details?.headline ?? "",
    phone: details?.phone ?? "",
    alternateEmail: details?.alternateEmail ?? "",
    linkedInUrl: details?.linkedInUrl ?? "",
    githubUrl: details?.githubUrl ?? "",
    portfolioUrl: details?.portfolioUrl ?? "",
    websiteUrl: details?.websiteUrl ?? "",
    leetcodeUrl: details?.leetcodeUrl ?? "",
    kaggleUrl: details?.kaggleUrl ?? "",
    addressLine1: details?.addressLine1 ?? "",
    addressLine2: details?.addressLine2 ?? "",
    city: details?.city ?? "",
    state: details?.state ?? "",
    country: details?.country ?? "",
    postalCode: details?.postalCode ?? "",
    nationality: details?.nationality ?? "",
    pronouns: details?.pronouns ?? "",
    gender: details?.gender ?? "",
    dateOfBirth: details?.dateOfBirth ?? "",
    currentCompany: details?.currentCompany ?? "",
    currentTitle: details?.currentTitle ?? "",
    totalExperienceYears: details?.totalExperienceYears !== undefined ? String(details.totalExperienceYears) : "",
    noticePeriodDays: details?.noticePeriodDays !== undefined ? String(details.noticePeriodDays) : "",
    currentSalaryLpa: details?.currentSalaryLpa !== undefined ? String(details.currentSalaryLpa) : "",
    sponsorshipRequired: details?.sponsorshipRequired ?? student.visaRequired,
    openToRelocate: details?.openToRelocate ?? false,
    willingToTravel: details?.willingToTravel ?? false,
    workAuthorizationCountries: joinList(details?.workAuthorizationCountries ?? []),
    preferredEmploymentTypes: joinList(details?.preferredEmploymentTypes ?? []),
    certifications: joinList(details?.certifications ?? []),
    languages: joinList(details?.languages ?? []),
    achievements: joinList(details?.achievements ?? []),
    educationHistory: formatEducationHistory(details?.educationHistory ?? []),
    employmentHistory: formatEmploymentHistory(details?.employmentHistory ?? []),
    projectHistory: formatProjectHistory(details?.projectHistory ?? []),
    screeningAnswers: formatScreeningAnswers(details?.screeningAnswers ?? []),
    customFacts: formatCustomFacts(details?.customFacts ?? []),
    ethnicity: details?.eeo.ethnicity ?? "",
    veteranStatus: details?.eeo.veteranStatus ?? "",
    disabilityStatus: details?.eeo.disabilityStatus ?? ""
  };
}

function splitFlexibleList(value: string) {
  return value
    .split(/\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinList(values: string[]) {
  return values.join(", ");
}

function toOptionalNumber(value: string) {
  if (!value || value.trim() === "") {
    return undefined;
  }

  return Number(value);
}

function parseEducationHistory(value: string): ProfileEducationRecord[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [school, degree, fieldOfStudy, startYear, endYear, grade, city, country] = splitPipeLine(line, 8);
      return {
        school,
        degree,
        fieldOfStudy: fieldOfStudy || undefined,
        startYear: toOptionalNumber(startYear),
        endYear: toOptionalNumber(endYear),
        grade: grade || undefined,
        city: city || undefined,
        country: country || undefined
      };
    })
    .filter((item) => item.school || item.degree);
}

function parseEmploymentHistory(value: string): ProfileEmploymentRecord[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [company, title, startDate, endDate, location, summary] = splitPipeLine(line, 6);
      const normalizedEndDate = endDate.toLowerCase() === "current" ? undefined : endDate;
      return {
        company,
        title,
        startDate: startDate || undefined,
        endDate: normalizedEndDate || undefined,
        current: endDate.toLowerCase() === "current",
        location: location || undefined,
        summary: summary || undefined
      };
    })
    .filter((item) => item.company || item.title);
}

function parseProjectHistory(value: string): ProfileProjectRecord[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, role, techStack, summary, url] = splitPipeLine(line, 5);
      return {
        name,
        role: role || undefined,
        techStack: techStack || undefined,
        summary: summary || undefined,
        url: url || undefined
      };
    })
    .filter((item) => item.name);
}

function parseScreeningAnswers(value: string): ProfileScreeningAnswer[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [question, answer] = splitPipeLine(line, 2);
      return { question, answer };
    })
    .filter((item) => item.question && item.answer);
}

function parseCustomFacts(value: string): ProfileCustomFact[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [label, factValue] = splitPipeLine(line, 2);
      return { label, value: factValue };
    })
    .filter((item) => item.label && item.value);
}

function formatEducationHistory(values: ProfileEducationRecord[]) {
  return values
    .map((entry) => [
      entry.school,
      entry.degree,
      entry.fieldOfStudy ?? "",
      entry.startYear ?? "",
      entry.endYear ?? "",
      entry.grade ?? "",
      entry.city ?? "",
      entry.country ?? ""
    ].join(" | "))
    .join("\n");
}

function formatEmploymentHistory(values: ProfileEmploymentRecord[]) {
  return values
    .map((entry) => [
      entry.company,
      entry.title,
      entry.startDate ?? "",
      entry.current ? "current" : entry.endDate ?? "",
      entry.location ?? "",
      entry.summary ?? ""
    ].join(" | "))
    .join("\n");
}

function formatProjectHistory(values: ProfileProjectRecord[]) {
  return values
    .map((entry) => [
      entry.name,
      entry.role ?? "",
      entry.techStack ?? "",
      entry.summary ?? "",
      entry.url ?? ""
    ].join(" | "))
    .join("\n");
}

function formatScreeningAnswers(values: ProfileScreeningAnswer[]) {
  return values
    .map((entry) => [entry.question, entry.answer].join(" | "))
    .join("\n");
}

function formatCustomFacts(values: ProfileCustomFact[]) {
  return values
    .map((entry) => [entry.label, entry.value].join(" | "))
    .join("\n");
}

function splitPipeLine(line: string, expectedParts: number) {
  const parts = line.split("|").map((item) => item.trim());

  while (parts.length < expectedParts) {
    parts.push("");
  }

  return parts.slice(0, expectedParts);
}
