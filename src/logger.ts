import { config } from './config';

const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof levels;
const threshold = levels[(config.logLevel as Level) in levels ? (config.logLevel as Level) : 'info'];

function write(level: Level, args: unknown[]): void {
  if (levels[level] < threshold) return;
  const stamp = new Date().toISOString();
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(`[${stamp}] ${level.toUpperCase().padEnd(5)}`, ...args);
}

export const log = {
  debug: (...args: unknown[]) => write('debug', args),
  info: (...args: unknown[]) => write('info', args),
  warn: (...args: unknown[]) => write('warn', args),
  error: (...args: unknown[]) => write('error', args),
};
