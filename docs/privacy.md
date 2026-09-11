# Privacyverklaring Nederlandse Treinreisplanner MCP

Deze MCP-server helpt gebruikers actuele Nederlandse treinreisinformatie op te halen via de NS Reisplanner API.

## Welke gegevens worden verwerkt

De server verwerkt alleen gegevens die nodig zijn voor de aangevraagde reisplannerfunctie:

- stationsnamen of stationcodes;
- optioneel expliciet opgegeven coordinaten voor het zoeken van dichtstbijzijnde stations;
- gewenste vertrek- of aankomsttijd;
- reisvoorkeuren zoals extra overstaptijd of toegankelijk reizen;
- technische requestgegevens die Cloudflare standaard beschikbaar stelt, zoals IP-adres en user-agent.

De server vraagt niet om namen, e-mailadressen, betaalgegevens, wachtwoorden, API-keys of volledige chatgeschiedenis. Coordinaten worden alleen verwerkt wanneer ze expliciet aan `get_nearest_stations` worden meegegeven.

## Waarvoor gegevens worden gebruikt

Invoer wordt gebruikt om:

- stations te zoeken;
- dichtstbijzijnde stations bij expliciet opgegeven coordinaten te vinden;
- treinreizen te plannen;
- prijsinformatie op te halen;
- verstoringen op te halen;
- misbruik en overbelasting van het publieke MCP-endpoint te beperken;
- technische fouten te onderzoeken.

Reisplannerrequests worden doorgestuurd naar de NS Reisplanner API. Raadpleeg ook de voorwaarden en privacyinformatie van NS voor de verwerking door NS.

## Logging

De Worker logt technische gebeurtenissen zoals toolnaam, resultaatstatus en duur van de call. De server logt geen `NS_API_KEY`, volledige toolargumenten of volledige reisadviezen.

Cloudflare kan daarnaast standaard platformlogs en beveiligingsgegevens verwerken voor hosting, beveiliging en misbruikpreventie.

## Bewaartermijn

De applicatie bewaart zelf geen permanente gebruikersprofielen of reisgeschiedenis. Tijdelijke caches worden gebruikt voor stationszoekopdrachten en verstoringen:

- stationszoekopdrachten en stationsdetails: maximaal 24 uur per Worker isolate;
- dichtstbijzijnde stations: maximaal 10 minuten per Worker isolate, keyed op afgeronde coordinaten;
- stationborden, ritdetails en verstoringen: kort, meestal maximaal 60 seconden per Worker isolate;
- prijsinformatie: maximaal 1 uur per Worker isolate;
- rate-limit tellers: maximaal circa 1 minuut in een Cloudflare Durable Object.

Cloudflare platformlogs kunnen volgens de instellingen van het Cloudflare-account tijdelijk beschikbaar blijven.

## Delen met derden

Gegevens worden alleen gedeeld met partijen die nodig zijn om de dienst te leveren:

- Cloudflare voor hosting, beveiliging en rate limiting;
- NS Reisplanner API voor actuele treinreisinformatie.

## Contact

Gebruik [docs/support.md](support.md) voor supportvragen, foutmeldingen of verzoeken over gegevensverwerking.
