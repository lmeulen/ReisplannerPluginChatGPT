import type { MiddlewareHandler } from 'hono';
import type { AppBindings } from './types';

export function requestLogger(): MiddlewareHandler<AppBindings> {
  return async (context, next) => {
    const requestId = crypto.randomUUID();
    context.set('requestId', requestId);
    const startedAt = Date.now();
    await next();
    if (context.env?.LOG_LEVEL === 'debug') console.log(JSON.stringify({
      requestId, route: ['/mcp', '/health'].includes(context.req.path) ? context.req.path : 'other',
      method: context.req.method, status: context.res.status, durationMs: Date.now() - startedAt
    }));
  };
}
