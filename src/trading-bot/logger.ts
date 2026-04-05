/**
 * Simple structured logger for the trading bot
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',   // gray
  info: '\x1b[36m',    // cyan
  warn: '\x1b[33m',    // yellow
  error: '\x1b[31m',   // red
};

const RESET = '\x1b[0m';

export class Logger {
  private minLevel: number;

  constructor(private level: LogLevel = 'info', private prefix: string = 'BOT') {
    this.minLevel = LEVEL_PRIORITY[level];
  }

  child(prefix: string): Logger {
    return new Logger(this.level as LogLevel, `${this.prefix}:${prefix}`);
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.log('debug', msg, data);
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.log('info', msg, data);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.log('warn', msg, data);
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.log('error', msg, data);
  }

  private log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < this.minLevel) return;

    const timestamp = new Date().toISOString();
    const color = LEVEL_COLORS[level];
    const tag = level.toUpperCase().padEnd(5);
    const prefix = `${color}[${timestamp}] ${tag} [${this.prefix}]${RESET}`;

    if (data) {
      console.log(`${prefix} ${msg}`, JSON.stringify(data, null, 0));
    } else {
      console.log(`${prefix} ${msg}`);
    }
  }
}
