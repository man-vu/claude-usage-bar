import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import {
  MODEL_PRICING, DEFAULT_PRICING, normalizeModel, calculateCost,
  PROJECTS_DIR, decodeProjectName,
} from "./shared";

export interface SessionSnapshot {
  file: string;
  project: string;
  startedAt: string | null;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cacheWrite: number;
  cacheRead: number;
  cost: number;
  cacheHitRate: number;
  model: string | null;
  turnRatios: number[];
  turnCosts: number[];
  elapsedMs: number;
}

const MAX_SPARKLINE = 30;
const POLL_INTERVAL_MS = 10_000; // Check for new session files every 10s

export class SessionMonitor extends EventEmitter {
  private watcher: fs.FSWatcher | undefined;
  private filePath: string | null = null;
  private project = "";
  private bytesRead = 0;
  private partialLine = "";
  private snap: SessionSnapshot = emptySnap("");
  private startTime = 0;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private seenIds = new Set<string>();
  private lastProjectsMtime = 0;

  start(): void {
    this.stop();
    this.filePath = findLatestSession();
    if (!this.filePath) return;

    this.project = decodeProject(this.filePath);
    this.snap = emptySnap(this.filePath);
    this.snap.project = this.project;
    this.bytesRead = 0;
    this.partialLine = "";
    this.startTime = Date.now();
    this.seenIds.clear();

    this.readNewBytes();

    try {
      this.watcher = fs.watch(this.filePath, { persistent: false }, () => this.readNewBytes());
    } catch { /* fall through to poll */ }

    this.pollTimer = setInterval(() => this.checkForNewFile(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.watcher) { this.watcher.close(); this.watcher = undefined; }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
    this.filePath = null;
  }

  getSnapshot(): SessionSnapshot {
    return { ...this.snap, elapsedMs: this.startTime ? Date.now() - this.startTime : 0 };
  }

  private checkForNewFile(): void {
    // Skip re-scan if projects directory hasn't changed
    try {
      const st = fs.statSync(PROJECTS_DIR);
      if (st.mtimeMs === this.lastProjectsMtime) {
        // Directory unchanged — just read new bytes from current file
        if (this.filePath) this.readNewBytes();
        return;
      }
      this.lastProjectsMtime = st.mtimeMs;
    } catch { return; }

    const latest = findLatestSession();
    if (latest && latest !== this.filePath) {
      if (this.watcher) { this.watcher.close(); this.watcher = undefined; }
      this.filePath = latest;
      this.project = decodeProject(latest);
      this.snap = emptySnap(latest);
      this.snap.project = this.project;
      this.bytesRead = 0;
      this.partialLine = "";
      this.startTime = Date.now();
      this.seenIds.clear();
      this.readNewBytes();
      try {
        this.watcher = fs.watch(this.filePath, { persistent: false }, () => this.readNewBytes());
      } catch { /* ignore */ }
    } else if (this.filePath) {
      this.readNewBytes();
    }
  }

  private readNewBytes(): void {
    if (!this.filePath) return;
    let stat: fs.Stats;
    try { stat = fs.statSync(this.filePath); } catch { return; }
    if (stat.size <= this.bytesRead) return;

    const buf = Buffer.alloc(stat.size - this.bytesRead);
    let fd: number;
    try { fd = fs.openSync(this.filePath, "r"); } catch { return; }
    try {
      fs.readSync(fd, buf, 0, buf.length, this.bytesRead);
    } finally { fs.closeSync(fd); }

    this.bytesRead = stat.size;
    const text = this.partialLine + buf.toString("utf-8");
    const lines = text.split("\n");
    this.partialLine = lines.pop() ?? "";

    let changed = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      if (this.processLine(line)) changed = true;
    }

    if (changed) {
      this.snap.elapsedMs = Date.now() - this.startTime;
      this.emit("update", this.getSnapshot());
    }
  }

  private processLine(line: string): boolean {
    if (!line.includes('"type"')) return false;

    try {
      const d = JSON.parse(line);
      if (!this.snap.startedAt && d.timestamp) this.snap.startedAt = d.timestamp;
      if (d.type !== "assistant") return false;

      const msg = d.message;
      if (!msg || typeof msg !== "object" || !msg.usage) return false;

      const msgId: string = msg.id ?? "";
      if (msgId && this.seenIds.has(msgId)) return false;
      if (msgId) this.seenIds.add(msgId);

      const usage = msg.usage;
      const model = normalizeModel(msg.model);
      if (!model) return false;

      if (!this.snap.model) this.snap.model = model;
      const pricing = MODEL_PRICING[model] ?? DEFAULT_PRICING;

      const input: number = usage.input_tokens ?? 0;
      const output: number = usage.output_tokens ?? 0;
      const cw: number = usage.cache_creation_input_tokens ?? 0;
      const cr: number = usage.cache_read_input_tokens ?? 0;

      this.snap.inputTokens += input;
      this.snap.outputTokens += output;
      this.snap.cacheWrite += cw;
      this.snap.cacheRead += cr;
      this.snap.messages += 1;
      this.snap.cost += calculateCost(input, output, cw, cr, pricing);

      const totalCache = this.snap.cacheWrite + this.snap.cacheRead;
      this.snap.cacheHitRate = totalCache > 0 ? this.snap.cacheRead / totalCache : 0;

      const turnTotal = cw + cr;
      this.snap.turnRatios.push(turnTotal > 0 ? cr / turnTotal : 0);
      if (this.snap.turnRatios.length > MAX_SPARKLINE) this.snap.turnRatios.shift();
      this.snap.turnCosts.push(this.snap.cost);
      if (this.snap.turnCosts.length > MAX_SPARKLINE) this.snap.turnCosts.shift();

      return true;
    } catch { return false; }
  }
}

function emptySnap(file: string): SessionSnapshot {
  return {
    file, project: "", startedAt: null, messages: 0,
    inputTokens: 0, outputTokens: 0, cacheWrite: 0, cacheRead: 0,
    cost: 0, cacheHitRate: 0, model: null,
    turnRatios: [], turnCosts: [], elapsedMs: 0,
  };
}

function findLatestSession(): string | null {
  if (!fs.existsSync(PROJECTS_DIR)) return null;
  let best: { path: string; mtime: number } | null = null;
  try {
    for (const project of fs.readdirSync(PROJECTS_DIR)) {
      const dir = path.join(PROJECTS_DIR, project);
      let stat: fs.Stats;
      try { stat = fs.statSync(dir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      try {
        for (const file of fs.readdirSync(dir)) {
          if (!file.endsWith(".jsonl")) continue;
          const fp = path.join(dir, file);
          try {
            const st = fs.statSync(fp);
            if (!best || st.mtimeMs > best.mtime) best = { path: fp, mtime: st.mtimeMs };
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return best?.path ?? null;
}

function decodeProject(filePath: string): string {
  return decodeProjectName(path.basename(path.dirname(filePath)));
}
