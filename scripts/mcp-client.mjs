import { isIP } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const TOOL_NAMES = ['plan_journey', 'get_departures', 'get_disruptions'];
export const MCP_REQUEST_TIMEOUT_MS = 15_000;

const workflowFields = {
  plan_journey: { inputs: ['from', 'to', 'dateTime', 'searchForArrival', 'accessible', 'language'], required: ['from', 'to'], outputs: ['status', 'retrievedAt', 'clarification', 'from', 'to', 'arrivalDeadline', 'recommendedIndex', 'journeys'] },
  get_departures: { inputs: ['station', 'dateTime', 'limit', 'language'], required: ['station'], outputs: ['status', 'retrievedAt', 'clarification', 'station', 'departures'] },
  get_disruptions: { inputs: ['station', 'isActive', 'language'], required: [], outputs: ['status', 'retrievedAt', 'clarification', 'scope', 'station', 'disruptions', 'truncated'] }
};

function hostIsPrivate(host) {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (['localhost', '::1', '::'].includes(normalized) || normalized.endsWith('.localhost') ||
      normalized.endsWith('.local') || normalized.endsWith('.internal') || normalized.endsWith('.test')) return true;
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    const [a, b] = normalized.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return ipVersion === 6 && (/^(?:fc|fd|fe[89ab])/.test(normalized) || normalized.startsWith('::ffff:'));
}

function parseUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() !== raw || !raw) throw new TypeError('Supply a nonblank absolute URL.');
  let url;
  try { url = new URL(raw); } catch { throw new TypeError('Supply a nonblank absolute URL.'); }
  if (url.username || url.password || url.search || url.hash) throw new TypeError('URL must not contain credentials, query, or fragment.');
  return url;
}

export function validateServerUrl(raw) {
  const url = parseUrl(raw);
  if (url.protocol !== 'https:') throw new TypeError('Package server URL must use HTTPS.');
  if (hostIsPrivate(url.hostname)) throw new TypeError('Package server URL must use a public host, not a local address.');
  return url;
}

export function validateLocalSmokeUrl(raw) {
  const url = parseUrl(raw);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isLoopback = host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
  if (url.protocol !== 'http:' || !isLoopback) throw new TypeError('Smoke checks are limited to localhost HTTP endpoints.');
  return url;
}

function typeIs(schema, type) {
  return schema?.type === type || (Array.isArray(schema?.type) && schema.type.includes(type));
}

export function validateToolCatalog(tools) {
  const errors = [];
  if (!Array.isArray(tools)) return ['MCP server did not return a tool catalog.'];
  const names = tools.map(tool => tool?.name).sort();
  if (JSON.stringify(names) !== JSON.stringify([...TOOL_NAMES].sort())) {
    errors.push(`MCP tool catalog must contain exactly ${TOOL_NAMES.join(', ')}.`);
  }

  for (const [name, contract] of Object.entries(workflowFields)) {
    const tool = tools.find(candidate => candidate?.name === name);
    if (!tool) continue;
    if (typeof tool.description !== 'string' || !tool.description.trim()) errors.push(`${name} needs a nonblank description.`);
    if (tool.annotations?.readOnlyHint !== true || tool.annotations?.destructiveHint !== false) errors.push(`${name} must be annotated read-only and non-destructive.`);
    if (tool.icons || tool.ui || tool._meta?.ui || tool._meta?.['ui/resourceUri']) errors.push(`${name} must not declare a UI or icon binding.`);

    const input = tool.inputSchema;
    const output = tool.outputSchema;
    if (input?.type !== 'object' || !input.properties) errors.push(`${name} inputSchema must be an object with properties.`);
    else {
      for (const field of contract.inputs) {
        if (!input.properties[field] || typeof input.properties[field] !== 'object') errors.push(`${name} inputSchema is missing ${field}.`);
      }
      const required = Array.isArray(input.required) ? input.required : [];
      for (const field of contract.required) {
        if (!required.includes(field)) errors.push(`${name} inputSchema must require ${field}.`);
      }
      for (const field of ['from', 'to', 'station']) {
        if (field in input.properties && !typeIs(input.properties[field], 'string')) errors.push(`${name} inputSchema.${field} must be a station string.`);
      }
      if (contract.inputs.includes('dateTime') && (!typeIs(input.properties.dateTime, 'string') || input.properties.dateTime.format !== 'date-time')) {
        errors.push(`${name} inputSchema.dateTime must be an offset-aware date-time string.`);
      }
      for (const field of ['searchForArrival', 'accessible', 'isActive']) {
        if (field in input.properties && !typeIs(input.properties[field], 'boolean')) errors.push(`${name} inputSchema.${field} must be boolean.`);
      }
      if (input.properties.language && (!typeIs(input.properties.language, 'string') || !['nl', 'en'].every(value => input.properties.language.enum?.includes(value)))) {
        errors.push(`${name} inputSchema.language must support nl and en.`);
      }
      if (name === 'get_departures' && (!typeIs(input.properties.limit, 'integer') || input.properties.limit.minimum !== 1 || input.properties.limit.maximum !== 20)) {
        errors.push('get_departures inputSchema.limit must be an integer bounded from 1 through 20.');
      }
    }
    if (output?.type !== 'object' || !output.properties) errors.push(`${name} outputSchema must be an object with properties.`);
    else {
      for (const field of contract.outputs) {
        if (!(field in output.properties)) errors.push(`${name} outputSchema is missing ${field}.`);
      }
      if (!typeIs(output.properties.status, 'string') || !typeIs(output.properties.retrievedAt, 'string')) {
        errors.push(`${name} outputSchema must expose status and retrievedAt strings.`);
      }
      if (contract.outputs.includes('journeys') && !typeIs(output.properties.journeys, 'array')) errors.push('plan_journey outputSchema.journeys must be an array.');
      if (contract.outputs.includes('departures') && !typeIs(output.properties.departures, 'array')) errors.push('get_departures outputSchema.departures must be an array.');
      if (contract.outputs.includes('disruptions') && !typeIs(output.properties.disruptions, 'array')) errors.push('get_disruptions outputSchema.disruptions must be an array.');
    }
  }
  return errors;
}

export function createMcpClient(options = {}) {
  return new Client({ name: options.name ?? 'ns-reisplanner-mvp-verifier', version: options.version ?? '1.0.0' }, { capabilities: {} });
}

export function createStreamableHttpTransport(url, timeoutMs = MCP_REQUEST_TIMEOUT_MS) {
  const timedFetch = (input, init = {}) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetch(input, { ...init, signal });
  };
  return new StreamableHTTPClientTransport(url instanceof URL ? url : new URL(url), { fetch: timedFetch });
}

export function validateServerIdentity(serverInfo, version) {
  if (serverInfo?.name !== 'ns-reisplanner-mvp' || serverInfo?.version !== version) {
    throw new Error('MCP server identity must match ns-reisplanner-mvp and the package version.');
  }
}

export async function assertNoUiResources(client) {
  const capabilities = client.getServerCapabilities?.() ?? {};
  if (capabilities.experimental?.['io.modelcontextprotocol/ui']) throw new Error('MCP server declares UI capabilities; this plugin is text-only.');
  if (!capabilities.resources) return;
  const [resources, templates] = await Promise.all([client.listResources(), client.listResourceTemplates()]);
  if ((resources.resources?.length ?? 0) || (templates.resourceTemplates?.length ?? 0)) {
    throw new Error('MCP server exposes resources or resource templates; this plugin is text-only.');
  }
}
