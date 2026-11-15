import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodTypeAny } from 'zod';

/** 请求校验复用 packages/contracts 的 Zod schema，不手写重复 DTO */
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodTypeAny) {}

  transform(value: unknown) {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const message = result.error.issues
        .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
        .join('; ');
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message });
    }
    return result.data;
  }
}
