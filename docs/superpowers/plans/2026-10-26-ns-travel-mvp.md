# NS Travel MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Deliver a maintainable, text-only NS plugin with exactly three tools and a focused discovery skill.

**Architecture:** Keep the existing TypeScript Worker, Hono and official MCP SDK. Separate validated domain contracts, a small NS client, workflows and stateless transport. Package the skill independently; require a verified endpoint before producing a connectable archive.

**Tech Stack:** TypeScript, Zod, MCP SDK, Hono, Cloudflare Workers, Vitest, Node.js 22+.

**Spec:** `docs/superpowers/specs/2026-10-26-ns-travel-mvp-design.md`

## Global Constraints

- Exactly `plan_journey`, `get_departures`, `get_disruptions`; read-only, no UI resources.
- Planning returns at most three options; departure default ten, maximum twenty.
- Explicit times include an offset; omitted time means now.
- Disruptions retain future work unless active-only was requested; truncation is explicit.
- Preserve missing facts as null and every returned travel leg; no fabricated route impact.
- No update to the existing deployed NS plugin/service and no deployment in this implementation.

## Review Focus

- Ambiguous city names return candidates; they never silently resolve to a station.
- Malformed upstream data fails explicitly rather than becoming an empty successful result.
- Arrival deadline decisions use returned arrival times, including delays/cancellations.
- Concurrent calls cannot share credentials, transports or mutable request state.
- Packaging refuses an unverified endpoint or a catalog from the old plugin.

## Task 1: Domain contracts and provider boundary

**Files:** `src/schemas.ts`, `src/nsClient.ts`, `src/nsPayloads.ts`, `test/nsClient.test.ts`.

**Interfaces:** Shared schemas export `Station`, `Journey`, `Departure`, `Disruption`, `PlanInput`, `DeparturesInput`, `DisruptionsInput`. `NsClient({apiKey, baseUrl, fetcher?})` exposes `getStations(): Promise<Station[]>`, `planJourney(input: PlanInput & {from: string; to: string}): Promise<Journey[]>`, `getDepartures(input: DeparturesInput & {station: string}): Promise<Departure[]>`, `getDisruptions(input: DisruptionsInput & {station?: string}): Promise<Disruption[]>`. These return normalized values, not MCP results. The workflow resolves names before passing station codes. Unknown/malformed upstream collections throw `NsApiError` with safe code/message.

- [x] Write provider tests for required paths/query params, leg fidelity, null fields, future disruptions, bad payloads, HTTP failures and timeout behavior; observe failure before implementation.
- [x] Implement strict boundary parsing with explicit schemas and null normalization, bounded response body, fixed upstream paths and timeout.
- [x] Run focused provider tests and typecheck; review implementation.

## Task 2: Three workflows and stateless MCP

**Files:** `src/workflows.ts`, `src/mcp.ts`, `src/server.ts`, `src/types.ts`, `src/config.ts`, `src/logging.ts`, `src/rateLimiter.ts`, `test/workflows.test.ts`, `test/app.test.ts`.

**Interfaces:** `createWorkflows(client, now?)` returns `planJourney`, `getDepartures`, `getDisruptions`. Each returns an output-schema-validated result with `status`, retrieval timestamp, resolved context and normalized results. Ambiguity returns `needs_clarification` and candidate stations. `createApp()` retains `/health` and `/mcp`; initialization and catalog work without an NS secret, while actual tool use reports missing configuration safely.

- [x] Write workflow tests for station ambiguity/typos, missing inputs and arrival deadlines, then run red.
- [x] Implement station matching and three workflows without cached travel responses or a recommendation engine.
- [x] Write MCP integration tests asserting exact catalog, metadata, input/output validation, empty/error distinction, isolation, rate limit and no UI, then run red.
- [x] Replace old transport/registrations with the three tools, request-scoped SDK/client instances and safe cleanup.
- [x] Remove obsolete weather code and unused legacy types; retain relevant old behavior tests as focused replacements.
- [x] Run tests and typecheck; review integration.

## Task 3: Plugin skill, package tooling and routing cases

**Files:** `plugin/plugin.json`, `plugin/skills/ns-travel/*`, `scripts/check-plugin.mjs`, `scripts/package-plugin.mjs`, `scripts/smoke-mcp.mjs`, `evaluations/*`, `test/plugin.test.ts`.

**Interfaces:** Package identity `ns-reisplanner-mvp` version `0.1.0`; one `ns-travel` skill, implicit invocation enabled, no UI/app binding. `npm run package:plugin -- --server-url HTTPS_URL` verifies the exact three-tool catalog and creates a portable tar.gz containing generated root `mcp.json` and existing package source. Source is complete without a deployment; no placeholder endpoint is uploaded. Scripts use the installed official SDK and YAML parser.

- [x] Write package tests for manifest/frontmatter/reference validity and routing case/result integrity, then run red.
- [x] Write concise bilingual discovery metadata, skill and contract reference covering the confirmed workflows only.
- [x] Implement validation/smoke/package scripts with argument-list process invocation and no embedded credentials.
- [x] Add positive, negative and clarification routing cases plus pending observation template; no fabricated runs.
- [x] Run package checks and focused tests; review package content.

## Task 4: Reproducible local delivery

**Files:** `README.md`, `ARCHITECTURE.md`, `docs/{deployment,mcp-server,privacy,support}.md`, `.env.example`, `.gitignore`, `wrangler.toml`, `package.json`, `package-lock.json`, CI workflow.

- [x] Use a distinct Worker name and remove the prior account binding and unused runtime settings.
- [x] Lock tested dependencies, use portable Node scripts, document the actual local/run/package/release steps and pending remote verification.
- [x] Run full validation, Worker type generation, Wrangler deploy dry run, and a local Worker smoke test against the exact catalog.
- [x] Obtain independent whole-change review; fix material findings and rerun affected checks.
- [x] Record actual evidence, update this checklist, and hand off source with any remote deployment/connection/routing work explicitly pending.

## Execution decisions and evidence

- Scope confirmation is the user's answer: “Train journeys, departures, and disruptions.” Proceed using the already requested parallel agents; no second planning approval round.
- Work in this dedicated repository on a feature branch if Git metadata writes are permitted. Do not create an additional worktree or change the original NS project.
- Package checks and API tests are separate from model routing observations. Live ChatGPT cases remain pending until an actual connection exists.

Final evidence: `docs/verification.md`. Independent review approved local source; 54 tests pass. Remote deployment, connected account plugin, and actual ChatGPT routing remain separate release work.
