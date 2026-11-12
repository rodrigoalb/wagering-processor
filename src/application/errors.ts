/**
 * Erros da camada de aplicação. A classificação (`kind`) decide o tratamento
 * na borda: status HTTP na API, ack/retry/DLQ no consumidor SQS.
 */
export type ErrorKind =
  | 'validation' // payload inválido: corrigir antes de reenviar
  | 'conflict' // idempotência ou unicidade violada: não reenviar
  | 'not-found'
  | 'business' // regra de negócio sem transação persistida (ex.: wallet inexistente)
  | 'transient'; // infraestrutura indisponível: reenviar com backoff

export abstract class ApplicationError extends Error {
  abstract readonly kind: ErrorKind;
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class IdempotencyConflictError extends ApplicationError {
  readonly kind = 'conflict';
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT';
  constructor(key: string, detail = 'já foi usada com outro payload') {
    super(`Idempotency-Key "${key}" ${detail}`);
  }
}

/**
 * O mesmo messageId chegou de novo com conteúdo diferente. Não é redelivery:
 * é erro do produtor, e repetir não resolve (vai para a DLQ).
 */
export class MessageIdReuseError extends ApplicationError {
  readonly kind = 'validation';
  readonly code = 'MESSAGE_ID_REUSED';
  constructor(messageId: string) {
    super(`messageId "${messageId}" já foi processado com outro conteúdo`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly kind = 'conflict';
  readonly code = 'WALLET_ALREADY_EXISTS';
  constructor(playerId: string, currency: string) {
    super(`Já existe wallet ${currency} para o player ${playerId}`);
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly kind: ErrorKind;
  readonly code = 'WALLET_NOT_FOUND';
  /** `business` quando a wallet vem no corpo de uma submissão; `not-found` quando está na URL. */
  constructor(walletId: string, kind: 'business' | 'not-found' = 'not-found') {
    super(`Wallet ${walletId} não encontrada`);
    this.kind = kind;
  }
}

export class TransactionNotFoundError extends ApplicationError {
  readonly kind = 'not-found';
  readonly code = 'TRANSACTION_NOT_FOUND';
  constructor(id: string) {
    super(`Transação ${id} não encontrada`);
  }
}

export class InvalidCursorError extends ApplicationError {
  readonly kind = 'validation';
  readonly code = 'INVALID_CURSOR';
  constructor() {
    super('Cursor inválido');
  }
}

export type ConflictReason = 'version' | 'unique-violation' | 'deadlock' | 'serialization' | 'lock-timeout';

/**
 * Disputa de concorrência (versão alterada, corrida de inserção, deadlock,
 * timeout de lock). Refazer a unidade de trabalho resolve; se o retry
 * limitado se esgotar, vira falha transitória para o chamador.
 */
export class ConcurrencyConflictError extends ApplicationError {
  readonly kind = 'transient';
  readonly code = 'CONCURRENCY_CONFLICT';
  constructor(
    message: string,
    readonly reason: ConflictReason = 'version',
  ) {
    super(message);
  }
}

/** Banco ou fila indisponível, timeout de lock, deadlock. */
export class TransientInfrastructureError extends ApplicationError {
  readonly kind = 'transient';
  readonly code = 'TRANSIENT_FAILURE';
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}
