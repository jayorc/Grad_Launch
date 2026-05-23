# GradLaunch

This directory is the dedicated workspace for the GradLaunch product.

Everything related to GradLaunch should live inside this folder, including:

- product and engineering docs
- frontend application code
- backend services
- automation workers
- scripts
- deployment files

## Current Structure

- `apps/api/`: Express + TypeScript backend for search sessions, job intake, applications, and dashboard reporting
- `apps/web/`: Next.js dashboard app for search, jobs, and application reporting
- `packages/shared/`: shared domain types and constants
- `gradlaunch-docs/`: product planning and architecture docs

## Implemented MVP Foundation

The current codebase includes:

- shared models for students, jobs, search sessions, applications, and dashboard reports
- MongoDB-backed persistence models for students, accounts, sessions, jobs, search sessions, applications, and runs
- optional seeded sample data for a demo student and multiple job sources
- live job search from public/registered sources instead of generated fake openings
- Chrome browser apply worker for supported job forms
- URL-first autonomous apply: paste a job URL, let GradLaunch prepare the package, and continue the browser flow in the background until submit or a real protected checkpoint
- Nodemailer confirmation flow with local outbox fallback
- API endpoints for:
  - `/health`
  - `/auth/login`
  - `/auth/register`
  - `/auth/resume-draft`
  - `/auth/session`
  - `/auth/logout`
  - `/agent/capabilities`
  - `/students/me`
  - `/students/me/profile`
  - `/students/me/resume`
  - `/students/me/dashboard`
  - `/jobs`
- `/jobs/intake-url`
- `/jobs/:jobId/fill-browser`
  - `/search-sessions`
  - `/applications`
  - `/applications/:applicationId/runs`
  - `/applications/:applicationId/submit`
- dashboard screens for:
  - overview metrics
  - active search sessions
  - pasted job URL intake
  - job listing and apply actions
  - application reporting
  - adapter capability reporting
  - saved run traces with filled fields and notes

## Local Run Plan

1. Install workspace dependencies from the `gradlaunch/` directory:
   - `npm install`
2. Copy env template and set real values:
   - `cp .env.example .env`
   - configure `JWT_SECRET`
   - set `DATA_MODE=mongo` for real Atlas persistence or keep `DATA_MODE=auto` for local fallback
   - if using Atlas, configure `MONGODB_URI`
   - set `SEED_DEMO_DATA=false` for real-product mode
   - keep `LIVE_JOB_SEARCH_ENABLED=true` for live search
   - optionally add `LIVE_GREENHOUSE_BOARDS=stripe,airbnb` or `LIVE_LEVER_COMPANIES=netlify,vercel`
   - set `BROWSER_AUTOFILL_ENABLED=true` and confirm `CHROME_EXECUTABLE_PATH`
2. Start the API:
   - `npm run dev:api`
3. In a second terminal, start the web app:
   - `npm run dev:web`
4. Open the dashboard:
   - `http://localhost:3000`

## Current Technical Assumptions

- production persistence is designed around MongoDB Atlas
- `DATA_MODE=auto` will fall back to in-memory storage when Atlas is unreachable during local development
- authentication uses hashed passwords plus signed bearer tokens stored in browser session storage
- set `SEED_DEMO_DATA=true` if you want the demo account and sample job/application data inserted automatically
- set `SEED_DEMO_DATA=false` for real usage so dashboards start from live searches, pasted URLs, and MongoDB data
- live search currently fetches Remotive public remote jobs by profile query, configured Greenhouse boards, configured Lever companies, and direct URLs from `LIVE_JOB_URLS`
- resume upload is supported for signup-prefill and profile refresh; uploads are stored in `RESUME_STORAGE_DIR`
- AIHawk local adapter detection is supported via `AIHAWK_REPO_PATH`
- every application run also writes a structured package to `APPLICATION_ARTIFACT_STORAGE_DIR`
- notifications use Nodemailer when SMTP variables are configured, otherwise receipts are saved in `EMAIL_OUTBOX_DIR`
- browser autofill first tries a logged Chrome session/profile (`BROWSER_LOGGED_CDP_URL` or `BROWSER_LOGGED_PROFILE_DIR`), then falls back to the persistent managed GradLaunch Chrome profile; run `npm run browser:prepare-logged-profile` after quitting Chrome to refresh the GradLaunch-owned logged profile copy, and set `BROWSER_REQUIRE_LOGGED_PROFILE=true` to prevent fallback to an empty managed session
- background autopilot can queue a browser run behind the API request, and the Applications page will keep refreshing while that run is active
- browser runs open Chrome visibly by default because `BROWSER_HEADLESS=false`; set it to `true` only for automated tests

## Demo Account

When `SEED_DEMO_DATA=true`, the API will create:

- email: `aarav@example.com`
- password: `gradlaunch123`

## Working Rule

If we build GradLaunch further, new files and folders should be created inside this directory instead of at the workspace root.
