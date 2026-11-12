import { createHash } from 'node:crypto';

/** SHA-256 of a UTF-8 string, as lowercase hex. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A short, stable identifier suffix derived from the given parts. */
export function shortHash(parts: readonly string[], length = 16): string {
  return sha256Hex(parts.join('\u001f')).slice(0, length);
}
