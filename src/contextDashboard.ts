/**
 * Context view — builds HTML/CSS fragments for embedding in the main dashboard.
 * Replicates /context visualization with a visually rich data dashboard.
 */

import { ContextAnalysis, GridSquare, ToolUsage, SkillInfo, McpToolInfo, McpServerInfo } from "./contextAnalyzer";
import { fmtTokens, buildRingGauge } from "./shared";

export interface ContextViewHTML {
  css: string;
  html: string;
}

function pctColor(pct: number): string {
  if (pct >= 80) return "#f38ba8";
  if (pct >= 60) return "#f9e2af";
  if (pct >= 40) return "#fab387";
  return "#a6e3a1";
}

function fmtPct(n: number, total: number): string {
  if (!total) return "0%";
  return (n * 100 / total).toFixed(1) + "%";
}

// ── Donut chart for context window ─────────────────────────────────

function buildContextDonut(d: ContextAnalysis): string {
  const size = 200;
  const cx = size / 2, cy = size / 2, r = 76, stroke = 18;
  const filledCats = d.categories.filter(c => !c.isDeferred && c.tokens > 0);
  const reserved = d.categories.filter(c => c.isDeferred);
  const reservedPct = reserved.reduce((s, c) => s + c.tokens, 0) / d.rawWindow;
  const freePct = d.freeTokens / d.rawWindow;

  let angle = -90; // Start at 12 o'clock
  const arcs: string[] = [];
  const circumference = 2 * Math.PI * r;

  const segments = [
    ...filledCats.map(c => ({ tokens: c.tokens, color: c.color, name: c.name })),
    { tokens: d.freeTokens, color: "rgba(255,255,255,0.06)", name: "Free space" },
    ...reserved.map(c => ({ tokens: c.tokens, color: "rgba(255,255,255,0.1)", name: c.name })),
  ];

  for (const seg of segments) {
    const pct = seg.tokens / d.rawWindow;
    const dashLen = pct * circumference;
    const gap = circumference - dashLen;
    const rotation = angle;
    arcs.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${seg.color}" stroke-width="${stroke}"
      stroke-dasharray="${dashLen.toFixed(2)} ${gap.toFixed(2)}"
      transform="rotate(${rotation.toFixed(2)} ${cx} ${cy})"
      style="filter:drop-shadow(0 0 4px ${seg.color}40);transition:all 0.6s ease">
      <title>${seg.name}: ${fmtTokens(seg.tokens)} (${(pct * 100).toFixed(1)}%)</title>
    </circle>`);
    angle += pct * 360;
  }

  const usedPct = Math.round(d.usagePct);
  const color = pctColor(d.usagePct);

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="ctx-donut">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,0.03)" stroke-width="${stroke + 2}"/>
    ${arcs.join("\n    ")}
    <text x="${cx}" y="${cy - 12}" text-anchor="middle" fill="${color}" font-size="28" font-weight="700" class="ctx-donut-pct">${usedPct}%</text>
    <text x="${cx}" y="${cy + 10}" text-anchor="middle" fill="var(--text-secondary)" font-size="11">of ${fmtTokens(d.rawWindow)}</text>
    <text x="${cx}" y="${cy + 26}" text-anchor="middle" fill="var(--text-tertiary)" font-size="10">${fmtTokens(d.totalUsed)} used</text>
  </svg>`;
}

// ── Grid visualization ─────────────────────────────────────────────

function buildGridHTML(d: ContextAnalysis): string {
  const rows: string[] = [];
  for (let r = 0; r < d.gridHeight; r++) {
    const cells: string[] = [];
    for (let c = 0; c < d.gridWidth; c++) {
      const sq = d.gridSquares[r * d.gridWidth + c];
      const isFree = sq.name === "Free space";
      const isReserved = sq.name === "Autocompact buffer";
      const cls = isFree ? "ctx-sq ctx-sq-free" : isReserved ? "ctx-sq ctx-sq-reserved" : "ctx-sq ctx-sq-filled";
      cells.push(`<div class="${cls}" style="--sq-color:${sq.color}" title="${sq.name}"></div>`);
    }
    rows.push(`<div class="ctx-grid-row">${cells.join("")}</div>`);
  }
  return rows.join("\n");
}

// ── Category bars ──────────────────────────────────────────────────

function buildCategoryBars(d: ContextAnalysis): string {
  const filled = d.categories.filter(c => !c.isDeferred && c.tokens > 0);
  const maxTokens = Math.max(...filled.map(c => c.tokens), 1);
  return filled.map(c => {
    const pct = (c.tokens / maxTokens) * 100;
    const windowPct = (c.tokens / d.rawWindow * 100).toFixed(1);
    return `<div class="ctx-cat-row">
      <div class="ctx-cat-label">
        <span class="ctx-cat-dot" style="background:${c.color}"></span>
        <span>${c.name}</span>
      </div>
      <div class="ctx-cat-bar-wrap">
        <div class="ctx-cat-bar" style="width:${pct}%;background:${c.color}"></div>
      </div>
      <div class="ctx-cat-val">${fmtTokens(c.tokens)}</div>
      <div class="ctx-cat-pct">${windowPct}%</div>
    </div>`;
  }).join("\n");
}

// ── Tool usage table ───────────────────────────────────────────────

function buildToolTable(tools: ToolUsage[]): string {
  if (!tools.length) return "";
  const maxTotal = Math.max(...tools.map(t => t.callTokens + t.resultTokens), 1);
  const rows = tools.map(t => {
    const total = t.callTokens + t.resultTokens;
    const pct = (total / maxTotal) * 100;
    const callPct = total > 0 ? (t.callTokens / total) * 100 : 0;
    return `<div class="ctx-tool-row">
      <div class="ctx-tool-name">${t.name}</div>
      <div class="ctx-tool-calls">${t.calls}</div>
      <div class="ctx-tool-bar-wrap">
        <div class="ctx-tool-bar-call" style="width:${pct * callPct / 100}%;"></div>
        <div class="ctx-tool-bar-result" style="width:${pct * (100 - callPct) / 100}%;"></div>
      </div>
      <div class="ctx-tool-total">${fmtTokens(total)}</div>
    </div>`;
  });
  return `<div class="ctx-tool-header">
    <div class="ctx-tool-name dim">Tool</div>
    <div class="ctx-tool-calls dim">#</div>
    <div class="ctx-tool-bar-wrap dim"></div>
    <div class="ctx-tool-total dim">Tokens</div>
  </div>${rows.join("")}`;
}

// ── MCP server cards ───────────────────────────────────────────────

function buildMcpCards(servers: McpServerInfo[]): string {
  if (!servers.length) return "<div class='dim' style='padding:12px'>No MCP servers connected</div>";
  return servers.map(s => `<div class="ctx-mcp-card">
    <div class="ctx-mcp-name">${s.name}</div>
    <div class="ctx-mcp-meta">
      <span>${fmtTokens(s.tokens)} tokens</span>
      <span class="ctx-mcp-dot"></span>
      <span>~${s.toolCount} tools</span>
    </div>
  </div>`).join("");
}

// ── Main builder ───────────────────────────────────────────────────

export function buildContextViewHTML(d: ContextAnalysis): ContextViewHTML {
  const gridHTML = buildGridHTML(d);
  const donutHTML = buildContextDonut(d);
  const catBars = buildCategoryBars(d);
  const toolTable = buildToolTable(d.toolUsage);
  const mcpCards = buildMcpCards(d.mcpServers);

  const loadedMcp = d.mcpTools.filter(t => t.isLoaded);
  const availMcp = d.mcpTools.filter(t => !t.isLoaded);
  const userSkills = d.skills.filter(s => s.source === "User");
  const pluginSkills = d.skills.filter(s => s.source === "Plugin");

  // Auto-compact gauge
  const compactPct = d.autoCompactThreshold > 0 ? Math.min(d.totalUsed / d.autoCompactThreshold * 100, 100) : 0;
  const compactColor = compactPct >= 90 ? "#f38ba8" : compactPct >= 70 ? "#f9e2af" : "#a6e3a1";

  // Status label
  const statusLabel = d.usagePct >= 85 ? "Auto-compact imminent" : d.usagePct >= 70 ? "Nearing limit" : "Healthy";
  const statusColor = d.usagePct >= 85 ? "#f38ba8" : d.usagePct >= 70 ? "#f9e2af" : "#a6e3a1";

  const css = `
/* ── Context View Styles ── */
.ctx-hero { display: grid; grid-template-columns: auto 1fr; gap: 32px; align-items: center; padding: 24px; }
.ctx-donut { filter: drop-shadow(0 0 20px rgba(137,180,250,0.08)); }
.ctx-hero-info { display: flex; flex-direction: column; gap: 12px; }
.ctx-model-name { font-size: 22px; font-weight: 700; color: var(--text-primary); letter-spacing: -0.5px; }
.ctx-model-id { font-size: 12px; color: var(--text-tertiary); font-family: 'SF Mono', monospace; }
.ctx-status-pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 500; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06); }
.ctx-status-dot { width: 6px; height: 6px; border-radius: 50%; }
.ctx-kpi-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
.ctx-kpi { background: var(--bg-elevated); border-radius: var(--radius-xs); padding: 6px 12px; font-size: 12px; }
.ctx-kpi-val { font-weight: 600; color: var(--text-primary); }
.ctx-kpi-label { color: var(--text-tertiary); margin-left: 4px; }

.ctx-grid-section { padding: 20px 24px; }
.ctx-grid-row { display: flex; gap: 3px; margin-bottom: 3px; }
.ctx-sq { width: 18px; height: 18px; border-radius: 3px; cursor: default; transition: transform 0.15s, box-shadow 0.2s; }
.ctx-sq:hover { transform: scale(1.25); z-index: 1; }
.ctx-sq-filled { background: var(--sq-color); box-shadow: 0 0 6px color-mix(in srgb, var(--sq-color) 40%, transparent); }
.ctx-sq-filled:hover { box-shadow: 0 0 12px color-mix(in srgb, var(--sq-color) 60%, transparent); }
.ctx-sq-free { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.04); }
.ctx-sq-reserved { background: repeating-linear-gradient(45deg, rgba(255,255,255,0.04), rgba(255,255,255,0.04) 2px, rgba(255,255,255,0.08) 2px, rgba(255,255,255,0.08) 4px); border: 1px solid rgba(255,255,255,0.06); }

.ctx-cats { padding: 0 24px 20px; }
.ctx-cat-row { display: grid; grid-template-columns: 160px 1fr 70px 50px; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border-subtle); }
.ctx-cat-row:last-child { border-bottom: none; }
.ctx-cat-label { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.ctx-cat-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.ctx-cat-bar-wrap { height: 6px; background: rgba(255,255,255,0.04); border-radius: 3px; overflow: hidden; }
.ctx-cat-bar { height: 100%; border-radius: 3px; transition: width 0.6s cubic-bezier(0.16, 1, 0.3, 1); }
.ctx-cat-val { text-align: right; font-size: 12px; font-weight: 500; font-family: 'SF Mono', monospace; }
.ctx-cat-pct { text-align: right; font-size: 11px; color: var(--text-tertiary); }

.ctx-section { padding: 0 24px 24px; }
.ctx-section-title { font-size: 13px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
.ctx-badge { background: rgba(255,255,255,0.08); padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 500; color: var(--text-tertiary); text-transform: none; letter-spacing: 0; }

.ctx-tool-row, .ctx-tool-header { display: grid; grid-template-columns: 1fr 40px 120px 70px; align-items: center; gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--border-subtle); font-size: 12px; }
.ctx-tool-header { border-bottom: 1px solid var(--border); }
.ctx-tool-name { font-family: 'SF Mono', monospace; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ctx-tool-calls { text-align: center; color: var(--text-tertiary); }
.ctx-tool-bar-wrap { display: flex; height: 4px; background: rgba(255,255,255,0.03); border-radius: 2px; overflow: hidden; }
.ctx-tool-bar-call { height: 100%; background: #89b4fa; }
.ctx-tool-bar-result { height: 100%; background: #cba6f7; }
.ctx-tool-total { text-align: right; font-family: 'SF Mono', monospace; font-weight: 500; }

.ctx-mcp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; }
.ctx-mcp-card { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-xs); padding: 12px; transition: border-color 0.2s; cursor: default; }
.ctx-mcp-card:hover { border-color: rgba(137,180,250,0.2); }
.ctx-mcp-name { font-size: 13px; font-weight: 500; margin-bottom: 4px; }
.ctx-mcp-meta { font-size: 11px; color: var(--text-tertiary); display: flex; align-items: center; gap: 6px; }
.ctx-mcp-dot { width: 3px; height: 3px; border-radius: 50%; background: var(--text-tertiary); }

.ctx-plugins-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
.ctx-plugin-card { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-xs); padding: 10px 12px; display: flex; justify-content: space-between; align-items: center; }
.ctx-plugin-name { font-size: 12px; font-weight: 500; }
.ctx-plugin-ver { font-size: 11px; color: var(--text-tertiary); font-family: 'SF Mono', monospace; }

.ctx-skill-group { margin-bottom: 12px; }
.ctx-skill-header { font-size: 12px; color: var(--text-secondary); margin-bottom: 6px; cursor: pointer; display: flex; align-items: center; gap: 6px; user-select: none; }
.ctx-skill-header:hover { color: var(--text-primary); }
.ctx-skill-arrow { font-size: 10px; color: var(--text-tertiary); transition: transform 0.2s; display: inline-block; }
.ctx-skill-arrow.open { transform: rotate(90deg); }
.ctx-skill-list { display: none; flex-wrap: wrap; gap: 4px; }
.ctx-skill-list.open { display: flex; }
.ctx-skill-chip { font-size: 11px; padding: 3px 8px; background: rgba(255,255,255,0.04); border-radius: 4px; color: var(--text-secondary); white-space: nowrap; }

.ctx-session-grid { display: grid; grid-template-columns: 140px 1fr; gap: 4px 16px; font-size: 12px; }
.ctx-session-label { color: var(--text-tertiary); }
.ctx-session-val { color: var(--text-secondary); font-family: 'SF Mono', monospace; }

.ctx-compact-bar { display: flex; align-items: center; gap: 12px; padding: 12px; background: var(--bg-elevated); border-radius: var(--radius-xs); margin-bottom: 16px; }
.ctx-compact-track { flex: 1; height: 8px; background: rgba(255,255,255,0.04); border-radius: 4px; overflow: hidden; position: relative; }
.ctx-compact-fill { height: 100%; border-radius: 4px; transition: width 0.8s cubic-bezier(0.16, 1, 0.3, 1); }
.ctx-compact-label { font-size: 12px; white-space: nowrap; }
.ctx-compact-marker { position: absolute; top: -3px; width: 2px; height: 14px; background: rgba(255,255,255,0.3); border-radius: 1px; }

.dim { color: var(--text-tertiary); }

@keyframes ctx-fade-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.ctx-animate { animation: ctx-fade-in 0.4s ease both; }
.ctx-animate:nth-child(2) { animation-delay: 0.05s; }
.ctx-animate:nth-child(3) { animation-delay: 0.1s; }
.ctx-animate:nth-child(4) { animation-delay: 0.15s; }
.ctx-animate:nth-child(5) { animation-delay: 0.2s; }
`;

  const html = `
<div class="ctx-animate">
  <!-- Hero: Donut + Model info -->
  <div class="card ctx-hero">
    ${donutHTML}
    <div class="ctx-hero-info">
      <div>
        <div class="ctx-model-name">${d.modelDisplay}</div>
        <div class="ctx-model-id">${d.model}${d.is1MContext ? "[1m]" : ""}</div>
      </div>
      <div class="ctx-status-pill">
        <span class="ctx-status-dot" style="background:${statusColor};box-shadow:0 0 6px ${statusColor}"></span>
        <span style="color:${statusColor}">${statusLabel}</span>
      </div>
      <div class="ctx-kpi-row">
        <div class="ctx-kpi"><span class="ctx-kpi-val">${fmtTokens(d.totalUsed)}</span><span class="ctx-kpi-label">used</span></div>
        <div class="ctx-kpi"><span class="ctx-kpi-val">${fmtTokens(d.freeTokens)}</span><span class="ctx-kpi-label">free</span></div>
        <div class="ctx-kpi"><span class="ctx-kpi-val">${d.activeMessages}</span><span class="ctx-kpi-label">messages</span></div>
        <div class="ctx-kpi"><span class="ctx-kpi-val">${d.compactCount}</span><span class="ctx-kpi-label">compacts</span></div>
      </div>
    </div>
  </div>
</div>

<div class="ctx-animate">
  <!-- Auto-compact progress -->
  <div class="ctx-compact-bar">
    <div class="ctx-compact-label" style="color:${compactColor}">Auto-compact</div>
    <div class="ctx-compact-track">
      <div class="ctx-compact-fill" style="width:${compactPct.toFixed(1)}%;background:${compactColor}"></div>
      <div class="ctx-compact-marker" style="left:${Math.min((d.effectiveWindow / d.rawWindow) * 100, 100).toFixed(1)}%" title="Effective window"></div>
    </div>
    <div class="ctx-compact-label dim">${fmtTokens(d.totalUsed)} / ${fmtTokens(d.autoCompactThreshold)}</div>
  </div>
</div>

<div class="ctx-animate">
  <!-- Grid -->
  <div class="card ctx-grid-section">
    ${gridHTML}
  </div>
</div>

<div class="ctx-animate">
  <!-- Category breakdown -->
  <div class="card ctx-cats" style="padding-top:16px">
    <div class="ctx-section-title">Token Breakdown</div>
    ${catBars}
    <div class="ctx-cat-row" style="border-top:1px solid var(--border);margin-top:4px;padding-top:8px">
      <div class="ctx-cat-label" style="font-weight:600">Free space</div>
      <div class="ctx-cat-bar-wrap"><div class="ctx-cat-bar" style="width:${(d.freeTokens / Math.max(...d.categories.filter(c => !c.isDeferred).map(c => c.tokens), d.freeTokens, 1)) * 100}%;background:rgba(255,255,255,0.08)"></div></div>
      <div class="ctx-cat-val">${fmtTokens(d.freeTokens)}</div>
      <div class="ctx-cat-pct">${(d.freeTokens / d.rawWindow * 100).toFixed(1)}%</div>
    </div>
  </div>
</div>

${d.toolUsage.length ? `<div class="ctx-animate">
  <div class="card ctx-section">
    <div class="ctx-section-title">Tool Usage <span class="ctx-badge">${d.toolUsage.length} tools</span></div>
    <div style="display:flex;gap:12px;margin-bottom:8px">
      <div style="display:flex;align-items:center;gap:4px;font-size:11px"><span style="width:10px;height:4px;background:#89b4fa;border-radius:2px;display:inline-block"></span><span class="dim">Calls</span></div>
      <div style="display:flex;align-items:center;gap:4px;font-size:11px"><span style="width:10px;height:4px;background:#cba6f7;border-radius:2px;display:inline-block"></span><span class="dim">Results</span></div>
    </div>
    ${toolTable}
  </div>
</div>` : ""}

${d.mcpServers.length ? `<div class="ctx-animate">
  <div class="card ctx-section">
    <div class="ctx-section-title">MCP Servers <span class="ctx-badge">${d.mcpServers.length} active</span></div>
    <div class="ctx-mcp-grid">${mcpCards}</div>
  </div>
</div>` : ""}

${d.mcpTools.length ? `<div class="ctx-animate">
  <div class="card ctx-section">
    <div class="ctx-section-title">MCP Tools <span class="ctx-badge">${d.mcpTools.length} total</span></div>
    ${loadedMcp.length ? `<div style="margin-bottom:8px;font-size:12px;color:var(--text-secondary)">Loaded (${loadedMcp.length})</div>
      ${loadedMcp.map(t => `<div class="ctx-tool-row" style="grid-template-columns:1fr 70px"><div class="ctx-tool-name">${t.name}</div><div class="ctx-tool-total">${fmtTokens(t.tokens)}</div></div>`).join("")}` : ""}
    ${availMcp.length ? `<div class="ctx-skill-header" onclick="this.querySelector('.ctx-skill-arrow').classList.toggle('open');this.nextElementSibling.classList.toggle('open')">
      <span class="ctx-skill-arrow">&#9654;</span> Available (${availMcp.length})
    </div>
    <div class="ctx-skill-list">${availMcp.map(t => `<span class="ctx-skill-chip">${t.name.replace(/^mcp__plugin_[^_]+_[^_]+__/, "").replace(/^mcp__[^_]+__/, "")}</span>`).join("")}</div>` : ""}
  </div>
</div>` : ""}

${d.plugins.length ? `<div class="ctx-animate">
  <div class="card ctx-section">
    <div class="ctx-section-title">Plugins <span class="ctx-badge">${d.plugins.length} enabled</span></div>
    <div class="ctx-plugins-grid">
      ${d.plugins.map(p => `<div class="ctx-plugin-card"><span class="ctx-plugin-name">${p.name}</span><span class="ctx-plugin-ver">${p.version}</span></div>`).join("")}
    </div>
  </div>
</div>` : ""}

${d.skills.length ? `<div class="ctx-animate">
  <div class="card ctx-section">
    <div class="ctx-section-title">Skills <span class="ctx-badge">${d.skills.length} installed</span></div>
    ${userSkills.length ? `<div class="ctx-skill-group">
      <div class="ctx-skill-header" onclick="this.querySelector('.ctx-skill-arrow').classList.toggle('open');this.nextElementSibling.classList.toggle('open')">
        <span class="ctx-skill-arrow">&#9654;</span> User (${userSkills.length})
      </div>
      <div class="ctx-skill-list">${userSkills.slice(0, 200).map(s => `<span class="ctx-skill-chip" title="${fmtTokens(s.tokens)} tokens">${s.name}</span>`).join("")}${userSkills.length > 200 ? `<span class="ctx-skill-chip dim">+${userSkills.length - 200} more</span>` : ""}</div>
    </div>` : ""}
    ${pluginSkills.length ? `<div class="ctx-skill-group">
      <div class="ctx-skill-header" onclick="this.querySelector('.ctx-skill-arrow').classList.toggle('open');this.nextElementSibling.classList.toggle('open')">
        <span class="ctx-skill-arrow">&#9654;</span> Plugin (${pluginSkills.length})
      </div>
      <div class="ctx-skill-list">${pluginSkills.map(s => `<span class="ctx-skill-chip" title="${fmtTokens(s.tokens)} tokens">${s.name}</span>`).join("")}</div>
    </div>` : ""}
  </div>
</div>` : ""}

${d.apiUsage ? `<div class="ctx-animate">
  <div class="card ctx-section">
    <div class="ctx-section-title">Last API Response</div>
    <div class="ctx-session-grid">
      <span class="ctx-session-label">Input</span><span class="ctx-session-val">${fmtTokens(d.apiUsage.input_tokens)}</span>
      <span class="ctx-session-label">Output</span><span class="ctx-session-val">${fmtTokens(d.apiUsage.output_tokens)}</span>
      <span class="ctx-session-label">Cache created</span><span class="ctx-session-val">${fmtTokens(d.apiUsage.cache_creation_input_tokens)}</span>
      <span class="ctx-session-label">Cache read</span><span class="ctx-session-val">${fmtTokens(d.apiUsage.cache_read_input_tokens)}</span>
    </div>
  </div>
</div>` : ""}

<div class="ctx-animate">
  <div class="card ctx-section">
    <div class="ctx-section-title">Session Metadata</div>
    <div class="ctx-session-grid">
      <span class="ctx-session-label">Session</span><span class="ctx-session-val">${d.sessionId.slice(0, 8)}...</span>
      <span class="ctx-session-label">File</span><span class="ctx-session-val">${d.file}</span>
      <span class="ctx-session-label">Version</span><span class="ctx-session-val">${d.version}</span>
      <span class="ctx-session-label">CWD</span><span class="ctx-session-val">${d.cwd}</span>
      <span class="ctx-session-label">Permissions</span><span class="ctx-session-val">${d.permissionMode}</span>
      <span class="ctx-session-label">Compactions</span><span class="ctx-session-val">${d.compactCount}</span>
      <span class="ctx-session-label">Messages</span><span class="ctx-session-val">${d.totalMessages} total, ${d.activeMessages} active</span>
      <span class="ctx-session-label">Auto-compact at</span><span class="ctx-session-val">${fmtTokens(d.autoCompactThreshold)}</span>
      <span class="ctx-session-label">Effective window</span><span class="ctx-session-val">${fmtTokens(d.effectiveWindow)}</span>
    </div>
  </div>
</div>
`;

  return { css, html };
}
