import type { SearchProviderName, SearchResult } from '../schemas/search.js';

export interface SearchOptions {
  /** Maximum number of results to return. */
  limit: number;
  /** ISO country code used to localize results, e.g. "mz". */
  country: string;
  language?: 'pt' | 'en';
}

/**
 * Port for web search. Serper is the first adapter; Tavily can be added as a
 * second one without touching agents or the pipeline. Retries, rate limiting
 * and error mapping are applied by a wrapper around this interface, so every
 * provider gets the same behaviour.
 */
export interface SearchProvider {
  readonly name: SearchProviderName;
  /** Throws PipelineError (rate_limited, provider_transient, provider_permanent). */
  search(query: string, options: SearchOptions): Promise<SearchResult[]>;
}
