import * as vscode from "vscode";
import { spawn, exec } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const TENURE_DIR = join(homedir(), ".tenure");
const WIN_TENURE_DIR = join(process.env.USERPROFILE ?? homedir(), ".tenure");
const DEFAULT_PORT = 5757;
const IS_WIN = platform() === "win32";

export type InstallResult = "running" | "already_running" | "failed";

export async function isTenureHealthy(port = DEFAULT_PORT): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/healthz`, {
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function checkDocker(): Promise<boolean> {
  try {
    await run("docker", ["info"]);
    return true;
  } catch {
    return false;
  }
}

export async function readTenureToken(): Promise<string | null> {
  const tenureDir = IS_WIN ? WIN_TENURE_DIR : TENURE_DIR;
  const tokenFile = join(tenureDir, "token");

  if (existsSync(tokenFile)) {
    try {
      const token = readFileSync(tokenFile, "utf8").trim();
      if (token.length > 0) return token;
    } catch {}
  }

  try {
    const composeFile = join(tenureDir, "docker-compose.yml");
    const envFile = join(tenureDir, ".env");
    const { stdout } = await execAsync(
      `docker compose -f "${composeFile}" --env-file "${envFile}" run --rm tenure node dist/index.js token`,
      { timeout: 15_000 },
    );
    const token = stdout.trim();
    if (token.length > 0) return token;
  } catch {}

  return null;
}

export async function ensureTenureRunning(
  context: vscode.ExtensionContext,
  onProgress: (msg: string) => void,
): Promise<InstallResult> {
  if (await isTenureHealthy()) {
    await maybeAutoSaveToken(context);
    return "already_running";
  }

  onProgress("Checking Docker…");
  const dockerAvailable = await checkDocker();
  if (!dockerAvailable) {
    const action = await vscode.window.showErrorMessage(
      "Tenure requires Docker Desktop. Please start Docker Desktop and try again.",
      "Download Docker",
      "Cancel",
    );
    if (action === "Download Docker") {
      vscode.env.openExternal(
        vscode.Uri.parse("https://docs.docker.com/get-docker/"),
      );
    }
    return "failed";
  }

  onProgress("Checking port availability…");
  if (await isPortInUse(DEFAULT_PORT)) {
    await vscode.window.showErrorMessage(
      `Port ${DEFAULT_PORT} is already in use by another process. Tenure cannot start.`,
    );
    return "failed";
  }

  try {
    const tenureDir = IS_WIN ? WIN_TENURE_DIR : TENURE_DIR;

    if (!existsSync(join(tenureDir, "docker-compose.yml"))) {
      onProgress("Initializing Tenure for the first time…");
      await runInit();
    }

    onProgress("Starting Tenure (this may take a moment on first run)…");
    await runComposeUp();

    onProgress("Waiting for Tenure to be ready…");
    await pollHealth();

    onProgress("Reading token…");
    let token: string | null = null;
    for (let i = 0; i < 5; i++) {
      token = await readTenureToken();
      if (token) break;
      await sleep(1_000);
    }
    if (token) {
      await context.secrets.store("tenure.apiToken", token);
      await vscode.commands.executeCommand(
        "setContext",
        "tenure.tokenConfigured",
        true,
      );
    } else {
      vscode.window.showWarningMessage(
        "Tenure is running but the token could not be read automatically. " +
          "Please run 'Tenure: Set API Token' and paste the value from ~/.tenure/token.",
      );
    }

    return "running";
  } catch (err) {
    const message = (err as Error).message ?? "Unknown error";
    const action = await vscode.window.showErrorMessage(
      `Tenure setup failed: ${message}`,
      "Retry in Terminal",
      "Cancel",
    );
    if (action === "Retry in Terminal") {
      installTenureInTerminal();
    }
    return "failed";
  }
}

async function maybeAutoSaveToken(
  context: vscode.ExtensionContext,
): Promise<void> {
  const existing = await context.secrets.get("tenure.apiToken");
  if (existing) return;

  const token = await readTenureToken();
  if (!token) return;

  await context.secrets.store("tenure.apiToken", token);
  await vscode.commands.executeCommand(
    "setContext",
    "tenure.tokenConfigured",
    true,
  );

  vscode.window.showInformationMessage(
    "Tenure is running and your token has been saved automatically.",
  );
}

function runInit(): Promise<void> {
  const volumeMount = IS_WIN
    ? `${WIN_TENURE_DIR}:/app/.tenure`
    : `${TENURE_DIR}:/app/.tenure`;

  return run(
    "docker",
    ["run", "--rm", "-v", volumeMount, "tenureai/tenure:latest", "init"],
    "Docker init failed. Is Docker running?",
  );
}

function runComposeUp(): Promise<void> {
  const tenureDir = IS_WIN ? WIN_TENURE_DIR : TENURE_DIR;

  return run(
    "docker",
    [
      "compose",
      "-f",
      join(tenureDir, "docker-compose.yml"),
      "--env-file",
      join(tenureDir, ".env"),
      "up",
      "-d",
    ],
    "Docker Compose failed. Is Docker running?",
  );
}

function runComposePull(): Promise<void> {
  const tenureDir = IS_WIN ? WIN_TENURE_DIR : TENURE_DIR;

  return run(
    "docker",
    [
      "compose",
      "-f",
      join(tenureDir, "docker-compose.yml"),
      "--env-file",
      join(tenureDir, ".env"),
      "pull",
    ],
    "Docker Compose pull failed.",
  );
}

function runComposeRecreate(): Promise<void> {
  const tenureDir = IS_WIN ? WIN_TENURE_DIR : TENURE_DIR;

  return run(
    "docker",
    [
      "compose",
      "-f",
      join(tenureDir, "docker-compose.yml"),
      "--env-file",
      join(tenureDir, ".env"),
      "up",
      "-d",
      "--force-recreate",
    ],
    "Docker Compose recreate failed.",
  );
}

export async function updateTenureImage(): Promise<boolean> {
  try {
    await runComposePull();
    await runComposeRecreate();
    await pollHealth();
    return true;
  } catch {
    return false;
  }
}

async function pollHealth(attempts = 30, intervalMs = 2_000): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (await isTenureHealthy()) return;
    await sleep(intervalMs);
  }
  throw new Error(
    "Tenure did not become healthy after 60 seconds. " +
      "Run: docker compose -f ~/.tenure/docker-compose.yml logs tenure",
  );
}

export function installTenureInTerminal(): void {
  const terminal = vscode.window.createTerminal({
    name: "Tenure Setup",
    iconPath: new vscode.ThemeIcon("symbol-misc"),
  });
  terminal.show();

  if (IS_WIN) {
    terminal.sendText(
      `docker run --rm -v "$env:USERPROFILE\\.tenure:/app/.tenure" tenureai/tenure:latest init`,
    );
    terminal.sendText(
      `docker compose -f "$env:USERPROFILE\\.tenure\\docker-compose.yml" ` +
        `--env-file "$env:USERPROFILE\\.tenure\\.env" up -d`,
    );
    terminal.sendText(`Get-Content "$env:USERPROFILE\\.tenure\\token"`);
  } else {
    terminal.sendText(
      `docker run --rm -v "$HOME/.tenure:/app/.tenure" tenureai/tenure:latest init && ` +
        `docker compose -f "$HOME/.tenure/docker-compose.yml" ` +
        `--env-file "$HOME/.tenure/.env" up -d`,
    );
    terminal.sendText(`cat "$HOME/.tenure/token"`);
  }
}

function run(cmd: string, args: string[], errorHint?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const isFlatpak = !!process.env.FLATPAK_ID;
    const finalCmd = isFlatpak ? "flatpak-spawn" : cmd;
    const finalArgs = isFlatpak ? ["--host", cmd, ...args] : args;

    const proc = spawn(finalCmd, finalArgs, { stdio: "pipe" });
    let stderr = "";
    let stdout = "";
    proc.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            errorHint ??
              (stderr || stdout || `${cmd} exited with code ${code}`),
          ),
        );
      } else {
        resolve();
      }
    });
    proc.on("error", (err) => reject(new Error(errorHint ?? err.message)));
  });
}

async function isPortInUse(port: number): Promise<boolean> {
  try {
    if (platform() === "win32") {
      const { stdout } = await execAsync(`netstat -ano | findstr :${port}`);
      return stdout.trim().length > 0;
    } else {
      const { stdout } = await execAsync(
        `lsof -i :${port} -sTCP:LISTEN -t 2>/dev/null || true`,
      );
      return stdout.trim().length > 0;
    }
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
