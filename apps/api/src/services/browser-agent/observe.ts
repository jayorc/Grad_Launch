import type { BrowserContext, Page } from "playwright-core";
import type {
  AtsAdapterHint,
  BrowserAgentObservation,
  BrowserFieldGroup,
  BrowserPageState,
  ObservedControl,
  ProtectedCheckpointDetection,
  VisibleField
} from "./types";
import { dedupeLabels, normalizeKey, safeHostname } from "./util";

export async function getActivePage(context: BrowserContext, fallbackPage: Page) {
  await fallbackPage.waitForTimeout(400).catch(() => undefined);
  const pages = context.pages().filter((page) => !page.isClosed());
  const page = pages.includes(fallbackPage) ? fallbackPage : pages.at(-1) ?? fallbackPage;
  page.setDefaultTimeout(Number(process.env.BROWSER_STEP_TIMEOUT_MS ?? 2500));
  await page.bringToFront().catch(() => undefined);
  return page;
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

        if (!label.trim()) {
          continue;
        }

        const id = control.getAttribute("data-gradlaunch-field-id") || `gl-field-${index}-${normalize(label)}`;
        control.setAttribute("data-gradlaunch-field-id", id);

        items.push({
          id,
          label: clean(label),
          required: isRequired(control, label),
          tagName: control.tagName.toLowerCase(),
          inputType: control instanceof HTMLInputElement ? control.type || "text" : control instanceof HTMLSelectElement ? "select" : "textarea",
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

      function isRequired(control: Element, label: string) {
        return (control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).required
          || control.getAttribute("aria-required") === "true"
          || /\*/.test(label)
          || Boolean(control.closest(".required, [class*='required'], [data-required='true']"));
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
    const visiblePasswordField = Array.from(document.querySelectorAll("input[type='password']")).some((field) => isVisible(field));
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

    if (visiblePasswordField && /sign in|log in|login|password|account/.test(bodyText)) {
      return {
        blocked: true,
        kind: "login" as const,
        reason: "Human intervention needed: sign in to the job portal in the open browser."
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

      return controls
        .filter((control) => {
          if (control instanceof HTMLInputElement && ["hidden", "file", "submit", "button"].includes(control.type)) {
            return false;
          }

          const rect = control.getBoundingClientRect();

          if (rect.width <= 0 || rect.height <= 0 || !isRequired(control)) {
            return false;
          }

          if (control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type)) {
            const group = control.name
              ? searchRoots.flatMap((root) => Array.from(root.querySelectorAll(`input[name="${CSS.escape(control.name)}"]`))) as HTMLInputElement[]
              : [control];
            return !group.some((item) => item.checked);
          }

          return !control.value.trim();
        })
        .map((control) => findFieldLabel(control))
        .filter(Boolean);

      function isRequired(control: Element) {
        const label = findFieldLabel(control);
        return (control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).required
          || control.getAttribute("aria-required") === "true"
          || /\*/.test(label)
          || Boolean(control.closest(".required, [class*='required'], [data-required='true']"));
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
          control.closest("label, fieldset, [role='group'], form")?.textContent
        ].filter(Boolean).join(" "));

        if (!/\b(terms|privacy|consent|agree|acknowledge|accept|declaration|eeo|voluntary self identification|data processing)\b/.test(descriptor)) {
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
  return page.evaluate(() => {
    const controls = getSearchRoots().flatMap((root) => Array.from(root.querySelectorAll("input[type='file']"))) as HTMLInputElement[];
    return controls.some((control) => {
      const rect = control.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !control.disabled;
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
  const labels = [
    "Continue",
    "Next",
    "Save and continue",
    "Save & continue",
    "Continue to review",
    "Review application",
    "Review",
    "Proceed",
    "Start application",
    "Start",
    ...(options.allowApplyStart ? ["Apply", "Apply now", "Apply for this job", "Apply for this position"] : []),
    "I'm interested",
    "I’m interested"
  ];

  for (const label of labels) {
    const locators = [
      page.getByRole("button", { name: label, exact: false }),
      page.getByRole("link", { name: label, exact: false })
    ];

    for (const locator of locators) {
      const count = await locator.count().catch(() => 0);

      for (let index = 0; index < Math.min(count, 4); index += 1) {
        const candidate = locator.nth(index);

        try {
          const text = await candidate.innerText({ timeout: 700 }).catch(() => label);

          if (isFinalSubmitText(text) || (!options.allowApplyStart && isApplyStartText(text))) {
            continue;
          }

          await candidate.scrollIntoViewIfNeeded({ timeout: 1000 });
          const nextPagePromise = context.waitForEvent("page", { timeout: 2500 }).catch(() => undefined);
          await candidate.click({ timeout: 1500 });
          return {
            clicked: true,
            page: (await nextPagePromise) ?? page
          };
        } catch (_error) {
          // Continue to the next candidate.
        }
      }
    }
  }

  return {
    clicked: false,
    page
  };
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
  const hasResumeUploadField = input.visibleFields.some((field) => field.inputType === "file")
    || input.controls.some((control) => /upload resume|upload cv|attach resume|choose file|select resume|autofill with resume/.test(normalizeKey(`${control.text} ${control.label}`)));
  const hasConsentLanguage = /\b(privacy|terms|consent|agree|acknowledge|declaration|data processing|equal opportunity|eeo|voluntary self identification)\b/.test(text);
  const hasReviewLanguage = /\b(review your application|review application|application review|preview)\b/.test(text);
  const hasSubmitLanguage = /\b(submit application|submit my application|send application|complete application)\b/.test(text);
  const hasApplyStart = input.controls.some((control) => isApplyStartText(`${control.text} ${control.label}`));
  const hasQuestionnaireHints = input.groupedFields.length > 0
    || input.visibleFields.some((field) => field.options.length > 0 || field.inputType === "radio" || field.inputType === "checkbox")
    || /\b(questionnaire|screening question|additional question|work authorization|salary expectation|notice period)\b/.test(text);

  if (hasPasswordField || /\b(sign in|log in|login|password)\b/.test(text)) {
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
