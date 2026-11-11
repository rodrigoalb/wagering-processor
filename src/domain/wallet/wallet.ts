import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { Money } from '../money/money';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  ValidationError,
} from '../shared/domain-error';
import { newId } from '../shared/id';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MovementProps {
  transactionId: string;
  money: Money;
  at: Date;
}

/**
 * Aggregate root da carteira. Toda mudança de saldo passa por `debit` ou
 * `credit`, que devolvem o lançamento correspondente: saldo e ledger nascem
 * juntos e não há como alterar um sem o outro.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money; at: Date }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new ValidationError('Saldo inicial não pode ser negativo');
    }
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.at,
      props.at,
    );
  }

  /** Reconstrução a partir da persistência: não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /**
   * Lançamento de abertura (transação OPENING). Só existe quando a wallet acabou
   * de ser aberta com saldo positivo: antes = 0, depois = saldo inicial, versão 1.
   */
  openingEntry(transactionId: string): WalletLedgerEntry | undefined {
    if (this._version !== 1 || !this._balance.isPositive()) {
      return undefined;
    }
    return WalletLedgerEntry.create({
      id: newId(),
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.Credit,
      money: this._balance,
      balanceBefore: Money.zero(this.currency),
      balanceAfter: this._balance,
      walletVersion: 1,
      createdAt: this.createdAt,
    });
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(props: MovementProps): WalletLedgerEntry {
    this.assertMovement(props.money);
    if (!this.canDebit(props.money)) {
      throw new InsufficientFundsError(`Saldo ${this._balance} insuficiente para debitar ${props.money}`);
    }
    return this.apply(LedgerDirection.Debit, props);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertMovement(props.money);
    return this.apply(LedgerDirection.Credit, props);
  }

  private apply(direction: LedgerDirection, props: MovementProps): WalletLedgerEntry {
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(props.money) : before.subtract(props.money);
    const entry = WalletLedgerEntry.create({
      id: newId(),
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: before,
      balanceAfter: after,
      walletVersion: this._version + 1,
      createdAt: props.at,
    });
    // Só altera o estado depois que o lançamento foi validado.
    this._balance = after;
    this._version += 1;
    this._updatedAt = props.at;
    return entry;
  }

  private assertMovement(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new ValidationError('Movimentação precisa de valor positivo');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
