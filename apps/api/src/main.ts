import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AppLogger } from './common/app-logger';
import { setupOpenApi } from './openapi';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: new AppLogger(),
  });

  app.use(helmet());
  app.enableCors();
  app.setGlobalPrefix('v1');
  app.useWebSocketAdapter(new WsAdapter(app));
  setupOpenApi(app);

  const config = app.get(ConfigService);
  const port = config.get<number>('port', 3000);
  await app.listen(port);
}

void bootstrap();
