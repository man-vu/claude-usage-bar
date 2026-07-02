import * as vscode from "vscode";
import { ContextAnalysis, analyzeContext } from "./contextAnalyzer";
import { fmtTokens } from "./shared";

function getWorkspacePath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export class ContextViewPanel {
  private static instance: ContextViewPanel | undefined;
  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(msg => {
      if (msg.command === "refresh") { ContextViewPanel.refresh(); }
    }, null, this.disposables);
  }

  static show(context: vscode.ExtensionContext): void {
    if (ContextViewPanel.instance) {
      ContextViewPanel.instance.panel.reveal(vscode.ViewColumn.Two);
      ContextViewPanel.instance.update();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "claudeContextView", "Claude Context View",
      vscode.ViewColumn.Two,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    ContextViewPanel.instance = new ContextViewPanel(panel);
    ContextViewPanel.instance.update();
  }

  static refresh(): void {
    ContextViewPanel.instance?.update();
  }

  private update(): void {
    const data = analyzeContext(getWorkspacePath());
    this.panel.webview.html = data ? buildHtml(data) : errorHtml();
  }

  private dispose(): void {
    ContextViewPanel.instance = undefined;
    for (const d of this.disposables) d.dispose();
  }
}

function errorHtml(): string {
  return `<!DOCTYPE html><html><body style="background:#1e1e1e;color:#ccc;font-family:monospace;padding:2em;">
    <h2>No Claude Code session found for this workspace</h2>
    <p>Run Claude Code in this folder and try again. Sessions from other
    workspaces are not shown here so the numbers always match this project's
    <code>/context</code>.</p></body></html>`;
}

function buildHtml(d: ContextAnalysis): string {
  const pctColor = d.usagePct >= 80 ? "#f44747" : d.usagePct >= 50 ? "#ffc107" : "#4ec9b0";

  // Grid HTML
  const gridRows: string[] = [];
  for (let r = 0; r < d.gridHeight; r++) {
    const cells = [];
    for (let c = 0; c < d.gridWidth; c++) {
      const sq = d.gridSquares[r * d.gridWidth + c];
      cells.push(`<span class="sq" style="color:${sq.color}" title="${sq.name}">${sq.symbol}</span>`);
    }
    gridRows.push(`<div class="grid-row">${cells.join("")}</div>`);
  }

  // Category legend
  const filledCats = d.categories.filter(c => !c.isDeferred);
  const reservedCats = d.categories.filter(c => c.isDeferred);
  const legendItems = filledCats.map(c =>
    `<div class="legend-item"><span class="sq" style="color:${c.color}">\u26C1</span> ${c.name}: <span class="dim">${fmtTokens(c.tokens)} (${(c.tokens * 100 / d.rawWindow).toFixed(1)}%)</span></div>`
  ).join("\n");
  const freeItem = `<div class="legend-item"><span class="sq" style="color:#999">\u26B6</span> Free space: <span class="dim">${fmtTokens(d.freeTokens)} (${(d.freeTokens * 100 / d.rawWindow).toFixed(1)}%)</span></div>`;
  const reservedItems = reservedCats.map(c =>
    `<div class="legend-item"><span class="sq" style="color:#999">\u26DD</span> <span class="dim">${c.name}: ${fmtTokens(c.tokens)} (${(c.tokens * 100 / d.rawWindow).toFixed(1)}%)</span></div>`
  ).join("\n");

  // MCP tools
  const loadedMcp = d.mcpTools.filter(t => t.isLoaded);
  const availMcp = d.mcpTools.filter(t => !t.isLoaded);

  // Skills grouped
  const userSkills = d.skills.filter(s => s.source === "User");
  const pluginSkills = d.skills.filter(s => s.source === "Plugin");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #1e1e1e; color: #d4d4d4; font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace; font-size: 13px; padding: 16px; overflow-y: auto; }
  h1 { font-size: 16px; margin-bottom: 12px; color: #fff; }
  h2 { font-size: 14px; margin: 20px 0 8px; color: #fff; border-bottom: 1px solid #333; padding-bottom: 4px; }
  .dim { color: #808080; }
  .header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .refresh-btn { background: #333; color: #ccc; border: 1px solid #555; padding: 4px 12px; cursor: pointer; border-radius: 3px; font-size: 12px; }
  .refresh-btn:hover { background: #444; }
  .context-panel { display: flex; gap: 24px; flex-wrap: wrap; }
  .grid-col { flex-shrink: 0; }
  .legend-col { flex: 1; min-width: 200px; }
  .grid-row { line-height: 1.4; white-space: nowrap; }
  .sq { font-size: 15px; margin-right: 2px; }
  .legend-item { margin: 2px 0; line-height: 1.6; }
  .model-info { margin-bottom: 4px; }
  .model-name { font-weight: bold; color: #fff; }
  .model-id { color: #808080; font-size: 12px; }
  .token-bar { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
  .bar-track { flex: 1; height: 6px; background: #333; border-radius: 3px; overflow: hidden; max-width: 200px; }
  .bar-fill { height: 100%; border-radius: 3px; }
  .section { margin-bottom: 16px; }
  .tree-item { margin: 1px 0; padding-left: 8px; line-height: 1.5; }
  .tree-item::before { content: "\\2514 "; color: #555; }
  .tree-group { color: #808080; margin: 8px 0 2px; font-size: 12px; }
  table { border-collapse: collapse; width: 100%; margin: 4px 0; }
  th { text-align: left; color: #808080; font-weight: normal; padding: 2px 12px 2px 0; font-size: 12px; border-bottom: 1px solid #333; }
  td { padding: 2px 12px 2px 0; white-space: nowrap; }
  .r { text-align: right; }
  .collapsible { cursor: pointer; user-select: none; }
  .collapsible::before { content: "\\25B6 "; font-size: 10px; color: #808080; }
  .collapsible.open::before { content: "\\25BC "; }
  .collapse-body { display: none; }
  .collapse-body.open { display: block; }
  .badge { display: inline-block; background: #333; color: #aaa; padding: 1px 6px; border-radius: 8px; font-size: 11px; margin-left: 6px; }
</style>
</head>
<body>
  <div class="header-row">
    <h1>Context Usage</h1>
    <button class="refresh-btn" onclick="vscode.postMessage({command:'refresh'})">Refresh</button>
  </div>

  <div class="context-panel">
    <div class="grid-col">
      ${gridRows.join("\n      ")}
    </div>
    <div class="legend-col">
      <div class="model-info">
        <span class="model-name">${d.modelDisplay}</span><br>
        <span class="model-id">${d.model}${d.is1MContext ? "[1m]" : ""}</span>
      </div>
      <div class="token-bar">
        <div class="bar-track"><div class="bar-fill" style="width:${Math.min(d.usagePct, 100)}%;background:${pctColor}"></div></div>
        <span style="color:${pctColor}">${fmtTokens(d.totalUsed)}/${fmtTokens(d.rawWindow)} (${Math.round(d.usagePct)}%)</span>
      </div>
      <div class="dim" style="font-style:italic;margin:8px 0">Estimated usage by category</div>
      ${legendItems}
      ${freeItem}
      ${reservedItems}
    </div>
  </div>

  ${d.apiUsage ? `
  <h2>Last API Response</h2>
  <table>
    <tr><td>Input</td><td class="r">${fmtTokens(d.apiUsage.input_tokens)}</td></tr>
    <tr><td>Output</td><td class="r">${fmtTokens(d.apiUsage.output_tokens)}</td></tr>
    <tr><td>Cache created</td><td class="r">${fmtTokens(d.apiUsage.cache_creation_input_tokens)}</td></tr>
    <tr><td>Cache read</td><td class="r">${fmtTokens(d.apiUsage.cache_read_input_tokens)}</td></tr>
  </table>` : ""}

  ${d.mcpTools.length ? `
  <h2>MCP Tools <span class="badge">${d.mcpTools.length}</span></h2>
  ${loadedMcp.length ? `<div class="tree-group">Loaded</div>${loadedMcp.map(t => `<div class="tree-item">${t.name}: <span class="dim">${fmtTokens(t.tokens)} tokens</span></div>`).join("")}` : ""}
  ${availMcp.length ? `<div class="collapsible" onclick="toggle(this)">Available <span class="badge">${availMcp.length}</span></div><div class="collapse-body">${availMcp.map(t => `<div class="tree-item"><span class="dim">${t.name}</span></div>`).join("")}</div>` : ""}` : ""}

  ${d.mcpServers.length ? `
  <h2>MCP Servers <span class="badge">${d.mcpServers.length}</span></h2>
  ${d.mcpServers.map(s => `<div class="tree-item">${s.name}: <span class="dim">${fmtTokens(s.tokens)} tokens, ~${s.toolCount} tools</span></div>`).join("")}` : ""}

  ${d.toolUsage.length ? `
  <h2>Tool Usage</h2>
  <table>
    <tr><th>Tool</th><th class="r">#Calls</th><th class="r">Call tok</th><th class="r">Result tok</th><th class="r">Total</th></tr>
    ${d.toolUsage.map(t => `<tr><td>${t.name}</td><td class="r">${t.calls}</td><td class="r">${fmtTokens(t.callTokens)}</td><td class="r">${fmtTokens(t.resultTokens)}</td><td class="r">${fmtTokens(t.callTokens + t.resultTokens)}</td></tr>`).join("")}
  </table>` : ""}

  ${d.memoryFiles.length ? `
  <h2>Memory Files</h2>
  ${d.memoryFiles.map(f => `<div class="tree-item">${f.path}: <span class="dim">${fmtTokens(f.tokens)} tokens</span></div>`).join("")}` : ""}

  ${d.plugins.length ? `
  <h2>Plugins <span class="badge">${d.plugins.length}</span></h2>
  <table>
    <tr><th>Name</th><th>Version</th><th>Source</th><th>Updated</th></tr>
    ${d.plugins.map(p => `<tr><td>${p.name}</td><td class="dim">${p.version}</td><td class="dim">${p.marketplace}</td><td class="dim">${p.lastUpdated}</td></tr>`).join("")}
  </table>` : ""}

  ${d.skills.length ? `
  <h2>Skills <span class="badge">${d.skills.length}</span></h2>
  ${userSkills.length ? `<div class="collapsible" onclick="toggle(this)">User <span class="badge">${userSkills.length}</span></div><div class="collapse-body">${userSkills.map(s => `<div class="tree-item">${s.name}: <span class="dim">${fmtTokens(s.tokens)} tokens</span></div>`).join("")}</div>` : ""}
  ${pluginSkills.length ? `<div class="collapsible" onclick="toggle(this)">Plugin <span class="badge">${pluginSkills.length}</span></div><div class="collapse-body">${pluginSkills.map(s => `<div class="tree-item">${s.name}: <span class="dim">${fmtTokens(s.tokens)} tokens</span></div>`).join("")}</div>` : ""}` : ""}

  <h2>Session</h2>
  <table>
    <tr><td>Session</td><td>${d.sessionId.slice(0, 8)}...</td></tr>
    <tr><td>File</td><td class="dim">${d.file}</td></tr>
    <tr><td>Version</td><td class="dim">${d.version}</td></tr>
    <tr><td>CWD</td><td class="dim">${d.cwd}</td></tr>
    <tr><td>Permissions</td><td class="dim">${d.permissionMode}</td></tr>
    <tr><td>Compactions</td><td class="dim">${d.compactCount}</td></tr>
    <tr><td>Messages</td><td class="dim">${d.totalMessages} total, ${d.activeMessages} active</td></tr>
    <tr><td>Auto-compact at</td><td class="dim">${fmtTokens(d.autoCompactThreshold)}</td></tr>
  </table>

<script>
  const vscode = acquireVsCodeApi();
  function toggle(el) {
    el.classList.toggle('open');
    el.nextElementSibling.classList.toggle('open');
  }
</script>
</body>
</html>`;
}
