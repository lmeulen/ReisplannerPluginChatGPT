import type { Context } from 'hono';

export interface Env {
  NS_API_KEY: string;
  NS_API_BASE_URL?: string;
  WEATHER_API_BASE_URL?: string;
  RESPONSE_MODE?: ResponseMode;
  LOG_LEVEL?: 'debug' | 'info' | 'warn' | 'error';
  MCP_RATE_LIMIT_PER_MINUTE?: string;
  MCP_RATE_LIMITER?: DurableObjectNamespace;
}

export type Language = 'nl' | 'en';
export type ResponseMode = 'strict' | 'flexible';

export interface StationSearchInput {
  query: string;
  language: Language;
  countryCodes?: string[];
  limit: number;
}

export interface StationInfoInput {
  stationCode: string;
  language: Language;
}

export interface StationBoardInput {
  stationCode?: string;
  uicCode?: string;
  dateTime?: string;
  maxResults: number;
  language: Language;
}

export interface NearestStationsInput {
  latitude: number;
  longitude: number;
  limit: number;
  language: Language;
}

export interface JourneyPlanInput {
  from: string;
  to: string;
  dateTime?: string;
  searchForArrival: boolean;
  language: Language;
  responseMode?: ResponseMode;
  viaStation?: string;
  localTrainsOnly?: boolean;
  excludeHighSpeedTrains?: boolean;
  excludeTrainsWithReservationRequired?: boolean;
  addChangeTime?: number;
  travelClass?: 1 | 2;
  discount?: string;
  passing?: boolean;
  showLiftInfo?: boolean;
  preferences: {
    minimizeTransfers: boolean;
    extraTransferTimeMinutes: number;
    accessible: boolean;
  };
}

export interface JourneyDetailsInput {
  journeyDetailRef?: string;
  trainNumber?: number;
  dateTime?: string;
  departureUicCode?: string;
  transferUicCode?: string;
  arrivalUicCode?: string;
  omitCrowdForecast: boolean;
  language: Language;
}

export interface SingleTripInput {
  ctxRecon: string;
  date?: string;
  travelRequestType?: string;
  sourceCtxRecon?: boolean;
  product?: string;
  discount?: string;
  travelClass?: 1 | 2;
  language: Language;
}

export interface DomesticPriceInput {
  fromStation: string;
  toStation: string;
  travelClass?: string;
  travelType?: string;
  isJointJourney: boolean;
  adults: number;
  children: number;
  routeId?: string;
  plannedFromTime?: string;
  plannedArrivalTime?: string;
}

export interface DisruptionsQueryInput {
  types?: string[];
  isActive?: boolean;
  language: Language;
}

export interface StationDisruptionsInput {
  stationCode: string;
  language: Language;
}

export interface SingleDisruptionInput {
  type: string;
  id: string;
  language: Language;
}

export interface AppVariables {
  requestId: string;
}

export type AppBindings = { Bindings: Env; Variables: AppVariables };
export type AppContext = Context<AppBindings>;

export interface StationResult {
  code: string;
  name: string;
  country: string;
  type: string;
  score: number;
  matchType: 'exact' | 'contains' | 'fuzzy' | 'fallback';
  uicCode: string | null;
  latitude: number | null;
  longitude: number | null;
  distanceMeters?: number | null;
}

export interface StationInfoResult {
  code: string;
  name: string;
  country: string;
  type: string;
  uicCode: string | null;
  evaCode: string | null;
  latitude: number | null;
  longitude: number | null;
  aliases: string[];
  synonyms: string[];
  tracks: string[];
  hasFacilities: boolean | null;
  hasTravelAssistance: boolean | null;
  hasDepartures: boolean | null;
  weather: WeatherResult | null;
}

export interface WeatherResult {
  latitude: number;
  longitude: number;
  observedAt: string | null;
  temperatureCelsius: number | null;
  apparentTemperatureCelsius: number | null;
  precipitationProbabilityPercent: number | null;
  precipitationMillimeters: number | null;
  windSpeedKmh: number | null;
  windDirectionDegrees: number | null;
  weatherCode: number | null;
  source: string;
  retrievedAt: string;
}

export interface RouteStationResult {
  name: string | null;
  uicCode: string | null;
}

export interface StationDepartureResult {
  name: string;
  direction: string;
  plannedDateTime: string | null;
  actualDateTime: string | null;
  plannedPlatform: string | null;
  actualPlatform: string | null;
  product: string;
  trainNumber: string | null;
  status: string | null;
  cancelled: boolean;
  delay: string | null;
  journeyDetailRef: string | null;
  messages: string[];
  routeStations: RouteStationResult[];
  operatorName: string | null;
  lineNumber: string | null;
  productType: string | null;
}

export interface StationArrivalResult {
  name: string;
  origin: string;
  plannedDateTime: string | null;
  actualDateTime: string | null;
  plannedPlatform: string | null;
  actualPlatform: string | null;
  product: string;
  trainNumber: string | null;
  status: string | null;
  cancelled: boolean;
  delay: string | null;
  journeyDetailRef: string | null;
  messages: string[];
  operatorName: string | null;
  lineNumber: string | null;
  productType: string | null;
}

export interface DomesticPriceResult {
  totalPriceInCents: number;
  totalPrice: string;
  travelClass: string;
  travelDiscount: string;
  travelProducts: string[];
  operatorName: string | null;
  priceDifferenceInCentsBetweenFirstAndSecondClass: number | null;
  priceDifferenceInCentsBetweenJointJourneyDiscount: number | null;
}

export interface JourneySummary {
  departure: string | null;
  arrival: string | null;
  durationMinutes: number | null;
  transfers: number;
  status: string;
}

export interface JourneyLeg {
  origin: string;
  destination: string;
  plannedDeparture: string | null;
  actualDeparture: string | null;
  plannedArrival: string | null;
  actualArrival: string | null;
  transportType: string;
  lineName: string | null;
  direction: string | null;
  plannedPlatform: string | null;
  actualPlatform: string | null;
  cancelled: boolean;
  journeyDetailRef: string | null;
  routeId: string | null;
}

export interface JourneyOption {
  id: string;
  ctxRecon: string | null;
  routeId: string | null;
  summary: JourneySummary;
  legs: JourneyLeg[];
  warnings: string[];
}

export interface JourneyStopResult {
  id: string;
  name: string;
  kind: string | null;
  plannedArrival: string | null;
  actualArrival: string | null;
  plannedDeparture: string | null;
  actualDeparture: string | null;
  plannedPlatform: string | null;
  actualPlatform: string | null;
  status: string | null;
  cancelled: boolean;
  weather: WeatherResult | null;
}

export interface JourneyDetailsResult {
  source: string | null;
  productNumbers: string[];
  allowCrowdReporting: boolean | null;
  stops: JourneyStopResult[];
  notes: string[];
}

export interface DisruptionResult {
  id: string;
  title: string;
  type: string;
  topic: string | null;
  isActive: boolean | null;
  severity: string | null;
  period: string | null;
  advice: string | null;
}