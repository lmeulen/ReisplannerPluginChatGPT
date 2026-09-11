# Support Nederlandse Treinreisplanner MCP

Gebruik deze pagina als supportreferentie voor de Nederlandse Treinreisplanner MCP-server.

## Endpoint

```text
https://nederlandse-treinreisplanner.nederlandsetreinreisplanner.workers.dev/mcp
```

## Veelvoorkomende controles

Controleer of de Worker bereikbaar is:

```powershell
Invoke-RestMethod -Method Get -Uri 'https://nederlandse-treinreisplanner.nederlandsetreinreisplanner.workers.dev/health'
```

Controleer of MCP tool discovery werkt:

```powershell
$headers = @{
  'Content-Type' = 'application/json'
  Accept = 'application/json, text/event-stream'
}

$body = @{ jsonrpc = '2.0'; id = 1; method = 'tools/list' } | ConvertTo-Json -Depth 8
Invoke-RestMethod -Method Post -Uri 'https://nederlandse-treinreisplanner.nederlandsetreinreisplanner.workers.dev/mcp' -Headers $headers -Body $body
```

## Verwachte foutbeelden

| Fout | Betekenis | Actie |
| --- | --- | --- |
| `429` | Publieke MCP tool-call rate-limit bereikt. | Wacht tot `Retry-After` is verstreken. |
| `400` of MCP tool error | Toolargumenten of NS API-parameters zijn ongeldig. | Controleer stationcode, UIC-code, `ctxRecon`, `journeyDetailRef` of prijsparameters. |
| `404` of MCP tool error | Station, rit, prijs of verstoring is niet gevonden. | Zoek eerst stations of verstoringen opnieuw en gebruik de teruggegeven IDs. |
| `419` of MCP tool error | NS backend gaf een niet-herstelbare fout bij reisplanning of tripdetails. | Probeer later opnieuw of vraag een nieuw reisadvies op. |
| `502` of MCP tool error | De NS API gaf geen bruikbare response. | Probeer later opnieuw en controleer NS API-status. |
| `406` | MCP client mist de juiste `Accept` header. | Gebruik `Accept: application/json, text/event-stream`. |

## Publicatiegegevens

Voor OpenAI plugin submission zijn daarnaast nodig:

- supportcontact of support-URL;
- privacy policy URL;
- testprompts met verwachte antwoorden;
- beschrijving van rate limiting en read-only gedrag;
- uitleg dat de tools actuele data ophalen bij de NS Reisplanner API en geen externe staat wijzigen.
