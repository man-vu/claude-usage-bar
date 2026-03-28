import * as vscode from "vscode";
import { UsageData } from "./api";


export class StatusBarManager {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.command = "claudeUsageBar.showDashboard";
    this.item.name = "Claude Usage Bar";
    this.item.show();
  }

  show(): void {
    this.item.show();
  }

  hide(): void {
    this.item.hide();
  }

  setLoading(): void {
    this.item.text = "$(sync~spin) Claude: Loading...";
    this.item.tooltip = "Fetching usage data...";
    this.item.backgroundColor = undefined;
    this.item.color = undefined;
  }

  setError(message: string): void {
    this.item.text = "$(warning) Claude: Error";
    this.item.tooltip = `Error: ${message}\nClick to retry`;
    this.item.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
    this.item.color = undefined;
  }

  setRateLimited(retryInSec: number): void {
    this.item.text = "$(clock) Claude: Rate limited";
    this.item.tooltip = `Rate limited — retrying in ${retryInSec}s\nClick to retry now`;
    this.item.backgroundColor = undefined;
    this.item.color = undefined;
  }

  setNoCredentials(): void {
    this.item.text = "$(key) Claude: No credentials";
    this.item.tooltip =
      "Claude Code OAuth credentials not found.\nMake sure Claude Code is installed and authenticated.";
    this.item.backgroundColor = undefined;
    this.item.color = undefined;
  }

  /** Update status bar text and coloring from API data. Tooltip is set externally. */
  update(data: UsageData, _stale: boolean = false): void {
    const config = vscode.workspace.getConfiguration("claudeUsageBar");
    const warningThreshold = config.get<number>("warningThreshold", 70);
    const criticalThreshold = config.get<number>("criticalThreshold", 90);

    const fiveHour = data.five_hour?.utilization ?? 0;
    const sevenDay = data.seven_day?.utilization ?? 0;
    const maxUtil = Math.max(fiveHour, sevenDay);

    const fhPie = pieChar(fiveHour);
    const sdPie = pieChar(sevenDay);

    if (maxUtil >= criticalThreshold) {
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
      this.item.color = undefined;
    } else if (maxUtil >= warningThreshold) {
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      this.item.color = undefined;
    } else {
      this.item.backgroundColor = undefined;
      this.item.color = undefined;
    }
    this.item.text = `Claude ${fhPie} ${Math.round(fiveHour)}% ${sdPie} ${Math.round(sevenDay)}%`;
  }

  /** Set tooltip externally (from the unified tooltip builder) */
  setTooltip(md: vscode.MarkdownString): void {
    this.item.tooltip = md;
  }

  dispose(): void {
    this.item.dispose();
  }
}

function pieChar(pct: number): string {
  if (pct >= 87.5) return "\u25CF"; // ●
  if (pct >= 62.5) return "\u25D5"; // ◕
  if (pct >= 37.5) return "\u25D1"; // ◑
  if (pct >= 12.5) return "\u25D4"; // ◔
  return "\u25CB";                  // ○
}

