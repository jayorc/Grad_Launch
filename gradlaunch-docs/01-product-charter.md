# GradLaunch Product Charter

## Vision

GradLaunch is an AI-assisted job application copilot for students and early-career candidates.

Its job is to help a student:

- discover matching job openings
- run an on-demand active search for a few minutes
- paste a job link and extract the opening details and fills it
- tailor resume and application answers
- autofill supported application forms
- keep a structured dashboard report of applications and fill activity
- notify the student by email about matches, drafts, review steps, and submissions

## Problem Statement

Students miss strong opportunities because job discovery, filtering, tailoring, and repetitive form filling take too much time.

GradLaunch reduces this repetitive effort while keeping the student in control of identity-sensitive and high-risk steps.

## Target Users

- final-year students
- recent graduates
- bootcamp graduates
- college placement cells
- career coaches helping many students

## Core Goals

- help students apply faster without lowering application quality
- centralize job matching and application tracking
- give the student a clear dashboard showing where they applied, what was filled, and current status
- let the student trigger a search session and receive recommended jobs from that run
- let the student control how strict or broad matching should be
- support "paste job URL" as a first-class entry point
- generate tailored application drafts with minimal manual rewriting
- keep a clear audit trail of what the system did

## Non-Goals

GradLaunch will not:

- impersonate a student in interviews
- take real hiring assessments on the student's behalf
- bypass captchas, OTP, identity checks, or platform protections
- promise reliable automation on every job site on the internet

## Product Principles

- student-first control: high-risk steps require review or consent
- compliance-aware automation: use official APIs where possible
- transparent actions: every action is logged and explainable
- graceful fallback: if a site is unsupported, GradLaunch still extracts data and prepares a draft

## Success Metrics

- time saved per application
- match-to-apply conversion rate
- percentage of jobs successfully extracted from pasted links
- search-session result quality and click-through rate
- dashboard engagement and application-status accuracy
- percentage of applications completed without manual rewriting
- email alert delivery success rate
- user approval rate for generated drafts

## v1 Scope

Included:

- student profile
- resume upload
- job ingestion from supported sources
- on-demand active search sessions
- adjustable match strictness
- "Paste Job URL" flow
- job matching and ranking
- tailored resume and answer drafting
- email alerts
- application tracking dashboard
- structured reporting for filled and submitted applications
- limited autofill for supported ATS flows

Not included in v1:

- mobile app
- recruiter CRM
- college admin multi-tenant controls
- interview bot
- assessment-taking automation
