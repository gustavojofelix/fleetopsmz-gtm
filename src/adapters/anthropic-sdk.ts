import Anthropic from '@anthropic-ai/sdk';
import type { MessageCreateParams, MessageResponse, MessagesApi } from './anthropic.js';

/**
 * The only file that imports the Anthropic SDK. It is loaded on demand, so
 * tests and dry runs never need the SDK or an API key.
 *
 * SDK retries are disabled because the pipeline applies its own retry policy
 * (src/infra/retry.ts), which keeps attempts and delays visible in the logs.
 *
 * The request and response are passed through the structural types declared in
 * anthropic.ts. The casts keep this file independent of the SDK's exact type
 * names across versions; the fields used are the stable Messages API fields.
 */
export function createAnthropicMessagesApi(apiKey: string): MessagesApi {
  const client = new Anthropic({ apiKey, maxRetries: 0 });
  return {
    async create(params: MessageCreateParams): Promise<MessageResponse> {
      const response: unknown = await client.messages.create(params as never);
      return response as MessageResponse;
    },
  };
}
