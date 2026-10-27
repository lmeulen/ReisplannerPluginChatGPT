import type { Env } from './types';

export function getNsApiBaseUrl(env: Env): string {
  return (env.NS_API_BASE_URL || 'https://gateway.apiportal.ns.nl/reisinformatie-api/api').replace(/\/$/, '');
}

export function getMcpRateLimitPerMinute(env: Env): number {
  const limit = Number(env.MCP_RATE_LIMIT_PER_MINUTE ?? 45);
  return Number.isInteger(limit) && limit >= 1 && limit <= 1000 ? limit : 45;
}
