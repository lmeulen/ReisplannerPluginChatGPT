# Uitbreidingsplan NS Reisplanner MCP-server

Deze repository bevat een MCP-only Cloudflare Worker voor actuele Nederlandse treinreisinformatie. De server gebruikt de officiele MCP TypeScript SDK, houdt de NS API-key server-side en exposeert alleen `/health` en `/mcp`.

## Implementatiestatus

Status: uitgevoerd.

De code bevat 12 API-nabije read-only toolimplementaties en 13 workflowtools. Alleen de 13 workflowtools worden publiek geregistreerd; de API-nabije implementaties blijven intern beschikbaar voor compositie en hergebruik. De bestaande tools zijn aangescherpt met rijkere NS-velden, `get_single_trip` is afgesplitst van ritdetails, `get_journey_details` gebruikt het ritdetailconcept met `journeyDetailRef` of treinnummer, en prijs-, nearest-station- en disruption-detailtools zijn toegevoegd.

Workflowtools resolveeren stationsnamen, stationcodes en typfouten intern met `search_stations`, zodat veelgestelde chatvragen met een enkele MCP-call beantwoord kunnen worden. Voorbeelden zijn `plan_resolved_journey`, `get_resolved_station_departures`, `price_resolved_journey`, `find_departure_platform`, `get_planned_journey_details`, `resolve_station`, `find_nearest_station` en `get_train_stops`.

De workflowtools geven een vaste tekstuele presentatie terug in `content` en instrueren de client om die als primaire weergave te gebruiken. De presentatie is gericht op treinreizen en laat buslegs weg; de client blijft verantwoordelijk voor de exacte visuele layout.

Niet toegevoegd als publieke MCP-tool: `get_openapi_spec` en `get_calamities`. `OpenAPI Spec` is ontwikkelaarmetadata. `Calamities` blijft gedekt via `get_disruptions` met een typefilter, omdat de calamities-operatie deprecated is en naar disruptions v3 verwijst.

## Doel

Het doel is om de MCP-server functioneel rijker te maken op basis van de beschikbare NS Reisinformatie API GET-operaties, zonder de toolset te breed of onduidelijk te maken voor ChatGPT toolselectie.

De uitbreiding moet:

- read-only blijven;
- minimale `structuredContent` teruggeven;
- geen ruwe NS payloads, request IDs, debugdata of secrets lekken;
- toolnamen stabiel en actiegericht houden;
- NS rate limits respecteren;
- privacygevoelige locatie-input expliciet en beperkt modelleren;
- bestaande toolcontracten zo veel mogelijk backward-compatible houden.

## Huidige MCP-tools

De huidige toolset bestaat uit zeven tools:

| Tool | Huidige status | NS API-basis |
| --- | --- | --- |
| `search_stations` | Aanwezig, bruikbaar | `GET /v2/stations` |
| `get_station_info` | Aanwezig, bruikbaar maar kan rijker | `GET /v2/stations` |
| `get_station_departures` | Aanwezig, basisnormalisatie | `GET /v2/departures` |
| `get_station_arrivals` | Aanwezig, basisnormalisatie | `GET /v2/arrivals` |
| `plan_journey` | Aanwezig, basisreisadvies | `GET /v3/trips` |
| `get_journey_details` | Aanwezig, moet herijkt worden | Nu gemodelleerd rond `GET /v3/trips/trip`, maar de docs tonen ook `GET /v2/journey` |
| `get_disruptions` | Aanwezig, te generiek | `GET /v3/disruptions` |

## Belangrijke observaties uit de NS-documentatie

### NS API rate limit

Voor externe, niet-betalende gebruikers geldt volgens de documentatie een NS-limiet van `300 requests per 5 minuten`. De MCP-server heeft al een eigen Durable Object rate limiter, maar de huidige default van `60` tool-calls per minuut kan in theorie precies op de NS-limiet uitkomen bij een enkele client en daaroverheen gaan bij cachemisses of meerdere clients.

Aanbeveling:

- MCP default limiter conservatiever zetten, bijvoorbeeld `240 requests per 5 minuten` of `45 requests per minuut` afhankelijk van de gekozen implementatie.
- Cache inzetten voor stations, stationborden, verstoringen en prijzen.
- Bij NS `429` de boodschap en `Retry-After` netjes doorgeven als tool error.

### Deprecated API-opmerking

Meerdere endpoints in `reisinformatie-api` zijn gemarkeerd als deprecated met verwijzing naar nieuwere product-URL's, bijvoorbeeld:

- arrivals: `https://gateway.apiportal.ns.nl/timetable-api/v2/arrivals`
- departures: `https://gateway.apiportal.ns.nl/timetable-api/v2/departures`
- disruptions: `https://gateway.apiportal.ns.nl/disruptions/v3`
- stations: `https://gateway.apiportal.ns.nl/nsapp-stations/v2` of `v3`
- nearest stations: `https://gateway.apiportal.ns.nl/nsapp-stations/v2/nearest` of `v3/nearest`

Voor deze proef kan de bestaande `reisinformatie-api` base URL blijven zolang de subscription key daarop werkt. Voor productie moet onderzocht worden of dezelfde key ook toegang geeft tot de nieuwe product-API's. Als dat zo is, verdient migratie naar de niet-deprecated endpoints de voorkeur.

## Toe te voegen of aan te passen functionaliteit

### 1. `get_station_arrivals` aanscherpen

Status: bestaat al.

Huidige waarde: hoog. Dit is een natuurlijke vraag: "Welke treinen komen aan op Utrecht?"

NS endpoint:

```text
GET /v2/arrivals?lang&station&uicCode&dateTime&maxJourneys
```

Documentatiepunten:

- `station` of `uicCode` moet aanwezig zijn.
- `dateTime` is volgens docs alleen ondersteund voor aankomsten op buitenlandse stations.
- default `maxJourneys` is `40`.
- response bevat `payload.arrivals`.
- velden bevatten onder meer `journeyDetailRef`, `messages`, `product`, `arrivalStatus`, `plannedTrack`, `actualTrack`.

Aanpassing:

- Input uitbreiden met optioneel `uicCode` naast `stationCode`.
- Validatie afdwingen: `stationCode` of `uicCode` is verplicht.
- `dateTime` beschrijving aanpassen: alleen zinvol voor buitenlandse stations.
- Output uitbreiden met `journeyDetailRef`, `messages`, `operatorName`, `lineNumber` en `productType`.
- Cache TTL: 30 seconden.

### 2. `get_station_departures` aanscherpen

Status: bestaat al.

Huidige waarde: zeer hoog. Dit is waarschijnlijk een van de meest gebruikte tools.

NS endpoint:

```text
GET /v2/departures?lang&station&uicCode&dateTime&maxJourneys
```

Documentatiepunten:

- `station` of `uicCode` moet aanwezig zijn.
- `dateTime` is volgens docs alleen ondersteund voor vertrekken op buitenlandse stations.
- response bevat `payload.departures`.
- departure bevat `journeyDetailRef` en `routeStations`.

Aanpassing:

- Input uitbreiden met optioneel `uicCode` naast `stationCode`.
- Validatie afdwingen: `stationCode` of `uicCode` is verplicht.
- Output uitbreiden met `journeyDetailRef`, `routeStations`, `messages`, `operatorName`, `lineNumber` en `productType`.
- Cache TTL: 30 seconden.

### 3. `get_station_info` en `search_stations` aanscherpen

Status: bestaan al.

Huidige waarde: hoog. Stationcodes zijn sleutelinput voor bijna alle andere tools.

NS endpoint:

```text
GET /v2/stations?q&countryCodes&limit
```

Documentatiepunten:

- `q` zoekt stations.
- `countryCodes` kan filteren.
- `limit` werkt alleen bij gebruik van `q`.
- station bevat veel nuttige velden: `UICCode`, `EVACode`, `code`, `lat`, `lng`, `heeftFaciliteiten`, `heeftReisassistentie`, `heeftVertrektijden`, `stationType`, `sporen`, `synoniemen`.

Aanpassing:

- `search_stations` uitbreiden met `countryCodes?: string[]` en `limit?: number`, met een veilige maximumwaarde zoals `20`.
- `search_stations` gebruikt een Levenshtein-gebaseerde fallback tegen de volledige stationslijst wanneer de exacte NS-zoekopdracht geen resultaat oplevert. Resultaten bevatten `matchType` zodat clients kunnen zien of de match exact, contains of fuzzy was.
- `get_station_info` uitbreiden met `evaCode`, `hasFacilities`, `hasTravelAssistance`, `hasDepartures`, `tracks` en `synonyms`.
- Cache TTL: 24 uur.

### 4. `get_nearest_stations` toevoegen

Status: nieuw.

Huidige waarde: middel tot hoog. Erg bruikbaar voor vragen als: "Wat is het dichtstbijzijnde station bij deze locatie?"

NS endpoint:

```text
GET /v2/stations/nearest?lat={lat}&lng={lng}&limit
```

Documentatiepunten:

- `lat` en `lng` zijn verplicht.
- `limit` is optioneel.
- response bevat `payload` met stations, inclusief `distance`.

Privacy-overweging:

- Dit is de enige voorgestelde tool die precieze coordinaten verwerkt.
- Toolomschrijving moet duidelijk maken dat coordinaten expliciet door de gebruiker of client worden aangeleverd.
- Niet automatisch locatie proberen te infereren uit tekst.
- Geen coordinaten loggen.
- Privacydocumentatie uitbreiden met coordinaten als optionele inputcategorie.

Voorgestelde MCP-tool: `get_nearest_stations`.

Input:

```json
{
  "latitude": 52.0907,
  "longitude": 5.1214,
  "limit": 5,
  "language": "nl"
}
```

Output:

```json
{
  "stations": [
    {
      "code": "UT",
      "name": "Utrecht Centraal",
      "country": "NL",
      "type": "knooppuntIntercitystation",
      "uicCode": "8400621",
      "latitude": 52.089,
      "longitude": 5.110,
      "distanceMeters": 850
    }
  ]
}
```

Cache TTL: 10 minuten, keyed op afgeronde coordinaten en limit. Coordinaten afronden op bijvoorbeeld 4 decimalen om cache en privacy iets te verbeteren.

### 5. `get_disruptions` herontwerpen

Status: bestaat al, maar huidige input is gemengd met station/routevelden die niet in de `GET /v3/disruptions` docs staan.

Huidige waarde: hoog, maar moet scherper.

NS endpoint:

```text
GET /v3/disruptions?type&isActive
```

Documentatiepunten:

- `type` is een array.
- `isActive` filtert onderhoud op actieve items.
- `Accept-Language` header bepaalt taal.
- response is een array van `BaseDisruption` met `id`, `isActive`, `title`, `topic`, `type`.

Aanpassing:

- `get_disruptions` beperken tot landelijke of algemene verstoringen: `types?: string[]`, `isActive?: boolean`, `language?: "nl" | "en"`.
- Station-specifieke verstoringen verplaatsen naar nieuwe tool `get_station_disruptions`.
- Route-specifieke verstoringen alleen houden als er een gedocumenteerd endpoint of aantoonbare API-ondersteuning is.

Backward compatibility:

- Als de MCP-server al in ChatGPT is gepubliceerd, bestaande inputvelden niet hard verwijderen.
- Als nog niet gepubliceerd, kan `get_disruptions` nu schoon worden aangepast.

### 6. `get_station_disruptions` toevoegen

Status: nieuw.

Huidige waarde: hoog. Dit is beter voor toolselectie dan een generieke disruptions-tool met optionele stationvelden.

NS endpoint:

```text
GET /v3/disruptions/station/{stationCode}
```

Documentatiepunten:

- `stationCode` is verplicht.
- response is een array van `BaseDisruption`.

Voorgestelde MCP-tool: `get_station_disruptions`.

Input:

```json
{
  "stationCode": "ASD",
  "language": "nl"
}
```

Output:

```json
{
  "disruptions": [
    {
      "id": "...",
      "type": "CALAMITY",
      "title": "...",
      "topic": "...",
      "isActive": true
    }
  ]
}
```

Cache TTL: 60 seconden.

### 7. `get_single_disruption` toevoegen

Status: nieuw.

Huidige waarde: middel tot hoog. Handig nadat `get_disruptions` of `get_station_disruptions` een ID heeft gegeven.

NS endpoint:

```text
GET /v3/disruptions/{type}/{id}
```

Documentatiepunten:

- `type` en `id` zijn verplicht.
- response is `BaseDisruption`.
- docs noemen ook een `500` response met dezelfde shape; implementatie moet niet blind op status `500` data als succes behandelen.

Voorgestelde MCP-tool: `get_single_disruption`.

Input:

```json
{
  "type": "CALAMITY",
  "id": "...",
  "language": "nl"
}
```

Output:

```json
{
  "disruption": {
    "id": "...",
    "type": "CALAMITY",
    "title": "...",
    "topic": "...",
    "isActive": true
  }
}
```

Cache TTL: 60 seconden.

### 8. `get_calamities` niet als losse tool toevoegen, tenzij nodig

Status: nieuw maar niet aanbevolen als eerste stap.

NS endpoint:

```text
GET /v1/calamities?lang
```

Documentatiepunten:

- Endpoint is deprecated.
- Docs zeggen expliciet: gebruik `/api/v3/disruptions` in plaats daarvan.
- Response heeft oude Nederlandse veldnamen zoals `calamiteit`, `meldingen`, `titel`, `beschrijving`.

Besluit:

- Niet toevoegen als aparte MCP-tool zolang `get_disruptions` calamities kan filteren via `type`.
- Wel zorgen dat `get_disruptions({ types: ["CALAMITY"] })` goed werkt.
- Alleen toevoegen als live tests aantonen dat `/v3/disruptions` minder detail bevat dan `/v1/calamities` en dat detail functioneel nodig is.

### 9. `get_domestic_price` toevoegen

Status: nieuw.

Huidige waarde: hoog. Prijsinformatie is een natuurlijke vervolgvraag na reisplanning.

NS endpoint:

```text
GET /v2/price?fromStation&toStation&travelClass&travelType&isJointJourney&adults&children&routeId&plannedFromTime&plannedArrivalTime
```

Documentatiepunten:

- `fromStation` en `toStation` zijn niet als required gemarkeerd, maar praktisch nodig tenzij `routeId` voldoende is.
- `routeId` komt uit `/api/v3/trips`.
- `plannedFromTime` en `plannedArrivalTime` helpen bij meerdere routes.
- response bevat `payload` met `totalPriceInCents`, `travelClass`, `travelDiscount`, `travelProducts`, `operatorName`.

Voorgestelde MCP-tool: `get_domestic_price`.

Input:

```json
{
  "fromStation": "ASD",
  "toStation": "UT",
  "travelClass": "SECOND_CLASS",
  "travelType": "single",
  "isJointJourney": false,
  "adults": 1,
  "children": 0,
  "routeId": "optional-route-id",
  "plannedFromTime": "2026-09-11T08:24:00+02:00",
  "plannedArrivalTime": "2026-09-11T08:51:00+02:00"
}
```

Open punt:

- Exacte enumwaarden voor `travelClass`, `travelType`, `product` en `discount` moeten live of via OpenAPI spec worden gecontroleerd. Niet gokken met te strikte enums voordat dit zeker is.

Output:

```json
{
  "price": {
    "totalPriceInCents": 1234,
    "totalPrice": "EUR 12.34",
    "travelClass": "SECOND_CLASS",
    "travelDiscount": "NO_DISCOUNT",
    "travelProducts": ["..."],
    "operatorName": "NS"
  }
}
```

Cache TTL: 1 uur voor stationpaar/klasse/korting/route/tijd-combinatie.

### 10. `get_journey_details` herijken naar twee verschillende concepten

Status: bestaat al, maar de naam is dubbelzinnig.

Er zijn twee relevante NS endpoints:

```text
GET /v2/journey?train&id&dateTime&departureUicCode&transferUicCode&arrivalUicCode&omitCrowdForecast
GET /v3/trips/trip?ctxRecon&date&travelRequestType&sourceCtxRecon&nsr&product&discount&travelClass
```

Verschil:

- `GET /v2/journey` geeft details over een treinrit of journey via `train` of `journeyDetailRef` uit trip legs, inclusief stops, aankomst/vertrek per stop, materieel/crowd forecast en platformdetails.
- `GET /v3/trips/trip` reconstrueert een volledige trip op basis van `ctxRecon` uit `/v3/trips`, inclusief volledige legs, fares, messages en routeId.

Aanbevolen herontwerp:

- `get_single_trip`: nieuwe tool voor `GET /v3/trips/trip` met `ctxRecon`.
- `get_journey_details`: aanpassen naar `GET /v2/journey` met `journeyDetailRef` of `trainNumber`.

Waarom:

- De namen sluiten dan aan op de NS API en op gebruikersintentie.
- `plan_journey` geeft `ctxRecon` voor `get_single_trip`.
- Legs/departures/arrivals geven `journeyDetailRef` voor `get_journey_details`.

Voorgestelde `get_single_trip` input:

```json
{
  "ctxRecon": "...",
  "date": "2026-09-11T08:30:00+02:00",
  "travelRequestType": "directions",
  "product": "optional",
  "discount": "optional",
  "travelClass": 2,
  "language": "nl"
}
```

Voorgestelde `get_journey_details` input:

```json
{
  "journeyDetailRef": "...",
  "trainNumber": 3024,
  "dateTime": "2026-09-11T08:30:00+02:00",
  "departureUicCode": "8400058",
  "transferUicCode": "8400621",
  "arrivalUicCode": "8400621",
  "omitCrowdForecast": false,
  "language": "nl"
}
```

Validatie:

- Voor `get_journey_details`: `journeyDetailRef` of `trainNumber` verplicht.
- Voor `get_single_trip`: `ctxRecon` verplicht.

Cache TTL: 30 seconden.

### 11. `plan_journey` uitbreiden, maar gefaseerd

Status: bestaat al.

NS endpoint:

```text
GET /v3/trips
```

De docs tonen veel meer mogelijkheden dan nu beschikbaar zijn:

- stationcode of UIC-code;
- coordinaten voor door-to-door planning;
- via-station of via-locatie;
- first mile/last mile met lopen/fiets/auto;
- toegankelijk reizen en assistentie;
- extra overstaptijd;
- lokale treinen only;
- high-speed/reservation filters;
- product/discount/travelClass voor prijsinformatie;
- passing stops;
- liftinformatie.

Aanbeveling:

- Niet alles in een keer toevoegen. Een te brede `plan_journey` tool maakt toolselectie en review lastiger.
- Wel een tweede tool overwegen voor deur-tot-deur planning: `plan_door_to_door_journey`.

Fase 1 uitbreidingen op bestaande `plan_journey`:

- `viaStation?: string`
- `localTrainsOnly?: boolean`
- `excludeHighSpeedTrains?: boolean`
- `excludeTrainsWithReservationRequired?: boolean`
- `addChangeTime?: number`
- `travelClass?: 1 | 2`
- `discount?: string`
- `passing?: boolean`
- `showLiftInfo?: boolean`

Fase 2 als aparte tool:

- coordinaten en namen voor origin/destination;
- first/last mile modaliteiten;
- disabled transport modalities;
- directions-only.

## Niet toevoegen als MCP-tool

### `get_openapi_spec`

NS endpoint:

```text
GET /openapi
```

Besluit: niet toevoegen als MCP-tool.

Reden:

- Dit is ontwikkelaarmetadata, geen eindgebruikersfunctionaliteit.
- ChatGPT heeft voor de MCP-server de MCP toolmetadata nodig, niet de ruwe NS OpenAPI spec.
- Het kan wel nuttig zijn als intern ontwikkelhulpmiddel of script, maar niet in de publieke MCP toolset.

### `get_booked_trip`

Status: niet genoeg documentatie aangeleverd.

Voorlopig besluit: niet toevoegen.

Reden:

- De naam suggereert persoonlijke boekingsinformatie.
- De huidige MCP-server is publiek en unauthenticated.
- Als dit gebruikersspecifieke data leest, is OAuth of een andere expliciete auth-flow nodig.

## Voorgestelde eindtoolset na uitvoering

Na uitvoering van dit plan bevat de server waarschijnlijk deze MCP-tools:

| Tool | Actie |
| --- | --- |
| `search_stations` | Stations zoeken met optionele landfiltering. |
| `get_station_info` | Details van een stationcode ophalen. |
| `get_nearest_stations` | Dichtstbijzijnde stations bij expliciete coordinaten zoeken. |
| `get_station_departures` | Actueel vertrekbord ophalen. |
| `get_station_arrivals` | Actueel aankomstbord ophalen. |
| `plan_journey` | Station-tot-station reis plannen. |
| `get_single_trip` | Een volledige trip reconstrueren met `ctxRecon`. |
| `get_journey_details` | Rit-/treindetails ophalen met `journeyDetailRef` of treinnummer. |
| `get_domestic_price` | Binnenlandse prijsinformatie ophalen. |
| `get_disruptions` | Algemene verstoringen, calamiteiten en werkzaamheden ophalen. |
| `get_station_disruptions` | Station-specifieke verstoringen ophalen. |
| `get_single_disruption` | Detail van een verstoring ophalen. |

Totaal: 12 tools. Dat is veel, maar nog verdedigbaar omdat elke tool een duidelijke gebruikersintentie heeft. De toolset blijft read-only.

## Implementatiefases

### Fase 1: Correcties op bestaande tools

Doel: de huidige zeven tools in lijn brengen met de aangeleverde docs.

Werk:

- `get_station_departures` uitbreiden met `uicCode`, `journeyDetailRef`, `routeStations`, productdetails en messages.
- `get_station_arrivals` uitbreiden met `uicCode`, `journeyDetailRef`, productdetails en messages.
- `search_stations` en `get_station_info` uitbreiden met stationsvelden uit de docs.
- `get_disruptions` aanpassen naar `type`, `isActive` en `Accept-Language`.
- `get_journey_details` herijken naar `/v2/journey`.
- Nieuwe `get_single_trip` toevoegen voor `/v3/trips/trip`.

Tests:

- Unit tests met mockpayloads uit de aangeleverde docs.
- SDK-client test voor `tools/list` om toolmetadata te controleren.
- Live smoke-test voor minimaal departures, arrivals, stations, disruptions en trips.

### Fase 2: Nieuwe nuttige tools

Werk:

- `get_domestic_price` toevoegen.
- `get_nearest_stations` toevoegen met privacybewuste input en logging.
- `get_station_disruptions` toevoegen.
- `get_single_disruption` toevoegen.

Tests:

- Mockpayloads voor prijs, nearest stations en disruption details.
- Rate-limit test blijft groen.
- Live smoke-tests alleen met niet-privacygevoelige vaste inputs, behalve nearest stations met expliciete testcoordinaten.

### Fase 3: Documentatie en publicatievoorbereiding

Werk:

- README tooltabel bijwerken.
- [docs/mcp-server.md](docs/mcp-server.md) uitbreiden met alle tools en voorbeeldcalls.
- [docs/privacy.md](docs/privacy.md) uitbreiden met optionele coordinateninput voor `get_nearest_stations`.
- [docs/support.md](docs/support.md) uitbreiden met veelvoorkomende foutbeelden voor NS `400`, `404`, `419` en `429`.
- ChatGPT Developer Mode **Scan Tools** opnieuw draaien omdat toolmetadata wijzigt.

### Fase 4: Endpointmodernisatie naar niet-deprecated NS APIs

Werk:

- Onderzoeken of de huidige subscription key werkt op:
  - `https://gateway.apiportal.ns.nl/timetable-api/v2/departures`
  - `https://gateway.apiportal.ns.nl/timetable-api/v2/arrivals`
  - `https://gateway.apiportal.ns.nl/disruptions/v3`
  - `https://gateway.apiportal.ns.nl/nsapp-stations/v2`
  - `https://gateway.apiportal.ns.nl/nsapp-stations/v2/nearest`
- Als dat werkt: `NS_API_BASE_URL` opsplitsen in product-specifieke base URLs.
- Als dat niet werkt: voorlopig bij `reisinformatie-api` blijven en deprecated-status documenteren.

## Acceptatiecriteria

De uitbreiding is klaar wanneer:

- `npm run validate` slaagt;
- `wrangler deploy --dry-run` slaagt;
- remote SDK smoke-test `tools/list` alle bedoelde tools ziet;
- live calls slagen voor stations, departures, arrivals, trips en disruptions;
- `get_single_trip` minstens een niet-lege reconstructie geeft op basis van `ctxRecon` uit `plan_journey`;
- `get_journey_details` werkt met `journeyDetailRef` uit departures, arrivals of trip legs;
- docs geen oude REST/OpenAPI Action-laag herintroduceren;
- privacydocumentatie coordinateninput noemt zodra `get_nearest_stations` live staat.

## Open vragen voordat implementatie start

1. Is deze MCP-server al gescand/gepubliceerd in ChatGPT Developer Mode?
   - Zo ja: backward compatibility zwaarder wegen en bestaande tools niet brekend aanpassen.
   - Zo nee: toolcontracten kunnen nu nog netter worden hernoemd of opgeschoond.
2. Werkt de huidige NS subscription key ook op de nieuwere niet-deprecated product-API's?
3. Moet de server unauthenticated blijven als `get_nearest_stations` coordinaten verwerkt?
4. Willen we `plan_journey` breed houden of deur-tot-deur planning als aparte tool modelleren?
5. Ontbreekt de documentatie voor `Booked trip`, en is die endpoint persoonlijk/accountgebonden?
