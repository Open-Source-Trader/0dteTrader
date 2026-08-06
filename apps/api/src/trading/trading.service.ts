import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma, type User } from '@prisma/client';
import {
  AccountSummary,
  OptionContract,
  OrderPreview,
  OrderRequest,
  OrderResult,
  Position,
  TradingMode,
} from '@0dtetrader/shared-types';
import {
  BROKER_GATEWAY,
  BrokerExecutionScope,
  BrokerGateway,
  RecoveredOrderResult,
} from '../broker/broker-gateway.interface';
import { OrderEventsService, type OrderUpdateEvent } from '../broker/order-events.service';
import {
  findExplicitOption,
  formatOccSymbol,
  pickExpiration,
  resolveAutoOtm,
} from '../broker/contract-resolution';
import { ApiException, errors, isUniqueViolation } from '../common/api-exception';
import { BrokerError } from '../common/broker-error';
import { timed } from '../common/timing';
import { PrismaService } from '../prisma/prisma.service';
import { LEGAL_VERSION } from '../legal/legal.service';
import { OrderRequestDto } from './dto/order-request.dto';
import { OrdersService, type PositionAnchor } from './orders.service';
import { AutoCandidatesService } from './auto-candidates.service';

type AuditAction = 'preview' | 'place' | 'cancel';

/** A pending idempotency claim older than this is a crashed attempt. */
const PENDING_CLAIM_TTL_MS = 2 * 60_000;
const STALE_AUTO_EXCLUSION_REASONS = new Set(['stale_quote', 'future_quote', 'stale_analytics']);

export interface TradingServiceMetrics {
  scoredReranks: number;
  scoredAccepted: number;
  scoredSelectionChanges: number;
  scoredNoPassRejections: number;
  scoredStaleRejections: number;
  scoredConfirmationRejections: number;
}

/** Guards against a source reporting 0 / NaN for a price we would anchor on. */
function usablePrice(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Failures at or beyond the broker request boundary for which a retry could
 * duplicate an order. Typed broker rejections are definitive; transport loss,
 * timeout and a broker-unavailable response are not. */
function placementOutcomeUncertain(error: unknown): boolean {
  if (error instanceof BrokerError) return error.code === 'BROKER_UNAVAILABLE';
  // ApiExceptions raised by gateway-side scope validation are explicit
  // refusals made before the broker send. Everything else is unknown at this
  // boundary — SDKs commonly surface transport loss as a plain `fetch failed`
  // Error (or even a non-Error value), which must never authorize a retry.
  if (error instanceof ApiException) return false;
  return true;
}

/**
 * Order flow (docs/ARCHITECTURE.md §3, docs/SECURITY.md §4):
 *   rate limit (controller) → kill switch → idempotency claim →
 *   server-side re-validation (auto-OTM strike and mid price recomputed from
 *   live data; client values are advisory only) → gateway → audit.
 */
@Injectable()
export class TradingService {
  private readonly logger = new Logger(TradingService.name);
  readonly metrics: TradingServiceMetrics = {
    scoredReranks: 0,
    scoredAccepted: 0,
    scoredSelectionChanges: 0,
    scoredNoPassRejections: 0,
    scoredStaleRejections: 0,
    scoredConfirmationRejections: 0,
  };

  constructor(
    private readonly prisma: PrismaService,
    @Inject(BROKER_GATEWAY) private readonly gateway: BrokerGateway,
    private readonly orders: OrdersService,
    private readonly events: OrderEventsService,
    @Optional() private readonly autoCandidates?: AutoCandidatesService,
  ) {}

  async preview(userId: string, dto: OrderRequestDto): Promise<OrderPreview> {
    await this.assertTradingEnabled(userId, 'preview', { order: dto });
    const { request: normalized } = await this.resolveAndValidate(userId, dto);
    try {
      const preview = await timed(this.logger, 'trading.preview.gateway', () =>
        this.gateway.previewOrder(userId, normalized),
      );
      await this.audit(userId, 'preview', { order: dto }, preview, 'ok');
      return preview;
    } catch (err) {
      await this.auditError(userId, 'preview', { order: dto }, err);
      throw err;
    }
  }

  /**
   * `expectedMode` pins the environment for the whole placement. Callers that
   * armed an order against a specific environment — chart order lines above
   * all, which fire with nobody present — pass the one they validated, and the
   * gateway refuses if the account has moved since.
   */
  async place(
    userId: string,
    dto: OrderRequestDto,
    idempotencyKey: string,
    expectedMode?: TradingMode,
    closeOnly = false,
    expectedScope?: BrokerExecutionScope,
  ): Promise<OrderResult> {
    // Always enforce the kill switch first. Legal acceptance is handled just
    // below because an already-open position must remain closable after a
    // disclosure version bump — but only when the server can prove this exact
    // request reduces that exact broker-account position.
    const user = await this.assertTradingEnabled(userId, 'place', { order: dto }, true);
    // Resolved once, here, and carried to the send: everything downstream
    // otherwise re-reads the mode per broker call.
    const mode: TradingMode =
      expectedMode ?? (user.tradingMode === 'practice' ? 'practice' : 'live');
    const requestedExecutionScope =
      expectedScope ?? (await this.executionScopeForPlacement(user, mode));

    const hasCurrentLegal = await this.hasCurrentLegalAcceptance(userId);
    let prevalidated: Awaited<ReturnType<TradingService['resolveAndValidate']>> | undefined;
    if (!hasCurrentLegal && !closeOnly) {
      prevalidated = await this.resolveAndValidate(userId, dto);
      if (
        !(await this.isVerifiedPositionReduction(
          userId,
          prevalidated.request,
          prevalidated.contractSymbol,
          requestedExecutionScope,
        ))
      ) {
        await this.rejectForMissingLegal(userId, { order: dto });
      }
    }

    // Claim the key BEFORE the broker call: the pending audit row is the
    // single-flight marker. (Previously the row was written after the broker
    // call, so two concurrent same-key requests both submitted.)
    const replay = await this.claimIdempotencyKey(
      userId,
      dto,
      idempotencyKey,
      requestedExecutionScope,
    );
    if (replay.result) return replay.result;
    const executionScope = replay.executionScope;

    let enteredGateway = false;
    try {
      const {
        request: normalized,
        underlyingPrice,
        contractSymbol,
        contract,
      } = prevalidated && dto.selection.mode !== 'auto_scored'
        ? prevalidated
        : await this.resolveAndValidate(userId, dto);
      const { order: capped, heldQuantity } = await this.capToPosition(
        userId,
        normalized,
        contractSymbol,
        closeOnly || !hasCurrentLegal,
        executionScope,
      );
      // Persist the exact normalized and size-capped broker request before the
      // send. A stale claim after process death can then distinguish a
      // crash-before-send from a broker-accepted option order without matching
      // some unrelated AUTO order on underlying/side alone.
      await this.prisma.orderAudit.update({
        where: { id: replay.pendingId },
        data: {
          request: JSON.parse(
            JSON.stringify({
              action: 'place',
              order: dto,
              preparedOrder: capped,
              executionScope,
            }),
          ),
        },
      });
      enteredGateway = true;
      const result = await timed(this.logger, 'trading.place.gateway', () =>
        this.gateway.placeOrder(
          userId,
          capped,
          idempotencyKey,
          mode,
          heldQuantity,
          contract,
          executionScope,
        ),
      );
      // The broker has accepted. Nothing from here may throw: the catch below
      // deletes the idempotency claim so the caller can retry, which after a
      // real placement would submit the order a SECOND time. Bookkeeping
      // failures are logged, never propagated.
      await this.prisma.orderAudit
        .update({
          where: { id: replay.pendingId },
          data: { response: result as never, status: result.status },
        })
        .catch((auditErr: unknown) =>
          this.logger.error(
            `order ${result.orderId} placed but its audit row was not updated: ` +
              `${(auditErr as Error).message}`,
          ),
        );
      // The gateway emits the placement on the order-events bus, which persists
      // the row without an underlying price (the broker has no such concept).
      // Recording it here converges on the same row from the one caller that
      // knows it — see OrdersService.record.
      if (underlyingPrice !== undefined) {
        // Writes only that column: the broker's status poll is already running,
        // and a full re-record could roll a fill back to `submitted`.
        const placementIdentity =
          executionScope.provider === 'snaptrade'
            ? {
                provider: 'snaptrade' as const,
                accountId: executionScope.accountId,
                clientOrderId: idempotencyKey,
                brokerOrderId: result.orderId === idempotencyKey ? undefined : result.orderId,
              }
            : {
                provider: executionScope.provider,
                accountId: executionScope.accountId,
                // Webull and Alpaca both expose their cancellation/client id
                // as OrderResult.orderId; their gateway event later adds the
                // broker id to this same scoped row.
                clientOrderId: result.orderId,
              };
        await this.orders
          .recordUnderlyingPrice(userId, result, underlyingPrice, mode, placementIdentity)
          .catch(() => undefined); // an unanchored entry line is not worth failing an order over
      }
      return result;
    } catch (err) {
      if (enteredGateway && placementOutcomeUncertain(err)) {
        // Preserve the keyed pending claim. A timeout can mean "accepted, but
        // the acknowledgement was lost"; deleting this row would make the
        // caller's retry submit a second order. Recovery reconciles it against
        // broker history, and refuses indefinitely where a broker cannot prove
        // absence.
        await this.auditError(userId, 'place', { order: dto }, err);
        throw errors.unavailable(
          'ORDER_PLACEMENT_UNCERTAIN',
          'The broker did not confirm whether it accepted the order. Do not retry it manually; reconciliation is still checking.',
        );
      }
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
    expectedScope: BrokerExecutionScope,
  ): Promise<
    | { pendingId: string; result: null; executionScope: BrokerExecutionScope }
    | { pendingId: null; result: OrderResult; executionScope: null }
  > {
    const data = {
      userId,
      idempotencyKey,
      request: JSON.parse(
        JSON.stringify({ action: 'place', order: dto, executionScope: expectedScope }),
      ),
      response: Prisma.DbNull,
      status: 'pending',
    };
    try {
      const pending = await this.prisma.orderAudit.create({ data });
      return { pendingId: pending.id, result: null, executionScope: expectedScope };
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
      const completed = this.recoveredOrderResult(prior.response);
      if (!completed) {
        throw errors.unavailable(
          'ORDER_RECOVERY_UNAVAILABLE',
          'The completed order audit is unreadable; broker reconciliation is required before continuing',
        );
      }
      const replayScope = this.persistedExecutionScope(prior.request) ?? expectedScope;
      await this.ingestRecoveredPlacement(userId, idempotencyKey, completed, replayScope);
      return {
        pendingId: null,
        result: this.publicOrderResult(completed),
        executionScope: null,
      };
    }
    if (Date.now() - prior.createdAt.getTime() < PENDING_CLAIM_TTL_MS) {
      throw errors.conflict(
        'ORDER_IN_FLIGHT',
        'An order with this idempotency key is already being placed',
      );
    }
    // A stale claim straddles the one inherently ambiguous crash boundary:
    // the broker may have accepted immediately before this process died. Ask
    // the broker for recent truth before reusing the key. This is especially
    // important for SnapTrade multi-leg option orders, whose endpoint has no
    // client_order_id field and therefore cannot deduplicate a blind retry.
    const recoveryRequest = this.preparedOrder(prior.request) ?? dto;
    const recoveryScope = this.persistedExecutionScope(prior.request) ?? expectedScope;
    const recovered = await this.recoverStalePlacement(
      userId,
      recoveryRequest,
      prior.createdAt,
      recoveryScope,
      idempotencyKey,
    );
    if (recovered) {
      await this.prisma.orderAudit
        .update({
          where: { id: prior.id },
          data: { response: recovered as never, status: recovered.status },
        })
        .catch(() => undefined);
      await this.ingestRecoveredPlacement(userId, idempotencyKey, recovered, recoveryScope);
      return {
        pendingId: null,
        result: this.publicOrderResult(recovered),
        executionScope: null,
      };
    }

    // The broker's recent-order view confirms nothing matching was accepted.
    // This is the crash-before-send case, so reclaiming and submitting is safe.
    await this.prisma.orderAudit.delete({ where: { id: prior.id } });
    const reclaimed = await this.prisma.orderAudit.create({
      data: {
        ...data,
        request: JSON.parse(
          JSON.stringify({ action: 'place', order: dto, executionScope: recoveryScope }),
        ),
      },
    });
    return { pendingId: reclaimed.id, result: null, executionScope: recoveryScope };
  }

  private async recoverStalePlacement(
    userId: string,
    dto: OrderRequest | OrderRequestDto,
    claimedAt: Date,
    expectedScope?: BrokerExecutionScope,
    idempotencyKey?: string,
  ): Promise<RecoveredOrderResult | null> {
    if (idempotencyKey && expectedScope && this.gateway.recoverOrder) {
      try {
        const exact = await this.gateway.recoverOrder(userId, idempotencyKey, expectedScope);
        if (exact !== undefined) return exact;
      } catch {
        throw errors.unavailable(
          'ORDER_RECOVERY_UNAVAILABLE',
          'The broker account could not be queried for the interrupted order; it remains pending for safety',
        );
      }
    }
    if (!this.gateway.getRecentOrders) {
      throw errors.unavailable(
        'ORDER_RECOVERY_UNAVAILABLE',
        'This broker cannot prove that the interrupted order was not accepted; the order remains pending for safety',
      );
    }
    const since = new Date(claimedAt.getTime() - 5_000);
    let recent: OrderResult[];
    try {
      recent = await this.gateway.getRecentOrders(userId, since, expectedScope);
    } catch {
      throw errors.unavailable(
        'ORDER_RECOVERY_UNAVAILABLE',
        'The broker account could not be queried for the interrupted order; it remains pending for safety',
      );
    }
    let scoredSelectedSymbol: string | null = null;
    if (dto.selection.mode === 'auto_scored' && 'autoScoring' in dto.selection) {
      const autoScoring = dto.selection.autoScoring;
      if (
        autoScoring &&
        typeof autoScoring === 'object' &&
        'selectedSymbol' in autoScoring &&
        typeof autoScoring.selectedSymbol === 'string' &&
        autoScoring.selectedSymbol.length > 0
      ) {
        scoredSelectedSymbol = autoScoring.selectedSymbol;
      }
    }
    if (dto.selection.mode === 'auto_scored' && scoredSelectedSymbol === null) {
      throw errors.unavailable(
        'ORDER_RECOVERY_UNAVAILABLE',
        'The interrupted scored-Auto order has no selected contract identity; it remains pending for safety',
      );
    }
    const expectedSymbol =
      scoredSelectedSymbol ??
      (dto.assetClass === 'option' &&
      dto.selection.expiration &&
      dto.selection.optionType &&
      dto.selection.strike !== undefined
        ? formatOccSymbol(
            dto.underlying,
            dto.selection.expiration,
            dto.selection.optionType,
            dto.selection.strike,
          )
        : null);
    const candidates = recent.filter((order) => {
      const placedAt = Date.parse(order.timestamp);
      if (Number.isFinite(placedAt) && placedAt < since.getTime()) return false;
      if (order.side !== dto.side || order.quantity !== dto.quantity) return false;
      if (order.orderType !== dto.orderType) return false;
      if (expectedSymbol) return order.contractSymbol === expectedSymbol;
      return order.contractSymbol.toUpperCase().startsWith(dto.underlying.toUpperCase());
    });
    if (candidates.length > 1) {
      throw errors.conflict(
        'ORDER_RECOVERY_AMBIGUOUS',
        'Multiple recent broker orders match the interrupted placement; review the broker before retrying',
      );
    }
    return candidates[0] ?? null;
  }

  private recoveredOrderResult(value: Prisma.JsonValue): RecoveredOrderResult | null {
    if (!value || Array.isArray(value) || typeof value !== 'object') return null;
    const candidate = value as unknown as Partial<RecoveredOrderResult>;
    if (typeof candidate.orderId !== 'string' || candidate.orderId.length === 0) return null;
    return candidate as RecoveredOrderResult;
  }

  private publicOrderResult(recovered: RecoveredOrderResult): OrderResult {
    const order = { ...recovered };
    delete order.brokerOrderId;
    delete order.clientOrderId;
    return order;
  }

  private recoveredPlacementIdentity(
    scope: BrokerExecutionScope,
    idempotencyKey: string,
    recovered: RecoveredOrderResult,
  ): Omit<OrderUpdateEvent, 'userId' | 'order' | 'environment'> {
    if (scope.provider === 'snaptrade') {
      const brokerOrderId =
        recovered.brokerOrderId ??
        (recovered.orderId !== idempotencyKey ? recovered.orderId : undefined);
      return {
        provider: scope.provider,
        accountId: scope.accountId,
        clientOrderId: recovered.clientOrderId ?? idempotencyKey,
        ...(brokerOrderId ? { brokerOrderId } : {}),
      };
    }
    return {
      provider: scope.provider,
      accountId: scope.accountId,
      clientOrderId: recovered.clientOrderId ?? recovered.orderId,
      ...(recovered.brokerOrderId ? { brokerOrderId: recovered.brokerOrderId } : {}),
    };
  }

  private async ingestRecoveredPlacement(
    userId: string,
    idempotencyKey: string,
    recovered: RecoveredOrderResult,
    scope: BrokerExecutionScope,
  ): Promise<void> {
    try {
      await this.events.ingest(
        userId,
        this.publicOrderResult(recovered),
        scope.environment,
        this.recoveredPlacementIdentity(scope, idempotencyKey, recovered),
      );
    } catch {
      // The completed audit is intentionally retained. The next keyed replay
      // retries this idempotent ingestion without touching the broker.
      throw errors.unavailable(
        'ORDER_RECOVERY_UNAVAILABLE',
        'The broker order was recovered but its durable application event is still being repaired',
      );
    }
  }

  private preparedOrder(request: Prisma.JsonValue): OrderRequest | null {
    if (request === null || Array.isArray(request) || typeof request !== 'object') return null;
    const candidate = (request as Prisma.JsonObject)['preparedOrder'];
    if (candidate === null || Array.isArray(candidate) || typeof candidate !== 'object') {
      return null;
    }
    const value = candidate as Prisma.JsonObject;
    const selection = value['selection'];
    if (
      typeof value['underlying'] !== 'string' ||
      value['assetClass'] !== 'option' ||
      (value['side'] !== 'buy' && value['side'] !== 'sell') ||
      !Number.isSafeInteger(value['quantity']) ||
      (value['orderType'] !== 'market' && value['orderType'] !== 'mid') ||
      selection === null ||
      Array.isArray(selection) ||
      typeof selection !== 'object'
    ) {
      return null;
    }
    return candidate as unknown as OrderRequest;
  }

  private persistedExecutionScope(request: Prisma.JsonValue): BrokerExecutionScope | undefined {
    if (request === null || Array.isArray(request) || typeof request !== 'object') return undefined;
    const candidate = (request as Prisma.JsonObject)['executionScope'];
    if (candidate === null || Array.isArray(candidate) || typeof candidate !== 'object') {
      return undefined;
    }
    const value = candidate as Prisma.JsonObject;
    if (
      !['webull', 'alpaca', 'snaptrade'].includes(String(value['provider'])) ||
      !['live', 'practice'].includes(String(value['environment'])) ||
      typeof value['accountId'] !== 'string' ||
      value['accountId'].length === 0
    ) {
      return undefined;
    }
    return value as unknown as BrokerExecutionScope;
  }

  private async executionScopeForPlacement(
    user: User,
    mode: TradingMode,
  ): Promise<BrokerExecutionScope> {
    if (this.gateway.executionScope) return this.gateway.executionScope(user.id, mode);
    const provider: BrokerExecutionScope['provider'] =
      user.tradingProvider === 'alpaca' || user.tradingProvider === 'snaptrade'
        ? user.tradingProvider
        : 'webull';
    return { provider, environment: mode, accountId: 'default' };
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

  /** Broker-reported account equity, when the broker exposes one — null for
   *  gateways with no previous-close reference (Webull, SnapTrade today). */
  getAccountSummary(userId: string): Promise<AccountSummary | null> {
    return this.gateway.getAccountSummary?.(userId) ?? Promise.resolve(null);
  }

  /**
   * Broker positions, each annotated with the underlying price its opening
   * fills happened at — the level the chart draws the entry line at — and the
   * time the position was opened. The annotations are best-effort: a position
   * opened before they were recorded (or outside this app) simply carries none.
   */
  async getPositions(userId: string): Promise<Position[]> {
    const positions = await this.gateway.getPositions(userId);
    if (positions.length === 0) return positions;
    const anchors = await this.orders
      .positionAnchors(
        userId,
        positions.map((position) => position.symbol),
      )
      .catch(() => new Map<string, PositionAnchor>());
    return positions.map((position) => {
      const anchor = anchors.get(position.symbol);
      // Trusted only when the replay accounts for the WHOLE broker position
      // — same signed quantity. App-side history can miss fills (orders
      // placed outside the app, missed polls), and an entry price averaged
      // over the wrong fills is worse than none: "Move stop to entry"
      // consumes it. Without the anchor the clients degrade cleanly (no
      // entry line, "Entry price unknown", time-in-trade dash).
      if (!anchor || anchor.quantity !== position.quantity) return position;
      return {
        ...position,
        // The anchor is a placement-quote ESTIMATE: it feeds the display
        // field only. underlyingEntryPrice stays reserved for a true
        // fill-time observation, which the backend cannot produce yet — so
        // "Move stop to entry" stays disabled rather than acting on a quote
        // from before the fill.
        ...(anchor.underlyingEntryEstimate !== undefined && {
          underlyingEntryEstimate: anchor.underlyingEntryEstimate,
        }),
        ...(anchor.openedAt && { openedAt: anchor.openedAt.toISOString() }),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Kill switch (docs/SECURITY.md §4.4)
  // -------------------------------------------------------------------------

  /** Returns the user it read, so callers need not fetch the row a second time. */
  private async assertTradingEnabled(
    userId: string,
    action: AuditAction,
    request: Record<string, unknown>,
    allowUnacceptedRiskReduction = false,
  ): Promise<User> {
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
    if (
      action === 'place' &&
      !allowUnacceptedRiskReduction &&
      !(await this.hasCurrentLegalAcceptance(userId))
    ) {
      await this.rejectForMissingLegal(userId, request);
    }
    return user;
  }

  private async hasCurrentLegalAcceptance(userId: string): Promise<boolean> {
    const accepted = await this.prisma.legalAcceptance.findMany({
      where: {
        userId,
        version: LEGAL_VERSION,
        document: { in: ['terms', 'risk'] },
      },
    });
    return new Set(accepted.map((row) => row.document)).size === 2;
  }

  private async rejectForMissingLegal(
    userId: string,
    request: Record<string, unknown>,
  ): Promise<never> {
    await this.audit(
      userId,
      'place',
      request,
      { error: { code: 'LEGAL_ACCEPTANCE_REQUIRED' } },
      'blocked',
    );
    throw errors.forbidden(
      'LEGAL_ACCEPTANCE_REQUIRED',
      'Accept the current Terms and Options Risk Disclosure before placing opening orders',
    );
  }

  private async isVerifiedPositionReduction(
    userId: string,
    order: OrderRequest,
    contractSymbol: string,
    expectedScope: BrokerExecutionScope,
  ): Promise<boolean> {
    let positions: Position[];
    try {
      positions = await this.gateway.getPositions(userId, expectedScope);
    } catch {
      throw errors.unavailable(
        'POSITIONS_UNAVAILABLE',
        `Could not verify the ${contractSymbol} position — no unaccepted order was sent`,
      );
    }
    const held = positions.find((position) => position.symbol === contractSymbol);
    if (!held || held.quantity === 0) return false;
    const closesHeldSide = order.side === 'sell' ? held.quantity > 0 : held.quantity < 0;
    return closesHeldSide && order.quantity <= Math.abs(held.quantity);
  }

  /** Chart orders are future placements, so arming one requires the same
   * current server-side acceptance as placing an opening order. */
  async assertCanArm(userId: string): Promise<void> {
    await this.assertTradingEnabled(userId, 'place', { action: 'arm-chart-order' });
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
   *
   * Also returns the underlying's price at resolution time — the chain is
   * fetched for every order anyway, so the entry-line anchor costs nothing
   * extra. Undefined when the source reports an unusable price.
   */
  private async resolveAndValidate(
    userId: string,
    dto: OrderRequestDto,
  ): Promise<{
    request: OrderRequest;
    underlyingPrice: number | undefined;
    contractSymbol: string;
    /** The contract this chain fetch already resolved — handed to the
     *  gateway so it need not re-resolve (re-fetch a chain/quote) seconds
     *  later for the same symbol. */
    contract: OptionContract;
  }> {
    const { selection } = dto;

    if (!selection.optionType) {
      throw errors.validation('selection.optionType is required for option orders');
    }

    if (selection.mode === 'auto_scored') {
      if (!selection.autoScoring || selection.autoScoring.scoredConfirmationAccepted !== true) {
        this.metrics.scoredConfirmationRejections += 1;
        this.logger.log(
          JSON.stringify({
            event: 'scored_auto_rerank',
            userId,
            underlying: dto.underlying,
            outcome: 'confirmation_required',
          }),
        );
        throw errors.badRequest(
          'SCORED_CONFIRMATION_REQUIRED',
          'Scored Auto orders require explicit scored confirmation.',
        );
      }
      if (!selection.expiration) {
        throw errors.validation('selection.expiration is required for scored Auto orders');
      }
      if (!this.autoCandidates) {
        throw errors.unavailable('AUTO_SCORING_UNAVAILABLE', 'Scored Auto ranking is unavailable.');
      }
      const fresh = await timed(this.logger, 'trading.resolveAndValidate.autoScored', () =>
        this.autoCandidates!.rankResolved(
          userId,
          {
            underlying: dto.underlying,
            expiration: selection.expiration!,
            optionType: selection.optionType!,
          },
          selection.autoScoring!.preferences,
        ),
      );
      this.metrics.scoredReranks += 1;
      if (fresh.result.noPass || fresh.selectedContract === null) {
        const staleRejected = fresh.result.exclusions.some((exclusion) =>
          STALE_AUTO_EXCLUSION_REASONS.has(exclusion.reason),
        );
        this.metrics.scoredNoPassRejections += 1;
        if (staleRejected) this.metrics.scoredStaleRejections += 1;
        this.logger.log(
          JSON.stringify({
            event: 'scored_auto_rerank',
            userId,
            underlying: dto.underlying,
            submittedSymbol: selection.autoScoring.selectedSymbol,
            freshSymbol: fresh.result.selectedSymbol,
            outcome: 'no_pass',
            staleRejected,
            exclusions: fresh.result.exclusions,
          }),
        );
        throw errors.conflict(
          'AUTO_SCORING_NO_PASS',
          'No contract passes the current scored Auto requirements.',
        );
      }
      if (fresh.result.selectedSymbol !== selection.autoScoring.selectedSymbol) {
        this.metrics.scoredSelectionChanges += 1;
        this.logger.log(
          JSON.stringify({
            event: 'scored_auto_rerank',
            userId,
            underlying: dto.underlying,
            submittedSymbol: selection.autoScoring.selectedSymbol,
            freshSymbol: fresh.result.selectedSymbol,
            outcome: 'selection_changed',
          }),
        );
        throw errors.conflict(
          'AUTO_SCORING_SELECTION_CHANGED',
          'The scored Auto winner changed; review and confirm the fresh ranking.',
        );
      }
      const contract = fresh.selectedContract;
      this.metrics.scoredAccepted += 1;
      this.logger.log(
        JSON.stringify({
          event: 'scored_auto_rerank',
          userId,
          underlying: dto.underlying,
          submittedSymbol: selection.autoScoring.selectedSymbol,
          freshSymbol: fresh.result.selectedSymbol,
          outcome: 'accepted',
        }),
      );
      return {
        request: {
          ...dto,
          selection: {
            mode: 'explicit',
            optionType: contract.optionType,
            expiration: contract.expiration,
            strike: contract.strike,
          },
        },
        underlyingPrice: usablePrice(fresh.underlyingPrice),
        contractSymbol: contract.symbol,
        contract,
      };
    }
    const chain = await timed(this.logger, 'trading.resolveAndValidate.chain', () =>
      this.getChainValidated(userId, dto.underlying, selection.expiration),
    );
    const expiration = pickExpiration(chain.expirations, selection.expiration);

    if (selection.mode === 'auto_otm') {
      const quote = await timed(this.logger, 'trading.resolveAndValidate.quote', () =>
        this.gateway.getQuote(userId, dto.underlying),
      );
      const contract = resolveAutoOtm(chain.contracts, selection.optionType, quote.last);
      return {
        request: {
          ...dto,
          selection: {
            mode: 'explicit',
            optionType: selection.optionType,
            expiration: contract.expiration,
            strike: contract.strike,
          },
        },
        // The quote that chose the strike is the honest anchor for this fill.
        underlyingPrice: usablePrice(quote.last) ?? usablePrice(chain.underlyingPrice),
        contractSymbol: contract.symbol,
        contract,
      };
    }

    if (typeof selection.strike !== 'number') {
      throw errors.validation('selection.strike is required for explicit option orders');
    }
    const contract = findExplicitOption(chain.contracts, selection.optionType, selection.strike);
    if (!contract) {
      throw errors.validation(
        `No ${selection.optionType} contract at strike ${selection.strike} ` +
          `for ${dto.underlying} expiring ${expiration}`,
      );
    }
    return {
      request: {
        ...dto,
        selection: {
          mode: 'explicit',
          optionType: selection.optionType,
          expiration,
          strike: selection.strike,
        },
      },
      underlyingPrice: usablePrice(chain.underlyingPrice),
      contractSymbol: contract.symbol,
      contract,
    };
  }

  /**
   * Caps an order that closes an existing position at the size actually held.
   *
   * Each client caps sell-to-close in its own trade panel, but that was the only
   * cap there was: a raw API call, the flatten path, or — the case that bites
   * unattended — a chart bracket leg whose size was frozen when the line was
   * drawn. Scale a position down by hand and the stop still carries the original
   * size, so firing it closes what is left and opens a short with the remainder,
   * with nobody watching.
   *
   * Best-effort by design: when the positions read fails we cannot tell an
   * opening order from a closing one, and refusing every order during a broker
   * blip would trade a rare wrong-size fill for a total loss of trading. The
   * residual needs a scale-out AND a positions outage in the same moment.
   *
   * Also returns the held quantity it just read, so `place` can pass it to
   * the gateway and save it from reading positions a second time to decide
   * open vs close intent.
   */
  private async capToPosition(
    userId: string,
    order: OrderRequest,
    contractSymbol: string,
    closeOnly: boolean,
    expectedScope?: BrokerExecutionScope,
  ): Promise<{ order: OrderRequest; heldQuantity: number | undefined }> {
    let held: Position | undefined;
    try {
      held = (await this.gateway.getPositions(userId, expectedScope)).find(
        (position) => position.symbol === contractSymbol,
      );
    } catch (err) {
      if (closeOnly) {
        throw errors.unavailable(
          'POSITIONS_UNAVAILABLE',
          `Could not verify the ${contractSymbol} position — the close-only order was not sent`,
        );
      }
      this.logger.error(
        `could not read positions to size-check ${contractSymbol}; ` +
          `placing ${order.quantity} uncapped: ${(err as Error).message}`,
      );
      return { order, heldQuantity: undefined };
    }
    const heldQuantity = held?.quantity ?? 0;
    if (!held || held.quantity === 0) {
      if (closeOnly) {
        throw errors.conflict(
          'CLOSE_ONLY_NO_POSITION',
          `There is no ${contractSymbol} position left to close`,
        );
      }
      return { order, heldQuantity };
    }

    // Closing means trading against the sign of what is held.
    const closing = order.side === 'sell' ? held.quantity > 0 : held.quantity < 0;
    if (!closing) {
      if (closeOnly) {
        throw errors.conflict(
          'CLOSE_ONLY_WRONG_SIDE',
          `${order.side.toUpperCase()} would increase or reverse the ${contractSymbol} position`,
        );
      }
      return { order, heldQuantity };
    }

    const closable = Math.abs(held.quantity);
    if (order.quantity <= closable) return { order, heldQuantity };
    this.logger.warn(
      `capping ${order.side} ${order.quantity} ${contractSymbol} to ${closable} ` +
        `— that is the whole position`,
    );
    return { order: { ...order, quantity: closable }, heldQuantity };
  }

  /**
   * Fetches a chain, translating gateway "no such expiration" errors into
   * client-facing validation errors (the expiration is client input).
   */
  private async getChainValidated(userId: string, underlying: string, expiration?: string) {
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
