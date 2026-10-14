const SECRET_KEY = /^(?:cookie|cookies|set-cookie|authorization|password|passwd|token|access_?token|refresh_?token|__zp_stoken__|zp_stoken|storageState|session_?token)$/i;
const defaultExitCode = (code) => /AUTH|LOGIN|SESSION_EXPIRED/.test(code) ? 3 : /TIMEOUT|NETWORK|CAPTCHA|VERIFICATION|VERIFY|BLOCKED/.test(code) ? 4 : /INVALID_ARGUMENT|USAGE/.test(code) ? 2 : 1;

export function redactSensitive(value) {
  return String(value ?? '')
    .replace(/(\b(?:cookie|set-cookie|authorization)\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/(["']?\b(?:__zp_stoken__|zp_stoken|access_?token|refresh_?token|password|passwd|token)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s;&,}\]]+)/gi, '$1[REDACTED]')
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/|wss?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[REDACTED]@');
}

export function redactResult(value) {
  if (Array.isArray(value)) return value.map(redactResult);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[REDACTED]' : redactResult(item)]));
  }
  return typeof value === 'string' ? redactSensitive(value) : value;
}

export class BossCliError extends Error {
  constructor(message, { code = 'BOSS_ERROR', exitCode = defaultExitCode(code), details, cause } = {}) {
    super(message, { cause });
    this.name = 'BossCliError';
    this.code = code;
    this.exitCode = exitCode;
    if (details !== undefined) this.details = details;
  }
}

export { BossCliError as BossError };

export class UsageError extends BossCliError {
  constructor(message) {
    super(message, { code: 'USAGE_ERROR', exitCode: 2 });
    this.name = 'UsageError';
  }
}

export function normalizeError(error) {
  const code = typeof error?.code === 'string' ? error.code : 'BOSS_ERROR';
  const result = {
    code,
    message: redactSensitive(error?.message ?? error ?? '未知错误'),
  };
  if (error?.details !== undefined) result.details = redactResult(error.details);
  return { error: result, exitCode: Number.isInteger(error?.exitCode) ? error.exitCode : defaultExitCode(code) };
}
