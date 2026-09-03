import { StrictMode, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Boundary } from "./boundary";

/**
 * The conversation with the assistant, in the panel, drawn the way VS Code
 * draws its own chat: on the editor's theme, a name above each turn, the
 * operator's turns in a request box, the assistant's as markdown, and a
 * rounded composer at the bottom. Every colour is a VS Code theme variable,
 * so it follows whatever theme is on. Assistant text is model output and
 * is rendered by react-markdown, which does not inject HTML. Every network
 * call is the extension host's; the page only asks.
 */

type ProposedDesign = { program: string; inputs: Record<string, unknown>; preview: { team: string } };

type Shown = {
  sequence: number;
  role: "operator" | "assistant";
  text: string;
  progress: boolean;
  design: ProposedDesign | null;
  selection: string[];
  contextAttached?: boolean;
};

type State = {
  messages: Shown[];
  connection: "off" | "connecting" | "live" | "stale";
  drafting: boolean;
  problem: string | null;
  /** The backend the assistant runs on, or null when unknown. */
  assistant: string | null;
  /** The backends it could run on instead. */
  backends: string[];
  /** Component names the next message will carry. */
  selection: string[];
  /** Whether a deployment is selected, so context can be attached. */
  deployment: string | null;
  attachContext: boolean;
  /** Something the thread cannot do without the operator, with a way to fix it. */
  notice: { text: string; action: string | null; label: string | null } | null;
  /** The proposal being previewed in the diagram panel, by sequence. */
  previewing: number | null;
};

type Outgoing =
  | { kind: "ready" }
  | { kind: "send"; text: string }
  | { kind: "attachContext"; value: boolean }
  | { kind: "clearSelection" }
  | { kind: "preview"; sequence: number }
  | { kind: "openProgram"; sequence: number }
  | { kind: "deploy"; sequence: number }
  | { kind: "action"; action: string }
  | { kind: "rendered"; messages: number };

const vscode = acquireVsCodeApi();
const post = (message: Outgoing) => vscode.postMessage(message);

function Turn({ message, previewing }: { message: Shown; previewing: number | null }) {
  const operator = message.role === "operator";
  return (
    <div className={`turn ${operator ? "request" : "response"}${message.progress ? " progress" : ""}`}>
      <div className="who">
        <span className={`avatar ${operator ? "you" : "ea"}`}>{operator ? "Y" : "EA"}</span>
        <span className="name">{operator ? "You" : "Assistant"}</span>
        {message.selection.length > 0 ? <span className="chip" title="Selected when this was sent">{message.selection.join(", ")}</span> : null}
        {message.contextAttached ? <span className="chip muted" title="The runtime's account of the deployment went with this message">deployment context</span> : null}
      </div>
      {operator ? (
        <div className="request-body">{message.text}</div>
      ) : (
        <div className="response-body">
          <Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown>
        </div>
      )}
      {message.design ? (
        <div className="actions">
          <span className="muted">Proposal · {message.design.preview.team}</span>
          <button type="button" className="secondary" onClick={() => post({ kind: "preview", sequence: message.sequence })}>
            {previewing === message.sequence ? "Previewing" : "Preview"}
          </button>
          <button type="button" className="secondary" onClick={() => post({ kind: "openProgram", sequence: message.sequence })}>
            Open program
          </button>
          <button type="button" className="primary" onClick={() => post({ kind: "deploy", sequence: message.sequence })}>
            Deploy…
          </button>
        </div>
      ) : null}
    </div>
  );
}

function App() {
  // Not restored from what VS Code persisted: a page from an older build
  // would restore an older shape, and the extension posts the whole state
  // as soon as the page says it is ready.
  const [state, setState] = useState<State | null>(null);
  const [draft, setDraft] = useState("");
  const threadRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent<{ kind?: string; state?: State }>) => {
      if (event.data?.kind === "state" && event.data.state) setState(event.data.state);
    };
    window.addEventListener("message", onMessage);
    post({ kind: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
    if (state) post({ kind: "rendered", messages: state.messages.length });
  }, [state?.messages.length, state?.drafting]);

  if (!state) return <p className="empty">Connecting…</p>;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || state.drafting) return;
    post({ kind: "send", text });
    setDraft("");
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <>
      <header>
        <span className={`dot ${state.connection}`} title={`Thread ${state.connection}`} />
        <b>Assistant</b>
        {state.backends.length > 0 ? (
          <select
            value={state.assistant ?? ""}
            title="Which backend the assistant runs on; changing it restarts the assistant"
            onChange={(event) => post({ kind: "action", action: `switchBackend:${event.target.value}` })}
          >
            {state.assistant && !state.backends.includes(state.assistant) ? <option value={state.assistant}>{state.assistant}</option> : null}
            {state.backends.map((backend) => (
              <option key={backend} value={backend}>
                {backend}
              </option>
            ))}
          </select>
        ) : state.assistant ? (
          <span className="muted">{state.assistant}</span>
        ) : null}
        <span className="grow" />
        {state.connection === "live" ? (
          <button type="button" className="secondary" title="Open a terminal on the assistant's tmux pane" onClick={() => post({ kind: "action", action: "attachTerminal" })}>
            Terminal
          </button>
        ) : null}
      </header>
      {state.notice ? (
        <div className="notice">
          <span>{state.notice.text}</span>
          {state.notice.action && state.notice.label ? (
            <button type="button" className="primary" onClick={() => post({ kind: "action", action: state.notice!.action! })}>
              {state.notice.label}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="thread" ref={threadRef}>
        {state.messages.length === 0 && !state.drafting ? (
          <div className="empty">
            <p>Ask the assistant for a workflow, or about the selected deployment.</p>
            <p className="muted">A proposal can be previewed in the Topology panel and deployed from here.</p>
          </div>
        ) : null}
        {state.messages.map((message) => (
          <Turn key={message.sequence} message={message} previewing={state.previewing} />
        ))}
        {state.drafting ? (
          <div className="turn response">
            <div className="who">
              <span className="avatar ea">EA</span>
              <span className="name">Assistant</span>
            </div>
            <div className="response-body muted">Working…</div>
          </div>
        ) : null}
      </div>
      {state.problem ? <div className="problem">{state.problem}</div> : null}
      <form className="composer" onSubmit={submit}>
        {state.selection.length > 0 ? (
          <div className="attachments">
            <span className="chip">
              {state.selection.join(", ")}
              <button type="button" title="Clear the selection" onClick={() => post({ kind: "clearSelection" })}>
                ×
              </button>
            </span>
          </div>
        ) : null}
        <textarea
          value={draft}
          rows={2}
          placeholder={state.deployment ? `Ask about ${state.deployment}, or for a new workflow…` : "Describe a workflow…"}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKey}
          disabled={state.connection === "off"}
        />
        <div className="toolbar">
          <label title="Send what the runtime says about the selected deployment with each message">
            <input
              type="checkbox"
              checked={state.attachContext}
              disabled={!state.deployment}
              onChange={(event) => post({ kind: "attachContext", value: event.target.checked })}
            />{" "}
            {state.deployment ? `Attach ${state.deployment}` : "No deployment selected"}
          </label>
          <span className="grow" />
          <button type="submit" className="primary send" disabled={state.drafting || !draft.trim()} title="Send (Enter)">
            Send
          </button>
        </div>
      </form>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Boundary>
      <App />
    </Boundary>
  </StrictMode>,
);
