# dsh-mem — cross-session memory for DeepSeek Harness

English | [中文](README.zh.md)

An out-of-tree **bundle** plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) that implements a complete **capability seam** — Service Definition + Service Provider + Consumer. It gives agents durable long-term memory shared across every session: the `memory_save` / `memory_recall` / `memory_forget` / `memory_list` tools persist facts, preferences, and decisions to `$DSH_HOME/memory/memory.json`.

## Install

Install from the **npm registry** (published as `dsh-mem`):

```sh
dsh plugin --profile <name> add dsh-mem
```

> `dsh plugin add` is the dsh way to install a plugin: it resolves the package from npm (via pnpm) into the profile and registers its bundle layer. Do **not** use `npm install dsh-mem` — that installs the package as a plain dependency without activating any profile layer.

From git instead (runs the package's self-contained `prepare` build; the first install asks you to allow the build in the profile's `pnpm-workspace.yaml`):

```sh
dsh plugin --profile demo add github:Jelee0145/dsh-mem
```

Or from a local checkout:

```sh
dsh plugin --profile demo add ./dsh-memory
```

Verify the composed layer without booting, then boot:

```sh
dsh --profile demo --dump-config   # expect a "# == dsh-mem" layer with memory / tool-memory rows
dsh --profile demo                 # new sessions can call the memory_* tools
```

Uninstall: `dsh plugin --profile demo remove dsh-mem`.

To disable without uninstalling (hot-reloaded, no restart), disable the rows in the profile's own `cordis.patch.yml`:

```yaml
- id: memory
  disabled: true
- id: tool-memory
  disabled: true
```

Memory data is never touched by uninstall; it lives in `$DSH_HOME/memory/memory.json` (default `~/.dsh/memory/`). Back it up or delete it separately if you want to clear it.

## The capability seam

| Role | Module | Mounted row | Notes |
|---|---|---|---|
| Service Definition | `src/memory.ts` (`dsh-mem/memory`) | — | abstract `MemoryService` declaring the `ctx.memory` contract and types; loading it directly fails loud |
| Service Provider | `src/provider.ts` (`dsh-mem/provider`) | `memory` | `MemoryFile extends MemoryService`; atomic JSON-file persistence |
| Consumer | `src/tool.ts` (`dsh-mem/tool`) | `tool-memory` | function plugin registering the four tools; resolves the service via `ctx.get('memory')` per call |

This mirrors the in-repo `ctx.jobs` seam (Definition in `packages/jobs/jobs`, provider in `jobs-local`, consumer in `tool-jobs`).

## Repository layout

```
dsh-mem/
├── package.json          # declares dsh.bundle.patch → ./cordis.patch.yml
├── cordis.patch.yml      # bundle layer: inserts memory + tool-memory rows
├── tsconfig.json         # standalone build config (types from npm deps)
├── tsconfig.check.json   # local typecheck against a dsh checkout (optional)
├── README.md             # this file
├── README.zh.md
└── src/
    ├── memory.ts         # Service Definition (default-exports the service class)
    ├── provider.ts       # Provider (default-exports the service class + static Config)
    └── tool.ts           # Consumer (named exports only: name/inject/Config/apply)
```

## Build

```sh
npm install      # pulls the dependencies (runtime and compile-time types both come from npm)
npm run build    # tsc emits lib/ (same as the prepare script, run automatically on git installs)
```

Working beside a dsh checkout, `dsh-memory/node_modules/@deepseek-ai/*` can be junctioned to the repo packages so local typechecking works without `npm install`:

```sh
pnpm exec tsc -p dsh-memory/tsconfig.check.json   # typecheck only (no emit)
pnpm exec tsc -p dsh-memory/tsconfig.json         # emit lib/
```

Smoke tests (build first):

```sh
node dsh-memory/tests/patch-smoke.mjs     # patch composition over empty and web-like bases
node dsh-memory/tests/provider-smoke.mjs  # provider round-trip: persistence/search/bounds/corruption
```

## Memory entries and storage

Each note is an immutable record of 5–6 fields:

| Field | Source | Meaning |
|---|---|---|
| `id` | provider | `m-<n>`; keeps counting across restarts |
| `content` | model | the durable fact as a complete standalone sentence or short paragraph |
| `tags` | model | keywords for filtering; empty strings are dropped |
| `project` | model | the owning project/workspace (e.g. repository name); absent means a global fact that applies everywhere |
| `createdAt` / `updatedAt` | provider, stamped automatically | epoch milliseconds; the model never supplies the timestamp, and the tool output includes a human-readable `createdAtText` (ISO 8601) |

Stored at `$DSH_HOME/memory/memory.json` (default `~/.dsh/memory/`), e.g.:

```json
{
  "version": 1,
  "nextId": 3,
  "entries": [
    {
      "id": "m-1",
      "content": "Project X uses pnpm workspaces and rejects yarn.",
      "tags": ["project", "tooling"],
      "project": "project-x",
      "createdAt": 1753000000000,
      "updatedAt": 1753000000000
    }
  ]
}
```

## Design notes

- **Why the provider owns a JSON file instead of the `ctx.storage` seam**: dsh's storage rows (`storage` / `storage-json` / `storage-domain`) are mounted by the `dsh-web-app` bundle, not by `dsh-base`; an out-of-tree bundle that inserts the same row ids would duplicate them in web profiles, while omitting them leaves `ctx.storage` absent in headless ones. One self-managed JSON document keeps this plugin zero-dependency on every profile (web / headless / custom). To swap in a `ctx.storage.domain` backend, subclass `MemoryService` and point the `memory` row at it — the tools and contract stay untouched. That is the point of the seam.
- **Durability**: every mutation writes memory first, then commits via `writeFileAtomic` (temp file + atomic rename, `0o600`/`0o700`); nothing is visible before it is durable. All operations (reads included) serialize on one in-process queue, so a read never observes an uncommitted write. Concurrent dsh processes sharing one `root` are not supported.
- **Document format**: `{ version, nextId, entries }`; `nextId` is persisted so ids stay unique across restarts. A wrong version or a corrupt file fails loud at load — never a silent reset.
- **Model tool contract**: search is a case-insensitive substring match on content plus exact tag match; an empty query returns the newest notes. `recall`/`list` accept a `project` filter (case-insensitive exact; global notes never match). Result caps are clamped to the deployment's `maxRecallLimit`. Oversized content, illegal limits, and malformed ids are rejected at the tool boundary. When to save and what to save is guided by the tool descriptions: project-specific facts must carry `project`; global facts (e.g. user preferences) omit it; timestamps are provider-stamped and cannot be forged by the model.
- **Dependencies**: `@deepseek-ai/cordis@^4.0.1` and `@deepseek-ai/dsh-*@^0.1.0-rc.6` are published on npm; `dsh plugin add` installs them into the profile.

## Extending

- **Swap the provider**: subclass `MemoryService`, then point the `memory` row's `name` at your class in `cordis.patch.yml`.
- **Add a human command**: inject `ctx.commands` (present in base) and register a `/memory`-style slash command.
- **Inject memory into a turn**: in an `agent/pre-step` or `tools/post-execute` listener, call `agent.inject()` with relevant notes for the next request.
- **Move the storage root**: override the whole `memory` row's `config.root` in the profile's `cordis.patch.yml` (a patch replaces the whole config, so restate the keys you keep).

## Known limitations

- Single-process writer: no cross-process lock when two dsh processes share one `root`.
- No edit API: `updatedAt` equals `createdAt` today; to overwrite a fact, `memory_forget` then `memory_save`.
- No structured schema: content is free text; for fielded facts, agree on a fixed text format with the model.
