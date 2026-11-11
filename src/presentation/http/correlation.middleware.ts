import type { NextFunction, Request, Response } from 'express';
import { newId } from '../../domain/shared/id';
import { withLogContext } from '../../infrastructure/observability/logger';

const HEADER = 'x-correlation-id';

/** Propaga (ou cria) o correlationId e abre o contexto de log da requisição. */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(HEADER);
  const correlationId = incoming && /^[\x21-\x7E]{1,200}$/.test(incoming) ? incoming : newId();
  res.setHeader(HEADER, correlationId);
  (req as Request & { correlationId: string }).correlationId = correlationId;
  withLogContext({ correlationId }, () => next());
}

export function correlationIdOf(req: Request): string {
  return (req as Request & { correlationId?: string }).correlationId ?? newId();
}
