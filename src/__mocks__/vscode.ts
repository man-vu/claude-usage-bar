// Minimal vscode module mock for unit tests
export const StatusBarAlignment = { Left: 1, Right: 2 };

export const ThemeColor = class ThemeColor {
  constructor(public id: string) {}
};

export class MarkdownString {
  value: string;
  isTrusted = false;
  supportHtml = false;
  supportThemeIcons = false;
  constructor(value = "") {
    this.value = value;
  }
}

export const window = {
  createStatusBarItem: () => ({
    show: () => {},
    hide: () => {},
    dispose: () => {},
    text: "",
    tooltip: "",
    command: "",
    name: "",
    backgroundColor: undefined,
    color: undefined,
  }),
};

export const workspace = {
  getConfiguration: () => ({
    get: <T>(key: string, defaultValue: T): T => defaultValue,
  }),
  onDidChangeConfiguration: () => ({ dispose: () => {} }),
};

export const commands = {
  registerCommand: () => ({ dispose: () => {} }),
  executeCommand: async () => {},
};
