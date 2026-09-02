import { StrictMode, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createRoot } from "react-dom/client";

import { ChatMessage } from "../vendor/omar/web/app/chat-message";
import type { ChatMessage as ChatMessageModel } from "../vendor/omar/web/app/lib/protocol";

/**
 * The conversation with the assistant, in the sidebar.
 *
 * Messages are drawn by the web app's own component; what is around them —
 * the composer, the selection the next message will carry, the proposal
 * buttons, and whether the thread is live — is the studio's chrome, kept to
 * what the extension has a use for. Every network call is the extension
 * host's; the page only asks.
 */

type Shown = ChatMessageModel & { contextAttached?: boolean };

type State = {
  messages: Shown[];
  connection: "off" | "connecting" | "live" | "stale";
  drafting: boolean;
  problem: string | null;
  /** The backend the assistant runs on, or null when unknown. */
  assistant: string | null;
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

const vscode = acquireVsCodeApi<State>();
const post = (message: Outgoing) => vscode.postMessage(message);

function App() {
  const [state, setState] = useState<State | null>(() => vscode.getState() ?? null);
  const [draft, setDraft] = useState("");
  const threadRef = useRef<HTMLDivElement | null>(null);

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
      <header className="thread-head">
        <b>Assistant</b>
        <span className={`pill ${state.connection}`}>{state.connection.toUpperCase()}</span>
        {state.assistant ? <span className="muted">{state.assistant}</span> : null}
      </header>
      {state.notice ? (
        <div className="notice">
          <span>{state.notice.text}</span>
          {state.notice.action && state.notice.label ? (
            <button type="button" className="primary-button" onClick={() => post({ kind: "action", action: state.notice!.action! })}>
              {state.notice.label}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="messages" ref={threadRef}>
        {state.messages.length === 0 && !state.drafting ? (
          <p className="empty">Ask the assistant for a workflow, or about the selected deployment.</p>
        ) : null}
        {state.messages.map((message) => (
          <div key={message.sequence} className="turn">
            <ChatMessage message={message} />
            {message.contextAttached ? <p className="context-note">deployment context attached</p> : null}
            {message.design ? (
              <div className="proposal-actions">
                <span className="muted">Proposal: {message.design.preview.team}</span>
                <button type="button" className="secondary-button" onClick={() => post({ kind: "preview", sequence: message.sequence })}>
                  {state.previewing === message.sequence ? "Previewing" : "Preview"}
                </button>
                <button type="button" className="secondary-button" onClick={() => post({ kind: "openProgram", sequence: message.sequence })}>
                  Open program
                </button>
                <button type="button" className="primary-button" onClick={() => post({ kind: "deploy", sequence: message.sequence })}>
                  Deploy…
                </button>
              </div>
            ) : null}
          </div>
        ))}
        {state.drafting ? <p className="waiting">The assistant is working…</p> : null}
      </div>
      {state.selection.length > 0 ? (
        <div className="selection-bar">
          <span className="selection-label">{state.selection.join(", ")}</span>
          <button type="button" className="selection-clear" onClick={() => post({ kind: "clearSelection" })}>
            clear
          </button>
        </div>
      ) : null}
      {state.problem ? <p className="problem">{state.problem}</p> : null}
      <form className="prompt-box" onSubmit={submit}>
        <textarea
          value={draft}
          placeholder={state.deployment ? `Ask about ${state.deployment}, or for a new workflow…` : "Describe a workflow…"}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKey}
          disabled={state.connection === "off"}
        />
        <div className="composer-actions">
          <label className="composer-status" title="Prefix each message with what the runtime says about the selected deployment">
            <input
              type="checkbox"
              checked={state.attachContext}
              disabled={!state.deployment}
              onChange={(event) => post({ kind: "attachContext", value: event.target.checked })}
            />{" "}
            {state.deployment ? `attach ${state.deployment}` : "no deployment"}
          </label>
          <button type="submit" className="send-button" disabled={state.drafting || !draft.trim()} title="Send (Enter)">
            ↑
          </button>
        </div>
      </form>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
