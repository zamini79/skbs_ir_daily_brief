export type InstrumentSeed = {
  category: '국내사' | '해외사' | 'Index'
  displayOrder: number
  name: string
  currency: string
  quoteSource: 'naver-stock' | 'naver-index' | 'twelvedata' | 'marketstack' | 'manual'
  quoteSymbol: string
  newsQuery: string
  /** 관련성 필터용 콤마 구분 별칭 목록. 비우면 파이프라인이 name 하나로 폴백한다. */
  newsAliases?: string
  isIndex?: boolean
  sharesOutstanding?: bigint | null
  priceDivisorForMarketCap?: number
}

export const INSTRUMENTS: InstrumentSeed[] = [
  // 국내사 — 네이버가 시총을 직접 주므로 sharesOutstanding 불필요
  // 종목코드 10건은 https://m.stock.naver.com/api/stock/{code}/basic 대조 완료(2026-08-27), 전부 일치.
  { category: '국내사', displayOrder: 1,  name: 'SK바이오사이언스',  currency: 'KRW', quoteSource: 'naver-stock', quoteSymbol: '302440', newsQuery: 'SK바이오사이언스', newsAliases: 'SK바이오사이언스' },
  { category: '국내사', displayOrder: 2,  name: '삼성바이오로직스',  currency: 'KRW', quoteSource: 'naver-stock', quoteSymbol: '207940', newsQuery: '삼성바이오로직스', newsAliases: '삼성바이오로직스,삼성바이오,삼바' },
  { category: '국내사', displayOrder: 3,  name: '셀트리온',          currency: 'KRW', quoteSource: 'naver-stock', quoteSymbol: '068270', newsQuery: '셀트리온', newsAliases: '셀트리온' },
  { category: '국내사', displayOrder: 4,  name: 'SK바이오팜',        currency: 'KRW', quoteSource: 'naver-stock', quoteSymbol: '326030', newsQuery: 'SK바이오팜', newsAliases: 'SK바이오팜' },
  { category: '국내사', displayOrder: 5,  name: '한미약품',          currency: 'KRW', quoteSource: 'naver-stock', quoteSymbol: '128940', newsQuery: '한미약품', newsAliases: '한미약품' },
  { category: '국내사', displayOrder: 6,  name: '녹십자',            currency: 'KRW', quoteSource: 'naver-stock', quoteSymbol: '006280', newsQuery: 'GC녹십자', newsAliases: '녹십자,GC녹십자' },
  { category: '국내사', displayOrder: 7,  name: '알테오젠',          currency: 'KRW', quoteSource: 'naver-stock', quoteSymbol: '196170', newsQuery: '알테오젠', newsAliases: '알테오젠' },
  { category: '국내사', displayOrder: 8,  name: '리가켐바이오',      currency: 'KRW', quoteSource: 'naver-stock', quoteSymbol: '141080', newsQuery: '리가켐바이오', newsAliases: '리가켐바이오' },
  { category: '국내사', displayOrder: 9,  name: '에이비엘바이오',    currency: 'KRW', quoteSource: 'naver-stock', quoteSymbol: '298380', newsQuery: '에이비엘바이오', newsAliases: '에이비엘바이오' },
  { category: '국내사', displayOrder: 10, name: '유바이오로직스',    currency: 'KRW', quoteSource: 'naver-stock', quoteSymbol: '206650', newsQuery: '유바이오로직스', newsAliases: '유바이오로직스,유바이오' },

  // 해외사 — 미국 5종목은 Twelve Data
  // sharesOutstanding은 샘플 엑셀 종가·시총 역산 근사치(2026-08-27). 분기 실적 발표 후 IR 자료로 갱신할 것(docs/운영.md, Task 15).
  // BigInt(...) 함수 형태를 쓴다: tsconfig.json의 target이 ES2017이라 `123n` 리터럴 문법은 타입 에러(TS2737)가 난다.
  { category: '해외사', displayOrder: 11, name: 'Pfizer',   currency: 'USD', quoteSource: 'twelvedata', quoteSymbol: 'PFE',  newsQuery: '화이자', newsAliases: '화이자,Pfizer', sharesOutstanding: BigInt(5_694_180_000) },
  { category: '해외사', displayOrder: 12, name: 'Merck',    currency: 'USD', quoteSource: 'twelvedata', quoteSymbol: 'MRK',  newsQuery: '머크', newsAliases: '머크,Merck', sharesOutstanding: BigInt(2_464_760_000) },
  { category: '해외사', displayOrder: 13, name: 'Novavax',  currency: 'USD', quoteSource: 'twelvedata', quoteSymbol: 'NVAX', newsQuery: '노바백스', newsAliases: '노바백스,Novavax', sharesOutstanding: BigInt(164_620_000) },
  // Vaxcyte: newsQuery와 newsAliases가 서로 다른 오타였다(박사이트 vs 백사이트) — 별칭이
  // 검색어를 포함하지 않으면 필터가 그 종목 뉴스를 전부 지워버린다. 실측(2026-08-27)으로
  // 박사이트/백사이트/Vaxcyte/백스사이트 네 표기 전부 네이버 뉴스 검색 결과 0건을 확인했다:
  // Vaxcyte는 한국어 언론 보도가 아예 없다. 그래서 "맞는 표기"를 찾는 대신 검색어와
  // 별칭을 영문 표기 하나로 통일한다 — 이 종목 뉴스 칸이 비어 있는 건 버그가 아니다.
  { category: '해외사', displayOrder: 14, name: 'Vaxcyte',  currency: 'USD', quoteSource: 'twelvedata', quoteSymbol: 'PCVX', newsQuery: 'Vaxcyte', newsAliases: 'Vaxcyte', sharesOutstanding: BigInt(148_610_000) },
  { category: '해외사', displayOrder: 15, name: 'Moderna',  currency: 'USD', quoteSource: 'twelvedata', quoteSymbol: 'MRNA', newsQuery: '모더나', newsAliases: '모더나,Moderna', sharesOutstanding: BigInt(398_840_000) },

  // 해외사 — 비미국 4종목은 marketstack. 거래소 약칭 접미사를 쓴다(MIC 접미사는 ADR 값이 온다).
  { category: '해외사', displayOrder: 16, name: 'GSK',    currency: 'GBP', quoteSource: 'marketstack', quoteSymbol: 'GSK.L',   newsQuery: 'GSK', newsAliases: 'GSK,지에스케이', priceDivisorForMarketCap: 100, sharesOutstanding: BigInt(4_046_530_000) },
  { category: '해외사', displayOrder: 17, name: 'Sanofi', currency: 'EUR', quoteSource: 'marketstack', quoteSymbol: 'SAN.PA',  newsQuery: '사노피', newsAliases: '사노피,Sanofi', sharesOutstanding: BigInt(1_191_860_000) },
  { category: '해외사', displayOrder: 18, name: 'Lonza',  currency: 'CHF', quoteSource: 'marketstack', quoteSymbol: 'LONN.SW', newsQuery: '론자', newsAliases: '론자,Lonza', sharesOutstanding: BigInt(70_340_000) },
  { category: '해외사', displayOrder: 19, name: 'Wuxi',   currency: 'HKD', quoteSource: 'marketstack', quoteSymbol: '2269.HK', newsQuery: '우시바이오로직스', newsAliases: '우시바이오로직스,우시바이오,WuXi', sharesOutstanding: BigInt(4_140_750_000) },

  // Index
  // S&P500: newsQuery('뉴욕증시')가 일부러 newsAliases에 없다 — 좁은 검색어로는 기사가
  // 거의 안 잡혀서 넓은 시황 검색어로 기사 풀을 넓힌 뒤 별칭으로 좁힌다. 실측(2026-08-27):
  // '뉴욕증시' 검색 100건을 이 별칭으로 필터링하면 실제로 S&P500 관련 기사가 남는다
  // (예: "S&P500 선물, 엔비디아 실적 호조에 상승…美 국채금리↑"). Vaxcyte류 오타가 아니다.
  { category: 'Index', displayOrder: 20, name: 'S&P500',           currency: 'USD', quoteSource: 'naver-index', quoteSymbol: '.INX',  newsQuery: '뉴욕증시', newsAliases: 'S&P500,S&P 500,스탠더드앤드푸어스', isIndex: true },
  { category: 'Index', displayOrder: 21, name: 'Nasdaq',           currency: 'USD', quoteSource: 'naver-index', quoteSymbol: '.IXIC', newsQuery: '나스닥',   newsAliases: '나스닥,Nasdaq', isIndex: true },
  { category: 'Index', displayOrder: 22, name: 'KOSPI',            currency: 'KRW', quoteSource: 'naver-index', quoteSymbol: 'KOSPI', newsQuery: '코스피',   newsAliases: '코스피,KOSPI', isIndex: true },
  { category: 'Index', displayOrder: 23, name: '코스피200 헬스케어', currency: 'KRW', quoteSource: 'manual',     quoteSymbol: '',      newsQuery: '코스피200 헬스케어', newsAliases: '코스피200 헬스케어,코스피200헬스케어', isIndex: true },
]
