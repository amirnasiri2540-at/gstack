/**
 * The output schema for each role, and the registry that role YAML files name.
 *
 * These schemas are where a role's refusal is actually enforced. A prompt that
 * says "never pick a winner" is a suggestion; a schema with exactly three
 * options and no `chosen` field is a rule. Wherever a role's discipline can be
 * expressed as a shape instead of a sentence, it is expressed as a shape.
 */
import { z } from 'zod';
import { Tier } from '../core/schema.ts';

/** MUSE. Three divergent options, each with its own reason not to. */
export const IdeaSet = z.object({
  options: z
    .array(
      z.object({
        title: z.string().min(3),
        sketch: z.string().min(20),
        /** The build prompt requires a "why not" per option. No option escapes it. */
        whyNot: z.string().min(10),
      }),
    )
    .length(3),
  /** MUSE has no field in which to pick a winner. That is deliberate. */
  divergenceNote: z.string(),
});
export type IdeaSet = z.infer<typeof IdeaSet>;

/** ATLAS. Decomposition, tier, and decisions that carry their own falsifier. */
export const Plan = z.object({
  chosenOption: z.string().min(3),
  rationale: z.string().min(20),
  tier: Tier,
  reversible: z.boolean(),
  tasks: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        assignee: z.enum(['FORGE', 'ECHO', 'SENTINEL', 'HERALD']),
        acceptance: z.string().min(10),
      }),
    )
    .min(1),
  decisions: z
    .array(
      z.object({
        title: z.string(),
        chosen: z.string(),
        alternatives: z.array(z.string()),
        assumptions: z.array(z.string()),
        /** The one fact that would prove this wrong. Feature 6.3 depends on it. */
        falsifier: z.string().min(10),
        reviewInDays: z.number().int().min(1).max(365),
      }),
    )
    .default([]),
});
export type Plan = z.infer<typeof Plan>;

/** FORGE. Files, and at least one of them has to actually run. */
export const BuildResult = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        kind: z.enum(['code', 'doc', 'config', 'test']),
        runnable: z.boolean(),
        contents: z.string().min(1),
      }),
    )
    .min(1),
  notes: z.string().default(''),
});
export type BuildResult = z.infer<typeof BuildResult>;

/**
 * ECHO. Either at least one concrete objection, or the single word NO_OBJECTION
 * plus the exact test that would produce one. The schema makes "looks good to
 * me" unrepresentable.
 */
export const CritiqueReport = z
  .object({
    objections: z
      .array(
        z.object({
          claim: z.string().min(15),
          severity: z.enum(['S1', 'S2', 'S3']),
          /** What observation would settle this objection either way. */
          falsifier: z.string().min(10),
        }),
      )
      .default([]),
    noObjection: z.boolean().default(false),
    /** Required when noObjection is true. Enforced below. */
    testThatWouldCreateOne: z.string().default(''),
  })
  .refine((r) => r.objections.length > 0 || (r.noObjection && r.testThatWouldCreateOne.length >= 15), {
    message:
      'ECHO must return at least one objection, or noObjection:true with a concrete testThatWouldCreateOne. Praise is not a valid output.',
  });
export type CritiqueReport = z.infer<typeof CritiqueReport>;

/** SENTINEL. A defect without reproduction steps is an opinion. */
export const DefectReport = z.object({
  defects: z
    .array(
      z.object({
        severity: z.enum(['S1', 'S2', 'S3']),
        description: z.string().min(15),
        /** Reproducible, not an opinion. The schema requires the steps. */
        evidence: z.string().min(20),
      }),
    )
    .default([]),
  testsRun: z.array(z.string()).default([]),
});
export type DefectReport = z.infer<typeof DefectReport>;

/** HERALD. Packaging only, plus the unverified-claim sweep from section 4. */
export const DeliveryPackage = z.object({
  headline: z.string().min(10),
  whatShipped: z.string().min(30),
  howToRun: z.string().min(10),
  risks: z.array(z.string()).default([]),
  /**
   * Any factual claim a non-primary model produced arrives tagged [UNVERIFIED].
   * HERALD lifts those into their own list so the founder sees them as claims
   * rather than as facts buried in prose.
   */
  unverifiedClaims: z.array(z.string()).default([]),
});
export type DeliveryPackage = z.infer<typeof DeliveryPackage>;

/** What a role YAML's `output_schema:` field is allowed to name. */
export const SCHEMAS = {
  IdeaSet,
  Plan,
  BuildResult,
  CritiqueReport,
  DefectReport,
  DeliveryPackage,
} as const;

export type SchemaName = keyof typeof SCHEMAS;

export function isSchemaName(name: string): name is SchemaName {
  return Object.hasOwn(SCHEMAS, name);
}
