import type { Page } from "playwright-core";
import type { BrowserFillField } from "./types";
import { normalizeKey } from "./util";

export async function fillFormField(page: Page, field: BrowserFillField) {
  const filledByAgentTarget = await fillByAgentFieldId(page, field);

  if (filledByAgentTarget) {
    return true;
  }

  if (field.inputType === "radio" || field.inputType === "checkbox") {
    return fillChoiceField(page, field);
  }

  if (field.inputType === "select") {
    return fillSelectField(page, field);
  }

  return fillTextField(page, field) || fillChoiceField(page, field);
}

export async function attachResume(page: Page, resumePath: string) {
  for (const frame of page.frames()) {
    const locator = frame.locator("input[type='file']").first();

    try {
      await locator.setInputFiles(resumePath, { timeout: 2000 });
      return true;
    } catch (_error) {
      // Try the next frame.
    }
  }

  return false;
}

async function fillByAgentFieldId(page: Page, field: BrowserFillField) {
  if (!field.fieldId || !field.value.trim()) {
    return false;
  }

  for (const frame of page.frames()) {
    const filled = await frame.evaluate(
      ({ fieldId, fieldValue }) => {
        const control = document.querySelector(`[data-gradlaunch-field-id="${CSS.escape(fieldId)}"]`);

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

        if (control instanceof HTMLSelectElement) {
          const option = Array.from(control.options).find((item) => normalize(item.text) === normalizedValue || normalize(item.value) === normalizedValue)
            ?? Array.from(control.options).find((item) => normalize(item.text).includes(normalizedValue) || normalizedValue.includes(normalize(item.text)));

          if (!option) {
            return false;
          }

          control.value = option.value;
          dispatch(control);
          return true;
        }

        if (control instanceof HTMLInputElement && ["radio", "checkbox"].includes(control.type)) {
          const group = control.name
            ? Array.from(document.querySelectorAll(`input[name="${CSS.escape(control.name)}"]`)) as HTMLInputElement[]
            : [control];
          const target = group.find((item) => normalize(getOptionText(item)) === normalizedValue || normalize(item.value) === normalizedValue)
            ?? group.find((item) => normalize(getOptionText(item)).includes(normalizedValue) || normalizedValue.includes(normalize(getOptionText(item))))
            ?? (/^(yes|true|agree|accept|consent|confirm|i agree)$/.test(normalizedValue) ? control : undefined);

          if (!target) {
            return false;
          }

          if (!target.checked) {
            target.click();
          }

          dispatch(target);
          return true;
        }

        control.focus();
        setNativeValue(control, fieldValue);
        dispatch(control);
        return normalize(control.value) === normalizedValue || normalize(control.value).includes(normalizedValue);

        function dispatch(element: Element) {
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          element.dispatchEvent(new Event("blur", { bubbles: true }));
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
      },
      { fieldId: field.fieldId, fieldValue: field.value }
    ).catch(() => false);

    if (filled) {
      return true;
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
      ({ label, value }) => {
        const controls = Array.from(document.querySelectorAll("input, textarea")) as Array<HTMLInputElement | HTMLTextAreaElement>;
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
            control.closest("fieldset")?.textContent
          ].filter(Boolean).join(" "));
          const score = scoreText(descriptor, label);

          if (score > bestScore) {
            best = control;
            bestScore = score;
          }
        }

        if (!best || bestScore < 40) {
          return false;
        }

        best.focus();
        setNativeValue(best, value);
        best.dispatchEvent(new Event("input", { bubbles: true }));
        best.dispatchEvent(new Event("change", { bubbles: true }));
        best.dispatchEvent(new Event("blur", { bubbles: true }));
        return true;

        function scoreText(descriptor: string, target: string) {
          if (!descriptor || !target) {
            return 0;
          }

          if (descriptor === target) {
            return 100;
          }

          if (descriptor.includes(target) || target.includes(descriptor)) {
            return 75;
          }

          const targetTokens = target.split(" ").filter(Boolean);
          return targetTokens.reduce((sum, token) => sum + (descriptor.includes(token) ? 15 : 0), 0);
        }

        function findLabelText(control: Element) {
          if (control.id) {
            const label = document.querySelector(`label[for="${CSS.escape(control.id)}"]`);

            if (label?.textContent?.trim()) {
              return label.textContent.trim();
            }
          }

          return control.closest("label")?.textContent?.trim()
            || control.closest("fieldset")?.querySelector("legend")?.textContent?.trim()
            || "";
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
      },
      { label: normalizedLabel, value: field.value }
    ).catch(() => false);

    if (filled) {
      return true;
    }
  }

  return false;
}

async function fillSelectField(page: Page, field: BrowserFillField) {
  const value = field.value.trim();

  if (!value) {
    return false;
  }

  for (const frame of page.frames()) {
    const filled = await frame.evaluate(
      ({ fieldId, fieldLabel, fieldValue }) => {
        const controls = Array.from(document.querySelectorAll("select")) as HTMLSelectElement[];
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
            bestScore = 100;
            break;
          }

          const descriptor = normalize([
            control.getAttribute("aria-label"),
            control.getAttribute("name"),
            control.id,
            control.closest("label")?.textContent,
            control.closest("fieldset")?.textContent
          ].filter(Boolean).join(" "));
          const score = descriptor.includes(normalizedLabel) ? 80 : normalizedLabel.includes(descriptor) ? 60 : 0;

          if (score > bestScore) {
            best = control;
            bestScore = score;
          }
        }

        if (!best) {
          return false;
        }

        const option = Array.from(best.options).find((item) => normalize(item.text) === normalizedValue || normalize(item.value) === normalizedValue)
          ?? Array.from(best.options).find((item) => normalize(item.text).includes(normalizedValue) || normalizedValue.includes(normalize(item.text)));

        if (!option) {
          return false;
        }

        best.value = option.value;
        best.dispatchEvent(new Event("input", { bubbles: true }));
        best.dispatchEvent(new Event("change", { bubbles: true }));
        return true;

        function normalize(value: string) {
          return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
          let score = 0;

          if (descriptor.includes(label)) {
            score += 40;
          }

          if (optionText === value) {
            score += 70;
          } else if (optionText.includes(value) || value.includes(optionText)) {
            score += 52;
          }

          if (control.type === "checkbox" && /^(yes|true|agree|authorized|available|willing|i agree)$/.test(value)) {
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

        bestControl.click();
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
      },
      { label: normalizedLabel, value: normalizedValue }
    ).catch(() => false);

    if (filled) {
      return true;
    }
  }

  return false;
}
