import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { exec } from "child_process";

export interface ClaudeCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  subscriptionType: string;
  rateLimitTier: string;
}

/**
 * Reads Claude Code OAuth credentials.
 *
 * - Windows/Linux: reads from ~/.claude/.credentials.json
 * - macOS: tries the system Keychain first, falls back to the JSON file
 */
export async function getCredentials(): Promise<ClaudeCredentials | null> {
  if (process.platform === "darwin") {
    const fromKeychain = await readFromMacKeychain();
    if (fromKeychain) {
      return fromKeychain;
    }
  }

  return readFromCredentialsFile();
}

function readFromCredentialsFile(): ClaudeCredentials | null {
  const credPath = path.join(os.homedir(), ".claude", ".credentials.json");

  try {
    if (!fs.existsSync(credPath)) {
      return null;
    }

    const raw = fs.readFileSync(credPath, "utf-8");
    const data = JSON.parse(raw);
    const oauth = data?.claudeAiOauth;

    if (!oauth?.accessToken) {
      return null;
    }

    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
      subscriptionType: oauth.subscriptionType ?? "unknown",
      rateLimitTier: oauth.rateLimitTier ?? "unknown",
    };
  } catch {
    return null;
  }
}

function readFromMacKeychain(): Promise<ClaudeCredentials | null> {
  return new Promise((resolve) => {
    exec(
      'security find-generic-password -s "Claude Code-credentials" -w',
      (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve(null);
          return;
        }

        try {
          const data = JSON.parse(stdout.trim());
          const oauth = data?.claudeAiOauth;

          if (!oauth?.accessToken) {
            resolve(null);
            return;
          }

          resolve({
            accessToken: oauth.accessToken,
            refreshToken: oauth.refreshToken,
            expiresAt: oauth.expiresAt,
            subscriptionType: oauth.subscriptionType ?? "unknown",
            rateLimitTier: oauth.rateLimitTier ?? "unknown",
          });
        } catch {
          resolve(null);
        }
      }
    );
  });
}
