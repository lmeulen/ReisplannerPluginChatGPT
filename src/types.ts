import type { Context } from 'hono';

// Wrangler generates non-secret bindings. The secret stays optional so discovery
// and liveness work before provisioning; tool calls check it explicitly.
export type Env = Partial<WorkerBindings> & { NS_API_KEY?: string };
export type AppBindings = { Bindings: Env; Variables: { requestId: string } };
export type AppContext = Context<AppBindings>;
