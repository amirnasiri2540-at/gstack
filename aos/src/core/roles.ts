/**
 * Roles are data (constraint C4). A seventh role is a seventh file.
 *
 * A role YAML carries identity: name, prompt, temperature, output schema, and
 * which other roles it must not share a provider with. It carries no model
 * slug. Slugs come from config/routing.lock.yaml, which setup generates from
 * the live catalog, so there is exactly one place a model id can enter the
 * system and it is not a hand-edited file.
 *
 * (The build prompt's example role file showed a `model:` line holding the
 * FILL_FROM_LIVE_MODEL_LIST placeholder. Keeping slugs out of prompt files
 * entirely serves the same constraint and means `npm run setup` never has to
 * rewrite hand-authored prose.)
 *
 * Provider diversity is enforced here, at load time, before a run can start.
 * Discovering that your independent critic is the same model as your builder
 * after paying for the run is the expensive way to learn it.
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { AosError } from './errors.ts';
import { providerOf } from './catalog.ts';
import { isSchemaName, SCHEMAS } from '../roles/outputs.ts';
import type { SchemaName } from '../roles/outputs.ts';
import type { RoutingLock } from './routing.ts';

export const RoleSpec = z.object({
  name: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'role names are SHOUTED so they stand out in a log'),
  title: z.string().min(3),
  temperature: z.number().min(0).max(2),
  max_tokens: z.number().int().positive(),
  output_schema: z.string(),
  /** Roles this one must not share a model provider with. */
  must_differ_from: z.array(z.string()).default([]),
  system_prompt: z.string().min(40),
});
export type RoleSpec = z.infer<typeof RoleSpec>;

export interface RuntimeRole {
  name: string;
  title: string;
  temperature: number;
  maxTokens: number;
  schemaName: SchemaName;
  schema: (typeof SCHEMAS)[SchemaName];
  mustDifferFrom: string[];
  systemPrompt: string;
  model: string;
  fallback: string;
  /** Additional models run alongside the primary, e.g. ECHO's second critic. */
  parallel: string[];
}

export function parseRoleFile(file: string): RoleSpec {
  let raw: unknown;
  try {
    raw = yaml.load(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    throw new AosError('ROLE_CONFIG', `${path.basename(file)} is not valid YAML: ${(err as Error).message}`, { file });
  }
  const parsed = RoleSpec.safeParse(raw);
  if (!parsed.success) {
    throw new AosError('ROLE_CONFIG', `${path.basename(file)} is not a valid role definition`, {
      file,
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    });
  }
  if (!isSchemaName(parsed.data.output_schema)) {
    throw new AosError(
      'ROLE_CONFIG',
      `${path.basename(file)} names output_schema "${parsed.data.output_schema}", which does not exist`,
      { file, known: Object.keys(SCHEMAS) },
    );
  }
  return parsed.data;
}

/**
 * Load every roles/*.yaml, bind it to its resolved models, and refuse to return
 * if any diversity constraint is violated.
 */
export function loadRoles(rolesDir: string, lock: RoutingLock): Map<string, RuntimeRole> {
  if (!fs.existsSync(rolesDir)) {
    throw new AosError('ROLE_CONFIG', `no roles directory at ${rolesDir}`, { rolesDir });
  }
  const files = fs
    .readdirSync(rolesDir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();
  if (files.length === 0) {
    throw new AosError('ROLE_CONFIG', `no role files in ${rolesDir}`, { rolesDir });
  }

  const roles = new Map<string, RuntimeRole>();
  for (const f of files) {
    const spec = parseRoleFile(path.join(rolesDir, f));
    if (roles.has(spec.name)) {
      throw new AosError('ROLE_CONFIG', `two role files both define ${spec.name}`, { file: f });
    }
    const routing = lock.roles[spec.name];
    if (!routing) {
      throw new AosError(
        'MODEL_UNRESOLVED',
        `role ${spec.name} has no routing entry. Add it to config/routing.yaml, then run: npm run setup`,
        { role: spec.name, known: Object.keys(lock.roles) },
      );
    }
    const schemaName = spec.output_schema as SchemaName;
    roles.set(spec.name, {
      name: spec.name,
      title: spec.title,
      temperature: spec.temperature,
      maxTokens: spec.max_tokens,
      schemaName,
      schema: SCHEMAS[schemaName],
      mustDifferFrom: spec.must_differ_from,
      systemPrompt: spec.system_prompt,
      model: routing.model,
      fallback: routing.fallback,
      parallel: routing.parallel,
    });
  }

  assertProviderDiversity(roles);
  return roles;
}

/**
 * Trick #7. ECHO exists to disagree with ATLAS and FORGE; running all three on
 * one provider buys correlated opinions at three times the price.
 */
export function assertProviderDiversity(roles: Map<string, RuntimeRole>): void {
  for (const role of roles.values()) {
    for (const otherName of role.mustDifferFrom) {
      const other = roles.get(otherName);
      if (!other) {
        throw new AosError('ROLE_CONFIG', `${role.name} must_differ_from names unknown role ${otherName}`, {
          role: role.name,
          otherName,
        });
      }
      const mine = providerOf(role.model);
      const theirs = providerOf(other.model);
      if (mine === theirs) {
        throw new AosError(
          'PROVIDER_DIVERSITY',
          `${role.name} and ${otherName} both resolve to provider "${mine}", but ${role.name} must differ from it`,
          {
            role: role.name,
            otherName,
            provider: mine,
            roleModel: role.model,
            otherModel: other.model,
            hint: `Change the \`prefer\` list for ${role.name} in config/routing.yaml, then re-run: npm run setup`,
          },
        );
      }
    }
  }
}

export function requireRole(roles: Map<string, RuntimeRole>, name: string): RuntimeRole {
  const role = roles.get(name);
  if (!role) {
    throw new AosError('ROLE_CONFIG', `the pipeline needs a role named ${name}, but no roles/*.yaml defines one`, {
      name,
      known: [...roles.keys()],
    });
  }
  return role;
}
