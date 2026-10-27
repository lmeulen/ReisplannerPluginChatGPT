# Deployment guidance

Local source work and production release are separate. Deploy only after the
owner approves the target account and service.

1. Install the lockfile dependencies with `npm ci`.
2. Run `npm run validate`, `npm run types:check`, and `npm run deploy:dry-run`.
3. Confirm Wrangler is authenticated to the intended account. Do not place
   account identifiers or credentials in source files.
4. Provision `NS_API_KEY` as a Worker secret with `npx wrangler secret put NS_API_KEY`.
   Never commit the key or pass it through chat, logs, or tool inputs.
5. After deployment approval, run `npm run deploy`.
6. Verify the deployed `/health` route, initialize MCP, confirm the exact
   three-tool catalog, and make representative live calls only when authorized.
7. Build a portable plugin package only against the endpoint that was just
   verified. Review the archive before any separate plugin upload or install.

A successful local build or dry-run does not establish production connectivity.
Record local checks, deployment results, and host observations separately.
