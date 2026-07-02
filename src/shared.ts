import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Model pricing per 1M tokens (API-equivalent costs) ──────────────

// Rates from platform.claude.com pricing (verified 2026-07). Cache write = 1.25x
// input (5m TTL), cache read = 0.1x input.
export const MODEL_PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  "claude-fable-5": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  "claude-mythos-5": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-sonnet-5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

export const DEFAULT_PRICING = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };

/** "claude-fable-5" → "Fable 5", "claude-opus-4-8" → "Opus 4.8" — works for
 *  any claude-{family}-{version} id so future models display sanely. */
export function formatModelDisplay(model: string): string {
  const m = model.match(/^claude-([a-z]+)-(\d+(?:-\d+)*)/);
  if (!m) return model;
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return `${family} ${m[2].replace(/-/g, ".")}`;
}

export function normalizeModel(raw: string | undefined): string | null {
  if (!raw || raw === "<synthetic>" || !raw.startsWith("claude-")) return null;
  return raw.replace(/-\d{8,}$/, "");
}

export function calculateCost(
  input: number, output: number, cacheWrite: number, cacheRead: number,
  pricing: { input: number; output: number; cacheWrite: number; cacheRead: number }
): number {
  return (input / 1_000_000) * pricing.input +
    (output / 1_000_000) * pricing.output +
    (cacheWrite / 1_000_000) * pricing.cacheWrite +
    (cacheRead / 1_000_000) * pricing.cacheRead;
}

// ── Formatters ───────────────────────────────────────────────────────

export function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toString();
}

export function fmtCost(n: number): string {
  return n < 10 ? `$${n.toFixed(2)}` : `$${n.toFixed(1)}`;
}

export function fmtModel(model: string): string {
  const stripped = model.replace("claude-", "").replace(/-\d{8,}$/, "");
  const match = stripped.match(/^(\w+)-(\d+)-(\d+)$/);
  if (match) return match[1].charAt(0).toUpperCase() + match[1].slice(1) + " " + match[2] + "." + match[3];
  return stripped.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export function fmtDate(d: string): string {
  const dt = new Date(d + "T00:00:00");
  return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export function fmtDateShort(d: string): string {
  const dt = new Date(d + "T00:00:00");
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function fmtPct(r: number): string {
  return (r * 100).toFixed(1) + "%";
}

export function fmtDateTime(d: Date | null): string {
  if (!d) return "unknown";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

// ── Cache threshold colors ───────────────────────────────────────────

export function cacheRatioColor(ratio: number): string {
  if (ratio >= 0.80) return "#a6e3a1";
  if (ratio >= 0.40) return "#f9e2af";
  return "#f38ba8";
}

export function cacheStatusColor(status: string): string {
  if (status === "healthy") return "#a6e3a1";
  if (status === "warning") return "#f9e2af";
  return "#f38ba8";
}

// ── SVG helpers ──────────────────────────────────────────────────────

export function smoothPathTS(pts: { x: number; y: number }[], minY?: number, maxY?: number): string {
  if (pts.length < 2) return "";
  if (pts.length === 2) return `M${pts[0].x},${pts[0].y} L${pts[1].x},${pts[1].y}`;
  const clamp = (y: number, segMinY: number, segMaxY: number) => {
    let v = y;
    if (minY !== undefined && v < minY) v = minY;
    if (maxY !== undefined && v > maxY) v = maxY;
    v = Math.max(Math.min(segMinY, segMaxY), Math.min(Math.max(segMinY, segMaxY), v));
    return v;
  };
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i === 0 ? 0 : i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2 < pts.length ? i + 2 : pts.length - 1];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = clamp(p1.y + (p2.y - p0.y) / 6, p1.y, p2.y);
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = clamp(p2.y - (p3.y - p1.y) / 6, p1.y, p2.y);
    d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

export function smoothAreaTS(pts: { x: number; y: number }[], baseY: number, minY?: number): string {
  if (pts.length < 2) return "";
  return smoothPathTS(pts, minY, baseY) + ` L${pts[pts.length - 1].x},${baseY} L${pts[0].x},${baseY} Z`;
}

export function buildRingGauge(pct: number, size: number, color: string, strokeWidth = 5, bgColor = "rgba(255,255,255,0.06)"): string {
  const r = (size - strokeWidth - 1) / 2;
  const cx = size / 2, cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const dashOffset = circumference * (1 - pct);
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="token-gauge-ring">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${bgColor}" stroke-width="${strokeWidth}"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${strokeWidth}"
      stroke-dasharray="${circumference}" stroke-dashoffset="${dashOffset}"
      stroke-linecap="round" transform="rotate(-90 ${cx} ${cy})"
      style="transition: stroke-dashoffset 0.6s ease"/>
  </svg>`;
}

export function buildDonutChart(
  segments: { label: string; value: number; color: string }[],
  size: number,
  centerTop: string,
  centerBottom: string,
  tooltipFormatter?: (seg: { label: string; value: number; color: string }, pct: number) => { date: string; cost: string; msgs: string; tokens: string }
): string {
  const filtered = segments.filter(s => s.value > 0);
  if (filtered.length === 0) return "";
  const total = filtered.reduce((s, seg) => s + seg.value, 0);
  if (total === 0) return "";
  const cx = size / 2, cy = size / 2, r = size / 2 - 8, inner = r * 0.62;
  let cumAngle = -Math.PI / 2;

  const arcs = filtered.map((seg) => {
    const pct = seg.value / total;
    const angle = pct * Math.PI * 2;
    const startAngle = cumAngle;
    cumAngle += angle;
    const endAngle = cumAngle;
    const largeArc = angle > Math.PI ? 1 : 0;
    const x1 = cx + r * Math.cos(startAngle), y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle), y2 = cy + r * Math.sin(endAngle);
    const ix1 = cx + inner * Math.cos(endAngle), iy1 = cy + inner * Math.sin(endAngle);
    const ix2 = cx + inner * Math.cos(startAngle), iy2 = cy + inner * Math.sin(startAngle);
    const tip = tooltipFormatter
      ? tooltipFormatter(seg, pct)
      : { date: seg.label, cost: `${seg.value}`, msgs: `${(pct * 100).toFixed(1)}% of total`, tokens: "" };
    return `<path d="M${x1},${y1} A${r},${r} 0 ${largeArc},1 ${x2},${y2} L${ix1},${iy1} A${inner},${inner} 0 ${largeArc},0 ${ix2},${iy2} Z"
                  fill="${seg.color}" opacity="0.85" class="donut-segment"
                  data-tip-date="${tip.date}" data-tip-cost="${tip.cost}" data-tip-msgs="${tip.msgs}" data-tip-tokens="${tip.tokens}"/>`;
  }).join("\n");

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="chart-svg">
    ${arcs}
    <text x="${cx}" y="${cy - 6}" text-anchor="middle" fill="#cdd6f4" font-size="16" font-weight="700">${centerTop}</text>
    <text x="${cx}" y="${cy + 12}" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-size="10">${centerBottom}</text>
  </svg>`;
}

// ── File utilities ───────────────────────────────────────────────────

export const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

export function decodeProjectName(dirName: string): string {
  const match = dirName.match(/^([a-z])--(.+)$/);
  if (match) {
    return match[1].toUpperCase() + ":/" + match[2].split("--").join("/");
  }
  return dirName;
}

export interface JsonlFileEntry {
  path: string;
  mtime: number;
  project: string;
}

export function findJsonlFiles(cutoffDate?: Date, maxFiles = 0, includeSubagents = false): JsonlFileEntry[] {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  const cutoffMs = cutoffDate?.getTime() ?? 0;
  const files: JsonlFileEntry[] = [];

  try {
    for (const project of fs.readdirSync(PROJECTS_DIR)) {
      const projectDir = path.join(PROJECTS_DIR, project);
      let dirStat: fs.Stats;
      try { dirStat = fs.statSync(projectDir); } catch { continue; }
      if (!dirStat.isDirectory()) continue;
      if (cutoffMs && dirStat.mtimeMs < cutoffMs) continue;

      const projectName = decodeProjectName(project);
      const scanDirs = [projectDir];
      if (includeSubagents) {
        const subDir = path.join(projectDir, "subagents");
        if (fs.existsSync(subDir)) scanDirs.push(subDir);
      }

      for (const dir of scanDirs) {
        try {
          for (const file of fs.readdirSync(dir)) {
            if (!file.endsWith(".jsonl")) continue;
            const filePath = path.join(dir, file);
            try {
              const st = fs.statSync(filePath);
              if (cutoffMs && st.mtimeMs < cutoffMs) continue;
              files.push({ path: filePath, mtime: st.mtimeMs, project: projectName });
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* permission errors */ }

  files.sort((a, b) => b.mtime - a.mtime);
  return maxFiles > 0 ? files.slice(0, maxFiles) : files;
}
