interface RateLimitState {
  count: number;
  resetAt: number;
}

const WINDOW_MS = 60_000;

export class McpRateLimiter {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    const body = await request.json().catch(() => null);
    const limit = readLimit(body);
    const now = Date.now();
    const current = await this.state.storage.get<RateLimitState>('current');

    if (!current || current.resetAt <= now) {
      await this.state.storage.put('current', { count: 1, resetAt: now + WINDOW_MS });
      return Response.json({ allowed: true });
    }

    if (current.count >= limit) {
      return Response.json({ allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) });
    }

    await this.state.storage.put('current', { count: current.count + 1, resetAt: current.resetAt });
    return Response.json({ allowed: true });
  }
}

function readLimit(value: unknown): number {
  if (typeof value === 'object' && value !== null && 'limit' in value) {
    const limit = Number(value.limit);
    if (Number.isFinite(limit) && limit > 0) {
      return Math.floor(limit);
    }
  }

  return 45;
}