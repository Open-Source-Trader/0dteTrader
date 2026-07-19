import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { Response } from 'express';
import { Public } from '../common/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check(
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ status: string; db: string; uptime: number }> {
    let dbStatus = 'ok';
    try {
      await this.prisma.$queryRawUnsafe('SELECT 1');
    } catch {
      dbStatus = 'error';
    }

    const status = dbStatus === 'ok' ? 'ok' : 'degraded';
    if (dbStatus !== 'ok') {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return { status, db: dbStatus, uptime: process.uptime() };
  }
}
