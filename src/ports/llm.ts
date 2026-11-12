/**
 * Port for the language model. Agents depend on this interface only; the
 * Anthropic SDK lives in an adapter, and tests use a scripted fake.
 */
export interface LlmRequest {
  model: string;
  /** Agent instructions, loaded from /prompts. */
  system: string;
  /** The record to process, serialized by the agent. */
  user: string;
  maxTokens: number;
  /** Name of the expected output schema, for logs and error messages. */
  schemaName: string;
  /** JSON Schema of the expected output, when the adapter can enforce it. */
  jsonSchema?: Record<string, unknown>;
}

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface LlmResponse {
  /** Parsed JSON as returned by the model. Not yet validated: the agent validates it. */
  json: unknown;
  rawText: string;
  model: string;
  usage: LlmUsage;
}

export interface LlmClient {
  /** Throws PipelineError on provider failure or when the reply is not JSON. */
  completeJson(request: LlmRequest): Promise<LlmResponse>;
}
