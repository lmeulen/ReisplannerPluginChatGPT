import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod/v4';

import { getDefaultResponseMode, getMcpRateLimitPerMinute, getNsApiBaseUrl } from './config';
import { NsClient } from './nsClient';
import type {
  AppContext,
  DisruptionResult,
  DomesticPriceResult,
  Env,
  JourneyDetailsResult,
  JourneyOption,
  Language,
  StationArrivalResult,
  StationDepartureResult,
  StationInfoResult,
  StationResult
} from './types';

type JsonRpcId = string | number | null;

interface JsonRpcProbe {
  id: JsonRpcId;
  method: string;
}

interface CachedValue<T> {
  expiresAt: number;
  value: T;
}

interface LocalRateLimitBucket {
  count: number;
  resetAt: number;
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const localRateLimitBuckets = new Map<string, LocalRateLimitBucket>();
const stationCache = new Map<string, CachedValue<StationResult[]>>();
const stationInfoCache = new Map<string, CachedValue<StationInfoResult | null>>();
const nearestStationsCache = new Map<string, CachedValue<StationResult[]>>();
const departureCache = new Map<string, CachedValue<StationDepartureResult[]>>();
const arrivalCache = new Map<string, CachedValue<StationArrivalResult[]>>();
const singleTripCache = new Map<string, CachedValue<JourneyOption[]>>();
const journeyDetailsCache = new Map<string, CachedValue<JourneyDetailsResult>>();
const priceCache = new Map<string, CachedValue<DomesticPriceResult | null>>();
const disruptionCache = new Map<string, CachedValue<DisruptionResult[]>>();
const stationDisruptionCache = new Map<string, CachedValue<DisruptionResult[]>>();
const singleDisruptionCache = new Map<string, CachedValue<DisruptionResult | null>>();

const readOnlyOpenWorldAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true
};

const workflowPresentationInstructions =
  'Voor workflowtools: gebruik de tekst uit content als primaire gebruikersweergave. Behoud de volgorde, koppen en regelafbrekingen. Geef geen tweede alternatieve samenvatting. Toon alleen treinritten; laat buslegs weg. Gebruik uitsluitend waarden uit de toolresponse en schrijf "onbekend" als een waarde ontbreekt.';

const stationOutputSchema = z.object({
  code: z.string(),
  name: z.string(),
  country: z.string(),
  type: z.string(),
  score: z.number(),
  matchType: z.enum(['exact', 'contains', 'fuzzy', 'fallback']),
  uicCode: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  distanceMeters: z.number().nullable().optional()
});

const stationInfoOutputSchema = z.object({
  code: z.string(),
  name: z.string(),
  country: z.string(),
  type: z.string(),
  uicCode: z.string().nullable(),
  evaCode: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  aliases: z.array(z.string()),
  synonyms: z.array(z.string()),
  tracks: z.array(z.string()),
  hasFacilities: z.boolean().nullable(),
  hasTravelAssistance: z.boolean().nullable(),
  hasDepartures: z.boolean().nullable()
});

const routeStationOutputSchema = z.object({
  name: z.string().nullable(),
  uicCode: z.string().nullable()
});

const departureOutputSchema = z.object({
  name: z.string(),
  direction: z.string(),
  plannedDateTime: z.string().nullable(),
  actualDateTime: z.string().nullable(),
  plannedPlatform: z.string().nullable(),
  actualPlatform: z.string().nullable(),
  product: z.string(),
  trainNumber: z.string().nullable(),
  status: z.string().nullable(),
  cancelled: z.boolean(),
  delay: z.string().nullable(),
  journeyDetailRef: z.string().nullable(),
  messages: z.array(z.string()),
  routeStations: z.array(routeStationOutputSchema),
  operatorName: z.string().nullable(),
  lineNumber: z.string().nullable(),
  productType: z.string().nullable()
});

const arrivalOutputSchema = z.object({
  name: z.string(),
  origin: z.string(),
  plannedDateTime: z.string().nullable(),
  actualDateTime: z.string().nullable(),
  plannedPlatform: z.string().nullable(),
  actualPlatform: z.string().nullable(),
  product: z.string(),
  trainNumber: z.string().nullable(),
  status: z.string().nullable(),
  cancelled: z.boolean(),
  delay: z.string().nullable(),
  journeyDetailRef: z.string().nullable(),
  messages: z.array(z.string()),
  operatorName: z.string().nullable(),
  lineNumber: z.string().nullable(),
  productType: z.string().nullable()
});

const journeyLegOutputSchema = z.object({
  origin: z.string(),
  destination: z.string(),
  plannedDeparture: z.string().nullable(),
  actualDeparture: z.string().nullable(),
  plannedArrival: z.string().nullable(),
  actualArrival: z.string().nullable(),
  transportType: z.string(),
  lineName: z.string().nullable(),
  direction: z.string().nullable(),
  plannedPlatform: z.string().nullable(),
  actualPlatform: z.string().nullable(),
  cancelled: z.boolean(),
  journeyDetailRef: z.string().nullable(),
  routeId: z.string().nullable()
});

const journeyOutputSchema = z.object({
  id: z.string(),
  ctxRecon: z.string().nullable(),
  routeId: z.string().nullable(),
  summary: z.object({
    departure: z.string().nullable(),
    arrival: z.string().nullable(),
    durationMinutes: z.number().nullable(),
    transfers: z.number(),
    status: z.string()
  }),
  legs: z.array(journeyLegOutputSchema),
  warnings: z.array(z.string())
});

const journeyDetailsOutputSchema = z.object({
  source: z.string().nullable(),
  productNumbers: z.array(z.string()),
  allowCrowdReporting: z.boolean().nullable(),
  stops: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.string().nullable(),
      plannedArrival: z.string().nullable(),
      actualArrival: z.string().nullable(),
      plannedDeparture: z.string().nullable(),
      actualDeparture: z.string().nullable(),
      plannedPlatform: z.string().nullable(),
      actualPlatform: z.string().nullable(),
      status: z.string().nullable(),
      cancelled: z.boolean()
    })
  ),
  notes: z.array(z.string())
});

const domesticPriceOutputSchema = z.object({
  totalPriceInCents: z.number(),
  totalPrice: z.string(),
  travelClass: z.string(),
  travelDiscount: z.string(),
  travelProducts: z.array(z.string()),
  operatorName: z.string().nullable(),
  priceDifferenceInCentsBetweenFirstAndSecondClass: z.number().nullable(),
  priceDifferenceInCentsBetweenJointJourneyDiscount: z.number().nullable()
});

const disruptionOutputSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string(),
  topic: z.string().nullable(),
  isActive: z.boolean().nullable(),
  severity: z.string().nullable(),
  period: z.string().nullable(),
  advice: z.string().nullable()
});

const resolvedStationOutputSchema = z.object({
  input: z.string(),
  station: stationOutputSchema.nullable()
});

const journeyDetailsItemOutputSchema = z.object({
  journeyDetailRef: z.string(),
  journeyDetails: journeyDetailsOutputSchema
});

const warningOutputSchema = z.object({
  source: z.string(),
  message: z.string()
});

export async function handleMcpRequest(context: AppContext, exposeApiNearTools = false): Promise<Response> {
  const rateLimit = await checkRateLimit(context);
  if (!rateLimit.allowed) {
    return Response.json(
      { jsonrpc: '2.0', id: rateLimit.id, error: { code: -32029, message: `Rate limit exceeded. Try again in ${rateLimit.retryAfterSeconds} seconds.` } },
      { status: 429, headers: { 'Cache-Control': 'no-store', 'Retry-After': String(rateLimit.retryAfterSeconds) } }
    );
  }

  const transport = new WebStandardStreamableHTTPServerTransport();
  const server = createMcpServer(context.env, exposeApiNearTools);
  await server.connect(transport);
  return transport.handleRequest(context.req.raw);
}

function createMcpServer(env: Env, exposeApiNearTools: boolean): McpServer {
  const server = new McpServer(
    { name: 'nederlandse-treinreisplanner-mcp', version: '1.0.0' },
    {
      instructions:
        `Gebruik deze server voor actuele Nederlandse treinreisinformatie. Alle tools zijn read-only. Verzin nooit tijden, routes, perrons, prijzen of verstoringen die niet in de tool-output staan. ${workflowPresentationInstructions}`
    }
  );

  // Keep API-near registrations in the source for internal reuse, but expose only workflowtools publicly.
  if (exposeApiNearTools) {
  server.registerTool(
    'search_stations',
    {
      title: 'Search stations',
      description: 'Zoek Nederlandse of internationale plannable stations op naam en geef stationcodes terug.',
      inputSchema: {
        query: z.string().trim().min(2).max(80).describe('Stationsnaam of deel daarvan, bijvoorbeeld Amsterdam.'),
        countryCodes: z.array(z.string().trim().min(2).max(2)).optional().describe('Optionele ISO-landcodes, bijvoorbeeld NL of BE.'),
        limit: z.number().int().min(1).max(20).default(8),
        language: z.enum(['nl', 'en']).default('nl')
      },
      outputSchema: { stations: z.array(stationOutputSchema) },
      annotations: readOnlyOpenWorldAnnotations
    },
    async ({ query, countryCodes, limit, language }) => {
      const stations = await observeToolCall(env, 'search_stations', { query, countryCodes, limit, language }, async () => getCachedStations(env, query, language, limit, countryCodes));
      return { structuredContent: { stations }, content: [{ type: 'text', text: summarizeStations(query, stations) }] };
    }
  );

  server.registerTool(
    'get_station_info',
    {
      title: 'Get station info',
      description: 'Haal stationsdetails op voor een stationcode, zoals UIC-code, coordinaten, faciliteiten, sporen en synoniemen.',
      inputSchema: {
        stationCode: z.string().trim().min(2).max(10).describe('Stationcode, bijvoorbeeld ASD of UT.'),
        language: z.enum(['nl', 'en']).default('nl')
      },
      outputSchema: { station: stationInfoOutputSchema.nullable() },
      annotations: readOnlyOpenWorldAnnotations
    },
    async (input) => {
      const station = await observeToolCall(env, 'get_station_info', input, async () => getCachedStationInfo(env, input.stationCode, input.language));
      return { structuredContent: { station }, content: [{ type: 'text', text: summarizeStationInfo(input.stationCode, station) }] };
    }
  );

  server.registerTool(
    'get_nearest_stations',
    {
      title: 'Get nearest stations',
      description: 'Zoek de dichtstbijzijnde plannable stations bij expliciet opgegeven coordinaten.',
      inputSchema: {
        latitude: z.number().min(-90).max(90).describe('Breedtegraad die expliciet door de gebruiker of client is gegeven.'),
        longitude: z.number().min(-180).max(180).describe('Lengtegraad die expliciet door de gebruiker of client is gegeven.'),
        limit: z.number().int().min(1).max(10).default(5),
        language: z.enum(['nl', 'en']).default('nl')
      },
      outputSchema: { stations: z.array(stationOutputSchema) },
      annotations: readOnlyOpenWorldAnnotations
    },
    async (input) => {
      const stations = await observeToolCall(env, 'get_nearest_stations', input, async () => getCachedNearestStations(env, input));
      return { structuredContent: { stations }, content: [{ type: 'text', text: summarizeNearestStations(stations) }] };
    }
  );

  server.registerTool(
    'get_station_departures',
    {
      title: 'Get station departures',
      description: 'Haal het actuele vertrekbord op voor een station via stationcode of UIC-code.',
      inputSchema: boardInputSchema('Optioneel moment. Volgens NS vooral ondersteund voor buitenlandse stations.'),
      outputSchema: { departures: z.array(departureOutputSchema) },
      annotations: readOnlyOpenWorldAnnotations
    },
    async (input) => {
      assertStationBoardInput(input.stationCode, input.uicCode);
      const departures = await observeToolCall(env, 'get_station_departures', input, async () => getCachedDepartures(env, input));
      return { structuredContent: { departures }, content: [{ type: 'text', text: summarizeDepartures(input.stationCode ?? input.uicCode ?? 'station', departures) }] };
    }
  );

  server.registerTool(
    'get_station_arrivals',
    {
      title: 'Get station arrivals',
      description: 'Haal het actuele aankomstbord op voor een station via stationcode of UIC-code.',
      inputSchema: boardInputSchema('Optioneel moment. Volgens NS vooral ondersteund voor buitenlandse stations.'),
      outputSchema: { arrivals: z.array(arrivalOutputSchema) },
      annotations: readOnlyOpenWorldAnnotations
    },
    async (input) => {
      assertStationBoardInput(input.stationCode, input.uicCode);
      const arrivals = await observeToolCall(env, 'get_station_arrivals', input, async () => getCachedArrivals(env, input));
      return { structuredContent: { arrivals }, content: [{ type: 'text', text: summarizeArrivals(input.stationCode ?? input.uicCode ?? 'station', arrivals) }] };
    }
  );

  server.registerTool(
    'plan_journey',
    {
      title: 'Plan journey',
      description: 'Plan een actuele station-tot-station treinreis via de NS Reisplanner API.',
      inputSchema: {
        from: z.string().trim().min(2).max(80).describe('Vertrekstation, bij voorkeur stationcode zoals ASD.'),
        to: z.string().trim().min(2).max(80).describe('Aankomststation, bij voorkeur stationcode zoals UT.'),
        dateTime: z.string().datetime({ offset: true }).optional(),
        searchForArrival: z.boolean().default(false),
        viaStation: z.string().trim().min(2).max(80).optional(),
        localTrainsOnly: z.boolean().optional(),
        excludeHighSpeedTrains: z.boolean().optional(),
        excludeTrainsWithReservationRequired: z.boolean().optional(),
        addChangeTime: z.number().int().min(0).max(60).optional(),
        travelClass: z.union([z.literal(1), z.literal(2)]).optional(),
        discount: z.string().trim().min(1).max(80).optional(),
        passing: z.boolean().optional(),
        showLiftInfo: z.boolean().optional(),
        language: z.enum(['nl', 'en']).default('nl'),
        responseMode: z.enum(['strict', 'flexible']).optional(),
        preferences: z
          .object({
            minimizeTransfers: z.boolean().default(false),
            extraTransferTimeMinutes: z.number().int().min(0).max(60).default(0),
            accessible: z.boolean().default(false)
          })
          .default({ minimizeTransfers: false, extraTransferTimeMinutes: 0, accessible: false })
      },
      outputSchema: { journeys: z.array(journeyOutputSchema) },
      annotations: readOnlyOpenWorldAnnotations
    },
    async (input) => {
      const journeys = await observeToolCall(env, 'plan_journey', input, async () => nsClient(env).planJourney(input));
      return { structuredContent: { journeys }, content: [{ type: 'text', text: summarizeJourneys(input.from, input.to, journeys, input.responseMode ?? getDefaultResponseMode(env)) }] };
    }
  );

  server.registerTool(
    'get_single_trip',
    {
      title: 'Get single trip',
      description: 'Reconstrueer een volledige trip met de ctxRecon waarde uit plan_journey.',
      inputSchema: {
        ctxRecon: z.string().trim().min(2).max(4096),
        date: z.string().datetime({ offset: true }).optional(),
        travelRequestType: z.string().trim().min(1).max(80).optional(),
        sourceCtxRecon: z.boolean().optional(),
        product: z.string().trim().min(1).max(80).optional(),
        discount: z.string().trim().min(1).max(80).optional(),
        travelClass: z.union([z.literal(1), z.literal(2)]).optional(),
        language: z.enum(['nl', 'en']).default('nl')
      },
      outputSchema: { journeys: z.array(journeyOutputSchema) },
      annotations: readOnlyOpenWorldAnnotations
    },
    async (input) => {
      const journeys = await observeToolCall(env, 'get_single_trip', input, async () => getCachedSingleTrip(env, input));
      return { structuredContent: { journeys }, content: [{ type: 'text', text: summarizeSingleTrip(input.ctxRecon, journeys) }] };
    }
  );

  server.registerTool(
    'get_journey_details',
    {
      title: 'Get journey details',
      description: 'Haal ritdetails op met journeyDetailRef uit vertrek/aankomst/trip legs of met een treinnummer.',
      inputSchema: {
        journeyDetailRef: z.string().trim().min(2).max(4096).optional(),
        trainNumber: z.number().int().positive().optional(),
        dateTime: z.string().datetime({ offset: true }).optional(),
        departureUicCode: z.string().trim().min(2).max(16).optional(),
        transferUicCode: z.string().trim().min(2).max(16).optional(),
        arrivalUicCode: z.string().trim().min(2).max(16).optional(),
        omitCrowdForecast: z.boolean().default(false),
        language: z.enum(['nl', 'en']).default('nl')
      },
      outputSchema: { journeyDetails: journeyDetailsOutputSchema },
      annotations: readOnlyOpenWorldAnnotations
    },
    async (input) => {
      if (!input.journeyDetailRef && !input.trainNumber) throw new Error('journeyDetailRef or trainNumber is required.');
      const journeyDetails = await observeToolCall(env, 'get_journey_details', input, async () => getCachedJourneyDetails(env, input));
      return { structuredContent: { journeyDetails }, content: [{ type: 'text', text: summarizeJourneyDetails(journeyDetails) }] };
    }
  );

  server.registerTool(
    'get_domestic_price',
    {
      title: 'Get domestic price',
      description: 'Haal prijsinformatie op voor een binnenlandse reis tussen twee stationcodes.',
      inputSchema: {
        fromStation: z.string().trim().min(2).max(10),
        toStation: z.string().trim().min(2).max(10),
        travelClass: z.string().trim().min(1).max(40).optional(),
        travelType: z.string().trim().min(1).max(40).optional(),
        isJointJourney: z.boolean().default(false),
        adults: z.number().int().min(0).max(9).default(1),
        children: z.number().int().min(0).max(9).default(0),
        routeId: z.string().trim().min(1).max(512).optional(),
        plannedFromTime: z.string().trim().min(1).max(80).optional(),
        plannedArrivalTime: z.string().trim().min(1).max(80).optional()
      },
      outputSchema: { price: domesticPriceOutputSchema.nullable() },
      annotations: readOnlyOpenWorldAnnotations
    },
    async (input) => {
      const price = await observeToolCall(env, 'get_domestic_price', input, async () => getCachedDomesticPrice(env, input));
      return { structuredContent: { price }, content: [{ type: 'text', text: summarizePrice(input.fromStation, input.toStation, price) }] };
    }
  );

  server.registerTool(
    'get_disruptions',
    {
      title: 'Get disruptions',
      description: 'Haal algemene actuele NS-verstoringen, calamiteiten en werkzaamheden op.',
      inputSchema: {
        types: z.array(z.string().trim().min(1).max(40)).optional().describe('Optionele types, bijvoorbeeld CALAMITY of MAINTENANCE.'),
        isActive: z.boolean().optional(),
        language: z.enum(['nl', 'en']).default('nl')
      },
      outputSchema: { disruptions: z.array(disruptionOutputSchema) },
      annotations: readOnlyOpenWorldAnnotations
    },
    async (input) => {
      const disruptions = await observeToolCall(env, 'get_disruptions', input, async () => getCachedDisruptions(env, input));
      return { structuredContent: { disruptions }, content: [{ type: 'text', text: summarizeDisruptions(disruptions) }] };
    }
  );

  server.registerTool(
    'get_station_disruptions',
    {
      title: 'Get station disruptions',
      description: 'Haal verstoringen op die relevant zijn voor een specifiek station.',
      inputSchema: {
        stationCode: z.string().trim().min(2).max(10),
        language: z.enum(['nl', 'en']).default('nl')
      },
      outputSchema: { disruptions: z.array(disruptionOutputSchema) },
      annotations: readOnlyOpenWorldAnnotations
    },
    async (input) => {
      const disruptions = await observeToolCall(env, 'get_station_disruptions', input, async () => getCachedStationDisruptions(env, input));
      return { structuredContent: { disruptions }, content: [{ type: 'text', text: summarizeDisruptions(disruptions) }] };
    }
  );

  server.registerTool(
    'get_single_disruption',
    {
      title: 'Get single disruption',
      description: 'Haal details op van een verstoring met type en id uit een verstoringslijst.',
      inputSchema: {
        type: z.string().trim().min(1).max(40),
        id: z.string().trim().min(1).max(512),
        language: z.enum(['nl', 'en']).default('nl')
      },
      outputSchema: { disruption: disruptionOutputSchema.nullable() },
      annotations: readOnlyOpenWorldAnnotations
    },
    async (input) => {
      const disruption = await observeToolCall(env, 'get_single_disruption', input, async () => getCachedSingleDisruption(env, input));
      return { structuredContent: { disruption }, content: [{ type: 'text', text: summarizeSingleDisruption(disruption) }] };
    }
  );
  }

  server.registerTool(
    'plan_resolved_journey',
    {
      title: 'Plan resolved journey',
      description: `Plan een treinreis met stationsnamen, stationcodes of typfouten; de server resolveert stations eerst zelf. ${workflowPresentationInstructions}`,
      inputSchema: resolvedJourneyInputSchema(),
      outputSchema: { fromStation: resolvedStationOutputSchema, toStation: resolvedStationOutputSchema, journeys: z.array(journeyOutputSchema) },
      annotations: readOnlyOpenWorldAnnotations
    },
    async (input) => {
      const result = await observeToolCall(env, 'plan_resolved_journey', input, async () => planResolvedJourney(env, input));
      return { structuredContent: result, content: [{ type: 'text', text: formatJourneyResponse(result.fromStation.station, result.toStation.station, result.journeys) }] };
    }
  );

  server.registerTool(
    'get_resolved_station_departures',
    {
      title: 'Get resolved station departures',
      description: 'Haal het vertrekbord op met een stationsnaam, stationcode of typfout.',
      inputSchema: resolvedStationBoardInputSchema(),
      outputSchema: { station: resolvedStationOutputSchema, departures: z.array(departureOutputSchema) },
      annotations: readOnlyOpenWorldAnnotations
    },
    async (input) => {
      const result = await observeToolCall(env, 'get_resolved_station_departures', input, async () => getResolvedDepartures(env, input));
      return { structuredContent: result, content: [{ type: 'text', text: summarizeDepartures(result.station.station?.name ?? input.station, result.departures) }] };
    }
  );

  server.registerTool(
    'get_resolved_station_arrivals',
    {
      title: 'Get resolved station arrivals',
      description: 'Haal het aankomstbord op met een stationsnaam, stationcode of typfout.',
      inputSchema: resolvedStationBoardInputSchema(),
      outputSchema: { station: resolvedStationOutputSchema, arrivals: z.array(arrivalOutputSchema) },
      annotations: readOnlyOpenWorldAnnotations
    },
    async (input) => {
      const result = await observeToolCall(env, 'get_resolved_station_arrivals', input, async () => getResolvedArrivals(env, input));
      return { structuredContent: result, content: [{ type: 'text', text: summarizeArrivals(result.station.station?.name ?? input.station, result.arrivals) }] };
    }
  );

  server.registerTool(
    'get_resolved_station_disruptions',
    {
      title: 'Get resolved station disruptions',
      description: 'Haal station-specifieke verstoringen op met een stationsnaam, stationcode of typfout.',
      inputSchema: resolvedStationInputSchema(),
      outputSchema: { station: resolvedStationOutputSchema, disruptions: z.array(disruptionOutputSchema) },
      annotations: readOnlyOpenWorldAnnotations
    },
    async (input) => {
      const result = await observeToolCall(env, 'get_resolved_station_disruptions', input, async () => getResolvedStationDisruptions(env, input));
      return { structuredContent: result, content: [{ type: 'text', text: summarizeDisruptions(result.disruptions) }] };
    }
  );

  server.registerTool(
    'price_resolved_journey',
    {
      title: 'Price resolved journey',
      description: 'Haal prijsinformatie op met stationsnamen, stationcodes of typfouten; plant optioneel eerst een route voor routeId en tijden.',
      inputSchema: priceResolvedJourneyInputSchema(),
      outputSchema: { fromStation: resolvedStationOutputSchema, toStation: resolvedStationOutputSchema, journeys: z.array(journeyOutputSchema), price: domesticPriceOutputSchema.nullable() },
      annotations: readOnlyOpenWorldAnnotations
    },
    async (input) => {
      const result = await observeToolCall(env, 'price_resolved_journey', input, async () => priceResolvedJourney(env, input));
      return { structuredContent: result, content: [{ type: 'text', text: summarizePrice(result.fromStation.station?.code ?? input.from, result.toStation.station?.code ?? input.to, result.price) }] };
    }
  );

  server.registerTool(
    'get_planned_journey_details',
    {
      title: 'Get planned journey details',
      description: `Plan een treinreis met stationsnamen en haal voor de beste optie single-trip en ritdetails op. ${workflowPresentationInstructions}`,
      inputSchema: plannedJourneyDetailsInputSchema(),
      outputSchema: {
        fromStation: resolvedStationOutputSchema,
        toStation: resolvedStationOutputSchema,
        journeys: z.array(journeyOutputSchema),
        singleTrip: z.array(journeyOutputSchema),
        journeyDetails: z.array(journeyDetailsItemOutputSchema)
      },
      annotations: readOnlyOpenWorldAnnotations
    },
    async (input) => {
      const result = await observeToolCall(env, 'get_planned_journey_details', input, async () => getPlannedJourneyDetails(env, input));
      return { structuredContent: result, content: [{ type: 'text', text: formatJourneyDetailsResponse(result) }] };
    }
  );

  server.registerTool(
    'check_route_disruptions',
    {
      title: 'Check route disruptions',
      description: 'Controleer verstoringen en waarschuwingen voor een route met stationsnamen of stationcodes.',
      inputSchema: resolvedJourneyInputSchema(),
      outputSchema: { fromStation: resolvedStationOutputSchema, toStation: resolvedStationOutputSchema, journeys: z.array(journeyOutputSchema), disruptions: z.array(disruptionOutputSchema), warnings: z.array(warningOutputSchema) },
      annotations: readOnlyOpenWorldAnnotations
    },
    async (input) => {
      const result = await observeToolCall(env, 'check_route_disruptions', input, async () => checkRouteDisruptions(env, input));
      return { structuredContent: result, content: [{ type: 'text', text: summarizeRouteDisruptions(result.disruptions, result.warnings) }] };
    }
  );

  server.registerTool(
    'check_journey_status',
    {
      title: 'Check journey status',
      description: `Controleer of een geplande treinreis vertraagd, geannuleerd of afwijkend is. ${workflowPresentationInstructions}`,
      inputSchema: resolvedJourneyInputSchema(),
      outputSchema: { fromStation: resolvedStationOutputSchema, toStation: resolvedStationOutputSchema, journeys: z.array(journeyOutputSchema), warnings: z.array(warningOutputSchema) },
      annotations: readOnlyOpenWorldAnnotations
    },
    async (input) => {
      const result = await observeToolCall(env, 'check_journey_status', input, async () => checkJourneyStatus(env, input));
      return { structuredContent: result, content: [{ type: 'text', text: summarizeJourneyStatus(result.journeys, result.warnings) }] };
    }
  );

  server.registerTool(
    'find_departure_platform',
    {
      title: 'Find departure platform',
      description: `Vind het vertrekspoor voor een trein vanaf een station richting een bestemming met stationsnamen of typfouten. ${workflowPresentationInstructions}`,
      inputSchema: findDeparturePlatformInputSchema(),
      outputSchema: { station: resolvedStationOutputSchema, destinationStation: resolvedStationOutputSchema, departures: z.array(departureOutputSchema) },
      annotations: readOnlyOpenWorldAnnotations
    },
    async (input) => {
      const result = await observeToolCall(env, 'find_departure_platform', input, async () => findDeparturePlatform(env, input));
      return { structuredContent: result, content: [{ type: 'text', text: summarizeDeparturePlatform(result.departures) }] };
    }
  );

  server.registerTool(
    'check_planned_journey_warnings',
    {
      title: 'Check planned journey warnings',
      description: 'Plan een reis en verzamel waarschuwingen en stationverstoringen voor de beste optie.',
      inputSchema: resolvedJourneyInputSchema(),
      outputSchema: { fromStation: resolvedStationOutputSchema, toStation: resolvedStationOutputSchema, journeys: z.array(journeyOutputSchema), disruptions: z.array(disruptionOutputSchema), warnings: z.array(warningOutputSchema) },
      annotations: readOnlyOpenWorldAnnotations
    },
    async (input) => {
      const result = await observeToolCall(env, 'check_planned_journey_warnings', input, async () => checkPlannedJourneyWarnings(env, input));
      return { structuredContent: result, content: [{ type: 'text', text: summarizeRouteDisruptions(result.disruptions, result.warnings) }] };
    }
  );

  server.registerTool(
    'resolve_station',
    {
      title: 'Resolve station',
      description: 'Vind de beste stationmatch voor een stationsnaam, afkorting, stationcode of typfout.',
      inputSchema: resolvedStationInputSchema(),
      outputSchema: { station: resolvedStationOutputSchema },
      annotations: readOnlyOpenWorldAnnotations
    },
    async (input) => {
      const station = await observeToolCall(env, 'resolve_station', input, async () => resolveStation(env, input.station, input.language));
      return { structuredContent: { station }, content: [{ type: 'text', text: summarizeResolvedStation(input.station, station.station) }] };
    }
  );

  server.registerTool(
    'find_nearest_station',
    {
      title: 'Find nearest station',
      description: 'Vind het dichtstbijzijnde station bij expliciet opgegeven coordinaten.',
      inputSchema: {
        latitude: z.number().min(-90).max(90).describe('Breedtegraad die expliciet door de gebruiker of client is gegeven.'),
        longitude: z.number().min(-180).max(180).describe('Lengtegraad die expliciet door de gebruiker of client is gegeven.'),
        limit: z.number().int().min(1).max(10).default(5),
        language: z.enum(['nl', 'en']).default('nl')
      },
      outputSchema: { station: stationOutputSchema.nullable(), stations: z.array(stationOutputSchema) },
      annotations: readOnlyOpenWorldAnnotations
    },
    async (input) => {
      const stations = await observeToolCall(env, 'find_nearest_station', input, async () => getCachedNearestStations(env, input));
      return { structuredContent: { station: stations[0] ?? null, stations }, content: [{ type: 'text', text: summarizeNearestStations(stations) }] };
    }
  );

  server.registerTool(
    'get_train_stops',
    {
      title: 'Get train stops',
      description: 'Toon tussenstops met een journeyDetailRef, treinnummer of een geplande route met stationsnamen.',
      inputSchema: {
        journeyDetailRef: z.string().trim().min(2).max(4096).optional(),
        trainNumber: z.number().int().positive().optional(),
        from: z.string().trim().min(2).max(80).optional(),
        to: z.string().trim().min(2).max(80).optional(),
        dateTime: z.string().datetime({ offset: true }).optional(),
        omitCrowdForecast: z.boolean().default(false),
        language: z.enum(['nl', 'en']).default('nl')
      },
      outputSchema: { fromStation: resolvedStationOutputSchema.optional(), toStation: resolvedStationOutputSchema.optional(), journeyDetails: journeyDetailsOutputSchema },
      annotations: readOnlyOpenWorldAnnotations
    },
    async (input) => {
      const result = await observeToolCall(env, 'get_train_stops', input, async () => getTrainStops(env, input));
      return { structuredContent: result, content: [{ type: 'text', text: summarizeJourneyDetails(result.journeyDetails) }] };
    }
  );

  return server;
}

function boardInputSchema(dateTimeDescription: string) {
  return {
    stationCode: z.string().trim().min(2).max(10).optional().describe('NS stationcode, bijvoorbeeld ASD of UT.'),
    uicCode: z.string().trim().min(2).max(16).optional().describe('UIC-code als alternatief voor stationCode.'),
    dateTime: z.string().datetime({ offset: true }).optional().describe(dateTimeDescription),
    maxResults: z.number().int().min(1).max(40).default(10),
    language: z.enum(['nl', 'en']).default('nl')
  };
}

function assertStationBoardInput(stationCode?: string, uicCode?: string): void {
  if (!stationCode && !uicCode) throw new Error('stationCode or uicCode is required.');
}

function resolvedStationInputSchema() {
  return {
    station: z.string().trim().min(2).max(80).describe('Stationcode, stationsnaam of typfout, bijvoorbeeld Amsterdam Centraal of Amsterdm.'),
    language: z.enum(['nl', 'en']).default('nl')
  };
}

function resolvedStationBoardInputSchema() {
  return {
    ...resolvedStationInputSchema(),
    dateTime: z.string().datetime({ offset: true }).optional(),
    maxResults: z.number().int().min(1).max(40).default(10)
  };
}

function resolvedJourneyInputSchema() {
  return {
    from: z.string().trim().min(2).max(80),
    to: z.string().trim().min(2).max(80),
    dateTime: z.string().datetime({ offset: true }).optional(),
    searchForArrival: z.boolean().default(false),
    viaStation: z.string().trim().min(2).max(80).optional(),
    localTrainsOnly: z.boolean().optional(),
    excludeHighSpeedTrains: z.boolean().optional(),
    excludeTrainsWithReservationRequired: z.boolean().optional(),
    addChangeTime: z.number().int().min(0).max(60).optional(),
    travelClass: z.union([z.literal(1), z.literal(2)]).optional(),
    discount: z.string().trim().min(1).max(80).optional(),
    passing: z.boolean().optional(),
    showLiftInfo: z.boolean().optional(),
    accessible: z.boolean().default(false),
    language: z.enum(['nl', 'en']).default('nl')
  };
}

function priceResolvedJourneyInputSchema() {
  return {
    ...resolvedJourneyInputSchema(),
    travelType: z.string().trim().min(1).max(40).optional(),
    isJointJourney: z.boolean().default(false),
    adults: z.number().int().min(0).max(9).default(1),
    children: z.number().int().min(0).max(9).default(0)
  };
}

function plannedJourneyDetailsInputSchema() {
  return {
    ...resolvedJourneyInputSchema(),
    journeyIndex: z.number().int().min(0).max(2).default(0)
  };
}

function findDeparturePlatformInputSchema() {
  return {
    station: z.string().trim().min(2).max(80),
    destination: z.string().trim().min(2).max(80),
    dateTime: z.string().datetime({ offset: true }).optional(),
    maxResults: z.number().int().min(1).max(40).default(20),
    language: z.enum(['nl', 'en']).default('nl')
  };
}

async function resolveStation(env: Env, input: string, language: Language): Promise<{ input: string; station: StationResult | null }> {
  const stations = await getCachedStations(env, input, language, 1, undefined);
  return { input, station: stations[0] ?? null };
}

function requireResolvedStation(resolved: { input: string; station: StationResult | null }): StationResult {
  if (!resolved.station) throw new Error(`No station found for ${resolved.input}.`);
  return resolved.station;
}

function journeyInputFromResolved(input: ResolvedJourneyInput, fromStation: StationResult, toStation: StationResult) {
  return {
    from: fromStation.code,
    to: toStation.code,
    dateTime: input.dateTime,
    searchForArrival: input.searchForArrival,
    language: input.language,
    viaStation: input.viaStation,
    localTrainsOnly: input.localTrainsOnly,
    excludeHighSpeedTrains: input.excludeHighSpeedTrains,
    excludeTrainsWithReservationRequired: input.excludeTrainsWithReservationRequired,
    addChangeTime: input.addChangeTime,
    travelClass: input.travelClass,
    discount: input.discount,
    passing: input.passing,
    showLiftInfo: input.showLiftInfo,
    preferences: {
      minimizeTransfers: false,
      extraTransferTimeMinutes: input.addChangeTime ?? 0,
      accessible: input.accessible
    }
  };
}

type ResolvedJourneyInput = {
  from: string;
  to: string;
  dateTime?: string;
  searchForArrival: boolean;
  viaStation?: string;
  localTrainsOnly?: boolean;
  excludeHighSpeedTrains?: boolean;
  excludeTrainsWithReservationRequired?: boolean;
  addChangeTime?: number;
  travelClass?: 1 | 2;
  discount?: string;
  passing?: boolean;
  showLiftInfo?: boolean;
  accessible: boolean;
  language: Language;
};

async function planResolvedJourney(env: Env, input: ResolvedJourneyInput) {
  const fromStation = await resolveStation(env, input.from, input.language);
  const toStation = await resolveStation(env, input.to, input.language);
  const journeys = await nsClient(env).planJourney(journeyInputFromResolved(input, requireResolvedStation(fromStation), requireResolvedStation(toStation)));
  return { fromStation, toStation, journeys };
}

async function getResolvedDepartures(env: Env, input: { station: string; dateTime?: string; maxResults: number; language: Language }) {
  const station = await resolveStation(env, input.station, input.language);
  const departures = await getCachedDepartures(env, { stationCode: requireResolvedStation(station).code, dateTime: input.dateTime, maxResults: input.maxResults, language: input.language });
  return { station, departures };
}

async function getResolvedArrivals(env: Env, input: { station: string; dateTime?: string; maxResults: number; language: Language }) {
  const station = await resolveStation(env, input.station, input.language);
  const arrivals = await getCachedArrivals(env, { stationCode: requireResolvedStation(station).code, dateTime: input.dateTime, maxResults: input.maxResults, language: input.language });
  return { station, arrivals };
}

async function getResolvedStationDisruptions(env: Env, input: { station: string; language: Language }) {
  const station = await resolveStation(env, input.station, input.language);
  const disruptions = await getCachedStationDisruptions(env, { stationCode: requireResolvedStation(station).code, language: input.language });
  return { station, disruptions };
}

async function priceResolvedJourney(env: Env, input: ResolvedJourneyInput & { travelType?: string; isJointJourney: boolean; adults: number; children: number }) {
  const resolved = await planResolvedJourney(env, input);
  const firstJourney = resolved.journeys[0];
  const price = await getCachedDomesticPrice(env, {
    fromStation: requireResolvedStation(resolved.fromStation).code,
    toStation: requireResolvedStation(resolved.toStation).code,
    travelClass: input.travelClass ? String(input.travelClass) : undefined,
    travelType: input.travelType,
    isJointJourney: input.isJointJourney,
    adults: input.adults,
    children: input.children,
    routeId: firstJourney?.routeId ?? undefined,
    plannedFromTime: firstJourney?.summary.departure ?? undefined,
    plannedArrivalTime: firstJourney?.summary.arrival ?? undefined
  });
  return { ...resolved, price };
}

async function getPlannedJourneyDetails(env: Env, input: ResolvedJourneyInput & { journeyIndex: number }) {
  const resolved = await planResolvedJourney(env, input);
  const selectedJourney = resolved.journeys[input.journeyIndex] ?? resolved.journeys[0];
  const singleTrip = selectedJourney?.ctxRecon ? await getCachedSingleTrip(env, { ctxRecon: selectedJourney.ctxRecon, language: input.language }) : [];
  const detailRefs = [...new Set((singleTrip[0]?.legs ?? selectedJourney?.legs ?? []).map((leg) => leg.journeyDetailRef).filter((value): value is string => Boolean(value)))].slice(0, 4);
  const journeyDetails = await Promise.all(
    detailRefs.map(async (journeyDetailRef) => ({
      journeyDetailRef,
      journeyDetails: await getCachedJourneyDetails(env, { journeyDetailRef, omitCrowdForecast: false, language: input.language })
    }))
  );
  return { ...resolved, singleTrip, journeyDetails };
}

async function checkRouteDisruptions(env: Env, input: ResolvedJourneyInput) {
  const resolved = await planResolvedJourney(env, input);
  const stationDisruptions = await Promise.all([
    getCachedStationDisruptions(env, { stationCode: requireResolvedStation(resolved.fromStation).code, language: input.language }),
    getCachedStationDisruptions(env, { stationCode: requireResolvedStation(resolved.toStation).code, language: input.language })
  ]);
  const warnings = collectJourneyWarnings(resolved.journeys);
  return { ...resolved, disruptions: dedupeDisruptions(stationDisruptions.flat()), warnings };
}

async function checkJourneyStatus(env: Env, input: ResolvedJourneyInput) {
  const resolved = await planResolvedJourney(env, input);
  return { ...resolved, warnings: collectJourneyWarnings(resolved.journeys) };
}

async function findDeparturePlatform(env: Env, input: { station: string; destination: string; dateTime?: string; maxResults: number; language: Language }) {
  const station = await resolveStation(env, input.station, input.language);
  const destinationStation = await resolveStation(env, input.destination, input.language);
  const destination = requireResolvedStation(destinationStation);
  const departures = await getCachedDepartures(env, { stationCode: requireResolvedStation(station).code, dateTime: input.dateTime, maxResults: input.maxResults, language: input.language });
  const filteredDepartures = departures.filter(
    (departure) =>
      normalizeText(departure.direction).includes(normalizeText(destination.name)) ||
      departure.routeStations.some((routeStation) => normalizeText(routeStation.name).includes(normalizeText(destination.name)) || routeStation.uicCode === destination.uicCode)
  );
  return { station, destinationStation, departures: filteredDepartures.length > 0 ? filteredDepartures : departures.slice(0, 3) };
}

async function checkPlannedJourneyWarnings(env: Env, input: ResolvedJourneyInput) {
  const route = await checkRouteDisruptions(env, input);
  return route;
}

async function getTrainStops(
  env: Env,
  input: { journeyDetailRef?: string; trainNumber?: number; from?: string; to?: string; dateTime?: string; omitCrowdForecast: boolean; language: Language }
): Promise<{ fromStation?: { input: string; station: StationResult | null }; toStation?: { input: string; station: StationResult | null }; journeyDetails: JourneyDetailsResult }> {
  if (input.journeyDetailRef || input.trainNumber) {
    return {
      journeyDetails: await getCachedJourneyDetails(env, {
        journeyDetailRef: input.journeyDetailRef,
        trainNumber: input.trainNumber,
        dateTime: input.dateTime,
        omitCrowdForecast: input.omitCrowdForecast,
        language: input.language
      })
    };
  }

  if (!input.from || !input.to) {
    throw new Error('journeyDetailRef, trainNumber, or both from and to are required.');
  }

  const resolved = await planResolvedJourney(env, {
    from: input.from,
    to: input.to,
    dateTime: input.dateTime,
    searchForArrival: false,
    accessible: false,
    language: input.language
  });
  const firstDetailRef = resolved.journeys[0]?.legs.find((leg) => leg.journeyDetailRef)?.journeyDetailRef;
  if (!firstDetailRef) throw new Error('No journeyDetailRef found for the planned route.');

  return {
    fromStation: resolved.fromStation,
    toStation: resolved.toStation,
    journeyDetails: await getCachedJourneyDetails(env, { journeyDetailRef: firstDetailRef, dateTime: input.dateTime, omitCrowdForecast: input.omitCrowdForecast, language: input.language })
  };
}

function collectJourneyWarnings(journeys: JourneyOption[]): Array<{ source: string; message: string }> {
  return journeys.flatMap((journey) => [
    ...journey.warnings.map((message) => ({ source: journey.id, message })),
    ...journey.legs.filter((leg) => leg.cancelled).map((leg) => ({ source: journey.id, message: `Leg ${leg.origin} naar ${leg.destination} is geannuleerd.` })),
    ...(journey.summary.status !== 'NORMAL' ? [{ source: journey.id, message: `Reisstatus: ${journey.summary.status}.` }] : [])
  ]);
}

function dedupeDisruptions(disruptions: DisruptionResult[]): DisruptionResult[] {
  return [...new Map(disruptions.map((disruption) => [`${disruption.type}:${disruption.id}`, disruption])).values()];
}

function normalizeText(value: string | null): string {
  return (value ?? '').toLocaleLowerCase('nl-NL');
}

async function getCachedStations(env: Env, query: string, language: Language, limit: number, countryCodes?: string[]): Promise<StationResult[]> {
  const key = JSON.stringify({ query: query.toLocaleLowerCase('nl-NL'), language, limit, countryCodes });
  const cached = getFromCache(stationCache, key);
  if (cached) return cached;

  const stations = await nsClient(env).searchStations({ query, language, limit, countryCodes });
  setCache(stationCache, key, stations, 86_400_000);
  return stations;
}

async function getCachedStationInfo(env: Env, stationCode: string, language: Language): Promise<StationInfoResult | null> {
  const key = `${language}:${stationCode.toLocaleUpperCase('nl-NL')}`;
  const cached = getFromCache(stationInfoCache, key);
  if (cached !== null) return cached;

  const station = await nsClient(env).getStationInfo({ stationCode, language });
  setCache(stationInfoCache, key, station, 86_400_000);
  return station;
}

async function getCachedNearestStations(env: Env, input: { latitude: number; longitude: number; limit: number; language: Language }): Promise<StationResult[]> {
  const roundedInput = { ...input, latitude: roundCoordinate(input.latitude), longitude: roundCoordinate(input.longitude) };
  const key = JSON.stringify(roundedInput);
  const cached = getFromCache(nearestStationsCache, key);
  if (cached) return cached;

  const stations = await nsClient(env).getNearestStations(roundedInput);
  setCache(nearestStationsCache, key, stations, 600_000);
  return stations;
}

async function getCachedDepartures(env: Env, input: { stationCode?: string; uicCode?: string; dateTime?: string; maxResults: number; language: Language }): Promise<StationDepartureResult[]> {
  const key = JSON.stringify(input);
  const cached = getFromCache(departureCache, key);
  if (cached) return cached;

  const departures = await nsClient(env).getDepartures(input);
  setCache(departureCache, key, departures, 30_000);
  return departures;
}

async function getCachedArrivals(env: Env, input: { stationCode?: string; uicCode?: string; dateTime?: string; maxResults: number; language: Language }): Promise<StationArrivalResult[]> {
  const key = JSON.stringify(input);
  const cached = getFromCache(arrivalCache, key);
  if (cached) return cached;

  const arrivals = await nsClient(env).getArrivals(input);
  setCache(arrivalCache, key, arrivals, 30_000);
  return arrivals;
}

async function getCachedSingleTrip(env: Env, input: { ctxRecon: string; date?: string; travelRequestType?: string; sourceCtxRecon?: boolean; product?: string; discount?: string; travelClass?: 1 | 2; language: Language }): Promise<JourneyOption[]> {
  const key = JSON.stringify(input);
  const cached = getFromCache(singleTripCache, key);
  if (cached) return cached;

  const journeys = await nsClient(env).getSingleTrip(input);
  setCache(singleTripCache, key, journeys, 30_000);
  return journeys;
}

async function getCachedJourneyDetails(env: Env, input: { journeyDetailRef?: string; trainNumber?: number; dateTime?: string; departureUicCode?: string; transferUicCode?: string; arrivalUicCode?: string; omitCrowdForecast: boolean; language: Language }): Promise<JourneyDetailsResult> {
  const key = JSON.stringify(input);
  const cached = getFromCache(journeyDetailsCache, key);
  if (cached) return cached;

  const journeyDetails = await nsClient(env).getJourneyDetails(input);
  setCache(journeyDetailsCache, key, journeyDetails, 30_000);
  return journeyDetails;
}

async function getCachedDomesticPrice(env: Env, input: { fromStation: string; toStation: string; travelClass?: string; travelType?: string; isJointJourney: boolean; adults: number; children: number; routeId?: string; plannedFromTime?: string; plannedArrivalTime?: string }): Promise<DomesticPriceResult | null> {
  const key = JSON.stringify(input);
  const cached = getFromCache(priceCache, key);
  if (cached !== null) return cached;

  const price = await nsClient(env).getDomesticPrice(input);
  setCache(priceCache, key, price, 3_600_000);
  return price;
}

async function getCachedDisruptions(env: Env, input: { types?: string[]; isActive?: boolean; language: Language }): Promise<DisruptionResult[]> {
  const key = JSON.stringify(input);
  const cached = getFromCache(disruptionCache, key);
  if (cached) return cached;

  const disruptions = await nsClient(env).getDisruptions(input);
  setCache(disruptionCache, key, disruptions, 60_000);
  return disruptions;
}

async function getCachedStationDisruptions(env: Env, input: { stationCode: string; language: Language }): Promise<DisruptionResult[]> {
  const key = JSON.stringify(input);
  const cached = getFromCache(stationDisruptionCache, key);
  if (cached) return cached;

  const disruptions = await nsClient(env).getStationDisruptions(input);
  setCache(stationDisruptionCache, key, disruptions, 60_000);
  return disruptions;
}

async function getCachedSingleDisruption(env: Env, input: { type: string; id: string; language: Language }): Promise<DisruptionResult | null> {
  const key = JSON.stringify(input);
  const cached = getFromCache(singleDisruptionCache, key);
  if (cached !== null) return cached;

  const disruption = await nsClient(env).getSingleDisruption(input);
  setCache(singleDisruptionCache, key, disruption, 60_000);
  return disruption;
}

function getFromCache<T>(cache: Map<string, CachedValue<T>>, key: string): T | null {
  const cached = cache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return cached.value;
}

function setCache<T>(cache: Map<string, CachedValue<T>>, key: string, value: T, ttlMs: number): void {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

async function observeToolCall<T>(env: Env, toolName: string, input: unknown, action: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  const toolCallId = crypto.randomUUID();
  try {
    const result = await action();
    logMcpEvent(env, {
      event: 'mcp_tool_call',
      toolCallId,
      toolName,
      outcome: 'success',
      durationMs: Date.now() - startedAt,
      parameters: sanitizeToolInput(input)
    });
    return result;
  } catch (error) {
    logMcpEvent(env, {
      event: 'mcp_tool_call',
      toolCallId,
      toolName,
      outcome: 'error',
      durationMs: Date.now() - startedAt,
      parameters: sanitizeToolInput(input),
      errorName: error instanceof Error ? error.name : 'UnknownError'
    });
    throw error;
  }
}

function logMcpEvent(env: Env, event: Record<string, unknown>): void {
  if (env.LOG_LEVEL === 'error' || env.LOG_LEVEL === 'warn') return;
  console.log(JSON.stringify({ category: 'mcp_tool_call', timestamp: new Date().toISOString(), ...event }));
}

function sanitizeToolInput(value: unknown, key = '', depth = 0): unknown {
  if (depth > 2) return '[truncated]';
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/api.?key|authorization|password|secret|token|ctxrecon|journey.?detail.?ref/i.test(key)) {
      return `[redacted:${value.length}]`;
    }
    return value.length > 160 ? `${value.slice(0, 157)}...` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeToolInput(item, key, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 40)
        .map(([entryKey, entryValue]) => [entryKey, sanitizeToolInput(entryValue, entryKey, depth + 1)])
    );
  }
  return '[unsupported]';
}

async function checkRateLimit(context: AppContext): Promise<{ allowed: true } | { allowed: false; id: JsonRpcId; retryAfterSeconds: number }> {
  const probe = await probeJsonRpc(context.req.raw.clone() as Request);
  if (probe?.method !== 'tools/call') return { allowed: true };

  const limit = getMcpRateLimitPerMinute(context.env);
  const clientKey = getClientKey(context);

  if (context.env.MCP_RATE_LIMITER) {
    const id = context.env.MCP_RATE_LIMITER.idFromName(clientKey);
    const stub = context.env.MCP_RATE_LIMITER.get(id);
    const response = await stub.fetch('https://mcp-rate-limit/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit })
    });
    const result = (await response.json()) as { allowed: boolean; retryAfterSeconds?: number };
    return result.allowed ? { allowed: true } : { allowed: false, id: probe.id, retryAfterSeconds: result.retryAfterSeconds ?? 60 };
  }

  const localResult = checkLocalRateLimit(clientKey, limit);
  return localResult.allowed ? { allowed: true } : { allowed: false, id: probe.id, retryAfterSeconds: localResult.retryAfterSeconds };
}

async function probeJsonRpc(request: Request): Promise<JsonRpcProbe | null> {
  const body = await request.json().catch(() => null);
  if (!isRecord(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') return null;
  return { id: isJsonRpcId(body.id) ? body.id : null, method: body.method };
}

function checkLocalRateLimit(clientKey: string, limit: number): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  const now = Date.now();
  const bucket = localRateLimitBuckets.get(clientKey);
  if (!bucket || bucket.resetAt <= now) {
    localRateLimitBuckets.set(clientKey, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true };
  }
  if (bucket.count >= limit) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  bucket.count += 1;
  return { allowed: true };
}

function getClientKey(context: AppContext): string {
  return context.req.header('CF-Connecting-IP') ?? context.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ?? 'unknown-client';
}

function summarizeStations(query: string, stations: StationResult[]): string {
  if (stations.length === 0) return `Geen stations gevonden voor "${query}".`;
  const first = stations[0];
  return `${stations.length} stations gevonden voor "${query}". Beste match: ${first.name} (${first.code}).`;
}

function summarizeStationInfo(stationCode: string, station: StationInfoResult | null): string {
  return station ? `Stationsdetails gevonden voor ${station.name} (${station.code}).` : `Geen stationsdetails gevonden voor ${stationCode}.`;
}

function summarizeResolvedStation(input: string, station: StationResult | null): string {
  return station ? `Beste stationmatch voor ${input}: ${station.name} (${station.code}), matchType ${station.matchType}.` : `Geen station gevonden voor ${input}.`;
}

function summarizeNearestStations(stations: StationResult[]): string {
  if (stations.length === 0) return 'Geen stations gevonden bij deze coordinaten.';
  const first = stations[0];
  return `${stations.length} dichtstbijzijnde station(s) gevonden. Dichtstbij: ${first.name} (${first.code}).`;
}

function summarizeResolvedJourney(fromStation: StationResult | null, toStation: StationResult | null, journeys: JourneyOption[]): string {
  if (!fromStation || !toStation) return 'Vertrek- of aankomststation kon niet worden gevonden.';
  if (journeys.length === 0) return `Geen reisadviezen gevonden van ${fromStation.name} naar ${toStation.name}.`;
  const first = journeys[0];
  return `${journeys.length} reisadvies(s) gevonden van ${fromStation.name} naar ${toStation.name}. Eerste vertrek: ${first.summary.departure ?? 'onbekend'}, aankomst: ${first.summary.arrival ?? 'onbekend'}.`;
}

function formatJourneyResponse(fromStation: StationResult | null, toStation: StationResult | null, journeys: JourneyOption[]): string {
  if (!fromStation || !toStation) return 'Vertrek- of aankomststation kon niet worden gevonden.';
  if (journeys.length === 0) return `Geen treinreis gevonden van ${fromStation.name} naar ${toStation.name}.`;

  const journey = journeys[0];
  return [
    'TREINREIS',
    `${journey.summary.departure ?? 'onbekend'} ${fromStation.name} -> ${journey.summary.arrival ?? 'onbekend'} ${toStation.name}`,
    `Duur: ${formatDuration(journey.summary.durationMinutes)} | Overstappen: ${journey.summary.transfers}`,
    '',
    ...formatJourneyLegs(journey)
  ].join('\n');
}

function formatJourneyDetailsResponse(result: { fromStation: { station: StationResult | null }; toStation: { station: StationResult | null }; journeys: JourneyOption[]; journeyDetails: Array<{ journeyDetailRef: string; journeyDetails: JourneyDetailsResult }> }): string {
  const journey = result.journeys[0];
  const fromStation = result.fromStation.station;
  const toStation = result.toStation.station;
  if (!journey || !fromStation || !toStation) return 'Geen treinreis gevonden voor deze aanvraag.';

  const detailStops = new Map(result.journeyDetails.map((item) => [item.journeyDetailRef, item.journeyDetails.stops.length]));
  return [
    'TREINREIS',
    `${journey.summary.departure ?? 'onbekend'} ${fromStation.name} -> ${journey.summary.arrival ?? 'onbekend'} ${toStation.name}`,
    `Duur: ${formatDuration(journey.summary.durationMinutes)} | Overstappen: ${journey.summary.transfers}`,
    '',
    ...formatJourneyLegs(journey, detailStops)
  ].join('\n');
}

function formatJourneyLegs(journey: JourneyOption, detailStops: Map<string, number> = new Map()): string[] {
  return journey.legs
    .filter((leg) => !/bus/i.test(leg.transportType))
    .flatMap((leg, index) => [
      `${index + 1}. ${leg.plannedDeparture ?? 'onbekend'} ${leg.origin} -> ${leg.plannedArrival ?? 'onbekend'} ${leg.destination}`,
      `   ${leg.transportType}${leg.lineName ? ` ${leg.lineName}` : ''}${leg.direction ? ` richting ${leg.direction}` : ''}`,
      `   Spoor: ${leg.actualPlatform ?? leg.plannedPlatform ?? 'onbekend'} | Tussenstops: ${leg.journeyDetailRef ? detailStops.get(leg.journeyDetailRef) ?? 'onbekend' : 'onbekend'}`,
      ...(leg.cancelled ? ['   Status: geannuleerd'] : [])
    ]);
}

function formatDuration(durationMinutes: number | null): string {
  if (durationMinutes === null) return 'onbekend';
  const hours = Math.floor(durationMinutes / 60);
  const minutes = durationMinutes % 60;
  return hours > 0 ? `${hours} uur ${minutes} min` : `${minutes} min`;
}

function summarizeDepartures(station: string, departures: StationDepartureResult[]): string {
  if (departures.length === 0) return `Geen actuele vertrekken gevonden voor ${station}.`;
  const first = departures[0];
  return `${departures.length} vertrek(ken) gevonden voor ${station}. Eerste vertrek: ${first.plannedDateTime ?? 'onbekend'} richting ${first.direction || 'onbekend'}.`;
}

function summarizeArrivals(station: string, arrivals: StationArrivalResult[]): string {
  if (arrivals.length === 0) return `Geen actuele aankomsten gevonden voor ${station}.`;
  const first = arrivals[0];
  return `${arrivals.length} aankomst(en) gevonden voor ${station}. Eerste aankomst: ${first.plannedDateTime ?? 'onbekend'} vanaf ${first.origin || 'onbekend'}.`;
}

function summarizeJourneys(from: string, to: string, journeys: JourneyOption[], responseMode: string): string {
  if (journeys.length === 0) return `Geen reisadviezen gevonden van ${from} naar ${to}. Controleer je reis in de NS-app of op ns.nl.`;
  const first = journeys[0];
  return `${journeys.length} reisadvies(s) gevonden van ${from} naar ${to}. Eerste vertrek: ${first.summary.departure ?? 'onbekend'}, aankomst: ${first.summary.arrival ?? 'onbekend'}. Response mode: ${responseMode}.`;
}

function summarizeSingleTrip(ctxRecon: string, journeys: JourneyOption[]): string {
  if (journeys.length === 0) return `Geen trip gevonden voor ctxRecon ${ctxRecon}.`;
  const first = journeys[0];
  return `Trip gereconstrueerd. Vertrek: ${first.summary.departure ?? 'onbekend'}, aankomst: ${first.summary.arrival ?? 'onbekend'}.`;
}

function summarizeJourneyDetails(details: JourneyDetailsResult): string {
  if (details.stops.length === 0) return 'Geen ritdetails gevonden.';
  return `Ritdetails gevonden met ${details.stops.length} stop(s).`;
}

function summarizePlannedJourneyDetails(journeys: JourneyOption[], details: Array<{ journeyDetailRef: string; journeyDetails: JourneyDetailsResult }>): string {
  if (journeys.length === 0) return 'Geen reis gevonden om details voor op te halen.';
  const stops = details.reduce((sum, item) => sum + item.journeyDetails.stops.length, 0);
  return `Reisdetails opgehaald voor de beste reisoptie: ${journeys[0].legs.length} leg(s), ${stops} stop(s).`;
}

function summarizeRouteDisruptions(disruptions: DisruptionResult[], warnings: Array<{ source: string; message: string }>): string {
  if (disruptions.length === 0 && warnings.length === 0) return 'Geen verstoringen of waarschuwingen gevonden voor deze aanvraag.';
  return `${disruptions.length} verstoring(en) en ${warnings.length} waarschuwing(en) gevonden.`;
}

function summarizeJourneyStatus(journeys: JourneyOption[], warnings: Array<{ source: string; message: string }>): string {
  if (journeys.length === 0) return 'Geen reis gevonden om de status voor te controleren.';
  if (warnings.length === 0) return `Reisstatus: ${journeys[0].summary.status}. Geen extra waarschuwingen in de response.`;
  return `Reisstatus: ${journeys[0].summary.status}. ${warnings.length} waarschuwing(en) gevonden.`;
}

function summarizeDeparturePlatform(departures: StationDepartureResult[]): string {
  if (departures.length === 0) return 'Geen passend vertrek gevonden.';
  const first = departures[0];
  return `Eerste passende vertrek: ${first.name} richting ${first.direction}, spoor ${first.actualPlatform ?? first.plannedPlatform ?? 'onbekend'}.`;
}

function summarizePrice(fromStation: string, toStation: string, price: DomesticPriceResult | null): string {
  return price ? `Prijs gevonden voor ${fromStation} naar ${toStation}: ${price.totalPrice}.` : `Geen prijs gevonden voor ${fromStation} naar ${toStation}.`;
}

function summarizeDisruptions(disruptions: DisruptionResult[]): string {
  if (disruptions.length === 0) return 'Geen actuele verstoringen gevonden voor deze aanvraag.';
  return `${disruptions.length} verstoring(en) gevonden. Eerste melding: ${disruptions[0].title}.`;
}

function summarizeSingleDisruption(disruption: DisruptionResult | null): string {
  return disruption ? `Verstoring gevonden: ${disruption.title}.` : 'Geen verstoring gevonden voor deze type/id combinatie.';
}

function roundCoordinate(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function nsClient(env: Env): NsClient {
  return new NsClient({ apiKey: env.NS_API_KEY, baseUrl: getNsApiBaseUrl(env) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === 'string' || typeof value === 'number';
}