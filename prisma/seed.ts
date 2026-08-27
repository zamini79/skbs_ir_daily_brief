import { PrismaClient } from '@prisma/client'
import { INSTRUMENTS } from './instruments'

const prisma = new PrismaClient()

async function main() {
  for (const i of INSTRUMENTS) {
    await prisma.instrument.upsert({
      where: { displayOrder: i.displayOrder },
      update: {
        category: i.category,
        name: i.name,
        currency: i.currency,
        quoteSource: i.quoteSource,
        quoteSymbol: i.quoteSymbol,
        newsQuery: i.newsQuery,
        newsAliases: i.newsAliases ?? '',
        isIndex: i.isIndex ?? false,
        sharesOutstanding: i.sharesOutstanding ?? null,
        priceDivisorForMarketCap: i.priceDivisorForMarketCap ?? 1,
      },
      create: {
        category: i.category,
        displayOrder: i.displayOrder,
        name: i.name,
        currency: i.currency,
        quoteSource: i.quoteSource,
        quoteSymbol: i.quoteSymbol,
        newsQuery: i.newsQuery,
        newsAliases: i.newsAliases ?? '',
        isIndex: i.isIndex ?? false,
        sharesOutstanding: i.sharesOutstanding ?? null,
        priceDivisorForMarketCap: i.priceDivisorForMarketCap ?? 1,
      },
    })
  }
  console.log(`seeded ${INSTRUMENTS.length} instruments`)
}

main().finally(() => prisma.$disconnect())
