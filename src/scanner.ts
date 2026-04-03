import * as fs from "fs";
import * as readline from "readline";
import {
  MODEL_PRICING, DEFAULT_PRICING, normalizeModel, calculateCost,
  findJsonlFiles as findFiles,
} from "./shared";

export interface DailyStats {
  date: string;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  messageCount: number;
  modelBreakdown: Record<string, { cost: number; messages: number; inputTokens: number; outputTokens: number }>;
  toolUsage: Record<string, number>;
  hourlyActivity: number[];
  sessionCount: number;
  projectBreakdown: Record<string, { cost: number; messages: number; tokens: number }>;
}

interface JsonlEntry {
  type: string;
  timestamp: string;
  message?: {
    model?: string;
    content?: Array<{ type: string; name?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

const MAX_FILES = 80;

export async function scanConversations(days: number = 7, maxFiles: number = MAX_FILES): Promise<DailyStats[]> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  cutoffDate.setHours(0, 0, 0, 0);

  const jsonlFiles = findFiles(cutoffDate, maxFiles);
  const statsMap = new Map<string, DailyStats>();

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
    date, totalCost: 0, inputTokens: 0, outputTokens: 0,
    cacheWriteTokens: 0, cacheReadTokens: 0, messageCount: 0,
    modelBreakdown: {}, toolUsage: {},
    hourlyActivity: new Array(24).fill(0),
    sessionCount: 0, projectBreakdown: {},
  };
}

async function processFile(
  filePath: string, projectName: string,
  cutoffDate: Date, statsMap: Map<string, DailyStats>
): Promise<void> {
  const sessionDates = new Set<string>();

  return new Promise((resolve) => {
    const timeout = setTimeout(() => { rl.close(); stream.destroy(); resolve(); }, 3000);
    const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", (line) => {
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

        const input = usage.input_tokens ?? 0;
        const output = usage.output_tokens ?? 0;
        const cacheWrite = usage.cache_creation_input_tokens ?? 0;
        const cacheRead = usage.cache_read_input_tokens ?? 0;
        const cost = calculateCost(input, output, cacheWrite, cacheRead, pricing);

        if (!statsMap.has(dateKey)) statsMap.set(dateKey, emptyStats(dateKey));
        const stats = statsMap.get(dateKey)!;

        stats.totalCost += cost;
        stats.inputTokens += input;
        stats.outputTokens += output;
        stats.cacheWriteTokens += cacheWrite;
        stats.cacheReadTokens += cacheRead;
        stats.messageCount += 1;
        stats.hourlyActivity[hour] += 1;

        if (!stats.modelBreakdown[model]) {
          stats.modelBreakdown[model] = { cost: 0, messages: 0, inputTokens: 0, outputTokens: 0 };
        }
        stats.modelBreakdown[model].cost += cost;
        stats.modelBreakdown[model].messages += 1;
        stats.modelBreakdown[model].inputTokens += input;
        stats.modelBreakdown[model].outputTokens += output;

        if (entry.message.content) {
          for (const block of entry.message.content) {
            if (block.type === "tool_use" && block.name) {
              stats.toolUsage[block.name] = (stats.toolUsage[block.name] ?? 0) + 1;
            }
          }
        }

        if (!stats.projectBreakdown[projectName]) {
          stats.projectBreakdown[projectName] = { cost: 0, messages: 0, tokens: 0 };
        }
        stats.projectBreakdown[projectName].cost += cost;
        stats.projectBreakdown[projectName].messages += 1;
        stats.projectBreakdown[projectName].tokens += input + output;

        const sessionDateKey = filePath + "|" + dateKey;
        if (!sessionDates.has(sessionDateKey)) {
          sessionDates.add(sessionDateKey);
          stats.sessionCount += 1;
        }
      } catch { /* skip */ }
    });

    rl.on("close", () => { clearTimeout(timeout); resolve(); });
    rl.on("error", () => { clearTimeout(timeout); resolve(); });
  });
}
