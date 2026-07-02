/**
 * Cache health view — builds HTML/CSS fragments for embedding in the main dashboard.
 * No standalone panel; the cache view is a tab within DashboardPanel.
 */

import { CacheAnalysisResult, SessionCacheMetrics } from "./cacheAnalyzer";
import {
  fmtTokens, fmtPct, fmtDate, fmtDateShort, fmtDateTime,
  cacheRatioColor, cacheStatusColor,
  smoothPathTS, smoothAreaTS, buildRingGauge, buildDonutChart,
} from "./shared";

// ── Verdict helper ───────────────────────────────────────────────────

function verdictLabel(v: CacheAnalysisResult["verdict"]): { text: string; color: string; icon: string } {
  switch (v) {
    case "NOT_AFFECTED": return { text: "Not Affected", color: "#a6e3a1", icon: "&#10003;" };
    case "MILDLY_AFFECTED": return { text: "Mildly Affected", color: "#f9e2af", icon: "&#9888;" };
    case "MODERATELY_AFFECTED": return { text: "Moderately Affected", color: "#fab387", icon: "&#9888;" };
    case "SEVERELY_AFFECTED": return { text: "Severely Affected", color: "#f38ba8", icon: "&#10007;" };
  }
}

// ── Chart builders ───────────────────────────────────────────────────

function buildCacheRatioChart(data: CacheAnalysisResult, width: number, height: number): string {
  const days = data.dailyCacheRatios;
  if (days.length === 0) return "<div style='text-align:center;color:var(--text-tertiary);padding:40px'>No data</div>";
  const pad = { top: 24, right: 16, bottom: 36, left: 52 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;

  const points = days.map((d, i) => ({
    x: pad.left + (i / Math.max(days.length - 1, 1)) * w,
    y: pad.top + h - (d.readRatio * h),
  }));

  const linePath = smoothPathTS(points, pad.top, pad.top + h);
  const areaPath = smoothAreaTS(points, pad.top + h, pad.top);
  const healthyY = pad.top + h - (0.80 * h);
  const warningY = pad.top + h - (0.40 * h);

  const gridLines = [0, 0.2, 0.4, 0.6, 0.8, 1.0].map(pct => {
    const y = pad.top + h - pct * h;
    return `<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
            <text x="${pad.left - 8}" y="${y + 4}" text-anchor="end" fill="rgba(255,255,255,0.35)" font-size="10">${(pct * 100).toFixed(0)}%</text>`;
  }).join("\n");

  const step = Math.max(1, Math.floor(points.length / 7));
  const xLabels = points.filter((_, i) => i % step === 0 || i === points.length - 1)
    .map((p) => {
      const idx = points.indexOf(p);
      return `<text x="${p.x}" y="${pad.top + h + 24}" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-size="10">${fmtDateShort(days[idx].date)}</text>`;
    }).join("\n");

  const dots = points.map((p, i) =>
    `<circle cx="${p.x}" cy="${p.y}" r="4" fill="${cacheRatioColor(days[i].readRatio)}" stroke="#1e1e2e" stroke-width="1.5" class="data-dot" opacity="0.7"
      data-tip-date="${fmtDate(days[i].date)}" data-tip-cost="Cache Hit: ${fmtPct(days[i].readRatio)}" data-tip-msgs="Read: ${fmtTokens(days[i].read)} / Create: ${fmtTokens(days[i].create)}" data-tip-tokens="${days[i].sessions} sessions"/>`
  ).join("\n");

  return `<svg width="100%" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" class="chart-svg">
    <defs>
      <linearGradient id="cacheAreaGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#a6e3a1" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="#a6e3a1" stop-opacity="0.02"/>
      </linearGradient>
    </defs>
    ${gridLines}
    <rect x="${pad.left}" y="${pad.top}" width="${w}" height="${healthyY - pad.top}" fill="rgba(166,227,161,0.03)"/>
    <rect x="${pad.left}" y="${healthyY}" width="${w}" height="${warningY - healthyY}" fill="rgba(249,226,175,0.03)"/>
    <rect x="${pad.left}" y="${warningY}" width="${w}" height="${pad.top + h - warningY}" fill="rgba(243,139,168,0.03)"/>
    <line x1="${pad.left}" y1="${healthyY}" x2="${width - pad.right}" y2="${healthyY}" stroke="#a6e3a1" stroke-width="1" stroke-dasharray="4,4" opacity="0.4"/>
    <line x1="${pad.left}" y1="${warningY}" x2="${width - pad.right}" y2="${warningY}" stroke="#f38ba8" stroke-width="1" stroke-dasharray="4,4" opacity="0.4"/>
    <text x="${width - pad.right + 4}" y="${healthyY + 4}" fill="#a6e3a1" font-size="9" opacity="0.6">80%</text>
    <text x="${width - pad.right + 4}" y="${warningY + 4}" fill="#f38ba8" font-size="9" opacity="0.6">40%</text>
    <path d="${areaPath}" fill="url(#cacheAreaGrad)" class="chart-area-fill"/>
    <path d="${linePath}" fill="none" stroke="#a6e3a1" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="chart-line"/>
    ${xLabels}
    ${dots}
  </svg>`;
}

function buildVersionBars(versions: CacheAnalysisResult["versionBreakdown"]): string {
  if (versions.length === 0) return "<div style='color:var(--text-tertiary);font-size:0.78rem'>No version data</div>";
  const maxSessions = Math.max(...versions.map(v => v.sessions), 1);
  return versions.slice(0, 8).map(v => {
    const barPct = (v.sessions / maxSessions) * 100;
    const color = cacheRatioColor(v.avgReadRatio);
    return `<div class="version-row">
      <span class="version-name">${v.version}</span>
      <div class="version-bar-bg"><div class="version-bar-fill" style="width:${barPct}%;background:${color}"></div></div>
      <span class="version-ratio" style="color:${color}">${fmtPct(v.avgReadRatio)}</span>
      <span class="version-count">${v.sessions}s${v.affected > 0 ? ` <span style="color:#f38ba8">(${v.affected} bad)</span>` : ""}</span>
    </div>`;
  }).join("\n");
}

function buildSessionTable(sessions: SessionCacheMetrics[], limit: number, ascending: boolean): string {
  const sorted = sessions.slice().sort((a, b) => ascending
    ? a.readRatio - b.readRatio
    : b.readRatio - a.readRatio
  ).slice(0, limit);

  if (sorted.length === 0) return `<div style="color:var(--text-tertiary);font-size:0.78rem">No sessions</div>`;

  const rows = sorted.map(s => {
    const bugs: string[] = [];
    if (s.bug1Likely) bugs.push('<span class="bug-tag b1">B1</span>');
    if (s.bug2Likely) bugs.push('<span class="bug-tag b2">B2</span>');
    const sc = cacheStatusColor(s.status);
    return `<tr>
      <td style="color:${sc}">${fmtPct(s.readRatio)}</td>
      <td><span class="status-pill" style="background:${sc}20;color:${sc}">${s.status}</span></td>
      <td>${s.turns}</td>
      <td>${fmtTokens(s.totalCreate)}</td>
      <td>${fmtTokens(s.totalRead)}</td>
      <td>${s.version ?? "?"}</td>
      <td>${fmtDateTime(s.firstTs)}</td>
      <td>${bugs.join(" ") || "-"}</td>
    </tr>`;
  }).join("\n");

  return `<table class="session-table">
    <thead><tr><th>Ratio</th><th>Status</th><th>Turns</th><th>Created</th><th>Read</th><th>Version</th><th>Date</th><th>Bugs</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function buildLegendItems(counts: { healthy: number; warning: number; affected: number }, total: number): string {
  const items = [
    { label: "Healthy", count: counts.healthy, color: "#a6e3a1" },
    { label: "Warning", count: counts.warning, color: "#f9e2af" },
    { label: "Affected", count: counts.affected, color: "#f38ba8" },
  ];
  return items.map(i => `<div class="legend-item">
    <span class="legend-dot" style="background:${i.color}"></span>
    <span class="legend-name">${i.label}</span>
    <span class="legend-val">${i.count}</span>
    <span class="legend-pct">${total > 0 ? ((i.count / total) * 100).toFixed(0) : 0}%</span>
  </div>`).join("\n");
}

// ── Exported fragment builder ────────────────────────────────────────

export interface CacheViewFragments {
  css: string;
  html: string;
  sessionData: string;
}

export function buildCacheViewHTML(data: CacheAnalysisResult): CacheViewFragments {
  const v = verdictLabel(data.verdict);
  const healthyPct = data.mainSessions.length > 0 ? data.healthyCounts.healthy / data.mainSessions.length : 0;

  const subCreate = data.subagentSessions.reduce((s, r) => s + r.totalCreate, 0);
  const subRead = data.subagentSessions.reduce((s, r) => s + r.totalRead, 0);
  const subTotal = subCreate + subRead;
  const subRatio = subTotal > 0 ? subRead / subTotal : 0;
  const subHealthy = data.subagentSessions.filter(r => r.status === "healthy").length;
  const subWarning = data.subagentSessions.filter(r => r.status === "warning").length;
  const subAffected = data.subagentSessions.filter(r => r.status === "affected").length;

  const sessionData = JSON.stringify(data.mainSessions.map(s => ({
    readRatio: s.readRatio, status: s.status, turns: s.turns,
    totalCreate: s.totalCreate, totalRead: s.totalRead,
    bug1Likely: s.bug1Likely, bug2Likely: s.bug2Likely, version: s.version,
    firstTs: s.firstTs ? s.firstTs.toISOString() : null,
    lastTs: s.lastTs ? s.lastTs.toISOString() : null,
  })));

  const healthDonut = buildDonutChart(
    [
      { label: "Healthy", value: data.healthyCounts.healthy, color: "#a6e3a1" },
      { label: "Warning", value: data.healthyCounts.warning, color: "#f9e2af" },
      { label: "Affected", value: data.healthyCounts.affected, color: "#f38ba8" },
    ],
    140,
    String(data.mainSessions.length),
    "SESSIONS",
    (seg, pct) => ({ date: seg.label, cost: `${seg.value} sessions`, msgs: `${(pct * 100).toFixed(1)}% of total`, tokens: "" })
  );

  const gaugeColor = cacheRatioColor(data.overallReadRatio);

  const css = `
/* ── Cache Health View ── */
.verdict-banner { border-radius: var(--radius); padding: 20px 24px; margin-bottom: 20px; display: flex; align-items: center; gap: 18px; }
.verdict-icon { width: 52px; height: 52px; border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 24px; flex-shrink: 0; }
.verdict-text h2 { font-size: 1.1rem; font-weight: 700; margin-bottom: 4px; }
.verdict-text p { font-size: 0.78rem; color: var(--text-secondary); line-height: 1.6; }
.verdict-text .stat { color: var(--text-primary); font-weight: 600; }
.kpi-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 14px; }
.kpi-card.kpi-ratio::before { background: linear-gradient(90deg, var(--accent-green), var(--accent-teal)); }
.kpi-card.kpi-sessions::before { background: linear-gradient(90deg, var(--accent-blue), var(--accent-purple)); }
.kpi-card.kpi-wasted::before { background: linear-gradient(90deg, var(--accent-red), var(--accent-peach)); }
.kpi-card.kpi-bugs::before { background: linear-gradient(90deg, var(--accent-yellow), var(--accent-peach)); }
.version-row { display: grid; grid-template-columns: 100px 1fr auto auto; gap: 10px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--border-subtle); }
.version-row:last-child { border-bottom: none; }
.version-name { font-size: 0.72rem; font-weight: 600; color: var(--text-primary); font-family: 'SF Mono', monospace; overflow: hidden; text-overflow: ellipsis; }
.version-bar-bg { height: 6px; background: rgba(255,255,255,0.04); border-radius: 3px; overflow: hidden; }
.version-bar-fill { height: 100%; border-radius: 3px; transition: width 0.4s ease; }
.version-ratio { font-size: 0.72rem; font-weight: 700; min-width: 42px; text-align: right; }
.version-count { font-size: 0.68rem; color: var(--text-tertiary); min-width: 60px; text-align: right; }
.session-table { width: 100%; border-collapse: collapse; font-size: 0.72rem; }
.session-table th { text-align: left; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-tertiary); font-size: 0.65rem; padding: 8px 10px; border-bottom: 1px solid var(--border); }
.session-table td { padding: 8px 10px; border-bottom: 1px solid var(--border-subtle); color: var(--text-secondary); }
.session-table tr:hover td { background: rgba(255,255,255,0.02); }
.status-pill { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.65rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.bug-tag { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 0.6rem; font-weight: 700; letter-spacing: 0.04em; }
.bug-tag.b1 { background: rgba(249,226,175,0.15); color: var(--accent-yellow); }
.bug-tag.b2 { background: rgba(203,166,247,0.15); color: var(--accent-purple); }
.sub-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 12px; }
.gauge-hero { display: flex; align-items: center; justify-content: center; gap: 24px; padding: 16px 0; }
.gauge-hero-ring { position: relative; }
.gauge-hero-pct { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.gauge-hero-pct .big { font-size: 1.8rem; font-weight: 800; letter-spacing: -0.03em; }
.gauge-hero-pct .label { font-size: 0.65rem; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.06em; }
.bug-insights { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 14px; }
.bug-insight { padding: 14px; background: rgba(255,255,255,0.02); border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); }
.bug-insight-title { font-size: 0.72rem; font-weight: 700; margin-bottom: 6px; }
.bug-insight-desc { font-size: 0.68rem; color: var(--text-secondary); line-height: 1.6; }
.bug-insight-count { font-size: 1.3rem; font-weight: 800; margin-bottom: 4px; }
.view-tabs { display: flex; gap: 4px; padding: 3px; background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 8px; width: fit-content; }
.view-tab { padding: 5px 16px; font-size: 0.72rem; font-weight: 600; font-family: inherit; color: var(--text-tertiary); background: transparent; border: none; border-radius: 6px; cursor: pointer; transition: all 0.2s ease; letter-spacing: 0.02em; line-height: 1; white-space: nowrap; }
.view-tab:hover { color: var(--text-secondary); background: rgba(255,255,255,0.04); }
.view-tab.active { color: var(--text-primary); background: rgba(137,180,250,0.15); box-shadow: 0 1px 4px rgba(0,0,0,0.2); }
@media (max-width: 800px) { .kpi-row { grid-template-columns: 1fr 1fr; } .bug-insights { grid-template-columns: 1fr; } }
@media (max-width: 500px) { .kpi-row { grid-template-columns: 1fr; } }
`;

  const html = `
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
    <div style="font-size:0.78rem;color:var(--text-tertiary)" id="cache-period-label">All time &middot; <span id="cache-session-count">${data.mainSessions.length}</span> sessions</div>
    <div class="period-tabs" id="cache-period-tabs">
      <button class="period-tab" data-cache-period="1">1D</button>
      <button class="period-tab" data-cache-period="5">5D</button>
      <button class="period-tab" data-cache-period="7">1W</button>
      <button class="period-tab" data-cache-period="30">1M</button>
      <button class="period-tab active" data-cache-period="0">ALL</button>
    </div>
  </div>
  <div class="verdict-banner" id="cache-verdict" style="background:linear-gradient(135deg,${v.color}10,${v.color}08);border:1px solid ${v.color}30">
    <div class="verdict-icon" style="background:${v.color}15;color:${v.color}">${v.icon}</div>
    <div class="verdict-text">
      <h2 style="color:${v.color}" id="cache-verdict-title">${v.text}</h2>
      <p id="cache-verdict-desc">
        <span class="stat">${data.healthyCounts.affected}/${data.mainSessions.length}</span> sessions have poor cache performance.
        Overall cache read ratio: <span class="stat">${fmtPct(data.overallReadRatio)}</span>.
        ${data.wastedTokenEstimate > 0 ? `Estimated <span class="stat">~${fmtTokens(Math.round(data.wastedTokenEstimate))}</span> tokens wasted.` : "No significant waste detected."}
      </p>
    </div>
  </div>
  <div class="kpi-row" id="cache-kpis">
    <div class="card kpi-card kpi-ratio"><div class="kpi-label">Cache Hit Rate</div><div class="kpi-value" id="cache-kpi-ratio" style="color:${gaugeColor}">${fmtPct(data.overallReadRatio)}</div><div class="kpi-sub" id="cache-kpi-ratio-sub">${fmtTokens(data.totalRead)} read / ${fmtTokens(data.totalCreate + data.totalRead)} total</div></div>
    <div class="card kpi-card kpi-sessions"><div class="kpi-label">Healthy Sessions</div><div class="kpi-value" id="cache-kpi-healthy" style="color:var(--accent-blue)">${fmtPct(healthyPct)}</div><div class="kpi-sub" id="cache-kpi-healthy-sub">${data.healthyCounts.healthy} healthy, ${data.healthyCounts.warning} warn, ${data.healthyCounts.affected} bad</div></div>
    <div class="card kpi-card kpi-wasted"><div class="kpi-label">Wasted Tokens</div><div class="kpi-value" id="cache-kpi-wasted" style="color:${data.wastedTokenEstimate > 0 ? "var(--accent-red)" : "var(--accent-green)"}">${data.wastedTokenEstimate > 0 ? "~" + fmtTokens(Math.round(data.wastedTokenEstimate)) : "0"}</div><div class="kpi-sub">Created instead of cache-read</div></div>
    <div class="card kpi-card kpi-bugs"><div class="kpi-label">Bug Detections</div><div class="kpi-value" id="cache-kpi-bugs" style="color:${(data.bug1Count + data.bug2Count) > 0 ? "var(--accent-yellow)" : "var(--accent-green)"}">${data.bug1Count + data.bug2Count}</div><div class="kpi-sub" id="cache-kpi-bugs-sub">B1: ${data.bug1Count} sentinel, B2: ${data.bug2Count} resume</div></div>
  </div>
  <div class="charts-row" id="cache-charts-row">
    <div class="card">
      <div class="section-header"><span class="section-title">Cache Hit Rate Trend</span><span class="section-badge" id="cache-chart-days">${data.dailyCacheRatios.length} days</span></div>
      <div class="chart-container" id="cache-chart-container">${buildCacheRatioChart(data, 700, 260)}</div>
      <div style="display:flex;gap:16px;margin-top:8px">
        <div style="display:flex;align-items:center;gap:4px;font-size:0.68rem;color:var(--text-tertiary)"><span style="display:inline-block;width:12px;height:2px;background:#a6e3a1;border-radius:1px"></span> Healthy (&gt;80%)</div>
        <div style="display:flex;align-items:center;gap:4px;font-size:0.68rem;color:var(--text-tertiary)"><span style="display:inline-block;width:12px;height:2px;background:#f9e2af;border-radius:1px"></span> Warning (40-80%)</div>
        <div style="display:flex;align-items:center;gap:4px;font-size:0.68rem;color:var(--text-tertiary)"><span style="display:inline-block;width:12px;height:2px;background:#f38ba8;border-radius:1px"></span> Affected (&lt;40%)</div>
      </div>
    </div>
    <div class="card">
      <div class="section-header"><span class="section-title">Session Health</span></div>
      <div class="donut-layout" id="cache-donut-area">${healthDonut}<div class="legend" id="cache-legend">${buildLegendItems(data.healthyCounts, data.mainSessions.length)}</div></div>
      <div class="gauge-hero" style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">
        <div class="gauge-hero-ring" id="cache-gauge-ring">
          ${buildRingGauge(data.overallReadRatio, 90, gaugeColor, 6)}
          <div class="gauge-hero-pct"><span class="big" id="cache-gauge-pct" style="color:${gaugeColor}">${(data.overallReadRatio * 100).toFixed(0)}</span><span class="label">hit %</span></div>
        </div>
        <div>
          <div style="font-size:0.68rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">Aggregate</div>
          <div style="font-size:0.78rem;color:var(--text-primary)" id="cache-agg-read">Read: <strong>${fmtTokens(data.totalRead)}</strong></div>
          <div style="font-size:0.78rem;color:var(--text-primary)" id="cache-agg-create">Create: <strong>${fmtTokens(data.totalCreate)}</strong></div>
        </div>
      </div>
    </div>
  </div>
  <div class="secondary-row">
    <div class="card"><div class="section-header"><span class="section-title">By Version</span><span class="section-badge" id="cache-version-badge">${data.versionBreakdown.length} versions</span></div><div id="cache-versions">${buildVersionBars(data.versionBreakdown)}</div></div>
    <div class="card">
      <div class="section-header"><span class="section-title">Bug Attribution</span></div>
      <div class="bug-insights">
        <div class="bug-insight"><div class="bug-insight-count" id="cache-bug1-count" style="color:var(--accent-yellow)">${data.bug1Count}</div><div class="bug-insight-title" style="color:var(--accent-yellow)">Bug 1: Sentinel</div><div class="bug-insight-desc">Standalone binary corrupts cache prefix.</div><div class="bug-insight-desc" style="margin-top:6px;color:var(--accent-teal)">Fix: Use npm version</div></div>
        <div class="bug-insight"><div class="bug-insight-count" id="cache-bug2-count" style="color:var(--accent-purple)">${data.bug2Count}</div><div class="bug-insight-title" style="color:var(--accent-purple)">Bug 2: Resume</div><div class="bug-insight-desc">Resuming sessions causes full cache miss.</div><div class="bug-insight-desc" style="margin-top:6px;color:var(--accent-teal)">Fix: Start fresh sessions</div></div>
      </div>
    </div>
  </div>
  <div class="card" style="margin-bottom:14px"><div class="section-header"><span class="section-title">Worst Sessions</span><span class="section-badge">ascending by ratio</span></div><div style="overflow-x:auto" id="cache-worst-table">${buildSessionTable(data.mainSessions, 15, true)}</div></div>
  <div class="card" style="margin-bottom:14px"><div class="section-header"><span class="section-title">Best Sessions</span><span class="section-badge">top 10</span></div><div style="overflow-x:auto" id="cache-best-table">${buildSessionTable(data.mainSessions, 10, false)}</div></div>
  <div class="card">
    <div class="section-header"><span class="section-title">Subagent Sessions</span><span class="section-badge">${data.subagentSessions.length} sessions</span></div>
    ${data.subagentSessions.length > 0 ? `
    <div style="font-size:0.72rem;color:var(--text-tertiary);margin-bottom:12px">Subagents create fresh contexts &mdash; lower ratios are expected.</div>
    <div class="sub-stats">
      <div class="sub-stat"><div class="sub-stat-val" style="color:${cacheRatioColor(subRatio)}">${fmtPct(subRatio)}</div><div class="sub-stat-label">Cache Hit Rate</div></div>
      <div class="sub-stat"><div class="sub-stat-val" style="color:var(--accent-green)">${subHealthy}</div><div class="sub-stat-label">Healthy</div></div>
      <div class="sub-stat"><div class="sub-stat-val" style="color:var(--accent-yellow)">${subWarning}</div><div class="sub-stat-label">Warning</div></div>
    </div>
    <div style="margin-top:8px;font-size:0.7rem;color:var(--text-tertiary)">${subAffected > 0 ? `<span style="color:var(--accent-red)">${subAffected} affected</span> detected` : "None affected"} &middot; ${fmtTokens(subRead)} read / ${fmtTokens(subTotal)} total</div>
    ` : `<div style="color:var(--text-tertiary);font-size:0.78rem">No subagent sessions with enough turns.</div>`}
  </div>
`;

  return { css, html, sessionData };
}
