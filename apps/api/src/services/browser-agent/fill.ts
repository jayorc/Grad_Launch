import type { Frame, Locator, Page } from "playwright-core";
import type { BrowserFillField } from "./types";
import { normalizeKey } from "./util";

export async function fillFormField(page: Page, field: BrowserFillField) {
  if (field.inputType === "file") {
    return false;
  }

  if (isCountryOptionLabel(field.label)) {
    return fillCountryOptionField(page, field);
  }

  if (isCountryChoiceGroupField(field)) {
    return fillCountryChoiceGroup(page, field);
  }

  if (isCountrySelectField(field)) {
    return fillCountrySelectField(page, field) || fillCountryChoiceGroup(page, field);
  }

  if (field.inputType === "radio" || field.inputType === "checkbox") {
    if (shouldSkipCountryOptionField(field)) {
      return false;
    }

    return fillCountryChoiceGroup(page, field) || fillByAgentFieldId(page, field) || fillChoiceField(page, field);
  }

  if (field.inputType === "select") {
    return fillByAgentFieldId(page, field) || fillSelectField(page, field);
  }

  if (shouldUseSelectLikeFlow(field)) {
    if (looksAutocompleteField(field.label, field.value)) {
      return fillSelectLikeField(page, field) || fillByAgentFieldId(page, field) || fillTextField(page, field);
    }

    return fillByAgentFieldId(page, field) || fillSelectLikeField(page, field) || fillTextField(page, field) || fillChoiceField(page, field);
  }

  return fillByAgentFieldId(page, field) || fillTextField(page, field) || fillChoiceField(page, field);
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
      const attachedControls = Array.from(document.querySelectorAll("input[type='file']")).filter((control): control is HTMLInputElement => {
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
        return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
      const uploadedViaAssociatedInput = await attachResumeToAssociatedInput(frame, trigger, resumePath);

      if (uploadedViaAssociatedInput) {
        return true;
      }

      const chooser = await Promise.all([
        frame.page().waitForEvent("filechooser", { timeout: 2500 }).catch(() => undefined),
        trigger.click({ force: true, timeout: 1200 }).catch(() => undefined)
      ]).then(([fileChooser]) => fileChooser);

      if (!chooser) {
        continue;
      }

      await chooser.setFiles(resumePath);
      await frame.page().waitForTimeout(500).catch(() => undefined);
      return true;
    } catch (_error) {
      // Try the next frame.
    }
  }

  return false;
}

async function findResumeUploadTrigger(frame: Frame) {
  const marker = `gl-resume-trigger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const found = await frame.evaluate((marker) => {
    const candidates = Array.from(document.querySelectorAll("button, [role='button'], label, a, div, span")) as HTMLElement[];
    let best: HTMLElement | undefined;
    let bestScore = 0;

    for (const candidate of candidates) {
      if (!isVisible(candidate)) {
        continue;
      }

      const ownText = normalize(candidate.innerText || candidate.textContent || "");

      if (!/\b(attach|upload|browse|choose file|select file)\b/.test(ownText) || /\b(dropbox|enter manually|manual)\b/.test(ownText)) {
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

      if (/\battach|upload|browse|choose file|select file\b/.test(ownText)) {
        score += 35;
      }

      if (candidate.matches("button, [role='button'], label")) {
        score += 15;
      }

      if (section?.textContent && normalize(section.textContent).length < 500) {
        score += 10;
      }

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
      return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
      const candidates = Array.from(document.querySelectorAll("label, legend, h1, h2, h3, h4, p, span, div")) as HTMLElement[];
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
      const descriptor = [
        input.accept,
        input.name,
        input.id,
        input.getAttribute("aria-label"),
        input.getAttribute("data-testid"),
        input.closest("label, section, article, fieldset, [role='group'], div")?.textContent
      ].filter(Boolean).join(" ").toLowerCase();

      let total = 0;

      if (/resume|cv|curriculum vitae/.test(descriptor)) {
        total += 120;
      }

      if (/pdf|doc|docx/.test(input.accept)) {
        total += 12;
      }

      if (/cover letter/.test(descriptor)) {
        total -= 220;
      }

      return total;
    }
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

  if (shouldPreferPlaywrightFieldTarget(field) && await fillByPlaywrightFieldTarget(page, field)) {
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
        ) {
          return false;
        }

        const normalizedValue = normalize(fieldValue);
        (control as HTMLElement).scrollIntoView?.({ block: "center", inline: "center" });

        if (isCustomSelectLike(control)) {
          return hasCommittedSelectLikeValue(control, normalizedValue);
        }

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
                item.click();
                dispatch(item);
              }
            }
          }

          if (!target.checked) {
            target.click();
          }

          dispatch(target);
          return true;
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
      },
      { fieldId: field.fieldId, fieldValue: field.value }
    ).catch(() => false);

    if (filled) {
      return true;
    }
  }

  if (field.inputType === "combobox") {
    return false;
  }

  return fillByPlaywrightFieldTarget(page, field);
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
        await locator.click({ timeout: 1000 });
        await locator.fill("", { timeout: 1000 }).catch(() => undefined);
        await locator.fill(field.value, { timeout: 1500 });
        await locator.press("Tab", { timeout: 350 }).catch(() => undefined);
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
  const isAutocomplete = looksAutocompleteField(field.label, value);
  const queries = getSelectLikeQueries(field.label, value);

  for (const frame of page.frames()) {
    const targets = field.fieldId
      ? [frame.locator(`[data-gradlaunch-field-id="${field.fieldId}"]`).first()]
      : aliases.flatMap((alias) => [
          frame.getByRole("combobox", { name: alias, exact: false }).first(),
          frame.getByLabel(alias, { exact: false }).first(),
          frame.getByPlaceholder(alias, { exact: false }).first(),
          frame.getByRole("button", { name: alias, exact: false }).first()
        ]);

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

        if (await verifySelectLikeValue(target!, value, { allowPartial: !isAutocomplete })) {
          return true;
        }

        if (!isAutocomplete) {
          await target!.scrollIntoViewIfNeeded().catch(() => undefined);
          await target!.click({ force: true, timeout: 700 }).catch(() => undefined);
          await page.waitForTimeout(120).catch(() => undefined);

          const clickedSimpleOption = await clickVisibleSelectOptionWithRetries(frame, value, field.label, value, 4);

          if (clickedSimpleOption) {
            await target!.press("Tab", { timeout: 350 }).catch(() => undefined);
            await page.waitForTimeout(100).catch(() => undefined);

            if (await verifySelectLikeValue(target!, value, { allowPartial: false }) || isShortChoiceValue(value)) {
              return true;
            }
          }
        }

        for (const query of queries) {
          await target!.scrollIntoViewIfNeeded().catch(() => undefined);
          await target!.click({ force: true, timeout: 700 }).catch(() => undefined);
          await page.waitForTimeout(60).catch(() => undefined);

          await target!.fill(query, { timeout: 600 }).catch(async () => {
            await target!.press(process.platform === "darwin" ? "Meta+A" : "Control+A", { timeout: 250 }).catch(() => undefined);
            await target!.type(query, { delay: 10, timeout: 800 }).catch(() => undefined);
          });
          await page.waitForTimeout(130).catch(() => undefined);

          const optionClicked = await clickVisibleSelectOptionWithRetries(frame, value, field.label, query, isAutocomplete ? 6 : 2);

          if (optionClicked) {
            await target!.press("Tab", { timeout: 350 }).catch(() => undefined);
            await page.waitForTimeout(80).catch(() => undefined);

            if (await verifySelectLikeValue(target!, value, { allowPartial: false })) {
              return true;
            }

            await target!.click({ force: true, timeout: 700 }).catch(() => undefined);
            await page.waitForTimeout(60).catch(() => undefined);
          }

          if (isAutocomplete) {
            await target!.press("Enter", { timeout: 400 }).catch(() => undefined);
            await target!.press("Tab", { timeout: 350 }).catch(() => undefined);
            await page.waitForTimeout(80).catch(() => undefined);

            if (await verifySelectLikeValue(target!, value, { allowPartial: false })) {
              return true;
            }

            await target!.click({ force: true, timeout: 700 }).catch(() => undefined);
            await target!.press("ArrowDown", { timeout: 350 }).catch(() => undefined);
            await page.waitForTimeout(60).catch(() => undefined);
            await target!.press("Enter", { timeout: 400 }).catch(() => undefined);
            await target!.press("Tab", { timeout: 350 }).catch(() => undefined);
            await page.waitForTimeout(80).catch(() => undefined);

            if (await verifySelectLikeValue(target!, value, { allowPartial: false })) {
              return true;
            }
          }
        }

        await target!.press("Enter", { timeout: 400 }).catch(() => undefined);
        const verified = await verifySelectLikeValue(target!, value, { allowPartial: !isAutocomplete });

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

async function fillCountrySelectField(page: Page, field: BrowserFillField) {
  const desiredCountry = countryLabelFromValue(field.value);

  if (!desiredCountry) {
    return false;
  }

  for (const frame of page.frames()) {
    const targets = field.fieldId
      ? [frame.locator(`[data-gradlaunch-field-id="${field.fieldId}"]`).first()]
      : [
          frame.getByRole("combobox", { name: field.label, exact: false }).first(),
          frame.getByLabel(field.label, { exact: false }).first(),
          frame.getByRole("button", { name: field.label, exact: false }).first()
        ];

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

async function verifySelectLikeValue(target: Locator, expected: string, options?: { allowPartial?: boolean }) {
  return target.evaluate((element, { wantedValue, allowPartial }) => {
    const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const wanted = normalize(wantedValue);
    const raw = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
      ? element.value
      : element.textContent ?? "";
    const actual = normalize(raw);

    if (actual && (actual === wanted || actual.includes(wanted) || (allowPartial && wanted.includes(actual)))) {
      return true;
    }

    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const describedBy = element.getAttribute("aria-describedby") ?? "";
    const labelledBy = element.getAttribute("aria-labelledby") ?? "";
    const container = element.closest("[role='combobox'], [aria-haspopup='listbox'], [data-radix-select-trigger], [data-headlessui-state], [class*='select'], [class*='combobox']")
      ?? element.parentElement;
    const metadata = normalize([
      element.getAttribute("data-value"),
      element.getAttribute("aria-valuetext"),
      element.getAttribute("aria-activedescendant"),
      element.getAttribute("title"),
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

    return Boolean(metadata)
      && !/select|choose|search|type to search|results found|no results found/.test(metadata)
      && (metadata.includes(wanted) || (allowPartial && wanted.includes(metadata)));
  }, { wantedValue: expected, allowPartial: options?.allowPartial !== false }).catch(() => false);
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
            bestControl.click();
          }
          return true;
        }

        if (!bestControl.checked) {
          bestControl.click();
        }

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

      if (target !== control) {
        dispatch(target);
      }

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

        if (entry.clickTarget !== entry.control) {
          dispatch(entry.clickTarget);
        }
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
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
    const isLocationLike = /\b(location|city)\b/.test(normalize(`${fieldLabel} ${expected}`));
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

      return false;
    }

    function normalize(value: string) {
      return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
      const firstPart = expected.split(/\s+(?:karnataka|india|australia|new south wales|united states|united kingdom)\b/)[0]?.trim();
      const firstCommaPart = expected.split(" india")[0]?.split(" australia")[0]?.trim();
      const aliases = new Set([firstPart, firstCommaPart, expected.split(" ")[0]].filter(Boolean));

      if (expected.includes("bengaluru") || expected.includes("bangalore") || expected.includes("banglore")) {
        aliases.add("bengaluru");
        aliases.add("bangalore");
        aliases.add("banglore");
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
  return /\b(location|city|country|school|university|college)\b/.test(descriptor);
}

function getSelectLikeQueries(label: string, value: string) {
  const descriptor = normalizeInline(`${label} ${value}`);

  if (!/\b(location|city)\b/.test(descriptor)) {
    return [value];
  }

  const city = value.split(",")[0]?.trim();
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
