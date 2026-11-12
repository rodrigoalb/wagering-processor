import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const metrics = {
  transactions: new Counter({
    name: 'wagering_transactions_total',
    help: 'Transações por kind, status final e origem',
    labelNames: ['kind', 'status', 'source'] as const,
    registers: [registry],
  }),
  duplicates: new Counter({
    name: 'wagering_duplicates_detected_total',
    help: 'Duplicatas detectadas (replay idempotente, inbox, conflito de payload)',
    labelNames: ['type', 'source'] as const,
    registers: [registry],
  }),
  retries: new Counter({
    name: 'wagering_retries_total',
    help: 'Retries por operação e motivo',
    labelNames: ['operation', 'reason'] as const,
    registers: [registry],
  }),
  lockConflicts: new Counter({
    name: 'wagering_lock_conflicts_total',
    help: 'Conflitos de concorrência (versão, timeout de lock, deadlock, corrida de unique)',
    labelNames: ['reason'] as const,
    registers: [registry],
  }),
  dlqMessages: new Counter({
    name: 'wagering_dlq_messages_total',
    help: 'Mensagens enviadas para a DLQ',
    labelNames: ['reason'] as const,
    registers: [registry],
  }),
  processingLatency: new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'Latência de processamento de uma transação (inclui retries)',
    labelNames: ['source'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  }),
  outboxLag: new Gauge({
    name: 'wagering_outbox_lag_seconds',
    help: 'Idade do evento mais antigo ainda não publicado',
    registers: [registry],
  }),
  reconciliationMismatches: new Counter({
    name: 'wagering_reconciliation_mismatches_total',
    help: 'Divergências entre saldo materializado e ledger',
    registers: [registry],
  }),
};
