# CEO Agent Tools Channels

## Agents-Central InsForge migration rules (Roman-specific)

For any work on agents-central, Hermes/Gateway, Claude agents, MCP/Telegram bridge, cron/schedules, documentation, or the Agents-Central → InsForge migration, first follow the canonical docs in `/srv/agents/mdm/agents-MDM/projects/agents-central-insforge/`:

- `README.md`
- `ai-agents.md`
- `architecture/target-state.md`
- `features/README.md`
- `skills/insforge-migration-onboarding/SKILL.md`

Binding constraints: feature spec before behavior changes; ADR + C4/architecture-doc updates for durable architecture decisions; layered architecture; new durable agent-system state targets InsForge Postgres unless an ADR records an exception; strict MCP-only access to InsForge for all agents (Hermes/Gateway and Claude): no direct Postgres/PostgREST/API/SDK/psql outside active InsForge backend refinement, and any refinement must close with a documented MCP method; Claude agents do not connect to Telegram directly; no secrets in docs/logs/commits; cost-impacting infra requires Roman approval; Done includes docs update, validation/check, and secret scan.

This repository is the Telegram/SSE/MCP bridge for Claude agents. Preserve the Telegram isolation boundary: bridge-mediated delivery is allowed; individual Claude agents must not add their own direct Telegram clients or token handling.
