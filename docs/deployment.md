# Deployment en validatie

## Voorwaarden

- Node.js 22 of nieuwer.
- Een Cloudflare-account.
- Wrangler-authenticatie via `wrangler login`.
- Een geldige NS API subscription key.

## Installatie

```powershell
npm install
```

Als `npm` niet globaal op je PATH staat, gebruik de lokale wrapper:

```powershell
.\scripts\npm.ps1 install
```

## Lokale validatie

```powershell
npm run typecheck
npm test
npm run validate
```

Zonder globale Node/npm-installatie:

```powershell
.\scripts\npm.ps1 run validate
```

## Secret instellen

```powershell
wrangler secret put NS_API_KEY
```

Zonder globale Wrangler-installatie:

```powershell
.\scripts\wrangler.ps1 secret put NS_API_KEY
```

## Lokaal draaien

```powershell
npm run dev
```

Controleer daarna:

```powershell
Invoke-RestMethod http://localhost:8787/health
```

Controleer MCP tool discovery:

```powershell
$headers = @{
  'Content-Type' = 'application/json'
  Accept = 'application/json, text/event-stream'
}

$body = @{ jsonrpc = '2.0'; id = 1; method = 'tools/list' } | ConvertTo-Json -Depth 8
Invoke-RestMethod -Method Post -Uri 'http://localhost:8787/mcp' -Headers $headers -Body $body
```

## Deployen

```powershell
npm run deploy
```

Na deployment gebruik je de publieke Worker-URL als remote MCP endpoint:

```text
https://<worker-url>/mcp
```

Voer na deployment de MCP-smoke-test uit:

```powershell
npm run smoke:mcp -- -WorkerUrl 'https://<worker-url>' -StationCode ASD
```

De smoke-test controleert `/health`, MCP `initialize`, `ping`, `tools/list` en een `resolve_station`-call. Gebruik optioneel `-CheckRateLimit` om de rate-limitgrens te controleren. Dit verstuurt extra requests en is daarom alleen geschikt voor een gecontroleerde omgeving.

## Productiechecklist

- Controleer dat `LOG_LEVEL` op `info` of lager staat.
- Controleer dat API-keys niet in logs of responses voorkomen.
- Monitor MCP tool-call volume, rate-limit hits en NS API-fouten.
- Publiceer privacy- en supportinformatie voordat je de MCP-server via ChatGPT breder aanbiedt.
- Controleer merkgebruik voordat NS-naam, logo of officiële positionering gebruikt wordt.
