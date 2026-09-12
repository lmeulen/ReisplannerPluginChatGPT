import type {
  DisruptionResult,
  DisruptionsQueryInput,
  DomesticPriceInput,
  DomesticPriceResult,
  JourneyDetailsInput,
  JourneyDetailsResult,
  JourneyLeg,
  JourneyOption,
  JourneyPlanInput,
  JourneyStopResult,
  NearestStationsInput,
  SingleDisruptionInput,
  SingleTripInput,
  StationArrivalResult,
  StationDisruptionsInput,
  StationBoardInput,
  StationDepartureResult,
  StationInfoInput,
  StationInfoResult,
  StationResult,
  StationSearchInput
} from './types';

export class NsApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'NsApiError';
  }
}

export function isNsApiError(error: unknown): error is NsApiError {
  return error instanceof NsApiError || (isRecord(error) && error.name === 'NsApiError' && typeof error.status === 'number');
}

export interface NsClientOptions {
  apiKey: string;
  baseUrl: string;
  fetcher?: typeof fetch;
}

export class NsClient {
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: NsClientOptions) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async searchStations(input: StationSearchInput): Promise<StationResult[]> {
    const payload = await this.getJson('/v2/stations', { q: input.query, countryCodes: input.countryCodes, limit: input.limit });
    const stations = arrayFromPayload(payload);
    const exactMatches = normalizeAndRankStations(stations, input.query, input.limit);

    if (exactMatches.length > 0) {
      return exactMatches;
    }

    const allStationsPayload = await this.getJson('/v2/stations', { countryCodes: input.countryCodes });
    return normalizeAndRankStations(arrayFromPayload(allStationsPayload), input.query, input.limit);
  }

  async getStationInfo(input: StationInfoInput): Promise<StationInfoResult | null> {
    const payload = await this.getJson('/v2/stations', { q: input.stationCode });
    const stations = arrayFromPayload(payload);
    const normalizedCode = input.stationCode.toLocaleUpperCase('nl-NL');
    const station = stations.find((candidate) => String(candidate?.code ?? '').toLocaleUpperCase('nl-NL') === normalizedCode) ?? stations[0];

    return station ? normalizeStationInfo(station) : null;
  }

  async getDepartures(input: StationBoardInput): Promise<StationDepartureResult[]> {
    const payload = await this.getJson('/v2/departures', {
      lang: input.language,
      station: input.stationCode,
      uicCode: input.uicCode,
      dateTime: input.dateTime,
      maxJourneys: String(input.maxResults)
    });

    return arrayFromPayloadProperty(payload, 'departures').map(normalizeDeparture).slice(0, input.maxResults);
  }

  async getArrivals(input: StationBoardInput): Promise<StationArrivalResult[]> {
    const payload = await this.getJson('/v2/arrivals', {
      lang: input.language,
      station: input.stationCode,
      uicCode: input.uicCode,
      dateTime: input.dateTime,
      maxJourneys: String(input.maxResults)
    });

    return arrayFromPayloadProperty(payload, 'arrivals').map(normalizeArrival).slice(0, input.maxResults);
  }

  async getNearestStations(input: NearestStationsInput): Promise<StationResult[]> {
    const payload = await this.getJson('/v2/stations/nearest', {
      lat: input.latitude,
      lng: input.longitude,
      limit: input.limit
    });

    return arrayFromPayload(payload)
      .map((station, index) => normalizeStation(station, '', index))
      .filter((station): station is StationResult => station !== null)
      .slice(0, input.limit);
  }

  async planJourney(input: JourneyPlanInput): Promise<JourneyOption[]> {
    const payload = await this.getJson('/v3/trips', {
      lang: input.language,
      fromStation: input.from,
      toStation: input.to,
      viaStation: input.viaStation,
      dateTime: input.dateTime,
      searchForArrival: String(input.searchForArrival),
      shortTransfer: String(input.preferences.extraTransferTimeMinutes === 0),
      addChangeTime: input.addChangeTime ?? input.preferences.extraTransferTimeMinutes,
      travelAssistance: String(input.preferences.accessible),
      searchForAccessibleTrip: input.preferences.accessible,
      localTrainsOnly: input.localTrainsOnly,
      excludeHighSpeedTrains: input.excludeHighSpeedTrains,
      excludeTrainsWithReservationRequired: input.excludeTrainsWithReservationRequired,
      discount: input.discount,
      travelClass: input.travelClass,
      passing: input.passing,
      showLiftInfo: input.showLiftInfo
    });

    const trips = tripsFromTravelAdvicePayload(payload);
    return trips.map(normalizeJourney).slice(0, 3);
  }

  async getSingleTrip(input: SingleTripInput): Promise<JourneyOption[]> {
    const payload = await this.getJson(
      '/v3/trips/trip',
      {
        ctxRecon: input.ctxRecon,
        date: input.date,
        travelRequestType: input.travelRequestType,
        sourceCtxRecon: input.sourceCtxRecon,
        product: input.product,
        discount: input.discount,
        travelClass: input.travelClass
      },
      { lang: input.language }
    );

    const trips = tripArrayFromPayload(payload);
    return trips.map(normalizeJourney).slice(0, 3);
  }

  async getJourneyDetails(input: JourneyDetailsInput): Promise<JourneyDetailsResult> {
    const payload = await this.getJson('/v2/journey', {
      id: input.journeyDetailRef,
      train: input.trainNumber,
      dateTime: input.dateTime,
      departureUicCode: input.departureUicCode,
      transferUicCode: input.transferUicCode,
      arrivalUicCode: input.arrivalUicCode,
      omitCrowdForecast: input.omitCrowdForecast
    });

    return normalizeJourneyDetails(payload?.payload ?? payload);
  }

  async getDomesticPrice(input: DomesticPriceInput): Promise<DomesticPriceResult | null> {
    const payload = await this.getJson('/v2/price', {
      fromStation: input.fromStation,
      toStation: input.toStation,
      travelClass: input.travelClass,
      travelType: input.travelType,
      isJointJourney: input.isJointJourney,
      adults: input.adults,
      children: input.children,
      routeId: input.routeId,
      plannedFromTime: input.plannedFromTime,
      plannedArrivalTime: input.plannedArrivalTime
    });

    return normalizeDomesticPrice(payload?.payload ?? payload);
  }

  async getDisruptions(input: DisruptionsQueryInput): Promise<DisruptionResult[]> {
    const payload = await this.getJson('/v3/disruptions', { type: input.types, isActive: input.isActive }, { 'Accept-Language': input.language });

    return arrayFromPayload(payload).map(normalizeDisruption).slice(0, 10);
  }

  async getStationDisruptions(input: StationDisruptionsInput): Promise<DisruptionResult[]> {
    const payload = await this.getJson(`/v3/disruptions/station/${encodeURIComponent(input.stationCode)}`, {}, { 'Accept-Language': input.language });

    return arrayFromPayload(payload).map(normalizeDisruption).slice(0, 10);
  }

  async getSingleDisruption(input: SingleDisruptionInput): Promise<DisruptionResult | null> {
    const payload = await this.getJson(
      `/v3/disruptions/${encodeURIComponent(input.type)}/${encodeURIComponent(input.id)}`,
      {},
      { 'Accept-Language': input.language }
    );

    return normalizeDisruption(payload, 0);
  }

  private async getJson(
    path: string,
    params: Record<string, string | number | boolean | string[] | undefined>,
    extraHeaders: Record<string, string> = {}
  ): Promise<any> {
    const url = new URL(`${this.options.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item !== '') url.searchParams.append(key, item);
        }
      } else if (value !== undefined && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await this.fetcher(url, {
      headers: {
        Accept: 'application/json',
        ...extraHeaders,
        'Ocp-Apim-Subscription-Key': this.options.apiKey
      }
    });

    if (!response.ok) {
      throw new NsApiError(`NS API returned ${response.status}`, response.status);
    }

    return response.json();
  }
}

function arrayFromPayload(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.payload)) return payload.payload;
  if (Array.isArray(payload?.disruptions)) return payload.disruptions;
  if (Array.isArray(payload?.stations)) return payload.stations;
  return [];
}

function arrayFromPayloadProperty(payload: any, property: string): any[] {
  if (Array.isArray(payload?.[property])) return payload[property];
  if (Array.isArray(payload?.payload?.[property])) return payload.payload[property];
  if (Array.isArray(payload?.payload)) return payload.payload;
  return arrayFromPayload(payload);
}

function tripArrayFromPayload(payload: any): any[] {
  if (Array.isArray(payload?.trips)) return payload.trips;
  if (payload?.trip) return [payload.trip];
  if (Array.isArray(payload?.payload?.trips)) return payload.payload.trips;
  if (payload?.payload?.trip) return [payload.payload.trip];
  if (Array.isArray(payload?.legs) || payload?.ctxRecon) return [payload];
  if (Array.isArray(payload?.payload?.legs) || payload?.payload?.ctxRecon) return [payload.payload];
  return arrayFromPayload(payload);
}

function tripsFromTravelAdvicePayload(payload: any): any[] {
  if (Array.isArray(payload?.trips)) return payload.trips;
  if (Array.isArray(payload?.payload?.trips)) return payload.payload.trips;
  if (Array.isArray(payload)) return payload.flatMap((advice) => (Array.isArray(advice?.trips) ? advice.trips : []));
  if (Array.isArray(payload?.payload)) return payload.payload.flatMap((advice: any) => (Array.isArray(advice?.trips) ? advice.trips : []));
  return tripArrayFromPayload(payload);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeAndRankStations(stations: any[], query: string, limit: number): StationResult[] {
  return stations
    .map((station, index) => normalizeStation(station, query, index))
    .filter((station): station is StationResult => station !== null)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

function normalizeStation(station: any, query: string, index: number): StationResult | null {
  const code = String(station?.code ?? station?.UICCode ?? '').trim();
  const name = String(station?.namen?.lang ?? station?.name ?? station?.names?.long ?? '').trim();
  if (!code || !name) return null;

  const match = scoreStationMatch(station, query, index);
  if (!match) return null;

  return {
    code,
    name,
    country: String(station?.land ?? station?.country ?? 'NL'),
    type: String(station?.stationType ?? station?.type ?? 'station'),
    score: match.score,
    matchType: match.matchType,
    uicCode: nullableString(station?.UICCode ?? station?.uicCode),
    latitude: numberOrNull(station?.lat ?? station?.latitude),
    longitude: numberOrNull(station?.lng ?? station?.longitude),
    distanceMeters: numberOrNull(station?.distance)
  };
}

function scoreStationMatch(station: any, query: string, index: number): { score: number; matchType: StationResult['matchType'] } | null {
  const normalizedQuery = normalizeSearchText(query);
  const terms = stationSearchTerms(station);

  if (!normalizedQuery) {
    return { score: 50 - index, matchType: 'fallback' };
  }

  for (const term of terms) {
    if (term === normalizedQuery) {
      return { score: 100 + stationPriority(station) - indexPenalty(index), matchType: 'exact' };
    }
  }

  for (const term of terms) {
    if (term.includes(normalizedQuery)) {
      return { score: 86 + stationPriority(station) - indexPenalty(index), matchType: 'contains' };
    }
  }

  let bestRatio = 0;
  for (const term of terms) {
    if (term.length < 3) continue;
    const ratio = levenshteinSimilarity(normalizedQuery, term);
    if (ratio > bestRatio) bestRatio = ratio;
  }

  if (bestRatio < 0.72) {
    return null;
  }

  return { score: Math.max(1, Math.round(60 + bestRatio * 35) + stationPriority(station) - indexPenalty(index)), matchType: 'fuzzy' };
}

function indexPenalty(index: number): number {
  return Math.min(index, 5);
}

function stationPriority(station: any): number {
  const name = normalizeSearchText(station?.namen?.lang ?? station?.name ?? station?.names?.long);
  const type = normalizeSearchText(station?.stationType ?? station?.type);
  let priority = 0;

  if (name.endsWith('centraal')) priority += 8;
  if (type.includes('knooppunt')) priority += 4;
  if (type.includes('intercity')) priority += 2;

  return priority;
}

function stationSearchTerms(station: any): string[] {
  const rawTerms = [
    station?.code,
    station?.UICCode,
    station?.uicCode,
    station?.namen?.kort,
    station?.namen?.middel,
    station?.namen?.lang,
    station?.name,
    station?.names?.short,
    station?.names?.middle,
    station?.names?.long,
    ...(Array.isArray(station?.synoniemen) ? station.synoniemen : [])
  ];
  const terms = rawTerms.flatMap((value) => {
    const normalized = normalizeSearchText(value);
    return normalized ? [normalized, ...normalized.split(' ').filter((part) => part.length >= 3)] : [];
  });

  return [...new Set(terms)];
}

function normalizeSearchText(value: unknown): string {
  return typeof value === 'string'
    ? value
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase('nl-NL')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
    : '';
}

function levenshteinSimilarity(left: string, right: string): number {
  const distance = levenshteinDistance(left, right);
  return 1 - distance / Math.max(left.length, right.length, 1);
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    current[0] = leftIndex + 1;
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex] === right[rightIndex] ? 0 : 1;
      current[rightIndex + 1] = Math.min(
        current[rightIndex] + 1,
        previous[rightIndex + 1] + 1,
        previous[rightIndex] + substitutionCost
      );
    }

    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length];
}

function normalizeStationInfo(station: any): StationInfoResult | null {
  const code = String(station?.code ?? '').trim();
  const name = String(station?.namen?.lang ?? station?.name ?? station?.names?.long ?? '').trim();
  if (!code || !name) return null;

  const aliases = [station?.namen?.kort, station?.namen?.middel, station?.namen?.lang, station?.name, station?.names?.short, station?.names?.middle, station?.names?.long]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);

  return {
    code,
    name,
    country: String(station?.land ?? station?.country ?? 'NL'),
    type: String(station?.stationType ?? station?.type ?? 'station'),
    uicCode: nullableString(station?.UICCode ?? station?.uicCode),
    evaCode: nullableString(station?.EVACode ?? station?.evaCode),
    latitude: numberOrNull(station?.lat ?? station?.latitude),
    longitude: numberOrNull(station?.lng ?? station?.longitude),
    aliases,
    synonyms: Array.isArray(station?.synoniemen) ? station.synoniemen.filter((value: any): value is string => typeof value === 'string') : [],
    tracks: Array.isArray(station?.sporen)
      ? station.sporen.map((track: any) => track?.spoorNummer).filter((value: any): value is string => typeof value === 'string')
      : [],
    hasFacilities: booleanOrNull(station?.heeftFaciliteiten),
    hasTravelAssistance: booleanOrNull(station?.heeftReisassistentie),
    hasDepartures: booleanOrNull(station?.heeftVertrektijden),
    weather: null
  };
}

function normalizeDeparture(departure: any): StationDepartureResult {
  return {
    name: String(departure?.name ?? departure?.product?.longCategoryName ?? departure?.product?.categoryName ?? 'Trein'),
    direction: String(departure?.direction ?? departure?.destination ?? ''),
    plannedDateTime: nullableString(departure?.plannedDateTime),
    actualDateTime: nullableString(departure?.actualDateTime),
    plannedPlatform: nullableString(departure?.plannedTrack),
    actualPlatform: nullableString(departure?.actualTrack),
    product: String(departure?.product?.categoryName ?? departure?.product?.shortCategoryName ?? departure?.trainCategory ?? 'train'),
    trainNumber: nullableString(departure?.product?.number ?? departure?.trainNumber),
    status: nullableString(departure?.departureStatus ?? departure?.status),
    cancelled: Boolean(departure?.cancelled),
    delay: nullableString(departure?.delay ?? departure?.actualDateTimeDelay),
    journeyDetailRef: nullableString(departure?.journeyDetailRef),
    messages: normalizeMessages(departure?.messages),
    routeStations: Array.isArray(departure?.routeStations)
      ? departure.routeStations.map((station: any) => ({ name: nullableString(station?.mediumName ?? station?.name), uicCode: nullableString(station?.uicCode ?? station?.UICCode) }))
      : [],
    operatorName: nullableString(departure?.product?.operatorName),
    lineNumber: nullableString(departure?.product?.lineNumber),
    productType: nullableString(departure?.product?.productType ?? departure?.product?.type)
  };
}

function normalizeArrival(arrival: any): StationArrivalResult {
  return {
    name: String(arrival?.name ?? arrival?.product?.longCategoryName ?? arrival?.product?.categoryName ?? 'Trein'),
    origin: String(arrival?.origin ?? arrival?.direction ?? ''),
    plannedDateTime: nullableString(arrival?.plannedDateTime),
    actualDateTime: nullableString(arrival?.actualDateTime),
    plannedPlatform: nullableString(arrival?.plannedTrack),
    actualPlatform: nullableString(arrival?.actualTrack),
    product: String(arrival?.product?.categoryName ?? arrival?.product?.shortCategoryName ?? arrival?.trainCategory ?? 'train'),
    trainNumber: nullableString(arrival?.product?.number ?? arrival?.trainNumber),
    status: nullableString(arrival?.arrivalStatus ?? arrival?.status),
    cancelled: Boolean(arrival?.cancelled),
    delay: nullableString(arrival?.delay ?? arrival?.actualDateTimeDelay),
    journeyDetailRef: nullableString(arrival?.journeyDetailRef),
    messages: normalizeMessages(arrival?.messages),
    operatorName: nullableString(arrival?.product?.operatorName),
    lineNumber: nullableString(arrival?.product?.lineNumber),
    productType: nullableString(arrival?.product?.productType ?? arrival?.product?.type)
  };
}

function normalizeJourney(trip: any, index: number): JourneyOption {
  const legs = Array.isArray(trip?.legs) ? trip.legs.map(normalizeLeg) : [];
  const warnings = collectWarnings(trip);
  const ctxRecon = nullableString(trip?.ctxRecon);

  return {
    id: String(ctxRecon ?? trip?.uid ?? `journey-${index + 1}`),
    ctxRecon,
    routeId: nullableString(trip?.routeId ?? trip?.fareRoute?.routeId),
    summary: {
      departure: firstLegTime(legs, 'departure'),
      arrival: firstLegTime(legs, 'arrival'),
      durationMinutes: numberOrNull(trip?.plannedDurationInMinutes ?? trip?.durationInMinutes),
      transfers: numberOrZero(trip?.transfers),
      status: String(trip?.status ?? 'UNKNOWN')
    },
    legs,
    warnings
  };
}

function normalizeLeg(leg: any): JourneyLeg {
  return {
    origin: String(leg?.origin?.name ?? leg?.origin?.stationName ?? ''),
    destination: String(leg?.destination?.name ?? leg?.destination?.stationName ?? ''),
    plannedDeparture: nullableString(leg?.origin?.plannedDateTime),
    actualDeparture: nullableString(leg?.origin?.actualDateTime),
    plannedArrival: nullableString(leg?.destination?.plannedDateTime),
    actualArrival: nullableString(leg?.destination?.actualDateTime),
    transportType: String(leg?.product?.categoryName ?? leg?.product?.shortCategoryName ?? leg?.type ?? 'train'),
    lineName: nullableString(leg?.name ?? leg?.product?.line),
    direction: nullableString(leg?.direction),
    plannedPlatform: nullableString(leg?.origin?.plannedTrack),
    actualPlatform: nullableString(leg?.origin?.actualTrack),
    cancelled: Boolean(leg?.cancelled),
    journeyDetailRef: nullableString(leg?.journeyDetailRef),
    routeId: nullableString(leg?.routeId)
  };
}

function normalizeDisruption(disruption: any, index: number): DisruptionResult {
  return {
    id: String(disruption?.id ?? disruption?.uri ?? `disruption-${index + 1}`),
    title: String(disruption?.title ?? disruption?.header ?? disruption?.cause ?? 'Onbekende verstoring'),
    type: String(disruption?.type ?? 'disruption'),
    topic: nullableString(disruption?.topic),
    isActive: booleanOrNull(disruption?.isActive),
    severity: nullableString(disruption?.severity),
    period: nullableString(disruption?.period ?? disruption?.timespans?.[0]?.period),
    advice: nullableString(disruption?.advice ?? disruption?.additionalTravelTime?.label)
  };
}

function normalizeDomesticPrice(price: any): DomesticPriceResult | null {
  const totalPriceInCents = numberOrNull(price?.totalPriceInCents);
  if (totalPriceInCents === null) return null;

  return {
    totalPriceInCents,
    totalPrice: `EUR ${(totalPriceInCents / 100).toFixed(2)}`,
    travelClass: String(price?.travelClass ?? ''),
    travelDiscount: String(price?.travelDiscount ?? ''),
    travelProducts: Array.isArray(price?.travelProducts) ? price.travelProducts.filter((value: any): value is string => typeof value === 'string') : [],
    operatorName: nullableString(price?.operatorName),
    priceDifferenceInCentsBetweenFirstAndSecondClass: numberOrNull(price?.priceDifferenceInCentsBetweenFirstAndSecondClass),
    priceDifferenceInCentsBetweenJointJourneyDiscount: numberOrNull(price?.priceDifferenceInCentsBetweenJointJourneyDiscount)
  };
}

function normalizeJourneyDetails(journey: any): JourneyDetailsResult {
  return {
    source: nullableString(journey?.source),
    productNumbers: Array.isArray(journey?.productNumbers) ? journey.productNumbers.filter((value: any): value is string => typeof value === 'string') : [],
    allowCrowdReporting: booleanOrNull(journey?.allowCrowdReporting),
    stops: Array.isArray(journey?.stops) ? journey.stops.map(normalizeJourneyStop) : [],
    notes: normalizeMessages(journey?.notes)
  };
}

function normalizeJourneyStop(stop: any): JourneyStopResult {
  const arrivals = Array.isArray(stop?.arrivals) ? stop.arrivals : [];
  const departures = Array.isArray(stop?.departures) ? stop.departures : [];
  const firstArrival = arrivals[0] ?? {};
  const firstDeparture = departures[0] ?? {};

  return {
    id: String(stop?.id ?? stop?.stop?.UICCode ?? stop?.stop?.uicCode ?? ''),
    name: String(stop?.stop?.namen?.lang ?? stop?.stop?.name ?? stop?.destination ?? ''),
    kind: nullableString(stop?.kind),
    plannedArrival: nullableString(firstArrival?.plannedTime),
    actualArrival: nullableString(firstArrival?.actualTime),
    plannedDeparture: nullableString(firstDeparture?.plannedTime),
    actualDeparture: nullableString(firstDeparture?.actualTime),
    plannedPlatform: nullableString(firstDeparture?.plannedTrack ?? firstArrival?.plannedTrack),
    actualPlatform: nullableString(firstDeparture?.actualTrack ?? firstArrival?.actualTrack),
    status: nullableString(stop?.status),
    cancelled: Boolean(firstDeparture?.cancelled ?? firstArrival?.cancelled),
    weather: null
  };
}

function collectWarnings(trip: any): string[] {
  const messages = [trip?.messages, trip?.notes, trip?.legs?.flatMap((leg: any) => leg?.messages ?? leg?.notes ?? [])].flat(2);

  return normalizeMessages(messages);
}

function normalizeMessages(messages: any): string[] {
  return [messages]
    .flat(3)
    .map((message: any) => message?.text ?? message?.message ?? message?.value ?? message?.shortValue ?? message?.head ?? message?.lead ?? message)
    .filter((message: any): message is string => typeof message === 'string' && message.trim().length > 0);
}

function firstLegTime(legs: JourneyLeg[], side: 'departure' | 'arrival'): string | null {
  if (side === 'departure') {
    return legs[0]?.actualDeparture ?? legs[0]?.plannedDeparture ?? null;
  }

  const lastLeg = legs[legs.length - 1];
  return lastLeg?.actualArrival ?? lastLeg?.plannedArrival ?? null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

