import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { PipelineError } from '../infra/errors.js';
import type { RecordStore } from '../ports/store.js';

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

/**
 * Filesystem implementation of RecordStore, confined to one root directory.
 * `writeNew` refuses to replace a file, so run results are never overwritten.
 */
export function createFsStore(rootDir: string): RecordStore {
  const root = resolve(rootDir);

  function locate(path: string): string {
    const absolute = resolve(root, path);
    const fromRoot = relative(root, absolute);
    if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
      throw new PipelineError({
        code: 'io',
        message: `Path is outside the project folder: ${path}`,
        context: { path },
      });
    }
    return absolute;
  }

  function ioError(action: string, path: string, cause: unknown): PipelineError {
    return new PipelineError({
      code: 'io',
      message: `Cannot ${action} ${path}`,
      context: { path },
      cause,
    });
  }

  return {
    async exists(path) {
      try {
        await stat(locate(path));
        return true;
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) return false;
        throw ioError('check', path, error);
      }
    },

    async readText(path) {
      try {
        return await readFile(locate(path), 'utf8');
      } catch (error) {
        throw ioError('read', path, error);
      }
    },

    async readJson(path) {
      const text = await this.readText(path);
      try {
        return JSON.parse(text) as unknown;
      } catch (error) {
        throw ioError('parse', path, error);
      }
    },

    async writeNew(path, content) {
      const target = locate(path);
      try {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, { encoding: 'utf8', flag: 'wx' });
      } catch (error) {
        if (isNodeError(error, 'EEXIST')) {
          throw new PipelineError({
            code: 'io',
            message: `Refusing to overwrite existing file: ${path}`,
            context: { path },
          });
        }
        throw ioError('write', path, error);
      }
    },

    async writeState(path, content) {
      const target = locate(path);
      const temporary = `${target}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(temporary, content, 'utf8');
        await rename(temporary, target);
      } catch (error) {
        throw ioError('write', path, error);
      }
    },

    async appendLine(path, line) {
      const target = locate(path);
      try {
        await mkdir(dirname(target), { recursive: true });
        await appendFile(target, `${line}\n`, 'utf8');
      } catch (error) {
        throw ioError('append to', path, error);
      }
    },

    async list(directory) {
      try {
        return (await readdir(locate(directory))).sort();
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) return [];
        throw ioError('list', directory, error);
      }
    },
  };
}
