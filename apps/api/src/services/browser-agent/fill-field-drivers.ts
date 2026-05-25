import type { Frame, Locator, Page } from "./browser-driver";
import type { FillV2Adapter, FillV2Answer, FillV2Field } from "./fill-engine";

type LocatedField = {
  frame: Frame;
  locator: Locator;
};

type DropdownScope = {
  frame: Frame;
  popupMarker: string;
};


export async function fillV2Field(page: Page, field: FillV2Field, answer: FillV2Answer, adapter: FillV2Adapter) {
  const located = await findV2Locator(page, field);
  
  if (!located || !answer.value.trim()) {
    return false;
  }

  if (field.driver === "file") {
    return false;
  }

  if (await verifyV2Field(page, field, answer)) {
    return true;
  }

  if (isLocationField(field) && (field.driver === "text" || field.driver === "textarea" || field.driver === "contenteditable")) {
    return fillLocationAutocomplete(page, located.frame, located.locator, field, answer, adapter);
  }

  if (field.driver === "choice") {
    return fillChoice(located.locator, answer);
  }

  if (field.driver === "native_select") {
    return fillNativeSelect(located.locator, answer);
  }

  if (field.driver === "custom_select") {
    if (isPhoneCountryCodeField(field)) {
      return fillCountryCodeSelect(page, located.frame, located.locator, field, answer, adapter);
    }

    if (isLocationField(field)) {
      return fillCustomSelect(located.frame, located.locator, field, answer, adapter);
    }

    if (adapter.fillCustomSelect && await adapter.fillCustomSelect({ page, field, answer })) {
      return true;
    }

    return fillCustomSelect(located.frame, located.locator, field, answer, adapter);
  }

  if (field.driver === "phone") {
    return fillPhone(page, located.frame, located.locator, answer);
  }

  return fillTextLike(located.locator, answer.value);
}

export async function verifyV2Field(page: Page, field: FillV2Field, answer: FillV2Answer) {
  const located = await findV2Locator(page, field);

  if (!located) {
    return false;
  }

  return located.locator.evaluate((control, { answer, field }) => {
    if (!(control instanceof HTMLElement)) {
      return false;
    }

    const expected = normalize(answer.value);
    const rawExpected = answer.value;

    if (!expected) {
      return false;
    }

    if (field.driver === "phone") {
      const expectedDigits = answer.value.replace(/\D+/g, "");
      const input = control instanceof HTMLInputElement ? control : control.querySelector("input[type='tel'], input[inputmode='tel'], input");
      const actualDigits = input instanceof HTMLInputElement ? input.value.replace(/\D+/g, "") : "";
      const localDigits = expectedDigits.slice(-10);
      return actualDigits.endsWith(localDigits) || actualDigits.includes(expectedDigits);
    }

    if (control instanceof HTMLSelectElement) {
      const selected = control.selectedOptions[0];
      return matches(normalize(`${selected?.textContent ?? ""} ${selected?.value ?? ""} ${control.value}`), expected);
    }

    if (isChoice(control)) {
      return matches(normalize(selectedChoiceText(control)), expected);
    }

    const value = committedValue(control);
    const rawValue = committedRawValue(control);

    if (!value || /^(select|select an option|choose|choose an option|none selected|not selected|search)$/.test(value)) {
      if (!isCountryCodeField(field)) {
        return false;
      }
    }

    if (isCountryCodeField(field)) {
      return countryCodeMatches(countryCodeRawValue(control), rawExpected);
    }

    if (field.intent === "country" || field.intent === "state" || field.intent === "city") {
      if (hasOpenAutocomplete(control)) {
        return false;
      }

      return locationMatches(rawValue, rawExpected, field.intent);
    }

    return matches(value, expected);

    function committedValue(element: HTMLElement) {
      return normalize(committedRawValue(element));
    }

    function committedRawValue(element: HTMLElement) {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        return element.value;
      }

      if (element.isContentEditable) {
        return element.textContent ?? "";
      }

      return [
        element.getAttribute("data-value"),
        element.getAttribute("data-dial-code"),
        element.getAttribute("aria-label"),
        element.getAttribute("aria-valuetext"),
        element.getAttribute("title"),
        element.innerText,
        element.textContent
      ].filter(Boolean).join(" ");
    }

    function countryCodeRawValue(element: HTMLElement) {
      const container = element.closest("[role='group'], [role='combobox'], [aria-haspopup], [class*='field'], [class*='input'], label, div")
        ?? element.parentElement
        ?? element;
      const related = Array.from(container.querySelectorAll([
        "[data-dial-code]",
        "[data-country-code]",
        "[aria-selected='true']",
        "[data-selected='true']",
        "[class*='selected']",
        "input[type='hidden']",
        "input[type='tel']",
        "button",
        "[role='option']"
      ].join(",")))
        .map((candidate) => {
          if (!(candidate instanceof HTMLElement)) {
            return "";
          }

          if (candidate instanceof HTMLInputElement || candidate instanceof HTMLTextAreaElement) {
            return candidate.value;
          }

          return [
            candidate.getAttribute("data-dial-code"),
            candidate.getAttribute("data-country-code"),
            candidate.getAttribute("aria-label"),
            candidate.getAttribute("aria-valuetext"),
            candidate.getAttribute("title"),
            candidate.innerText,
            candidate.textContent
          ].filter(Boolean).join(" ");
        })
        .filter(Boolean)
        .join(" ");

      return `${committedRawValue(element)} ${related}`.trim();
    }

    function selectedChoiceText(element: HTMLElement) {
      const group = element instanceof HTMLInputElement && element.name
        ? Array.from(document.querySelectorAll(`input[name="${CSS.escape(element.name)}"]`)) as HTMLElement[]
        : Array.from((element.closest("fieldset, [role='radiogroup'], [role='group'], form") ?? element.parentElement ?? element)
          .querySelectorAll("input[type='radio'], input[type='checkbox'], [role='radio'], [role='checkbox']")) as HTMLElement[];
      const selected = group.find((item) => item instanceof HTMLInputElement && item.checked || item.getAttribute("aria-checked") === "true");

      if (!selected) {
        return "";
      }

      return [
        selected instanceof HTMLInputElement ? selected.value : "",
        selected.getAttribute("aria-label"),
        selected.id ? document.querySelector(`label[for="${CSS.escape(selected.id)}"]`)?.textContent : "",
        selected.closest("label")?.textContent,
        selected.parentElement?.textContent
      ].filter(Boolean).join(" ");
    }

    function matches(actual: string, expected: string) {
      return actual === expected || actual.includes(expected) || expected.includes(actual);
    }

    function isCountryCodeField(field: { label: string; context?: string; intent: string }) {
      return field.intent === "country"
        && /\b(country code|country region code|search by country region or code|dial code|phone code)\b/.test(normalize(`${field.label} ${field.context ?? ""}`));
    }

    function countryCodeMatches(actualRaw: string, expectedRaw: string) {
      const actual = normalize(actualRaw);
      const expected = normalize(expectedRaw);

      if (!actual || !expected) {
        return false;
      }

      const expectedDial = inferDial(expectedRaw);
      const actualDigits = actualRaw.replace(/\D+/g, "");

      if (expectedDial) {
        const dialDigits = expectedDial.replace(/\D+/g, "");

        if (actualDigits === dialDigits || actualDigits.startsWith(dialDigits) || actual.includes(dialDigits) || actual.includes(expectedDial)) {
          return true;
        }
      }

      const expectedCountry = inferCountry(expected);

      if (expectedCountry && hasPhrase(actual, expectedCountry) && !mentionsDifferentCountry(actual, expectedCountry)) {
        return true;
      }

      return matches(actual, expected);
    }

    function locationMatches(actualRaw: string, expectedRaw: string, intent: string) {
      const actual = normalize(actualRaw);
      const expected = normalize(expectedRaw);

      if (!actual || !expected) {
        return false;
      }

      if (matches(actual, expected)) {
        return true;
      }

      const actualCountry = inferCountry(actual);
      const expectedCountry = inferCountry(expected);

      if (actualCountry && expectedCountry && actualCountry !== expectedCountry) {
        return false;
      }

      if (intent === "country") {
        return Boolean(actualCountry && expectedCountry && actualCountry === expectedCountry);
      }

      const actualCore = canonicalLocation(actualRaw);
      const expectedCore = canonicalLocation(expectedRaw);

      if (actualCore && expectedCore && actualCore === expectedCore) {
        return true;
      }

      if (actualCore && expectedCore) {
        const actualTokens = new Set(actualCore.split(" ").filter(Boolean));
        const expectedTokens = new Set(expectedCore.split(" ").filter(Boolean));
        let overlap = 0;

        for (const token of expectedTokens) {
          if (actualTokens.has(token)) {
            overlap += 1;
          }
        }

        if (overlap >= Math.min(actualTokens.size, expectedTokens.size)) {
          return true;
        }
      }

      return false;
    }

    function hasOpenAutocomplete(element: HTMLElement) {
      if (element.getAttribute("aria-expanded") === "true") {
        return true;
      }

      const popupIds = [element.getAttribute("aria-controls"), element.getAttribute("aria-owns")]
        .flatMap((value) => (value ?? "").split(/\s+/).filter(Boolean));

      for (const id of popupIds) {
        const popup = document.getElementById(id);

        if (popup instanceof HTMLElement && isVisible(popup) && popup.querySelector("[role='option'], [aria-selected='true'], li, button")) {
          return true;
        }
      }

      return false;
    }

    function canonicalLocation(raw: string) {
      const normalized = normalize(raw);

      if (!normalized) {
        return "";
      }

      if (/\bgurugram|gurgaon\b/.test(normalized)) return "gurugram";
      if (/\bbengaluru|bangalore|banglore\b/.test(normalized)) return "bengaluru";
      if (/\baurangabad\b/.test(normalized)) return "aurangabad";
      if (/\bbhiwani\b/.test(normalized)) return "bhiwani";
      if (/\bnew york\b/.test(normalized)) return "new york";
      if (/\bsan francisco\b/.test(normalized)) return "san francisco";
      if (/\bseattle\b/.test(normalized)) return "seattle";
      if (/\baustin\b/.test(normalized)) return "austin";
      if (/\bhyderabad\b/.test(normalized)) return "hyderabad";
      if (/\bnoida\b/.test(normalized)) return "noida";
      if (/\bpune\b/.test(normalized)) return "pune";
      if (/\bmumbai\b/.test(normalized)) return "mumbai";
      if (/\bchennai\b/.test(normalized)) return "chennai";
      if (/\bkolkata\b/.test(normalized)) return "kolkata";
      if (/\blondon\b/.test(normalized)) return "london";
      if (/\bsydney\b/.test(normalized)) return "sydney";

      return normalized
        .replace(/\b(india|australia|canada|united states|usa|united kingdom|uk)\b/g, " ")
        .replace(/\b(haryana|bihar|maharashtra|karnataka|uttar pradesh|telangana|tamil nadu|west bengal|new south wales|california|washington|texas|new york)\b/g, " ")
        .replace(/\b(city|location|state|region|country)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    function inferCountry(value: string) {
      if (/\bindia\b/.test(value)) return "india";
      if (/\baustralia\b/.test(value)) return "australia";
      if (/\bcanada\b/.test(value)) return "canada";
      if (/\bunited states|usa\b/.test(value)) return "united states";
      if (/\bunited kingdom|uk\b/.test(value)) return "united kingdom";
      return undefined;
    }

    function mentionsDifferentCountry(text: string, desiredCountry: string | undefined) {
      if (!desiredCountry) {
        return false;
      }

      const countries = ["india", "australia", "canada", "united states", "usa", "united kingdom", "uk"];
      return countries.some((country) => country !== desiredCountry && hasPhrase(text, country));
    }

    function inferDial(value: string) {
      if (/\bindia|indian\b/.test(normalize(value))) return "+91";
      if (/\bunited states|usa|us|canada\b/.test(normalize(value))) return "+1";
      if (/\bunited kingdom|uk|britain|england\b/.test(normalize(value))) return "+44";
      if (/\baustralia\b/.test(normalize(value))) return "+61";
      if (/\bgermany\b/.test(normalize(value))) return "+49";
      if (/\bfrance\b/.test(normalize(value))) return "+33";
      if (/\bsingapore\b/.test(normalize(value))) return "+65";
      return undefined;
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

    function isChoice(element: HTMLElement) {
      return element instanceof HTMLInputElement && ["radio", "checkbox"].includes(element.type)
        || element.getAttribute("role") === "radio"
        || element.getAttribute("role") === "checkbox";
    }

    function isVisible(element: Element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
    }

    function normalize(value: string | null | undefined) {
      return (value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9+]+/g, " ").trim();
    }
  }, { answer, field }).catch(() => false);
}

export async function collectFillV2FieldDebug(page: Page, field: FillV2Field) {
  const located = await findV2Locator(page, field);

  if (!located) {
    return {
      found: false,
      fieldId: field.id,
      label: field.label,
      driver: field.driver,
      intent: field.intent
    };
  }

  const control = await located.locator.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      return undefined;
    }

    return {
      tagName: element.tagName.toLowerCase(),
      role: element.getAttribute("role"),
      name: element.getAttribute("name"),
      type: element instanceof HTMLInputElement ? element.type : undefined,
      value: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value
        : element.isContentEditable
          ? element.textContent ?? ""
          : [
            element.getAttribute("data-value"),
            element.getAttribute("aria-valuetext"),
            element.getAttribute("title"),
            element.textContent
          ].filter(Boolean).join(" "),
      ariaExpanded: element.getAttribute("aria-expanded"),
      ariaControls: element.getAttribute("aria-controls"),
      ariaOwns: element.getAttribute("aria-owns"),
      ariaActiveDescendant: element.getAttribute("aria-activedescendant")
    };
  }).catch(() => undefined);

  const popupScope = await waitForDropdownScope(located.frame, located.locator);
  const optionTexts = popupScope ? await readVisibleOptionTexts(popupScope) : [];
  const highlightedText = popupScope ? await readHighlightedOption(popupScope) : "";
  const popupState = popupScope
    ? await popupScope.frame.evaluate((popupMarker) => {
      const popup = findPopupByMarker(popupMarker);

      if (!(popup instanceof HTMLElement)) {
        return undefined;
      }

      return {
        role: popup.getAttribute("role"),
        id: popup.id || undefined,
        className: popup.className || undefined,
        textPreview: (popup.innerText || popup.textContent || "").replace(/\s+/g, " ").trim().slice(0, 240)
      };

      function findPopupByMarker(marker: string) {
        for (const root of getSearchRoots()) {
          const match = root.querySelector(`[data-gradlaunch-v2-dropdown-popup="${CSS.escape(marker)}"]`);

          if (match instanceof HTMLElement) {
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
    }, popupScope.popupMarker).catch(() => undefined)
    : undefined;

  if (popupScope) {
    await cleanupDropdownScope(popupScope);
  }

  return {
    found: true,
    fieldId: field.id,
    label: field.label,
    driver: field.driver,
    intent: field.intent,
    control,
    popupFound: Boolean(popupScope),
    popupState,
    highlightedText,
    optionTexts: optionTexts.slice(0, 10)
  };
}

async function fillTextLike(locator: Locator, value: string) {
  const target = await resolveTypingLocator(locator);

  if (!target) {
    return false;
  }

  await realType(target, value);
  await target.press("Tab", { timeout: 350 }).catch(() => undefined);
  await target.blur().catch(() => undefined);
  await target.page().waitForTimeout(Number(process.env.BROWSER_REAL_TYPE_COMMIT_WAIT_MS ?? 120)).catch(() => undefined);
  return true;
}

async function fillLocationAutocomplete(page: Page, frame: Frame, locator: Locator, field: FillV2Field, answer: FillV2Answer, adapter: FillV2Adapter) {
  let activeLocator = locator;
  let activeFrame = frame;
  let target = await resolveTypingLocator(activeLocator);

  if (!target) {
    return false;
  }

  const query = adapter.selectQuery?.(field, answer) ?? answer.value.split(",")[0]?.trim() ?? answer.value;
  const isComboboxField = await locator.evaluate((element) => element instanceof HTMLElement && element.getAttribute("role") === "combobox").catch(() => false);

  if (isComboboxField) {
    await realType(target, query).catch(() => undefined);
  } else {
    const seededQuery = await seedReactiveText(target, query);

    if (!seededQuery) {
      await realType(target, query).catch(() => undefined);
    }
  }

  await page.waitForTimeout(180).catch(() => undefined);

  const refreshedAfterType = await findV2Locator(page, field);

  if (refreshedAfterType) {
    activeLocator = refreshedAfterType.locator;
    activeFrame = refreshedAfterType.frame;
    target = await resolveTypingLocator(activeLocator) ?? target;
  }

  let dropdownScope = await waitForDropdownScope(activeFrame, activeLocator);

  if (dropdownScope) {
    await waitForMatchingLocationOption(dropdownScope, answer.value, query);

    if (await waitAndClickLocationOption(page, field, query, answer.value, dropdownScope)) {
      await target.press("Tab", { timeout: 350 }).catch(() => undefined);
      await page.waitForTimeout(180).catch(() => undefined);
      if (await verifyV2Field(page, field, answer)) {
        return true;
      }
    }

    if (await commitComboboxSuggestionByKeyboard(page, dropdownScope, answer.value, target)) {
      await target.press("Tab", { timeout: 350 }).catch(() => undefined);
      await page.waitForTimeout(180).catch(() => undefined);
      if (await verifyV2Field(page, field, answer)) {
        return true;
      }
    }
  }

  const refreshedAfterPopup = await findV2Locator(page, field);

  if (refreshedAfterPopup) {
    activeLocator = refreshedAfterPopup.locator;
    activeFrame = refreshedAfterPopup.frame;
    target = await resolveTypingLocator(activeLocator) ?? target;
  }

  dropdownScope = await waitForDropdownScope(activeFrame, activeLocator) ?? dropdownScope;

  if (dropdownScope) {
    await waitForMatchingLocationOption(dropdownScope, answer.value, query);
  }

  if (dropdownScope && await commitDropdownByKeyboard(page, dropdownScope)) {
    await target.press("Tab", { timeout: 350 }).catch(() => undefined);
    await page.waitForTimeout(180).catch(() => undefined);
    if (await verifyV2Field(page, field, answer)) {
      return true;
    }
  }

  await realType(target, answer.value).catch(() => undefined);
  await target.press("Tab", { timeout: 350 }).catch(() => undefined);
  await target.blur().catch(() => undefined);
  await page.waitForTimeout(Number(process.env.BROWSER_REAL_TYPE_COMMIT_WAIT_MS ?? 120)).catch(() => undefined);
  return true;
}

async function seedReactiveText(locator: Locator, value: string) {
  return locator.evaluate((element, nextValue) => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    element.focus?.();

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

      descriptor?.set?.call(element, nextValue);
      element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: nextValue, inputType: "insertText" }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    if (element.isContentEditable) {
      element.textContent = nextValue;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: nextValue, inputType: "insertText" }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    return false;
  }, value).catch(() => false);
}

async function fillPhone(page: Page, frame: Frame, locator: Locator, answer: FillV2Answer) {
  const parsed = parsePhone(answer.value);

  if (!parsed) {
    return fillTextLike(locator, answer.value);
  }

  await fillTextLike(locator, parsed.fullNumber);
  await page.waitForTimeout(180).catch(() => undefined);

  if (parsed.dialDigits && await openPhoneCountryPicker(locator)) {
    await typePhoneCountrySearch(page, parsed.dialDigits);
    await clickPhoneCountry(page, parsed.dialDigits);
    await page.keyboard.press("Escape").catch(() => undefined);
    await fillTextLike(locator, parsed.localNumber);
    await frame.page().waitForTimeout(140).catch(() => undefined);
  }

  return true;
}

async function fillCountryCodeSelect(page: Page, frame: Frame, locator: Locator, field: FillV2Field, answer: FillV2Answer, adapter: FillV2Adapter) {
  const baseQuery = adapter.selectQuery?.(field, answer) ?? answer.value.split(",")[0]?.trim() ?? answer.value;
  const dialDigits = inferDialDigitsFromCountry(baseQuery) ?? inferDialDigitsFromCountry(answer.value);
  const queries = [...new Set([baseQuery, dialDigits ? `+${dialDigits}` : undefined, dialDigits].filter(Boolean) as string[])];

  await locator.scrollIntoViewIfNeeded().catch(() => undefined);
  await locator.click({ force: true, timeout: 900 }).catch(() => undefined);
  await page.waitForTimeout(120).catch(() => undefined);

  let dropdownScope = await waitForDropdownScope(frame, locator);

  if (dialDigits && await clickCountryCodeOption(page, baseQuery, dialDigits, dropdownScope)) {
    await page.keyboard.press("Tab").catch(() => undefined);
    await page.waitForTimeout(180).catch(() => undefined);

    if (await verifyV2Field(page, field, answer)) {
      return true;
    }
  }

  for (const query of queries) {
    if (await typeOpenSelectSearch(page, query, dropdownScope)) {
      await page.waitForTimeout(180).catch(() => undefined);
    }

    dropdownScope = await waitForDropdownScope(frame, locator) ?? dropdownScope;

    if (dialDigits) {
      await typePhoneCountrySearch(page, dialDigits).catch(() => undefined);

      if (await clickCountryCodeOption(page, baseQuery, dialDigits, dropdownScope) || await clickPhoneCountry(page, dialDigits)) {
        await page.keyboard.press("Tab").catch(() => undefined);
        await page.waitForTimeout(180).catch(() => undefined);

        if (await verifyV2Field(page, field, answer)) {
          return true;
        }
      }
    }

    if (await clickOpenOption(page, query, answer.value, dropdownScope)) {
      await page.keyboard.press("Tab").catch(() => undefined);
      await page.waitForTimeout(180).catch(() => undefined);

      if (await verifyV2Field(page, field, answer)) {
        return true;
      }
    }
  }

  if (await commitDropdownByKeyboard(page, dropdownScope)) {
    await page.keyboard.press("Tab").catch(() => undefined);
    await page.waitForTimeout(180).catch(() => undefined);

    if (await verifyV2Field(page, field, answer)) {
      return true;
    }
  }

  return false;
}

async function fillNativeSelect(locator: Locator, answer: FillV2Answer) {
  return locator.evaluate((control, value) => {
    if (!(control instanceof HTMLSelectElement)) {
      return false;
    }

    const expected = normalize(value);
    const option = Array.from(control.options).find((item) => {
      const text = normalize(`${item.textContent ?? ""} ${item.value}`);
      return text === expected || text.includes(expected) || expected.includes(text);
    });

    if (!option) {
      return false;
    }

    control.value = option.value;
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    control.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    return true;

    function normalize(raw: string | null | undefined) {
      return (raw ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9+]+/g, " ").trim();
    }
  }, answer.value).catch(() => false);
}

async function fillChoice(locator: Locator, answer: FillV2Answer) {
  return locator.evaluate((control, answer) => {
    if (!(control instanceof HTMLElement)) {
      return false;
    }

    const expected = normalize(answer.value);
    const choices = choiceGroup(control);
    const best = choices
      .map((choice) => ({ choice, score: scoreChoice(choice, expected) }))
      .sort((left, right) => right.score - left.score)[0];

    if (!best || best.score < 35) {
      return false;
    }

    best.choice.click();
    best.choice.dispatchEvent(new Event("input", { bubbles: true }));
    best.choice.dispatchEvent(new Event("change", { bubbles: true }));
    return true;

    function choiceGroup(element: HTMLElement) {
      if (element instanceof HTMLInputElement && element.name) {
        return Array.from(document.querySelectorAll(`input[name="${CSS.escape(element.name)}"]`)) as HTMLElement[];
      }

      return Array.from((element.closest("fieldset, [role='radiogroup'], [role='group'], form") ?? element.parentElement ?? element)
        .querySelectorAll("input[type='radio'], input[type='checkbox'], [role='radio'], [role='checkbox']")) as HTMLElement[];
    }

    function scoreChoice(element: HTMLElement, expected: string) {
      const text = normalize([
        element instanceof HTMLInputElement ? element.value : "",
        element.getAttribute("aria-label"),
        element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent : "",
        element.closest("label")?.textContent,
        element.parentElement?.textContent
      ].filter(Boolean).join(" "));
      let score = 0;

      if (text === expected) score += 100;
      if (text.includes(expected) || expected.includes(text)) score += 70;
      if (/^(yes|true|agree|accept|i agree)$/.test(expected) && /\b(yes|agree|accept|consent|confirm)\b/.test(text)) score += 90;
      if (/^(no|false|decline|do not|dont|not now|no thanks)$/.test(expected) && /\b(no|decline|do not|none|not now)\b/.test(text)) score += 90;

      return score;
    }

    function normalize(raw: string | null | undefined) {
      return (raw ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9+]+/g, " ").trim();
    }
  }, answer).catch(() => false);
}

async function fillCustomSelect(frame: Frame, locator: Locator, field: FillV2Field, answer: FillV2Answer, adapter: FillV2Adapter) {
  const query = adapter.selectQuery?.(field, answer) ?? answer.value.split(",")[0]?.trim() ?? answer.value;
  const locationField = isLocationField(field);

  await locator.scrollIntoViewIfNeeded().catch(() => undefined);
  await locator.click({ force: true, timeout: 900 }).catch(() => undefined);
  await frame.page().waitForTimeout(120).catch(() => undefined);

  let dropdownScope = await waitForDropdownScope(frame, locator);

  if (await typeOpenSelectSearch(frame.page(), query, dropdownScope)) {
    await frame.page().waitForTimeout(160).catch(() => undefined);
  }

  dropdownScope = await waitForDropdownScope(frame, locator) ?? dropdownScope;

  if (locationField) {
    await waitForMatchingLocationOption(dropdownScope, answer.value, query);

    if (await commitComboboxSuggestionByKeyboard(frame.page(), dropdownScope, answer.value)) {
      await frame.page().keyboard.press("Tab").catch(() => undefined);
      await frame.page().waitForTimeout(180).catch(() => undefined);
      if (await verifyV2Field(frame.page(), field, answer)) {
        return true;
      }
    }

    if (await waitAndClickLocationOption(frame.page(), field, query, answer.value, dropdownScope)) {
      await frame.page().keyboard.press("Tab").catch(() => undefined);
      await frame.page().waitForTimeout(180).catch(() => undefined);
      if (await verifyV2Field(frame.page(), field, answer)) {
        return true;
      }
    }

    if (await commitDropdownByKeyboard(frame.page(), dropdownScope)) {
      await frame.page().keyboard.press("Tab").catch(() => undefined);
      await frame.page().waitForTimeout(180).catch(() => undefined);
      if (await verifyV2Field(frame.page(), field, answer)) {
        return true;
      }
    }

    return false;
  }

  if (await clickOpenOption(frame.page(), query, answer.value, dropdownScope)) {
    await frame.page().keyboard.press("Tab").catch(() => undefined);
    await frame.page().waitForTimeout(140).catch(() => undefined);
    if (await verifyV2Field(frame.page(), field, answer)) {
      return true;
    }
  }

  if (await commitDropdownByKeyboard(frame.page(), dropdownScope)) {
    await frame.page().keyboard.press("Tab").catch(() => undefined);
    await frame.page().waitForTimeout(140).catch(() => undefined);
    if (await verifyV2Field(frame.page(), field, answer)) {
      return true;
    }
  }

  await frame.page().keyboard.press("ArrowDown").catch(() => undefined);
  await frame.page().keyboard.press("Enter").catch(() => undefined);
  await frame.page().keyboard.press("Tab").catch(() => undefined);
  await frame.page().waitForTimeout(140).catch(() => undefined);
  return true;
}

async function waitAndClickLocationOption(page: Page, field: FillV2Field, query: string, value: string, scope?: DropdownScope) {
  const timeoutMs = Number(process.env.BROWSER_LOCATION_OPTION_TIMEOUT_MS ?? 1800);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await clickMatchingLocationOption(page, field, query, value, scope)) {
      return true;
    }

    await page.waitForTimeout(120).catch(() => undefined);
  }

  return false;
}

async function clickMatchingLocationOption(page: Page, field: FillV2Field, query: string, value: string, scope?: DropdownScope) {
  const frames = scope ? [scope.frame] : page.frames();

  for (const frame of frames) {
    const marker = `fill-v2-location-option-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const found = await frame.evaluate(({ marker, popupMarker, intent, query, value }) => {
      const normalizedQuery = normalize(query);
      const normalizedValue = normalize(value);
      const expectedCountry = inferCountry(normalizedValue) ?? inferCountry(normalizedQuery);
      const aliases = locationAliases(normalizedValue, normalizedQuery);
      const popup = popupMarker
        ? findPopupByMarker(popupMarker)
        : undefined;
      const root = popup instanceof HTMLElement ? popup : document;
      const candidates = Array.from(root.querySelectorAll([
        "[role='option']",
        "mat-option",
        "[data-value]",
        "[class*='option' i]",
        "[class*='suggest' i]",
        "[class*='result' i]",
        "[class*='item' i]",
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

        const text = normalize(`${candidate.innerText || candidate.textContent || ""} ${candidate.getAttribute("data-value") ?? ""}`);

        if (!text || text.length > 220 || /\b(cannot find|fill in manually|manually|please provide|no results)\b/.test(text)) {
          continue;
        }

        const score = scoreLocationOption(text, intent, normalizedQuery, normalizedValue, aliases, expectedCountry);
        const inKnownDropdown = popup instanceof HTMLElement || Boolean(candidate.closest([
          "[role='listbox']",
          "[role='menu']",
          "[role='dialog']",
          ".cdk-overlay-pane",
          "[class*='dropdown' i]",
          "[class*='menu' i]",
          "[class*='option' i]",
          "[class*='suggest' i]",
          "[class*='result' i]",
          "[class*='popover' i]",
          "[class*='paper' i]",
          "[class*='list' i]",
          ".select2-results"
        ].join(",")));

        if (!inKnownDropdown && score < minimumScore(intent) + 35) {
          continue;
        }

        if (score > bestScore) {
          best = candidate;
          bestScore = score;
        }
      }

      if (!best || bestScore < minimumScore(intent)) {
        return false;
      }

      const target = clickableLocationTarget(best);
      target.setAttribute("data-gradlaunch-v2-location-option", marker);
      return true;

      function scoreLocationOption(
        text: string,
        intent: string,
        query: string,
        expected: string,
        aliases: string[],
        country: string | undefined
      ) {
        let score = 0;

        if (intent === "country") {
          if (text === expected || text === query) score += 160;
          if (country && text === country) score += 170;
          if (country && hasPhrase(text, country)) score += 120;
          if (mentionsDifferentCountry(text, country)) score -= 120;
          return score + optionBonus(text);
        }

        if (text === expected) score += 150;
        if (expected && (text.includes(expected) || expected.includes(text))) score += 80;
        if (query && hasPhrase(text, query)) score += 45;

        for (const alias of aliases) {
          if (alias.length > 2 && hasPhrase(text, alias)) {
            score += text.startsWith(alias) ? 100 : 78;
            break;
          }
        }

        if (country) {
          if (hasPhrase(text, country)) {
            score += 42;
          } else if (mentionsDifferentCountry(text, country)) {
            score -= 95;
          }
        }

        return score + optionBonus(text);
      }

      function optionBonus(_text: string) {
        return 0;
      }

      function minimumScore(intent: string) {
        return intent === "country" ? 110 : 92;
      }

      function locationAliases(expected: string, typedQuery: string) {
        const aliases = new Set<string>();

        for (const raw of [expected, typedQuery]) {
          const withoutCountry = raw
            .replace(/\b(india|australia|canada|united states|usa|united kingdom|uk)\b/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          const withoutRegion = withoutCountry
            .replace(/\b(haryana|bihar|maharashtra|karnataka|uttar pradesh|telangana|tamil nadu|west bengal|new south wales|california|washington|texas)\b/g, " ")
            .replace(/\s+/g, " ")
            .trim();

          for (const alias of [withoutRegion, withoutCountry, raw.split(" ")[0]]) {
            const normalizedAlias = normalize(alias);

            if (normalizedAlias && !/^(city|location|country|state|region|india)$/.test(normalizedAlias)) {
              aliases.add(normalizedAlias);
            }
          }
        }

        if (expected.includes("gurugram") || expected.includes("gurgaon") || typedQuery.includes("gurugram") || typedQuery.includes("gurgaon")) {
          aliases.add("gurugram");
          aliases.add("gurgaon");
        }

        if (expected.includes("bengaluru") || expected.includes("bangalore") || expected.includes("banglore") || typedQuery.includes("bengaluru") || typedQuery.includes("bangalore") || typedQuery.includes("banglore")) {
          aliases.add("bengaluru");
          aliases.add("bangalore");
          aliases.add("banglore");
        }

        if (expected.includes("aurangabad") || typedQuery.includes("aurangabad")) {
          aliases.add("aurangabad");
          aliases.add("aurangabad bihar");
        }

        if (expected.includes("bhiwani") || typedQuery.includes("bhiwani")) {
          aliases.add("bhiwani");
          aliases.add("bhiwani haryana");
        }

        return [...aliases];
      }

      function inferCountry(value: string) {
        if (hasPhrase(value, "india")) return "india";
        if (hasPhrase(value, "australia")) return "australia";
        if (hasPhrase(value, "canada")) return "canada";
        if (hasPhrase(value, "united states") || hasPhrase(value, "usa")) return "united states";
        if (hasPhrase(value, "united kingdom") || hasPhrase(value, "uk")) return "united kingdom";
        return undefined;
      }

      function mentionsDifferentCountry(text: string, desiredCountry: string | undefined) {
        if (!desiredCountry) {
          return false;
        }

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

      function isVisible(element: Element) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
      }

      function clickableLocationTarget(element: HTMLElement) {
        return element.closest([
          "[role='option']",
          "mat-option",
          "li",
          "button",
          "[data-value]",
          "[class*='option' i]"
        ].join(",")) as HTMLElement | null ?? element;
      }

      function normalize(raw: string | null | undefined) {
        return (raw ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9+]+/g, " ").trim();
      }

      function escapeRegExp(raw: string) {
        return raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }

      function findPopupByMarker(marker: string) {
        for (const root of getSearchRoots()) {
          const match = root.querySelector(`[data-gradlaunch-v2-dropdown-popup="${CSS.escape(marker)}"]`);

          if (match instanceof HTMLElement) {
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
    }, { marker, popupMarker: scope?.frame === frame ? scope.popupMarker : undefined, intent: field.intent, query, value }).catch(() => false);

    if (!found) {
      continue;
    }
    try {
      const clicked = await frame.evaluate((optionMarker) => {
        const option = findOptionByMarker(optionMarker);

        if (!(option instanceof HTMLElement)) {
          return false;
        }

        option.scrollIntoView({ block: "nearest", inline: "nearest" });

        if (typeof PointerEvent === "function") {
          option.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
        }

        option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));

        if (typeof PointerEvent === "function") {
          option.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, view: window }));
        }

        option.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
        option.click();
        return true;

        function findOptionByMarker(marker: string) {
          for (const root of getSearchRoots()) {
            const match = root.querySelector(`[data-gradlaunch-v2-location-option="${CSS.escape(marker)}"]`);

            if (match instanceof HTMLElement) {
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
      }, marker).catch(() => false);

      await page.waitForTimeout(180).catch(() => undefined);
      if (clicked) {
        return true;
      }
    } finally {
      await frame.evaluate((optionMarker) => {
        for (const root of getSearchRoots()) {
          root
            .querySelector(`[data-gradlaunch-v2-location-option="${CSS.escape(optionMarker)}"]`)
            ?.removeAttribute("data-gradlaunch-v2-location-option");
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
      }, marker).catch(() => undefined);
    }
  }

  return false;
}

async function findV2Locator(page: Page, field: FillV2Field): Promise<LocatedField | undefined> {
  const selectors = [
    `[data-gradlaunch-v2-field-id="${cssEscape(field.id)}"]`,
    `[data-gradlaunch-fast-field-id="${cssEscape(field.id)}"]`,
    `[data-gradlaunch-field-id="${cssEscape(field.id)}"]`
  ].filter((selector): selector is string => Boolean(selector));

  for (const frame of page.frames()) {
    for (const selector of selectors) {
      const locator = frame.locator(selector).first();

      if (await locator.count().catch(() => 0) > 0) {
        return { frame, locator };
      }
    }
  }

  return findByLabel(page, field);
}

async function findByLabel(page: Page, field: FillV2Field): Promise<LocatedField | undefined> {
  const marker = `fill-v2-target-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  for (const frame of page.frames()) {
    const found = await frame.evaluate(({ field, marker }) => {
      const controls = Array.from(document.querySelectorAll("input, textarea, select, [contenteditable='true'], [role='combobox'], [role='radio'], [role='checkbox'], [aria-haspopup]")) as HTMLElement[];
      const expected = normalize(`${field.label} ${field.intent}`);
      let best: HTMLElement | undefined;
      let bestScore = 0;

      for (const control of controls) {
        if (!isVisible(control) && !(isChoice(control) && hasVisibleChoiceLabel(control))) {
          continue;
        }

        if (control.closest("[hidden], [aria-hidden='true'], [role='listbox'], [role='menu'], .cdk-overlay-pane, mat-option, [class*='option']")) {
          continue;
        }

        const label = normalize([
          control.getAttribute("aria-label"),
          control.getAttribute("placeholder"),
          control.getAttribute("name"),
          control.id,
          control.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" "),
          control.id ? document.querySelector(`label[for="${CSS.escape(control.id)}"]`)?.textContent : "",
          control.closest("label")?.textContent,
          control.closest("fieldset")?.querySelector("legend")?.textContent,
          control.parentElement?.textContent
        ].filter(Boolean).join(" "));
        const score = tokenScore(expected, label);

        if (score > bestScore) {
          best = control;
          bestScore = score;
        }
      }

      if (!best || bestScore < 45) {
        return false;
      }

      best.setAttribute("data-gradlaunch-v2-field-id", marker);
      return true;

      function tokenScore(left: string, right: string) {
        if (!left || !right) return 0;
        const leftTokens = tokens(left);
        const rightTokens = tokens(right);
        let overlap = 0;

        for (const token of leftTokens) {
          if (rightTokens.has(token)) overlap += 1;
        }

        return Math.round((overlap / Math.max(1, new Set([...leftTokens, ...rightTokens]).size)) * 100);
      }

      function tokens(value: string) {
        return new Set(value.split(" ").filter((token) => token.length > 1 && !/^(field|required|select|option|please|enter|choose|the|your)$/.test(token)));
      }

      function isChoice(element: HTMLElement) {
        return element instanceof HTMLInputElement && ["radio", "checkbox"].includes(element.type)
          || element.getAttribute("role") === "radio"
          || element.getAttribute("role") === "checkbox";
      }

      function hasVisibleChoiceLabel(element: HTMLElement) {
        return Boolean(element.id && document.querySelector(`label[for="${CSS.escape(element.id)}"]`) && isVisible(document.querySelector(`label[for="${CSS.escape(element.id)}"]`)!));
      }

      function isVisible(element: Element) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
      }

      function normalize(raw: string | null | undefined) {
        return (raw ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9+]+/g, " ").trim();
      }
    }, { field, marker }).catch(() => false);

    if (found) {
      return { frame, locator: frame.locator(`[data-gradlaunch-v2-field-id="${marker}"]`).first() };
    }
  }

  return undefined;
}

async function resolveTypingLocator(locator: Locator) {
  const marker = `fill-v2-typing-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const found = await locator.evaluate((control, marker) => {
    if (!(control instanceof HTMLElement)) {
      return false;
    }

    const target = isTypingTarget(control)
      ? control
      : Array.from(control.querySelectorAll("input, textarea, [contenteditable='true']"))
        .find((item): item is HTMLElement => item instanceof HTMLElement && isTypingTarget(item));

    if (!target) {
      return false;
    }

    target.setAttribute("data-gradlaunch-v2-typing-target", marker);
    return true;

    function isTypingTarget(element: HTMLElement) {
      if (element instanceof HTMLInputElement) {
        return !["hidden", "file", "submit", "button", "checkbox", "radio", "image", "reset"].includes(element.type) && !element.disabled;
      }

      if (element instanceof HTMLTextAreaElement) {
        return !element.disabled;
      }

      return element.isContentEditable;
    }
  }, marker).catch(() => false);

  return found ? locator.page().locator(`[data-gradlaunch-v2-typing-target="${marker}"]`).first() : undefined;
}

async function realType(locator: Locator, value: string) {
  const selectAll = process.platform === "darwin" ? "Meta+A" : "Control+A";
  await locator.scrollIntoViewIfNeeded().catch(() => undefined);
  await locator.click({ force: true, timeout: 900 });
  await locator.press(selectAll, { timeout: 350 }).catch(() => undefined);
  await locator.press("Backspace", { timeout: 350 }).catch(() => undefined);
  await locator.type(value, {
    delay: Number(process.env.BROWSER_REAL_TYPE_DELAY_MS ?? 5),
    timeout: Math.max(2500, value.length * 80)
  });
}

async function typeOpenSelectSearch(page: Page, query: string, scope?: DropdownScope) {
  if (scope && await typeScopedOpenSelectSearch(scope, query)) {
    return true;
  }

  for (const frame of page.frames()) {
    const input = frame.locator([
      "[role='listbox'] input",
      "[role='dialog'] input",
      "[class*='dropdown'] input",
      "[class*='menu'] input",
      "input[placeholder*='country' i]",
      "input[placeholder*='code' i]",
      "input[placeholder*='Search' i]",
      "input[type='search']",
      ".select2-search__field"
    ].join(",")).first();

    if (await input.isVisible({ timeout: 180 }).catch(() => false)) {
      await realType(input, query).catch(() => undefined);
      return true;
    }
  }

  await page.keyboard.type(query, { delay: 6 }).catch(() => undefined);
  return true;
}

async function clickOpenOption(page: Page, query: string, value: string, scope?: DropdownScope) {
  const expected = [query, value].filter(Boolean);
  const frames = scope ? [scope.frame] : page.frames();

  for (const frame of frames) {
    const marker = `fill-v2-option-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const found = await frame.evaluate(({ marker, popupMarker, expected }) => {
      const expectedKeys = expected.map(normalize).filter(Boolean);
      const popup = popupMarker
        ? findPopupByMarker(popupMarker)
        : undefined;
      const root = popup instanceof HTMLElement ? popup : document;
      const candidates = Array.from(root.querySelectorAll("[role='option'], mat-option, [data-value], [data-dial-code], .iti__country, li, button, div, span")) as HTMLElement[];
      let best: HTMLElement | undefined;
      let bestScore = 0;

      for (const candidate of candidates) {
        if (!isVisible(candidate) || !(popup instanceof HTMLElement || candidate.closest("[role='listbox'], [role='menu'], [role='dialog'], .cdk-overlay-pane, [class*='dropdown'], [class*='menu'], [class*='option'], .select2-results"))) {
          continue;
        }

        const text = normalize(`${candidate.innerText || candidate.textContent || ""} ${candidate.getAttribute("data-value") ?? ""} ${candidate.getAttribute("data-dial-code") ?? ""}`);

        if (!text || text.length > 180) {
          continue;
        }

        let score = 0;

        for (const expectedKey of expectedKeys) {
          if (text === expectedKey) score += 140;
          else if (text.includes(expectedKey) || expectedKey.includes(text)) score += 90;
          score += tokenScore(text, expectedKey, 35);
        }

        if (candidate.getAttribute("role") === "option" || candidate.tagName.toLowerCase() === "mat-option") {
          score += 15;
        }

        if (score > bestScore) {
          best = candidate;
          bestScore = score;
        }
      }

      if (!best || bestScore < 55) {
        return false;
      }

      best.setAttribute("data-gradlaunch-v2-option", marker);
      return true;

      function tokenScore(left: string, right: string, max: number) {
        const leftTokens = tokens(left);
        const rightTokens = tokens(right);
        let overlap = 0;

        for (const token of leftTokens) {
          if (rightTokens.has(token)) overlap += 1;
        }

        return Math.round((overlap / Math.max(1, new Set([...leftTokens, ...rightTokens]).size)) * max);
      }

      function tokens(value: string) {
        return new Set(value.split(" ").filter((token) => token.length > 1 && !/^(select|option|choose|please|the|your)$/.test(token)));
      }

      function isVisible(element: Element) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
      }

      function normalize(raw: string | null | undefined) {
        return (raw ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9+]+/g, " ").trim();
      }

      function findPopupByMarker(marker: string) {
        for (const root of getSearchRoots()) {
          const match = root.querySelector(`[data-gradlaunch-v2-dropdown-popup="${CSS.escape(marker)}"]`);

          if (match instanceof HTMLElement) {
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
    }, { marker, popupMarker: scope?.frame === frame ? scope.popupMarker : undefined, expected }).catch(() => false);

    if (!found) {
      continue;
    }
    try {
      const clicked = await frame.evaluate((optionMarker) => {
        const option = findOptionByMarker(optionMarker);

        if (!(option instanceof HTMLElement)) {
          return false;
        }

        option.scrollIntoView({ block: "nearest", inline: "nearest" });

        if (typeof PointerEvent === "function") {
          option.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
        }

        option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));

        if (typeof PointerEvent === "function") {
          option.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, view: window }));
        }

        option.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
        option.click();
        return true;

        function findOptionByMarker(marker: string) {
          for (const root of getSearchRoots()) {
            const match = root.querySelector(`[data-gradlaunch-v2-option="${CSS.escape(marker)}"]`);

            if (match instanceof HTMLElement) {
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
      }, marker).catch(() => false);

      await page.waitForTimeout(120).catch(() => undefined);

      if (clicked) {
        return true;
      }
    } finally {
      await frame.evaluate((optionMarker) => {
        for (const root of getSearchRoots()) {
          root
            .querySelector(`[data-gradlaunch-v2-option="${CSS.escape(optionMarker)}"]`)
            ?.removeAttribute("data-gradlaunch-v2-option");
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
      }, marker).catch(() => undefined);
    }
  }

  return false;
}

async function waitForDropdownScope(frame: Frame, locator: Locator) {
  const timeoutMs = Number(process.env.BROWSER_DYNAMIC_DROPDOWN_WAIT_MS ?? 1200);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const scope = await markDropdownPopup(frame, locator);

    if (scope && await dropdownHasViableOptions(scope)) {
      return scope;
    }

    await frame.page().waitForTimeout(90).catch(() => undefined);
  }

  return markDropdownPopup(frame, locator);
}

async function markDropdownPopup(frame: Frame, locator: Locator): Promise<DropdownScope | undefined> {
  const popupMarker = `fill-v2-dropdown-popup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const found = await locator.evaluate((control, popupMarker) => {
    if (!(control instanceof HTMLElement)) {
      return false;
    }

    const popup = resolvePopup(control);

    if (!(popup instanceof HTMLElement) || !isVisible(popup)) {
      return false;
    }

    popup.setAttribute("data-gradlaunch-v2-dropdown-popup", popupMarker);
    return true;

    function resolvePopup(control: HTMLElement) {
      const popupSelectors = [
        "[role='listbox']",
        "[role='menu']",
        "[role='dialog']",
        ".cdk-overlay-pane",
        "[class*='dropdown' i]",
        "[class*='menu' i]",
        "[class*='popover' i]",
        "[class*='listbox' i]",
        ".select2-results"
      ].join(",");
      const active = deepActiveElement(document);
      const refs = [
        active,
        control,
        control.closest("[role='combobox'], [aria-haspopup], [aria-controls], [aria-owns]"),
        control.querySelector("[role='combobox'], [aria-haspopup], [aria-controls], [aria-owns]")
      ].filter((element): element is HTMLElement => element instanceof HTMLElement);

      for (const ref of refs) {
        const linked = popupFromReference(ref, popupSelectors);

        if (linked) {
          return linked;
        }
      }

      const activePopup = active?.closest(popupSelectors);

      if (activePopup instanceof HTMLElement) {
        return activePopup;
      }

      return undefined;
    }

    function popupFromReference(ref: HTMLElement, popupSelectors: string) {
      for (const attr of ["aria-controls", "aria-owns"] as const) {
        const raw = ref.getAttribute(attr);

        if (!raw) {
          continue;
        }

        for (const id of raw.split(/\s+/).filter(Boolean)) {
          const popup = getElementByIdDeep(id);

          if (popup instanceof HTMLElement) {
            const direct = popup.matches(popupSelectors)
              ? popup
              : popup.querySelector(popupSelectors) ?? popup.closest(popupSelectors);

            if (direct instanceof HTMLElement) {
              return direct;
            }

            // SmartRecruiters-style controlled menus can be linked by id via aria-controls
            // without carrying our generic popup selector hints. In that case prefer the
            // controlled element itself once it becomes visible.
            if (isVisible(popup)) {
              return popup;
            }
          }
        }
      }

      const activeDescendantId = ref.getAttribute("aria-activedescendant");

      if (activeDescendantId) {
        const activeDescendant = getElementByIdDeep(activeDescendantId);
        const popup = activeDescendant?.closest(popupSelectors);

        if (popup instanceof HTMLElement) {
          return popup;
        }
      }

      const enclosingPopup = ref.closest(popupSelectors);

      if (enclosingPopup instanceof HTMLElement) {
        return enclosingPopup;
      }

      return undefined;
    }

    function getElementByIdDeep(id: string) {
      for (const root of getSearchRoots()) {
        if ("getElementById" in root && typeof root.getElementById === "function") {
          const match = root.getElementById(id);

          if (match) {
            return match;
          }
        } else {
          const match = root.querySelector(`#${CSS.escape(id)}`);

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

    function deepActiveElement(root: Document | ShadowRoot): HTMLElement | undefined {
      const active = root.activeElement;

      if (!(active instanceof HTMLElement)) {
        return undefined;
      }

      if (active.shadowRoot) {
        return deepActiveElement(active.shadowRoot) ?? active;
      }

      return active;
    }

    function isVisible(element: Element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
    }
  }, popupMarker).catch(() => false);

  if (!found) {
    return undefined;
  }

  return { frame, popupMarker };
}

async function dropdownHasViableOptions(scope: DropdownScope) {
  return scope.frame.evaluate((popupMarker) => {
    const popup = findPopupByMarker(popupMarker);

    if (!(popup instanceof HTMLElement)) {
      return false;
    }

    const candidates = Array.from(popup.querySelectorAll([
      "[role='option']",
      "mat-option",
      "[data-dial-code]",
      "[data-value]",
      "li",
      "button",
      "div",
      "span"
    ].join(","))) as HTMLElement[];

    return candidates.some((candidate) => {
      if (!isVisible(candidate)) {
        return false;
      }

      const text = normalize(`${candidate.innerText || candidate.textContent || ""} ${candidate.getAttribute("data-value") ?? ""} ${candidate.getAttribute("data-dial-code") ?? ""}`);
      return Boolean(text) && !/\b(loading|searching|no results|no matches|cannot find|fill in manually)\b/.test(text);
    });

    function isVisible(element: Element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
    }

    function normalize(raw: string | null | undefined) {
      return (raw ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9+]+/g, " ").trim();
    }

    function findPopupByMarker(marker: string) {
      for (const root of getSearchRoots()) {
        const match = root.querySelector(`[data-gradlaunch-v2-dropdown-popup="${CSS.escape(marker)}"]`);

        if (match instanceof HTMLElement) {
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
  }, scope.popupMarker).catch(() => false);
}

async function waitForMatchingLocationOption(scope: DropdownScope | undefined, expectedValue: string, typedQuery?: string) {
  if (!scope) {
    return false;
  }

  const timeoutMs = Number(process.env.BROWSER_LOCATION_MATCH_TIMEOUT_MS ?? 2600);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const options = await readVisibleOptionTexts(scope);

    if (options.some((option) => highlightedOptionMatches(option, expectedValue))
      || (typedQuery && options.some((option) => highlightedOptionMatches(option, typedQuery)))) {
      return true;
    }

    await scope.frame.page().waitForTimeout(90).catch(() => undefined);
  }

  return false;
}

async function typeScopedOpenSelectSearch(scope: DropdownScope, query: string) {
  const popupInput = scope.frame.locator([
    `[data-gradlaunch-v2-dropdown-popup="${cssEscape(scope.popupMarker)}"] input`,
    `[data-gradlaunch-v2-dropdown-popup="${cssEscape(scope.popupMarker)}"] textarea`,
    `[data-gradlaunch-v2-dropdown-popup="${cssEscape(scope.popupMarker)}"] [role='searchbox']`,
    `[data-gradlaunch-v2-dropdown-popup="${cssEscape(scope.popupMarker)}"] [role='combobox']`,
    `[data-gradlaunch-v2-dropdown-popup="${cssEscape(scope.popupMarker)}"] [contenteditable='true']`
  ].join(",")).first();

  if (await popupInput.isVisible({ timeout: 150 }).catch(() => false)) {
    await realType(popupInput, query).catch(() => undefined);
    return true;
  }

  return false;
}

async function commitDropdownByKeyboard(page: Page, scope?: DropdownScope) {
  if (scope && !await dropdownHasViableOptions(scope)) {
    return false;
  }

  await page.keyboard.press("ArrowDown").catch(() => undefined);
  await page.waitForTimeout(70).catch(() => undefined);
  await page.keyboard.press("Enter").catch(() => undefined);
  await page.waitForTimeout(120).catch(() => undefined);
  return true;
}

async function commitComboboxSuggestionByKeyboard(page: Page, scope?: DropdownScope, expectedValue?: string, focusTarget?: Locator) {
  if (!scope || !await dropdownHasViableOptions(scope)) {
    return false;
  }

  if (focusTarget) {
    await focusTarget.click({ force: true, timeout: 700 }).catch(() => undefined);
  }

  const maxMoves = Number(process.env.BROWSER_COMBOBOX_NAVIGATION_STEPS ?? 6);

  for (let move = 0; move < maxMoves; move += 1) {
    const highlighted = await readHighlightedOption(scope);

    if (highlighted && (!expectedValue || highlightedOptionMatches(highlighted, expectedValue))) {
      await page.keyboard.press("Enter").catch(() => undefined);
      await page.waitForTimeout(140).catch(() => undefined);
      return true;
    }

    await page.keyboard.press("ArrowDown").catch(() => undefined);
    await page.waitForTimeout(80).catch(() => undefined);
  }

  const highlighted = await readHighlightedOption(scope);

  if (!highlighted || (expectedValue && !highlightedOptionMatches(highlighted, expectedValue))) {
    return false;
  }

  await page.keyboard.press("Enter").catch(() => undefined);
  await page.waitForTimeout(140).catch(() => undefined);
  return true;
}

async function popupHasHighlightedOption(scope: DropdownScope) {
  return scope.frame.evaluate((popupMarker) => {
    const popup = findPopupByMarker(popupMarker);

    if (!(popup instanceof HTMLElement)) {
      return false;
    }

    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const activeDescendant = active?.getAttribute("aria-activedescendant");

    if (activeDescendant) {
      const option = getElementByIdDeep(activeDescendant);

      if (option instanceof HTMLElement) {
        return true;
      }
    }

    return Boolean(popup.querySelector("[aria-selected='true'], [data-focus='true'], [data-highlighted='true'], .active, .highlighted"));

    function findPopupByMarker(marker: string) {
      for (const root of getSearchRoots()) {
        const match = root.querySelector(`[data-gradlaunch-v2-dropdown-popup="${CSS.escape(marker)}"]`);

        if (match instanceof HTMLElement) {
          return match;
        }
      }

      return null;
    }

    function getElementByIdDeep(id: string) {
      for (const root of getSearchRoots()) {
        if ("getElementById" in root && typeof root.getElementById === "function") {
          const match = root.getElementById(id);

          if (match) {
            return match;
          }
        } else {
          const match = root.querySelector(`#${CSS.escape(id)}`);

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
  }, scope.popupMarker).catch(() => false);
}

async function readVisibleOptionTexts(scope: DropdownScope) {
  return scope.frame.evaluate((popupMarker) => {
    const popup = findPopupByMarker(popupMarker);

    if (!(popup instanceof HTMLElement)) {
      return [] as string[];
    }

    return Array.from(popup.querySelectorAll([
      "[role='option']",
      "mat-option",
      "[data-dial-code]",
      "[data-value]",
      "li",
      "button",
      "div",
      "span"
    ].join(",")))
      .filter((element): element is HTMLElement => element instanceof HTMLElement && isVisible(element))
      .map((element) => `${element.innerText || element.textContent || ""} ${element.getAttribute("data-value") ?? ""} ${element.getAttribute("data-dial-code") ?? ""}`.replace(/\s+/g, " ").trim())
      .filter((text) => Boolean(text) && !/\b(loading|searching|no results|no matches|cannot find|fill in manually)\b/i.test(text));

    function isVisible(element: Element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
    }

    function findPopupByMarker(marker: string) {
      for (const root of getSearchRoots()) {
        const match = root.querySelector(`[data-gradlaunch-v2-dropdown-popup="${CSS.escape(marker)}"]`);

        if (match instanceof HTMLElement) {
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
  }, scope.popupMarker).catch(() => []);
}

async function cleanupDropdownScope(scope: DropdownScope) {
  await scope.frame.evaluate((popupMarker) => {
    for (const root of getSearchRoots()) {
      root
        .querySelector(`[data-gradlaunch-v2-dropdown-popup="${CSS.escape(popupMarker)}"]`)
        ?.removeAttribute("data-gradlaunch-v2-dropdown-popup");
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
  }, scope.popupMarker).catch(() => undefined);
}

async function readHighlightedOption(scope: DropdownScope) {
  return scope.frame.evaluate((popupMarker) => {
    const popup = findPopupByMarker(popupMarker);

    if (!(popup instanceof HTMLElement)) {
      return "";
    }

    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const activeDescendant = active?.getAttribute("aria-activedescendant");

    if (activeDescendant) {
      const option = getElementByIdDeep(activeDescendant);
      const text = (option instanceof HTMLElement ? option.innerText || option.textContent || "" : "").replace(/\s+/g, " ").trim();

      if (text) {
        return text;
      }
    }

    const highlighted = popup.querySelector("[aria-selected='true'], [data-focus='true'], [data-highlighted='true'], .active, .highlighted");
    return (highlighted instanceof HTMLElement ? highlighted.innerText || highlighted.textContent || "" : "").replace(/\s+/g, " ").trim();

    function findPopupByMarker(marker: string) {
      for (const root of getSearchRoots()) {
        const match = root.querySelector(`[data-gradlaunch-v2-dropdown-popup="${CSS.escape(marker)}"]`);

        if (match instanceof HTMLElement) {
          return match;
        }
      }

      return null;
    }

    function getElementByIdDeep(id: string) {
      for (const root of getSearchRoots()) {
        if ("getElementById" in root && typeof root.getElementById === "function") {
          const match = root.getElementById(id);

          if (match) {
            return match;
          }
        } else {
          const match = root.querySelector(`#${CSS.escape(id)}`);

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
  }, scope.popupMarker).catch(() => "");
}

async function clickCountryCodeOption(page: Page, countryName: string, dialDigits: string, scope?: DropdownScope) {
  const frames = scope ? [scope.frame] : page.frames();

  for (const frame of frames) {
    const marker = `fill-v2-country-code-option-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const found = await frame.evaluate(({ marker, popupMarker, countryName, dialDigits }) => {
      const expectedCountry = normalize(countryName);
      const expectedDial = dialDigits.replace(/\D+/g, "");
      const popup = popupMarker ? findPopupByMarker(popupMarker) : undefined;
      const roots = popup instanceof HTMLElement ? [popup] : getSearchRoots();
      let best: HTMLElement | undefined;
      let bestScore = 0;

      for (const root of roots) {
        const candidates = Array.from(root.querySelectorAll([
          "[data-dial-code]",
          ".iti__country",
          "[role='option']",
          "[data-value]",
          "li",
          "button",
          "div",
          "span"
        ].join(","))) as HTMLElement[];

        for (const candidate of candidates) {
          if (!isVisible(candidate)) {
            continue;
          }

          const rawText = [
            candidate.getAttribute("data-dial-code"),
            candidate.getAttribute("aria-label"),
            candidate.getAttribute("data-value"),
            candidate.innerText,
            candidate.textContent
          ].filter(Boolean).join(" ");
          const text = normalize(rawText);
          const candidateDial = (candidate.getAttribute("data-dial-code") ?? "").replace(/\D+/g, "");

          if (!text) {
            continue;
          }

          let score = 0;

          if (candidateDial && candidateDial === expectedDial) {
            score += 220;
          }

          if (expectedDial && (text.includes(` ${expectedDial} `) || text.endsWith(` ${expectedDial}`) || text.includes(`+${expectedDial}`))) {
            score += 170;
          }

          if (expectedCountry && hasPhrase(text, expectedCountry)) {
            score += 140;
          }

          if (candidate.closest("[role='listbox'], [role='menu'], [role='dialog'], .cdk-overlay-pane, [class*='dropdown' i], [class*='menu' i], [class*='list' i]")) {
            score += 28;
          }

          if (!candidateDial && !candidate.closest("[role='listbox'], [role='menu'], [role='dialog'], .cdk-overlay-pane, [class*='dropdown' i], [class*='menu' i], [class*='list' i]") && score < 180) {
            continue;
          }

          if (score > bestScore) {
            bestScore = score;
            best = candidate;
          }
        }
      }

      if (!best || bestScore < 170) {
        return false;
      }

      best.setAttribute("data-gradlaunch-v2-country-code-option", marker);
      return true;

      function hasPhrase(text: string, phrase: string) {
        if (!text || !phrase) {
          return false;
        }

        return new RegExp(`(^| )${escapeRegExp(phrase)}( |$)`).test(text);
      }

      function escapeRegExp(value: string) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }

      function normalize(value: string | null | undefined) {
        return (value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9+]+/g, " ").trim();
      }

      function isVisible(element: Element) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
      }

      function findPopupByMarker(marker: string) {
        for (const root of getSearchRoots()) {
          const match = root.querySelector(`[data-gradlaunch-v2-dropdown-popup="${CSS.escape(marker)}"]`);

          if (match instanceof HTMLElement) {
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
    }, { marker, popupMarker: scope?.frame === frame ? scope.popupMarker : undefined, countryName, dialDigits }).catch(() => false);

    if (!found) {
      continue;
    }

    try {
      const clicked = await frame.evaluate((optionMarker) => {
        for (const root of getSearchRoots()) {
          const option = root.querySelector(`[data-gradlaunch-v2-country-code-option="${CSS.escape(optionMarker)}"]`);

          if (!(option instanceof HTMLElement)) {
            continue;
          }

          option.scrollIntoView({ block: "nearest", inline: "nearest" });

          if (typeof PointerEvent === "function") {
            option.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
          }

          option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));

          if (typeof PointerEvent === "function") {
            option.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, view: window }));
          }

          option.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
          option.click();
          return true;
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

      await page.waitForTimeout(140).catch(() => undefined);

      if (clicked) {
        return true;
      }
    } finally {
      await frame.evaluate((optionMarker) => {
        for (const root of getSearchRoots()) {
          root
            .querySelector(`[data-gradlaunch-v2-country-code-option="${CSS.escape(optionMarker)}"]`)
            ?.removeAttribute("data-gradlaunch-v2-country-code-option");
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
      }, marker).catch(() => undefined);
    }
  }

  return false;
}

function highlightedOptionMatches(actual: string, expected: string) {
  const actualKey = normalizeLocationCandidate(actual);
  const expectedKey = normalizeLocationCandidate(expected);

  if (!actualKey || !expectedKey) {
    return false;
  }

  if (actualKey === expectedKey || actualKey.includes(expectedKey) || expectedKey.includes(actualKey)) {
    return true;
  }

  const aliases = locationMatchAliases(expected);
  return aliases.some((alias) => alias && (actualKey === alias || actualKey.includes(alias) || alias.includes(actualKey)));
}

function locationMatchAliases(value: string) {
  const normalized = normalizeLocationCandidate(value);
  const aliases = new Set<string>([normalized]);

  if (/\bgurugram|gurgaon\b/.test(normalized)) {
    aliases.add("gurugram");
    aliases.add("gurgaon");
  }

  if (/\bbengaluru|bangalore|banglore\b/.test(normalized)) {
    aliases.add("bengaluru");
    aliases.add("bangalore");
    aliases.add("banglore");
  }

  const stripped = normalized
    .replace(/\b(india|australia|canada|united states|usa|united kingdom|uk)\b/g, " ")
    .replace(/\b(haryana|bihar|maharashtra|karnataka|uttar pradesh|telangana|tamil nadu|west bengal|new south wales|california|washington|texas|new york)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (stripped) {
    aliases.add(stripped);
  }

  const cityOnly = stripped.split(",")[0]?.trim() || stripped.split(" ")[0]?.trim();

  if (cityOnly) {
    aliases.add(cityOnly);
  }

  return [...aliases].filter(Boolean);
}

function normalizeLocationCandidate(value: string | undefined) {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function openPhoneCountryPicker(locator: Locator) {
  const marker = `fill-v2-phone-trigger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const found = await locator.evaluate((control, marker) => {
    if (!(control instanceof HTMLElement)) {
      return false;
    }

    let current: HTMLElement | null = control;

    for (let depth = 0; depth < 7 && current; depth += 1) {
      const trigger = current.querySelector(".iti__selected-flag, .iti__selected-country, [class*='selected-country'], [class*='selectedCountry'], mat-select, [role='combobox'], [aria-haspopup], button") as HTMLElement | null;

      if (trigger && isVisible(trigger)) {
        trigger.setAttribute("data-gradlaunch-v2-phone-trigger", marker);
        return true;
      }

      current = current.parentElement;
    }

    return false;

    function isVisible(element: Element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
    }
  }, marker).catch(() => false);

  if (!found) {
    return false;
  }

  const trigger = locator.page().locator(`[data-gradlaunch-v2-phone-trigger="${marker}"]`).first();
  await trigger.click({ force: true, timeout: 700 }).catch(() => undefined);
  await locator.page().waitForTimeout(120).catch(() => undefined);
  return true;
}

async function typePhoneCountrySearch(page: Page, dialDigits: string) {
  for (const frame of page.frames()) {
    const input = frame.locator(".iti__search-input, input[type='search'], input[placeholder*='Search' i], [role='dialog'] input").first();

    if (await input.isVisible({ timeout: 150 }).catch(() => false)) {
      await realType(input, dialDigits).catch(() => undefined);
      return true;
    }
  }

  await page.keyboard.type(dialDigits, { delay: 6 }).catch(() => undefined);
  return true;
}

async function clickPhoneCountry(page: Page, dialDigits: string) {
  for (const frame of page.frames()) {
    const option = frame.locator(`[data-dial-code="${cssEscape(dialDigits)}"], .iti__country[data-dial-code="${cssEscape(dialDigits)}"], [role='option']`)
      .filter({ hasText: new RegExp(`\\+?${escapeRegExp(dialDigits)}|India`, "i") })
      .first();

    if (await option.isVisible({ timeout: 500 }).catch(() => false)) {
      await option.click({ force: true, timeout: 700 }).catch(() => undefined);
      await page.waitForTimeout(120).catch(() => undefined);
      return true;
    }
  }

  return false;
}

function parsePhone(value: string) {
  const digits = value.replace(/\D+/g, "");

  if (digits.length < 7) {
    return undefined;
  }

  const explicitDial = value.match(/^\s*\+(\d{1,4})(?=$|[\s().-]|\d)/)?.[1];
  const dialDigits = explicitDial ?? (digits.length > 10 ? digits.slice(0, digits.length - 10) : "91");
  const localNumber = dialDigits && digits.startsWith(dialDigits) ? digits.slice(dialDigits.length) : digits.slice(-10);

  return {
    dialDigits,
    localNumber,
    fullNumber: `+${dialDigits}${localNumber}`
  };
}

function isLocationField(field: FillV2Field) {
  return field.intent === "country" || field.intent === "state" || field.intent === "city";
}

function isPhoneCountryCodeField(field: FillV2Field) {
  return field.intent === "country"
    && /\b(country code|country region code|search by country region or code|dial code|phone code)\b/.test(normalizeLocationCandidate(`${field.label} ${field.context}`));
}

function inferDialDigitsFromCountry(value: string | undefined) {
  const normalized = normalizeLocationCandidate(value);

  if (!normalized) {
    return undefined;
  }

  if (/\bindia|indian\b/.test(normalized)) return "91";
  if (/\bunited states|usa|us|canada\b/.test(normalized)) return "1";
  if (/\bunited kingdom|uk|britain|england\b/.test(normalized)) return "44";
  if (/\baustralia\b/.test(normalized)) return "61";
  if (/\bgermany\b/.test(normalized)) return "49";
  if (/\bfrance\b/.test(normalized)) return "33";
  if (/\bsingapore\b/.test(normalized)) return "65";

  return undefined;
}

function cssEscape(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
