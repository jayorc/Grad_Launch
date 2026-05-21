# GradLaunch MVP Plan

## MVP Goal

Launch a narrow but reliable first version of GradLaunch that helps a student go from job link to draft-ready application with email alerts.

## Phase 1: Foundation

- create student auth and profile
- upload and store resumes
- create job and application data model
- set up MongoDB, object storage, and email service
- add dashboard skeleton

## Phase 2: Job Intake

- implement "Paste Job URL"
- implement active search sessions with a fixed duration
- fetch and parse job pages
- support structured extraction from common job pages
- normalize and store job records
- deduplicate repeated pasted jobs

## Phase 3: Matching and Drafting

- implement fit scoring
- add user-controlled match strictness: broad, balanced, strict
- generate tailored summaries
- generate short-answer drafts
- generate cover letter draft
- allow student review and edit

## Phase 4: Notifications

- send email on job extraction success
- send email on draft readiness
- send email on automation block or failure
- send email on submission completion

## Phase 5: Autofill for Supported ATS

- add Playwright worker
- support first ATS adapter
- map form fields to profile data
- upload resume and cover letter
- pause on blocked steps

## Phase 6: Tracking and Hardening

- add audit events
- add retry logic
- add run screenshots
- add status dashboard
- add structured reporting for application history and fill activity
- add admin debug view

## Recommended First ATS Targets

1. Greenhouse
2. Lever
3. Ashby

## Explicit MVP Boundaries

We should not start with:

- every job board on the web
- LinkedIn automation
- full self-submitting mode across unknown sites
- real assessment completion
- multi-tenant enterprise features

## Deliverable at MVP End

The student can paste a job URL, receive an extracted job record, get tailored application drafts, use GradLaunch to autofill supported forms with a human review gate, and view a structured dashboard report of application activity.
