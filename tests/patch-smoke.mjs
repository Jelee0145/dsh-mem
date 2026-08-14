// Patch-layer smoke: apply the bundle's cordis.patch.yml with the same
// applyEntryPatches the dsh boot uses, over an empty base and over a
// web-app-like base, and assert the composed rows. Runs under plain Node
// against the global dsh installation's built include package.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'

// The Loader evaluates `!!js` expressions at mount; for composition checks we
// only need the tag to parse, keeping the raw expression text as the value.
const jsTag = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: () => true,
  construct: data => data,
})
const jsYaml = yaml.DEFAULT_SCHEMA.extend([jsTag])

const patchFile = resolve(import.meta.dirname, '..', 'cordis.patch.yml')
const patch = yaml.load(readFileSync(patchFile, 'utf8'), { schema: jsYaml })
const warnings = []
const warn = (message, ...args) => warnings.push(String(message).replaceAll('%C', String(args[0])))

const rows = applyEntryPatches([], patch, warn)
if (rows.length !== 2) throw new Error(`expected 2 inserted rows, got ${rows.length}`)
const byId = new Map(rows.map(row => [row.id, row]))
const provider = byId.get('memory')
const tool = byId.get('tool-memory')
if (!provider || provider.name !== 'dsh-mem/provider') throw new Error('missing or wrong memory provider row')
if (!tool || tool.name !== 'dsh-mem/tool') throw new Error('missing or wrong tool-memory row')
if (warnings.length > 0) throw new Error(`unexpected patch warnings: ${warnings.join('; ')}`)
console.log('patch over empty base: OK ->', rows.map(row => `${row.id} (${row.name})`).join(', '))

// A web-app-like base already mounts rows with unrelated ids; our insert must
// not collide with them or re-target any existing row.
const webBase = [
  { id: 'storage', name: '@deepseek-ai/dsh-storage' },
  { id: 'storage-json', name: '@deepseek-ai/dsh-storage-json' },
  { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo' },
]
const composed = applyEntryPatches(webBase, patch, warn)
if (composed.length !== 5) throw new Error(`expected 5 composed rows, got ${composed.length}`)
const ids = composed.map(row => row.id)
if (ids.filter(id => id === 'memory').length !== 1 || ids.filter(id => id === 'tool-memory').length !== 1) {
  throw new Error(`our rows duplicated or missing: ${ids.join(', ')}`)
}
for (const original of webBase) {
  const kept = composed.find(row => row.id === original.id)
  if (kept?.name !== original.name) throw new Error(`web base row ${original.id} was disturbed`)
}
if (warnings.length > 0) throw new Error(`unexpected warnings over web base: ${warnings.join('; ')}`)
console.log('patch over web-like base: OK (no collisions, existing rows untouched)')
