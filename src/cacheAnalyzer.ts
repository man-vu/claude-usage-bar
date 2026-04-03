import * as fs from "fs";
import * as readline from "readline";
import { findJsonlFiles } from "./shared";

const HEALTHY_THRESHOLD = 0.80;
const WARNING_THRESHOLD = 0.40;
const MIN_TURNS = 3;

export type CacheStatus = "healthy" | "warning" | "affected";

export interface SessionCacheMetrics {
  file: string;
  sessionId: string | null;
  version: string | null;
  model: string | null;
  isSubagent: boolean;
  turns: number;
  totalCreate: number;
  totalRead: number;
  readRatio: number;
  postColdRatio: number;
  status: CacheStatus;
  bug1Likely: boolean;
  bug2Likely: boolean;
  firstTs: Date | null;
  lastTs: Date | null;
}

export interface VersionBreakdown {
  version: string;
  sessions: number;
  avgReadRatio: number;
  affected: number;
  healthy: number;
  warning: number;
}

export interface CacheAnalysisResult {
  mainSessions: SessionCacheMetrics[];
  subagentSessions: SessionCacheMetrics[];
  overallReadRatio: number;
  totalCreate: number;
  totalRead: number;
  healthyCounts: { healthy: number; warning: number; affected: number };
  bug1Count: number;
  bug2Count: number;
  versionBreakdown: VersionBreakdown[];
  wastedTokenEstimate: number;
  verdict: "NOT_AFFECTED" | "MILDLY_AFFECTED" | "MODERATELY_AFFECTED" | "SEVERELY_AFFECTED";
  dailyCacheRatios: { date: string; readRatio: number; create: number; read: number; sessions: number }[];
}

// ── Session parser ───────────────────────────────────────────────────

async function parseSession(filepath: string): Promise<SessionCacheMetrics | null> {
  let totalCreate = 0;
  let totalRead = 0;
  let turns = 0;
  const seenMsgIds = new Set<string>();
  let version: string | null = null;
  let sessionId: string | null = null;
  let model: string | null = null;
  let firstTs: Date | null = null;
  let lastTs: Date | null = null;
  const isSubagent = filepath.includes("subagents");

  // Only track turns 1-4 for Bug 2 detection (no need to store all turns)
  let postColdCreate = 0;
  let postColdRead = 0;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => { rl.close(); stream.destroy(); resolve(null); }, 5000);
    const stream = fs.createReadStream(filepath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", (line) => {
      try {
        const d = JSON.parse(line);
        const recordType = d.type ?? "";

        if ((recordType === "system" || recordType === "progress")) {
          if (!version && d.version) version = d.version;
          if (!sessionId && d.sessionId) sessionId = d.sessionId;
        }

        if (recordType === "assistant") {
          const msg = d.message;
          if (!msg || typeof msg !== "object") return;
          const usage = msg.usage;
          if (!usage) return;

          const msgId: string = msg.id ?? "";
          if (msgId && seenMsgIds.has(msgId)) return;
          if (msgId) seenMsgIds.add(msgId);

          if (!model && msg.model) model = msg.model;

          const create: number = usage.cache_creation_input_tokens ?? 0;
          const read: number = usage.cache_read_input_tokens ?? 0;
          totalCreate += create;
          totalRead += read;
          turns += 1;

          // Track turns 2-4 for Bug 2 detection
          if (turns >= 2 && turns <= 4) {
            postColdCreate += create;
            postColdRead += read;
          }
        }

        const tsStr = d.timestamp;
        if (tsStr) {
          try {
            const ts = new Date(tsStr);
            if (!isNaN(ts.getTime())) {
              if (firstTs === null || ts < firstTs) firstTs = ts;
              if (lastTs === null || ts > lastTs) lastTs = ts;
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    });

    rl.on("close", () => {
      clearTimeout(timeout);
      if (turns < MIN_TURNS) { resolve(null); return; }

      const total = totalCreate + totalRead;
      const readRatio = total > 0 ? totalRead / total : 0;

      const pcTotal = postColdCreate + postColdRead;
      const postColdRatio = pcTotal > 0 ? postColdRead / pcTotal : 1.0;

      let status: CacheStatus;
      if (readRatio >= HEALTHY_THRESHOLD) status = "healthy";
      else if (readRatio >= WARNING_THRESHOLD) status = "warning";
      else status = "affected";

      const bug2Likely = postColdRatio < 0.5 && turns > 5;
      const bug1Likely = status === "affected" && !bug2Likely;

      resolve({
        file: filepath, sessionId, version, model, isSubagent, turns,
        totalCreate, totalRead, readRatio, postColdRatio,
        status, bug1Likely, bug2Likely, firstTs, lastTs,
      });
    });

    rl.on("error", () => { clearTimeout(timeout); resolve(null); });
  });
}

// ── Main analysis ────────────────────────────────────────────────────

const DEFAULT_DAYS = 30;

export async function analyzeCacheHealth(days: number = DEFAULT_DAYS): Promise<CacheAnalysisResult> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const allFiles = findJsonlFiles(cutoff, 0, true);

  if (allFiles.length === 0) return emptyResult();

  const results: SessionCacheMetrics[] = [];
  const batchSize = 20;
  for (let i = 0; i < allFiles.length; i += batchSize) {
    const batch = allFiles.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(f => parseSession(f.path)));
    for (const r of batchResults) {
      if (!r) continue;
      if (r.lastTs && r.lastTs < cutoff) continue;
      results.push(r);
    }
  }

  const mainSessions = results.filter(r => !r.isSubagent);
  const subagentSessions = results.filter(r => r.isSubagent);

  if (mainSessions.length === 0) return emptyResult();

  const totalCreate = mainSessions.reduce((s, r) => s + r.totalCreate, 0);
  const totalRead = mainSessions.reduce((s, r) => s + r.totalRead, 0);
  const totalTokens = totalCreate + totalRead;
  const overallReadRatio = totalTokens > 0 ? totalRead / totalTokens : 0;

  const healthy = mainSessions.filter(r => r.status === "healthy").length;
  const warning = mainSessions.filter(r => r.status === "warning").length;
  const affected = mainSessions.filter(r => r.status === "affected").length;

  const bug1Count = mainSessions.filter(r => r.bug1Likely).length;
  const bug2Count = mainSessions.filter(r => r.bug2Likely).length;

  // Version breakdown
  const versionMap = new Map<string, SessionCacheMetrics[]>();
  for (const r of mainSessions) {
    const v = r.version ?? "unknown";
    if (!versionMap.has(v)) versionMap.set(v, []);
    versionMap.get(v)!.push(r);
  }
  const versionBreakdown: VersionBreakdown[] = Array.from(versionMap.entries())
    .map(([version, sessions]) => ({
      version, sessions: sessions.length,
      avgReadRatio: sessions.reduce((s, r) => s + r.readRatio, 0) / sessions.length,
      affected: sessions.filter(r => r.status === "affected").length,
      healthy: sessions.filter(r => r.status === "healthy").length,
      warning: sessions.filter(r => r.status === "warning").length,
    }))
    .sort((a, b) => b.sessions - a.sessions);

  // Wasted token estimate
  const wastedTokenEstimate = Math.max(0, totalCreate - totalTokens * 0.05);

  // Verdict
  const affPct = affected / mainSessions.length;
  let verdict: CacheAnalysisResult["verdict"];
  if (affPct > 0.3 || overallReadRatio < 0.5) verdict = "SEVERELY_AFFECTED";
  else if (affPct > 0.1 || overallReadRatio < 0.7) verdict = "MODERATELY_AFFECTED";
  else if (affected > 0) verdict = "MILDLY_AFFECTED";
  else verdict = "NOT_AFFECTED";

  // Daily cache ratios
  const dailyMap = new Map<string, { create: number; read: number; sessions: number }>();
  for (const r of mainSessions) {
    const dateKey = r.firstTs ? r.firstTs.toISOString().slice(0, 10) : null;
    if (!dateKey) continue;
    if (!dailyMap.has(dateKey)) dailyMap.set(dateKey, { create: 0, read: 0, sessions: 0 });
    const day = dailyMap.get(dateKey)!;
    day.create += r.totalCreate;
    day.read += r.totalRead;
    day.sessions += 1;
  }
  const dailyCacheRatios = Array.from(dailyMap.entries())
    .map(([date, d]) => ({
      date,
      readRatio: (d.create + d.read) > 0 ? d.read / (d.create + d.read) : 0,
      create: d.create, read: d.read, sessions: d.sessions,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    mainSessions, subagentSessions, overallReadRatio,
    totalCreate, totalRead,
    healthyCounts: { healthy, warning, affected },
    bug1Count, bug2Count, versionBreakdown,
    wastedTokenEstimate, verdict, dailyCacheRatios,
  };
}

function emptyResult(): CacheAnalysisResult {
  return {
    mainSessions: [], subagentSessions: [], overallReadRatio: 0,
    totalCreate: 0, totalRead: 0,
    healthyCounts: { healthy: 0, warning: 0, affected: 0 },
    bug1Count: 0, bug2Count: 0, versionBreakdown: [],
    wastedTokenEstimate: 0, verdict: "NOT_AFFECTED", dailyCacheRatios: [],
  };
}
