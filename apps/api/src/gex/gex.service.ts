import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { computeGexLevels } from './gex.engine';
import type { GexLevels } from './gex.types';
import { TradierClient } from './tradier.client';

/** Today's date in the US options market timezone — 0DTE is a New York
 *  concept, and a UTC date mislabels the session for ~5-7 hours a day. */
function tradingDay(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * Orchestrates Tradier fetches + the pure engine, and holds the last-good
 * result per (symbol, expiration) so a Tradier hiccup degrades to a stale
 * overlay instead of an error on the chart.
 */
@Injectable()
export class GexService {
  private readonly logger = new Logger(GexService.name);
  private readonly lastGood = new Map<string, GexLevels>();
  private client: TradierClient | null = null;

  constructor(private readonly config: ConfigService) {}

  private getClient(): TradierClient {
    if (!this.client) {
      const token = this.config.get<string>('tradier.token') ?? '';
      if (!token) {
        // Flat {code, message} body — the global exception filter reads that
        // shape and passes the actionable code through to the client.
        throw new ServiceUnavailableException({
          code: 'TRADIER_NOT_CONFIGURED',
          message:
            'Set TRADIER_API_TOKEN in .env (a free Tradier brokerage or paper account provides one).',
        });
      }
      this.client = new TradierClient(
        token,
        this.config.get<string>('tradier.baseUrl') ?? 'https://api.tradier.com',
      );
    }
    return this.client;
  }

  async getLevels(symbol: string, expiration?: string): Promise<GexLevels> {
    const normalized = symbol.toUpperCase().trim();
    if (!/^[A-Z0-9.\-]{1,12}$/.test(normalized)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'A valid symbol is required (e.g. SPY)',
      });
    }
    const client = this.getClient();
    const today = tradingDay();
    let selected: string | null = null;

    try {
      const expirations = await client.getExpirations(normalized);
      if (expiration) {
        if (!expirations.includes(expiration)) {
          throw new BadRequestException({
            code: 'VALIDATION_ERROR',
            message:
              `No expiration ${expiration} for ${normalized}. ` +
              `Available: ${expirations.slice(0, 8).join(', ')}${expirations.length > 8 ? ', …' : ''}`,
          });
        }
        selected = expiration;
      } else {
        selected = expirations.includes(today) ? today : (expirations[0] ?? null);
        if (!selected) {
          throw new Error(`No option expirations available for ${normalized}`);
        }
      }

      const [spot, chain] = await Promise.all([
        client.getSpot(normalized),
        client.getChain(normalized, selected),
      ]);
      if (chain.length === 0) {
        // A transient empty-chain glitch must not poison the last-good cache.
        throw new Error(`Empty option chain for ${normalized} ${selected}`);
      }

      const levels: GexLevels = {
        ...computeGexLevels(chain, {
          symbol: normalized,
          expiration: selected,
          isZeroDte: selected === today,
          spot,
        }),
        asOf: new Date().toISOString(),
        stale: false,
      };
      this.lastGood.set(`${normalized}:${selected}`, levels);
      return levels;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      // Stale fallback: exact (symbol, expiration) match first, then any
      // cached expiration for the symbol — labeled stale either way.
      const exact = selected ? this.lastGood.get(`${normalized}:${selected}`) : undefined;
      const anyForSymbol = [...this.lastGood.entries()].find(([key]) =>
        key.startsWith(`${normalized}:`),
      )?.[1];
      const cached = exact ?? anyForSymbol;
      if (cached && !(error instanceof ServiceUnavailableException)) {
        this.logger.warn(
          `Tradier fetch failed for ${normalized}, serving stale levels: ${(error as Error).message}`,
        );
        return { ...cached, stale: true };
      }
      throw error;
    }
  }
}
