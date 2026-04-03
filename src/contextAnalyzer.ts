import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { PROJECTS_DIR, decodeProjectName, normalizeModel, fmtTokens } from "./shared";

// ── Constants (from Claude Code source: autoCompact.ts, tokens.ts) ──

const CHARS_PER_TOKEN = 4;
const AUTOCOMPACT_BUFFER = 13_000;
const MAX_OUTPUT_RESERVE = 20_000;
const TOOL_OVERHEAD = 500;

const CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-4-6": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5": 200_000,
};

// ── Types ───────────────────────────────────────────────────────────

export interface ContextCategory {
  name: string;
  tokens: number;
  color: string;     // CSS color
  isDeferred?: boolean;
}

export interface ToolUsage {
  name: string;
  calls: number;
  callTokens: number;
  results: number;
  resultTokens: number;
}

export interface McpToolInfo {
  name: string;
  tokens: number;
  isLoaded: boolean;
}

export interface McpServerInfo {
  name: string;
  tokens: number;
  toolCount: number;
}

export interface SkillInfo {
  name: string;
  tokens: number;
  source: "User" | "Plugin";
}

export interface PluginInfo {
  name: string;
  version: string;
  marketplace: string;
  lastUpdated: string;
}

export interface MemoryFileInfo {
  path: string;
  tokens: number;
}

export interface ContextAnalysis {
  // Session
  sessionId: string;
  file: string;
  model: string;
  modelDisplay: string;
  is1MContext: boolean;
  version: string;
  cwd: string;
  permissionMode: string;

  // Context window
  rawWindow: number;
  effectiveWindow: number;
  autoCompactThreshold: number;
  totalUsed: number;
  freeTokens: number;
  usagePct: number;

  // Categories for the grid
  categories: ContextCategory[];

  // Grid
  gridWidth: number;
  gridHeight: number;
  gridSquares: GridSquare[];

  // Breakdowns
  toolUsage: ToolUsage[];
  mcpTools: McpToolInfo[];
  mcpServers: McpServerInfo[];
  skills: SkillInfo[];
  plugins: PluginInfo[];
  memoryFiles: MemoryFileInfo[];

  // Compaction
  compactCount: number;
  totalMessages: number;
  activeMessages: number;

  // API usage
  apiUsage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  } | null;
}

export interface GridSquare {
  color: string;
  symbol: string;
  name: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

function est(x: unknown): number {
  if (!x) return 0;
  const s = typeof x === "string" ? x : JSON.stringify(x);
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

/**
 * Estimate tokens for a message content block more accurately.
 * Extracts only the actual text content, ignoring JSON structure overhead.
 * Thinking blocks are excluded (not sent to API in context).
 */
function estMessageBlock(block: Record<string, unknown>): number {
  if (!block) return 0;
  // Thinking blocks are NOT counted in context (output-only, not re-sent)
  if (block.type === "thinking") return 0;
  // Tool use: count the input parameters only, not the JSON wrapper
  if (block.type === "tool_use") {
    const inputStr = typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? "");
    // tool_use overhead: name + id + structure ≈ 30 tokens
    return 30 + Math.ceil(inputStr.length / CHARS_PER_TOKEN);
  }
  // Tool result: count the content text only
  if (block.type === "tool_result") {
    const content = block.content;
    if (typeof content === "string") return Math.ceil(content.length / CHARS_PER_TOKEN);
    if (Array.isArray(content)) {
      return (content as Record<string, unknown>[]).reduce((s: number, c) => {
        if (typeof c === "string") return s + Math.ceil((c as string).length / CHARS_PER_TOKEN);
        if (c.type === "text" && typeof c.text === "string") return s + Math.ceil((c.text as string).length / CHARS_PER_TOKEN);
        return s + est(c);
      }, 0);
    }
    return est(content);
  }
  // Text block: count text only
  if (block.type === "text" && typeof block.text === "string") {
    return Math.ceil(block.text.length / CHARS_PER_TOKEN);
  }
  // Fallback
  return est(block);
}

/**
 * Encode a workspace path to match Claude Code's project directory naming.
 * e.g. "D:/projects/foo" → "D--projects-foo" (or "d--projects-foo")
 */
function encodeWorkspacePath(wsPath: string): string {
  // Normalize to forward slashes, strip trailing slash
  const normalized = wsPath.replace(/\\/g, "/").replace(/\/$/, "");
  // "D:/projects/foo" → drive="D", rest="projects-foo"
  const match = normalized.match(/^([a-zA-Z]):\/(.+)$/);
  if (match) {
    const drive = match[1].toUpperCase();
    const rest = match[2].replace(/\//g, "-");
    return `${drive}--${rest}`;
  }
  // Unix paths: "/home/user/foo" → "-home-user-foo" — encode slashes as dashes
  return normalized.replace(/\//g, "-").replace(/^-/, "");
}

function findLatestSession(workspacePath?: string): string | null {
  if (!fs.existsSync(PROJECTS_DIR)) return null;

  // If workspace given, find the matching project directory first
  let targetProjectDir: string | null = null;
  if (workspacePath) {
    const encoded = encodeWorkspacePath(workspacePath);
    for (const project of fs.readdirSync(PROJECTS_DIR)) {
      // Case-insensitive match since Windows paths can differ in case
      if (project.toLowerCase() === encoded.toLowerCase()) {
        targetProjectDir = path.join(PROJECTS_DIR, project);
        break;
      }
    }
  }

  // Search in target project dir, or fall back to all projects
  const searchDirs = targetProjectDir
    ? [targetProjectDir]
    : fs.readdirSync(PROJECTS_DIR).map(p => path.join(PROJECTS_DIR, p));

  let best: { path: string; mtime: number } | null = null;
  for (const dir of searchDirs) {
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".jsonl") || file.includes("subagent")) continue;
        const fp = path.join(dir, file);
        try {
          const st = fs.statSync(fp);
          if (!best || st.mtimeMs > best.mtime) best = { path: fp, mtime: st.mtimeMs };
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return best?.path ?? null;
}

// ── Main analysis ───────────────────────────────────────────────────

export function analyzeContext(workspacePath?: string): ContextAnalysis | null {
  const filePath = findLatestSession(workspacePath);
  if (!filePath) return null;

  const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msgs: any[] = lines.map((l, i) => {
    try { return { _idx: i, ...JSON.parse(l) }; }
    catch { return { _idx: i, type: "parse-error" }; }
  });

  // ── Session metadata ──
  const version = msgs.find(m => m.version)?.version ?? "";
  const cwd = msgs.find(m => m.cwd)?.cwd ?? "";
  const permissionMode = msgs.find(m => m.permissionMode)?.permissionMode
    ?? msgs.find(m => m.type === "permission-mode")?.permissionMode ?? "";
  const sessionId = msgs.find(m => m.session_id)?.session_id ?? "";

  // ── Model detection (including [1m] suffix from system-reminders) ──
  const assistantMsgs = msgs.filter(m => m.type === "assistant");
  const lastAst = assistantMsgs[assistantMsgs.length - 1];
  let model = lastAst?.message?.model ?? "unknown";
  let is1MContext = false;
  for (const m of msgs) {
    const str = typeof m.message?.content === "string"
      ? m.message.content
      : JSON.stringify(m.message?.content ?? "");
    const match = str.match(/claude-[a-z]+-[0-9-]+\[1m\]/);
    if (match) { model = match[0].replace("[1m]", ""); is1MContext = true; break; }
  }
  if (model.includes("[1m]")) { model = model.replace("[1m]", ""); is1MContext = true; }

  const rawWindow = is1MContext ? 1_000_000 : (CONTEXT_WINDOWS[model] ?? 200_000);
  const effectiveWindow = rawWindow - MAX_OUTPUT_RESERVE;
  const autoCompactThreshold = effectiveWindow - AUTOCOMPACT_BUFFER;

  // ── Model display ──
  const modelBase = model;
  const modelFamily = modelBase.includes("opus") ? "Opus" : modelBase.includes("sonnet") ? "Sonnet" : modelBase.includes("haiku") ? "Haiku" : modelBase;
  const modelVer = modelBase.includes("4-6") ? "4.6" : modelBase.includes("4-5") ? "4.5" : "";
  const modelDisplay = `${modelFamily}${modelVer ? " " + modelVer : ""}${is1MContext ? " (1M context)" : ""}`;

  // ── API usage (lives at m.message.usage in JSONL) ──
  let apiUsage: ContextAnalysis["apiUsage"] = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.type !== "assistant") continue;
    const u = m.message?.usage ?? m.usage;
    if (u && (u.input_tokens != null || u.cache_read_input_tokens != null)) {
      apiUsage = {
        input_tokens: u.input_tokens ?? 0,
        output_tokens: u.output_tokens ?? 0,
        cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      };
      break;
    }
  }

  // ── Compact boundaries ──
  const compactBounds = msgs.map((m, i) => m.type === "system" && m.subtype === "compact_boundary" ? i : -1).filter(i => i >= 0);
  const lastCompact = compactBounds.length ? compactBounds[compactBounds.length - 1] : -1;
  const active = lastCompact >= 0 ? msgs.slice(lastCompact + 1) : msgs;
  const activeConvo = active.filter(m => m.type === "user" || m.type === "assistant");

  // ── Attachments ──
  const attachments = msgs.filter(m => m.type === "attachment");
  const deferredAttach = attachments.find(m => m.attachment?.type === "deferred_tools_delta");
  const mcpInstrAttach = attachments.find(m => m.attachment?.type === "mcp_instructions_delta");
  const deferredNames: string[] = deferredAttach?.attachment?.addedNames ?? [];
  const mcpServerNames: string[] = mcpInstrAttach?.attachment?.addedNames ?? [];
  const mcpBlocks: string[] = mcpInstrAttach?.attachment?.addedBlocks ?? [];

  // ── Find loaded MCP tools ──
  const loadedToolNames = new Set<string>();
  active.forEach(m => {
    if (m.type !== "assistant" || !m.message?.content) return;
    const arr = Array.isArray(m.message.content) ? m.message.content : [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    arr.forEach((b: any) => { if (b.type === "tool_use" && b.name?.startsWith("mcp__")) loadedToolNames.add(b.name); });
  });

  // ── Build MCP tool list ──
  const mcpTools: McpToolInfo[] = deferredNames
    .filter(n => n.startsWith("mcp__"))
    .map(name => ({
      name,
      tokens: loadedToolNames.has(name) ? est(name) + TOOL_OVERHEAD : 0,
      isLoaded: loadedToolNames.has(name),
    }));

  // ── MCP servers ──
  const mcpServers: McpServerInfo[] = mcpServerNames.map((name, i) => ({
    name,
    tokens: est(mcpBlocks[i] ?? ""),
    toolCount: deferredNames.filter(t => t.includes(name.replace(/[:.]/g, "_"))).length,
  }));

  // ── Categories ──
  const categories: ContextCategory[] = [];
  const COLORS = {
    systemPrompt: "#888888",
    mcpTools: "#0891b2",
    agents: "#b1b9f9",
    memory: "#d77757",
    skills: "#ffc107",
    messages: "#9333ea",
    reserved: "#999999",
  };

  categories.push({ name: "System prompt", tokens: 6500, color: COLORS.systemPrompt });

  // MCP tools: loaded tools have full schemas in context
  const mcpLoadedTokens = mcpTools.filter(t => t.isLoaded).reduce((s, t) => s + t.tokens, 0);
  if (mcpLoadedTokens) categories.push({ name: "MCP tools", tokens: mcpLoadedTokens, color: COLORS.mcpTools });

  // Deferred MCP tools: tool names + short descriptions still in context as deferred index
  const mcpDeferredNames = deferredNames.filter(n => n.startsWith("mcp__"));
  const mcpDeferredTokens = mcpDeferredNames.reduce((s, n) => s + est(n) + 250, 0); // ~250 tokens per deferred tool schema stub
  if (mcpDeferredTokens) categories.push({ name: "MCP tools (deferred)", tokens: mcpDeferredTokens, color: "#666666", isDeferred: true });

  // Deferred system tools (builtin tools that are deferred via tool search)
  const systemDeferredNames = deferredNames.filter(n => !n.startsWith("mcp__"));
  const systemDeferredTokens = systemDeferredNames.reduce((s, n) => s + est(n) + 500, 0); // ~500 tokens per system tool
  if (systemDeferredTokens) categories.push({ name: "System tools (deferred)", tokens: systemDeferredTokens, color: "#555555", isDeferred: true });

  // Custom agents — use real /context's typical value of ~4.7k
  categories.push({ name: "Custom agents", tokens: 4700, color: COLORS.agents });

  // Memory files
  const claudeDir = path.join(os.homedir(), ".claude");
  const memoryFiles: MemoryFileInfo[] = [];
  const claudeMdPath = path.join(claudeDir, "CLAUDE.md");
  if (fs.existsSync(claudeMdPath)) {
    const tokens = est(fs.readFileSync(claudeMdPath, "utf8"));
    memoryFiles.push({ path: claudeMdPath, tokens });
  }
  const memTokens = memoryFiles.reduce((s, f) => s + f.tokens, 0);
  if (memTokens) categories.push({ name: "Memory files", tokens: memTokens, color: COLORS.memory });

  // Skills
  const skills: SkillInfo[] = [];
  let totalSkillTokens = 0;
  try {
    const skillsDir = path.join(claudeDir, "skills");
    if (fs.existsSync(skillsDir)) {
      for (const d of fs.readdirSync(skillsDir)) {
        try {
          if (!fs.statSync(path.join(skillsDir, d)).isDirectory()) continue;
          const skillFile = path.join(skillsDir, d, "SKILL.md");
          // Real /context counts only the skill frontmatter name + description line
          // Average ~47 tokens per skill. Extract just the description if available.
          let tokens = 47;
          try {
            const content = fs.readFileSync(skillFile, "utf8");
            const descMatch = content.match(/description:\s*["|']?(.+?)["|']?\s*\n/);
            if (descMatch) {
              tokens = Math.ceil((d.length + descMatch[1].length + 20) / CHARS_PER_TOKEN);
            }
          } catch { /* no SKILL.md */ }
          skills.push({ name: d, tokens, source: "User" });
          totalSkillTokens += tokens;
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }

  // Plugin skills
  try {
    const pluginCache = path.join(claudeDir, "plugins", "cache");
    if (fs.existsSync(pluginCache)) {
      for (const market of fs.readdirSync(pluginCache)) {
        const marketDir = path.join(pluginCache, market);
        try {
          for (const plugin of fs.readdirSync(marketDir)) {
            const versDir = path.join(marketDir, plugin);
            try {
              for (const v of fs.readdirSync(versDir)) {
                const skillsSubdir = path.join(versDir, v, "skills");
                try {
                  if (!fs.existsSync(skillsSubdir)) continue;
                  for (const s of fs.readdirSync(skillsSubdir).filter(f => f.endsWith(".md"))) {
                    let tokens = 47;
                    try {
                      const content = fs.readFileSync(path.join(skillsSubdir, s), "utf8");
                      const descMatch = content.match(/description:\s*["|']?(.+?)["|']?\s*\n/);
                      if (descMatch) {
                        tokens = Math.ceil((s.length + descMatch[1].length + 20) / CHARS_PER_TOKEN);
                      }
                    } catch { /* skip */ }
                    skills.push({ name: `${plugin}:${s.replace(/\.md$/, "")}`, tokens, source: "Plugin" });
                    totalSkillTokens += tokens;
                  }
                } catch { /* skip */ }
              }
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  if (totalSkillTokens) categories.push({ name: "Skills", tokens: totalSkillTokens, color: COLORS.skills });

  // Messages + tool usage
  // Use estMessageBlock for accurate counting (strips JSON overhead, skips thinking)
  let msgTokens = 0;
  const toolMap = new Map<string, ToolUsage>();
  active.forEach(m => {
    if (m.type === "assistant" && m.message?.content) {
      const arr = Array.isArray(m.message.content) ? m.message.content : [m.message.content];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      arr.forEach((b: any) => {
        const t = estMessageBlock(b);
        msgTokens += t;
        if (b.type === "tool_use") {
          const n: string = b.name ?? "unknown";
          if (!toolMap.has(n)) toolMap.set(n, { name: n, calls: 0, callTokens: 0, results: 0, resultTokens: 0 });
          const entry = toolMap.get(n)!;
          entry.calls++;
          entry.callTokens += t;
        }
      });
    } else if (m.type === "user" && m.message?.content) {
      const arr = Array.isArray(m.message.content) ? m.message.content : [{ text: m.message.content }];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      arr.forEach((b: any) => {
        const t = estMessageBlock(b);
        msgTokens += t;
        if (b.type === "tool_result") {
          for (let j = msgs.length - 1; j >= 0; j--) {
            const am = msgs[j];
            if (am.type !== "assistant" || !am.message?.content) continue;
            const match = (Array.isArray(am.message.content) ? am.message.content : [])
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .find((x: any) => x.type === "tool_use" && x.id === b.tool_use_id);
            if (match) {
              const n: string = match.name ?? "unknown";
              if (!toolMap.has(n)) toolMap.set(n, { name: n, calls: 0, callTokens: 0, results: 0, resultTokens: 0 });
              const entry = toolMap.get(n)!;
              entry.results++;
              entry.resultTokens += t;
              break;
            }
          }
        }
      });
    }
  });
  // If we have actual API usage, derive message tokens from the authoritative input_tokens.
  // The API's input_tokens includes everything the model sees (system prompt, tools, messages).
  // Subtract known non-message categories to get the true message token count.
  if (apiUsage && apiUsage.input_tokens > 0) {
    const apiTotal = apiUsage.input_tokens + (apiUsage.cache_read_input_tokens ?? 0) + (apiUsage.cache_creation_input_tokens ?? 0);
    const nonMessageTokens = categories.reduce((s, c) => s + (c.isDeferred ? 0 : c.tokens), 0);
    const derivedMsgTokens = Math.max(0, apiTotal - nonMessageTokens);
    if (msgTokens) categories.push({ name: "Messages", tokens: derivedMsgTokens, color: COLORS.messages });
  } else {
    if (msgTokens) categories.push({ name: "Messages", tokens: msgTokens, color: COLORS.messages });
  }

  // Reserved
  const reservedTokens = AUTOCOMPACT_BUFFER + MAX_OUTPUT_RESERVE;
  categories.push({ name: "Autocompact buffer", tokens: reservedTokens, color: COLORS.reserved, isDeferred: true });

  // ── Totals ──
  const totalUsed = categories.filter(c => !c.isDeferred).reduce((s, c) => s + c.tokens, 0);
  const freeTokens = Math.max(0, rawWindow - totalUsed - reservedTokens);
  const usagePct = (totalUsed / rawWindow) * 100;

  // ── Grid ──
  const is1M = is1MContext || rawWindow >= 1_000_000;
  const gridWidth = is1M ? 20 : 10;
  const gridHeight = 10;
  const totalSq = gridWidth * gridHeight;

  const gridSquares: GridSquare[] = [];
  const filledCats = categories.filter(c => !c.isDeferred && c.tokens > 0);
  const reservedCats = categories.filter(c => c.isDeferred && c.tokens > 0);

  for (const c of filledCats) {
    const exact = (c.tokens / rawWindow) * totalSq;
    const whole = Math.max(1, Math.round(exact));
    for (let i = 0; i < whole && gridSquares.length < totalSq; i++) {
      gridSquares.push({ color: c.color, symbol: "\u26C1", name: c.name });
    }
  }

  const reservedSq = reservedCats.reduce((s, c) => Math.max(1, Math.round((c.tokens / rawWindow) * totalSq)), 0);
  const freeSq = Math.max(0, totalSq - gridSquares.length - reservedSq);
  for (let i = 0; i < freeSq; i++) gridSquares.push({ color: COLORS.reserved, symbol: "\u26B6", name: "Free space" });
  for (let i = 0; i < reservedSq && gridSquares.length < totalSq; i++) gridSquares.push({ color: COLORS.reserved, symbol: "\u26DD", name: "Autocompact buffer" });
  while (gridSquares.length < totalSq) gridSquares.push({ color: COLORS.reserved, symbol: "\u26B6", name: "Free space" });

  // ── Plugins ──
  const plugins: PluginInfo[] = [];
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8"));
    const enabled: Record<string, boolean> = settings.enabledPlugins ?? {};
    const installed = JSON.parse(fs.readFileSync(path.join(claudeDir, "plugins", "installed_plugins.json"), "utf8"));
    const pluginData: Record<string, { version?: string; lastUpdated?: string }[]> = installed.plugins ?? {};
    for (const [key, val] of Object.entries(enabled)) {
      if (!val) continue;
      const [name, marketplace] = key.split("@");
      const inst = pluginData[key]?.[0];
      plugins.push({
        name,
        version: inst?.version ?? "unknown",
        marketplace: marketplace ?? "",
        lastUpdated: inst?.lastUpdated ? new Date(inst.lastUpdated).toISOString().slice(0, 10) : "",
      });
    }
  } catch { /* skip */ }

  // ── Tool usage sorted ──
  const toolUsage = [...toolMap.values()].sort((a, b) =>
    (b.callTokens + b.resultTokens) - (a.callTokens + a.resultTokens)
  );

  return {
    sessionId, file: path.basename(filePath), model: modelBase, modelDisplay, is1MContext, version, cwd, permissionMode,
    rawWindow, effectiveWindow, autoCompactThreshold, totalUsed, freeTokens, usagePct,
    categories, gridWidth, gridHeight, gridSquares,
    toolUsage, mcpTools, mcpServers, skills: skills.sort((a, b) => b.tokens - a.tokens), plugins, memoryFiles,
    compactCount: compactBounds.length, totalMessages: msgs.length, activeMessages: activeConvo.length,
    apiUsage,
  };
}
