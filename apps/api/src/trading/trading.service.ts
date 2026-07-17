import { Inject, Injectable } from '@nestjs/common';
import {
  OrderPreview,
  OrderRequest,
  OrderResult,
  Position,
} from '@0dtetrader/shared-types';
import {
  BROKER_GATEWAY,
  BrokerGateway,
} from '../broker/broker-gateway.interface';
import {
  findExplicitOption,
  pickExpiration,
  resolveAutoOtm,
} from '../broker/contract-resolution';
import { errors, isUniqueViolation } from '../common/api-exception';
import { BrokerError } from '../common/broker-error';
import { PrismaService } from '../prisma/prisma.service';
import { OrderRequestDto } from './dto/order-request.dto';

type AuditAction = 'preview' | 'place' | 'cancel';

/**
 * Order flow (docs/ARCHITECTURE.md §3, docs/SECURITY.md §4):
 *   rate limit (controller) → kill switch → idempotency lookup →
 *   server-side re-validation (auto-OTM strike and mid price recomputed from
 *   live data; client values are advisory only) → gateway → audit.
 */
@Injectable()
export class TradingService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(BROKER_GATEWAY) private readonly gateway: BrokerGateway,
  ) {}

  async preview(userId: string, dto: OrderRequestDto): Promise<OrderPreview> {
    await this.assertTradingEnabled(userId, 'preview', { order: dto });
    const normalized = await this.resolveAndValidate(userId, dto);
    try {
      const preview = await this.gateway.previewOrder(userId, normalized);
      await this.audit(userId, 'preview', { order: dto }, preview, 'ok');
      return preview;
    } catch (err) {
      await this.auditError(userId, 'preview', { order: dto }, err);
      throw err;
    }
  }

  async place(
    userId: string,
    dto: OrderRequestDto,
    idempotencyKey: string,
  ): Promise<OrderResult> {
    await this.assertTradingEnabled(userId, 'place', { order: dto });

    // Idempotent replay: a seen key returns the original result without
    // re-submitting (docs/SECURITY.md §4.1).
    const existing = await this.prisma.orderAudit.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
    });
    if (existing) {
      return existing.response as unknown as OrderResult;
    }

    const normalized = await this.resolveAndValidate(userId, dto);
    let result: OrderResult;
    try {
      result = await this.gateway.placeOrder(userId, normalized, idempotencyKey);
    } catch (err) {
      // Failed executions do not consume the key: the client may fix the
      // cause and retry with the same key.
      await this.auditError(userId, 'place', { order: dto }, err);
      throw err;
    }

    try {
      await this.audit(userId, 'place', { order: dto }, result, result.status, idempotencyKey);
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Lost a race against a concurrent submit with the same key — return
        // the winner's result instead of double-submitting.
        const prior = await this.prisma.orderAudit.findUnique({
          where: { userId_idempotencyKey: { userId, idempotencyKey } },
        });
        if (prior) return prior.response as unknown as OrderResult;
      }
      throw err;
    }
    return result;
  }

  async cancel(userId: string, orderId: string): Promise<void> {
    await this.assertTradingEnabled(userId, 'cancel', { orderId });
    try {
      await this.gateway.cancelOrder(userId, orderId);
      await this.audit(userId, 'cancel', { orderId }, { cancelled: orderId }, 'ok');
    } catch (err) {
      await this.auditError(userId, 'cancel', { orderId }, err);
      throw err;
    }
  }

  getOpenOrders(userId: string): Promise<OrderResult[]> {
    return this.gateway.getOpenOrders(userId);
  }

  getPositions(userId: string): Promise<Position[]> {
    return this.gateway.getPositions(userId);
  }

  // -------------------------------------------------------------------------
  // Kill switch (docs/SECURITY.md §4.4)
  // -------------------------------------------------------------------------

  private async assertTradingEnabled(
    userId: string,
    action: AuditAction,
    request: Record<string, unknown>,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw errors.unauthorized('USER_NOT_FOUND', 'User no longer exists');
    }
    if (user.tradingDisabled) {
      await this.audit(
        userId,
        action,
        request,
        { error: { code: 'TRADING_DISABLED', message: 'Trading is disabled for this account' } },
        'blocked',
      );
      throw errors.forbidden(
        'TRADING_DISABLED',
        'Trading is disabled for this account (kill switch)',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Server-side re-validation / normalization (docs/SECURITY.md §4.2)
  // -------------------------------------------------------------------------

  /**
   * Recomputes the tradeable contract from live data. auto_otm is resolved
   * from the live quote + chain (never the client's strike), and the returned
   * request is normalized to explicit mode so the gateway executes exactly
   * what the server validated. Mid prices are recomputed by the gateway from
   * live bid/ask at execution time (and in previews).
   */
  private async resolveAndValidate(
    userId: string,
    dto: OrderRequestDto,
  ): Promise<OrderRequest> {
    const { selection } = dto;

    if (dto.assetClass === 'option') {
      if (!selection.optionType) {
        throw errors.validation('selection.optionType is required for option orders');
      }
      const chain = await this.getChainValidated(
        userId,
        dto.underlying,
        selection.expiration,
      );
      const expiration = pickExpiration(chain.expirations, selection.expiration);

      if (selection.mode === 'auto_otm') {
        const quote = await this.gateway.getQuote(userId, dto.underlying);
        const contract = resolveAutoOtm(
          chain.contracts,
          selection.optionType,
          quote.last,
        );
        return {
          ...dto,
          selection: {
            mode: 'explicit',
            optionType: selection.optionType,
            expiration: contract.expiration,
            strike: contract.strike,
          },
        };
      }

      if (typeof selection.strike !== 'number') {
        throw errors.validation('selection.strike is required for explicit option orders');
      }
      const contract = findExplicitOption(
        chain.contracts,
        selection.optionType,
        selection.strike,
      );
      if (!contract) {
        throw errors.validation(
          `No ${selection.optionType} contract at strike ${selection.strike} ` +
            `for ${dto.underlying} expiring ${expiration}`,
        );
      }
      return {
        ...dto,
        selection: {
          mode: 'explicit',
          optionType: selection.optionType,
          expiration,
          strike: selection.strike,
        },
      };
    }

    // Futures
    if (selection.mode === 'auto_otm') {
      throw errors.validation('selection.mode auto_otm is only supported for options');
    }
    if (!selection.contractSymbol) {
      throw errors.validation('selection.contractSymbol is required for futures orders');
    }
    const contracts = await this.gateway.getFuturesContracts(userId, dto.underlying);
    const contract = contracts.find((c) => c.symbol === selection.contractSymbol);
    if (!contract) {
      throw errors.validation(
        `No futures contract ${selection.contractSymbol} for root ${dto.underlying}`,
      );
    }
    return {
      ...dto,
      selection: { mode: 'explicit', contractSymbol: selection.contractSymbol },
    };
  }

  /**
   * Fetches a chain, translating gateway "no such expiration" errors into
   * client-facing validation errors (the expiration is client input).
   */
  private async getChainValidated(
    userId: string,
    underlying: string,
    expiration?: string,
  ) {
    try {
      return await this.gateway.getOptionsChain(userId, underlying, expiration);
    } catch (err) {
      if (err instanceof BrokerError && err.code === 'CONTRACT_NOT_FOUND') {
        throw errors.validation(err.message);
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Audit log (docs/SECURITY.md §4.5) — never contains credentials.
  // -------------------------------------------------------------------------

  private async audit(
    userId: string,
    action: AuditAction,
    request: Record<string, unknown>,
    response: unknown,
    status: string,
    idempotencyKey?: string,
  ): Promise<void> {
    await this.prisma.orderAudit.create({
      data: {
        userId,
        idempotencyKey: idempotencyKey ?? null,
        request: { action, ...request },
        response: (response ?? null) as never,
        status,
      },
    });
  }

  private async auditError(
    userId: string,
    action: AuditAction,
    request: Record<string, unknown>,
    err: unknown,
  ): Promise<void> {
    const e = err as { code?: string; message?: string };
    await this.audit(
      userId,
      action,
      request,
      { error: { code: e?.code ?? 'ERROR', message: e?.message ?? 'Unknown error' } },
      'error',
    ).catch(() => undefined); // never mask the original error
  }
}
