import type { MiddlewareHandler, Next } from 'hono';

import type { AppBindings, AppContext } from './types';

/**
 * Logs technical request metadata only.
 *
 * MVP logging is intentionally useful for debugging, but it avoids full request
 * bodies, route parameters, API keys and raw NS responses. Keep that discipline
 * if this logger is expanded later.
 */
export function requestLogger(): MiddlewareHandler<AppBindings> {
  return async (context: AppContext, next: Next) => {
    const startedAt = Date.now();
    const requestId = crypto.randomUUID();
    context.set('requestId', requestId);

    await next();

    if (context.env.LOG_LEVEL === 'debug') {
      console.log(
        JSON.stringify({
          requestId,
          method: context.req.method,
          path: new URL(context.req.url).pathname,
          status: context.res.status,
          latencyMs: Date.now() - startedAt
        })
      );
    }
  };
}