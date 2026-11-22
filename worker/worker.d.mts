// Type declarations so TypeScript tests can import the plain-JS worker.
export interface WorkerConfig {
  workerUrl: string; token: string; claudeBin: string; claudeModel: string;
  pollIntervalMs: number; taskTimeoutMs: number; concurrency: number; workDir: string;
}
export interface Prepared { claude: { command: string; prefixArgs: string[]; display: string }; version: string; info: string }
export const REQUIRED_FLAGS: string[];
export function parseEnvFile(text: string): Record<string, string>;
export function loadConfig(env?: Record<string, string | undefined>, envFile?: string | null): WorkerConfig;
export function redact(text: unknown, max?: number): string;
export function splitCommand(str: string): string[];
export function resolveClaude(claudeBin: string): Prepared["claude"];
export function sanitizedEnv(base?: Record<string, string | undefined>): Record<string, string>;
export function buildClaudeArgs(model?: string): string[];
export function buildStdinMessage(task: { page: number; mediaType: string; data: string }): string;
export function looksLikePage(v: unknown): boolean;
export function interpretOutput(o: Record<string, any>, timeoutMs: number): any;
export function validateTask(t: unknown): string | null;
export function extractPage(task: any, cfg: WorkerConfig, claude: Prepared["claude"]): Promise<any>;
export function prepare(cfg: WorkerConfig): Promise<Prepared>;
export function runOnce(cfg: WorkerConfig, prep?: Prepared, state?: any): Promise<{
  status: "idle" | "processed" | "http_error" | "invalid_task"; backoffMs?: number | null; posted?: number | null; body?: any; outcome?: any; httpStatus?: number;
}>;
export function selfCheck(cfg: WorkerConfig): Promise<boolean>;
export const HEARTBEAT_MS: number;
export function parseLimitReset(text: string, now?: Date): Date | null;
export function checkLogin(claude: Prepared["claude"], cwd: string): Promise<{ ok: boolean | null; detail: string }>;
export function heartbeatBody(prep: Prepared, state: any): import("../src/lib/contract").WorkerHeartbeatRequest;
