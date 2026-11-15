import { ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { DomainError } from '../../domain/ports';

/** 领域异常 → 统一 ApiError 结构，领域层不感知 HTTP */
@Catch(DomainError)
export class DomainErrorFilter implements ExceptionFilter {
  catch(exception: DomainError, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    response.status(exception.status).json({
      code: exception.code,
      message: exception.message,
    });
  }
}
