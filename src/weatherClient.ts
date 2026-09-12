import type { WeatherResult } from './types';

export interface WeatherClientOptions {
  baseUrl: string;
  fetcher?: typeof fetch;
}

export class WeatherClient {
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: WeatherClientOptions) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async getWeather(latitude: number, longitude: number): Promise<WeatherResult> {
    const url = new URL(this.options.baseUrl);
    url.searchParams.set('latitude', String(latitude));
    url.searchParams.set('longitude', String(longitude));
    url.searchParams.set('current', 'temperature_2m,apparent_temperature,precipitation,rain,showers,snowfall,weather_code,wind_speed_10m,wind_direction_10m');
    url.searchParams.set('hourly', 'precipitation_probability');
    url.searchParams.set('forecast_days', '1');
    url.searchParams.set('timezone', 'auto');

    const response = await this.fetcher(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Weather API returned ${response.status}`);

    const payload = await response.json() as any;
    const current = payload?.current ?? {};
    const hourly = payload?.hourly ?? {};
    const currentTime = typeof current.time === 'string' ? current.time : null;
    const currentIndex = Array.isArray(hourly?.time) && currentTime ? hourly.time.indexOf(currentTime) : -1;

    return {
      latitude: numberOrFallback(payload?.latitude, latitude),
      longitude: numberOrFallback(payload?.longitude, longitude),
      observedAt: currentTime,
      temperatureCelsius: numberOrNull(current?.temperature_2m),
      apparentTemperatureCelsius: numberOrNull(current?.apparent_temperature),
      precipitationProbabilityPercent: currentIndex >= 0 ? numberOrNull(hourly?.precipitation_probability?.[currentIndex]) : null,
      precipitationMillimeters: numberOrNull(current?.precipitation),
      windSpeedKmh: numberOrNull(current?.wind_speed_10m),
      windDirectionDegrees: numberOrNull(current?.wind_direction_10m),
      weatherCode: numberOrNull(current?.weather_code),
      source: 'Open-Meteo',
      retrievedAt: new Date().toISOString()
    };
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numberOrFallback(value: unknown, fallback: number): number {
  return numberOrNull(value) ?? fallback;
}