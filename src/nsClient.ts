import type { Departure, DeparturesInput, Disruption, DisruptionsInput, Journey, PlanInput, Station } from './schemas';
import {
  parseDepartures,
  parseDisruptions,
  parseJourneys,
  parseStations
} from './nsPayloads';

export type NsApiErrorCode =
  | 'configuration_error'
  | 'invalid_request'
  | 'timeout'
  | 'network_error'
  | 'redirect_denied'
  | 'http_error'
  | 'invalid_response'
  | 'response_too_large';

export class NsApiError extends Error {
  constructor(
    message: string,
    readonly code: NsApiErrorCode,
    readonly status?: number
  ) {
    super(message);
    this.name = 'NsApiError';
  }
}

export function isNsApiError(error: unknown): error is NsApiError {
  return error instanceof NsApiError || (
    isRecord(error) && error.name === 'NsApiError' && typeof error.code === 'string'
  );
}

export interface NsClientOptions {
  apiKey: string;
  baseUrl: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

type QueryValue = string | number | boolean | undefined;

export class NsClient {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: NsClientOptions) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async getStations(): Promise<Station[]> {
    const payload = await this.getJson('/v2/stations');
    return this.parse(() => parseStations(payload));
  }

  async planJourney(input: PlanInput): Promise<Journey[]> {
    const payload = await this.getJson('/v3/trips', {
      lang: input.language,
      fromStation: input.from,
      toStation: input.to,
      dateTime: input.dateTime,
      searchForArrival: String(input.searchForArrival),
      travelAssistance: String(input.accessible),
      searchForAccessibleTrip: input.accessible
    });
    return this.parse(() => parseJourneys(payload));
  }

  async getDepartures(input: DeparturesInput): Promise<Departure[]> {
    const limit = Math.min(20, Math.max(1, input.limit));
    const payload = await this.getJson('/v2/departures', {
      lang: input.language,
      station: input.station,
      dateTime: input.dateTime,
      maxJourneys: String(limit)
    });
    return this.parse(() => parseDepartures(payload)).slice(0, limit);
  }

  async getDisruptions(input: DisruptionsInput): Promise<Disruption[]> {
    const headers = { 'Accept-Language': input.language };
    const query: Record<string, QueryValue> = {};
    if (input.isActive !== undefined) query.isActive = String(input.isActive);

    const path = input.station === undefined
      ? '/v3/disruptions'
      : `/v3/disruptions/station/${encodeStationCode(input.station)}`;
    const payload = await this.getJson(path, query, headers);
    const disruptions = this.parse(() => parseDisruptions(payload));
    return input.isActive === undefined
      ? disruptions
      : disruptions.filter(item => item.isActive === input.isActive);
  }

  private parse<T>(parser: () => T): T {
    try {
      return parser();
    } catch (error) {
      if (isNsApiError(error)) throw error;
      throw new NsApiError('NS returned an invalid response.', 'invalid_response');
    }
  }

  private async getJson(
    path: string,
    params: Record<string, QueryValue> = {},
    extraHeaders: Record<string, string> = {}
  ): Promise<unknown> {
    const url = this.createUrl(path, params);
    if (!this.options.apiKey.trim()) {
      throw new NsApiError('NS API credentials are unavailable.', 'configuration_error');
    }
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > MAX_TIMEOUT_MS) {
      throw new NsApiError('NS request timeout configuration is invalid.', 'configuration_error');
    }

    const controller = new AbortController();
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new NsApiError('NS request timed out.', 'timeout'));
      }, this.timeoutMs);
    });

    try {
      const requestPromise = this.fetchAndParse(url, controller, extraHeaders, () => timedOut);
      return await Promise.race([requestPromise, timeoutPromise]);
    } catch (error) {
      if (isNsApiError(error)) throw error;
      if (timedOut || controller.signal.aborted) {
        throw new NsApiError('NS request timed out.', 'timeout');
      }
      throw new NsApiError('NS request failed.', 'network_error');
    } finally {
      clearTimeout(timeoutHandle!);
    }
  }

  private async fetchAndParse(
    url: URL,
    controller: AbortController,
    extraHeaders: Record<string, string>,
    didTimeOut: () => boolean
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...extraHeaders,
          'Ocp-Apim-Subscription-Key': this.options.apiKey
        }
      });
    } catch {
      if (didTimeOut() || controller.signal.aborted) {
        throw new NsApiError('NS request timed out.', 'timeout');
      }
      throw new NsApiError('NS request failed.', 'network_error');
    }

    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new NsApiError('NS redirected the request.', 'redirect_denied', response.status);
    }
    if (!response.ok) {
      throw new NsApiError(`NS API request failed with status ${response.status}.`, 'http_error', response.status);
    }
    return readJsonBody(response, controller.signal);
  }

  private createUrl(path: string, params: Record<string, QueryValue>): URL {
    let base: URL;
    try {
      base = new URL(this.options.baseUrl);
    } catch {
      throw new NsApiError('NS API base URL is invalid.', 'configuration_error');
    }
    const localHttp = base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
    if (
      (base.protocol !== 'https:' && !localHttp) ||
      base.username !== '' || base.password !== '' || base.search !== '' || base.hash !== '' ||
      path[0] !== '/' || path.includes('..')
    ) {
      throw new NsApiError('NS API base URL or request path is invalid.', 'configuration_error');
    }

    const prefix = base.pathname.replace(/\/+$/, '');
    base.pathname = `${prefix}${path}`;
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') base.searchParams.set(key, String(value));
    }
    return base;
  }
}

function encodeStationCode(code: string): string {
  if (!/^[A-Za-z0-9]{1,10}$/.test(code)) {
    throw new NsApiError('Station code is invalid.', 'invalid_request');
  }
  return encodeURIComponent(code);
}

async function readJsonBody(response: Response, signal: AbortSignal): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new NsApiError('NS response exceeded the size limit.', 'response_too_large');
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new NsApiError('NS returned an invalid response.', 'invalid_response');
  }

  const cancelReader = () => { void reader.cancel().catch(() => undefined); };
  if (signal.aborted) cancelReader();
  else signal.addEventListener('abort', cancelReader, { once: true });

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        cancelReader();
        throw new NsApiError('NS response exceeded the size limit.', 'response_too_large');
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', cancelReader);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new NsApiError('NS returned an invalid response.', 'invalid_response');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
