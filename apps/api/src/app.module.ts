import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import configuration, { validateEnv } from './config/configuration';
import { AppThrottlerGuard } from './common/app-throttler.guard';
import { GlobalExceptionFilter } from './common/global-exception.filter';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { BrokerModule } from './broker/broker.module';
import { CredentialsModule } from './credentials/credentials.module';
import { GexModule } from './gex/gex.module';
import { MarketDataModule } from './market-data/market-data.module';
import { PrismaModule } from './prisma/prisma.module';
import { TradingModule } from './trading/trading.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
      // Works both when started from the repo root and from apps/api.
      envFilePath: ['../../.env', '.env'],
      ignoreEnvFile: process.env.NODE_ENV === 'test',
    }),
    // Default rate limit for all routes: 100 req/min. Order routes override
    // with 10 req/min via @Throttle on TradingController. Throttling is
    // disabled under NODE_ENV=test so e2e flows are not capped.
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 100 }],
      skipIf: () => process.env.NODE_ENV === 'test',
    }),
    PrismaModule,
    AuthModule,
    UsersModule,
    CredentialsModule,
    BrokerModule,
    MarketDataModule,
    TradingModule,
    GexModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        transform: true,
        stopAtFirstError: false,
      }),
    },
  ],
})
export class AppModule {}
