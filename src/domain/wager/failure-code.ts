/**
 * Taxonomia estável de motivos de rejeição/falha. O provedor decide pela
 * família do código se reenvia, corrige o payload ou desiste (ver ARCHITECTURE.md).
 */
export enum FailureCode {
  // --- saldo
  /** BET sem saldo suficiente. Provedor não deve reenviar a mesma aposta. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** ROLLBACK que deixaria o saldo negativo (o crédito revertido já foi gasto). Exige ação operacional. */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',

  // --- consistência com a wallet
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  PlayerWalletMismatch = 'PLAYER_WALLET_MISMATCH',

  // --- referência (REFUND, ROLLBACK, WIN/LOSS com referência)
  /** Referência nunca chegou dentro da janela de reprocessamento. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Tipo referenciado não pode ser revertido por esta operação (ex.: REFUND de WIN). */
  ReferenceInvalidKind = 'REFERENCE_INVALID_KIND',
  /** Referência de outro player, wallet, moeda ou rodada. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** Referência existe mas terminou REJECTED ou FAILED. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Referência já revertida por um REFUND ou ROLLBACK anterior. */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  /** Reversão com valor diferente da referência (reversão parcial está fora de escopo). */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',

  // --- infraestrutura
  /** Erro permanente inesperado durante o reprocessamento (status FAILED). */
  InternalError = 'INTERNAL_ERROR',
}
