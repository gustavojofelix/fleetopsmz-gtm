/**
 * Port for persistence. The filesystem adapter writes atomically and refuses
 * to overwrite: raw data and previous run results are never replaced.
 * Paths are relative to the project root.
 */
export interface RecordStore {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  readJson(path: string): Promise<unknown>;
  /** Fails with PipelineError("io") if the file already exists. */
  writeNew(path: string, content: string): Promise<void>;
  /** Atomic replace, for run-scoped state only (manifest, pointer files). */
  writeState(path: string, content: string): Promise<void>;
  appendLine(path: string, line: string): Promise<void>;
  list(directory: string): Promise<string[]>;
}
