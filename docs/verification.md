# Verification guidance

Run these local checks from a clean checkout:

```sh
npm ci
npm run validate
npm run types:check
npm run deploy:dry-run
```

The automated suite uses fictional provider fixtures and local Worker runtime
checks. It covers the three public workflows, schema validation, station
ambiguity, deadline handling, provider parsing, rate limiting, and plugin
package integrity. These checks do not contact NS or establish current travel
facts.

A dry-run builds the Worker and reports its bindings without deploying it. Live
NS connectivity, the deployed tool catalog, and automatic selection in a ChatGPT
host are separate checks. Record each only after it is performed against the
intended service and host.
