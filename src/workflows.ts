import {
  planOutputSchema, departuresOutputSchema, disruptionsOutputSchema,
  type PlanInput, type DeparturesInput, type DisruptionsInput,
  type Station, type Journey, type Departure, type Disruption
} from './schemas';

export interface TravelProvider {
  getStations(): Promise<Station[]>;
  planJourney(input: PlanInput): Promise<Journey[]>;
  getDepartures(input: DeparturesInput): Promise<Departure[]>;
  getDisruptions(input: DisruptionsInput): Promise<Disruption[]>;
}

export function createWorkflows(client: TravelProvider, now = () => new Date()) {
  return {
    async planJourney(input: PlanInput) {
      const stations = await client.getStations();
      const from = resolve(stations, input.from, 'from');
      const to = resolve(stations, input.to, 'to');
      const base = {
        retrievedAt: now().toISOString(), from: from.station, to: to.station,
        arrivalDeadline: input.searchForArrival ? input.dateTime ?? null : null,
        clarification: from.clarification ?? to.clarification,
        recommendedIndex: null, journeys: []
      };
      if (!from.station || !to.station) return planOutputSchema.parse({ ...base, status: 'needs_clarification' });
      const searchTime = now().toISOString();
      const earliestDeparture = Math.max(Date.parse(searchTime), Date.parse(input.searchForArrival ? searchTime : input.dateTime ?? searchTime));
      const journeys = (await client.planJourney({ ...input, from: from.station.code, to: to.station.code, dateTime: input.dateTime ?? searchTime }))
        .filter(journey => {
          const departure = departureTime(journey);
          return departure === null || departure >= earliestDeparture;
        })
        .slice(0, 3).map(journey => ({ ...journey, meetsArrivalDeadline: input.searchForArrival ? meetsDeadline(journey, input.dateTime!) : null }));
      let recommendedIndex: number | null = null;
      if (input.searchForArrival) {
        let latestDeparture = -Infinity;
        journeys.forEach((journey, index) => {
          const departure = departureTime(journey);
          if (journey.meetsArrivalDeadline && departure !== null && departure > latestDeparture) { recommendedIndex = index; latestDeparture = departure; }
        });
      } else {
        const first = journeys.findIndex(journey => isUsable(journey) && departureTime(journey) !== null);
        if (first !== -1) recommendedIndex = first;
      }
      return planOutputSchema.parse({ ...base, retrievedAt: now().toISOString(), status: journeys.length ? 'ok' : 'no_results', journeys, recommendedIndex });
    },

    async getDepartures(input: DeparturesInput) {
      const resolved = resolve(await client.getStations(), input.station, 'station');
      const base = { retrievedAt: now().toISOString(), station: resolved.station, clarification: resolved.clarification, departures: [] };
      if (!resolved.station) return departuresOutputSchema.parse({ ...base, status: 'needs_clarification' });
      const departures = (await client.getDepartures({ ...input, station: resolved.station.code, dateTime: input.dateTime ?? now().toISOString() })).slice(0, input.limit);
      return departuresOutputSchema.parse({ ...base, retrievedAt: now().toISOString(), status: departures.length ? 'ok' : 'no_results', departures });
    },

    async getDisruptions(input: DisruptionsInput) {
      const resolved = input.station ? resolve(await client.getStations(), input.station, 'station') : null;
      const base = { retrievedAt: now().toISOString(), scope: input.station ? 'station' : 'national', station: resolved?.station ?? null, clarification: resolved?.clarification ?? null, disruptions: [], truncated: false };
      if (resolved && !resolved.station) return disruptionsOutputSchema.parse({ ...base, status: 'needs_clarification' });
      const notices = await client.getDisruptions({ ...input, station: resolved?.station?.code });
      const filtered = input.isActive === undefined ? notices : notices.filter(notice => notice.isActive === input.isActive);
      return disruptionsOutputSchema.parse({ ...base, retrievedAt: now().toISOString(), status: filtered.length ? 'ok' : 'no_results', disruptions: filtered.slice(0, 20), truncated: filtered.length > 20 });
    }
  };
}

function departureTime(journey: Journey): number | null {
  const first = journey.legs[0];
  const departure = first?.actualDeparture ?? first?.plannedDeparture;
  return departure ? Date.parse(departure) : null;
}

function isUsable(journey: Journey): boolean {
  return journey.cancelled !== true && !journey.legs.some(leg => leg.cancelled === true) && !/CANCEL|NOT_POSSIBLE|INVALID/i.test(journey.status ?? '');
}

function meetsDeadline(journey: Journey, deadline: string): boolean | null {
  if (!isUsable(journey)) return false;
  const last = journey.legs.at(-1);
  const arrival = last?.actualArrival ?? last?.plannedArrival;
  return arrival ? Date.parse(arrival) <= Date.parse(deadline) : null;
}

type Clarification = { field: 'from' | 'to' | 'station'; query: string; reason: 'ambiguous' | 'not_found'; candidates: Station[] };
function resolve(stations: Station[], query: string, field: Clarification['field']): { station: Station | null; clarification: Clarification | null } {
  const needle = normalize(query);
  const exact = stations.filter(station => normalize(station.code) === needle || normalize(station.name) === needle);
  if (exact.length === 1) return { station: exact[0], clarification: null };
  const containing = stations.filter(station => [station.name, ...station.aliases].some(term => normalize(term).includes(needle)));
  if (containing.length === 1) return { station: containing[0], clarification: null };
  let candidates = exact.length ? exact : containing;
  if (!candidates.length && needle.length >= 4) {
    const scored = stations.map(station => ({ station, distance: Math.min(...[station.name, ...station.aliases].map(term => editDistance(needle, normalize(term)))) }));
    const best = Math.min(...scored.map(item => item.distance));
    if (best <= Math.min(2, Math.floor(needle.length / 5))) candidates = scored.filter(item => item.distance === best).map(item => item.station);
    if (candidates.length === 1) return { station: candidates[0], clarification: null };
  }
  return { station: null, clarification: { field, query, reason: candidates.length ? 'ambiguous' : 'not_found', candidates: candidates.slice(0, 5) } };
}

function normalize(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('nl-NL').replace(/[^a-z0-9]/g, '');
}

function editDistance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let previous = row[0]; row[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (left[i - 1] === right[j - 1] ? 0 : 1));
      previous = above;
    }
  }
  return row[right.length];
}
