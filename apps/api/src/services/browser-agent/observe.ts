import type { BrowserContext, Page } from "playwright-core";
import type {
  AtsAdapterHint,
  BrowserAgentObservation,
  NavigationCandidate,
  BrowserFieldGroup,
  BrowserPageState,
  TransitionWaitResult,
  ObservedControl,
  ProtectedCheckpointDetection,
  VisibleField
} from "./types";
import { dedupeLabels, isTransientStatusMessage, normalizeKey, safeHostname } from "./util";

export async function getActivePage(context: BrowserContext, fallbackPage: Page) {
  await fallbackPage.waitForTimeout(400).catch(() => undefined);
  const pages = context.pages().filter((page) => !page.isClosed());
  const meaningfulPages = pages.filter((page) => !isBlankBrowserPage(page.url()));
  const fallbackIsUsable = pages.includes(fallbackPage) && !isBlankBrowserPage(fallbackPage.url());
  const fallbackOrigin = safePageOrigin(fallbackPage.url());
  const originMatch = meaningfulPages.find((page) => safePageOrigin(page.url()) === fallbackOrigin);
  const page = fallbackIsUsable
    ? fallbackPage
    : originMatch
      ?? meaningfulPages.at(-1)
      ?? (pages.includes(fallbackPage) ? fallbackPage : undefined)
      ?? pages.at(-1)
      ?? fallbackPage;
  page.setDefaultTimeout(Number(process.env.BROWSER_STEP_TIMEOUT_MS ?? 2500));
  await page.bringToFront().catch(() => undefined);
  return page;
}

function isBlankBrowserPage(url: string) {
  return !url || url === "about:blank" || url.startsWith("chrome://newtab");
}

function safePageOrigin(url: string) {
  try {
    return new URL(url).origin;
  } catch (_error) {
    return "";
  }
}

export async function clickSoftGate(page: Page) {
  const labels = ["Accept", "Accept all", "Continue", "I agree"];

  for (const label of labels) {
    const clicked = await page.evaluate((label) => {
      const wanted = normalize(label);
      const controls = Array.from(document.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit'], a")) as HTMLElement[];

      for (const control of controls) {
        if (control.closest("#gradlaunch-live-bot") || !isVisible(control) || isDisabled(control)) {
          continue;
        }

        const text = normalize([
          control.textContent,
          control.getAttribute("aria-label"),
          control instanceof HTMLInputElement ? control.value : ""
        ].filter(Boolean).join(" "));

        if (text.includes(wanted)) {
          control.click();
          return true;
        }
      }

      return false;

      function isVisible(element: HTMLElement) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      }

      function isDisabled(element: HTMLElement) {
        return (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) && element.disabled
          || element.getAttribute("aria-disabled") === "true";
      }

      function normalize(value: string) {
        return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      }
    }, label).catch(() => false);

    if (clicked) {
      return;
    }
  }
}

export async function discoverVisibleFields(page: Page): Promise<VisibleField[]> {
  const fields: VisibleField[] = [];

  for (const frame of page.frames()) {
    const frameFields = await frame.evaluate(() => {
      const searchRoots = getSearchRoots();
      const controls = searchRoots.flatMap((root) => Array.from(root.querySelectorAll("input, textarea, select"))) as Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>;
      const items: VisibleField[] = [];
      const seenRadioGroups = new Set<string>();

      for (const [index, control] of controls.entries()) {
        if (control instanceof HTMLInputElement && ["hidden", "submit", "button", "image", "reset"].includes(control.type)) {
          continue;
        }

        const isChoiceControl = control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type);
        const rect = control.getBoundingClientRect();

        if ("disabled" in control && control.disabled) {
          continue;
        }

        if ((rect.width <= 0 || rect.height <= 0) && !(isChoiceControl && hasVisibleChoiceTarget(control))) {
          continue;
        }

        const label = findFieldLabel(control);

        if (!label.trim() || isNoiseField(control, label)) {
          continue;
        }

        if (control instanceof HTMLInputElement && control.type === "radio") {
          const radioGroup = findRadioGroup(control);
          const groupLabel = findChoiceGroupLabel(control, radioGroup) || label;
          const groupKey = radioGroupKey(control, groupLabel, index);

          if (seenRadioGroups.has(groupKey)) {
            continue;
          }

          seenRadioGroups.add(groupKey);

          const idControl = radioGroup.find((item) => isVisibleControl(item)) ?? control;
          const id = idControl.getAttribute("data-gradlaunch-field-id") || `gl-field-${index}-${normalize(groupLabel)}`;
          idControl.setAttribute("data-gradlaunch-field-id", id);

          items.push({
            id,
            label: clean(groupLabel),
            required: radioGroup.some((item) => isRequired(item, groupLabel || findFieldLabel(item))),
            tagName: control.tagName.toLowerCase(),
            inputType: "radio",
            options: dedupeText(radioGroup.map((item) => clean(findFieldLabel(item) || item.value)).filter(Boolean)).slice(0, 15),
            context: clean(findChoiceGroupContext(control, groupLabel))
          });
          continue;
        }

        const id = control.getAttribute("data-gradlaunch-field-id") || `gl-field-${index}-${normalize(label)}`;
        control.setAttribute("data-gradlaunch-field-id", id);

        items.push({
          id,
          label: clean(label),
          required: isRequired(control, label),
          tagName: control.tagName.toLowerCase(),
          inputType: control instanceof HTMLSelectElement
            ? "select"
            : control instanceof HTMLInputElement
              ? getInputType(control)
              : "textarea",
          options: control instanceof HTMLSelectElement
            ? Array.from(control.options).map((option) => clean(option.textContent ?? option.value)).filter(Boolean).slice(0, 15)
            : control instanceof HTMLInputElement && control.type === "checkbox"
              ? [clean(label)].filter(Boolean)
            : [],
          context: clean([
            control.closest("fieldset")?.querySelector("legend")?.textContent,
            control.closest("[role='group']")?.textContent,
            control.closest("section, article, form, .form-group, .field")?.querySelector("h1, h2, h3, h4, legend")?.textContent
          ].filter(Boolean).join(" "))
        });
      }

      return items;

      function normalize(value: string) {
        return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      }

      function clean(value: string | null | undefined) {
        return (value ?? "").replace(/\s+/g, " ").replace(/\*/g, "").trim().slice(0, 160);
      }

      function getInputType(control: HTMLInputElement) {
        if (isCustomSelectLike(control)) {
          return "combobox";
        }

        return control.type || "text";
      }

      function findRadioGroup(control: HTMLInputElement) {
        const root = control.getRootNode();

        if (control.name) {
          const selector = `input[type='radio'][name="${CSS.escape(control.name)}"]`;
          const namedControls = root instanceof Document || root instanceof ShadowRoot || root instanceof Element
            ? Array.from(root.querySelectorAll(selector)) as HTMLInputElement[]
            : [];

          if (namedControls.length > 1) {
            return namedControls.filter((item) => isVisibleControl(item) && !item.disabled);
          }
        }

        const ancestorGroup = findChoiceControlsInBestAncestor(control, "radio");

        if (ancestorGroup.length > 1) {
          return ancestorGroup;
        }

        const container = control.closest("fieldset, [role='radiogroup'], [role='group'], section, article, [class*='question'], [class*='field'], [class*='input']")
          ?? control.parentElement;
        const grouped = container
          ? Array.from(container.querySelectorAll("input[type='radio']")) as HTMLInputElement[]
          : [control];

        return grouped.filter((item) => isVisibleControl(item) && !item.disabled);
      }

      function findChoiceControlsInBestAncestor(control: HTMLInputElement, type: "radio" | "checkbox") {
        let best: HTMLInputElement[] = [];
        let bestScore = Number.NEGATIVE_INFINITY;
        let ancestor: Element | null = control.parentElement;

        for (let depth = 0; depth < 10 && ancestor; depth += 1) {
          const controls = Array.from(ancestor.querySelectorAll(`input[type='${type}']`)) as HTMLInputElement[];
          const usable = controls.filter((item) => isVisibleControl(item) && !item.disabled);

          if (usable.length < 2 || usable.length > 12) {
            ancestor = ancestor.parentElement;
            continue;
          }

          const text = normalize(ancestor.textContent ?? "");
          let score = 0;

          if (/\b(yes|no|no thanks|continue to apply|decline)\b/.test(text)) {
            score += 45;
          }

          if (/\b(talent network|career opportunities|upcoming events|keep you up to date|preferred name|past working experience|work experience)\b/.test(text)) {
            score += 90;
          }

          if (/\b(this field is required|required)\b/.test(text)) {
            score += 20;
          }

          score += Math.min(usable.length * 8, 30);
          score -= Math.min(text.length / 260, 55);
          score -= depth * 2;

          if (score > bestScore) {
            bestScore = score;
            best = usable;
          }

          ancestor = ancestor.parentElement;
        }

        return bestScore >= 20 ? best : [];
      }

      function radioGroupKey(control: HTMLInputElement, groupLabel: string, index: number) {
        return control.name
          ? `name:${control.name}`
          : `label:${normalize(groupLabel) || index}`;
      }

      function findChoiceGroupLabel(control: HTMLInputElement, group: HTMLInputElement[]) {
        const fieldsetLegend = control.closest("fieldset")?.querySelector("legend")?.textContent;

        if (fieldsetLegend?.trim()) {
          return clean(fieldsetLegend);
        }

        const radiogroup = control.closest("[role='radiogroup'], [role='group']");
        const labelledBy = radiogroup?.getAttribute("aria-labelledby");

        if (labelledBy) {
          const labelledText = labelledBy
            .split(/\s+/)
            .map((id) => getElementById(id)?.textContent ?? "")
            .join(" ");

          if (labelledText.trim()) {
            return clean(labelledText);
          }
        }

        const groupOptions = new Set(group.map((item) => normalize(findFieldLabel(item) || item.value)).filter(Boolean));
        let ancestor: Element | null = control.parentElement;

        for (let depth = 0; depth < 8 && ancestor; depth += 1) {
          const heading = Array.from(ancestor.querySelectorAll("legend, h1, h2, h3, h4, [aria-level], p, label"))
            .map((element) => clean(element.textContent))
            .find((text) => {
              const normalized = normalize(text);
              return normalized
                && !groupOptions.has(normalized)
                && normalized.length > 4
                && !/\b(this field is required|there are some errors|show details)\b/.test(normalized);
            });

          if (heading) {
            return heading;
          }

          ancestor = ancestor.parentElement;
        }

        return "";
      }

      function findChoiceGroupContext(control: HTMLInputElement, groupLabel: string) {
        const container = control.closest("fieldset, [role='radiogroup'], [role='group'], section, article, [class*='question'], [class*='field'], [class*='input']");

        return [
          groupLabel,
          container?.textContent
        ].filter(Boolean).join(" ");
      }

      function dedupeText(values: string[]) {
        const seen = new Set<string>();
        const unique: string[] = [];

        for (const value of values) {
          const key = normalize(value);

          if (!key || seen.has(key)) {
            continue;
          }

          seen.add(key);
          unique.push(value);
        }

        return unique;
      }

      function isRequired(control: Element, label: string) {
        const choiceContainer = control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type)
          ? control.closest("label, fieldset, [role='group'], [role='radiogroup'], section, article, [class*='question'], [class*='field'], [class*='input']")
          : undefined;

        return (control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).required
          || control.getAttribute("aria-required") === "true"
          || /\*/.test(label)
          || Boolean(choiceContainer?.textContent && /\*/.test(choiceContainer.textContent))
          || Boolean(control.closest(".required, [class*='required'], [data-required='true']"));
      }

      function isVisibleControl(control: Element) {
        const rect = control.getBoundingClientRect();
        const style = window.getComputedStyle(control);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
          || control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type) && hasVisibleChoiceTarget(control);
      }

      function hasVisibleChoiceTarget(control: HTMLInputElement) {
        const target = getChoiceClickTarget(control);

        if (!target) {
          return false;
        }

        const rect = target.getBoundingClientRect();
        const style = window.getComputedStyle(target);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      }

      function getChoiceClickTarget(control: HTMLInputElement) {
        if (control.id) {
          const label = queryFirst(`label[for="${CSS.escape(control.id)}"]`, control);

          if (label instanceof HTMLElement) {
            return label;
          }
        }

        const closestLabel = control.closest("label");

        if (closestLabel instanceof HTMLElement) {
          return closestLabel;
        }

        const row = control.closest("button, [role='radio'], [role='checkbox'], [role='button'], [aria-checked], [tabindex], [class*='checkbox'], [class*='radio']");

        return row instanceof HTMLElement ? row : undefined;
      }

      function isNoiseField(control: Element, label: string) {
        const normalized = normalize(label);

        if (!normalized) {
          return true;
        }

        if (normalized.length > 140) {
          return true;
        }

        if (/results found|no results found/.test(normalized)) {
          return true;
        }

        if (control.closest("[role='option'], [role='listbox'], [role='menu'], [role='dialog']") && !/^location|city|country|phone|email|name/.test(normalized)) {
          return true;
        }

        return false;
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

      function findFieldLabel(control: Element) {
        if (control.id) {
          const direct = queryFirst(`label[for="${CSS.escape(control.id)}"]`, control);

          if (direct?.textContent?.trim()) {
            return direct.textContent.trim();
          }
        }

        const ariaLabelledBy = control.getAttribute("aria-labelledby");

        if (ariaLabelledBy) {
          const labelled = ariaLabelledBy
            .split(/\s+/)
            .map((id) => getElementById(id)?.textContent ?? "")
            .join(" ")
            .trim();

          if (labelled) {
            return labelled;
          }
        }

        return control.closest("label")?.textContent?.trim()
          || control.closest("fieldset")?.querySelector("legend")?.textContent?.trim()
          || control.getAttribute("aria-label")
          || control.getAttribute("placeholder")
          || control.getAttribute("name")
          || control.id
          || "";
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
    }).catch(() => [] as VisibleField[]);

    fields.push(...frameFields);
  }

  const seen = new Set<string>();
  return fields.filter((field) => {
    const key = `${normalizeKey(field.label)}:${field.inputType}:${field.id}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

export async function observeBrowserPage(page: Page, visibleFields: VisibleField[]): Promise<BrowserAgentObservation> {
  const validationMessages = await getVisibleValidationMessages(page);
  const domObservation = await page.evaluate(() => {
    const searchRoots = getSearchRoots();
    const candidates = searchRoots.flatMap((root) => Array.from(root.querySelectorAll("button, a, input, textarea, select, [role='button'], [role='link']"))) as HTMLElement[];
    const controls: ObservedControl[] = [];

    for (const [index, element] of candidates.entries()) {
      if (element.closest("#gradlaunch-live-bot")) {
        continue;
      }

      const rect = element.getBoundingClientRect();

      if (rect.width <= 0 || rect.height <= 0) {
        continue;
      }

      const id = `gl-agent-control-${index}`;
      element.setAttribute("data-gradlaunch-control-id", id);
      const input = element instanceof HTMLInputElement ? element : undefined;
      const label = findControlLabel(element);
      const text = [
        element.textContent,
        input?.value,
        element.getAttribute("aria-label"),
        element.getAttribute("placeholder"),
        label
      ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

      controls.push({
        id,
        text,
        tagName: element.tagName.toLowerCase(),
        role: element.getAttribute("role") ?? "",
        inputType: input?.type ?? "",
        label,
        disabled: Boolean((element as HTMLButtonElement | HTMLInputElement).disabled) || element.getAttribute("aria-disabled") === "true"
      });
    }

    const pageText = [
      document.body?.innerText ?? "",
      controls.map((control) => control.text).join(" ")
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 3500);

    return {
      title: document.title,
      pageText,
      controls
    };

    function findControlLabel(element: Element) {
      if (element.id) {
        const root = element.getRootNode();
        const direct = ((root instanceof Document || root instanceof ShadowRoot || root instanceof Element)
          ? root.querySelector(`label[for="${CSS.escape(element.id)}"]`)
          : null)
          ?? searchRoots.map((searchRoot) => searchRoot.querySelector(`label[for="${CSS.escape(element.id)}"]`)).find(Boolean)
          ?? null;

        if (direct?.textContent?.trim()) {
          return direct.textContent.trim();
        }
      }

      return element.closest("label")?.textContent?.trim()
        ?? element.getAttribute("aria-label")
        ?? element.getAttribute("placeholder")
        ?? element.getAttribute("name")
        ?? "";
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
  }).catch(() => ({ title: "", pageText: "", controls: [] as ObservedControl[] }));

  const adapter = resolveAtsAdapter(page.url());
  const groupedFields = groupVisibleFields(visibleFields);
  const pageState = classifyBrowserPageState({
    url: page.url(),
    title: domObservation.title,
    pageText: domObservation.pageText,
    visibleFields,
    controls: domObservation.controls.filter((control) => !control.disabled),
    validationMessages,
    groupedFields,
    adapter
  });

  return {
    url: page.url(),
    title: domObservation.title,
    pageText: domObservation.pageText,
    visibleFields,
    controls: domObservation.controls.filter((control) => !control.disabled),
    pageState,
    validationMessages,
    groupedFields,
    adapter
  };
}

export async function getPageFingerprint(page: Page) {
  return page.evaluate(() => {
    const controls = getSearchRoots().flatMap((root) => Array.from(root.querySelectorAll("input, textarea, select"))) as Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>;
    const visibleControlKeys = controls
      .filter((control) => {
        const rect = control.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !(control instanceof HTMLInputElement && control.type === "hidden");
      })
      .slice(0, 20)
      .map((control) => [
        control.tagName,
        control.getAttribute("type"),
        control.getAttribute("name"),
        control.id,
        control.getAttribute("placeholder"),
        control.getAttribute("aria-label")
      ].filter(Boolean).join(":"));

    return `${window.location.href}|${visibleControlKeys.join("|")}`;

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
  }).catch(() => page.url());
}

export async function getProgressSnapshot(page: Page) {
  return page.evaluate(() => {
    const selectors = [
      "[aria-current='step']",
      "[data-testid*='step']",
      "[class*='step'][class*='active']",
      "[class*='progress'] [class*='active']",
      "[role='progressbar']",
      "ol li[aria-current='step']",
      "nav li[aria-current='page']"
    ];

    for (const selector of selectors) {
      const elements = Array.from(document.querySelectorAll(selector));

      for (const element of elements) {
        const htmlElement = element as HTMLElement;
        const rect = htmlElement.getBoundingClientRect();
        const text = element.textContent?.replace(/\s+/g, " ").trim();

        if (text && rect.width > 0 && rect.height > 0) {
          return text.slice(0, 180);
        }
      }
    }

    return undefined;
  }).catch(() => undefined);
}

export async function getStageSignature(page: Page, observation?: BrowserAgentObservation) {
  const nextObservation = observation ?? await observeBrowserPage(page, await discoverVisibleFields(page));
  const fingerprint = await getPageFingerprint(page);
  const progressText = await getProgressSnapshot(page);

  return {
    url: page.url(),
    title: nextObservation.title,
    fingerprint,
    visibleFieldLabels: nextObservation.visibleFields.map((field) => field.label).slice(0, 25),
    requiredFieldLabels: nextObservation.visibleFields.filter((field) => field.required).map((field) => field.label).slice(0, 20),
    controlLabels: nextObservation.controls.map((control) => control.text || control.label).filter(Boolean).slice(0, 20),
    progressText,
    savedAt: new Date().toISOString()
  };
}

export async function matchesSavedStageSignature(page: Page, signature: { fingerprint: string; url: string; progressText?: string }) {
  const [fingerprint, progressText] = await Promise.all([
    getPageFingerprint(page),
    getProgressSnapshot(page)
  ]);

  return fingerprint === signature.fingerprint
    || (page.url() === signature.url && progressText === signature.progressText);
}

export async function detectProtectedCheckpoint(page: Page): Promise<ProtectedCheckpointDetection> {
  return page.evaluate(() => {
    function normalize(value: string) {
      return value.toLowerCase().replace(/\s+/g, " ").trim();
    }

    function isVisible(element: Element | null) {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0 && rect.width > 0 && rect.height > 0;
    }

    const bodyText = normalize(document.body?.innerText ?? "");
    const currentHost = window.location.hostname.toLowerCase();
    const visiblePasswordField = Array.from(document.querySelectorAll("input[type='password']")).some((field) => isVisible(field));
    const visibleApplicationField = Array.from(document.querySelectorAll("input, textarea, select")).some((field) => {
      if (!isVisible(field)) {
        return false;
      }

      const descriptor = normalize([
        field.getAttribute("name") ?? "",
        field.getAttribute("id") ?? "",
        field.getAttribute("aria-label") ?? "",
        field.getAttribute("placeholder") ?? "",
        field.closest("label")?.textContent ?? ""
      ].join(" "));

      return /\b(first name|last name|full name|resume|cv|phone|mobile|location|city|school|degree)\b/.test(descriptor);
    });
    const visibleLoginProviderControl = Array.from(document.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']"))
      .some((control) => {
        if (!isVisible(control)) {
          return false;
        }

        const text = normalize([
          control.textContent ?? "",
          control.getAttribute("aria-label") ?? "",
          control.getAttribute("title") ?? "",
          control instanceof HTMLInputElement ? control.value : ""
        ].join(" "));

        return /\b(sign in|signin|log in|login|continue)\b/.test(text)
          && /\b(google|gmail|email|e mail|mail|sso|account)\b/.test(text);
      });
    const visibleOtpField = Array.from(document.querySelectorAll("input, textarea")).some((field) => {
      if (!isVisible(field)) {
        return false;
      }

      const descriptor = normalize([
        field.getAttribute("autocomplete") ?? "",
        field.getAttribute("name") ?? "",
        field.getAttribute("id") ?? "",
        field.getAttribute("aria-label") ?? "",
        field.getAttribute("placeholder") ?? "",
        field.getAttribute("inputmode") ?? ""
      ].join(" "));

      return /one-time-code|otp|verification code|security code|authenticator|two factor|2fa|mfa/.test(descriptor);
    });
    const iframeCaptcha = Array.from(document.querySelectorAll("iframe")).some((frame) => {
      if (!isVisible(frame)) {
        return false;
      }

      const descriptor = normalize(`${frame.getAttribute("src") ?? ""} ${frame.getAttribute("title") ?? ""} ${frame.getAttribute("name") ?? ""} ${frame.getAttribute("aria-label") ?? ""}`);
      return /recaptcha|hcaptcha|turnstile|cloudflare|captcha|robot|challenge/.test(descriptor);
    });

    if ((/captcha|verify you are human|human verification|security check|i am not a robot|press and hold/.test(bodyText) || iframeCaptcha)) {
      return {
        blocked: true,
        kind: "captcha" as const,
        reason: "Human intervention needed: complete the captcha or security check in the open browser."
      };
    }

    if (/(user authentication is denied|authentication is denied|log on did not complete|logon did not complete|not permitted using the selected method|chosen identity is not permitted|csiac\d+)/.test(bodyText)) {
      return {
        blocked: true,
        kind: "verification" as const,
        reason: "The job portal rejected this login method or account. Try a permitted account/login option in the open browser, then continue only after the application form is visible."
      };
    }

    if (/(security key|passkey|touch id|use a saved passkey|use a phone or tablet|usb security key|registered security device|registered device|follow the on-screen prompt|webauthn|authenticator device|issue verifying your login|use another method)/.test(bodyText)) {
      return {
        blocked: true,
        kind: "verification" as const,
        reason: "IBM security key/passkey verification is blocking login. If Touch ID/security key fails, click 'Use another method' in IBM, complete login manually, then click the GradLaunch continue button."
      };
    }

    if (/(^|\.)accounts\.google\.com$/.test(currentHost) && /\b(sign in|email or phone|choose an account|password|continue|verify|2-step verification)\b/.test(bodyText)) {
      return {
        blocked: true,
        kind: "login" as const,
        reason: "Google sign-in is open. Complete login manually in this controlled Chrome window, then click the GradLaunch continue button."
      };
    }

    if (visiblePasswordField && /sign in|log in|login|password|account/.test(bodyText)) {
      return {
        blocked: true,
        kind: "login" as const,
        reason: "Human intervention needed: sign in to the job portal in the open browser."
      };
    }

    if (visibleLoginProviderControl && !visibleApplicationField && /\b(sign in|signin|log in|login|continue with google|continue with email|account)\b/.test(bodyText)) {
      return {
        blocked: true,
        kind: "login" as const,
        reason: "Login panel detected. GradLaunch is paused; choose Google/email manually in this controlled Chrome window, then click the GradLaunch continue button."
      };
    }

    if (visibleOtpField || /otp|verification code|one time code|two factor|2fa|mfa|enter the code we sent/.test(bodyText)) {
      return {
        blocked: true,
        kind: "otp" as const,
        reason: "Human intervention needed: complete the OTP or verification code step in the open browser."
      };
    }

    if (/manual verification|manual attention|security challenge|additional verification/.test(bodyText)) {
      return {
        blocked: true,
        kind: "verification" as const,
        reason: "Human intervention needed: complete the verification step in the open browser."
      };
    }

    return { blocked: false };
  }).catch(() => ({ blocked: false }));
}

export async function getVisibleRequiredEmptyLabels(page: Page) {
  const labels: string[] = [];

  for (const frame of page.frames()) {
    const frameLabels = await frame.evaluate(() => {
      const searchRoots = getSearchRoots();
      const controls = searchRoots.flatMap((root) => Array.from(root.querySelectorAll("input, textarea, select"))) as Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>;
      const groups = new Map<string, { label: string; satisfied: boolean; required: boolean }>();

      for (const control of controls) {
        if (control instanceof HTMLInputElement && ["hidden", "file", "submit", "button"].includes(control.type)) {
          continue;
        }

        const isChoiceControl = control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type);
        const rect = control.getBoundingClientRect();

        if ((rect.width <= 0 || rect.height <= 0) && !(isChoiceControl && hasVisibleChoiceTarget(control))) {
          continue;
        }

        const label = findFieldLabel(control);
        const cleanLabel = clean(label);

        if (!cleanLabel || isNoiseField(control, cleanLabel)) {
          continue;
        }

        const choiceGroupLabel = control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type)
          ? findChoiceGroupLabel(control) || cleanLabel
          : cleanLabel;
        const hasSharedChoiceLabel = control instanceof HTMLInputElement
          && ["checkbox", "radio"].includes(control.type)
          && normalize(choiceGroupLabel) !== normalize(cleanLabel);
        const key = control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type)
          ? hasSharedChoiceLabel
            ? `choice:${control.type}:${normalize(choiceGroupLabel)}`
            : control.name
              ? `choice:${control.type}:${control.name}`
              : normalize(choiceGroupLabel)
          : normalize(choiceGroupLabel);
        const existing = groups.get(key) ?? {
          label: choiceGroupLabel,
          satisfied: false,
          required: false
        };

        existing.required = existing.required || isRequired(control);
        existing.satisfied = existing.satisfied || isSatisfied(control, searchRoots);
        groups.set(key, existing);
      }

      for (const inferred of inferRequiredLabelControls(searchRoots)) {
        const key = `inferred:${normalize(inferred.label)}`;
        const existing = groups.get(key) ?? {
          label: inferred.label,
          satisfied: false,
          required: true
        };

        existing.required = true;
        existing.satisfied = existing.satisfied || inferred.satisfied;
        groups.set(key, existing);
      }

      for (const errorLabel of findRequiredErrorLabels(searchRoots)) {
        const key = `validation:${normalize(errorLabel)}`;
        const existing = groups.get(key) ?? {
          label: errorLabel,
          satisfied: false,
          required: true
        };

        existing.required = true;
        existing.satisfied = existing.satisfied || false;
        groups.set(key, existing);
      }

      return Array.from(groups.values())
        .filter((group) => group.required && !group.satisfied)
        .map((group) => group.label);

      function isRequired(control: Element) {
        const label = findFieldLabel(control);
        const choiceContainer = control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type)
          ? control.closest("label, fieldset, [role='group'], [role='radiogroup'], section, article, [class*='question'], [class*='field'], [class*='input']")
          : undefined;

        return (control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).required
          || control.getAttribute("aria-required") === "true"
          || control.getAttribute("aria-invalid") === "true"
          || /\*/.test(label)
          || Boolean(choiceContainer?.textContent && /\*/.test(choiceContainer.textContent))
          || Boolean(control.closest(".required, [class*='required'], [data-required='true']"))
          || hasNearbyRequiredError(control)
          || isLikelyRequiredApplicationField(control, label);
      }

      function isSatisfied(
        control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
        roots: Array<Document | ShadowRoot>
      ) {
        if (control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type)) {
          const group = getChoiceGroupControls(control, roots);
          return group.some((item) => item.checked || item.getAttribute("aria-checked") === "true");
        }

        if (control instanceof HTMLSelectElement) {
          const selected = control.selectedOptions[0];
          const selectedText = normalize(`${selected?.textContent ?? ""} ${selected?.value ?? ""} ${control.value}`);

          if (isEmptySelectText(selectedText)) {
            return false;
          }

          return true;
        }

        if (!(control instanceof HTMLElement)) {
          return false;
        }

        if (control instanceof HTMLInputElement && isCustomSelectLike(control)) {
          const actual = normalize(control.value);

          if (actual && !isEmptySelectText(actual)) {
            return true;
          }

          const container = control.closest("[role='combobox'], [aria-haspopup='listbox'], [data-radix-select-trigger], [data-headlessui-state], [class*='select'], [class*='combobox']")
            ?? control.parentElement;
          const selectedText = normalize([
            control.getAttribute("data-value"),
            control.getAttribute("aria-valuetext"),
            container?.getAttribute("data-value"),
            container?.getAttribute("aria-valuetext"),
            container?.textContent
          ].filter(Boolean).join(" "));

          if (selectedText && !isEmptySelectText(selectedText)) {
            return true;
          }

          return false;
        }

        if (control.value.trim()) {
          return true;
        }

        return false;
      }

      function isLikelyRequiredApplicationField(control: Element, label: string) {
        const descriptor = normalize([
          label,
          control.getAttribute("aria-label"),
          control.getAttribute("placeholder"),
          control.getAttribute("name"),
          control.getAttribute("id"),
          control.closest("label, fieldset, [role='group'], [class*='field'], [class*='input'], section, article, div")?.textContent
        ].filter(Boolean).join(" "));

        if (!descriptor || /\b(address line 2|address 2|middle name|preferred middle|apt|suite|optional)\b/.test(descriptor)) {
          return false;
        }

        return /\b(legal first name|first name|given name|legal last name|last name|surname|family name|address line 1|street address|country|state|province|region|city|zip|postal|postcode|pin code|pincode|home email|email|phone|mobile|contact number|degree name|type of degree|degree type|education level|university|college|institution|start date|end date|graduation date|work experience|past working experience|authorized|authorization|sponsorship|visa)\b/.test(descriptor);
      }

      function isEmptySelectText(value: string) {
        return !value
          || /^(select|select an option|choose|choose an option|please select|none selected)$/.test(value)
          || /\b(options available|total results|use the up and down keys|press enter to select|press escape to exit|not selected|results found|no results found)\b/.test(value);
      }

      function hasNearbyRequiredError(control: Element) {
        const text = normalize(control.closest("label, fieldset, [role='group'], [class*='field'], [class*='input'], section, article, div")?.textContent ?? "");
        return /\b(this field is required|required field|required|please select|please enter|cannot be blank|select an option)\b/.test(text)
          && (control.getAttribute("aria-invalid") === "true" || /\b(this field is required|cannot be blank|required field)\b/.test(text));
      }

      function findRequiredErrorLabels(roots: Array<Document | ShadowRoot>) {
        const labels: string[] = [];
        const errorElements = roots.flatMap((root) => Array.from(root.querySelectorAll("[role='alert'], .error, .field-error, .validation-error, [aria-live='assertive'], [class*='error'], [class*='invalid']"))) as HTMLElement[];

        for (const element of errorElements) {
          const rect = element.getBoundingClientRect();
          const text = normalize(element.innerText || element.textContent || "");

          if (rect.width <= 0 || rect.height <= 0 || !/\b(this field is required|required|cannot be blank|please select|please enter)\b/.test(text)) {
            continue;
          }

          if (isNearbyChoiceGroupSatisfied(element, roots)) {
            continue;
          }

          const control = findNearestControl(element);
          const label = control ? findFieldLabel(control) : inferLabelFromErrorElement(element);

          if (label) {
            labels.push(label);
          }
        }

        for (const control of roots.flatMap((root) => Array.from(root.querySelectorAll("[aria-invalid='true']")))) {
          if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement)) {
            continue;
          }

          if (!isSatisfied(control, roots)) {
            const label = findFieldLabel(control);

            if (label) {
              labels.push(label);
            }
          }
        }

        return labels;
      }

      function inferRequiredLabelControls(roots: Array<Document | ShadowRoot>) {
        const inferred: Array<{ label: string; satisfied: boolean }> = [];
        const labelElements = roots.flatMap((root) => Array.from(root.querySelectorAll("label, legend, [class*='label'], [class*='Label'], [aria-required='true']"))) as HTMLElement[];

        for (const element of labelElements) {
          if (!isVisibleElement(element)) {
            continue;
          }

          const rawText = element.innerText || element.textContent || element.getAttribute("aria-label") || "";
          const label = clean(rawText);
          const text = normalize(rawText);

          if (!label || label.length > 140 || !/(\*|\brequired\b)/i.test(rawText)) {
            continue;
          }

          if (/\b(this field is required|there are some errors|please correct|show details|select an option|required field)\b/.test(text)) {
            continue;
          }

          const control = findControlForLabelElement(element, roots);

          if (!control || isNoiseField(control, label)) {
            continue;
          }

          inferred.push({
            label,
            satisfied: isSatisfied(control, roots)
          });
        }

        return inferred;
      }

      function findControlForLabelElement(element: HTMLElement, roots: Array<Document | ShadowRoot>) {
        if (element instanceof HTMLLabelElement && element.htmlFor) {
          const direct = getElementById(element.htmlFor);

          if (isVisibleFillControl(direct)) {
            return direct;
          }
        }

        const nested = Array.from(element.querySelectorAll("input, textarea, select")).find(isVisibleFillControl);

        if (nested) {
          return nested;
        }

        let ancestor: Element | null = element;

        for (let depth = 0; depth < 5 && ancestor; depth += 1) {
          const controls = Array.from(ancestor.querySelectorAll("input, textarea, select")).filter(isVisibleFillControl);

          if (controls.length === 1) {
            return controls[0];
          }

          const afterLabel = controls.find((control) => {
            const labelRect = element.getBoundingClientRect();
            const controlRect = control.getBoundingClientRect();
            return controlRect.top >= labelRect.top - 8
              && controlRect.left >= labelRect.left - 80
              && controlRect.top - labelRect.bottom < 140;
          });

          if (afterLabel) {
            return afterLabel;
          }

          const nextControl = Array.from(ancestor.nextElementSibling?.querySelectorAll("input, textarea, select") ?? []).find(isVisibleFillControl);

          if (nextControl) {
            return nextControl;
          }

          ancestor = ancestor.parentElement;
        }

        for (const root of roots) {
          const labelledByControl = Array.from(root.querySelectorAll("input[aria-labelledby], textarea[aria-labelledby], select[aria-labelledby]")).find((control) => {
            const ids = control.getAttribute("aria-labelledby")?.split(/\s+/) ?? [];
            return element.id && ids.includes(element.id) && isVisibleFillControl(control);
          });

          if (labelledByControl && isVisibleFillControl(labelledByControl)) {
            return labelledByControl;
          }
        }

        return undefined;
      }

      function isVisibleFillControl(element: Element | null | undefined): element is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
          return false;
        }

        if (element instanceof HTMLInputElement && ["hidden", "file", "submit", "button", "image", "reset"].includes(element.type)) {
          return false;
        }

        if ("disabled" in element && element.disabled) {
          return false;
        }

        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      }

      function isVisibleElement(element: HTMLElement) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      }

      function isNearbyChoiceGroupSatisfied(element: HTMLElement, roots: Array<Document | ShadowRoot>) {
        let ancestor: Element | null = element.parentElement;

        for (let depth = 0; depth < 8 && ancestor; depth += 1) {
          const controls = Array.from(ancestor.querySelectorAll("input[type='radio'], input[type='checkbox']")) as HTMLInputElement[];
          const visibleControls = controls.filter((control) => isChoiceControlVisible(control));

          if (visibleControls.length >= 2 && visibleControls.some((control) => getChoiceGroupControls(control, roots).some((item) => item.checked || item.getAttribute("aria-checked") === "true"))) {
            return true;
          }

          ancestor = ancestor.parentElement;
        }

        return false;
      }

      function getChoiceGroupControls(control: HTMLInputElement, roots: Array<Document | ShadowRoot>) {
        const namedControls = control.name
          ? roots.flatMap((root) => Array.from(root.querySelectorAll(`input[name="${CSS.escape(control.name)}"]`))) as HTMLInputElement[]
          : [];
        const ancestorControls = findChoiceControlsInBestAncestor(control);
        const merged = [...namedControls, ...ancestorControls, control];
        const seen = new Set<HTMLInputElement>();
        const unique: HTMLInputElement[] = [];

        for (const item of merged) {
          if (seen.has(item) || item.disabled || !isChoiceControlVisible(item)) {
            continue;
          }

          seen.add(item);
          unique.push(item);
        }

        return unique.length > 0 ? unique : [control];
      }

      function findChoiceControlsInBestAncestor(control: HTMLInputElement) {
        let best: HTMLInputElement[] = [];
        let bestScore = Number.NEGATIVE_INFINITY;
        let ancestor: Element | null = control.parentElement;
        const type = control.type;

        for (let depth = 0; depth < 9 && ancestor; depth += 1) {
          const controls = Array.from(ancestor.querySelectorAll(`input[type='${type}']`)) as HTMLInputElement[];
          const visibleControls = controls.filter((item) => isChoiceControlVisible(item) && !item.disabled);

          if (visibleControls.length < 2 || visibleControls.length > 16) {
            ancestor = ancestor.parentElement;
            continue;
          }

          const text = normalize(ancestor.textContent ?? "");
          let score = 0;

          if (/\b(yes|no|no thanks|continue|decline|agree|accept)\b/.test(text)) {
            score += 35;
          }

          if (/\b(this field is required|required|please select|please correct|question|select one)\b/.test(text)) {
            score += 35;
          }

          if (ancestor.matches("fieldset, [role='radiogroup'], [role='group'], section, article, [class*='question'], [class*='field'], [class*='input']")) {
            score += 30;
          }

          score += Math.min(visibleControls.length * 6, 30);
          score -= Math.min(text.length / 250, 60);
          score -= depth * 2;

          if (score > bestScore) {
            bestScore = score;
            best = visibleControls;
          }

          ancestor = ancestor.parentElement;
        }

        return bestScore >= 20 ? best : [];
      }

      function isChoiceControlVisible(control: HTMLInputElement) {
        const rect = control.getBoundingClientRect();

        if (rect.width > 0 && rect.height > 0) {
          return true;
        }

        return hasVisibleChoiceTarget(control);
      }

      function findNearestControl(element: HTMLElement) {
        let ancestor: Element | null = element.parentElement;

        for (let depth = 0; depth < 6 && ancestor; depth += 1) {
          const controls = Array.from(ancestor.querySelectorAll("input, textarea, select")) as Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>;
          const visibleEmpty = controls.find((control) => {
            const rect = control.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && !isSatisfied(control, searchRoots);
          });

          if (visibleEmpty) {
            return visibleEmpty;
          }

          ancestor = ancestor.parentElement;
        }

        return undefined;
      }

      function inferLabelFromErrorElement(element: HTMLElement) {
        let ancestor: Element | null = element.parentElement;

        for (let depth = 0; depth < 5 && ancestor; depth += 1) {
          const label = ancestor.querySelector("label, legend, h1, h2, h3, h4")?.textContent;

          if (label?.trim()) {
            return clean(label);
          }

          ancestor = ancestor.parentElement;
        }

        return "";
      }

      function findFieldLabel(control: Element) {
        if (control.id) {
          const root = control.getRootNode();
          const direct = ((root instanceof Document || root instanceof ShadowRoot || root instanceof Element)
            ? root.querySelector(`label[for="${CSS.escape(control.id)}"]`)
            : null)
            ?? searchRoots.map((searchRoot) => searchRoot.querySelector(`label[for="${CSS.escape(control.id)}"]`)).find(Boolean)
            ?? null;

          if (direct?.textContent?.trim()) {
            return clean(direct.textContent);
          }
        }

        return clean(
          control.closest("label")?.textContent
          || control.closest("fieldset")?.querySelector("legend")?.textContent
          || control.getAttribute("aria-label")
          || control.getAttribute("placeholder")
          || control.getAttribute("name")
          || control.id
          || ""
        );
      }

      function clean(value: string | null | undefined) {
        return (value ?? "").replace(/\s+/g, " ").replace(/\*/g, "").trim().slice(0, 120);
      }

      function findChoiceGroupLabel(control: HTMLInputElement) {
        const fieldsetLegend = control.closest("fieldset")?.querySelector("legend")?.textContent;

        if (fieldsetLegend?.trim()) {
          return clean(fieldsetLegend);
        }

        const group = control.closest("[role='group']");
        const labelledBy = group?.getAttribute("aria-labelledby");

        if (labelledBy) {
          const labelledText = labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" ");

          if (labelledText.trim()) {
            return clean(labelledText);
          }
        }

        const container = control.closest("section, article, [class*='question'], [class*='field'], [class*='input']");
        const heading = container?.querySelector("h1, h2, h3, h4, legend, label")?.textContent;

        if (heading?.trim() && normalize(heading) !== normalize(findFieldLabel(control))) {
          return clean(heading);
        }

        const inferredCountryQuestion = inferCountryQuestionFromAncestors(control);

        if (inferredCountryQuestion) {
          return inferredCountryQuestion;
        }

        return "";
      }

      function inferCountryQuestionFromAncestors(control: HTMLInputElement) {
        if (!isCountryOption(findFieldLabel(control))) {
          return "";
        }

        let ancestor: Element | null = control.parentElement;

        for (let depth = 0; depth < 8 && ancestor; depth += 1) {
          const text = clean(ancestor.textContent);
          const normalized = normalize(text);

          if (/\b(country|countries|working in|currently reside|previous response)\b/.test(normalized)) {
            const match = text.match(/(Please select[^.?\n]*(?:country|countries)[^.?\n]*|Are you authorized[^.?\n]*previous response|Will you require[^.?\n]*previous response)/i);

            if (match?.[1]) {
              return clean(match[1]);
            }
          }

          ancestor = ancestor.parentElement;
        }

        return "";
      }

      function isCountryOption(value: string) {
        return /^(australia|belgium|brazil|canada|france|germany|india|indonesia|ireland|israel|italy|japan|luxembourg|malaysia|mexico|new zealand|poland|portugal|romania|singapore|south korea|spain|sweden|switzerland|thailand|the netherlands|netherlands|uae|uk|us|united states|united kingdom)$/i.test(value.trim());
      }

      function isNoiseField(control: Element, label: string) {
        const normalized = normalize(label);

        if (!normalized) {
          return true;
        }

        if (normalized.length > 140) {
          return true;
        }

        if (/results found|no results found/.test(normalized)) {
          return true;
        }

        if (control.closest("[role='option'], [role='listbox'], [role='menu'], [role='dialog']") && !/^location|city|country|phone|email|name/.test(normalized)) {
          return true;
        }

        return false;
      }

      function isCustomSelectLike(control: HTMLElement) {
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

      function normalize(value: string) {
        return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      }

      function hasVisibleChoiceTarget(control: HTMLInputElement) {
        const target = getChoiceClickTarget(control);

        if (!target) {
          return false;
        }

        const rect = target.getBoundingClientRect();
        const style = window.getComputedStyle(target);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      }

      function getChoiceClickTarget(control: HTMLInputElement) {
        if (control.id) {
          const root = control.getRootNode();
          const label = ((root instanceof Document || root instanceof ShadowRoot || root instanceof Element)
            ? root.querySelector(`label[for="${CSS.escape(control.id)}"]`)
            : null)
            ?? searchRoots.map((searchRoot) => searchRoot.querySelector(`label[for="${CSS.escape(control.id)}"]`)).find(Boolean)
            ?? null;

          if (label instanceof HTMLElement) {
            return label;
          }
        }

        const closestLabel = control.closest("label");

        if (closestLabel instanceof HTMLElement) {
          return closestLabel;
        }

        const row = control.closest("button, [role='radio'], [role='checkbox'], [role='button'], [aria-checked], [tabindex], [class*='checkbox'], [class*='radio']");

        return row instanceof HTMLElement ? row : undefined;
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
    }).catch(() => []);

    labels.push(...frameLabels);
  }

  return dedupeLabels(labels);
}

export async function autoResolveConsentControls(page: Page) {
  let resolvedCount = 0;

  for (const frame of page.frames()) {
    const resolved = await frame.evaluate(() => {
      const controls = getSearchRoots().flatMap((root) => Array.from(root.querySelectorAll("input[type='checkbox'], input[type='radio']"))) as HTMLInputElement[];
      let count = 0;

      for (const control of controls) {
        if (control.disabled || control.checked || !isUsableChoice(control)) {
          continue;
        }

        const descriptor = normalize([
          findLabelText(control),
          control.getAttribute("aria-label"),
          control.getAttribute("name"),
          control.id,
          control.closest("label, fieldset, [role='group'], [role='radiogroup'], section, article, [class*='question'], [class*='field'], [class*='input']")?.textContent
        ].filter(Boolean).join(" "));

        if (!/\b(terms|privacy|consent|agree|acknowledge|accept|declaration|eeo|voluntary self identification|data processing)\b/.test(descriptor)) {
          continue;
        }

        if (/\b(country|countries|location|locations|remote|relocat|work permit|sponsor|sponsorship|whatsapp|sms|text messages|talent network|career opportunities|job alerts|marketing)\b/.test(descriptor)) {
          continue;
        }

        clickChoiceControl(control);
        count += 1;
      }

      return count;

      function findLabelText(control: HTMLInputElement) {
        if (control.id) {
          const root = control.getRootNode();
          const label = ((root instanceof Document || root instanceof ShadowRoot || root instanceof Element)
            ? root.querySelector(`label[for="${CSS.escape(control.id)}"]`)
            : null)
            ?? getSearchRoots().map((searchRoot) => searchRoot.querySelector(`label[for="${CSS.escape(control.id)}"]`)).find(Boolean)
            ?? null;

          if (label?.textContent?.trim()) {
            return label.textContent.trim();
          }
        }

        return control.closest("label")?.textContent?.trim()
          || control.parentElement?.textContent?.trim()
          || "";
      }

      function isUsableChoice(control: HTMLInputElement) {
        const target = getChoiceClickTarget(control);

        if (!target) {
          return false;
        }

        const rect = target.getBoundingClientRect();
        const style = window.getComputedStyle(target);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      }

      function clickChoiceControl(control: HTMLInputElement) {
        const target = getChoiceClickTarget(control) ?? control;

        target.scrollIntoView?.({ block: "center", inline: "center" });
        control.focus();

        try {
          target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
          target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, view: window }));
        } catch (_error) {
          target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
          target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
        }

        target.click();

        if (!control.checked) {
          setNativeChecked(control, true);
        }

        dispatch(control);

        control.blur();
      }

      function getChoiceClickTarget(control: HTMLInputElement) {
        if (control.id) {
          const root = control.getRootNode();
          const label = ((root instanceof Document || root instanceof ShadowRoot || root instanceof Element)
            ? root.querySelector(`label[for="${CSS.escape(control.id)}"]`)
            : null)
            ?? getSearchRoots().map((searchRoot) => searchRoot.querySelector(`label[for="${CSS.escape(control.id)}"]`)).find(Boolean)
            ?? null;

          if (label instanceof HTMLElement) {
            return label;
          }
        }

        const closestLabel = control.closest("label");

        if (closestLabel instanceof HTMLElement) {
          return closestLabel;
        }

        const row = control.closest("button, [role='radio'], [role='checkbox'], [role='button'], [aria-checked], [tabindex], [class*='checkbox'], [class*='radio']");

        return row instanceof HTMLElement ? row : undefined;
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

      function normalize(value: string) {
        return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
    }).catch(() => 0);

    resolvedCount += resolved;
  }

  return resolvedCount;
}

export async function getVisibleValidationMessages(page: Page) {
  const messages: string[] = [];

  for (const frame of page.frames()) {
    const frameMessages = await frame.evaluate(() => {
      const selectors = [
        "[role='alert']",
        "[aria-live='assertive']",
        ".error",
        ".errors",
        ".field-error",
        ".validation-error",
        ".form-error"
      ];
      const values = new Set<string>();

      for (const selector of selectors) {
        const elements = Array.from(document.querySelectorAll(selector));

        for (const element of elements) {
          const htmlElement = element as HTMLElement;

          if (htmlElement.closest("#gradlaunch-live-bot")) {
            continue;
          }

          const rect = htmlElement.getBoundingClientRect();
          const text = element.textContent?.replace(/\s+/g, " ").trim();

          if (!text || rect.width <= 0 || rect.height <= 0) {
            continue;
          }

          values.add(text.length > 160 ? `${text.slice(0, 157)}...` : text);
        }
      }

      const invalidControls = Array.from(document.querySelectorAll("input[aria-invalid='true'], textarea[aria-invalid='true'], select[aria-invalid='true']")) as Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>;

      for (const control of invalidControls) {
        if (control.closest("#gradlaunch-live-bot")) {
          continue;
        }

        const rect = control.getBoundingClientRect();

        if (rect.width <= 0 || rect.height <= 0) {
          continue;
        }

        const label = findFieldLabel(control);
        const containerText = control.closest("label, fieldset, [role='group'], [class*='field'], [class*='input'], section, article, div")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const message = /\b(this field is required|required|cannot be blank|please select|please enter|invalid)\b/i.test(containerText)
          ? `${label || "Field"}: ${containerText}`
          : `${label || "Field"} is invalid or incomplete.`;

        values.add(message.length > 160 ? `${message.slice(0, 157)}...` : message);
      }

      return Array.from(values).slice(0, 6);

      function findFieldLabel(control: Element) {
        if (control.id) {
          const label = document.querySelector(`label[for="${CSS.escape(control.id)}"]`);

          if (label?.textContent?.trim()) {
            return label.textContent.trim().replace(/\*/g, "").replace(/\s+/g, " ").trim();
          }
        }

        return (
          control.closest("label")?.textContent
          || control.closest("fieldset")?.querySelector("legend")?.textContent
          || control.getAttribute("aria-label")
          || control.getAttribute("placeholder")
          || control.getAttribute("name")
          || ""
        ).replace(/\*/g, "").replace(/\s+/g, " ").trim();
      }
    }).catch(() => []);

    messages.push(...frameMessages);
  }

  return dedupeLabels(messages).filter((message) => !isTransientStatusMessage(message));
}

export async function hasFileUpload(page: Page) {
  for (const frame of page.frames()) {
    const found = await frame.evaluate(() => {
      const searchRoots = getSearchRoots();
      const controls = searchRoots.flatMap((root) => Array.from(root.querySelectorAll("input[type='file']"))) as HTMLInputElement[];
      if (controls.some((control) => !control.disabled)) {
        return true;
      }

      const uploadSelectors = [
        "button",
        "[role='button']",
        "label",
        "a",
        "div",
        "span"
      ];
      const uploadElements = searchRoots.flatMap((root) => {
        return uploadSelectors.flatMap((selector) => Array.from(root.querySelectorAll(selector)));
      }).filter((element): element is HTMLElement => element instanceof HTMLElement && !element.closest("#gradlaunch-live-bot"));
      const pageText = normalize([
        document.body?.innerText ?? "",
        document.body?.textContent ?? "",
        ...uploadElements.map((element) => element.innerText || element.textContent || "")
      ].join(" "));

      return uploadElements.some((element) => {
        const rect = element.getBoundingClientRect();

        if (rect.width <= 0 || rect.height <= 0) {
          return false;
        }

        const ownText = normalize(`${element.textContent ?? ""} ${element.getAttribute("aria-label") ?? ""}`);
        const nearbyText = normalize(findNearbyUploadLabel(element));
        const sectionText = normalize(findUploadSectionText(element));

        return /\b(upload resume|attach resume|drag and drop your resume|browse file|choose(?: a)? file|select file|drop (?:it|file|resume|cv) here|drag and drop)\b/.test(ownText)
          || (looksLikeResumeMethodChoice(`${sectionText} ${pageText}`) && /\b(from device|upload from device|upload from computer|from computer|from my device|select from device)\b/.test(ownText) && !/\b(without resume|without cv|copy paste|copy and paste|paste|manual)\b/.test(ownText))
          || (
            /\b(attach|upload|browse|choose(?: a)? file|select file|drop (?:it|file|resume|cv) here|drag and drop)\b/.test(ownText)
            && (/\b(resume|cv|curriculum vitae|resume cv)\b/.test(nearbyText) || /\b(resume|cv|curriculum vitae|resume cv)\b/.test(sectionText))
            && !(/\bcover letter\b/.test(nearbyText) && !/\b(resume|cv|curriculum vitae)\b/.test(nearbyText))
          );
      });

    function findUploadSectionText(element: HTMLElement) {
      let ancestor: Element | null = element;
      let best = "";
      let bestScore = Number.NEGATIVE_INFINITY;

      for (let depth = 0; depth < 8 && ancestor; depth += 1) {
        const text = normalize(ancestor.textContent ?? "");
        let score = 0;

        if (/\b(resume|cv|curriculum vitae|resume cv)\b/.test(text)) {
          score += 120;
        }

        if (/\bcover letter\b/.test(text)) {
          score -= 90;
        }

        score -= Math.min(text.length / 100, 40);
        score -= depth * 3;

        if (score > bestScore) {
          bestScore = score;
          best = text;
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
        if (candidate === element) {
          continue;
        }

        const rect = candidate.getBoundingClientRect();

        if (rect.width <= 0 || rect.height <= 0) {
          continue;
        }

        const text = normalize(candidate.innerText || candidate.textContent || "");

        if (!/\b(resume|cv|curriculum vitae|cover letter)\b/.test(text)) {
          continue;
        }

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
    }).catch(() => false);

    if (found) {
      return true;
    }
  }

  return false;
}

export async function hasFinalSubmitControl(page: Page) {
  const checkpoint = await detectProtectedCheckpoint(page);

  if (checkpoint.blocked) {
    return false;
  }

  return page.evaluate(() => {
    const controls = getSearchRoots().flatMap((root) => Array.from(root.querySelectorAll("button, input[type='submit'], input[type='button'], a"))) as Array<HTMLButtonElement | HTMLInputElement | HTMLAnchorElement>;
    return controls.some((control) => {
      const rect = control.getBoundingClientRect();

      if (rect.width <= 0 || rect.height <= 0 || control.getAttribute("aria-disabled") === "true") {
        return false;
      }

      if ("disabled" in control && control.disabled) {
        return false;
      }

      const text = `${control.textContent ?? ""} ${"value" in control ? control.value : ""} ${control.getAttribute("aria-label") ?? ""}`.toLowerCase();
      return /\b(submit application|submit my application|submit|send application|send my application)\b/.test(text);
    });

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
}

export async function detectNavigationCandidates(
  page: Page,
  observation: BrowserAgentObservation,
  options: { allowApplyStart: boolean }
): Promise<NavigationCandidate[]> {
  const adapterId = observation.adapter?.id;

  return observation.controls
    .filter((control) => !control.disabled)
    .map((control) => {
      const text = normalizeKey(`${control.text} ${control.label}`);
      let score = 0;

      if (/\b(next|continue|save and continue|save continue|proceed)\b/.test(text)) {
        score += 90;
      }

      if (/\b(review|review application|continue to review)\b/.test(text)) {
        score += 76;
      }

      if (options.allowApplyStart && /\b(apply|apply now|apply for this job|apply for this position|start application|i m interested|im interested)\b/.test(text)) {
        score += 70;
      }

      if (adapterId === "smartrecruiters" && /\b(next|continue|review)\b/.test(text)) {
        score += 18;
      }

      if (adapterId === "workday" && /\b(next|continue|review and submit)\b/.test(text)) {
        score += 18;
      }

      if (isFinalSubmitText(text) || (!options.allowApplyStart && isApplyStartText(text)) || /\b(cancel|back|previous|close|add)\b/.test(text)) {
        score -= 120;
      }

      if (!["button", "link"].includes(control.role) && !["button", "a", "input"].includes(control.tagName)) {
        score -= 10;
      }

      return {
        id: control.id,
        label: control.text || control.label,
        role: control.role || control.tagName,
        score,
        strategy: "dom_control" as const
      };
    })
    .filter((candidate) => candidate.score >= 65)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8);
}

export async function waitForStageTransition(
  context: BrowserContext,
  page: Page,
  signatureBefore: Awaited<ReturnType<typeof getStageSignature>>
): Promise<TransitionWaitResult> {
  const timeoutMs = Number(process.env.BROWSER_STAGE_TRANSITION_TIMEOUT_MS ?? 5000);
  const pollMs = Number(process.env.BROWSER_STAGE_TRANSITION_POLL_MS ?? 250);
  const startedAt = Date.now();
  let activePage = await getActivePage(context, page);

  while (Date.now() - startedAt < timeoutMs) {
    await activePage.waitForLoadState("domcontentloaded", { timeout: pollMs }).catch(() => undefined);
    await activePage.waitForTimeout(pollMs).catch(() => undefined);
    activePage = await getActivePage(context, activePage);

    const visibleFields = await discoverVisibleFields(activePage);
    const observation = await observeBrowserPage(activePage, visibleFields);
    const signatureAfter = await getStageSignature(activePage, observation);

    if (signatureAfter.fingerprint !== signatureBefore.fingerprint || signatureAfter.progressText !== signatureBefore.progressText || signatureAfter.url !== signatureBefore.url) {
      const outcome = observation.pageState === "submit"
        ? "submit_ready"
        : observation.pageState === "review"
          ? "review_ready"
          : "advanced";

      return {
        changed: true,
        activePage,
        reason: `Detected a stage transition to ${observation.pageState}.`,
        signatureBefore,
        signatureAfter,
        outcome
      };
    }
  }

  const signatureAfter = await getStageSignature(activePage);
  const observation = await observeBrowserPage(activePage, await discoverVisibleFields(activePage));

  return {
    changed: false,
    activePage,
    reason: `No stage transition was confirmed after the click. Current page state: ${observation.pageState}.`,
    signatureBefore,
    signatureAfter,
    outcome: "same_stage"
  };
}

export async function clickFinalSubmit(page: Page) {
  const labels = ["Submit application", "Submit Application", "Submit", "Apply"];

  for (const label of labels) {
    try {
      await page.getByRole("button", { name: label, exact: false }).last().click({ timeout: 1500 });
      return true;
    } catch (_error) {
      // Try selector fallback next.
    }
  }

  return page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll("button, input[type='submit'], input[type='button']")) as Array<HTMLButtonElement | HTMLInputElement>;
    const submitControl = controls.find((control) => {
      const text = `${control.textContent ?? ""} ${control.value ?? ""}`.toLowerCase();
      return /submit|apply|send application/.test(text);
    }) ?? controls.find((control) => control instanceof HTMLButtonElement && control.type === "submit");

    if (!submitControl) {
      return false;
    }

    submitControl.click();
    return true;
  }).catch(() => false);
}

export async function clickNextStageControl(context: BrowserContext, page: Page, options: { allowApplyStart: boolean }) {
  const observation = await observeBrowserPage(page, await discoverVisibleFields(page));
  const signatureBefore = await getStageSignature(page, observation);
  const candidates = await detectNavigationCandidates(page, observation, options);

  for (const candidate of candidates) {
    const clicked = await clickObservedControl(context, page, candidate.id);

    if (!clicked) {
      continue;
    }

    const transition = await waitForStageTransition(context, clicked, signatureBefore);

    if (transition.changed) {
      return {
        clicked: true,
        page: transition.activePage
      };
    }
  }

  return {
    clicked: false,
    page
  };
}

async function clickObservedControl(context: BrowserContext, page: Page, controlId: string) {
  for (const frame of page.frames()) {
    const nextPagePromise = context.waitForEvent("page", { timeout: 1500 }).catch(() => undefined);
    const clicked = await frame.evaluate((targetId) => {
      const control = document.querySelector(`[data-gradlaunch-control-id="${CSS.escape(targetId)}"]`);

      if (!(control instanceof HTMLElement)) {
        return false;
      }

      control.scrollIntoView({ block: "center", inline: "center" });
      control.click();
      return true;
    }, controlId).catch(() => false);

    if (clicked) {
      return (await nextPagePromise) ?? page;
    }
  }

  return undefined;
}

function resolveAtsAdapter(url: string): AtsAdapterHint | undefined {
  const hostname = safeHostname(url);

  if (/smartrecruiters\.com$/i.test(hostname)) {
    return { id: "smartrecruiters", label: "SmartRecruiters" };
  }

  if (/greenhouse\.io$/i.test(hostname)) {
    return { id: "greenhouse", label: "Greenhouse" };
  }

  if (/lever\.co$/i.test(hostname)) {
    return { id: "lever", label: "Lever" };
  }

  if (/myworkdayjobs\.com$/i.test(hostname) || /workday/i.test(hostname)) {
    return { id: "workday", label: "Workday" };
  }

  if (/ashbyhq\.com$/i.test(hostname)) {
    return { id: "ashby", label: "Ashby" };
  }

  return undefined;
}

function groupVisibleFields(visibleFields: VisibleField[]): BrowserFieldGroup[] {
  const groups = new Map<string, BrowserFieldGroup>();

  for (const field of visibleFields) {
    const groupLabel = deriveFieldGroupLabel(field);
    const key = normalizeKey(groupLabel);

    if (!key) {
      continue;
    }

    const existing = groups.get(key) ?? {
      label: groupLabel,
      fieldIds: [],
      fieldLabels: [],
      required: false
    };

    existing.fieldIds.push(field.id);
    existing.fieldLabels.push(field.label);
    existing.required = existing.required || field.required;
    groups.set(key, existing);
  }

  return [...groups.values()]
    .filter((group) => group.fieldIds.length > 1)
    .map((group) => ({
      ...group,
      fieldLabels: dedupeLabels(group.fieldLabels)
    }))
    .slice(0, 8);
}

function deriveFieldGroupLabel(field: VisibleField) {
  const context = field.context.replace(/\s+/g, " ").trim();

  if (context) {
    const trimmedContext = context.split(/\.\s+/)[0]?.trim() ?? context;

    if (trimmedContext.length >= 6) {
      return trimmedContext.slice(0, 120);
    }
  }

  const label = field.label.replace(/\s+/g, " ").trim();
  return (label.split(":")[0]?.trim() ?? label).slice(0, 120);
}

function classifyBrowserPageState(input: Omit<BrowserAgentObservation, "pageState">): BrowserPageState {
  const text = normalizeKey([
    input.title,
    input.pageText,
    ...input.controls.map((control) => `${control.text} ${control.label}`),
    ...input.validationMessages
  ].join(" "));
  const hasVisibleFields = input.visibleFields.length > 0;
  const hasPasswordField = input.visibleFields.some((field) => field.inputType === "password" || /\bpassword\b/i.test(field.label));
  const visibleFieldText = normalizeKey(input.visibleFields.map((field) => `${field.label} ${field.context}`).join(" "));
  const hasResumeMethodChoice = /\b(choose an option to apply|application method|application methods|how would you like to apply|apply with)\b/.test(text)
    && /\b(without resume|without cv|copy paste|copy and paste|from device|from computer|upload from device|upload resume|resume)\b/.test(text);
  const hasResumeUploadField = input.visibleFields.some((field) => field.inputType === "file")
    || input.controls.some((control) => /upload resume|upload cv|attach resume|choose(?: a)? file|select resume|autofill with resume/.test(normalizeKey(`${control.text} ${control.label}`)))
    || (hasResumeMethodChoice && input.controls.some((control) => {
      const controlText = normalizeKey(`${control.text} ${control.label}`);
      return /\b(from device|upload from device|from computer|upload from computer|from my device|select from device)\b/.test(controlText)
        && !/\b(without resume|without cv|copy paste|copy and paste|paste|manual)\b/.test(controlText);
    }));
  const hasConsentLanguage = /\b(privacy|terms|consent|agree|acknowledge|declaration|data processing|equal opportunity|eeo|voluntary self identification)\b/.test(text);
  const hasReviewLanguage = /\b(review your application|review application|application review|preview)\b/.test(text);
  const hasSubmitLanguage = /\b(submit application|submit my application|send application|complete application)\b/.test(text);
  const hasCaptchaLanguage = /\b(captcha|verify you are human|human verification|security check|i am not a robot|cloudflare challenge)\b/.test(text);
  const hasLoadingLanguage = /\b(active loading indicator|loading|please wait|processing|uploading|saving|submitting|one moment)\b/.test(text);
  const hasApplyStart = input.controls.some((control) => isApplyStartText(`${control.text} ${control.label}`));
  const hasQuestionnaireHints = input.groupedFields.length > 0
    || input.visibleFields.some((field) => field.options.length > 0 || field.inputType === "radio" || field.inputType === "checkbox")
    || /\b(questionnaire|screening question|additional question|work authorization|salary expectation|notice period)\b/.test(text);
  const hasCredentialField = input.visibleFields.some((field) => /\b(email|username|user name|login|password|otp|verification code)\b/i.test(field.label));
  const hasApplicationIdentityField = /\b(name|full name|first name|last name|resume|cv|phone|mobile|linkedin|portfolio|website|location|city)\b/.test(visibleFieldText);
  const loginLanguage = /\b(sign in|log in|login|continue with email|forgot password|create account|account password)\b/.test(text);
  const looksLikeLogin = hasPasswordField
    || (loginLanguage && hasCredentialField && !hasApplicationIdentityField && !hasResumeUploadField && !hasApplyStart);

  if (looksLikeLogin) {
    return "login";
  }

  if (hasCaptchaLanguage) {
    return "captcha";
  }

  if (input.validationMessages.length > 0) {
    return "validation_error";
  }

  if (hasLoadingLanguage && !hasVisibleFields && !hasResumeUploadField) {
    return "loading";
  }

  if (hasResumeUploadField && !hasVisibleFields) {
    return "resume_upload";
  }

  if (hasSubmitLanguage) {
    return "submit";
  }

  if (hasReviewLanguage) {
    return "review";
  }

  if (hasConsentLanguage && hasVisibleFields) {
    return "consent";
  }

  if (hasQuestionnaireHints && hasVisibleFields) {
    return "questionnaire";
  }

  if (hasApplyStart && !hasVisibleFields) {
    return "start";
  }

  if (hasVisibleFields) {
    return "form_fill";
  }

  if (!text && input.controls.length === 0) {
    return "empty";
  }

  return "unknown";
}

function isFinalSubmitText(value: string) {
  return /\b(submit application|submit my application|submit|send application|send my application)\b/i.test(value);
}

function isApplyStartText(value: string) {
  return /\bapply\b|apply now|apply for this job|apply for this position/i.test(value);
}
