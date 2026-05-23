import type { Job, StudentProfile } from "@gradlaunch/shared";

export type ResolvedLocation = {
  label: string;
  city: string;
  region?: string;
  country?: string;
  source: string;
  confidence: number;
  raw: string;
};

type LocationCandidate = {
  raw: string | undefined;
  source: string;
  confidence: number;
};

type KnownLocation = {
  city: string;
  region?: string;
  country: string;
  aliases: string[];
};

type ResolveBestProfileLocationInput = {
  student?: StudentProfile;
  job?: Job;
  resumeText?: string;
  proposedLocation?: string;
  preparedLocations?: Array<string | undefined>;
  countryHint?: string;
  phone?: string;
};

const knownLocations: KnownLocation[] = [
  { city: "Aurangabad", region: "Bihar", country: "India", aliases: ["aurangabad", "aurangabad bihar"] },
  { city: "Aurangabad", region: "Maharashtra", country: "India", aliases: ["aurangabad maharashtra", "chhatrapati sambhajinagar"] },
  { city: "Bengaluru", region: "Karnataka", country: "India", aliases: ["bengaluru", "bangalore", "banglore", "bangluru", "blr"] },
  { city: "Gurugram", region: "Haryana", country: "India", aliases: ["gurugram", "gurgaon"] },
  { city: "Delhi", country: "India", aliases: ["delhi", "new delhi", "ncr"] },
  { city: "Noida", region: "Uttar Pradesh", country: "India", aliases: ["noida"] },
  { city: "Hyderabad", region: "Telangana", country: "India", aliases: ["hyderabad"] },
  { city: "Pune", region: "Maharashtra", country: "India", aliases: ["pune"] },
  { city: "Mumbai", region: "Maharashtra", country: "India", aliases: ["mumbai", "bombay"] },
  { city: "Chennai", region: "Tamil Nadu", country: "India", aliases: ["chennai"] },
  { city: "Kolkata", region: "West Bengal", country: "India", aliases: ["kolkata", "calcutta"] },
  { city: "Sydney", region: "New South Wales", country: "Australia", aliases: ["sydney"] },
  { city: "London", country: "United Kingdom", aliases: ["london"] },
  { city: "New York", region: "New York", country: "United States", aliases: ["new york", "nyc"] },
  { city: "San Francisco", region: "California", country: "United States", aliases: ["san francisco", "sf"] },
  { city: "Seattle", region: "Washington", country: "United States", aliases: ["seattle"] },
  { city: "Austin", region: "Texas", country: "United States", aliases: ["austin"] }
];

const remoteOnlyPattern = /^(remote|anywhere|global|work from home|wfh|hybrid|onsite|not specified|not provided)$/i;

export function resolveBestProfileLocation(input: ResolveBestProfileLocationInput): ResolvedLocation | undefined {
  const countryHint = canonicalCountry(input.countryHint)
    ?? canonicalCountry(input.student?.completeProfile?.country)
    ?? firstCanonicalCountry(input.student?.completeProfile?.workAuthorizationCountries)
    ?? inferCountryFromPhoneNumber(input.phone)
    ?? inferCountryFromPhoneNumber(input.resumeText)
    ?? inferCountryFromLocationLabel(input.resumeText);

  const candidates: LocationCandidate[] = [];
  const details = input.student?.completeProfile;

  pushCandidate(candidates, input.proposedLocation, "proposed_location", 132);
  pushCandidate(candidates, joinLocationParts(details?.city, details?.state, details?.country), "profile_address", 115);
  pushCandidate(candidates, details?.city, "profile_city", 105);

  const employmentHistory = Array.isArray(details?.employmentHistory) ? details?.employmentHistory ?? [] : [];
  const currentEmployment = employmentHistory.find((item) => item.current) ?? employmentHistory[0];

  pushCandidate(candidates, currentEmployment?.location, "current_employment", 100);

  for (const employment of employmentHistory) {
    pushCandidate(candidates, employment.location, "employment_history", 88);
  }

  const educationHistory = Array.isArray(details?.educationHistory) ? details?.educationHistory ?? [] : [];

  for (const education of educationHistory) {
    pushCandidate(candidates, joinLocationParts(education.city, undefined, education.country), "education_history", 72);
  }

  for (const preferred of input.student?.preferredLocations ?? []) {
    pushCandidate(candidates, preferred, "preferred_location", 95);
  }

  for (const resumeLocation of extractKnownLocationsFromText(input.resumeText)) {
    pushCandidate(candidates, resumeLocation, "resume_text", 92);
  }

  for (const prepared of input.preparedLocations ?? []) {
    pushCandidate(candidates, prepared, "prepared_field", 70);
  }

  pushCandidate(candidates, input.job?.location, "job_location", 40);

  let best: ResolvedLocation | undefined;

  for (const candidate of candidates) {
    const resolved = canonicalizeLocation(candidate.raw, countryHint);

    if (!resolved) {
      continue;
    }

    let confidence = candidate.confidence;

    if (countryHint && resolved.country) {
      if (sameCountry(resolved.country, countryHint)) {
        confidence += 22;
      } else if (candidate.source === "job_location" || candidate.source === "prepared_field") {
        confidence -= 110;
      } else {
        confidence -= 55;
      }
    }

    if (!best || confidence > best.confidence) {
      best = {
        ...resolved,
        source: candidate.source,
        confidence,
        raw: candidate.raw?.trim() ?? resolved.raw
      };
    }
  }

  return best && best.confidence >= 35 ? best : undefined;
}

export function cityFromLocationLabel(value: string | undefined) {
  return canonicalizeLocation(value)?.city ?? sanitizeCity(value?.split(",")[0]);
}

export function inferCountryFromPhoneNumber(value: string | undefined) {
  const normalized = (value ?? "").replace(/\s+/g, "");

  if (!normalized) {
    return undefined;
  }

  if (normalized.includes("+91")) {
    return "India";
  }

  if (normalized.includes("+1")) {
    return "United States";
  }

  if (normalized.includes("+44")) {
    return "United Kingdom";
  }

  if (normalized.includes("+61")) {
    return "Australia";
  }

  return undefined;
}

export function inferCountryFromLocationLabel(value: string | undefined) {
  const normalized = normalizeLocationText(value);

  if (!normalized) {
    return undefined;
  }

  for (const location of knownLocations) {
    if (location.aliases.some((alias) => includesPhrase(normalized, alias))) {
      return location.country;
    }
  }

  if (includesPhrase(normalized, "india") || includesPhrase(normalized, "bharat")) {
    return "India";
  }

  if (includesPhrase(normalized, "australia")) {
    return "Australia";
  }

  if (includesPhrase(normalized, "united states") || includesPhrase(normalized, "usa") || includesPhrase(normalized, "america")) {
    return "United States";
  }

  if (includesPhrase(normalized, "united kingdom") || includesPhrase(normalized, "uk")) {
    return "United Kingdom";
  }

  return undefined;
}

function canonicalizeLocation(value: string | undefined, countryHint?: string): Omit<ResolvedLocation, "source" | "confidence"> | undefined {
  const compact = sanitizeLocation(value);

  if (!compact || remoteOnlyPattern.test(compact)) {
    return undefined;
  }

  const normalized = normalizeLocationText(compact);
  const known = knownLocations.find((location) => location.aliases.some((alias) => includesPhrase(normalized, alias)));

  if (known) {
    return toResolvedKnownLocation(known, compact);
  }

  const inferredCountry = inferCountryFromLocationLabel(compact) ?? canonicalCountry(countryHint);
  const city = sanitizeCity(compact
    .split(",")[0]
    ?.replace(/\b(remote|hybrid|onsite|work from home|wfh)\b/gi, "")
    .trim());

  if (!city || isCountryOnly(city) || remoteOnlyPattern.test(city)) {
    return undefined;
  }

  const country = inferredCountry;
  const label = [city, country].filter(Boolean).join(", ");

  return {
    label,
    city,
    country,
    raw: compact
  };
}

function toResolvedKnownLocation(location: KnownLocation, raw: string): Omit<ResolvedLocation, "source" | "confidence"> {
  return {
    label: [location.city, location.region, location.country].filter(Boolean).join(", "),
    city: location.city,
    region: location.region,
    country: location.country,
    raw
  };
}

function extractKnownLocationsFromText(text: string | undefined) {
  const normalized = normalizeLocationText(text);
  const matches: string[] = [];

  if (!normalized) {
    return matches;
  }

  for (const location of knownLocations) {
    if (location.aliases.some((alias) => includesPhrase(normalized, alias))) {
      matches.push([location.city, location.region, location.country].filter(Boolean).join(", "));
    }
  }

  return [...new Set(matches)];
}

function pushCandidate(candidates: LocationCandidate[], raw: string | undefined, source: string, confidence: number) {
  const compact = sanitizeLocation(raw);

  if (!compact) {
    return;
  }

  candidates.push({ raw: compact, source, confidence });
}

function sanitizeLocation(value: string | undefined) {
  const compact = value?.replace(/\s+/g, " ").trim();

  if (!compact || compact.length <= 2 || /^(a|an|na|n a|none|unknown|city|location)$/i.test(compact)) {
    return undefined;
  }

  return compact;
}

function sanitizeCity(value: string | undefined) {
  const compact = value?.replace(/\s+/g, " ").trim();

  if (!compact || compact.length <= 2 || /^(a|an|na|n a|none|unknown|city|location|country)$/i.test(compact)) {
    return undefined;
  }

  return compact
    .split(" ")
    .filter(Boolean)
    .map((part) => part.length <= 3 && part === part.toUpperCase() ? part : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function joinLocationParts(city?: string, state?: string, country?: string) {
  return [city, state, country].filter((part) => Boolean(part?.trim())).join(", ");
}

function canonicalCountry(value: string | undefined) {
  const normalized = normalizeLocationText(value);

  if (!normalized) {
    return undefined;
  }

  if (includesPhrase(normalized, "india") || includesPhrase(normalized, "bharat")) {
    return "India";
  }

  if (includesPhrase(normalized, "australia")) {
    return "Australia";
  }

  if (includesPhrase(normalized, "united states") || includesPhrase(normalized, "usa") || includesPhrase(normalized, "america")) {
    return "United States";
  }

  if (includesPhrase(normalized, "united kingdom") || includesPhrase(normalized, "uk")) {
    return "United Kingdom";
  }

  return undefined;
}

function firstCanonicalCountry(values: string[] | undefined) {
  for (const value of values ?? []) {
    const country = canonicalCountry(value);

    if (country) {
      return country;
    }
  }

  return undefined;
}

function sameCountry(first: string, second: string) {
  const normalizedFirst = canonicalCountry(first);
  const normalizedSecond = canonicalCountry(second);

  return Boolean(normalizedFirst && normalizedSecond && normalizedFirst === normalizedSecond);
}

function isCountryOnly(value: string) {
  return Boolean(canonicalCountry(value)) && normalizeLocationText(value).split(" ").length <= 2;
}

function normalizeLocationText(value: string | undefined) {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function includesPhrase(normalizedHaystack: string, phrase: string) {
  const normalizedPhrase = normalizeLocationText(phrase);

  if (!normalizedHaystack || !normalizedPhrase) {
    return false;
  }

  return new RegExp(`(^| )${escapeRegExp(normalizedPhrase)}( |$)`).test(normalizedHaystack);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
