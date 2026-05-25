# Browser Agent Map

This folder holds the GradLaunch browser-application runtime.

## Core Flow

- `engine.ts`: outer browser lifecycle, handoffs, stage loop, and final receipt
- `observe.ts`: DOM/page observation and protected-checkpoint detection
- `plan.ts` and `strategy.ts`: action ranking, readiness checks, and recovery decisions
- `answer.ts`: deterministic, profile, optional LLM, and reflection answer planning
- `fill.ts`: main field interaction layer
- `fill-engine.ts`: single stage-level fill engine and shared fill types
- `fill-field-graph.ts`: field discovery, classification, and ATS adapters
- `fill-field-drivers.ts` and `fill-answer-resolver.ts`: field interaction and answer resolution
- `ui.ts`: live in-browser bot and manual handoff controls
- `planner.ts` and `session.ts`: durable run trace and resume state
- `browser-driver.ts`: single third-party browser-driver boundary

There is one active stage-fill path in this folder: `fill-engine.ts`.
