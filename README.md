# NS Reisplanner MVP

A text-only MCP Worker for three current-travel tasks:

| Tool | Use it for |
| --- | --- |
| `plan_journey` | Station-to-station options, arrival deadlines and accessible planning |
| `get_departures` | A station's departure board, platforms and cancellations |
| `get_disruptions` | National or station notices, including planned works |

Station resolution happens inside each call. Ambiguous names return choices,
unknown facts remain `null`, and every result includes its retrieval time. The
public catalog contains only these workflows; it has no cards, weather calls,
booking, pricing or raw API tools.

## Develop

Requires Node.js 22.12+ and npm.

```sh
npm ci
cp .dev.vars.example .dev.vars
# Set NS_API_KEY in .dev.vars locally; keep that file out of Git.
npm run dev
```

The Worker serves `/health` and the stateless Streamable HTTP endpoint at
`/mcp`. Catalog discovery works before an NS key is configured.

```sh
npm run validate
npm run types:check
npm run deploy:dry-run
npm run test:worker
```

The tests use fictional provider responses. They verify code behavior, not live
NS connectivity or ChatGPT tool selection.

## Plugin source and maintenance

`plugin/` contains the portable manifest and a focused `ns-travel` skill. See
[Architecture](ARCHITECTURE.md), the [MCP contract](docs/mcp-server.md),
[privacy](docs/privacy.md), and [deployment guidance](docs/deployment.md).

The source package can be prepared after the intended endpoint has been
verified. See `npm run package:plugin -- --help` for the packaging command.
