import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getNsApiBaseUrl } from './config';
import { NsClient, NsApiError } from './nsClient';
import { createWorkflows, type TravelProvider } from './workflows';
import { planInputSchema, departuresInputSchema, disruptionsInputSchema, planOutputSchema, departuresOutputSchema, disruptionsOutputSchema } from './schemas';
import type { Env } from './types';

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const instructions = 'Use these read-only tools for current Dutch station-to-station train journeys, departures and NS disruptions. Resolve missing endpoints and ambiguous station choices with the user. For arrival deadlines use searchForArrival with an offset-aware dateTime and check meetsArrivalDeadline; never claim feasibility if none qualifies. Preserve all returned transport legs and planned/actual distinctions. Only use returned travel facts. Errors and empty results do not establish no service or no disruptions. This server has no booking, pricing, previous-train status, UI or monitoring capability.';

export async function handleMcpRequest(request: Request, env: Env): Promise<Response> {
  const server = createServer(env);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    // JSON response mode completes each request before cleanup; no open SSE
    // stream or transport is shared between Worker invocations.
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}

function createServer(env: Env): McpServer {
  const server = new McpServer({ name: 'ns-reisplanner-mvp', version: '0.1.0' }, { instructions });
  server.registerTool('plan_journey', {
    title: 'Plan a Dutch train journey',
    description: 'Plan current train journeys between Dutch stations, including arrival deadlines, accessible planning, transfers, platforms and returned route warnings. Accept station names, codes or clear typos; ambiguous names return choices. Use for new travel advice, including questions that do not mention NS. Does not recheck a previously selected train.',
    inputSchema: planInputSchema, outputSchema: planOutputSchema, annotations
  }, input => execute(env, 'plan_journey', client => createWorkflows(client).planJourney(input)));
  server.registerTool('get_departures', {
    title: 'Get NS station departures',
    description: 'Get the current departure board for a Dutch station, with planned and actual times, platforms and cancellations. Accepts a station name or code and resolves it internally. Use for trains leaving a station; use plan_journey for travel between two stations.',
    inputSchema: departuresInputSchema, outputSchema: departuresOutputSchema, annotations
  }, input => execute(env, 'get_departures', client => createWorkflows(client).getDepartures(input)));
  server.registerTool('get_disruptions', {
    title: 'Check NS disruptions and planned work',
    description: 'Get national NS disruptions and planned railway works, or notices for a named station. Omit station for the national overview. Includes future work by default. National or station notices do not establish impact on a specific route; use plan_journey for current route advice.',
    inputSchema: disruptionsInputSchema, outputSchema: disruptionsOutputSchema, annotations
  }, input => execute(env, 'get_disruptions', client => createWorkflows(client).getDisruptions(input)));
  return server;
}

async function execute(env: Env, operation: string, action: (client: TravelProvider) => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  const startedAt = Date.now();
  let outcome = 'error';
  try {
    if (!env.NS_API_KEY?.trim()) return failure('not_configured', 'NS access is not configured on this server.');
    const client = new NsClient({ apiKey: env.NS_API_KEY, baseUrl: getNsApiBaseUrl(env) });
    const result = await action(client);
    outcome = String(result.status);
    return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) {
    if (error instanceof NsApiError) return failure(error.code, error.message);
    return failure('unavailable', 'Travel information could not be retrieved or validated. Try again later.');
  } finally {
    if (env.LOG_LEVEL !== 'error') console.log(JSON.stringify({ operation, outcome, durationMs: Date.now() - startedAt }));
  }
}

function failure(code: string, message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: `${code}: ${message}` }] };
}
