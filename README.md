# OMAR for VS Code

Syntax highlighting, compilation, and a topology diagram for the
[OMAR](https://github.com/omar-os/omar) language.

## What it does

**Highlights `.omar` files.** Teams and their agents, ports and timers, prompt
triggers and effects, connections and their delays, `main` blocks and the teams
they instantiate. `$(port)` inside a prompt body is marked as the interpolation
it is rather than as more string.

**Compiles with `omarc`.** `OMAR: Compile to bytecode` writes the bytecode
beside the source. On save, the same compile runs to report problems as
diagnostics — the real compiler, so nothing passes here and is refused later.

**Draws the topology.** `OMAR: Show topology diagram` opens a panel beside the
editor showing what the program describes: ports, timers, reactions, and the
edges between them. Save and it redraws.

Point `omar.diagramServerUrl` at a running diagram server and the same panel
follows the run — which reaction is working, what each port carries, where
logical time has reached. Without one it keeps showing the compiled topology,
which is the honest thing: the program exists, it just is not running.

```
omar run program.omar --input request=hello --diagram-server --diagram-address 127.0.0.1:7341
```

## Settings

| Setting | Default | |
| --- | --- | --- |
| `omar.compilerPath` | `omarc` | Resolved on `PATH` when it is a bare name. |
| `omar.diagramServerUrl` | *(none)* | e.g. `http://127.0.0.1:7341`. |
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
npm install
npm run build
npm test          # skips the compiler tests when omarc is not built
npm run lint
```

Press <kbd>F5</kbd> in VS Code to launch a window with the extension loaded, and
open `examples/Review.omar`.

The tests that use the real compiler find it at `../omar/lang/.lake/build/bin/omarc`
or wherever `OMARC_BIN` points, and skip themselves when it is not there. CI runs
them in a job of their own, because checking how the compiler's errors are parsed
against strings written here is not the same as checking it against the compiler.

## Not yet

- **No language server.** No completion, no go-to-definition, no hover. The
  compiler knows the whole topology, so all three are reachable, but they want a
  server rather than a compile-per-save.
- **The diagram does not nest.** Containers are in the model; the drawing lays
  everything out in one plane, so a program that instantiates teams inside teams
  is drawn flat.
- **No formatter.**
