import * as vscode from "vscode";
import { UsageData } from "./api";

const BAR_FULL = "\u2588"; // █
const BAR_EMPTY = "\u2591"; // ░
const BAR_LENGTH = 10;

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

    const bar = buildBar(maxUtil);

    if (maxUtil < 1) {
      this.item.text = `$(check) Claude: ${bar} ${Math.round(maxUtil)}%`;
      this.item.backgroundColor = undefined;
      this.item.color = new vscode.ThemeColor("charts.green");
    } else if (maxUtil >= criticalThreshold) {
      this.item.text = `$(error) Claude: ${bar} ${Math.round(maxUtil)}%`;
      this.item.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground"
      );
      this.item.color = undefined;
    } else if (maxUtil >= warningThreshold) {
      this.item.text = `$(warning) Claude: ${bar} ${Math.round(maxUtil)}%`;
      this.item.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
      this.item.color = undefined;
    } else {
      this.item.text = `$(check) Claude: ${bar} ${Math.round(maxUtil)}%`;
      this.item.backgroundColor = undefined;
      this.item.color = undefined;
    }
  }

  /** Set tooltip externally (from the unified tooltip builder) */
  setTooltip(md: vscode.MarkdownString): void {
    this.item.tooltip = md;
  }

  dispose(): void {
    this.item.dispose();
  }
}

function buildBar(percentage: number): string {
  const clamped = Math.max(0, Math.min(percentage, 100));
  const filled = Math.round((clamped / 100) * BAR_LENGTH);
  const empty = BAR_LENGTH - filled;
  return BAR_FULL.repeat(filled) + BAR_EMPTY.repeat(empty);
}
