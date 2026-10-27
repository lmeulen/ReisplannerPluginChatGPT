import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server';
import type { Env } from '../src/types';

const limiter = { idFromName: vi.fn(), newUniqueId: vi.fn(), idFromString: vi.fn(), getByName: vi.fn(), jurisdiction: vi.fn(), get: vi.fn().mockReturnValue({ fetch: async () => Response.json({ allowed: true }) }) };
const env: Env = { NS_API_KEY: 'test-secret', NS_API_BASE_URL: 'https://ns.test/api', LOG_LEVEL: 'error', MCP_RATE_LIMITER: limiter };
const stations = [{ code: 'GD', namen: { lang: 'Gouda' } }];
function request(method: string, params?: object, id: string | number = 1) {
  return { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) };
}
async function rpc(method: string, params?: object, bindings = env) {
  const response = await createApp().request('/mcp', request(method, params), bindings);
  const text = await response.text();
  const json = JSON.parse(text.startsWith('event:') ? text.split('\n').find(line => line.startsWith('data: '))!.slice(6) : text);
  return { response, json };
}
afterEach(() => vi.restoreAllMocks());

describe('text-only MVP MCP endpoint', () => {
  it('publishes liveness without claiming upstream health', async () => {
    const response = await createApp().request('/health', {}, {});
    expect(await response.json()).toMatchObject({ status: 'ok', service: 'ns-reisplanner-mvp', scope: 'liveness' });
  });
  it('initializes without credentials and advertises no UI resources', async () => {
    const { json } = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }, {});
    expect(json.result.serverInfo).toEqual({ name: 'ns-reisplanner-mvp', version: '0.1.0' });
    expect(json.result.capabilities.resources).toBeUndefined();
    expect(json.result.instructions).toContain('arrival');
  });
  it('exposes exactly three distinct, read-only schema-validated tools without a secret', async () => {
    const { json } = await rpc('tools/list', {}, {});
    expect(json.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['plan_journey', 'get_departures', 'get_disruptions']);
    for (const tool of json.result.tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.outputSchema.type).toBe('object');
      expect(tool._meta).toBeUndefined();
    }
  });
  it('rejects missing inputs and offset-free time before upstream I/O', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const args of [{ to: 'Gouda' }, { from: 'GD', to: 'GD', dateTime: '2026-10-26T09:00:00' }, { from: 'GD', to: 'GD', searchForArrival: true }]) {
      const { json } = await rpc('tools/call', { name: 'plan_journey', arguments: args });
      expect(json.result?.isError ?? Boolean(json.error)).toBe(true);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('reports missing NS configuration safely', async () => {
    const { json } = await rpc('tools/call', { name: 'get_disruptions', arguments: {} }, { ...env, NS_API_KEY: undefined });
    expect(json.result.isError).toBe(true);
    expect(JSON.stringify(json)).toContain('not configured');
    expect(JSON.stringify(json)).not.toContain('test-secret');
  });
  it('performs one complete departures workflow using natural station input', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async resource => {
      const url = String(resource);
      return Response.json(url.includes('/stations') ? { payload: stations } : { payload: { departures: [{ direction: 'Rotterdam Centraal', product: { categoryName: 'Intercity' }, plannedDateTime: '2026-10-26T09:00:00+01:00', actualDateTime: '2026-10-26T09:05:00+01:00', plannedTrack: '3', actualTrack: '5', cancelled: false }] } });
    });
    const { json } = await rpc('tools/call', { name: 'get_departures', arguments: { station: 'Gouda' } });
    expect(json.result.isError).not.toBe(true);
    expect(json.result.structuredContent).toMatchObject({ status: 'ok', station: { code: 'GD' }, departures: [{ actualPlatform: '5', plannedPlatform: '3' }] });
    expect(json.result.content[0].text).toContain('Rotterdam Centraal');
  });
  it('distinguishes a valid empty response from a malformed upstream response', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ payload: [] }));
    expect((await rpc('tools/call', { name: 'get_disruptions', arguments: {} })).json.result.structuredContent.status).toBe('no_results');
    fetcher.mockResolvedValue(Response.json({ message: 'provider schema changed' }));
    const { json } = await rpc('tools/call', { name: 'get_disruptions', arguments: {} });
    expect(json.result.isError).toBe(true);
    expect(json.result.structuredContent).toBeUndefined();
  });
  it('keeps credentials scoped to concurrent requests', async () => {
    const keys: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_resource, init) => {
      keys.push(new Headers(init?.headers).get('Ocp-Apim-Subscription-Key') ?? '');
      return Response.json([]);
    });
    await Promise.all(['first', 'second'].map(key => rpc('tools/call', { name: 'get_disruptions', arguments: {} }, { ...env, NS_API_KEY: key })));
    expect(keys.sort()).toEqual(['first', 'second']);
  });
  it('honors durable rate limiting without contacting NS', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const blocked: Env = { ...env, MCP_RATE_LIMITER: { ...limiter, get: vi.fn().mockReturnValue({ fetch: async () => Response.json({ allowed: false, retryAfterSeconds: 17 }) }) } };
    const { response, json } = await rpc('tools/call', { name: 'get_disruptions', arguments: {} }, blocked);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('17');
    expect(json.error.code).toBe(-32029);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects oversized requests and retains only health/MCP routes', async () => {
    const app = createApp();
    expect((await app.request('/mcp', request('tools/call', { large: 'x'.repeat(20_000) }), env)).status).toBe(413);
    expect((await app.request('/stations/search')).status).toBe(404);
  });
});
