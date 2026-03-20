import * as https from "https";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export interface UsageLimit {
  utilization: number;
  resets_at: string | null;
}

export interface UsageData {
  five_hour: UsageLimit | null;
  seven_day: UsageLimit | null;
  seven_day_opus: UsageLimit | null;
  [key: string]: UsageLimit | null | undefined;
}

export interface FetchResult {
  data: UsageData | null;
  error: string | null;
  retryAfter: number | null;
}

/**
 * Fetches usage data from the Anthropic OAuth usage endpoint.
 * Uses Node's built-in https module (no external dependencies).
 */
export function fetchUsage(accessToken: string): Promise<FetchResult> {
  return new Promise((resolve) => {
    const url = new URL(USAGE_URL);

    const options: https.RequestOptions = {
      hostname: url.hostname,
      path: url.pathname,
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "claude-usage-bar-vscode/0.1.0",
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on("end", () => {
        if (res.statusCode === 429) {
          const retryAfter = parseInt(
            res.headers["retry-after"] as string,
            10
          );
          resolve({
            data: null,
            error: "rate_limited",
            retryAfter: isNaN(retryAfter) ? 60 : Math.max(retryAfter, 10),
          });
          return;
        }

        if (res.statusCode !== 200) {
          resolve({
            data: null,
            error: `HTTP ${res.statusCode}`,
            retryAfter: null,
          });
          return;
        }

        try {
          const data = JSON.parse(body) as UsageData;
          resolve({ data, error: null, retryAfter: null });
        } catch {
          resolve({
            data: null,
            error: "Invalid JSON response",
            retryAfter: null,
          });
        }
      });
    });

    req.on("error", (err) => {
      resolve({ data: null, error: err.message, retryAfter: null });
    });

    // Socket-level inactivity timeout
    req.setTimeout(5000, () => {
      req.destroy();
      resolve({ data: null, error: "Request timeout", retryAfter: null });
    });

    // Hard absolute deadline — kills request no matter what after 6s
    const hardTimeout = setTimeout(() => {
      req.destroy();
      resolve({ data: null, error: "Request timeout", retryAfter: null });
    }, 6000);

    req.on("close", () => clearTimeout(hardTimeout));

    req.end();
  });
}
