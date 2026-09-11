import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { requestLogger } from './logging';
import { handleMcpRequest } from './mcp';
import type { AppBindings } from './types';

export function createApp(options: { exposeApiNearTools?: boolean } = {}) {
  const app = new Hono<AppBindings>();

  app.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'MCP-Protocol-Version', 'mcp-protocol-version', 'mcp-session-id', 'Last-Event-ID'],
      exposeHeaders: ['mcp-protocol-version', 'mcp-session-id']
    })
  );
  app.use('*', requestLogger());

  app.get('/health', (context) => {
    return context.json({
      status: 'ok',
      service: 'nederlandse-treinreisplanner-mcp',
      retrievedAt: new Date().toISOString()
    });
  });

  app.all('/mcp', (context) => handleMcpRequest(context, options.exposeApiNearTools ?? false));

  app.notFound((context) => context.json({ code: 'not_found', message: 'Unknown endpoint. Use /mcp for MCP clients.' }, 404));

  return app;
}
