import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { ApplicationError, ErrorKind } from '../../application/errors';
import { DomainError, ValidationError } from '../../domain/shared/domain-error';
import { currentLogContext, logger } from '../../infrastructure/observability/logger';
import { PayloadValidationError } from '../contracts';

/**
 * Mapeamento único de erros para HTTP, igual em todos os endpoints:
 *
 *   400 payload inválido (corrigir antes de reenviar)
 *   404 recurso da URL inexistente
 *   409 conflito: Idempotency-Key com outro payload, id externo com outra chave, wallet duplicada
 *   422 rejeição por regra de negócio (transação REJECTED ou wallet do corpo inexistente)
 *   503 falha transitória de infraestrutura (pode reenviar; Retry-After)
 *   500 erro inesperado
 *
 * 201/200/202 vêm do controller (processada / replay / pendente de referência).
 */
const STATUS_BY_KIND: Record<ErrorKind, number> = {
  validation: 400,
  'not-found': 404,
  conflict: 409,
  business: 422,
  transient: 503,
};

@Catch()
export class HttpErrorsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const correlationId = currentLogContext().correlationId;
    const { status, code, message, details } = this.describe(exception);

    if (status === 503) res.setHeader('Retry-After', '1');
    if (status === 503) {
      logger.warn({ code, status }, 'falha transitória, o chamador pode reenviar');
    } else if (status >= 500) {
      logger.error({ code, err: (exception as Error)?.message, stack: (exception as Error)?.stack }, 'erro na requisição');
    } else {
      logger.info({ code, status }, 'requisição recusada');
    }
    res.status(status).json({ error: { code, message, ...(details ? { details } : {}) }, correlationId });
  }

  private describe(e: unknown): { status: number; code: string; message: string; details?: unknown } {
    if (e instanceof PayloadValidationError) {
      return { status: 400, code: e.code, message: 'Payload inválido', details: e.issues };
    }
    if (e instanceof ValidationError) {
      return { status: 400, code: e.code, message: e.message };
    }
    if (e instanceof ApplicationError) {
      return { status: STATUS_BY_KIND[e.kind], code: e.code, message: e.message };
    }
    if (e instanceof DomainError) {
      return { status: 500, code: 'INTERNAL_ERROR', message: 'Erro interno' };
    }
    if (e instanceof HttpException) {
      const status = e.getStatus();
      if (status === 400) return { status, code: 'VALIDATION_ERROR', message: `Corpo inválido: ${e.message}` };
      return { status, code: status === 404 ? 'ROUTE_NOT_FOUND' : 'HTTP_ERROR', message: e.message };
    }
    // Erros do body-parser (JSON malformado, corpo grande demais).
    const raw = e as { status?: number; type?: string; message?: string };
    if (raw?.status && raw.status >= 400 && raw.status < 500) {
      return { status: 400, code: 'VALIDATION_ERROR', message: `Corpo inválido: ${raw.type ?? raw.message}` };
    }
    return { status: 500, code: 'INTERNAL_ERROR', message: 'Erro interno' };
  }
}
