# Mission Control

The extension is a client of the OMAR runtime. It shows what the runtime says
and never decides anything the runtime has not: no scheduling, no guarantee
semantics, no state of its own that outlives a fetch.

## What the runtime exposes

Two servers, both loopback-only HTTP, both existing before this extension.

**`omar serve`** (default `http://127.0.0.1:7340`) admits programs and
supervises runs. A run is what the product spec calls a deployment.

| Route | Gives |
| --- | --- |
| `GET /health` | `{status, protocol_version}` |
| `GET /v1/runs` | every run this daemon has started, newest last |
| `GET /v1/runs/{id}` | one run: `status`, `diagram_address`, `started_at`, `finished_at`, `error` |
| `POST /v1/runs` | start a run from program source and inputs |

Run status: `starting`, `running`, `completed`, `stopped`, `failed`. The list
is in memory; a restarted daemon has forgotten its runs.

**The diagram server**, one per run, at the run's `diagram_address`. It exists
only while the run does.

| Route | Gives |
| --- | --- |
| `GET /v1/diagram` | the topology and its state, stamped with a `sequence` |
| `GET /v1/events` | server-sent events from now on; nothing is replayed |

Event kinds: `run_started`, `tag_advanced`, `reaction_started`,
`reaction_completed`, `run_completed`, `run_failed`. Each carries the
`sequence` the snapshot would have after it.

Ids are namespaced: `instance::`, `agent::`, `port::`, `timer::`,
`reaction::`. A reaction's `agent`, `triggers` and `effects` are ids; an
agent's `instance` is a name.

## The client (`src/client/`)

- `protocol.ts` — the wire shapes, validators that refuse a protocol version
  they do not speak, normalisers that fill what an older runtime omits, and
  `applyDiagramEvent`, which folds an event into a snapshot.
- `sse.ts` — server-sent events parsed by hand; the extension host has `fetch`
  but no `EventSource`.
- `OmarClient.ts` — `ServeClient` and `DiagramClient`. Nothing cached.
- `follow.ts` — `followRun`: snapshot, then stream; a sequence gap re-fetches
  the snapshot rather than guessing; a broken stream marks the picture
  **stale** and asks the daemon whether the run ended before trying again.

`connection` is one of `connecting`, `live`, `stale`, `final`. A view must
show it. Cached state is never presented as live.

## Artifacts (`src/artifacts/`)

The daemon serves none of a run's files. It writes them under its data
directory (`omar.dataDir`, default `~/.omar`, resolved on the extension host —
the remote machine under Remote SSH):

    <data>/ea/<ea>/serve/<run_id>/program.omar     the program as submitted
    <data>/ea/<ea>/topologies/<team>/
        deployment.json  outputs.json  state.json
        logs/<agent>.txt          the agent's pane, captured at the end
        agents/<agent>/system.md  the agent's standing instructions

`listArtifacts` reads these and names the agent a log or instruction file
came from. The topology directory is per team, so a rerun overwrites it; the
view says so when the directory's record is newer than the run shown. Files
open with `vscode.open`, never a viewer of the extension's own.

## Guarantees (`src/model/guarantees.ts`)

The runtime does not publish guarantees, so the Guarantees view shows a
catalogue of what protocol-1 runtime semantics establish, each entry naming
the mechanism and the parts of the picture it covers, and a footnote says so.
Statuses are kept apart: **ENFORCED** (the runtime prevents violation),
**MONITORED** (it detects and reports), **UNCHECKED** (nothing establishes it).
Nothing is **PROVEN**, because nothing is.

| Guarantee | Status | Mechanism |
| --- | --- | --- |
| Connections are typed | ENFORCED | `verify()` at admission |
| No instantaneous cycle | ENFORCED | `reject_causality_loops()` at admission |
| Agents write only declared effects | ENFORCED | `omar_set_port` refuses others |
| Effect contracts are honoured | ENFORCED | `validate_contract()` at completion |
| Deadlines are kept | MONITORED | `expired()`; the runtime cannot make an agent answer |
| Teams are isolated | UNCHECKED | shared working directory, permission checks off |
| The run terminates | UNCHECKED | nothing checks |

The shapes are the ones a runtime-supplied list would have: `evidence` may
be a `lean-proof` with a `workflowRevision`, and `withRevision` marks such a
guarantee **STALE** when the program's revision (SHA-256 of the source, first
seven digits, shown in the Deployment view) differs. "Show on topology"
brings a guarantee's subjects forward and dims the rest.

## Events

The follower keeps every event it applied, with a note where the stream broke
or a gap was filled from a snapshot. The Events view lists them newest
first; a reaction's event inspects the reaction.

## What the runtime does not expose yet

Kept out of the UI rather than faked:

- pause and resume (no such lifecycle state);
- approvals;
- sandboxes (agents share the daemon's working directory);
- a read-only or permission mode (the API has no auth surface);
- guarantees as a first-class list (the view shows a catalogue, and says so);
- proofs (the Lean code is the compiler, not theorems).

Where the extension shows any of these it says what it does not know.
