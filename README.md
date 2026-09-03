# OMAR for VS Code

Language support and **Mission Control** for the
[OMAR](https://github.com/omar-os/omar) runtime: syntax highlighting,
compilation, and a live, inspectable picture of what a deployment is doing.

![Mission Control: deployments, a live topology, teams, an inspector, and artifacts](docs/images/mission-control.png)

## Mission Control

Open the OMAR activity bar and you see what the runtime is running. The
sidebar holds one view for now, **Deployment**; the topology and the
assistant have panels of their own.

- **Assistant** (in the panel, next to the terminal; `OMAR: Open Assistant`)
  — the thread with the executive assistant, the same one the web Mission
  Control talks to. Ask for a workflow and it proposes a complete program
  the daemon has compiled; preview it in the Topology panel, open its
  source, deploy it. Ask about the selected deployment and the message
  carries the runtime's own account of it — each reaction's state, the port
  values, the last events, the guarantees, where the files are — because
  the runtime gives the assistant no other way to see a run. The header
  names the backend the assistant runs on and lets you move it to another
  (which restarts it); **Terminal** opens the assistant's own tmux pane.
- **Deployment** — the selected run: status, team, revision, timing, the
  counts, logical time, lag, the guarantees at a glance, and whether the
  picture is **LIVE**, **STALE** (the event stream broke; what is shown is
  what was last known) or **FINAL**. `OMAR: Select Deployment` picks another;
  the newest is selected on its own, and a run you start is selected as it
  starts.
- **Topology** panel (`OMAR: Open Topology`, or the diagram button on an
  `.omar` editor) — one picture, drawn by the very component the web
  Mission Control draws with (vendored from the omar repository and bundled
  into the webview): teams as containers, ports on their boundary, reactions
  as chevrons, timers as clocks. It shows the compiled picture of the
  `.omar` file you are editing, redrawn on save, and switches itself to the
  live picture when the selected deployment goes live; a Live / file toggle
  in its header brings either back. Pan, zoom, click anything to select it.

The Teams, Inspector, Artifacts, Guarantees and Events views are out of the
sidebar for now; what they read still feeds the summary, the topology and
the assistant's context.

Controls are the runtime's own: **Run Program** starts the open `.omar` file
through the daemon (asking for each open input); **Stop** goes through the
`omar` CLI. Pause, resume and approvals are not offered, because
the runtime has no such operation. Nothing is cached across a fetch and
nothing is invented: the extension shows what the runtime says, and says what
it does not know.

### Install

Build the extension package and install it into VS Code:

```bash
git clone --recurse-submodules git@github.com:omar-os/omar-vscode.git
cd omar-vscode
npm install
npm run package                                   # writes omar-vscode-<version>.vsix
code --install-extension omar-vscode-*.vsix       # or: Extensions view › … › Install from VSIX
```

Every CI run on `main` also attaches the `.vsix` as a workflow artifact. To
develop instead, open the folder in VS Code and press <kbd>F5</kbd>.

### Try it

Install `omar` (`brew install omar-os/omar/omar`, or the install script in
its README) so it is on `PATH`, together with `omarc`. Open the OMAR
activity bar: when nothing answers at `omar.runtimeUrl` the extension starts
`omar serve` itself, as a child that stops with the window, and connects
once it answers. Its output is in the **OMAR Runtime** output channel. A
daemon that was already running is used as it is and left alone.

The runtime the extension starts brings the assistant with it (on whatever
backend `omar` is configured for: Claude Code, Codex, …), so the Assistant
view answers at once. A runtime started by hand with `--no-ea` has none;
the view says so, and offers to restart the runtime with one when the
extension started it.

Then open `examples/Pipeline.omar`, run **OMAR: Run Program**
(input `first.inp` = `1`, real time), and watch the four stages go idle →
running → completed over about eight seconds in the panel, the Teams view
and the status bar. Click a stage to inspect it; open its log under
Artifacts when the run is over.

### Remote SSH

The extension is a workspace extension: under Remote SSH it runs on the
remote host, next to the daemon, and reads the daemon's data directory from
there. Point `omar.runtimeUrl` at the daemon as the remote sees it (the
default, `http://127.0.0.1:7340`, is right when they share a machine) and
artifacts open through VS Code's own remote file access. See
[docs/mission-control.md](docs/mission-control.md) for what the runtime
exposes, what it does not, and how the extension is put together.

## Language support

**Highlights `.omar` files.** Teams and their agents, ports and timers, prompt
triggers and effects, connections and their delays, `main` blocks and the teams
they instantiate. `$(port)` inside a prompt body is marked as the interpolation
it is rather than as more string.

**Compiles.** On save, the program is checked and problems reported as
diagnostics; `OMAR: Compile to bytecode` writes the compiled picture beside
the source. The connected runtime does the compiling (`POST
/v1/programs/check`), so nothing else needs to be installed; without a
runtime, `omarc` on `PATH` or at `omar.compilerPath` is run directly. Either
way it is the real compiler, so nothing passes here and is refused later.

**Outlines a file.** The Explorer's Outline lists each team and main block
with its ports, timers, prompts and instances, and jumps to them.

**Draws a file.** `OMAR: Show Topology` puts the compiled picture of the
program in the Topology panel, the daemon's own preview when one is
connected, without running anything.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `omar.runtimeUrl` | `http://127.0.0.1:7340` | Where `omar serve` listens, as the extension host sees it. |
| `omar.autoStartRuntime` | `true` | Start `omar serve` when nothing answers at a loopback address. |
| `omar.serveArguments` | `["--restart-ea"]` | Arguments for the `omar serve` the extension starts; the assistant is started fresh so it answers through this runtime. |
| `omar.attachDeploymentContext` | `true` | Put the runtime's account of the selected deployment in front of each message to the assistant. |
| `omar.dataDir` | `~/.omar` | The runtime's data directory on the extension host; artifacts are read from it. |
| `omar.cliPath` | `omar` | Used to start the runtime and to stop a deployment. |
| `omar.compilerPath` | `omarc` | Resolved on `PATH` when it is a bare name; a path is handed to the started runtime as `OMARC_BIN`. |
| `omar.compileOnSave` | `true` | Report problems as diagnostics on save. |

## Diagnostics are positioned by guessing

`omarc` reports `<path>: <message>` and nothing else — no line, no column. So a
diagnostic's position is recovered from the message: most of them name the thing
they are complaining about in quotes, and that name is looked for in the source.
A qualified name like `flow.topic` is tried by its last segment too, because
that is what the source says inside the team that declares it.

It is a guess. When there is nothing to find, the first line carries the message,
which is at least honest about not knowing. Positions in the compiler's output
would make this exact, and that is where the fix belongs.

## Building it

```bash
git submodule update --init   # the web app's diagram, vendored from omar
npm install
npm run build                 # tsc, then the webview bundle into media/webview/
npm test              # skips the compiler tests when omarc is not built
npm run lint
npm run test:vscode   # a real VS Code against a stub runtime; needs a display or xvfb-run
```

Press <kbd>F5</kbd> in VS Code to launch a window with the extension loaded, and
open `examples/Pipeline.omar`.

The tests that use the real compiler find it at `../omar/lang/.lake/build/bin/omarc`
or wherever `OMARC_BIN` points, and skip themselves when it is not there. CI runs
them in a job of their own, because checking how the compiler's errors are parsed
against strings written here is not the same as checking it against the compiler.
CI also starts a real VS Code under `xvfb` with a stub runtime, and checks
activation, the commands, a picture going live, inspection, artifacts opening,
and a run being started.

## Not yet

- **No language server.** No completion, no go-to-definition, no hover.
- **No proofs.** The guarantee model carries Lean proof evidence scoped to a
  program revision, and marks a proof for another revision stale, but the
  runtime produces none yet.
- **No runtime-published guarantees.** The Guarantees view is a catalogue of
  what the runtime's semantics establish, and says so.
- **No formatter.**
