import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { requestLogger } from './logging';
import { handleMcpRequest } from './mcp';
import { enforceRateLimit } from './rateLimiter';
import type { AppBindings } from './types';

export function createApp() {
  const app = new Hono<AppBindings>();
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'], allowHeaders: ['Content-Type', 'MCP-Protocol-Version', 'Mcp-Session-Id', 'Last-Event-ID'], exposeHeaders: ['MCP-Protocol-Version'] }));
  app.use('*', requestLogger());
  app.use('/mcp', bodyLimit({ maxSize: 16 * 1024, onError: context => context.json({ error: 'Request too large.' }, 413) }));
  app.get('/health', context => context.json({ status: 'ok', service: 'ns-reisplanner-mvp', scope: 'liveness' }));
  app.all('/mcp', async context => {
    const limited = await enforceRateLimit(context.req.raw, context.env);
    if (limited) return limited;
    const response = await handleMcpRequest(context.req.raw, context.env);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  });
  app.notFound(context => context.json({ error: 'Unknown endpoint. Use /mcp.' }, 404));
  app.onError((_error, context) => context.json({ error: 'Service unavailable.' }, 503));
  return app;
}
