# GradLaunch Risks and Robustness

## Technical Robustness

### Strong Areas

- profile and resume management
- email notification flows
- job extraction from known ATS providers
- application tracking and audit logs
- tailored draft generation

### Medium-Risk Areas

- generic HTML job page extraction
- autofill on sites with frequent UI changes
- file upload handling across different form implementations
- duplicate detection across multiple job sources

### High-Risk Areas

- unsupported site automation at scale
- anti-bot defenses
- captchas and OTP-gated flows
- assessment platforms with integrity checks

## Product Feasibility

### Highly Feasible

- job discovery
- paste-link intake
- fit scoring
- draft generation
- email alerts
- dashboard-based tracking

### Feasible With Controlled Scope

- autofill for selected ATS flows
- semi-automated application pipelines
- retry and recovery workflows

### Not Recommended

- universal apply-anywhere automation
- automated real assessment completion
- impersonation-style identity actions

## Legal and Policy Considerations

- use official APIs where possible
- avoid platform behavior that clearly violates terms
- keep student consent and action logs
- pause on protected checkpoints instead of trying to bypass them

## Robustness Strategy

- adapter-based parsers instead of one giant scraper
- review gate before high-impact actions
- idempotent application runs
- observability with screenshots and event logs
- graceful fallback to "draft only" mode

## Recommended Reliability Principles

- every automation run must be resumable
- every protected checkpoint should support human handoff and agent resume
- every generated artifact must be auditable
- every failure should create a useful manual fallback
- every external integration should have a timeout and retry policy
