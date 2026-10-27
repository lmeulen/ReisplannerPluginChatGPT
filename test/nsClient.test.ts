import { describe, expect, it } from 'vitest';
import { NsApiError, NsClient } from '../src/nsClient';

const baseUrl = 'https://ns.test/reisinformatie-api/api';

function clientFor(payload: unknown, requests: Array<{ url: URL; init: RequestInit }> = []): NsClient {
  return new NsClient({
    apiKey: 'test-secret',
    baseUrl,
    fetcher: async (request, init) => {
      requests.push({ url: new URL(String(request)), init: init ?? {} });
      return Response.json(payload);
    }
  });
}

describe('NsClient provider boundary', () => {
  it('loads the full station list and preserves short names, synonyms, and codes as aliases', async () => {
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    const client = clientFor({
      payload: [{
        code: 'ASD', UICCode: '8400058', EVACode: '8400058',
        namen: { lang: 'Amsterdam Centraal', middel: 'Amsterdam C.', kort: 'Amsterdam CS' },
        synoniemen: ['Amsterdam CS', 'Adam CS']
      }]
    }, requests);

    await expect(client.getStations()).resolves.toEqual([{
      code: 'ASD', name: 'Amsterdam Centraal',
      aliases: ['Amsterdam Centraal', 'Amsterdam C.', 'Amsterdam CS', 'Adam CS', 'ASD', '8400058']
    }]);
    expect(requests[0].url.pathname).toBe('/reisinformatie-api/api/v2/stations');
    expect(requests[0].url.search).toBe('');
  });

  it('maps a trip without dropping transport modes, times, platforms, warnings, or unknown flags', async () => {
    const leg = (mode: string, product: string, origin: string, destination: string) => ({
      type: mode,
      product: { type: mode.toUpperCase(), categoryName: product },
      origin: {
        name: origin, plannedDateTime: '2026-10-26T09:00:00+01:00',
        actualDateTime: '2026-10-26T09:02:00+01:00', plannedTrack: '5', actualTrack: '6'
      },
      destination: {
        name: destination, plannedDateTime: '2026-10-26T09:20:00+01:00',
        actualDateTime: '2026-10-26T09:22:00+01:00', plannedTrack: '2', actualTrack: '3'
      }
    });
    const trip = {
      ctxRecon: 'provider-ref', plannedDurationInMinutes: 95, transfers: 2, status: 'PLANNED',
      messages: [{ text: 'Check the departure platform.' }],
      legs: [
        leg('TRAIN', 'Intercity', 'Amsterdam Centraal', 'Utrecht Centraal'),
        leg('BUS', 'Replacement bus', 'Utrecht Centraal', 'Utrecht Science Park'),
        leg('TRAM', 'Tram 22', 'Utrecht Science Park', 'Centrum'),
        leg('METRO', 'Metro', 'Centrum', 'Zuid'),
        leg('WALK', 'Walk', 'Zuid', 'Destination')
      ]
    };
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    const client = clientFor({
      trips: [trip, { ...trip, transfers: undefined, status: undefined, cancelled: undefined }, trip, trip]
    }, requests);

    const journeys = await client.planJourney({
      from: 'ASD', to: 'UT', dateTime: '2026-10-26T09:00:00+01:00',
      searchForArrival: true, accessible: true, language: 'en'
    });

    // The workflow must see later trips before applying its departure filter and public cap.
    expect(journeys).toHaveLength(4);
    expect(journeys[0]).toMatchObject({
      id: 'provider-ref', durationMinutes: 95, transfers: 2, status: 'PLANNED', cancelled: null,
      warnings: ['Check the departure platform.'],
      legs: [
        {
          origin: 'Amsterdam Centraal', destination: 'Utrecht Centraal', mode: 'TRAIN', product: 'Intercity',
          plannedDeparture: '2026-10-26T09:00:00+01:00', actualDeparture: '2026-10-26T09:02:00+01:00',
          plannedArrival: '2026-10-26T09:20:00+01:00', actualArrival: '2026-10-26T09:22:00+01:00',
          plannedDeparturePlatform: '5', actualDeparturePlatform: '6',
          plannedArrivalPlatform: '2', actualArrivalPlatform: '3', cancelled: null
        },
        { mode: 'BUS' }, { mode: 'TRAM' }, { mode: 'METRO' }, { mode: 'WALK' }
      ]
    });
    expect(journeys[1]).toMatchObject({ transfers: null, status: null, cancelled: null });
    expect(requests[0].url.pathname).toBe('/reisinformatie-api/api/v3/trips');
    expect(requests[0].url.searchParams.get('fromStation')).toBe('ASD');
    expect(requests[0].url.searchParams.get('toStation')).toBe('UT');
    expect(requests[0].url.searchParams.get('lang')).toBe('en');
    expect(requests[0].url.searchParams.get('dateTime')).toBe('2026-10-26T09:00:00+01:00');
    expect(requests[0].url.searchParams.get('searchForArrival')).toBe('true');
    expect(requests[0].url.searchParams.get('travelAssistance')).toBe('true');
    expect(requests[0].url.searchParams.get('searchForAccessibleTrip')).toBe('true');
    expect(requests[0].init.redirect).toBe('manual');
  });

  it('sends departure limits and retains actual values, platform changes, and nullable cancellation', async () => {
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    const client = clientFor({ payload: { departures: [
      {
        direction: 'Utrecht Centraal', product: { categoryName: 'Intercity' },
        plannedDateTime: '2026-10-26T09:00:00+01:00', actualDateTime: '2026-10-26T09:03:00+01:00',
        plannedTrack: '5', actualTrack: '6', cancelled: false, messages: [{ text: 'Platform changed.' }]
      },
      { direction: 'Rotterdam Centraal', product: { categoryName: 'Sprinter' }, plannedDateTime: '2026-10-26T09:10:00+01:00' },
      { direction: 'Ignored extra', plannedDateTime: '2026-10-26T09:20:00+01:00' }
    ] } }, requests);

    await expect(client.getDepartures({
      station: 'ASD', dateTime: '2026-10-26T09:00:00+01:00', limit: 2, language: 'en'
    })).resolves.toEqual([
      {
        destination: 'Utrecht Centraal', product: 'Intercity',
        plannedDeparture: '2026-10-26T09:00:00+01:00', actualDeparture: '2026-10-26T09:03:00+01:00',
        plannedPlatform: '5', actualPlatform: '6', cancelled: false, warnings: ['Platform changed.']
      },
      {
        destination: 'Rotterdam Centraal', product: 'Sprinter',
        plannedDeparture: '2026-10-26T09:10:00+01:00', actualDeparture: null,
        plannedPlatform: null, actualPlatform: null, cancelled: null, warnings: []
      }
    ]);
    expect(requests[0].url.pathname).toBe('/reisinformatie-api/api/v2/departures');
    expect(requests[0].url.searchParams.get('station')).toBe('ASD');
    expect(requests[0].url.searchParams.get('dateTime')).toBe('2026-10-26T09:00:00+01:00');
    expect(requests[0].url.searchParams.get('maxJourneys')).toBe('2');
    expect(requests[0].url.searchParams.get('lang')).toBe('en');
  });

  it('keeps all national and station disruptions, including planned future work', async () => {
    const nationalItems = Array.from({ length: 27 }, (_, index) => ({
      id: `work-${index}`, title: `Planned work ${index}`, type: 'MAINTENANCE', isActive: false,
      start: '2026-11-01T00:00:00+01:00', end: null,
      expectedDuration: { endTime: '2026-11-01T04:00:00+01:00' },
      description: index === 1 ? undefined : 'Track maintenance',
      advice: index === 1 ? undefined : 'Use a replacement bus.',
      publicationSections: [{ consequence: { description: 'Track work impact.' } }],
      timespans: [{ advices: ['Use the replacement bus.'] }]
    }));
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    const client = clientFor(nationalItems, requests);

    const disruptions = await client.getDisruptions({ language: 'en' });
    expect(disruptions).toHaveLength(27);
    expect(disruptions[0]).toEqual({
      id: 'work-0', title: 'Planned work 0', type: 'MAINTENANCE', isActive: false,
      start: '2026-11-01T00:00:00+01:00', end: null, expectedEnd: '2026-11-01T04:00:00+01:00',
      description: 'Track maintenance Track work impact.', advice: 'Use a replacement bus. Use the replacement bus.'
    });
    expect(disruptions[1]).toMatchObject({
      description: 'Track work impact.', advice: 'Use the replacement bus.'
    });
    expect(requests[0].url.pathname).toBe('/reisinformatie-api/api/v3/disruptions');
    expect(requests[0].init.headers).toMatchObject({ 'Accept-Language': 'en' });
    expect(requests[0].url.searchParams.has('isActive')).toBe(false);

    const stationRequests: Array<{ url: URL; init: RequestInit }> = [];
    const stationClient = clientFor([], stationRequests);
    await expect(stationClient.getDisruptions({ station: 'UT', isActive: true, language: 'nl' })).resolves.toEqual([]);
    expect(stationRequests[0].url.pathname).toBe('/reisinformatie-api/api/v3/disruptions/station/UT');
    expect(stationRequests[0].url.searchParams.get('isActive')).toBe('true');
  });

  it('retains primary journey messages and title fallbacks without duplicate warnings', async () => {
    const client = clientFor({ trips: [
      {
        primaryMessage: { title: 'Replacement transport', message: { text: 'Buses replace trains.' } },
        messages: [{ text: 'Platform changed.' }],
        legs: [{
          type: 'BUS', product: { type: 'BUS' },
          origin: { name: 'A' }, destination: { name: 'B' },
          messages: [{ text: 'Platform changed.' }]
        }]
      },
      {
        primaryMessage: { title: 'Transfer may not be possible', type: 'LEG_TRANSFER_IMPOSSIBLE' },
        legs: [{ type: 'TRAIN', product: { type: 'TRAIN' }, origin: { name: 'A' }, destination: { name: 'B' } }]
      }
    ] });
    const journeys = await client.planJourney({
      from: 'ASD', to: 'UT', searchForArrival: false, accessible: false, language: 'nl'
    });
    expect(journeys[0].warnings).toEqual(['Buses replace trains.', 'Platform changed.']);
    expect(journeys[1].warnings).toEqual(['Transfer may not be possible']);
  });

  it('combines distinct disruption description and advice text from each timespan', async () => {
    const client = clientFor([{
      id: 'timespan-details', title: 'Planned work',
      timespans: [
        {
          situation: { label: 'Between Utrecht and Houten.' },
          consequence: { description: 'Fewer trains will run.' },
          advices: ['Use a replacement bus.']
        },
        {
          situation: { label: 'Between Houten and Culemborg.' },
          consequence: { description: 'Fewer trains will run.' },
          advices: ['Travel via Arnhem.']
        }
      ]
    }]);
    const [disruption] = await client.getDisruptions({ language: 'nl' });
    expect(disruption.description).toBe('Between Utrecht and Houten. Fewer trains will run. Between Houten and Culemborg.');
    expect(disruption.advice).toBe('Use a replacement bus. Travel via Arnhem.');
  });

  it.each([
    ['stations', { payload: [{ code: 42, namen: { lang: 'Station' } }] }, (client: NsClient) => client.getStations()],
    ['journeys', { trips: [{ legs: 'not-an-array' }] }, (client: NsClient) => client.planJourney({ from: 'ASD', to: 'UT', searchForArrival: false, accessible: false, language: 'nl' })],
    ['departures', { payload: {} }, (client: NsClient) => client.getDepartures({ station: 'ASD', limit: 10, language: 'nl' })],
    ['disruptions', { disruptions: [{ id: 'd-1', title: 'Broken', isActive: 'true' }] }, (client: NsClient) => client.getDisruptions({ language: 'nl' })]
  ])('rejects malformed %s payloads instead of treating them as empty results', async (_name, payload, call) => {
    const client = clientFor(payload);
    await expect(call(client)).rejects.toMatchObject({ name: 'NsApiError', code: 'invalid_response' });
  });

  it('reports safe stable errors for upstream HTTP failures without leaking response bodies', async () => {
    const client = new NsClient({
      apiKey: 'test-secret', baseUrl,
      fetcher: async () => new Response('body contains secret test-secret and request details', { status: 503 })
    });
    let caught: unknown;
    try {
      await client.getStations();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NsApiError);
    expect(caught).toMatchObject({ code: 'http_error', status: 503 });
    expect((caught as Error).message).not.toContain('test-secret');
    expect((caught as Error).message).not.toContain('request details');
  });

  it('times out even when an injected fetcher ignores its abort signal', async () => {
    const client = new NsClient({
      apiKey: 'test-secret', baseUrl, timeoutMs: 5,
      fetcher: async () => new Promise<Response>(() => undefined)
    });
    await expect(client.getStations()).rejects.toMatchObject({ name: 'NsApiError', code: 'timeout' });
  });

  it('rejects redirects, oversized bodies, and invalid JSON with safe error categories', async () => {
    const redirecting = new NsClient({
      apiKey: 'test-secret', baseUrl,
      fetcher: async () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.test' } })
    });
    await expect(redirecting.getStations()).rejects.toMatchObject({ name: 'NsApiError', code: 'redirect_denied' });

    const oversized = new NsClient({
      apiKey: 'test-secret', baseUrl,
      fetcher: async () => new Response('{"payload":[]}', { headers: { 'Content-Length': '3000000' } })
    });
    await expect(oversized.getStations()).rejects.toMatchObject({ name: 'NsApiError', code: 'response_too_large' });

    const invalidJson = new NsClient({ apiKey: 'test-secret', baseUrl, fetcher: async () => new Response('not json') });
    await expect(invalidJson.getStations()).rejects.toMatchObject({ name: 'NsApiError', code: 'invalid_response' });
  });

  it('uses Worker-compatible manual redirect handling and rejects without following', async () => {
    let redirectMode: RequestRedirect | undefined;
    let requestCount = 0;
    const client = new NsClient({
      apiKey: 'test-secret', baseUrl,
      fetcher: async (_request, init) => {
        requestCount += 1;
        redirectMode = init?.redirect;
        if (redirectMode === 'error') throw new TypeError('Invalid redirect value');
        return new Response(null, { status: 302, headers: { Location: 'https://elsewhere.test' } });
      }
    });
    await expect(client.getStations()).rejects.toMatchObject({ name: 'NsApiError', code: 'redirect_denied' });
    expect(redirectMode).toBe('manual');
    expect(requestCount).toBe(1);
  });

  it('keeps the station path fixed and rejects unsafe station codes before making a request', async () => {
    let called = false;
    const client = new NsClient({
      apiKey: 'test-secret', baseUrl,
      fetcher: async () => { called = true; return Response.json([]); }
    });
    await expect(client.getDisruptions({ station: '../secrets', language: 'nl' }))
      .rejects.toMatchObject({ name: 'NsApiError', code: 'invalid_request' });
    expect(called).toBe(false);
  });

  it('accepts the one-character NS station code O', async () => {
    let requestedUrl: URL | undefined;
    const client = new NsClient({
      apiKey: 'test-secret', baseUrl,
      fetcher: async request => {
        requestedUrl = new URL(String(request));
        return Response.json([]);
      }
    });
    await expect(client.getDisruptions({ station: 'O', language: 'nl' })).resolves.toEqual([]);
    expect(requestedUrl?.pathname).toBe('/reisinformatie-api/api/v3/disruptions/station/O');
  });

  it('cancels a stalled response stream when the request timeout expires', async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel: () => { canceled = true; }
    });
    const client = new NsClient({
      apiKey: 'test-secret', baseUrl, timeoutMs: 5,
      fetcher: async () => new Response(body)
    });
    await expect(client.getStations()).rejects.toMatchObject({ name: 'NsApiError', code: 'timeout' });
    expect(canceled).toBe(true);
  });

  it('normalizes basic-offset journey timestamps without changing their instant', async () => {
    const client = clientFor({ trips: [{
      legs: [{
        type: 'TRAIN', product: { type: 'TRAIN' },
        origin: { name: 'Amsterdam Centraal', plannedDateTime: '2026-10-26T09:00:00+0100' },
        destination: { name: 'Utrecht Centraal', actualDateTime: '2026-10-26T09:27:00+0100' }
      }]
    }] });
    const [journey] = await client.planJourney({
      from: 'ASD', to: 'UT', searchForArrival: false, accessible: false, language: 'nl'
    });
    expect(journey.legs[0]).toMatchObject({
      plannedDeparture: '2026-10-26T09:00:00+01:00',
      actualArrival: '2026-10-26T09:27:00+01:00'
    });
  });

  it('normalizes basic-offset departure timestamps before validation', async () => {
    const client = clientFor({ departures: [{
      direction: 'Utrecht Centraal',
      plannedDateTime: '2026-06-02T09:00:00+0200',
      actualDateTime: '2026-06-02T09:02:00+0200'
    }] });
    const [departure] = await client.getDepartures({ station: 'ASD', limit: 10, language: 'nl' });
    expect(departure).toMatchObject({
      plannedDeparture: '2026-06-02T09:00:00+02:00',
      actualDeparture: '2026-06-02T09:02:00+02:00'
    });
  });

  it('normalizes basic-offset disruption times before validation', async () => {
    const client = clientFor([{
      id: 'work-basic-offset', title: 'Planned work', isActive: false,
      start: '2026-06-02T09:00:00+0200', end: '2026-06-02T11:00:00+0200',
      expectedDuration: { endTime: '2026-06-02T11:30:00+0200' }
    }]);
    const [disruption] = await client.getDisruptions({ language: 'nl' });
    expect(disruption).toMatchObject({
      start: '2026-06-02T09:00:00+02:00',
      end: '2026-06-02T11:00:00+02:00',
      expectedEnd: '2026-06-02T11:30:00+02:00'
    });
  });
});
