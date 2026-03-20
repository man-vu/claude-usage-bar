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

function normalizeModel(raw: string | undefined): string | null {
  if (!raw || raw === "<synthetic>" || !raw.startsWith("claude-")) return null;
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
  // New fields
  toolUsage: Record<string, number>;       // tool name → invocation count
  hourlyActivity: number[];                // 24 slots (0-23), message count per hour
  sessionCount: number;                    // unique session files contributing to this day
  projectBreakdown: Record<string, { cost: number; messages: number; tokens: number }>;
}

// Raw JSONL entry — we now parse more broadly
interface JsonlEntry {
  type: string;
  timestamp: string;
  sessionId?: string;
  cwd?: string;
  message?: {
    model?: string;
    content?: Array<{ type: string; name?: string }>;
    stop_reason?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

export async function scanConversations(days: number = 7, maxFiles: number = MAX_FILES): Promise<DailyStats[]> {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(projectsDir)) return [];

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  cutoffDate.setHours(0, 0, 0, 0);

  const statsMap = new Map<string, DailyStats>();
  const jsonlFiles = findJsonlFiles(projectsDir, cutoffDate, maxFiles);

  const batchSize = 15;
  for (let i = 0; i < jsonlFiles.length; i += batchSize) {
    const batch = jsonlFiles.slice(i, i + batchSize);
    await Promise.all(batch.map((f) => processFile(f.path, f.project, cutoffDate, statsMap)));
  }

  return Array.from(statsMap.values()).sort((a, b) => b.date.localeCompare(a.date));
}

export async function scanToday(): Promise<DailyStats> {
  const today = new Date().toISOString().slice(0, 10);
  const results = await scanConversations(1, 0);
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
    toolUsage: {},
    hourlyActivity: new Array(24).fill(0),
    sessionCount: 0,
    projectBreakdown: {},
  };
}

interface FileEntry {
  path: string;
  mtime: number;
  project: string; // decoded project directory name
}

const MAX_FILES = 80;

/**
 * Decode project directory name to human-readable path.
 * "d--claude-code-usage-bar" → "D:/claude-code-usage-bar"
 */
function decodeProjectName(dirName: string): string {
  // Format: drive--path-parts  e.g. "d--my-project" → "D:/my-project"
  const match = dirName.match(/^([a-z])--(.+)$/);
  if (match) {
    const parts = match[2].split("--");
    return match[1].toUpperCase() + ":/" + parts.join("/");
  }
  return dirName;
}

function findJsonlFiles(dir: string, cutoffDate: Date, maxFiles: number = MAX_FILES): FileEntry[] {
  const files: FileEntry[] = [];
  const cutoffMs = cutoffDate.getTime();

  try {
    for (const project of fs.readdirSync(dir)) {
      const projectDir = path.join(dir, project);
      let dirStat: fs.Stats;
      try { dirStat = fs.statSync(projectDir); } catch { continue; }
      if (!dirStat.isDirectory()) continue;
      if (dirStat.mtimeMs < cutoffMs) continue;

      const projectName = decodeProjectName(project);
      try {
        for (const file of fs.readdirSync(projectDir)) {
          if (!file.endsWith(".jsonl")) continue;
          const filePath = path.join(projectDir, file);
          try {
            const st = fs.statSync(filePath);
            if (st.mtimeMs >= cutoffMs) {
              files.push({ path: filePath, mtime: st.mtimeMs, project: projectName });
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  } catch { /* Permission errors */ }

  files.sort((a, b) => b.mtime - a.mtime);
  return maxFiles > 0 ? files.slice(0, maxFiles) : files;
}

async function processFile(
  filePath: string,
  projectName: string,
  cutoffDate: Date,
  statsMap: Map<string, DailyStats>
): Promise<void> {
  // Track which sessions contribute to which dates
  const sessionDates = new Set<string>();

  return new Promise((resolve) => {
    const timeout = setTimeout(() => { rl.close(); stream.destroy(); resolve(); }, 3000);
    const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", (line) => {
      // Only parse assistant messages (they have usage + tool_use data)
      if (!line.includes('"type":"assistant"')) return;

      try {
        const entry = JSON.parse(line) as JsonlEntry;
        if (entry.type !== "assistant" || !entry.message?.usage) return;

        const ts = new Date(entry.timestamp);
        if (ts < cutoffDate) return;

        const dateKey = ts.toISOString().slice(0, 10);
        const hour = ts.getHours();
        const usage = entry.message.usage;
        const model = normalizeModel(entry.message.model);
        if (!model) return;
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

        if (!statsMap.has(dateKey)) statsMap.set(dateKey, emptyStats(dateKey));
        const stats = statsMap.get(dateKey)!;

        stats.totalCost += cost;
        stats.inputTokens += inputTokens;
        stats.outputTokens += outputTokens;
        stats.cacheWriteTokens += cacheWrite;
        stats.cacheReadTokens += cacheRead;
        stats.messageCount += 1;

        // Hourly activity
        stats.hourlyActivity[hour] += 1;

        // Model breakdown
        if (!stats.modelBreakdown[model]) {
          stats.modelBreakdown[model] = { cost: 0, messages: 0, inputTokens: 0, outputTokens: 0 };
        }
        stats.modelBreakdown[model].cost += cost;
        stats.modelBreakdown[model].messages += 1;
        stats.modelBreakdown[model].inputTokens += inputTokens;
        stats.modelBreakdown[model].outputTokens += outputTokens;

        // Tool usage — extract from message.content[]
        if (entry.message.content) {
          for (const block of entry.message.content) {
            if (block.type === "tool_use" && block.name) {
              stats.toolUsage[block.name] = (stats.toolUsage[block.name] ?? 0) + 1;
            }
          }
        }

        // Project breakdown
        if (!stats.projectBreakdown[projectName]) {
          stats.projectBreakdown[projectName] = { cost: 0, messages: 0, tokens: 0 };
        }
        stats.projectBreakdown[projectName].cost += cost;
        stats.projectBreakdown[projectName].messages += 1;
        stats.projectBreakdown[projectName].tokens += inputTokens + outputTokens;

        // Session tracking
        const sessionDateKey = filePath + "|" + dateKey;
        if (!sessionDates.has(sessionDateKey)) {
          sessionDates.add(sessionDateKey);
          stats.sessionCount += 1;
        }
      } catch { /* Skip malformed lines */ }
    });

    rl.on("close", () => { clearTimeout(timeout); resolve(); });
    rl.on("error", () => { clearTimeout(timeout); resolve(); });
  });
}
