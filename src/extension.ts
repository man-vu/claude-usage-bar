import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { getCredentials } from "./credentials";
import { fetchUsage, UsageData } from "./api";
import { StatusBarManager } from "./statusBar";
import { scanConversations, scanToday, DailyStats } from "./scanner";
import { DashboardPanel, SubscriptionInfo } from "./dashboard";

let statusBar: StatusBarManager;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let lastData: UsageData | null = null;
let lastLocalStats: DailyStats | null = null;
let isVisible = true;
let consecutiveFailures = 0;
let extensionContext: vscode.ExtensionContext;
let lastSuccessfulFetch: number | null = null;
let lastAttemptTime = 0;
let outputChannel: vscode.OutputChannel;
let statusLineWatcher: fs.FSWatcher | undefined;

const CACHE_KEY = "claudeUsageBar.lastData";
const CACHE_TIME_KEY = "claudeUsageBar.lastDataTime";
const STATUS_LINE_FILE = path.join(os.homedir(), ".claude", "usage-bar-status.json");

// Minimum gap between API calls (prevents multiple sources triggering concurrent calls)
const MIN_API_GAP_MS = 30_000;

function log(msg: string): void {
  const ts = new Date().toLocaleTimeString();
  outputChannel.appendLine(`[${ts}] ${msg}`);
}

/**
 * Adaptive timer interval: starts at user config (default 5min),
 * doubles on each failure up to 30min, resets on success.
 */
function getAdaptiveIntervalMs(): number {
  const config = vscode.workspace.getConfiguration("claudeUsageBar");
  const baseSeconds = config.get<number>("refreshInterval", 300);
  const baseMs = Math.max(baseSeconds, 60) * 1000;

  if (consecutiveFailures === 0) return baseMs;

  // Double the interval for each failure, cap at 30 minutes
  const multiplier = Math.min(Math.pow(2, consecutiveFailures), 6);
  const adaptedMs = Math.min(baseMs * multiplier, 30 * 60 * 1000);
  return adaptedMs;
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  outputChannel = vscode.window.createOutputChannel("Claude Usage Bar");
  statusBar = new StatusBarManager();

  log("Extension activating...");

  // Honor showInStatusBar config on startup
  const config = vscode.workspace.getConfiguration("claudeUsageBar");
  const showInStatusBar = config.get<boolean>("showInStatusBar", true);
  if (!showInStatusBar) {
    isVisible = false;
    statusBar.hide();
  }

  // Restore cached API data from previous session
  const cached = context.globalState.get<UsageData>(CACHE_KEY);
  const cachedTime = context.globalState.get<number>(CACHE_TIME_KEY);
  if (cached) {
    lastData = cached;
    lastSuccessfulFetch = cachedTime ?? null;
    statusBar.update(cached, true);
    const age = cachedTime ? Math.round((Date.now() - cachedTime) / 1000) : "unknown";
    log(`Restored cached data (age: ${age}s)`);
  }

  // Try reading statusLine file for supplementary data
  readStatusLineFile();
  watchStatusLineFile();

  // Register commands
  const refreshCmd = vscode.commands.registerCommand(
    "claudeUsageBar.refresh",
    () => {
      log("Manual refresh triggered — resetting failure counter");
      consecutiveFailures = 0;
      lastAttemptTime = 0; // Allow immediate retry
      scheduleNextTick(0); // Run now
      return Promise.resolve();
    }
  );

  const toggleCmd = vscode.commands.registerCommand(
    "claudeUsageBar.toggle",
    () => {
      isVisible = !isVisible;
      if (isVisible) {
        statusBar.show();
        consecutiveFailures = 0;
        lastAttemptTime = 0;
        scheduleNextTick(0);
      } else {
        statusBar.hide();
        stopTimer();
      }
    }
  );

  const dashboardCmd = vscode.commands.registerCommand(
    "claudeUsageBar.showDashboard",
    async () => {
      const [stats, creds] = await Promise.all([
        scanConversations(365, 0),
        getCredentials(),
      ]);

      // Only try a fresh fetch if we haven't failed recently
      let usageData = lastData;
      const timeSinceLastAttempt = Date.now() - lastAttemptTime;
      if (creds?.accessToken && consecutiveFailures < 2 && timeSinceLastAttempt > MIN_API_GAP_MS) {
        log("Dashboard open: fetching fresh usage data...");
        const result = await fetchUsage(creds.accessToken);
        lastAttemptTime = Date.now();
        if (result.data) {
          lastData = result.data;
          usageData = result.data;
          lastSuccessfulFetch = Date.now();
          consecutiveFailures = 0;
          statusBar.update(result.data, false);
          extensionContext.globalState.update(CACHE_KEY, result.data);
          extensionContext.globalState.update(CACHE_TIME_KEY, Date.now());
          rebuildSharedTooltip();
          log("Dashboard: fresh data obtained");
        } else {
          consecutiveFailures++;
          log(`Dashboard: API returned ${result.error}, using cached data (age: ${formatAge(lastSuccessfulFetch)})`);
        }
      } else {
        log(`Dashboard: using cached data (failures: ${consecutiveFailures}, last attempt: ${formatAge(lastAttemptTime || null)})`);
      }

      const sub: SubscriptionInfo = {
        type: creds?.subscriptionType ?? "unknown",
        tier: creds?.rateLimitTier ?? "unknown",
      };
      DashboardPanel.show(context, stats, sub, usageData ?? undefined, lastSuccessfulFetch);
    }
  );

  // Dashboard refresh: re-scans JSONL only, no API call (avoids rate limit)
  const refreshDashboardCmd = vscode.commands.registerCommand(
    "claudeUsageBar.refreshDashboard",
    async () => {
      log("Dashboard refresh: re-scanning local data (no API call)");
      const [stats, creds] = await Promise.all([
        scanConversations(365, 0),
        getCredentials(),
      ]);
      const sub: SubscriptionInfo = {
        type: creds?.subscriptionType ?? "unknown",
        tier: creds?.rateLimitTier ?? "unknown",
      };
      DashboardPanel.show(context, stats, sub, lastData ?? undefined, lastSuccessfulFetch);
    }
  );

  const scanCmd = vscode.commands.registerCommand(
    "claudeUsageBar.scanToday",
    () => refreshLocalStats()
  );

  context.subscriptions.push(
    refreshCmd, toggleCmd, dashboardCmd, refreshDashboardCmd, scanCmd,
    statusBar, outputChannel
  );

  // Listen for config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeUsageBar")) {
        const cfg = vscode.workspace.getConfiguration("claudeUsageBar");
        const shouldShow = cfg.get<boolean>("showInStatusBar", true);
        if (shouldShow && !isVisible) {
          isVisible = true;
          statusBar.show();
          consecutiveFailures = 0;
          scheduleNextTick(0);
        } else if (!shouldShow && isVisible) {
          isVisible = false;
          statusBar.hide();
          stopTimer();
        }
        if (lastData) {
          statusBar.update(lastData);
        }
      }
    })
  );

  // Initial fetch + start adaptive timer
  refreshAll().then(() => scheduleNextTick());
  log("Extension activated");
}

export function deactivate(): void {
  stopTimer();
  if (statusLineWatcher) {
    statusLineWatcher.close();
    statusLineWatcher = undefined;
  }
}

/**
 * Schedule the next refresh tick using adaptive interval.
 * Uses setTimeout instead of setInterval so the interval can change dynamically.
 */
function scheduleNextTick(overrideMs?: number): void {
  stopTimer();
  if (!isVisible) return;

  const ms = overrideMs ?? getAdaptiveIntervalMs();
  if (overrideMs === undefined) {
    log(`Next refresh in ${Math.round(ms / 1000)}s (failures: ${consecutiveFailures})`);
  }
  refreshTimer = setTimeout(async () => {
    if (isVisible) {
      await refreshAll();
      scheduleNextTick();
    }
  }, ms);
}

function stopTimer(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }
}

async function refreshAll(): Promise<void> {
  await Promise.all([refreshApiUsage(), refreshLocalStats()]);
  updateDashboardIfOpen();
}

async function refreshApiUsage(): Promise<void> {
  // Enforce minimum gap between API calls
  const timeSinceLastAttempt = Date.now() - lastAttemptTime;
  if (timeSinceLastAttempt < MIN_API_GAP_MS) {
    log(`Skipping API call (only ${Math.round(timeSinceLastAttempt / 1000)}s since last attempt)`);
    return;
  }

  if (!lastData) {
    statusBar.setLoading();
  }

  const creds = await getCredentials();
  if (!creds) {
    log("No credentials found");
    statusBar.setNoCredentials();
    return;
  }

  if (creds.expiresAt && Date.now() > creds.expiresAt) {
    log(`Token expired at ${new Date(creds.expiresAt).toISOString()}`);
    statusBar.setError("Token expired — re-authenticate in Claude Code");
    return;
  }

  log("Fetching usage data...");
  lastAttemptTime = Date.now();
  const result = await fetchUsage(creds.accessToken);

  if (result.error === "rate_limited") {
    consecutiveFailures++;
    const nextInterval = Math.round(getAdaptiveIntervalMs() / 1000);
    log(`Rate limited (attempt #${consecutiveFailures}) — next attempt in ~${nextInterval}s`);
    if (lastData) {
      statusBar.update(lastData, true);
      rebuildSharedTooltip();
    }
    return;
  }

  if (result.error) {
    consecutiveFailures++;
    log(`API error: ${result.error} (attempt #${consecutiveFailures})`);
    if (lastData) {
      statusBar.update(lastData, true);
      rebuildSharedTooltip();
    } else {
      statusBar.setError(result.error);
    }
    return;
  }

  if (result.data) {
    lastData = result.data;
    lastSuccessfulFetch = Date.now();
    consecutiveFailures = 0;
    statusBar.update(result.data, false);
    rebuildSharedTooltip();

    extensionContext.globalState.update(CACHE_KEY, result.data);
    extensionContext.globalState.update(CACHE_TIME_KEY, Date.now());

    const fh = result.data.five_hour?.utilization?.toFixed(0) ?? "?";
    const sd = result.data.seven_day?.utilization?.toFixed(0) ?? "?";
    log(`Success: 5h=${fh}% 7d=${sd}%`);
  }
}

async function refreshLocalStats(): Promise<void> {
  try {
    const today = await scanToday();
    lastLocalStats = today;
    rebuildSharedTooltip();
  } catch {
    // Silently fail — local stats are supplementary
  }
}

// ── StatusLine file integration ──────────────────────────────────────
// Claude Code can be configured to write status data to a file via statusLine.
// We watch that file for changes and use it as a supplementary data source.

function readStatusLineFile(): void {
  try {
    if (!fs.existsSync(STATUS_LINE_FILE)) return;
    const raw = fs.readFileSync(STATUS_LINE_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (data.timestamp && data.cost !== undefined) {
      log(`StatusLine file: cost=$${data.cost?.toFixed(2)}, model=${data.model ?? "?"}`);
    }
  } catch {
    // File may not exist or be malformed
  }
}

function watchStatusLineFile(): void {
  const dir = path.dirname(STATUS_LINE_FILE);
  const basename = path.basename(STATUS_LINE_FILE);
  try {
    if (!fs.existsSync(dir)) return;
    statusLineWatcher = fs.watch(dir, (event, filename) => {
      if (filename === basename && event === "change") {
        readStatusLineFile();
      }
    });
    statusLineWatcher.on("error", () => {
      // Silently ignore watch errors
    });
  } catch {
    // Directory may not exist
  }
}

/**
 * Rebuild and assign the tooltip to the single status bar item.
 */
function rebuildSharedTooltip(): void {
  const config = vscode.workspace.getConfiguration("claudeUsageBar");
  const budget = config.get<number>("dailyBudget", 0);
  const md = buildUnifiedTooltip(lastLocalStats, lastData, budget, lastSuccessfulFetch);
  statusBar.setTooltip(md);
}

/**
 * Push fresh data to the dashboard webview if it's currently open.
 */
async function updateDashboardIfOpen(): Promise<void> {
  if (!DashboardPanel.isOpen) return;
  const [stats, creds] = await Promise.all([
    scanConversations(365, 0),
    getCredentials(),
  ]);
  const sub: SubscriptionInfo = {
    type: creds?.subscriptionType ?? "unknown",
    tier: creds?.rateLimitTier ?? "unknown",
  };
  DashboardPanel.updateIfOpen(stats, sub, lastData ?? undefined, lastSuccessfulFetch);
  log("Dashboard auto-refreshed");
}

// ── Color helpers ──
const C = {
  green: "#4ec9b0",
  blue: "#569cd6",
  purple: "#c586c0",
  orange: "#ce9178",
  yellow: "#dcdcaa",
  red: "#f44747",
  teal: "#4fc1ff",
  dim: "#808080",
  white: "#d4d4d4",
};

function col(color: string, text: string): string {
  return `<span style="color:${color};">${text}</span>`;
}

function colorBar(value: number, max: number, color: string, len: number = 12): string {
  if (max <= 0) return col(C.dim, "\u2591".repeat(len));
  const ratio = Math.min(value / max, 1);
  const filled = Math.round(ratio * len);
  const empty = len - filled;
  return col(color, "\u2588".repeat(filled)) + col("#3c3c3c", "\u2591".repeat(empty));
}

function pctColor(pct: number): string {
  if (pct >= 90) return C.red;
  if (pct >= 70) return C.yellow;
  if (pct >= 40) return C.orange;
  return C.green;
}

function formatResetTime(resetsAt: string | null): string {
  if (!resetsAt) return "N/A";
  const diffMs = new Date(resetsAt).getTime() - Date.now();
  if (diffMs <= 0) return "resetting...";
  const h = Math.floor(diffMs / 3_600_000);
  const m = Math.floor((diffMs % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatAge(timestamp: number | null): string {
  if (!timestamp) return "never";
  const diffMs = Date.now() - timestamp;
  if (diffMs < 60_000) return "just now";
  const m = Math.floor(diffMs / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function buildUnifiedTooltip(
  stats: DailyStats | null,
  apiData: UsageData | null,
  budget: number,
  lastFetchTime: number | null,
): vscode.MarkdownString {
  const lines: string[] = [];

  // ══════════════════════════════════════════════
  // SECTION 1: Rate Limits (from API)
  // ══════════════════════════════════════════════
  if (apiData) {
    const ageStr = formatAge(lastFetchTime);
    lines.push(
      `## $(shield) Rate Limits`,
      "",
    );

    const limits: { name: string; icon: string; data: { utilization: number; resets_at: string | null } | null }[] = [
      { name: "5-hour session", icon: "$(clock)", data: apiData.five_hour },
      { name: "7-day rolling", icon: "$(calendar)", data: apiData.seven_day },
    ];
    if (apiData.seven_day_opus && apiData.seven_day_opus.utilization > 0) {
      limits.push({ name: "7-day Opus", icon: "$(star)", data: apiData.seven_day_opus });
    }

    lines.push(
      `| | | Usage | Resets |`,
      `|:--|:--|:--|--:|`,
    );
    for (const lim of limits) {
      if (lim.data) {
        const pct = Math.round(lim.data.utilization);
        const barColor = pctColor(pct);
        const bar = colorBar(lim.data.utilization, 100, barColor, 10);
        const reset = formatResetTime(lim.data.resets_at);
        lines.push(`| ${lim.icon} ${lim.name} | ${bar} | ${col(barColor, `**${pct}%**`)} | ${col(C.dim, reset)} |`);
      } else {
        lines.push(`| ${lim.icon} ${lim.name} | | ${col(C.dim, "N/A")} | |`);
      }
    }

    const intervalMin = Math.round(getAdaptiveIntervalMs() / 60_000);
    lines.push(
      "",
      `$(history) _Updated ${ageStr}_ &nbsp;&middot;&nbsp; $(sync) _every ${intervalMin}m_ &nbsp;&middot;&nbsp; $(refresh) _Ctrl+Alt+R_`,
      "",
    );
  }

  // ══════════════════════════════════════════════
  // SECTION 2: Today's Usage (from local JSONL)
  // ══════════════════════════════════════════════
  if (stats && stats.messageCount > 0) {
    const cost = stats.totalCost;
    const totalTokens = stats.inputTokens + stats.outputTokens;
    const cacheTotal = stats.cacheWriteTokens + stats.cacheReadTokens;

    lines.push(
      `---`,
      "",
      `## $(dashboard) Today's Usage`,
      "",
    );

    // Hero stats with colors
    let budgetLine = "";
    if (budget > 0) {
      const budgetPct = Math.min((cost / budget) * 100, 100);
      const budgetColor = pctColor(budgetPct);
      budgetLine = ` ${col(C.dim, "/")} ${col(C.dim, "$" + budget.toFixed(0))} ${colorBar(cost, budget, budgetColor, 6)} ${col(budgetColor, budgetPct.toFixed(0) + "%")}`;
    }
    lines.push(
      `| | |`,
      `|:--|--:|`,
      `| $(credit-card) **Cost** | ${col(C.green, `**$${cost.toFixed(2)}**`)}${budgetLine} |`,
      `| $(comment-discussion) **Messages** | ${col(C.purple, `**${stats.messageCount}**`)} |`,
      `| $(pulse) **Tokens** | ${col(C.orange, `**${formatTokens(totalTokens)}**`)} |`,
      "",
    );

    // Token breakdown with colored bars
    const inputPct = totalTokens > 0 ? ((stats.inputTokens / totalTokens) * 100).toFixed(0) : "0";
    const outputPct = totalTokens > 0 ? ((stats.outputTokens / totalTokens) * 100).toFixed(0) : "0";

    lines.push(
      `### $(symbol-number) Tokens`,
      "",
      `| | Count | | % |`,
      `|:--|--:|:--|--:|`,
      `| $(arrow-down) Input | ${col(C.blue, formatTokens(stats.inputTokens))} | ${colorBar(stats.inputTokens, totalTokens, C.blue)} | ${col(C.dim, inputPct + "%")} |`,
      `| $(arrow-up) Output | ${col(C.green, formatTokens(stats.outputTokens))} | ${colorBar(stats.outputTokens, totalTokens, C.green)} | ${col(C.dim, outputPct + "%")} |`,
    );

    if (cacheTotal > 0) {
      const totalContext = stats.cacheReadTokens + stats.inputTokens;
      const hitRate = totalContext > 0 ? ((stats.cacheReadTokens / totalContext) * 100).toFixed(0) : "0";
      lines.push(
        `| $(database) Cache Read | ${col(C.teal, formatTokens(stats.cacheReadTokens))} | ${colorBar(stats.cacheReadTokens, totalContext, C.teal)} | ${col(C.teal, hitRate + "% hit")} |`,
        `| $(edit) Cache Write | ${col(C.dim, formatTokens(stats.cacheWriteTokens))} | | |`,
      );
    }
    lines.push("");

    // Model breakdown with colored bars
    const models = Object.entries(stats.modelBreakdown)
      .sort((a, b) => b[1].cost - a[1].cost)
      .filter(([, d]) => d.messages > 0);

    if (models.length > 0) {
      const modelColors = [C.blue, C.green, C.orange, C.purple, C.yellow, C.teal];
      const maxCost = models[0][1].cost;
      lines.push(
        `### $(server) Models`,
        "",
        `| Model | Cost | Msgs | |`,
        `|:--|--:|--:|:--|`,
      );
      models.forEach(([name, data], i) => {
        const mc = modelColors[i % modelColors.length];
        lines.push(
          `| $(symbol-class) ${col(mc, formatModelName(name))} | ${col(C.green, "$" + data.cost.toFixed(2))} | ${col(C.dim, String(data.messages))} | ${colorBar(data.cost, maxCost, mc, 8)} |`
        );
      });
      lines.push("");
    }
  } else if (!apiData) {
    lines.push(`## $(sync~spin) Loading...`, "");
  }

  // Footer
  lines.push(
    `---`,
    "",
    `$(link-external) _Click to open dashboard_`,
  );

  const md = new vscode.MarkdownString(lines.join("\n"));
  md.isTrusted = true;
  md.supportHtml = true;
  md.supportThemeIcons = true;
  return md;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return (n / 1_000_000).toFixed(1) + "M";
  }
  if (n >= 1_000) {
    return (n / 1_000).toFixed(1) + "K";
  }
  return n.toString();
}

function formatModelName(model: string): string {
  const stripped = model.replace("claude-", "").replace(/-\d{8,}$/, "");
  const match = stripped.match(/^(\w+)-(\d+)-(\d+)$/);
  if (match) {
    return match[1].charAt(0).toUpperCase() + match[1].slice(1) + " " + match[2] + "." + match[3];
  }
  return stripped.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
