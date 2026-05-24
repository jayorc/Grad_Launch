import type { FileChooser, Frame, Locator, Page } from "playwright-core";
import type { BrowserFillField } from "./types";
import { normalizeKey } from "./util";

type FillStrategy = "text" | "date" | "native_select" | "custom_select" | "autocomplete" | "choice" | "file";
type CanonicalFieldKind =
  | "text"
  | "textarea"
  | "date"
  | "number"
  | "email"
  | "phone"
  | "select"
  | "combobox"
  | "autocomplete"
  | "radio"
  | "checkbox"
  | "file"
  | "contenteditable"
  | "multi_select"
  | "unknown";

export async function fillFormField(page: Page, field: BrowserFillField) {
  const normalizedField = normalizeBrowserFillField(field);
  const strategy = await resolveFillStrategy(page, normalizedField);

  if (strategy === "file") {
    return false;
  }

  if (isCountryOptionLabel(normalizedField.label)) {
    return fillCountryOptionField(page, normalizedField);
  }

  if (isCountryChoiceGroupField(normalizedField)) {
    return fillCountryChoiceGroup(page, normalizedField);
  }

  if (isCountrySelectField(normalizedField) || (strategy !== "choice" && isCountryLikeField(normalizedField))) {
    return await fillCountrySelectField(page, normalizedField) || await fillCountryChoiceGroup(page, normalizedField);
  }

  if (strategy === "choice") {
    if (shouldSkipCountryOptionField(normalizedField)) {
      return false;
    }

    return await fillCountryChoiceGroup(page, normalizedField)
      || await fillByClassifiedControl(page, normalizedField, "choice")
      || await fillByAgentFieldId(page, normalizedField, "choice")
      || await fillChoiceField(page, normalizedField);
  }

  if (strategy === "native_select") {
    return await fillByClassifiedControl(page, normalizedField, "native_select")
      || await fillByAgentFieldId(page, normalizedField, "native_select")
      || await fillSelectField(page, normalizedField)
      || await fillSelectLikeField(page, normalizedField);
  }

  if (strategy === "autocomplete") {
    if (await fillByClassifiedControl(page, normalizedField, "autocomplete")
      || await fillSelectLikeField(page, normalizedField)
      || await fillByAgentFieldId(page, normalizedField, "autocomplete")) {
      return true;
    }

    if (!shouldAllowTextFallbackForAutocomplete(normalizedField)) {
      return false;
    }

    return await fillByFreshLabelTarget(page, normalizedField) || await fillTextField(page, normalizedField);
  }

  if (strategy === "custom_select") {
    return await fillByClassifiedControl(page, normalizedField, "custom_select")
      || await fillByAgentFieldId(page, normalizedField, "custom_select")
      || await fillSelectLikeField(page, normalizedField)
      || await fillSelectField(page, normalizedField);
  }

  if (strategy === "date") {
    return await fillByClassifiedControl(page, normalizedField, "date")
      || await fillByAgentFieldId(page, normalizedField)
      || await fillByFreshLabelTarget(page, normalizedField)
      || await fillTextField(page, normalizedField);
  }

  return await fillByClassifiedControl(page, normalizedField)
    || await fillByAgentFieldId(page, normalizedField)
    || await fillByFreshLabelTarget(page, normalizedField)
    || await fillTextField(page, normalizedField)
    || await fillChoiceField(page, normalizedField);
}

async function fillByClassifiedControl(page: Page, field: BrowserFillField, preferredStrategy?: FillStrategy) {
  if (!field.value.trim() || field.inputType === "file") {
    return false;
  }

  for (const frame of page.frames()) {
    const marker = `gl-classified-control-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const classified = await frame.evaluate(({ fieldId, label, value, inputType, marker, preferredStrategy }) => {
      const searchRoots = getSearchRoots();
      const controls = discoverCandidateControls(searchRoots);
      const labelKey = normalize(label);
      const valueKey = normalize(value);
      const semanticIntent = inferSemanticIntent(`${labelKey} ${valueKey}`);
      let best: {
        control: HTMLElement;
        kind: CanonicalFieldKind;
        score: number;
        reason: string;
      } | undefined;

      for (const control of controls) {
        if (!isVisibleCandidate(control)) {
          continue;
        }

        const labels = getControlLabels(control);
        const kind = classifyControlKind(control, `${labels.direct} ${labels.nearby} ${labels.context} ${labelKey} ${valueKey}`);
        const score = rankControlCandidate({
          control,
          labels,
          labelKey,
          semanticIntent,
          fieldId,
          declaredInputType: inputType,
          kind,
          preferredStrategy
        });

        if (!best || score > best.score) {
          best = {
            control,
            kind,
            score,
            reason: labels.reason
          };
        }
      }

      const minimumScore = semanticIntent ? 52 : 68;

      if (!best || best.score < minimumScore || best.kind === "unknown" || best.kind === "file") {
        return undefined;
      }

      best.control.setAttribute("data-gradlaunch-classified-control", marker);

      return {
        kind: best.kind,
        score: best.score,
        reason: best.reason
      };

      type CanonicalFieldKind =
        | "text"
        | "textarea"
        | "date"
        | "number"
        | "email"
        | "phone"
        | "select"
        | "combobox"
        | "autocomplete"
        | "radio"
        | "checkbox"
        | "file"
        | "contenteditable"
        | "multi_select"
        | "unknown";

      function discoverCandidateControls(roots: Array<Document | ShadowRoot>) {
        const selector = [
          "input",
          "textarea",
          "select",
          "[contenteditable='true']",
          "[role='combobox']",
          "[role='radio']",
          "[role='checkbox']",
          "[aria-haspopup]",
          "[aria-expanded]",
          "button"
        ].join(",");
        const seen = new Set<HTMLElement>();
        const candidates: HTMLElement[] = [];

        for (const root of roots) {
          for (const element of Array.from(root.querySelectorAll(selector))) {
            if (!(element instanceof HTMLElement) || seen.has(element)) {
              continue;
            }

            seen.add(element);
            candidates.push(element);
          }
        }

        return candidates;
      }

      function rankControlCandidate(input: {
        control: HTMLElement;
        labels: ReturnType<typeof getControlLabels>;
        labelKey: string;
        semanticIntent: string | undefined;
        fieldId: string | undefined;
        declaredInputType: string | undefined;
        kind: CanonicalFieldKind;
        preferredStrategy: FillStrategy | undefined;
      }) {
        const { control, labels, labelKey, semanticIntent, fieldId, declaredInputType, kind, preferredStrategy } = input;
        let score = 0;

        if (fieldId && control.getAttribute("data-gradlaunch-field-id") === fieldId) {
          score += 180;
        }

        score += textMatchScore(labels.direct, labelKey, 110);
        score += textMatchScore(labels.nearby, labelKey, 95);
        score += textMatchScore(labels.context, labelKey, 44);

        if (semanticIntent) {
          if (descriptorMatchesSemanticIntent(labels.direct, semanticIntent)) {
            score += 96;
          } else if (descriptorMatchesSemanticIntent(labels.nearby, semanticIntent)) {
            score += 84;
          } else if (descriptorMatchesSemanticIntent(labels.context, semanticIntent)) {
            score += 32;
          }
        }

        score += tokenSimilarityScore(labelKey, `${labels.direct} ${labels.nearby}`, 56);

        if (kind === "select" && normalize(declaredInputType ?? "") === "select") {
          score += 42;
        }

        if ((kind === "combobox" || kind === "autocomplete") && /\b(select|search|autocomplete|type to search|country|state|province|location)\b/.test(`${labels.direct} ${labels.nearby} ${labels.context}`)) {
          score += 36;
        }

        if ((kind === "radio" || kind === "checkbox") && /\b(yes|no|agree|accept|decline|experience|preferred name)\b/.test(`${labels.direct} ${labels.nearby} ${labels.context}`)) {
          score += 34;
        }

        if (isRequired(control)) {
          score += 12;
        }

        if (preferredStrategy) {
          if (kindMatchesPreferredStrategy(kind, preferredStrategy)) {
            score += 120;
          } else if (preferredStrategy !== "text" && isTextLikeKind(kind)) {
            score -= 180;
          } else if (preferredStrategy === "choice" && kind !== "radio" && kind !== "checkbox") {
            score -= 120;
          } else if ((preferredStrategy === "native_select" || preferredStrategy === "custom_select" || preferredStrategy === "autocomplete") && kind !== "select" && kind !== "multi_select" && kind !== "combobox" && kind !== "autocomplete") {
            score -= 95;
          }
        }

        if (semanticIntent && kind === "text" && /^(country|state|degree_type|work_experience)$/.test(semanticIntent)) {
          score -= 90;
        }

        if (kind === "text" && /\b(select an option|choose an option|please select)\b/.test(`${labels.direct} ${labels.nearby} ${labels.context}`)) {
          score -= 120;
        }

        return score;
      }

      function kindMatchesPreferredStrategy(kind: CanonicalFieldKind, strategy: FillStrategy) {
        if (strategy === "native_select") {
          return kind === "select" || kind === "multi_select";
        }

        if (strategy === "custom_select") {
          return kind === "combobox" || kind === "select" || kind === "multi_select";
        }

        if (strategy === "autocomplete") {
          return kind === "autocomplete" || kind === "combobox";
        }

        if (strategy === "choice") {
          return kind === "radio" || kind === "checkbox";
        }

        if (strategy === "date") {
          return kind === "date";
        }

        if (strategy === "text") {
          return isTextLikeKind(kind);
        }

        return false;
      }

      function isTextLikeKind(kind: CanonicalFieldKind) {
        return kind === "text"
          || kind === "textarea"
          || kind === "number"
          || kind === "email"
          || kind === "phone"
          || kind === "contenteditable";
      }

      function classifyControlKind(control: HTMLElement, descriptor: string): CanonicalFieldKind {
        const normalized = normalize(descriptor);

        if (control instanceof HTMLTextAreaElement) {
          return "textarea";
        }

        if (control instanceof HTMLSelectElement) {
          return control.multiple ? "multi_select" : "select";
        }

        if (control instanceof HTMLInputElement) {
          const type = normalize(control.type || "text");

          if (type === "radio") {
            return "radio";
          }

          if (type === "checkbox") {
            return "checkbox";
          }

          if (type === "file") {
            return "file";
          }

          if (type === "date" || /\b(date picker|calendar)\b/.test(normalized)) {
            return "date";
          }

          if (type === "email") {
            return "email";
          }

          if (type === "tel") {
            return "phone";
          }

          if (type === "number") {
            return "number";
          }

          if (hasAutocompleteSemantics(control, normalized)) {
            return "autocomplete";
          }

          if (hasComboboxSemantics(control, normalized)) {
            return "combobox";
          }

          if (/\b(start date|end date|from date|to date|completion date|graduation date|date of birth|dob)\b/.test(normalized)) {
            return "date";
          }

          return "text";
        }

        if (control.isContentEditable) {
          return "contenteditable";
        }

        const role = normalize(control.getAttribute("role") ?? "");

        if (role === "radio") {
          return "radio";
        }

        if (role === "checkbox") {
          return "checkbox";
        }

        if (hasAutocompleteSemantics(control, normalized)) {
          return "autocomplete";
        }

        if (hasComboboxSemantics(control, normalized)) {
          return "combobox";
        }

        return "unknown";
      }

      function hasAutocompleteSemantics(control: HTMLElement, descriptor: string) {
        const semanticOwner = findSelectSemanticOwner(control);
        const ownerDescriptor = normalize(`${descriptor} ${describeElement(semanticOwner)}`);

        return control.getAttribute("aria-autocomplete") === "list"
          || semanticOwner?.getAttribute("aria-autocomplete") === "list"
          || /\b(autocomplete|autosuggest|type to search|search for|place of residence|search and select)\b/.test(ownerDescriptor);
      }

      function hasComboboxSemantics(control: HTMLElement, descriptor: string) {
        const semanticOwner = findSelectSemanticOwner(control);
        const controlsPopup = getControlledPopup(control) ?? getControlledPopup(semanticOwner);
        const role = normalize(control.getAttribute("role") ?? "");
        const ownerRole = normalize(semanticOwner?.getAttribute("role") ?? "");
        const popup = normalize(control.getAttribute("aria-haspopup") ?? "");
        const ownerPopup = normalize(semanticOwner?.getAttribute("aria-haspopup") ?? "");
        const ownerDescriptor = normalize(`${descriptor} ${describeElement(semanticOwner)}`);

        return role === "combobox"
          || ownerRole === "combobox"
          || /^(listbox|menu|dialog|tree|true)$/.test(popup)
          || /^(listbox|menu|dialog|tree|true)$/.test(ownerPopup)
          || Boolean(controlsPopup && controlsPopup.querySelector("[role='option'], li, [data-value], [class*='option']"))
          || control.getAttribute("aria-expanded") !== null
          || semanticOwner?.getAttribute("aria-expanded") !== null
          || control.hasAttribute("data-radix-select-trigger")
          || semanticOwner?.hasAttribute("data-radix-select-trigger")
          || control.hasAttribute("data-headlessui-state")
          || semanticOwner?.hasAttribute("data-headlessui-state")
          || /\b(select__control|select-control|select-trigger|select-input|select value|dropdown|drop down|select an option|choose an option|open menu|open select)\b/.test(ownerDescriptor);
      }

      function findSelectSemanticOwner(control: HTMLElement) {
        let current: HTMLElement | null = control;

        for (let depth = 0; depth < 5 && current; depth += 1) {
          const role = normalize(current.getAttribute("role") ?? "");
          const popup = normalize(current.getAttribute("aria-haspopup") ?? "");
          const className = normalize(String(current.getAttribute("class") ?? ""));

          if (
            role === "combobox"
            || /^(listbox|menu|dialog|tree|true)$/.test(popup)
            || current.getAttribute("aria-expanded") !== null
            || current.hasAttribute("data-radix-select-trigger")
            || current.hasAttribute("data-headlessui-state")
            || /\b(combobox|select control|select trigger|select input|select value|dropdown|autosuggest|autocomplete)\b/.test(className)
          ) {
            return current;
          }

          current = current.parentElement;
        }

        return undefined;
      }

      function getControlledPopup(control: HTMLElement | undefined) {
        const controls = control?.getAttribute("aria-controls");

        if (!controls) {
          return undefined;
        }

        for (const id of controls.split(/\s+/)) {
          const popup = getElementById(id);

          if (popup instanceof HTMLElement) {
            return popup;
          }
        }

        return undefined;
      }

      function describeElement(element: HTMLElement | undefined) {
        if (!element) {
          return "";
        }

        return [
          element.getAttribute("aria-label"),
          element.getAttribute("role"),
          element.getAttribute("aria-haspopup"),
          element.getAttribute("aria-autocomplete"),
          element.getAttribute("aria-expanded"),
          element.className,
          element.textContent
        ].filter(Boolean).join(" ");
      }

      function getControlLabels(control: HTMLElement) {
        const direct = normalize([
          control.getAttribute("aria-label"),
          control.getAttribute("placeholder"),
          control.getAttribute("name"),
          control.id,
          control.getAttribute("role"),
          control.getAttribute("aria-haspopup"),
          control.getAttribute("aria-autocomplete"),
          control.getAttribute("autocomplete"),
          control.className,
          labelledByText(control),
          findLabelText(control)
        ].filter(Boolean).join(" "));
        const nearby = normalize(findNearbyLabelText(control));
        const context = normalize(compactContainerText(control));

        return {
          direct,
          nearby,
          context,
          reason: [direct, nearby, context].filter(Boolean).join(" | ").slice(0, 180)
        };
      }

      function textMatchScore(source: string, target: string, maxScore: number) {
        if (!source || !target) {
          return 0;
        }

        if (source === target) {
          return maxScore;
        }

        if (source.includes(target)) {
          return Math.round(maxScore * 0.82);
        }

        if (target.includes(source) && source.length > 2) {
          return Math.round(maxScore * 0.68);
        }

        return tokenSimilarityScore(source, target, Math.round(maxScore * 0.55));
      }

      function inferSemanticIntent(text: string) {
        if (/\b(country)\b/.test(text)) {
          return "country";
        }

        if (/\b(state|province|region)\b/.test(text)) {
          return "state";
        }

        if (/\b(city|location|place of residence|current city)\b/.test(text)) {
          return "city";
        }

        if (/\b(type of degree|degree type|education level)\b/.test(text)) {
          return "degree_type";
        }

        if (/\b(work experience|past working experience|professional experience)\b/.test(text)) {
          return "work_experience";
        }

        if (/\b(zip|postal|postcode|pin code|pincode)\b/.test(text)) {
          return "postal_code";
        }

        if (/\b(email|e mail)\b/.test(text)) {
          return "email";
        }

        if (/\b(phone|mobile|telephone|contact number)\b/.test(text)) {
          return "phone";
        }

        return undefined;
      }

      function descriptorMatchesSemanticIntent(descriptor: string, intent: string) {
        const patterns: Record<string, RegExp> = {
          country: /\bcountry\b/,
          state: /\b(state|province|region)\b/,
          city: /\b(city|location|place of residence|town|locality)\b/,
          degree_type: /\b(type of degree|degree type|education level|level of education)\b/,
          work_experience: /\b(work|working|professional|employment).*\bexperience\b|\bexperience\b/,
          postal_code: /\b(zip|postal|postcode|pin code|pincode)\b/,
          email: /\b(email|e mail)\b/,
          phone: /\b(phone|mobile|telephone|contact)\b/
        };

        return Boolean(patterns[intent]?.test(descriptor));
      }

      function isVisibleCandidate(control: HTMLElement) {
        if (control instanceof HTMLInputElement && ["hidden", "submit", "button", "image", "reset"].includes(control.type)) {
          return false;
        }

        if ((control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement) && control.disabled) {
          return false;
        }

        if (control.getAttribute("aria-disabled") === "true") {
          return false;
        }

        const rect = control.getBoundingClientRect();
        const style = window.getComputedStyle(control);

        if (rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0) {
          return true;
        }

        if (control instanceof HTMLInputElement && ["radio", "checkbox"].includes(control.type)) {
          const label = control.id ? queryFirst(`label[for="${CSS.escape(control.id)}"]`, control) : undefined;
          const target = label instanceof HTMLElement ? label : control.closest("label, [role='radio'], [role='checkbox'], [aria-checked], [tabindex]");

          if (target instanceof HTMLElement) {
            const targetRect = target.getBoundingClientRect();
            const targetStyle = window.getComputedStyle(target);
            return targetRect.width > 0 && targetRect.height > 0 && targetStyle.display !== "none" && targetStyle.visibility !== "hidden";
          }
        }

        return false;
      }

      function isRequired(control: Element) {
        const text = `${findLabelText(control)} ${findNearbyLabelText(control)} ${compactContainerText(control)}`;

        return (control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).required
          || control.getAttribute("aria-required") === "true"
          || control.getAttribute("aria-invalid") === "true"
          || /\*/.test(text)
          || Boolean(control.closest(".required, [class*='required'], [data-required='true']"));
      }

      function labelledByText(control: Element) {
        const labelledBy = control.getAttribute("aria-labelledby");

        if (!labelledBy) {
          return "";
        }

        return labelledBy
          .split(/\s+/)
          .map((id) => getElementById(id)?.textContent ?? "")
          .join(" ");
      }

      function findLabelText(control: Element) {
        if (control.id) {
          const labelElement = queryFirst(`label[for="${CSS.escape(control.id)}"]`, control);

          if (labelElement?.textContent?.trim()) {
            return labelElement.textContent.trim();
          }
        }

        return control.closest("label")?.textContent?.trim()
          || control.closest("fieldset")?.querySelector("legend")?.textContent?.trim()
          || "";
      }

      function findNearbyLabelText(control: Element) {
        let ancestor: Element | null = control.parentElement;

        for (let depth = 0; depth < 5 && ancestor; depth += 1) {
          const labels = Array.from(ancestor.querySelectorAll("label, legend, h1, h2, h3, h4, [class*='label'], [class*='Label']")) as HTMLElement[];
          const ownRect = control instanceof HTMLElement ? control.getBoundingClientRect() : undefined;
          const best = labels
            .map((item) => {
              const text = clean(item.innerText || item.textContent || "");
              const rect = item.getBoundingClientRect();
              const distance = ownRect ? Math.abs(rect.bottom - ownRect.top) + Math.abs(rect.left - ownRect.left) / 4 : 0;
              return { text, distance };
            })
            .filter((item) => item.text && item.text.length <= 140)
            .sort((left, right) => left.distance - right.distance)[0];

          if (best?.text) {
            return best.text;
          }

          const previous = ancestor.previousElementSibling?.textContent?.trim();

          if (previous) {
            return previous;
          }

          ancestor = ancestor.parentElement;
        }

        return "";
      }

      function compactContainerText(control: Element) {
        const container = control.closest("label, fieldset, [role='group'], [role='radiogroup'], [class*='field'], [class*='input'], [class*='form'], section, article, div");
        const text = clean(container?.textContent ?? "");

        return text.length <= 260 ? text : "";
      }

      function tokenSimilarityScore(left: string, right: string, maxScore: number) {
        const leftTokens = semanticTokens(left);
        const rightTokens = semanticTokens(right);

        if (leftTokens.size === 0 || rightTokens.size === 0) {
          return 0;
        }

        let overlap = 0;

        for (const token of leftTokens) {
          if (rightTokens.has(token)) {
            overlap += 1;
          }
        }

        const union = new Set([...leftTokens, ...rightTokens]).size;

        return Math.round((overlap / union) * maxScore);
      }

      function semanticTokens(text: string) {
        return new Set(
          normalize(text)
            .split(" ")
            .filter((token) => token.length > 1 && !/^(select|option|choose|please|your|the|field|required|number|name|date)$/.test(token))
        );
      }

      function queryFirst(selector: string, control: Element) {
        const root = control.getRootNode();

        if (root instanceof Document || root instanceof ShadowRoot || root instanceof Element) {
          const match = root.querySelector(selector);

          if (match) {
            return match;
          }
        }

        for (const searchRoot of searchRoots) {
          const match = searchRoot.querySelector(selector);

          if (match) {
            return match;
          }
        }

        return null;
      }

      function getElementById(id: string) {
        for (const searchRoot of searchRoots) {
          if ("getElementById" in searchRoot && typeof searchRoot.getElementById === "function") {
            const match = searchRoot.getElementById(id);

            if (match) {
              return match;
            }
          } else {
            const match = searchRoot.querySelector(`#${CSS.escape(id)}`);

            if (match) {
              return match;
            }
          }
        }

        return null;
      }

      function getSearchRoots() {
        const roots: Array<Document | ShadowRoot> = [document];

        for (let index = 0; index < roots.length; index += 1) {
          const root = roots[index];
          const elements = Array.from(root.querySelectorAll("*")) as HTMLElement[];

          for (const element of elements) {
            if (element.shadowRoot) {
              roots.push(element.shadowRoot);
            }
          }
        }

        return roots;
      }

      function clean(value: string | null | undefined) {
        return (value ?? "").replace(/\s+/g, " ").replace(/\*/g, " ").trim();
      }

      function normalize(value: string | null | undefined) {
        return clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      }
    }, {
      fieldId: field.fieldId,
      label: field.label,
      value: field.value,
      inputType: field.inputType,
      marker,
      preferredStrategy
    }).catch(() => undefined as { kind: CanonicalFieldKind; score: number; reason: string } | undefined);

    if (!classified) {
      continue;
    }

    const target = frame.locator(`[data-gradlaunch-classified-control="${marker}"]`).first();

    try {
      if (classified.kind === "select" || classified.kind === "multi_select") {
        if (await fillClassifiedNativeSelect(target, field)) {
          return true;
        }
      } else if (classified.kind === "combobox") {
        if (await fillClassifiedSelectLike(page, frame, target, field)) {
          return true;
        }
      } else if (classified.kind === "autocomplete") {
        if (await fillClassifiedAutocomplete(frame, target, field)) {
          return true;
        }
      } else if (classified.kind === "radio" || classified.kind === "checkbox") {
        if (await fillClassifiedChoice(frame, marker, field)) {
          await frame.page().waitForTimeout(180).catch(() => undefined);

          if (!await verifyLocatorCommitted(target, field, { kind: classified.kind, allowPartial: false })) {
            continue;
          }

          return true;
        }
      } else if (["text", "textarea", "date", "number", "email", "phone", "contenteditable"].includes(classified.kind)) {
        if (await fillClassifiedTextLike(target, field, classified.kind)) {
          return true;
        }
      }
    } finally {
      await cleanupClassifiedControl(frame, marker);
    }
  }

  return false;
}

async function fillClassifiedNativeSelect(target: Locator, field: BrowserFillField) {
  const option = await target.evaluate((element, { fieldValue, fieldLabel }) => {
    if (!(element instanceof HTMLSelectElement)) {
      return undefined;
    }

    const wanted = normalize(fieldValue);
    const label = normalize(fieldLabel);
    const option = findBestOption(element, wanted, label);

    if (!option) {
      return undefined;
    }

    return {
      label: option.textContent ?? option.value,
      value: option.value
    };

    function findBestOption(select: HTMLSelectElement, wantedValue: string, labelText: string) {
      const options = Array.from(select.options).filter((item) => {
        const text = normalize(`${item.textContent ?? ""} ${item.value ?? ""}`);
        return Boolean(text) && !/^(select|select an option|choose|choose an option|please select|none selected)$/.test(text);
      });

      return options.find((item) => normalize(item.textContent ?? item.value) === wantedValue || normalize(item.value) === wantedValue)
        ?? options.find((item) => !isCountryLabel(labelText) && (normalize(item.textContent ?? item.value).includes(wantedValue) || wantedValue.includes(normalize(item.textContent ?? item.value))))
        ?? options.find((item) => matchesSemanticOption(normalize(`${item.textContent ?? ""} ${item.value ?? ""}`), wantedValue, labelText));
    }

    function isCountryLabel(labelText: string) {
      return /\bcountry\b/.test(labelText);
    }

    function matchesSemanticOption(optionText: string, wantedValue: string, labelText: string) {
      if (/\bcountry\b/.test(labelText)) {
        if (wantedValue.includes("india")) {
          return optionText === "india" || optionText === "in";
        }
      }

      if (/\b(state|province|region)\b/.test(labelText)) {
        return optionText.includes(wantedValue) || wantedValue.includes(optionText);
      }

      if (/\b(type of degree|degree type|education level)\b/.test(labelText)) {
        if (/\b(bachelor|b tech|btech|undergraduate|ug)\b/.test(wantedValue)) {
          return /\b(bachelor|b tech|btech|undergraduate|ug)\b/.test(optionText);
        }

        if (/\b(master|m tech|mtech|postgraduate|pg|mca|msc)\b/.test(wantedValue)) {
          return /\b(master|m tech|mtech|postgraduate|pg|mca|msc)\b/.test(optionText);
        }
      }

      if (/\b(work experience|past working experience|professional experience)\b/.test(labelText)) {
        if (/^(yes|true|1)$/.test(wantedValue)) {
          return /^yes\b|experience/.test(optionText);
        }

        if (/^(no|false|0)$/.test(wantedValue)) {
          return /^no\b|fresher|0/.test(optionText);
        }
      }

      return false;
    }

    function normalize(value: string | null | undefined) {
      return (value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    }
  }, { fieldValue: field.value, fieldLabel: field.label }).catch(() => undefined as { label: string; value: string } | undefined);

  if (!option) {
    return false;
  }

  await target.scrollIntoViewIfNeeded().catch(() => undefined);
  await target.selectOption({ value: option.value }, { timeout: 900 }).catch(async () => {
    await target.selectOption({ label: option.label }, { timeout: 900 }).catch(() => undefined);
  });
  await target.press("Tab", { timeout: 350 }).catch(() => undefined);
  await target.blur().catch(() => undefined);
  await target.page().waitForTimeout(180).catch(() => undefined);

  if (await verifyLocatorCommitted(target, field, { kind: "select", allowPartial: false })) {
    return true;
  }

  const selected = await target.evaluate((element, optionValue) => {
    if (!(element instanceof HTMLSelectElement)) {
      return false;
    }

    const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");

    if (descriptor?.set) {
      descriptor.set.call(element, optionValue);
    } else {
      element.value = optionValue;
    }

    element.focus();
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));

    if (element.form) {
      element.form.dispatchEvent(new Event("change", { bubbles: true }));
    }

    return !isEmptySelect(element);

    function isEmptySelect(select: HTMLSelectElement) {
      const selected = select.selectedOptions[0];
      const value = normalize(`${selected?.textContent ?? ""} ${selected?.value ?? ""} ${select.value}`);
      return !value || /^(select|select an option|choose|choose an option|please select|none selected)$/.test(value);
    }

    function normalize(value: string | null | undefined) {
      return (value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    }
  }, option.value).catch(() => false);

  if (!selected) {
    return false;
  }

  await target.press("Tab", { timeout: 350 }).catch(() => undefined);
  await target.blur().catch(() => undefined);
  await target.page().waitForTimeout(180).catch(() => undefined);
  return verifyLocatorCommitted(target, field, { kind: "select", allowPartial: false });
}

async function fillClassifiedSelectLike(page: Page, frame: Frame, target: Locator, field: BrowserFillField) {
  const interactionTarget = await getSelectInteractionTarget(target);
  const wantedCountry = countryLabelFromValue(field.value);

  if (await verifySelectLikeValue(target, field.value, { allowPartial: false, fieldLabel: field.label, acceptLocationTextValue: true })
    || await verifySelectLikeValue(interactionTarget, field.value, { allowPartial: false, fieldLabel: field.label, acceptLocationTextValue: true })) {
    return true;
  }

  await interactionTarget.scrollIntoViewIfNeeded().catch(() => undefined);
  await interactionTarget.click({ force: true, timeout: 900 }).catch(() => undefined);
  await page.waitForTimeout(150).catch(() => undefined);

  if (wantedCountry && await clickExactCountryOption(frame, wantedCountry)) {
    await interactionTarget.press("Tab", { timeout: 350 }).catch(() => undefined);
    await interactionTarget.blur().catch(() => undefined);
    await page.waitForTimeout(260).catch(() => undefined);
    return await verifySelectLikeValue(target, wantedCountry, { allowPartial: false, fieldLabel: field.label })
      || await verifySelectLikeValue(interactionTarget, wantedCountry, { allowPartial: false, fieldLabel: field.label })
      || await verifyLocatorCommitted(target, field, { kind: "combobox", allowPartial: false, acceptLocationTextValue: true })
      || await verifyLocatorCommitted(interactionTarget, field, { kind: "combobox", allowPartial: false, acceptLocationTextValue: true });
  }

  if (await clickVisibleSelectOptionWithRetries(frame, field.value, field.label, field.value, 4)) {
    await interactionTarget.press("Tab", { timeout: 350 }).catch(() => undefined);
    await interactionTarget.blur().catch(() => undefined);
    await page.waitForTimeout(260).catch(() => undefined);

    if (await verifySelectLikeValue(target, field.value, { allowPartial: false, fieldLabel: field.label, acceptLocationTextValue: true })
      || await verifySelectLikeValue(interactionTarget, field.value, { allowPartial: false, fieldLabel: field.label, acceptLocationTextValue: true })
      || await verifyLocatorCommitted(target, field, { kind: "combobox", allowPartial: isShortChoiceValue(field.value), acceptLocationTextValue: true })
      || await verifyLocatorCommitted(interactionTarget, field, { kind: "combobox", allowPartial: isShortChoiceValue(field.value), acceptLocationTextValue: true })) {
      return true;
    }
  }

  for (const query of getSelectLikeQueries(field.label, field.value)) {
    await interactionTarget.click({ force: true, timeout: 700 }).catch(() => undefined);
    await interactionTarget.fill(query, { timeout: 700 }).catch(async () => {
      await interactionTarget.press(process.platform === "darwin" ? "Meta+A" : "Control+A", { timeout: 250 }).catch(() => undefined);
      await interactionTarget.type(query, { delay: 12, timeout: 1000 }).catch(() => undefined);
    });
    await page.waitForTimeout(260).catch(() => undefined);

    if (wantedCountry && await clickExactCountryOption(frame, wantedCountry)
      || await clickVisibleSelectOptionWithRetries(frame, field.value, field.label, query, 4)) {
      await interactionTarget.press("Tab", { timeout: 350 }).catch(() => undefined);
      await interactionTarget.blur().catch(() => undefined);
      await page.waitForTimeout(300).catch(() => undefined);

      if (await verifySelectLikeValue(target, field.value, { allowPartial: false, fieldLabel: field.label, acceptLocationTextValue: true })
        || await verifySelectLikeValue(interactionTarget, field.value, { allowPartial: false, fieldLabel: field.label, acceptLocationTextValue: true })
        || await verifyLocatorCommitted(target, field, { kind: "combobox", allowPartial: false, acceptLocationTextValue: true })
        || await verifyLocatorCommitted(interactionTarget, field, { kind: "combobox", allowPartial: false, acceptLocationTextValue: true })) {
        return true;
      }
    }
  }

  return false;
}

async function fillClassifiedAutocomplete(frame: Frame, target: Locator, field: BrowserFillField) {
  const marker = `gl-classified-autocomplete-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await target.evaluate((element, marker) => {
    if (element instanceof HTMLElement) {
      element.setAttribute("data-gradlaunch-autocomplete-target", marker);
    }
  }, marker).catch(() => undefined);

  try {
    for (const query of getSelectLikeQueries(field.label, field.value)) {
      await target.scrollIntoViewIfNeeded().catch(() => undefined);
      await target.click({ force: true, timeout: 900 }).catch(() => undefined);
      await clearAutocompleteTarget(target);
      await target.type(query, { delay: 35, timeout: 1800 }).catch(async () => {
        await setAutocompleteTargetValue(target, query);
      });
      await frame.page().waitForTimeout(350).catch(() => undefined);

      const clicked = await clickBestAutocompleteSuggestion(frame, marker, field.value, field.label, query);

      if (clicked && await verifySearchAutocompleteCommitted(frame, marker, field.value, field.label, query)) {
        return true;
      }

      await target.press("ArrowDown", { timeout: 500 }).catch(() => undefined);
      await frame.page().waitForTimeout(120).catch(() => undefined);
      await target.press("Enter", { timeout: 600 }).catch(() => undefined);
      await target.press("Tab", { timeout: 350 }).catch(() => undefined);
      await frame.page().waitForTimeout(350).catch(() => undefined);

      if (await verifySearchAutocompleteCommitted(frame, marker, field.value, field.label, query)) {
        return true;
      }
    }

    return false;
  } finally {
    await cleanupAutocompleteTarget(frame, marker);
  }
}

async function fillClassifiedTextLike(target: Locator, field: BrowserFillField, kind: CanonicalFieldKind) {
  const value = normalizeValueForClassifiedText(field, kind);

  return commitTextLikeLocator(target, { ...field, value }, kind);
}

async function fillClassifiedChoice(frame: Frame, marker: string, field: BrowserFillField) {
  return frame.evaluate(({ marker, value }) => {
    const target = document.querySelector(`[data-gradlaunch-classified-control="${CSS.escape(marker)}"]`);

    if (!(target instanceof HTMLElement)) {
      return false;
    }

    const expected = normalize(value);
    const groupControls = getChoiceGroupControls(target);
    const best = groupControls
      .map((control) => ({
        control,
        score: scoreChoice(control, expected)
      }))
      .sort((left, right) => right.score - left.score)[0];

    if (!best || best.score < 45) {
      return false;
    }

    clickChoice(best.control, true);
    return best.control.checked || best.control.getAttribute("aria-checked") === "true";

    function getChoiceGroupControls(element: HTMLElement) {
      const base = element instanceof HTMLInputElement && ["radio", "checkbox"].includes(element.type)
        ? element
        : element.querySelector("input[type='radio'], input[type='checkbox']");

      if (!(base instanceof HTMLInputElement)) {
        return [];
      }

      const named = base.name
        ? Array.from(document.querySelectorAll(`input[name="${CSS.escape(base.name)}"]`)) as HTMLInputElement[]
        : [];
      let ancestor: Element | null = base.parentElement;
      let best: HTMLInputElement[] = named.length > 0 ? named : [base];
      let bestScore = named.length > 0 ? 40 : 0;

      for (let depth = 0; depth < 8 && ancestor; depth += 1) {
        const controls = Array.from(ancestor.querySelectorAll("input[type='radio'], input[type='checkbox']")) as HTMLInputElement[];
        const visibleControls = controls.filter((control) => !control.disabled && isVisibleChoice(control));

        if (visibleControls.length > 0 && visibleControls.length <= 16) {
          const text = normalize(ancestor.textContent ?? "");
          let score = visibleControls.length * 10 - depth * 2;

          if (/\b(yes|no|agree|accept|decline|experience|preferred name|required)\b/.test(text)) {
            score += 40;
          }

          if (score > bestScore) {
            bestScore = score;
            best = visibleControls;
          }
        }

        ancestor = ancestor.parentElement;
      }

      return best;
    }

    function scoreChoice(control: HTMLInputElement, expectedValue: string) {
      const option = normalize(getOptionText(control));
      let score = 0;

      if (option === expectedValue) {
        score += 120;
      } else if (option.includes(expectedValue) || expectedValue.includes(option)) {
        score += 85;
      }

      if (/^(yes|true|1|agree|accept|i agree)$/.test(expectedValue) && /\b(yes|agree|accept|i agree)\b/.test(option)) {
        score += 95;
      }

      if (/^(no|false|0|decline|no thanks|not now)$/.test(expectedValue) && /\b(no|decline|no thanks|not now)\b/.test(option)) {
        score += 95;
      }

      if (control.checked) {
        score += 8;
      }

      return score;
    }

    function clickChoice(input: HTMLInputElement, checked: boolean) {
      const clickTarget = getChoiceClickTarget(input);

      clickTarget.scrollIntoView?.({ block: "center", inline: "center" });
      input.focus();

      try {
        clickTarget.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
        clickTarget.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, view: window }));
      } catch (_error) {
        clickTarget.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
        clickTarget.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      }

      clickTarget.click();

      if (input.type === "radio" && checked) {
        const group = input.name
          ? Array.from(document.querySelectorAll(`input[name="${CSS.escape(input.name)}"]`)) as HTMLInputElement[]
          : [input];

        for (const item of group) {
          if (item !== input && item.checked) {
            setNativeChecked(item, false);
            dispatch(item);
          }
        }
      }

      if (input.checked !== checked) {
        setNativeChecked(input, checked);
      }

      dispatch(input);
      input.blur();
    }

    function getChoiceClickTarget(input: HTMLInputElement) {
      if (input.id) {
        const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);

        if (label instanceof HTMLElement) {
          return label;
        }
      }

      const closestLabel = input.closest("label");

      if (closestLabel instanceof HTMLElement) {
        return closestLabel;
      }

      const clickableAncestor = input.closest("button, [role='radio'], [role='checkbox'], [role='button'], [aria-checked], [tabindex]");

      return clickableAncestor instanceof HTMLElement ? clickableAncestor : input;
    }

    function getOptionText(input: HTMLInputElement) {
      if (input.id) {
        const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);

        if (label?.textContent?.trim()) {
          return label.textContent.trim();
        }
      }

      return input.closest("label")?.textContent?.trim()
        || input.parentElement?.textContent?.trim()
        || input.getAttribute("aria-label")
        || input.value
        || "";
    }

    function isVisibleChoice(input: HTMLInputElement) {
      const target = getChoiceClickTarget(input);
      const rect = target.getBoundingClientRect();
      const style = window.getComputedStyle(target);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    }

    function dispatch(element: Element) {
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new Event("blur", { bubbles: true }));

      if (element instanceof HTMLInputElement && element.form) {
        element.form.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }

    function setNativeChecked(input: HTMLInputElement, checked: boolean) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");

      if (descriptor?.set) {
        descriptor.set.call(input, checked);
      } else {
        input.checked = checked;
      }
    }

    function normalize(text: string | null | undefined) {
      return (text ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    }
  }, { marker, value: field.value }).catch(() => false);
}

async function cleanupClassifiedControl(frame: Frame, marker: string) {
  await frame.evaluate((marker) => {
    const target = document.querySelector(`[data-gradlaunch-classified-control="${CSS.escape(marker)}"]`);

    if (target instanceof HTMLElement) {
      target.removeAttribute("data-gradlaunch-classified-control");
    }
  }, marker).catch(() => undefined);
}

async function commitTextLikeLocator(target: Locator, field: BrowserFillField, kind: CanonicalFieldKind | FillStrategy = "text") {
  const value = field.value.trim();

  if (!value) {
    return false;
  }

  const selectAllKey = process.platform === "darwin" ? "Meta+A" : "Control+A";

  await target.scrollIntoViewIfNeeded().catch(() => undefined);

  const keyboardCommitted = await target.click({ force: true, timeout: 900 })
    .then(async () => {
      await target.press(selectAllKey, { timeout: 350 }).catch(() => undefined);
      await target.press("Backspace", { timeout: 350 }).catch(() => undefined);
      await target.type(value, { delay: 24, timeout: Math.max(2200, value.length * 80) });
      await dispatchCommitEvents(target, value, { onlyIfEmpty: false });
      await target.press("Tab", { timeout: 450 }).catch(() => undefined);
      await target.blur().catch(() => undefined);
      await target.page().waitForTimeout(260).catch(() => undefined);
      return verifyLocatorCommitted(target, field, { kind, allowPartial: false });
    })
    .catch(() => false);

  if (keyboardCommitted) {
    return true;
  }

  const fillCommitted = await target.click({ force: true, timeout: 900 })
    .then(async () => {
      await target.fill("", { timeout: 900 }).catch(async () => {
        await target.press(selectAllKey, { timeout: 250 }).catch(() => undefined);
        await target.press("Backspace", { timeout: 250 }).catch(() => undefined);
      });
      await target.fill(value, { timeout: 1600 }).catch(async () => {
        await target.type(value, { delay: 18, timeout: Math.max(1600, value.length * 70) }).catch(() => undefined);
      });
      await dispatchCommitEvents(target, value, { onlyIfEmpty: false });
      await target.press("Tab", { timeout: 450 }).catch(() => undefined);
      await target.blur().catch(() => undefined);
      await target.page().waitForTimeout(300).catch(() => undefined);
      return verifyLocatorCommitted(target, field, { kind, allowPartial: false });
    })
    .catch(() => false);

  if (fillCommitted) {
    return true;
  }

  await dispatchCommitEvents(target, value, { onlyIfEmpty: true });
  await target.press("Tab", { timeout: 450 }).catch(() => undefined);
  await target.blur().catch(() => undefined);
  await target.page().waitForTimeout(320).catch(() => undefined);

  return verifyLocatorCommitted(target, field, { kind, allowPartial: false });
}

async function dispatchCommitEvents(target: Locator, value: string, options?: { onlyIfEmpty?: boolean }) {
  await target.evaluate((element, { expected, onlyIfEmpty }) => {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.focus();

      if (!onlyIfEmpty || !element.value.trim()) {
        setNativeValue(element, expected);
      }

      element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Unidentified" }));
      element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: expected }));
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: expected }));
      element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: "Unidentified" }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      element.dispatchEvent(new Event("blur", { bubbles: true }));

      if (element.form) {
        element.form.dispatchEvent(new Event("input", { bubbles: true }));
        element.form.dispatchEvent(new Event("change", { bubbles: true }));
      }
    } else if (element instanceof HTMLElement && element.isContentEditable) {
      element.focus();

      if (!onlyIfEmpty || !element.textContent?.trim()) {
        element.textContent = expected;
      }

      element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: expected }));
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: expected }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      element.dispatchEvent(new Event("blur", { bubbles: true }));
    }

    function setNativeValue(control: HTMLInputElement | HTMLTextAreaElement, nextValue: string) {
      const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

      if (descriptor?.set) {
        descriptor.set.call(control, nextValue);
      } else {
        control.value = nextValue;
      }
    }
  }, { expected: value, onlyIfEmpty: options?.onlyIfEmpty === true }).catch(() => undefined);
}

async function verifyLocatorCommitted(
  target: Locator,
  field: BrowserFillField,
  options?: {
    kind?: CanonicalFieldKind | FillStrategy;
    allowPartial?: boolean;
    acceptLocationTextValue?: boolean;
  }
) {
  return target.evaluate((element, { expectedValue, fieldLabel, kind, allowPartial, acceptLocationTextValue }) => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const expected = normalize(expectedValue);
    const label = normalize(fieldLabel);
    const isLocationLike = /\b(location|city|country|state|province|region|india|australia|canada|united states|usa|united kingdom|uk|haryana|bihar|maharashtra|karnataka|uttar pradesh|telangana|tamil nadu|west bengal|aurangabad|bhiwani|bengaluru|bangalore|banglore|gurugram|gurgaon|delhi|noida|hyderabad|pune|mumbai|chennai|kolkata)\b/.test(`${label} ${expected}`);
    const values = collectCommittedValues(element, kind);

    if (hasBlockingValidation(element)) {
      return false;
    }

    if (element instanceof HTMLInputElement && element.type === "date") {
      return Boolean(element.value);
    }

    if (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)) {
      return verifyChoice(element, expected, label);
    }

    return values.some((actual) => matchesExpected(actual, expected, label, {
      allowPartial,
      allowLocationAlias: Boolean(acceptLocationTextValue) || isLocationLike
    }));

    function collectCommittedValues(targetElement: HTMLElement, fieldKind: string | undefined) {
      const values: string[] = [];

      if (targetElement instanceof HTMLInputElement || targetElement instanceof HTMLTextAreaElement || targetElement instanceof HTMLSelectElement) {
        if (targetElement instanceof HTMLSelectElement) {
          const selected = targetElement.selectedOptions[0];
          values.push(`${selected?.textContent ?? ""} ${selected?.value ?? ""} ${targetElement.value}`);
        } else {
          values.push(targetElement.value);
        }
      } else {
        values.push(targetElement.textContent ?? "");
      }

      const container = findFieldContainer(targetElement) ?? targetElement.parentElement;
      const widget = targetElement.closest("[role='combobox'], [aria-haspopup='listbox'], [data-radix-select-trigger], [data-headlessui-state], [class*='select'], [class*='combobox'], [class*='autocomplete']")
        ?? container;

      values.push(
        targetElement.getAttribute("data-value") ?? "",
        targetElement.getAttribute("aria-valuetext") ?? "",
        targetElement.getAttribute("title") ?? "",
        widget?.getAttribute("data-value") ?? "",
        widget?.getAttribute("aria-valuetext") ?? "",
        Array.from(widget?.querySelectorAll("input[type='hidden'], [aria-selected='true'], [data-selected='true'], [data-state='checked'], [class*='singleValue'], [class*='single-value'], [class*='selected'], [class*='token'], [class*='chip'], [class*='tag'], [class*='pill']") ?? [])
          .map((item) => item instanceof HTMLInputElement ? item.value : item.textContent ?? "")
          .join(" ")
      );

      if (fieldKind === "combobox" || fieldKind === "autocomplete" || fieldKind === "custom_select") {
        values.push(widget?.textContent ?? "");
      }

      return values
        .map(normalize)
        .filter((value) => value && !isEmptyValue(value));
    }

    function verifyChoice(control: HTMLInputElement, expectedValue: string, labelText: string) {
      const group = getChoiceGroup(control);
      const selected = group.filter((item) => item.checked || item.getAttribute("aria-checked") === "true");

      if (selected.length === 0) {
        return false;
      }

      return selected.some((item) => matchesExpected(normalize(getChoiceText(item)), expectedValue, labelText, { allowPartial: false, allowLocationAlias: false }));
    }

    function getChoiceGroup(control: HTMLInputElement) {
      if (control.name) {
        return Array.from(document.querySelectorAll(`input[name="${CSS.escape(control.name)}"]`)) as HTMLInputElement[];
      }

      const container = findFieldContainer(control);
      return Array.from(container?.querySelectorAll("input[type='radio'], input[type='checkbox']") ?? [control]) as HTMLInputElement[];
    }

    function getChoiceText(control: HTMLInputElement) {
      if (control.id) {
        const labelElement = document.querySelector(`label[for="${CSS.escape(control.id)}"]`);

        if (labelElement?.textContent?.trim()) {
          return labelElement.textContent.trim();
        }
      }

      return control.closest("label")?.textContent?.trim()
        || control.parentElement?.textContent?.trim()
        || control.getAttribute("aria-label")
        || control.value
        || "";
    }

    function hasBlockingValidation(targetElement: HTMLElement) {
      if (targetElement.getAttribute("aria-invalid") === "true") {
        return true;
      }

      const describedBy = targetElement.getAttribute("aria-describedby") ?? "";
      const describedText = describedBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");

      if (isBlockingValidationText(normalize(describedText))) {
        return true;
      }

      const directError = targetElement.parentElement?.querySelector("[role='alert'], [aria-live='assertive'], .error, .field-error, .validation-error, [class*='error'], [class*='invalid']");

      if (directError && isVisible(directError) && isBlockingValidationText(normalize(directError.textContent ?? ""))) {
        return true;
      }

      const container = findFieldContainer(targetElement);

      if (!container) {
        return false;
      }

      const errorElements = Array.from(container.querySelectorAll("[role='alert'], [aria-live='assertive'], .error, .field-error, .validation-error, [class*='error'], [class*='invalid']")) as HTMLElement[];

      if (errorElements.some((item) => isVisible(item) && isBlockingValidationText(normalize(item.innerText || item.textContent || "")))) {
        return true;
      }

      const containerText = normalize(container.textContent ?? "");
      return isBlockingValidationText(containerText) && getFillControlCount(container) <= getAllowedControlCount(targetElement);
    }

    function findFieldContainer(targetElement: HTMLElement) {
      let ancestor: HTMLElement | null = targetElement;
      let best: HTMLElement | undefined;
      let bestScore = Number.NEGATIVE_INFINITY;

      for (let depth = 0; depth < 7 && ancestor; depth += 1) {
        const text = normalize(ancestor.innerText || ancestor.textContent || "");
        const controlCount = getFillControlCount(ancestor);
        let score = 0;

        if (ancestor.matches("label, fieldset, [role='group'], [role='radiogroup'], [class*='field'], [class*='Field'], [class*='input'], [class*='Input'], [class*='question'], [class*='Question'], [data-testid*='field']")) {
          score += 50;
        }

        if (ancestor.querySelector("label, legend, h1, h2, h3, h4")) {
          score += 25;
        }

        if (isBlockingValidationText(text)) {
          score += 35;
        }

        score -= Math.max(0, controlCount - getAllowedControlCount(targetElement)) * 20;
        score -= Math.min(text.length / 180, 50);
        score -= depth * 4;

        if (score > bestScore) {
          bestScore = score;
          best = ancestor;
        }

        ancestor = ancestor.parentElement;
      }

      return best;
    }

    function getAllowedControlCount(targetElement: HTMLElement) {
      if (targetElement instanceof HTMLInputElement && ["radio", "checkbox"].includes(targetElement.type)) {
        return 18;
      }

      return 3;
    }

    function getFillControlCount(container: Element) {
      return Array.from(container.querySelectorAll("input:not([type='hidden']):not([type='submit']):not([type='button']):not([type='file']), textarea, select, [role='combobox'], [contenteditable='true']"))
        .filter((item) => item instanceof HTMLElement && isVisible(item)).length;
    }

    function matchesExpected(actual: string, expectedValue: string, labelText: string, matchOptions: { allowPartial?: boolean; allowLocationAlias?: boolean }) {
      if (!actual || isEmptyValue(actual) || !expectedValue) {
        return false;
      }

      if (/\bcountry\b/.test(labelText)) {
        const expectedCountry = countryKey(expectedValue);
        const actualCountry = countryKey(actual);

        if (expectedCountry) {
          return actualCountry === expectedCountry || hasPhrase(actual, expectedCountry);
        }
      }

      if (actual === expectedValue || actual.includes(expectedValue) || (matchOptions.allowPartial && expectedValue.includes(actual))) {
        return true;
      }

      if (/\b(email|phone|mobile|linkedin|github|portfolio|website|url)\b/.test(labelText)) {
        return false;
      }

      if (semanticDegreeMatch(actual, expectedValue) || semanticYesNoMatch(actual, expectedValue)) {
        return true;
      }

      if (!matchOptions.allowLocationAlias) {
        return false;
      }

      return getLocationAliases(expectedValue).some((alias) => alias.length > 2 && (hasPhrase(actual, alias) || (matchOptions.allowPartial && hasPhrase(alias, actual))));
    }

    function semanticDegreeMatch(actual: string, expectedValue: string) {
      if (/\b(bachelor|b tech|btech|undergraduate|ug)\b/.test(expectedValue)) {
        return /\b(bachelor|b tech|btech|undergraduate|ug)\b/.test(actual);
      }

      if (/\b(master|m tech|mtech|postgraduate|pg|mca|msc)\b/.test(expectedValue)) {
        return /\b(master|m tech|mtech|postgraduate|pg|mca|msc)\b/.test(actual);
      }

      return false;
    }

    function semanticYesNoMatch(actual: string, expectedValue: string) {
      if (/^(yes|true|1|agree|accept|i agree)\b/.test(expectedValue)) {
        return /\b(yes|true|agree|accept|i agree)\b/.test(actual);
      }

      if (/^(no|false|0|decline|none|not applicable)\b/.test(expectedValue)) {
        return /\b(no|false|decline|none|not applicable|fresher|0)\b/.test(actual);
      }

      return false;
    }

    function getLocationAliases(value: string) {
      const aliases = new Set<string>();
      const withoutCountry = value.replace(/\b(india|australia|canada|united states|usa|united kingdom|uk)\b/g, " ").replace(/\s+/g, " ").trim();
      const withoutRegion = withoutCountry.replace(/\b(bihar|haryana|maharashtra|karnataka|uttar pradesh|telangana|tamil nadu|west bengal|new south wales|california|washington|texas)\b/g, " ").replace(/\s+/g, " ").trim();

      for (const alias of [value, withoutCountry, withoutRegion, value.split(" ")[0]]) {
        const normalizedAlias = normalize(alias);

        if (normalizedAlias && !/^(city|location|country|state|region|india)$/.test(normalizedAlias)) {
          aliases.add(normalizedAlias);
        }
      }

      if (value.includes("aurangabad")) {
        aliases.add("aurangabad");
        aliases.add("aurangabad bihar");
      }

      if (value.includes("bengaluru") || value.includes("bangalore") || value.includes("banglore")) {
        aliases.add("bengaluru");
        aliases.add("bangalore");
        aliases.add("banglore");
      }

      if (value.includes("bhiwani")) {
        aliases.add("bhiwani");
        aliases.add("bhiwani haryana");
      }

      if (value.includes("gurugram") || value.includes("gurgaon")) {
        aliases.add("gurugram");
        aliases.add("gurgaon");
      }

      return [...aliases];
    }

    function countryKey(value: string) {
      if (hasPhrase(value, "india")) {
        return "india";
      }

      if (hasPhrase(value, "australia")) {
        return "australia";
      }

      if (hasPhrase(value, "united states") || hasPhrase(value, "usa") || value === "us") {
        return "united states";
      }

      if (hasPhrase(value, "united kingdom") || hasPhrase(value, "uk")) {
        return "united kingdom";
      }

      if (hasPhrase(value, "indonesia")) {
        return "indonesia";
      }

      return undefined;
    }

    function isBlockingValidationText(text: string) {
      return /\b(this field is required|field is required|required field|cannot be blank|please select|please enter|select a valid|invalid value|invalid selection|value is required|missing required)\b/.test(text);
    }

    function isEmptyValue(value: string) {
      return !value
        || /^(select|select an option|choose|choose an option|please select|none selected|search|type to search)$/.test(value)
        || /\b(options available|total results|use the up and down keys|press enter to select|press escape to exit|not selected|results found|no results found)\b/.test(value);
    }

    function isVisible(item: Element) {
      if (!(item instanceof HTMLElement)) {
        return false;
      }

      const rect = item.getBoundingClientRect();
      const style = window.getComputedStyle(item);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
    }

    function hasPhrase(text: string, phrase: string) {
      const normalizedPhrase = normalize(phrase);

      if (!text || !normalizedPhrase) {
        return false;
      }

      return new RegExp(`(^| )${escapeRegExp(normalizedPhrase)}( |$)`).test(text);
    }

    function normalize(value: string | null | undefined) {
      return (value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    }

    function escapeRegExp(value: string) {
      return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }, {
    expectedValue: field.value,
    fieldLabel: field.label,
    kind: options?.kind,
    allowPartial: options?.allowPartial === true,
    acceptLocationTextValue: options?.acceptLocationTextValue === true
  }).catch(() => false);
}

function normalizeValueForClassifiedText(field: BrowserFillField, kind: CanonicalFieldKind) {
  if (kind !== "date") {
    return field.value;
  }

  return normalizeBrowserFillField({ ...field, inputType: "date" }).value;
}

async function resolveFillStrategy(page: Page, field: BrowserFillField): Promise<FillStrategy> {
  const declared = inferDeclaredFillStrategy(field);
  const runtime = await detectRuntimeFillStrategy(page, field);

  if (!runtime) {
    return declared;
  }

  if (declared === "native_select" || runtime === "native_select") {
    return "native_select";
  }

  if (declared === "autocomplete" || runtime === "autocomplete") {
    return "autocomplete";
  }

  if (declared === "custom_select" || runtime === "custom_select") {
    return "custom_select";
  }

  if (declared === "choice" || runtime === "choice") {
    return "choice";
  }

  if (declared === "date" || runtime === "date") {
    return "date";
  }

  return runtime;
}

function inferDeclaredFillStrategy(field: BrowserFillField): FillStrategy {
  const inputType = normalizeKey(field.inputType ?? "");
  const descriptor = normalizeKey(`${field.label} ${field.value} ${(field.options ?? []).join(" ")}`);
  const meaningfulOptionCount = (field.options ?? []).filter((option) => {
    const normalized = normalizeKey(option);
    return Boolean(normalized) && !/^(select|select an option|choose|choose one|please select|none selected|not selected)$/.test(normalized);
  }).length;

  if (inputType === "file") {
    return "file";
  }

  if (inputType === "radio" || inputType === "checkbox") {
    return "choice";
  }

  if (inputType === "date" || /\b(start date|end date|from date|to date|completion date|graduation date|date of birth|dob)\b/.test(descriptor)) {
    return "date";
  }

  if (inputType === "select") {
    return "native_select";
  }

  if (meaningfulOptionCount > 0 || /\b(select an option|choose an option|please select|dropdown|drop down)\b/.test(descriptor)) {
    if (looksAutocompleteField(field.label, field.value) || /\b(search|type to search|autocomplete|place of residence)\b/.test(descriptor)) {
      return "autocomplete";
    }

    return "custom_select";
  }

  if (inputType === "combobox" || /\b(select an option|choose an option|please select|dropdown|drop down|type to search|search|autocomplete)\b/.test(descriptor)) {
    return looksAutocompleteField(field.label, field.value) ? "autocomplete" : "custom_select";
  }

  if (
    /\b(country|state|province|region)\b/.test(descriptor)
    && /\b(india|australia|canada|united states|usa|united kingdom|uk|haryana|bihar|maharashtra|karnataka)\b/.test(descriptor)
  ) {
    return "custom_select";
  }

  if (looksAutocompleteField(field.label, field.value) && /\b(location|place of residence|search|autocomplete|type to search)\b/.test(descriptor)) {
    return "autocomplete";
  }

  if (/^(yes|no|true|false)$/i.test(field.value.trim()) && /\b(agree|consent|authorized|sponsor|experience|preferred name|resident|relocat|remote)\b/.test(descriptor)) {
    return "choice";
  }

  return "text";
}

async function detectRuntimeFillStrategy(page: Page, field: BrowserFillField): Promise<FillStrategy | undefined> {
  for (const frame of page.frames()) {
    const strategy = await frame.evaluate(({ fieldId, label, value, inputType }) => {
      const searchRoots = getSearchRoots();
      const controls = searchRoots.flatMap((root) => Array.from(root.querySelectorAll("input, textarea, select, [role='combobox'], [role='radio'], [role='checkbox'], [role='button'], [aria-haspopup], [aria-expanded], [aria-checked], [contenteditable='true']"))) as HTMLElement[];
      const labelKey = normalize(label);
      const descriptorKey = normalize(`${label} ${value}`);
      const semanticIntent = inferSemanticIntent(descriptorKey);
      let best: { strategy: FillStrategy; score: number } | undefined;

      for (const control of controls) {
        if (!isUsableControl(control)) {
          continue;
        }

        const descriptor = normalize([
          control.getAttribute("aria-label"),
          control.getAttribute("placeholder"),
          control.getAttribute("name"),
          control.id,
          control.getAttribute("role"),
          control.getAttribute("aria-haspopup"),
          control.getAttribute("aria-autocomplete"),
          control.getAttribute("autocomplete"),
          control.className,
          labelledByText(control),
          findLabelText(control),
          findNearbyLabelText(control),
          compactContainerText(control)
        ].filter(Boolean).join(" "));
        const controlStrategy = inferControlStrategy(control, `${descriptor} ${descriptorKey}`);
        let score = 0;

        if (fieldId && control.getAttribute("data-gradlaunch-field-id") === fieldId) {
          score += 180;
        }

        if (labelKey && (descriptor.includes(labelKey) || labelKey.includes(descriptor))) {
          score += 95;
        }

        if (semanticIntent && descriptorMatchesSemanticIntent(descriptor, semanticIntent)) {
          score += 90;
        }

        score += tokenSimilarityScore(labelKey, descriptor, 52);

        if (normalize(inputType ?? "") === "select" && controlStrategy === "native_select") {
          score += 40;
        }

        if (isRequired(control)) {
          score += 12;
        }

        if (!best || score > best.score) {
          best = { strategy: controlStrategy, score };
        }
      }

      return best && best.score >= (semanticIntent ? 52 : 68) ? best.strategy : undefined;

      type FillStrategy = "text" | "date" | "native_select" | "custom_select" | "autocomplete" | "choice" | "file";

      function inferControlStrategy(control: HTMLElement, descriptor: string): FillStrategy {
        if (control instanceof HTMLInputElement && control.type === "file") {
          return "file";
        }

        const role = normalize(control.getAttribute("role") ?? "");

        if (control instanceof HTMLInputElement && ["radio", "checkbox"].includes(control.type) || role === "radio" || role === "checkbox" || control.getAttribute("aria-checked") !== null) {
          return "choice";
        }

        if (control instanceof HTMLSelectElement) {
          return "native_select";
        }

        if (control instanceof HTMLInputElement && control.type === "date") {
          return "date";
        }

        if (/\b(start date|end date|from date|to date|completion date|graduation date|date of birth|dob)\b/.test(descriptor)) {
          return "date";
        }

        if (isAutocompleteControl(control, descriptor)) {
          return "autocomplete";
        }

        if (isCustomSelectControl(control, descriptor)) {
          return "custom_select";
        }

        return "text";
      }

      function isAutocompleteControl(control: HTMLElement, descriptor: string) {
        const semanticOwner = findSelectSemanticOwner(control);
        const ownerDescriptor = normalize(`${descriptor} ${describeElement(semanticOwner)}`);

        return control.getAttribute("aria-autocomplete") === "list"
          || semanticOwner?.getAttribute("aria-autocomplete") === "list"
          || /\b(search|autocomplete|autosuggest|type to search|search and select|place of residence)\b/.test(ownerDescriptor)
          && Boolean(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control.isContentEditable);
      }

      function isCustomSelectControl(control: HTMLElement, descriptor: string) {
        const semanticOwner = findSelectSemanticOwner(control);
        const controlsPopup = getControlledPopup(control) ?? getControlledPopup(semanticOwner);
        const role = control.getAttribute("role") ?? "";
        const popup = control.getAttribute("aria-haspopup") ?? "";
        const ownerRole = semanticOwner?.getAttribute("role") ?? "";
        const ownerPopup = semanticOwner?.getAttribute("aria-haspopup") ?? "";
        const ownerDescriptor = normalize(`${descriptor} ${describeElement(semanticOwner)}`);

        return role === "combobox"
          || ownerRole === "combobox"
          || /^(listbox|menu|dialog|tree|true)$/i.test(popup)
          || /^(listbox|menu|dialog|tree|true)$/i.test(ownerPopup)
          || Boolean(controlsPopup && controlsPopup.querySelector("[role='option'], li, [data-value], [class*='option']"))
          || control.getAttribute("aria-expanded") !== null
          || semanticOwner?.getAttribute("aria-expanded") !== null
          || semanticOwner?.hasAttribute("data-radix-select-trigger")
          || semanticOwner?.hasAttribute("data-headlessui-state")
          || /\b(select|dropdown|drop down|select an option|choose an option|open menu|open select|country|state|province|region)\b/.test(ownerDescriptor);
      }

      function findSelectSemanticOwner(control: HTMLElement) {
        let current: HTMLElement | null = control;

        for (let depth = 0; depth < 5 && current; depth += 1) {
          const role = normalize(current.getAttribute("role") ?? "");
          const popup = normalize(current.getAttribute("aria-haspopup") ?? "");
          const className = normalize(String(current.getAttribute("class") ?? ""));

          if (
            role === "combobox"
            || /^(listbox|menu|dialog|tree|true)$/.test(popup)
            || current.getAttribute("aria-expanded") !== null
            || current.hasAttribute("data-radix-select-trigger")
            || current.hasAttribute("data-headlessui-state")
            || /\b(combobox|select control|select trigger|select input|select value|dropdown|autosuggest|autocomplete)\b/.test(className)
          ) {
            return current;
          }

          current = current.parentElement;
        }

        return undefined;
      }

      function getControlledPopup(control: HTMLElement | undefined) {
        const controls = control?.getAttribute("aria-controls");

        if (!controls) {
          return undefined;
        }

        for (const id of controls.split(/\s+/)) {
          const popup = getElementById(id);

          if (popup instanceof HTMLElement) {
            return popup;
          }
        }

        return undefined;
      }

      function describeElement(element: HTMLElement | undefined) {
        if (!element) {
          return "";
        }

        return [
          element.getAttribute("aria-label"),
          element.getAttribute("role"),
          element.getAttribute("aria-haspopup"),
          element.getAttribute("aria-autocomplete"),
          element.getAttribute("aria-expanded"),
          element.className,
          element.textContent
        ].filter(Boolean).join(" ");
      }

      function isUsableControl(control: HTMLElement) {
        if (control instanceof HTMLInputElement && ["hidden", "submit", "button", "image", "reset"].includes(control.type)) {
          return false;
        }

        if ((control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement) && control.disabled) {
          return false;
        }

        if (control.getAttribute("aria-disabled") === "true") {
          return false;
        }

        const rect = control.getBoundingClientRect();
        const style = window.getComputedStyle(control);
        if (rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden") {
          return true;
        }

        if (control instanceof HTMLInputElement && ["radio", "checkbox"].includes(control.type)) {
          const clickTarget = control.id ? queryFirst(`label[for="${CSS.escape(control.id)}"]`, control) : control.closest("label, [role='radio'], [role='checkbox'], [aria-checked], [tabindex]");

          if (clickTarget instanceof HTMLElement) {
            const targetRect = clickTarget.getBoundingClientRect();
            const targetStyle = window.getComputedStyle(clickTarget);
            return targetRect.width > 0 && targetRect.height > 0 && targetStyle.display !== "none" && targetStyle.visibility !== "hidden";
          }
        }

        return false;
      }

      function inferSemanticIntent(text: string) {
        if (/\b(country)\b/.test(text)) {
          return "country";
        }

        if (/\b(state|province|region)\b/.test(text)) {
          return "state";
        }

        if (/\b(city|location|place of residence|current city)\b/.test(text)) {
          return "city";
        }

        if (/\b(type of degree|degree type|education level)\b/.test(text)) {
          return "degree_type";
        }

        if (/\b(work experience|past working experience|professional experience)\b/.test(text)) {
          return "work_experience";
        }

        return undefined;
      }

      function descriptorMatchesSemanticIntent(descriptor: string, intent: string) {
        const patterns: Record<string, RegExp> = {
          country: /\bcountry\b/,
          state: /\b(state|province|region)\b/,
          city: /\b(city|location|place of residence|town|locality)\b/,
          degree_type: /\b(type of degree|degree type|education level|level of education)\b/,
          work_experience: /\b(work|working|professional|employment).*\bexperience\b|\bexperience\b/
        };

        return Boolean(patterns[intent]?.test(descriptor));
      }

      function labelledByText(control: Element) {
        const labelledBy = control.getAttribute("aria-labelledby");

        if (!labelledBy) {
          return "";
        }

        return labelledBy
          .split(/\s+/)
          .map((id) => getElementById(id)?.textContent ?? "")
          .join(" ");
      }

      function findLabelText(control: Element) {
        if (control.id) {
          const labelElement = queryFirst(`label[for="${CSS.escape(control.id)}"]`, control);

          if (labelElement?.textContent?.trim()) {
            return labelElement.textContent.trim();
          }
        }

        return control.closest("label")?.textContent?.trim()
          || control.closest("fieldset")?.querySelector("legend")?.textContent?.trim()
          || "";
      }

      function findNearbyLabelText(control: Element) {
        let ancestor: Element | null = control.parentElement;

        for (let depth = 0; depth < 4 && ancestor; depth += 1) {
          const labels = Array.from(ancestor.querySelectorAll("label, legend, h1, h2, h3, h4, [class*='label'], [class*='Label']")) as HTMLElement[];
          const ownRect = control instanceof HTMLElement ? control.getBoundingClientRect() : undefined;
          const best = labels
            .map((item) => {
              const text = clean(item.innerText || item.textContent || "");
              const rect = item.getBoundingClientRect();
              const distance = ownRect ? Math.abs(rect.bottom - ownRect.top) + Math.abs(rect.left - ownRect.left) / 4 : 0;
              return { text, distance };
            })
            .filter((item) => item.text && item.text.length <= 140)
            .sort((left, right) => left.distance - right.distance)[0];

          if (best?.text) {
            return best.text;
          }

          const previous = ancestor.previousElementSibling?.textContent?.trim();

          if (previous) {
            return previous;
          }

          ancestor = ancestor.parentElement;
        }

        return "";
      }

      function compactContainerText(control: Element) {
        const container = control.closest("label, fieldset, [role='group'], [class*='field'], [class*='input'], [class*='form'], section, article, div");
        const text = clean(container?.textContent ?? "");

        return text.length <= 240 ? text : "";
      }

      function isRequired(control: Element) {
        const text = `${findLabelText(control)} ${findNearbyLabelText(control)} ${compactContainerText(control)}`;

        return (control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).required
          || control.getAttribute("aria-required") === "true"
          || control.getAttribute("aria-invalid") === "true"
          || /\*/.test(text)
          || Boolean(control.closest(".required, [class*='required'], [data-required='true']"));
      }

      function tokenSimilarityScore(left: string, right: string, maxScore: number) {
        const leftTokens = semanticTokens(left);
        const rightTokens = semanticTokens(right);

        if (leftTokens.size === 0 || rightTokens.size === 0) {
          return 0;
        }

        let overlap = 0;

        for (const token of leftTokens) {
          if (rightTokens.has(token)) {
            overlap += 1;
          }
        }

        const union = new Set([...leftTokens, ...rightTokens]).size;

        return Math.round((overlap / union) * maxScore);
      }

      function semanticTokens(text: string) {
        return new Set(
          normalize(text)
            .split(" ")
            .filter((token) => token.length > 1 && !/^(select|option|choose|please|your|the|field|required|number|name|date)$/.test(token))
        );
      }

      function queryFirst(selector: string, control: Element) {
        const root = control.getRootNode();

        if (root instanceof Document || root instanceof ShadowRoot || root instanceof Element) {
          const match = root.querySelector(selector);

          if (match) {
            return match;
          }
        }

        for (const searchRoot of searchRoots) {
          const match = searchRoot.querySelector(selector);

          if (match) {
            return match;
          }
        }

        return null;
      }

      function getElementById(id: string) {
        for (const searchRoot of searchRoots) {
          if ("getElementById" in searchRoot && typeof searchRoot.getElementById === "function") {
            const match = searchRoot.getElementById(id);

            if (match) {
              return match;
            }
          } else {
            const match = searchRoot.querySelector(`#${CSS.escape(id)}`);

            if (match) {
              return match;
            }
          }
        }

        return null;
      }

      function getSearchRoots() {
        const roots: Array<Document | ShadowRoot> = [document];

        for (let index = 0; index < roots.length; index += 1) {
          const root = roots[index];
          const elements = Array.from(root.querySelectorAll("*")) as HTMLElement[];

          for (const element of elements) {
            if (element.shadowRoot) {
              roots.push(element.shadowRoot);
            }
          }
        }

        return roots;
      }

      function clean(value: string | null | undefined) {
        return (value ?? "").replace(/\s+/g, " ").replace(/\*/g, " ").trim();
      }

      function normalize(value: string | null | undefined) {
        return clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      }
    }, {
      fieldId: field.fieldId,
      label: field.label,
      value: field.value,
      inputType: field.inputType
    }).catch(() => undefined);

    if (strategy) {
      return strategy;
    }
  }

  return undefined;
}

function shouldAllowTextFallbackForAutocomplete(field: BrowserFillField) {
  const descriptor = normalizeKey(`${field.label} ${field.value}`);

  return /\b(university|college|school|institution)\b/.test(descriptor)
    && !/\b(location|city|country|state|province|region|place of residence)\b/.test(descriptor);
}

function isCountryLikeField(field: BrowserFillField) {
  const descriptor = normalizeKey(`${field.label} ${field.value}`);

  return /\bcountry\b/.test(descriptor) && /\b(india|australia|canada|united states|usa|united kingdom|uk)\b/.test(descriptor);
}

function normalizeBrowserFillField(field: BrowserFillField): BrowserFillField {
  const inputType = field.inputType ?? "";

  if (inputType !== "date") {
    return field;
  }

  const value = field.value.trim();

  if (/^\d{4}$/.test(value)) {
    const monthDay = /\b(end|completion|graduation|to)\b/i.test(field.label) ? "12-31" : "01-01";
    return { ...field, value: `${value}-${monthDay}` };
  }

  if (/^\d{4}-\d{2}$/.test(value)) {
    return { ...field, value: `${value}-01` };
  }

  return field;
}

export async function resolveKnownRequiredChoice(page: Page, blockers: string[]) {
  const blockerText = blockers.join(" ");

  if (!/\b(talent network|career opportunities|upcoming events|keep you up to date|job alerts|preferred name|past working experience|required)\b/i.test(blockerText)) {
    return false;
  }

  for (const frame of page.frames()) {
    const resolved = await frame.evaluate((blockerText) => {
      const blocker = normalize(blockerText);
      const controls = getSearchRoots().flatMap((root) => Array.from(root.querySelectorAll("input[type='radio'], input[type='checkbox']"))) as HTMLInputElement[];
      let best: { control: HTMLInputElement; score: number } | undefined;

      for (const control of controls) {
        if (control.disabled || !isUsableChoice(control)) {
          continue;
        }

        const option = normalize(getOptionText(control));
        const groupText = normalize(getChoiceGroupText(control));
        const descriptor = `${option} ${groupText} ${blocker}`;
        let score = 0;

        if (/\b(no thanks|no thank you|decline|do not|don t|dont|not now|skip)\b/.test(option)) {
          score += 140;
        } else if (/^no\b/.test(option)) {
          score += 105;
        } else if (/^yes\b|agree|accept/.test(option)) {
          score -= 120;
        }

        if (/\b(talent network|career opportunities|upcoming events|keep you up to date|job alerts|marketing updates)\b/.test(descriptor)) {
          score += 130;
        }

        if (/\b(preferred name|different from your legal name)\b/.test(descriptor)) {
          score += 95;
        }

        if (/\b(past working experience|prior work experience|work experience|professional experience)\b/.test(descriptor)) {
          score += 85;
        }

        if (/\b(this field is required|required|please correct|there are some errors)\b/.test(groupText) || /\b(this field is required|required|please correct|there are some errors)\b/.test(blocker)) {
          score += 45;
        }

        if (control.checked) {
          score += 20;
        }

        if (!best || score > best.score) {
          best = { control, score };
        }
      }

      if (!best || best.score < 120) {
        return false;
      }

      clickChoiceControl(best.control);
      return best.control.checked || best.control.getAttribute("aria-checked") === "true";

      function getChoiceGroupText(control: HTMLInputElement) {
        const group = getChoiceGroup(control);
        return [
          group?.querySelector("legend, h1, h2, h3, h4, label, p")?.textContent,
          group?.textContent,
          control.closest("fieldset, [role='radiogroup'], [role='group'], section, article, [class*='question'], [class*='field'], [class*='input'], div")?.textContent
        ].filter(Boolean).join(" ");
      }

      function getChoiceGroup(control: HTMLInputElement) {
        let best: HTMLElement | undefined;
        let bestScore = Number.NEGATIVE_INFINITY;
        let ancestor: Element | null = control.parentElement;

        for (let depth = 0; depth < 8 && ancestor; depth += 1) {
          if (!(ancestor instanceof HTMLElement)) {
            ancestor = ancestor.parentElement;
            continue;
          }

          const radios = Array.from(ancestor.querySelectorAll("input[type='radio'], input[type='checkbox']")) as HTMLInputElement[];
          const text = normalize(ancestor.innerText || ancestor.textContent || "");
          let score = 0;

          if (radios.length >= 2 && radios.length <= 10) {
            score += 70;
          }

          if (/\b(talent network|career opportunities|upcoming events|keep you up to date|job alerts|preferred name|past working experience)\b/.test(text)) {
            score += 90;
          }

          if (/\b(this field is required|required)\b/.test(text)) {
            score += 25;
          }

          score -= Math.min(text.length / 180, 50);
          score -= depth * 2;

          if (score > bestScore) {
            best = ancestor;
            bestScore = score;
          }

          ancestor = ancestor.parentElement;
        }

        return best;
      }

      function getOptionText(control: HTMLInputElement) {
        if (control.id) {
          const label = queryFirst(`label[for="${CSS.escape(control.id)}"]`);

          if (label?.textContent?.trim()) {
            return label.textContent.trim();
          }
        }

        return control.closest("label")?.textContent?.trim()
          || control.parentElement?.textContent?.trim()
          || control.getAttribute("aria-label")
          || control.value
          || "";
      }

      function clickChoiceControl(input: HTMLInputElement) {
        const group = getChoiceGroup(input);
        const clickTarget = getChoiceClickTarget(input);

        clickTarget.scrollIntoView?.({ block: "center", inline: "center" });
        input.focus();

        for (const item of Array.from(group?.querySelectorAll("input[type='radio']") ?? []) as HTMLInputElement[]) {
          if (item !== input && item.checked) {
            setNativeChecked(item, false);
            dispatch(item);
          }
        }

        try {
          clickTarget.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
          clickTarget.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, view: window }));
        } catch (_error) {
          clickTarget.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
          clickTarget.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
        }

        clickTarget.click();

        if (!input.checked) {
          setNativeChecked(input, true);
        }

        dispatch(input);
        input.blur();
      }

      function getChoiceClickTarget(input: HTMLInputElement) {
        if (input.id) {
          const label = queryFirst(`label[for="${CSS.escape(input.id)}"]`);

          if (label instanceof HTMLElement) {
            return label;
          }
        }

        const closestLabel = input.closest("label");

        if (closestLabel instanceof HTMLElement) {
          return closestLabel;
        }

        const clickableAncestor = input.closest("button, [role='radio'], [role='checkbox'], [role='button'], [aria-checked], [tabindex], [class*='radio'], [class*='checkbox']");

        return clickableAncestor instanceof HTMLElement ? clickableAncestor : input;
      }

      function isUsableChoice(control: HTMLInputElement) {
        const target = getChoiceClickTarget(control);
        const rect = target.getBoundingClientRect();
        const style = window.getComputedStyle(target);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
      }

      function dispatch(element: Element) {
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        element.dispatchEvent(new Event("blur", { bubbles: true }));

        if (element instanceof HTMLInputElement && element.form) {
          element.form.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }

      function setNativeChecked(input: HTMLInputElement, checked: boolean) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");

        if (descriptor?.set) {
          descriptor.set.call(input, checked);
        } else {
          input.checked = checked;
        }
      }

      function queryFirst(selector: string) {
        for (const root of getSearchRoots()) {
          const match = root.querySelector(selector);

          if (match) {
            return match;
          }
        }

        return null;
      }

      function normalize(value: string) {
        return value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      }

      function getSearchRoots() {
        const roots: Array<Document | ShadowRoot> = [document];

        for (let index = 0; index < roots.length; index += 1) {
          const root = roots[index];
          const elements = Array.from(root.querySelectorAll("*")) as HTMLElement[];

          for (const element of elements) {
            if (element.shadowRoot) {
              roots.push(element.shadowRoot);
            }
          }
        }

        return roots;
      }
    }, blockerText).catch(() => false);

    if (resolved) {
      await page.waitForTimeout(350).catch(() => undefined);
      return true;
    }
  }

  return false;
}

export async function attachResume(page: Page, resumePath: string) {
  if (await pageHasResumeMethodChoice(page)) {
    if (await continueAfterResumeUploadIfReady(page, resumePath)) {
      return true;
    }

    return attachResumeViaUploadTrigger(page, resumePath);
  }

  if (await hasExistingAttachedFile(page)) {
    return true;
  }

  if (await attachResumeToBestFileInput(page, resumePath)) {
    return true;
  }

  for (const frame of page.frames()) {
    try {
      const targetIndex = await frame.evaluate(() => {
        const controls = Array.from(document.querySelectorAll("input[type='file']")) as HTMLInputElement[];
        let bestIndex = -1;
        let bestScore = Number.NEGATIVE_INFINITY;

        for (const [index, control] of controls.entries()) {
          if (control.disabled) {
            continue;
          }

          const descriptor = normalize([
            control.accept,
            control.name,
            control.id,
            control.className,
            control.getAttribute("aria-label"),
            control.getAttribute("data-testid"),
            control.labels?.[0]?.textContent,
            control.closest("label")?.textContent,
            control.closest("section, article, form, fieldset, [role='group'], div")?.textContent
          ].filter(Boolean).join(" "));
          let score = 0;

          if (/\b(resume|cv|curriculum vitae)\b/.test(descriptor)) {
            score += 120;
          }

          if (/\bresume cv\b/.test(descriptor)) {
            score += 40;
          }

          if (/\b(easy apply|autofill|application)\b/.test(descriptor)) {
            score += 35;
          }

          if (/\b(photo|image|avatar|profile picture|profile photo)\b/.test(descriptor)) {
            score -= 120;
          }

          if (/pdf/.test(control.accept)) {
            score += 20;
          }

          if (/\b(upload|attach|browse|drop)\b/.test(descriptor)) {
            score += 18;
          }

          if (/\bcover letter\b/.test(descriptor)) {
            score -= 220;
          }

          if (control.multiple) {
            score += 4;
          }

          if (score > bestScore) {
            bestScore = score;
            bestIndex = index;
          }
        }

        return bestScore >= 70 ? bestIndex : -1;

        function normalize(value: string) {
          return value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        }
      }).catch(() => -1);

      if (targetIndex < 0) {
        continue;
      }

      await frame.locator("input[type='file']").nth(targetIndex).setInputFiles(resumePath, { timeout: 2500 });
      const verified = await frame.locator("input[type='file']").nth(targetIndex).evaluate((control) => {
        return control instanceof HTMLInputElement && (control.files?.length ?? 0) > 0;
      }).catch(() => false);

      if (verified) {
        return true;
      }
    } catch (_error) {
      // Try the next frame.
    }
  }

  const uploadedViaChooser = await attachResumeViaUploadTrigger(page, resumePath);

  if (uploadedViaChooser) {
    return true;
  }

  return false;
}

async function attachResumeToBestFileInput(page: Page, resumePath: string) {
  for (const frame of page.frames()) {
    const marker = `gl-resume-input-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const found = await frame.evaluate((marker) => {
      const searchRoots = getSearchRoots();
      const controls = searchRoots.flatMap((root) => Array.from(root.querySelectorAll("input[type='file']"))) as HTMLInputElement[];
      let best: HTMLInputElement | undefined;
      let bestScore = Number.NEGATIVE_INFINITY;
      const pageText = normalize([
        document.body?.innerText ?? "",
        document.body?.textContent ?? "",
        ...getVisibleElementText(searchRoots)
      ].join(" "));
      const pageLooksLikeResumeUpload = /\b(resume|cv|curriculum vitae|upload resume|attach resume|choose(?: a)? file|drop (?:it|file|resume|cv) here|drag and drop)\b/.test(pageText)
        || looksLikeResumeMethodChoice(pageText);
      const pageLooksLikeApplicationFileStep = /\b(application|apply|candidate|job|career|profile)\b/.test(pageText)
        && /\b(upload|attach|file|document|device|resume|cv)\b/.test(pageText);
      const pageHasCoverLetterOnly = /\bcover letter\b/.test(pageText) && !/\b(resume|cv|curriculum vitae)\b/.test(pageText);

      for (const control of controls) {
        if (control.disabled) {
          continue;
        }

        const descriptor = normalize([
          control.accept,
          control.name,
          control.id,
          control.className,
          control.getAttribute("aria-label"),
          control.getAttribute("data-testid"),
          control.labels?.[0]?.textContent,
          control.closest("label")?.textContent,
          control.closest("section, article, form, fieldset, [role='group'], [class*='upload'], [class*='drop'], [class*='file'], div")?.textContent
        ].filter(Boolean).join(" "));
        let score = 0;

        if (/\b(resume|cv|curriculum vitae)\b/.test(descriptor)) {
          score += 130;
        }

        if (/\bresume cv\b/.test(descriptor)) {
          score += 40;
        }

        if (/\b(easy apply|autofill|application)\b/.test(descriptor)) {
          score += 30;
        }

        if (/\b(photo|image|avatar|profile picture|profile photo)\b/.test(descriptor) || /\bimage\b/.test(normalize(control.accept))) {
          score -= 140;
        }

        if (/\bcover letter\b/.test(descriptor) && !/\b(resume|cv|curriculum vitae)\b/.test(descriptor)) {
          score -= 240;
        }

        if (/\b(pdf|doc|docx)\b/.test(normalize(control.accept))) {
          score += 22;
        }

        if (/\b(upload|attach|browse|choose(?: a)? file|select file|drop (?:it|file|resume|cv) here|drag and drop)\b/.test(descriptor)) {
          score += 24;
        }

        if (controls.length === 1 && pageLooksLikeResumeUpload) {
          score += 75;
        }

        if (
          controls.length === 1
          && pageLooksLikeApplicationFileStep
          && !pageHasCoverLetterOnly
          && !/\b(cover letter|photo|image|avatar|profile picture|profile photo)\b/.test(descriptor)
        ) {
          score += /\b(pdf|doc|docx)\b/.test(normalize(control.accept)) ? 54 : 30;
        }

        if (pageLooksLikeResumeUpload && !/\bcover letter\b/.test(descriptor) && !/\b(photo|image|avatar|profile picture|profile photo)\b/.test(descriptor)) {
          score += /\b(pdf|doc|docx)\b/.test(normalize(control.accept)) ? 58 : 34;
        }

        if (control.multiple) {
          score += 4;
        }

        if (score > bestScore) {
          bestScore = score;
          best = control;
        }
      }

      if (!best || bestScore < 55) {
        return false;
      }

      best.setAttribute("data-gradlaunch-resume-input", marker);
      return true;

      function getSearchRoots() {
        const roots: Array<Document | ShadowRoot> = [document];

        for (let index = 0; index < roots.length; index += 1) {
          const root = roots[index];
          const elements = Array.from(root.querySelectorAll("*")) as HTMLElement[];

          for (const element of elements) {
            if (element.shadowRoot) {
              roots.push(element.shadowRoot);
            }
          }
        }

        return roots;
      }

      function getVisibleElementText(roots: Array<Document | ShadowRoot>) {
        return roots.flatMap((root) => {
          return Array.from(root.querySelectorAll("button, [role='button'], label, a, input, span, div")).flatMap((element) => {
            if (!(element instanceof HTMLElement)) {
              return [];
            }

            const rect = element.getBoundingClientRect();

            if (rect.width <= 0 || rect.height <= 0) {
              return [];
            }

            return [
              element.innerText || element.textContent || "",
              element.getAttribute("aria-label") ?? "",
              element instanceof HTMLInputElement ? element.value : ""
            ].filter(Boolean);
          });
        });
      }

      function looksLikeResumeMethodChoice(value: string) {
        return /\b(choose an option to apply|application method|application methods|how would you like to apply|apply with)\b/.test(value)
          && /\b(without resume|without cv|copy paste|copy and paste|from device|from computer|upload from device|upload resume|resume)\b/.test(value);
      }

      function normalize(value: string) {
        return value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      }
    }, marker).catch(() => false);

    if (!found) {
      continue;
    }

    const inputLocator = frame.locator(`[data-gradlaunch-resume-input="${marker}"]`).first();

    try {
      await inputLocator.setInputFiles(resumePath, { timeout: 3500 });
      await frame.page().waitForTimeout(450).catch(() => undefined);
      const verified = await inputLocator.evaluate((control) => {
        return control instanceof HTMLInputElement && (control.files?.length ?? 0) > 0;
      }).catch(() => false);

      if (verified) {
        return true;
      }

      const likelyAcceptedByUploadWidget = await inputLocator.evaluate((control) => {
        if (!(control instanceof HTMLInputElement)) {
          return false;
        }

        const descriptor = normalize([
          control.accept,
          control.name,
          control.id,
          control.className,
          control.getAttribute("aria-label"),
          control.getAttribute("data-testid"),
          control.labels?.[0]?.textContent,
          control.closest("label")?.textContent,
          control.closest("section, article, form, fieldset, [role='group'], [class*='upload'], [class*='drop'], [class*='file'], div")?.textContent
        ].filter(Boolean).join(" "));

        return /\b(pdf|doc|docx|resume|cv|curriculum vitae|upload|attach|file)\b/.test(descriptor)
          && !/\b(photo|image|avatar|profile picture|profile photo|cover letter)\b/.test(descriptor);

        function normalize(value: string) {
          return value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        }
      }).catch(() => false);

      if (likelyAcceptedByUploadWidget) {
        return true;
      }
    } catch (_error) {
      // Try upload triggers and other frames.
    } finally {
      await inputLocator.evaluate((control) => {
        if (control instanceof HTMLElement) {
          control.removeAttribute("data-gradlaunch-resume-input");
        }
      }).catch(() => undefined);
    }
  }

  return false;
}

async function hasExistingAttachedFile(page: Page) {
  for (const frame of page.frames()) {
    const alreadyAttached = await frame.evaluate(() => {
      const attachedControls = getSearchRoots().flatMap((root) => Array.from(root.querySelectorAll("input[type='file']"))).filter((control): control is HTMLInputElement => {
        return control instanceof HTMLInputElement && !control.disabled && (control.files?.length ?? 0) > 0;
      });

      if (attachedControls.length === 0) {
        return false;
      }

      return attachedControls.some((control) => {
        const descriptor = normalize([
          control.accept,
          control.name,
          control.id,
          control.getAttribute("aria-label"),
          control.labels?.[0]?.textContent,
          control.closest("label, section, article, fieldset, [role='group'], div")?.textContent
        ].filter(Boolean).join(" "));

        return /\b(resume|cv|curriculum vitae)\b/.test(descriptor) && !/\bcover letter\b/.test(descriptor);
      }) || (attachedControls.length === 1 && !attachedControls.some((control) => {
        const descriptor = normalize([
          control.name,
          control.id,
          control.getAttribute("aria-label"),
          control.closest("label, section, article, fieldset, [role='group'], div")?.textContent
        ].filter(Boolean).join(" "));
        return /\bcover letter\b/.test(descriptor);
      }));

      function normalize(value: string) {
        return value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      }

      function getSearchRoots() {
        const roots: Array<Document | ShadowRoot> = [document];

        for (let index = 0; index < roots.length; index += 1) {
          const root = roots[index];
          const elements = Array.from(root.querySelectorAll("*")) as HTMLElement[];

          for (const element of elements) {
            if (element.shadowRoot) {
              roots.push(element.shadowRoot);
            }
          }
        }

        return roots;
      }
    }).catch(() => false);

    if (alreadyAttached) {
      return true;
    }
  }

  return false;
}

async function attachResumeViaUploadTrigger(page: Page, resumePath: string) {
  for (const frame of page.frames()) {
    const trigger = await findResumeUploadTrigger(frame);

    if (!trigger) {
      continue;
    }

    try {
      const wasMethodChoiceScreen = await pageHasResumeMethodChoice(frame.page());
      const uploadedViaAssociatedInput = await attachResumeToAssociatedInput(frame, trigger, resumePath);

      if (uploadedViaAssociatedInput) {
        if (wasMethodChoiceScreen) {
          return await waitForMethodChoiceUploadAcceptance(frame.page(), resumePath);
        }

        return true;
      }

      const chooser = await Promise.all([
        frame.page().waitForEvent("filechooser", { timeout: 2500 }).catch(() => undefined),
        trigger.click({ force: true, timeout: 1200 }).catch(() => undefined)
      ]).then(([fileChooser]) => fileChooser);

      if (!chooser) {
        await frame.page().waitForTimeout(900).catch(() => undefined);

        if (await attachResumeToBestFileInput(frame.page(), resumePath)) {
          if (wasMethodChoiceScreen) {
            return await waitForMethodChoiceUploadAcceptance(frame.page(), resumePath);
          }

          return true;
        }

        if (wasMethodChoiceScreen && !await pageHasResumeMethodChoice(frame.page())) {
          return true;
        }

        continue;
      }

      await chooser.setFiles(resumePath);
      await frame.page().waitForTimeout(900).catch(() => undefined);

      if (wasMethodChoiceScreen) {
        return await waitForMethodChoiceUploadAcceptance(frame.page(), resumePath);
      }

      if (await verifyFileChooserSelection(chooser)) {
        return true;
      }

      if (await hasExistingAttachedFile(frame.page())) {
        return true;
      }

      if (wasMethodChoiceScreen && !await pageHasResumeMethodChoice(frame.page())) {
        return true;
      }

      return false;
    } catch (_error) {
      // Try the next frame.
    }
  }

  return false;
}

async function waitForMethodChoiceUploadAcceptance(page: Page, resumePath: string) {
  const timeoutMs = Number(process.env.BROWSER_METHOD_UPLOAD_ACCEPT_TIMEOUT_MS ?? 5000);
  const pollMs = 500;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    await page.waitForLoadState("domcontentloaded", { timeout: pollMs }).catch(() => undefined);
    await page.waitForTimeout(pollMs).catch(() => undefined);

    if (!await pageHasResumeMethodChoice(page)) {
      return true;
    }

    if (await continueAfterResumeUploadIfReady(page, resumePath)) {
      return true;
    }
  }

  return false;
}

export async function continueAfterResumeUploadIfReady(page: Page, resumePath?: string) {
  const resumeFileName = resumePath?.split(/[\\/]/).pop() ?? "";

  for (const frame of page.frames()) {
    const marker = `gl-resume-method-continue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const found = await frame.evaluate(({ marker, resumeFileName }) => {
      const uploadEvidence = findResumeUploadEvidence(resumeFileName);

      if (!uploadEvidence) {
        return false;
      }

      const searchRoots = getSearchRoots();
      const controls = searchRoots.flatMap((root) => Array.from(root.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit'], a"))) as HTMLElement[];
      let best: HTMLElement | undefined;
      let bestScore = Number.NEGATIVE_INFINITY;
      const uploadContainer = findUploadContainer(uploadEvidence);
      const uploadRect = (uploadContainer ?? uploadEvidence).getBoundingClientRect();

      for (const control of controls) {
        if (!isVisible(control) || isDisabled(control)) {
          continue;
        }

        const text = normalize([
          control.textContent,
          control.getAttribute("aria-label"),
          control instanceof HTMLInputElement ? control.value : ""
        ].filter(Boolean).join(" "));

        if (!/\b(continue|next|save and continue|save continue|proceed)\b/.test(text) || /\b(back|cancel|previous|without resume|without cv|copy paste|copy and paste|from device|from computer|upload|browse|choose file|select file|replace|remove|delete)\b/.test(text)) {
          continue;
        }

        const controlContainer = findUploadContainer(control);
        const controlRect = control.getBoundingClientRect();
        const verticalDistance = Math.max(0, Math.max(controlRect.top - uploadRect.bottom, uploadRect.top - controlRect.bottom));
        const horizontalDistance = Math.max(0, Math.max(controlRect.left - uploadRect.right, uploadRect.left - controlRect.right));
        const overlapsHorizontally = horizontalDistance <= 120;
        let score = 110;

        if (controlContainer && uploadContainer && (controlContainer === uploadContainer || controlContainer.contains(uploadContainer) || uploadContainer.contains(controlContainer))) {
          score += 90;
        }

        if (verticalDistance <= 320 && overlapsHorizontally) {
          score += 80;
        }

        if (/\bcontinue\b/.test(text)) {
          score += 40;
        }

        score -= Math.min(verticalDistance / 8, 80);

        if (score > bestScore) {
          bestScore = score;
          best = control;
        }
      }

      if (!best || bestScore < 100) {
        return false;
      }

      best.setAttribute("data-gradlaunch-resume-method-continue", marker);
      return true;

      function findResumeUploadEvidence(fileName: string) {
        const normalizedFileName = normalize(fileName);
        const roots = getSearchRoots();
        const inputs = roots.flatMap((root) => Array.from(root.querySelectorAll("input[type='file']"))) as HTMLInputElement[];
        const selectedInput = inputs.find((input) => {
          if (!input.files || input.files.length === 0 || input.disabled) {
            return false;
          }

          const descriptor = normalize([
            input.accept,
            input.name,
            input.id,
            input.getAttribute("aria-label"),
            input.closest("label, section, article, fieldset, form, [role='group'], div")?.textContent
          ].filter(Boolean).join(" "));

          return !/\b(cover letter|photo|image|avatar|profile picture|profile photo)\b/.test(descriptor);
        });

        if (selectedInput) {
          return selectedInput;
        }

        const textElements = roots.flatMap((root) => Array.from(root.querySelectorAll("div, span, p, label, li, output, strong, em, small, a"))) as HTMLElement[];

        return textElements.find((element) => {
          if (!isVisible(element)) {
            return false;
          }

          const rawText = (element.innerText || element.textContent || "").trim();

          if (!rawText || rawText.length > 360) {
            return false;
          }

          const text = normalize(rawText);

          if (normalizedFileName && (text.includes(normalizedFileName) || rawText.toLowerCase().includes(fileName.toLowerCase()))) {
            return true;
          }

          return /\b(pdf|doc|docx)\b/.test(text)
            && /\b(resume|cv|curriculum vitae|selected|attached|uploaded|upload complete|file)\b/.test(text)
            && !/\b(cover letter|photo|image|avatar|profile picture|profile photo)\b/.test(text);
        });
      }

      function findUploadContainer(element: HTMLElement) {
        let ancestor: HTMLElement | null = element;
        let best: HTMLElement | null = null;
        let bestScore = Number.NEGATIVE_INFINITY;

        for (let depth = 0; depth < 8 && ancestor; depth += 1) {
          const text = normalize(ancestor.innerText || ancestor.textContent || "");
          let score = 0;

          if (/\b(resume|cv|curriculum vitae|upload|attached|selected|pdf|doc|docx|continue)\b/.test(text)) {
            score += 100;
          }

          if (/\b(choose an option to apply|application method|without resume|copy paste|from device)\b/.test(text)) {
            score += 35;
          }

          score -= Math.min(text.length / 120, 60);
          score -= depth * 3;

          if (score > bestScore) {
            bestScore = score;
            best = ancestor;
          }

          ancestor = ancestor.parentElement;
        }

        return best;
      }

      function isVisible(element: HTMLElement) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
      }

      function isDisabled(element: HTMLElement) {
        return (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) && element.disabled
          || element.getAttribute("aria-disabled") === "true";
      }

      function normalize(value: string) {
        return value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      }

      function getSearchRoots() {
        const roots: Array<Document | ShadowRoot> = [document];

        for (let index = 0; index < roots.length; index += 1) {
          const root = roots[index];
          const elements = Array.from(root.querySelectorAll("*")) as HTMLElement[];

          for (const element of elements) {
            if (element.shadowRoot) {
              roots.push(element.shadowRoot);
            }
          }
        }

        return roots;
      }
    }, { marker, resumeFileName }).catch(() => false);

    if (!found) {
      continue;
    }

    const clicked = await frame.evaluate((marker) => {
      for (const root of getSearchRoots()) {
        const control = root.querySelector(`[data-gradlaunch-resume-method-continue="${marker}"]`);

        if (control instanceof HTMLElement) {
          control.scrollIntoView({ block: "center", inline: "center" });
          control.click();
          control.removeAttribute("data-gradlaunch-resume-method-continue");
          return true;
        }
      }

      return false;

      function getSearchRoots() {
        const roots: Array<Document | ShadowRoot> = [document];

        for (let index = 0; index < roots.length; index += 1) {
          const root = roots[index];
          const elements = Array.from(root.querySelectorAll("*")) as HTMLElement[];

          for (const element of elements) {
            if (element.shadowRoot) {
              roots.push(element.shadowRoot);
            }
          }
        }

        return roots;
      }
    }, marker).catch(() => false);

    if (!clicked) {
      continue;
    }

    await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => undefined);
    await page.waitForTimeout(1200).catch(() => undefined);
    return true;
  }

  return false;
}

async function verifyFileChooserSelection(chooser: FileChooser) {
  return chooser.element().evaluate((control) => {
    return control instanceof HTMLInputElement && (control.files?.length ?? 0) > 0;
  }).catch(() => false);
}

async function pageHasResumeMethodChoice(page: Page) {
  for (const frame of page.frames()) {
    const found = await frame.evaluate(() => {
      const text = normalize([
        document.body?.innerText ?? "",
        document.body?.textContent ?? "",
        ...Array.from(document.querySelectorAll("button, [role='button'], a, label")).map((element) => element.textContent ?? "")
      ].join(" "));

      return /\b(choose an option to apply|application method|application methods|how would you like to apply|apply with)\b/.test(text)
        && /\b(from device|from computer|upload from device|upload from computer|select from device)\b/.test(text)
        && /\b(without resume|without cv|copy paste|copy and paste)\b/.test(text);

      function normalize(value: string) {
        return value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      }
    }).catch(() => false);

    if (found) {
      return true;
    }
  }

  return false;
}

async function findResumeUploadTrigger(frame: Frame) {
  const marker = `gl-resume-trigger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const found = await frame.evaluate((marker) => {
    const searchRoots = getSearchRoots();
    const candidates = searchRoots.flatMap((root) => Array.from(root.querySelectorAll("button, [role='button'], label, a, div, span"))) as HTMLElement[];
    let best: HTMLElement | undefined;
    let bestScore = 0;
    const pageText = normalize([
      document.body?.innerText ?? "",
      document.body?.textContent ?? "",
      ...candidates.map((element) => element.innerText || element.textContent || "")
    ].join(" "));
    const pageLooksLikeResumeMethodChoice = looksLikeResumeMethodChoice(pageText);

    for (const candidate of candidates) {
      if (!isVisible(candidate)) {
        continue;
      }

      const ownText = normalize(candidate.innerText || candidate.textContent || "");
      const isDeviceUploadChoice = pageLooksLikeResumeMethodChoice
        && /\b(from device|upload from device|upload from computer|from computer|from my device|select from device)\b/.test(ownText)
        && !/\b(without resume|without cv|copy paste|copy and paste|paste|manual)\b/.test(ownText);

      if ((!isDeviceUploadChoice && !/\b(attach|upload|browse|choose(?: a)? file|select file|drop (?:it|file|resume|cv) here|drag and drop)\b/.test(ownText)) || /\b(dropbox|enter manually|manual)\b/.test(ownText)) {
        continue;
      }

      const section = findBestResumeSection(candidate);
      const nearbyText = normalize(findNearbyUploadLabel(candidate));
      const descriptor = normalize([
        ownText,
        nearbyText,
        candidate.getAttribute("aria-label"),
        candidate.id,
        candidate.className,
        section?.querySelector("legend, h1, h2, h3, h4, label")?.textContent,
        section?.textContent
      ].filter(Boolean).join(" "));
      let score = 0;

      if (/\b(resume|cv|curriculum vitae|resume cv)\b/.test(nearbyText)) {
        score += 220;
      }

      if (/\bcover letter\b/.test(nearbyText) && !/\b(resume|cv|curriculum vitae)\b/.test(nearbyText)) {
        score -= 260;
      }

      if (/\b(resume|cv|curriculum vitae|resume cv)\b/.test(descriptor)) {
        score += 150;
      }

      if (/\bcover letter\b/.test(descriptor) && !/\bresume|cv|curriculum vitae\b/.test(descriptor)) {
        score -= 240;
      }

      if (/\b(?:attach|upload|browse|choose(?: a)? file|select file|drop (?:it|file|resume|cv) here|drag and drop)\b/.test(ownText)) {
        score += 35;
      }

      if (isDeviceUploadChoice) {
        score += 260;
      }

      if (pageLooksLikeResumeMethodChoice && /\b(without resume|without cv|copy paste|copy and paste|paste)\b/.test(ownText)) {
        score -= 300;
      }

      if (candidate.matches("button, [role='button'], label")) {
        score += 15;
      }

      if (candidate.matches("a, button, [role='button'], label") && /\bchoose(?: a)? file|select file|browse\b/.test(ownText)) {
        score += 55;
      }

      if (section?.textContent && normalize(section.textContent).length < 500) {
        score += 10;
      }

      score -= Math.min(Math.max(0, ownText.length - 80) / 12, 55);

      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    if (!best || bestScore < 60) {
      return false;
    }

    best.setAttribute("data-gradlaunch-resume-trigger", marker);
    return true;

    function isVisible(element: HTMLElement) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0 && rect.width > 0 && rect.height > 0;
    }

    function normalize(value: string) {
      return value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    }

    function looksLikeResumeMethodChoice(value: string) {
      return /\b(choose an option to apply|application method|application methods|how would you like to apply|apply with)\b/.test(value)
        && /\b(without resume|without cv|copy paste|copy and paste|from device|from computer|upload from device|upload resume|resume)\b/.test(value);
    }

    function getSearchRoots() {
      const roots: Array<Document | ShadowRoot> = [document];

      for (let index = 0; index < roots.length; index += 1) {
        const root = roots[index];
        const elements = Array.from(root.querySelectorAll("*")) as HTMLElement[];

        for (const element of elements) {
          if (element.shadowRoot) {
            roots.push(element.shadowRoot);
          }
        }
      }

      return roots;
    }

    function findBestResumeSection(element: HTMLElement) {
      let ancestor: Element | null = element;
      let best: Element | undefined;
      let bestScore = Number.NEGATIVE_INFINITY;

      for (let depth = 0; depth < 8 && ancestor; depth += 1) {
        const text = normalize(ancestor.textContent ?? "");
        let score = 0;

        if (/\b(resume|cv|curriculum vitae|resume cv)\b/.test(text)) {
          score += 140;
        }

        if (/\bcover letter\b/.test(text)) {
          score -= text.includes("resume") || text.includes("cv") ? 35 : 180;
        }

        score -= Math.min(text.length / 80, 40);
        score -= depth * 4;

        if (score > bestScore) {
          bestScore = score;
          best = ancestor;
        }

        ancestor = ancestor.parentElement;
      }

      return best;
    }

    function findNearbyUploadLabel(element: HTMLElement) {
      const targetRect = element.getBoundingClientRect();
      const candidates = getSearchRoots().flatMap((root) => Array.from(root.querySelectorAll("label, legend, h1, h2, h3, h4, p, span, div"))) as HTMLElement[];
      let best = "";
      let bestScore = Number.NEGATIVE_INFINITY;

      for (const candidate of candidates) {
        if (candidate === element || !isVisible(candidate)) {
          continue;
        }

        const text = normalize(candidate.innerText || candidate.textContent || "");

        if (!/\b(resume|cv|curriculum vitae|cover letter)\b/.test(text)) {
          continue;
        }

        const rect = candidate.getBoundingClientRect();
        const verticalDistance = Math.max(0, targetRect.top - rect.bottom);
        const overlapsHorizontally = rect.right >= targetRect.left - 40 && rect.left <= targetRect.right + 40;

        if (verticalDistance > 260 || (!overlapsHorizontally && verticalDistance > 80)) {
          continue;
        }

        let score = 120 - verticalDistance;

        if (overlapsHorizontally) {
          score += 50;
        }

        if (/\b(resume|cv|curriculum vitae|resume cv)\b/.test(text)) {
          score += 120;
        }

        if (/\bcover letter\b/.test(text)) {
          score -= 140;
        }

        if (score > bestScore) {
          bestScore = score;
          best = text;
        }
      }

      return best;
    }
  }, marker).catch(() => false);

  if (!found) {
    return undefined;
  }

  return frame.locator(`[data-gradlaunch-resume-trigger="${marker}"]`).first();
}

async function attachResumeToAssociatedInput(frame: Frame, trigger: Locator, resumePath: string) {
  const marker = `gl-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const found = await trigger.evaluate((element, targetMarker) => {
    const candidates = new Set<HTMLInputElement>();
    const triggerDescriptor = normalize([
      element.textContent,
      element.getAttribute("aria-label"),
      element.id,
      element.className,
      element.closest("label, section, article, fieldset, [role='group'], [class*='upload'], [class*='drop'], [class*='file'], div")?.textContent
    ].filter(Boolean).join(" "));

    const addIfFileInput = (candidate: Element | null | undefined) => {
      if (candidate instanceof HTMLInputElement && candidate.type === "file" && !candidate.disabled) {
        candidates.add(candidate);
      }
    };

    addIfFileInput(element.querySelector("input[type='file']"));
    addIfFileInput(element.closest("label")?.querySelector("input[type='file']"));
    addIfFileInput(element.closest("section, article, fieldset, [role='group'], [class*='upload'], [class*='field'], [class*='question'], div")?.querySelector("input[type='file']"));

    if (element instanceof HTMLLabelElement && element.htmlFor) {
      addIfFileInput(document.getElementById(element.htmlFor));
    }

    if (element instanceof HTMLElement) {
      let ancestor: Element | null = element;

      for (let depth = 0; depth < 6 && ancestor; depth += 1) {
        addIfFileInput(ancestor.querySelector("input[type='file']"));
        addIfFileInput(ancestor.previousElementSibling?.querySelector("input[type='file']"));
        addIfFileInput(ancestor.nextElementSibling?.querySelector("input[type='file']"));
        ancestor = ancestor.parentElement;
      }
    }

    for (const input of getSearchRoots().flatMap((root) => Array.from(root.querySelectorAll("input[type='file']"))) as HTMLInputElement[]) {
      if (input.disabled) {
        continue;
      }

      if (candidates.size === 0 || isNearTrigger(input) || /\b(resume|cv|curriculum vitae|upload|attach|choose(?: a)? file|drop (?:it|file|resume|cv) here)\b/.test(triggerDescriptor)) {
        candidates.add(input);
      }
    }

    if (element instanceof HTMLElement) {
      const labelledBy = element.getAttribute("aria-labelledby");

      if (labelledBy) {
        for (const id of labelledBy.split(/\s+/)) {
          addIfFileInput(document.getElementById(id)?.querySelector("input[type='file']"));
        }
      }
    }

    const best = [...candidates].sort((first, second) => score(second) - score(first))[0];

    if (!best || score(best) < 60) {
      return false;
    }

    best.setAttribute("data-gradlaunch-upload-target", targetMarker);
    return true;

    function score(input: HTMLInputElement) {
      const descriptor = normalize([
        input.accept,
        input.name,
        input.id,
        input.getAttribute("aria-label"),
        input.getAttribute("data-testid"),
        input.closest("label, section, article, fieldset, [role='group'], div")?.textContent
      ].filter(Boolean).join(" "));

      let total = 0;

      if (/resume|cv|curriculum vitae/.test(descriptor)) {
        total += 120;
      }

      if (/resume|cv|curriculum vitae/.test(triggerDescriptor)) {
        total += 80;
      }

      if (/upload|attach|browse|choose(?: a)? file|select file|drop (?:it|file|resume|cv) here|drag and drop/.test(triggerDescriptor)) {
        total += 20;
      }

      if (/\bchoose(?: a)? file|select file|browse|drop (?:it|file|resume|cv) here\b/.test(triggerDescriptor) && !/photo|image|avatar|profile picture|profile photo/.test(descriptor)) {
        total += /pdf|doc|docx/.test(input.accept) ? 45 : 25;
      }

      if (/pdf|doc|docx/.test(input.accept)) {
        total += 18;
      }

      if (/cover letter/.test(descriptor) && !/resume|cv|curriculum vitae/.test(descriptor)) {
        total -= 220;
      }

      return total;
    }

    function isNearTrigger(input: HTMLInputElement) {
      const triggerElement = element instanceof HTMLElement ? element : undefined;

      if (!triggerElement) {
        return false;
      }

      if (triggerElement.contains(input) || input.closest("label, section, article, fieldset, [role='group'], [class*='upload'], [class*='drop'], [class*='file'], div")?.contains(triggerElement)) {
        return true;
      }

      const triggerRect = triggerElement.getBoundingClientRect();
      const inputContainer = input.closest("label, section, article, fieldset, [role='group'], [class*='upload'], [class*='drop'], [class*='file'], div") as HTMLElement | null;
      const rect = (inputContainer ?? input).getBoundingClientRect();
      const verticalDistance = Math.max(0, Math.max(triggerRect.top - rect.bottom, rect.top - triggerRect.bottom));
      const overlapsHorizontally = rect.right >= triggerRect.left - 80 && rect.left <= triggerRect.right + 80;

      return verticalDistance <= 320 && overlapsHorizontally;
    }

    function getSearchRoots() {
      const roots: Array<Document | ShadowRoot> = [document];

      for (let index = 0; index < roots.length; index += 1) {
        const root = roots[index];
        const elements = Array.from(root.querySelectorAll("*")) as HTMLElement[];

        for (const item of elements) {
          if (item.shadowRoot) {
            roots.push(item.shadowRoot);
          }
        }
      }

      return roots;
    }

    function normalize(value: string) {
      return value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    }
  }, marker).catch(() => false);

  if (!found) {
    return false;
  }

  const inputLocator = frame.locator(`[data-gradlaunch-upload-target="${marker}"]`).first();

  try {
    await inputLocator.setInputFiles(resumePath, { timeout: 2500 });
    await frame.page().waitForTimeout(450).catch(() => undefined);
    const verified = await inputLocator.evaluate((control) => {
      return control instanceof HTMLInputElement && (control.files?.length ?? 0) > 0;
    }).catch(() => false);

    if (verified) {
      return true;
    }

    return await inputLocator.evaluate((control) => {
      if (!(control instanceof HTMLInputElement)) {
        return false;
      }

      const descriptor = [
        control.accept,
        control.name,
        control.id,
        control.getAttribute("aria-label"),
        control.getAttribute("data-testid"),
        control.closest("label, section, article, fieldset, [role='group'], div")?.textContent
      ].filter(Boolean).join(" ").toLowerCase();

      return /pdf|doc|docx|resume|cv|curriculum vitae|upload|attach|file/.test(descriptor)
        && !/photo|image|avatar|profile picture|profile photo|cover letter/.test(descriptor);
    }).catch(() => false);
  } catch (_error) {
    return false;
  } finally {
    await inputLocator.evaluate((control) => {
      if (control instanceof HTMLElement) {
        control.removeAttribute("data-gradlaunch-upload-target");
      }
    }).catch(() => undefined);
  }
}

async function fillByAgentFieldId(page: Page, field: BrowserFillField, preferredStrategy?: FillStrategy) {
  if (!field.fieldId || !field.value.trim()) {
    return false;
  }

  if (!isNonTextPreferredStrategy(preferredStrategy) && shouldPreferPlaywrightFieldTarget(field) && await fillByPlaywrightFieldTarget(page, field)) {
    return true;
  }

  for (const frame of page.frames()) {
    const filled = await frame.evaluate(
      ({ fieldId, fieldValue, preferredStrategy }) => {
        const control = findByAgentFieldId(fieldId);

        if (
          !control
          || !(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement)
          || (control instanceof HTMLInputElement && ["hidden", "file", "submit", "button"].includes(control.type))
          || ("disabled" in control && control.disabled)
        ) {
          return false;
        }

        const normalizedValue = normalize(fieldValue);
        (control as HTMLElement).scrollIntoView?.({ block: "center", inline: "center" });

        if (preferredStrategy === "choice" && !(control instanceof HTMLInputElement && ["radio", "checkbox"].includes(control.type))) {
          return false;
        }

        if ((preferredStrategy === "native_select" || preferredStrategy === "custom_select" || preferredStrategy === "autocomplete") && !(control instanceof HTMLSelectElement) && !isCustomSelectLike(control)) {
          return false;
        }

        if (isCustomSelectLike(control)) {
          return hasCommittedSelectLikeValue(control, normalizedValue);
        }

        if (control instanceof HTMLSelectElement) {
          const option = Array.from(control.options).find((item) => normalize(item.text) === normalizedValue || normalize(item.value) === normalizedValue)
            ?? Array.from(control.options).find((item) => normalize(item.text).includes(normalizedValue) || normalizedValue.includes(normalize(item.text)));

          if (!option) {
            return false;
          }

          control.focus();
          control.value = option.value;
          dispatch(control);
          return true;
        }

        if (control instanceof HTMLInputElement && ["radio", "checkbox"].includes(control.type)) {
          const group = control.name
            ? Array.from(document.querySelectorAll(`input[name="${CSS.escape(control.name)}"]`)) as HTMLInputElement[]
            : [control];
          const descriptor = normalize([
            getOptionText(control),
            control.getAttribute("aria-label"),
            control.name,
            control.id,
            control.closest("fieldset, [role='group'], section, article, [class*='question'], [class*='field']")?.textContent
          ].filter(Boolean).join(" "));
          const isCountryOrLocationList = /\b(country|countries|location|locations)\b/.test(descriptor)
            && !/\b(terms|privacy|consent|agree|acknowledge|declaration)\b/.test(descriptor);
          const target = group.find((item) => normalize(getOptionText(item)) === normalizedValue || normalize(item.value) === normalizedValue)
            ?? group.find((item) => normalize(getOptionText(item)).includes(normalizedValue) || normalizedValue.includes(normalize(getOptionText(item))))
            ?? (!isCountryOrLocationList && /^(yes|true|agree|accept|consent|confirm|i agree)$/.test(normalizedValue) ? control : undefined);

          if (!target) {
            return false;
          }

          if (control.type === "checkbox" && isCountryOrLocationList && target !== control) {
            for (const item of group) {
              if (item !== target && item.checked) {
                clickChoiceControl(item, false);
                dispatch(item);
              }
            }
          }

          clickChoiceControl(target, true);
          return true;
        }

        if (preferredStrategy && preferredStrategy !== "text" && preferredStrategy !== "date") {
          return false;
        }

        if (normalize(control.value) === normalizedValue || normalize(control.value).includes(normalizedValue)) {
          dispatch(control);
          return true;
        }

        control.focus();
        setNativeValue(control, fieldValue);
        dispatch(control);
        return normalize(control.value) === normalizedValue || normalize(control.value).includes(normalizedValue);

        function dispatch(element: Element) {
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
          element.dispatchEvent(new Event("blur", { bubbles: true }));

          if (element instanceof HTMLInputElement && element.form) {
            element.form.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }

        function clickChoiceControl(input: HTMLInputElement, checked: boolean) {
          const clickTarget = getChoiceClickTarget(input);

          clickTarget.scrollIntoView?.({ block: "center", inline: "center" });
          input.focus();

          try {
            clickTarget.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
            clickTarget.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, view: window }));
          } catch (_error) {
            clickTarget.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
            clickTarget.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
          }

          clickTarget.click();

          if (input.type === "radio" && checked) {
            const group = input.name
              ? Array.from(document.querySelectorAll(`input[name="${CSS.escape(input.name)}"]`)) as HTMLInputElement[]
              : [input];

            for (const item of group) {
              if (item !== input && item.checked) {
                setNativeChecked(item, false);
                dispatch(item);
              }
            }
          }

          if (input.checked !== checked) {
            setNativeChecked(input, checked);
          }

          dispatch(input);

          input.blur();
        }

        function getChoiceClickTarget(input: HTMLInputElement) {
          if (input.id) {
            const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);

            if (label instanceof HTMLElement) {
              return label;
            }
          }

          const closestLabel = input.closest("label");

          if (closestLabel instanceof HTMLElement) {
            return closestLabel;
          }

          const clickableAncestor = input.closest("button, [role='radio'], [role='checkbox'], [role='button'], [aria-checked], [tabindex]");

          return clickableAncestor instanceof HTMLElement ? clickableAncestor : input;
        }

        function setNativeChecked(input: HTMLInputElement, checked: boolean) {
          const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");

          if (descriptor?.set) {
            descriptor.set.call(input, checked);
          } else {
            input.checked = checked;
          }
        }

        function setNativeValue(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
          const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

          if (descriptor?.set) {
            descriptor.set.call(control, value);
          } else {
            control.value = value;
          }
        }

        function getOptionText(input: HTMLInputElement) {
          if (input.id) {
            const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);

            if (label?.textContent?.trim()) {
              return label.textContent.trim();
            }
          }

          return input.closest("label")?.textContent?.trim() || input.parentElement?.textContent?.trim() || input.value;
        }

        function normalize(value: string) {
          return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        }

        function isCustomSelectLike(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
          if (control instanceof HTMLSelectElement) {
            return false;
          }

          const popup = control.getAttribute("aria-haspopup") ?? "";
          const role = control.getAttribute("role") ?? "";
          const expanded = control.getAttribute("aria-expanded");

          if (role === "combobox" || /^(listbox|menu|dialog|tree|true)$/i.test(popup) || expanded !== null) {
            return true;
          }

          let ancestor = control.parentElement;

          for (let depth = 0; depth < 3 && ancestor; depth += 1) {
            const ancestorRole = ancestor.getAttribute("role") ?? "";
            const ancestorPopup = ancestor.getAttribute("aria-haspopup") ?? "";
            const ancestorExpanded = ancestor.getAttribute("aria-expanded");
            const className = String(ancestor.getAttribute("class") ?? "");

            if (
              ancestorRole === "combobox"
              || /^(listbox|menu|dialog|tree|true)$/i.test(ancestorPopup)
              || ancestorExpanded !== null
              || ancestor.hasAttribute("data-radix-select-trigger")
              || ancestor.hasAttribute("data-headlessui-state")
              || /\b(combobox|select__control|select-control|select-trigger|select-input)\b/i.test(className)
            ) {
              return true;
            }

            ancestor = ancestor.parentElement;
          }

          return false;
        }

        function hasCommittedSelectLikeValue(control: HTMLElement, wanted: string) {
          const describedBy = control.getAttribute("aria-describedby") ?? "";
          const labelledBy = control.getAttribute("aria-labelledby") ?? "";
          const container = control.closest("[role='combobox'], [aria-haspopup='listbox'], [data-radix-select-trigger], [data-headlessui-state], [class*='select'], [class*='combobox']")
            ?? control.parentElement;
          const selectedText = normalize([
            control.getAttribute("data-value"),
            control.getAttribute("aria-valuetext"),
            container?.getAttribute("data-value"),
            container?.getAttribute("aria-valuetext"),
            container?.querySelector("[aria-selected='true'], [data-selected='true'], [data-state='checked']")?.textContent,
            describedBy
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent ?? "")
              .join(" "),
            labelledBy
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent ?? "")
              .join(" ")
          ].filter(Boolean).join(" "));

          return Boolean(selectedText)
            && !/select|choose|search|type to search|results found|no results found/.test(selectedText)
            && (selectedText.includes(wanted) || wanted.includes(selectedText));
        }

        function findByAgentFieldId(id: string) {
          for (const root of getSearchRoots()) {
            const match = root.querySelector(`[data-gradlaunch-field-id="${CSS.escape(id)}"]`);

            if (match) {
              return match;
            }
          }

          return null;
        }

        function getSearchRoots() {
          const roots: Array<Document | ShadowRoot> = [document];

          for (let index = 0; index < roots.length; index += 1) {
            const root = roots[index];
            const elements = Array.from(root.querySelectorAll("*")) as HTMLElement[];

            for (const element of elements) {
              if (element.shadowRoot) {
                roots.push(element.shadowRoot);
              }
            }
          }

          return roots;
        }
      },
      { fieldId: field.fieldId, fieldValue: field.value, preferredStrategy }
    ).catch(() => false);

    if (filled) {
      return true;
    }
  }

  if (field.inputType === "combobox" || isNonTextPreferredStrategy(preferredStrategy)) {
    return false;
  }

  return fillByPlaywrightFieldTarget(page, field);
}

function isNonTextPreferredStrategy(strategy: FillStrategy | undefined) {
  return strategy === "choice"
    || strategy === "native_select"
    || strategy === "custom_select"
    || strategy === "autocomplete";
}

function shouldPreferPlaywrightFieldTarget(field: BrowserFillField) {
  const inputType = field.inputType ?? "";

  return !["checkbox", "radio", "select", "combobox", "file"].includes(inputType);
}

async function fillByPlaywrightFieldTarget(page: Page, field: BrowserFillField) {
  if (!field.fieldId || !field.value.trim()) {
    return false;
  }

  const normalizedExpected = normalizeInline(field.value);

  for (const frame of page.frames()) {
    const locator = frame.locator(`[data-gradlaunch-field-id="${field.fieldId}"]`).first();

    try {
      if (!await locator.isVisible({ timeout: 300 })) {
        continue;
      }

      if (field.inputType === "select") {
        await locator.selectOption({ label: field.value }).catch(async () => {
          await locator.selectOption({ value: field.value });
        });
      } else if (field.inputType === "checkbox" || field.inputType === "radio") {
        await locator.check({ force: true });
      } else {
        if (await commitTextLikeLocator(locator, field, field.inputType === "date" ? "date" : "text")) {
          return true;
        }

        continue;
      }

      const verified = await locator.evaluate((element, expected) => {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
          const actual = normalize(element.value);

          if (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)) {
            return element.checked;
          }

          return actual === expected || actual.includes(expected) || expected.includes(actual);
        }

        return false;

        function normalize(value: string) {
          return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        }
      }, normalizedExpected).catch(() => false);

      if (verified && await verifyLocatorCommitted(locator, field, {
        kind: field.inputType === "select" ? "select" : field.inputType === "checkbox" || field.inputType === "radio" ? field.inputType : "text",
        allowPartial: false
      })) {
        return true;
      }
    } catch (_error) {
      // Fall back to DOM-level setters below.
    }
  }

  return false;
}

async function fillByFreshLabelTarget(page: Page, field: BrowserFillField) {
  const value = field.value.trim();

  if (!value || ["file", "checkbox", "radio"].includes(field.inputType ?? "")) {
    return false;
  }

  for (const frame of page.frames()) {
    const marker = `gl-fresh-field-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const found = await frame.evaluate(({ fieldId, label, inputType, value, marker }) => {
      const searchRoots = getSearchRoots();
      const controls = searchRoots.flatMap((root) => Array.from(root.querySelectorAll("input, textarea, select"))) as Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>;
      const labelKey = normalize(label);
      const semanticIntent = inferSemanticIntent(`${label} ${value}`);
      const semanticAliases = getSemanticAliases(semanticIntent);
      let best: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | undefined;
      let bestScore = 0;

      for (const control of controls) {
        if (!isUsableControl(control, inputType)) {
          continue;
        }

        const descriptor = normalize([
          control.getAttribute("aria-label"),
          control.getAttribute("placeholder"),
          control.getAttribute("name"),
          control.id,
          labelledByText(control),
          findLabelText(control),
          findNearbyLabelText(control),
          compactContainerText(control)
        ].filter(Boolean).join(" "));
        const idMatches = Boolean(fieldId && control.getAttribute("data-gradlaunch-field-id") === fieldId);
        const score = scoreDescriptor(descriptor, labelKey, inputType, control, semanticIntent, semanticAliases) + (idMatches ? 120 : 0);

        if (score > bestScore) {
          best = control;
          bestScore = score;
        }
      }

      if (!best || bestScore < (semanticIntent ? 48 : 58)) {
        return false;
      }

      best.setAttribute("data-gradlaunch-fresh-field-target", marker);
      return true;

      function isUsableControl(
        control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
        wantedType: string | undefined
      ) {
        if (control.disabled) {
          return false;
        }

        if (control instanceof HTMLInputElement && ["hidden", "file", "submit", "button", "checkbox", "radio"].includes(control.type)) {
          return false;
        }

        if (wantedType === "select" && !(control instanceof HTMLSelectElement) && !(control instanceof HTMLInputElement && isCustomSelectLike(control))) {
          return false;
        }

        if (wantedType && wantedType !== "select" && control instanceof HTMLSelectElement) {
          return false;
        }

        const rect = control.getBoundingClientRect();
        const style = window.getComputedStyle(control);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      }

      function isCustomSelectLike(control: HTMLInputElement) {
        const popup = control.getAttribute("aria-haspopup") ?? "";
        const role = control.getAttribute("role") ?? "";
        const expanded = control.getAttribute("aria-expanded");

        if (role === "combobox" || /^(listbox|menu|dialog|tree|true)$/i.test(popup) || expanded !== null) {
          return true;
        }

        let ancestor = control.parentElement;

        for (let depth = 0; depth < 3 && ancestor; depth += 1) {
          const ancestorRole = ancestor.getAttribute("role") ?? "";
          const ancestorPopup = ancestor.getAttribute("aria-haspopup") ?? "";
          const ancestorExpanded = ancestor.getAttribute("aria-expanded");
          const className = String(ancestor.getAttribute("class") ?? "");

          if (
            ancestorRole === "combobox"
            || /^(listbox|menu|dialog|tree|true)$/i.test(ancestorPopup)
            || ancestorExpanded !== null
            || ancestor.hasAttribute("data-radix-select-trigger")
            || ancestor.hasAttribute("data-headlessui-state")
            || /\b(combobox|select__control|select-control|select-trigger|select-input)\b/i.test(className)
          ) {
            return true;
          }

          ancestor = ancestor.parentElement;
        }

        return false;
      }

      function scoreDescriptor(
        descriptor: string,
        wantedLabel: string,
        wantedType: string | undefined,
        control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
        semanticIntent: string | undefined,
        semanticAliases: string[]
      ) {
        if (!descriptor || !wantedLabel) {
          return 0;
        }

        let score = 0;

        if (descriptor === wantedLabel) {
          score += 150;
        } else if (descriptor.includes(wantedLabel)) {
          score += 118;
        } else if (wantedLabel.includes(descriptor) && descriptor.length > 3) {
          score += 92;
        }

        const tokens = wantedLabel
          .split(" ")
          .filter((token) => token.length > 1 && !/^(select|option|your|please|field|number)$/.test(token));
        score += tokens.reduce((sum, token) => sum + (descriptor.includes(token) ? 20 : 0), 0);
        score += tokenSimilarityScore(wantedLabel, descriptor, 50);

        for (const alias of semanticAliases) {
          const aliasKey = normalize(alias);

          if (aliasKey && descriptor.includes(aliasKey)) {
            score = Math.max(score, descriptor === aliasKey ? 118 : 92);
          }
        }

        if (semanticIntent && descriptorMatchesSemanticIntent(descriptor, semanticIntent)) {
          score = Math.max(score, 96);
        }

        if (/\b(home email|email|e mail)\b/.test(wantedLabel) && /\b(email|e mail)\b/.test(descriptor)) {
          score = Math.max(score, 88);
        }

        if (/\b(phone|mobile|contact)\b/.test(wantedLabel) && /\b(phone|mobile|contact|telephone)\b/.test(descriptor)) {
          score = Math.max(score, 88);
        }

        if (/\b(address line 1|street address|address)\b/.test(wantedLabel) && /\b(address|street)\b/.test(descriptor)) {
          score = Math.max(score, 86);
        }

        if (/\b(address line 2|address 2|apartment|suite)\b/.test(wantedLabel) && /\b(address|apartment|suite|line 2)\b/.test(descriptor)) {
          score = Math.max(score, 82);
        }

        if (/\bcity\b/.test(wantedLabel) && /\b(city|town|locality)\b/.test(descriptor)) {
          score = Math.max(score, 86);
        }

        if (/\b(state|province|region)\b/.test(wantedLabel) && /\b(state|province|region)\b/.test(descriptor)) {
          score = Math.max(score, 86);
        }

        if (/\bcountry\b/.test(wantedLabel) && /\bcountry\b/.test(descriptor)) {
          score = Math.max(score, 86);
        }

        if (/\b(degree name|major|field of study)\b/.test(wantedLabel) && /\b(degree|major|field of study|course)\b/.test(descriptor)) {
          score = Math.max(score, 84);
        }

        if (/\b(type of degree|degree type|education level)\b/.test(wantedLabel) && /\b(degree|education|level)\b/.test(descriptor)) {
          score = Math.max(score, 84);
        }

        if (/\b(university|college|school|institution)\b/.test(wantedLabel) && /\b(university|college|school|institution|institute)\b/.test(descriptor)) {
          score = Math.max(score, 86);
        }

        if (/\b(start date|from date)\b/.test(wantedLabel) && /\b(start|from|date)\b/.test(descriptor)) {
          score = Math.max(score, 84);
        }

        if (/\b(end date|to date|completion date|graduation date)\b/.test(wantedLabel) && /\b(end|to|completion|graduation|date)\b/.test(descriptor)) {
          score = Math.max(score, 84);
        }

        if (/\b(work experience|past working experience|professional experience)\b/.test(wantedLabel) && /\b(work|working|professional|experience)\b/.test(descriptor)) {
          score = Math.max(score, 86);
        }

        if (wantedType === "select" && (control instanceof HTMLSelectElement || control instanceof HTMLInputElement && isCustomSelectLike(control))) {
          score += 18;
        }

        if (wantedType && control instanceof HTMLInputElement && normalize(control.type) === normalize(wantedType)) {
          score += 12;
        }

        if (isRequired(control)) {
          score += 8;
        }

        return score;
      }

      function inferSemanticIntent(text: string) {
        const normalized = normalize(text);

        if (/\b(address line 2|address 2|apartment|apt|suite)\b/.test(normalized)) {
          return "address_2";
        }

        if (/\b(address line 1|address 1|street address|address)\b/.test(normalized)) {
          return "address_1";
        }

        if (/\b(postal|postcode|zip|pin code|pincode)\b/.test(normalized)) {
          return "postal_code";
        }

        if (/\bcountry\b/.test(normalized)) {
          return "country";
        }

        if (/\b(state|province|region)\b/.test(normalized)) {
          return "state";
        }

        if (/\b(city|current city|town|locality|place of residence|location city)\b/.test(normalized)) {
          return "city";
        }

        if (/\b(email|e mail)\b/.test(normalized)) {
          return "email";
        }

        if (/\b(phone|mobile|telephone|contact number)\b/.test(normalized)) {
          return "phone";
        }

        if (/\b(type of degree|degree type|education level|level of education)\b/.test(normalized)) {
          return "degree_type";
        }

        if (/\b(degree name|field of study|major|qualification|course of study)\b/.test(normalized)) {
          return "degree_name";
        }

        if (/\b(university|college|institution|institute|school)\b/.test(normalized)) {
          return "university";
        }

        if (/\b(start date|start year|from date|begin date|education start)\b/.test(normalized)) {
          return "education_start";
        }

        if (/\b(end date|end year|completion date|graduation date|education end)\b/.test(normalized)) {
          return "education_end";
        }

        if (/\b(past working experience|prior work experience|work experience|employment experience|professional experience)\b/.test(normalized)) {
          return "work_experience";
        }

        if (/\b(first name|given name|legal first)\b/.test(normalized)) {
          return "first_name";
        }

        if (/\b(last name|surname|family name|legal last)\b/.test(normalized)) {
          return "last_name";
        }

        return undefined;
      }

      function getSemanticAliases(intent: string | undefined) {
        const aliases: Record<string, string[]> = {
          first_name: ["first name", "given name", "legal first name"],
          last_name: ["last name", "surname", "family name", "legal last name"],
          address_1: ["address line 1", "address 1", "street address", "address"],
          address_2: ["address line 2", "address 2", "apartment", "suite"],
          country: ["country", "country region", "current country"],
          state: ["state", "province", "region", "state province"],
          city: ["city", "current city", "town", "locality", "place of residence", "location city"],
          postal_code: ["zip code", "postal code", "postcode", "pin code", "pincode"],
          email: ["email", "email address", "home email", "e mail"],
          phone: ["phone", "phone number", "mobile", "telephone", "contact number"],
          degree_name: ["degree name", "field of study", "major", "qualification", "course of study"],
          degree_type: ["type of degree", "degree type", "education level", "level of education"],
          university: ["university", "college", "institution", "institute", "school"],
          education_start: ["start date", "start year", "from date", "begin date"],
          education_end: ["end date", "end year", "completion date", "graduation date"],
          work_experience: ["work experience", "past working experience", "professional experience", "employment experience"]
        };

        return intent ? aliases[intent] ?? [] : [];
      }

      function descriptorMatchesSemanticIntent(descriptor: string, intent: string) {
        const patterns: Record<string, RegExp> = {
          first_name: /\b(first|given|legal first)\b/,
          last_name: /\b(last|surname|family|legal last)\b/,
          address_1: /\b(address line 1|address 1|street address|address)\b/,
          address_2: /\b(address line 2|address 2|apartment|apt|suite)\b/,
          country: /\bcountry\b/,
          state: /\b(state|province|region)\b/,
          city: /\b(city|town|locality|place of residence)\b/,
          postal_code: /\b(zip|postal|postcode|pin code|pincode)\b/,
          email: /\b(email|e mail)\b/,
          phone: /\b(phone|mobile|telephone|contact)\b/,
          degree_name: /\b(degree name|field of study|major|course|qualification)\b/,
          degree_type: /\b(type of degree|degree type|education level|level of education)\b/,
          university: /\b(university|college|school|institution|institute)\b/,
          education_start: /\b(start|from|begin).*\b(date|year)\b|\b(date|year).*\b(start|from|begin)\b/,
          education_end: /\b(end|to|completion|graduation).*\b(date|year)\b|\b(date|year).*\b(end|to|completion|graduation)\b/,
          work_experience: /\b(work|working|professional|employment).*\bexperience\b|\bexperience\b/
        };

        return Boolean(patterns[intent]?.test(descriptor));
      }

      function tokenSimilarityScore(left: string, right: string, maxScore: number) {
        const leftTokens = semanticTokens(left);
        const rightTokens = semanticTokens(right);

        if (leftTokens.size === 0 || rightTokens.size === 0) {
          return 0;
        }

        let overlap = 0;

        for (const token of leftTokens) {
          if (rightTokens.has(token)) {
            overlap += 1;
          }
        }

        const union = new Set([...leftTokens, ...rightTokens]).size;

        return Math.round((overlap / union) * maxScore);
      }

      function semanticTokens(text: string) {
        return new Set(
          normalize(text)
            .split(" ")
            .filter((token) => token.length > 1 && !/^(select|option|choose|please|your|the|field|required|number|name|date)$/.test(token))
        );
      }

      function labelledByText(control: Element) {
        const labelledBy = control.getAttribute("aria-labelledby");

        if (!labelledBy) {
          return "";
        }

        return labelledBy
          .split(/\s+/)
          .map((id) => getElementById(id)?.textContent ?? "")
          .join(" ");
      }

      function findLabelText(control: Element) {
        if (control.id) {
          const label = queryFirst(`label[for="${CSS.escape(control.id)}"]`, control);

          if (label?.textContent?.trim()) {
            return label.textContent.trim();
          }
        }

        return control.closest("label")?.textContent?.trim()
          || control.closest("fieldset")?.querySelector("legend")?.textContent?.trim()
          || "";
      }

      function findNearbyLabelText(control: Element) {
        let ancestor: Element | null = control.parentElement;

        for (let depth = 0; depth < 4 && ancestor; depth += 1) {
          const labels = Array.from(ancestor.querySelectorAll("label, legend, h1, h2, h3, h4, [class*='label'], [class*='Label']")) as HTMLElement[];
          const ownRect = control instanceof HTMLElement ? control.getBoundingClientRect() : undefined;
          const best = labels
            .map((item) => {
              const text = clean(item.innerText || item.textContent || "");
              const rect = item.getBoundingClientRect();
              const distance = ownRect ? Math.abs(rect.bottom - ownRect.top) + Math.abs(rect.left - ownRect.left) / 4 : 0;
              return { text, distance };
            })
            .filter((item) => item.text && item.text.length <= 140)
            .sort((left, right) => left.distance - right.distance)[0];

          if (best?.text) {
            return best.text;
          }

          const previous = ancestor.previousElementSibling?.textContent?.trim();

          if (previous) {
            return previous;
          }

          ancestor = ancestor.parentElement;
        }

        return "";
      }

      function compactContainerText(control: Element) {
        const container = control.closest("label, fieldset, [role='group'], [class*='field'], [class*='input'], [class*='form'], section, article, div");
        const text = clean(container?.textContent ?? "");

        return text.length <= 220 ? text : "";
      }

      function isRequired(control: Element) {
        const text = `${findLabelText(control)} ${findNearbyLabelText(control)} ${compactContainerText(control)}`;

        return (control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).required
          || control.getAttribute("aria-required") === "true"
          || control.getAttribute("aria-invalid") === "true"
          || /\*/.test(text)
          || Boolean(control.closest(".required, [class*='required'], [data-required='true']"));
      }

      function clean(value: string | null | undefined) {
        return (value ?? "").replace(/\s+/g, " ").replace(/\*/g, " ").trim();
      }

      function normalize(value: string | null | undefined) {
        return clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      }

      function queryFirst(selector: string, control: Element) {
        const root = control.getRootNode();

        if (root instanceof Document || root instanceof ShadowRoot || root instanceof Element) {
          const match = root.querySelector(selector);

          if (match) {
            return match;
          }
        }

        for (const searchRoot of searchRoots) {
          const match = searchRoot.querySelector(selector);

          if (match) {
            return match;
          }
        }

        return null;
      }

      function getElementById(id: string) {
        for (const searchRoot of searchRoots) {
          if ("getElementById" in searchRoot && typeof searchRoot.getElementById === "function") {
            const match = searchRoot.getElementById(id);

            if (match) {
              return match;
            }
          } else {
            const match = searchRoot.querySelector(`#${CSS.escape(id)}`);

            if (match) {
              return match;
            }
          }
        }

        return null;
      }

      function getSearchRoots() {
        const roots: Array<Document | ShadowRoot> = [document];

        for (let index = 0; index < roots.length; index += 1) {
          const root = roots[index];
          const elements = Array.from(root.querySelectorAll("*")) as HTMLElement[];

          for (const element of elements) {
            if (element.shadowRoot) {
              roots.push(element.shadowRoot);
            }
          }
        }

        return roots;
      }
    }, {
      fieldId: field.fieldId,
      label: field.label,
      inputType: field.inputType,
      value,
      marker
    }).catch(() => false);

    if (!found) {
      continue;
    }

    const target = frame.locator(`[data-gradlaunch-fresh-field-target="${marker}"]`).first();

    try {
      if (field.inputType === "select") {
        const selected = await target.evaluate((element, { fieldValue, fieldLabel }) => {
          if (!(element instanceof HTMLSelectElement)) {
            return false;
          }

          const wanted = normalize(fieldValue);
          const label = normalize(fieldLabel);
          const options = Array.from(element.options).filter((option) => {
            const text = normalize(`${option.textContent ?? ""} ${option.value ?? ""}`);
            return Boolean(text) && !/^(select|select an option|choose|choose an option|please select|none selected)$/.test(text);
          });
          const option = options.find((item) => normalize(item.textContent ?? item.value) === wanted || normalize(item.value) === wanted)
            ?? options.find((item) => normalize(item.textContent ?? item.value).includes(wanted) || wanted.includes(normalize(item.textContent ?? item.value)))
            ?? options.find((item) => matchesSemanticOption(normalize(`${item.textContent ?? ""} ${item.value ?? ""}`), wanted, label));

          if (!option) {
            return false;
          }

          const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");

          if (descriptor?.set) {
            descriptor.set.call(element, option.value);
          } else {
            element.value = option.value;
          }

          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          element.dispatchEvent(new Event("blur", { bubbles: true }));
          return !isEmptySelect(element);

          function matchesSemanticOption(optionText: string, wantedValue: string, labelText: string) {
            if (/\b(type of degree|degree type|education level)\b/.test(labelText)) {
              if (/\b(bachelor|b tech|btech|undergraduate|ug)\b/.test(wantedValue)) {
                return /\b(bachelor|b tech|btech|undergraduate|ug)\b/.test(optionText);
              }

              if (/\b(master|m tech|mtech|postgraduate|pg|mca|msc)\b/.test(wantedValue)) {
                return /\b(master|m tech|mtech|postgraduate|pg|mca|msc)\b/.test(optionText);
              }
            }

            if (/\b(work experience|past working experience|professional experience)\b/.test(labelText)) {
              if (/^(yes|true|1)$/.test(wantedValue)) {
                return /^yes\b|experience/.test(optionText);
              }

              if (/^(no|false|0)$/.test(wantedValue)) {
                return /^no\b|fresher|0/.test(optionText);
              }
            }

            return false;
          }

          function isEmptySelect(select: HTMLSelectElement) {
            const selected = select.selectedOptions[0];
            const value = normalize(`${selected?.textContent ?? ""} ${selected?.value ?? ""} ${select.value}`);
            return !value || /^(select|select an option|choose|choose an option|please select|none selected)$/.test(value);
          }

          function normalize(value: string | null | undefined) {
            return (value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
          }
        }, { fieldValue: value, fieldLabel: field.label }).catch(() => false);

        if (selected) {
          await target.press("Tab", { timeout: 350 }).catch(() => undefined);
          await target.blur().catch(() => undefined);

          if (!await verifyLocatorCommitted(target, field, { kind: "select", allowPartial: false })) {
            continue;
          }

          return true;
        }
      } else {
        if (await commitTextLikeLocator(target, { ...field, value }, field.inputType === "date" ? "date" : "text")) {
          return true;
        }
      }
    } catch (_error) {
      // Try the next frame.
    } finally {
      await target.evaluate((element) => {
        if (element instanceof HTMLElement) {
          element.removeAttribute("data-gradlaunch-fresh-field-target");
        }
      }).catch(() => undefined);
    }
  }

  return false;
}

async function fillTextField(page: Page, field: BrowserFillField) {
  if (!field.value.trim()) {
    return false;
  }

  const normalizedLabel = normalizeKey(field.label);

  for (const frame of page.frames()) {
    const filled = await frame.evaluate(
      ({ fieldId, label, value }) => {
        const searchRoots = getSearchRoots();
        const controls = searchRoots.flatMap((root) => Array.from(root.querySelectorAll("input, textarea"))) as Array<HTMLInputElement | HTMLTextAreaElement>;
        const semanticIntent = inferSemanticIntent(`${label} ${value}`);
        let best: HTMLInputElement | HTMLTextAreaElement | undefined;
        let bestScore = 0;

        for (const control of controls) {
          if (control instanceof HTMLInputElement && ["hidden", "file", "submit", "button", "checkbox", "radio"].includes(control.type)) {
            continue;
          }

          const rect = control.getBoundingClientRect();

          if (rect.width <= 0 || rect.height <= 0 || ("disabled" in control && control.disabled)) {
            continue;
          }

          const descriptor = normalize([
            control.getAttribute("aria-label"),
            control.getAttribute("placeholder"),
            control.getAttribute("name"),
            control.id,
            findLabelText(control),
            findNearbyLabelText(control),
            control.closest("fieldset, [role='group'], [class*='field'], [class*='input'], section, article")?.textContent
          ].filter(Boolean).join(" "));
          const idMatches = Boolean(fieldId && control.getAttribute("data-gradlaunch-field-id") === fieldId);
          const score = scoreText(descriptor, label, semanticIntent) + (idMatches ? 110 : 0);

          if (score > bestScore) {
            best = control;
            bestScore = score;
          }
        }

        if (!best || bestScore < (semanticIntent ? 36 : 40)) {
          return false;
        }

        best.focus();
        setNativeValue(best, value);
        best.dispatchEvent(new Event("input", { bubbles: true }));
        best.dispatchEvent(new Event("change", { bubbles: true }));
        best.dispatchEvent(new Event("blur", { bubbles: true }));
        return isFilled(best, value);

        function scoreText(descriptor: string, target: string, intent: string | undefined) {
          if (!descriptor || !target) {
            return 0;
          }

          if (descriptor === target) {
            return 100;
          }

          if (descriptor.includes(target) || target.includes(descriptor)) {
            return 75;
          }

          const targetTokens = target.split(" ").filter((token) => token.length > 1 && !/^(select|option|the|your|please)$/.test(token));
          const tokenScore = targetTokens.reduce((sum, token) => sum + (descriptor.includes(token) ? 18 : 0), 0);
          const semanticScore = intent && descriptorMatchesSemanticIntent(descriptor, intent) ? 74 : 0;
          const fuzzyScore = tokenSimilarityScore(target, descriptor, 44);

          if (/\b(home email|email)\b/.test(target) && /\b(email|e mail)\b/.test(descriptor)) {
            return Math.max(tokenScore, semanticScore, fuzzyScore, 72);
          }

          if (/\b(phone number|mobile|contact number)\b/.test(target) && /\b(phone|mobile|contact)\b/.test(descriptor)) {
            return Math.max(tokenScore, semanticScore, fuzzyScore, 72);
          }

          if (/\b(city)\b/.test(target) && /\b(city|town|place)\b/.test(descriptor)) {
            return Math.max(tokenScore, semanticScore, fuzzyScore, 70);
          }

          if (/\b(address line 1|street address|address)\b/.test(target) && /\b(address|street)\b/.test(descriptor)) {
            return Math.max(tokenScore, semanticScore, fuzzyScore, 70);
          }

          if (/\b(zip|postal|postcode|pin code|pincode)\b/.test(target) && /\b(zip|postal|postcode|pin code|pincode)\b/.test(descriptor)) {
            return Math.max(tokenScore, semanticScore, fuzzyScore, 70);
          }

          if (/\b(university|college|school|institution)\b/.test(target) && /\b(university|college|school|institution|institute)\b/.test(descriptor)) {
            return Math.max(tokenScore, semanticScore, fuzzyScore, 70);
          }

          if (/\b(degree name|field of study|major)\b/.test(target) && /\b(degree|field of study|major|course)\b/.test(descriptor)) {
            return Math.max(tokenScore, semanticScore, fuzzyScore, 68);
          }

          return Math.max(tokenScore, semanticScore, fuzzyScore);
        }

        function inferSemanticIntent(text: string) {
          const normalized = normalize(text);

          if (/\b(address line 2|address 2|apartment|apt|suite)\b/.test(normalized)) {
            return "address_2";
          }

          if (/\b(address line 1|address 1|street address|address)\b/.test(normalized)) {
            return "address_1";
          }

          if (/\b(postal|postcode|zip|pin code|pincode)\b/.test(normalized)) {
            return "postal_code";
          }

          if (/\b(city|current city|town|locality|place of residence|location city)\b/.test(normalized)) {
            return "city";
          }

          if (/\b(email|e mail)\b/.test(normalized)) {
            return "email";
          }

          if (/\b(phone|mobile|telephone|contact number)\b/.test(normalized)) {
            return "phone";
          }

          if (/\b(degree name|field of study|major|qualification|course of study)\b/.test(normalized)) {
            return "degree_name";
          }

          if (/\b(university|college|institution|institute|school)\b/.test(normalized)) {
            return "university";
          }

          if (/\b(start date|start year|from date|begin date|education start)\b/.test(normalized)) {
            return "education_start";
          }

          if (/\b(end date|end year|completion date|graduation date|education end)\b/.test(normalized)) {
            return "education_end";
          }

          if (/\b(first name|given name|legal first)\b/.test(normalized)) {
            return "first_name";
          }

          if (/\b(last name|surname|family name|legal last)\b/.test(normalized)) {
            return "last_name";
          }

          return undefined;
        }

        function descriptorMatchesSemanticIntent(descriptor: string, intent: string) {
          const patterns: Record<string, RegExp> = {
            first_name: /\b(first|given|legal first)\b/,
            last_name: /\b(last|surname|family|legal last)\b/,
            address_1: /\b(address line 1|address 1|street address|address)\b/,
            address_2: /\b(address line 2|address 2|apartment|apt|suite)\b/,
            city: /\b(city|town|locality|place of residence)\b/,
            postal_code: /\b(zip|postal|postcode|pin code|pincode)\b/,
            email: /\b(email|e mail)\b/,
            phone: /\b(phone|mobile|telephone|contact)\b/,
            degree_name: /\b(degree name|field of study|major|course|qualification)\b/,
            university: /\b(university|college|school|institution|institute)\b/,
            education_start: /\b(start|from|begin).*\b(date|year)\b|\b(date|year).*\b(start|from|begin)\b/,
            education_end: /\b(end|to|completion|graduation).*\b(date|year)\b|\b(date|year).*\b(end|to|completion|graduation)\b/
          };

          return Boolean(patterns[intent]?.test(descriptor));
        }

        function tokenSimilarityScore(left: string, right: string, maxScore: number) {
          const leftTokens = semanticTokens(left);
          const rightTokens = semanticTokens(right);

          if (leftTokens.size === 0 || rightTokens.size === 0) {
            return 0;
          }

          let overlap = 0;

          for (const token of leftTokens) {
            if (rightTokens.has(token)) {
              overlap += 1;
            }
          }

          const union = new Set([...leftTokens, ...rightTokens]).size;

          return Math.round((overlap / union) * maxScore);
        }

        function semanticTokens(text: string) {
          return new Set(
            normalize(text)
              .split(" ")
              .filter((token) => token.length > 1 && !/^(select|option|choose|please|your|the|field|required|number|name|date)$/.test(token))
          );
        }

        function findLabelText(control: Element) {
          if (control.id) {
            const label = queryFirst(`label[for="${CSS.escape(control.id)}"]`);

            if (label?.textContent?.trim()) {
              return label.textContent.trim();
            }
          }

          return control.closest("label")?.textContent?.trim()
            || control.closest("fieldset")?.querySelector("legend")?.textContent?.trim()
            || "";
        }

        function findNearbyLabelText(control: Element) {
          const container = control.closest("label, fieldset, [role='group'], [class*='field'], [class*='input'], section, article, div");
          const localLabel = container?.querySelector("label, legend, h1, h2, h3, h4, span, p")?.textContent?.trim();

          if (localLabel) {
            return localLabel;
          }

          return control.previousElementSibling?.textContent?.trim()
            || control.parentElement?.previousElementSibling?.textContent?.trim()
            || "";
        }

        function isFilled(control: HTMLInputElement | HTMLTextAreaElement, expected: string) {
          const actual = normalize(control.value);
          const wanted = normalize(expected);

          if (control instanceof HTMLInputElement && control.type === "date") {
            return Boolean(control.value);
          }

          return Boolean(actual) && (actual === wanted || actual.includes(wanted) || wanted.includes(actual));
        }

        function setNativeValue(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
          const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

          if (descriptor?.set) {
            descriptor.set.call(control, value);
          } else {
            control.value = value;
          }
        }

        function normalize(value: string) {
          return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        }

        function queryFirst(selector: string) {
          for (const root of searchRoots) {
            const match = root.querySelector(selector);

            if (match) {
              return match;
            }
          }

          return null;
        }

        function getSearchRoots() {
          const roots: Array<Document | ShadowRoot> = [document];

          for (let index = 0; index < roots.length; index += 1) {
            const root = roots[index];
            const elements = Array.from(root.querySelectorAll("*")) as HTMLElement[];

            for (const element of elements) {
              if (element.shadowRoot) {
                roots.push(element.shadowRoot);
              }
            }
          }

          return roots;
        }
      },
      { fieldId: field.fieldId, label: normalizedLabel, value: field.value }
    ).catch(() => false);

    if (filled) {
      return true;
    }
  }

  return false;
}

async function fillSelectLikeField(page: Page, field: BrowserFillField) {
  const value = field.value.trim();

  if (!value || field.inputType === "file") {
    return false;
  }

  const aliases = getFieldAliases(field.label);
  const isAutocomplete = looksAutocompleteField(field.label, value);
  const queries = getSelectLikeQueries(field.label, value);

  if (isAutocomplete && await fillSearchAutocompleteByDom(page, field, queries)) {
    return true;
  }

  for (const frame of page.frames()) {
    const aliasTargets = aliases.flatMap((alias) => [
      frame.getByRole("combobox", { name: alias, exact: false }).first(),
      frame.getByLabel(alias, { exact: false }).first(),
      frame.getByPlaceholder(alias, { exact: false }).first(),
      frame.getByRole("button", { name: alias, exact: false }).first()
    ]);
    const targets = field.fieldId
      ? [frame.locator(`[data-gradlaunch-field-id="${field.fieldId}"]`).first(), ...aliasTargets]
      : aliasTargets;

    for (const target of targets) {
      try {
        const visible = await target!.isVisible({ timeout: 100 }).catch(() => false);

        if (!visible) {
          continue;
        }

        const isFileInput = await target!.evaluate((element) => {
          return element instanceof HTMLInputElement && element.type === "file";
        }).catch(() => false);

        if (isFileInput) {
          continue;
        }

        const interactionTarget = await getSelectInteractionTarget(target!);

        if (await verifySelectLikeValue(target!, value, { allowPartial: !isAutocomplete, fieldLabel: field.label })
          || await verifySelectLikeValue(interactionTarget, value, { allowPartial: !isAutocomplete, fieldLabel: field.label })) {
          return true;
        }

        if (!isAutocomplete) {
          await interactionTarget.scrollIntoViewIfNeeded().catch(() => undefined);
          await interactionTarget.click({ force: true, timeout: 700 }).catch(() => undefined);
          await page.waitForTimeout(120).catch(() => undefined);

          const clickedSimpleOption = await clickVisibleSelectOptionWithRetries(frame, value, field.label, value, 4);

          if (clickedSimpleOption) {
            await interactionTarget.press("Tab", { timeout: 350 }).catch(() => undefined);
            await page.waitForTimeout(100).catch(() => undefined);

            if (await verifySelectLikeValue(target!, value, { allowPartial: false, fieldLabel: field.label, acceptLocationTextValue: true })
              || await verifySelectLikeValue(interactionTarget, value, { allowPartial: false, fieldLabel: field.label, acceptLocationTextValue: true })
              || await verifyLocatorCommitted(target!, field, { kind: "combobox", allowPartial: isShortChoiceValue(value), acceptLocationTextValue: true })
              || await verifyLocatorCommitted(interactionTarget, field, { kind: "combobox", allowPartial: isShortChoiceValue(value), acceptLocationTextValue: true })) {
              return true;
            }
          }
        }

        for (const query of queries) {
          await interactionTarget.scrollIntoViewIfNeeded().catch(() => undefined);
          await interactionTarget.click({ force: true, timeout: 700 }).catch(() => undefined);
          await page.waitForTimeout(60).catch(() => undefined);

          if (isAutocomplete) {
            await interactionTarget.press(process.platform === "darwin" ? "Meta+A" : "Control+A", { timeout: 250 }).catch(() => undefined);
            await interactionTarget.press("Backspace", { timeout: 250 }).catch(() => undefined);
            await interactionTarget.type(query, { delay: 20, timeout: 1200 }).catch(async () => {
              await interactionTarget.fill(query, { timeout: 700 }).catch(() => undefined);
            });
          } else {
            await interactionTarget.fill(query, { timeout: 600 }).catch(async () => {
              await interactionTarget.press(process.platform === "darwin" ? "Meta+A" : "Control+A", { timeout: 250 }).catch(() => undefined);
              await interactionTarget.type(query, { delay: 10, timeout: 800 }).catch(() => undefined);
            });
          }
          await page.waitForTimeout(isAutocomplete ? 350 : 130).catch(() => undefined);

          if (isAutocomplete && await clickLocationSuggestionByText(frame, value, field.label, query)) {
            await interactionTarget.press("Tab", { timeout: 350 }).catch(() => undefined);
            await interactionTarget.blur().catch(() => undefined);
            await page.waitForTimeout(320).catch(() => undefined);

            if (await verifySelectLikeValue(target!, value, { allowPartial: false, fieldLabel: field.label, acceptLocationTextValue: true })
              || await verifySelectLikeValue(interactionTarget, value, { allowPartial: false, fieldLabel: field.label, acceptLocationTextValue: true })
              || await verifyLocatorCommitted(target!, field, { kind: "autocomplete", allowPartial: false, acceptLocationTextValue: true })
              || await verifyLocatorCommitted(interactionTarget, field, { kind: "autocomplete", allowPartial: false, acceptLocationTextValue: true })) {
              return true;
            }
          }

          const optionClicked = await clickVisibleSelectOptionWithRetries(frame, value, field.label, query, isAutocomplete ? 6 : 2);

          if (optionClicked) {
            await interactionTarget.press("Tab", { timeout: 350 }).catch(() => undefined);
            await page.waitForTimeout(80).catch(() => undefined);

            if (await verifySelectLikeValue(target!, value, { allowPartial: false, fieldLabel: field.label, acceptLocationTextValue: true })
              || await verifySelectLikeValue(interactionTarget, value, { allowPartial: false, fieldLabel: field.label, acceptLocationTextValue: true })) {
              return true;
            }

            await interactionTarget.click({ force: true, timeout: 700 }).catch(() => undefined);
            await page.waitForTimeout(60).catch(() => undefined);
          }

          if (isAutocomplete) {
            await interactionTarget.press("Enter", { timeout: 400 }).catch(() => undefined);
            await interactionTarget.press("Tab", { timeout: 350 }).catch(() => undefined);
            await page.waitForTimeout(80).catch(() => undefined);

            if (await verifySelectLikeValue(target!, value, { allowPartial: false, fieldLabel: field.label, acceptLocationTextValue: true })
              || await verifySelectLikeValue(interactionTarget, value, { allowPartial: false, fieldLabel: field.label, acceptLocationTextValue: true })) {
              return true;
            }

            await interactionTarget.click({ force: true, timeout: 700 }).catch(() => undefined);
            await interactionTarget.press("ArrowDown", { timeout: 350 }).catch(() => undefined);
            await page.waitForTimeout(60).catch(() => undefined);
            await interactionTarget.press("Enter", { timeout: 400 }).catch(() => undefined);
            await interactionTarget.press("Tab", { timeout: 350 }).catch(() => undefined);
            await page.waitForTimeout(80).catch(() => undefined);

            if (await verifySelectLikeValue(target!, value, { allowPartial: false, fieldLabel: field.label, acceptLocationTextValue: true })
              || await verifySelectLikeValue(interactionTarget, value, { allowPartial: false, fieldLabel: field.label, acceptLocationTextValue: true })) {
              return true;
            }
          }
        }

        await interactionTarget.press("Enter", { timeout: 400 }).catch(() => undefined);
        const verified = await verifySelectLikeValue(target!, value, { allowPartial: !isAutocomplete, fieldLabel: field.label, acceptLocationTextValue: true })
          || await verifySelectLikeValue(interactionTarget, value, { allowPartial: !isAutocomplete, fieldLabel: field.label, acceptLocationTextValue: true });

        if (verified) {
          return true;
        }
      } catch (_error) {
        // Try the next select-like target.
      }
    }
  }

  return false;
}

async function fillSearchAutocompleteByDom(page: Page, field: BrowserFillField, queries: string[]) {
  const expected = field.value.trim();

  if (!expected) {
    return false;
  }

  for (const frame of page.frames()) {
    const marker = `gl-autocomplete-target-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const foundTarget = await frame.evaluate(({ fieldId, label, value, marker }) => {
      const labelKey = normalize(label);
      const expectedKey = normalize(value);
      const isLocationLike = isLocationDescriptor(`${labelKey} ${expectedKey}`);
      const controls = Array.from(document.querySelectorAll("input, textarea, [contenteditable='true']")) as HTMLElement[];
      let best: HTMLElement | undefined;
      let bestScore = 0;

      for (const control of controls) {
        if (!isUsableTextControl(control)) {
          continue;
        }

        const descriptor = normalize([
          control.getAttribute("aria-label"),
          control.getAttribute("placeholder"),
          control.getAttribute("name"),
          control.id,
          control.getAttribute("role"),
          control.getAttribute("aria-autocomplete"),
          control.getAttribute("autocomplete"),
          control.className,
          findLabelText(control),
          control.closest("[class*='field'], [class*='input'], [role='group'], label")?.textContent
        ].filter(Boolean).join(" "));
        let score = 0;

        if (fieldId && control.getAttribute("data-gradlaunch-field-id") === fieldId) {
          score += 220;
        }

        if (labelKey && (descriptor.includes(labelKey) || labelKey.includes(descriptor))) {
          score += 95;
        }

        if (isLocationLike && /\b(city|location|place|residence|where do you live|address|country|state|province|region)\b/.test(descriptor)) {
          score += 110;
        }

        if (/\b(combobox|autocomplete|search)\b/.test(descriptor) || control.getAttribute("role") === "combobox") {
          score += 55;
        }

        if (isRequired(control)) {
          score += 30;
        }

        if (normalize(getControlValue(control))) {
          score -= 5;
        }

        if (score > bestScore) {
          bestScore = score;
          best = control;
        }
      }

      if (!best || bestScore < (isLocationLike ? 70 : 95)) {
        return false;
      }

      best.setAttribute("data-gradlaunch-autocomplete-target", marker);
      return true;

      function isUsableTextControl(element: HTMLElement) {
        if (element instanceof HTMLInputElement) {
          if (["hidden", "file", "checkbox", "radio", "submit", "button"].includes(element.type) || element.disabled) {
            return false;
          }
        }

        if (element instanceof HTMLTextAreaElement && element.disabled) {
          return false;
        }

        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);

        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      }

      function isRequired(element: HTMLElement) {
        const label = findLabelText(element);
        return element.getAttribute("aria-required") === "true"
          || (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.required : false)
          || /\*/.test(label)
          || Boolean(element.closest(".required, [class*='required'], [data-required='true']"));
      }

      function findLabelText(element: HTMLElement) {
        if (element.id) {
          const labelElement = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);

          if (labelElement?.textContent?.trim()) {
            return labelElement.textContent.trim();
          }
        }

        return element.closest("label")?.textContent?.trim()
          || element.closest("[class*='field'], [class*='input'], [role='group']")?.querySelector("label, legend, h1, h2, h3, h4")?.textContent?.trim()
          || "";
      }

      function getControlValue(element: HTMLElement) {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          return element.value;
        }

        return element.textContent ?? "";
      }

      function isLocationDescriptor(value: string) {
        return /\b(location|city|place|residence|country|state|province|region|india|australia|canada|united states|usa|united kingdom|uk|haryana|bihar|maharashtra|karnataka|uttar pradesh|telangana|tamil nadu|west bengal|bhiwani|gurugram|gurgaon|aurangabad|bengaluru|bangalore|delhi|noida|hyderabad|pune|mumbai|chennai|kolkata)\b/.test(normalize(value));
      }

      function normalize(text: string) {
        return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      }
    }, { fieldId: field.fieldId, label: field.label, value: expected, marker }).catch(() => false);

    if (!foundTarget) {
      continue;
    }

    const target = frame.locator(`[data-gradlaunch-autocomplete-target="${marker}"]`).first();

    for (const query of queries) {
      const cleanQuery = query.trim();

      if (!cleanQuery) {
        continue;
      }

      await target.scrollIntoViewIfNeeded().catch(() => undefined);
      await target.click({ force: true, timeout: 900 }).catch(() => undefined);
      await clearAutocompleteTarget(target);
      await target.type(cleanQuery, { delay: 35, timeout: 1800 }).catch(async () => {
        await setAutocompleteTargetValue(target, cleanQuery);
      });

      const clicked = await clickBestAutocompleteSuggestion(frame, marker, expected, field.label, cleanQuery);

      if (clicked && await verifySearchAutocompleteCommitted(frame, marker, expected, field.label, cleanQuery)) {
        await cleanupAutocompleteTarget(frame, marker);
        return true;
      }

      await target.click({ force: true, timeout: 700 }).catch(() => undefined);
      await frame.page().waitForTimeout(250).catch(() => undefined);
      await target.press("ArrowDown", { timeout: 500 }).catch(() => undefined);
      await frame.page().waitForTimeout(120).catch(() => undefined);
      await target.press("Enter", { timeout: 600 }).catch(() => undefined);
      await frame.page().waitForTimeout(550).catch(() => undefined);

      if (await verifySearchAutocompleteCommitted(frame, marker, expected, field.label, cleanQuery)) {
        await cleanupAutocompleteTarget(frame, marker);
        return true;
      }
    }

    await cleanupAutocompleteTarget(frame, marker);
  }

  return false;
}

async function clearAutocompleteTarget(target: Locator) {
  await target.press(process.platform === "darwin" ? "Meta+A" : "Control+A", { timeout: 300 }).catch(() => undefined);
  await target.press("Backspace", { timeout: 300 }).catch(() => undefined);
  await target.evaluate((element) => {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      setNativeValue(element, "");
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (element instanceof HTMLElement && element.isContentEditable) {
      element.textContent = "";
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
    }

    function setNativeValue(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
      const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

      if (descriptor?.set) {
        descriptor.set.call(control, value);
      } else {
        control.value = value;
      }
    }
  }).catch(() => undefined);
}

async function setAutocompleteTargetValue(target: Locator, value: string) {
  await target.evaluate((element, value) => {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      setNativeValue(element, value);
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (element instanceof HTMLElement && element.isContentEditable) {
      element.textContent = value;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    }

    function setNativeValue(control: HTMLInputElement | HTMLTextAreaElement, nextValue: string) {
      const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

      if (descriptor?.set) {
        descriptor.set.call(control, nextValue);
      } else {
        control.value = nextValue;
      }
    }
  }, value).catch(() => undefined);
}

async function clickBestAutocompleteSuggestion(
  frame: Frame,
  targetMarker: string,
  expected: string,
  fieldLabel: string,
  query: string
) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const optionMarker = `gl-autocomplete-option-${Date.now()}-${attempt}-${Math.random().toString(36).slice(2, 8)}`;
    const found = await frame.evaluate(({ targetMarker, expected, fieldLabel, query, optionMarker }) => {
      const target = document.querySelector(`[data-gradlaunch-autocomplete-target="${CSS.escape(targetMarker)}"]`) as HTMLElement | null;

      if (!target) {
        return false;
      }

      const targetRect = target.getBoundingClientRect();
      const expectedKey = normalize(expected);
      const queryKey = normalize(query);
      const isLocationLike = /\b(location|city|place|residence|country|state|province|region|india|australia|canada|united states|usa|united kingdom|uk|haryana|bihar|maharashtra|karnataka|uttar pradesh|telangana|tamil nadu|west bengal|bhiwani|gurugram|gurgaon|aurangabad|bengaluru|bangalore|delhi|noida|hyderabad|pune|mumbai|chennai|kolkata)\b/.test(normalize(`${fieldLabel} ${expected}`));
      const aliases = getLocationAliases(expectedKey, queryKey);
      const country = inferCountry(expectedKey) ?? inferCountry(queryKey);
      const candidates = Array.from(document.querySelectorAll("body *")) as HTMLElement[];
      let best: HTMLElement | undefined;
      let bestScore = 0;

      for (const candidate of candidates) {
        if (candidate === target || candidate.contains(target) || !isVisible(candidate)) {
          continue;
        }

        const text = normalize(candidate.innerText || candidate.textContent || "");

        if (!isUsefulSuggestionText(text)) {
          continue;
        }

        const rect = candidate.getBoundingClientRect();
        const nearTarget = rect.bottom >= targetRect.bottom - 4
          && rect.top <= targetRect.bottom + 420
          && rect.right >= targetRect.left - 80
          && rect.left <= targetRect.right + 80;
        const inPopup = Boolean(candidate.closest("[role='listbox'], [role='menu'], [class*='menu'], [class*='dropdown'], [class*='popover'], [class*='suggest'], [class*='option'], [class*='result']"));

        if (!nearTarget && !inPopup) {
          continue;
        }

        let score = 0;

        if (isLocationLike) {
          for (const alias of aliases) {
            if (alias.length > 2 && hasPhrase(text, alias)) {
              score += text.startsWith(alias) ? 130 : 95;
              break;
            }
          }

          if (queryKey.length > 2 && hasPhrase(text, queryKey)) {
            score += 70;
          }

          if (country && hasPhrase(text, country)) {
            score += 35;
          }

          if (/\b(haryana|bihar|maharashtra|karnataka|uttar pradesh|telangana|tamil nadu|west bengal)\b/.test(text)) {
            score += 20;
          }
        } else if (text === expectedKey) {
          score += 120;
        } else if (text.includes(expectedKey) || expectedKey.includes(text)) {
          score += 80;
        } else if (queryKey.length > 2 && text.includes(queryKey)) {
          score += 70;
        }

        if (candidate.getAttribute("role") === "option") {
          score += 30;
        }

        if (inPopup) {
          score += 25;
        }

        if (nearTarget) {
          score += 20;
        }

        score -= Math.min(Math.max(0, text.length - 65) / 5, 35);
        score -= Math.min(Math.max(0, rect.height - 60) / 3, 35);

        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }

      if (!best || bestScore < (isLocationLike ? 90 : 75)) {
        return false;
      }

      const clickTarget = getClickableTarget(best);
      clickTarget.setAttribute("data-gradlaunch-autocomplete-option", optionMarker);
      return true;

      function getClickableTarget(element: HTMLElement) {
        return element.closest("[role='option'], [role='button'], button, a, li, [tabindex]") as HTMLElement | null
          ?? element;
      }

      function isUsefulSuggestionText(text: string) {
        return Boolean(text)
          && text.length <= 160
          && !/\b(cannot find|fill in manually|manually|please provide|fields marked|first name|last name|email|phone number|experience|education|resume|choose file|drop it here)\b/.test(text);
      }

      function getLocationAliases(expected: string, typedQuery: string) {
        const aliases = new Set<string>();
        const values = [expected, typedQuery];

        for (const value of values) {
          const withoutCountry = value.replace(/\b(india|australia|canada|united states|usa|united kingdom|uk)\b/g, " ").replace(/\s+/g, " ").trim();
          const withoutRegion = withoutCountry.replace(/\b(haryana|bihar|maharashtra|karnataka|uttar pradesh|telangana|tamil nadu|west bengal|new south wales|california|washington|texas)\b/g, " ").replace(/\s+/g, " ").trim();

          for (const alias of [withoutRegion, withoutCountry, value.split(" ")[0]]) {
            const normalizedAlias = normalize(alias);

            if (normalizedAlias && !/^(city|location|country|state|region|india)$/.test(normalizedAlias)) {
              aliases.add(normalizedAlias);
            }
          }
        }

	    if (expected.includes("bhiwani") || typedQuery.includes("bhiwani")) {
	      aliases.add("bhiwani");
	      aliases.add("bhiwani haryana");
	    }

	    if (expected.includes("aurangabad") || typedQuery.includes("aurangabad")) {
	      aliases.add("aurangabad");
	      aliases.add("aurangabad bihar");
	    }

	    if (expected.includes("bengaluru") || expected.includes("bangalore") || expected.includes("banglore") || typedQuery.includes("bengaluru") || typedQuery.includes("bangalore") || typedQuery.includes("banglore")) {
	      aliases.add("bengaluru");
	      aliases.add("bangalore");
	      aliases.add("banglore");
	    }

	    if (expected.includes("gurugram") || expected.includes("gurgaon") || typedQuery.includes("gurugram") || typedQuery.includes("gurgaon")) {
	      aliases.add("gurugram");
	      aliases.add("gurgaon");
	    }

        return [...aliases];
      }

      function inferCountry(value: string) {
        if (hasPhrase(value, "india")) {
          return "india";
        }

        if (hasPhrase(value, "australia")) {
          return "australia";
        }

        if (hasPhrase(value, "united states") || hasPhrase(value, "usa")) {
          return "united states";
        }

        if (hasPhrase(value, "united kingdom") || hasPhrase(value, "uk")) {
          return "united kingdom";
        }

        return undefined;
      }

      function isVisible(element: HTMLElement) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0 && rect.width > 0 && rect.height > 0;
      }

      function hasPhrase(text: string, phrase: string) {
        const normalizedPhrase = normalize(phrase);

        if (!text || !normalizedPhrase) {
          return false;
        }

        return new RegExp(`(^| )${escapeRegExp(normalizedPhrase)}( |$)`).test(text);
      }

      function normalize(text: string) {
        return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      }

      function escapeRegExp(value: string) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
    }, { targetMarker, expected, fieldLabel, query, optionMarker }).catch(() => false);

    if (found) {
      const option = frame.locator(`[data-gradlaunch-autocomplete-option="${optionMarker}"]`).first();
      const box = await option.boundingBox().catch(() => undefined);

      if (box) {
        await frame.page().mouse.move(box.x + box.width / 2, box.y + box.height / 2).catch(() => undefined);
        await frame.page().mouse.down().catch(() => undefined);
        await frame.page().waitForTimeout(40).catch(() => undefined);
        await frame.page().mouse.up().catch(() => undefined);
      } else {
        await option.click({ force: true, timeout: 900 }).catch(() => undefined);
      }

      await option.evaluate((element) => {
        if (element instanceof HTMLElement) {
          element.removeAttribute("data-gradlaunch-autocomplete-option");
        }
      }).catch(() => undefined);
      await frame.page().waitForTimeout(650).catch(() => undefined);
      return true;
    }

    await frame.page().waitForTimeout(attempt < 4 ? 250 : 400).catch(() => undefined);
  }

  return false;
}

async function verifySearchAutocompleteCommitted(
  frame: Frame,
  marker: string,
  expected: string,
  fieldLabel: string,
  query: string
) {
  return frame.evaluate(({ marker, expected, fieldLabel, query }) => {
    const target = document.querySelector(`[data-gradlaunch-autocomplete-target="${CSS.escape(marker)}"]`) as HTMLElement | null;

    if (!target) {
      return false;
    }

    const expectedKey = normalize(expected);
    const queryKey = normalize(query);
    const aliases = getLocationAliases(expectedKey, queryKey);
    const isLocationLike = /\b(location|city|place|residence|country|state|province|region|india|australia|canada|united states|usa|united kingdom|uk|haryana|bihar|maharashtra|karnataka|uttar pradesh|telangana|tamil nadu|west bengal|bhiwani|gurugram|gurgaon|aurangabad|bengaluru|bangalore|delhi|noida|hyderabad|pune|mumbai|chennai|kolkata)\b/.test(normalize(`${fieldLabel} ${expected}`));
    const rawValue = getControlValue(target);
    const value = normalize(rawValue);
    const container = target.closest("[role='combobox'], [aria-haspopup='listbox'], [class*='select'], [class*='combobox'], [class*='autocomplete'], [class*='field'], [class*='input']")
      ?? target.parentElement;
    const metadata = normalize([
      rawValue,
      target.getAttribute("data-value"),
      target.getAttribute("aria-valuetext"),
      container?.getAttribute("data-value"),
      container?.getAttribute("aria-valuetext"),
      Array.from(container?.querySelectorAll("input[type='hidden'], [aria-selected='true'], [data-selected='true'], [class*='single'], [class*='selected'], [class*='chip'], [class*='tag'], [class*='pill']") ?? [])
        .map((item) => item instanceof HTMLInputElement ? item.value : item.textContent ?? "")
        .join(" "),
      container?.textContent
    ].filter(Boolean).join(" "));
	    if (hasBlockingValidation(target)) {
	      return false;
	    }

    if (isLocationLike) {
      const matchedAlias = aliases.some((alias) => alias.length > 2 && (hasPhrase(value, alias) || hasPhrase(metadata, alias)));
      const matchedExpected = metadata.includes(expectedKey) || expectedKey.includes(metadata);

      return Boolean((value || metadata) && (matchedAlias || matchedExpected));
    }

    return Boolean(value || metadata);

    function getControlValue(element: HTMLElement) {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        return element.value;
      }

      return element.textContent ?? "";
    }

    function getLocationAliases(expectedValue: string, typedQuery: string) {
      const aliases = new Set<string>();

      for (const value of [expectedValue, typedQuery]) {
        const withoutCountry = value.replace(/\b(india|australia|canada|united states|usa|united kingdom|uk)\b/g, " ").replace(/\s+/g, " ").trim();
        const withoutRegion = withoutCountry.replace(/\b(haryana|bihar|maharashtra|karnataka|uttar pradesh|telangana|tamil nadu|west bengal|new south wales|california|washington|texas)\b/g, " ").replace(/\s+/g, " ").trim();

        for (const alias of [withoutRegion, withoutCountry, value.split(" ")[0]]) {
          const normalizedAlias = normalize(alias);

          if (normalizedAlias && !/^(city|location|country|state|region|india)$/.test(normalizedAlias)) {
            aliases.add(normalizedAlias);
          }
        }
      }

	      if (expectedValue.includes("bhiwani") || typedQuery.includes("bhiwani")) {
	        aliases.add("bhiwani");
	        aliases.add("bhiwani haryana");
	      }

	      if (expectedValue.includes("aurangabad") || typedQuery.includes("aurangabad")) {
	        aliases.add("aurangabad");
	        aliases.add("aurangabad bihar");
	      }

	      if (expectedValue.includes("bengaluru") || expectedValue.includes("bangalore") || expectedValue.includes("banglore") || typedQuery.includes("bengaluru") || typedQuery.includes("bangalore") || typedQuery.includes("banglore")) {
	        aliases.add("bengaluru");
	        aliases.add("bangalore");
	        aliases.add("banglore");
	      }

	      if (expectedValue.includes("gurugram") || expectedValue.includes("gurgaon") || typedQuery.includes("gurugram") || typedQuery.includes("gurgaon")) {
	        aliases.add("gurugram");
	        aliases.add("gurgaon");
	      }

      return [...aliases];
    }

	    function hasPhrase(text: string, phrase: string) {
	      const normalizedPhrase = normalize(phrase);

	      if (!text || !normalizedPhrase) {
	        return false;
      }

	      return new RegExp(`(^| )${escapeRegExp(normalizedPhrase)}( |$)`).test(text);
	    }

	    function hasBlockingValidation(targetElement: HTMLElement) {
	      if (targetElement.getAttribute("aria-invalid") === "true") {
	        return true;
	      }

	      const describedBy = targetElement.getAttribute("aria-describedby") ?? "";
	      const describedText = describedBy
	        .split(/\s+/)
	        .map((id) => document.getElementById(id)?.textContent ?? "")
	        .join(" ");

	      if (isBlockingValidationText(normalize(describedText))) {
	        return true;
	      }

	      const container = targetElement.closest("[class*='field'], [class*='Field'], [class*='input'], [class*='Input'], [role='group'], label")
	        ?? targetElement.parentElement;

	      if (!container) {
	        return false;
	      }

	      const errorElements = Array.from(container.querySelectorAll("[role='alert'], [aria-live='assertive'], .error, .field-error, .validation-error, [class*='error'], [class*='invalid']")) as HTMLElement[];

	      if (errorElements.some((item) => isVisible(item) && isBlockingValidationText(normalize(item.innerText || item.textContent || "")))) {
	        return true;
	      }

	      return targetElement.getAttribute("aria-invalid") === "true" && isBlockingValidationText(normalize(container.textContent ?? ""));
	    }

	    function isBlockingValidationText(text: string) {
	      return /\b(this field is required|field is required|required field|cannot be blank|please select|please enter|select a valid|invalid value|invalid selection|value is required|missing required)\b/.test(text);
	    }

	    function isVisible(element: HTMLElement) {
	      const rect = element.getBoundingClientRect();
	      const style = window.getComputedStyle(element);
	      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
	    }

	    function normalize(text: string) {
	      return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
	    }

    function escapeRegExp(value: string) {
      return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }, { marker, expected, fieldLabel, query }).catch(() => false);
}

async function cleanupAutocompleteTarget(frame: Frame, marker: string) {
  await frame.evaluate((marker) => {
    const target = document.querySelector(`[data-gradlaunch-autocomplete-target="${CSS.escape(marker)}"]`);

    if (target instanceof HTMLElement) {
      target.removeAttribute("data-gradlaunch-autocomplete-target");
    }
  }, marker).catch(() => undefined);
}

async function clickLocationSuggestionByText(
  frame: Frame,
  value: string,
  fieldLabel: string,
  query: string
) {
  const marker = `gl-location-suggestion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const found = await frame.evaluate(({ expected, fieldLabel, query, marker }) => {
    const expectedKey = normalize(expected);
    const queryKey = normalize(query);
    const isLocationLike = /\b(location|city|place|residence|country|state|province|region|india|australia|canada|united states|usa|united kingdom|uk|haryana|bihar|maharashtra|karnataka|uttar pradesh|telangana|tamil nadu|west bengal|bhiwani|gurugram|gurgaon|aurangabad|bengaluru|bangalore|delhi|noida|hyderabad|pune|mumbai|chennai|kolkata)\b/.test(normalize(`${fieldLabel} ${expected}`));

    if (!isLocationLike) {
      return false;
    }

    const aliases = getLocationAliases(expectedKey, queryKey);
    const country = inferCountry(expectedKey) ?? inferCountry(queryKey);
    const candidates = Array.from(document.querySelectorAll([
      "[role='option']",
      "[role='listbox'] [role='button']",
      "[class*='option']",
      "[class*='suggest']",
      "[class*='result']",
      "[class*='menu'] li",
      "[class*='menu'] div",
      "[class*='dropdown'] li",
      "[class*='dropdown'] div",
      "li",
      "button",
      "div",
      "span"
    ].join(","))) as HTMLElement[];
    let best: HTMLElement | undefined;
    let bestScore = 0;

    for (const candidate of candidates) {
      if (!isVisible(candidate)) {
        continue;
      }

      const text = normalize(candidate.innerText || candidate.textContent || "");

      if (!text || text.length > 120 || /\b(cannot find|fill in manually|manually|please provide|fields marked|phone number|experience|education)\b/.test(text)) {
        continue;
      }

      let score = 0;

      for (const alias of aliases) {
        if (alias.length > 2 && hasPhrase(text, alias)) {
          score += text.startsWith(alias) ? 110 : 85;
          break;
        }
      }

      if (queryKey.length > 2 && hasPhrase(text, queryKey)) {
        score += 65;
      }

      if (text === expectedKey || text.includes(expectedKey) || expectedKey.includes(text)) {
        score += 70;
      }

      if (country && hasPhrase(text, country)) {
        score += 35;
      }

      if (/\b(haryana|bihar|maharashtra|karnataka|uttar pradesh|telangana|tamil nadu|west bengal)\b/.test(text)) {
        score += 15;
      }

      if (candidate.getAttribute("role") === "option") {
        score += 25;
      }

      if (candidate.closest("[role='listbox'], [class*='menu'], [class*='dropdown'], [class*='suggest'], [class*='option']")) {
        score += 20;
      }

      const rect = candidate.getBoundingClientRect();
      score -= Math.min(rect.height > 80 ? (rect.height - 80) / 4 : 0, 40);

      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    if (!best || bestScore < 80) {
      return false;
    }

    best.setAttribute("data-gradlaunch-location-suggestion", marker);
    best.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    best.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    best.click();
    return true;

    function getLocationAliases(expected: string, typedQuery: string) {
      const aliases = new Set<string>();
      const values = [expected, typedQuery];

      for (const value of values) {
        const withoutCountry = value
          .replace(/\b(india|australia|canada|united states|usa|united kingdom|uk)\b/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        const withoutRegion = withoutCountry
          .replace(/\b(haryana|bihar|maharashtra|karnataka|uttar pradesh|telangana|tamil nadu|west bengal|new south wales|california|washington|texas)\b/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        for (const alias of [withoutRegion, withoutCountry, value.split(" ")[0]]) {
          const normalizedAlias = normalize(alias);

          if (normalizedAlias && !/^(city|location|country|state|region|india)$/.test(normalizedAlias)) {
            aliases.add(normalizedAlias);
          }
        }
      }

      if (expected.includes("bhiwani") || typedQuery.includes("bhiwani")) {
        aliases.add("bhiwani");
        aliases.add("bhiwani haryana");
      }

      if (expected.includes("aurangabad") || typedQuery.includes("aurangabad")) {
        aliases.add("aurangabad");
        aliases.add("aurangabad bihar");
      }

      if (expected.includes("bengaluru") || expected.includes("bangalore") || expected.includes("banglore") || typedQuery.includes("bengaluru") || typedQuery.includes("bangalore") || typedQuery.includes("banglore")) {
        aliases.add("bengaluru");
        aliases.add("bangalore");
        aliases.add("banglore");
      }

      if (expected.includes("gurugram") || expected.includes("gurgaon") || typedQuery.includes("gurugram") || typedQuery.includes("gurgaon")) {
        aliases.add("gurugram");
        aliases.add("gurgaon");
      }

      return [...aliases];
    }

    function inferCountry(value: string) {
      if (hasPhrase(value, "india")) {
        return "india";
      }

      if (hasPhrase(value, "australia")) {
        return "australia";
      }

      if (hasPhrase(value, "united states") || hasPhrase(value, "usa")) {
        return "united states";
      }

      if (hasPhrase(value, "united kingdom") || hasPhrase(value, "uk")) {
        return "united kingdom";
      }

      return undefined;
    }

    function isVisible(element: HTMLElement) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0 && rect.width > 0 && rect.height > 0;
    }

    function hasPhrase(text: string, phrase: string) {
      const normalizedPhrase = normalize(phrase);

      if (!text || !normalizedPhrase) {
        return false;
      }

      return new RegExp(`(^| )${escapeRegExp(normalizedPhrase)}( |$)`).test(text);
    }

    function normalize(value: string) {
      return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    }

    function escapeRegExp(value: string) {
      return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }, { expected: value, fieldLabel, query, marker }).catch(() => false);

  if (!found) {
    return false;
  }

  const option = frame.locator(`[data-gradlaunch-location-suggestion="${marker}"]`).first();

  try {
    await option.click({ force: true, timeout: 900 });
    return true;
  } catch (_error) {
    const box = await option.boundingBox().catch(() => undefined);

    if (!box) {
      return true;
    }

    await frame.page().mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => undefined);
    return true;
  } finally {
    await option.evaluate((element) => {
      if (element instanceof HTMLElement) {
        element.removeAttribute("data-gradlaunch-location-suggestion");
      }
    }).catch(() => undefined);
  }
}

async function getSelectInteractionTarget(target: Locator) {
  const canUseDirectly = await target.evaluate((element) => {
    if (element instanceof HTMLInputElement) {
      return !["hidden", "file", "checkbox", "radio", "submit", "button"].includes(element.type) && !element.disabled;
    }

    if (element instanceof HTMLTextAreaElement) {
      return !element.disabled;
    }

    if (element instanceof HTMLElement) {
      return element.isContentEditable;
    }

    return false;
  }).catch(() => false);

  if (canUseDirectly) {
    return target;
  }

  const nested = target.locator([
    "input:not([type='hidden']):not([type='file']):not([type='checkbox']):not([type='radio'])",
    "textarea",
    "[contenteditable='true']",
    "[role='combobox']"
  ].join(",")).first();
  const nestedVisible = await nested.isVisible({ timeout: 150 }).catch(() => false);

  return nestedVisible ? nested : target;
}

async function fillCountrySelectField(page: Page, field: BrowserFillField) {
  const desiredCountry = countryLabelFromValue(field.value);

  if (!desiredCountry) {
    return false;
  }

  for (const frame of page.frames()) {
    const aliasTargets = [
      frame.getByRole("combobox", { name: field.label, exact: false }).first(),
      frame.getByLabel(field.label, { exact: false }).first(),
      frame.getByRole("button", { name: field.label, exact: false }).first(),
      frame.getByRole("combobox", { name: "Country", exact: false }).first(),
      frame.getByLabel("Country", { exact: false }).first(),
      frame.getByRole("button", { name: "Country", exact: false }).first()
    ];
    const targets = field.fieldId
      ? [frame.locator(`[data-gradlaunch-field-id="${field.fieldId}"]`).first(), ...aliasTargets]
      : aliasTargets;

    for (const target of targets) {
      const visible = await target.isVisible({ timeout: 120 }).catch(() => false);

      if (!visible) {
        continue;
      }

      const filledNative = await target.evaluate((element, desired) => {
        if (!(element instanceof HTMLSelectElement)) {
          return false;
        }

        const desiredKey = normalize(desired);
        const option = Array.from(element.options).find((item) => normalize(item.textContent ?? item.value) === desiredKey || normalize(item.value) === desiredKey);

        if (!option) {
          return false;
        }

        element.value = option.value;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        element.dispatchEvent(new Event("blur", { bubbles: true }));
        return true;

        function normalize(value: string) {
          return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        }
      }, desiredCountry).catch(() => false);

      if (filledNative && await verifySelectLikeValue(target, desiredCountry, { allowPartial: false })) {
        return true;
      }

      await target.scrollIntoViewIfNeeded().catch(() => undefined);
      await target.click({ force: true, timeout: 800 }).catch(() => undefined);
      await page.waitForTimeout(120).catch(() => undefined);

      if (await clickExactCountryOption(frame, desiredCountry)) {
        await target.press("Tab", { timeout: 350 }).catch(() => undefined);
        await page.waitForTimeout(120).catch(() => undefined);

        if (await verifySelectLikeValue(target, desiredCountry, { allowPartial: false })) {
          return true;
        }
      }

      await target.click({ force: true, timeout: 800 }).catch(() => undefined);
      await target.fill(desiredCountry, { timeout: 600 }).catch(async () => {
        await target.press(process.platform === "darwin" ? "Meta+A" : "Control+A", { timeout: 250 }).catch(() => undefined);
        await target.type(desiredCountry, { delay: 5, timeout: 800 }).catch(() => undefined);
      });
      await page.waitForTimeout(150).catch(() => undefined);

      if (await clickExactCountryOption(frame, desiredCountry)) {
        await target.press("Tab", { timeout: 350 }).catch(() => undefined);
        await page.waitForTimeout(120).catch(() => undefined);

        if (await verifySelectLikeValue(target, desiredCountry, { allowPartial: false })) {
          return true;
        }
      }
    }
  }

  return false;
}

async function verifySelectLikeValue(target: Locator, expected: string, options?: { allowPartial?: boolean; fieldLabel?: string; acceptLocationTextValue?: boolean }) {
  return target.evaluate((element, { wantedValue, allowPartial, fieldLabel, acceptLocationTextValue }) => {
    const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const wanted = normalize(wantedValue);
    const descriptor = normalize(`${fieldLabel ?? ""} ${wantedValue}`);
    const isLocationLike = /\b(location|city|country|state|province|region|india|australia|canada|united states|usa|united kingdom|uk|haryana|bihar|maharashtra|karnataka|uttar pradesh|telangana|tamil nadu|west bengal|aurangabad|bhiwani|bengaluru|bangalore|banglore|gurugram|gurgaon|delhi|noida|hyderabad|pune|mumbai|chennai|kolkata)\b/.test(descriptor);
    const locationAliases = isLocationLike ? getLocationAliases(wanted) : [];
    const raw = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
      ? element.value
      : element.textContent ?? "";
    const actual = normalize(raw);

    if (element instanceof HTMLElement && hasBlockingValidation(element)) {
      return false;
    }

    if (actual && matchesExpected(actual, { allowLocationAlias: Boolean(acceptLocationTextValue) })) {
      return true;
    }

    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const describedBy = element.getAttribute("aria-describedby") ?? "";
    const labelledBy = element.getAttribute("aria-labelledby") ?? "";
    const container = element.closest("[role='combobox'], [aria-haspopup='listbox'], [data-radix-select-trigger], [data-headlessui-state], [class*='select'], [class*='combobox'], [class*='field'], [class*='input']")
      ?? element.parentElement;
    const selectedText = normalize(Array.from((container ?? element).querySelectorAll([
      "[aria-selected='true']",
      "[data-selected='true']",
      "[data-state='checked']",
      "[class*='singleValue']",
      "[class*='single-value']",
      "[class*='selected']",
      "[class*='token']",
      "[class*='chip']",
      "[class*='tag']",
      "[class*='pill']"
    ].join(","))).map((item) => item.textContent ?? "").join(" "));
    const hiddenValues = normalize(Array.from((container ?? element).querySelectorAll("input[type='hidden']"))
      .map((item) => item instanceof HTMLInputElement ? item.value : "")
      .join(" "));
    const metadata = normalize([
      element.getAttribute("data-value"),
      element.getAttribute("aria-valuetext"),
      element.getAttribute("aria-activedescendant"),
      element.getAttribute("title"),
      container?.getAttribute("data-value"),
      container?.getAttribute("aria-valuetext"),
      container?.querySelector("[aria-selected='true'], [data-selected='true'], [data-state='checked']")?.textContent,
      selectedText,
      hiddenValues,
      describedBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" "),
      labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ")
    ].filter(Boolean).join(" "));

    return Boolean(metadata)
      && !/select|choose|search|type to search|results found|no results found/.test(metadata)
      && matchesExpected(metadata, { allowLocationAlias: true });

    function matchesExpected(actualValue: string, matchOptions?: { allowLocationAlias?: boolean }) {
      if (!actualValue) {
        return false;
      }

      if (/\bcountry\b/.test(descriptor)) {
        const desiredCountry = inferCountry(wanted);

        if (desiredCountry) {
          return !mentionsDifferentCountry(actualValue, desiredCountry) && hasPhrase(actualValue, desiredCountry);
        }
      }

      if (actualValue === wanted || actualValue.includes(wanted) || (allowPartial && wanted.includes(actualValue))) {
        return true;
      }

      if (!matchOptions?.allowLocationAlias || !isLocationLike) {
        return false;
      }

      return locationAliases.some((alias) => {
        return alias.length > 2
          && (hasPhrase(actualValue, alias) || (allowPartial && hasPhrase(alias, actualValue)));
      });
    }

    function inferCountry(value: string) {
      if (hasPhrase(value, "india")) {
        return "india";
      }

      if (hasPhrase(value, "australia")) {
        return "australia";
      }

      if (hasPhrase(value, "united states") || hasPhrase(value, "usa") || value === "us") {
        return "united states";
      }

      if (hasPhrase(value, "united kingdom") || hasPhrase(value, "uk")) {
        return "united kingdom";
      }

      return undefined;
    }

    function mentionsDifferentCountry(actualValue: string, desiredCountry: string) {
      const countries = ["india", "indonesia", "australia", "canada", "united states", "usa", "united kingdom", "uk", "american samoa"];
      return countries.some((country) => {
        if (country === desiredCountry) {
          return false;
        }

        if (desiredCountry === "united states" && (country === "usa" || country === "american samoa")) {
          return false;
        }

        if (desiredCountry === "united kingdom" && country === "uk") {
          return false;
        }

        return hasPhrase(actualValue, country);
      });
    }

    function hasBlockingValidation(targetElement: HTMLElement) {
      if (targetElement.getAttribute("aria-invalid") === "true") {
        return true;
      }

      const describedBy = targetElement.getAttribute("aria-describedby") ?? "";
      const describedText = describedBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");

      if (isBlockingValidationText(normalize(describedText))) {
        return true;
      }

      const container = findFieldContainer(targetElement);

      if (!container) {
        return false;
      }

      const errorElements = Array.from(container.querySelectorAll("[role='alert'], [aria-live='assertive'], .error, .field-error, .validation-error, [class*='error'], [class*='invalid']")) as HTMLElement[];

      if (errorElements.some((item) => isVisible(item) && isBlockingValidationText(normalize(item.innerText || item.textContent || "")))) {
        return true;
      }

      const text = normalize(container.textContent ?? "");
      return isBlockingValidationText(text) && getFillControlCount(container) <= 3;
    }

    function findFieldContainer(targetElement: HTMLElement) {
      let ancestor: HTMLElement | null = targetElement;

      for (let depth = 0; depth < 6 && ancestor; depth += 1) {
        if (
          ancestor.matches("[role='combobox'], [aria-haspopup='listbox'], label, fieldset, [role='group'], [class*='field'], [class*='Field'], [class*='input'], [class*='Input'], [class*='question'], [class*='Question']")
          && getFillControlCount(ancestor) <= 3
        ) {
          return ancestor;
        }

        ancestor = ancestor.parentElement;
      }

      return targetElement.parentElement;
    }

    function getFillControlCount(container: Element) {
      return Array.from(container.querySelectorAll("input:not([type='hidden']):not([type='submit']):not([type='button']):not([type='file']), textarea, select, [role='combobox'], [contenteditable='true']"))
        .filter((item) => item instanceof HTMLElement && isVisible(item)).length;
    }

    function isBlockingValidationText(text: string) {
      return /\b(this field is required|field is required|required field|cannot be blank|please select|please enter|select a valid|invalid value|invalid selection|value is required|missing required)\b/.test(text);
    }

    function isVisible(item: Element) {
      if (!(item instanceof HTMLElement)) {
        return false;
      }

      const rect = item.getBoundingClientRect();
      const style = window.getComputedStyle(item);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
    }

    function getLocationAliases(value: string) {
      const aliases = new Set<string>();
      const countryPattern = /\b(india|australia|canada|united states|usa|united kingdom|uk)\b/g;
      const statePattern = /\b(bihar|maharashtra|karnataka|haryana|uttar pradesh|telangana|tamil nadu|west bengal|new south wales|california|washington|texas)\b/g;
      const withoutCountry = value.replace(countryPattern, " ").replace(/\s+/g, " ").trim();
      const withoutRegion = withoutCountry.replace(statePattern, " ").replace(/\s+/g, " ").trim();
      const firstCommaPart = value.split(/\s+(?:india|australia|canada|united states|usa|united kingdom|uk)\b/)[0]?.trim();
      const firstTokens = value.split(" ").slice(0, Math.min(2, value.split(" ").length)).join(" ").trim();

      for (const alias of [withoutRegion, withoutCountry, firstCommaPart, firstTokens]) {
        const normalizedAlias = normalize(alias);

        if (normalizedAlias && !/^(city|location|country|state|region)$/.test(normalizedAlias)) {
          aliases.add(normalizedAlias);
        }
      }

      if (value.includes("bengaluru") || value.includes("bangalore") || value.includes("banglore")) {
        aliases.add("bengaluru");
        aliases.add("bangalore");
        aliases.add("banglore");
      }

      if (value.includes("gurugram") || value.includes("gurgaon")) {
        aliases.add("gurugram");
        aliases.add("gurgaon");
      }

      if (value.includes("aurangabad")) {
        aliases.add("aurangabad");
        aliases.add("aurangabad bihar");
      }

      if (value.includes("bhiwani")) {
        aliases.add("bhiwani");
        aliases.add("bhiwani haryana");
      }

      return [...aliases];
    }

    function hasPhrase(text: string, phrase: string) {
      const normalizedPhrase = normalize(phrase);

      if (!text || !normalizedPhrase) {
        return false;
      }

      return new RegExp(`(^| )${escapeRegExp(normalizedPhrase)}( |$)`).test(text);
    }

    function escapeRegExp(value: string) {
      return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }, {
    wantedValue: expected,
    allowPartial: options?.allowPartial !== false,
    fieldLabel: options?.fieldLabel,
    acceptLocationTextValue: options?.acceptLocationTextValue === true
  }).catch(() => false);
}

async function fillSelectField(page: Page, field: BrowserFillField) {
  const value = field.value.trim();

  if (!value) {
    return false;
  }

  for (const frame of page.frames()) {
    const filled = await frame.evaluate(
      ({ fieldId, fieldLabel, fieldValue }) => {
        const searchRoots = getSearchRoots();
        const controls = searchRoots.flatMap((root) => Array.from(root.querySelectorAll("select"))) as HTMLSelectElement[];
        const normalizedValue = normalize(fieldValue);
        const normalizedLabel = normalize(fieldLabel);
        let best: HTMLSelectElement | undefined;
        let bestScore = 0;

        for (const control of controls) {
          const rect = control.getBoundingClientRect();

          if (rect.width <= 0 || rect.height <= 0 || control.disabled) {
            continue;
          }

          if (fieldId && control.getAttribute("data-gradlaunch-field-id") === fieldId) {
            best = control;
            bestScore = 240;
            break;
          }

          const descriptor = normalize([
            control.getAttribute("aria-label"),
            control.getAttribute("name"),
            control.id,
            findLabelText(control),
            findNearbyLabelText(control),
            control.closest("label, fieldset, [role='group'], [class*='field'], [class*='input'], section, article")?.textContent
          ].filter(Boolean).join(" "));
          const score = scoreSelect(descriptor, normalizedLabel);

          if (score > bestScore) {
            best = control;
            bestScore = score;
          }
        }

        if (!best) {
          return false;
        }

        const option = findBestOption(best, normalizedValue, normalizedLabel);

        if (!option) {
          return false;
        }

        best.focus();
        best.value = option.value;
        best.dispatchEvent(new Event("input", { bubbles: true }));
        best.dispatchEvent(new Event("change", { bubbles: true }));
        best.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        best.dispatchEvent(new Event("blur", { bubbles: true }));
        return true;

        function findBestOption(select: HTMLSelectElement, wanted: string, label: string) {
          const options = Array.from(select.options).filter((item) => {
            const text = normalize(item.text || item.value);
            return Boolean(text) && !/^(select|select an option|choose|please select)$/.test(text);
          });

          return options.find((item) => normalize(item.text) === wanted || normalize(item.value) === wanted)
            ?? options.find((item) => normalize(item.text).includes(wanted) || wanted.includes(normalize(item.text)))
            ?? options.find((item) => matchesSemanticOption(normalize(item.text || item.value), wanted, label));
        }

        function matchesSemanticOption(option: string, wanted: string, label: string) {
          if (!option || !wanted) {
            return false;
          }

          if (/\b(type of degree|degree type|education level)\b/.test(label)) {
            if (/\b(b tech|btech|bachelor|undergraduate|ug)\b/.test(wanted)) {
              return /\b(bachelor|undergraduate|ug|b tech|btech)\b/.test(option);
            }

            if (/\b(m tech|mtech|master|postgraduate|pg|mca|msc)\b/.test(wanted)) {
              return /\b(master|postgraduate|pg|m tech|mtech|mca|msc)\b/.test(option);
            }
          }

          if (/\b(past working experience|work experience|professional experience)\b/.test(label)) {
            if (/^(no|false|0)$/.test(wanted)) {
              return /^no\b|no experience|fresher|0/.test(option);
            }

            if (/^(yes|true|1)$/.test(wanted)) {
              return /^yes\b|experience/.test(option);
            }
          }

          return false;
        }

        function scoreSelect(descriptor: string, target: string) {
          if (!descriptor || !target) {
            return 0;
          }

          if (descriptor === target) {
            return 110;
          }

          if (descriptor.includes(target) || target.includes(descriptor)) {
            return 85;
          }

          const targetTokens = target.split(" ").filter((token) => token.length > 1 && !/^(select|option|the|your|please)$/.test(token));
          const tokenScore = targetTokens.reduce((sum, token) => sum + (descriptor.includes(token) ? 18 : 0), 0);

          if (/\b(state|province)\b/.test(target) && /\b(state|province|region)\b/.test(descriptor)) {
            return Math.max(tokenScore, 72);
          }

          if (/\bcountry\b/.test(target) && /\bcountry\b/.test(descriptor)) {
            return Math.max(tokenScore, 72);
          }

          if (/\b(type of degree|degree type)\b/.test(target) && /\b(degree|education)\b/.test(descriptor)) {
            return Math.max(tokenScore, 72);
          }

          if (/\b(past working experience|work experience)\b/.test(target) && /\b(experience|working)\b/.test(descriptor)) {
            return Math.max(tokenScore, 72);
          }

          return tokenScore;
        }

        function findLabelText(control: Element) {
          if (control.id) {
            const label = queryFirst(`label[for="${CSS.escape(control.id)}"]`);

            if (label?.textContent?.trim()) {
              return label.textContent.trim();
            }
          }

          return control.closest("label")?.textContent?.trim()
            || control.closest("fieldset")?.querySelector("legend")?.textContent?.trim()
            || "";
        }

        function findNearbyLabelText(control: Element) {
          const container = control.closest("label, fieldset, [role='group'], [class*='field'], [class*='input'], section, article, div");
          const localLabel = container?.querySelector("label, legend, h1, h2, h3, h4, span, p")?.textContent?.trim();

          if (localLabel) {
            return localLabel;
          }

          return control.previousElementSibling?.textContent?.trim()
            || control.parentElement?.previousElementSibling?.textContent?.trim()
            || "";
        }

        function normalize(value: string) {
          return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        }

        function queryFirst(selector: string) {
          for (const root of searchRoots) {
            const match = root.querySelector(selector);

            if (match) {
              return match;
            }
          }

          return null;
        }

        function getSearchRoots() {
          const roots: Array<Document | ShadowRoot> = [document];

          for (let index = 0; index < roots.length; index += 1) {
            const root = roots[index];
            const elements = Array.from(root.querySelectorAll("*")) as HTMLElement[];

            for (const element of elements) {
              if (element.shadowRoot) {
                roots.push(element.shadowRoot);
              }
            }
          }

          return roots;
        }
      },
      { fieldId: field.fieldId, fieldLabel: field.label, fieldValue: value }
    ).catch(() => false);

    if (filled) {
      return true;
    }
  }

  return false;
}

async function fillChoiceField(page: Page, field: BrowserFillField) {
  const normalizedLabel = normalizeKey(field.label);
  const normalizedValue = normalizeKey(field.value);

  if (!normalizedValue) {
    return false;
  }

  for (const frame of page.frames()) {
    const filled = await frame.evaluate(
      ({ label, value }) => {
        const controls = Array.from(document.querySelectorAll("input[type='radio'], input[type='checkbox']")) as HTMLInputElement[];
        let bestControl: HTMLInputElement | undefined;
        let bestScore = 0;

        for (const control of controls) {
          const rect = control.getBoundingClientRect();

          if (rect.width <= 0 || rect.height <= 0 || control.disabled) {
            continue;
          }

          const descriptor = normalize([
            control.getAttribute("aria-label"),
            control.getAttribute("name"),
            control.id,
            findLabelText(control),
            control.closest("fieldset")?.textContent
          ].filter(Boolean).join(" "));
          const optionText = normalize([
            findLabelText(control),
            control.parentElement?.textContent,
            control.value
          ].filter(Boolean).join(" "));
          const isCountryOrLocationList = /\b(country|countries|location|locations)\b/.test(descriptor)
            && !/\b(terms|privacy|consent|agree|acknowledge|declaration)\b/.test(descriptor);
          let score = 0;

          if (descriptor.includes(label)) {
            score += 40;
          }

          if (optionText === value) {
            score += 70;
          } else if (optionText.includes(value) || value.includes(optionText)) {
            score += 52;
          }

          if (!isCountryOrLocationList && control.type === "checkbox" && /^(yes|true|agree|authorized|available|willing|i agree)$/.test(value)) {
            score += 35;
          }

          if (score > bestScore) {
            bestScore = score;
            bestControl = control;
          }
        }

        if (!bestControl || bestScore < 45) {
          return false;
        }

        if (bestControl.type === "checkbox" && /^(no|false|none|not applicable|do not|dont|don t|decline)$/.test(value)) {
          if (bestControl.checked) {
            clickChoiceControl(bestControl, false);
          }
          return true;
        }

        clickChoiceControl(bestControl, true);
        bestControl.dispatchEvent(new Event("input", { bubbles: true }));
        bestControl.dispatchEvent(new Event("change", { bubbles: true }));
        return true;

        function findLabelText(control: HTMLInputElement) {
          if (control.id) {
            const label = document.querySelector(`label[for="${CSS.escape(control.id)}"]`);

            if (label?.textContent?.trim()) {
              return label.textContent.trim();
            }
          }

          return control.closest("label")?.textContent ?? "";
        }

        function normalize(value: string) {
          return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        }

        function clickChoiceControl(input: HTMLInputElement, checked: boolean) {
          const clickTarget = getChoiceClickTarget(input);

          clickTarget.scrollIntoView?.({ block: "center", inline: "center" });
          input.focus();

          try {
            clickTarget.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
            clickTarget.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, view: window }));
          } catch (_error) {
            clickTarget.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
            clickTarget.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
          }

          clickTarget.click();

          if (input.type === "radio" && checked) {
            const group = input.name
              ? Array.from(document.querySelectorAll(`input[name="${CSS.escape(input.name)}"]`)) as HTMLInputElement[]
              : [input];

            for (const item of group) {
              if (item !== input && item.checked) {
                setNativeChecked(item, false);
                dispatch(item);
              }
            }
          }

          if (input.checked !== checked) {
            setNativeChecked(input, checked);
          }

          dispatch(input);

          input.blur();
        }

        function getChoiceClickTarget(input: HTMLInputElement) {
          if (input.id) {
            const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);

            if (label instanceof HTMLElement) {
              return label;
            }
          }

          const closestLabel = input.closest("label");

          if (closestLabel instanceof HTMLElement) {
            return closestLabel;
          }

          const clickableAncestor = input.closest("button, [role='radio'], [role='checkbox'], [role='button'], [aria-checked], [tabindex]");

          return clickableAncestor instanceof HTMLElement ? clickableAncestor : input;
        }

        function dispatch(element: Element) {
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          element.dispatchEvent(new Event("blur", { bubbles: true }));

          if (element instanceof HTMLInputElement && element.form) {
            element.form.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }

        function setNativeChecked(input: HTMLInputElement, checked: boolean) {
          const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");

          if (descriptor?.set) {
            descriptor.set.call(input, checked);
          } else {
            input.checked = checked;
          }
        }
      },
      { label: normalizedLabel, value: normalizedValue }
    ).catch(() => false);

    if (filled) {
      return true;
    }
  }

  return false;
}

async function fillCountryChoiceGroup(page: Page, field: BrowserFillField) {
  const normalizedValue = normalizeKey(field.value);
  const normalizedLabel = normalizeKey(field.label);
  const desiredFromValue = extractDesiredCountries(field.value);
  const desiredCountries = desiredFromValue.length > 0 ? desiredFromValue : extractDesiredCountries(field.label);

  if (!desiredCountries.length || !/\b(country|countries|india|australia|united states|usa|uk|united kingdom)\b/.test(`${normalizedValue} ${normalizedLabel}`)) {
    return false;
  }

  if (await normalizeCountryCheckboxList(page, desiredCountries)) {
    return true;
  }

  for (const frame of page.frames()) {
    const filled = await frame.evaluate(({ desired }) => {
      const desiredSet = new Set(desired);
      const controls = Array.from(document.querySelectorAll("input[type='checkbox'], input[type='radio']")) as HTMLInputElement[];
      const candidates = controls
        .filter((control) => isVisible(control) && !control.disabled)
        .map((control) => ({
          control,
          option: normalize(getOptionText(control)),
          group: getChoiceGroup(control)
        }))
        .filter((item) => {
          const descriptor = normalize(`${item.option} ${item.group.text}`);
          return /\b(country|countries|location|locations|working in|role in which you are applying)\b/.test(descriptor)
            && desired.some((country) => item.group.options.has(country));
        });

      if (candidates.length === 0) {
        return false;
      }

      const targetGroup = candidates
        .map((item) => item.group)
        .sort((first, second) => second.score - first.score)[0];

      if (!targetGroup) {
        return false;
      }

      let changed = false;
      let matched = false;

      for (const control of targetGroup.controls) {
        const option = normalize(getOptionText(control));
        const shouldCheck = desiredSet.has(option)
          || (desiredSet.has("united states") && option === "us")
          || (desiredSet.has("united kingdom") && option === "uk");

        if (shouldCheck) {
          matched = true;
        }

        if (control.type === "checkbox") {
          if (shouldCheck && !control.checked) {
            control.click();
            dispatch(control);
            changed = true;
          } else if (!shouldCheck && control.checked) {
            control.click();
            dispatch(control);
            changed = true;
          }
        } else if (shouldCheck && !control.checked) {
          control.click();
          dispatch(control);
          changed = true;
        }
      }

      return matched && (changed || targetGroup.controls.some((control) => control.checked && desiredSet.has(normalize(getOptionText(control)))));

      function getChoiceGroup(control: HTMLInputElement) {
        const namedControls = control.name
          ? Array.from(document.querySelectorAll(`input[name="${CSS.escape(control.name)}"]`)) as HTMLInputElement[]
          : [];
        let best = scoreGroup(namedControls, control.closest("fieldset, [role='group'], section, article, [class*='question'], [class*='field'], [class*='input']") ?? control.parentElement ?? document.body);
        let ancestor: Element | null = control.parentElement;

        for (let depth = 0; depth < 8 && ancestor; depth += 1) {
          const controls = Array.from(ancestor.querySelectorAll("input[type='checkbox'], input[type='radio']")) as HTMLInputElement[];
          const candidate = scoreGroup(controls, ancestor);

          if (candidate.score > best.score) {
            best = candidate;
          }

          ancestor = ancestor.parentElement;
        }

        return best;
      }

      function scoreGroup(groupControls: HTMLInputElement[], container: Element) {
        const rawControls = groupControls.length >= 2
          ? groupControls
          : Array.from(container.querySelectorAll("input[type='checkbox'], input[type='radio']")) as HTMLInputElement[];
        const countryControls = rawControls.filter((item) => isCountryOption(normalize(getOptionText(item))));
        const controls = countryControls.length >= 2 ? countryControls : rawControls;
        const text = normalize([
          container.querySelector("legend, h1, h2, h3, h4, label")?.textContent,
          container.textContent
        ].filter(Boolean).join(" "));
        const options = new Set(controls.map((item) => normalize(getOptionText(item))).filter(Boolean));
        const desiredMatches = desired.reduce((sum, country) => sum + (options.has(country) ? 20 : 0), 0);
        const score = (/\bcountry|countries\b/.test(text) ? 80 : 0)
          + (/\bworking in|role in which you are applying|previous response|location\b/.test(text) ? 35 : 0)
          + (controls.length >= 4 ? 25 : controls.length >= 2 ? 10 : 0)
          + desiredMatches;

        return { controls, text, options, score };
      }

      function isCountryOption(value: string) {
        return /^(australia|belgium|brazil|canada|france|germany|india|indonesia|ireland|israel|italy|japan|luxembourg|malaysia|mexico|new zealand|poland|portugal|romania|singapore|south korea|spain|sweden|switzerland|thailand|the netherlands|netherlands|uae|uk|us|united states|united kingdom)$/.test(value);
      }

      function getOptionText(control: HTMLInputElement) {
        if (control.id) {
          const label = document.querySelector(`label[for="${CSS.escape(control.id)}"]`);

          if (label?.textContent?.trim()) {
            return label.textContent.trim();
          }
        }

        return control.closest("label")?.textContent?.trim()
          || control.parentElement?.textContent?.trim()
          || control.value;
      }

      function dispatch(control: HTMLInputElement) {
        control.dispatchEvent(new Event("input", { bubbles: true }));
        control.dispatchEvent(new Event("change", { bubbles: true }));
      }

      function isVisible(element: HTMLElement) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0 && rect.width > 0 && rect.height > 0;
      }

      function normalize(value: string) {
        return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      }
    }, { desired: desiredCountries }).catch(() => false);

    if (filled) {
      return true;
    }
  }

  return false;
}

async function fillCountryOptionField(page: Page, field: BrowserFillField) {
  const desiredCountries = extractDesiredCountries(field.value);

  if (desiredCountries.length === 0) {
    return false;
  }

  const normalized = await normalizeCountryCheckboxList(page, desiredCountries);
  const fieldCountry = countryKeyFromLabel(field.label);

  if (normalized && fieldCountry && desiredCountries.includes(fieldCountry)) {
    return true;
  }

  return Boolean(fieldCountry && desiredCountries.includes(fieldCountry) && await clickCountryOptionFieldTarget(page, field));
}

async function clickCountryOptionFieldTarget(page: Page, field: BrowserFillField) {
  if (!field.fieldId) {
    return false;
  }

  for (const frame of page.frames()) {
    const clicked = await frame.evaluate(({ fieldId, label }) => {
      const control = document.querySelector(`[data-gradlaunch-field-id="${CSS.escape(fieldId)}"]`);

      if (!(control instanceof HTMLElement) || !isCountryOption(normalize(label))) {
        return false;
      }

      const target = getClickTarget(control);
      target.click();
      dispatch(control);

      return true;

      function getClickTarget(element: HTMLElement) {
        if (element instanceof HTMLInputElement && element.id) {
          const labelElement = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);

          if (labelElement instanceof HTMLElement) {
            return labelElement;
          }
        }

        const ancestor = element.closest("label, button, [role='checkbox'], [role='button'], [aria-checked], [tabindex]");

        return ancestor instanceof HTMLElement ? ancestor : element;
      }

      function dispatch(element: HTMLElement) {
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        element.dispatchEvent(new Event("blur", { bubbles: true }));
      }

      function isCountryOption(value: string) {
        return /^(australia|belgium|brazil|canada|france|germany|india|indonesia|ireland|israel|italy|japan|luxembourg|malaysia|mexico|new zealand|poland|portugal|romania|singapore|south korea|spain|sweden|switzerland|thailand|the netherlands|netherlands|uae|uk|us|united states|united kingdom)$/.test(value);
      }

      function normalize(value: string) {
        return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      }
    }, { fieldId: field.fieldId, label: field.label }).catch(() => false);

    if (clicked) {
      return true;
    }
  }

  return false;
}

async function normalizeCountryCheckboxList(page: Page, desiredCountries: string[]) {
  for (const frame of page.frames()) {
    const normalized = await frame.evaluate(({ desired }) => {
      const desiredSet = new Set(desired);
      const entries = collectCountryEntries();

      if (entries.length === 0) {
        return false;
      }

      let changed = false;
      let matched = false;

      for (const entry of entries) {
        const shouldCheck = desiredSet.has(entry.option)
          || (desiredSet.has("united states") && entry.option === "us")
          || (desiredSet.has("united kingdom") && entry.option === "uk");

        if (shouldCheck) {
          matched = true;
        }

        if (entry.checked === undefined) {
          if (shouldCheck) {
            clickEntry(entry);
            changed = true;
          }
        } else if (shouldCheck !== entry.checked) {
          clickEntry(entry);
          changed = true;
        }
      }

      const postEntries = collectCountryEntries();
      const desiredChecked = postEntries.some((entry) => {
        return entry.checked !== false && (
          desiredSet.has(entry.option)
          || (desiredSet.has("united states") && entry.option === "us")
          || (desiredSet.has("united kingdom") && entry.option === "uk")
        );
      });
      const undesiredChecked = postEntries.some((entry) => {
        return entry.checked === true
          && !desiredSet.has(entry.option)
          && !(desiredSet.has("united states") && entry.option === "us")
          && !(desiredSet.has("united kingdom") && entry.option === "uk");
      });

      return matched && desiredChecked && !undesiredChecked && (changed || desiredChecked);

      function collectCountryEntries() {
        const candidates = Array.from(document.querySelectorAll("input, [role='checkbox'], [aria-checked], label, button, [role='button'], li, div, span")) as HTMLElement[];
        const byOption = new Map<string, {
          option: string;
          control: HTMLElement;
          clickTarget: HTMLElement;
          checked: boolean | undefined;
          score: number;
        }>();

        for (const candidate of candidates) {
          if (!isUsable(candidate)) {
            continue;
          }

          if (candidate.closest("[role='listbox'], [role='menu']")) {
            continue;
          }

          const option = getCountryOption(candidate);

          if (!isCountryOption(option)) {
            continue;
          }

          const group = getCountryGroup(candidate, option);

          if (!group) {
            continue;
          }

          const row = getCountryRow(candidate, option) ?? candidate;
          const control = getControl(candidate, row) ?? row;
          const clickTarget = getClickTarget(candidate, row, control);
          const entry = {
            option,
            control,
            clickTarget,
            checked: isChecked(control, row, clickTarget),
            score: scoreCandidate(candidate, control, row, clickTarget)
          };
          const existing = byOption.get(option);

          if (!existing || entry.score > existing.score) {
            byOption.set(option, entry);
          }
        }

        return [...byOption.values()];
      }

      function clickEntry(entry: {
        control: HTMLElement;
        clickTarget: HTMLElement;
      }) {
        try {
          entry.clickTarget.click();
        } catch (_error) {
          try {
            entry.control.click();
          } catch (_innerError) {
            // Best-effort DOM click; Playwright-level fallbacks handle other controls.
          }
        }

        dispatch(entry.control);
      }

      function isUsable(element: HTMLElement) {
        if (element instanceof HTMLInputElement && element.disabled) {
          return false;
        }

        if (element.getAttribute("aria-disabled") === "true") {
          return false;
        }

        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      }

      function getClickTarget(element: HTMLElement, row: HTMLElement, control: HTMLElement) {
        if (control instanceof HTMLInputElement) {
          const label = control.id ? document.querySelector(`label[for="${CSS.escape(control.id)}"]`) : undefined;

          if (label instanceof HTMLElement && isUsable(label)) {
            return label;
          }

          const closestLabel = control.closest("label");

          if (closestLabel instanceof HTMLElement && isUsable(closestLabel)) {
            return closestLabel;
          }
        }

        if (row instanceof HTMLLabelElement || row.getAttribute("role") === "checkbox" || row.getAttribute("aria-checked") !== null) {
          return row;
        }

        const clickableAncestor = element.closest("label, button, [role='checkbox'], [role='button'], [aria-checked], [tabindex]");

        if (clickableAncestor instanceof HTMLElement && isUsable(clickableAncestor) && isTightCountryText(clickableAncestor, getCountryOption(element))) {
          return clickableAncestor;
        }

        return control !== row && isUsable(control) ? control : row;
      }

      function getCountryOption(element: HTMLElement) {
        const values = [
          getOptionText(element),
          element.getAttribute("aria-label") ?? "",
          element.getAttribute("data-value") ?? "",
          element.getAttribute("value") ?? ""
        ];

        for (const value of values) {
          const normalized = normalize(value);

          if (isCountryOption(normalized)) {
            return normalized;
          }
        }

        return "";
      }

      function getOptionText(element: HTMLElement) {
        if (element instanceof HTMLInputElement && element.id) {
          const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);

          if (label?.textContent?.trim()) {
            return label.textContent.trim();
          }
        }

        if (element instanceof HTMLInputElement) {
          return element.closest("label")?.textContent?.trim()
            || element.parentElement?.textContent?.trim()
            || element.getAttribute("aria-label")
            || element.value
            || "";
        }

        return element.textContent?.trim()
          || element.getAttribute("aria-label")
          || "";
      }

      function getCountryGroup(element: HTMLElement, option: string) {
        let ancestor: Element | null = element;

        for (let depth = 0; depth < 10 && ancestor; depth += 1) {
          if (!(ancestor instanceof HTMLElement)) {
            ancestor = ancestor.parentElement;
            continue;
          }

          const text = normalize(ancestor.innerText || ancestor.textContent || "");
          const optionCount = countCountryOptions(text);
          const mentionsCountryQuestion = /\b(country|countries|working in|role in which you are applying|previous response|selected in)\b/.test(text);

          if ((optionCount >= 4 || (optionCount >= 2 && mentionsCountryQuestion)) && hasPhrase(text, option)) {
            return ancestor;
          }

          ancestor = ancestor.parentElement;
        }

        return undefined;
      }

      function getCountryRow(element: HTMLElement, option: string) {
        let ancestor: Element | null = element;

        for (let depth = 0; depth < 6 && ancestor; depth += 1) {
          if (ancestor instanceof HTMLElement && isUsable(ancestor) && isTightCountryText(ancestor, option)) {
            return ancestor;
          }

          ancestor = ancestor.parentElement;
        }

        return undefined;
      }

      function getControl(element: HTMLElement, row: HTMLElement) {
        if (element instanceof HTMLInputElement || element.getAttribute("role") === "checkbox" || element.getAttribute("aria-checked") !== null) {
          return element;
        }

        const nestedControl = row.querySelector("input[type='checkbox'], input[type='radio'], [role='checkbox'], [aria-checked]");

        if (nestedControl instanceof HTMLElement) {
          return nestedControl;
        }

        const labelledControl = row instanceof HTMLLabelElement && row.htmlFor
          ? document.getElementById(row.htmlFor)
          : undefined;

        if (labelledControl instanceof HTMLElement) {
          return labelledControl;
        }

        return undefined;
      }

      function isChecked(control: HTMLElement, row: HTMLElement, clickTarget: HTMLElement): boolean | undefined {
        if (control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type)) {
          return control.checked;
        }

        const nestedInput = row.querySelector("input[type='checkbox'], input[type='radio']")
          ?? clickTarget.querySelector("input[type='checkbox'], input[type='radio']");

        if (nestedInput instanceof HTMLInputElement) {
          return nestedInput.checked;
        }

        const stateValues = [
          control.getAttribute("aria-checked"),
          row.getAttribute("aria-checked"),
          clickTarget.getAttribute("aria-checked"),
          control.getAttribute("data-state"),
          row.getAttribute("data-state"),
          clickTarget.getAttribute("data-state"),
          control.getAttribute("aria-selected"),
          row.getAttribute("aria-selected"),
          clickTarget.getAttribute("aria-selected")
        ].filter(Boolean);

        if (stateValues.some((value) => value === "true" || value === "checked")) {
          return true;
        }

        if (stateValues.some((value) => value === "false" || value === "unchecked")) {
          return false;
        }

        if (control.querySelector("[aria-checked='true'], [data-state='checked']")
          || row.querySelector("[aria-checked='true'], [data-state='checked']")
          || clickTarget.querySelector("[aria-checked='true'], [data-state='checked']")) {
          return true;
        }

        return undefined;
      }

      function scoreCandidate(element: HTMLElement, control: HTMLElement, row: HTMLElement, clickTarget: HTMLElement) {
        let score = 0;

        if (control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type)) {
          score += 70;
        }

        if (control.getAttribute("role") === "checkbox" || row.getAttribute("role") === "checkbox" || clickTarget.getAttribute("role") === "checkbox") {
          score += 50;
        }

        if (clickTarget.tagName.toLowerCase() === "label") {
          score += 35;
        }

        if (element instanceof HTMLLabelElement) {
          score += 30;
        }

        if (row !== element) {
          score += 12;
        }

        return score;
      }

      function countCountryOptions(text: string) {
        const countries = [
          "australia",
          "belgium",
          "brazil",
          "canada",
          "france",
          "germany",
          "india",
          "indonesia",
          "ireland",
          "israel",
          "italy",
          "japan",
          "luxembourg",
          "malaysia",
          "mexico",
          "new zealand",
          "poland",
          "portugal",
          "romania",
          "singapore",
          "south korea",
          "spain",
          "sweden",
          "switzerland",
          "thailand",
          "the netherlands",
          "uae",
          "uk",
          "us"
        ];

        return countries.reduce((sum, country) => sum + (hasPhrase(text, country) ? 1 : 0), 0);
      }

      function isTightCountryText(element: HTMLElement, option: string) {
        const text = normalize(element.innerText || element.textContent || "");

        if (!text || !option) {
          return false;
        }

        if (text === option) {
          return true;
        }

        return text.includes(option) && text.length <= option.length + 20 && countCountryOptions(text) <= 1;
      }

      function hasPhrase(text: string, phrase: string) {
        const normalizedPhrase = normalize(phrase);

        if (!text || !normalizedPhrase) {
          return false;
        }

        return new RegExp(`(^| )${escapeRegExp(normalizedPhrase)}( |$)`).test(text);
      }

      function escapeRegExp(value: string) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }

      function dispatch(element: HTMLElement) {
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));

        if (element instanceof HTMLInputElement && element.form) {
          element.form.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }

      function isCountryOption(value: string) {
        return /^(australia|belgium|brazil|canada|france|germany|india|indonesia|ireland|israel|italy|japan|luxembourg|malaysia|mexico|new zealand|poland|portugal|romania|singapore|south korea|spain|sweden|switzerland|thailand|the netherlands|netherlands|uae|uk|us|united states|united kingdom)$/.test(value);
      }

      function normalize(value: string) {
        return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      }
    }, { desired: desiredCountries }).catch(() => false);

    if (normalized) {
      return true;
    }
  }

  return false;
}

function extractDesiredCountries(value: string) {
  const normalized = normalizeInline(value);
  const countries: string[] = [];

  if (/\bindia\b/.test(normalized)) {
    countries.push("india");
  }

  if (/\baustralia\b/.test(normalized)) {
    countries.push("australia");
  }

  if (/\bunited states\b|\busa\b|\bus\b/.test(normalized)) {
    countries.push("united states");
  }

  if (/\bunited kingdom\b|\buk\b/.test(normalized)) {
    countries.push("united kingdom");
  }

  return [...new Set(countries)];
}

function countryLabelFromValue(value: string) {
  const country = extractDesiredCountries(value)[0];

  if (!country) {
    return undefined;
  }

  if (country === "india") {
    return "India";
  }

  if (country === "australia") {
    return "Australia";
  }

  if (country === "united states") {
    return "United States";
  }

  if (country === "united kingdom") {
    return "United Kingdom";
  }

  return undefined;
}

function countryKeyFromLabel(value: string) {
  const normalized = normalizeInline(value);

  if (normalized === "india") {
    return "india";
  }

  if (normalized === "australia") {
    return "australia";
  }

  if (normalized === "us" || normalized === "united states") {
    return "united states";
  }

  if (normalized === "uk" || normalized === "united kingdom") {
    return "united kingdom";
  }

  return normalized;
}

function isCountryChoiceGroupField(field: BrowserFillField) {
  const label = normalizeInline(field.label);

  return Boolean(countryLabelFromValue(field.value))
    && /\b(country|countries)\b/.test(label)
    && /\b(countries|anticipate|working in|role in which you are applying|previous response)\b/.test(label);
}

function isCountrySelectField(field: BrowserFillField) {
  const label = normalizeInline(field.label);

  return Boolean(countryLabelFromValue(field.value))
    && /\bcountry\b/.test(label)
    && !/\b(countries|anticipate|working in|role in which you are applying|previous response)\b/.test(label);
}

function shouldSkipCountryOptionField(field: BrowserFillField) {
  const inputType = field.inputType ?? "";

  if (inputType !== "checkbox" && inputType !== "radio") {
    return false;
  }

  // Country lists are filled through the parent question so bad LLM plans cannot
  // tick every standalone option ("Australia", "Belgium", "India", ...).
  return isCountryOptionLabel(field.label);
}

function isCountryOptionLabel(value: string) {
  return /^(australia|belgium|brazil|canada|france|germany|india|indonesia|ireland|israel|italy|japan|luxembourg|malaysia|mexico|new zealand|poland|portugal|romania|singapore|south korea|spain|sweden|switzerland|thailand|the netherlands|netherlands|uae|uk|us|united states|united kingdom)$/i.test(value.trim());
}

function normalizeInline(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function clickExactCountryOption(frame: Frame, desiredCountry: string) {
  const marker = `gl-country-option-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const found = await frame.evaluate(({ desired, marker }) => {
    const desiredKey = normalize(desired);
    const candidates = Array.from(document.querySelectorAll([
      "[role='option']",
      "[role='menuitemradio']",
      "[role='menuitemcheckbox']",
      "[role='radio']",
      "[role='button']",
      "[data-radix-collection-item]",
      "[cmdk-item]",
      "[data-value]",
      "li",
      "button",
      "div",
      "span"
    ].join(","))) as HTMLElement[];
    let best: HTMLElement | undefined;
    let bestScore = 0;

    for (const candidate of candidates) {
      if (!isVisible(candidate)) {
        continue;
      }

      const text = normalize(candidate.innerText || candidate.textContent || "");

      if (!isExactCountryOption(text, desiredKey)) {
        continue;
      }

      if (!isLikelySelectOption(candidate, text)) {
        continue;
      }

      let score = text === desiredKey ? 120 : 90;

      if (candidate.getAttribute("role") === "option") {
        score += 20;
      }

      if (candidate.closest("[role='listbox'], [role='menu'], [data-radix-popper-content-wrapper], [cmdk-list], [class*='menu'], [class*='listbox']")) {
        score += 35;
      }

      if (candidate.getAttribute("aria-selected") === "true") {
        score += 10;
      }

      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    if (!best) {
      return false;
    }

    best.setAttribute("data-gradlaunch-country-option-target", marker);
    return true;

    function isExactCountryOption(text: string, expected: string) {
      if (!text || text.length > 40) {
        return false;
      }

      if (text === expected) {
        return true;
      }

      if (expected === "india") {
        return /^india(?: in)?$/.test(text);
      }

      if (expected === "united states") {
        return text === "us" || /^united states(?: us)?$/.test(text);
      }

      if (expected === "united kingdom") {
        return text === "uk" || /^united kingdom(?: uk)?$/.test(text);
      }

      return false;
    }

    function isVisible(element: HTMLElement) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0 && rect.width > 0 && rect.height > 0;
    }

    function isLikelySelectOption(element: HTMLElement, text: string) {
      if (!text || text.length > 40) {
        return false;
      }

      const role = element.getAttribute("role") ?? "";

      if (/^(option|menuitemradio|menuitemcheckbox|radio|button)$/.test(role)) {
        return true;
      }

      if (element.closest("[role='listbox'], [role='menu'], [data-radix-popper-content-wrapper], [cmdk-list], [class*='menu'], [class*='listbox'], [class*='option']")) {
        return true;
      }

      const groupText = normalize(element.closest("fieldset, [role='group'], section, article")?.textContent ?? "");

      return !/\b(anticipate|working in|role in which you are applying)\b/.test(groupText);
    }

    function normalize(value: string) {
      return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    }
  }, { desired: desiredCountry, marker }).catch(() => false);

  if (!found) {
    return false;
  }

  const option = frame.locator(`[data-gradlaunch-country-option-target="${marker}"]`).first();

  try {
    await option.click({ force: true, timeout: 700 });
    return true;
  } catch (_error) {
    const box = await option.boundingBox().catch(() => undefined);

    if (!box) {
      return false;
    }

    await frame.page().mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => undefined);
    return true;
  } finally {
    await option.evaluate((element) => {
      if (element instanceof HTMLElement) {
        element.removeAttribute("data-gradlaunch-country-option-target");
      }
    }).catch(() => undefined);
  }
}

async function clickVisibleSelectOption(
  frame: Frame,
  value: string,
  fieldLabel = "",
  query = value
) {
  const marker = `gl-option-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const found = await frame.evaluate(({ expected, fieldLabel, query, marker }) => {
    const normalizedExpected = normalize(expected);
    const normalizedQuery = normalize(query);
    const isLocationLike = /\b(location|city|country|state|province|region|india|australia|canada|united states|usa|united kingdom|uk|haryana|bihar|maharashtra|karnataka|uttar pradesh|telangana|tamil nadu|west bengal|aurangabad|bhiwani|bengaluru|bangalore|banglore|gurugram|gurgaon|delhi|noida|hyderabad|pune|mumbai|chennai|kolkata)\b/.test(normalize(`${fieldLabel} ${expected}`));
    const desiredCountry = inferDesiredCountry(normalizedExpected);
    const cityAliases = getCityAliases(normalizedExpected);
    const candidates = Array.from(document.querySelectorAll([
      "[role='option']",
      "[role='menuitemradio']",
      "[role='menuitemcheckbox']",
      "[role='radio']",
      "[role='button']",
      "[data-radix-collection-item]",
      "[cmdk-item]",
      "[data-value]",
      "li",
      "button",
      "div",
      "span"
    ].join(","))) as HTMLElement[];
    let best: HTMLElement | undefined;
    let bestScore = 0;

    for (const candidate of candidates) {
      if (!isVisible(candidate)) {
        continue;
      }

      const text = normalize(candidate.innerText || candidate.textContent || "");

      if (!text) {
        continue;
      }

      if (!isLikelySelectOption(candidate, text)) {
        continue;
      }

      let score = 0;

      if (isLocationLike) {
        score = scoreLocationOption(text, normalizedExpected, normalizedQuery, cityAliases, desiredCountry);
      } else if (text === normalizedExpected) {
        score = 100;
      } else if (text.startsWith(normalizedExpected)) {
        score = 90;
      } else if (text.includes(normalizedExpected) || normalizedExpected.includes(text)) {
        score = 72;
      }

      if (candidate.getAttribute("role") === "option") {
        score += 15;
      }

      if (candidate.closest("[role='listbox'], [role='menu'], [data-radix-popper-content-wrapper], [cmdk-list], [class*='menu'], [class*='listbox']")) {
        score += 20;
      }

      if (candidate.getAttribute("aria-selected") === "true") {
        score += 12;
      }

      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    if (!best || bestScore < (isLocationLike ? 68 : 60)) {
      return false;
    }

    best.setAttribute("data-gradlaunch-option-target", marker);
    return true;

    function isVisible(element: HTMLElement) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0 && rect.width > 0 && rect.height > 0;
    }

    function isLikelySelectOption(element: HTMLElement, text: string) {
      if (!text || text.length > 90) {
        return false;
      }

      if (/\b(cannot find|fill in manually|manually)\b/.test(text)) {
        return false;
      }

      const role = element.getAttribute("role") ?? "";

      if (/^(option|menuitemradio|menuitemcheckbox|radio|button)$/.test(role)) {
        return true;
      }

      if (element.closest("[role='listbox'], [role='menu'], [data-radix-popper-content-wrapper], [cmdk-list], [class*='menu'], [class*='listbox'], [class*='option']")) {
        return true;
      }

      if (/^(yes|no|true|false)$/.test(text)) {
        return true;
      }

      if (isLocationLike) {
        const hasCityAlias = cityAliases.some((alias) => alias.length > 2 && hasPhrase(text, alias));
        const hasTypedQuery = normalizedQuery.length > 2 && hasPhrase(text, normalizedQuery);
        const hasCountry = desiredCountry ? hasPhrase(text, desiredCountry) : /\b(india|australia|canada|united states|usa|united kingdom|uk)\b/.test(text);

        return (hasCityAlias || hasTypedQuery) && hasCountry;
      }

      return false;
    }

    function normalize(value: string) {
      return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    }

    function scoreLocationOption(
      text: string,
      expected: string,
      typedQuery: string,
      aliases: string[],
      country: string | undefined
    ) {
      let score = 0;

      if (text === expected) {
        score += 130;
      } else if (text.includes(expected) || expected.includes(text)) {
        score += 70;
      }

      for (const alias of aliases) {
        if (hasPhrase(text, alias)) {
          score += 70;

          if (text.startsWith(alias)) {
            score += 20;
          }

          break;
        }
      }

      if (typedQuery && text.includes(typedQuery)) {
        score += 12;
      }

      if (country) {
        if (hasPhrase(text, country)) {
          score += 38;
        } else if (mentionsDifferentCountry(text, country)) {
          score -= 90;
        }
      }

      const stopWords = new Set(["city", "state", "region", "country", "new", "south"]);
      const expectedTokens = expected
        .split(" ")
        .filter((token) => token.length > 2 && !stopWords.has(token));
      const tokenScore = expectedTokens.reduce((sum, token) => sum + (hasPhrase(text, token) ? 7 : 0), 0);

      return score + Math.min(tokenScore, 35);
    }

    function getCityAliases(expected: string) {
      const firstPart = expected.split(/\s+(?:bihar|maharashtra|karnataka|haryana|uttar pradesh|telangana|tamil nadu|west bengal|india|australia|new south wales|united states|united kingdom)\b/)[0]?.trim();
      const firstCommaPart = expected.split(" india")[0]?.split(" australia")[0]?.trim();
      const aliases = new Set([firstPart, firstCommaPart, expected.split(" ")[0]].filter(Boolean));

      if (expected.includes("bengaluru") || expected.includes("bangalore") || expected.includes("banglore")) {
        aliases.add("bengaluru");
        aliases.add("bangalore");
        aliases.add("banglore");
      }

      if (expected.includes("bhiwani")) {
        aliases.add("bhiwani");
        aliases.add("bhiwani haryana");
      }

      if (expected.includes("gurugram") || expected.includes("gurgaon")) {
        aliases.add("gurugram");
        aliases.add("gurgaon");
      }

      if (expected.includes("new york") || expected.includes("nyc")) {
        aliases.add("new york");
        aliases.add("nyc");
      }

      if (expected.includes("san francisco")) {
        aliases.add("san francisco");
      }

      return [...aliases].map(normalize).filter(Boolean);
    }

    function inferDesiredCountry(expected: string) {
      if (hasPhrase(expected, "india")) {
        return "india";
      }

      if (hasPhrase(expected, "australia")) {
        return "australia";
      }

      if (hasPhrase(expected, "united states") || hasPhrase(expected, "usa")) {
        return "united states";
      }

      if (hasPhrase(expected, "united kingdom") || hasPhrase(expected, "uk")) {
        return "united kingdom";
      }

      return undefined;
    }

    function mentionsDifferentCountry(text: string, desiredCountry: string) {
      const countries = ["india", "australia", "canada", "united states", "usa", "united kingdom", "uk"];
      return countries.some((country) => country !== desiredCountry && hasPhrase(text, country));
    }

    function hasPhrase(text: string, phrase: string) {
      const normalizedPhrase = normalize(phrase);

      if (!text || !normalizedPhrase) {
        return false;
      }

      return new RegExp(`(^| )${escapeRegExp(normalizedPhrase)}( |$)`).test(text);
    }

    function escapeRegExp(value: string) {
      return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }, { expected: value, fieldLabel, query, marker }).catch(() => false);

  if (!found) {
    return false;
  }

  const option = frame.locator(`[data-gradlaunch-option-target="${marker}"]`).first();

  try {
    await option.click({ force: true, timeout: 700 });
    return true;
  } catch (_error) {
    const box = await option.boundingBox().catch(() => undefined);

    if (!box) {
      return false;
    }

    await frame.page().mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => undefined);
    return true;
  } finally {
    await option.evaluate((element) => {
      if (element instanceof HTMLElement) {
        element.removeAttribute("data-gradlaunch-option-target");
      }
    }).catch(() => undefined);
  }
}

async function clickVisibleSelectOptionWithRetries(
  frame: Frame,
  value: string,
  fieldLabel: string,
  query: string,
  attempts: number
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await clickVisibleSelectOption(frame, value, fieldLabel, query)) {
      return true;
    }

    await frame.page().waitForTimeout(attempt < 2 ? 120 : 180).catch(() => undefined);
  }

  return false;
}

function looksAutocompleteField(label: string, value: string) {
  const descriptor = normalizeInline(`${label} ${value}`);
  return isLocationLikeDescriptor(descriptor) || /\b(school|university|college)\b/.test(descriptor);
}

function getSelectLikeQueries(label: string, value: string) {
  const descriptor = normalizeInline(`${label} ${value}`);

  if (!isLocationLikeDescriptor(descriptor)) {
    return [value];
  }

  const city = getLocationQueryCity(value);
  const queries = [
    city,
    /\bbengaluru|bangalore|banglore\b/.test(normalizeInline(value)) ? "Bengaluru" : undefined,
    value
  ].filter((item): item is string => Boolean(item?.trim()));
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const query of queries) {
    const key = normalizeInline(query);

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(query);
  }

  return unique;
}

function isLocationLikeDescriptor(descriptor: string) {
  return /\b(location|city|country|state|province|region|india|australia|canada|united states|usa|united kingdom|uk|haryana|bihar|maharashtra|karnataka|uttar pradesh|telangana|tamil nadu|west bengal|aurangabad|bhiwani|bengaluru|bangalore|banglore|gurugram|gurgaon|delhi|noida|hyderabad|pune|mumbai|chennai|kolkata)\b/.test(descriptor);
}

function getLocationQueryCity(value: string) {
  const normalized = normalizeInline(value);

  if (/\baurangabad\b/.test(normalized)) {
    return "Aurangabad";
  }

  if (/\bbhiwani\b/.test(normalized)) {
    return "Bhiwani";
  }

  if (/\bbengaluru|bangalore|banglore\b/.test(normalized)) {
    return "Bengaluru";
  }

  if (/\bgurugram|gurgaon\b/.test(normalized)) {
    return "Gurugram";
  }

  const withoutCountry = value
    .replace(/\b(india|australia|canada|united states|usa|united kingdom|uk)\b/gi, "")
    .replace(/\b(bihar|maharashtra|karnataka|haryana|uttar pradesh|telangana|tamil nadu|west bengal|new south wales|california|washington|texas)\b/gi, "")
    .replace(/\s*,\s*/g, ",")
    .replace(/(^,|,$)/g, "")
    .trim();

  return withoutCountry.split(",")[0]?.trim() || value.split(",")[0]?.trim();
}

function shouldUseSelectLikeFlow(field: BrowserFillField) {
  return field.inputType === "combobox" || looksAutocompleteField(field.label, field.value);
}

function isShortChoiceValue(value: string) {
  return /^(yes|no|true|false|n\/a|na)$/i.test(value.trim());
}

function getFieldAliases(label: string) {
  const normalizedLabel = label.toLowerCase().trim();
  const aliases = new Set([label]);

  if (normalizedLabel.includes("country")) {
    aliases.add("Country");
    aliases.add("Country/Region");
    aliases.add("Country region");
  }

  if (normalizedLabel.includes("location")) {
    aliases.add("Location");
    aliases.add("Location (City)");
    aliases.add("City");
  }

  if (normalizedLabel.includes("city")) {
    aliases.add("City");
    aliases.add("Current city");
    aliases.add("Location (City)");
  }

  if (normalizedLabel.includes("authorized") || normalizedLabel.includes("work authorization") || normalizedLabel.includes("eligible")) {
    aliases.add("Work authorization");
    aliases.add("Legally authorized to work");
    aliases.add("Are you legally authorized to work");
  }

  if (normalizedLabel.includes("visa") || normalizedLabel.includes("sponsorship")) {
    aliases.add("Visa sponsorship required");
    aliases.add("Visa required");
    aliases.add("Require sponsorship");
  }

  if (normalizedLabel.includes("remote")) {
    aliases.add("Remote");
    aliases.add("Work remotely");
  }

  return [...aliases];
}
