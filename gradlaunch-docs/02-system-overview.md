# GradLaunch System Overview

## Recommended Initial Stack

- frontend: `Next.js`
- backend API: `Node.js` with `NestJS` or `Express`
- database: `MongoDB Atlas`
- email: `Nodemailer` with `AWS SES` as the sending provider
- browser automation: `Playwright`
- workflow orchestration: `Temporal` or a simpler queue-based worker in MVP
- object storage: `S3` for resumes and generated artifacts
- auth: `Clerk`, `Auth.js`, or Firebase Auth

## Why This Stack

- `MongoDB` fits flexible application payloads, ATS-specific fields, and document-heavy user profiles
- `Nodemailer` gives a familiar mail API while `SES` gives production-grade delivery
- `Playwright` is the best option for controlled browser automation
- `Next.js` gives us product UI and API-adjacent patterns quickly

## Core Services

### 1. Student Profile Service

Stores:

- personal profile
- education
- skills
- work preferences
- resume versions
- consent and automation settings

### 2. Job Intake Service

Accepts jobs from:

- ATS connectors
- active on-demand search runs
- pasted job URLs
- manual imports later

Responsibilities:

- classify source
- extract normalized job data
- store raw page data and normalized fields
- deduplicate repeated jobs

### 3. Matching Service

Scores job fit using:

- hard filters
- keyword and semantic matching
- custom rules such as location, visa, salary, and tech stack
- user-selected match strictness from broad to strict

### 3a. Search Session Service

Runs a time-boxed discovery session when the student clicks search.

Responsibilities:

- launch source queries for a fixed time window
- collect and normalize results during the session
- rank and deduplicate jobs
- return recommended jobs before the session ends
- persist the search run and its outputs for later review

### 4. Drafting Service

Generates:

- tailored resume suggestions
- cover letters
- short-answer drafts
- missing-information prompts

### 5. Application Automation Service

Uses Playwright to:

- open supported application flows
- map fields
- fill known values
- upload documents
- keep running in the background by default
- hand control to the student for login, OTP, captcha, or identity prompts
- resume the autonomous flow after the checkpoint clears
- persist planner checkpoints so a run can continue across sessions

### 5a. Planner and Checkpoint Service

Keeps a resumable plan for each browser run:

- goal
- subgoals
- current section
- retry count
- validation blockers
- manual handoff count
- resume token and checkpoint state

### 6. Notification Service

Sends:

- new job alerts
- application ready alerts
- approval requests
- submission confirmations
- failure and retry alerts

### 7. Audit and Tracking Service

Records:

- every automation run
- every generated draft
- status transitions
- screenshots, errors, and timestamps

### 8. Dashboard Reporting Service

Builds user-facing reports for:

- applications started
- applications autofilled
- submitted applications
- blocked or failed runs
- pending review items
- source of each job and last action taken

## High-Level Data Model

Main collections:

- `students`
- `student_profiles`
- `resumes`
- `jobs`
- `job_sources`
- `search_sessions`
- `job_matches`
- `applications`
- `application_runs`
- `application_reports`
- `draft_artifacts`
- `notifications`
- `audit_events`

## Architecture Flow

1. Student creates a profile and uploads resume
2. Student starts a search session or provides a job URL
3. Job intake normalizes and stores the discovered jobs
4. Matching service scores jobs using the selected strictness level
5. Drafting service prepares application artifacts
6. Automation service fills supported forms
7. If a protected checkpoint appears, control hands to the student and then returns to the agent
8. Tracking and reporting services store the outcome
9. Notification service updates the student
