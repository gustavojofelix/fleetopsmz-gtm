import type { ResearchDossier } from '../../schemas/dossier.js';
import type { OutreachChannel } from '../../schemas/outreach.js';
import type { Persona, PublicContact, Segment } from '../../schemas/primitives.js';
import type { OutreachConfig } from '../../schemas/settings.js';

/** One message to write: who it is for and through which channel. */
export interface DraftTarget {
  target_id: string;
  persona: Persona;
  /** A person's name only when the dossier holds it from a public source. */
  addressed_to: string | null;
  role_title: string | null;
  contact_id: string | null;
  channel: OutreachChannel;
}

/** Decision-makers to address when no named person is known, by segment. */
const DEFAULT_PERSONAS: Record<Segment, readonly Persona[]> = {
  transport: ['managing_director', 'operations_director', 'fleet_manager'],
  logistics: ['managing_director', 'operations_director', 'logistics_manager'],
  distribution: ['managing_director', 'logistics_manager', 'fleet_manager'],
  fleet_intensive: ['managing_director', 'fleet_manager', 'finance_director'],
  other: ['managing_director', 'operations_director', 'fleet_manager'],
};

export const PERSONA_LABELS: Record<Persona, { pt: string; en: string }> = {
  managing_director: { pt: 'Director-Geral', en: 'Managing Director' },
  owner: { pt: 'Proprietário', en: 'Owner' },
  operations_director: { pt: 'Director de Operações', en: 'Operations Director' },
  fleet_manager: { pt: 'Gestor de Frota', en: 'Fleet Manager' },
  transport_manager: { pt: 'Gestor de Transportes', en: 'Transport Manager' },
  logistics_manager: { pt: 'Gestor de Logística', en: 'Logistics Manager' },
  finance_director: { pt: 'Director Financeiro', en: 'Finance Director' },
  procurement_manager: { pt: 'Gestor de Compras', en: 'Procurement Manager' },
};

interface NamedPerson {
  name: string;
  persona: Persona;
  role_title: string | null;
  email: PublicContact | undefined;
  linkedin: PublicContact | undefined;
}

/**
 * Decides which drafts to write for a dossier. Chosen by code, not by the
 * model, so a message can only be addressed to a person the research found
 * publicly, and only through a channel that was publicly listed.
 *
 * - Up to `max_personas` decision-makers: named people first, then the
 *   segment's default roles.
 * - Email: one per persona, to that person's public email or the corporate one.
 * - LinkedIn: one per named person with a public profile; otherwise a single
 *   role-addressed note for the first persona.
 * - WhatsApp: a single message to the corporate number.
 */
export function buildTargets(dossier: ResearchDossier, outreach: OutreachConfig): DraftTarget[] {
  const contacts = dossier.lead.public_contacts;
  const corporate = contacts.filter((contact) => contact.scope === 'corporate');
  const corporateEmail = corporate.find((contact) => contact.channel === 'email');
  const corporatePhone =
    corporate.find((contact) => contact.channel === 'whatsapp') ??
    corporate.find((contact) => contact.channel === 'phone');

  const people = new Map<Persona, NamedPerson>();
  for (const contact of contacts) {
    if (contact.scope !== 'named_person' || contact.persona === null || contact.person_name === null) {
      continue;
    }
    const sameName = (c: PublicContact): boolean => c.person_name === contact.person_name;
    if (!people.has(contact.persona)) {
      people.set(contact.persona, {
        name: contact.person_name,
        persona: contact.persona,
        role_title: contact.role_title,
        email: contacts.find((c) => sameName(c) && c.channel === 'email'),
        linkedin: contacts.find((c) => sameName(c) && c.channel === 'linkedin'),
      });
    }
  }

  const personas: Persona[] = [...people.keys()];
  for (const persona of DEFAULT_PERSONAS[dossier.lead.business_segment]) {
    if (!personas.includes(persona)) personas.push(persona);
  }
  const chosen = personas.slice(0, outreach.max_personas);
  const primary = chosen[0];
  if (primary === undefined) return [];

  const targets: Omit<DraftTarget, 'target_id'>[] = [];
  for (const persona of chosen) {
    const person = people.get(persona);
    const email = person?.email ?? corporateEmail;
    if (email !== undefined) {
      targets.push({
        persona,
        addressed_to: person?.name ?? null,
        role_title: person?.role_title ?? null,
        contact_id: email.contact_id,
        channel: 'email',
      });
    }
    if (person?.linkedin !== undefined) {
      targets.push({
        persona,
        addressed_to: person.name,
        role_title: person.role_title,
        contact_id: person.linkedin.contact_id,
        channel: 'linkedin',
      });
    }
  }
  if (corporatePhone !== undefined) {
    targets.push({
      persona: primary,
      addressed_to: null,
      role_title: null,
      contact_id: corporatePhone.contact_id,
      channel: 'whatsapp',
    });
  }
  if (!targets.some((target) => target.channel === 'linkedin')) {
    const person = people.get(primary);
    targets.push({
      persona: primary,
      addressed_to: person?.name ?? null,
      role_title: person?.role_title ?? null,
      contact_id: null,
      channel: 'linkedin',
    });
  }

  return targets
    .slice(0, outreach.max_drafts_per_lead)
    .map((target, index) => ({ target_id: `t${index + 1}`, ...target }));
}
