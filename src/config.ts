import type { Env, ResponseMode } from './types';

const DEFAULT_NS_API_BASE_URL = 'https://gateway.apiportal.ns.nl/reisinformatie-api/api';
const DEFAULT_WEATHER_API_BASE_URL = 'https://api.open-meteo.com/v1/forecast';

export function getNsApiBaseUrl(env: Env): string {
  return stripTrailingSlash(env.NS_API_BASE_URL || DEFAULT_NS_API_BASE_URL);
}

export function getWeatherApiBaseUrl(env: Env): string {
  return stripTrailingSlash(env.WEATHER_API_BASE_URL || DEFAULT_WEATHER_API_BASE_URL);
}

export function getDefaultResponseMode(env: Env): ResponseMode {
  return env.RESPONSE_MODE === 'flexible' ? 'flexible' : 'strict';
}

export function getMcpRateLimitPerMinute(env: Env): number {
  const configuredLimit = Number(env.MCP_RATE_LIMIT_PER_MINUTE ?? 45);
  return Number.isFinite(configuredLimit) && configuredLimit > 0 ? Math.floor(configuredLimit) : 45;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}