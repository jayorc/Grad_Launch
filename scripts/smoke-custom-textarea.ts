import assert from "node:assert/strict";
import { chromium } from "../apps/api/src/services/browser-agent/browser-driver";
import { discoverStructuredVisibleFields } from "../apps/api/src/services/browser-agent/fill-field-graph";
import { fillV2Field, verifyV2Field } from "../apps/api/src/services/browser-agent/fill-field-drivers";
import type { FillV2Adapter, FillV2Answer, FillV2Field } from "../apps/api/src/services/browser-agent/fill-engine";

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath
  });

  try {
    const page = await browser.newPage();
    await page.setContent(buildCustomTextareaHtml(), { waitUntil: "domcontentloaded" });

    const discovered = await discoverStructuredVisibleFields(page);
    const discoveredMessage = discovered.find((field) => normalize(field.label) === normalize("Let the company know about your interest working there"));
    const fakeResumeTextarea = discovered.find((field) => normalize(field.label) === "resume" && field.inputType === "textarea");

    assert.ok(discoveredMessage, "custom SmartRecruiters textarea should be discovered");
    assert.equal(discoveredMessage.inputType, "textarea", "custom textarea host should be classified as textarea");
    assert.equal(fakeResumeTextarea, undefined, "resume upload evidence must not be mapped to the message textarea");

    await page.locator("spl-textarea").evaluate((element) => {
      element.setAttribute("data-gradlaunch-v2-field-id", "custom-message");
    });

    const field: FillV2Field = {
      id: "custom-message",
      label: "Let the company know about your interest working there",
      required: true,
      tagName: "spl-textarea",
      inputType: "text",
      options: [],
      context: "Personal information",
      domPathSignature: "spl-textarea#hiring-manager-message-i > oc-textarea > oc-hiring-manager-message",
      ownerLabelText: "Let the company know about your interest working there",
      ownerLabelSource: "visual_question",
      adapterId: "smoke",
      driver: "text",
      intent: "prose",
      confidence: 0.86,
      widgetKind: "text_input",
      valueKind: "prose",
      intentCandidates: [{
        intent: "prose",
        score: 86,
        reasons: ["Smoke test for custom SmartRecruiters textarea host."]
      }],
      signature: {
        semanticLabel: "prose",
        normalizedLabel: "let the company know about your interest working there",
        section: "personal information",
        widgetKind: "text_input",
        valueKind: "prose",
        options: []
      }
    };
    const answer: FillV2Answer = {
      label: field.label,
      fieldId: field.id,
      inputType: field.inputType,
      options: [],
      required: true,
      value: "Thank you for reviewing my application. I am excited about this opportunity and would be glad to contribute my engineering skills.",
      reason: "Smoke answer.",
      intent: "prose",
      source: "fallback",
      confidence: 0.9
    };
    const adapter: FillV2Adapter = {
      id: "smoke",
      label: "Smoke adapter",
      matches: () => true
    };

    const filled = await fillV2Field(page, field, answer, adapter);
    const verified = await verifyV2Field(page, field, answer);
    const textareaValue = await page.locator("spl-textarea").evaluate((element) => {
      return element.shadowRoot?.querySelector("textarea")?.value ?? "";
    });

    console.log(JSON.stringify({ filled, verified, textareaValue }, null, 2));

    assert.equal(filled, true, "custom textarea host should fill");
    assert.equal(verified, true, "custom textarea host should verify through nested textarea value");
    assert.equal(textareaValue, answer.value, "nested textarea should contain the planned answer");

    await page.close();
  } finally {
    await browser.close();
  }
}

function buildCustomTextareaHtml() {
  return `<!doctype html>
<html>
  <head>
    <style>
      body { font-family: sans-serif; padding: 32px; }
      oc-hiring-manager-message, oc-textarea, spl-textarea { display: block; }
      .form-section { width: 680px; }
      .question { margin: 0 0 8px; font-weight: 600; }
      spl-textarea { width: 680px; min-height: 132px; }
    </style>
  </head>
  <body>
    <section class="resume-upload">
      <h2>Resume</h2>
      <div class="uploaded-file">Arpit_CV.pdf</div>
    </section>
    <oc-hiring-manager-message>
      <div class="form-section">
        <div class="question">Let the company know about your interest working there *</div>
        <oc-textarea>
          <spl-textarea id="hiring-manager-message-i"></spl-textarea>
        </oc-textarea>
      </div>
    </oc-hiring-manager-message>
    <script>
      class SplTextarea extends HTMLElement {
        connectedCallback() {
          if (this.shadowRoot) return;

          const shadow = this.attachShadow({ mode: "open" });
          const style = document.createElement("style");
          const textarea = document.createElement("textarea");

          style.textContent = "textarea { box-sizing: border-box; width: 100%; min-height: 132px; padding: 10px; }";
          textarea.setAttribute("aria-label", "Let the company know about your interest working there");
          textarea.addEventListener("input", () => {
            this.dataset.lastValue = textarea.value;
          });
          textarea.addEventListener("change", () => {
            this.dataset.lastValue = textarea.value;
          });

          shadow.append(style, textarea);
        }

        get value() {
          return this.shadowRoot?.querySelector("textarea")?.value ?? "";
        }

        set value(nextValue) {
          const textarea = this.shadowRoot?.querySelector("textarea");

          if (textarea) {
            textarea.value = String(nextValue ?? "");
          }
        }
      }

      customElements.define("spl-textarea", SplTextarea);
    </script>
  </body>
</html>`;
}

function normalize(value: string) {
  return value.toLowerCase().replace(/\*/g, "").replace(/\s+/g, " ").trim();
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
