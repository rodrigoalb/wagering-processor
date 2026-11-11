import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../shared/domain-error';
import { Money } from './money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  describe('entrada e escala', () => {
    test.each([
      ['25.00', '25.00'],
      ['25', '25.00'],
      ['25.5', '25.50'],
      ['0', '0.00'],
      ['0.01', '0.01'],
      ['999999999999999999.99', '999999999999999999.99'],
    ])('aceita "%s" e serializa com 2 casas como "%s"', (input, expected) => {
      expect(brl(input).toJSON()).toEqual({ amount: expected, currency: 'BRL' });
    });

    test.each([
      ['', 'string vazia'],
      ['NaN', 'NaN'],
      ['Infinity', 'Infinity'],
      ['-Infinity', '-Infinity'],
      ['1e3', 'notação científica'],
      ['1E-2', 'notação científica com expoente negativo'],
      ['25.001', 'mais de 2 casas'],
      ['-1.00', 'negativo em contrato de entrada'],
      ['-0.00', 'zero negativo'],
      ['+1.00', 'sinal explícito'],
      [' 1.00', 'espaço'],
      ['1,00', 'vírgula decimal'],
      ['01.00', 'zero à esquerda'],
      ['.50', 'sem parte inteira'],
      ['1.', 'ponto sem casas'],
      ['0x10', 'hexadecimal'],
      ['1000000000000000000.00', 'acima de numeric(20,2)'],
    ])('rejeita "%s" (%s)', (input) => {
      expect(() => brl(input)).toThrow(InvalidMoneyError);
    });

    test('rejeita amount que não é string (number nunca entra no domínio)', () => {
      expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: null as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
    });

    test.each(['brl', 'BR', 'BRLL', '', '123'])('rejeita moeda inválida "%s"', (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    });
  });

  describe('aritmética exata, sem arredondamento', () => {
    test('0.10 + 0.20 = 0.30 exatamente (o clássico erro de float não acontece)', () => {
      expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
    });

    test('soma de 1000 centavos dá exatamente 10.00', () => {
      let total = Money.zero('BRL');
      for (let i = 0; i < 1000; i++) total = total.add(brl('0.01'));
      expect(total.amount).toBe('10.00');
    });

    test('valores grandes não perdem precisão', () => {
      expect(brl('999999999999999999.99').subtract(brl('0.01')).amount).toBe('999999999999999999.98');
    });

    test('subtract pode ficar negativo e negate inverte o sinal', () => {
      const r = brl('1.00').subtract(brl('2.50'));
      expect(r.amount).toBe('-1.50');
      expect(r.isNegative()).toBe(true);
      expect(r.negate().amount).toBe('1.50');
    });

    test('é imutável: operações retornam nova instância', () => {
      const a = brl('10.00');
      const b = a.add(brl('5.00'));
      expect(a.amount).toBe('10.00');
      expect(b.amount).toBe('15.00');
      expect(a).not.toBe(b);
    });

    test('predicados', () => {
      expect(Money.zero('BRL').isZero()).toBe(true);
      expect(brl('0.01').isPositive()).toBe(true);
      expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
      expect(brl('1.01').isLessThan(brl('1.00'))).toBe(false);
      expect(brl('1.00').equals(Money.from({ amount: '1.00', currency: 'USD' }))).toBe(false);
    });

    test('toString', () => {
      expect(brl('3.5').toString()).toBe('3.50 BRL');
    });
  });

  describe('moedas', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    test.each([
      ['add', () => brl('1.00').add(usd)],
      ['subtract', () => brl('1.00').subtract(usd)],
      ['isLessThan', () => brl('1.00').isLessThan(usd)],
    ])('%s entre moedas diferentes lança CurrencyMismatchError', (_, op) => {
      expect(op).toThrow(CurrencyMismatchError);
    });
  });

  describe('reidratação', () => {
    test('aceita o formato numeric do PostgreSQL, inclusive negativo', () => {
      expect(Money.fromPersisted('975.00', 'BRL').amount).toBe('975.00');
      expect(Money.fromPersisted('-3.5', 'BRL').amount).toBe('-3.50');
      expect(Money.fromPersisted('0', 'BRL').isZero()).toBe(true);
    });
    test('rejeita lixo vindo do banco', () => {
      expect(() => Money.fromPersisted('abc', 'BRL')).toThrow(InvalidMoneyError);
    });
  });
});
