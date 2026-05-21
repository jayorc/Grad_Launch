# GradLaunch Docs

This folder is the source of truth for the GradLaunch product before implementation.

If we want to avoid drift and "hallucinated" features during development, we should use these docs as the contract:

- `01-product-charter.md`: what GradLaunch is, who it serves, and what is out of scope
- `02-system-overview.md`: the high-level architecture and major services
- `03-user-workflows.md`: how the product behaves from the student's point of view
- `04-mvp-plan.md`: what we build first, in order
- `05-risks-and-robustness.md`: technical, legal, and operational realities
- `06-decision-log.md`: explicit stack and product decisions
- `07-autonomous-agent-architecture.md`: migration plan from MVP autopilot to durable agent orchestration

Working rule:

1. Product scope comes from `01-product-charter.md`
2. Build scope comes from `04-mvp-plan.md`
3. Changes to product behavior should update the relevant doc first

Current proposed product name: `GradLaunch`
