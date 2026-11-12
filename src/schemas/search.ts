import { z } from 'zod';
import { IsoDateTimeSchema } from './primitives.js';

export const SearchProviderNameSchema = z.enum(['serper', 'tavily']);
export type SearchProviderName = z.infer<typeof SearchProviderNameSchema>;

/**
 * One web search result, normalized across providers. Provider, query and
 * retrieval time travel with the result so every derived fact can be attributed.
 */
export const SearchResultSchema = z
  .object({
    provider: SearchProviderNameSchema,
    query: z.string().min(1),
    rank: z.number().int().positive(),
    url: z.string().url(),
    title: z.string(),
    snippet: z.string(),
    retrieved_at: IsoDateTimeSchema,
  })
  .strict();
export type SearchResult = z.infer<typeof SearchResultSchema>;
