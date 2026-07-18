import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  OrderPreview,
  OrderResult,
  Position,
  TradeHistory,
} from '@0dtetrader/shared-types';
import { errors } from '../common/api-exception';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../common/current-user.decorator';
import { OrderRequestDto } from './dto/order-request.dto';
import { OrdersService } from './orders.service';
import { TradingService } from './trading.service';

/**
 * Order endpoints carry a stricter rate limit than read routes: 10 requests
 * per minute per user (docs/SECURITY.md §4.3).
 */
@Throttle({ default: { limit: 10, ttl: 60_000 } })
@Controller()
export class TradingController {
  constructor(
    private readonly trading: TradingService,
    private readonly orders: OrdersService,
  ) {}

  /** Declared before the parameterized order routes so /history never matches an id. */
  @Get('orders/history')
  getHistory(@CurrentUser() user: AuthenticatedUser): Promise<TradeHistory> {
    return this.orders.history(user.userId);
  }

  @Post('orders/preview')
  @HttpCode(200)
  preview(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: OrderRequestDto,
  ): Promise<OrderPreview> {
    return this.trading.preview(user.userId, dto);
  }

  @Post('orders')
  @HttpCode(200)
  place(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: OrderRequestDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<OrderResult> {
    if (!idempotencyKey || !idempotencyKey.trim()) {
      throw errors.badRequest(
        'IDEMPOTENCY_KEY_REQUIRED',
        'The Idempotency-Key header is required on POST /v1/orders',
      );
    }
    return this.trading.place(user.userId, dto, idempotencyKey.trim());
  }

  @Get('orders')
  getOpenOrders(@CurrentUser() user: AuthenticatedUser): Promise<OrderResult[]> {
    return this.trading.getOpenOrders(user.userId);
  }

  @Delete('orders/:orderId')
  @HttpCode(204)
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId') orderId: string,
  ): Promise<void> {
    await this.trading.cancel(user.userId, orderId);
  }

  @Get('positions')
  getPositions(@CurrentUser() user: AuthenticatedUser): Promise<Position[]> {
    return this.trading.getPositions(user.userId);
  }
}
