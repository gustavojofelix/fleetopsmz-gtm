import type { CandidateContact, LeadCandidate } from '../schemas/candidate.js';
import type { IdentityKey, LeadRegistry, LeadRegistryEntry } from '../schemas/lead.js';
import type { RawCompanyRecord } from '../schemas/raw.js';
import type { GeographyConfig } from '../schemas/settings.js';
import { KEY_PRECEDENCE, identityKeysFor, keyToString, mintLeadId } from './identity.js';
import {
  normalizeCompanyName,
  normalizeEmails,
  normalizePhones,
  normalizeWebsite,
  resolveLocation,
} from './normalize.js';
import type { ResolvedLocation } from './normalize.js';

export function emptyRegistry(): LeadRegistry {
  return { schema_version: 1, updated_at: null, entries: [] };
}

interface NormalizedRecord {
  record: RawCompanyRecord;
  normalized_name: string;
  location: ResolvedLocation;
  website: string | null;
  phones: string[];
  emails: string[];
  keys: IdentityKey[];
}

function normalizeRecord(record: RawCompanyRecord, geography: GeographyConfig): NormalizedRecord {
  const input = record.input;
  const normalized_name = normalizeCompanyName(input.company_name);
  const location = resolveLocation(input.city, input.province, geography);
  const website = normalizeWebsite(input.website);
  const phones = normalizePhones(input.phone);
  const emails = normalizeEmails(input.email);
  const keys = identityKeysFor({
    normalized_name,
    city: location.city,
    domains: [
      ...(website !== null && website.identifying ? [website.domain] : []),
      ...emails.filter((e) => e.identifying).map((e) => e.domain),
    ],
    phones,
  });
  return {
    record,
    normalized_name,
    location,
    website: website?.url ?? null,
    phones,
    emails: emails.map((e) => e.address),
    keys,
  };
}

interface Group {
  lead_id: string;
  is_new: boolean;
  created_at: string;
  members: NormalizedRecord[];
  conflicts: Set<string>;
}

export interface ResolveContext {
  run_id: string;
  now: string;
}

export interface ResolveResult {
  /** One candidate per company seen in this batch, in first-seen order. */
  candidates: LeadCandidate[];
  /** The registry including every lead seen in this batch. The input is not mutated. */
  registry: LeadRegistry;
  /** Raw rows that merged into a lead already represented by another row. */
  merged_rows: number;
}

function pushUnique<T>(list: T[], value: T): void {
  if (!list.includes(value)) list.push(value);
}

/**
 * Deduplicates raw records and assigns each company a stable lead_id.
 *
 * A record joins an existing lead when it shares a key with it (a website or
 * email domain the company owns, a phone number, or name plus city). Records that only share a
 * name are kept apart and flagged in `possible_duplicate_of` for a person to
 * decide. Running the same input again resolves to the same lead_ids.
 */
export function resolveLeads(
  records: readonly RawCompanyRecord[],
  registry: LeadRegistry,
  geography: GeographyConfig,
  context: ResolveContext,
): ResolveResult {
  const keyIndex = new Map<string, string>();
  const nameIndex = new Map<string, Set<string>>();
  const entries = new Map<string, LeadRegistryEntry>();

  const indexName = (name: string, leadId: string): void => {
    const ids = nameIndex.get(name) ?? new Set<string>();
    ids.add(leadId);
    nameIndex.set(name, ids);
  };

  for (const entry of registry.entries) {
    entries.set(entry.lead_id, { ...entry, keys: [...entry.keys] });
    indexName(entry.normalized_name, entry.lead_id);
    for (const key of entry.keys) keyIndex.set(keyToString(key), entry.lead_id);
  }

  const groups = new Map<string, Group>();
  let mergedRows = 0;

  for (const raw of records) {
    const normalized = normalizeRecord(raw, geography);

    const matches: string[] = [];
    for (const type of KEY_PRECEDENCE) {
      for (const key of normalized.keys) {
        if (key.type !== type) continue;
        const leadId = keyIndex.get(keyToString(key));
        if (leadId !== undefined) pushUnique(matches, leadId);
      }
    }

    let leadId = matches[0];
    if (leadId === undefined) {
      let salt = 0;
      leadId = mintLeadId(normalized.normalized_name, geography.country, salt);
      while (entries.has(leadId)) {
        salt += 1;
        leadId = mintLeadId(normalized.normalized_name, geography.country, salt);
      }
    }

    const existing = entries.get(leadId);
    const entry: LeadRegistryEntry = existing ?? {
      lead_id: leadId,
      normalized_name: normalized.normalized_name,
      country: geography.country,
      keys: [],
      first_seen_run: context.run_id,
      last_seen_run: context.run_id,
      created_at: context.now,
      updated_at: context.now,
    };
    entry.last_seen_run = context.run_id;
    entry.updated_at = context.now;
    for (const key of normalized.keys) {
      const text = keyToString(key);
      if (!keyIndex.has(text)) {
        keyIndex.set(text, leadId);
        entry.keys.push(key);
      }
    }
    entries.set(leadId, entry);
    indexName(entry.normalized_name, leadId);
    indexName(normalized.normalized_name, leadId);

    let group = groups.get(leadId);
    if (group === undefined) {
      group = {
        lead_id: leadId,
        is_new: existing === undefined,
        created_at: entry.created_at,
        members: [],
        conflicts: new Set(),
      };
      groups.set(leadId, group);
    } else {
      mergedRows += 1;
    }
    group.members.push(normalized);
    for (const other of matches.slice(1)) group.conflicts.add(other);
  }

  const candidates = [...groups.values()].map((group) =>
    buildCandidate(group, entries, nameIndex, geography.country),
  );

  return {
    candidates,
    registry: {
      schema_version: 1,
      updated_at: records.length > 0 ? context.now : registry.updated_at,
      entries: [...entries.values()],
    },
    merged_rows: mergedRows,
  };
}

function buildCandidate(
  group: Group,
  entries: ReadonlyMap<string, LeadRegistryEntry>,
  nameIndex: ReadonlyMap<string, Set<string>>,
  country: string,
): LeadCandidate {
  const first = group.members[0];
  if (first === undefined) throw new Error('a lead group cannot be empty');
  const located = group.members.find((m) => m.location.city !== null) ?? first;

  const contacts: CandidateContact[] = [];
  const categories: string[] = [];
  const descriptions: string[] = [];
  const seenContacts = new Set<string>();
  for (const member of group.members) {
    const rawId = member.record.raw_id;
    for (const phone of member.phones) {
      if (!seenContacts.has(`phone:${phone}`)) {
        seenContacts.add(`phone:${phone}`);
        contacts.push({ channel: 'phone', value: phone, raw_id: rawId });
      }
    }
    for (const email of member.emails) {
      if (!seenContacts.has(`email:${email}`)) {
        seenContacts.add(`email:${email}`);
        contacts.push({ channel: 'email', value: email, raw_id: rawId });
      }
    }
    const category = member.record.input.business_category;
    if (category !== null) pushUnique(categories, category);
    const description = member.record.input.business_description;
    if (description !== null) pushUnique(descriptions, description);
  }

  const possibleDuplicates = new Set<string>(group.conflicts);
  for (const member of group.members) {
    for (const other of nameIndex.get(member.normalized_name) ?? []) {
      if (other !== group.lead_id) possibleDuplicates.add(other);
    }
  }

  return {
    lead_id: group.lead_id,
    is_new: group.is_new,
    company_name: first.record.input.company_name,
    normalized_name: entries.get(group.lead_id)?.normalized_name ?? first.normalized_name,
    city: located.location.city,
    province: located.location.province,
    country,
    location_listed: located.location.listed,
    priority_rank: located.location.priority_rank,
    website: group.members.find((m) => m.website !== null)?.website ?? null,
    contacts,
    business_categories: categories,
    business_descriptions: descriptions,
    keys: entries.get(group.lead_id)?.keys ?? [],
    records: group.members.map((m) => m.record),
    possible_duplicate_of: [...possibleDuplicates].sort(),
    created_at: group.created_at,
  };
}
