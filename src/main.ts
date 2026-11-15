import 'reflect-metadata';
import { loadEnvironment } from './shared/env';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DomainErrorFilter } from './interface/http/domain-error.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new DomainErrorFilter());
  const env = loadEnvironment();
  // Render / Fly 等平台通过 PORT 注入监听端口，优先取它
  const port = Number(process.env.PORT ?? env.API_PORT);
  await app.listen(port, '127.0.0.1');
  console.log(`erp-api ready on http://127.0.0.1:${port}/api`);
}

void bootstrap();
