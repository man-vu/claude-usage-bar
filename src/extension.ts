import * as vscode from "vscode";
import { getCredentials } from "./credentials";
import { fetchUsage, UsageData } from "./api";
import { StatusBarManager } from "./statusBar";
import { scanConversations, scanToday, DailyStats } from "./scanner";
import { DashboardPanel, SubscriptionInfo } from "./dashboard";
let statusBar: StatusBarManager;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let lastData: UsageData | null = null;
let lastLocalStats: DailyStats | null = null;
let lastDailyStats: DailyStats[] = [];
let isVisible = true;
let rateLimitBackoff = 60; // seconds, grows exponentially
let extensionContext: vscode.ExtensionContext;

const CACHE_KEY = "claudeUsageBar.lastData";
const CACHE_TIME_KEY = "claudeUsageBar.lastDataTime";

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  statusBar = new StatusBarManager();

  // Restore cached API data from previous session
  const cached = context.globalState.get<UsageData>(CACHE_KEY);
  if (cached) {
    lastData = cached;
    statusBar.update(cached, true);
  }

  // Register commands
  const refreshCmd = vscode.commands.registerCommand(
    "claudeUsageBar.refresh",
    () => refreshAll()
  );

  const toggleCmd = vscode.commands.registerCommand(
    "claudeUsageBar.toggle",
    () => {
      isVisible = !isVisible;
      if (isVisible) {
        statusBar.show();
        refreshAll();
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
      lastDailyStats = stats;
      const sub: SubscriptionInfo = {
        type: creds?.subscriptionType ?? "unknown",
        tier: creds?.rateLimitTier ?? "unknown",
      };
      DashboardPanel.show(context, stats, sub);
    }
  );

  const scanCmd = vscode.commands.registerCommand(
    "claudeUsageBar.scanToday",
    () => refreshLocalStats()
  );

  context.subscriptions.push(
    refreshCmd, toggleCmd, dashboardCmd, scanCmd,
    statusBar
  );

  // Listen for config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeUsageBar")) {
        restartTimer();
        if (lastData) {
          statusBar.update(lastData);
        }
      }
    })
  );

  // Initial fetch
  refreshAll();
  startTimer();
}

export function deactivate(): void {
  stopTimer();
}

async function refreshAll(): Promise<void> {
  refreshApiUsage();
  refreshLocalStats();
}

async function refreshApiUsage(): Promise<void> {
  if (!lastData) {
    statusBar.setLoading();
  }

  const creds = await getCredentials();
  if (!creds) {
    statusBar.setNoCredentials();
    return;
  }

  if (creds.expiresAt && Date.now() > creds.expiresAt) {
    statusBar.setError("Token expired — re-authenticate in Claude Code");
    return;
  }

  const result = await fetchUsage(creds.accessToken);

  if (result.error === "rate_limited") {
    if (lastData) {
      statusBar.update(lastData, true);
      rebuildSharedTooltip();
    }

    const retryDelay = Math.min(rateLimitBackoff, 600);
    rateLimitBackoff = Math.min(rateLimitBackoff * 2, 600);

    setTimeout(() => {
      if (isVisible) {
        refreshApiUsage();
      }
    }, retryDelay * 1000);
    return;
  }

  if (result.error) {
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
    rateLimitBackoff = 60;
    statusBar.update(result.data, false);
    rebuildSharedTooltip();

    extensionContext.globalState.update(CACHE_KEY, result.data);
    extensionContext.globalState.update(CACHE_TIME_KEY, Date.now());
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

/**
 * Rebuild and assign the tooltip to the single status bar item.
 */
function rebuildSharedTooltip(): void {
  const config = vscode.workspace.getConfiguration("claudeUsageBar");
  const budget = config.get<number>("dailyBudget", 0);
  const md = buildUnifiedTooltip(lastLocalStats, lastData, budget);
  statusBar.setTooltip(md);

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

function buildUnifiedTooltip(
  stats: DailyStats | null,
  apiData: UsageData | null,
  budget: number,
): vscode.MarkdownString {
  const lines: string[] = [];

  // ══════════════════════════════════════════════
  // SECTION 1: Rate Limits (from API)
  // ══════════════════════════════════════════════
  if (apiData) {
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
    lines.push("");
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
    `$(link-external) _Click to open dashboard_ \u2003\u2003 $(refresh) _Ctrl+Alt+R refresh_`,
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

function getIntervalMs(): number {
  const config = vscode.workspace.getConfiguration("claudeUsageBar");
  const seconds = config.get<number>("refreshInterval", 300);
  return Math.max(seconds, 60) * 1000;
}

function startTimer(): void {
  stopTimer();
  refreshTimer = setInterval(() => {
    if (isVisible) {
      refreshAll();
    }
  }, getIntervalMs());
}

function stopTimer(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}

function restartTimer(): void {
  startTimer();
}
