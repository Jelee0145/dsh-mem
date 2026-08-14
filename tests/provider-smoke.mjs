// Provider smoke: drive the built file-backed MemoryFile through a real cordis
// Context, exercising durability across instances, search semantics, bounds,
// and fail-loud corruption. Runs under plain Node against the built lib/.
// Requires `npm run build` (or the local tsc build) first.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { MemoryFile } from '../lib/provider.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-mem-smoke-'))
const file = join(root, 'memory.json')

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

async function freshProvider() {
  const ctx = new Context()
  const memory = new MemoryFile(ctx, { root })
  return { ctx, memory }
}

async function dispose(ctx) {
  await ctx.fiber.dispose()
}

// Round-trip through one context.
{
  const { ctx, memory } = await freshProvider()
  const first = await memory.remember({ content: 'The user prefers Python for data scripts.' })
  assert(first.id === 'm-1', `first id is m-1, got ${first.id}`)
  assert(first.content === 'The user prefers Python for data scripts.', 'content trimmed and stored')
  assert(first.project === undefined, 'global note has no project key')
  const second = await memory.remember({
    content: '  Project X uses pnpm workspaces.  ',
    tags: ['project', 'pnpm'],
    project: 'project-x',
  })
  assert(second.id === 'm-2', `second id is m-2, got ${second.id}`)
  assert(second.content === 'Project X uses pnpm workspaces.', 'content trimmed')
  assert(second.tags.length === 2, 'tags kept')
  assert(second.project === 'project-x', 'project stored')
  await memory.remember({ content: 'Deployment target is Windows.', tags: ['ops'], project: 'project-y' })

  const bySubstring = await memory.recall('python')
  assert(bySubstring.length === 1 && bySubstring[0].id === 'm-1', 'case-insensitive substring match')
  const byTag = await memory.recall('PNPM')
  assert(byTag.length === 1 && byTag[0].id === 'm-2', 'case-insensitive exact tag match')
  const newest = await memory.list({ limit: 2 })
  assert(newest.length === 2 && newest[0].id === 'm-3' && newest[1].id === 'm-2', 'list newest-first')
  const emptyQuery = await memory.recall('')
  assert(emptyQuery.length === 3, 'empty query returns every note')
  const byProject = await memory.recall('', { project: 'PROJECT-X' })
  assert(byProject.length === 1 && byProject[0].id === 'm-2', 'project filter is case-insensitive exact')
  const projectList = await memory.list({ project: 'project-x' })
  assert(projectList.length === 1 && projectList[0].id === 'm-2', 'list narrows to one project')
  const globalExcluded = await memory.recall('deployment', { project: 'project-x' })
  assert(globalExcluded.length === 0, 'global notes never match a project filter')
  const none = await memory.recall('no-such-term')
  assert(none.length === 0, 'no match returns empty')
  const removed = await memory.forget(first.id)
  assert(removed === true, 'forget reports removal')
  const again = await memory.forget(first.id)
  assert(again === false, 'second forget reports absent')
  const afterForget = await memory.list()
  assert(afterForget.length === 2 && afterForget.every(entry => entry.id !== 'm-1'), 'entry gone after forget')
  await dispose(ctx)
  console.log('round-trip (remember/recall/forget/list + project filter): OK')
}

// Durability: a second provider over the same root reads the same notes.
{
  const { ctx, memory } = await freshProvider()
  const notes = await memory.list()
  assert(notes.length === 2, `reload sees 2 notes, got ${notes.length}`)
  assert(notes[0].id === 'm-3', 'ids continue after restart (nextId persisted)')
  assert(notes.find(entry => entry.id === 'm-2').project === 'project-x', 'project survives restart')
  assert(notes.find(entry => entry.id === 'm-3').project === 'project-y', 'each note keeps its own project after restart')
  const next = await memory.remember({ content: 'One more note after restart.' })
  assert(next.id === 'm-4', `next id is m-4, got ${next.id}`)
  assert(readFileSync(file, 'utf8').includes('"m-4"'), 'document persisted on disk')
  await dispose(ctx)
  console.log('durability across instances: OK')
}

// Bounds fail loud. `freshProvider` uses the constructor defaults (5000/20000),
// so this block pins a tight content bound on its own provider.
{
  const { ctx, memory } = await freshProvider()
  let threw = false
  try { await memory.remember({ content: '   ' }) } catch { threw = true }
  assert(threw, 'empty content rejected')
  threw = false
  try { await memory.list({ limit: 0 }) } catch { threw = true }
  assert(threw, 'non-positive limit rejected')
  await dispose(ctx)

  const tightCtx = new Context()
  const tight = new MemoryFile(tightCtx, { root, maxContentChars: 20 })
  threw = false
  try { await tight.remember({ content: 'x'.repeat(30) }) } catch { threw = true }
  assert(threw, 'oversized content rejected (maxContentChars 20)')
  await dispose(tightCtx)

  const evictingCtx = new Context()
  const evicting = new MemoryFile(evictingCtx, { root, maxEntries: 3 })
  for (let i = 0; i < 5; i += 1) await evicting.remember({ content: `note ${i}` })
  const kept = await evicting.list()
  assert(kept.length === 3 && kept[0].content === 'note 4', 'oldest evicted beyond maxEntries')
  await dispose(evictingCtx)
  console.log('bounds and eviction: OK')
}

// Corrupt document fails loud instead of silently resetting.
{
  writeFileSync(file, '{ not json', 'utf8')
  let threw = false
  try {
    const ctx = new Context()
    new MemoryFile(ctx, { root })
    await dispose(ctx)
  } catch { threw = true }
  assert(threw, 'corrupt document rejected at construction')
  writeFileSync(file, JSON.stringify({ version: 999, nextId: 1, entries: [] }), 'utf8')
  threw = false
  try {
    const ctx = new Context()
    new MemoryFile(ctx, { root })
    await dispose(ctx)
  } catch { threw = true }
  assert(threw, 'wrong document version rejected')
  console.log('corrupt-document fail-loud: OK')
}

rmSync(root, { recursive: true, force: true })
console.log('provider smoke: all assertions passed')
