import { z } from 'zod/v4';
import { getMcpRateLimitPerMinute } from './config';
import type { Env } from './types';

const WINDOW_MS = 60_000;
const decisionSchema = z.object({ allowed: z.boolean(), retryAfterSeconds: z.number().int().min(1).max(60).optional() });
const probeSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number(), z.null()]).optional(), method: z.string() });

export async function enforceRateLimit(request: Request, env: Env): Promise<Response | null> {
  if (request.method !== 'POST') return null;
  const probe = probeSchema.safeParse(await request.clone().json().catch(() => null));
  if (!probe.success || probe.data.method !== 'tools/call') return null;
  if (!env.MCP_RATE_LIMITER) return Response.json({ error: 'Rate limiter is not configured.' }, { status: 503 });
  // Cloudflare supplies this header. Forwarded headers from clients are not
  // used; missing IPs share one conservative bucket (including local smoke).
  const clientKey = request.headers.get('CF-Connecting-IP') ?? 'unknown-client';
  try {
    const stub = env.MCP_RATE_LIMITER.get(env.MCP_RATE_LIMITER.idFromName(clientKey));
    const response = await stub.fetch('https://limiter/check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: getMcpRateLimitPerMinute(env) })
    });
    if (!response.ok) throw new Error('Limiter unavailable');
    const decision = decisionSchema.parse(await response.json());
    if (decision.allowed) return null;
    const retryAfter = decision.retryAfterSeconds ?? 60;
    return Response.json({ jsonrpc: '2.0', id: probe.data.id ?? null, error: { code: -32029, message: 'Rate limit exceeded. Try again later.' } }, { status: 429, headers: { 'Retry-After': String(retryAfter), 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ error: 'Rate limiter unavailable. Try again later.' }, { status: 503 });
  }
}

export class McpRateLimiter {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const input = z.object({ limit: z.number().int().min(1).max(1000) }).safeParse(await request.json().catch(() => null));
    if (!input.success) return Response.json({ error: 'Invalid limit.' }, { status: 400 });
    const now = Date.now();
    // Cloudflare input gates serialize this read-then-write sequence: there is
    // no external I/O between storage operations and no allowConcurrency flag.
    const current = await this.state.storage.get<{ count: number; resetAt: number }>('current');
    if (!current || current.resetAt <= now) {
      await this.state.storage.put('current', { count: 1, resetAt: now + WINDOW_MS });
      return Response.json({ allowed: true });
    }
    if (current.count >= input.data.limit) return Response.json({ allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) });
    await this.state.storage.put('current', { ...current, count: current.count + 1 });
    return Response.json({ allowed: true });
  }
}
