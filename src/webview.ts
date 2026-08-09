import type { Topology } from "./diagram";

/**
 * The diagram window's markup.
 *
 * Drawn as SVG from a laid-out topology, with no build step and no framework:
 * an extension that shipped a bundler to draw boxes would be paying for
 * something the picture does not need. Colours come from the editor's own theme
 * variables, so the diagram belongs to whatever theme is on.
 */
export function render(topology: Topology | null, problems: string[]): string {
  const payload = JSON.stringify({ topology, problems }).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>
  body {
    margin: 0;
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  header {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--vscode-panel-border);
    font-size: 12px;
  }
  header b { font-size: 13px; }
  .state {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 999px;
    padding: 1px 8px;
  }
  .state.live { border-color: var(--vscode-charts-green); color: var(--vscode-charts-green); }
  .problems {
    margin: 0;
    padding: 12px 14px;
    color: var(--vscode-errorForeground);
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
    white-space: pre-wrap;
  }
  svg { display: block; }
  .node rect {
    fill: var(--vscode-editorWidget-background);
    stroke: var(--vscode-panel-border);
    rx: 5;
  }
  .node text {
    fill: var(--vscode-foreground);
    font-family: var(--vscode-editor-font-family);
    font-size: 11px;
    dominant-baseline: middle;
  }
  .node.reaction rect { stroke: var(--vscode-charts-purple); }
  .node.timer rect { stroke: var(--vscode-charts-yellow); }
  .node.agent rect { stroke-dasharray: 3 3; }
  /* A reaction the run is working on. */
  .node.running rect {
    stroke: var(--vscode-charts-green);
    stroke-width: 2;
  }
  /* A port carrying a value at the tag being shown. */
  .node.carrying rect { fill: var(--vscode-editor-selectionBackground); }
  .edge { fill: none; stroke: var(--vscode-panel-border); }
  /* Triggers and effects are a reaction's own wiring, not a path a value
     travels between ports, so only connections are drawn solid. */
  .edge.trigger, .edge.effect { stroke-dasharray: 3 3; opacity: 0.7; }
  .edge.delayed { stroke-dasharray: 8 5; stroke: var(--vscode-charts-purple); }
  .empty { padding: 14px; font-size: 12px; opacity: 0.8; }
</style>
</head>
<body>
<header>
  <b id="team">—</b>
  <span id="tag"></span>
  <span class="state" id="state">compiled</span>
  <span id="note"></span>
</header>
<div id="root"></div>
<script>
const vscode = acquireVsCodeApi();
let current = ${payload};

function draw() {
  const { topology, problems } = current;
  const root = document.getElementById("root");
  if (problems.length > 0) {
    document.getElementById("team").textContent = "does not compile";
    root.innerHTML = "";
    const pre = document.createElement("pre");
    pre.className = "problems";
    pre.textContent = problems.join("\\n");
    root.appendChild(pre);
    return;
  }
  if (!topology) { root.innerHTML = '<p class="empty">Nothing to draw.</p>'; return; }

  document.getElementById("team").textContent = topology.team || "(unnamed)";
  document.getElementById("tag").textContent = topology.tag
    ? topology.tag.timestamp + ":" + topology.tag.microstep
    : "";
  const state = document.getElementById("state");
  state.textContent = topology.status || "compiled";
  state.className = topology.status ? "state live" : "state";

  const at = new Map(topology.nodes.map((node) => [node.id, node]));
  const edges = topology.edges.map((edge) => {
    const from = at.get(edge.source);
    const to = at.get(edge.target);
    if (!from || !to) return "";
    const x1 = from.x + from.width, y1 = from.y + from.height / 2;
    const x2 = to.x, y2 = to.y + to.height / 2;
    const mid = (x1 + x2) / 2;
    const classes = "edge " + edge.kind + (edge.delay > 0 ? " delayed" : "");
    return '<path class="' + classes + '" d="M' + x1 + ',' + y1 +
      ' H' + mid + ' V' + y2 + ' H' + x2 + '" />';
  }).join("");

  const nodes = topology.nodes.map((node) => {
    const classes = ["node", node.kind,
      node.status === "running" ? "running" : "",
      node.value !== undefined && node.value !== null ? "carrying" : ""].filter(Boolean).join(" ");
    const label = node.label.length > 20 ? node.label.slice(0, 19) + "…" : node.label;
    const title = node.value !== undefined && node.value !== null
      ? node.label + " = " + JSON.stringify(node.value)
      : node.label;
    return '<g class="' + classes + '"><title>' + escape(title) + '</title>' +
      '<rect x="' + node.x + '" y="' + node.y + '" width="' + node.width +
      '" height="' + node.height + '" />' +
      '<text x="' + (node.x + 8) + '" y="' + (node.y + node.height / 2) + '">' +
      escape(label) + '</text></g>';
  }).join("");

  root.innerHTML = '<svg width="' + topology.width + '" height="' + topology.height +
    '" viewBox="0 0 ' + topology.width + ' ' + topology.height + '">' + edges + nodes + '</svg>';
}

function escape(text) {
  return String(text).replace(/[&<>"]/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message.kind === "topology") {
    current = { topology: message.topology, problems: [] };
    draw();
  }
  if (message.kind === "other-run") {
    document.getElementById("note").textContent =
      "a different program is running (" + message.team + ")";
  }
});

draw();
</script>
</body>
</html>`;
}
