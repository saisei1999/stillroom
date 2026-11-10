/**
 * Pure account-sync domain logic for Stillroom.
 *
 * This module is deliberately React-free, storage-free and network-free so it
 * can be unit tested and reused from any layer. It decides what to do with a
 * locally queued change versus a server row (never last-write-wins), validates
 * untrusted server payloads, classifies conflicts for the UI, plans retries and
 * builds the "keep both" conflict copy.
 *
 * Type ownership note: `Entry` and `AccountRecord` are defined in
 * `storage.ts`, which imports `Entry` from here and re-exports it (the original
 * local library imports keep working). We re-export both so consumers can take
 * their domain types from a single, storage-free module.
 */

/** The canonical stillroom entry shape. Owned here; `storage.ts` re-exports it. */
export type Entry = { id: string; title: string; type: string; status: string; color: string; progress: string; tags: string[]; rating?: number; notes: string; createdAt: string };

/** The latest acknowledged-or-pending server view cached locally, scoped to one account. */
export type AccountRecord = { accountId: string; entryId: string; entry: Entry | null; revision: number };

/** One durable, account-scoped outbox operation. `entry === null` is a deletion tombstone. */
export type PendingChange = {
  accountId: string;
  entryId: string;
  /** Stable UUID for idempotency: resending the same operation must not double-apply. */
  operationId: string;
  /** The server revision the change was based on. `0` means "create, no server row yet". */
  expectedRevision: number;
  /** Full entry snapshot for a create/update; `null` for a deletion tombstone. */
  entry: Entry | null;
  /** ISO timestamp when the change was queued. */
  createdAt: string;
  /** Failed attempts so far. Absent is treated as `0`. */
  retryCount?: number;
};

/** A validated server row. `entry === null` means the server (or the user elsewhere) deleted it. */
export type ServerEntry = { id: string; revision: number; entry: Entry | null };

/** What the sync engine should do for one entry given its local queue and the server. */
export type SyncDecision = { kind: 'push'; change: PendingChange } | { kind: 'accept'; server: ServerEntry } | { kind: 'conflict'; local: PendingChange; server: ServerEntry };

/** The concrete user choice a conflict needs. */
export type ConflictKind = 'deleted-remotely' | 'edited-remotely' | 'deleted-locally' | 'diverged';

/** Typical causes of a sync failure, used only to pick honest UI copy. */
export type SyncErrorKind = 'offline' | 'timeout' | 'unauthenticated' | 'forbidden' | 'rejected' | 'rate-limited' | 'server' | 'payload-too-large' | 'unknown';

/**
 * Typed error raised when untrusted input fails validation.
 * `kind` lets the UI react without matching error strings.
 */
export class SyncValidationError extends Error {
  readonly kind: SyncErrorKind;
  constructor(kind: SyncErrorKind, message: string) {
    super(message);
    this.name = 'SyncValidationError';
    this.kind = kind;
  }
}

/** Server-side per-payload byte limit (the draft SQL rejects anything larger). */
export const MAX_PAYLOAD_BYTES = 262144;

/** Automatic attempts per change (first try included) before it waits for an explicit retry. */
export const MAX_AUTOMATIC_ATTEMPTS = 6;

const BASE_RETRY_DELAY_MILLIS = 2000;
const MAX_RETRY_DELAY_MILLIS = 5 * 60 * 1000;
const MAX_REVISION = Number.MAX_SAFE_INTEGER;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isSafeRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_REVISION;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

/**
 * Rebuilds a trusted `Entry` field by field from untrusted data, or throws.
 * Accepts an already-parsed object (network JSON), never a raw string. The
 * field rules mirror `parseBackup`; unknown extra fields are dropped and
 * never reach the local store. Prototype-bearing objects are rejected too.
 */
export function parseEntry(raw: unknown): Entry {
  if (!isRecord(raw)) throw new SyncValidationError('rejected', 'Entry data is not an object.');
  const string = (key: string): string => {
    const field = raw[key];
    if (typeof field !== 'string') throw new SyncValidationError('rejected', `Entry field "${key}" is not text.`);
    return field;
  };
  const id = string('id');
  const title = string('title');
  const type = string('type');
  const status = string('status');
  const color = string('color');
  const progress = string('progress');
  const notes = string('notes');
  const createdAt = string('createdAt');
  if (!isId(id)) throw new SyncValidationError('rejected', 'Entry id is missing or too long.');
  if (!title.trim()) throw new SyncValidationError('rejected', 'Entry title is empty.');
  const rawTags = raw.tags;
  if (!Array.isArray(rawTags) || !rawTags.every((tag) => typeof tag === 'string')) throw new SyncValidationError('rejected', 'Entry tags are not a list of labels.');
  const tags: string[] = [];
  for (const tag of rawTags) tags.push(tag);
  const rawRating = raw.rating;
  if (rawRating === undefined) return { id, title, type, status, color, progress, tags, notes, createdAt };
  if (typeof rawRating !== 'number' || !Number.isInteger(rawRating) || rawRating < 1 || rawRating > 5) throw new SyncValidationError('rejected', 'Entry rating must be a whole number from 1 to 5.');
  const rating: number = rawRating;
  return { id, title, type, status, color, progress, tags, rating, notes, createdAt };
}

/**
 * Validates one server row for `expectedId`. Requires a safe integer
 * revision >= 1, the matching entry id, and (when present) a strict entry.
 * Throws `SyncValidationError`; never returns a partially-trusted object.
 */
export function parseServerEntry(raw: unknown, expectedId: string): ServerEntry {
  if (!isId(expectedId)) throw new SyncValidationError('rejected', 'Expected entry id is invalid.');
  if (!isRecord(raw)) throw new SyncValidationError('rejected', 'Server row is not an object.');
  if (raw.id !== expectedId) throw new SyncValidationError('rejected', 'Server row is for a different entry.');
  if (!isSafeRevision(raw.revision)) throw new SyncValidationError('rejected', 'Server row has an invalid revision.');
  const revision = raw.revision;
  if (!Object.prototype.hasOwnProperty.call(raw, 'entry')) throw new SyncValidationError('rejected', 'Server row is missing its entry (or explicit null).');
  const entry = raw.entry === null ? null : parseEntry(raw.entry);
  if (entry && entry.id !== expectedId) throw new SyncValidationError('rejected', 'Server entry id does not match the row id.');
  return { id: expectedId, revision, entry };
}

/** UTF-8 byte length of a payload's JSON encoding, as the server counts it. */
export function entryPayloadSize(entry: Entry): number {
  return new TextEncoder().encode(JSON.stringify(entry)).length;
}

/** True when the payload fits the server limit. */
export function fitsPayloadLimit(entry: Entry): boolean {
  return entryPayloadSize(entry) <= MAX_PAYLOAD_BYTES;
}

/**
 * Decides push / accept / conflict. Any revision disagreement is a conflict:
 * pending work is never silently dropped or overwritten (no last-write-wins).
 * A pending change for another entry id is a programming error and throws.
 */
export function reconcile(pending: PendingChange | undefined, server: ServerEntry): SyncDecision {
  if (pending && pending.entryId !== server.id) throw new Error('Entry mismatch: pending change and server row refer to different entries.');
  if (!pending) return { kind: 'accept', server };
  if (pending.expectedRevision === server.revision) return { kind: 'push', change: pending };
  return { kind: 'conflict', local: pending, server };
}

/**
 * Classifies a conflict for the choice UI:
 * - `'deleted-remotely'`: an update here vs. a delete elsewhere (keep locally or accept the delete).
 * - `'edited-remotely'`: a delete or edit here vs. an edit elsewhere (keep this version or take theirs).
 * - `'deleted-locally'`: a delete here vs. an edit elsewhere (keep this device's delete or restore theirs).
 * - `'diverged'`: both sides edited (keep both, use mine, or use theirs).
 */
export function classifyConflict(local: PendingChange, server: ServerEntry): ConflictKind {
  if (server.entry === null) return 'deleted-remotely';
  if (local.entry === null) return 'deleted-locally';
  return 'diverged';
}

/** True when the change belongs to `accountId`. Defends against cross-account leaks. */
export function belongsToAccount(change: PendingChange, accountId: string): boolean {
  return accountId.length > 0 && change.accountId === accountId;
}

/** Throws unless the change belongs to `accountId`; call before every send or cache write. */
export function assertChangeForAccount(change: PendingChange, accountId: string): void {
  if (!belongsToAccount(change, accountId)) throw new Error('Sync change belongs to another account.');
}

/** Throws unless a cached record belongs to `accountId`. */
export function assertRecordForAccount(record: AccountRecord, accountId: string): void {
  if (accountId.length === 0 || record.accountId !== accountId) throw new Error('Cached record belongs to another account.');
}

/**
 * Pure, timer-free retry delay. Exponential backoff from 2s, doubling per
 * attempt and capped per step at 5 minutes, with full jitter:
 * `random() * cappedDelay`. `attempt` is 0-based and clamped to the valid
 * range `[0, RETRY_SCHEDULE_LENGTH - 1]`, so a hung queue cannot overflow;
 * `exceededAutomaticAttempts` tells the UI when to stop scheduling. `random`
 * defaults to `Math.random`; out-of-range values are clamped and the result is
 * always an integer in `[0, cap]`.
 */
export function nextRetryDelayMillis(attempt: number, random: () => number = Math.random): number {
  const cap = retryDelayCapMillis(attempt);
  const sample = random();
  const jitter = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 1) : 0;
  return Math.floor(jitter * cap);
}

/** How many steps the backoff schedule describes (attempts before reaching the 5 minute cap). */
export const RETRY_SCHEDULE_LENGTH = 9;

/** Stable, capped exponential delay without jitter (for display and tests). */
export function retryDelayCapMillis(attempt: number): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.min(Math.max(Math.trunc(attempt), 0), RETRY_SCHEDULE_LENGTH - 1) : 0;
  return Math.min(BASE_RETRY_DELAY_MILLIS * 2 ** safeAttempt, MAX_RETRY_DELAY_MILLIS);
}

/** True once a change has used its automatic attempts and needs an explicit retry. */
export function exceededAutomaticAttempts(retryCount: number | undefined): boolean {
  return (retryCount ?? 0) >= MAX_AUTOMATIC_ATTEMPTS;
}

const RETRYABLE_CODES = new Set([
  'offline',
  'rate_limit',
  'rate-limited',
  'timeout',
  'timed_out',
  'etimedout',
  'econnreset',
  'econnrefused',
  'enotfound',
  'fetch_error',
  'network',
  'network_error',
  'networkerror',
  'request_timeout',
  'service_unavailable',
  'unavailable',
  'internal_server_error',
  'internal',
  'server_error',
  'pgrst000',
  'pgrst001',
  'pgrst002',
  'pgrst003',
  'pgrst999',
]);

const PERMANENT_CODES = new Set([
  'auth',
  'authentication',
  'auth_error',
  'jwt_expired',
  'invalid',
  'invalid_payload',
  'invalid_request',
  'permission_denied',
  'permission',
  'forbidden',
  'not_authorized',
  'unauthorized',
  'unauthenticated',
  '422',
  'validation_error',
  'validation_failed',
  'pgrst116',
  'pgrst301',
  '23502',
  '23503',
  '23505',
  '23514',
  '42501',
]);

const RETRYABLE_PATTERN = /offline|network|timed? ?out|timeout|rate.?limit|too many requests|\b(408|429|5\d\d)\b|unavailable|temporar|retry|connection|econn|failed to fetch/i;
const PERMANENT_PATTERN = /\b(401|403|404|409|422)\b|unauthori[sz]ed|unauthenticated|forbidden|permission|jwt expired|\binvalid|\bvalidat|\bpayload|\btoo large|not allowed/i;

function readProperty(error: unknown, key: 'code' | 'message' | 'status' | 'statusCode'): unknown {
  if (!error || typeof error !== 'object') return undefined;
  return Reflect.get(error, key);
}

function codeOf(error: unknown): string | undefined {
  const candidate = readProperty(error, 'code');
  return typeof candidate === 'string' ? candidate.toLowerCase() : undefined;
}

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  const candidate = readProperty(error, 'message');
  return typeof candidate === 'string' ? candidate : '';
}

function statusOf(error: unknown): number | undefined {
  for (const key of ['status', 'statusCode'] as const) {
    const candidate = readProperty(error, key);
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 100 && candidate <= 599) return candidate;
  }
  return undefined;
}

/**
 * Retry rule (small and explicit, used only to schedule attempts):
 * - Never retry validation or authorization failures: 401, 403, 404, 409,
 *   422, or codes/messages about auth, permission, validation or payloads.
 * - Retry transient failures: network/offline errors, timeouts, 429, 408,
 *   5xx, missing `code` on a plain network throw, and unknown errors. When the
 *   classification is ambiguous we retry: the outbox is durable, and a change
 *   that keeps failing stops after `MAX_AUTOMATIC_ATTEMPTS`.
 */
export function isRetryable(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== undefined) {
    if (status === 408 || status === 429) return true;
    if (status >= 500) return true;
    if (status >= 400) return false;
  }
  const code = codeOf(error);
  if (code !== undefined) {
    if (/^(5\d\d|429|408)$/.test(code)) return true;
    if (RETRYABLE_CODES.has(code)) return true;
    if (PERMANENT_CODES.has(code)) return false;
  }
  const message = messageOf(error);
  if (PERMANENT_PATTERN.test(message) || /authentication required/i.test(message)) return false;
  if (RETRYABLE_PATTERN.test(message)) return true;
  // Unknown failures stay queued: retrying is safe and bounded by the attempt cap.
  return true;
}

/** Maps an untrusted failure to a kind for wording. Never claims success. */
export function syncErrorKind(error: unknown): SyncErrorKind {
  if (error instanceof SyncValidationError) {
    if (error.kind === 'payload-too-large') return 'payload-too-large';
    return 'rejected';
  }
  const status = statusOf(error);
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate-limited';
  if (status === 408) return 'timeout';
  if (status !== undefined && status >= 500) return 'server';
  if (status !== undefined && status >= 400) return 'rejected';
  const code = codeOf(error);
  if (code === 'timeout' || code === 'etimedout' || code === 'request_timeout') return 'timeout';
  if (code === 'pgrst301' || code === 'jwt_expired') return 'unauthenticated';
  if (code === '42501' || code === 'permission_denied') return 'forbidden';
  const message = messageOf(error);
  if (/offline|network|econn|fetch/i.test(message)) return 'offline';
  if (/timed? ?out|timeout/i.test(message)) return 'timeout';
  if (/\b401\b|unauthori[sz]ed|jwt expired/i.test(message)) return 'unauthenticated';
  if (/\b403\b|forbidden|permission/i.test(message)) return 'forbidden';
  if (/\b429\b|rate.?limit|too many requests/i.test(message)) return 'rate-limited';
  if (/\b5\d\d\b|unavailable|server/i.test(message)) return 'server';
  return 'unknown';
}

/**
 * One honest, non-technical sentence for the status area. Never says the data
 * is saved to the account; only that it stays on this device.
 */
export function friendlySyncError(error: unknown): string {
  switch (syncErrorKind(error)) {
    case 'offline':
      return 'Could not reach the account service. Changes stay saved on this device.';
    case 'timeout':
      return 'The account service did not answer in time. Changes stay saved on this device.';
    case 'unauthenticated':
      return 'Your session ended before changes could be sent. Sign in again to sync; nothing was removed from this device.';
    case 'forbidden':
      return 'Your account did not allow this change, so it was not applied to the account. It stays saved on this device.';
    case 'rejected':
      return 'The account service refused this change, so it was not applied. It stays saved on this device.';
    case 'rate-limited':
      return 'The account service is busy and asked us to slow down. Nothing was lost; syncing will try again shortly.';
    case 'server':
      return 'The account service had a problem. Changes stay saved on this device and syncing will retry.';
    case 'payload-too-large':
      return 'This entry is too large to sync to the account yet. It stays saved on this device.';
    default:
      return 'Sync could not be confirmed. Changes stay saved on this device.';
  }
}

/** A local entry that would become a new account entry (id absent from the account). */
export type ImportUpload = { entry: Entry };

/** A local entry whose id exists in the account with different content. */
export type ImportConflict = { local: Entry; server: ServerEntry };

/** Result of planning "bring my local entries into my account". Nothing is written. */
export type ImportPlan = { uploads: Entry[]; conflicts: ImportConflict[]; alreadySynced: number };

function canonicalEntryJson(value: Record<string, unknown>): string {
  const keys = Object.keys(value).sort();
  return JSON.stringify(keys.map((key) => [key, value[key]]));
}

function entryOf(entry: Entry): Record<string, unknown> {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Entry must be an object.');
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) record[key] = value;
  return record;
}

/**
 * Plans a first import without writing anything. Uploads are local entries the
 * account has never had; conflicts are ids on both sides with different
 * content (server tombstones count as conflicts); `alreadySynced` counts ids
 * whose content matches exactly. Comparison is on the validated entry shape
 * (canonical JSON of the parsed fields), so field order and dropped extra
 * fields do not cause false conflicts. Inputs are not mutated; output order is
 * sorted by entry id (ties in `alreadySynced` cannot occur: ids are unique).
 */
export function planImport(localEntries: Entry[], accountEntries: ServerEntry[]): ImportPlan {
  const remote = new Map<string, ServerEntry>();
  for (const raw of accountEntries) {
    if (!isRecord(raw)) throw new SyncValidationError('rejected', 'Account entry is not an object.');
    if (!isId(raw.id)) throw new SyncValidationError('rejected', 'Account entry id is invalid.');
    const id = raw.id;
    if (remote.has(id)) throw new SyncValidationError('rejected', 'Account entries contain a duplicate id.');
    // Rows with an invalid revision or a malformed entry are rejected wholesale
    // instead of being treated as "absent": "absent" would plan an upload that
    // could overwrite content the user cannot see.
    remote.set(id, parseServerEntry(raw, id));
  }
  const seen = new Set<string>();
  const uploads: Entry[] = [];
  const conflicts: ImportConflict[] = [];
  let alreadySynced = 0;
  for (const entry of localEntries) {
    const local = parseEntry(entryOf(entry));
    if (seen.has(local.id)) throw new SyncValidationError('rejected', 'Local entries contain a duplicate id.');
    seen.add(local.id);
    const server = remote.get(local.id);
    if (!server) {
      uploads.push(local);
      continue;
    }
    if (server.entry !== null && canonicalEntryJson(entryOf(server.entry)) === canonicalEntryJson(entryOf(local))) {
      alreadySynced += 1;
      continue;
    }
    conflicts.push({ local, server });
  }
  const byId = (left: { id: string }, right: { id: string }) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  uploads.sort(byId);
  conflicts.sort((left, right) => byId(left.local, right.local));
  return { uploads, conflicts, alreadySynced };
}

/**
 * Builds the "keep both" copy of a divergent entry: a NEW entry with a fresh
 * id, `" (conflict copy)"` appended to the title and `createdAt: now`. The
 * original entry is never mutated. Injectable `now` and `makeId` keep it pure.
 */
export function conflictCopy(local: Entry, now: string, makeId: () => string = () => crypto.randomUUID()): Entry {
  const source = parseEntry(entryOf(local));
  if (typeof now !== 'string' || !now.trim()) throw new SyncValidationError('rejected', 'A timestamp is required for the conflict copy.');
  const id = makeId();
  if (!isId(id) || id === source.id) throw new SyncValidationError('rejected', 'A conflict copy needs a new, unique id.');
  const base = { id, title: `${source.title} (conflict copy)`, type: source.type, status: source.status, color: source.color, progress: source.progress, tags: [...source.tags], notes: source.notes, createdAt: now };
  const rating = source.rating;
  return rating === undefined ? base : { ...base, rating };
}

/**
 * Builds the pending change that saves a keep-both conflict locally as a NEW
 * entry: `expectedRevision: 0` because the fresh id has no server row yet.
 */
export function conflictCopyChange(change: PendingChange, now: string, makeId: () => string = () => crypto.randomUUID(), operationId: () => string = () => crypto.randomUUID()): PendingChange {
  if (change.entry === null) throw new Error('A deleted entry cannot be copied.');
  const copy = conflictCopy(change.entry, now, makeId);
  return { accountId: change.accountId, entryId: copy.id, operationId: operationId(), expectedRevision: 0, entry: copy, createdAt: now };
}

/**
 * Convenience: a create for a local entry the account has never seen
 * (`expectedRevision: 0`) or an ordinary update. Throws on cross-account use.
 */
export function createChangeFor(accountId: string, entry: Entry, createdAt: string, expectedRevision: number, operationId: () => string = () => crypto.randomUUID()): PendingChange {
  if (accountId.length === 0) throw new Error('An account is required.');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new SyncValidationError('rejected', 'Expected revision must be a non-negative whole number.');
  const parsed = parseEntry(entryOf(entry));
  return { accountId, entryId: parsed.id, operationId: operationId(), expectedRevision, entry: parsed, createdAt };
}

/** Turns one conflict into the push that saves it server-side, with its own revision check. */
export function pendingForConflict(conflict: { local: PendingChange; server: ServerEntry }, entry: Entry | null, operationId: () => string = () => crypto.randomUUID()): PendingChange {
  if (conflict.local.entryId !== conflict.server.id) throw new Error('Entry mismatch: conflict sides refer to different entries.');
  const parsed = entry === null ? null : parseEntry(entryOf(entry));
  if (parsed && parsed.id !== conflict.server.id) throw new SyncValidationError('rejected', 'The saved entry must keep the same id.');
  return { accountId: conflict.local.accountId, entryId: conflict.server.id, operationId: operationId(), expectedRevision: conflict.server.revision, entry: parsed, createdAt: conflict.local.createdAt };
}
