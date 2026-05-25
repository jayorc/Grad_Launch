import type { Page } from "./browser-driver";
import type { VisibleField } from "./types";
import { dedupeLabels, normalizeKey, writeBrowserDebug } from "./util";
import type { Locator } from "./browser-driver";
import type { FillV2Adapter, FillV2DriverKind, FillV2Field, FillV2Input, FillV2Intent } from "./fill-engine";

const genericAdapter: FillV2Adapter = {
  id: "generic",
  label: "Generic form",
  matches: () => true,
  selectQuery: (_field, answer) => answer.value.trim().split(",")[0]?.trim() || answer.value.trim()
};

const ibmSelect2Adapter: FillV2Adapter = {
  id: "ibm-select2",
  label: "IBM Select2",
  matches: ({ url, pageText }) => {
    const text = normalizeKey(`${url} ${pageText.slice(0, 1000)}`);
    return /careers ibm|ibm talent acquisition|select2/.test(text);
  },
  selectQuery: (field, answer) => {
    if (field.intent === "country") {
      return normalizeKey(answer.value).includes("india") ? "India" : answer.value;
    }

    return answer.value.split(",")[0]?.trim() || answer.value;
  },
  fillCustomSelect: async ({ page, field, answer }) => {
    const query = field.intent === "country" && normalizeKey(answer.value).includes("india")
      ? "India"
      : answer.value.split(",")[0]?.trim() || answer.value;

    for (const frame of page.frames()) {
      const locator = frame.locator(`[data-gradlaunch-v2-field-id="${cssEscape(field.id)}"]`).first();

      if (await locator.count().catch(() => 0) === 0) {
        continue;
      }

      await locator.scrollIntoViewIfNeeded().catch(() => undefined);
      await locator.click({ force: true, timeout: 900 }).catch(() => undefined);
      await page.waitForTimeout(120).catch(() => undefined);

      const search = frame.locator(".select2-search__field, input.select2-search__field, [role='searchbox']").first();

      if (await search.isVisible({ timeout: 250 }).catch(() => false)) {
        await realType(search, query);
        await page.waitForTimeout(180).catch(() => undefined);
      } else {
        await page.keyboard.type(query, { delay: 6 }).catch(() => undefined);
      }

      const option = page.locator(".select2-results__option, [role='option']")
        .filter({ hasText: new RegExp(escapeRegExp(query), "i") })
        .first();

      if (await option.isVisible({ timeout: 700 }).catch(() => false)) {
        await option.click({ force: true, timeout: 900 }).catch(() => undefined);
        await page.keyboard.press("Tab").catch(() => undefined);
        await page.waitForTimeout(140).catch(() => undefined);
        return true;
      }

      await page.keyboard.press("ArrowDown").catch(() => undefined);
      await page.keyboard.press("Enter").catch(() => undefined);
      await page.keyboard.press("Tab").catch(() => undefined);
      await page.waitForTimeout(140).catch(() => undefined);
      return true;
    }

    return false;
  }
};

const smartRecruitersAdapter: FillV2Adapter = {
  id: "smartrecruiters",
  label: "SmartRecruiters",
  matches: ({ url, pageText }) => /smartrecruiters|jobs smartrecruiters|smartr/i.test(`${url} ${pageText.slice(0, 1200)}`),
  selectQuery: (field, answer) => {
    if (field.intent === "country") {
      return normalizeKey(answer.value).includes("india") ? "India" : answer.value;
    }

    return answer.value.split(",")[0]?.trim() || answer.value;
  },
  cleanupBeforeFill: cleanupEmptyExperienceCards
};

const simpleAdapters: FillV2Adapter[] = [
  {
    id: "greenhouse",
    label: "Greenhouse",
    matches: ({ url, pageText }) => /greenhouse|boards.greenhouse|job-boards.greenhouse/i.test(`${url} ${pageText.slice(0, 1000)}`)
  },
  {
    id: "lever",
    label: "Lever",
    matches: ({ url, pageText }) => /lever.co|jobs.lever|lever apply/i.test(`${url} ${pageText.slice(0, 1000)}`)
  },
  {
    id: "workday",
    label: "Workday",
    matches: ({ url, pageText }) => /workdayjobs|myworkdayjobs|workday/i.test(`${url} ${pageText.slice(0, 1000)}`),
    selectQuery: (field, answer) => field.intent === "country" && normalizeKey(answer.value).includes("india")
      ? "India"
      : answer.value.split(",")[0]?.trim() || answer.value
  }
];

const fillV2Adapters: FillV2Adapter[] = [
  ibmSelect2Adapter,
  smartRecruitersAdapter,
  ...simpleAdapters,
  genericAdapter
];

async function detectFillV2Adapter(input: { url: string; pageText: string }) {
  return fillV2Adapters.find((adapter) => adapter.matches(input)) ?? genericAdapter;
}

export async function buildFillV2FieldGraph(input: FillV2Input): Promise<{
  adapter: FillV2Adapter;
  fields: FillV2Field[];
}> {
  const pageText = await input.page.locator("body").innerText({ timeout: 1200 }).catch(() => "");
  const adapter = await detectFillV2Adapter({ url: input.page.url(), pageText });
  const discovered = await discoverDomFields(input.page);
  const seedFields = input.visibleFields.filter((field) => field.inputType !== "file");
  const merged = mergeSeedFields(discovered, seedFields);
  const fields = dedupeV2Fields(merged.map((field) => classifyFillV2Field(field, adapter.id)));

  await writeBrowserDebug(input.workspacePath, "fill-v2-field-graph", {
    stageIndex: input.stageIndex,
    adapter: adapter.id,
    fieldCount: fields.length,
    fields: fields.map((field) => ({
      id: field.id,
      label: field.label,
      inputType: field.inputType,
      driver: field.driver,
      intent: field.intent,
      required: field.required,
      options: field.options.slice(0, 10),
      context: field.context.slice(0, 220)
    })).slice(0, 80)
  });

  return { adapter, fields };
}

async function discoverDomFields(page: Page): Promise<VisibleField[]> {
  const allFields: VisibleField[] = [];

  for (const frame of page.frames()) {
    const frameFields = await frame.evaluate(() => {
      const roots = getSearchRoots();
      const controls = roots.flatMap((root) => Array.from(root.querySelectorAll([
        "input",
        "textarea",
        "select",
        "[contenteditable='true']",
        "[role='combobox']",
        "[role='radio']",
        "[role='checkbox']",
        "[aria-haspopup='listbox']",
        "[aria-haspopup='menu']"
      ].join(",")))) as HTMLElement[];
      const fields: VisibleField[] = [];
      const seen = new Set<Element>();

      for (const [index, control] of controls.entries()) {
        if (seen.has(control) || !isFillCandidate(control)) {
          continue;
        }

        seen.add(control);

        const isChoice = isChoiceControl(control);
        const label = clean(isChoice ? findChoiceGroupLabel(control) || findFieldLabel(control) : findFieldLabel(control));
        const context = clean(findContext(control));

        if (!label || isNoise(label, context, control)) {
          continue;
        }

        const id = control.getAttribute("data-gradlaunch-v2-field-id")
          || control.getAttribute("data-gradlaunch-fast-field-id")
          || control.getAttribute("data-gradlaunch-field-id")
          || `fill-v2-${index}-${normalizeId(label)}`;

        control.setAttribute("data-gradlaunch-v2-field-id", id);

        fields.push({
          id,
          label,
          required: isRequired(control, label, context),
          tagName: control.tagName.toLowerCase(),
          inputType: inferInputType(control),
          options: getOptions(control, label),
          context
        });
      }

      return dedupeFields(fields);

      function isFillCandidate(control: HTMLElement) {
        if (control.getAttribute("aria-disabled") === "true" || control.closest("[hidden], [aria-hidden='true'], .datasetField__row--sample, [id*='sample']")) {
          return false;
        }

        if (control instanceof HTMLInputElement) {
          if (control.disabled || ["hidden", "submit", "button", "image", "reset", "file"].includes(control.type)) {
            return false;
          }
        }

        if ((control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement) && control.disabled) {
          return false;
        }

        if (isChoiceControl(control)) {
          return isVisible(control) || hasVisibleChoiceTarget(control);
        }

        if (control instanceof HTMLSelectElement && !isVisible(control)) {
          return false;
        }

        return isVisible(control);
      }

      function findFieldLabel(control: Element): string {
        if (control.id) {
          const direct = queryFirst(`label[for="${CSS.escape(control.id)}"]`, control);

          if (direct?.textContent?.trim()) {
            return direct.textContent;
          }
        }

        const labelledBy = control.getAttribute("aria-labelledby");

        if (labelledBy) {
          const text = labelledBy
            .split(/\s+/)
            .map((id) => getElementById(id)?.textContent ?? "")
            .join(" ")
            .trim();

          if (text) {
            return text;
          }
        }

        return control.closest("label")?.textContent
          || control.getAttribute("aria-label")
          || control.getAttribute("placeholder")
          || control.closest("fieldset")?.querySelector("legend")?.textContent
          || nearbyLabel(control)
          || control.getAttribute("name")
          || "";
      }

      function findChoiceGroupLabel(control: Element) {
        const fieldset = control.closest("fieldset");
        const legend = fieldset?.querySelector("legend")?.textContent;

        if (legend?.trim()) {
          return legend;
        }

        const group = control.closest("[role='radiogroup'], [role='group'], [aria-labelledby]");
        const labelledBy = group?.getAttribute("aria-labelledby");

        if (labelledBy) {
          const text = labelledBy
            .split(/\s+/)
            .map((id) => getElementById(id)?.textContent ?? "")
            .join(" ")
            .trim();

          if (text) {
            return text;
          }
        }

        return "";
      }

      function nearbyLabel(control: Element) {
        let current = control.parentElement;

        for (let depth = 0; depth < 5 && current; depth += 1) {
          const label = Array.from(current.querySelectorAll("label, legend, h1, h2, h3, h4, [class*='label'], [class*='Label']"))
            .map((item) => clean(item.textContent ?? ""))
            .find((text) => text && text.length <= 180);

          if (label) {
            return label;
          }

          const previous = clean(current.previousElementSibling?.textContent ?? "");

          if (previous && previous.length <= 180) {
            return previous;
          }

          current = current.parentElement;
        }

        return "";
      }

      function findContext(control: Element) {
        const container = control.closest("label, fieldset, [role='group'], [role='radiogroup'], [class*='field'], [class*='Field'], [class*='form'], section, article, div");
        const text = clean(container?.textContent ?? "");
        return text.length > 900 ? text.slice(0, 900) : text;
      }

      function inferInputType(control: HTMLElement) {
        if (control instanceof HTMLInputElement) {
          return control.type || "text";
        }

        if (control instanceof HTMLTextAreaElement) {
          return "textarea";
        }

        if (control instanceof HTMLSelectElement) {
          return "select";
        }

        if (control.isContentEditable) {
          return "contenteditable";
        }

        if (control.getAttribute("role") === "combobox" || control.getAttribute("aria-haspopup")) {
          return "combobox";
        }

        return control.getAttribute("role") || "text";
      }

      function getOptions(control: HTMLElement, label: string) {
        if (control instanceof HTMLSelectElement) {
          return Array.from(control.options)
            .map((option) => clean(option.textContent ?? option.value))
            .filter(Boolean)
            .slice(0, 80);
        }

        if (isChoiceControl(control)) {
          return choiceGroup(control)
            .map((choice) => clean(choiceText(choice)))
            .filter(Boolean)
            .slice(0, 20);
        }

        const inline = Array.from(control.querySelectorAll("[role='option'], option, li, [data-value]"))
          .map((option) => clean(option.textContent ?? option.getAttribute("data-value") ?? ""))
          .filter(Boolean)
          .slice(0, 40);

        return inline.length > 0 ? inline : label ? [label].filter(() => false) : [];
      }

      function choiceGroup(control: HTMLElement) {
        if (control instanceof HTMLInputElement && control.name) {
          return Array.from(document.querySelectorAll(`input[name="${CSS.escape(control.name)}"]`)) as HTMLElement[];
        }

        return Array.from((control.closest("fieldset, [role='radiogroup'], [role='group'], form") ?? control.parentElement ?? control)
          .querySelectorAll("input[type='radio'], input[type='checkbox'], [role='radio'], [role='checkbox']")) as HTMLElement[];
      }

      function choiceText(control: HTMLElement) {
        return [
          control instanceof HTMLInputElement ? control.value : "",
          control.getAttribute("aria-label"),
          control.id ? document.querySelector(`label[for="${CSS.escape(control.id)}"]`)?.textContent : "",
          control.closest("label")?.textContent,
          control.parentElement?.textContent
        ].filter(Boolean).join(" ");
      }

      function isRequired(control: HTMLElement, label: string, context: string) {
        return (control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).required
          || control.getAttribute("aria-required") === "true"
          || /\*/.test(label)
          || /\*/.test(context)
          || Boolean(control.closest(".required, [class*='required'], [data-required='true']"))
          || /\b(required|this field is required|please select|please enter|cannot be blank)\b/i.test(context);
      }

      function isNoise(label: string, context: string, control: HTMLElement) {
        const key = normalize(`${label} ${context}`);

        if (/^(search|select an option|choose an option)$/i.test(label.trim()) && !/\b(country|city|location|state|degree)\b/.test(key)) {
          return true;
        }

        if (control.closest("[role='listbox'], [role='menu'], .iti__country-list, .iti__country, .cdk-overlay-pane, mat-option, [class*='option']")) {
          return true;
        }

        return /^(close|cancel|continue|submit|back|next|previous|remove|add another|save)$/i.test(label.trim());
      }

      function dedupeFields(items: VisibleField[]) {
        const byKey = new Map<string, VisibleField>();

        for (const item of items) {
          const key = `${normalizeType(item.inputType)}:${normalizeSemantic(item.label)}`;
          const existing = byKey.get(key);

          if (!existing || (item.required && !existing.required) || item.label.length < existing.label.length) {
            byKey.set(key, item);
          }
        }

        return [...byKey.values()];
      }

      function isChoiceControl(control: Element) {
        return control instanceof HTMLInputElement && ["radio", "checkbox"].includes(control.type)
          || control.getAttribute("role") === "radio"
          || control.getAttribute("role") === "checkbox";
      }

      function hasVisibleChoiceTarget(control: HTMLElement) {
        return Boolean(control.id && document.querySelector(`label[for="${CSS.escape(control.id)}"]`) && isVisible(document.querySelector(`label[for="${CSS.escape(control.id)}"]`)!));
      }

      function queryFirst(selector: string, control: Element) {
        const root = control.getRootNode();
        return root instanceof Document || root instanceof ShadowRoot || root instanceof Element
          ? root.querySelector(selector) ?? document.querySelector(selector)
          : document.querySelector(selector);
      }

      function getSearchRoots() {
        const roots: Array<Document | ShadowRoot> = [document];

        for (let index = 0; index < roots.length; index += 1) {
          for (const element of Array.from(roots[index].querySelectorAll("*")) as HTMLElement[]) {
            if (element.shadowRoot) {
              roots.push(element.shadowRoot);
            }
          }
        }

        return roots;
      }

      function getElementById(id: string) {
        for (const root of roots) {
          const match = "getElementById" in root && typeof root.getElementById === "function"
            ? root.getElementById(id)
            : root.querySelector(`#${CSS.escape(id)}`);

          if (match) {
            return match;
          }
        }

        return null;
      }

      function isVisible(element: Element) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
      }

      function normalizeType(value: string) {
        const normalized = normalize(value);
        return normalized === "combobox" ? "select" : normalized || "text";
      }

      function normalizeSemantic(value: string) {
        return normalize(value)
          .replace(/\b(select an option|choose an option|please select|required|field required|none selected)\b/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }

      function normalizeId(value: string) {
        return normalize(value).replace(/\s+/g, "-").slice(0, 64) || "field";
      }

      function clean(value: string | null | undefined) {
        return (value ?? "").replace(/\s+/g, " ").replace(/\*/g, " ").trim();
      }

      function normalize(value: string | null | undefined) {
        return clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9+]+/g, " ").trim();
      }

      type VisibleField = {
        id: string;
        label: string;
        required: boolean;
        tagName: string;
        inputType: string;
        options: string[];
        context: string;
      };
    }).catch(() => []);

    allFields.push(...frameFields);
  }

  return allFields;
}

function mergeSeedFields(discovered: VisibleField[], seedFields: VisibleField[]) {
  const result = [...discovered];

  for (const seed of seedFields) {
    const seedKey = normalizeKey(`${seed.inputType}:${seed.label}`);
    const exists = result.some((field) => {
      const fieldKey = normalizeKey(`${field.inputType}:${field.label}`);
      return field.id === seed.id || fieldKey === seedKey || labelsOverlap(field.label, seed.label);
    });

    if (!exists) {
      result.push(seed);
    }
  }

  return result;
}

function dedupeV2Fields(fields: FillV2Field[]) {
  const byKey = new Map<string, FillV2Field>();

  for (const field of fields) {
    const key = field.intent !== "unknown"
      ? `${field.driver}:${field.intent}`
      : `${field.driver}:${normalizeKey(field.label)}`;
    const existing = byKey.get(key);

    if (!existing || scoreField(field) > scoreField(existing)) {
      byKey.set(key, {
        ...field,
        options: dedupeLabels(field.options)
      });
    }
  }

  return [...byKey.values()];
}

function classifyFillV2Field(field: VisibleField, adapterId: string): FillV2Field {
  const driver = inferDriver(field);
  const intent = inferIntent(field);
  const confidence = scoreIntentConfidence(field, intent);

  return {
    ...field,
    adapterId,
    driver,
    intent,
    confidence
  };
}

function inferIntent(field: Pick<VisibleField, "label" | "context" | "options" | "inputType">): FillV2Intent {
  const label = normalizeKey(field.label);
  const descriptor = normalizeKey(`${field.label} ${field.context} ${(field.options ?? []).join(" ")}`);

  if (/\b(email|e mail)\b/.test(descriptor) && /\b(confirm|verify|repeat|retype|again)\b/.test(descriptor)) return "confirm_email";
  if (/\b(first name|given name|forename|legal first)\b/.test(descriptor)) return "first_name";
  if (/\b(middle name|legal middle)\b/.test(descriptor)) return "middle_name";
  if (/\b(last name|surname|family name|legal last)\b/.test(descriptor)) return "last_name";
  if (label === "name" || /\b(full name|legal name|candidate name|your name)\b/.test(descriptor)) return "full_name";
  if (/\b(email|e mail)\b/.test(descriptor)) return "email";
  if (/^\+\d{1,4}$/.test(field.label.trim()) || /\b(phone|mobile|telephone|contact number|cell)\b/.test(descriptor)) return "phone";
  if (/\b(country|country region|country\/region|country of residence|currently reside)\b/.test(descriptor) && !/\bcity\b/.test(descriptor)) return "country";
  if (/\b(state|province|region|county)\b/.test(descriptor) && !/\bcountry\b/.test(label)) return "state";
  if (/\b(city|town|current location|current city|location|place of residence|residence)\b/.test(descriptor) && !/\bcountry\b/.test(label)) return "city";
  if (/\b(zip|postal|postcode|pin code|pincode)\b/.test(descriptor)) return "postal_code";
  if (/\b(address line 1|address 1|street address|primary address|address)\b/.test(descriptor) && !/\b(address line 2|address 2)\b/.test(descriptor)) return "address_1";
  if (/\b(address line 2|address 2|apartment|suite|flat)\b/.test(descriptor)) return "address_2";
  if (/\blinkedin|linked in\b/.test(descriptor)) return "linkedin";
  if (/\bgithub|git hub\b/.test(descriptor)) return "github";
  if (/\bportfolio\b/.test(descriptor)) return "portfolio";
  if (/\b(website|personal site|homepage|web site)\b/.test(descriptor)) return "website";
  if (/\b(expected|desired|target|asking|minimum)\b/.test(descriptor) && /\b(ctc|salary|compensation|package|pay)\b/.test(descriptor)) return "expected_ctc";
  if (/\b(current|present|existing|last|previous|annual)\b/.test(descriptor) && /\b(ctc|salary|compensation|package|pay)\b/.test(descriptor)) return "current_ctc";
  if (/\b(notice period|joining time|availability to join|available to join)\b/.test(descriptor)) return "notice_period";
  if (/\b(type of degree|degree type|education level|level of education)\b/.test(descriptor)) return "degree_type";
  if (/\b(degree name|degree|qualification|field of study|major)\b/.test(descriptor)) return "degree_name";
  if (/\b(university|college|institution|school)\b/.test(descriptor)) return "university";
  if (/\b(start date|start year|from date|education start)\b/.test(descriptor)) return "education_start";
  if (/\b(end date|completion date|graduation date|education end|to date)\b/.test(descriptor)) return "education_end";
  if (/\b(past working experience|prior work experience|work experience|employment experience|professional experience)\b/.test(descriptor)) return "work_experience_choice";
  if (/\b(company|employer|organization)\b/.test(descriptor) && /\b(work|experience|employment|current|previous)\b/.test(descriptor)) return "work_company";
  if (/\b(title|position|designation|job title)\b/.test(descriptor) && /\b(work|experience|employment|current|previous)\b/.test(descriptor)) return "work_title";
  if (/\b(current position|currently work here|i currently work)\b/.test(descriptor)) return "work_current_choice";
  if (/\b(start date|from date)\b/.test(descriptor) && /\b(work|experience|employment|company)\b/.test(descriptor)) return "work_start";
  if (/\b(end date|to date)\b/.test(descriptor) && /\b(work|experience|employment|company)\b/.test(descriptor)) return "work_end";
  if (/\b(talent network|career opportunities|job alerts|recruiting updates|marketing|newsletter|whatsapp|sms|text messages)\b/.test(descriptor)) return "marketing_opt_in";
  if (/\b(preferred name|different from your legal name)\b/.test(descriptor)) return "preferred_name_choice";
  if (/\b(privacy|terms|consent|agree|acknowledge|accept|declaration|data processing|read and understand)\b/.test(descriptor)) return "consent";
  if (/\b(work authorization|authorized to work|eligible to work|legally authorized)\b/.test(descriptor)) return "work_authorization";
  if (/\b(visa sponsorship|sponsorship|work permit|require sponsorship)\b/.test(descriptor)) return "sponsorship";
  if (/\b(relocat|travel|willing to move)\b/.test(descriptor)) return "relocation";
  if (isProseFieldDescriptor(descriptor, field.inputType)) return "prose";

  return "unknown";
}

function inferDriver(field: VisibleField): FillV2DriverKind {
  const inputType = normalizeKey(field.inputType);
  const descriptor = normalizeKey(`${field.label} ${field.context} ${field.tagName} ${inputType}`);

  if (inputType === "file" || field.tagName === "input" && inputType === "file") return "file";
  if (inputType === "radio" || inputType === "checkbox") return "choice";
  if (field.tagName === "select" || inputType === "select") return "native_select";
  if (inputType === "combobox" || inputType === "autocomplete" || /\b(select2|combobox|autocomplete|dropdown|listbox|select an option|choose an option)\b/.test(descriptor)) return "custom_select";
  if (inputType === "tel" || /\b(phone|mobile|telephone|contact number)\b/.test(descriptor) || /^\+\d{1,4}$/.test(field.label.trim())) return "phone";
  if (inputType === "textarea" || field.tagName === "textarea") return "textarea";
  if (inputType === "date" || /\b(date|dob)\b/.test(descriptor)) return "date";
  if (inputType === "number") return "number";
  if (inputType === "email") return "email";
  if (inputType === "contenteditable") return "contenteditable";

  return "text";
}

function isProseFieldDescriptor(descriptor: string, inputType: string) {
  return /\b(cover letter|motivation|why|summary|bio|about you|describe|explain|additional information|message|hiring team|comments?|anything else|let the company know|interest working there|interest in working there)\b/.test(descriptor)
    && !/\blinkedin|github|portfolio|website|url\b/.test(descriptor)
    && !["radio", "checkbox", "select", "combobox"].includes(normalizeKey(inputType));
}

function scoreIntentConfidence(field: VisibleField, intent: FillV2Intent) {
  if (intent === "unknown") {
    return 0.25;
  }

  if (field.required) {
    return 0.9;
  }

  return intent === "prose" ? 0.8 : 0.85;
}

function scoreField(field: FillV2Field) {
  return (field.required ? 20 : 0)
    + field.confidence * 50
    + (field.options.length > 0 ? 5 : 0)
    - Math.max(0, field.label.length - 60) / 10;
}

function labelsOverlap(left: string, right: string) {
  const leftTokens = new Set(normalizeKey(left).split(" ").filter((token) => token.length > 2));
  const rightTokens = new Set(normalizeKey(right).split(" ").filter((token) => token.length > 2));

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return false;
  }

  let overlap = 0;

  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap / Math.max(1, Math.min(leftTokens.size, rightTokens.size)) >= 0.75;
}

async function cleanupEmptyExperienceCards(input: FillV2Input, fields: FillV2Field[]) {
  if (profileHasWorkHistory(input) || !fields.some((field) => field.intent === "work_title" || field.intent === "work_start" || field.intent === "work_end")) {
    return false;
  }

  const result = await input.page.evaluate(() => {
    let removed = 0;
    const removedText: string[] = [];

    for (const card of findExperienceCards()) {
      if (removed > 2) {
        break;
      }

      const text = normalize(card.innerText || card.textContent || "");

      if (!/\b(title|position)\b/.test(text) || !/\b(from|start date)\b/.test(text) || !/\b(to|end date)\b/.test(text)) {
        continue;
      }

      const values = Array.from(card.querySelectorAll("input:not([type='hidden']), textarea, select"))
        .filter((control): control is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement => {
          return (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement) && isVisible(control);
        })
        .map((control) => control instanceof HTMLSelectElement ? control.value : control.value)
        .map((value) => normalize(value))
        .filter((value) => value && !/^(select|select an option|choose|none selected)$/.test(value));

      if (values.length > 0) {
        continue;
      }

      const action = Array.from(card.querySelectorAll("button, a, [role='button']"))
        .find((element): element is HTMLElement => {
          if (!(element instanceof HTMLElement) || !isVisible(element)) {
            return false;
          }

          return /\b(cancel|remove|delete|discard)\b/.test(normalize(element.innerText || element.textContent || element.getAttribute("aria-label") || ""));
        });

      if (!action) {
        continue;
      }

      action.click();
      removed += 1;
      removedText.push((card.innerText || card.textContent || "").replace(/\s+/g, " ").trim().slice(0, 220));
    }

    return { removed, removedText };

    function findExperienceCards() {
      const cards = new Set<HTMLElement>();

      for (const label of Array.from(document.querySelectorAll("label"))) {
        const text = normalize(label.textContent ?? "");

        if (!/\b(title|position|from|to|company)\b/.test(text)) {
          continue;
        }

        const card = label.closest("section, article, fieldset, [role='group'], [class*='card' i], [class*='experience' i], [data-testid*='experience' i]");

        if (card instanceof HTMLElement && isVisible(card)) {
          cards.add(card);
        }
      }

      return [...cards].sort((left, right) => (left.innerText || "").length - (right.innerText || "").length);
    }

    function isVisible(element: Element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
    }

    function normalize(value: string | null | undefined) {
      return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    }
  }).catch(() => ({ removed: 0, removedText: [] as string[] }));

  if (result.removed <= 0) {
    return false;
  }

  await input.page.waitForTimeout(250).catch(() => undefined);
  await writeBrowserDebug(input.workspacePath, "fill-v2-smartrecruiters-empty-experience-removed", {
    stageIndex: input.stageIndex,
    removed: result.removed,
    removedText: result.removedText
  });
  return true;
}

function profileHasWorkHistory(input: FillV2Input) {
  const details = input.student?.completeProfile;

  return Boolean(
    details?.currentCompany
    || details?.currentTitle
    || (details?.totalExperienceYears ?? 0) > 0
    || (details?.employmentHistory?.length ?? 0) > 0
  );
}

async function realType(locator: Locator, value: string) {
  const selectAll = process.platform === "darwin" ? "Meta+A" : "Control+A";
  await locator.click({ force: true, timeout: 700 });
  await locator.press(selectAll, { timeout: 350 }).catch(() => undefined);
  await locator.press("Backspace", { timeout: 350 }).catch(() => undefined);
  await locator.type(value, { delay: 6, timeout: Math.max(2000, value.length * 70) });
}

function cssEscape(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
