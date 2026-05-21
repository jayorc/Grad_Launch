# GradLaunch Decision Log

## Current Decisions

### Product Name

- decision: `GradLaunch`
- reason: clear student-first positioning and strong launch/career meaning

### Database

- decision: `MongoDB`
- reason: flexible document model for job payloads, ATS-specific fields, student profiles, and application artifacts
- note: we may still add a search or vector layer later if needed

### Email

- decision: `Nodemailer` with `AWS SES`
- reason: simple Node integration with production-grade sending infrastructure

### Core UX

- decision: make "Paste Job URL" a first-class workflow
- reason: it gives immediate user value even before we build large job ingestion pipelines

### Search UX

- decision: support time-boxed active search runs triggered by the student
- reason: this gives the user an immediate "search now" experience instead of relying only on background ingestion

### Match Controls

- decision: let the student choose match strictness with broad, balanced, and strict modes
- reason: different students will want either more opportunities or tighter-fit recommendations

### Dashboard Reporting

- decision: provide a structured student dashboard with application history, fill activity, statuses, and failure details
- reason: the user needs a reliable source of truth for what GradLaunch has done and what still needs action

### Automation Policy

- decision: use review-gated automation for supported flows
- reason: this is more robust and safer than blind autonomous submission

### Assessment Policy

- decision: do not build real assessment-taking automation
- reason: low robustness, high policy risk, and misaligned with trustworthy product positioning

## Open Decisions

- whether to use `Temporal` in MVP or add it after launch
- whether to use vector search inside MongoDB Atlas or a separate service
- whether to use `NestJS` or lightweight `Express/Fastify` first
- whether to support college placement admins in v1 or v2

## Update Rule

Whenever we make a major architecture or scope decision, we should add it here before implementing a conflicting direction.
