import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/server';
import type { Env } from '../src/types';

const env: Env = {
  NS_API_KEY: 'ns-test-key',
  NS_API_BASE_URL: 'https://ns.example.test/api',
  RESPONSE_MODE: 'strict',
  LOG_LEVEL: 'error'
};

describe('Nederlandse Treinreisplanner MCP Worker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a public MCP health response', async () => {
    const response = await createApp().request('/health', {}, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'ok', service: 'nederlandse-treinreisplanner-mcp' });
  });

  it('does not expose legacy REST endpoints', async () => {
    const response = await createApp().request('/stations/search?query=Amsterdam', {}, env);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: 'not_found' });
  });

  it('lists only the public workflow toolset', async () => {
    const response = await createApp().request('/mcp', mcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), env);

    expect(response.status).toBe(200);
    const result = await readMcpResponse(response);
    expect(result.result.tools.map((tool: any) => tool.name)).toEqual([
      'plan_resolved_journey',
      'get_resolved_station_departures',
      'get_resolved_station_arrivals',
      'get_resolved_station_disruptions',
      'price_resolved_journey',
      'get_planned_journey_details',
      'check_route_disruptions',
      'check_journey_status',
      'find_departure_platform',
      'check_planned_journey_warnings',
      'resolve_station',
      'find_nearest_station',
      'get_train_stops'
    ]);
    expect(result.result.tools[0]).toMatchObject({
      title: 'Plan resolved journey',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      outputSchema: { properties: { fromStation: { type: 'object' }, toStation: { type: 'object' }, journeys: { type: 'array' } } }
    });
  });

  it('searches stations with enriched station fields', async () => {
    mockNsResponse({
      payload: [
        {
          code: 'ASD',
          UICCode: '8400058',
          namen: { lang: 'Amsterdam Centraal' },
          land: 'NL',
          stationType: 'knooppuntIntercitystation',
          lat: 52.378887,
          lng: 4.900277
        }
      ]
    });

    const response = await callMcpTool('search_stations', { query: 'Amsterdam', limit: 5, countryCodes: ['NL'] }, 'stations-1');

    expect(response.status).toBe(200);
    expect(await readMcpResponse(response)).toMatchObject({
      id: 'stations-1',
      result: {
        structuredContent: {
          stations: [{ code: 'ASD', name: 'Amsterdam Centraal', uicCode: '8400058', latitude: 52.378887, longitude: 4.900277 }]
        }
      }
    });
    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/api/v2/stations' }), expect.any(Object));
  });

  it('uses fuzzy matching against the full station list when NS exact search returns no station', async () => {
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          return Response.json({ payload: [] });
        }

        return Response.json({
          payload: [
            {
              code: 'RAI',
              UICCode: '8400561',
              namen: { kort: 'Rai', middel: 'Amsterdam RAI', lang: 'Amsterdam RAI' },
              land: 'NL',
              stationType: 'stoptreinstation'
            },
            {
              code: 'ASD',
              UICCode: '8400058',
              namen: { kort: 'Asd', middel: 'Amsterdam C.', lang: 'Amsterdam Centraal' },
              land: 'NL',
              stationType: 'knooppuntIntercitystation',
              synoniemen: ['Amsterdam CS']
            },
            {
              code: 'RTD',
              UICCode: '8400530',
              namen: { lang: 'Rotterdam Centraal' },
              land: 'NL',
              stationType: 'knooppuntIntercitystation'
            }
          ]
        });
      })
    );

    const response = await callMcpTool('search_stations', { query: 'Amsterdm', limit: 3 }, 'fuzzy-stations-1');

    expect(response.status).toBe(200);
    const mcpResponse = await readMcpResponse(response);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(mcpResponse.result.structuredContent.stations[0]).toMatchObject({ code: 'ASD', name: 'Amsterdam Centraal', matchType: 'fuzzy' });
  });

  it('returns enriched station info', async () => {
    mockNsResponse({
      payload: [
        {
          code: 'ASD',
          UICCode: '8400058',
          EVACode: '8400058',
          namen: { kort: 'Asd', middel: 'Amsterdam C.', lang: 'Amsterdam Centraal' },
          land: 'NL',
          stationType: 'knooppuntIntercitystation',
          lat: 52.378887,
          lng: 4.900277,
          heeftFaciliteiten: true,
          heeftReisassistentie: true,
          heeftVertrektijden: true,
          sporen: [{ spoorNummer: '5' }],
          synoniemen: ['Amsterdam CS']
        }
      ]
    });

    const response = await callMcpTool('get_station_info', { stationCode: 'ASD' }, 'station-info-1');

    expect(response.status).toBe(200);
    expect(await readMcpResponse(response)).toMatchObject({
      result: {
        structuredContent: {
          station: {
            code: 'ASD',
            evaCode: '8400058',
            tracks: ['5'],
            synonyms: ['Amsterdam CS'],
            hasFacilities: true,
            hasTravelAssistance: true,
            hasDepartures: true
          }
        }
      }
    });
  });

  it('finds nearest stations from explicit coordinates', async () => {
    mockNsResponse({ payload: [{ code: 'UT', UICCode: '8400621', namen: { lang: 'Utrecht Centraal' }, land: 'NL', stationType: 'knooppuntIntercitystation', distance: 850 }] });

    const response = await callMcpTool('get_nearest_stations', { latitude: 52.0907, longitude: 5.1214, limit: 3 }, 'nearest-1');

    expect(response.status).toBe(200);
    expect(await readMcpResponse(response)).toMatchObject({
      result: { structuredContent: { stations: [{ code: 'UT', name: 'Utrecht Centraal', distanceMeters: 850 }] } }
    });
  });

  it('returns enriched station departures', async () => {
    mockNsResponse({
      payload: {
        departures: [
          {
            name: 'Intercity',
            direction: 'Utrecht Centraal',
            plannedDateTime: '2026-09-11T08:24:00+02:00',
            actualDateTime: '2026-09-11T08:26:00+02:00',
            plannedTrack: '5',
            actualTrack: '5',
            product: { categoryName: 'Intercity', number: '3024', operatorName: 'NS', lineNumber: '3000', productType: 'TRAIN' },
            departureStatus: 'INCOMING',
            journeyDetailRef: 'journey-ref-1',
            messages: [{ text: 'Let op gewijzigde vertrektijd.' }],
            routeStations: [{ mediumName: 'Utrecht C.', uicCode: '8400621' }]
          }
        ]
      }
    });

    const response = await callMcpTool('get_station_departures', { stationCode: 'ASD', maxResults: 5 }, 'departures-1');

    expect(response.status).toBe(200);
    expect(await readMcpResponse(response)).toMatchObject({
      result: {
        structuredContent: {
          departures: [
            {
              journeyDetailRef: 'journey-ref-1',
              messages: ['Let op gewijzigde vertrektijd.'],
              routeStations: [{ name: 'Utrecht C.', uicCode: '8400621' }],
              operatorName: 'NS',
              lineNumber: '3000',
              productType: 'TRAIN'
            }
          ]
        }
      }
    });
  });

  it('returns enriched station arrivals', async () => {
    mockNsResponse({
      payload: {
        arrivals: [
          {
            name: 'Sprinter',
            origin: 'Rotterdam Centraal',
            plannedDateTime: '2026-09-11T09:10:00+02:00',
            actualDateTime: '2026-09-11T09:12:00+02:00',
            plannedTrack: '7',
            actualTrack: '8',
            product: { categoryName: 'Sprinter', number: '5024', operatorName: 'NS', lineNumber: '5000', productType: 'TRAIN' },
            arrivalStatus: 'ARRIVING',
            journeyDetailRef: 'arrival-ref-1',
            messages: [{ text: 'Komt binnen op spoor 8.' }]
          }
        ]
      }
    });

    const response = await callMcpTool('get_station_arrivals', { uicCode: '8400621', maxResults: 5 }, 'arrivals-1');

    expect(response.status).toBe(200);
    expect(await readMcpResponse(response)).toMatchObject({
      result: { structuredContent: { arrivals: [{ journeyDetailRef: 'arrival-ref-1', messages: ['Komt binnen op spoor 8.'], operatorName: 'NS' }] } }
    });
  });

  it('plans journeys with route and detail references', async () => {
    mockNsResponse({
      trips: [
        {
          uid: 'trip-1',
          ctxRecon: 'ctx-recon-plan-1',
          routeId: 'route-1',
          plannedDurationInMinutes: 27,
          transfers: 0,
          status: 'NORMAL',
          legs: [
            {
              name: 'Intercity',
              direction: 'Utrecht Centraal',
              journeyDetailRef: 'journey-ref-1',
              origin: { name: 'Amsterdam Centraal', plannedDateTime: '2026-09-11T08:24:00+02:00', actualTrack: '5' },
              destination: { name: 'Utrecht Centraal', plannedDateTime: '2026-09-11T08:51:00+02:00' },
              product: { categoryName: 'Intercity' }
            }
          ]
        }
      ]
    });

    const response = await callMcpTool('plan_journey', { from: 'ASD', to: 'UT', dateTime: '2026-09-11T08:30:00+02:00', localTrainsOnly: false }, 'journey-1');

    expect(response.status).toBe(200);
    expect(await readMcpResponse(response)).toMatchObject({
      result: {
        structuredContent: {
          journeys: [{ id: 'ctx-recon-plan-1', ctxRecon: 'ctx-recon-plan-1', routeId: 'route-1', legs: [{ journeyDetailRef: 'journey-ref-1' }] }]
        }
      }
    });
  });

  it('reconstructs a single trip from ctxRecon', async () => {
    mockNsResponse({ ctxRecon: 'ctx-single-1', routeId: 'route-1', plannedDurationInMinutes: 27, transfers: 0, status: 'NORMAL', legs: [] });

    const response = await callMcpTool('get_single_trip', { ctxRecon: 'ctx-single-1' }, 'single-trip-1');

    expect(response.status).toBe(200);
    expect(await readMcpResponse(response)).toMatchObject({
      result: { structuredContent: { journeys: [{ id: 'ctx-single-1', ctxRecon: 'ctx-single-1', routeId: 'route-1' }] } }
    });
  });

  it('gets train journey details from journeyDetailRef', async () => {
    mockNsResponse({
      payload: {
        source: 'HARP',
        productNumbers: ['3024'],
        allowCrowdReporting: true,
        notes: [{ value: 'Rijdt volgens planning.' }],
        stops: [
          {
            id: 'stop-1',
            kind: 'DEPARTURE',
            stop: { namen: { lang: 'Amsterdam Centraal' } },
            departures: [{ plannedTime: '2026-09-11T08:24:00+02:00', actualTime: '2026-09-11T08:26:00+02:00', plannedTrack: '5', actualTrack: '5', cancelled: false }],
            arrivals: []
          }
        ]
      }
    });

    const response = await callMcpTool('get_journey_details', { journeyDetailRef: 'journey-ref-1' }, 'journey-details-1');

    expect(response.status).toBe(200);
    expect(await readMcpResponse(response)).toMatchObject({
      result: { structuredContent: { journeyDetails: { source: 'HARP', productNumbers: ['3024'], stops: [{ name: 'Amsterdam Centraal', actualDeparture: '2026-09-11T08:26:00+02:00' }] } } }
    });
  });

  it('gets domestic price information', async () => {
    mockNsResponse({ payload: { totalPriceInCents: 1234, travelClass: 'SECOND_CLASS', travelDiscount: 'NO_DISCOUNT', travelProducts: ['OVCHIPKAART_ENKELE_REIS'], operatorName: 'NS' } });

    const response = await callMcpTool('get_domestic_price', { fromStation: 'ASD', toStation: 'UT' }, 'price-1');

    expect(response.status).toBe(200);
    expect(await readMcpResponse(response)).toMatchObject({
      result: { content: [{ text: expect.stringContaining('EUR 12.34') }], structuredContent: { price: { totalPriceInCents: 1234, totalPrice: 'EUR 12.34' } } }
    });
  });

  it('gets general disruptions with filters', async () => {
    mockNsResponse([{ id: 'd1', title: 'Minder treinen', type: 'CALAMITY', topic: 'landelijk', isActive: true }]);

    const response = await callMcpTool('get_disruptions', { types: ['CALAMITY'], isActive: true }, 'disruptions-1');

    expect(response.status).toBe(200);
    expect(await readMcpResponse(response)).toMatchObject({
      result: { structuredContent: { disruptions: [{ id: 'd1', title: 'Minder treinen', type: 'CALAMITY', topic: 'landelijk', isActive: true }] } }
    });
  });

  it('gets station disruptions', async () => {
    mockNsResponse([{ id: 's1', title: 'Werkzaamheden rond Amsterdam', type: 'MAINTENANCE', topic: 'station', isActive: true }]);

    const response = await callMcpTool('get_station_disruptions', { stationCode: 'ASD' }, 'station-disruptions-1');

    expect(response.status).toBe(200);
    expect(await readMcpResponse(response)).toMatchObject({
      result: { structuredContent: { disruptions: [{ id: 's1', title: 'Werkzaamheden rond Amsterdam' }] } }
    });
  });

  it('gets a single disruption', async () => {
    mockNsResponse({ id: 'd1', title: 'Minder treinen', type: 'CALAMITY', topic: 'landelijk', isActive: true });

    const response = await callMcpTool('get_single_disruption', { type: 'CALAMITY', id: 'd1' }, 'single-disruption-1');

    expect(response.status).toBe(200);
    expect(await readMcpResponse(response)).toMatchObject({
      result: { structuredContent: { disruption: { id: 'd1', title: 'Minder treinen', isActive: true } } }
    });
  });

  it('plans a resolved journey with station names in one tool call', async () => {
    mockNsSequence([
      { payload: [{ code: 'ASD', namen: { lang: 'Amsterdam Centraal' }, land: 'NL', stationType: 'knooppuntIntercitystation' }] },
      { payload: [{ code: 'UT', namen: { lang: 'Utrecht Centraal' }, land: 'NL', stationType: 'knooppuntIntercitystation' }] },
      { trips: [mockTrip()] }
    ]);

    const response = await callMcpTool('plan_resolved_journey', { from: 'Amsterdm', to: 'Utrect' }, 'resolved-journey-1');

    expect(response.status).toBe(200);
    const result = await readMcpResponse(response);
    expect(result).toMatchObject({
      result: {
        structuredContent: {
          fromStation: { station: { code: 'ASD' } },
          toStation: { station: { code: 'UT' } },
          journeys: [{ ctxRecon: 'ctx-recon-plan-1' }]
        }
      }
    });
    expect(result.result.content[0].text).toContain('TREINREIS');
    expect(result.result.content[0].text).toContain('Amsterdam Centraal ->');
  });

  it('gets resolved departures with a station name in one tool call', async () => {
    mockNsSequence([
      { payload: [{ code: 'ASD', namen: { lang: 'Amsterdam Centraal' }, land: 'NL', stationType: 'knooppuntIntercitystation' }] },
      { payload: { departures: [{ name: 'Intercity', direction: 'Utrecht Centraal', plannedTrack: '5', product: { categoryName: 'Intercity' }, departureStatus: 'ON_STATION' }] } }
    ]);

    const response = await callMcpTool('get_resolved_station_departures', { station: 'Amsterdam', maxResults: 3 }, 'resolved-departures-1');

    expect(response.status).toBe(200);
    expect(await readMcpResponse(response)).toMatchObject({
      result: { structuredContent: { station: { station: { code: 'ASD' } }, departures: [{ direction: 'Utrecht Centraal', plannedPlatform: '5' }] } }
    });
  });

  it('prices a resolved journey in one tool call', async () => {
    mockNsSequence([
      { payload: [{ code: 'ASD', namen: { lang: 'Amsterdam Centraal' }, land: 'NL', stationType: 'knooppuntIntercitystation' }] },
      { payload: [{ code: 'UT', namen: { lang: 'Utrecht Centraal' }, land: 'NL', stationType: 'knooppuntIntercitystation' }] },
      { trips: [mockTrip()] },
      { payload: { totalPriceInCents: 1000, travelClass: 'SECOND_CLASS', travelDiscount: 'NO_DISCOUNT', travelProducts: ['OVCHIPKAART_ENKELE_REIS'], operatorName: 'NS' } }
    ]);

    const response = await callMcpTool('price_resolved_journey', { from: 'Amsterdam', to: 'Utrecht' }, 'resolved-price-1');

    expect(response.status).toBe(200);
    expect(await readMcpResponse(response)).toMatchObject({
      result: { structuredContent: { price: { totalPrice: 'EUR 10.00' }, journeys: [{ routeId: 'route-1' }] } }
    });
  });

  it('finds a departure platform with station names in one tool call', async () => {
    mockNsSequence([
      { payload: [{ code: 'ALM', namen: { lang: 'Almere Centrum' }, land: 'NL', stationType: 'intercitystation' }] },
      { payload: [{ code: 'LLS', UICCode: '8400390', namen: { lang: 'Lelystad Centrum' }, land: 'NL', stationType: 'intercitystation' }] },
      { payload: { departures: [{ name: 'Intercity', direction: 'Lelystad Centrum', plannedTrack: '5', actualTrack: '6', product: { categoryName: 'Intercity' }, routeStations: [{ mediumName: 'Lelystad C.', uicCode: '8400390' }] }] } }
    ]);

    const response = await callMcpTool('find_departure_platform', { station: 'Almere', destination: 'Lelystad' }, 'platform-1');

    expect(response.status).toBe(200);
    expect(await readMcpResponse(response)).toMatchObject({
      result: { structuredContent: { station: { station: { code: 'ALM' } }, destinationStation: { station: { code: 'LLS' } }, departures: [{ actualPlatform: '6' }] } }
    });
  });

  it('resolves a station as a standalone workflow tool', async () => {
    mockNsResponse({ payload: [{ code: 'ASD', UICCode: '8400058', namen: { lang: 'Amsterdam Centraal' }, land: 'NL', stationType: 'knooppuntIntercitystation' }] });

    const response = await callMcpTool('resolve_station', { station: 'Amsterdm' }, 'resolve-station-1');

    expect(response.status).toBe(200);
    expect(await readMcpResponse(response)).toMatchObject({
      result: { structuredContent: { station: { input: 'Amsterdm', station: { code: 'ASD', name: 'Amsterdam Centraal' } } } }
    });
  });

  it('finds the nearest station as a standalone workflow tool', async () => {
    mockNsResponse({ payload: [{ code: 'UT', UICCode: '8400621', namen: { lang: 'Utrecht Centraal' }, land: 'NL', stationType: 'knooppuntIntercitystation', distance: 850 }] });

    const response = await callMcpTool('find_nearest_station', { latitude: 52.0907, longitude: 5.1214, limit: 3 }, 'nearest-station-workflow-1');

    expect(response.status).toBe(200);
    expect(await readMcpResponse(response)).toMatchObject({
      result: { structuredContent: { station: { code: 'UT', name: 'Utrecht Centraal' }, stations: [{ code: 'UT', distanceMeters: 850 }] } }
    });
  });

  it('gets train stops from a journey detail reference as a workflow tool', async () => {
    mockNsResponse(mockJourneyDetailsPayload());

    const response = await callMcpTool('get_train_stops', { journeyDetailRef: 'journey-ref-1' }, 'train-stops-1');

    expect(response.status).toBe(200);
    expect(await readMcpResponse(response)).toMatchObject({
      result: { structuredContent: { journeyDetails: { stops: [{ name: 'Amsterdam Centraal', actualDeparture: '2026-09-11T08:26:00+02:00' }] } } }
    });
  });

  it('caches MCP station searches to reduce upstream NS API calls', async () => {
    mockNsResponse({ payload: [{ code: 'GN', namen: { lang: 'Groningen' }, land: 'NL' }] });

    const firstResponse = await callMcpTool('search_stations', { query: 'Groningen' }, 'cached-stations-1');
    const secondResponse = await callMcpTool('search_stations', { query: 'Groningen' }, 'cached-stations-2');

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns MCP validation errors as tool errors', async () => {
    const response = await callMcpTool('get_journey_details', {}, 2);

    expect(response.status).toBe(200);
    expect(await readMcpResponse(response)).toMatchObject({ jsonrpc: '2.0', id: 2, result: { isError: true, content: [{ type: 'text' }] } });
  });

  it('rate limits public MCP tool calls per client', async () => {
    mockNsResponse({ payload: [{ code: 'RTD', namen: { lang: 'Rotterdam Centraal' }, land: 'NL' }] });

    const limitedEnv = { ...env, MCP_RATE_LIMIT_PER_MINUTE: '1' };
    const request = buildMcpToolRequest('search_stations', { query: 'Rotterdam' }, 'limited-stations', { 'CF-Connecting-IP': '203.0.113.42' });

    const firstResponse = await createApp({ exposeApiNearTools: true }).request('/mcp', request, limitedEnv);
    const secondResponse = await createApp({ exposeApiNearTools: true }).request('/mcp', request, limitedEnv);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(429);
    expect(secondResponse.headers.get('Retry-After')).toBeTruthy();
    await expect(secondResponse.json()).resolves.toMatchObject({ jsonrpc: '2.0', id: 'limited-stations', error: { code: -32029 } });
  });
});

function callMcpTool(name: string, argumentsInput: Record<string, unknown>, id: string | number): Promise<Response> {
  return createApp({ exposeApiNearTools: true }).request('/mcp', buildMcpToolRequest(name, argumentsInput, id), env) as Promise<Response>;
}

function buildMcpToolRequest(name: string, argumentsInput: Record<string, unknown>, id: string | number, extraHeaders?: Record<string, string>) {
  return mcpRequest({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: argumentsInput } }, extraHeaders);
}

function mcpRequest(body: unknown, extraHeaders?: Record<string, string>) {
  return { method: 'POST', headers: { ...mcpHeaders(), ...extraHeaders }, body: JSON.stringify(body) };
}

function mcpHeaders() {
  return { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
}

async function readMcpResponse(response: Response): Promise<any> {
  const contentType = response.headers.get('Content-Type') ?? '';
  if (!contentType.includes('text/event-stream')) return response.json();

  const text = await response.text();
  const dataLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('data:'));

  if (!dataLine) throw new Error(`MCP SSE response did not contain a data line: ${text}`);
  return JSON.parse(dataLine.slice('data:'.length).trim());
}

function mockNsResponse(payload: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(payload)));
}

function mockNsSequence(payloads: unknown[]): void {
  let index = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(payloads[Math.min(index++, payloads.length - 1)]))
  );
}

function mockTrip() {
  return {
    uid: 'trip-1',
    ctxRecon: 'ctx-recon-plan-1',
    routeId: 'route-1',
    plannedDurationInMinutes: 27,
    transfers: 0,
    status: 'NORMAL',
    legs: [
      {
        name: 'Intercity',
        direction: 'Utrecht Centraal',
        journeyDetailRef: 'journey-ref-1',
        origin: { name: 'Amsterdam Centraal', plannedDateTime: '2026-09-11T08:24:00+02:00', actualTrack: '5' },
        destination: { name: 'Utrecht Centraal', plannedDateTime: '2026-09-11T08:51:00+02:00' },
        product: { categoryName: 'Intercity' }
      }
    ]
  };
}

function mockJourneyDetailsPayload() {
  return {
    payload: {
      source: 'HARP',
      productNumbers: ['3024'],
      allowCrowdReporting: true,
      stops: [
        {
          id: 'stop-1',
          kind: 'DEPARTURE',
          stop: { namen: { lang: 'Amsterdam Centraal' } },
          departures: [{ plannedTime: '2026-09-11T08:24:00+02:00', actualTime: '2026-09-11T08:26:00+02:00', plannedTrack: '5', actualTrack: '5', cancelled: false }],
          arrivals: []
        }
      ]
    }
  };
}