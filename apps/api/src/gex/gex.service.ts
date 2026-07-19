import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { computeGexLevels } from './gex.engine';
import type { GexLevels } from './gex.types';
import { TradierClient } from './tradier.client';

/**
 * Orchestrates Tradier fetches + the pure engine, and holds the last-good
 * result per symbol so a Tradier hiccup degrades to a stale overlay instead
 * of an error on the chart.
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
        throw new ServiceUnavailableException({
          error: {
            code: 'TRADIER_NOT_CONFIGURED',
            message:
              'Set TRADIER_API_TOKEN in .env (a free Tradier brokerage or paper account provides one).',
          },
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
    const normalized = symbol.toUpperCase().trim() || 'SPY';
    try {
      const client = this.getClient();
      const expirations = await client.getExpirations(normalized);
      const today = new Date().toISOString().slice(0, 10);
      const selected =
        expiration && expirations.includes(expiration)
          ? expiration
          : expirations.includes(today)
            ? today // 0DTE preferred
            : (expirations[0] ?? null); // else nearest
      if (!selected) {
        throw new Error(`No option expirations available for ${normalized}`);
      }

      const [spot, chain] = await Promise.all([
        client.getSpot(normalized),
        client.getChain(normalized, selected),
      ]);

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
      this.lastGood.set(normalized, levels);
      return levels;
    } catch (error) {
      const cached = this.lastGood.get(normalized);
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
