import { Instrumentation } from '../../application/instrumentation';
import { enrichLogContext, logger } from './logger';
import { metrics } from './metrics';

/** Implementação da porta de observabilidade com pino + prom-client. */
export const prometheusInstrumentation: Instrumentation = {
  transactionSettled(kind, status, source) {
    metrics.transactions.inc({ kind, status, source });
  },
  duplicateDetected(type, source) {
    metrics.duplicates.inc({ type, source });
    logger.info({ duplicateType: type, source }, 'duplicata detectada');
  },
  concurrencyConflict(reason, operation, attempt) {
    metrics.lockConflicts.inc({ reason });
    metrics.retries.inc({ operation, reason });
    logger.warn({ reason, operation, attempt }, 'conflito de concorrência, refazendo');
  },
  referenceExpired(transactionId) {
    logger.warn({ transactionId }, 'referência não chegou dentro do limite de tentativas');
  },
  reconciliationMismatch(walletId, stored, calculated) {
    metrics.reconciliationMismatches.inc();
    // Saldos aparecem aqui de propósito: é um alerta operacional de divergência, não um payload.
    logger.error({ walletId, storedBalance: stored, calculatedBalance: calculated }, 'divergência entre saldo e ledger');
  },
  info: (msg, fields) => logger.info(fields ?? {}, msg),
  warn: (msg, fields) => logger.warn(fields ?? {}, msg),
  error: (msg, fields) => logger.error(fields ?? {}, msg),
  enrich: (fields) => enrichLogContext(fields),
};
