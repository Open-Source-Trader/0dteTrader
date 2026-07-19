import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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

/** A pending idempotency claim older than this is a crashed attempt. */
const PENDING_CLAIM_TTL_MS = 2 * 60_000;

/**
 * Order flow (docs/ARCHITECTURE.md §3, docs/SECURITY.md §4):
 *   rate limit (controller) → kill switch → idempotency claim →
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

    // Claim the key BEFORE the broker call: the pending audit row is the
    // single-flight marker. (Previously the row was written after the broker
    // call, so two concurrent same-key requests both submitted.)
    const replay = await this.claimIdempotencyKey(userId, dto, idempotencyKey);
    if (replay.result) return replay.result;

    try {
      const normalized = await this.resolveAndValidate(userId, dto);
      const result = await this.gateway.placeOrder(userId, normalized, idempotencyKey);
      await this.prisma.orderAudit.update({
        where: { id: replay.pendingId },
        data: { response: result as never, status: result.status },
      });
      return result;
    } catch (err) {
      // Failed executions do not consume the key: the client may fix the
      // cause and retry with the same key.
      await this.prisma.orderAudit
        .delete({ where: { id: replay.pendingId } })
        .catch(() => undefined);
      await this.auditError(userId, 'place', { order: dto }, err);
      throw err;
    }
  }

  /**
   * Inserts the pending claim row for (userId, key). Returns the pending
   * row id on success, the original result on replay, and throws
   * ORDER_IN_FLIGHT when a concurrent placement holds a fresh claim.
   */
  private async claimIdempotencyKey(
    userId: string,
    dto: OrderRequestDto,
    idempotencyKey: string,
  ): Promise<{ pendingId: string; result: null } | { pendingId: null; result: OrderResult }> {
    const data = {
      userId,
      idempotencyKey,
      request: JSON.parse(JSON.stringify({ action: 'place', order: dto })),
      response: Prisma.DbNull,
      status: 'pending',
    };
    try {
      const pending = await this.prisma.orderAudit.create({ data });
      return { pendingId: pending.id, result: null };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }

    const prior = await this.prisma.orderAudit.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
    });
    if (!prior) {
      // Lost the row to a concurrent delete; safest to refuse.
      throw errors.conflict('ORDER_IN_FLIGHT', 'Retry the order');
    }
    if (prior.status !== 'pending') {
      return { pendingId: null, result: prior.response as unknown as OrderResult };
    }
    if (Date.now() - prior.createdAt.getTime() < PENDING_CLAIM_TTL_MS) {
      throw errors.conflict(
        'ORDER_IN_FLIGHT',
        'An order with this idempotency key is already being placed',
      );
    }
    // Stale pending row from a crashed attempt: remove and re-claim.
    await this.prisma.orderAudit.delete({ where: { id: prior.id } });
    const reclaimed = await this.prisma.orderAudit.create({ data });
    return { pendingId: reclaimed.id, result: null };
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
        request: JSON.parse(JSON.stringify({ action, ...request })),
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
