import { Logger } from '@nestjs/common';

/**
 * Times an async operation and logs its duration at debug level. No-op cost
 * beyond one Date.now() pair — safe to leave wrapping hot paths permanently,
 * and `debug` is silent unless the app's log level is turned up.
 */
export async function timed<T>(logger: Logger, label: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    logger.debug(`${label} took ${Date.now() - start}ms`);
  }
}
