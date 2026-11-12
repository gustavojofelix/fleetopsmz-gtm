import { PipelineError } from '../infra/errors.js';
import type { LlmClient, LlmRequest, LlmResponse } from '../ports/llm.js';

/**
 * The part of the Anthropic Messages API this adapter uses, described
 * structurally so the logic here can be tested without the SDK or the network.
 * The real client is created in anthropic-sdk.ts.
 */
export interface MessageCreateParams {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: 'user'; content: string }[];
  tools: { name: string; description: string; input_schema: Record<string, unknown> }[];
  tool_choice: { type: 'tool'; name: string };
}

export interface MessageResponse {
  content: { type: string; name?: string; input?: unknown }[];
  model: string;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export interface MessagesApi {
  create(params: MessageCreateParams): Promise<MessageResponse>;
}

function readHeader(headers: unknown, name: string): string | null {
  if (headers === null || typeof headers !== 'object') return null;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === 'function') {
    const value: unknown = getter.call(headers, name);
    return typeof value === 'string' ? value : null;
  }
  const value = (headers as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : null;
}

/**
 * Maps an SDK or network error to a PipelineError by HTTP status, so retry
 * behaviour does not depend on SDK error class names.
 */
export function mapProviderError(error: unknown, provider = 'anthropic'): PipelineError {
  if (error instanceof PipelineError) return error;
  const status =
    error !== null && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number'
      ? (error as { status: number }).status
      : null;
  const detail = error instanceof Error ? error.message : String(error);
  const context = { provider, status };

  if (status === 429) {
    const retryAfter = Number(readHeader((error as { headers?: unknown }).headers, 'retry-after'));
    return new PipelineError({
      code: 'rate_limited',
      message: `${provider}: rate limited`,
      context,
      cause: error,
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1_000 } : {}),
    });
  }
  if (status === null || status === 408 || status === 409 || status >= 500) {
    return new PipelineError({
      code: 'provider_transient',
      message: `${provider}: temporary failure (${status ?? 'network'}): ${detail}`,
      context,
      cause: error,
    });
  }
  const hint = status === 401 || status === 403 ? ' Check the API key.' : '';
  return new PipelineError({
    code: 'provider_permanent',
    message: `${provider}: request rejected (${status}): ${detail}.${hint}`,
    context,
    cause: error,
  });
}

/**
 * LlmClient backed by the Messages API. Structured output is obtained by
 * forcing a single tool call whose input schema is the expected JSON schema.
 * The result is still validated by the agent before use.
 */
export function createAnthropicLlmClient(api: MessagesApi): LlmClient {
  return {
    async completeJson(request: LlmRequest): Promise<LlmResponse> {
      if (request.jsonSchema === undefined) {
        throw new PipelineError({
          code: 'internal',
          message: `No JSON schema supplied for ${request.schemaName}`,
        });
      }
      const toolName = `record_${request.schemaName}`;
      let response: MessageResponse;
      try {
        response = await api.create({
          model: request.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: [{ role: 'user', content: request.user }],
          tools: [
            {
              name: toolName,
              description: `Record the ${request.schemaName} result.`,
              input_schema: request.jsonSchema,
            },
          ],
          tool_choice: { type: 'tool', name: toolName },
        });
      } catch (error) {
        throw mapProviderError(error);
      }

      const usage = {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      };
      if (response.stop_reason === 'max_tokens') {
        throw new PipelineError({
          code: 'model_output_invalid',
          message: 'Model reply was cut off at the token limit',
          context: { schema: request.schemaName, usage },
        });
      }
      const block = response.content.find((b) => b.type === 'tool_use' && b.name === toolName);
      if (block === undefined || block.input === undefined) {
        throw new PipelineError({
          code: 'model_output_invalid',
          message: 'Model reply contained no structured result',
          context: { schema: request.schemaName, stop_reason: response.stop_reason },
        });
      }
      return {
        json: block.input,
        rawText: JSON.stringify(block.input),
        model: response.model,
        usage,
      };
    },
  };
}
