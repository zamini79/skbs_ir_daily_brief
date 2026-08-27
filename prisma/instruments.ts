export type InstrumentSeed = {
  category: '국내사' | '해외사' | 'Index'
  displayOrder: number
  name: string
  currency: string
  quoteSource: 'naver-stock' | 'naver-index' | 'twelvedata' | 'marketstack' | 'manual'
  quoteSymbol: string
  newsQuery: string
  isIndex?: boolean
  sharesOutstanding?: bigint | null
  priceDivisorForMarketCap?: number
}

export const INSTRUMENTS: InstrumentSeed[] = [
  // 국내사 — 네이버가 시총을 직접 주므로 sharesOutstanding 불필요
  // 종목코드 10건은 https://m.stock.naver.com/api/stock/{code}/basic 대조 완료(2026-08-27), 전부 일치.
  { category: '국내사', displayOrder: 1,  name: 'SK바이오사이언스',  currency: 'KRW', quoteSource: 'naver-stock', quoteSymbol: '302440', newsQuery: 'SK바이오사이언스' },
  { category: '국내사', displayOrder: 2,  name: '삼성바이오로직스',  currency: 'KRW', quoteSource: 'naver-stock', quoteSymbol: '207940', newsQuery: '삼성바이오로직스' },
  { category: '국내사', displayOrder: 3,  name: '셀트리온',          currency: 'KRW', quoteSource: 'naver-stock', quoteSymbol: '068270', newsQuery: '셀트리온' },
  { category: '국내사', displayOrder: 4,  name: 'SK바이오팜',        currency: 'KRW', quoteSource: 'naver-stock', quoteSymbol: '326030', newsQuery: 'SK바이오팜' },
  { category: '국내사', displayOrder: 5,  name: '한미약품',          currency: 'KRW', quoteSource: 'naver-stock', quoteSymbol: '128940', newsQuery: '한미약품' },
  { category: '국내사', displayOrder: 6,  name: '녹십자',            currency: 'KRW', quoteSource: 'naver-stock', quoteSymbol: '006280', newsQuery: 'GC녹십자' },
  { category: '국내사', displayOrder: 7,  name: '알테오젠',          currency: 'KRW', quoteSource: 'naver-stock', quoteSymbol: '196170', newsQuery: '알테오젠' },
  { category: '국내사', displayOrder: 8,  name: '리가켐바이오',      currency: 'KRW', quoteSource: 'naver-stock', quoteSymbol: '141080', newsQuery: '리가켐바이오' },
  { category: '국내사', displayOrder: 9,  name: '에이비엘바이오',    currency: 'KRW', quoteSource: 'naver-stock', quoteSymbol: '298380', newsQuery: '에이비엘바이오' },
  { category: '국내사', displayOrder: 10, name: '유바이오로직스',    currency: 'KRW', quoteSource: 'naver-stock', quoteSymbol: '206650', newsQuery: '유바이오로직스' },

  // 해외사 — 미국 5종목은 Twelve Data
  // sharesOutstanding은 샘플 엑셀 종가·시총 역산 근사치(2026-08-27). 분기 실적 발표 후 IR 자료로 갱신할 것(docs/운영.md, Task 15).
  // BigInt(...) 함수 형태를 쓴다: tsconfig.json의 target이 ES2017이라 `123n` 리터럴 문법은 타입 에러(TS2737)가 난다.
  { category: '해외사', displayOrder: 11, name: 'Pfizer',   currency: 'USD', quoteSource: 'twelvedata', quoteSymbol: 'PFE',  newsQuery: '화이자', sharesOutstanding: BigInt(5_694_180_000) },
  { category: '해외사', displayOrder: 12, name: 'Merck',    currency: 'USD', quoteSource: 'twelvedata', quoteSymbol: 'MRK',  newsQuery: '머크', sharesOutstanding: BigInt(2_464_760_000) },
  { category: '해외사', displayOrder: 13, name: 'Novavax',  currency: 'USD', quoteSource: 'twelvedata', quoteSymbol: 'NVAX', newsQuery: '노바백스', sharesOutstanding: BigInt(164_620_000) },
  { category: '해외사', displayOrder: 14, name: 'Vaxcyte',  currency: 'USD', quoteSource: 'twelvedata', quoteSymbol: 'PCVX', newsQuery: '박사이트', sharesOutstanding: BigInt(148_610_000) },
  { category: '해외사', displayOrder: 15, name: 'Moderna',  currency: 'USD', quoteSource: 'twelvedata', quoteSymbol: 'MRNA', newsQuery: '모더나', sharesOutstanding: BigInt(398_840_000) },

  // 해외사 — 비미국 4종목은 marketstack. 거래소 약칭 접미사를 쓴다(MIC 접미사는 ADR 값이 온다).
  { category: '해외사', displayOrder: 16, name: 'GSK',    currency: 'GBP', quoteSource: 'marketstack', quoteSymbol: 'GSK.L',   newsQuery: 'GSK', priceDivisorForMarketCap: 100, sharesOutstanding: BigInt(4_046_530_000) },
  { category: '해외사', displayOrder: 17, name: 'Sanofi', currency: 'EUR', quoteSource: 'marketstack', quoteSymbol: 'SAN.PA',  newsQuery: '사노피', sharesOutstanding: BigInt(1_191_860_000) },
  { category: '해외사', displayOrder: 18, name: 'Lonza',  currency: 'CHF', quoteSource: 'marketstack', quoteSymbol: 'LONN.SW', newsQuery: '론자', sharesOutstanding: BigInt(70_340_000) },
  { category: '해외사', displayOrder: 19, name: 'Wuxi',   currency: 'HKD', quoteSource: 'marketstack', quoteSymbol: '2269.HK', newsQuery: '우시바이오로직스', sharesOutstanding: BigInt(4_140_750_000) },

  // Index
  { category: 'Index', displayOrder: 20, name: 'S&P500',           currency: 'USD', quoteSource: 'naver-index', quoteSymbol: '.INX',  newsQuery: '뉴욕증시', isIndex: true },
  { category: 'Index', displayOrder: 21, name: 'Nasdaq',           currency: 'USD', quoteSource: 'naver-index', quoteSymbol: '.IXIC', newsQuery: '나스닥',   isIndex: true },
  { category: 'Index', displayOrder: 22, name: 'KOSPI',            currency: 'KRW', quoteSource: 'naver-index', quoteSymbol: 'KOSPI', newsQuery: '코스피',   isIndex: true },
  { category: 'Index', displayOrder: 23, name: '코스피200 헬스케어', currency: 'KRW', quoteSource: 'manual',     quoteSymbol: '',      newsQuery: '코스피200 헬스케어', isIndex: true },
]
