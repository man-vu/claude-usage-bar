import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";

// Model pricing per 1M tokens (API-equivalent costs)
const MODEL_PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  "claude-opus-4-6": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-opus-4-5": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
};

const DEFAULT_PRICING = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };

/**
 * Normalize model IDs to canonical form:
 * "claude-haiku-4-5-20251001" → "claude-haiku-4-5"
 * "<synthetic>" / "opus" / "sonnet" → skip (non-billable)
 * "" / undefined → skip
 */
function normalizeModel(raw: string | undefined): string | null {
  if (!raw || raw === "<synthetic>" || !raw.startsWith("claude-")) return null;
  // Strip date suffixes like -20251001
  return raw.replace(/-\d{8,}$/, "");
}

export interface DailyStats {
  date: string;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  messageCount: number;
  modelBreakdown: Record<string, { cost: number; messages: number; inputTokens: number; outputTokens: number }>;
}

interface AssistantEntry {
  type: "assistant";
  timestamp: string;
  message: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

/**
 * Scans JSONL conversation files and returns stats grouped by date.
 * Only processes files modified within the scan window, sorted by recency.
 * @param maxFiles Cap on files to process (0 = unlimited)
 */
export async function scanConversations(days: number = 7, maxFiles: number = MAX_FILES): Promise<DailyStats[]> {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(projectsDir)) {
    return [];
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  cutoffDate.setHours(0, 0, 0, 0);

  const statsMap = new Map<string, DailyStats>();

  // Gather JSONL files with mtime, pre-filter and sort by recency
  const jsonlFiles = findJsonlFiles(projectsDir, cutoffDate, maxFiles);

  // Process in parallel batches — already filtered to recent files only
  const batchSize = 15;
  for (let i = 0; i < jsonlFiles.length; i += batchSize) {
    const batch = jsonlFiles.slice(i, i + batchSize);
    await Promise.all(batch.map((f) => processFile(f.path, cutoffDate, statsMap)));
  }

  return Array.from(statsMap.values()).sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Quick scan for today's stats only — no file cap so it matches the dashboard.
 */
export async function scanToday(): Promise<DailyStats> {
  const today = new Date().toISOString().slice(0, 10);
  const results = await scanConversations(1, 0); // 0 = no cap
  return results.find((s) => s.date === today) ?? emptyStats(today);
}

function emptyStats(date: string): DailyStats {
  return {
    date,
    totalCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    messageCount: 0,
    modelBreakdown: {},
  };
}

interface FileEntry {
  path: string;
  mtime: number;
}

const MAX_FILES = 80; // Cap to prevent scanning hundreds of old files

function findJsonlFiles(dir: string, cutoffDate: Date, maxFiles: number = MAX_FILES): FileEntry[] {
  const files: FileEntry[] = [];
  const cutoffMs = cutoffDate.getTime();

  try {
    for (const project of fs.readdirSync(dir)) {
      const projectDir = path.join(dir, project);
      let dirStat: fs.Stats;
      try {
        dirStat = fs.statSync(projectDir);
      } catch {
        continue;
      }
      if (!dirStat.isDirectory()) continue;

      // Skip entire project dirs that haven't been modified since cutoff
      if (dirStat.mtimeMs < cutoffMs) continue;

      try {
        for (const file of fs.readdirSync(projectDir)) {
          if (!file.endsWith(".jsonl")) continue;
          const filePath = path.join(projectDir, file);
          try {
            const st = fs.statSync(filePath);
            if (st.mtimeMs >= cutoffMs) {
              files.push({ path: filePath, mtime: st.mtimeMs });
            }
          } catch {
            // skip unreadable files
          }
        }
      } catch {
        // skip unreadable dirs
      }
    }
  } catch {
    // Permission errors
  }

  // Sort most recent first, optionally cap
  files.sort((a, b) => b.mtime - a.mtime);
  return maxFiles > 0 ? files.slice(0, maxFiles) : files;
}

async function processFile(
  filePath: string,
  cutoffDate: Date,
  statsMap: Map<string, DailyStats>
): Promise<void> {
  return new Promise((resolve) => {
    // Hard timeout per file — 3 seconds max
    const timeout = setTimeout(() => {
      rl.close();
      stream.destroy();
      resolve();
    }, 3000);

    const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", (line) => {
      if (!line.includes('"type":"assistant"')) return;

      try {
        const entry = JSON.parse(line) as AssistantEntry;
        if (entry.type !== "assistant" || !entry.message?.usage) return;

        const ts = new Date(entry.timestamp);
        if (ts < cutoffDate) return;

        const dateKey = ts.toISOString().slice(0, 10);
        const usage = entry.message.usage;
        const model = normalizeModel(entry.message.model);
        if (!model) return; // skip non-billable entries
        const pricing = MODEL_PRICING[model] ?? DEFAULT_PRICING;

        const inputTokens = usage.input_tokens ?? 0;
        const outputTokens = usage.output_tokens ?? 0;
        const cacheWrite = usage.cache_creation_input_tokens ?? 0;
        const cacheRead = usage.cache_read_input_tokens ?? 0;

        const cost =
          (inputTokens / 1_000_000) * pricing.input +
          (outputTokens / 1_000_000) * pricing.output +
          (cacheWrite / 1_000_000) * pricing.cacheWrite +
          (cacheRead / 1_000_000) * pricing.cacheRead;

        if (!statsMap.has(dateKey)) {
          statsMap.set(dateKey, emptyStats(dateKey));
        }
        const stats = statsMap.get(dateKey)!;

        stats.totalCost += cost;
        stats.inputTokens += inputTokens;
        stats.outputTokens += outputTokens;
        stats.cacheWriteTokens += cacheWrite;
        stats.cacheReadTokens += cacheRead;
        stats.messageCount += 1;

        if (!stats.modelBreakdown[model]) {
          stats.modelBreakdown[model] = { cost: 0, messages: 0, inputTokens: 0, outputTokens: 0 };
        }
        stats.modelBreakdown[model].cost += cost;
        stats.modelBreakdown[model].messages += 1;
        stats.modelBreakdown[model].inputTokens += inputTokens;
        stats.modelBreakdown[model].outputTokens += outputTokens;
      } catch {
        // Skip malformed lines
      }
    });

    rl.on("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    rl.on("error", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
