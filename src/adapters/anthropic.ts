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
  tool_choice: { type: 'auto' };
}

export interface MessageResponse {
  content: { type: string; name?: string; input?: unknown; text?: string }[];
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

/** Reads a JSON object from a plain-text reply, with or without a code fence. */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * LlmClient backed by the Messages API. The model is asked, in the user turn,
 * to call one tool whose input schema is the expected JSON schema.
 *
 * Current Claude models reject forced tool choice (tool_choice "tool" or
 * "any"), so the request uses tool_choice "auto" with an explicit instruction.
 * The model may therefore answer in text: a JSON object in the text is
 * accepted as a fallback. Either way the agent validates the result with Zod
 * before using it, and asks once for a correction if it is invalid.
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
          messages: [
            {
              role: 'user',
              content: `${request.user}\n\nReply by calling the \`${toolName}\` tool exactly once with the complete result. Do not answer in plain text.`,
            },
          ],
          tools: [
            {
              name: toolName,
              description: `Record the ${request.schemaName} result.`,
              input_schema: request.jsonSchema,
            },
          ],
          tool_choice: { type: 'auto' },
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
      let json: unknown = block?.input;
      if (json === undefined) {
        const text = response.content
          .filter((b) => b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n');
        json = extractJsonObject(text);
      }
      if (json === undefined) {
        throw new PipelineError({
          code: 'model_output_invalid',
          message: `The reply did not call the ${toolName} tool`,
          context: { schema: request.schemaName, stop_reason: response.stop_reason, usage },
        });
      }
      return { json, rawText: JSON.stringify(json), model: response.model, usage };
    },
  };
}
