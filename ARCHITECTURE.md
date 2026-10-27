# Architecture

A stateless Cloudflare Worker using Hono, Zod and the official MCP SDK.

```text
HTTP request → server → rate limiter → MCP tool → workflow → NS client
                                                ↓              ↓
                                           output schema   payload parser
```

| Module | Responsibility |
| --- | --- |
| `src/index.ts` | Worker entry point and Durable Object export |
| `src/server.ts` | Health/MCP routes, CORS, request-size limit and safe HTTP errors |
| `src/mcp.ts` | Three registrations, request-scoped transport/client, safe tool errors |
| `src/schemas.ts` | Public input/output schemas and inferred domain types |
| `src/workflows.ts` | Station resolution, deadlines, scopes and bounded results |
| `src/nsClient.ts` | NS HTTP paths, credentials, timeout and bounded response reading |
| `src/nsPayloads.ts` | Parse unknown provider JSON and normalize supported fields |
| `src/rateLimiter.ts` | Durable fixed-window counter and HTTP enforcement |
| `src/config.ts`, `src/logging.ts` | Runtime defaults and technical logs |
| `src/worker-bindings.d.ts` | Generated non-secret Wrangler bindings |
| `plugin/skills/ns-travel/` | Model workflow guidance and discovery metadata |
| `scripts/` | Local verification and verified-endpoint packaging |

## Contracts

The public catalog is deliberately three tools. This MVP replaces the older
fifteen-tool contract in this checkout, with a distinct package/Worker identity.
The existing deployed NS plugin is separate.

Schemas are constructed once at module scope. SDK servers, transports, NS
clients and credentials are request-scoped. Travel responses are not cached.
Station data is fetched once per workflow and used for internal matching.
An exact station name/code wins; a broad city match returns candidates. A clear
unique typo can resolve, and the result always includes the resolved name/code.

`plan_journey` keeps provider order and returns at most three options. For an
arrival deadline it marks each option using its returned actual arrival, falling
back to planned arrival; cancelled/unusable options do not qualify. The suggested
index is the latest returned feasible departure, never a claim about all trains.
Known past departures are filtered before the three-option cap. Actual departure
takes precedence over planned departure; the cutoff is the later of server now
and a requested departure time. Arrival searches use server now as that cutoff.
Without a deadline, the first usable option with a known departure is suggested.
Unknown and cancelled options cannot become the recommended fallback.

Provider parsing distinguishes a valid empty list from missing/malformed data.
Unknown optional facts remain null. All legs and both endpoint platforms survive
normalization. General/station notices do not establish route impact. The
workflow limits disruptions to twenty and signals truncation.

Errors are MCP `isError` results with safe categories, not successful empty data.
Logs contain operation, outcome and duration; debug request logs use canonical
route names. No bodies, travel queries, API keys or journey references are logged
by application code. Infrastructure has its own logging and retention settings.

## Change one thing at a time

1. Update the public schema if the contract changes.
2. Add a failing behavior test at the responsible boundary.
3. Change the provider parser or workflow; keep provider details out of MCP.
4. Update the skill reference and relevant routing cases if behavior changes.
5. Run `npm run validate`, `npm run types:check` and `npm run deploy:dry-run`.

Avoid additional public tools until a distinct traveler task needs one. Keep
raw provider operations internal. Do not add UI metadata or duplicate
output-schema definitions in documentation/tooling. Add a small helper when it
removes real duplication, not a generic workflow or transport framework.

Dependency versions are locked. Regenerate bindings after changing Wrangler
configuration. A deployment, a live NS call and an untagged ChatGPT test are
separate evidence stages; none can be inferred from unit-test success.
