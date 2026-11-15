import 'reflect-metadata';
import { loadEnvironment } from './shared/env';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DomainErrorFilter } from './interface/http/domain-error.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new DomainErrorFilter());

  // 生产通过 ALLOWED_ORIGINS（逗号分隔）收窄来源；未配置时放开，便于本地联调
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({ origin: allowedOrigins.length > 0 ? allowedOrigins : true });

  const env = loadEnvironment();
  // Render / Fly 等平台通过 PORT 注入监听端口，优先取它
  const port = Number(process.env.PORT ?? env.API_PORT);
  // 容器平台必须监听 0.0.0.0，绑 127.0.0.1 会导致平台探测不到端口
  const host = process.env.HOST ?? '0.0.0.0';
  await app.listen(port, host);
  console.log(`erp-api ready on http://${host}:${port}/api`);
}

void bootstrap();
