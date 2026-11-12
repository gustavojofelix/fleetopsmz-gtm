import type { GeographyConfig } from '../schemas/settings.js';

/** Removes accents: "Zambézia" becomes "Zambezia". */
export function stripDiacritics(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Lowercase, accent-free, single-spaced key used for comparisons. */
export function comparisonKey(text: string): string {
  return stripDiacritics(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Legal-form words dropped from the end of a company name. */
const LEGAL_FORM_TOKENS: ReadonlySet<string> = new Set([
  'lda',
  'limitada',
  'sa',
  'sarl',
  'ei',
  'eirl',
  'su',
  'unipessoal',
  'sociedade',
  'anonima',
  'ltd',
  'limited',
  'pty',
  'inc',
  'llc',
]);

/**
 * Normalizes a company name for matching: lowercase, no accents, no
 * punctuation, no trailing legal form. "Transportes Exemplo, Lda." and
 * "TRANSPORTES EXEMPLO LIMITADA" both become "transportes exemplo".
 */
export function normalizeCompanyName(name: string): string {
  const prepared = stripDiacritics(name)
    .toLowerCase()
    .replace(/&/g, ' e ')
    // Collapse dotted legal forms before punctuation is removed.
    .replace(/\bs\.\s?a\.\s?r\.\s?l\b\.?/g, ' sarl ')
    .replace(/\bs\.\s?a\b\.?/g, ' sa ')
    .replace(/\bl\.\s?d\.\s?a\b\.?/g, ' lda ')
    .replace(/\be\.\s?i\b\.?/g, ' ei ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const tokens = prepared.split(' ').filter((token) => token !== '');
  const kept = [...tokens];
  while (kept.length > 1 && LEGAL_FORM_TOKENS.has(kept[kept.length - 1] ?? '')) {
    kept.pop();
  }
  return kept.join(' ');
}

/** Hosts that many companies share, so they cannot identify one company. */
const SHARED_WEB_DOMAINS: readonly string[] = [
  'facebook.com',
  'fb.com',
  'instagram.com',
  'linkedin.com',
  'twitter.com',
  'x.com',
  'youtube.com',
  'tiktok.com',
  'wa.me',
  'whatsapp.com',
  'google.com',
  'linktr.ee',
  'wixsite.com',
  'wordpress.com',
  'blogspot.com',
];

/** Email providers used by many unrelated businesses. */
const SHARED_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.com.br',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'icloud.com',
  'sapo.pt',
  'tdm.co.mz',
  'teledata.mz',
  'tvcabo.co.mz',
  'intra.co.mz',
]);

function matchesDomain(domain: string, list: readonly string[]): boolean {
  return list.some((shared) => domain === shared || domain.endsWith(`.${shared}`));
}

/** True for social networks, site builders and other hosts shared by many companies. */
export function isSharedWebDomain(domain: string): boolean {
  return matchesDomain(domain.toLowerCase(), SHARED_WEB_DOMAINS);
}

/** The registrable host of a URL without "www.", or null when it is not a URL. */
export function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

export interface NormalizedWebsite {
  url: string;
  domain: string;
  /** False for social networks and site builders: not usable as an identity key. */
  identifying: boolean;
}

/** Parses a website value as collected. Returns null when it is not a usable URL. */
export function normalizeWebsite(raw: string | null): NormalizedWebsite | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '' || /\s/.test(trimmed)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  if (!host.includes('.')) return null;
  const domain = host.replace(/^www\./, '');
  const path = parsed.pathname === '/' ? '' : parsed.pathname;
  return {
    url: `${parsed.protocol}//${host}${path}`,
    domain,
    identifying: !matchesDomain(domain, SHARED_WEB_DOMAINS),
  };
}

/** Splits a cell that holds several values ("84 111 / 82 222"). */
export function splitMultiValue(raw: string | null): string[] {
  if (raw === null) return [];
  return raw
    .split(/[;/|,]/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/**
 * Normalizes one phone number to +<country><number>. Mozambican national
 * numbers (9 digits starting with 8, or 8 digits starting with 2) get +258.
 * Returns null when the value cannot be read as a phone number.
 */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  let digits = trimmed.replace(/\D/g, '');
  let international = trimmed.startsWith('+');
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
    international = true;
  }
  const isNationalMz = (value: string): boolean =>
    (value.length === 9 && value.startsWith('8')) || (value.length === 8 && value.startsWith('2'));

  if (digits.startsWith('258') && isNationalMz(digits.slice(3))) return `+${digits}`;
  if (!international && isNationalMz(digits)) return `+258${digits}`;
  if (international && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

/** All distinct phone numbers found in a raw cell. */
export function normalizePhones(raw: string | null): string[] {
  const numbers = splitMultiValue(raw)
    .map(normalizePhone)
    .filter((value): value is string => value !== null);
  return [...new Set(numbers)];
}

export interface NormalizedEmail {
  address: string;
  domain: string;
  /** False for webmail and ISP domains: not usable as an identity key. */
  identifying: boolean;
}

export function normalizeEmail(raw: string): NormalizedEmail | null {
  const address = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return null;
  const domain = address.slice(address.lastIndexOf('@') + 1);
  return { address, domain, identifying: !SHARED_EMAIL_DOMAINS.has(domain) };
}

/** All distinct, valid email addresses found in a raw cell. */
export function normalizeEmails(raw: string | null): NormalizedEmail[] {
  const seen = new Set<string>();
  const result: NormalizedEmail[] = [];
  for (const part of splitMultiValue(raw)) {
    const email = normalizeEmail(part);
    if (email !== null && !seen.has(email.address)) {
      seen.add(email.address);
      result.push(email);
    }
  }
  return result;
}

export interface ResolvedLocation {
  city: string | null;
  province: string | null;
  /** True when the city is listed in config/geography.json. */
  listed: boolean;
  priority_rank: number | null;
}

/**
 * Maps a collected city and province to the canonical names in
 * config/geography.json. An unlisted city is kept as collected; nothing is
 * guessed, so an unknown province stays null.
 */
export function resolveLocation(
  city: string | null,
  province: string | null,
  geography: GeographyConfig,
): ResolvedLocation {
  const cleanCity = city?.trim() || null;
  const cleanProvince = province?.trim() || null;
  if (cleanCity !== null) {
    const key = comparisonKey(cleanCity);
    const match = geography.cities.find(
      (entry) =>
        comparisonKey(entry.city) === key ||
        entry.aliases.some((alias) => comparisonKey(alias) === key),
    );
    if (match !== undefined) {
      return {
        city: match.city,
        province: match.province,
        listed: true,
        priority_rank: match.priority_rank,
      };
    }
  }
  return { city: cleanCity, province: cleanProvince, listed: false, priority_rank: null };
}

/** Reads a collected date. Accepts ISO dates and timestamps only; otherwise null. */
export function parseCollectedAt(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? null : `${value}T00:00:00Z`;
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const time = Date.parse(value);
    return Number.isNaN(time) ? null : new Date(time).toISOString();
  }
  return null;
}
