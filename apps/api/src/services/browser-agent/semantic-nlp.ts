import type { BrowserFillField, VisibleField } from "./types";
import { normalizeKey } from "./util";

// semantic-nlp.ts is the local NLP-style normalization layer for field
// understanding. It does not call an external model; instead it applies
// practical NLP techniques that are deterministic and fast for form fields:
// identifier splitting, compound-word splitting, light lemmatization/stemming,
// synonym expansion, and semantic concept scoring.
type SemanticField = Pick<VisibleField, "label" | "context" | "options"> & Partial<Pick<VisibleField, "placeholder" | "name" | "ariaLabel" | "autocomplete" | "role">>;

const compoundTerms = [
  "firstname",
  "givenname",
  "middlename",
  "lastname",
  "surname",
  "familyname",
  "fullname",
  "legalname",
  "preferredname",
  "emailaddress",
  "phonenumber",
  "mobilenumber",
  "contactnumber",
  "postalcode",
  "zipcode",
  "postcode",
  "workauthorization",
  "authorisedtowork",
  "authorizedtowork",
  "visasponsorship",
  "sponsorshiprequired",
  "currentlocation",
  "preferredlocation",
  "citystate",
  "stateprovince",
  "countryregion",
  "githubprofile",
  "linkedinprofile",
  "portfolioURL".toLowerCase(),
  "websiteurl",
  "schoolname",
  "universityname",
  "collegename",
  "degreename",
  "degreetype",
  "fieldofstudy",
  "graduationdate",
  "startdate",
  "enddate",
  "dateofbirth",
  "workexperience",
  "noticeperiod",
  "areaofinterest",
  "interestarea",
  "experiencelevel",
  "careerlevel",
  "skillset",
  "primaryskills",
  "communitiesofinterest"
];

const compoundSplitMap = new Map<string, string>([
  ["firstname", "first name"],
  ["givenname", "given name"],
  ["middlename", "middle name"],
  ["lastname", "last name"],
  ["surname", "sur name"],
  ["familyname", "family name"],
  ["fullname", "full name"],
  ["legalname", "legal name"],
  ["preferredname", "preferred name"],
  ["emailaddress", "email address"],
  ["phonenumber", "phone number"],
  ["mobilenumber", "mobile number"],
  ["contactnumber", "contact number"],
  ["postalcode", "postal code"],
  ["zipcode", "zip code"],
  ["postcode", "post code"],
  ["workauthorization", "work authorization"],
  ["authorisedtowork", "authorised to work"],
  ["authorizedtowork", "authorized to work"],
  ["visasponsorship", "visa sponsorship"],
  ["sponsorshiprequired", "sponsorship required"],
  ["currentlocation", "current location"],
  ["preferredlocation", "preferred location"],
  ["citystate", "city state"],
  ["stateprovince", "state province"],
  ["countryregion", "country region"],
  ["githubprofile", "github profile"],
  ["linkedinprofile", "linkedin profile"],
  ["portfoliourl", "portfolio url"],
  ["websiteurl", "website url"],
  ["schoolname", "school name"],
  ["universityname", "university name"],
  ["collegename", "college name"],
  ["degreename", "degree name"],
  ["degreetype", "degree type"],
  ["fieldofstudy", "field of study"],
  ["graduationdate", "graduation date"],
  ["startdate", "start date"],
  ["enddate", "end date"],
  ["dateofbirth", "date of birth"],
  ["workexperience", "work experience"],
  ["noticeperiod", "notice period"],
  ["areaofinterest", "area of interest"],
  ["interestarea", "interest area"],
  ["experiencelevel", "experience level"],
  ["careerlevel", "career level"],
  ["skillset", "skill set"],
  ["primaryskills", "primary skills"],
  ["communitiesofinterest", "communities of interest"]
]);

const synonymMap = new Map<string, string[]>([
  ["first", ["given", "forename"]],
  ["last", ["surname", "family"]],
  ["email", ["e-mail", "mail"]],
  ["phone", ["mobile", "contact", "telephone", "tel"]],
  ["city", ["town", "municipality"]],
  ["state", ["province", "region"]],
  ["country", ["nation"]],
  ["location", ["place", "residence", "address", "city", "country"]],
  ["zip", ["postal", "postcode"]],
  ["postal", ["zip", "postcode"]],
  ["university", ["college", "school", "institution", "institute"]],
  ["degree", ["qualification", "program", "course"]],
  ["authorization", ["authorisation", "eligible", "eligibility", "authorized", "authorised"]],
  ["sponsorship", ["visa", "sponsor"]],
  ["resume", ["cv", "curriculum"]],
  ["linkedin", ["linked", "in"]],
  ["github", ["git", "hub"]],
  ["skill", ["technology", "stack", "tool"]],
  ["interest", ["area", "domain", "job", "career"]],
  ["experience", ["level", "seniority"]]
]);

const stopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "of",
  "on",
  "or",
  "please",
  "select",
  "the",
  "to",
  "your"
]);

// Builds the richest text description for a field by combining the visible
// label with placeholder/name/ARIA metadata. LLM prompts, deterministic answer
// matching, and fill-strategy detection all use this so placeholder-only fields
// are no longer under-described.
export function fieldSemanticText(field: SemanticField | BrowserFillField) {
  const metadata = field as Partial<SemanticField>;

  return [
    field.label,
    metadata.placeholder,
    metadata.name,
    metadata.ariaLabel,
    metadata.autocomplete,
    metadata.role,
    metadata.context,
    field.options?.join(" ")
  ].filter(Boolean).join(" ");
}

// Converts labels such as "first_name", "firstName", and "firstname" into the
// same semantic key, with simple lemma/stem reduction and synonym expansion.
export function semanticKey(value: string | undefined | null) {
  return semanticTokens(value).join(" ");
}

// Tokenizes form text using deterministic NLP-style cleanup: identifier
// splitting, compound dictionary splitting, diacritic removal, light
// lemmatization/stemming, stop-word removal, and synonym expansion.
export function semanticTokens(value: string | undefined | null) {
  const expanded = splitCompounds(splitIdentifiers(value ?? ""));
  const base = normalizeKey(expanded)
    .split(/\s+/)
    .map((token) => lemmatizeToken(token))
    .filter((token) => token && !stopWords.has(token));
  const tokens = new Set<string>();

  for (const token of base) {
    tokens.add(token);

    for (const synonym of synonymMap.get(token) ?? []) {
      tokens.add(lemmatizeToken(normalizeKey(synonym)));
    }
  }

  return [...tokens].filter(Boolean);
}

// Scores semantic overlap between two bits of field text. This catches
// separator/case differences and common aliases better than raw regex checks.
export function semanticSimilarity(left: string | undefined | null, right: string | undefined | null) {
  const leftTokens = new Set(semanticTokens(left));
  const rightTokens = new Set(semanticTokens(right));

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let overlap = 0;

  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

// Checks whether a field text matches any semantic concept phrase, using the
// same tokenizer as the rest of the browser agent.
export function hasSemanticConcept(value: string | undefined | null, concepts: string[]) {
  const key = semanticKey(value);

  return concepts.some((concept) => {
    const conceptKey = semanticKey(concept);
    return key.includes(conceptKey) || semanticSimilarity(key, conceptKey) >= 0.72;
  });
}

// Infers common job-application field intent from semantic tokens. This is
// intentionally conservative: it helps strategy selection and trusted-profile
// matching, but the live DOM verifier still has final authority.
export function inferSemanticFieldIntent(value: string | undefined | null) {
  const rawKey = normalizeKey(splitCompounds(splitIdentifiers(value ?? "")));
  const key = semanticKey(value);

  if (hasAll(key, ["first", "name"]) || hasAll(key, ["given", "name"])) return "first_name";
  if (hasAll(key, ["middle", "name"])) return "middle_name";
  if (hasAll(key, ["last", "name"]) || hasAll(key, ["family", "name"]) || key.includes("surname")) return "last_name";
  if (hasAll(key, ["full", "name"]) || hasAll(key, ["legal", "name"])) return "full_name";
  if (key.includes("email")) return "email";
  if (key.includes("phone") || key.includes("mobile") || key.includes("telephone")) return "phone";
  if (/\b(city|current city|town|locality)\b/.test(rawKey)) return "city";
  if (/\b(location|residence|place of residence)\b/.test(rawKey)) return "location";
  if (/\bcountry\b/.test(rawKey)) return "country";
  if (/\b(state|province|region)\b/.test(rawKey)) return "state";
  if (hasAll(key, ["postal", "code"]) || hasAll(key, ["zip", "code"]) || key.includes("postcode")) return "postal_code";
  if (key.includes("linkedin")) return "linkedin";
  if (key.includes("github")) return "github";
  if (key.includes("portfolio") || key.includes("website")) return "portfolio";
  if (key.includes("university") || key.includes("college") || key.includes("institution")) return "university";
  if (key.includes("degree") || key.includes("qualification")) return "degree";
  if (hasAll(key, ["start", "date"]) || hasAll(key, ["end", "date"]) || hasAll(key, ["graduation", "date"]) || hasAll(key, ["birth", "date"]) || key.includes("dob")) return "date";
  if (hasAll(key, ["work", "authorization"]) || key.includes("eligible")) return "work_authorization";
  if (key.includes("sponsorship") || key.includes("visa")) return "sponsorship";
  if (key.includes("resume") || key.includes("cv")) return "resume";
  if (/\b(area of interest|interest area|job interest|career interest)\b/.test(rawKey) || /\barea\b.*\binterest\b|\binterest\b.*\barea\b/.test(rawKey)) return "area_interest";
  if (/\b(skills?|skill set|primary skills|technologies|tech stack)\b/.test(rawKey)) return "skills";
  if (/\b(experience level|career level|seniority)\b/.test(rawKey)) return "experience_level";
  if (/\b(communities of interest|community interest)\b/.test(rawKey)) return "community_interest";

  return undefined;
}

function splitIdentifiers(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_./\\-]+/g, " ");
}

function splitCompounds(value: string) {
  let result = value;

  for (const term of compoundTerms) {
    const replacement = compoundSplitMap.get(term.toLowerCase());

    if (!replacement) {
      continue;
    }

    result = result.replace(new RegExp(`\\b${escapeRegExp(term)}\\b`, "gi"), replacement);
  }

  return result;
}

function lemmatizeToken(value: string) {
  let token = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

  if (token === "authorised") return "authorized";
  if (token === "authorisation") return "authorization";
  if (token === "authorized") return "authorized";
  if (token === "eligibility") return "eligible";
  if (token === "universities") return "university";
  if (token === "colleges") return "college";
  if (token === "addresses") return "address";

  if (token.length > 5 && token.endsWith("ies")) {
    token = `${token.slice(0, -3)}y`;
  } else if (token.length > 5 && token.endsWith("ing")) {
    token = token.slice(0, -3);
  } else if (token.length > 4 && token.endsWith("ed")) {
    token = token.slice(0, -2);
  } else if (token.length > 4 && token.endsWith("s")) {
    token = token.slice(0, -1);
  }

  return token;
}

function hasAll(key: string, terms: string[]) {
  return terms.every((term) => key.includes(semanticKey(term)));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
