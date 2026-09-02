import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { DiagramCanvas } from "../vendor/omar/web/app/diagram/diagram-canvas";
import type { DiagramSnapshot } from "../vendor/omar/web/app/lib/protocol";

/**
 * The diagram in the webview: the web app's own component, mounted as is.
 *
 * Nothing about the drawing lives here. The extension posts the whole state
 * on every change and this page hands the snapshot to `DiagramCanvas`, the
 * same component `omar serve --ui` renders, from the same checkout. Around it
 * sits only what the web app's studio chrome would say: whose picture this
 * is, and whether it is live.
 */

type State = {
  snapshot: DiagramSnapshot | null;
  /** Component names, as the diagram selects them. */
  selection: string[];
  /** Ids to draw at the tag; null draws everything alike. */
  highlight: string[] | null;
  team: string;
  status: string;
  /** live, stale, final, connecting, compiled, proposal — or null when nothing is shown. */
  connection: string | null;
  detail: string | null;
  tag: string;
  lag: string;
  /** What to say when there is no snapshot. */
  empty: string | null;
};

type Outgoing =
  | { kind: "ready" }
  | { kind: "toggle"; component: string }
  | { kind: "drawn"; nodes: number; error: string | null };

const vscode = acquireVsCodeApi<State>();

function post(message: Outgoing): void {
  vscode.postMessage(message);
}

function App() {
  const [state, setState] = useState<State | null>(() => vscode.getState() ?? null);
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent<{ kind?: string; state?: State }>) => {
      if (event.data?.kind === "state" && event.data.state) {
        vscode.setState(event.data.state);
        setState(event.data.state);
      }
    };
    window.addEventListener("message", onMessage);
    post({ kind: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Report what got drawn, so a test outside the webview can know the
  // component rendered rather than merely mounted. ELK lays out
  // asynchronously, so the count is read once it settles.
  useEffect(() => {
    if (!state?.snapshot) return;
    let attempts = 0;
    let previous = -1;
    let stable = 0;
    const timer = setInterval(() => {
      const host = hostRef.current;
      if (!host) return;
      const error = host.querySelector(".diagram-error")?.textContent ?? null;
      const nodes = host.querySelectorAll(".omar-reaction-body, .omar-port-group, .omar-timer-face").length;
      attempts += 1;
      stable = nodes === previous ? stable + 1 : 0;
      previous = nodes;
      if ((nodes > 0 && stable >= 5) || error || attempts > 60) {
        clearInterval(timer);
        post({ kind: "drawn", nodes, error });
      }
    }, 100);
    return () => clearInterval(timer);
  }, [state?.snapshot]);

  if (!state) {
    return <p className="empty">Select a deployment to see its topology.</p>;
  }
  const connection = state.connection ?? "connecting";
  return (
    <>
      <header>
        <b>{state.team || "(unnamed)"}</b>
        <span className={`pill ${connection}`}>{connection.toUpperCase()}</span>
        {state.status ? <span className="muted">{state.status.toUpperCase()}</span> : null}
        {state.tag ? <span className="muted">t = {state.tag}</span> : null}
        {state.lag && state.lag !== "—" ? <span className="muted">lag {state.lag}</span> : null}
      </header>
      {connection === "stale" ? (
        <div className="banner">
          <b>DISPLAYED STATE MAY BE STALE</b>
          <span>{state.detail ?? ""}</span>
        </div>
      ) : null}
      <div className="diagram-panel" ref={hostRef}>
        {state.snapshot ? (
          <DiagramCanvas
            snapshot={state.snapshot}
            selection={state.selection}
            onToggleComponent={(component) => post({ kind: "toggle", component })}
            highlight={state.highlight ? new Set(state.highlight) : undefined}
          />
        ) : (
          <p className="empty">{state.empty ?? "No picture of this deployment."}</p>
        )}
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
