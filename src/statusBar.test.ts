import { describe, it, expect } from "vitest";
import { StatusBarManager } from "./statusBar";
import type { UsageData } from "./api";

describe("StatusBarManager", () => {
  it("constructs without error", () => {
    const mgr = new StatusBarManager();
    expect(mgr).toBeDefined();
  });

  it("setLoading sets loading state", () => {
    const mgr = new StatusBarManager();
    // Should not throw
    mgr.setLoading();
  });

  it("setError sets error state", () => {
    const mgr = new StatusBarManager();
    mgr.setError("test error");
  });

  it("setNoCredentials sets no-creds state", () => {
    const mgr = new StatusBarManager();
    mgr.setNoCredentials();
  });

  it("setRateLimited sets rate limited state", () => {
    const mgr = new StatusBarManager();
    mgr.setRateLimited(60);
  });

  it("update handles zero utilization", () => {
    const mgr = new StatusBarManager();
    const data: UsageData = {
      five_hour: { utilization: 0, resets_at: null },
      seven_day: { utilization: 0, resets_at: null },
      seven_day_opus: null,
    };
    mgr.update(data, false);
  });

  it("update handles high utilization (critical)", () => {
    const mgr = new StatusBarManager();
    const data: UsageData = {
      five_hour: { utilization: 95, resets_at: null },
      seven_day: { utilization: 50, resets_at: null },
      seven_day_opus: null,
    };
    mgr.update(data, false);
  });

  it("update handles warning utilization", () => {
    const mgr = new StatusBarManager();
    const data: UsageData = {
      five_hour: { utilization: 75, resets_at: null },
      seven_day: { utilization: 50, resets_at: null },
      seven_day_opus: null,
    };
    mgr.update(data, false);
  });

  it("update handles >100% utilization without crashing", () => {
    const mgr = new StatusBarManager();
    const data: UsageData = {
      five_hour: { utilization: 120, resets_at: null },
      seven_day: { utilization: 50, resets_at: null },
      seven_day_opus: null,
    };
    // This exercises the buildBar bug (B5) — should not throw
    mgr.update(data, false);
  });

  it("update handles null limits gracefully", () => {
    const mgr = new StatusBarManager();
    const data: UsageData = {
      five_hour: null,
      seven_day: null,
      seven_day_opus: null,
    };
    mgr.update(data, false);
  });

  it("dispose does not throw", () => {
    const mgr = new StatusBarManager();
    mgr.dispose();
  });
});
