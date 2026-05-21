# GradLaunch User Workflows

## Workflow 1: Onboarding

1. Student signs up
2. Student uploads resume
3. Student adds role, location, salary, and skill preferences
4. Student chooses automation mode:
   - alerts only
   - draft and review
   - autofill supported forms with review
   - full autopilot with handoff only for protected checkpoints
5. Student verifies email

## Workflow 2: Paste Job URL

1. Student pastes a job opening URL
2. GradLaunch fetches the page
3. GradLaunch identifies the page type:
   - supported ATS
   - generic job page
   - unsupported or blocked page
4. GradLaunch extracts job data
5. GradLaunch scores fit for the student
6. GradLaunch creates tailored application materials
7. If supported, GradLaunch launches a background autopilot run or a guided autofill run
8. Student receives email status

## Workflow 3: Active Search Session

1. Student clicks search
2. Student selects search duration and match strictness:
   - broad
   - balanced
   - strict
3. GradLaunch runs job discovery for a few minutes across supported sources
4. Jobs are normalized and deduplicated during the run
5. Matching service ranks results using the selected strictness
6. Student receives a list of recommended jobs from that session
7. Student can choose to draft, use guided autofill, or launch full autopilot on supported applications

## Workflow 4: Scheduled Job Discovery

1. Connectors ingest new jobs on a schedule
2. Jobs are normalized and deduplicated
3. Matching service scores jobs against student profiles
4. High-fit jobs trigger email alerts
5. Student opens dashboard and chooses whether to continue

## Workflow 5: Application Submission

1. Student picks a matched job
2. GradLaunch prepares a tailored application package
3. Playwright opens a new controlled tab in the persistent managed GradLaunch browser session, fills form fields on supported pages, and continues in the background by default
4. System pauses at:
   - captcha
   - OTP
   - e-sign
   - unclear mandatory fields
   - assessments
5. For login or OTP, control moves to the student in the live browser window
6. After the checkpoint clears, GradLaunch resumes filling automatically
7. Student only reviews and intervenes when the portal truly requires it; otherwise GradLaunch submits automatically
8. GradLaunch records the result and emails confirmation
9. If the browser closes or the student leaves, GradLaunch can reopen from the latest saved checkpoint

## Workflow 6: Dashboard Reporting

1. Student opens dashboard
2. GradLaunch shows a structured report of:
   - jobs discovered
   - jobs shortlisted
   - applications drafted
   - applications autofilled
   - submitted applications
   - blocked or failed applications
3. Each application row shows:
   - company
   - role
   - source
   - match score
   - current status
   - last updated time
4. Student can open an application to view:
   - filled fields
   - uploaded documents
   - generated answers
   - screenshots or failure reason
5. Student uses the dashboard to continue, review, or retry

## Workflow 7: Failure Handling

1. Extraction fails or form structure changes
2. System marks run as partial or failed
3. Student gets a fallback email with:
   - job summary
   - extracted fields
   - generated answers
   - manual next step
4. Event is logged for future parser improvements
