# GradLaunch Browser Agent Flow

## WhatsApp Short Version

GradLaunch takes a pasted job URL, saves it as a `Job`, creates or reuses an `Application`, opens the real job page in Chrome, scans the visible fields, prepares answers from profile + resume + memory, optionally asks the LLM for better field matching, fills the form, uploads resume when a resume input is detected, pauses for login/captcha/manual questions, and saves screenshots/debug logs/receipt for review.

Main flow:

```text
Paste job URL
  -> Save Job
  -> Fill Browser API
  -> Build student/job/resume context
  -> Launch or attach Chrome
  -> Open job page
  -> Observe visible fields
  -> Decide action: login/upload/fill/next/review
  -> LLM + deterministic answers
  -> Fill fields and upload resume
  -> Validate required fields
  -> Continue, pause, submit, or save receipt
```

## Folder Structure Snapshot

Important files only:

```text
gradlaunch/
  apps/api/src/routes/
    job-routes.ts                  # POST /jobs/intake-url
    application-routes.ts          # POST /jobs/:jobId/fill-browser

  apps/api/src/services/
    job-intake-service.ts          # Validates/saves pasted job URL
    application-service.ts         # Builds Application + prepared fields
    aihawk-adapter-service.ts      # Hands browser work to BrowserApplyService
    browser-apply-service.ts       # Thin wrapper around BrowserAgentEngine

    browser-agent/
      engine.ts                    # Main browser loop/orchestrator
      observe.ts                   # Reads visible fields, buttons, page state
      plan.ts                      # Chooses next action for the current stage
      strategy.ts                  # Classifies page state, ranks actions, plans recovery
      answer.ts                    # Deterministic + LLM answer selection
      fill.ts                      # DOM-first field type detection + field-specific fill strategies
      autonomous-fill.ts           # Multi-round fill -> verify -> repair loop
      reflect.ts                   # LLM retry when required fields fail
      session.ts                   # Saves live browser execution session
      util.ts                      # Debug logging + helpers

  apps/api/src/config/
    storage.ts                     # storage/applications, storage/browser, profiles

  storage/
    resumes/                       # Uploaded resume files
    applications/<application-id>-<company>-<role>/
      browser-agent-debug.log      # Step-by-step debug events
      browser-opened.png           # Screenshots from the run
      browser-*.png
      run_trace.json               # Final trace package
      planner_checkpoint.json      # Planner state/checkpoint
      submission_receipt.json      # Saved receipt when available

    browser/                       # Browser workspace if no app workspace passed
    browser-profile/               # Managed GradLaunch Chrome profile
    logged-browser-profile/        # GradLaunch-controlled persistent login profile
```

## High-Level Dry Run

1. User pastes a job URL in the app.
2. API receives `POST /jobs/intake-url` in `apps/api/src/routes/job-routes.ts`.
3. `JobIntakeService.intakeFromUrl()` validates the URL, rejects old demo URLs, tries to parse the real job page, then saves a `Job`. If parsing fails, it still saves a fallback job using the pasted `sourceUrl`.
4. User starts browser filling.
5. API receives `POST /jobs/:jobId/fill-browser` in `apps/api/src/routes/application-routes.ts`.
6. `ApplicationService.fillJobInBrowser()` loads student, job, existing application, resume, memory, and browser capability.
7. `buildFilledFields()` prepares known values like name, email, phone, city, location, country, LinkedIn, salary, authorization, and short answers.
8. `AihawkAdapterService.applyWithBrowser()` passes the package into the browser worker.
9. `BrowserApplyService.apply()` delegates to `BrowserAgentEngine.apply()`.
10. `BrowserAgentEngine` checks Chrome availability, creates the workspace folder, launches or attaches Chrome, and opens the job `sourceUrl`.
11. On every stage, it scans visible fields with `discoverVisibleFields()` and builds a page observation with `observeBrowserPage()`.
12. `classifyPage()` and `rankActions()` score the page as login, captcha, resume upload, form fill, validation error, loading, review, submit, start, or unknown.
13. `buildStageExecutionPlan()` chooses the safest action from those scores: ask user, wait, explore, upload resume, fill, click next, stop, or submit.
14. If login/CAPTCHA/account verification is visible, the engine stops filling completely and waits for the user to click `I am logged in, continue`.
15. If a resume upload is visible, `attachResume()` uploads the latest stored resume using direct file input, upload trigger, or file chooser fallback.
16. If the stage has fields, `runAutonomousStageFill()` starts the autonomous solver.
17. `buildStageAnswerPlan()` creates answers from deterministic profile/resume data and optionally asks the LLM for semantic matching.
18. `fillFormField()` detects the real DOM control type and routes to text, native select, custom select, autocomplete, radio, checkbox, date, or file-safe behavior.
19. The solver verifies each field after filling. Failed required/profile fields go through a repair pass before the engine is allowed to click Continue.
20. The engine re-checks missing required fields, validation messages, pending resume uploads, and current-page completion guards.
21. The engine either clicks next, pauses for manual help, stops at review, submits if allowed, or saves a receipt.

## Code Execution Chain

```text
POST /jobs/intake-url
  apps/api/src/routes/job-routes.ts:15
    -> JobIntakeService.intakeFromUrl()
       apps/api/src/services/job-intake-service.ts:15

POST /jobs/:jobId/fill-browser
  apps/api/src/routes/application-routes.ts:78
    -> ApplicationService.fillJobInBrowser()
       apps/api/src/services/application-service.ts:154
       -> buildFilledFields()
          apps/api/src/services/application-service.ts:791
       -> AihawkAdapterService.applyWithBrowser()
          apps/api/src/services/aihawk-adapter-service.ts:184
       -> BrowserApplyService.apply()
          apps/api/src/services/browser-apply-service.ts:196
       -> BrowserAgentEngine.apply()
          apps/api/src/services/browser-agent/engine.ts:133
```

Browser stage loop:

```text
BrowserAgentEngine.apply()
  -> getAvailability() / launchContext()
  -> navigateToJobPage()
  -> detectProtectedCheckpoint()
  -> waitForLoginConfirmation() if login is visible
  -> discoverVisibleFields()
  -> observeBrowserPage()
  -> classifyPage() / rankActions()
  -> buildStageExecutionPlan()
  -> attachResume()
  -> runAutonomousStageFill()
     -> buildStageAnswerPlan()
     -> fillFormField()
        -> resolveFillStrategy()
        -> fillByClassifiedControl()
        -> fillClassifiedNativeSelect() / fillClassifiedSelectLike()
        -> fillClassifiedAutocomplete() / fillClassifiedChoice()
        -> commitTextLikeLocator()
     -> verifyFieldAnswer()
     -> verifyAndRepairKnownFields()
  -> reflectOnStageAnswers() if required fields still fail
  -> evaluateStageReadiness()
  -> clickNextStageControl() or stop/submit
```

## Current Agent Architecture

```text
Observer
  -> Reads fields, controls, validation, page text, progress, protected gates

Strategy
  -> Classifies page state
  -> Ranks safe actions
  -> Builds recovery plans for validation/upload/missing-required failures

Answer Planner
  -> Uses profile, resume, job, and memory first
  -> Uses LLM only when enabled and useful for semantic matching/writing
  -> Rejects unsafe personal-data hallucinations

Fill Executor
  -> Detects actual DOM control kind
  -> Chooses text/select/autocomplete/choice/date/file-safe strategy
  -> Commits values through browser-like events

Verifier + Repair
  -> Re-reads the live DOM
  -> Checks required fields, invalid state, selected options, committed widget text
  -> Retries failed known fields before navigation

Engine
  -> Owns Chrome/session/workspace
  -> Pauses on login/CAPTCHA
  -> Runs one stage at a time
  -> Saves screenshots, debug logs, planner checkpoint, and receipt
```

## Field Filling Strategy

The browser agent should not use typing for every field. `fill.ts` follows this routing model:

```text
Normalize answer
  -> Resolve strategy from declared field type + live DOM inspection
  -> If file: skip normal fill and let attachResume() handle it
  -> If country/location: use strict select/autocomplete matching
  -> If native select: select option by value/label and verify selection
  -> If custom select: open widget, click option, type query only if needed
  -> If autocomplete: type query, wait for suggestions, select matched suggestion
  -> If radio/checkbox: score choices in the group and click one label/wrapper
  -> If date/text: type/fill/set native value and dispatch input/change/blur
  -> Verify committed result
```

This is why the important files are split:

```text
answer.ts
  decides "what value should this field have?"

fill.ts
  decides "what kind of control is this and how should it be interacted with?"

autonomous-fill.ts
  decides "did the page accept the value, and should we repair it?"
```

## Login Handoff Strategy

Login is deliberately manual and explicit:

```text
Open job URL in controlled persistent Chrome profile
  -> Detect login/account gate
  -> Stop all filling/observing-as-action
  -> Show user handoff in the same Chrome window
  -> User completes Google/email/MFA manually
  -> User clicks "I am logged in, continue"
  -> Re-detect protected checkpoint
  -> Resume stage loop only if the real form is visible
```

This avoids the earlier failure mode where the bot kept acting while the user was typing credentials or changing pages.

## Where The LLM Is Called

Primary answer planning:

```text
apps/api/src/services/browser-agent/answer.ts
  buildStageAnswerPlan()           # line 17
  askLlmForStageAnswers()          # line 587
  callOpenAiCompatible()           # line 670
```

The LLM call uses:

```text
OPENAI_API_KEY
OPENAI_BASE_URL or https://api.openai.com/v1/chat/completions
OPENAI_MODEL or LLM_MODEL or gpt-4o-mini
```

Reflection/retry LLM call:

```text
apps/api/src/services/browser-agent/reflect.ts
  reflectOnStageAnswers()          # line 16
  callOpenAiCompatible()           # line 101
```

LLM is only used for answer planning when `LLM_ANSWER_ENABLED=true` and `OPENAI_API_KEY` exists. If it fails or is disabled, the agent falls back to deterministic answers from profile, resume, job, and memory.

## Important Behavior Notes

Location and country are prepared before the browser starts in `buildFilledFields()`. The current logic resolves location from profile, job, resume text, phone, and defaults; country eventually falls back to `India`.

Autocomplete/search-select location fields are handled inside `fillFormField()` by select-like and autocomplete-aware flows. This matters because typing text alone is often not enough; the matching option usually has to be selected.

Checkbox/radio behavior is centralized in `fill.ts`. Country choice groups have special handling so the agent should select only the matching country option instead of toggling every checkbox.

Resume upload is handled by `attachResume()` in `fill.ts`. It first checks if a file is already attached, then scores file inputs by labels like resume/CV/upload/pdf and avoids cover-letter/photo fields.

Login panels are treated as protected checkpoints before filling starts. GradLaunch opens the job URL in a controlled persistent Chrome profile, then fully pauses if a login/account gate is visible. The user completes Google/email/MFA in that same controlled Chrome window and GradLaunch resumes only after the user clicks `I am logged in, continue`. GradLaunch does not clone cookies or attach to an uncontrolled browser by default.

GradLaunch cannot reuse the app website's own Google sign-in session for external job portals because those OAuth cookies are scoped to Google/the portal domains, not the GradLaunch domain. The safe reusable path is the controlled logged Chrome profile, which preserves Google cookies for third-party `Sign in with Google` flows.

## Runtime Artifacts To Check

When debugging a run, first check the application workspace:

```text
storage/applications/<application-id>-<company>-<role>/
```

Useful files:

```text
browser-agent-debug.log      # best file for why a field was/was not filled
planner_checkpoint.json      # current planner state
run_trace.json               # final packaged execution trace
submission_receipt.json      # final result when saved
browser-*.png                # screenshots at important stages
```

Do not share `.env`, API keys, resume files, or full storage folders externally. For WhatsApp sharing, this doc and sanitized screenshots/log snippets are safe.
