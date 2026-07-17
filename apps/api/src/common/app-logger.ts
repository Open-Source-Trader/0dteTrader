import { ConsoleLogger, Injectable, LogLevel } from '@nestjs/common';
import { redact } from './redact';

/**
 * App-wide logger. Uses Nest's ConsoleLogger (structured JSON not required for
 * v1) but redacts credential/token fields from every message and context
 * object before printing (docs/SECURITY.md §7).
 */
@Injectable()
export class AppLogger extends ConsoleLogger {
  constructor(context?: string, logLevels?: LogLevel[]) {
    super(context ?? '0dteTrader', logLevels ? { logLevels } : {});
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    super.log(redact(message), ...optionalParams.map((p) => redact(p)));
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    super.warn(redact(message), ...optionalParams.map((p) => redact(p)));
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    super.error(redact(message), ...optionalParams.map((p) => redact(p)));
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    super.debug(redact(message), ...optionalParams.map((p) => redact(p)));
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    super.verbose(redact(message), ...optionalParams.map((p) => redact(p)));
  }
}
