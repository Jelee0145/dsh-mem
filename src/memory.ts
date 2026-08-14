/**
 * Cross-session memory Service Definition (`ctx.memory`). It owns the contract
 * for durable notes shared across every session of one harness home: ids,
 * entry shape, search semantics, and the single-implementation rule. The
 * file-backed implementation lives in `dsh-mem/provider`; the model-facing
 * tools live in `dsh-mem/tool`.
 * @module dsh-mem/memory
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque id of one durable memory note, issued by the provider (`m-<n>`). */
export type MemoryEntryId = Branded<'MemoryEntryId'>

/**
 * Construct a {@link MemoryEntryId} from its runtime string. The owning
 * package's factory: a plain cast, since the brand is erased at runtime.
 * @param value - the provider-issued `m-<n>` string.
 * @returns the branded id.
 */
export function MemoryEntryId(value: string): MemoryEntryId {
  return value as MemoryEntryId
}

/** One durable memory note. Instances are immutable; update by replacing. */
export interface MemoryEntry {
  /** Provider-issued stable id (`m-<n>`); unique across restarts. */
  readonly id: MemoryEntryId
  /** Durable free-form content. */
  readonly content: string
  /** Keyword tags for later filtering; never contains empty strings. */
  readonly tags: readonly string[]
  /**
   * The project or workspace this note belongs to, when the fact is
   * project-specific; absent means a global fact that applies everywhere.
   * Recorded at save time from the caller (the model names the project).
   */
  readonly project?: string
  /** Epoch milliseconds at first save (stamped by the provider, never caller-supplied). */
  readonly createdAt: number
  /** Epoch milliseconds at the last save (equal to `createdAt` today). */
  readonly updatedAt: number
}

/** Input to {@link MemoryService.remember}. */
export interface RememberInput {
  /** Non-empty trimmed content, within the provider's size bound. */
  content: string
  /** Optional keyword tags; empty strings are dropped by the provider. */
  tags?: readonly string[]
  /**
   * Optional project or workspace this fact belongs to; empty strings are
   * dropped by the provider (treated as a global fact).
   */
  project?: string
}

/** Options narrowing a recall or list read. */
export interface MemoryQueryOptions {
  /**
   * When provided, only notes whose `project` matches (case-insensitive
   * exact) are returned; global notes without a project never match.
   */
  project?: string
  /** Optional positive result cap; omitted means all matches. */
  limit?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryService
  }
}

/**
 * Abstract cross-session memory registry. Subclass, implement the abstract
 * methods, and load the subclass as a plugin — it registers as `ctx.memory`
 * (one implementation per context; loading a second throws, which is cordis'
 * standard duplicate-service behavior).
 *
 * Implementations must honor these semantics:
 * - **Durable and cross-session**: entries survive process restarts and are
 *   shared by every session of one harness home. Nothing here is scoped to a
 *   session, an agent, or a workspace.
 * - **Reads are synchronous** from the authoritative in-memory state; writes
 *   are queued and await durability before the change is visible.
 * - **Search**: {@link recall} matches case-insensitive substrings of
 *   `content` and exact (case-insensitive) tag names; an empty query returns
 *   the newest notes. Results are newest-first by `updatedAt`. An optional
 *   `project` narrows to that project's notes (global notes never match).
 * - **Deletion**: {@link forget} removes one note and reports whether it
 *   existed; it never throws for an unknown id.
 * - **Bounds fail loud at the tool boundary**: oversized content and
 *   non-positive limits reject, they do not truncate silently.
 */
export abstract class MemoryService extends Service {
  constructor(ctx: Context) {
    // `abstract` erases at runtime, so a composition row naming this package
    // would register a ctx.memory with no method implementations and fail far
    // from the misconfiguration. Fail loud at load instead.
    if (new.target === MemoryService) {
      throw new Error('dsh-mem is the abstract cross-session memory seam; load the provider (dsh-mem/provider) instead')
    }
    super(ctx, 'memory')
  }

  /**
   * Store one durable note. Trims content, drops empty tags and empty
   * projects, assigns the next `m-<n>` id, stamps `createdAt`/`updatedAt`,
   * and persists before resolving.
   * @param input - content, optional tags, and optional owning project.
   * @returns the stored entry.
   */
  abstract remember(input: RememberInput): Promise<MemoryEntry>

  /**
   * Search stored notes. Case-insensitive substring match on content or exact
   * tag match; an empty query returns the newest notes. `project` narrows to
   * notes of exactly that project (global notes never match a project filter).
   * @param query - search text (already trimmed by the caller).
   * @param options - optional project filter and result cap.
   * @returns matching entries, newest-first by `updatedAt`, never live state.
   */
  abstract recall(query: string, options?: MemoryQueryOptions): Promise<MemoryEntry[]>

  /**
   * Remove one note.
   * @param id - the note to remove.
   * @returns `true` when the note existed and was removed, `false` otherwise.
   */
  abstract forget(id: MemoryEntryId): Promise<boolean>

  /**
   * List stored notes newest-first, optionally narrowed to one project.
   * @param options - optional project filter and result cap.
   * @returns entries, never live state.
   */
  abstract list(options?: MemoryQueryOptions): Promise<MemoryEntry[]>
}

export default MemoryService
