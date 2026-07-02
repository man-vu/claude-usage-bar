import { describe, it, expect } from "vitest";
import { resolveContextWindow, encodeWorkspacePath } from "./contextAnalyzer";
import { formatModelDisplay, MODEL_PRICING } from "./shared";

describe("resolveContextWindow", () => {
  it("uses the table window for known models", () => {
    expect(resolveContextWindow("claude-opus-4-6", false, 150_000)).toBe(200_000);
    expect(resolveContextWindow("claude-fable-5", false, 150_000)).toBe(1_000_000);
  });

  it("honors the [1m] marker", () => {
    expect(resolveContextWindow("claude-sonnet-4-6", true, 0)).toBe(1_000_000);
  });

  it("never reports a window smaller than the observed context (the 134% bug)", () => {
    // Regression: a 269k context on an unknown/newer model must not be judged
    // against a 200k window, which displayed usage as an impossible 134.9%.
    const window = resolveContextWindow("claude-unknown-9", false, 269_891);
    expect(window).toBeGreaterThanOrEqual(269_891);
    expect(window).toBe(500_000);
  });

  it("bumps past every standard tier when the context demands it", () => {
    expect(resolveContextWindow("claude-unknown-9", false, 1_200_001)).toBeGreaterThanOrEqual(1_200_001);
  });

  it("defaults unknown models to 200k when usage fits", () => {
    expect(resolveContextWindow("claude-unknown-9", false, 50_000)).toBe(200_000);
  });
});

describe("encodeWorkspacePath", () => {
  it("encodes every non-alphanumeric character, not just slashes", () => {
    // Regression: dots survived encoding, so workspaces like
    // "man-vu.github.io" never matched their project directory and the
    // Context View silently showed a different project's session.
    expect(encodeWorkspacePath("D:\\projects\\web-apps\\man-vu.github.io"))
      .toBe("D--projects-web-apps-man-vu-github-io");
    expect(encodeWorkspacePath("D:/projects/tools/claude-code-usage-bar"))
      .toBe("D--projects-tools-claude-code-usage-bar");
    expect(encodeWorkspacePath("/home/user/my_app v2"))
      .toBe("-home-user-my-app-v2");
  });
});

describe("formatModelDisplay", () => {
  it("formats current model families generically", () => {
    expect(formatModelDisplay("claude-fable-5")).toBe("Fable 5");
    expect(formatModelDisplay("claude-opus-4-8")).toBe("Opus 4.8");
    expect(formatModelDisplay("claude-sonnet-4-6")).toBe("Sonnet 4.6");
    expect(formatModelDisplay("claude-haiku-4-5")).toBe("Haiku 4.5");
  });

  it("passes through unparseable ids", () => {
    expect(formatModelDisplay("unknown")).toBe("unknown");
  });
});

describe("MODEL_PRICING", () => {
  it("covers the current model generation", () => {
    for (const id of ["claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5"]) {
      expect(MODEL_PRICING[id], `${id} missing from pricing table`).toBeDefined();
    }
  });

  it("prices cache traffic relative to input (1.25x write, 0.1x read)", () => {
    for (const [id, p] of Object.entries(MODEL_PRICING)) {
      expect(p.cacheWrite, id).toBeCloseTo(p.input * 1.25, 5);
      expect(p.cacheRead, id).toBeCloseTo(p.input * 0.1, 5);
    }
  });
});
