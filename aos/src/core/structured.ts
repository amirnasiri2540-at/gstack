/**
 * Structured output with exactly one automatic repair (trick #3).
 *
 * This single pattern removes most multi-agent chain breakage, because the way
 * these pipelines actually die is not a bad idea from the model, it is role
 * four receiving prose where it expected an object. Forcing JSON, validating
 * with zod, and handing the validation error back once fixes the overwhelming
 * majority of those without a human in the loop.
 *
 * The attempt ladder is fixed at three and there is nothing configurable about
 * it, because "just one more retry" is how a $1 run becomes a $40 run:
 *
 *   1. primary model
 *   2. primary model, with the zod errors appended as a user message
 *   3. fallback model, fresh
 *   then halt (trick #12: fail loud, fail cheap)
 *
 * The JSON Schema shown to the model is generated from the same zod schema that
 * validates the reply, so the instructions and the gate cannot drift apart.
 */
import { z } from 'zod';
import type { ZodType } from 'zod';
import { AosError } from './errors.ts';
import { callModel } from './router.ts';
import type { RouterContext, ModelResult } from './router.ts';
import type { Message } from './transport.ts';
import type { RuntimeRole } from './roles.ts';

export interface StructuredCall<T> {
  role: RuntimeRole;
  /** Conversation after the role's system prompt. */
  messages: Message[];
  schema: ZodType<T>;
  /** Override the role's primary model, e.g. ECHO's parallel second critic. */
  model?: string;
}

export interface StructuredResult<T> {
  value: T;
  result: ModelResult;
  attempts: number;
}

/**
 * Pull a JSON value out of a reply that may be fenced, prefaced with prose, or
 * both. Models do this constantly even in JSON mode, and treating it as a
 * protocol violation rather than parsing around it just burns a repair.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  const fence = /```(?:json|JSON)?\s*\n([\s\S]*?)\n?```/.exec(trimmed);
  const candidates = [fence?.[1], trimmed, sliceBalanced(trimmed)].filter(
    (c): c is string => typeof c === 'string' && c.trim().length > 0,
  );

  for (const c of candidates) {
    try {
      return JSON.parse(c.trim());
    } catch {
      // Try the next candidate. The caller reports failure if none parse.
    }
  }
  throw new AosError('SCHEMA_VIOLATION', 'the reply contained no parseable JSON', {
    preview: trimmed.slice(0, 300),
  });
}

/** First balanced {...} or [...] in the text, respecting strings and escapes. */
function sliceBalanced(text: string): string | undefined {
  const start = text.search(/[{[]/);
  if (start === -1) return undefined;
  const open = text[start]!;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

export function describeSchema(schema: ZodType<unknown>): string {
  try {
    return JSON.stringify(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }), null, 2);
  } catch {
    // A schema with checks JSON Schema cannot express still has to be described.
    return 'The exact shape is enforced by the validator; return a JSON object matching the fields named in the instructions.';
  }
}

function issuesOf(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues.map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
  }
  return err instanceof Error ? err.message : String(err);
}

function systemMessage(role: RuntimeRole, schema: ZodType<unknown>): Message {
  return {
    role: 'system',
    content: [
      role.systemPrompt.trim(),
      '',
      'OUTPUT CONTRACT',
      'Reply with a single JSON object and nothing else. No prose before or after,',
      'no markdown fence. It must validate against this JSON Schema:',
      '',
      describeSchema(schema),
    ].join('\n'),
  };
}

export async function callStructured<T>(ctx: RouterContext, call: StructuredCall<T>): Promise<StructuredResult<T>> {
  const { role, schema } = call;
  const base: Message[] = [systemMessage(role, schema), ...call.messages];
  const primary = call.model ?? role.model;

  // Attempt 1: primary.
  let last = await callModel(ctx, {
    role: role.name,
    model: primary,
    messages: base,
    temperature: role.temperature,
    maxTokens: role.maxTokens,
    jsonMode: true,
  });
  let parsed = tryParse(schema, last.text);
  if (parsed.ok) return { value: parsed.value, result: last, attempts: 1 };

  // Attempt 2: same model, handed its own validation errors.
  ctx.log.append({
    type: 'model.repair',
    role: role.name,
    model: primary,
    hash: last.hash,
    issues: parsed.issues,
  });
  last = await callModel(ctx, {
    role: role.name,
    model: primary,
    messages: [
      ...base,
      { role: 'assistant', content: last.text },
      {
        role: 'user',
        content: [
          'Your previous reply failed schema validation:',
          '',
          parsed.issues,
          '',
          'Return the corrected JSON object only. Fix exactly these problems and change nothing else.',
        ].join('\n'),
      },
    ],
    temperature: role.temperature,
    maxTokens: role.maxTokens,
    jsonMode: true,
  });
  parsed = tryParse(schema, last.text);
  if (parsed.ok) return { value: parsed.value, result: last, attempts: 2 };

  // Attempt 3: a different model. Two failures is evidence about the model,
  // not about the prompt.
  ctx.log.append({
    type: 'model.repair',
    role: role.name,
    model: role.fallback,
    hash: last.hash,
    issues: `escalating to fallback after two failures on ${primary}`,
  });
  last = await callModel(ctx, {
    role: role.name,
    model: role.fallback,
    messages: base,
    temperature: role.temperature,
    maxTokens: role.maxTokens,
    jsonMode: true,
  });
  parsed = tryParse(schema, last.text);
  if (parsed.ok) return { value: parsed.value, result: last, attempts: 3 };

  throw new AosError(
    'SCHEMA_VIOLATION',
    `${role.name} failed to produce valid ${role.schemaName} after three attempts (${primary}, repair, ${role.fallback})`,
    { role: role.name, issues: parsed.issues, preview: last.text.slice(0, 300) },
  );
}

type ParseOutcome<T> = { ok: true; value: T } | { ok: false; issues: string };

function tryParse<T>(schema: ZodType<T>, text: string): ParseOutcome<T> {
  let json: unknown;
  try {
    json = extractJson(text);
  } catch (err) {
    return { ok: false, issues: err instanceof AosError ? err.message : issuesOf(err) };
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, issues: issuesOf(parsed.error) };
}
