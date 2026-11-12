import type { Clock } from '../ports/clock.js';
import { systemClock } from '../ports/clock.js';
import type { SearchOptions, SearchProvider } from '../ports/search.js';
import type { SearchResult } from '../schemas/search.js';
import { mapProviderError } from './anthropic.js';

const SERPER_URL = 'https://google.serper.dev/search';

export interface SerperOptions {
  apiKey: string;
  /** Injected in tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  clock?: Clock;
  timeoutMs?: number;
}

interface SerperOrganicResult {
  title?: unknown;
  link?: unknown;
  snippet?: unknown;
  position?: unknown;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Serper (Google Search API) adapter. It only returns what the search API
 * returns: titles, links and snippets. It does not open or scrape pages.
 * Retries, rate limiting and caching are applied by the search service.
 */
export function createSerperProvider(options: SerperOptions): SearchProvider {
  const doFetch = options.fetch ?? fetch;
  const clock = options.clock ?? systemClock;

  return {
    name: 'serper',
    async search(query: string, search: SearchOptions): Promise<SearchResult[]> {
      let response: Response;
      try {
        response = await doFetch(SERPER_URL, {
          method: 'POST',
          headers: { 'X-API-KEY': options.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            q: query,
            gl: search.country,
            hl: search.language ?? 'pt',
            num: search.limit,
          }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
        });
      } catch (error) {
        throw mapProviderError(error, 'serper');
      }
      if (!response.ok) {
        throw mapProviderError(
          Object.assign(new Error(`HTTP ${response.status}`), {
            status: response.status,
            headers: response.headers,
          }),
          'serper',
        );
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        throw mapProviderError(error, 'serper');
      }
      const organic: unknown = (body as { organic?: unknown } | null)?.organic;
      const retrievedAt = clock.now().toISOString();
      const results: SearchResult[] = [];
      for (const item of Array.isArray(organic) ? (organic as SerperOrganicResult[]) : []) {
        if (!isHttpUrl(item.link)) continue;
        results.push({
          provider: 'serper',
          query,
          rank: results.length + 1,
          url: item.link,
          title: typeof item.title === 'string' ? item.title : '',
          snippet: typeof item.snippet === 'string' ? item.snippet : '',
          retrieved_at: retrievedAt,
        });
        if (results.length >= search.limit) break;
      }
      return results;
    },
  };
}
