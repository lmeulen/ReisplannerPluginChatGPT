import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import {
  createMcpClient,
  createStreamableHttpTransport,
  validateServerIdentity,
  validateToolCatalog
} from '../scripts/mcp-client.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workerBundle = resolve(repoRoot, 'dist/worker/index.js');
const fixturePath = resolve(repoRoot, 'test/fixtures/ns-runtime.json');

function amsterdamDate(daysFromToday) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const calendarDate = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const date = new Date(Date.UTC(
    Number(calendarDate.year),
    Number(calendarDate.month) - 1,
    Number(calendarDate.day) + daysFromToday
  ));
  return date.toISOString().slice(0, 10);
}

const journeyDay = amsterdamDate(1);
const plannedWorkDay = amsterdamDate(2);

assert.ok(
  existsSync(workerBundle),
  'Build dist/worker/index.js first with npm run deploy:dry-run.'
);
const fixtures = JSON.parse(await readFile(fixturePath, 'utf8'), (_key, value) => {
  if (typeof value !== 'string') return value;
  if (value.startsWith('2000-01-01T')) return `${journeyDay}${value.slice(10)}`;
  if (value.startsWith('2000-01-02T')) return `${plannedWorkDay}${value.slice(10)}`;
  return value;
});
const manifest = JSON.parse(await readFile(resolve(repoRoot, 'plugin/plugin.json'), 'utf8'));
const fixtureByPath = new Map([
  ['/api/v2/stations', fixtures.stations],
  ['/api/v3/trips', fixtures.trips],
  ['/api/v2/departures', fixtures.departures],
  ['/api/v3/disruptions', fixtures.disruptions]
]);
const unexpectedOutboundPaths = [];
let outboundRequests = 0;

const miniflare = new Miniflare(convertV4MiniflareOptions({
  modules: true,
  scriptPath: workerBundle,
  compatibilityDate: '2026-10-26',
  compatibilityFlags: ['nodejs_compat'],
  bindings: {
    NS_API_KEY: 'fictional-fixture-key',
    NS_API_BASE_URL: 'https://ns-fixture.example/api',
    LOG_LEVEL: 'error',
    MCP_RATE_LIMIT_PER_MINUTE: '5'
  },
  durableObjects: {
    MCP_RATE_LIMITER: { className: 'McpRateLimiter', useSQLite: true }
  },
  outboundService: async request => {
    outboundRequests += 1;
    const path = new URL(request.url).pathname;
    const fixture = fixtureByPath.get(path);
    if (fixture === undefined) {
      unexpectedOutboundPaths.push(path);
      return Response.json({ error: 'No fictional fixture registered.' }, { status: 404 });
    }
    return Response.json(fixture);
  }
}));

let client;
try {
  const baseUrl = await miniflare.ready;
  const health = await fetch(new URL('/health', baseUrl));
  assert.equal(health.status, 200, 'Worker health route should respond.');

  client = createMcpClient({ name: 'fictional-worker-runtime-test' });
  await client.connect(createStreamableHttpTransport(new URL('/mcp', baseUrl)));
  validateServerIdentity(client.getServerVersion(), manifest.version);

  const catalog = await client.listTools();
  assert.deepEqual(validateToolCatalog(catalog.tools), [], 'SDK tool catalog should match the three-tool contract.');

  async function callTool(name, args) {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, `${name} should succeed: ${JSON.stringify(result)}`);
    assert.ok(result.structuredContent, `${name} should return structured content.`);
    assert.equal(result.structuredContent.status, 'ok');
    assert.ok(Number.isFinite(Date.parse(result.structuredContent.retrievedAt)), `${name} should preserve retrievedAt.`);
    return result.structuredContent;
  }

  const journeyResult = await callTool('plan_journey', {
    from: 'Gouda',
    to: 'Utrecht Centraal',
    dateTime: `${journeyDay}T18:00:00+01:00`,
    searchForArrival: true
  });
  const journey = journeyResult.journeys[0];
  assert.deepEqual(journey.legs.map(leg => leg.mode), ['TRAIN', 'WALK', 'BUS']);
  assert.equal(journey.legs[0].plannedDeparture, `${journeyDay}T17:00:00+01:00`);
  assert.equal(journey.legs[0].plannedDeparturePlatform, '3');
  assert.equal(journey.legs[1].actualDeparturePlatform, null, 'Unknown platform facts should remain null.');
  assert.ok(journey.warnings.includes('FICTIONAL replacement bus warning'));
  assert.equal(journey.meetsArrivalDeadline, true);

  const departuresResult = await callTool('get_departures', { station: 'Gouda' });
  assert.equal(departuresResult.departures[0].actualPlatform, '4');
  assert.equal(departuresResult.departures[0].actualDeparture, `${journeyDay}T17:05:00+01:00`);

  const disruptionsResult = await callTool('get_disruptions', {});
  const work = disruptionsResult.disruptions[0];
  assert.equal(work.title, 'FICTIONAL planned track work');
  assert.equal(work.isActive, false);
  assert.equal(work.start, `${plannedWorkDay}T08:00:00+01:00`);
  assert.equal(work.expectedEnd, `${plannedWorkDay}T10:00:00+01:00`);
  assert.ok(work.description.includes('FICTIONAL trains use another platform'));

  // The configured bound permits five tool calls; unknown tools use two slots.
  for (let index = 0; index < 2; index += 1) {
    try {
      await client.callTool({ name: 'fictional_unknown_tool', arguments: {} });
    } catch {
      // Unknown-tool protocol errors still pass through the rate limiter.
    }
  }

  const outboundBeforeLimit = outboundRequests;
  const limitedResponse = await fetch(new URL('/mcp', baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: { name: 'get_disruptions', arguments: {} }
    })
  });
  assert.equal(limitedResponse.status, 429, 'The next tool call should exceed the durable limit.');
  assert.ok(Number(limitedResponse.headers.get('Retry-After')) > 0, '429 should include Retry-After.');
  assert.equal(outboundRequests, outboundBeforeLimit, 'Rate-limited requests should not reach the provider fixture.');

  const catalogAfterLimit = await client.listTools();
  assert.deepEqual(validateToolCatalog(catalogAfterLimit.tools), [], 'Catalog discovery should remain available after 429.');
  assert.deepEqual(unexpectedOutboundPaths, [], 'Only registered fictional provider paths should be requested.');

  console.log(JSON.stringify({
    runtime: 'Miniflare workerd',
    providerData: 'fictional fixtures only',
    health: 'passed',
    sdkCatalog: 'passed',
    toolCalls: ['plan_journey', 'get_departures', 'get_disruptions'],
    durableRateLimitAndFreeCatalog: 'passed'
  }, null, 2));
} finally {
  try {
    if (client) await client.close();
  } finally {
    await miniflare.dispose();
  }
}
