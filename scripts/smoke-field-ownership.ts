import assert from "node:assert/strict";
import type { Job, StudentProfile } from "@gradlaunch/shared";
import { chromium } from "../apps/api/src/services/browser-agent/browser-driver";
import { discoverStructuredVisibleFields } from "../apps/api/src/services/browser-agent/fill-field-graph";
import { runFillEngine } from "../apps/api/src/services/browser-agent/fill-engine";

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

process.env.LLM_ANSWER_ENABLED = "false";

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath
  });

  try {
    const page = await browser.newPage();
    await page.setContent(buildOwnershipSmokeHtml(), { waitUntil: "domcontentloaded" });
    const discovered = await discoverStructuredVisibleFields(page);

    assert.ok(!discovered.some((field) => /^stage\s+\d+/i.test(field.label)), "status text must not be discovered as a field");
    assertFieldOwner(discovered, "Current Company");
    assertFieldOwner(discovered, "Tell us about your Overall technical expertise");
    assertFieldOwner(discovered, "Reason for job Change");
    assertFieldOwner(discovered, "Preferred Work Location?");
    assertFieldOwner(discovered, "Please mention your Notice Period.");
    assertFieldOwner(discovered, "Do you have Notice Period Buyout?");

    const result = await withTimeout("runFillEngine", runFillEngine({
      page,
      stageIndex: 0,
      visibleFields: [],
      baseFields: [],
      job: smokeJob,
      student: smokeStudent,
      workspacePath: "/private/tmp",
      shouldStop: async () => false,
      onStatus: async (message) => {
        console.log(`[ownership-smoke] ${message}`);
      }
    }), 45000);
    const values = await page.evaluate(() => {
      const entries = Array.from(document.querySelectorAll<HTMLInputElement>("input[data-key]:not([type='radio']):not([type='checkbox'])"))
        .map((input) => [input.dataset.key ?? "", input.value]);

      for (const name of ["officeHybrid", "previousAssociation"]) {
        const checked = document.querySelector<HTMLInputElement>(`input[type='radio'][name='${name}']:checked`);
        entries.push([name, checked?.value ?? ""]);
      }

      const privacy = document.querySelector<HTMLInputElement>("input[data-key='privacyConsent']");
      entries.push(["privacyConsent", privacy?.checked ? "true" : "false"]);

      return Object.fromEntries(entries);
    });
    const attemptSummary = result.attempts.map((attempt) => ({
      label: attempt.field.label,
      value: attempt.field.value,
      filled: attempt.filled,
      verified: attempt.verified,
      alreadySatisfied: attempt.alreadySatisfied
    }));

    console.log(JSON.stringify({ attempts: attemptSummary, values }, null, 2));

    assert.equal(values.totalExperience, "0", "total experience should stay in its own field");
    assert.equal(values.currentCompany, "Global Logic", "current company should not spill into expertise");
    assert.match(values.technicalExpertise ?? "", /C\/C\+\+|Python|Java/i, "technical expertise should use skills prose");
    assert.notEqual(values.technicalExpertise, "Global Logic", "technical expertise must not receive company value");
    assert.match(values.reasonForChange ?? "", /growing|ownership|collaborative/i, "reason field should receive reason prose");
    assert.equal(values.preferredLocation, "Bengaluru", "preferred location should stay in its own field");
    assert.equal(values.officeHybrid, "Yes", "office hybrid radio should be selected");
    assert.equal(values.bondObligation, "No", "bond/obligation text question should receive a yes/no answer");
    assert.equal(values.previousAssociation, "No", "previous association radio should be selected");
    assert.equal(values.noticePeriod, "20", "notice period should use profile notice period");
    assert.equal(values.noticeBuyout, "No", "notice buyout should not receive notice period days");
    assert.equal(values.currentCtc, "10 LPA", "current CTC should use profile current salary");
    assert.equal(values.expectedCtc, "30 LPA", "expected CTC should use profile expected salary");
    assert.equal(values.privacyConsent, "true", "privacy declaration checkbox should be checked");

    await page.close();
  } finally {
    await browser.close();
  }
}

const smokeJob: Job = {
  id: "job_tsystems",
  title: "Software Engineer",
  company: "T-Systems ICT India Pvt Ltd",
  location: "Bengaluru",
  workMode: "hybrid",
  minExperience: 0,
  maxExperience: 2,
  degreeRequirements: ["B.Tech"],
  skills: ["JavaScript", "TypeScript"],
  description: "Software engineering role focused on reliable backend and product delivery.",
  sourceType: "manual_url",
  sourceUrl: "https://example.test/job",
  createdAt: new Date().toISOString()
};

const smokeStudent: StudentProfile = {
  id: "student_hlnw1o55",
  fullName: "Arpit",
  email: "arpitarpit2003@gmail.com",
  degree: "B.Tech in Computer Science",
  graduationYear: 2026,
  targetRoles: ["Software developer", "software engineer"],
  preferredLocations: ["Gurugram", "Bengaluru"],
  workModes: ["remote", "hybrid"],
  skills: ["C/C++", "Python", "Java", "JavaScript", "TypeScript"],
  expectedSalaryLpa: 30,
  visaRequired: false,
  automationMode: "full_autopilot",
  defaultStrictness: "balanced",
  bio: "Computer Engineering student with programming, machine learning, and data analysis experience.",
  completeProfile: {
    headline: "Computer Engineering",
    phone: "+91-9990605914",
    linkedInUrl: "https://linkedin.com/in/arpit917028250",
    githubUrl: "https://github.com/Arpit03022004",
    addressLine1: "bhiwani, Haryana",
    city: "Bhiwani",
    state: "Haryana",
    country: "India",
    nationality: "Indian",
    currentCompany: "Global Logic",
    currentTitle: "Software Developer",
    totalExperienceYears: 0,
    noticePeriodDays: 20,
    currentSalaryLpa: 10,
    sponsorshipRequired: false,
    openToRelocate: true,
    willingToTravel: false,
    workAuthorizationCountries: ["India"],
    preferredEmploymentTypes: [],
    certifications: [],
    languages: ["English", "Hindi"],
    achievements: [],
    educationHistory: [{
      school: "National Institute of Technology Kurukshetra",
      degree: "B.Tech in Computer Science",
      fieldOfStudy: "Computer Science",
      startYear: 2022,
      endYear: 2026,
      grade: "7.6/10"
    }],
    employmentHistory: [],
    projectHistory: [],
    screeningAnswers: [],
    customFacts: [],
    eeo: {
      ethnicity: "Asia",
      veteranStatus: "no",
      disabilityStatus: "no"
    }
  }
};

function buildOwnershipSmokeHtml() {
  return `<!doctype html>
<html>
  <head>
    <style>
      body { font-family: sans-serif; padding: 24px 42px; }
      sr-question-field-text, sr-question-field-radio { display: block; }
      .row { margin: 0 0 20px; width: 860px; }
      .question { margin-bottom: 8px; }
      input[type="text"] { box-sizing: border-box; width: 100%; height: 36px; padding: 7px 8px; }
      .counter { text-align: right; font-size: 12px; color: #555; }
    </style>
  </head>
  <body>
    <div class="agent-status">STAGE 2 Classified page as consent (91% confidence). 14 visible input field(s) can be mapped and verified. fields are present, so filling should happen before navigation.</div>
    <form id="form"></form>
    <script>
      const state = {
        totalExperience: "",
        currentCompany: "",
        technicalExpertise: "",
        reasonForChange: "",
        preferredLocation: "",
        officeHybrid: "",
        bondObligation: "",
        previousAssociation: "",
        shiftFlexibility: "",
        noticePeriod: "",
        noticeBuyout: "",
        aadhar: "",
        currentCtc: "",
        expectedCtc: "",
        privacyConsent: ""
      };
      const form = document.getElementById("form");

      function render() {
        form.innerHTML = [
          textRow("What is your total Experience?", "totalExperience", true),
          textRow("Current Company", "currentCompany", true),
          textRow("Tell us about your Overall technical expertise", "technicalExpertise", true, false, 200),
          textRow("Reason for job Change", "reasonForChange", true, false, 200),
          textRow("Preferred Work Location?", "preferredLocation", true),
          radioRow("Are you open to work from office(Hybrid Model)?", "officeHybrid", true),
          textRow("Do you have any Bond/Obligation with Current Organization?", "bondObligation", true, false, 200),
          radioRow("Have you been associated previously with T-Systems ICT India Pvt Ltd ?", "previousAssociation", true),
          textRow("Are you flexible to work in Rotational and Night Shifts?", "shiftFlexibility", true, false, 200),
          textRow("Please mention your Notice Period.", "noticePeriod", false),
          textRow("Do you have Notice Period Buyout?", "noticeBuyout", true, false, 200),
          textRow("Aadhar Card Number?", "aadhar", false, false, 200),
          textRow("What is your current CTC?", "currentCtc", true, false, 200),
          textRow("What is the expected CTC?", "expectedCtc", false, false, 200),
          checkboxRow("You declare that you have read and agree to the privacy notice of T-Systems ICT India Pvt. Ltd..", "privacyConsent", true)
        ].join("");

        for (const input of form.querySelectorAll("input[data-key]")) {
          input.addEventListener("input", (event) => {
            state[event.target.dataset.key] = event.target.value;
          });
          input.addEventListener("change", (event) => {
            if (event.target.type === "radio" && event.target.checked) {
              state[event.target.name] = event.target.value;
            } else if (event.target.type === "checkbox") {
              state[event.target.dataset.key] = event.target.checked ? "Yes" : "";
            }
          });
        }
      }

      function textRow(label, key, required, search = false, max = undefined) {
        const value = escapeHtml(state[key] || "");
        return \`
          <sr-question-field-text class="row">
            <div class="question">\${label}\${required ? " *" : ""}</div>
            <input type="text" data-key="\${key}" value="\${value}" \${search ? "role='combobox' aria-autocomplete='list'" : ""} \${max ? \`maxlength="\${max}"\` : ""}>
            \${max ? \`<div class="counter">\${value.length}/\${max}</div>\` : ""}
          </sr-question-field-text>
        \`;
      }

      function radioRow(label, key, required) {
        return \`
          <sr-question-field-radio class="row">
            <div class="question">\${label}\${required ? " *" : ""}</div>
            <label><input type="radio" name="\${key}" data-key="\${key}" value="Yes" \${state[key] === "Yes" ? "checked" : ""}> Yes</label>
            <label><input type="radio" name="\${key}" data-key="\${key}" value="No" \${state[key] === "No" ? "checked" : ""}> No</label>
          </sr-question-field-radio>
        \`;
      }

      function checkboxRow(label, key, required) {
        return \`
          <sr-question-field-checkbox class="row">
            <label><input type="checkbox" data-key="\${key}" value="Yes" \${state[key] ? "checked" : ""}> \${label}\${required ? " *" : ""}</label>
          </sr-question-field-checkbox>
        \`;
      }

      function escapeHtml(value) {
        return String(value)
          .replace(/&/g, "&amp;")
          .replace(/"/g, "&quot;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
      }

      render();
    </script>
  </body>
</html>`;
}

function assertFieldOwner(fields: Awaited<ReturnType<typeof discoverStructuredVisibleFields>>, label: string) {
  const field = fields.find((item) => normalizeForAssert(item.label) === normalizeForAssert(label));

  assert.ok(field, `expected to discover field "${label}"`);
  assert.equal(
    normalizeForAssert(field.ownerLabelText ?? field.label),
    normalizeForAssert(label),
    `"${label}" should own its own control, got owner "${field.ownerLabelText}"`
  );
}

function normalizeForAssert(value: string) {
  return value
    .toLowerCase()
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function withTimeout<T>(label: string, promise: Promise<T>, timeoutMs: number) {
  let timeout: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
