import { z } from 'zod/v4';
import type { Departure, Disruption, Journey, Station } from './schemas';

const optionalString = z.string().nullable().optional();
// NS can emit basic +HHMM offsets; normalize them here while keeping public schemas strict.
const optionalTime = z.preprocess(
  value => typeof value === 'string' ? value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2') : value,
  z.iso.datetime({ offset: true }).nullable()
).optional();
const optionalBoolean = z.boolean().nullable().optional();
const optionalNonnegativeNumber = z.number().finite().nonnegative().nullable().optional();

const stationNamesSchema = z.object({
  lang: optionalString,
  middel: optionalString,
  kort: optionalString,
  long: optionalString,
  middle: optionalString,
  short: optionalString
}).passthrough();

const stationRawSchema = z.object({
  code: z.string().trim().min(1),
  name: optionalString,
  namen: stationNamesSchema.nullable().optional(),
  names: stationNamesSchema.nullable().optional(),
  UICCode: optionalString,
  EVACode: optionalString,
  uicCode: optionalString,
  evaCode: optionalString,
  synoniemen: z.array(z.string()).nullable().optional()
}).passthrough();

const stopSchema = z.object({
  name: optionalString,
  stationName: optionalString,
  plannedDateTime: optionalTime,
  actualDateTime: optionalTime,
  plannedTrack: optionalString,
  actualTrack: optionalString
}).passthrough().superRefine((stop, context) => {
  if (!nonempty(stop.name) && !nonempty(stop.stationName)) {
    context.addIssue({ code: 'custom', message: 'Missing stop name.' });
  }
});

const productSchema = z.object({
  type: optionalString,
  categoryName: optionalString,
  shortCategoryName: optionalString,
  longCategoryName: optionalString,
  name: optionalString,
  line: optionalString
}).passthrough();

const legSchema = z.object({
  type: optionalString,
  product: productSchema.nullable().optional(),
  origin: stopSchema,
  destination: stopSchema,
  cancelled: optionalBoolean,
  messages: z.unknown().optional(),
  notes: z.unknown().optional()
}).passthrough().superRefine((leg, context) => {
  if (!firstString(leg.product?.type, leg.type, leg.product?.categoryName, leg.product?.shortCategoryName)) {
    context.addIssue({ code: 'custom', message: 'Missing transport mode.' });
  }
});

const tripSchema = z.object({
  ctxRecon: optionalString,
  uid: optionalString,
  plannedDurationInMinutes: optionalNonnegativeNumber,
  durationInMinutes: optionalNonnegativeNumber,
  transfers: z.number().int().nonnegative().nullable().optional(),
  status: optionalString,
  cancelled: optionalBoolean,
  legs: z.array(legSchema).min(1).max(50),
  messages: z.unknown().optional(),
  notes: z.unknown().optional()
}).passthrough();

const departureRawSchema = z.object({
  direction: optionalString,
  destination: optionalString,
  product: productSchema.nullable().optional(),
  trainCategory: optionalString,
  plannedDateTime: optionalTime,
  actualDateTime: optionalTime,
  plannedTrack: optionalString,
  actualTrack: optionalString,
  cancelled: optionalBoolean,
  messages: z.unknown().optional()
}).passthrough().superRefine((departure, context) => {
  if (!firstString(departure.direction, departure.destination)) {
    context.addIssue({ code: 'custom', message: 'Missing departure destination.' });
  }
});

const expectedDurationSchema = z.object({ endTime: optionalTime }).passthrough();
const disruptionRawSchema = z.object({
  id: z.union([z.string(), z.number().int()]).nullable().optional(),
  uri: optionalString,
  title: optionalString,
  header: optionalString,
  type: optionalString,
  isActive: optionalBoolean,
  start: optionalTime,
  end: optionalTime,
  expectedEnd: optionalTime,
  expectedDuration: expectedDurationSchema.nullable().optional(),
  description: optionalString,
  advice: optionalString,
  additionalTravelTime: z.object({ label: optionalString }).passthrough().nullable().optional(),
  cause: z.union([optionalString, z.object({ label: optionalString }).passthrough()]).optional()
}).passthrough();

const MAX_STATIONS = 5_000;
const MAX_JOURNEYS = 100;
const MAX_DEPARTURES = 500;
const MAX_DISRUPTIONS = 2_000;

export function parseStations(payload: unknown): Station[] {
  const items = readArray(payload, [['payload', 'stations'], ['stations'], ['payload']], MAX_STATIONS);
  return items.map(item => {
    const station = parse(stationRawSchema, item);
    const name = firstString(station.namen?.lang, station.names?.long, station.name);
    if (!name) invalidPayload();

    const aliases = uniqueStrings([
      station.namen?.lang,
      station.namen?.middel,
      station.namen?.kort,
      station.names?.long,
      station.names?.middle,
      station.names?.short,
      ...(station.synoniemen ?? []),
      station.code,
      station.UICCode,
      station.uicCode,
      station.EVACode,
      station.evaCode
    ]);
    return { code: station.code, name, aliases };
  });
}

export function parseJourneys(payload: unknown): Journey[] {
  const items = readTripArray(payload);
  if (items.length > MAX_JOURNEYS) invalidPayload();
  return items.map(item => {
    const trip = parse(tripSchema, item);
    return {
      id: firstString(trip.ctxRecon, trip.uid),
      durationMinutes: trip.plannedDurationInMinutes ?? trip.durationInMinutes ?? null,
      transfers: trip.transfers ?? null,
      status: firstString(trip.status),
      cancelled: trip.cancelled ?? null,
      legs: trip.legs.map(leg => ({
        origin: firstString(leg.origin.name, leg.origin.stationName) as string,
        destination: firstString(leg.destination.name, leg.destination.stationName) as string,
        mode: firstString(leg.product?.type, leg.type, leg.product?.categoryName, leg.product?.shortCategoryName) as string,
        product: firstString(
          leg.product?.categoryName,
          leg.product?.shortCategoryName,
          leg.product?.longCategoryName,
          leg.product?.name,
          leg.product?.line
        ),
        plannedDeparture: leg.origin.plannedDateTime ?? null,
        actualDeparture: leg.origin.actualDateTime ?? null,
        plannedArrival: leg.destination.plannedDateTime ?? null,
        actualArrival: leg.destination.actualDateTime ?? null,
        plannedDeparturePlatform: firstString(leg.origin.plannedTrack),
        actualDeparturePlatform: firstString(leg.origin.actualTrack),
        plannedArrivalPlatform: firstString(leg.destination.plannedTrack),
        actualArrivalPlatform: firstString(leg.destination.actualTrack),
        cancelled: leg.cancelled ?? null
      })),
      warnings: uniqueStrings([
        ...primaryMessageWarnings(trip.primaryMessage),
        ...warningTexts(trip.messages),
        ...warningTexts(trip.notes),
        ...trip.legs.flatMap(leg => [...warningTexts(leg.messages), ...warningTexts(leg.notes)])
      ])
    };
  });
}

export function parseDepartures(payload: unknown): Departure[] {
  const items = readArray(payload, [['payload', 'departures'], ['departures'], ['payload']], MAX_DEPARTURES);
  return items.map(item => {
    const departure = parse(departureRawSchema, item);
    return {
      destination: firstString(departure.direction, departure.destination) as string,
      product: firstString(
        departure.product?.categoryName,
        departure.product?.shortCategoryName,
        departure.product?.longCategoryName,
        departure.trainCategory
      ),
      plannedDeparture: departure.plannedDateTime ?? null,
      actualDeparture: departure.actualDateTime ?? null,
      plannedPlatform: firstString(departure.plannedTrack),
      actualPlatform: firstString(departure.actualTrack),
      cancelled: departure.cancelled ?? null,
      warnings: uniqueStrings(warningTexts(departure.messages))
    };
  });
}

export function parseDisruptions(payload: unknown): Disruption[] {
  const items = readArray(payload, [['payload', 'disruptions'], ['disruptions'], ['payload']], MAX_DISRUPTIONS);
  return items.map(item => {
    const disruption = parse(disruptionRawSchema, item);
    const title = firstString(
      disruption.title,
      disruption.header,
      typeof disruption.cause === 'string' ? disruption.cause : disruption.cause?.label
    );
    if (!title) invalidPayload();

    return {
      id: disruption.id === undefined || disruption.id === null
        ? firstString(disruption.uri)
        : String(disruption.id),
      title,
      type: firstString(disruption.type),
      isActive: disruption.isActive ?? null,
      start: disruption.start ?? null,
      end: disruption.end ?? null,
      expectedEnd: disruption.expectedEnd ?? disruption.expectedDuration?.endTime ?? null,
      description: combineStrings([
        disruption.description,
        ...nestedStrings(disruption, [
          ['publicationSections', 'consequence', 'description']
        ]),
        ...arrayItemNestedStrings(disruption.timespans, [
          ['situation', 'label'],
          ['consequence', 'description']
        ]),
        ...nestedStrings(disruption, [
        ['Calamitydescription'],
        ['bodyItems', 'content', 'text']
        ])
      ]),
      advice: combineStrings([
        disruption.advice,
        disruption.additionalTravelTime?.label,
        ...nestedStrings(disruption, [['timespans', 'advices'], ['advices']])
      ])
    };
  });
}

function readTripArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return flattenTripItems(payload);
  if (!isRecord(payload)) invalidPayload();

  if (hasOwn(payload, 'trips')) return requireArray(payload.trips);
  if (hasOwn(payload, 'trip')) return [payload.trip];
  if (hasOwn(payload, 'payload')) {
    const nested = payload.payload;
    if (Array.isArray(nested)) return flattenTripItems(nested);
    if (!isRecord(nested)) invalidPayload();
    if (hasOwn(nested, 'trips')) return requireArray(nested.trips);
    if (hasOwn(nested, 'trip')) return [nested.trip];
    if (hasOwn(nested, 'legs') || hasOwn(nested, 'ctxRecon')) return [nested];
    invalidPayload();
  }
  if (hasOwn(payload, 'legs') || hasOwn(payload, 'ctxRecon')) return [payload];
  invalidPayload();
}

function flattenTripItems(items: unknown[]): unknown[] {
  if (items.length === 0) return [];
  if (items.every(item => isRecord(item) && (hasOwn(item, 'legs') || hasOwn(item, 'ctxRecon')))) {
    return items;
  }
  return items.flatMap(item => {
    if (!isRecord(item)) invalidPayload();
    if (hasOwn(item, 'trips')) return requireArray(item.trips);
    if (hasOwn(item, 'trip')) return [item.trip];
    invalidPayload();
  });
}

function readArray(payload: unknown, paths: string[][], maxItems: number): unknown[] {
  if (Array.isArray(payload)) return boundedArray(payload, maxItems);
  if (!isRecord(payload)) invalidPayload();

  for (const path of paths) {
    const result = readPath(payload, path);
    if (!result.found) continue;
    if (!Array.isArray(result.value)) invalidPayload();
    return boundedArray(result.value, maxItems);
  }
  invalidPayload();
}

function readPath(root: Record<string, unknown>, path: string[]): { found: boolean; value?: unknown } {
  let current: unknown = root;
  for (const part of path) {
    if (!isRecord(current) || !hasOwn(current, part)) return { found: false };
    current = current[part];
  }
  return { found: true, value: current };
}

function boundedArray(items: unknown[], maxItems: number): unknown[] {
  if (items.length > maxItems) invalidPayload();
  return items;
}

function requireArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) invalidPayload();
  return value;
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) invalidPayload();
  return result.data;
}

function warningTexts(value: unknown, depth = 0): string[] {
  if (depth > 5) return [];
  if (typeof value === 'string') return nonempty(value) ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(item => warningTexts(item, depth + 1));
  if (!isRecord(value)) return [];
  for (const key of ['text', 'message', 'value', 'shortValue', 'head', 'lead']) {
    if (hasOwn(value, key)) return warningTexts(value[key], depth + 1);
  }
  return [];
}

function primaryMessageWarnings(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const message = value.message;
  if (isRecord(message) && nonempty(message.text)) return [message.text.trim()];
  return nonempty(value.title) ? [value.title.trim()] : [];
}

function nestedStrings(root: Record<string, unknown>, paths: string[][]): string[] {
  return paths.flatMap(path => nestedPathStrings(root, path));
}

function arrayItemNestedStrings(value: unknown, paths: string[][]): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => paths.flatMap(path => nestedPathStrings(item, path)));
}

function nestedPathStrings(root: unknown, path: string[]): string[] {
  let current: unknown[] = [root];
  for (const part of path) {
    current = current.flatMap(value => {
      const candidates = Array.isArray(value) ? value : [value];
      return candidates.flatMap(candidate =>
        isRecord(candidate) && hasOwn(candidate, part) ? [candidate[part]] : []
      );
    });
  }
  return current.flatMap(value => warningTexts(value));
}

function firstString(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (nonempty(value)) return value.trim();
  }
  return null;
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!nonempty(value)) continue;
    const normalized = value.trim();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function combineStrings(values: Array<string | null | undefined>): string | null {
  const combined = uniqueStrings(values).join(' ');
  return combined.length > 0 ? combined : null;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidPayload(): never {
  throw new Error('Invalid upstream payload.');
}
