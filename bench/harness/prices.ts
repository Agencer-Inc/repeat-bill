import { readFileSync } from 'node:fs'

export interface Price {
  in_per_mtok: number
  out_per_mtok: number
  source: string
  date: string
  note?: string
}

export interface PriceBook {
  unit: string
  models: Record<string, Price>
}

export const DEFAULT_PRICES = new URL('../prices.json', import.meta.url)

export const loadPrices = (file: string | URL = DEFAULT_PRICES): PriceBook => {
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
  const models = (raw as { models?: unknown }).models
  if (typeof models !== 'object' || models === null) {
    throw new Error('prices.json has no models object')
  }
  for (const [model, price] of Object.entries(models as Record<string, Partial<Price>>)) {
    const ok =
      typeof price.in_per_mtok === 'number' &&
      price.in_per_mtok >= 0 &&
      typeof price.out_per_mtok === 'number' &&
      price.out_per_mtok >= 0 &&
      typeof price.source === 'string' &&
      price.source !== '' &&
      typeof price.date === 'string' &&
      price.date !== ''
    if (!ok) {
      throw new Error(`prices.json: ${model} needs in_per_mtok, out_per_mtok, a source and a date`)
    }
  }
  return raw as PriceBook
}

export const priceOf = (book: PriceBook, model: string): Price => {
  const price = Object.hasOwn(book.models, model) ? book.models[model] : undefined
  if (price === undefined) {
    throw new Error(`no price for ${model} in prices.json; add a line for it with its source and date`)
  }
  return price
}

export const costOf = (price: Price, promptTokens: number, completionTokens: number): number =>
  (promptTokens * price.in_per_mtok + completionTokens * price.out_per_mtok) / 1_000_000

export type ServedBy = 'large' | 'small' | 'other'

/** A provider may answer with a dated snapshot of the name asked: `<name>-20250929` or `<name>-2025-09-29`. */
const DATED = /^(\d{8}|\d{4}-\d{2}-\d{2})$/

export const answersAs = (responseModel: string, asked: string): boolean =>
  responseModel === asked ||
  (responseModel.startsWith(`${asked}-`) && DATED.test(responseModel.slice(asked.length + 1)))

/** Which model answered a step, from the `model` its response names. Exact or dated only; never a bare prefix. */
export const servedBy = (responseModel: unknown, large: string, small: string | null): ServedBy => {
  if (typeof responseModel !== 'string') {
    return 'other'
  }
  if (answersAs(responseModel, large)) {
    return 'large'
  }
  return small !== null && answersAs(responseModel, small) ? 'small' : 'other'
}
