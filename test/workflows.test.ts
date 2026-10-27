import { describe, expect, it, vi } from 'vitest';
import { createWorkflows } from '../src/workflows';
import { planInputSchema, departuresInputSchema, disruptionsInputSchema, type Journey, type Station } from '../src/schemas';

const stations: Station[] = [
  { code: 'UT', name: 'Utrecht Centraal', aliases: ['Utrecht'] },
  { code: 'UTO', name: 'Utrecht Overvecht', aliases: [] },
  { code: 'GD', name: 'Gouda', aliases: [] }
];
function journey(departure: string, arrival: string, cancelled = false): Journey {
  return { id: departure, durationMinutes: 30, transfers: 0, status: 'NORMAL', cancelled, warnings: [], legs: [{
    origin: 'Gouda', destination: 'Utrecht Centraal', mode: 'TRAIN', product: 'Intercity',
    plannedDeparture: departure, actualDeparture: null, plannedArrival: arrival, actualArrival: null,
    plannedDeparturePlatform: '3', actualDeparturePlatform: null, plannedArrivalPlatform: null, actualArrivalPlatform: null, cancelled
  }] };
}
function setup(journeys: Journey[] = []) {
  const client = { getStations: vi.fn().mockResolvedValue(stations), planJourney: vi.fn().mockResolvedValue(journeys), getDepartures: vi.fn().mockResolvedValue([]), getDisruptions: vi.fn().mockResolvedValue([]) };
  return { client, workflows: createWorkflows(client, () => new Date('2026-10-26T07:00:00Z')) };
}
describe('traveler workflows', () => {
  it('returns choices for an ambiguous city, even if one station has a matching alias', async () => {
    const { client, workflows } = setup();
    const result = await workflows.planJourney(planInputSchema.parse({ from: 'Gouda', to: 'Utrecht' }));
    expect(result.status).toBe('needs_clarification');
    expect(result.clarification).toMatchObject({ field: 'to', reason: 'ambiguous', candidates: stations.slice(0, 2) });
    expect(client.planJourney).not.toHaveBeenCalled();
  });
  it('resolves station codes and an unambiguous typo inside one tool call', async () => {
    const { client, workflows } = setup();
    const result = await workflows.planJourney(planInputSchema.parse({ from: 'gd', to: 'Utrcht Centraal' }));
    expect(result.status).toBe('no_results');
    expect(client.getStations).toHaveBeenCalledTimes(1);
    expect(client.planJourney).toHaveBeenCalledWith(expect.objectContaining({ from: 'GD', to: 'UT', dateTime: '2026-10-26T07:00:00.000Z' }));
  });
  it('omits already departed options when departure time is omitted and preserves eligible provider order', async () => {
    const { workflows } = setup([
      journey('2026-10-26T07:56:00+01:00', '2026-10-26T08:26:00+01:00'),
      journey('2026-10-26T08:12:00+01:00', '2026-10-26T08:42:00+01:00'),
      journey('2026-10-26T08:04:00+01:00', '2026-10-26T08:34:00+01:00')
    ]);
    const result = await workflows.planJourney(planInputSchema.parse({ from: 'GD', to: 'UT' }));
    expect(result.journeys.map(item => item.id)).toEqual(['2026-10-26T08:12:00+01:00', '2026-10-26T08:04:00+01:00']);
    expect(result.recommendedIndex).toBe(0);
  });
  it('uses actual departure before planned departure for eligibility without changing returned times', async () => {
    const delayed = journey('2026-10-26T07:56:00+01:00', '2026-10-26T08:26:00+01:00');
    delayed.legs[0].actualDeparture = '2026-10-26T08:03:00+01:00';
    const departed = journey('2026-10-26T08:01:00+01:00', '2026-10-26T08:31:00+01:00');
    departed.legs[0].actualDeparture = '2026-10-26T07:59:00+01:00';
    const { workflows } = setup([departed, delayed]);
    const result = await workflows.planJourney(planInputSchema.parse({ from: 'GD', to: 'UT' }));
    expect(result.journeys).toEqual([{ ...delayed, meetsArrivalDeadline: null }]);
    expect(result.recommendedIndex).toBe(0);
  });
  it('uses the explicit departure threshold and includes a departure exactly at that time', async () => {
    const { workflows } = setup([
      journey('2026-10-26T09:59:00+01:00', '2026-10-26T10:29:00+01:00'),
      journey('2026-10-26T10:00:00+01:00', '2026-10-26T10:30:00+01:00')
    ]);
    const result = await workflows.planJourney(planInputSchema.parse({ from: 'GD', to: 'UT', dateTime: '2026-10-26T10:00:00+01:00' }));
    expect(result.journeys.map(item => item.id)).toEqual(['2026-10-26T10:00:00+01:00']);
    expect(result.recommendedIndex).toBe(0);
  });
  it('floors a past explicit departure request at the current server time', async () => {
    const { workflows } = setup([
      journey('2026-10-26T07:56:00+01:00', '2026-10-26T08:26:00+01:00'),
      journey('2026-10-26T08:01:00+01:00', '2026-10-26T08:31:00+01:00')
    ]);
    const result = await workflows.planJourney(planInputSchema.parse({ from: 'GD', to: 'UT', dateTime: '2026-10-26T07:50:00+01:00' }));
    expect(result.journeys.map(item => item.id)).toEqual(['2026-10-26T08:01:00+01:00']);
    expect(result.recommendedIndex).toBe(0);
  });
  it('applies the three-option cap after discarding past departures', async () => {
    const { workflows } = setup([
      journey('2026-10-26T07:40:00+01:00', '2026-10-26T08:10:00+01:00'),
      journey('2026-10-26T07:45:00+01:00', '2026-10-26T08:15:00+01:00'),
      journey('2026-10-26T07:50:00+01:00', '2026-10-26T08:20:00+01:00'),
      journey('2026-10-26T08:01:00+01:00', '2026-10-26T08:31:00+01:00'),
      journey('2026-10-26T08:02:00+01:00', '2026-10-26T08:32:00+01:00'),
      journey('2026-10-26T08:03:00+01:00', '2026-10-26T08:33:00+01:00'),
      journey('2026-10-26T08:04:00+01:00', '2026-10-26T08:34:00+01:00')
    ]);
    const result = await workflows.planJourney(planInputSchema.parse({ from: 'GD', to: 'UT' }));
    expect(result.journeys.map(item => item.id)).toEqual(['2026-10-26T08:01:00+01:00', '2026-10-26T08:02:00+01:00', '2026-10-26T08:03:00+01:00']);
    expect(result.recommendedIndex).toBe(0);
  });
  it('returns no results when every known departure has passed', async () => {
    const { workflows } = setup([journey('2026-10-26T07:59:00+01:00', '2026-10-26T08:29:00+01:00')]);
    const result = await workflows.planJourney(planInputSchema.parse({ from: 'GD', to: 'UT' }));
    expect(result).toMatchObject({ status: 'no_results', journeys: [], recommendedIndex: null });
  });
  it('excludes already departed options from arrival-deadline results', async () => {
    const { workflows } = setup([journey('2026-10-26T07:59:00+01:00', '2026-10-26T08:29:00+01:00')]);
    const result = await workflows.planJourney(planInputSchema.parse({ from: 'GD', to: 'UT', searchForArrival: true, dateTime: '2026-10-26T09:00:00+01:00' }));
    expect(result).toMatchObject({ status: 'no_results', journeys: [], recommendedIndex: null });
  });
  it.each([false, true])('preserves unknown departure facts without recommending unknown or cancelled options (arrival search: %s)', async searchForArrival => {
    const unknown = journey('2026-10-26T08:01:00+01:00', '2026-10-26T08:31:00+01:00');
    unknown.legs[0].plannedDeparture = null;
    const cancelled = journey('2026-10-26T08:02:00+01:00', '2026-10-26T08:32:00+01:00', true);
    const { workflows } = setup([unknown, cancelled]);
    const result = await workflows.planJourney(planInputSchema.parse({ from: 'GD', to: 'UT', searchForArrival, ...(searchForArrival ? { dateTime: '2026-10-26T09:00:00+01:00' } : {}) }));
    expect(result.journeys).toHaveLength(2);
    expect(result.journeys[0].legs[0]).toMatchObject({ plannedDeparture: null, actualDeparture: null });
    expect(result.recommendedIndex).toBeNull();
  });
  it('selects the latest returned feasible departure and rejects delayed or cancelled options for a deadline', async () => {
    const options = [journey('2026-10-26T08:00:00+01:00', '2026-10-26T08:30:00+01:00'), journey('2026-10-26T08:20:00+01:00', '2026-10-26T08:50:00+01:00'), journey('2026-10-26T08:25:00+01:00', '2026-10-26T08:55:00+01:00')];
    options[2].legs[0].actualArrival = '2026-10-26T09:05:00+01:00';
    const { workflows } = setup(options);
    const result = await workflows.planJourney(planInputSchema.parse({ from: 'GD', to: 'UT', searchForArrival: true, dateTime: '2026-10-26T09:00:00+01:00' }));
    expect(result.recommendedIndex).toBe(1);
    expect(result.journeys.map(item => item.meetsArrivalDeadline)).toEqual([true, true, false]);
  });
  it('does not recommend any option when all miss a deadline or are cancelled', async () => {
    const { workflows } = setup([journey('2026-10-26T08:00:00+01:00', '2026-10-26T09:05:00+01:00'), journey('2026-10-26T08:00:00+01:00', '2026-10-26T08:45:00+01:00', true)]);
    const result = await workflows.planJourney(planInputSchema.parse({ from: 'GD', to: 'UT', searchForArrival: true, dateTime: '2026-10-26T09:00:00+01:00' }));
    expect(result.recommendedIndex).toBeNull();
  });
  it('keeps national scope distinct and marks truncation without discarding planned work', async () => {
    const { client, workflows } = setup();
    const notice = { id: 'x', title: 'Future work', type: 'MAINTENANCE', isActive: false, start: null, end: null, expectedEnd: null, description: null, advice: null };
    client.getDisruptions.mockResolvedValue(Array.from({ length: 21 }, () => notice));
    const result = await workflows.getDisruptions(disruptionsInputSchema.parse({}));
    expect(result).toMatchObject({ status: 'ok', scope: 'national', truncated: true });
    expect(result.disruptions).toHaveLength(20);
    expect(client.getStations).not.toHaveBeenCalled();
  });
  it('does not reinterpret an upstream error as no departures', async () => {
    const { client, workflows } = setup();
    client.getDepartures.mockRejectedValue(new Error('upstream unavailable'));
    await expect(workflows.getDepartures(departuresInputSchema.parse({ station: 'GD' }))).rejects.toThrow('upstream unavailable');
  });
});
