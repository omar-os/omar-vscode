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

## The diagram is the web app's

The topology panel renders `DiagramCanvas` from the web app — the same
React component `omar serve --ui` draws, over the same ELK layout, with the
same stylesheet — not a drawing of the extension's own. The omar repository
is vendored as a git submodule at `vendor/omar`, pinned to a commit, and
`build/webview.mjs` bundles `webview/main.tsx` (which mounts the component
and relays messages) with React and ELK into `media/webview/diagram.js`,
cutting the diagram's section of `web/app/globals.css` into
`media/webview/diagram.css`. A moved marker in that stylesheet fails the
build rather than shipping a diagram without its styles.

The extension posts the whole state to the page on every change — snapshot,
selection (by component name, which is how the diagram selects), highlight
(by id), and the header's words — and the page hands the snapshot to the
component. Clicks come back as component names and are mapped to ids for
the inspector (`src/topology/components.ts`). After ELK settles, the page
reports how many nodes it drew, which is what the headless VS Code run
checks.

There is one panel (`src/topology/TopologyPanel.ts`) and three pictures it
can show, in this order of precedence: a proposal being previewed; the live
picture of the selected deployment; the compiled picture of an `.omar` file
— the active editor's, or the one `OMAR: Show Topology` was run on, redrawn
on save, compiled by the connected daemon (`POST /v1/programs/check`) or by
`omarc` read into the same shape (`src/diagram.ts`, tested to equal the
daemon's preview). When a deployment goes live the panel switches to it;
the header's toggle brings the file back and Live returns. The canvas is
light here where the web app's is dark, so the dark ports read.

To move to a newer web diagram: `git -C vendor/omar checkout <commit>`,
`npm run build`, and commit the submodule pointer. Clone with
`--recurse-submodules`, or run `git submodule update --init`.

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

## The assistant (`src/chat/`, `src/client/chat.ts`)

The daemon's chat: `POST /v1/chat` `{text, selection}` (202 with the
operator's message; 502 in the daemon's words when no assistant is
running), `GET /v1/chat/events` (SSE, `message` and `design_proposed`
events; the whole backlog is replayed on every connection), `GET /v1/agent`
(the backend the assistant runs on), `POST /v1/agent/backend` (relaunch it).
A proposal is an assistant message with `design: {program, inputs,
preview}`; the daemon compiled the program before relaying it.

`Thread` (no vscode import) places each message by sequence so a replay
changes nothing, holds `drafting` from the operator's message until an
assistant message that is not `progress`, and reconnects a broken stream.
`ChatView` mounts the web app's `ChatMessage` component (react-markdown, so
model output is never injected as HTML) in a webview view in its own panel
container, so the thread has the room a conversation needs; the composer,
selection bar and proposal buttons are the studio's chrome, kept to what the
extension has a use for.

**What the assistant can see.** A chat message reaches the assistant as its
text plus the selected component names, and no tool of the assistant's reads
a run. So, with `omar.attachDeploymentContext` on and a deployment selected,
`deploymentContext` puts in front of the operator's words a bounded block
built only from the runtime's own answers: status and elapsed time, each
reaction's state and agent, the port values, the last dozen events, the
guarantees, and the files on this machine. It is marked as the runtime's,
not the operator's, and the view shows only the operator's words. That is
how the assistant "monitors" a deployment today; a channel that pushes run
events to the assistant belongs in the runtime.

**Proposals.** Preview shows the compiled preview in the diagram panel, in
place of the run, marked PROPOSAL until cleared. Open program opens the
source as an `.omar` document. Deploy asks for any open input the assistant
left out, then `POST /v1/runs` with the assistant's program and inputs, and
selects the run. The operator deploys; the assistant never does.

**Backend and pane.** The header lists the backends the daemon offers
(`GET /v1/agent`); choosing another restarts the assistant on it
(`POST /v1/agent/backend`). Terminal opens `tmux attach-session -t
<prefix>ea-<ea>` in a VS Code terminal, on the extension host, which under
Remote SSH is where the assistant is.

**No assistant.** A daemon started with `--no-ea` refuses chat with "the
executive assistant is not running"; the view shows that and, when the
extension started the runtime, offers to restart it with one. A daemon that
found an assistant launched before it prints that it "cannot reply or
propose designs"; the launcher relays the line and the view offers to
restart the assistant (`POST /v1/agent/backend`), which loses its session.

## Starting the runtime

`src/runtime/serve.ts` and `RuntimeLauncher.ts`. When a connect attempt
finds nothing answering at a loopback `omar.runtimeUrl`, the session asks the
launcher for a daemon: `omar serve --address host:port` plus
`omar.serveArguments` (default `--restart-ea`: the assistant is started fresh, since one from an earlier runtime holds that runtime's token and cannot answer through this one), spawned as a child of the
extension host with `OMARC_BIN` set when `omar.compilerPath` is a path. The
session shows **starting** until `/health` answers (20s at most), then
connects. Output goes to the **OMAR Runtime** output channel. The poll tries
again no more than once a half minute if the daemon goes away, so a daemon
that will not start is not started in a loop. A daemon that was already
answering is never touched, and only one the extension started is stopped —
on `OMAR: Stop Runtime`, on deactivation, and when the host process exits.
Not loopback, or `omar.autoStartRuntime` off: nothing is started and the
view says what to do.

## Operator controls and capabilities

Every control is a call the runtime itself authorises; the extension decides
nothing.

- **Run program**: `POST /v1/programs/check` on the open `.omar` file, a
  prompt per open input typed by its port, then `POST /v1/runs`. The daemon's
  refusal is shown in its own words.
- **Stop deployment**: `omar stop <team>` through the CLI (`omar.cliPath`),
  which writes the stop request the runner reads. The daemon has no HTTP
  route for this. Not `omar kill`: for a run started through the daemon the
  recorded runner pid is the daemon's own, so a kill takes the daemon down.
- Not offered, because the runtime has no such operation: pause, resume,
  retry, approve, reject.

`src/runtime/capabilities.ts` finds out what a connection can do — the
daemon answered, the CLI runs, the data directory is readable — and controls
the runtime cannot honour are not shown. Hiding a button grants nothing: the
runtime refuses what it refuses either way.

**Read only** is a property of what a connection reaches, not a policy. The
daemon's API has no permission mode, so the extension cannot offer one. But
`OMAR: Follow a Diagram Server` connects to one run's diagram server alone
(as `omar run --diagram-server` exposes it), and that surface has no way to
change the run; the session is then read-only by construction and says so
in the status bar and the Deployment view.

## Remote SSH

`package.json` declares `"extensionKind": ["workspace"]`, so under Remote SSH
the extension host — and with it every `fetch`, every file read, and the
`omar` CLI call — runs on the remote machine, where the daemon is. Nothing in
the extension touches the local machine's disk or network: URLs are the
daemon's loopback address as the remote sees it, artifact paths are read
through `vscode.workspace.fs` and opened with `vscode.open`, and `~` in
`omar.dataDir` is the remote user's home. The one thing to set is nothing,
when the daemon listens on its default address on the same host.

Not verified in CI: the headless run is a local VS Code. Verified by
construction and by the design above; a manual check is to connect to a host
running `omar serve`, open the OMAR activity bar, and confirm the run list,
a live picture, and an artifact opening.

## Testing

- `node --test test/*.test.mjs` — the pure parts: protocol parsing against
  snapshots captured from real runs (`test/fixtures/*.v1.json`), SSE
  chunking, the reconnection scenario (disconnect, the run moves on,
  reconnect, no repeated or backwards transition), layout containment and
  non-overlap, inspection rows, artifact listing on a fake disk, guarantees,
  input parsing.
- `xvfb-run -a node test/vscode/run.mjs` — a real VS Code, the extension
  loaded, a stub runtime (`test/vscode/stub-runtime.js`) serving a captured
  snapshot and an SSE event: activation, commands, unreachable reported, a
  picture going live with the streamed transition, the panel drawn, a node
  and a guarantee inspected, highlight on and off, artifacts listed and a
  log opened in an editor, a run started with mocked prompts, and the
  diagram-only read-only connection.
- Manual, against a real daemon: `OMAR_SUITE=screenshot.js` or
  `OMAR_SUITE=stop-check.js` with `test/vscode/manual-run.mjs`.

## What the runtime does not expose yet

Kept out of the UI rather than faked:

- pause and resume (no such lifecycle state);
- approvals;
- sandboxes (agents share the daemon's working directory);
- a permission mode (the API has no auth surface; read-only exists only as
  the diagram-server-only connection above);
- guarantees as a first-class list (the view shows a catalogue, and says so);
- proofs (the Lean code is the compiler, not theorems).

Where the extension shows any of these it says what it does not know.
