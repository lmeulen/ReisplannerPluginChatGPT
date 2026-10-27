import { afterEach, expect, it, vi } from 'vitest';
import { McpRateLimiter } from '../src/rateLimiter';

afterEach(() => vi.useRealTimers());
it('allows exactly the configured count and resets an expired durable window', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T08:00:00Z'));
  const storage = new Map<string, unknown>();
  const limiter = new McpRateLimiter({ storage: {
    get: async (key: string) => storage.get(key),
    put: async (key: string, value: unknown) => { storage.set(key, value); }
  } } as DurableObjectState);
  const call = () => limiter.fetch(new Request('https://limiter/check', { method: 'POST', body: JSON.stringify({ limit: 2 }) }));
  expect(await (await call()).json()).toEqual({ allowed: true });
  expect(await (await call()).json()).toEqual({ allowed: true });
  expect(await (await call()).json()).toMatchObject({ allowed: false, retryAfterSeconds: 60 });
  vi.advanceTimersByTime(60_000);
  expect(await (await call()).json()).toEqual({ allowed: true });
});
