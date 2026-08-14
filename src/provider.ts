/**
 * File-backed provider for the cross-session memory seam (`ctx.memory`). One
 * JSON document per harness home (`<root>/memory.json`), replaced atomically
 * via `@deepseek-ai/dsh-atomic-write`; every mutation awaits durability before
 * it is visible. All operations serialize on one in-process queue, so reads
 * never observe an uncommitted write; concurrent harness processes must not
 * share one root (the document is not cross-process locked).
 * @module dsh-mem/provider
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { MemoryEntryId, MemoryService } from './memory.ts'
import type {
  MemoryEntry, MemoryEntryId as MemoryEntryIdType, MemoryQueryOptions, RememberInput,
} from './memory.ts'

/** Configuration for the file-backed memory provider. */
export interface Config {
  /**
   * Directory holding the `memory.json` document; created when missing. A
   * deployment chooses where durable cross-session data lives (the bundle
   * layer defaults it to `dshHomePath('memory')`).
   */
  root: string
  /**
   * Maximum stored notes. When exceeded, the oldest notes (by creation order)
   * are evicted on the next save. Omission defaults to 5000.
   */
  maxEntries?: number
  /**
   * Maximum content characters per note; a larger save is rejected. Omission
   * defaults to 20000.
   */
  maxContentChars?: number
}

/** On-disk document format version; a different stamp fails load. */
const DOCUMENT_VERSION = 1

/** Deployment defaults, referenced by both the schema and the constructor (one home per fact). */
const DEFAULT_MAX_ENTRIES = 5000
const DEFAULT_MAX_CONTENT_CHARS = 20000

/** The serialized document (the provider's only durable state). */
interface MemoryDocument {
  version: number
  /** Next `m-<n>` counter, persisted so ids stay unique across restarts. */
  nextId: number
  /** All notes in creation order (the eviction order). */
  entries: MemoryEntry[]
}

/** True for a well-formed document of the current version. */
function isDocument(value: unknown): value is MemoryDocument {
  if (typeof value !== 'object' || value === null) return false
  const doc = value as Record<string, unknown>
  if (doc.version !== DOCUMENT_VERSION) return false
  if (typeof doc.nextId !== 'number' || !Number.isSafeInteger(doc.nextId) || doc.nextId < 1) return false
  if (!Array.isArray(doc.entries)) return false
  return doc.entries.every(isEntry)
}

/** True for one well-formed {@link MemoryEntry} as stored. */
function isEntry(value: unknown): value is MemoryEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  if (typeof entry.id !== 'string' || !/^m-\d+$/.test(entry.id)) return false
  if (typeof entry.content !== 'string') return false
  if (!Array.isArray(entry.tags) || !entry.tags.every(tag => typeof tag === 'string')) return false
  if (entry.project !== undefined && typeof entry.project !== 'string') return false
  if (typeof entry.createdAt !== 'number' || !Number.isFinite(entry.createdAt)) return false
  if (typeof entry.updatedAt !== 'number' || !Number.isFinite(entry.updatedAt)) return false
  return true
}

/**
 * Read and normalize the document at `file`. A missing file is a fresh empty
 * document; an unreadable or malformed one fails loud at construction, because
 * silently starting from an empty store would forget everything the user
 * saved.
 * @param file - absolute path of the memory document.
 * @returns the loaded document, normalized to fresh objects.
 */
function loadDocument(file: string): MemoryDocument {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return { version: DOCUMENT_VERSION, nextId: 1, entries: [] }
    }
    throw new Error(`dsh-mem: cannot read ${file}: ${String(error)}`, { cause: error })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`dsh-mem: corrupt memory document at ${file}: ${String(error)}`, { cause: error })
  }
  if (!isDocument(parsed)) {
    throw new Error(`dsh-mem: corrupt memory document at ${file}: unexpected shape (version must be ${DOCUMENT_VERSION})`)
  }
  return {
    version: parsed.version,
    nextId: parsed.nextId,
    entries: parsed.entries.map(entry => ({
      id: MemoryEntryId(entry.id),
      content: entry.content,
      tags: [...entry.tags],
      ...(entry.project !== undefined ? { project: entry.project } : {}),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    })),
  }
}

/**
 * The file-backed `memory` registry. See the Service Definition contract in
 * `dsh-mem/memory` for the durability and search semantics this
 * implementation honors.
 */
export class MemoryFile extends MemoryService {
  static Config: z<Config> = z.object({
    root: z.string().required(),
    maxEntries: z.number().step(1).min(1).max(1_000_000).default(DEFAULT_MAX_ENTRIES),
    maxContentChars: z.number().step(1).min(1).max(1_000_000).default(DEFAULT_MAX_CONTENT_CHARS),
  })

  private readonly file: string
  private readonly maxEntries: number
  private readonly maxContentChars: number
  private doc: MemoryDocument
  /**
   * Tail of the operation queue. Every operation (mutating or reading) runs at
   * its own queue slot, so a read never observes a mutation that has not yet
   * awaited durability.
   */
  private queue: Promise<void> = Promise.resolve()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // The Loader fills schema defaults before constructing, and the
    // `??` fallbacks keep direct construction (tests, embedding) from
    // silently running with unlimited bounds.
    this.file = join(config.root, 'memory.json')
    this.maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.maxContentChars = config.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS
    this.doc = loadDocument(this.file)
  }

  /**
   * Run one operation at the next queue slot. Rejections do not break the
   * chain: each caller observes its own operation's outcome.
   * @param job - the operation to run.
   * @returns the operation's result.
   */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** Replace the document on disk atomically with user-private permissions. */
  private async persist(): Promise<void> {
    await writeFileAtomic(this.file, `${JSON.stringify(this.doc, null, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
  }

  remember(input: RememberInput): Promise<MemoryEntry> {
    const content = input.content.trim()
    if (content.length === 0) {
      throw new Error('invalid memory content: expected a non-empty string')
    }
    if (content.length > this.maxContentChars) {
      throw new Error(`invalid memory content: exceeds the ${this.maxContentChars}-character bound`)
    }
    const tags = (input.tags ?? []).map(tag => tag.trim()).filter(tag => tag.length > 0)
    // An empty project is a global fact (no project key on the entry).
    const project = input.project?.trim() || undefined
    return this.enqueue(async () => {
      const now = Date.now()
      const id = MemoryEntryId(`m-${this.doc.nextId}`)
      this.doc.nextId += 1
      const entry: MemoryEntry = {
        id,
        content,
        tags,
        ...(project !== undefined ? { project } : {}),
        createdAt: now,
        updatedAt: now,
      }
      this.doc.entries.push(entry)
      // Entries are appended in creation order, so the head is the oldest.
      const overflow = this.doc.entries.length - this.maxEntries
      if (overflow > 0) this.doc.entries.splice(0, overflow)
      await this.persist()
      return entry
    })
  }

  recall(query: string, options?: MemoryQueryOptions): Promise<MemoryEntry[]> {
    const q = query.trim().toLowerCase()
    const project = options?.project?.trim().toLowerCase()
    const take = boundLimit(options?.limit)
    return this.enqueue(async () => {
      const matches = this.doc.entries.filter(entry =>
        (project === undefined || entry.project?.toLowerCase() === project)
        && (q.length === 0
          || entry.content.toLowerCase().includes(q)
          || entry.tags.some(tag => tag.toLowerCase() === q)))
      return newestFirst(matches, take)
    })
  }

  forget(id: MemoryEntryIdType): Promise<boolean> {
    return this.enqueue(async () => {
      const index = this.doc.entries.findIndex(entry => entry.id === id)
      if (index === -1) return false
      this.doc.entries.splice(index, 1)
      await this.persist()
      return true
    })
  }

  list(options?: MemoryQueryOptions): Promise<MemoryEntry[]> {
    const project = options?.project?.trim().toLowerCase()
    const take = boundLimit(options?.limit)
    return this.enqueue(async () => {
      const matches = project === undefined
        ? this.doc.entries
        : this.doc.entries.filter(entry => entry.project?.toLowerCase() === project)
      return newestFirst(matches, take)
    })
  }
}

/**
 * Validate an optional result cap. A provided limit must be a positive safe
 * integer; `undefined` means no cap.
 * @param limit - the caller-supplied limit, if any.
 * @returns the validated limit, or `undefined`.
 */
function boundLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(`invalid limit: expected a positive integer, got ${JSON.stringify(limit)}`)
  }
  return limit
}

/**
 * Project matches newest-first and detach them from live state, so a caller
 * can never mutate the store through a returned entry.
 * @param entries - the matching entries, in creation order.
 * @param limit - optional cap applied after sorting.
 * @returns fresh entry objects, newest `updatedAt` first.
 */
function newestFirst(entries: MemoryEntry[], limit: number | undefined): MemoryEntry[] {
  const sorted = [...entries].sort((a, b) => b.updatedAt - a.updatedAt)
  const taken = limit === undefined ? sorted : sorted.slice(0, limit)
  return taken.map(entry => ({ ...entry, tags: [...entry.tags] }))
}

export default MemoryFile
