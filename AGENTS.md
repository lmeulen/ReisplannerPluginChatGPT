# Working on the NS travel MVP

The public catalog is exactly `plan_journey`, `get_departures`, `get_disruptions`.
Keep station resolution internal and the plugin text-only. New tools require a
distinct traveler need; do not expose the upstream API catalog.

Read ARCHITECTURE.md and the relevant schema before editing. Put HTTP mechanics
in nsClient, provider parsing in nsPayloads, traveler decisions in workflows and
MCP registration in mcp. Shared contracts live in schemas.ts; infer types from
them. Preserve unknown facts as null, all travel legs and retrieval timestamps.

Use failing behavior tests for changed contracts and regressions. Verify with
`npm run validate`, `npm run types:check` and `npm run deploy:dry-run`. Regenerate
bindings after Wrangler changes. Never present fixtures, local smoke or metadata
checks as live NS connectivity or actual ChatGPT routing observations.

Use the integrations available for the task and parallel agents for independent
work, with distinct file ownership. Prefer Luna 6 Max for routine tasks and Sol
6.1 Medium through Extra High for complex work. Use Impeccable for UI design if
UI is separately requested. Granola notes older than 30 days live in Notion.
Keep user-facing text brief.

Do not deploy, change the existing NS plugin, upload/install a plugin, push or
publish without authorization. Keep credentials in untracked .dev.vars or
Worker secrets; never log raw travel inputs or credentials.
