import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertNoUiResources,
  createMcpClient,
  createStreamableHttpTransport,
  validateLocalSmokeUrl,
  validateToolCatalog
} from './mcp-client.mjs';

const supportedTools = new Set(['plan_journey', 'get_departures', 'get_disruptions']);
const secretKey = /(?:secret|password|token|credential|authorization|api[-_]?key)/i;

function rejectSecrets(value, location = 'arguments') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecrets(item, `${location}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (secretKey.test(key)) throw new TypeError(`Refusing secret-like tool argument field at ${location}.${key}.`);
      rejectSecrets(item, `${location}.${key}`);
    }
  }
}

export function parseSmokeArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (['--server-url', '--tool', '--args'].includes(key)) {
      if (parsed[key] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) {
        throw new TypeError(`${key} requires exactly one value and may appear only once.`);
      }
      parsed[key] = args[index + 1];
      index += 1;
    } else {
      throw new TypeError(`Unknown smoke option: ${key}`);
    }
  }
  if (!parsed['--server-url']) throw new TypeError('Supply an explicit --server-url localhost HTTP endpoint.');
  const serverUrl = validateLocalSmokeUrl(parsed['--server-url']);
  const hasTool = parsed['--tool'] !== undefined;
  const hasArgs = parsed['--args'] !== undefined;
  if (hasTool !== hasArgs) throw new TypeError('A tool call requires both --tool and explicit JSON --args.');

  let toolArguments;
  if (hasTool) {
    if (!supportedTools.has(parsed['--tool'])) throw new TypeError('Only the three supported read-only tools can be smoke-called.');
    try {
      toolArguments = JSON.parse(parsed['--args']);
    } catch {
      throw new TypeError('--args must be valid JSON.');
    }
    if (!toolArguments || typeof toolArguments !== 'object' || Array.isArray(toolArguments)) {
      throw new TypeError('--args must be a JSON object.');
    }
    rejectSecrets(toolArguments);
  }
  return { serverUrl, tool: parsed['--tool'], toolArguments };
}

/**
 * @param {{serverUrl: string | URL, tool?: string, toolArguments?: Record<string, unknown>, clientFactory?: (options: {name: string, version: string}) => any, transportFactory?: (url: URL) => any}} options
 */
export async function smokeMcp({ serverUrl, tool, toolArguments, clientFactory = createMcpClient, transportFactory = createStreamableHttpTransport } = {}) {
  const url = serverUrl instanceof URL ? validateLocalSmokeUrl(serverUrl.href) : validateLocalSmokeUrl(serverUrl);
  if ((tool === undefined) !== (toolArguments === undefined)) throw new TypeError('A tool call requires explicit arguments.');
  if (tool !== undefined && !supportedTools.has(tool)) throw new TypeError('Only the three supported read-only tools can be smoke-called.');
  if (toolArguments !== undefined) {
    if (!toolArguments || typeof toolArguments !== 'object' || Array.isArray(toolArguments)) throw new TypeError('Tool arguments must be a JSON object.');
    rejectSecrets(toolArguments);
  }

  const client = clientFactory({ name: 'ns-reisplanner-mvp-local-smoke', version: '1.0.0' });
  const transport = transportFactory(url);
  try {
    await client.connect(transport);
    const catalog = await client.listTools();
    const errors = validateToolCatalog(catalog.tools);
    if (errors.length) throw new Error(errors.join('\n'));
    await assertNoUiResources(client);
    if (tool === undefined) return { mode: 'inspect-only', tools: catalog.tools.map(item => item.name).sort() };

    const result = await client.callTool({ name: tool, arguments: toolArguments });
    if (result.isError === true) throw new Error(`${tool} returned an MCP error during the local smoke call.`);
    return {
      mode: 'read-only-tool-call',
      tool,
      isError: false,
      contentBlocks: Array.isArray(result.content) ? result.content.length : 0,
      hasStructuredContent: result.structuredContent !== undefined
    };
  } finally {
    try {
      await client.close();
    } catch {
      // A failed initialization may leave no active transport to close.
    }
  }
}

function isCliEntry() {
  return Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isCliEntry()) {
  if (process.argv.slice(2).some(arg => arg === '--help' || arg === '-h')) {
    console.log('Usage: node scripts/smoke-mcp.mjs --server-url http://127.0.0.1:8787/mcp');
    console.log('Inspect-only by default. Optional call: --tool get_departures --args \'{"station":"Utrecht Centraal"}\'');
  } else {
    try {
      const result = await smokeMcp(parseSmokeArgs(process.argv.slice(2)));
      console.log(JSON.stringify(result));
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Local MCP smoke check failed.');
      process.exitCode = 1;
    }
  }
}
