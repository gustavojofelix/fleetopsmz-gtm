import { z } from 'zod';
import type { JsonCache } from '../agents/structured-call.js';
import { sha256Hex } from '../infra/hash.js';
import type { Logger } from '../infra/logger.js';
import type { RateLimiter } from '../infra/rate-limiter.js';
import { DEFAULT_RETRY, withRetry } from '../infra/retry.js';
import type { RetryOptions } from '../infra/retry.js';
import type { SearchOptions, SearchProvider } from '../ports/search.js';
import { SearchResultSchema } from '../schemas/search.js';
import type { SearchResult } from '../schemas/search.js';

export interface SearchOutcome {
  results: SearchResult[];
  fromCache: boolean;
}

export interface SearchService {
  readonly providerName: string;
  search(query: string, options: SearchOptions): Promise<SearchOutcome>;
}

export interface SearchServiceDeps {
  provider: SearchProvider;
  limiter: RateLimiter;
  logger: Logger;
  cache?: JsonCache;
  /** Ignore cached results and replace them. */
  force?: boolean;
  retry?: Partial<RetryOptions>;
}

/**
 * Wraps any SearchProvider with caching, rate limiting, retries and result
 * validation. Agents use this service, so adding a provider needs no agent change.
 */
export function createSearchService(deps: SearchServiceDeps): SearchService {
  const ResultsSchema = z.array(SearchResultSchema);

  return {
    providerName: deps.provider.name,
    async search(query, options): Promise<SearchOutcome> {
      const key = sha256Hex(
        [deps.provider.name, query, String(options.limit), options.country, options.language ?? ''].join(
          '\u001f',
        ),
      );
      if (deps.cache !== undefined && deps.force !== true) {
        const cached = ResultsSchema.safeParse(await deps.cache.get(key));
        if (cached.success) return { results: cached.data, fromCache: true };
      }

      const raw = await withRetry(
        () => deps.limiter.schedule(() => deps.provider.search(query, options)),
        {
          ...DEFAULT_RETRY,
          ...deps.retry,
          onRetry: (info) =>
            deps.logger.warn('search.retry', {
              provider: deps.provider.name,
              attempt: info.attempt,
              delay_ms: info.delayMs,
              error: info.error,
            }),
        },
      );
      const results = raw.filter((item) => SearchResultSchema.safeParse(item).success);
      await deps.cache?.set(key, results);
      return { results, fromCache: false };
    },
  };
}
