import { LedgerDirection } from '../ledger/wallet-ledger-entry';
import { Money } from '../money/money';
import { InvalidTransactionStateError, ValidationError } from '../shared/domain-error';
import { FailureCode } from './failure-code';

export enum WagerTransactionKind {
  /** Interno: crédito de abertura da wallet. Nunca aceito pela API nem pela fila. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export const EXTERNAL_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

const TERMINAL = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/**
 * Transições válidas. PROCESSED, REJECTED e FAILED são terminais.
 *
 *   PENDING ──────────► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE ─► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (nova tentativa)
 */
const TRANSITIONS: Record<WagerTransactionStatus, readonly WagerTransactionStatus[]> = {
  [WagerTransactionStatus.Pending]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
    WagerTransactionStatus.PendingReference,
  ],
  [WagerTransactionStatus.PendingReference]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
    WagerTransactionStatus.PendingReference,
  ],
  [WagerTransactionStatus.Processed]: [],
  [WagerTransactionStatus.Rejected]: [],
  [WagerTransactionStatus.Failed]: [],
};

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  correlationId: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  /** Saldo observado quando a transação chegou ao estado atual. Base do replay idempotente. */
  resultBalance?: Money;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date;
  updatedAt: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor, não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly correlationId: string,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _updatedAt: Date,
    private _referenceAttempts: number,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _resultBalance?: Money,
    private _nextReferenceAttemptAt?: Date,
  ) {}

  /** Nasce em PENDING. Valida a exigência de referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new ValidationError('OPENING é interno e não pode ser submetido');
    }
    if (!EXTERNAL_KINDS.includes(props.kind)) {
      throw new ValidationError(`kind desconhecido: ${String(props.kind)}`);
    }
    const ref = props.referenceExternalTransactionId;
    const needsRef = props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (needsRef && !ref) {
      throw new ValidationError(`${props.kind} exige referenceExternalTransactionId`);
    }
    if (props.kind === WagerTransactionKind.Bet && ref) {
      throw new ValidationError('BET não aceita referenceExternalTransactionId');
    }
    if (ref && ref === props.externalTransactionId) {
      throw new ValidationError('Uma transação não pode referenciar a si mesma');
    }
    if (props.money.isNegative()) {
      throw new ValidationError('Valor não pode ser negativo');
    }
    // LOSS não move saldo, então aceita zero; as demais exigem valor positivo.
    if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new ValidationError(`${props.kind} exige valor positivo`);
    }
    return WagerTransaction.fromCreate(props);
  }

  /** Transação interna de abertura da wallet. */
  static opening(props: Omit<CreateWagerTransactionProps, 'kind' | 'referenceExternalTransactionId'>): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new ValidationError('OPENING exige valor positivo');
    }
    return WagerTransaction.fromCreate({ ...props, kind: WagerTransactionKind.Opening });
  }

  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id,
      s.providerId,
      s.externalTransactionId,
      s.idempotencyKey,
      s.payloadHash,
      s.walletId,
      s.playerId,
      s.roundId,
      s.gameId,
      s.kind,
      s.money,
      s.referenceExternalTransactionId,
      s.correlationId,
      s.createdAt,
      s.status,
      s.updatedAt,
      s.referenceAttempts,
      s.referenceTransactionId,
      s.failureCode,
      s.processedAt,
      s.resultBalance,
      s.nextReferenceAttemptAt,
    );
  }

  private static fromCreate(p: CreateWagerTransactionProps): WagerTransaction {
    return new WagerTransaction(
      p.id,
      p.providerId,
      p.externalTransactionId,
      p.idempotencyKey,
      p.payloadHash,
      p.walletId,
      p.playerId,
      p.roundId,
      p.gameId,
      p.kind,
      p.money,
      p.referenceExternalTransactionId,
      p.correlationId,
      p.createdAt,
      WagerTransactionStatus.Pending,
      p.createdAt,
      0,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ---- transições

  markProcessed(referenceTransactionId: string | undefined, at: Date, resultBalance: Money): void {
    this.transitionTo(WagerTransactionStatus.Processed, at);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._resultBalance = resultBalance;
    this._nextReferenceAttemptAt = undefined;
  }

  /** Registra mais uma tentativa sem a referência e agenda a próxima. */
  markPendingReference(at: Date, nextAttemptAt: Date, resultBalance: Money): void {
    this.transitionTo(WagerTransactionStatus.PendingReference, at);
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = nextAttemptAt;
    this._resultBalance = resultBalance;
  }

  reject(code: FailureCode, at: Date, resultBalance: Money, referenceTransactionId?: string): void {
    this.transitionTo(WagerTransactionStatus.Rejected, at);
    this._failureCode = code;
    this._processedAt = at;
    this._resultBalance = resultBalance;
    this._referenceTransactionId = referenceTransactionId;
    this._nextReferenceAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.transitionTo(WagerTransactionStatus.Failed, at);
    this._failureCode = code;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento que esta transação produz. ROLLBACK inverte a direção
   * da referência; LOSS não produz lançamento.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionStateError('ROLLBACK precisa da referência para definir a direção');
        }
        const original = reference.ledgerDirectionFor();
        return original === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError('LOSS não produz lançamento');
    }
  }

  private transitionTo(next: WagerTransactionStatus, at: Date): void {
    if (!TRANSITIONS[this._status].includes(next)) {
      throw new InvalidTransactionStateError(
        `Transação ${this.id}: transição inválida ${this._status} -> ${next}`,
      );
    }
    this._status = next;
    this._updatedAt = at;
  }
}
