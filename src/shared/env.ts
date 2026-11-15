import { z } from 'zod';

/** 启动时校验环境变量，缺配置立即失败而非运行到一半才崩 */
export const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().max(65535).default(3000),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  JWT_SECRET: z.string().min(8).optional(),
  DESKTOP_MODE: z.enum(['demo', 'live']).default('demo'),
});

export type Environment = z.infer<typeof EnvironmentSchema>;

export function loadEnvironment(
  source: Record<string, string | undefined> = process.env,
): Environment {
  const result = EnvironmentSchema.safeParse(source);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || 'env'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${detail}`);
  }
  return result.data;
}
