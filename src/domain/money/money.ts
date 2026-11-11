import { CurrencyMismatchError, InvalidMoneyError } from '../shared/domain-error';

/** Contrato serializado de dinheiro. `amount` é sempre string decimal com 2 casas. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
const FACTOR = 100n;
/** Cabe em numeric(20,2): até 18 dígitos inteiros. */
const MAX_INTEGER_DIGITS = 18;
/** Sem sinal, sem expoente, sem zeros à esquerda, no máximo 2 casas decimais. */
const AMOUNT_PATTERN = new RegExp(`^(0|[1-9]\\d{0,${MAX_INTEGER_DIGITS - 1}})(\\.\\d{1,${SCALE}})?$`);
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Valor monetário imutável com escala fixa de 2 casas.
 *
 * Internamente o valor é um `bigint` em unidades mínimas (centavos): aritmética
 * inteira é exata, então não existe arredondamento em nenhuma operação. Nunca
 * passa por `number`.
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {}

  /**
   * Constrói a partir de um contrato de entrada. Rejeita NaN, Infinity,
   * notação científica, string vazia, mais de 2 casas e valores negativos.
   */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('Money deve ser um objeto { amount, currency }');
    }
    const { amount, currency } = props;
    Money.assertCurrency(currency);
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('amount deve ser uma string decimal');
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        `amount inválido "${amount}": use decimal não negativo com até ${SCALE} casas, ex.: "25.00"`,
      );
    }
    const [integer, fraction = ''] = amount.split('.');
    const minor = BigInt(integer!) * FACTOR + BigInt(fraction.padEnd(SCALE, '0'));
    return new Money(minor, currency);
  }

  /**
   * Reconstrói a partir de valor já persistido (numeric do PostgreSQL, que
   * chega como string). Aceita sinal negativo porque é reidratação, não entrada.
   */
  static fromPersisted(amount: string, currency: string): Money {
    const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(amount);
    if (!match) {
      throw new InvalidMoneyError(`Valor persistido inválido "${amount}"`);
    }
    Money.assertCurrency(currency);
    const [, sign, integer, fraction = ''] = match;
    const minor = BigInt(integer!) * FACTOR + BigInt(fraction.padEnd(SCALE, '0'));
    return new Money(sign === '-' ? -minor : minor, currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  /** Valor decimal com escala fixa, ex.: "25.00", "-3.50". */
  get amount(): string {
    const negative = this.minorUnits < 0n;
    const abs = negative ? -this.minorUnits : this.minorUnits;
    const integer = abs / FACTOR;
    const fraction = (abs % FACTOR).toString().padStart(SCALE, '0');
    return `${negative ? '-' : ''}${integer}.${fraction}`;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`currency inválida "${String(currency)}": use ISO-4217, ex.: "BRL"`);
    }
  }
}
