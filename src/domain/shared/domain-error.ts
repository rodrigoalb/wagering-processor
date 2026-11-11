/**
 * Erros de domínio. Cada um carrega um `code` estável, legível por máquina,
 * que a camada de apresentação traduz para HTTP ou para a decisão de ack/DLQ.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Entrada inválida (formato, escala, valores negativos, campos ausentes). */
export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_ERROR';
}

export class InvalidMoneyError extends ValidationError {}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(expected: string, received: string) {
    super(`Moeda ${received} difere da moeda esperada ${expected}`);
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
}

/**
 * Tentativa de transicionar uma transação já terminal. É erro de programação,
 * nunca caminho de negócio: se acontecer, existe um bug no fluxo.
 */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
}

/** Lançamento de ledger cuja aritmética não fecha. Também é erro de programação. */
export class UnbalancedLedgerEntryError extends DomainError {
  readonly code = 'UNBALANCED_LEDGER_ENTRY';
}
