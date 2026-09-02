import type { Connection } from "../client/follow";
import type { Graph } from "./graph";

/**
 * The Mission Control panel's markup.
 *
 * SVG drawn from a laid-out graph, no framework, no bundler. The page holds no
 * truth of its own: every message from the extension replaces the whole
 * picture, and the banner says whether that picture is live. Labels come from
 * agent-written programs, so all of them go through `escape` and nothing is
 * ever inserted as HTML. The script is allowed only by nonce.
 */

export type PanelState = {
  graph: Graph | null;
  team: string;
  status: string;
  connection: Connection | null;
  detail: string | null;
  tag: string;
  lag: string;
  selected: string | null;
  /** Ids to draw bright, dimming the rest; empty means everything. */
  highlight: string[];
};

export function renderPanel(cspSource: string, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
<style nonce="${nonce}">
  html, body { height: 100%; margin: 0; overflow: hidden; }
  body {
    display: flex; flex-direction: column;
    font-family: var(--vscode-font-family); font-size: 12px;
    color: var(--vscode-foreground); background: var(--vscode-editor-background);
  }
  header {
    display: flex; align-items: center; gap: 12px; padding: 6px 12px;
    border-bottom: 1px solid var(--vscode-panel-border); flex: none;
  }
  header b { font-size: 13px; }
  header .muted { opacity: 0.7; }
  .pill { border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 1px 8px; letter-spacing: 0.04em; }
  .pill.live { border-color: var(--vscode-charts-green); color: var(--vscode-charts-green); }
  .pill.stale { border-color: var(--vscode-charts-yellow); color: var(--vscode-charts-yellow); }
  .pill.final { opacity: 0.8; }
  .pill.connecting { opacity: 0.6; }
  #banner {
    display: none; padding: 6px 12px; flex: none;
    background: var(--vscode-inputValidation-warningBackground);
    border-bottom: 1px solid var(--vscode-inputValidation-warningBorder);
  }
  #banner.shown { display: block; }
  #banner b { margin-right: 8px; }
  #canvas { flex: 1; cursor: grab; }
  #canvas.dragging { cursor: grabbing; }
  #empty { padding: 16px; opacity: 0.8; }
  .box rect { fill: var(--vscode-sideBar-background); stroke: var(--vscode-panel-border); rx: 6; }
  .box.depth2 rect { fill: var(--vscode-editorWidget-background); }
  .box text { fill: var(--vscode-descriptionForeground); font-size: 11px; }
  .box text.team { opacity: 0.7; }
  .node { cursor: pointer; }
  .node rect { fill: var(--vscode-editorWidget-background); stroke: var(--vscode-panel-border); rx: 4; }
  .node text { fill: var(--vscode-foreground); font-family: var(--vscode-editor-font-family); font-size: 11px; dominant-baseline: middle; pointer-events: none; }
  .node text.sub { fill: var(--vscode-descriptionForeground); font-size: 9px; }
  .node.port rect { rx: 14; }
  .node.port.input rect { stroke: var(--vscode-charts-blue); }
  .node.port.output rect { stroke: var(--vscode-charts-orange); }
  .node.port.action rect { stroke: var(--vscode-charts-purple); }
  .node.timer rect { stroke: var(--vscode-charts-yellow); rx: 14; }
  .node.agent rect { stroke-dasharray: 3 3; }
  .node.reaction rect { stroke-width: 1.5; }
  .node.reaction.running rect { stroke: var(--vscode-charts-green); stroke-width: 2.5; }
  .node.reaction.completed rect { stroke: var(--vscode-charts-blue); }
  .node.carrying rect { fill: var(--vscode-badge-background); }
  .node.selected rect { stroke: var(--vscode-focusBorder); stroke-width: 2.5; }
  .node .badge { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; }
  .edge { fill: none; stroke: var(--vscode-panel-border); stroke-width: 1.2; marker-end: url(#arrow); }
  .edge.trigger, .edge.effect { stroke-dasharray: 3 3; opacity: 0.6; }
  .edge.delayed { stroke-dasharray: 8 4; stroke: var(--vscode-charts-purple); opacity: 1; }
  .edge text { fill: var(--vscode-charts-purple); font-size: 9px; }
  #arrow path { fill: var(--vscode-panel-border); }
  .dim { opacity: 0.18; }
</style>
</head>
<body>
<header>
  <b id="team">—</b>
  <span class="pill" id="connection">—</span>
  <span id="status" class="muted"></span>
  <span id="tag" class="muted"></span>
  <span id="lag" class="muted"></span>
</header>
<div id="banner"><b>DISPLAYED STATE MAY BE STALE</b><span id="detail"></span></div>
<div id="canvas"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let state = vscode.getState() || null;
let view = { x: 0, y: 0, k: 1 };
let viewInitialised = false;

function escape(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function trim(text, max) {
  text = String(text);
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function draw() {
  const canvas = document.getElementById("canvas");
  const team = document.getElementById("team");
  const pill = document.getElementById("connection");
  const banner = document.getElementById("banner");
  if (!state) {
    team.textContent = "—";
    pill.textContent = "NO DEPLOYMENT";
    pill.className = "pill";
    banner.className = "";
    canvas.innerHTML = '<p id="empty">Select a deployment to see its topology.</p>';
    return;
  }
  team.textContent = state.team || "(unnamed)";
  document.getElementById("status").textContent = state.status ? state.status.toUpperCase() : "";
  document.getElementById("tag").textContent = state.tag ? "t = " + state.tag : "";
  document.getElementById("lag").textContent = state.lag && state.lag !== "—" ? "lag " + state.lag : "";
  const connection = state.connection || "connecting";
  pill.textContent = connection.toUpperCase();
  pill.className = "pill " + connection;
  banner.className = connection === "stale" ? "shown" : "";
  document.getElementById("detail").textContent = state.detail || "";

  const graph = state.graph;
  if (!graph) {
    canvas.innerHTML = '<p id="empty">' + escape(state.detail || "No picture of this deployment; its diagram server is gone.") + '</p>';
    return;
  }
  const bright = new Set(state.highlight || []);
  const dimmed = (id) => bright.size > 0 && !bright.has(id) ? " dim" : "";
  const at = new Map(graph.nodes.map((node) => [node.id, node]));

  const boxes = graph.boxes.map((box) =>
    '<g class="box depth' + Math.min(box.depth, 2) + '"><rect x="' + box.x + '" y="' + box.y + '" width="' + box.width + '" height="' + box.height + '" />' +
    '<text x="' + (box.x + 8) + '" y="' + (box.y + 15) + '">' + escape(trim(box.label, 30)) +
    (box.team ? ' <tspan class="team">: ' + escape(trim(box.team, 24)) + '</tspan>' : "") + '</text></g>').join("");

  const edges = graph.edges.map((edge) => {
    const from = at.get(edge.source), to = at.get(edge.target);
    if (!from || !to) return "";
    const x1 = from.x + from.width, y1 = from.y + from.height / 2;
    const x2 = to.x, y2 = to.y + to.height / 2;
    const back = x2 < x1 + 20;
    // A feedback edge loops around below rather than cutting back through.
    const d = back
      ? "M" + x1 + "," + y1 + " C" + (x1 + 40) + "," + y1 + " " + (x1 + 40) + "," + (y1 + 60) + " " + ((x1 + x2) / 2) + "," + (Math.max(y1, y2) + 60) +
        " S" + (x2 - 40) + "," + y2 + " " + x2 + "," + y2
      : "M" + x1 + "," + y1 + " C" + ((x1 + x2) / 2) + "," + y1 + " " + ((x1 + x2) / 2) + "," + y2 + " " + x2 + "," + y2;
    const delayed = edge.delay !== null && edge.delay > 0;
    const cls = "edge " + edge.kind + (delayed ? " delayed" : "") + (dimmed(edge.source) && dimmed(edge.target) ? " dim" : "");
    const label = delayed ? '<text x="' + ((x1 + x2) / 2) + '" y="' + ((y1 + y2) / 2 - 4) + '" text-anchor="middle">after ' + escape(state.delays[edge.id] || "") + '</text>' : "";
    return '<g class="' + cls + '"><path d="' + d + '" />' + label + '</g>';
  }).join("");

  const nodes = graph.nodes.map((node) => {
    const cls = ["node", node.kind, node.role || "", node.status || "", node.value !== undefined ? "carrying" : "", node.id === state.selected ? "selected" : ""]
      .filter(Boolean).join(" ") + dimmed(node.id);
    const title = node.kind === "reaction" ? node.label + " · " + node.sublabel + " · " + node.status : node.label + (node.value !== undefined ? " = " + node.value : "");
    let text = '<text x="' + (node.x + 10) + '" y="' + (node.y + (node.kind === "reaction" ? 14 : node.height / 2)) + '">' + escape(trim(node.label, 18)) + '</text>';
    if (node.kind === "reaction") {
      text += '<text class="sub" x="' + (node.x + 10) + '" y="' + (node.y + 29) + '">' + escape(trim(node.sublabel || "", 14)) + '</text>';
      text += '<text class="badge" x="' + (node.x + node.width - 8) + '" y="' + (node.y + 29) + '" text-anchor="end">' + escape(node.status || "") + '</text>';
    } else if (node.value !== undefined) {
      text += '<text class="sub" x="' + (node.x + node.width - 8) + '" y="' + (node.y + node.height / 2) + '" text-anchor="end">' + escape(trim(node.value, 10)) + '</text>';
    }
    return '<g class="' + cls + '" data-id="' + escape(node.id) + '"><title>' + escape(title) + '</title>' +
      '<rect x="' + node.x + '" y="' + node.y + '" width="' + node.width + '" height="' + node.height + '" />' + text + '</g>';
  }).join("");

  const rect = canvas.getBoundingClientRect();
  if (!viewInitialised && rect.width > 0) {
    // Fit on first draw; afterwards the reader's pan and zoom stand.
    const k = Math.min(1, (rect.width - 20) / graph.width, (rect.height - 20) / graph.height);
    view = { x: 10, y: 10, k: k > 0 ? k : 1 };
    viewInitialised = true;
  }
  canvas.innerHTML = '<svg width="100%" height="100%">' +
    '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" /></marker></defs>' +
    '<g id="world" transform="translate(' + view.x + ',' + view.y + ') scale(' + view.k + ')">' + boxes + edges + nodes + '</g></svg>';
}

// Pan by dragging, zoom with the wheel, select by clicking a node.
(function () {
  const canvas = document.getElementById("canvas");
  let drag = null;
  canvas.addEventListener("mousedown", (event) => {
    drag = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, moved: false };
    canvas.classList.add("dragging");
  });
  window.addEventListener("mousemove", (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    view.x = drag.vx + dx; view.y = drag.vy + dy;
    const world = document.getElementById("world");
    if (world) world.setAttribute("transform", "translate(" + view.x + "," + view.y + ") scale(" + view.k + ")");
  });
  window.addEventListener("mouseup", (event) => {
    if (!drag) return;
    canvas.classList.remove("dragging");
    const moved = drag.moved;
    drag = null;
    if (moved) return;
    const node = event.target.closest && event.target.closest(".node");
    vscode.postMessage({ kind: "select", id: node ? node.getAttribute("data-id") : null });
  });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0015);
    const k = Math.min(4, Math.max(0.2, view.k * factor));
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left, py = event.clientY - rect.top;
    view.x = px - (px - view.x) * (k / view.k);
    view.y = py - (py - view.y) * (k / view.k);
    view.k = k;
    const world = document.getElementById("world");
    if (world) world.setAttribute("transform", "translate(" + view.x + "," + view.y + ") scale(" + view.k + ")");
  }, { passive: false });
})();

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message.kind === "state") {
    const changed = !state || !message.state.graph || !state.graph || message.state.graph.team !== state.graph.team ||
      message.state.graph.width !== state.graph.width || message.state.graph.height !== state.graph.height;
    if (changed) viewInitialised = false;
    state = message.state;
    vscode.setState(state);
    draw();
  }
});
window.addEventListener("resize", draw);
draw();
vscode.postMessage({ kind: "ready" });
</script>
</body>
</html>`;
}
