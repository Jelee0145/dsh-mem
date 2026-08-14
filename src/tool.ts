/**
 * Model-facing consumer of the cross-session memory seam: registers the
 * `memory_save` / `memory_recall` / `memory_forget` / `memory_list` tools on
 * `ctx.tools`. The memory service is resolved per call through `ctx.get`, so a
 * composition without the provider row fails at call time with a clear message
 * instead of at load. Named exports only — a default export would make the
 * Loader drop this plugin's namespace.
 * @module dsh-mem/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MemoryEntryId } from './memory.ts'
import type { MemoryEntry, MemoryEntryId as MemoryEntryIdType, MemoryService } from './memory.ts'

export const name = 'tool-memory'

/** The tool registry must be present before this plugin activates. */
export const inject = ['tools']

/** Configuration for the memory tool consumer. */
export interface Config {
  /**
   * Upper bound for `memory_recall` / `memory_list` result counts; a per-call
   * limit larger than this is clamped. Omission defaults to 20.
   */
  maxRecallLimit: number
}

export const Config: z<Config> = z.object({
  maxRecallLimit: z.number().step(1).min(1).max(100).default(20),
})

/** The provider's id format; a model-supplied id outside it is rejected. */
const ID_PATTERN = /^m-\d+$/

/** Canonical tool-facing projection of one stored entry. */
interface MemoryEntryOutput {
  id: string
  content: string
  tags: string[]
  /** Owning project, when the note is project-specific. */
  project?: string
  /** Epoch milliseconds at first save. */
  createdAt: number
  /** Epoch milliseconds at the last save. */
  updatedAt: number
  /** Human-readable ISO 8601 timestamp of the first save (derived, never caller-supplied). */
  createdAtText: string
}

/** Project one stored entry to the tool-facing shape. */
function toOutput(entry: MemoryEntry): MemoryEntryOutput {
  return {
    id: entry.id,
    content: entry.content,
    tags: [...entry.tags],
    ...(entry.project !== undefined ? { project: entry.project } : {}),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    createdAtText: new Date(entry.createdAt).toISOString(),
  }
}

/**
 * Resolve the memory service for one call. The provider row is optional in a
 * composition (a user may disable it), so absence fails here, at the tool
 * boundary, not at load.
 * @param ctx - the registrant context.
 * @returns the mounted memory service.
 */
function memoryOf(ctx: Context): MemoryService {
  const memory = ctx.get('memory')
  if (memory === undefined) {
    throw new Error('memory service unavailable: mount the dsh-mem provider row (dsh-mem/provider) in this composition')
  }
  return memory
}

/**
 * Validate a per-call result cap against the deployment bound.
 * @param max - the configured upper bound.
 * @param limit - the model-supplied limit, if any.
 * @returns the validated limit (clamped), or `undefined`.
 */
function clampLimit(max: number, limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(`invalid limit: expected a positive integer, got ${JSON.stringify(limit)}`)
  }
  return Math.min(limit, max)
}

/**
 * Register the four memory tools.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment's recall bound.
 */
export function apply(ctx: Context, config: Config): void {
  const { maxRecallLimit } = config

  ctx.tools.register(defineTool({
    name: 'memory_save',
    description:
      'Store a durable fact in the harness-wide long-term memory shared by every session. '
      + 'Use this for information that must survive this conversation and be available to later '
      + 'sessions: user preferences and identity, project conventions, decisions and their '
      + 'rationale, learned facts, or reusable knowledge. Do not store transient conversation '
      + 'content that is already in the session log; memory is for what a later session must '
      + 'know. Prefer a few broad, self-contained notes over many narrow ones. When the fact '
      + 'belongs to one project or workspace, name it in `project` so later sessions can recall '
      + 'it per project; omit `project` for facts that apply globally.',
    parameters: {
      content: {
        type: 'string',
        required: true,
        description: 'The durable fact to remember, as a complete standalone sentence or short paragraph.',
      },
      tags: {
        type: 'array',
        description: 'Short keywords for later filtering, e.g. ["project", "preference"].',
        items: { type: 'string' },
      },
      project: {
        type: 'string',
        description: 'The project or workspace this fact belongs to (e.g. the repository name). Omit for facts that apply to every project.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entry: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              id: { type: 'string', required: true },
              content: { type: 'string', required: true },
              tags: { type: 'array', required: true, items: { type: 'string' } },
              project: { type: 'string' },
              createdAt: { type: 'integer', required: true },
              updatedAt: { type: 'integer', required: true },
              createdAtText: { type: 'string', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Saved to long-term memory as ${value.entry.id}`
          + `${value.entry.project !== undefined ? ` for ${value.entry.project}` : ''}`
          + ` at ${value.entry.createdAtText}.`,
      }],
    },
    execute(args, _exec) {
      return memoryOf(ctx).remember({
        content: args.content,
        ...(args.tags !== undefined ? { tags: args.tags } : {}),
        ...(args.project !== undefined && args.project.trim().length > 0 ? { project: args.project } : {}),
      }).then(toOutput).then(entry => ({ entry }))
    },
    presentCall: args => ({ card: 'generic', title: 'Save memory note', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_recall',
    description:
      'Search the harness-wide long-term memory for notes saved in any past session. Call this '
      + 'before answering a question that may depend on previously learned context (user '
      + 'preferences, project setup, past decisions). Matching is a case-insensitive substring '
      + 'match on note content; an exact tag name also matches. An empty query returns the '
      + 'newest notes. Pass `project` to narrow the search to one project\'s notes (global notes '
      + 'are then excluded).',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Search text; an empty string returns the newest notes.',
      },
      project: {
        type: 'string',
        description: 'Only return notes recorded for this project (exact, case-insensitive).',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of notes to return (clamped to the deployment bound).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                content: { type: 'string', required: true },
                tags: { type: 'array', required: true, items: { type: 'string' } },
                project: { type: 'string' },
                createdAt: { type: 'integer', required: true },
                updatedAt: { type: 'integer', required: true },
                createdAtText: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderEntries('Recalled', value.entries),
      }],
    },
    execute(args, _exec) {
      const limit = args.limit !== undefined ? clampLimit(maxRecallLimit, args.limit) : undefined
      return memoryOf(ctx).recall(args.query, {
        ...(args.project !== undefined && args.project.trim().length > 0 ? { project: args.project } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }).then(entries => ({ entries: entries.map(toOutput) }))
    },
    presentCall: args => ({ card: 'generic', title: 'Recall memory notes', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description:
      'Remove one memory note by its id. Use when the model or the user decides a stored fact '
      + 'is wrong, obsolete, or no longer needed. Report the outcome; a note that is already '
      + 'gone is not an error.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'The note id, as returned by memory_save or memory_recall (e.g. m-3).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          removed: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.removed
          ? `Forgot memory note ${value.id}.`
          : `No memory note ${value.id} was stored.`,
      }],
    },
    execute(args, _exec) {
      if (!ID_PATTERN.test(args.id)) {
        throw new Error(`invalid memory id: expected m-<n>, got ${JSON.stringify(args.id)}`)
      }
      const id: MemoryEntryIdType = MemoryEntryId(args.id)
      return memoryOf(ctx).forget(id).then(removed => ({ id: args.id, removed }))
    },
    presentCall: args => ({ card: 'generic', title: 'Forget memory note', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_list',
    description:
      'List the harness-wide long-term memory notes, newest first. Use to survey what is '
      + 'stored before saving, or to discover ids for memory_forget. Pass `project` to list '
      + 'only one project\'s notes. Use memory_recall instead when looking for a specific note.',
    parameters: {
      project: {
        type: 'string',
        description: 'Only list notes recorded for this project (exact, case-insensitive).',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of notes to return (clamped to the deployment bound).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                content: { type: 'string', required: true },
                tags: { type: 'array', required: true, items: { type: 'string' } },
                project: { type: 'string' },
                createdAt: { type: 'integer', required: true },
                updatedAt: { type: 'integer', required: true },
                createdAtText: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderEntries('Stored', value.entries),
      }],
    },
    execute(args, _exec) {
      const limit = args.limit !== undefined ? clampLimit(maxRecallLimit, args.limit) : undefined
      return memoryOf(ctx).list({
        ...(args.project !== undefined && args.project.trim().length > 0 ? { project: args.project } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }).then(entries => ({ entries: entries.map(toOutput) }))
    },
    presentCall: args => ({ card: 'generic', title: 'List memory notes', kind: 'other', rawInput: args }),
  }))
}

/**
 * Render a result list as one compact text block.
 * @param head - the label line.
 * @param entries - the projected entries.
 * @returns the rendered text.
 */
function renderEntries(head: string, entries: MemoryEntryOutput[]): string {
  if (entries.length === 0) return `${head} 0 memory notes.`
  const lines = entries.map(entry => {
    const tags = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : ''
    const project = entry.project !== undefined ? ` (${entry.project})` : ''
    return `- ${entry.id} ${entry.createdAtText}${tags}${project} ${entry.content}`
  })
  return `${head} ${entries.length} memory note${entries.length === 1 ? '' : 's'}:\n${lines.join('\n')}`
}
