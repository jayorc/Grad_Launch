# GradLaunch Autonomous Agent Architecture

## Purpose

This document describes how GradLaunch should evolve from its current "background autopilot" MVP into a durable, policy-driven, autonomous agent system.

The goal is not "blind automation." The goal is trustworthy autonomous execution with:

- clear student goals
- durable planning
- tool-aware execution
- resumable workflows
- hard safety and policy boundaries
- full auditability

## Current Baseline

GradLaunch already has the beginnings of an agent:

- job intake from URLs and live search
- matching and draft generation
- application package creation
- a browser worker with checkpointing and manual handoff
- application runs, timelines, screenshots, and receipts

Today, however, the autonomous path is still limited because:

- autopilot is launched in-process with `setTimeout`
- planning is mostly local to the browser apply flow
- there is no durable cross-job goal planner
- there is no queue-backed orchestration layer
- there is no long-term memory or policy engine
- there is no central task ledger for retries, leases, or agent recovery

## Target Product Definition

GradLaunch should become an autonomous job-search and application agent that can:

1. Understand a student's job-seeking goal and constraints
2. Continuously discover and prioritize opportunities
3. Decide what work to do next
4. Prepare application packages without constant prompting
5. Execute browser workflows across safe checkpoints
6. Pause only when policy, trust, or missing data requires human action
7. Resume from durable state after crashes, restarts, or user absence
8. Explain every action it took and why

## Operating Principles

### 1. Policy Before Autonomy

The system must never treat "can attempt" as "should attempt."

Every action should be checked against:

- student consent
- platform policy
- portal risk level
- confidence threshold
- missing-data threshold
- action impact level

### 2. Durable State Over Ephemeral Loops

No critical automation should depend on process memory alone.

Plans, tasks, checkpoints, retries, and handoffs must survive:

- API restarts
- worker crashes
- browser crashes
- deployment rollouts

### 3. Specialist Agents, Not One Giant Agent

The system should be decomposed into narrow agent roles instead of one large planner prompt.

Recommended agent roles:

- discovery agent
- ranking agent
- application planner
- drafting agent
- browser executor
- recovery agent
- notification agent
- policy guard

### 4. Human Handoff Is a First-Class Capability

Manual intervention is not a failure. It is part of the core design.

GradLaunch should pause for:

- login or account creation
- OTP or captcha
- identity verification
- signature or legal acknowledgement
- missing or ambiguous required answers
- any step that violates configured trust policy

### 5. Every Action Must Be Explainable

The student should always be able to answer:

- what is the agent doing now
- what did it do already
- why did it choose this job
- why did it stop
- what does it need from me

## Recommended Architecture

### Layer 1: Product API and UI

Keep the current `apps/web` and `apps/api` structure, but make the API the control plane rather than the place where long-running autonomy actually happens.

Responsibilities:

- auth and profile management
- automation preferences and consent
- dashboard state
- user-triggered commands
- displaying agent state and explanations

### Layer 2: Agent Control Plane

Add a dedicated orchestration layer responsible for:

- creating goals
- decomposing goals into tasks
- scheduling work
- assigning work to workers
- tracking task state
- retrying safely
- resuming from checkpoints

This should become the source of truth for autonomous execution.

Suggested core concepts:

- `goal`: a student-level objective such as "find and apply to backend roles this week"
- `plan`: the current strategy for that goal
- `task`: a concrete unit of work such as "parse this job URL" or "resume application run"
- `run`: one execution attempt of a task
- `checkpoint`: resumable state captured mid-execution
- `handoff`: a waiting state that requires user action

### Layer 3: Durable Workflow Engine

Move long-running and retry-heavy work out of `setTimeout` and into a durable workflow system.

Recommended options:

1. `Temporal`
2. A queue plus worker model as an intermediate step

If speed matters most, start with a queue-backed worker system now and keep the interfaces Temporal-friendly.

Responsibilities:

- queued execution
- retries with backoff
- task leases and heartbeats
- timeout handling
- delayed jobs
- resumable state transitions
- worker crash recovery

### Layer 4: Specialized Workers

Workers should own bounded responsibilities.

Recommended worker groups:

- `discovery-worker`
  - runs scheduled searches
  - ingests live job sources
  - deduplicates and stores candidates

- `intake-worker`
  - classifies job URLs
  - fetches raw pages
  - extracts structured job data

- `ranking-worker`
  - scores jobs against profile, memory, and user preferences
  - decides shortlist priority

- `drafting-worker`
  - produces tailored resume summaries, cover letters, and short answers
  - identifies missing information

- `application-planner-worker`
  - creates a per-application execution plan
  - selects whether to draft, autofill, auto-submit, or hold

- `browser-worker`
  - runs Playwright
  - restores checkpoints
  - fills forms
  - detects gates
  - emits structured observations

- `recovery-worker`
  - handles stuck runs
  - retries failed tasks
  - escalates when confidence drops

- `notification-worker`
  - sends emails and in-app alerts
  - creates user action requests

### Layer 5: Agent Memory and Knowledge

Add a memory layer so the agent can make better decisions over time.

Separate memory into three types:

- `profile memory`
  - stable student facts
  - resume history
  - role preferences
  - salary and visa constraints

- `working memory`
  - current goals
  - active search themes
  - open blockers
  - current application state

- `episodic memory`
  - prior applications
  - portal-specific failures
  - repeated rejection patterns
  - successful resume variants

Important rule:

Raw LLM conversation logs should not be the system of record. Structured state should.

### Layer 6: Policy and Trust Engine

Create a dedicated policy evaluator that is checked before high-impact actions.

Inputs:

- student automation mode
- site type and portal risk
- confidence score
- presence of protected checkpoint
- missing required information
- action type

Outputs:

- allow
- allow with review
- pause for user
- block entirely

Example policy decisions:

- submit on known ATS with high confidence: allow
- submit on unknown custom portal with weak field mapping: allow with review
- continue after captcha appears: pause for user
- complete an assessment automatically: block entirely

### Layer 7: Observability and Audit

GradLaunch already stores timelines and screenshots. Expand this into a formal observability model.

Recommended event types:

- goal created
- task queued
- task started
- planner decision made
- tool called
- browser observation captured
- checkpoint saved
- handoff requested
- task failed
- task retried
- task completed
- submission confirmed

This data should support:

- student-facing explanations
- internal debugging
- reliability analytics
- future training and evaluation

## Suggested Data Model Additions

The current collections are a good base, but a fully agentic system should add:

- `goals`
- `plans`
- `tasks`
- `task_runs`
- `checkpoints`
- `handoffs`
- `agent_events`
- `portal_profiles`
- `student_preferences_history`
- `policy_decisions`

### Notes on Existing Models

The current `applications`, `application_runs`, and `search_sessions` tables can remain. They should become part of the larger orchestration model instead of carrying the whole autonomy burden alone.

## Recommended Decision Flow

For each student, the agent loop should look like this:

1. Read student policy, profile, and current goals
2. Refresh discovery tasks on a schedule
3. Rank newly discovered jobs
4. Decide whether each job is:
   - ignore
   - alert only
   - draft
   - prepare for review
   - apply autonomously
5. Build or refresh the application plan
6. Execute the next safe task
7. Save checkpoint after every external side effect
8. If blocked, create a handoff request
9. Resume automatically after the handoff clears
10. Record outcome and update memory

## Migration Plan

### Phase A: Stabilize the Existing Autopilot

Goals:

- keep current features working
- remove in-process fragility

Tasks:

- replace `setTimeout` background autopilot with queue-backed jobs
- introduce durable task records for application runs
- add worker heartbeat, timeout, and retry metadata
- separate API request lifecycle from background execution lifecycle

### Phase B: Extract the Planner

Goals:

- move from browser-local planning to application-level planning

Tasks:

- create an `ApplicationPlannerService`
- generate explicit next-step tasks before browser execution
- persist planner decisions outside the browser worker
- store confidence, rationale, and policy result per decision

### Phase C: Add Goal-Level Autonomy

Goals:

- support ongoing autonomous job search, not only per-job execution

Tasks:

- add `Goal` and `Task` models
- support recurring search schedules
- auto-shortlist jobs based on user policy
- create agent-driven recommendations and application queues

### Phase D: Add Memory and Learning Loops

Goals:

- make the agent improve from prior runs

Tasks:

- store portal-specific failure patterns
- track successful answer variants
- store student corrections and preference changes
- feed these signals back into ranking, drafting, and policy

### Phase E: Add Reliability Tooling

Goals:

- operate safely at larger scale

Tasks:

- dead-letter queue
- stuck-run detector
- replay tooling for failed runs
- admin event explorer
- evaluation harness for planner and browser outcomes

## Near-Term Codebase Changes

The lowest-risk next implementation steps in this repo are:

1. Add domain models for `Goal`, `Task`, `TaskRun`, and `Handoff`
2. Introduce an `AgentOrchestratorService` in `apps/api/src/services`
3. Replace `activeAutopilotApplications` plus `setTimeout` with a queue-backed worker entrypoint
4. Split current autopilot into:
   - package generation
   - planning
   - browser execution
   - submission confirmation
5. Emit structured agent events from each stage
6. Add dashboard views for:
   - active goals
   - pending handoffs
   - blocked tasks
   - autonomous decision history

## Boundaries We Should Keep

Even in a "completely autonomous" direction, GradLaunch should not cross these boundaries:

- no captcha bypass
- no OTP interception
- no fake identity actions
- no assessment cheating
- no hidden submission without user consent policy
- no unlogged side effects

## Architecture Recommendation

Recommended target path:

1. Keep the current API and dashboard
2. Add a durable orchestration layer
3. Treat the browser worker as one specialist executor
4. Introduce a policy engine before any high-impact action
5. Add goal/task/memory primitives before making the prompts more complex

This path gives GradLaunch a real autonomous backbone instead of a fragile "bigger prompt" approach.
