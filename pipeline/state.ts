import { z } from 'zod';

export const TriageOutput = z.object({
  files: z
    .array(z.string())
    .min(1)
    .max(5)
    .describe('Repo-relative paths of the most likely defective files'),
  hypothesis: z
    .string()
    .max(1200)
    .describe('What is broken and why, citing concrete symbols/functions'),
  confidence: z.enum(['low', 'med', 'high']),
});
export type TriageOutput = z.infer<typeof TriageOutput>;

export const ReproOutput = z.object({
  testFilePath: z
    .string()
    .describe('Repo-relative path of the ONE new *.repro.spec.ts file'),
  expectedBehavior: z.string().max(600),
  actualBehavior: z.string().max(600),
});
export type ReproOutput = z.infer<typeof ReproOutput>;

export const FixOutput = z.object({
  changedFiles: z.array(z.string()).min(1),
  diffSummary: z.string().max(1200),
  riskNotes: z.string().max(600),
});
export type FixOutput = z.infer<typeof FixOutput>;

export const CriticOutput = z.object({
  verdict: z.enum(['approve', 'reject']),
  // max raised 1200 -> 4000 after run-2: a thorough rejection legitimately
  // needs room; two critic attempts were wasted on length/format friction.
  reasons: z.string().max(4000).describe('A single string (not an array), the review reasoning'),
  claims: z
    .array(
      z.object({
        text: z.string().max(300),
        cite: z
          .string()
          .regex(/^[^:]+:\d+$/, 'must be file:line')
          .describe('file:line the claim is grounded on — verified by a script'),
      })
    )
    .min(1)
    .max(10),
});
export type CriticOutput = z.infer<typeof CriticOutput>;

export const PrOutput = z.object({
  title: z.string().max(120),
  body: z.string().max(6000),
});
export type PrOutput = z.infer<typeof PrOutput>;

export const RunState = z.object({
  runId: z.string(),
  branch: z.string(),
  baseBranch: z.string(),
  status: z.enum(['running', 'done', 'escalated']),
  issue: z.object({
    id: z.number().optional(),
    title: z.string(),
    body: z.string(),
  }),
  triage: TriageOutput.optional(),
  repro: ReproOutput.extend({
    failingOutput: z
      .string()
      .describe('Truncated jest output proving the test is red'),
  }).optional(),
  fix: FixOutput.extend({ attempts: z.number() }).optional(),
  critic: CriticOutput.optional(),
  pr: PrOutput.extend({ url: z.string().optional() }).optional(),
  escalation: z.string().optional(),
});
export type RunState = z.infer<typeof RunState>;

export function jsonSchemaFor(schema: z.ZodType): object {
  return z.toJSONSchema(schema);
}
