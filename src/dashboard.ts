import * as vscode from "vscode";
import { DailyStats } from "./scanner";

export interface SubscriptionInfo {
  type: string;  // "max", "pro", "free", "unknown"
  tier: string;  // "default_claude_max_20x", etc.
}

export class DashboardPanel {
  private static instance: DashboardPanel | undefined;
  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Handle messages from the webview (refresh button)
    this.panel.webview.onDidReceiveMessage(
      (msg) => {
        if (msg.command === "refresh") {
          vscode.commands.executeCommand("claudeUsageBar.showDashboard");
        }
      },
      null,
      this.disposables
    );
  }

  static show(context: vscode.ExtensionContext, stats: DailyStats[], sub?: SubscriptionInfo): DashboardPanel {
    if (DashboardPanel.instance) {
      DashboardPanel.instance.panel.reveal(vscode.ViewColumn.One);
      DashboardPanel.instance.updateContent(stats, sub);
      return DashboardPanel.instance;
    }

    const panel = vscode.window.createWebviewPanel(
      "claudeUsageDashboard",
      "Claude Usage Dashboard",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    DashboardPanel.instance = new DashboardPanel(panel);
    DashboardPanel.instance.updateContent(stats, sub);
    return DashboardPanel.instance;
  }

  updateContent(stats: DailyStats[], sub?: SubscriptionInfo): void {
    this.panel.webview.html = buildHtml(stats, sub);
  }

  private dispose(): void {
    DashboardPanel.instance = undefined;
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

// ── Subscription helpers ──────────────────────────────────────────────

function formatSubscription(sub?: SubscriptionInfo): { label: string; badge: string; color: string; monthlyPrice: number } {
  if (!sub || sub.type === "unknown") return { label: "Unknown", badge: "?", color: "#7f849c", monthlyPrice: 0 };

  const tier = sub.tier?.toLowerCase() ?? "";
  if (sub.type === "max" && tier.includes("20x")) return { label: "Max 20x", badge: "MAX 20x", color: "#cba6f7", monthlyPrice: 200 };
  if (sub.type === "max" && tier.includes("5x")) return { label: "Max 5x", badge: "MAX 5x", color: "#b4befe", monthlyPrice: 100 };
  if (sub.type === "max") return { label: "Max", badge: "MAX", color: "#b4befe", monthlyPrice: 100 };
  if (sub.type === "pro") return { label: "Pro", badge: "PRO", color: "#89b4fa", monthlyPrice: 20 };
  if (sub.type === "free") return { label: "Free", badge: "FREE", color: "#a6adc8", monthlyPrice: 0 };
  return { label: sub.type, badge: sub.type.toUpperCase(), color: "#89b4fa", monthlyPrice: 0 };
}

// ── Data helpers ──────────────────────────────────────────────────────

interface ComputedData {
  today: DailyStats;
  yesterday: DailyStats;
  stats: DailyStats[];
  totalCost: number;
  totalMessages: number;
  totalInput: number;
  totalOutput: number;
  totalCacheWrite: number;
  totalCacheRead: number;
  avgDailyCost: number;
  costChange: number;
  modelTotals: Record<string, { cost: number; messages: number; inputTokens: number; outputTokens: number }>;
  peakDay: DailyStats;
  cacheSavings: number;
  // New aggregations
  totalToolUsage: Record<string, number>;
  totalHourlyActivity: number[];
  totalSessions: number;
  totalProjectBreakdown: Record<string, { cost: number; messages: number; tokens: number }>;
}

function emptyDay(date: string): DailyStats {
  return { date, totalCost: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, messageCount: 0, modelBreakdown: {}, toolUsage: {}, hourlyActivity: new Array(24).fill(0), sessionCount: 0, projectBreakdown: {} };
}

function compute(stats: DailyStats[]): ComputedData {
  const todayKey = new Date().toISOString().slice(0, 10);
  const yd = new Date(); yd.setDate(yd.getDate() - 1);
  const yesterdayKey = yd.toISOString().slice(0, 10);

  const today = stats.find(s => s.date === todayKey) ?? emptyDay(todayKey);
  const yesterday = stats.find(s => s.date === yesterdayKey) ?? emptyDay(yesterdayKey);
  const totalCost = stats.reduce((s, d) => s + d.totalCost, 0);
  const totalMessages = stats.reduce((s, d) => s + d.messageCount, 0);
  const totalInput = stats.reduce((s, d) => s + d.inputTokens, 0);
  const totalOutput = stats.reduce((s, d) => s + d.outputTokens, 0);
  const totalCacheWrite = stats.reduce((s, d) => s + d.cacheWriteTokens, 0);
  const totalCacheRead = stats.reduce((s, d) => s + d.cacheReadTokens, 0);
  const daysWithData = stats.filter(s => s.messageCount > 0).length || 1;
  const avgDailyCost = totalCost / daysWithData;
  const costChange = yesterday.totalCost > 0 ? ((today.totalCost - yesterday.totalCost) / yesterday.totalCost) * 100 : 0;

  const modelTotals: Record<string, { cost: number; messages: number; inputTokens: number; outputTokens: number }> = {};
  for (const day of stats) {
    for (const [model, data] of Object.entries(day.modelBreakdown)) {
      if (!modelTotals[model]) modelTotals[model] = { cost: 0, messages: 0, inputTokens: 0, outputTokens: 0 };
      modelTotals[model].cost += data.cost;
      modelTotals[model].messages += data.messages;
      modelTotals[model].inputTokens += data.inputTokens;
      modelTotals[model].outputTokens += data.outputTokens;
    }
  }

  const peakDay = stats.reduce((max, d) => d.totalCost > max.totalCost ? d : max, stats[0] ?? emptyDay(todayKey));
  const cacheSavings = totalCacheRead * 0.9 * 3 / 1_000_000;

  // Aggregate new fields across all days
  const totalToolUsage: Record<string, number> = {};
  const totalHourlyActivity = new Array(24).fill(0);
  let totalSessions = 0;
  const totalProjectBreakdown: Record<string, { cost: number; messages: number; tokens: number }> = {};

  for (const day of stats) {
    for (const [tool, count] of Object.entries(day.toolUsage ?? {})) {
      totalToolUsage[tool] = (totalToolUsage[tool] ?? 0) + count;
    }
    if (day.hourlyActivity) {
      for (let h = 0; h < 24; h++) {
        totalHourlyActivity[h] += day.hourlyActivity[h] ?? 0;
      }
    }
    totalSessions += day.sessionCount ?? 0;
    for (const [proj, data] of Object.entries(day.projectBreakdown ?? {})) {
      if (!totalProjectBreakdown[proj]) totalProjectBreakdown[proj] = { cost: 0, messages: 0, tokens: 0 };
      totalProjectBreakdown[proj].cost += data.cost;
      totalProjectBreakdown[proj].messages += data.messages;
      totalProjectBreakdown[proj].tokens += data.tokens;
    }
  }

  return { today, yesterday, stats, totalCost, totalMessages, totalInput, totalOutput, totalCacheWrite, totalCacheRead, avgDailyCost, costChange, modelTotals, peakDay, cacheSavings, totalToolUsage, totalHourlyActivity, totalSessions, totalProjectBreakdown };
}

// ── Formatters ────────────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toString();
}

function fmtCost(n: number): string {
  return n < 10 ? `$${n.toFixed(2)}` : `$${n.toFixed(1)}`;
}

function fmtModel(model: string): string {
  // "claude-opus-4-6" → "Opus 4.6"
  // "claude-haiku-4-5" → "Haiku 4.5"
  const stripped = model.replace("claude-", "").replace(/-\d{8,}$/, "");
  const match = stripped.match(/^(\w+)-(\d+)-(\d+)$/);
  if (match) {
    return match[1].charAt(0).toUpperCase() + match[1].slice(1) + " " + match[2] + "." + match[3];
  }
  // fallback
  return stripped.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function fmtDate(d: string): string {
  const dt = new Date(d + "T00:00:00");
  return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function fmtDateShort(d: string): string {
  const dt = new Date(d + "T00:00:00");
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ── Catmull-Rom to cubic bezier smooth path (server-side) ─────────────
function smoothPathTS(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return "";
  if (pts.length === 2) return `M${pts[0].x},${pts[0].y} L${pts[1].x},${pts[1].y}`;
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i === 0 ? 0 : i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2 < pts.length ? i + 2 : pts.length - 1];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}
function smoothAreaTS(pts: { x: number; y: number }[], baseY: number): string {
  if (pts.length < 2) return "";
  return smoothPathTS(pts) + ` L${pts[pts.length - 1].x},${baseY} L${pts[0].x},${baseY} Z`;
}

// ── SVG Charts (with data attributes for JS tooltips) ─────────────────

function buildAreaChart(days: DailyStats[], width: number, height: number): string {
  if (days.length === 0) return "";
  const sorted = days.slice().sort((a, b) => a.date.localeCompare(b.date));
  const max = Math.max(...sorted.map(d => d.totalCost), 0.01);
  const pad = { top: 20, right: 16, bottom: 36, left: 48 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;

  const points = sorted.map((d, i) => ({
    x: pad.left + (i / Math.max(sorted.length - 1, 1)) * w,
    y: pad.top + h - (d.totalCost / max) * h,
    cost: d.totalCost,
    msgs: d.messageCount,
    tokens: d.inputTokens + d.outputTokens,
    date: d.date,
  }));

  const linePath = smoothPathTS(points);
  const areaPath = smoothAreaTS(points, pad.top + h);

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map(pct => {
    const y = pad.top + h - pct * h;
    const val = pct * max;
    return `<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
            <text x="${pad.left - 8}" y="${y + 4}" text-anchor="end" fill="rgba(255,255,255,0.35)" font-size="10">${fmtCost(val)}</text>`;
  }).join("\n");

  const xLabels = points.filter((_, i) => i % Math.max(1, Math.floor(points.length / 7)) === 0 || i === points.length - 1)
    .map(p => `<text x="${p.x}" y="${pad.top + h + 24}" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-size="10">${fmtDateShort(p.date)}</text>`)
    .join("\n");

  // Static dots (small, dimmed — the active one gets highlighted by JS)
  const dots = points.map((p, i) =>
    `<circle cx="${p.x}" cy="${p.y}" r="3" fill="#89b4fa" stroke="#1e1e2e" stroke-width="1.5" class="data-dot" data-idx="${i}" opacity="0.4"/>`
  ).join("\n");

  // Embed point data as a JSON array for the JS proximity engine
  const pointData = JSON.stringify(points.map(p => ({
    x: +p.x.toFixed(1), y: +p.y.toFixed(1),
    date: fmtDate(p.date), cost: fmtCost(p.cost),
    msgs: p.msgs + " messages", tokens: fmtTokens(p.tokens) + " tokens"
  })));

  return `<svg width="100%" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" class="chart-svg" id="cost-chart" data-points='${pointData}' data-pad-left="${pad.left}" data-pad-top="${pad.top}" data-chart-h="${h}">
    <defs>
      <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#89b4fa" stop-opacity="0.3"/>
        <stop offset="100%" stop-color="#89b4fa" stop-opacity="0.02"/>
      </linearGradient>
      <linearGradient id="lineGrad" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#74c7ec"/>
        <stop offset="50%" stop-color="#89b4fa"/>
        <stop offset="100%" stop-color="#b4befe"/>
      </linearGradient>
    </defs>
    ${gridLines}
    <path d="${areaPath}" fill="url(#areaGrad)" class="chart-area-fill"/>
    <path d="${linePath}" fill="none" stroke="url(#lineGrad)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="chart-line"/>
    ${xLabels}
    ${dots}
    <!-- Tracking elements (hidden by default, driven by JS) -->
    <line id="track-line" x1="0" y1="${pad.top}" x2="0" y2="${pad.top + h}" stroke="rgba(137,180,250,0.3)" stroke-width="1" stroke-dasharray="3,3" visibility="hidden"/>
    <circle id="track-dot" cx="0" cy="0" r="6" fill="#89b4fa" stroke="#fff" stroke-width="2" visibility="hidden" style="filter:drop-shadow(0 0 6px rgba(137,180,250,0.5))"/>
    <!-- Invisible overlay to capture mouse events across the entire chart area -->
    <rect id="chart-overlay" x="${pad.left}" y="${pad.top}" width="${w}" height="${h}" fill="transparent" style="cursor:crosshair"/>
  </svg>`;
}

function buildDonutChart(models: Record<string, { cost: number; messages: number }>, size: number): string {
  const sorted = Object.entries(models).sort((a, b) => b[1].cost - a[1].cost);
  if (sorted.length === 0) return "";
  const total = sorted.reduce((s, [, d]) => s + d.cost, 0);
  if (total === 0) return "";
  const colors = ["#89b4fa", "#a6e3a1", "#fab387", "#f38ba8", "#f9e2af", "#cba6f7", "#94e2d5"];
  const cx = size / 2, cy = size / 2, r = size / 2 - 8, inner = r * 0.62;
  let cumAngle = -Math.PI / 2;

  const arcs = sorted.map(([name, data], i) => {
    const pct = data.cost / total;
    const angle = pct * Math.PI * 2;
    const startAngle = cumAngle;
    cumAngle += angle;
    const endAngle = cumAngle;
    const largeArc = angle > Math.PI ? 1 : 0;
    const x1 = cx + r * Math.cos(startAngle), y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle), y2 = cy + r * Math.sin(endAngle);
    const ix1 = cx + inner * Math.cos(endAngle), iy1 = cy + inner * Math.sin(endAngle);
    const ix2 = cx + inner * Math.cos(startAngle), iy2 = cy + inner * Math.sin(startAngle);
    const color = colors[i % colors.length];
    return `<path d="M${x1},${y1} A${r},${r} 0 ${largeArc},1 ${x2},${y2} L${ix1},${iy1} A${inner},${inner} 0 ${largeArc},0 ${ix2},${iy2} Z"
                  fill="${color}" opacity="0.85" class="donut-segment"
                  data-tip-date="${fmtModel(name)}" data-tip-cost="${fmtCost(data.cost)}" data-tip-msgs="${data.messages} messages" data-tip-tokens="${(pct * 100).toFixed(1)}% of total"/>`;
  }).join("\n");

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="chart-svg">
    ${arcs}
    <text x="${cx}" y="${cy - 6}" text-anchor="middle" fill="#cdd6f4" font-size="16" font-weight="700">${fmtCost(total)}</text>
    <text x="${cx}" y="${cy + 12}" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-size="10">TOTAL</text>
  </svg>`;
}

function buildTokenAreaChart(days: DailyStats[], width: number, height: number): string {
  if (days.length === 0) return "";
  const sorted = days.slice().sort((a, b) => a.date.localeCompare(b.date));
  const maxTokens = Math.max(...sorted.map(d => Math.max(d.inputTokens, d.outputTokens)), 1);
  const pad = { top: 20, right: 16, bottom: 36, left: 56 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;

  const inputPts = sorted.map((d, i) => ({
    x: pad.left + (i / Math.max(sorted.length - 1, 1)) * w,
    y: pad.top + h - (d.inputTokens / maxTokens) * h,
    val: d.inputTokens, date: d.date,
  }));
  const outputPts = sorted.map((d, i) => ({
    x: pad.left + (i / Math.max(sorted.length - 1, 1)) * w,
    y: pad.top + h - (d.outputTokens / maxTokens) * h,
    val: d.outputTokens, date: d.date,
  }));

  const inputLinePath = smoothPathTS(inputPts);
  const outputLinePath = smoothPathTS(outputPts);
  const inputAreaPathD = smoothAreaTS(inputPts, pad.top + h);
  const outputAreaPathD = smoothAreaTS(outputPts, pad.top + h);

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map(pct => {
    const y = pad.top + h - pct * h;
    const val = pct * maxTokens;
    return `<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
            <text x="${pad.left - 8}" y="${y + 4}" text-anchor="end" fill="rgba(255,255,255,0.35)" font-size="10">${fmtTokens(val)}</text>`;
  }).join("\n");

  const xLabels = inputPts.filter((_, i) => i % Math.max(1, Math.floor(inputPts.length / 7)) === 0 || i === inputPts.length - 1)
    .map(p => `<text x="${p.x}" y="${pad.top + h + 24}" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-size="10">${fmtDateShort(p.date)}</text>`)
    .join("\n");

  // Data points for tooltips
  const pointData = JSON.stringify(sorted.map((d, i) => ({
    x: +inputPts[i].x.toFixed(1), y: +inputPts[i].y.toFixed(1),
    date: fmtDate(d.date), cost: "Input: " + fmtTokens(d.inputTokens),
    msgs: "Output: " + fmtTokens(d.outputTokens),
    tokens: "Total: " + fmtTokens(d.inputTokens + d.outputTokens)
  })));

  const inputDots = inputPts.map((p, i) =>
    `<circle cx="${p.x}" cy="${p.y}" r="3" fill="#89b4fa" stroke="#1e1e2e" stroke-width="1.5" class="data-dot" data-idx="${i}" opacity="0.4"/>`
  ).join("\n");

  return `<svg width="100%" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" class="chart-svg" id="cost-chart" data-points='${pointData}' data-pad-left="${pad.left}" data-pad-top="${pad.top}" data-chart-h="${h}">
    <defs>
      <linearGradient id="inputAreaGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#89b4fa" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="#89b4fa" stop-opacity="0.02"/>
      </linearGradient>
      <linearGradient id="outputAreaGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#a6e3a1" stop-opacity="0.2"/>
        <stop offset="100%" stop-color="#a6e3a1" stop-opacity="0.02"/>
      </linearGradient>
    </defs>
    ${gridLines}
    <path d="${outputAreaPathD}" fill="url(#outputAreaGrad)" class="chart-area-fill"/>
    <path d="${outputLinePath}" fill="none" stroke="#a6e3a1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.8" class="chart-line"/>
    <path d="${inputAreaPathD}" fill="url(#inputAreaGrad)" class="chart-area-fill"/>
    <path d="${inputLinePath}" fill="none" stroke="#89b4fa" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="chart-line"/>
    ${xLabels}
    ${inputDots}
    <line id="track-line" x1="0" y1="${pad.top}" x2="0" y2="${pad.top + h}" stroke="rgba(137,180,250,0.3)" stroke-width="1" stroke-dasharray="3,3" visibility="hidden"/>
    <circle id="track-dot" cx="0" cy="0" r="6" fill="#89b4fa" stroke="#fff" stroke-width="2" visibility="hidden" style="filter:drop-shadow(0 0 6px rgba(137,180,250,0.5))"/>
    <rect id="chart-overlay" x="${pad.left}" y="${pad.top}" width="${w}" height="${h}" fill="transparent" style="cursor:crosshair"/>
  </svg>`;
}

function buildSparkline(values: number[], w: number, h: number, color: string): string {
  if (values.length < 2) return "";
  const max = Math.max(...values, 0.01);
  const pts = values.map((v, i) =>
    `${(i / (values.length - 1)) * w},${h - (v / max) * (h - 4)}`
  ).join(" ");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.7"/>
  </svg>`;
}

function buildRingGauge(value: number, total: number, size: number, color: string, bgColor: string = "rgba(255,255,255,0.06)"): string {
  const r = (size - 6) / 2;
  const cx = size / 2, cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const pct = total > 0 ? value / total : 0;
  const dashOffset = circumference * (1 - pct);

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="token-gauge-ring">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${bgColor}" stroke-width="5"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="5"
      stroke-dasharray="${circumference}" stroke-dashoffset="${dashOffset}"
      stroke-linecap="round" transform="rotate(-90 ${cx} ${cy})"
      style="transition: stroke-dashoffset 0.6s ease"/>
    <text x="${cx}" y="${cy + 3}" text-anchor="middle" fill="${color}" font-size="9" font-weight="700">${total > 0 ? (pct * 100).toFixed(0) : 0}%</text>
  </svg>`;
}

// ── Main HTML builder ─────────────────────────────────────────────────

function buildHtml(stats: DailyStats[], sub?: SubscriptionInfo): string {
  const d = compute(stats);
  const chartDays = d.stats.slice().sort((a, b) => a.date.localeCompare(b.date));
  const costSparkValues = chartDays.map(s => s.totalCost);
  const tokenSparkValues = chartDays.map(s => s.inputTokens + s.outputTokens + s.cacheWriteTokens + s.cacheReadTokens);

  const changeIcon = d.costChange > 0 ? "&#9650;" : d.costChange < 0 ? "&#9660;" : "&#8226;";
  const changeColor = d.costChange > 0 ? "#f38ba8" : d.costChange < 0 ? "#a6e3a1" : "rgba(255,255,255,0.4)";
  const changeText = d.costChange !== 0 ? `${Math.abs(d.costChange).toFixed(0)}% vs yesterday` : "same as yesterday";

  const modelColors = ["#89b4fa", "#a6e3a1", "#fab387", "#f38ba8", "#f9e2af", "#cba6f7", "#94e2d5"];

  // Today's model breakdown for KPI card
  const todayModels = Object.entries(d.today.modelBreakdown).sort((a, b) => b[1].cost - a[1].cost);
  const todayMaxCost = todayModels.length > 0 ? todayModels[0][1].cost : 1;
  const todayModelBars = todayModels.map(([name, data], i) => {
    const color = modelColors[i % modelColors.length];
    const pct = todayMaxCost > 0 ? (data.cost / todayMaxCost) * 100 : 0;
    return `<div class="kpi-model-row">
      <span class="kpi-model-name">${fmtModel(name)}</span>
      <div class="kpi-model-bar-bg"><div class="kpi-model-bar-fill" style="width:${pct}%;background:${color}"></div></div>
      <span class="kpi-model-cost">${fmtCost(data.cost)} <span style="color:var(--text-tertiary);font-weight:400">(${data.messages})</span></span>
    </div>`;
  }).join("\n");

  // Today's token data for ring gauges
  const todayIOTokens = d.today.inputTokens + d.today.outputTokens;
  const todayCacheTotal = d.today.cacheWriteTokens + d.today.cacheReadTokens;
  const todayAllTokens = todayIOTokens + todayCacheTotal;
  const sortedModels = Object.entries(d.modelTotals).sort((a, b) => b[1].cost - a[1].cost);
  const modelLegend = sortedModels.map(([name, data], i) => {
    const color = modelColors[i % modelColors.length];
    const pct = d.totalCost > 0 ? ((data.cost / d.totalCost) * 100).toFixed(0) : "0";
    return `<div class="legend-item">
      <span class="legend-dot" style="background:${color}"></span>
      <span class="legend-name">${fmtModel(name)}</span>
      <span class="legend-val">${fmtCost(data.cost)}</span>
      <span class="legend-pct">${pct}%</span>
    </div>`;
  }).join("\n");

  const dailyRows = d.stats.map(day => {
    const isToday = day.date === d.today.date;
    return `<tr class="${isToday ? "row-today" : ""}">
      <td class="cell-date">${fmtDate(day.date)}${isToday ? '<span class="badge-today">TODAY</span>' : ""}</td>
      <td class="cell-cost">${fmtCost(day.totalCost)}</td>
      <td class="cell-tokens">${fmtTokens(day.inputTokens + day.outputTokens)}</td>
      <td class="cell-msgs">${day.messageCount}</td>
      <td class="cell-bar"><div class="mini-bar"><div class="mini-bar-fill" style="width:${d.peakDay.totalCost > 0 ? (day.totalCost / d.peakDay.totalCost * 100) : 0}%"></div></div></td>
    </tr>`;
  }).join("\n");

  // Tool usage breakdown (sorted by frequency)
  const sortedTools = Object.entries(d.totalToolUsage).sort((a, b) => b[1] - a[1]);
  const totalToolCalls = sortedTools.reduce((s, [, c]) => s + c, 0);
  const toolColors = ["#89b4fa", "#a6e3a1", "#fab387", "#f38ba8", "#f9e2af", "#cba6f7", "#94e2d5", "#b4befe", "#74c7ec", "#f2cdcd"];

  // Project leaderboard (sorted by cost)
  const sortedProjects = Object.entries(d.totalProjectBreakdown).sort((a, b) => b[1].cost - a[1].cost);
  const maxProjectCost = sortedProjects.length > 0 ? sortedProjects[0][1].cost : 1;

  // Hourly heatmap data
  const maxHourly = Math.max(...d.totalHourlyActivity, 1);

  // Subscription info
  const subInfo = formatSubscription(sub);
  const isSubscription = sub && sub.type !== "unknown" && sub.type !== "free";
  const projectedMonthly = d.avgDailyCost * 30;

  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Usage Dashboard</title>
<style>
/* ── Design tokens ── */
:root {
  --bg-base: #0f0f1a;
  --bg-surface: rgba(30, 30, 52, 0.65);
  --bg-surface-hover: rgba(40, 40, 70, 0.8);
  --bg-elevated: rgba(50, 50, 85, 0.45);
  --text-primary: #e2e8f0;
  --text-secondary: rgba(255, 255, 255, 0.5);
  --text-tertiary: rgba(255, 255, 255, 0.3);
  --border: rgba(255, 255, 255, 0.06);
  --border-subtle: rgba(255, 255, 255, 0.03);
  --accent-blue: #89b4fa;
  --accent-green: #a6e3a1;
  --accent-peach: #fab387;
  --accent-red: #f38ba8;
  --accent-yellow: #f9e2af;
  --accent-purple: #cba6f7;
  --accent-teal: #94e2d5;
  --glow-blue: rgba(137, 180, 250, 0.15);
  --radius: 16px;
  --radius-sm: 10px;
  --radius-xs: 6px;
}

*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  background: var(--bg-base);
  color: var(--text-primary);
  line-height: 1.5;
  overflow-x: hidden;
}

body::before {
  content: '';
  position: fixed;
  inset: 0;
  background:
    radial-gradient(ellipse 80% 60% at 20% 10%, rgba(137,180,250,0.08) 0%, transparent 60%),
    radial-gradient(ellipse 60% 50% at 80% 80%, rgba(166,227,161,0.06) 0%, transparent 50%),
    radial-gradient(ellipse 50% 40% at 50% 50%, rgba(203,166,247,0.04) 0%, transparent 50%);
  pointer-events: none;
  z-index: 0;
}

.dashboard {
  position: relative;
  z-index: 1;
  max-width: 1100px;
  margin: 0 auto;
  padding: 32px 24px 48px;
}

/* ── Header ── */
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 28px;
}
.header-left { display: flex; align-items: center; gap: 14px; }
.logo {
  width: 36px; height: 36px;
  border-radius: 10px;
  background: linear-gradient(135deg, var(--accent-blue), var(--accent-purple));
  display: flex; align-items: center; justify-content: center;
  font-size: 18px; font-weight: 800; color: #fff;
  box-shadow: 0 4px 16px rgba(137,180,250,0.25);
}
.header h1 {
  font-size: 1.35rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  background: linear-gradient(135deg, var(--text-primary), var(--accent-blue));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}
.header-right { display: flex; align-items: center; gap: 14px; }
.header-meta {
  font-size: 0.75rem;
  color: var(--text-tertiary);
  text-align: right;
  line-height: 1.6;
}

/* Subscription badge */
.sub-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 8px;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  border: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.04);
  backdrop-filter: blur(8px);
}
.sub-dot {
  width: 7px; height: 7px;
  border-radius: 50%;
  display: inline-block;
  animation: pulse-dot 2s ease-in-out infinite;
}
@keyframes pulse-dot {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* ── Subscription banner ── */
.sub-banner {
  background: linear-gradient(135deg, rgba(137,180,250,0.08), rgba(203,166,247,0.06));
  border: 1px solid rgba(137,180,250,0.12);
  border-radius: var(--radius);
  padding: 16px 22px;
  margin-bottom: 20px;
  display: flex;
  align-items: flex-start;
  gap: 14px;
}
.sub-banner-icon {
  font-size: 20px;
  line-height: 1;
  flex-shrink: 0;
  margin-top: 2px;
}
.sub-banner-text {
  flex: 1;
}
.sub-banner-title {
  font-size: 0.82rem;
  font-weight: 700;
  color: var(--accent-blue);
  margin-bottom: 4px;
}
.sub-banner-desc {
  font-size: 0.75rem;
  color: var(--text-secondary);
  line-height: 1.6;
}
.sub-banner-highlight {
  color: var(--accent-green);
  font-weight: 600;
}
.sub-banner-savings {
  display: flex;
  gap: 20px;
  margin-top: 10px;
}
.sub-stat {
  text-align: center;
}
.sub-stat-val {
  font-size: 1.1rem;
  font-weight: 700;
  line-height: 1.2;
}
.sub-stat-label {
  font-size: 0.6rem;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

/* ── Glass card ── */
.card {
  background: var(--bg-surface);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 22px;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.card:hover {
  border-color: rgba(255,255,255,0.1);
  box-shadow: 0 8px 32px rgba(0,0,0,0.2);
}

/* ── KPI Hero Cards ── */
.kpi-top {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin-bottom: 14px;
}
.kpi-card { position: relative; overflow: hidden; }
.kpi-card::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 3px;
  border-radius: var(--radius) var(--radius) 0 0;
}
.kpi-card.kpi-cost::before { background: linear-gradient(90deg, var(--accent-green), var(--accent-teal)); }
.kpi-card.kpi-tokens::before { background: linear-gradient(90deg, var(--accent-peach), var(--accent-yellow)); }

.kpi-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 12px;
}
.kpi-header-left { flex: 1; }
.kpi-label {
  font-size: 0.68rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-secondary);
  margin-bottom: 8px;
}
.kpi-value {
  font-size: 1.9rem;
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1.1;
}
.kpi-cost .kpi-value { color: var(--accent-green); }
.kpi-tokens .kpi-value { color: var(--accent-peach); }
.kpi-sub {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  font-size: 0.72rem;
  color: var(--text-secondary);
}
.kpi-change {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-weight: 600;
  font-size: 0.7rem;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(255,255,255,0.05);
}
.kpi-sparkline {
  flex-shrink: 0;
  opacity: 0.6;
  margin-top: 4px;
}

/* Model mini-breakdown inside KPI */
.kpi-breakdown {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.kpi-model-row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 10px;
  align-items: center;
  padding: 5px 0;
}
.kpi-model-name {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
}
.kpi-model-bar-bg {
  height: 6px;
  background: rgba(255,255,255,0.04);
  border-radius: 3px;
  overflow: hidden;
}
.kpi-model-bar-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.4s ease;
}
.kpi-model-cost {
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--text-secondary);
  text-align: right;
  white-space: nowrap;
  min-width: 52px;
}

/* Token ring gauge */
.token-gauges {
  display: flex;
  gap: 20px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.token-gauge {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
}
.token-gauge-ring {
  flex-shrink: 0;
}
.token-gauge-info {
  flex: 1;
  min-width: 0;
}
.token-gauge-label {
  font-size: 0.65rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
  margin-bottom: 2px;
}
.token-gauge-val {
  font-size: 1rem;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1.2;
}
.token-gauge-sub {
  font-size: 0.65rem;
  color: var(--text-tertiary);
}

/* ── Chart section ── */
.charts-row {
  display: grid;
  grid-template-columns: 1fr 340px;
  gap: 14px;
  margin-bottom: 14px;
}
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.section-title {
  font-size: 0.85rem;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--text-primary);
}
.section-badge {
  font-size: 0.65rem;
  font-weight: 600;
  padding: 3px 8px;
  border-radius: 4px;
  background: rgba(137,180,250,0.1);
  color: var(--accent-blue);
}
.chart-container {
  width: 100%;
  overflow: hidden;
}
.donut-layout {
  display: flex;
  align-items: center;
  gap: 20px;
}
.legend { flex: 1; }
.legend-item {
  display: grid;
  grid-template-columns: 10px 1fr auto auto;
  gap: 8px;
  align-items: center;
  padding: 6px 0;
  border-bottom: 1px solid var(--border-subtle);
}
.legend-item:last-child { border-bottom: none; }
.legend-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.legend-name { font-size: 0.78rem; font-weight: 500; color: var(--text-primary); }
.legend-val { font-size: 0.78rem; font-weight: 600; color: var(--text-primary); text-align: right; }
.legend-pct { font-size: 0.7rem; color: var(--text-secondary); text-align: right; min-width: 28px; }

/* ── Secondary Row ── */
.secondary-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin-bottom: 14px;
}
.token-legend {
  display: flex;
  gap: 16px;
  margin-top: 8px;
}
.token-legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.72rem;
  color: var(--text-secondary);
}
.token-legend-dot {
  width: 10px; height: 10px;
  border-radius: 3px;
  display: inline-block;
}
.cache-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.cache-stat {
  text-align: center;
  padding: 14px 8px;
  background: rgba(255,255,255,0.02);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
}
.cache-stat-val {
  font-size: 1.3rem;
  font-weight: 700;
  color: var(--accent-teal);
  line-height: 1.2;
}
.cache-stat-label {
  font-size: 0.65rem;
  color: var(--text-secondary);
  margin-top: 4px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

/* ── Daily breakdown table (collapsible) ── */
.table-card { padding: 18px; }
.collapse-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 0.72rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  transition: all 0.15s;
}
.collapse-toggle:hover {
  color: var(--text-primary);
  background: rgba(255,255,255,0.04);
}
.collapse-toggle svg {
  transition: transform 0.25s ease;
}
.collapse-toggle.expanded svg {
  transform: rotate(180deg);
}
.collapsible-body {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.35s ease;
}
.collapsible-body.expanded {
  max-height: 2000px;
}
.daily-table {
  width: 100%;
  border-collapse: collapse;
}
.daily-table th {
  text-align: left;
  padding: 8px 12px;
  font-size: 0.65rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-tertiary);
  border-bottom: 1px solid var(--border);
}
.daily-table td {
  padding: 10px 12px;
  font-size: 0.82rem;
  border-bottom: 1px solid var(--border-subtle);
}
.daily-table tr:hover td { background: rgba(255,255,255,0.02); }
.row-today td { background: rgba(137,180,250,0.04) !important; }
.cell-date {
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
}
.badge-today {
  font-size: 0.55rem;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 3px;
  background: linear-gradient(135deg, var(--accent-blue), var(--accent-purple));
  color: #fff;
  letter-spacing: 0.04em;
}
.cell-cost { font-weight: 600; color: var(--accent-green); }
.cell-tokens { color: var(--accent-peach); }
.cell-msgs { color: var(--text-secondary); }
.mini-bar {
  width: 100%;
  height: 6px;
  background: rgba(255,255,255,0.04);
  border-radius: 3px;
  overflow: hidden;
}
.mini-bar-fill {
  height: 100%;
  border-radius: 3px;
  background: linear-gradient(90deg, var(--accent-blue), var(--accent-purple));
  transition: width 0.3s;
}

/* ── Custom Tooltip ── */
#chart-tooltip {
  position: fixed;
  z-index: 9999;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.12s ease;
  background: rgba(15, 15, 30, 0.92);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 10px;
  padding: 10px 14px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(137,180,250,0.08);
  min-width: 140px;
}
#chart-tooltip.visible { opacity: 1; }
.tip-title {
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--accent-blue);
  margin-bottom: 6px;
  white-space: nowrap;
}
.tip-row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  font-size: 0.7rem;
  line-height: 1.7;
}
.tip-label { color: var(--text-secondary); }
.tip-value { color: var(--text-primary); font-weight: 600; white-space: nowrap; }

/* ── SVG animations ── */
@keyframes lineDrawIn {
  from { stroke-dashoffset: var(--line-length); }
  to { stroke-dashoffset: 0; }
}
@keyframes areaFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes dotPopIn {
  from { r: 0; opacity: 0; }
  to { r: 3; opacity: 0.4; }
}
.chart-line {
  stroke-dasharray: var(--line-length);
  stroke-dashoffset: 0;
  animation: lineDrawIn 1s ease-out both;
}
.chart-area-fill {
  animation: areaFadeIn 0.8s ease-out 0.3s both;
}
.data-dot {
  animation: dotPopIn 0.3s ease-out both;
}

/* ── SVG interactions ── */
.data-dot { transition: r 0.15s, filter 0.15s; cursor: pointer; }
.data-dot:hover { r: 7; filter: drop-shadow(0 0 6px rgba(137,180,250,0.6)); }
.donut-segment { transition: opacity 0.15s, filter 0.15s; cursor: pointer; }
.donut-segment:hover { opacity: 1 !important; filter: drop-shadow(0 0 8px rgba(255,255,255,0.15)); }

/* ── Chart draw animations ── */
@keyframes lineDrawIn {
  from { stroke-dashoffset: var(--line-length); }
  to { stroke-dashoffset: 0; }
}
@keyframes areaFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes dotPopIn {
  0% { r: 0; opacity: 0; }
  100% { r: 3; opacity: 0.4; }
}
.chart-line {
  stroke-dasharray: var(--line-length);
  stroke-dashoffset: 0;
  animation: lineDrawIn 1s ease-out both;
}
.chart-area-fill {
  opacity: 0;
  animation: areaFadeIn 0.6s ease-out both;
  animation-delay: 0.4s;
}

/* ── Period tabs (financial-style) ── */
.period-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px;
  background: rgba(255,255,255,0.03);
  border: 1px solid var(--border);
  border-radius: 8px;
  width: fit-content;
}
.period-tab {
  padding: 5px 14px;
  font-size: 0.72rem;
  font-weight: 600;
  font-family: inherit;
  color: var(--text-tertiary);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
  letter-spacing: 0.02em;
  line-height: 1;
  white-space: nowrap;
}
.period-tab:hover {
  color: var(--text-secondary);
  background: rgba(255,255,255,0.04);
}
.period-tab.active {
  color: var(--text-primary);
  background: rgba(137,180,250,0.15);
  box-shadow: 0 1px 4px rgba(0,0,0,0.2);
}

/* Period summary line */
.period-summary {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 6px;
}
.period-total {
  font-size: 1.8rem;
  font-weight: 800;
  letter-spacing: -0.03em;
  color: var(--accent-green);
  line-height: 1;
}
.period-change {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 0.75rem;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(255,255,255,0.05);
}
.period-meta {
  font-size: 0.72rem;
  color: var(--text-tertiary);
}

/* Chart mode toggle (Cost / Tokens) */
.chart-mode-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  background: rgba(255,255,255,0.03);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.chart-mode-tab {
  padding: 4px 12px;
  font-size: 0.68rem;
  font-weight: 600;
  font-family: inherit;
  color: var(--text-tertiary);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
  letter-spacing: 0.02em;
  line-height: 1;
  white-space: nowrap;
}
.chart-mode-tab:hover {
  color: var(--text-secondary);
  background: rgba(255,255,255,0.04);
}
.chart-mode-tab.active {
  color: var(--text-primary);
  background: rgba(137,180,250,0.15);
}
.chart-subtitle {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 6px;
  font-size: 0.72rem;
  color: var(--text-tertiary);
}
.chart-subtitle .token-legend-inline {
  display: flex;
  gap: 12px;
}
.chart-subtitle .token-legend-inline .tl-item {
  display: flex;
  align-items: center;
  gap: 4px;
}
.chart-subtitle .token-legend-inline .tl-dot {
  width: 8px; height: 8px;
  border-radius: 3px;
  display: inline-block;
}

/* Chart area with smooth transitions */
.chart-area {
  position: relative;
  transition: opacity 0.2s ease;
}
.chart-area.transitioning {
  opacity: 0.4;
}

/* ── Responsive ── */
@media (max-width: 800px) {
  .kpi-top { grid-template-columns: 1fr; }
  .charts-row { grid-template-columns: 1fr; }
  .secondary-row { grid-template-columns: 1fr; }
  .insights-row { grid-template-columns: 1fr; }
  .donut-layout { flex-direction: column; }
  .token-gauges { flex-wrap: wrap; }
  .period-tabs { flex-wrap: wrap; }
}
@media (max-width: 500px) {
  .kpi-grid { grid-template-columns: 1fr; }
  .dashboard { padding: 16px 12px; }
}

/* ── Animated entry ── */
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}
.card, .sub-banner { animation: fadeUp 0.4s ease-out both; }
.kpi-top .card:nth-child(1) { animation-delay: 0.05s; }
.kpi-top .card:nth-child(2) { animation-delay: 0.1s; }
.charts-row .card:nth-child(1) { animation-delay: 0.2s; }
.charts-row .card:nth-child(2) { animation-delay: 0.25s; }
.secondary-row .card:nth-child(1) { animation-delay: 0.3s; }
.secondary-row .card:nth-child(2) { animation-delay: 0.35s; }
.table-card { animation-delay: 0.4s; }

/* ── Donation top strip ── */
.donate-strip {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 8px 16px;
  margin-bottom: 16px;
  background: linear-gradient(90deg, rgba(250,179,135,0.08), rgba(203,166,247,0.08));
  border: 1px solid rgba(250,179,135,0.1);
  border-radius: var(--radius);
  animation: fadeUp 0.3s ease-out both;
}
.donate-strip-text {
  font-size: 0.75rem;
  color: var(--text-secondary);
}
.donate-strip-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  font-size: 0.7rem;
  font-weight: 700;
  color: #1a1a2e;
  background: linear-gradient(135deg, #fab387, #cba6f7);
  border-radius: 4px;
  text-decoration: none;
  transition: transform 0.15s;
}
.donate-strip-link:hover { transform: translateY(-1px); }

/* ── Donation banner ── */
.donate-banner {
  margin-top: 14px;
  padding: 20px 24px;
  background: linear-gradient(135deg, rgba(250,179,135,0.06), rgba(203,166,247,0.06));
  border: 1px solid rgba(250,179,135,0.12);
  border-radius: var(--radius);
  display: flex;
  align-items: center;
  gap: 20px;
  animation: fadeUp 0.4s ease-out both;
  animation-delay: 0.5s;
}
.donate-icon {
  font-size: 28px;
  flex-shrink: 0;
  line-height: 1;
}
.donate-body { flex: 1; min-width: 0; }
.donate-title {
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 4px;
}
.donate-desc {
  font-size: 0.75rem;
  color: var(--text-secondary);
  line-height: 1.5;
  margin-bottom: 10px;
}
.donate-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 20px;
  font-size: 0.78rem;
  font-weight: 700;
  font-family: inherit;
  color: #1a1a2e;
  background: linear-gradient(135deg, #fab387, #cba6f7);
  border: none;
  border-radius: 6px;
  cursor: pointer;
  text-decoration: none;
  transition: transform 0.15s, box-shadow 0.15s;
}
.donate-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 16px rgba(250,179,135,0.3);
}

/* ── Tool usage bars ── */
.tool-list { display: flex; flex-direction: column; gap: 2px; }
.tool-row {
  display: grid;
  grid-template-columns: 80px 1fr 42px 34px;
  gap: 6px;
  align-items: center;
  padding: 4px 4px;
  border-radius: 4px;
  transition: background 0.15s;
}
.tool-row:hover { background: rgba(255,255,255,0.03); }
.tool-name {
  font-size: 0.72rem;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tool-bar-bg {
  height: 5px;
  background: rgba(255,255,255,0.04);
  border-radius: 3px;
  overflow: hidden;
}
.tool-bar-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.4s ease;
}
.tool-count { font-size: 0.7rem; font-weight: 600; color: var(--text-primary); text-align: right; }
.tool-pct { font-size: 0.65rem; color: var(--text-secondary); text-align: right; }

/* ── Hourly heatmap ── */
.heatmap-wrap { margin-top: 4px; }
.heatmap-grid {
  display: grid;
  grid-template-columns: repeat(24, 1fr);
  gap: 2px;
}
.heatmap-cell {
  border-radius: 3px;
  height: 28px;
  transition: opacity 0.2s, transform 0.15s;
  position: relative;
  cursor: default;
}
.heatmap-cell:hover { opacity: 0.85; transform: scaleY(1.15); }
.heatmap-labels {
  display: grid;
  grid-template-columns: repeat(24, 1fr);
  gap: 2px;
  margin-top: 3px;
}
.heatmap-label {
  font-size: 0.55rem;
  color: var(--text-tertiary);
  text-align: center;
}
/* Heatmap legend */
.heatmap-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 10px;
  font-size: 0.65rem;
  color: var(--text-tertiary);
}
.heatmap-legend {
  display: flex;
  align-items: center;
  gap: 3px;
}
.heatmap-legend-cell {
  width: 10px; height: 10px;
  border-radius: 2px;
}

/* ── Project leaderboard ── */
.project-list { display: flex; flex-direction: column; gap: 0; }
.project-row {
  display: grid;
  grid-template-columns: 1fr 70px 60px;
  gap: 8px;
  align-items: center;
  padding: 8px 6px;
  border-bottom: 1px solid var(--border-subtle);
  transition: background 0.15s;
}
.project-row:last-child { border-bottom: none; }
.project-row:hover { background: rgba(255,255,255,0.02); }
.project-info { min-width: 0; }
.project-name {
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.project-bar-inline {
  height: 3px;
  margin-top: 4px;
  background: rgba(255,255,255,0.04);
  border-radius: 2px;
  overflow: hidden;
}
.project-bar-fill {
  height: 100%;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--accent-blue), var(--accent-purple));
}
.project-cost { font-size: 0.78rem; font-weight: 600; color: var(--accent-green); text-align: right; }
.project-msgs { font-size: 0.68rem; color: var(--text-secondary); text-align: right; }

/* ── Refresh button (inline in header) ── */
.refresh-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  font-size: 0.72rem;
  font-weight: 600;
  font-family: inherit;
  color: var(--text-secondary);
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--border);
  border-radius: 5px;
  cursor: pointer;
  transition: all 0.15s;
}
.refresh-btn:hover {
  color: var(--text-primary);
  background: rgba(137,180,250,0.1);
  border-color: rgba(137,180,250,0.3);
}
.refresh-btn svg { transition: transform 0.3s; }
.refresh-btn:hover svg { transform: rotate(180deg); }

/* ── New sections layout ── */
.insights-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin-bottom: 14px;
}
</style>
</head>
<body>
<div class="dashboard">

  <!-- Tooltip container -->
  <div id="chart-tooltip">
    <div class="tip-title" id="tip-title"></div>
    <div id="tip-rows"></div>
  </div>

  <!-- Header -->
  <div class="header">
    <div class="header-left">
      <div class="logo">C</div>
      <h1>Claude Usage Dashboard</h1>
    </div>
    <div class="header-right">
      ${sub && sub.type !== "unknown" ? `<div class="sub-badge" style="color:${subInfo.color}; border-color:${subInfo.color}33">
        <span class="sub-dot" style="background:${subInfo.color}"></span>
        ${subInfo.badge}
      </div>` : ""}
      <button class="refresh-btn" onclick="(acquireVsCodeApi()).postMessage({command:'refresh'})">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M13.65 2.35A8 8 0 1 0 16 8h-2a6 6 0 1 1-1.76-4.24L10 6h6V0l-2.35 2.35z" fill="currentColor"/></svg>
        Refresh
      </button>
      <div class="header-meta">
        <span id="header-period-label">Last 7 days</span> &middot; ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </div>
    </div>
  </div>

  <!-- Donate strip -->
  <div class="donate-strip">
    <span class="donate-strip-text">&#9749; Enjoying this extension? Support development</span>
    <a class="donate-strip-link" href="https://buymeacoffee.com/manvu" target="_blank">Buy me a coffee</a>
  </div>

  <!-- Subscription Info Banner -->
  ${isSubscription ? `
  <div class="sub-banner">
    <div class="sub-banner-icon">&#9889;</div>
    <div class="sub-banner-text">
      <div class="sub-banner-title">You're on Claude ${subInfo.label} (${subInfo.monthlyPrice > 0 ? "$" + subInfo.monthlyPrice + "/mo" : "subscription"})</div>
      <div class="sub-banner-desc">
        Costs shown are <strong>API-equivalent estimates</strong> &mdash; what you'd pay if billed per-token via the Anthropic API.
        Since you're on a <span class="sub-banner-highlight">fixed-price subscription</span>, you are <strong>not charged</strong> these amounts.
        This helps you understand your usage intensity and how much value you're getting from your plan.
      </div>
      <div class="sub-banner-savings">
        <div class="sub-stat">
          <div class="sub-stat-val" style="color:var(--accent-green)">${fmtCost(projectedMonthly)}</div>
          <div class="sub-stat-label">Projected Monthly (API)</div>
        </div>
        <div class="sub-stat">
          <div class="sub-stat-val" style="color:var(--accent-purple)">$${subInfo.monthlyPrice}</div>
          <div class="sub-stat-label">You Actually Pay</div>
        </div>
        ${projectedMonthly > subInfo.monthlyPrice ? `<div class="sub-stat">
          <div class="sub-stat-val" style="color:var(--accent-teal)">${((projectedMonthly / subInfo.monthlyPrice - 1) * 100).toFixed(0)}%</div>
          <div class="sub-stat-label">Value Multiplier</div>
        </div>` : ""}
      </div>
    </div>
  </div>
  ` : ""}

  <!-- KPI Hero Cards — Top Row: Today's Cost + Today's Tokens (expanded) -->
  <div class="kpi-top">
    <div class="card kpi-card kpi-cost">
      <div class="kpi-header">
        <div class="kpi-header-left">
          <div class="kpi-label">Today's Cost${isSubscription ? " (API equiv.)" : ""}</div>
          <div class="kpi-value">${fmtCost(d.today.totalCost)}</div>
          <div class="kpi-sub">
            <span class="kpi-change" style="color:${changeColor}">${changeIcon} ${changeText}</span>
            <span style="color:var(--text-tertiary)">&middot; ${d.today.messageCount} msgs</span>
          </div>
        </div>
        <div class="kpi-sparkline">${buildSparkline(costSparkValues, 80, 36, "rgba(166,227,161,0.6)")}</div>
      </div>
      ${todayModelBars ? `<div class="kpi-breakdown">${todayModelBars}</div>` : ""}
    </div>

    <div class="card kpi-card kpi-tokens">
      <div class="kpi-header">
        <div class="kpi-header-left">
          <div class="kpi-label">Tokens Today (All)</div>
          <div class="kpi-value">${fmtTokens(todayAllTokens)}</div>
          <div class="kpi-sub">${fmtTokens(todayIOTokens)} I/O &middot; ${fmtTokens(todayCacheTotal)} cache &middot; ${d.today.messageCount} msgs</div>
        </div>
        <div class="kpi-sparkline">${buildSparkline(tokenSparkValues, 80, 36, "rgba(250,179,135,0.6)")}</div>
      </div>
      <div class="token-gauges">
        <div class="token-gauge">
          ${buildRingGauge(d.today.inputTokens, todayAllTokens, 48, "#89b4fa")}
          <div class="token-gauge-info">
            <div class="token-gauge-label">Input</div>
            <div class="token-gauge-val">${fmtTokens(d.today.inputTokens)}</div>
          </div>
        </div>
        <div class="token-gauge">
          ${buildRingGauge(d.today.outputTokens, todayAllTokens, 48, "#a6e3a1")}
          <div class="token-gauge-info">
            <div class="token-gauge-label">Output</div>
            <div class="token-gauge-val">${fmtTokens(d.today.outputTokens)}</div>
          </div>
        </div>
        <div class="token-gauge">
          ${buildRingGauge(todayCacheTotal, todayAllTokens, 48, "#94e2d5")}
          <div class="token-gauge-info">
            <div class="token-gauge-label">Cache</div>
            <div class="token-gauge-val">${fmtTokens(todayCacheTotal)}</div>
            <div class="token-gauge-sub">${fmtTokens(d.today.cacheReadTokens)} read</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Usage Trend — Unified Cost + Tokens with mode toggle -->
  <div class="card" style="margin-bottom:14px">
    <div class="section-header">
      <div style="display:flex;align-items:center;gap:12px">
        <span class="section-title" id="chart-section-title">Cost Trend${isSubscription ? " (API Equivalent)" : ""}</span>
        <div class="chart-mode-tabs" id="chart-mode-tabs">
          <button class="chart-mode-tab active" data-mode="cost">Cost</button>
          <button class="chart-mode-tab" data-mode="tokens">Tokens</button>
        </div>
      </div>
      <div class="period-tabs" id="period-tabs">
        <button class="period-tab" data-period="1">1D</button>
        <button class="period-tab active" data-period="7">1W</button>
        <button class="period-tab" data-period="30">1M</button>
        <button class="period-tab" data-period="365">1Y</button>
        <button class="period-tab" data-period="0">ALL</button>
      </div>
    </div>
    <div class="period-summary">
      <span class="period-total" id="period-total">${fmtCost(d.totalCost)}</span>
      <span class="period-change" id="period-change" style="color:${changeColor}">${changeIcon} ${changeText}</span>
    </div>
    <div class="period-meta" id="period-meta">${d.stats.length} days &middot; avg ${fmtCost(d.avgDailyCost)}/day &middot; peak ${fmtCost(d.peakDay.totalCost)} on ${fmtDate(d.peakDay.date)}</div>
    <div class="chart-area" id="chart-area" style="margin-top:12px">
      ${buildAreaChart(chartDays, 700, 220)}
    </div>
    <div class="chart-subtitle" id="chart-subtitle" style="display:none">
      <div class="token-legend-inline">
        <span class="tl-item"><span class="tl-dot" style="background:var(--accent-blue)"></span> Input <strong id="token-input-label">${fmtTokens(d.totalInput)}</strong></span>
        <span class="tl-item"><span class="tl-dot" style="background:var(--accent-green)"></span> Output <strong id="token-output-label">${fmtTokens(d.totalOutput)}</strong></span>
      </div>
      <span class="section-badge" id="token-badge">${fmtTokens(d.totalInput + d.totalOutput + d.totalCacheWrite + d.totalCacheRead)} TOTAL</span>
    </div>
  </div>

  <!-- Charts Row: Model + Cache -->
  <div class="charts-row">
    <div class="card" id="model-card">
      <div class="section-header">
        <span class="section-title">Model Distribution</span>
        <span class="section-badge" id="model-badge">${fmtCost(d.totalCost)}</span>
      </div>
      <div class="donut-layout" id="model-donut-area">
        ${buildDonutChart(d.modelTotals, 140)}
        <div class="legend" id="model-legend">
          ${modelLegend}
        </div>
      </div>
    </div>
    <div class="card">
      <div class="section-header">
        <span class="section-title">Cache Performance</span>
      </div>
      <div class="cache-grid" id="cache-grid">
        <div class="cache-stat">
          <div class="cache-stat-val" id="cache-reads">${fmtTokens(d.totalCacheRead)}</div>
          <div class="cache-stat-label">Cache Reads</div>
        </div>
        <div class="cache-stat">
          <div class="cache-stat-val" id="cache-writes">${fmtTokens(d.totalCacheWrite)}</div>
          <div class="cache-stat-label">Cache Writes</div>
        </div>
        <div class="cache-stat">
          <div class="cache-stat-val" id="cache-hit-rate">${(d.totalCacheRead + d.totalInput) > 0 ? ((d.totalCacheRead / (d.totalCacheRead + d.totalInput)) * 100).toFixed(0) : 0}%</div>
          <div class="cache-stat-label">Hit Rate</div>
        </div>
        <div class="cache-stat">
          <div class="cache-stat-val" id="cache-savings">~${fmtCost(d.cacheSavings)}</div>
          <div class="cache-stat-label">Est. Savings</div>
        </div>
      </div>
    </div>
  </div>

  <!-- Tool Usage + Activity Heatmap -->
  <div class="insights-row">
    <div class="card">
      <div class="section-header">
        <span class="section-title">Tool Usage</span>
        <span class="section-badge">${totalToolCalls} calls</span>
      </div>
      <div class="tool-list">
        ${sortedTools.slice(0, 10).map(([name, count], i) => {
          const pct = totalToolCalls > 0 ? (count / totalToolCalls) * 100 : 0;
          const color = toolColors[i % toolColors.length];
          // Shorten MCP plugin names: "mcp__plugin_playwright_playwright__browser_click" → "browser_click"
          const shortName = name.includes("__") ? name.split("__").pop()! : name;
          return `<div class="tool-row">
            <span class="tool-name" title="${name}">${shortName}</span>
            <div class="tool-bar-bg"><div class="tool-bar-fill" style="width:${pct}%;background:${color}"></div></div>
            <span class="tool-count">${count}</span>
            <span class="tool-pct">${pct.toFixed(0)}%</span>
          </div>`;
        }).join("\n")}
      </div>
    </div>

    <div class="card">
      <div class="section-header">
        <span class="section-title">Activity by Hour</span>
        <span class="section-badge">${d.totalSessions} sessions</span>
      </div>
      <div class="heatmap-wrap">
        <div class="heatmap-grid">
          ${d.totalHourlyActivity.map((count, h) => {
            const intensity = maxHourly > 0 ? count / maxHourly : 0;
            const bg = count === 0
              ? "rgba(255,255,255,0.03)"
              : `rgba(137,180,250,${0.15 + intensity * 0.85})`;
            return `<div class="heatmap-cell" style="background:${bg}" data-tip-date="${String(h).padStart(2, "0")}:00 – ${String(h).padStart(2, "0")}:59" data-tip-cost="${count} messages" data-tip-msgs="" data-tip-tokens=""></div>`;
          }).join("\n")}
        </div>
        <div class="heatmap-labels">
          ${Array.from({ length: 24 }, (_, h) => `<span class="heatmap-label">${h % 3 === 0 ? String(h).padStart(2, "0") : ""}</span>`).join("")}
        </div>
        <div class="heatmap-footer">
          <span>Less</span>
          <div class="heatmap-legend">
            <div class="heatmap-legend-cell" style="background:rgba(255,255,255,0.03)"></div>
            <div class="heatmap-legend-cell" style="background:rgba(137,180,250,0.25)"></div>
            <div class="heatmap-legend-cell" style="background:rgba(137,180,250,0.5)"></div>
            <div class="heatmap-legend-cell" style="background:rgba(137,180,250,0.75)"></div>
            <div class="heatmap-legend-cell" style="background:rgba(137,180,250,1)"></div>
          </div>
          <span>More</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Project Leaderboard (full width) -->
  <div class="card" style="margin-bottom:14px">
    <div class="section-header">
      <span class="section-title">Projects</span>
      <span class="section-badge">${sortedProjects.length} active</span>
    </div>
    <div class="project-list">
      ${sortedProjects.slice(0, 10).map(([name, data]) => {
        const shortName = name.split("/").pop() ?? name;
        const barPct = maxProjectCost > 0 ? (data.cost / maxProjectCost) * 100 : 0;
        return `<div class="project-row">
          <div class="project-info">
            <div class="project-name" title="${name}">${shortName}</div>
            <div class="project-bar-inline"><div class="project-bar-fill" style="width:${barPct}%"></div></div>
          </div>
          <span class="project-cost">${fmtCost(data.cost)}</span>
          <span class="project-msgs">${data.messages} msgs</span>
        </div>`;
      }).join("\n")}
    </div>
  </div>

  <!-- Daily Breakdown (collapsible) -->
  <div class="card table-card">
    <div class="section-header">
      <span class="section-title">Daily Breakdown</span>
      <div style="display:flex;align-items:center;gap:10px">
        <span class="section-badge" id="daily-peak-badge">PEAK: ${fmtDate(d.peakDay.date)} at ${fmtCost(d.peakDay.totalCost)}</span>
        <button class="collapse-toggle" id="daily-toggle" aria-expanded="false" aria-controls="daily-body">
          Show
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </div>
    <div class="collapsible-body" id="daily-body">
      <table class="daily-table">
        <thead>
          <tr>
            <th>Day</th>
            <th>Cost${isSubscription ? " (API)" : ""}</th>
            <th>Tokens</th>
            <th>Messages</th>
            <th style="width:25%">Usage</th>
          </tr>
        </thead>
        <tbody id="daily-tbody">
          ${dailyRows}
        </tbody>
      </table>
    </div>
  </div>

  <!-- Support -->
  <div class="donate-banner">
    <div class="donate-icon">&#9749;</div>
    <div class="donate-body">
      <div class="donate-title">Enjoying Claude Usage Bar?</div>
      <div class="donate-desc">This extension is free and open-source. If it helps you track your Claude usage, consider buying me a coffee to support continued development.</div>
      <a class="donate-btn" href="https://buymeacoffee.com/manvu" target="_blank">&#9749; Buy me a coffee</a>
    </div>
  </div>

</div>

<script>
(function() {
  // ── All stats data embedded as JSON ──
  const ALL_STATS = ${JSON.stringify(stats.map(s => ({
    date: s.date,
    totalCost: s.totalCost,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cacheWriteTokens: s.cacheWriteTokens,
    cacheReadTokens: s.cacheReadTokens,
    messageCount: s.messageCount,
    modelBreakdown: s.modelBreakdown,
    toolUsage: s.toolUsage,
    hourlyActivity: s.hourlyActivity,
    sessionCount: s.sessionCount,
    projectBreakdown: s.projectBreakdown
  })))};

  const todayKey = new Date().toISOString().slice(0, 10);
  let currentPeriod = 7;

  // ── Tooltip setup ──
  const tooltip = document.getElementById('chart-tooltip');
  const tipTitle = document.getElementById('tip-title');
  const tipRows = document.getElementById('tip-rows');

  function addRow(label, value) {
    const row = document.createElement('div');
    row.className = 'tip-row';
    row.innerHTML = '<span class="tip-label">' + label + '</span><span class="tip-value">' + value + '</span>';
    tipRows.appendChild(row);
  }

  // ── Catmull-Rom to cubic bezier smooth path ──
  function smoothPath(pts) {
    // pts: array of {x, y}
    if (pts.length < 2) return '';
    if (pts.length === 2) return 'M' + pts[0].x + ',' + pts[0].y + ' L' + pts[1].x + ',' + pts[1].y;
    var d = 'M' + pts[0].x + ',' + pts[0].y;
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[i === 0 ? 0 : i - 1];
      var p1 = pts[i];
      var p2 = pts[i + 1];
      var p3 = pts[i + 2 < pts.length ? i + 2 : pts.length - 1];
      var cp1x = p1.x + (p2.x - p0.x) / 6;
      var cp1y = p1.y + (p2.y - p0.y) / 6;
      var cp2x = p2.x - (p3.x - p1.x) / 6;
      var cp2y = p2.y - (p3.y - p1.y) / 6;
      d += ' C' + cp1x.toFixed(1) + ',' + cp1y.toFixed(1) + ' ' + cp2x.toFixed(1) + ',' + cp2y.toFixed(1) + ' ' + p2.x.toFixed(1) + ',' + p2.y.toFixed(1);
    }
    return d;
  }
  function smoothArea(pts, baseY) {
    if (pts.length < 2) return '';
    var pathD = smoothPath(pts);
    return pathD + ' L' + pts[pts.length - 1].x + ',' + baseY + ' L' + pts[0].x + ',' + baseY + ' Z';
  }

  // ── Formatters (mirror server-side) ──
  function fmtTokens(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return n.toString();
  }
  function fmtCost(n) {
    return n < 10 ? '$' + n.toFixed(2) : '$' + n.toFixed(1);
  }
  function fmtDate(d) {
    const dt = new Date(d + 'T00:00:00');
    return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function fmtDateShort(d) {
    const dt = new Date(d + 'T00:00:00');
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  function fmtModel(model) {
    var stripped = model.replace('claude-', '').replace(/-[0-9]{8,}$/, '');
    var m = stripped.match(/^([a-z]+)-([0-9]+)-([0-9]+)$/i);
    if (m) return m[1].charAt(0).toUpperCase() + m[1].slice(1) + ' ' + m[2] + '.' + m[3];
    return stripped.split('-').map(function(w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
  }

  // ── Filter stats by period ──
  function filterByPeriod(period) {
    if (period === 0) return ALL_STATS.slice(); // ALL
    var cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - period);
    var cutoffStr = cutoff.toISOString().slice(0, 10);
    return ALL_STATS.filter(function(s) { return s.date >= cutoffStr; });
  }

  // ── Compute aggregates for filtered data ──
  function computeFiltered(stats) {
    var totalCost = 0, totalMsgs = 0, totalInput = 0, totalOutput = 0, totalCacheWrite = 0, totalCacheRead = 0;
    var modelTotals = {};
    stats.forEach(function(s) {
      totalCost += s.totalCost;
      totalMsgs += s.messageCount;
      totalInput += s.inputTokens;
      totalOutput += s.outputTokens;
      totalCacheWrite += s.cacheWriteTokens;
      totalCacheRead += s.cacheReadTokens;
      Object.keys(s.modelBreakdown || {}).forEach(function(m) {
        if (!modelTotals[m]) modelTotals[m] = { cost: 0, messages: 0, inputTokens: 0, outputTokens: 0 };
        modelTotals[m].cost += s.modelBreakdown[m].cost;
        modelTotals[m].messages += s.modelBreakdown[m].messages;
        modelTotals[m].inputTokens += s.modelBreakdown[m].inputTokens;
        modelTotals[m].outputTokens += s.modelBreakdown[m].outputTokens;
      });
    });
    var daysWithData = stats.filter(function(s) { return s.messageCount > 0; }).length || 1;
    var avgDailyCost = totalCost / daysWithData;
    var peakDay = stats.reduce(function(max, d) { return d.totalCost > max.totalCost ? d : max; }, stats[0] || { date: todayKey, totalCost: 0 });
    var cacheSavings = totalCacheRead * 0.9 * 3 / 1000000;
    return {
      totalCost: totalCost, totalMsgs: totalMsgs, totalInput: totalInput, totalOutput: totalOutput,
      totalCacheWrite: totalCacheWrite, totalCacheRead: totalCacheRead,
      avgDailyCost: avgDailyCost, peakDay: peakDay, modelTotals: modelTotals, cacheSavings: cacheSavings,
      daysWithData: daysWithData
    };
  }

  // ── Build area chart SVG ──
  function buildAreaChartSVG(days, width, height) {
    if (days.length === 0) return '';
    var sorted = days.slice().sort(function(a, b) { return a.date.localeCompare(b.date); });
    var max = Math.max.apply(null, sorted.map(function(d) { return d.totalCost; }).concat([0.01]));
    var pad = { top: 20, right: 16, bottom: 36, left: 48 };
    var w = width - pad.left - pad.right;
    var h = height - pad.top - pad.bottom;

    var points = sorted.map(function(d, i) {
      return {
        x: pad.left + (i / Math.max(sorted.length - 1, 1)) * w,
        y: pad.top + h - (d.totalCost / max) * h,
        cost: d.totalCost, msgs: d.messageCount, tokens: d.inputTokens + d.outputTokens, date: d.date
      };
    });

    var linePath = smoothPath(points);
    var areaPath = smoothArea(points, pad.top + h);

    var gridLines = [0, 0.25, 0.5, 0.75, 1].map(function(pct) {
      var y = pad.top + h - pct * h;
      return '<line x1="' + pad.left + '" y1="' + y + '" x2="' + (width - pad.right) + '" y2="' + y + '" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>' +
        '<text x="' + (pad.left - 8) + '" y="' + (y + 4) + '" text-anchor="end" fill="rgba(255,255,255,0.35)" font-size="10">' + fmtCost(pct * max) + '</text>';
    }).join('');

    // Dynamic label count based on data length
    var labelStep = Math.max(1, Math.floor(points.length / 8));
    var xLabels = points.filter(function(_, i) { return i % labelStep === 0 || i === points.length - 1; })
      .map(function(p) { return '<text x="' + p.x + '" y="' + (pad.top + h + 24) + '" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-size="10">' + fmtDateShort(p.date) + '</text>'; }).join('');

    var dots = points.map(function(p, i) {
      return '<circle cx="' + p.x + '" cy="' + p.y + '" r="3" fill="#89b4fa" stroke="#1e1e2e" stroke-width="1.5" class="data-dot" data-idx="' + i + '" opacity="0.4"/>';
    }).join('');

    var pointData = JSON.stringify(points.map(function(p) {
      return { x: +p.x.toFixed(1), y: +p.y.toFixed(1), date: fmtDate(p.date), cost: fmtCost(p.cost), msgs: p.msgs + ' messages', tokens: fmtTokens(p.tokens) + ' tokens' };
    }));

    return '<svg width="100%" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="xMidYMid meet" class="chart-svg" id="cost-chart" data-points="' + pointData.replace(/"/g, '&quot;') + '" data-pad-left="' + pad.left + '" data-pad-top="' + pad.top + '" data-chart-h="' + h + '">' +
      '<defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#89b4fa" stop-opacity="0.3"/><stop offset="100%" stop-color="#89b4fa" stop-opacity="0.02"/></linearGradient>' +
      '<linearGradient id="lineGrad" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#74c7ec"/><stop offset="50%" stop-color="#89b4fa"/><stop offset="100%" stop-color="#b4befe"/></linearGradient></defs>' +
      gridLines +
      '<path d="' + areaPath + '" fill="url(#areaGrad)" class="chart-area-fill"/>' +
      '<path d="' + linePath + '" fill="none" stroke="url(#lineGrad)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="chart-line"/>' +
      xLabels + dots +
      '<line id="track-line" x1="0" y1="' + pad.top + '" x2="0" y2="' + (pad.top + h) + '" stroke="rgba(137,180,250,0.3)" stroke-width="1" stroke-dasharray="3,3" visibility="hidden"/>' +
      '<circle id="track-dot" cx="0" cy="0" r="6" fill="#89b4fa" stroke="#fff" stroke-width="2" visibility="hidden" style="filter:drop-shadow(0 0 6px rgba(137,180,250,0.5))"/>' +
      '<rect id="chart-overlay" x="' + pad.left + '" y="' + pad.top + '" width="' + w + '" height="' + h + '" fill="transparent" style="cursor:crosshair"/>' +
      '</svg>';
  }

  // ── Build token dual-line area chart SVG ──
  function buildTokenAreaSVG(days, width, height) {
    var sorted = days.slice().sort(function(a, b) { return a.date.localeCompare(b.date); });
    if (sorted.length === 0) return '';
    var maxTokens = Math.max.apply(null, sorted.map(function(d) { return Math.max(d.inputTokens, d.outputTokens); }).concat([1]));
    var pad = { top: 20, right: 16, bottom: 36, left: 56 };
    var w = width - pad.left - pad.right;
    var h = height - pad.top - pad.bottom;

    var inputPts = sorted.map(function(d, i) {
      return { x: pad.left + (i / Math.max(sorted.length - 1, 1)) * w, y: pad.top + h - (d.inputTokens / maxTokens) * h, val: d.inputTokens, date: d.date };
    });
    var outputPts = sorted.map(function(d, i) {
      return { x: pad.left + (i / Math.max(sorted.length - 1, 1)) * w, y: pad.top + h - (d.outputTokens / maxTokens) * h, val: d.outputTokens, date: d.date };
    });

    var inputLinePath = smoothPath(inputPts);
    var outputLinePath = smoothPath(outputPts);
    var inputAreaPath = smoothArea(inputPts, pad.top + h);
    var outputAreaPath = smoothArea(outputPts, pad.top + h);

    var gridLines = [0, 0.25, 0.5, 0.75, 1].map(function(pct) {
      var y = pad.top + h - pct * h;
      return '<line x1="' + pad.left + '" y1="' + y + '" x2="' + (width - pad.right) + '" y2="' + y + '" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>' +
        '<text x="' + (pad.left - 8) + '" y="' + (y + 4) + '" text-anchor="end" fill="rgba(255,255,255,0.35)" font-size="10">' + fmtTokens(pct * maxTokens) + '</text>';
    }).join('');

    var labelStep = Math.max(1, Math.floor(inputPts.length / 8));
    var xLabels = inputPts.filter(function(_, i) { return i % labelStep === 0 || i === inputPts.length - 1; })
      .map(function(p) { return '<text x="' + p.x + '" y="' + (pad.top + h + 24) + '" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-size="10">' + fmtDateShort(p.date) + '</text>'; }).join('');

    var pointData = JSON.stringify(sorted.map(function(d, i) {
      return { x: +inputPts[i].x.toFixed(1), y: +inputPts[i].y.toFixed(1), date: fmtDate(d.date), cost: 'Input: ' + fmtTokens(d.inputTokens), msgs: 'Output: ' + fmtTokens(d.outputTokens), tokens: 'Total: ' + fmtTokens(d.inputTokens + d.outputTokens) };
    }));

    var inputDots = inputPts.map(function(p, i) {
      return '<circle cx="' + p.x + '" cy="' + p.y + '" r="3" fill="#89b4fa" stroke="#1e1e2e" stroke-width="1.5" class="data-dot" data-idx="' + i + '" opacity="0.4"/>';
    }).join('');

    return '<svg width="100%" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="xMidYMid meet" class="chart-svg" id="cost-chart" data-points="' + pointData.replace(/"/g, '&quot;') + '" data-pad-left="' + pad.left + '" data-pad-top="' + pad.top + '" data-chart-h="' + h + '">' +
      '<defs><linearGradient id="inputAreaGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#89b4fa" stop-opacity="0.25"/><stop offset="100%" stop-color="#89b4fa" stop-opacity="0.02"/></linearGradient>' +
      '<linearGradient id="outputAreaGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#a6e3a1" stop-opacity="0.2"/><stop offset="100%" stop-color="#a6e3a1" stop-opacity="0.02"/></linearGradient></defs>' +
      gridLines +
      '<path d="' + outputAreaPath + '" fill="url(#outputAreaGrad)" class="chart-area-fill"/>' +
      '<path d="' + outputLinePath + '" fill="none" stroke="#a6e3a1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.8" class="chart-line"/>' +
      '<path d="' + inputAreaPath + '" fill="url(#inputAreaGrad)" class="chart-area-fill"/>' +
      '<path d="' + inputLinePath + '" fill="none" stroke="#89b4fa" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="chart-line"/>' +
      xLabels + inputDots +
      '<line id="track-line" x1="0" y1="' + pad.top + '" x2="0" y2="' + (pad.top + h) + '" stroke="rgba(137,180,250,0.3)" stroke-width="1" stroke-dasharray="3,3" visibility="hidden"/>' +
      '<circle id="track-dot" cx="0" cy="0" r="6" fill="#89b4fa" stroke="#fff" stroke-width="2" visibility="hidden" style="filter:drop-shadow(0 0 6px rgba(137,180,250,0.5))"/>' +
      '<rect id="chart-overlay" x="' + pad.left + '" y="' + pad.top + '" width="' + w + '" height="' + h + '" fill="transparent" style="cursor:crosshair"/>' +
      '</svg>';
  }

  // ── Build donut chart SVG ──
  function buildDonutSVG(models, size) {
    var sorted = Object.keys(models).sort(function(a, b) { return models[b].cost - models[a].cost; });
    if (sorted.length === 0) return '';
    var total = sorted.reduce(function(s, k) { return s + models[k].cost; }, 0);
    if (total === 0) return '';
    var colors = ['#89b4fa','#a6e3a1','#fab387','#f38ba8','#f9e2af','#cba6f7','#94e2d5'];
    var cx = size/2, cy = size/2, r = size/2 - 8, inner = r * 0.62;
    var cumAngle = -Math.PI / 2;

    var arcs = sorted.map(function(name, i) {
      var data = models[name];
      var pct = data.cost / total;
      var angle = pct * Math.PI * 2;
      var startAngle = cumAngle;
      cumAngle += angle;
      var endAngle = cumAngle;
      var largeArc = angle > Math.PI ? 1 : 0;
      var x1 = cx + r * Math.cos(startAngle), y1 = cy + r * Math.sin(startAngle);
      var x2 = cx + r * Math.cos(endAngle), y2 = cy + r * Math.sin(endAngle);
      var ix1 = cx + inner * Math.cos(endAngle), iy1 = cy + inner * Math.sin(endAngle);
      var ix2 = cx + inner * Math.cos(startAngle), iy2 = cy + inner * Math.sin(startAngle);
      var color = colors[i % colors.length];
      return '<path d="M' + x1 + ',' + y1 + ' A' + r + ',' + r + ' 0 ' + largeArc + ',1 ' + x2 + ',' + y2 + ' L' + ix1 + ',' + iy1 + ' A' + inner + ',' + inner + ' 0 ' + largeArc + ',0 ' + ix2 + ',' + iy2 + ' Z" fill="' + color + '" opacity="0.85" class="donut-segment" data-tip-date="' + fmtModel(name) + '" data-tip-cost="' + fmtCost(data.cost) + '" data-tip-msgs="' + data.messages + ' messages" data-tip-tokens="' + (pct * 100).toFixed(1) + '% of total"/>';
    }).join('');

    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '" class="chart-svg">' +
      arcs +
      '<text x="' + cx + '" y="' + (cy - 6) + '" text-anchor="middle" fill="#cdd6f4" font-size="16" font-weight="700">' + fmtCost(total) + '</text>' +
      '<text x="' + cx + '" y="' + (cy + 12) + '" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-size="10">TOTAL</text></svg>';
  }

  // ── Build hourly area chart for 1D view ──
  function buildHourlyAreaSVG(dayStats, width, height, mode) {
    var hourly = dayStats.hourlyActivity || new Array(24).fill(0);
    var totalMsgs = hourly.reduce(function(s, v) { return s + v; }, 0) || 1;

    // Distribute today's cost/tokens proportionally by hourly messages
    var hourlyData = hourly.map(function(msgs, h) {
      var ratio = msgs / totalMsgs;
      return {
        hour: h,
        msgs: msgs,
        cost: dayStats.totalCost * ratio,
        input: dayStats.inputTokens * ratio,
        output: dayStats.outputTokens * ratio
      };
    });

    var pad = { top: 20, right: 16, bottom: 36, left: mode === 'tokens' ? 56 : 48 };
    var w = width - pad.left - pad.right;
    var h = height - pad.top - pad.bottom;

    if (mode === 'tokens') {
      // Dual-line: input + output
      var maxVal = Math.max.apply(null, hourlyData.map(function(d) { return Math.max(d.input, d.output); }).concat([1]));
      var inputPts = hourlyData.map(function(d, i) {
        return { x: pad.left + (i / 23) * w, y: pad.top + h - (d.input / maxVal) * h };
      });
      var outputPts = hourlyData.map(function(d, i) {
        return { x: pad.left + (i / 23) * w, y: pad.top + h - (d.output / maxVal) * h };
      });
      var inputLinePath = smoothPath(inputPts);
      var outputLinePath = smoothPath(outputPts);
      var inputAreaPath = smoothArea(inputPts, pad.top + h);
      var outputAreaPath = smoothArea(outputPts, pad.top + h);

      var gridLines = [0, 0.25, 0.5, 0.75, 1].map(function(pct) {
        var y = pad.top + h - pct * h;
        return '<line x1="' + pad.left + '" y1="' + y + '" x2="' + (width - pad.right) + '" y2="' + y + '" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>' +
          '<text x="' + (pad.left - 8) + '" y="' + (y + 4) + '" text-anchor="end" fill="rgba(255,255,255,0.35)" font-size="10">' + fmtTokens(pct * maxVal) + '</text>';
      }).join('');

      var xLabels = inputPts.filter(function(_, i) { return i % 3 === 0; })
        .map(function(p, _, arr) { var idx = inputPts.indexOf(p); return '<text x="' + p.x + '" y="' + (pad.top + h + 24) + '" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-size="10">' + String(idx).padStart(2, '0') + ':00</text>'; }).join('');

      var pointData = JSON.stringify(hourlyData.map(function(d, i) {
        return { x: +inputPts[i].x.toFixed(1), y: +inputPts[i].y.toFixed(1), date: String(d.hour).padStart(2, '0') + ':00 - ' + String(d.hour).padStart(2, '0') + ':59', cost: 'Input: ' + fmtTokens(d.input), msgs: 'Output: ' + fmtTokens(d.output), tokens: d.msgs + ' messages' };
      }));

      var dots = inputPts.map(function(p, i) {
        return '<circle cx="' + p.x + '" cy="' + p.y + '" r="3" fill="#89b4fa" stroke="#1e1e2e" stroke-width="1.5" class="data-dot" data-idx="' + i + '" opacity="0.4"/>';
      }).join('');

      return '<svg width="100%" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="xMidYMid meet" class="chart-svg" id="cost-chart" data-points="' + pointData.replace(/"/g, '&quot;') + '" data-pad-left="' + pad.left + '" data-pad-top="' + pad.top + '" data-chart-h="' + h + '">' +
        '<defs><linearGradient id="inputAreaGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#89b4fa" stop-opacity="0.25"/><stop offset="100%" stop-color="#89b4fa" stop-opacity="0.02"/></linearGradient>' +
        '<linearGradient id="outputAreaGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#a6e3a1" stop-opacity="0.2"/><stop offset="100%" stop-color="#a6e3a1" stop-opacity="0.02"/></linearGradient></defs>' +
        gridLines +
        '<path d="' + outputAreaPath + '" fill="url(#outputAreaGrad)" class="chart-area-fill"/>' +
        '<path d="' + outputLinePath + '" fill="none" stroke="#a6e3a1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.8" class="chart-line"/>' +
        '<path d="' + inputAreaPath + '" fill="url(#inputAreaGrad)" class="chart-area-fill"/>' +
        '<path d="' + inputLinePath + '" fill="none" stroke="#89b4fa" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="chart-line"/>' +
        xLabels + dots +
        '<line id="track-line" x1="0" y1="' + pad.top + '" x2="0" y2="' + (pad.top + h) + '" stroke="rgba(137,180,250,0.3)" stroke-width="1" stroke-dasharray="3,3" visibility="hidden"/>' +
        '<circle id="track-dot" cx="0" cy="0" r="6" fill="#89b4fa" stroke="#fff" stroke-width="2" visibility="hidden" style="filter:drop-shadow(0 0 6px rgba(137,180,250,0.5))"/>' +
        '<rect id="chart-overlay" x="' + pad.left + '" y="' + pad.top + '" width="' + w + '" height="' + h + '" fill="transparent" style="cursor:crosshair"/>' +
        '</svg>';
    } else {
      // Cost mode - single line
      var maxCost = Math.max.apply(null, hourlyData.map(function(d) { return d.cost; }).concat([0.01]));
      var pts = hourlyData.map(function(d, i) {
        return { x: pad.left + (i / 23) * w, y: pad.top + h - (d.cost / maxCost) * h, cost: d.cost, msgs: d.msgs, hour: d.hour };
      });
      var linePath = smoothPath(pts);
      var areaPathD = smoothArea(pts, pad.top + h);

      var gridLines2 = [0, 0.25, 0.5, 0.75, 1].map(function(pct) {
        var y = pad.top + h - pct * h;
        return '<line x1="' + pad.left + '" y1="' + y + '" x2="' + (width - pad.right) + '" y2="' + y + '" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>' +
          '<text x="' + (pad.left - 8) + '" y="' + (y + 4) + '" text-anchor="end" fill="rgba(255,255,255,0.35)" font-size="10">' + fmtCost(pct * maxCost) + '</text>';
      }).join('');

      var xLabels2 = pts.filter(function(_, i) { return i % 3 === 0; })
        .map(function(p) { return '<text x="' + p.x + '" y="' + (pad.top + h + 24) + '" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-size="10">' + String(p.hour).padStart(2, '0') + ':00</text>'; }).join('');

      var pointData2 = JSON.stringify(pts.map(function(p) {
        return { x: +p.x.toFixed(1), y: +p.y.toFixed(1), date: String(p.hour).padStart(2, '0') + ':00 - ' + String(p.hour).padStart(2, '0') + ':59', cost: fmtCost(p.cost), msgs: p.msgs + ' messages', tokens: '' };
      }));

      var dots2 = pts.map(function(p, i) {
        return '<circle cx="' + p.x + '" cy="' + p.y + '" r="3" fill="#89b4fa" stroke="#1e1e2e" stroke-width="1.5" class="data-dot" data-idx="' + i + '" opacity="0.4"/>';
      }).join('');

      return '<svg width="100%" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="xMidYMid meet" class="chart-svg" id="cost-chart" data-points="' + pointData2.replace(/"/g, '&quot;') + '" data-pad-left="' + pad.left + '" data-pad-top="' + pad.top + '" data-chart-h="' + h + '">' +
        '<defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#89b4fa" stop-opacity="0.3"/><stop offset="100%" stop-color="#89b4fa" stop-opacity="0.02"/></linearGradient>' +
        '<linearGradient id="lineGrad" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#74c7ec"/><stop offset="50%" stop-color="#89b4fa"/><stop offset="100%" stop-color="#b4befe"/></linearGradient></defs>' +
        gridLines2 +
        '<path d="' + areaPathD + '" fill="url(#areaGrad)" class="chart-area-fill"/>' +
        '<path d="' + linePath + '" fill="none" stroke="url(#lineGrad)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="chart-line"/>' +
        xLabels2 + dots2 +
        '<line id="track-line" x1="0" y1="' + pad.top + '" x2="0" y2="' + (pad.top + h) + '" stroke="rgba(137,180,250,0.3)" stroke-width="1" stroke-dasharray="3,3" visibility="hidden"/>' +
        '<circle id="track-dot" cx="0" cy="0" r="6" fill="#89b4fa" stroke="#fff" stroke-width="2" visibility="hidden" style="filter:drop-shadow(0 0 6px rgba(137,180,250,0.5))"/>' +
        '<rect id="chart-overlay" x="' + pad.left + '" y="' + pad.top + '" width="' + w + '" height="' + h + '" fill="transparent" style="cursor:crosshair"/>' +
        '</svg>';
    }
  }

  // ── Period label helpers ──
  var periodLabels = { 1: 'Today', 7: 'Last 7 Days', 30: 'Last 30 Days', 365: 'Last Year', 0: 'All Time' };
  var chartMode = 'cost'; // 'cost' or 'tokens'

  // ── Render chart based on current mode ──
  function renderChart(sorted, agg) {
    var chartArea = document.getElementById('chart-area');
    var subtitle = document.getElementById('chart-subtitle');
    var summaryEl = document.querySelector('.period-summary');
    var metaEl = document.getElementById('period-meta');
    if (!chartArea) return;

    chartArea.classList.add('transitioning');
    setTimeout(function() {
      if (currentPeriod === 1) {
        // 1D: hourly chart using today's data
        var todayData = ALL_STATS.find(function(s) { return s.date === todayKey; }) || { date: todayKey, totalCost: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, messageCount: 0, modelBreakdown: {}, toolUsage: {}, hourlyActivity: new Array(24).fill(0), sessionCount: 0, projectBreakdown: {} };
        chartArea.innerHTML = buildHourlyAreaSVG(todayData, 700, 220, chartMode);
        if (subtitle) subtitle.style.display = chartMode === 'tokens' ? 'flex' : 'none';
        if (summaryEl) summaryEl.style.display = chartMode === 'cost' ? '' : 'none';
        if (metaEl) metaEl.style.display = chartMode === 'cost' ? '' : 'none';
      } else if (chartMode === 'cost') {
        chartArea.innerHTML = buildAreaChartSVG(sorted, 700, 220);
        if (subtitle) subtitle.style.display = 'none';
        if (summaryEl) summaryEl.style.display = '';
        if (metaEl) metaEl.style.display = '';
      } else {
        chartArea.innerHTML = buildTokenAreaSVG(sorted, 700, 220);
        if (subtitle) subtitle.style.display = 'flex';
        if (summaryEl) summaryEl.style.display = 'none';
        if (metaEl) metaEl.style.display = 'none';
      }
      chartArea.classList.remove('transitioning');
      attachChartListeners();
    }, 150);
  }

  // ── Update everything for a period ──
  function switchPeriod(period) {
    currentPeriod = period;
    var filtered = filterByPeriod(period);
    var sorted = filtered.slice().sort(function(a, b) { return a.date.localeCompare(b.date); });
    var agg = computeFiltered(filtered);

    // Update active tab
    document.querySelectorAll('.period-tab').forEach(function(tab) {
      tab.classList.toggle('active', parseInt(tab.getAttribute('data-period')) === period);
    });

    // Update header
    var headerLabel = document.getElementById('header-period-label');
    if (headerLabel) headerLabel.textContent = periodLabels[period] || ('Last ' + period + ' days');

    // Update period summary (cost mode)
    var totalEl = document.getElementById('period-total');
    if (totalEl) totalEl.textContent = fmtCost(agg.totalCost);

    var changeEl = document.getElementById('period-change');
    if (changeEl) {
      var today = filtered.find(function(s) { return s.date === todayKey; });
      var yd = new Date(); yd.setDate(yd.getDate() - 1);
      var yesterdayKey = yd.toISOString().slice(0, 10);
      var yesterday = filtered.find(function(s) { return s.date === yesterdayKey; });
      var todayCost = today ? today.totalCost : 0;
      var yesterdayCost = yesterday ? yesterday.totalCost : 0;
      var costChange = yesterdayCost > 0 ? ((todayCost - yesterdayCost) / yesterdayCost) * 100 : 0;
      var changeIcon = costChange > 0 ? '\u25B2' : costChange < 0 ? '\u25BC' : '\u2022';
      var changeColor = costChange > 0 ? '#f38ba8' : costChange < 0 ? '#a6e3a1' : 'rgba(255,255,255,0.4)';
      var changeText = costChange !== 0 ? Math.abs(costChange).toFixed(0) + '% vs yesterday' : 'same as yesterday';
      changeEl.style.color = changeColor;
      changeEl.textContent = changeIcon + ' ' + changeText;
    }

    var metaEl = document.getElementById('period-meta');
    if (metaEl) {
      if (period === 1) {
        metaEl.textContent = 'Hourly breakdown \u00B7 ' + agg.totalMsgs + ' messages \u00B7 ' + fmtTokens(agg.totalInput + agg.totalOutput) + ' tokens';
      } else {
        metaEl.textContent = filtered.length + ' days \u00B7 avg ' + fmtCost(agg.avgDailyCost) + '/day \u00B7 peak ' + fmtCost(agg.peakDay.totalCost) + ' on ' + fmtDate(agg.peakDay.date);
      }
    }

    // Update token subtitle stats
    var tokenBadge = document.getElementById('token-badge');
    if (tokenBadge) tokenBadge.textContent = fmtTokens(agg.totalInput + agg.totalOutput + agg.totalCacheWrite + agg.totalCacheRead) + ' TOTAL';
    var tokenInputLabel = document.getElementById('token-input-label');
    if (tokenInputLabel) tokenInputLabel.textContent = fmtTokens(agg.totalInput);
    var tokenOutputLabel = document.getElementById('token-output-label');
    if (tokenOutputLabel) tokenOutputLabel.textContent = fmtTokens(agg.totalOutput);

    // Render chart based on current mode
    renderChart(sorted, agg);

    // Update model distribution
    var modelBadge = document.getElementById('model-badge');
    if (modelBadge) modelBadge.textContent = fmtCost(agg.totalCost);
    var modelDonutArea = document.getElementById('model-donut-area');
    if (modelDonutArea) {
      var colors = ['#89b4fa','#a6e3a1','#fab387','#f38ba8','#f9e2af','#cba6f7','#94e2d5'];
      var sortedModels = Object.keys(agg.modelTotals).sort(function(a, b) { return agg.modelTotals[b].cost - agg.modelTotals[a].cost; });
      var legendHtml = sortedModels.map(function(name, i) {
        var data = agg.modelTotals[name];
        var color = colors[i % colors.length];
        var pct = agg.totalCost > 0 ? ((data.cost / agg.totalCost) * 100).toFixed(0) : '0';
        return '<div class="legend-item"><span class="legend-dot" style="background:' + color + '"></span><span class="legend-name">' + fmtModel(name) + '</span><span class="legend-val">' + fmtCost(data.cost) + '</span><span class="legend-pct">' + pct + '%</span></div>';
      }).join('');
      modelDonutArea.innerHTML = buildDonutSVG(agg.modelTotals, 140) + '<div class="legend">' + legendHtml + '</div>';
    }

    // Update cache stats
    var cacheReads = document.getElementById('cache-reads');
    if (cacheReads) cacheReads.textContent = fmtTokens(agg.totalCacheRead);
    var cacheWrites = document.getElementById('cache-writes');
    if (cacheWrites) cacheWrites.textContent = fmtTokens(agg.totalCacheWrite);
    var cacheHitRate = document.getElementById('cache-hit-rate');
    if (cacheHitRate) cacheHitRate.textContent = (agg.totalCacheRead + agg.totalInput) > 0 ? ((agg.totalCacheRead / (agg.totalCacheRead + agg.totalInput)) * 100).toFixed(0) + '%' : '0%';
    var cacheSavings = document.getElementById('cache-savings');
    if (cacheSavings) cacheSavings.textContent = '~' + fmtCost(agg.cacheSavings);

    // Update daily table
    var tbody = document.getElementById('daily-tbody');
    if (tbody) {
      var peakCost = agg.peakDay.totalCost || 1;
      tbody.innerHTML = filtered.map(function(day) {
        var isToday = day.date === todayKey;
        return '<tr class="' + (isToday ? 'row-today' : '') + '">' +
          '<td class="cell-date">' + fmtDate(day.date) + (isToday ? '<span class="badge-today">TODAY</span>' : '') + '</td>' +
          '<td class="cell-cost">' + fmtCost(day.totalCost) + '</td>' +
          '<td class="cell-tokens">' + fmtTokens(day.inputTokens + day.outputTokens) + '</td>' +
          '<td class="cell-msgs">' + day.messageCount + '</td>' +
          '<td class="cell-bar"><div class="mini-bar"><div class="mini-bar-fill" style="width:' + (peakCost > 0 ? (day.totalCost / peakCost * 100) : 0) + '%"></div></div></td></tr>';
      }).join('');
    }
    var peakBadge = document.getElementById('daily-peak-badge');
    if (peakBadge) peakBadge.textContent = 'PEAK: ' + fmtDate(agg.peakDay.date) + ' at ' + fmtCost(agg.peakDay.totalCost);
  }

  // ── Animate SVG line lengths ──
  function initChartAnimations() {
    // Animate line drawing
    document.querySelectorAll('.chart-line').forEach(function(line) {
      var len = line.getTotalLength ? line.getTotalLength() : 0;
      if (len > 0) {
        line.style.setProperty('--line-length', len + 'px');
        line.style.animation = 'none';
        line.offsetHeight; // force reflow
        line.style.animation = '';
      }
    });
    // Animate area fill
    document.querySelectorAll('.chart-area-fill').forEach(function(area) {
      area.style.animation = 'none';
      area.offsetHeight;
      area.style.animation = '';
    });
    // Stagger dot animations
    document.querySelectorAll('.data-dot').forEach(function(dot, i) {
      dot.style.animation = 'none';
      dot.offsetHeight;
      dot.style.animation = 'dotPopIn 0.3s ease-out both';
      dot.style.animationDelay = (0.5 + i * 0.04) + 's';
    });
  }

  // ── Chart tooltip interaction ──
  function attachChartListeners() {
    initChartAnimations();
    var chart = document.getElementById('cost-chart');
    var trackLine = document.getElementById('track-line');
    var trackDot = document.getElementById('track-dot');
    var overlay = document.getElementById('chart-overlay');

    var chartPoints = [];
    if (chart) {
      try { chartPoints = JSON.parse(chart.getAttribute('data-points') || '[]'); } catch(e) {}
    }

    var activeIdx = -1;

    if (overlay && chartPoints.length > 0) {
      overlay.addEventListener('mousemove', function(e) {
        var svg = chart;
        var pt = svg.createSVGPoint();
        pt.x = e.clientX;
        pt.y = e.clientY;
        var svgPt = pt.matrixTransform(svg.getScreenCTM().inverse());

        var minDist = Infinity, nearest = 0;
        for (var i = 0; i < chartPoints.length; i++) {
          var dist = Math.abs(chartPoints[i].x - svgPt.x);
          if (dist < minDist) { minDist = dist; nearest = i; }
        }

        if (nearest === activeIdx) return;
        activeIdx = nearest;
        var p = chartPoints[nearest];

        trackLine.setAttribute('x1', p.x);
        trackLine.setAttribute('x2', p.x);
        trackLine.setAttribute('visibility', 'visible');
        trackDot.setAttribute('cx', p.x);
        trackDot.setAttribute('cy', p.y);
        trackDot.setAttribute('visibility', 'visible');

        chart.querySelectorAll('.data-dot').forEach(function(dot, i) {
          dot.setAttribute('opacity', i === nearest ? '1' : '0.25');
          dot.setAttribute('r', i === nearest ? '0' : '3');
        });

        tipTitle.textContent = p.date;
        tipRows.innerHTML = '';
        addRow('Cost', p.cost);
        addRow('Messages', p.msgs);
        addRow('Tokens', p.tokens);

        var dotScreenPt = svg.createSVGPoint();
        dotScreenPt.x = p.x;
        dotScreenPt.y = p.y;
        var screenPos = dotScreenPt.matrixTransform(svg.getScreenCTM());

        var vw = window.innerWidth;
        var tx = screenPos.x + 16;
        var ty = screenPos.y - 40;
        if (tx + 180 > vw) tx = screenPos.x - 196;
        if (ty < 8) ty = 8;

        tooltip.style.left = tx + 'px';
        tooltip.style.top = ty + 'px';
        tooltip.classList.add('visible');
      });

      overlay.addEventListener('mouseleave', function() {
        activeIdx = -1;
        trackLine.setAttribute('visibility', 'hidden');
        trackDot.setAttribute('visibility', 'hidden');
        chart.querySelectorAll('.data-dot').forEach(function(dot) {
          dot.setAttribute('opacity', '0.4');
          dot.setAttribute('r', '3');
        });
        tooltip.classList.remove('visible');
      });
    }
  }

  // ── Generic tooltip for other charts ──
  document.addEventListener('mousemove', function(e) {
    if (e.target.closest('#cost-chart')) return;
    var target = e.target.closest('[data-tip-date]');
    if (target) {
      var date = target.getAttribute('data-tip-date');
      var cost = target.getAttribute('data-tip-cost');
      var msgs = target.getAttribute('data-tip-msgs');
      var tokens = target.getAttribute('data-tip-tokens');
      if (!date) return;
      tipTitle.textContent = date;
      tipRows.innerHTML = '';
      if (cost) addRow('Cost', cost);
      if (msgs) addRow('Messages', msgs);
      if (tokens) addRow('Tokens', tokens);
      var vw = window.innerWidth;
      var x = e.clientX + 14, y = e.clientY - 10;
      if (x + 180 > vw) x = e.clientX - 180;
      if (y < 8) y = 8;
      tooltip.style.left = x + 'px';
      tooltip.style.top = y + 'px';
      tooltip.classList.add('visible');
    } else {
      tooltip.classList.remove('visible');
    }
  });

  document.addEventListener('mouseleave', function() {
    tooltip.classList.remove('visible');
  });

  // ── Period tab click handlers ──
  document.querySelectorAll('.period-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      var period = parseInt(this.getAttribute('data-period'));
      switchPeriod(period);
    });
  });

  // ── Chart mode toggle (Cost / Tokens) ──
  document.querySelectorAll('.chart-mode-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      var mode = this.getAttribute('data-mode');
      if (mode === chartMode) return;
      chartMode = mode;
      document.querySelectorAll('.chart-mode-tab').forEach(function(t) {
        t.classList.toggle('active', t.getAttribute('data-mode') === mode);
      });
      var title = document.getElementById('chart-section-title');
      if (title) title.textContent = mode === 'cost' ? 'Cost Trend' : 'Token Usage';
      // Re-render with current period
      switchPeriod(currentPeriod);
    });
  });

  // ── Daily breakdown collapse toggle ──
  var dailyToggle = document.getElementById('daily-toggle');
  var dailyBody = document.getElementById('daily-body');
  if (dailyToggle && dailyBody) {
    dailyToggle.addEventListener('click', function() {
      var expanded = dailyBody.classList.toggle('expanded');
      dailyToggle.classList.toggle('expanded', expanded);
      dailyToggle.setAttribute('aria-expanded', expanded.toString());
      dailyToggle.childNodes[0].textContent = expanded ? 'Hide ' : 'Show ';
    });
  }

  // ── Initial chart listeners ──
  attachChartListeners();
})();
</script>
</body>
</html>`;
}
