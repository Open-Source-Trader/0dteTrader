import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ChartOrder } from '@0dtetrader/shared-types';
import { AuthenticatedUser, CurrentUser } from '../common/current-user.decorator';
import { ChartOrdersService } from './chart-orders.service';
import { CreateChartOrderDto, UpdateChartOrderDto } from './dto/chart-order.dto';

/**
 * Chart order lines. These arm a future order rather than placing one, but they
 * carry the same 10/min limit as the order routes: an armed line is one broker
 * quote per second and one order waiting to happen (docs/SECURITY.md §4.3).
 */
@Throttle({ default: { limit: 10, ttl: 60_000 } })
@Controller('chart-orders')
export class ChartOrdersController {
  constructor(private readonly chartOrders: ChartOrdersService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<ChartOrder[]> {
    return this.chartOrders.list(user.userId);
  }

  @Post()
  @HttpCode(201)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateChartOrderDto,
  ): Promise<ChartOrder> {
    return this.chartOrders.create(user.userId, dto);
  }

  /**
   * The app saw the level cross on its own quote stream and does not want to
   * wait for the watcher's next poll. Idempotent: firing the same line twice
   * (or racing the watcher) yields one broker order.
   */
  @Post(':id/trigger')
  @HttpCode(200)
  trigger(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<ChartOrder> {
    return this.chartOrders.triggerNow(user.userId, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateChartOrderDto,
  ): Promise<ChartOrder> {
    return this.chartOrders.update(user.userId, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    await this.chartOrders.cancel(user.userId, id);
  }
}
