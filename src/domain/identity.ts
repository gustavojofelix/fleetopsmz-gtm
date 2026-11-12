import { shortHash } from '../infra/hash.js';
import type { IdentityKey } from '../schemas/lead.js';
import { comparisonKey } from './normalize.js';

/** Key types from strongest to weakest. The first match decides the lead. */
export const KEY_PRECEDENCE: readonly IdentityKey['type'][] = [
  'domain',
  'phone',
  'name_city',
  'name_only',
];

export function keyToString(key: IdentityKey): string {
  return `${key.type}:${key.value}`;
}

export interface IdentityInput {
  normalized_name: string;
  city: string | null;
  /**
   * Domains the company owns: its website and its email addresses, excluding
   * social networks, site builders and webmail providers.
   */
  domains: readonly string[];
  phones: readonly string[];
}

/**
 * Builds the identity keys of a record, strongest first. A record without a
 * city gets a name_only key, which matches only other records without a city.
 */
export function identityKeysFor(input: IdentityInput): IdentityKey[] {
  const keys: IdentityKey[] = [];
  for (const domain of input.domains) keys.push({ type: 'domain', value: domain });
  for (const phone of input.phones) keys.push({ type: 'phone', value: phone });
  if (input.city !== null) {
    keys.push({
      type: 'name_city',
      value: `${input.normalized_name}|${comparisonKey(input.city)}`,
    });
  } else {
    keys.push({ type: 'name_only', value: input.normalized_name });
  }
  const seen = new Set<string>();
  return keys.filter((key) => {
    const text = keyToString(key);
    if (seen.has(text)) return false;
    seen.add(text);
    return true;
  });
}

/**
 * Derives a lead_id from the normalized name and country. `salt` separates
 * distinct companies that share a name (for example in different cities).
 */
export function mintLeadId(normalizedName: string, country: string, salt = 0): string {
  const parts = [normalizedName, comparisonKey(country)];
  if (salt > 0) parts.push(String(salt));
  return `lead_${shortHash(parts, 16)}`;
}
