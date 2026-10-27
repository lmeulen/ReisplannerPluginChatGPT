# MCP contract

`/mcp` uses the official SDK's stateless Streamable HTTP transport with JSON
responses. `/health` is liveness only. Initialization and tool discovery do not
require an NS API key. No resources, prompts, subscriptions or UI are exposed.

All three tools have input/output schemas and read-only, non-destructive,
idempotent, open-world annotations. Unknown input keys are rejected.

| Tool | Required | Optional |
| --- | --- | --- |
| `plan_journey` | `from`, `to` station names/codes | `dateTime`, `searchForArrival` (false), `accessible` (false), `language` (`nl`/`en`, default `nl`) |
| `get_departures` | `station` | `dateTime`, `limit` (1–20, default 10), `language` |
| `get_disruptions` | None (national overview) | `station`, `isActive`, `language` |

Explicit `dateTime` is ISO 8601 with an offset, such as
`2026-10-26T09:00:00+01:00`. Omit it for now. `searchForArrival: true` requires
`dateTime`. The skill resolves local Dutch times in Europe/Amsterdam.

Successful calls return `structuredContent` and equivalent JSON text for clients
that do not consume structured output. Result `status` is `ok`, `no_results` or
`needs_clarification`, with `retrievedAt` and nullable `clarification`. Ambiguity
returns the input field, query, reason and up to five candidate stations.

Planning includes resolved `from`/`to`, an optional `arrivalDeadline`, up to three
`journeys` and `recommendedIndex` (zero-based, or null). Each journey has
`meetsArrivalDeadline` (null when no deadline or no arrival is known). Planned and
actual leg facts are separate, and missing values remain null.

Departures include the resolved station and at most the requested limit.
Disruptions include `scope` (`national`/`station`), the resolved station if given,
at most twenty notices and `truncated`. Omitting `isActive` includes future work;
true selects active notices and false selects inactive notices.

Provider/network/configuration failures return `isError: true` and a safe error
category/message. They do not return a successful empty result. A rate-limited
tool request returns HTTP 429 with `Retry-After`; an unavailable limiter fails
closed with HTTP 503. Initialization/catalog discovery remain available.

The server does not book, price, reserve assistance, recheck a previous train,
monitor changes, or establish complete local-transit or route-disruption coverage.
