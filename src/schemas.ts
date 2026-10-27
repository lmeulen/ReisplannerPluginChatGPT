import { z } from 'zod/v4';

const stationQuery = z.string().trim().min(1).max(120).describe('NS station name or code; do not supply an address or infer a location.');
const dateTime = z.iso.datetime({ offset: true }).describe('ISO 8601 time with UTC offset. Omit for now. Use Europe/Amsterdam for Dutch local time.');
const language = z.enum(['nl', 'en']).default('nl');

export const planInputSchema = z.strictObject({
  from: stationQuery,
  to: stationQuery,
  dateTime: dateTime.optional(),
  searchForArrival: z.boolean().default(false).describe('True only for an arrive-by deadline; requires dateTime.'),
  accessible: z.boolean().default(false).describe('Request accessible planning; does not reserve assistance.'),
  language
}).refine(input => !input.searchForArrival || input.dateTime !== undefined, { message: 'An arrival deadline requires dateTime.', path: ['dateTime'] });

export const departuresInputSchema = z.strictObject({
  station: stationQuery,
  dateTime: dateTime.optional(),
  limit: z.number().int().min(1).max(20).default(10),
  language
});

export const disruptionsInputSchema = z.strictObject({
  station: stationQuery.optional().describe('Omit for national disruptions; a station notice does not establish route impact.'),
  isActive: z.boolean().optional().describe('Omit to include planned works. True filters to active notices; false to inactive notices.'),
  language
});

const time = z.iso.datetime({ offset: true }).nullable();
const text = z.string().nullable();
export const stationSchema = z.object({ code: z.string(), name: z.string(), aliases: z.array(z.string()) });
export const legSchema = z.object({
  origin: z.string(), destination: z.string(), mode: z.string(), product: text,
  plannedDeparture: time, actualDeparture: time, plannedArrival: time, actualArrival: time,
  plannedDeparturePlatform: text, actualDeparturePlatform: text,
  plannedArrivalPlatform: text, actualArrivalPlatform: text,
  cancelled: z.boolean().nullable()
});
export const journeySchema = z.object({
  id: text, durationMinutes: z.number().nonnegative().nullable(), transfers: z.number().int().nonnegative().nullable(),
  status: text, cancelled: z.boolean().nullable(), legs: z.array(legSchema).min(1), warnings: z.array(z.string())
});
export const departureSchema = z.object({
  destination: z.string(), product: text, plannedDeparture: time, actualDeparture: time,
  plannedPlatform: text, actualPlatform: text, cancelled: z.boolean().nullable(), warnings: z.array(z.string())
});
export const disruptionSchema = z.object({
  id: text, title: z.string(), type: text, isActive: z.boolean().nullable(),
  start: time, end: time, expectedEnd: time, description: text, advice: text
});

const clarificationSchema = z.object({
  field: z.enum(['from', 'to', 'station']), query: z.string(),
  reason: z.enum(['ambiguous', 'not_found']), candidates: z.array(stationSchema).max(5)
});
const resultBase = {
  status: z.enum(['ok', 'no_results', 'needs_clarification']),
  retrievedAt: z.iso.datetime(),
  clarification: clarificationSchema.nullable()
};

export const planOutputSchema = z.object({
  ...resultBase, from: stationSchema.nullable(), to: stationSchema.nullable(),
  arrivalDeadline: time, recommendedIndex: z.number().int().min(0).max(2).nullable(),
  journeys: z.array(journeySchema.extend({ meetsArrivalDeadline: z.boolean().nullable() })).max(3)
});
export const departuresOutputSchema = z.object({
  ...resultBase, station: stationSchema.nullable(), departures: z.array(departureSchema).max(20)
});
export const disruptionsOutputSchema = z.object({
  ...resultBase, scope: z.enum(['national', 'station']), station: stationSchema.nullable(),
  disruptions: z.array(disruptionSchema).max(20), truncated: z.boolean()
});

export type PlanInput = z.infer<typeof planInputSchema>;
export type DeparturesInput = z.infer<typeof departuresInputSchema>;
export type DisruptionsInput = z.infer<typeof disruptionsInputSchema>;
export type Station = z.infer<typeof stationSchema>;
export type Journey = z.infer<typeof journeySchema>;
export type Departure = z.infer<typeof departureSchema>;
export type Disruption = z.infer<typeof disruptionSchema>;
