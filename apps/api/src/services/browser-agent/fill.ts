import type { Frame, Locator, Page } from "playwright-core";
import type { BrowserFillField } from "./types";
import { normalizeKey } from "./util";

export async function fillFormField(page: Page, field: BrowserFillField) {
  if (field.inputType === "file") {
    return false;
  }

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

  return fillSelectLikeField(page, field) || fillTextField(page, field) || fillChoiceField(page, field);
}

export async function attachResume(page: Page, resumePath: string) {
  if (await hasExistingAttachedFile(page)) {
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
            score += 80;
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
            score -= 40;
          }

          if (control.multiple) {
            score += 4;
          }

          if (score > bestScore) {
            bestScore = score;
            bestIndex = index;
          }
        }

        return bestIndex;

        function normalize(value: string) {
          return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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

async function hasExistingAttachedFile(page: Page) {
  for (const frame of page.frames()) {
    const alreadyAttached = await frame.evaluate(() => {
      return Array.from(document.querySelectorAll("input[type='file']")).some((control) => {
        return control instanceof HTMLInputElement && !control.disabled && (control.files?.length ?? 0) > 0;
      });
    }).catch(() => false);

    if (alreadyAttached) {
      return true;
    }
  }

  return false;
}

async function attachResumeViaUploadTrigger(page: Page, resumePath: string) {
  const triggerSelectors = [
    "text=/browse file/i",
    "text=/drag and drop your resume/i",
    "text=/upload resume/i",
    "text=/attach resume/i",
    "text=/choose file/i",
    "text=/select file/i",
    "button:has-text('Browse File')",
    "[role='button']:has-text('Browse File')",
    "label:has-text('Browse File')"
  ];

  for (const frame of page.frames()) {
    for (const selector of triggerSelectors) {
      try {
        const trigger = frame.locator(selector).first();

        if (!await trigger.isVisible({ timeout: 300 })) {
          continue;
        }

        const uploadedViaAssociatedInput = await attachResumeToAssociatedInput(frame, trigger, resumePath);

        if (uploadedViaAssociatedInput) {
          return true;
        }

        const [chooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 2000 }),
          trigger.click({ force: true, timeout: 1500 })
        ]);

        await chooser.setFiles(resumePath);
        await page.waitForTimeout(700).catch(() => undefined);
        return true;
      } catch (_error) {
        // Try the next trigger candidate.
      }
    }
  }

  return false;
}

async function attachResumeToAssociatedInput(frame: Frame, trigger: Locator, resumePath: string) {
  const marker = `gl-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const found = await trigger.evaluate((element, targetMarker) => {
    const candidates = new Set<HTMLInputElement>();

    const addIfFileInput = (candidate: Element | null | undefined) => {
      if (candidate instanceof HTMLInputElement && candidate.type === "file" && !candidate.disabled) {
        candidates.add(candidate);
      }
    };

    addIfFileInput(element.querySelector("input[type='file']"));
    addIfFileInput(element.closest("label")?.querySelector("input[type='file']"));
    addIfFileInput(element.closest("form, section, article, fieldset, [role='group'], div")?.querySelector("input[type='file']"));

    if (element instanceof HTMLLabelElement && element.htmlFor) {
      addIfFileInput(document.getElementById(element.htmlFor));
    }

    if (element instanceof HTMLElement) {
      const labelledBy = element.getAttribute("aria-labelledby");

      if (labelledBy) {
        for (const id of labelledBy.split(/\s+/)) {
          addIfFileInput(document.getElementById(id)?.querySelector("input[type='file']"));
        }
      }
    }

    const best = [...candidates][0];

    if (!best) {
      return false;
    }

    best.setAttribute("data-gradlaunch-upload-target", targetMarker);
    return true;
  }, marker).catch(() => false);

  if (!found) {
    return false;
  }

  const inputLocator = frame.locator(`[data-gradlaunch-upload-target="${marker}"]`).first();

  try {
    await inputLocator.setInputFiles(resumePath, { timeout: 2500 });
    return await inputLocator.evaluate((control) => {
      return control instanceof HTMLInputElement && (control.files?.length ?? 0) > 0;
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

async function fillByAgentFieldId(page: Page, field: BrowserFillField) {
  if (!field.fieldId || !field.value.trim()) {
    return false;
  }

  const filledByPlaywright = await fillByPlaywrightFieldTarget(page, field);

  if (filledByPlaywright) {
    return true;
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
          || isCustomSelectLike(control)
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

        function isCustomSelectLike(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
          if (control instanceof HTMLSelectElement) {
            return false;
          }

          const popup = control.getAttribute("aria-haspopup")
            ?? control.closest("[aria-haspopup]")?.getAttribute("aria-haspopup")
            ?? "";
          const role = control.getAttribute("role")
            ?? control.closest("[role]")?.getAttribute("role")
            ?? "";
          const expanded = control.getAttribute("aria-expanded") ?? control.closest("[aria-expanded]")?.getAttribute("aria-expanded");

          return role === "combobox"
            || /listbox|menu|dialog|tree/.test(popup)
            || expanded !== null
            || Boolean(control.closest("[role='combobox'], [aria-haspopup='listbox'], [data-radix-select-trigger], [data-headlessui-state], [class*='select'], [class*='combobox']"));
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
        await locator.click({ timeout: 1000 });
        await locator.fill("", { timeout: 1000 }).catch(() => undefined);
        await locator.fill(field.value, { timeout: 1500 });
        await locator.blur().catch(() => undefined);
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

      if (verified) {
        return true;
      }
    } catch (_error) {
      // Fall back to DOM-level setters below.
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

async function fillSelectLikeField(page: Page, field: BrowserFillField) {
  const value = field.value.trim();

  if (!value || field.inputType === "file") {
    return false;
  }

  const aliases = getFieldAliases(field.label);

  for (const frame of page.frames()) {
    const targets = [
      field.fieldId ? frame.locator(`[data-gradlaunch-field-id="${field.fieldId}"]`).first() : undefined,
      ...aliases.flatMap((alias) => [
        frame.getByRole("combobox", { name: alias, exact: false }).first(),
        frame.getByLabel(alias, { exact: false }).first(),
        frame.getByPlaceholder(alias, { exact: false }).first(),
        frame.getByRole("button", { name: alias, exact: false }).first()
      ])
    ].filter(Boolean);

    for (const target of targets) {
      try {
        const visible = await target!.isVisible({ timeout: 250 }).catch(() => false);

        if (!visible) {
          continue;
        }

        const isFileInput = await target!.evaluate((element) => {
          return element instanceof HTMLInputElement && element.type === "file";
        }).catch(() => false);

        if (isFileInput) {
          continue;
        }

        await target!.scrollIntoViewIfNeeded().catch(() => undefined);
        await target!.click({ force: true, timeout: 1000 }).catch(() => undefined);
        await page.waitForTimeout(120).catch(() => undefined);

        await target!.fill(value, { timeout: 800 }).catch(async () => {
          await target!.press(process.platform === "darwin" ? "Meta+A" : "Control+A", { timeout: 250 }).catch(() => undefined);
          await target!.type(value, { delay: 25, timeout: 1200 }).catch(() => undefined);
        });
        await page.waitForTimeout(180).catch(() => undefined);

        const optionClicked = await clickVisibleSelectOption(frame, value);

        if (optionClicked) {
          return true;
        }

        await target!.press("Enter", { timeout: 400 }).catch(() => undefined);
        const verified = await target!.evaluate((element, expected) => {
          if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
            return false;
          }

          const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
          const actual = normalize(element.value);
          const wanted = normalize(expected);
          return actual === wanted || actual.includes(wanted) || wanted.includes(actual);
        }, value).catch(() => false);

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

function normalizeInline(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function clickVisibleSelectOption(frame: Awaited<ReturnType<Page["mainFrame"]>>, value: string) {
  return frame.evaluate((expected) => {
    const normalizedExpected = normalize(expected);
    const candidates = Array.from(document.querySelectorAll([
      "[role='option']",
      "[role='menuitemradio']",
      "[role='menuitemcheckbox']",
      "[role='radio']",
      "[data-radix-collection-item]",
      "[cmdk-item]",
      "li",
      "button"
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

      let score = 0;

      if (text === normalizedExpected) {
        score = 100;
      } else if (text.includes(normalizedExpected) || normalizedExpected.includes(text)) {
        score = 72;
      }

      if (candidate.getAttribute("role") === "option") {
        score += 15;
      }

      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    if (!best || bestScore < 60) {
      return false;
    }

    best.click();
    best.dispatchEvent(new Event("input", { bubbles: true }));
    best.dispatchEvent(new Event("change", { bubbles: true }));
    return true;

    function isVisible(element: HTMLElement) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0 && rect.width > 0 && rect.height > 0;
    }

    function normalize(value: string) {
      return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    }
  }, value).catch(() => false);
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
