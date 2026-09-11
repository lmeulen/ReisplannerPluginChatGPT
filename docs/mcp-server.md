# MCP-server voor de Nederlandse Treinreisplanner

Deze repository bevat een HTTP-gebaseerde MCP-server op Cloudflare Workers. De MCP-route gebruikt de officiële `@modelcontextprotocol/sdk` met `WebStandardStreamableHTTPServerTransport`.

## Aanbevolen proeflocatie

Voor deze proef is Cloudflare Workers de beste plek om de MCP-server te draaien.

Redenen:

- de MCP-server moet publiek via HTTPS bereikbaar zijn voor remote MCP-clients;
- Cloudflare houdt `NS_API_KEY` buiten de client;
- lokaal testen kan met dezelfde code via Wrangler.

Gebruik lokaal `http://localhost:8787/mcp` en na deployment `https://<worker-url>/mcp`.

## MCP-endpoint

- URL: `POST /mcp`
- Transport: stateless streamable HTTP via de officiële MCP TypeScript SDK
- Authenticatie: geen; het MCP-endpoint is publiek voor deze proef
- Content-Type: `application/json`
- Accept: `application/json, text/event-stream`
- Rate-limit: `MCP_RATE_LIMIT_PER_MINUTE` publieke `tools/call` requests per client per minuut

De endpoint ondersteunt deze MCP-methodes:

- `initialize`
- `ping`
- `tools/list`
- `tools/call`

## Tools

### API-nabije tools (niet extern exposed)

| Tool | Doel |
| --- | --- |
| `search_stations` | Zoek stations en stationcodes met optionele landfiltering en fuzzy typo fallback. |
| `get_station_info` | Haal stationsdetails op voor een stationcode. |
| `get_nearest_stations` | Zoek stations bij expliciet opgegeven coordinaten. |
| `get_station_departures` | Haal het actuele vertrekbord voor een station op. |
| `get_station_arrivals` | Haal het actuele aankomstbord voor een station op. |
| `plan_journey` | Plan een actuele treinreis. |
| `get_single_trip` | Reconstrueer een volledige trip met `ctxRecon`. |
| `get_journey_details` | Haal ritdetails op met `journeyDetailRef` of treinnummer. |
| `get_domestic_price` | Haal binnenlandse prijsinformatie op. |
| `get_disruptions` | Haal algemene verstoringen, calamiteiten en werkzaamheden op. |
| `get_station_disruptions` | Haal station-specifieke verstoringen op. |
| `get_single_disruption` | Haal details van een verstoring op. |

Deze API-nabije tools blijven intern beschikbaar voor compositie en hergebruik, maar worden niet extern geregistreerd. Publieke MCP-clients krijgen uitsluitend de workflowtools.

### Workflowtools

| Tool | Doel |
| --- | --- |
| `plan_resolved_journey` | Plan een reis met stationsnamen, stationcodes of typfouten. |
| `get_resolved_station_departures` | Haal vertrekbord op met stationsnaam, stationcode of typfout. |
| `get_resolved_station_arrivals` | Haal aankomstbord op met stationsnaam, stationcode of typfout. |
| `get_resolved_station_disruptions` | Haal stationverstoringen op met stationsnaam, stationcode of typfout. |
| `price_resolved_journey` | Plan en prijs een reis met stationsnamen of typfouten. |
| `get_planned_journey_details` | Plan een reis en haal details van de beste optie op. |
| `check_route_disruptions` | Controleer routewaarschuwingen en stationverstoringen. |
| `check_journey_status` | Controleer reisstatus en waarschuwingen. |
| `find_departure_platform` | Vind vertrekspoor vanaf station richting bestemming. |
| `check_planned_journey_warnings` | Verzamel waarschuwingen voor een geplande reis. |
| `resolve_station` | Vind de beste stationmatch voor naam, afkorting, code of typfout. |
| `find_nearest_station` | Vind het dichtstbijzijnde station bij expliciete coordinaten. |
| `get_train_stops` | Toon tussenstops met `journeyDetailRef`, treinnummer of route. |

Alle tools gebruiken dezelfde NS-normalisatie. MCP `structuredContent` is bewust minimaal gehouden: alleen de data die de tool belooft terug te geven. De tekstuele `content` bevat een korte samenvatting en, waar nodig, een verwijzing naar NS-app of ns.nl.

`search_stations` probeert eerst de exacte NS-stationszoekopdracht. Als NS geen resultaten teruggeeft, haalt de server de volledige stationslijst op en kiest lokaal de beste matches met genormaliseerde namen, aliases, synoniemen en Levenshtein-afstand. Resultaten bevatten `matchType` met `exact`, `contains`, `fuzzy` of `fallback`.

Workflowtools gebruiken dezelfde resolver intern. Daardoor kunnen chatvragen zoals "plan Amsterdam naar Utrect", "welk spoor naar Schiphol", "wat kost Amsterdam naar Utrecht", "zoek Amsterdm" of "toon tussenstops van trein 3024" met een enkele MCP-call worden afgehandeld.

Workflowtools sturen de presentatie extra aan via hun toolbeschrijving, serverinstructies en `content`. De teruggegeven tekst gebruikt een vaste volgorde voor treinreis, tijden, duur, overstappen, treinlegs, sporen en tussenstops. Buslegs worden uit deze tekstuele presentatie weggelaten. Dit is een sterke clienthint, geen garantie op een identieke visuele rendering: de MCP-client bepaalt zelf de uiteindelijke UI.

Elke tool publiceert metadata voor ChatGPT tool scanning:

- `title`
- `description`
- `inputSchema`
- `outputSchema`
- `annotations` met `readOnlyHint: true`, `destructiveHint: false` en `openWorldHint: true`

`openWorldHint` staat op `true` omdat de tools actuele gegevens ophalen bij de externe NS Reisplanner API. De tools wijzigen geen externe staat.

## Productie-instellingen

De Worker gebruikt deze productiegerichte defaults:

```toml
LOG_LEVEL = "info"
MCP_RATE_LIMIT_PER_MINUTE = "45"
```

De primaire rate-limit gebruikt een Cloudflare Durable Object binding, zodat tellers niet per Worker isolate versnipperen. Als de binding lokaal ontbreekt, valt de server terug op een in-memory limiter voor tests en lokale ontwikkeling. Voor publieke distributie of hogere volumes blijft een aanvullende Cloudflare WAF/rate limiting rule op `/mcp` aanbevolen.

Stationszoekopdrachten en stationsdetails worden maximaal 24 uur per Worker isolate gecachet. Dichtstbijzijnde stations worden 10 minuten gecachet op afgeronde coordinaten. Vertrekborden, aankomstborden, single trips, ritdetails en verstoringen worden kort gecachet. Prijzen worden 1 uur gecachet. Nieuwe reisplanningen worden niet gecachet.

Observability is privacybewust: logs bevatten toolnaam, outcome en duur, maar geen API-keys, volledige toolargumenten of volledige reisadviezen.

## Lokaal draaien

```powershell
.\scripts\npm.ps1 install
.\scripts\wrangler.ps1 secret put NS_API_KEY
.\scripts\npm.ps1 run dev
```

De lokale MCP-server is daarna bereikbaar op:

```text
http://localhost:8787/mcp
```

## Deployen als remote MCP-server

```powershell
.\scripts\wrangler.ps1 secret put NS_API_KEY
.\scripts\npm.ps1 run deploy
```

Gebruik daarna:

```text
https://nederlandse-treinreisplanner.nederlandsetreinreisplanner.workers.dev/mcp
```

of de URL die Wrangler na deployment toont.

## Handmatige MCP-test

Initialiseer de server:

```powershell
$headers = @{
  'Content-Type' = 'application/json'
  Accept = 'application/json, text/event-stream'
}

$body = @{
  jsonrpc = '2.0'
  id = 1
  method = 'initialize'
  params = @{ protocolVersion = '2025-06-18'; clientInfo = @{ name = 'manual-test'; version = '1.0.0' } }
} | ConvertTo-Json -Depth 8

Invoke-RestMethod -Method Post -Uri 'http://localhost:8787/mcp' -Headers $headers -Body $body
```

Vraag de tools op:

```powershell
$body = @{ jsonrpc = '2.0'; id = 2; method = 'tools/list' } | ConvertTo-Json -Depth 8
Invoke-RestMethod -Method Post -Uri 'http://localhost:8787/mcp' -Headers $headers -Body $body
```

Zoek stations:

```powershell
$body = @{
  jsonrpc = '2.0'
  id = 3
  method = 'tools/call'
  params = @{ name = 'search_stations'; arguments = @{ query = 'Amsterdam' } }
} | ConvertTo-Json -Depth 8

Invoke-RestMethod -Method Post -Uri 'http://localhost:8787/mcp' -Headers $headers -Body $body
```

Haal actuele vertrekken op:

```powershell
$body = @{
  jsonrpc = '2.0'
  id = 4
  method = 'tools/call'
  params = @{ name = 'get_station_departures'; arguments = @{ stationCode = 'ASD'; maxResults = 5 } }
} | ConvertTo-Json -Depth 8

Invoke-RestMethod -Method Post -Uri 'http://localhost:8787/mcp' -Headers $headers -Body $body
```

Haal stationverstoringen op:

```powershell
$body = @{
  jsonrpc = '2.0'
  id = 5
  method = 'tools/call'
  params = @{ name = 'get_station_disruptions'; arguments = @{ stationCode = 'ASD' } }
} | ConvertTo-Json -Depth 8

Invoke-RestMethod -Method Post -Uri 'http://localhost:8787/mcp' -Headers $headers -Body $body
```

Haal een prijs op:

```powershell
$body = @{
  jsonrpc = '2.0'
  id = 6
  method = 'tools/call'
  params = @{ name = 'get_domestic_price'; arguments = @{ fromStation = 'ASD'; toStation = 'UT' } }
} | ConvertTo-Json -Depth 8

Invoke-RestMethod -Method Post -Uri 'http://localhost:8787/mcp' -Headers $headers -Body $body
```

Plan een reis:

```powershell
$body = @{
  jsonrpc = '2.0'
  id = 7
  method = 'tools/call'
  params = @{
    name = 'plan_journey'
    arguments = @{
      from = 'ASD'
      to = 'UT'
      dateTime = '2026-09-11T08:30:00+02:00'
      searchForArrival = $false
    }
  }
} | ConvertTo-Json -Depth 8

Invoke-RestMethod -Method Post -Uri 'http://localhost:8787/mcp' -Headers $headers -Body $body
```

Plan een reis met stationsnamen of typfouten:

```powershell
$body = @{
  jsonrpc = '2.0'
  id = 8
  method = 'tools/call'
  params = @{
    name = 'plan_resolved_journey'
    arguments = @{ from = 'Amsterdm'; to = 'Utrect' }
  }
} | ConvertTo-Json -Depth 8

Invoke-RestMethod -Method Post -Uri 'http://localhost:8787/mcp' -Headers $headers -Body $body
```

## Clientconfiguratie

Gebruik bij een remote MCP-client deze waarden:

```text
Name: Nederlandse Treinreisplanner
URL: https://<worker-url>/mcp
Authentication: none
```

Voor lokale MCP-clients die HTTP-MCP ondersteunen:

```text
URL: http://localhost:8787/mcp
Authentication: none
```

Let op: desktopclients die alleen `stdio`-MCP ondersteunen kunnen deze Worker niet rechtstreeks starten. Gebruik daarvoor een kleine lokale proxy, of test deze proef met een client die remote HTTP-MCP ondersteunt.

## ChatGPT reviewstatus

Deze server zit dichter op productie voor ChatGPT Apps omdat hij publiek via HTTPS draait, geen lokale tunnel nodig heeft, de officiële MCP SDK gebruikt, duidelijke toolmetadata publiceert, alle tools als read-only annoteert, minimale output teruggeeft en publieke tool-calls rate-limited uitvoert.

Nog te doen buiten deze codebase voor publicatie:

- testen met MCP Inspector als streamable HTTP-server;
- verbinden in ChatGPT Developer Mode en **Scan Tools** draaien;
- pluginnaam, logo, beschrijving, supportcontact, privacy policy URL en testprompts invullen; gebruik [docs/privacy.md](privacy.md) en [docs/support.md](support.md) als basis;
- OpenAI organisatieverificatie afronden;
- voor publieke schaal eventueel een aanvullende Cloudflare WAF/rate limiting rule toevoegen voor `/mcp`.
