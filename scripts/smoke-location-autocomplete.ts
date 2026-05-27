import assert from "node:assert/strict";
import { chromium } from "../apps/api/src/services/browser-agent/browser-driver";
import { fillRepairFieldV2 } from "../apps/api/src/services/browser-agent/fill-field-drivers";
import type { BrowserFillField } from "../apps/api/src/services/browser-agent/types";

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const legacyCityField: BrowserFillField = {
  fieldId: "city-field",
  label: "City",
  inputType: "combobox",
  value: "Gurugram, India",
  required: true
};

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath
  });

  try {
    const lightDom = await runScenario(browser, {
      name: "legacy-light-dom",
      shadowPopup: false
    });
    const shadowDom = await runScenario(browser, {
      name: "legacy-shadow-popup",
      shadowPopup: true
    });

    console.log(JSON.stringify({ lightDom, shadowDom }, null, 2));
  } finally {
    await browser.close();
  }
}

async function runScenario(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  options: { name: string; shadowPopup: boolean }
) {
  const page = await browser.newPage();
  await page.setContent(buildSmokeHtml({ comboboxRole: true, shadowPopup: options.shadowPopup }), { waitUntil: "domcontentloaded" });
  console.log(`running ${options.name}`);

  const filled = await withTimeout("fillRepairFieldV2", fillRepairFieldV2(page, legacyCityField));
  const committed = await page.locator("#city-input").inputValue();
  const selected = await page.locator("#selected-city").textContent();

  assert.equal(filled, true, `${options.name}: fillRepairFieldV2 should report success`);
  assert.equal(committed, "Gurugram, Haryana, India", `${options.name}: committed value should match selected city`);
  assert.equal(selected, "Gurugram, Haryana, India", `${options.name}: selected city should match`);

  await page.close();

  return {
    filled,
    committed,
    selected
  };
}

async function withTimeout<T>(label: string, promise: Promise<T>, timeoutMs = 30000) {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    })
  ]);
}

function buildSmokeHtml(options: { comboboxRole: boolean; shadowPopup: boolean }) {
  return `<!doctype html>
<html>
  <body>
    <div id="app">
      <label for="city-input">City*</label>
      <div id="city-field-shell"></div>
      <div id="selected-city" aria-live="polite"></div>
    </div>
    <script>
      const state = {
        query: "",
        highlighted: -1,
        options: [],
        selected: "",
        navigationUsed: false,
        armed: false,
        loading: false,
        requestId: 0
      };

      const allOptions = ["Gurugram, Haryana, India", "Delhi, India"];
      const shell = document.getElementById("city-field-shell");
      const selected = document.getElementById("selected-city");

      function render() {
        shell.innerHTML = "";
        const wrapper = document.createElement("div");
        wrapper.className = "city-wrapper";

        const input = document.createElement("input");
        input.id = "city-input";
        input.name = "city";
        input.type = "text";
        input.setAttribute("data-gradlaunch-v2-field-id", "city-field");
        input.setAttribute("data-gradlaunch-field-id", "city-field");
        input.setAttribute("aria-label", "City");
        ${options.comboboxRole ? "input.setAttribute('role', 'combobox');" : ""}
        input.setAttribute("autocomplete", "off");
        input.setAttribute("aria-autocomplete", "list");
        input.setAttribute("aria-controls", "city-popup");
        input.setAttribute("aria-expanded", state.options.length > 0 ? "true" : "false");
        input.value = state.selected || state.query;

        if (state.highlighted >= 0 && state.options[state.highlighted]) {
          input.setAttribute("aria-activedescendant", "city-option-" + state.highlighted);
        } else {
          input.removeAttribute("aria-activedescendant");
        }

        input.addEventListener("input", (event) => {
          const nextQuery = event.target.value;
          const requestId = ++state.requestId;
          state.selected = "";
          state.query = nextQuery;
          state.options = [];
          state.highlighted = -1;
          state.navigationUsed = false;
          state.armed = false;
          state.loading = true;
          queueMicrotask(render);

          setTimeout(() => {
            if (requestId !== state.requestId) {
              return;
            }

            state.options = allOptions.filter((option) => option.toLowerCase().includes(nextQuery.toLowerCase()));
            state.loading = false;
            queueMicrotask(render);
          }, 450);
        });

        input.addEventListener("keydown", (event) => {
          if (event.key === "ArrowDown" && state.options.length > 0) {
            event.preventDefault();
            state.navigationUsed = true;
            if (!state.armed) {
              state.armed = true;
            } else {
              state.highlighted = Math.min(state.highlighted + 1, state.options.length - 1);
            }
            queueMicrotask(render);
          }

          if (event.key === "Enter" && state.navigationUsed && state.options[state.highlighted]) {
            event.preventDefault();
            commit(state.options[state.highlighted]);
          }
        });

        wrapper.appendChild(input);

        if (state.loading || state.options.length > 0) {
          const popup = document.createElement("div");
          popup.id = "city-popup";
          popup.setAttribute("role", "listbox");

          if (state.loading) {
            const loading = document.createElement("div");
            loading.textContent = "Searching cities...";
            popup.appendChild(loading);
          } else {
            state.options.forEach((option, index) => {
              const item = document.createElement("div");
              item.id = "city-option-" + index;
              item.setAttribute("role", "option");
              item.setAttribute("aria-selected", index === state.highlighted ? "true" : "false");
              item.textContent = option;
              item.addEventListener("mousedown", (event) => event.preventDefault());
              item.addEventListener("click", () => commit(option));
              popup.appendChild(item);
            });
          }

          const manual = document.createElement("div");
          manual.textContent = "Cannot find your city? Click here to fill in manually";
          popup.appendChild(manual);

          if (${options.shadowPopup ? "true" : "false"}) {
            const popupHost = document.createElement("div");
            popupHost.id = "city-popup-host";
            const shadow = popupHost.attachShadow({ mode: "open" });
            shadow.appendChild(popup);
            wrapper.appendChild(popupHost);
          } else {
            wrapper.appendChild(popup);
          }
        }

        shell.appendChild(wrapper);
        selected.textContent = state.selected;
      }

      function commit(value) {
        state.selected = value;
        state.query = value;
        state.options = [];
        state.highlighted = -1;
        state.navigationUsed = false;
        state.armed = false;
        state.loading = false;
        queueMicrotask(render);
      }

      render();
    </script>
  </body>
</html>`;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
