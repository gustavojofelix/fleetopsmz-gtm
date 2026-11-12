import { z } from 'zod';
import { IcpCriterionKeySchema } from './lead.js';
import { PrioritySchema } from './primitives.js';

/** config/scoring.json */
export const ScoringConfigSchema = z
  .object({
    schema_version: z.literal(1),
    criteria: z.array(
      z
        .object({
          key: IcpCriterionKeySchema,
          label: z.string().min(1),
          max: z.number().int().positive(),
        })
        .strict(),
    ),
    /** Minimum score for each priority band. Below band C is "low". */
    bands: z
      .object({
        A: z.number().int().min(0).max(100),
        B: z.number().int().min(0).max(100),
        C: z.number().int().min(0).max(100),
      })
      .strict(),
    /** Below this coverage a lead goes to manual review whatever its score. */
    coverage_threshold: z.number().min(0).max(1),
    /** Priorities that proceed to Agent 2 without manual promotion. */
    auto_research_priorities: z.array(PrioritySchema).min(1),
    /** Points for the geographic_relevance criterion, computed by code. */
    geographic_points: z
      .object({
        /** Keyed by the city's priority_rank in geography.json ("1", "2", ...). */
        by_priority_rank: z.record(z.string().regex(/^[1-9]\d*$/), z.number().int().min(0)),
        /** A city listed in geography.json without a priority rank. */
        listed_city: z.number().int().min(0),
        /** A city or province that is given but not listed in geography.json. */
        unlisted_location: z.number().int().min(0),
      })
      .strict(),
    /** Points for the contact_availability criterion, computed by code. */
    contact_points: z
      .object({
        one_channel: z.number().int().min(0),
        two_or_more_channels: z.number().int().min(0),
      })
      .strict(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const expected = IcpCriterionKeySchema.options;
    const seen = new Set(config.criteria.map((c) => c.key));
    if (config.criteria.length !== expected.length || seen.size !== expected.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['criteria'],
        message: 'criteria must list each ICP criterion exactly once',
      });
    }
    const total = config.criteria.reduce((sum, c) => sum + c.max, 0);
    if (total !== 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['criteria'],
        message: `criterion maxima must total 100 (got ${total})`,
      });
    }
    const maxOf = (key: string): number => config.criteria.find((c) => c.key === key)?.max ?? 0;
    const geographic = [
      ...Object.values(config.geographic_points.by_priority_rank),
      config.geographic_points.listed_city,
      config.geographic_points.unlisted_location,
    ];
    if (geographic.some((points) => points > maxOf('geographic_relevance'))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['geographic_points'],
        message: 'geographic points exceed the geographic_relevance maximum',
      });
    }
    const contact = [config.contact_points.one_channel, config.contact_points.two_or_more_channels];
    if (contact.some((points) => points > maxOf('contact_availability'))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contact_points'],
        message: 'contact points exceed the contact_availability maximum',
      });
    }
    if (!(config.bands.A > config.bands.B && config.bands.B > config.bands.C)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bands'],
        message: 'bands must satisfy A > B > C',
      });
    }
  });
export type ScoringConfig = z.infer<typeof ScoringConfigSchema>;

/** config/geography.json */
export const GeographyConfigSchema = z
  .object({
    schema_version: z.literal(1),
    country: z.string().min(1),
    cities: z
      .array(
        z
          .object({
            city: z.string().min(1),
            province: z.string().min(1),
            aliases: z.array(z.string().min(1)),
            /** 1 is the highest commercial priority; null means no special priority. */
            priority_rank: z.number().int().positive().nullable(),
            corridors: z.array(z.string().min(1)),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type GeographyConfig = z.infer<typeof GeographyConfigSchema>;

/** config/outreach.json: who the drafts are sent from, and how many to write. */
export const OutreachConfigSchema = z
  .object({
    schema_version: z.literal(1),
    sender: z
      .object({
        /** The person who will send the messages. Required before Agent 3 runs. */
        name: z.string().min(1).nullable(),
        role: z.string().min(1).nullable(),
        company: z.string().min(1),
        email: z.string().email().nullable(),
        phone: z.string().min(1).nullable(),
        website: z.string().url().nullable(),
      })
      .strict(),
    max_personas: z.number().int().min(1).max(5),
    max_drafts_per_lead: z.number().int().min(1).max(12),
  })
  .strict();
export type OutreachConfig = z.infer<typeof OutreachConfigSchema>;
