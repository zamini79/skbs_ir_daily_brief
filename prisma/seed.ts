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
        // 폴백 설정은 **없으면 반드시 null 로 덮는다.** `?? undefined` 로 두면 update
        // 에서 그 필드가 통째로 빠져, 시드에서 폴백을 뺀 종목이 DB 에는 계속 남는다.
        quoteFallbackSource: i.quoteFallbackSource ?? null,
        quoteFallbackSymbol: i.quoteFallbackSymbol ?? null,
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
        quoteFallbackSource: i.quoteFallbackSource ?? null,
        quoteFallbackSymbol: i.quoteFallbackSymbol ?? null,
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
