import type { Page } from "./browser-driver";
import type { VisibleField } from "./types";
import { dedupeLabels, normalizeKey, writeBrowserDebug } from "./util";
import type { Locator } from "./browser-driver";
import type {
  FillV2Adapter,
  FillV2DriverKind,
  FillV2Field,
  FillV2FieldSignature,
  FillV2Input,
  FillV2Intent,
  FillV2IntentCandidate,
  FillV2PortalPattern,
  FillV2ValueKind,
  FillV2WidgetKind
} from "./fill-engine";

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

export async function discoverStructuredVisibleFields(page: Page): Promise<VisibleField[]> {
  return discoverDomFields(page);
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
  const currentUrl = input.page.url();
  const fields = dedupeV2Fields(merged.map((field) => classifyFillV2Field(field, adapter.id, currentUrl, input.memory)));

  await writeBrowserDebug(input.workspacePath, "fill-v2-field-graph", {
    stageIndex: input.stageIndex,
    adapter: adapter.id,
    fieldCount: fields.length,
      fields: fields.map((field) => ({
        id: field.id,
        label: field.label,
        inputType: field.inputType,
        driver: field.driver,
        widgetKind: field.widgetKind,
        valueKind: field.valueKind,
        intent: field.intent,
        intentCandidates: field.intentCandidates.slice(0, 3),
        required: field.required,
        options: field.options.slice(0, 10),
        context: field.context.slice(0, 220),
        sectionLabel: field.sectionLabel,
        labelSource: field.labelSource,
        placeholder: field.placeholder,
        helpText: field.helpText,
        domPathSignature: field.domPathSignature,
        maxLength: field.maxLength,
        signature: field.signature,
        portalPattern: field.portalPattern
          ? {
              id: field.portalPattern.id,
              domain: field.portalPattern.domain,
              strategy: field.portalPattern.strategy,
              queryMode: field.portalPattern.queryMode,
              successCount: field.portalPattern.successCount
            }
          : undefined
      })).slice(0, 80)
    });

  return { adapter, fields };
}

async function discoverDomFields(page: Page): Promise<VisibleField[]> {
  const allFields: VisibleField[] = [];

  for (const frame of page.frames()) {
    const frameFields = await frame.evaluate(() => {
      const roots = getSearchRoots();
      clearPreviousFillV2Markers(roots);
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
        const labelDetails = isChoice
          ? findChoiceGroupLabelDetails(control) ?? findFieldLabelDetails(control)
          : findFieldLabelDetails(control);
        const rawLabel = labelDetails.text;
        const rawContext = findContext(control);
        const label = clean(rawLabel);
        const context = clean(rawContext);
        const helpText = clean(findHelpText(control));
        const sectionLabel = clean(findSectionLabel(control));

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
          required: isKnownOptionalField(label, context) ? false : isRequired(control, rawLabel, rawContext),
          tagName: control.tagName.toLowerCase(),
          inputType: inferInputType(control),
          options: getOptions(control, label),
          context,
          maxLength: inferMaxLength(control, `${rawLabel} ${rawContext}`),
          name: control.getAttribute("name") ?? undefined,
          placeholder: control.getAttribute("placeholder") ?? undefined,
          autocomplete: control.getAttribute("autocomplete") ?? undefined,
          ariaLabel: control.getAttribute("aria-label") ?? undefined,
          ariaDescribedBy: control.getAttribute("aria-describedby") ?? undefined,
          pattern: control.getAttribute("pattern") ?? undefined,
          inputMode: control.getAttribute("inputmode") ?? ("inputMode" in control ? (control as HTMLInputElement).inputMode || undefined : undefined),
          sectionLabel,
          helpText,
          labelSource: labelDetails.source,
          domPathSignature: buildDomPathSignature(control)
        });
      }

      mergeInferredQuestionFields(fields);

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

      function findFieldLabelDetails(control: Element): { text: string; source: string } {
        if (control.id) {
          const direct = queryFirst(`label[for="${CSS.escape(control.id)}"]`, control);

          if (direct?.textContent?.trim() && !isGenericLabel(direct.textContent)) {
            return { text: direct.textContent, source: "for" };
          }
        }

        const labelledBy = control.getAttribute("aria-labelledby");

        if (labelledBy) {
          const text = labelledBy
            .split(/\s+/)
            .map((id) => getElementById(id)?.textContent ?? "")
            .join(" ")
            .trim();

          if (text && !isGenericLabel(text)) {
            return { text, source: "aria-labelledby" };
          }
        }

        const nearestQuestion = nearbyQuestionLabel(control);
        const explicit = control.closest("label")?.textContent
          || control.getAttribute("aria-label")
          || control.getAttribute("placeholder")
          || control.closest("fieldset")?.querySelector("legend")?.textContent
          || "";

        if (nearestQuestion && (!explicit || isGenericLabel(explicit) || isChoiceOptionLabel(explicit))) {
          return { text: nearestQuestion, source: "question" };
        }

        if (explicit && !isGenericLabel(explicit)) {
          return {
            text: explicit,
            source: control.closest("label")?.textContent
              ? "wrapper"
              : control.getAttribute("aria-label")
                ? "aria-label"
                : control.getAttribute("placeholder")
                  ? "placeholder"
                  : "legend"
          };
        }

        const nearby = nearbyLabel(control);

        if (nearestQuestion) {
          return { text: nearestQuestion, source: "question" };
        }

        if (nearby) {
          return { text: nearby, source: "nearby" };
        }

        return { text: control.getAttribute("name") || "", source: "name" };
      }

      function findChoiceGroupLabelDetails(control: Element) {
        const fieldset = control.closest("fieldset");
        const legend = fieldset?.querySelector("legend")?.textContent;

        if (legend?.trim()) {
          return { text: legend, source: "legend" };
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
            return { text, source: "aria-labelledby" };
          }
        }

        const question = nearbyQuestionLabel(control);
        return question ? { text: question, source: "question" } : undefined;
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
        const container = findQuestionContainer(control)
          ?? control.closest("label, fieldset, [role='group'], [role='radiogroup'], [class*='field'], [class*='Field'], [class*='form'], section, article, div");
        const text = clean(container?.textContent ?? "");
        return text.length > 900 ? text.slice(0, 900) : text;
      }

      function findSectionLabel(control: Element) {
        const section = control.closest("fieldset, section, article, [role='group'], [role='radiogroup'], [class*='section' i], [class*='step' i], [class*='card' i]");

        if (!section) {
          return "";
        }

        const heading = section.querySelector("legend, h1, h2, h3, h4, [role='heading'], [class*='title' i], [class*='heading' i]");
        return clean(heading?.textContent ?? "");
      }

      function findHelpText(control: Element) {
        const describedBy = control.getAttribute("aria-describedby");

        if (describedBy) {
          const ariaText = describedBy
            .split(/\s+/)
            .map((id) => clean(getElementById(id)?.textContent ?? ""))
            .filter(Boolean)
            .join(" ");

          if (ariaText) {
            return ariaText;
          }
        }

        const container = control.closest("label, fieldset, [role='group'], [role='radiogroup'], [class*='field'], [class*='Field'], [class*='form'], section, article, div")
          ?? control.parentElement;

        if (!container) {
          return "";
        }

        const hints = Array.from(container.querySelectorAll("small, help-text, [class*='help' i], [class*='hint' i], [class*='description' i], [class*='assistive' i], [data-testid*='help' i]"))
          .map((item) => clean(item.textContent ?? ""))
          .filter((text) => text && text.length <= 260);

        const controlText = normalize(control.textContent ?? "");
        return hints.find((text) => normalize(text) !== controlText) ?? "";
      }

      function buildDomPathSignature(control: Element) {
        const parts: string[] = [];
        let current: Element | null = control;

        for (let depth = 0; depth < 5 && current; depth += 1) {
          const classes = (current.getAttribute("class") ?? "")
            .split(/\s+/)
            .map((name) => name.trim())
            .filter(Boolean)
            .slice(0, 2)
            .join(".");
          const role = current.getAttribute("role");
          const part = [
            current.tagName.toLowerCase(),
            current.id ? `#${current.id.slice(0, 24)}` : "",
            classes ? `.${classes}` : "",
            role ? `[role=${role}]` : ""
          ].join("");

          parts.push(part);
          current = current.parentElement;
        }

        return parts.join(" > ");
      }

      function inferInputType(control: HTMLElement) {
        if (control instanceof HTMLInputElement) {
          if (isSearchBackedInput(control)) {
            return "autocomplete";
          }

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

      function isSearchBackedInput(control: HTMLInputElement) {
        if (control.type && control.type !== "text" && control.type !== "search") {
          return false;
        }

        if (control.getAttribute("role") === "combobox" || control.getAttribute("aria-autocomplete") || control.getAttribute("aria-controls")) {
          return true;
        }

        const container = control.closest("[class*='field' i], [class*='input' i], [class*='autocomplete' i], [class*='question' i], [role='combobox'], div")
          ?? control.parentElement;

        if (!container) {
          return false;
        }

        const icons = Array.from(container.querySelectorAll([
          "spl-icon",
          "[class*='search' i]",
          "[aria-label*='search' i]",
          "button[type='button'] [class*='search' i]",
          "button[aria-label*='search' i] svg"
        ].join(","))) as HTMLElement[];
        const controlRect = control.getBoundingClientRect();

        return icons.some((icon) => {
          if (!isVisible(icon)) {
            return false;
          }

          const rect = icon.getBoundingClientRect();
          const verticalOverlap = Math.min(controlRect.bottom, rect.bottom) - Math.max(controlRect.top, rect.top);
          const nearRight = rect.left >= controlRect.left && rect.left <= controlRect.right + 48;

          return verticalOverlap > Math.min(controlRect.height, rect.height) * 0.35 && nearRight;
        });
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

      function inferMaxLength(control: HTMLElement, text: string) {
        const nativeMax = control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement
          ? control.maxLength
          : undefined;

        if (typeof nativeMax === "number" && nativeMax > 0 && nativeMax < 10000) {
          return nativeMax;
        }

        const match = text.match(/\b(?:\d+)\s*\/\s*(\d{1,5})\b/);
        const parsed = match?.[1] ? Number(match[1]) : undefined;

        return parsed && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
      }

      function choiceGroup(control: HTMLElement) {
        if (control instanceof HTMLInputElement && control.name) {
          const named = Array.from(document.querySelectorAll(`input[name="${CSS.escape(control.name)}"]`)) as HTMLElement[];
          const visibleNamed = named.filter((item) => isVisible(item) || hasVisibleChoiceTarget(item));

          if (visibleNamed.length > 1 && sameVisualQuestion(control, visibleNamed)) {
            return visibleNamed;
          }
        }

        return Array.from((findChoiceContainer(control) ?? control.closest("fieldset, [role='radiogroup'], [role='group']") ?? control.parentElement ?? control)
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
        const nearbyRequiredText = nearbyQuestionRawText(control);

        return (control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).required
          || control.getAttribute("aria-required") === "true"
          || hasFieldLocalRequiredMarker(label)
          || hasFieldLocalRequiredMarker(nearbyRequiredText)
          || Boolean(control.closest(".required, [class*='required'], [data-required='true']"))
          || /\b(this field is required|please select|please enter|cannot be blank)\b/i.test(`${context} ${nearbyRequiredText}`);
      }

      function hasFieldLocalRequiredMarker(value: string | null | undefined) {
        const raw = value ?? "";
        const normalized = normalize(raw);

        if (!raw || /\b(fields? marked|marked with|required fields?|all fields)\b/.test(normalized)) {
          return false;
        }

        return /\*/.test(raw) || /\b(required|this field is required)\b/.test(normalized);
      }

      function isNoise(label: string, context: string, control: HTMLElement) {
        const key = normalize(`${label} ${context}`);

        if (isGenericLabel(label) && !context) {
          return true;
        }

        if (/^(search|select an option|choose an option)$/i.test(label.trim()) && !/\b(country|city|location|state|degree)\b/.test(key)) {
          return true;
        }

        if (control.closest("[role='listbox'], [role='menu'], .iti__country-list, .iti__country, .cdk-overlay-pane, mat-option, [class*='option']")) {
          return true;
        }

        return /^(close|cancel|continue|submit|back|next|previous|remove|add another|save)$/i.test(label.trim());
      }

      function mergeInferredQuestionFields(items: VisibleField[]) {
        const questionElements = roots
          .flatMap((root) => Array.from(root.querySelectorAll("label, legend, h1, h2, h3, h4, p, span, div, strong, b"))) as HTMLElement[];
        questionElements.sort((left, right) => {
          const leftRect = left.getBoundingClientRect();
          const rightRect = right.getBoundingClientRect();
          return leftRect.top - rightRect.top || leftRect.left - rightRect.left;
        });

        const assignedControls = new WeakSet<HTMLElement>();
        const existingControls = new WeakSet<HTMLElement>();

        for (const item of items) {
          const control = findControlByV2Id(item.id);

          if (control && hasStableDirectLabel(item.label, item.context)) {
            existingControls.add(control);
          }
        }

        for (const element of questionElements) {
          if (!isVisible(element)) {
            continue;
          }

          const rawText = element.innerText || element.textContent || "";

          if (isCompositeQuestionElement(element, rawText)) {
            continue;
          }

          const label = cleanQuestionLabel(rawText);

          if (!isQuestionLabel(label, rawText)) {
            continue;
          }

          const control = findNearestQuestionControl(element, assignedControls, questionElements);

          if (!control || !isFillCandidate(control) || isNoise(label, "", control)) {
            continue;
          }

          const existingId = control.getAttribute("data-gradlaunch-v2-field-id")
            || control.getAttribute("data-gradlaunch-fast-field-id")
            || control.getAttribute("data-gradlaunch-field-id");
          const existing = existingId ? items.find((item) => item.id === existingId) : undefined;

          if (existing && existingControls.has(control)) {
            markQuestionControlAssigned(control, assignedControls);
            continue;
          }

          const id = existing?.id ?? `fill-v2-inferred-${items.length}-${normalizeId(label)}`;
          const context = clean(findContext(control) || rawText);
          const required = !isKnownOptionalField(label, context) && (hasFieldLocalRequiredMarker(rawText) || isRequired(control, rawText, context));

          control.setAttribute("data-gradlaunch-v2-field-id", id);
          markQuestionControlAssigned(control, assignedControls);

          const sameId = items.find((item) => item.id === id);

          if (sameId) {
            if (!hasStableDirectLabel(sameId.label, sameId.context) && isBetterInferredLabel(label, sameId.label)) {
              sameId.label = label;
              sameId.labelSource = "inferred_question";
            }

            sameId.required = sameId.required || required;
            sameId.context = sameId.context || context;

            if (sameId.options.length === 0) {
              sameId.options = getOptions(control, label);
            }

            sameId.maxLength = sameId.maxLength ?? inferMaxLength(control, `${rawText} ${context}`);
            sameId.helpText = sameId.helpText || clean(findHelpText(control));
            sameId.sectionLabel = sameId.sectionLabel || clean(findSectionLabel(control));
            sameId.name = sameId.name || control.getAttribute("name") || undefined;
            sameId.placeholder = sameId.placeholder || control.getAttribute("placeholder") || undefined;
            sameId.autocomplete = sameId.autocomplete || control.getAttribute("autocomplete") || undefined;
            sameId.ariaLabel = sameId.ariaLabel || control.getAttribute("aria-label") || undefined;
            sameId.ariaDescribedBy = sameId.ariaDescribedBy || control.getAttribute("aria-describedby") || undefined;
            sameId.pattern = sameId.pattern || control.getAttribute("pattern") || undefined;
            sameId.inputMode = sameId.inputMode || control.getAttribute("inputmode") || ("inputMode" in control ? (control as HTMLInputElement).inputMode || undefined : undefined);
            sameId.domPathSignature = sameId.domPathSignature || buildDomPathSignature(control);

            continue;
          }

          items.push({
            id,
            label,
            required,
            tagName: control.tagName.toLowerCase(),
            inputType: inferInputType(control),
            options: getOptions(control, label),
            context,
            maxLength: inferMaxLength(control, `${rawText} ${context}`),
            name: control.getAttribute("name") ?? undefined,
            placeholder: control.getAttribute("placeholder") ?? undefined,
            autocomplete: control.getAttribute("autocomplete") ?? undefined,
            ariaLabel: control.getAttribute("aria-label") ?? undefined,
            ariaDescribedBy: control.getAttribute("aria-describedby") ?? undefined,
            pattern: control.getAttribute("pattern") ?? undefined,
            inputMode: control.getAttribute("inputmode") ?? ("inputMode" in control ? (control as HTMLInputElement).inputMode || undefined : undefined),
            sectionLabel: clean(findSectionLabel(control)),
            helpText: clean(findHelpText(control)),
            labelSource: "inferred_question",
            domPathSignature: buildDomPathSignature(control)
          });
        }
      }

      function findControlByV2Id(id: string) {
        for (const root of roots) {
          const control = root.querySelector(`[data-gradlaunch-v2-field-id="${CSS.escape(id)}"], [data-gradlaunch-fast-field-id="${CSS.escape(id)}"], [data-gradlaunch-field-id="${CSS.escape(id)}"]`);

          if (control instanceof HTMLElement) {
            return control;
          }
        }

        return undefined;
      }

      function hasStableDirectLabel(label: string, context: string) {
        const normalized = normalize(label);

        if (!normalized || isGenericLabel(label)) {
          return false;
        }

        if (/^(yes|no|on|off|select|search|choose an option|select an option)$/.test(normalized)) {
          return false;
        }

        if (/\b(first name|last name|email|confirm your email|phone number|linkedin|facebook|twitter|website|city|country|region|resume|aadhar|aadhaar|ctc|notice period)\b/.test(normalized)) {
          return true;
        }

        const contextKey = normalize(context);
        return normalized.length >= 4 && contextKey.includes(normalized);
      }

      function markQuestionControlAssigned(control: HTMLElement, assignedControls: WeakSet<HTMLElement>) {
        assignedControls.add(control);

        if (isChoiceControl(control)) {
          for (const choice of choiceGroup(control)) {
            assignedControls.add(choice);
          }
        }
      }

      function isQuestionControlAssigned(control: HTMLElement, assignedControls: WeakSet<HTMLElement>) {
        if (assignedControls.has(control)) {
          return true;
        }

        return isChoiceControl(control) && choiceGroup(control).some((choice) => assignedControls.has(choice));
      }

      function findNearestQuestionControl(labelElement: HTMLElement, assignedControls: WeakSet<HTMLElement>, questionElements: HTMLElement[]) {
        if (labelElement instanceof HTMLLabelElement && labelElement.htmlFor) {
          const direct = getElementById(labelElement.htmlFor);

          if (direct instanceof HTMLElement && isFillCandidate(direct) && !isQuestionControlAssigned(direct, assignedControls)) {
            return direct;
          }
        }

        const nested = Array.from(labelElement.querySelectorAll("input, textarea, select, [contenteditable='true'], [role='combobox'], [role='radio'], [role='checkbox'], [aria-haspopup]"))
          .find((control): control is HTMLElement => control instanceof HTMLElement && isFillCandidate(control) && !isQuestionControlAssigned(control, assignedControls));

        if (nested) {
          return nested;
        }

        const blockControl = findQuestionBlockControl(labelElement, assignedControls, questionElements);

        if (blockControl) {
          return blockControl;
        }

        const sequential = findNextSequentialQuestionControl(labelElement, assignedControls, questionElements);

        if (sequential) {
          return sequential;
        }

        const labelRect = labelElement.getBoundingClientRect();
        let best: { control: HTMLElement; score: number } | undefined;
        let ancestor: Element | null = labelElement;

        for (let depth = 0; depth < 5 && ancestor; depth += 1) {
          const candidates = Array.from(ancestor.querySelectorAll("input, textarea, select, [contenteditable='true'], [role='combobox'], [role='radio'], [role='checkbox'], [aria-haspopup]"))
            .filter((control): control is HTMLElement => control instanceof HTMLElement && isFillCandidate(control) && !isQuestionControlAssigned(control, assignedControls));

          for (const control of candidates) {
            if (labelElement.contains(control)) {
              continue;
            }

            const score = scoreQuestionControl(labelRect, control.getBoundingClientRect(), depth);

            if (score > 0 && (!best || score > best.score)) {
              best = { control, score };
            }
          }

          const siblingControls = Array.from(ancestor.nextElementSibling?.querySelectorAll("input, textarea, select, [contenteditable='true'], [role='combobox'], [role='radio'], [role='checkbox'], [aria-haspopup]") ?? [])
            .filter((control): control is HTMLElement => control instanceof HTMLElement && isFillCandidate(control) && !isQuestionControlAssigned(control, assignedControls));

          for (const control of siblingControls) {
            const score = scoreQuestionControl(labelRect, control.getBoundingClientRect(), depth);

            if (score > 0 && (!best || score > best.score)) {
              best = { control, score };
            }
          }

          ancestor = ancestor.parentElement;
        }

        if (best) {
          return best.control;
        }

        for (const root of roots) {
          const controls = Array.from(root.querySelectorAll("input, textarea, select, [contenteditable='true'], [role='combobox'], [role='radio'], [role='checkbox'], [aria-haspopup]"))
            .filter((control): control is HTMLElement => control instanceof HTMLElement && isFillCandidate(control) && !isQuestionControlAssigned(control, assignedControls));

          for (const control of controls) {
            const score = scoreQuestionControl(labelRect, control.getBoundingClientRect(), 5);

            if (score > 0 && (!best || score > best.score)) {
              best = { control, score };
            }
          }
        }

        return best?.control;
      }

      function findNextSequentialQuestionControl(labelElement: HTMLElement, assignedControls: WeakSet<HTMLElement>, questionElements: HTMLElement[]) {
        const labelRect = labelElement.getBoundingClientRect();
        const nextQuestionTop = nextQuestionBoundaryTop(labelElement, labelRect, questionElements);
        let best: { control: HTMLElement; score: number } | undefined;

        for (const root of roots) {
          const controls = Array.from(root.querySelectorAll("input, textarea, select, [contenteditable='true'], [role='combobox'], [role='radio'], [role='checkbox'], [aria-haspopup]"))
            .filter((control): control is HTMLElement => control instanceof HTMLElement && isFillCandidate(control) && !isQuestionControlAssigned(control, assignedControls));

          for (const control of controls) {
            if (labelElement.contains(control)) {
              continue;
            }

            const rect = control.getBoundingClientRect();

            if (rect.bottom < labelRect.top - 8 || rect.top < labelRect.top - 16) {
              continue;
            }

            if (nextQuestionTop !== undefined && rect.top > nextQuestionTop - 6) {
              continue;
            }

            const horizontalDistance = rect.right < labelRect.left
              ? labelRect.left - rect.right
              : rect.left > labelRect.right
                ? rect.left - labelRect.right
                : 0;

            if (horizontalDistance > Math.max(420, labelRect.width * 3)) {
              continue;
            }

            const vertical = Math.max(0, rect.top - labelRect.bottom);
            const score = 260
              - vertical
              - Math.abs(rect.left - labelRect.left) / 5
              - Math.min(horizontalDistance / 4, 90);

            if (score > 0 && (!best || score > best.score)) {
              best = { control, score };
            }
          }
        }

        return best?.control;
      }

      function findQuestionBlockControl(labelElement: HTMLElement, assignedControls: WeakSet<HTMLElement>, questionElements: HTMLElement[]) {
        const labelRect = labelElement.getBoundingClientRect();
        let ancestor: Element | null = labelElement.parentElement;
        let best: { control: HTMLElement; score: number } | undefined;

        for (let depth = 0; depth < 6 && ancestor; depth += 1) {
          const controls = Array.from(ancestor.querySelectorAll("input, textarea, select, [contenteditable='true'], [role='combobox'], [role='radio'], [role='checkbox'], [aria-haspopup]"))
            .filter((control): control is HTMLElement => control instanceof HTMLElement && isFillCandidate(control) && !isQuestionControlAssigned(control, assignedControls));
          const localControls = controls.filter((control) => {
            if (labelElement.contains(control)) {
              return false;
            }

            const rect = control.getBoundingClientRect();

            if (rect.bottom < labelRect.top - 8 || rect.top > labelRect.bottom + 180) {
              return false;
            }

            return !hasInterveningQuestionLabel(labelElement, control, questionElements);
          });

          if (localControls.length > 0 && localControls.length <= 6) {
            for (const control of localControls) {
              const score = scoreQuestionControl(labelRect, control.getBoundingClientRect(), depth) + 35 - localControls.length * 4;

              if (score > 0 && (!best || score > best.score)) {
                best = { control, score };
              }
            }
          }

          ancestor = ancestor.parentElement;
        }

        return best?.control;
      }

      function hasInterveningQuestionLabel(labelElement: HTMLElement, control: HTMLElement, questionElements: HTMLElement[]) {
        const labelRect = labelElement.getBoundingClientRect();
        const controlRect = control.getBoundingClientRect();
        const lower = Math.min(labelRect.bottom, controlRect.top);
        const upper = Math.max(labelRect.bottom, controlRect.top);

        return questionElements.some((candidate) => {
          if (candidate === labelElement || candidate.contains(labelElement) || labelElement.contains(candidate) || candidate.contains(control) || !isVisible(candidate)) {
            return false;
          }

          const raw = candidate.innerText || candidate.textContent || "";
          const text = cleanQuestionLabel(raw);

          if (!isQuestionLabel(text, raw) || isCompositeQuestionElement(candidate, raw)) {
            return false;
          }

          const rect = candidate.getBoundingClientRect();
          return rect.top > lower + 3 && rect.top < upper - 3;
        });
      }

      function nextQuestionBoundaryTop(labelElement: HTMLElement, labelRect: DOMRect, questionElements: HTMLElement[]) {
        let best = Number.POSITIVE_INFINITY;

        for (const candidate of questionElements) {
          if (candidate === labelElement || candidate.contains(labelElement) || labelElement.contains(candidate) || !isVisible(candidate)) {
            continue;
          }

          const raw = candidate.innerText || candidate.textContent || "";
          const text = cleanQuestionLabel(raw);

          if (!isQuestionLabel(text, raw)) {
            continue;
          }

          const rect = candidate.getBoundingClientRect();

          if (rect.top > labelRect.top + 8 && rect.top < best) {
            best = rect.top;
          }
        }

        return Number.isFinite(best) ? best : undefined;
      }

      function scoreQuestionControl(labelRect: DOMRect, controlRect: DOMRect, depth: number) {
        const vertical = controlRect.top - labelRect.bottom;
        const sameRow = Math.abs(controlRect.top - labelRect.top) < 28;
        const below = vertical >= -16 && vertical <= 360;
        const horizontalOverlap = Math.min(labelRect.right, controlRect.right) - Math.max(labelRect.left, controlRect.left);
        const nearLeft = Math.abs(controlRect.left - labelRect.left) < 160;

        if (!sameRow && !below) {
          return 0;
        }

        if (horizontalOverlap < -80 && !nearLeft) {
          return 0;
        }

        return 200
          - Math.max(0, vertical)
          - Math.abs(controlRect.left - labelRect.left) / 4
          - depth * 12;
      }

      function isBetterInferredLabel(label: string, existingLabel: string) {
        const existing = normalize(existingLabel);
        const next = normalize(label);
        return Boolean(next)
          && next !== existing
          && (isGenericLabel(existingLabel)
            || existing.length < 4
            || existing === "yes"
            || existing === "no"
            || label.length > existingLabel.length && /\?|\b(ctc|experience|company|expertise|reason|location|notice|privacy)\b/.test(next));
      }

      function isKnownOptionalField(label: string, context: string) {
        const descriptor = normalize(`${label} ${context}`);
        return /\b(country code|country region code|search by country region or code|search by country\/region or code|dial code|phone code)\b/.test(descriptor)
          || /^(facebook|x fka twitter|twitter|website|personal website|portfolio website|github|instagram)$/.test(descriptor)
          || /\b(facebook|x fka twitter|twitter)\b/.test(descriptor);
      }

      function dedupeFields(items: VisibleField[]) {
        const byKey = new Map<string, VisibleField>();

        for (const item of items) {
          const key = normalizeSemantic(item.label);
          const existing = byKey.get(key);

          if (!existing || scoreVisibleField(item) > scoreVisibleField(existing)) {
            byKey.set(key, item);
          }
        }

        return [...byKey.values()];
      }

      function scoreVisibleField(item: VisibleField) {
        const label = normalize(item.label);
        const inputType = normalizeType(item.inputType);
        let score = 0;

        if (item.required) score += 20;
        if (!item.id.startsWith("fill-v2-inferred-")) score += 6;
        if (item.options.length > 0) score += 4;
        if (inputType === "radio" || inputType === "checkbox") score += 18;
        if (inputType === "autocomplete" || inputType === "combobox" || inputType === "select") score += 10;
        if (inputType === "textarea") score += 16;
        if (inputType === "text") score += 8;
        if (/\b(email|confirm your email)\b/.test(label) && inputType === "email") score += 42;
        if (/\b(phone number|phone|mobile|contact)\b/.test(label) && inputType === "tel") score += 42;

        if (/\b(reason|technical expertise|overall technical|tell us)\b/.test(label)) {
          if (inputType === "textarea" || inputType === "text") score += 35;
          if (inputType === "autocomplete" || inputType === "combobox" || inputType === "select") score -= 40;
        }

        if (/\b(total|overall|years?)\b/.test(label) && /\b(experience|exp)\b/.test(label) && !/\b(technical expertise|tell us)\b/.test(label)) {
          if (inputType === "autocomplete" || inputType === "combobox" || inputType === "select") score += 28;
        }

        if (/\b(work from office|hybrid|associated previously|previously associated|bond|obligation|shift|night|buyout|privacy|consent|agree|declaration)\b/.test(label)) {
          if (inputType === "radio" || inputType === "checkbox") score += 35;
          if (inputType === "autocomplete" || inputType === "combobox" || inputType === "select") score += 18;
        }

        return score - Math.max(0, item.label.length - 80) / 12;
      }

      function isChoiceControl(control: Element) {
        return control instanceof HTMLInputElement && ["radio", "checkbox"].includes(control.type)
          || control.getAttribute("role") === "radio"
          || control.getAttribute("role") === "checkbox";
      }

      function hasVisibleChoiceTarget(control: HTMLElement) {
        return Boolean(control.id && document.querySelector(`label[for="${CSS.escape(control.id)}"]`) && isVisible(document.querySelector(`label[for="${CSS.escape(control.id)}"]`)!));
      }

      function nearbyQuestionLabel(control: Element) {
        return cleanQuestionLabel(nearbyQuestionRawText(control));
      }

      function nearbyQuestionRawText(control: Element) {
        const owner = control instanceof HTMLElement ? control : control.parentElement;

        if (!owner) {
          return "";
        }

        const controlRect = owner.getBoundingClientRect();
        let best: { text: string; score: number } | undefined;

        for (const root of roots) {
          const candidates = Array.from(root.querySelectorAll("label, legend, h1, h2, h3, h4, p, span, div, strong, b")) as HTMLElement[];

          for (const candidate of candidates) {
            if (candidate === owner || candidate.contains(owner) || !isVisible(candidate)) {
              continue;
            }

            if (candidate.querySelector("input, textarea, select, [role='radio'], [role='checkbox'], [role='combobox']")) {
              continue;
            }

            const raw = candidate.innerText || candidate.textContent || "";
            const text = cleanQuestionLabel(raw);

            if (!isQuestionLabel(text, raw)) {
              continue;
            }

            const rect = candidate.getBoundingClientRect();

            if (rect.top > controlRect.bottom + 20) {
              continue;
            }

            const verticalDistance = rect.bottom <= controlRect.top
              ? controlRect.top - rect.bottom
              : Math.max(0, rect.top - controlRect.bottom);

            if (verticalDistance > 260) {
              continue;
            }

            const horizontalDistance = rect.right < controlRect.left
              ? controlRect.left - rect.right
              : rect.left > controlRect.right
                ? rect.left - controlRect.right
                : 0;

            if (horizontalDistance > Math.max(360, controlRect.width * 2.5)) {
              continue;
            }

            let score = 260 - verticalDistance - Math.min(horizontalDistance / 3, 90);

            if (/\*/.test(raw)) score += 45;
            if (/\?/.test(text)) score += 25;
            if (candidate.matches("label, legend")) score += 30;
            if (candidate.matches("h1, h2, h3, h4, p")) score += 12;
            if (isChoiceOptionLabel(text)) score -= 90;

            if (!best || score > best.score) {
              best = { text: raw, score };
            }
          }
        }

        return best?.text ?? "";
      }

      function findQuestionContainer(control: Element) {
        let current = control.parentElement;
        let best: Element | undefined;
        let bestScore = Number.NEGATIVE_INFINITY;

        for (let depth = 0; depth < 8 && current; depth += 1) {
          const controls = Array.from(current.querySelectorAll("input:not([type='hidden']), textarea, select, [role='radio'], [role='checkbox'], [role='combobox']"));

          if (controls.length > 0 && controls.length <= 10) {
            const text = cleanQuestionLabel(current.textContent ?? "");
            let score = 80 - depth * 8 - Math.min(text.length / 8, 80);

            if (/\*/.test(current.textContent ?? "")) score += 25;
            if (/\?/.test(text)) score += 14;
            if (current.matches("fieldset, [role='radiogroup'], [role='group'], section, article, [class*='question' i], [class*='field' i], [class*='input' i]")) score += 20;

            if (score > bestScore) {
              best = current;
              bestScore = score;
            }
          }

          current = current.parentElement;
        }

        return best;
      }

      function findChoiceContainer(control: HTMLElement) {
        let current = control.parentElement;
        let best: Element | undefined;
        let bestScore = Number.NEGATIVE_INFINITY;

        for (let depth = 0; depth < 8 && current; depth += 1) {
          const choices = Array.from(current.querySelectorAll("input[type='radio'], input[type='checkbox'], [role='radio'], [role='checkbox']")) as HTMLElement[];
          const visibleChoices = choices.filter((choice) => isVisible(choice) || hasVisibleChoiceTarget(choice));

          if (visibleChoices.length === 0 || visibleChoices.length > 8) {
            current = current.parentElement;
            continue;
          }

          const text = cleanQuestionLabel(current.textContent ?? "");
          let score = 90 - depth * 10 - Math.min(text.length / 10, 70);

          if (visibleChoices.length > 1) score += 35;
          if (/\*/.test(current.textContent ?? "")) score += 25;
          if (/\?/.test(text)) score += 14;
          if (current.matches("fieldset, [role='radiogroup'], [role='group'], [class*='question' i], [class*='radio' i], [class*='checkbox' i]")) score += 28;

          if (score > bestScore) {
            best = current;
            bestScore = score;
          }

          current = current.parentElement;
        }

        return best;
      }

      function sameVisualQuestion(control: HTMLElement, controls: HTMLElement[]) {
        const label = normalize(nearbyQuestionLabel(control));

        if (!label) {
          return true;
        }

        return controls.every((item) => {
          const itemLabel = normalize(nearbyQuestionLabel(item));
          return !itemLabel || itemLabel === label;
        });
      }

      function cleanQuestionLabel(value: string | null | undefined) {
        return clean(value)
          .replace(/\b\d+\s*\/\s*\d+\b/g, " ")
          .replace(/\b(required|optional)\b/gi, " ")
          .replace(/\s+/g, " ")
          .trim();
      }

      function isQuestionLabel(text: string, raw: string) {
        const normalized = normalize(text);

        if (!normalized || text.length > 180 || isGenericLabel(text) || isChoiceOptionLabel(text)) {
          return false;
        }

        if (countQuestionSignals(raw) > 1) {
          return false;
        }

        if (/\b(fields? marked|marked with|required fields?|all fields|this field is required|there are some errors|show details|select an option|choose an option|cannot find your city|click here|upload|drag and drop)\b/.test(normalized)) {
          return false;
        }

        return /\*/.test(raw)
          || /\?/.test(text)
          || /\b(experience|company|expertise|reason|location|office|hybrid|bond|obligation|associated|shift|night|notice period|ctc|salary|privacy|consent|authorization|sponsorship)\b/.test(normalized);
      }

      function isCompositeQuestionElement(element: HTMLElement, rawText: string) {
        if (element instanceof HTMLLabelElement) {
          return false;
        }

        if (element.querySelector("input, textarea, select, [role='radio'], [role='checkbox'], [role='combobox'], [aria-haspopup]")) {
          return true;
        }

        return countQuestionSignals(rawText) > 1;
      }

      function countQuestionSignals(rawText: string) {
        const text = normalize(rawText);
        const questionMarks = rawText.match(/\?/g)?.length ?? 0;
        const knownPrompts = [
          /\bwhat is your total experience\b/,
          /\breason for job change\b/,
          /\boverall technical expertise\b/,
          /\bpreferred work location\b/,
          /\bnotice period buyout\b/,
          /\bcurrent company\b/,
          /\bexpected ctc\b/,
          /\bcurrent ctc\b/,
          /\bwork from office\b/,
          /\bassociated previously\b/,
          /\bnight shifts?\b/,
          /\bbond\b/
        ].reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);

        return Math.max(questionMarks, knownPrompts);
      }

      function isGenericLabel(value: string | null | undefined) {
        return /^question[_-]?[a-f0-9-]{8,}$/i.test(clean(value))
          || /^spl-form-element[_-]?\d+$/i.test(clean(value))
          || /^field[_-]?\d+$/i.test(clean(value));
      }

      function isChoiceOptionLabel(value: string | null | undefined) {
        const normalized = normalize(value);
        return /^(yes|no|true|false|y|n|agree|i agree|accept|decline|none)$/.test(normalized);
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

      function clearPreviousFillV2Markers(roots: Array<Document | ShadowRoot>) {
        for (const root of roots) {
          for (const element of Array.from(root.querySelectorAll("[data-gradlaunch-v2-field-id]"))) {
            element.removeAttribute("data-gradlaunch-v2-field-id");
          }
        }
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
        maxLength?: number;
        name?: string;
        placeholder?: string;
        autocomplete?: string;
        ariaLabel?: string;
        ariaDescribedBy?: string;
        pattern?: string;
        inputMode?: string;
        sectionLabel?: string;
        helpText?: string;
        labelSource?: string;
        domPathSignature?: string;
      };
    }).catch(() => []);

    allFields.push(...frameFields);
  }

  return allFields;
}

function mergeSeedFields(discovered: VisibleField[], seedFields: VisibleField[]) {
  const result = [...discovered];

  for (const seed of seedFields) {
    const sameId = result.find((field) => field.id === seed.id);

    if (sameId) {
      if (shouldPreferSeedField(seed, sameId)) {
        sameId.label = seed.label;
        sameId.required = seed.required || sameId.required;
        sameId.tagName = seed.tagName || sameId.tagName;
        sameId.inputType = seed.inputType || sameId.inputType;
        sameId.options = seed.options.length > 0 ? seed.options : sameId.options;
        sameId.context = seed.context || sameId.context;
        sameId.maxLength = sameId.maxLength ?? seed.maxLength;
        sameId.name = seed.name || sameId.name;
        sameId.placeholder = seed.placeholder || sameId.placeholder;
        sameId.autocomplete = seed.autocomplete || sameId.autocomplete;
        sameId.ariaLabel = seed.ariaLabel || sameId.ariaLabel;
        sameId.ariaDescribedBy = seed.ariaDescribedBy || sameId.ariaDescribedBy;
        sameId.pattern = seed.pattern || sameId.pattern;
        sameId.inputMode = seed.inputMode || sameId.inputMode;
        sameId.sectionLabel = seed.sectionLabel || sameId.sectionLabel;
        sameId.helpText = seed.helpText || sameId.helpText;
        sameId.labelSource = seed.labelSource || sameId.labelSource;
        sameId.domPathSignature = seed.domPathSignature || sameId.domPathSignature;
      }

      continue;
    }

    const seedKey = normalizeKey(`${seed.inputType}:${seed.label}`);
    const existingIndex = result.findIndex((field) => {
      const fieldKey = normalizeKey(`${field.inputType}:${field.label}`);
      return fieldKey === seedKey || labelsOverlap(field.label, seed.label);
    });
    const existing = existingIndex >= 0 ? result[existingIndex] : undefined;

    if (existing && shouldPreferSeedField(seed, existing)) {
      result[existingIndex] = {
        ...existing,
        id: seed.id,
        label: seed.label,
        required: seed.required || existing.required,
        tagName: seed.tagName || existing.tagName,
        inputType: seed.inputType || existing.inputType,
        options: seed.options.length > 0 ? seed.options : existing.options,
        context: seed.context || existing.context,
        maxLength: existing.maxLength ?? seed.maxLength,
        name: seed.name || existing.name,
        placeholder: seed.placeholder || existing.placeholder,
        autocomplete: seed.autocomplete || existing.autocomplete,
        ariaLabel: seed.ariaLabel || existing.ariaLabel,
        ariaDescribedBy: seed.ariaDescribedBy || existing.ariaDescribedBy,
        pattern: seed.pattern || existing.pattern,
        inputMode: seed.inputMode || existing.inputMode,
        sectionLabel: seed.sectionLabel || existing.sectionLabel,
        helpText: seed.helpText || existing.helpText,
        labelSource: seed.labelSource || existing.labelSource,
        domPathSignature: seed.domPathSignature || existing.domPathSignature
      };
      continue;
    }

    if (!existing) {
      result.push(seed);
    }
  }

  return result;
}

function shouldPreferSeedField(seed: VisibleField, discovered: VisibleField) {
  const seedLabel = normalizeKey(seed.label);
  const discoveredLabel = normalizeKey(discovered.label);
  const seedType = normalizeKey(seed.inputType);
  const discoveredType = normalizeKey(discovered.inputType);

  if (!seedLabel) {
    return false;
  }

  if (discovered.id.startsWith("fill-v2-inferred-") && !seed.id.startsWith("fill-v2-inferred-")) {
    if (seedLabel === discoveredLabel || labelsOverlap(seed.label, discovered.label)) {
      return true;
    }
  }

  if (/\b(email|confirm your email|phone number)\b/.test(seedLabel)) {
    if (seedType === "email" && discoveredType !== "email") {
      return true;
    }

    if (seedType === "tel" && discoveredType !== "tel") {
      return true;
    }
  }

  if (!discoveredLabel || isWeakDiscoveredLabel(discoveredLabel)) {
    return true;
  }

  if (isAuthoritativeSeedLabel(seedLabel) && !isAuthoritativeSeedLabel(discoveredLabel)) {
    return true;
  }

  if (isAuthoritativeSeedLabel(seedLabel) && seedLabel !== discoveredLabel && !labelsOverlap(seed.label, discovered.label)) {
    return true;
  }

  return false;
}

function isAuthoritativeSeedLabel(label: string) {
  return /\b(first name|last name|email|confirm your email|phone number|linkedin|facebook|x fka twitter|twitter|website|city|country|country region|country code|state|aadhar|aadhaar|expected ctc|current ctc|notice period|notice period buyout)\b/.test(label);
}

function isWeakDiscoveredLabel(label: string) {
  return /^(yes|no|on|off|search|select|select an option|choose an option|experience add|education add|add|resume|personal information)$/.test(label)
    || /\b(experience add|education add|fields marked with are required|choose an option to autocomplete)\b/.test(label);
}

function dedupeV2Fields(fields: FillV2Field[]) {
  const byKey = new Map<string, FillV2Field>();

  for (const field of fields) {
    const key = dedupeFillV2FieldKey(field);
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

function dedupeFillV2FieldKey(field: FillV2Field) {
  const label = normalizeKey(field.label);

  if (!label) {
    return `${field.driver}:${field.id}`;
  }

  if (field.intent === "unknown") {
    return `unknown:${label}`;
  }

  return `${field.intent}:${label}`;
}

function classifyFillV2Field(field: VisibleField, adapterId: string, currentUrl: string, memory?: FillV2Input["memory"]): FillV2Field {
  const intentCandidates = inferIntentCandidates(field);
  const intent = intentCandidates[0]?.intent ?? "unknown";
  const widgetKind = inferWidgetKind(field);
  const valueKind = inferValueKind(field, intentCandidates, widgetKind);
  const signature = buildFieldSignature(field, widgetKind, valueKind, intentCandidates);
  const portalPattern = matchPortalPattern(memory?.portalPatterns ?? [], currentUrl, field, signature);
  const driver = inferDriver(field, intent, widgetKind);
  const confidence = scoreIntentConfidence(field, intentCandidates);

  return {
    ...field,
    adapterId,
    driver,
    intent,
    confidence,
    widgetKind,
    valueKind,
    intentCandidates,
    signature,
    portalPattern
  };
}

function matchPortalPattern(
  patterns: FillV2PortalPattern[],
  currentUrl: string,
  field: VisibleField,
  signature: FillV2FieldSignature
) {
  const currentHost = hostFromUrl(currentUrl);
  const label = normalizeKey(field.label);
  let best: { pattern: FillV2PortalPattern; score: number } | undefined;

  for (const pattern of patterns) {
    if (!pattern.domain || !currentHost || !hostMatches(currentHost, pattern.domain)) {
      continue;
    }

    let score = 0;

    if (pattern.urlPattern && currentUrl.includes(pattern.urlPattern)) score += 35;
    if (pattern.normalizedLabel && pattern.normalizedLabel === label) score += 55;
    else if (pattern.fieldLabel && labelsOverlap(pattern.fieldLabel, field.label)) score += 38;
    if (pattern.autocomplete && normalizeKey(pattern.autocomplete) === normalizeKey(field.autocomplete)) score += 24;
    if (pattern.widgetKind && normalizeKey(pattern.widgetKind) === normalizeKey(signature.widgetKind)) score += 18;
    if (pattern.valueKind && normalizeKey(pattern.valueKind) === normalizeKey(signature.valueKind)) score += 18;
    if (pattern.domPathSignature && field.domPathSignature && normalizeKey(field.domPathSignature).includes(normalizeKey(pattern.domPathSignature))) score += 14;
    score += Math.min(pattern.successCount, 10);

    if (!best || score > best.score) {
      best = { pattern, score };
    }
  }

  return best && best.score >= 50 ? best.pattern : undefined;
}

function hostFromUrl(value: string) {
  try {
    return new URL(value).hostname.replace(/^www\./i, "").toLowerCase();
  } catch (_error) {
    return "";
  }
}

function hostMatches(currentHost: string, patternDomain: string) {
  const desired = patternDomain.replace(/^www\./i, "").toLowerCase();
  return currentHost === desired || currentHost.endsWith(`.${desired}`);
}

function inferIntentCandidates(field: VisibleField): FillV2IntentCandidate[] {
  const label = normalizeKey(field.label);
  const descriptor = buildIntentDescriptor(field);
  const autocomplete = normalizeKey(field.autocomplete);
  const name = normalizeKey(field.name);
  const helpText = normalizeKey(field.helpText);
  const inputType = normalizeKey(field.inputType);
  const inputMode = normalizeKey(field.inputMode);
  const scores = new Map<FillV2Intent, { score: number; reasons: Set<string> }>();
  const add = (intent: FillV2Intent, score: number, reason: string) => {
    const existing = scores.get(intent) ?? { score: 0, reasons: new Set<string>() };
    existing.score += score;
    existing.reasons.add(reason);
    scores.set(intent, existing);
  };

  if (inputType === "email" || autocomplete.includes("email")) add("email", 55, "Native email signal.");
  if (inputType === "tel" || inputMode === "tel" || autocomplete.includes("tel")) add("phone", 55, "Native phone signal.");
  if (inputType === "date" || autocomplete.includes("bday")) add("education_end", 10, "Date-like control.");
  if (inputType === "number" || /\b(numeric|decimal)\b/.test(inputMode)) {
    add("total_experience", 18, "Numeric input can hold experience values.");
    add("current_ctc", 12, "Numeric input can hold compensation.");
    add("expected_ctc", 12, "Numeric input can hold compensation.");
  }

  if (/\b(email|e mail)\b/.test(label) && /\b(confirm|verify|repeat|retype|again)\b/.test(label)) add("confirm_email", 95, "Label explicitly asks to confirm email.");
  if (/\bfirst name|given name|forename|legal first\b/.test(label)) add("first_name", 95, "Label explicitly matches first name.");
  if (/\bmiddle name|legal middle\b/.test(label)) add("middle_name", 95, "Label explicitly matches middle name.");
  if (/\blast name|surname|family name|legal last\b/.test(label)) add("last_name", 95, "Label explicitly matches last name.");
  if (label === "name" || /\bfull name|legal name|candidate name|your name\b/.test(label)) add("full_name", 92, "Label explicitly asks for full name.");
  if (/^email$/.test(label) || /\b(email|e mail)\b/.test(label)) add("email", 78, "Label references email.");
  if (/^\+\d{1,4}$/.test(field.label.trim()) || /\b(country code|dial code|phone code|phone country code)\b/.test(label)) add("country", 84, "Label looks like phone country code.");
  if (/\b(phone number|phone|mobile|telephone|contact number|cell)\b/.test(label)) add("phone", 88, "Label explicitly references phone.");
  if (/^(country|country region|country region code|country of residence)$/.test(label) || /\bcountry\/region\b/.test(label)) add("country", 88, "Label explicitly references country.");
  if (/^(state|province|region|county)$/.test(label)) add("state", 88, "Label explicitly references state or province.");
  if (/^(city|town|current city|location city)$/.test(label)) add("city", 88, "Label explicitly references city.");
  if (/\blinkedin|linked in\b/.test(label)) add("linkedin", 90, "Label explicitly references LinkedIn.");
  if (/\bgithub|git hub\b/.test(label)) add("github", 90, "Label explicitly references GitHub.");
  if (/\bportfolio\b/.test(label)) add("portfolio", 90, "Label explicitly references portfolio.");
  if (/^(website|personal website|personal site|homepage|web site)$/.test(label)) add("website", 88, "Label explicitly references website.");
  if (/\b(expected|desired|target|asking|minimum)\b/.test(label) && /\b(ctc|salary|compensation|package|pay)\b/.test(label)) add("expected_ctc", 92, "Label explicitly references expected compensation.");
  if (/\b(current|present|existing|last|previous|annual)\b/.test(label) && /\b(ctc|salary|compensation|package|pay)\b/.test(label)) add("current_ctc", 92, "Label explicitly references current compensation.");
  if (/\bnotice period buyout|notice buyout|buyout\b/.test(label)) add("notice_buyout_choice", 90, "Label explicitly references notice buyout.");
  if (/\b(rotational|night shifts?|shifts?)\b/.test(label)) add("shift_flexibility_choice", 78, "Label explicitly references shift flexibility.");
  if (/\b(associated previously|previously associated|worked previously|previously worked)\b/.test(label)) add("previous_employer_choice", 82, "Label explicitly references prior employment with this company.");
  if (/\b(work from office|office hybrid|hybrid model|work from office hybrid)\b/.test(label)) add("office_work_choice", 82, "Label explicitly references office work preference.");
  if (/\b(bond|obligation)\b/.test(label)) add("bond_obligation_choice", 80, "Label explicitly references bond or obligation.");
  if (/\bpreferred\b/.test(label) && /\b((work )?location|city)\b/.test(label)) add("preferred_work_location", 88, "Label explicitly references preferred work location.");
  if (/\bwork location\b/.test(label) && !/\bcurrent\b/.test(label)) add("preferred_work_location", 76, "Label references desired work location.");
  if (/\bcurrent company|current employer|current organization\b/.test(label)) add("work_company", 82, "Label explicitly references current company.");
  if (/\baadhaar|aadhar|pan card|government id|national id|identity number\b/.test(label)) add("government_id", 88, "Label explicitly references government identifier.");
  if (/\b(privacy|terms|consent|agree|acknowledge|accept|declaration|data processing|read and understand)\b/.test(label)) add("consent", 88, "Label explicitly references consent.");

  if (/\b(email|e mail)\b/.test(descriptor) && /\b(confirm|verify|repeat|retype|again)\b/.test(descriptor)) add("confirm_email", 50, "Context references confirmation email.");
  if (/\b(first name|given name|forename|legal first)\b/.test(descriptor)) add("first_name", 48, "Context references first name.");
  if (/\b(middle name|legal middle)\b/.test(descriptor)) add("middle_name", 48, "Context references middle name.");
  if (/\b(last name|surname|family name|legal last)\b/.test(descriptor)) add("last_name", 48, "Context references last name.");
  if (label === "name" || /\b(full name|legal name|candidate name|your name)\b/.test(descriptor)) add("full_name", 46, "Context references full name.");
  if (/\b(email|e mail)\b/.test(descriptor)) add("email", 36, "Context references email.");
  if (/^\+\d{1,4}$/.test(field.label.trim()) || /\b(phone|mobile|telephone|contact number|cell)\b/.test(descriptor)) add("phone", 36, "Context references phone.");
  if (/\b(country|country region|country\/region|country of residence|currently reside)\b/.test(descriptor) && !/\bcity\b/.test(descriptor)) add("country", 42, "Context references country.");
  if (/\b(state|province|region|county)\b/.test(descriptor) && !/\bcountry\b/.test(label)) add("state", 42, "Context references state or province.");
  if (/\bpreferred\b/.test(descriptor) && /\b((work )?location|city)\b/.test(descriptor)) add("preferred_work_location", 44, "Context references preferred location.");
  if (/\bwork location\b/.test(descriptor) && !/\bcurrent\b/.test(descriptor)) add("preferred_work_location", 38, "Context references work location.");
  if (/\b(city|town|current location|current city|location city|place of residence|residence)\b/.test(descriptor) && !/\bcountry\b/.test(label)) add("city", 40, "Context references city or current location.");
  if (/\b(zip|postal|postcode|pin code|pincode)\b/.test(descriptor)) add("postal_code", 60, "Context references postal code.");
  if (/\b(address line 1|address 1|street address|primary address|address)\b/.test(descriptor) && !/\b(address line 2|address 2)\b/.test(descriptor)) add("address_1", 58, "Context references primary address.");
  if (/\b(address line 2|address 2|apartment|suite|flat)\b/.test(descriptor)) add("address_2", 58, "Context references secondary address.");
  if (/\blinkedin|linked in\b/.test(descriptor)) add("linkedin", 60, "Context references LinkedIn.");
  if (/\bgithub|git hub\b/.test(descriptor)) add("github", 60, "Context references GitHub.");
  if (/\bportfolio\b/.test(descriptor)) add("portfolio", 60, "Context references portfolio.");
  if (/\b(website|personal site|homepage|web site)\b/.test(descriptor)) add("website", 58, "Context references website.");
  if (/\b(expected|desired|target|asking|minimum)\b/.test(descriptor) && /\b(ctc|salary|compensation|package|pay)\b/.test(descriptor)) add("expected_ctc", 65, "Context references expected compensation.");
  if (/\b(current|present|existing|last|previous|annual)\b/.test(descriptor) && /\b(ctc|salary|compensation|package|pay)\b/.test(descriptor)) add("current_ctc", 65, "Context references current compensation.");
  if (/\baadhaar|aadhar|pan card|government id|national id|identity number\b/.test(descriptor)) add("government_id", 60, "Context references government identifier.");
  if (/\bnotice period buyout|notice buyout|buyout\b/.test(descriptor)) add("notice_buyout_choice", 62, "Context references notice buyout.");
  if (/\b(notice period|joining time|availability to join|available to join)\b/.test(descriptor)) add("notice_period", 64, "Context references notice period.");
  if (/\b(total|overall|years?)\b/.test(descriptor) && /\b(experience|exp)\b/.test(descriptor) && !/\b(technical expertise|describe|tell us|summary)\b/.test(descriptor)) add("total_experience", 66, "Context references total experience.");
  if (/\b(type of degree|degree type|education level|level of education)\b/.test(descriptor)) add("degree_type", 68, "Context references degree type.");
  if (/\b(degree name|degree|qualification|field of study|major)\b/.test(descriptor)) add("degree_name", 55, "Context references degree.");
  if (/\b(university|college|institution|school)\b/.test(descriptor)) add("university", 56, "Context references university or school.");
  if (/\b(start date|start year|from date|education start)\b/.test(descriptor)) add("education_start", 58, "Context references education start date.");
  if (/\b(end date|completion date|graduation date|education end|to date)\b/.test(descriptor)) add("education_end", 58, "Context references education end date.");
  if (/\b(past working experience|prior work experience|work experience|employment experience|professional experience)\b/.test(descriptor)) add("work_experience_choice", 56, "Context references work experience choice.");
  if (/\b(rotational|night shifts?|shifts?)\b/.test(descriptor)) add("shift_flexibility_choice", 52, "Context references shift flexibility.");
  if (/\b(work from office|office hybrid|hybrid model|work from office hybrid)\b/.test(descriptor)) add("office_work_choice", 52, "Context references office work preference.");
  if (/\b(bond|obligation)\b/.test(descriptor)) add("bond_obligation_choice", 52, "Context references bond or obligation.");
  if (/\b(associated previously|previously associated|worked previously|previously worked)\b/.test(descriptor)) add("previous_employer_choice", 54, "Context references previous employer status.");
  if (/\b(company|employer|organization)\b/.test(descriptor) && /\b(work|experience|employment|current|previous)\b/.test(descriptor)) add("work_company", 60, "Context references work company.");
  if (/\b(title|position|designation|job title)\b/.test(descriptor) && /\b(work|experience|employment|current|previous)\b/.test(descriptor)) add("work_title", 60, "Context references work title.");
  if (/\b(current position|currently work here|i currently work)\b/.test(descriptor)) add("work_current_choice", 58, "Context references whether the user currently works there.");
  if (/\b(start date|from date)\b/.test(descriptor) && /\b(work|experience|employment|company)\b/.test(descriptor)) add("work_start", 58, "Context references work start date.");
  if (/\b(end date|to date)\b/.test(descriptor) && /\b(work|experience|employment|company)\b/.test(descriptor)) add("work_end", 58, "Context references work end date.");
  if (/\b(talent network|career opportunities|job alerts|recruiting updates|marketing|newsletter|whatsapp|sms|text messages)\b/.test(descriptor)) add("marketing_opt_in", 60, "Context references marketing opt-in.");
  if (/\b(preferred name|different from your legal name)\b/.test(descriptor)) add("preferred_name_choice", 58, "Context references preferred-name choice.");
  if (/\b(privacy|terms|consent|agree|acknowledge|accept|declaration|data processing|read and understand)\b/.test(descriptor)) add("consent", 64, "Context references consent.");
  if (/\b(work authorization|authorized to work|eligible to work|legally authorized)\b/.test(descriptor)) add("work_authorization", 64, "Context references work authorization.");
  if (/\b(visa sponsorship|sponsorship|work permit|require sponsorship)\b/.test(descriptor)) add("sponsorship", 64, "Context references sponsorship.");
  if (/\b(relocat|travel|willing to move)\b/.test(descriptor)) add("relocation", 56, "Context references relocation.");
  if (isProseFieldDescriptor(descriptor, field.inputType)) add("prose", 62, "Field looks like prose input.");

  if (autocomplete.includes("given-name")) add("first_name", 72, "Autocomplete suggests given name.");
  if (autocomplete.includes("additional-name")) add("middle_name", 72, "Autocomplete suggests additional name.");
  if (autocomplete.includes("family-name")) add("last_name", 72, "Autocomplete suggests family name.");
  if (autocomplete.includes("name")) add("full_name", 38, "Autocomplete suggests full name.");
  if (autocomplete.includes("address-level2")) add("city", 60, "Autocomplete suggests city.");
  if (autocomplete.includes("address-level1")) add("state", 60, "Autocomplete suggests state.");
  if (autocomplete.includes("country")) add("country", 72, "Autocomplete suggests country.");
  if (autocomplete.includes("postal-code")) add("postal_code", 72, "Autocomplete suggests postal code.");
  if (autocomplete.includes("street-address") || autocomplete.includes("address-line1")) add("address_1", 72, "Autocomplete suggests street address.");

  if (/\b(upload|resume|cv)\b/.test(helpText) && /\bmessage|comments?\b/.test(label)) add("prose", 8, "Help text hints at a free-form response.");
  if (/\b(phone|mobile)\b/.test(name) && !/\bcountry\b/.test(name)) add("phone", 24, "Control name hints at phone.");
  if (/\bcity|location\b/.test(name) && !/\bcountry\b/.test(name)) add("city", 20, "Control name hints at city or location.");
  if (/\bcountry\b/.test(name)) add("country", 22, "Control name hints at country.");
  if (/\bstate|province|region\b/.test(name)) add("state", 22, "Control name hints at state.");
  if (/\bctc|salary|compensation\b/.test(name)) {
    add("current_ctc", 18, "Control name hints at compensation.");
    add("expected_ctc", 18, "Control name hints at compensation.");
  }
  if (/\bexp|experience\b/.test(name)) add("total_experience", 18, "Control name hints at experience.");

  if (hasYesNoOptions(field.options)) {
    add("consent", /\bprivacy|terms|consent|declaration\b/.test(descriptor) ? 18 : 0, "Yes/No options align with consent.");
    add("work_authorization", /\bauthorized|eligible to work\b/.test(descriptor) ? 18 : 0, "Yes/No options align with work authorization.");
    add("sponsorship", /\bsponsorship|permit|visa\b/.test(descriptor) ? 18 : 0, "Yes/No options align with sponsorship.");
  }

  const ranked = [...scores.entries()]
    .filter(([, value]) => value.score > 0)
    .map(([intent, value]) => ({
      intent,
      score: value.score,
      reasons: [...value.reasons]
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 3);

  if (ranked.length === 0) {
    return [{ intent: "unknown", score: 12, reasons: ["No strong semantic signals found."] }];
  }

  if (ranked[0].score < 36) {
    ranked.push({ intent: "unknown", score: 18, reasons: ["Top signal is weak, so keep unknown as a fallback."] });
  }

  return ranked.slice(0, 3);
}

function buildIntentDescriptor(field: VisibleField) {
  return normalizeKey([
    field.label,
    field.context,
    field.sectionLabel,
    field.helpText,
    field.placeholder,
    field.ariaLabel,
    field.name,
    field.autocomplete,
    field.pattern,
    field.inputMode,
    field.options.join(" ")
  ].filter(Boolean).join(" "));
}

function inferWidgetKind(field: VisibleField): FillV2WidgetKind {
  const inputType = normalizeKey(field.inputType);
  const descriptor = normalizeKey(`${field.tagName} ${field.inputType} ${field.placeholder} ${field.ariaLabel} ${field.domPathSignature}`);

  if (inputType === "file" || field.tagName === "input" && inputType === "file") return "file_input";
  if (inputType === "radio" || inputType === "checkbox") return "choice_group";
  if (field.tagName === "select" || inputType === "select") return "native_select";
  if (inputType === "autocomplete") return "autocomplete";
  if (inputType === "combobox" || /\bcombobox|listbox|dropdown|select2\b/.test(descriptor)) return "combobox";
  if (inputType === "textarea" || field.tagName === "textarea") return "textarea";
  if (inputType === "contenteditable") return "contenteditable";
  if (inputType === "email") return "email_input";
  if (inputType === "tel" || /\bphone|mobile|telephone|contact number\b/.test(descriptor)) return "phone_input";
  if (inputType === "date") return "date_input";
  if (inputType === "number" || /\bnumeric|decimal\b/.test(normalizeKey(field.inputMode))) return "numeric_input";
  if (inputType === "text" || inputType === "search") return "text_input";

  return "unknown";
}

function inferValueKind(
  field: VisibleField,
  intentCandidates: FillV2IntentCandidate[],
  widgetKind: FillV2WidgetKind
): FillV2ValueKind {
  const topIntent = intentCandidates[0]?.intent ?? "unknown";

  if (["first_name", "middle_name", "last_name", "full_name"].includes(topIntent)) return "name";
  if (["email", "confirm_email"].includes(topIntent)) return "email";
  if (topIntent === "phone") return "phone";
  if (topIntent === "country") return "country";
  if (["state", "city", "preferred_work_location", "postal_code", "address_1", "address_2"].includes(topIntent)) return "location";
  if (["current_ctc", "expected_ctc"].includes(topIntent)) return "money";
  if (["notice_period", "total_experience"].includes(topIntent)) return "experience";
  if (["education_start", "education_end", "work_start", "work_end"].includes(topIntent)) return "date";
  if (["consent", "marketing_opt_in", "preferred_name_choice", "work_experience_choice", "work_current_choice", "office_work_choice", "bond_obligation_choice", "previous_employer_choice", "shift_flexibility_choice", "notice_buyout_choice"].includes(topIntent)) return "yes_no";
  if (["work_authorization", "sponsorship", "relocation"].includes(topIntent)) return "authorization";
  if (["linkedin", "github", "portfolio", "website"].includes(topIntent)) return "url";
  if (topIntent === "prose") return "prose";
  if (topIntent === "government_id") return "identifier";
  if (widgetKind === "email_input") return "email";
  if (widgetKind === "phone_input") return "phone";
  if (widgetKind === "date_input") return "date";
  if (widgetKind === "numeric_input") return "number";
  if (widgetKind === "choice_group" || widgetKind === "native_select" || widgetKind === "combobox" || widgetKind === "autocomplete") return "choice";

  return "text";
}

function buildFieldSignature(
  field: VisibleField,
  widgetKind: FillV2WidgetKind,
  valueKind: FillV2ValueKind,
  intentCandidates: FillV2IntentCandidate[]
): FillV2FieldSignature {
  return {
    semanticLabel: intentCandidates[0]?.intent === "unknown"
      ? field.label
      : intentCandidates[0].intent.replace(/_/g, " "),
    normalizedLabel: normalizeKey([
      field.label,
      field.placeholder,
      field.ariaLabel,
      field.name
    ].filter(Boolean).join(" ")),
    section: normalizeKey(field.sectionLabel),
    widgetKind,
    valueKind,
    expectedFormat: inferExpectedFormat(field, valueKind),
    options: field.options.slice(0, 20)
  };
}

function inferExpectedFormat(field: VisibleField, valueKind: FillV2ValueKind) {
  if (valueKind === "phone") return field.pattern ?? field.autocomplete ?? "phone digits";
  if (valueKind === "email") return field.pattern ?? "email";
  if (valueKind === "money") return field.pattern ?? "numeric salary";
  if (valueKind === "date") return field.pattern ?? "date";
  if (valueKind === "country") return "country option";
  if (valueKind === "choice" || valueKind === "yes_no") return "option match";
  if (field.maxLength) return `max ${field.maxLength} chars`;
  return undefined;
}

function inferDriver(field: VisibleField, intent: FillV2Intent, widgetKind: FillV2WidgetKind): FillV2DriverKind {
  if (widgetKind === "file_input") return "file";
  if (widgetKind === "choice_group") return "choice";
  if (intent === "prose") {
    if (widgetKind === "textarea") return "textarea";
    if (widgetKind === "contenteditable") return "contenteditable";
    return "text";
  }
  if (widgetKind === "native_select") return "native_select";
  if (widgetKind === "combobox" || widgetKind === "autocomplete") return "custom_select";
  if (widgetKind === "phone_input") return "phone";
  if (widgetKind === "textarea") return "textarea";
  if (widgetKind === "date_input") return "date";
  if (widgetKind === "numeric_input") return "number";
  if (widgetKind === "email_input") return "email";
  if (widgetKind === "contenteditable") return "contenteditable";

  return "text";
}

function isProseFieldDescriptor(descriptor: string, inputType: string) {
  return /\b(cover letter|motivation|why|summary|bio|about you|describe|explain|additional information|message|hiring team|comments?|anything else|let the company know|interest working there|interest in working there|tell us|technical expertise|overall technical|reason for job change|job change reason)\b/.test(descriptor)
    && !/\blinkedin|github|portfolio|website|url\b/.test(descriptor)
    && !["radio", "checkbox", "select", "combobox"].includes(normalizeKey(inputType));
}

function hasYesNoOptions(options: string[]) {
  const normalized = options.map((option) => normalizeKey(option)).filter(Boolean);
  return normalized.includes("yes") && normalized.includes("no");
}

function scoreIntentConfidence(field: VisibleField, intentCandidates: FillV2IntentCandidate[]) {
  const top = intentCandidates[0];
  const second = intentCandidates[1];

  if (!top || top.intent === "unknown") {
    return 0.25;
  }

  const gap = top.score - (second?.score ?? 0);
  const base = 0.42
    + Math.min(top.score, 100) / 180
    + Math.min(Math.max(gap, 0), 60) / 220
    + (field.required ? 0.05 : 0);

  return Math.max(0.3, Math.min(0.96, base));
}

function scoreField(field: FillV2Field) {
  return (field.required ? 20 : 0)
    + field.confidence * 50
    + (field.options.length > 0 ? 5 : 0)
    + driverPreferenceScore(field)
    + (field.id.startsWith("fill-v2-inferred-") ? -3 : 3)
    - Math.max(0, field.label.length - 60) / 10;
}

function driverPreferenceScore(field: FillV2Field) {
  if (field.intent === "email" || field.intent === "confirm_email") {
    if (field.driver === "email") return 38;
    if (field.driver === "text") return 8;
  }

  if (field.intent === "phone") {
    if (field.driver === "phone") return field.inputType === "tel" ? 42 : 22;
  }

  if (field.intent === "prose") {
    if (field.driver === "textarea") return 34;
    if (field.driver === "text" || field.driver === "contenteditable") return 28;
    if (field.driver === "custom_select" || field.driver === "native_select") return -60;
  }

  if (isChoiceLikeIntent(field.intent)) {
    if (field.driver === "choice") return 42;
    if (field.driver === "custom_select" || field.driver === "native_select") return 24;
    if (field.driver === "text") return 8;
  }

  if (field.intent === "total_experience" || field.intent === "notice_period") {
    if (field.driver === "custom_select" || field.driver === "native_select") return 36;
    if (field.driver === "text" || field.driver === "number") return 14;
  }

  if (field.intent === "preferred_work_location" || field.intent === "city" || field.intent === "state" || field.intent === "country") {
    if (field.driver === "custom_select" || field.driver === "native_select") return 24;
    if (field.driver === "text") return 12;
  }

  return 0;
}

function isChoiceLikeIntent(intent: FillV2Intent) {
  return [
    "office_work_choice",
    "bond_obligation_choice",
    "previous_employer_choice",
    "shift_flexibility_choice",
    "notice_buyout_choice",
    "work_experience_choice",
    "work_current_choice",
    "consent",
    "marketing_opt_in",
    "preferred_name_choice",
    "work_authorization",
    "sponsorship",
    "relocation"
  ].includes(intent);
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
