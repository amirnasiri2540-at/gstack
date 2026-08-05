/**
 * Fail loud, fail cheap (trick #12).
 *
 * Every unexpected condition throws an AosError with a machine-readable code.
 * The CLI adapter writes the WorkOrder to disk and exits non-zero. There are no
 * silent retries anywhere in this codebase except the ONE structured-output
 * repair in structured.ts, which is explicit and logged.
 *
 * Note on style: no TypeScript parameter properties anywhere in this project.
 * Node's built-in type stripping erases types, it does not transform syntax, so
 * `constructor(public readonly code: string)` would leave an unassigned field.
 */

export type AosErrorCode =
  | 'BUDGET_EXCEEDED'
  | 'INVALID_TRANSITION'
  | 'SCHEMA_VIOLATION'
  | 'PATH_ESCAPE'
  | 'ROLE_CONFIG'
  | 'PROVIDER_DIVERSITY'
  | 'MODEL_UNRESOLVED'
  | 'ROUTER'
  | 'BILL_NO_1'
  | 'REPLAY_MISS'
  | 'CATALOG';

export class AosError extends Error {
  code: AosErrorCode;
  detail: Record<string, unknown>;

  constructor(code: AosErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AosError';
    this.code = code;
    this.detail = detail;
  }
}

export function isAosError(err: unknown): err is AosError {
  return err instanceof AosError;
}
