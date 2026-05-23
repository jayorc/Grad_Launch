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
import { dedupeLabels, normalizeKey, safeHostname } from "./util";

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
    try {
      await page.getByRole("button", { name: label, exact: false }).first().click({ timeout: 800 });
      return;
    } catch (_error) {
      // Soft gates vary across sites.
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

      for (const [index, control] of controls.entries()) {
        if (control instanceof HTMLInputElement && ["hidden", "submit", "button", "image", "reset"].includes(control.type)) {
          continue;
        }

        const rect = control.getBoundingClientRect();

        if (rect.width <= 0 || rect.height <= 0 || ("disabled" in control && control.disabled)) {
          continue;
        }

        const label = findFieldLabel(control);

        if (!label.trim() || isNoiseField(control, label)) {
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

      function isRequired(control: Element, label: string) {
        return (control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).required
          || control.getAttribute("aria-required") === "true"
          || /\*/.test(label)
          || Boolean(control.closest(".required, [class*='required'], [data-required='true']"));
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

    return {
      title: document.title,
      pageText: document.body?.innerText?.replace(/\s+/g, " ").slice(0, 3500) ?? "",
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

    if (/(^|\.)accounts\.google\.com$/.test(currentHost) && /\b(sign in|email or phone|choose an account|password|continue|verify|2-step verification)\b/.test(bodyText)) {
      return {
        blocked: true,
        kind: "login" as const,
        reason: "Google sign-in is open. GradLaunch will choose the existing account when possible, otherwise it will enter the applicant email and wait if Google asks for password or verification."
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
        reason: "Login panel detected. GradLaunch will try the existing browser profile first, then wait if the portal still needs input."
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

        const rect = control.getBoundingClientRect();

        if (rect.width <= 0 || rect.height <= 0) {
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

      return Array.from(groups.values())
        .filter((group) => group.required && !group.satisfied)
        .map((group) => group.label);

      function isRequired(control: Element) {
        const label = findFieldLabel(control);
        return (control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).required
          || control.getAttribute("aria-required") === "true"
          || /\*/.test(label)
          || Boolean(control.closest(".required, [class*='required'], [data-required='true']"));
      }

      function isSatisfied(
        control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
        roots: Array<Document | ShadowRoot>
      ) {
        if (control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type)) {
          const group = control.name
            ? roots.flatMap((root) => Array.from(root.querySelectorAll(`input[name="${CSS.escape(control.name)}"]`))) as HTMLInputElement[]
            : [control];
          return group.some((item) => item.checked);
        }

        if (control.value.trim()) {
          return true;
        }

        if (!(control instanceof HTMLElement)) {
          return false;
        }

        if (isCustomSelectLike(control)) {
          const container = control.closest("[role='combobox'], [aria-haspopup='listbox'], [data-radix-select-trigger], [data-headlessui-state], [class*='select'], [class*='combobox']")
            ?? control.parentElement;
          const selectedText = normalize([
            control.getAttribute("data-value"),
            control.getAttribute("aria-valuetext"),
            container?.getAttribute("data-value"),
            container?.getAttribute("aria-valuetext"),
            container?.textContent
          ].filter(Boolean).join(" "));

          if (selectedText && !/select|choose|search|type to search/.test(selectedText)) {
            return true;
          }
        }

        return false;
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
        const rect = control.getBoundingClientRect();

        if (rect.width <= 0 || rect.height <= 0 || control.disabled || control.checked) {
          continue;
        }

        const descriptor = normalize([
          findLabelText(control),
          control.getAttribute("aria-label"),
          control.getAttribute("name"),
          control.id,
          control.closest("label, fieldset, [role='group']")?.textContent
        ].filter(Boolean).join(" "));

        if (!/\b(terms|privacy|consent|agree|acknowledge|accept|declaration|eeo|voluntary self identification|data processing)\b/.test(descriptor)) {
          continue;
        }

        if (/\b(country|countries|location|locations|remote|relocat|work permit|sponsor|sponsorship|whatsapp|sms|text messages)\b/.test(descriptor)) {
          continue;
        }

        control.click();
        control.dispatchEvent(new Event("input", { bubbles: true }));
        control.dispatchEvent(new Event("change", { bubbles: true }));
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
          const rect = htmlElement.getBoundingClientRect();
          const text = element.textContent?.replace(/\s+/g, " ").trim();

          if (!text || rect.width <= 0 || rect.height <= 0) {
            continue;
          }

          values.add(text.length > 160 ? `${text.slice(0, 157)}...` : text);
        }
      }

      return Array.from(values).slice(0, 6);
    }).catch(() => []);

    messages.push(...frameMessages);
  }

  return dedupeLabels(messages);
}

export async function hasFileUpload(page: Page) {
  for (const frame of page.frames()) {
    const found = await frame.evaluate(() => {
    const controls = getSearchRoots().flatMap((root) => Array.from(root.querySelectorAll("input[type='file']"))) as HTMLInputElement[];
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

    return uploadSelectors.some((selector) => {
      return Array.from(document.querySelectorAll(selector)).some((element) => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }

        const rect = element.getBoundingClientRect();

        if (rect.width <= 0 || rect.height <= 0) {
          return false;
        }

        const ownText = normalize(`${element.textContent ?? ""} ${element.getAttribute("aria-label") ?? ""}`);
        const nearbyText = normalize(findNearbyUploadLabel(element));
        const sectionText = normalize(findUploadSectionText(element));

        return /\b(upload resume|attach resume|drag and drop your resume|browse file|choose file|select file)\b/.test(ownText)
          || (
            /\b(attach|upload|browse|choose file|select file)\b/.test(ownText)
            && (/\b(resume|cv|curriculum vitae|resume cv)\b/.test(nearbyText) || /\b(resume|cv|curriculum vitae|resume cv)\b/.test(sectionText))
            && !(/\bcover letter\b/.test(nearbyText) && !/\b(resume|cv|curriculum vitae)\b/.test(nearbyText))
          );
      });
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
    .filter((candidate) => candidate.score > 0)
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
    ...input.validationMessages
  ].join(" "));
  const hasVisibleFields = input.visibleFields.length > 0;
  const hasPasswordField = input.visibleFields.some((field) => field.inputType === "password" || /\bpassword\b/i.test(field.label));
  const visibleFieldText = normalizeKey(input.visibleFields.map((field) => `${field.label} ${field.context}`).join(" "));
  const hasResumeUploadField = input.visibleFields.some((field) => field.inputType === "file")
    || input.controls.some((control) => /upload resume|upload cv|attach resume|choose file|select resume|autofill with resume/.test(normalizeKey(`${control.text} ${control.label}`)));
  const hasConsentLanguage = /\b(privacy|terms|consent|agree|acknowledge|declaration|data processing|equal opportunity|eeo|voluntary self identification)\b/.test(text);
  const hasReviewLanguage = /\b(review your application|review application|application review|preview)\b/.test(text);
  const hasSubmitLanguage = /\b(submit application|submit my application|send application|complete application)\b/.test(text);
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
    return "account_gate";
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
