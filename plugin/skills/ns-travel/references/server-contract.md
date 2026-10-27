# Server contract

All three tools resolve station names or codes internally. Use the text result as data; do not infer facts that are absent. `status` is `ok`, `no_results`, or `needs_clarification`; each result includes `retrievedAt` and a nullable `clarification`. A clarification contains `field`, `query`, `reason`, and up to five `candidates`.

## `plan_journey`

Inputs: required `from`, `to`; optional `dateTime`, `searchForArrival`, `accessible`, and `language` (`nl` or `en`). `dateTime` is ISO 8601 with an explicit UTC offset. Omit it for now. `searchForArrival: true` requires `dateTime`.

Output fields: `status`, `retrievedAt`, `clarification`, resolved `from` and `to`, `arrivalDeadline`, `recommendedIndex`, and up to three `journeys`. Each journey includes `meetsArrivalDeadline`, all returned `legs`, and `warnings`. Keep the returned leg order and mode.

## `get_departures`

Inputs: required `station`; optional offset-aware `dateTime`, `limit` (default 10, maximum 20), and `language`.

Output fields: `status`, `retrievedAt`, `clarification`, resolved `station`, and up to 20 `departures`. Preserve planned and actual times and platforms separately, along with cancellation and warning data.

## `get_disruptions`

Inputs: optional `station`, optional `isActive`, and optional `language`. Omit `station` for national notices. Omit `isActive` to include planned works.

Output fields: `status`, `retrievedAt`, `clarification`, `scope` (`national` or `station`), nullable resolved `station`, up to 20 `disruptions`, and `truncated`. A notice scoped to a station or the nation does not establish impact on a particular route.

## Scope

These workflows cover current journey planning, departures, and disruption notices. They do not expose journey-status references, prices, booking, or OV-fiets actions. Provider errors are distinct from a valid `no_results` response.
