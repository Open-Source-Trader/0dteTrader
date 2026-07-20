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
  ): Promise<{ status: string; db: string; uptime: number; outboundIp: string }> {
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
    let outboundIp = 'unknown';
    try {
      const resp = await fetch('https://api.ipify.org');
      outboundIp = await resp.text();
    } catch {
      // Best-effort: leave outboundIp as 'unknown' if the lookup fails.
    }
    return { status, db: dbStatus, uptime: process.uptime(), outboundIp };
  }
}
