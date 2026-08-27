import type { RawQuote } from '@/domain/types'

export type QuoteFetcher = (symbol: string) => Promise<RawQuote>

export class QuoteError extends Error {
  constructor(public readonly symbol: string, message: string) {
    super(`[${symbol}] ${message}`)
    this.name = 'QuoteError'
  }
}
