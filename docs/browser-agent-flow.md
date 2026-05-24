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
      answer.ts                    # Deterministic + LLM answer selection
      fill.ts                      # Actually fills fields and uploads resume
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
12. `buildStageExecutionPlan()` decides whether the page needs login, resume upload, normal filling, next-step click, review, or submit.
13. If the stage has fields, `buildStageAnswerPlan()` creates answers from deterministic profile/resume data and optionally asks the LLM.
14. `fillFormField()` fills text/select/radio/checkbox/autocomplete-style fields.
15. `attachResume()` uploads the latest stored resume when a resume/CV upload input is detected.
16. The engine checks missing required fields and validation messages. If needed, `reflectOnStageAnswers()` asks the LLM for a retry plan.
17. The engine either clicks next, pauses for manual help, stops at review, submits if allowed, or saves a receipt.

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
  -> discoverVisibleFields()
  -> observeBrowserPage()
  -> buildStageExecutionPlan()
  -> attachResume()
  -> buildStageAnswerPlan()
  -> fillFormField()
  -> reflectOnStageAnswers() if required fields still fail
  -> clickNextStageControl() or stop/submit
```

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
