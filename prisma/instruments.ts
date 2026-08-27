export type InstrumentSeed = {
  category: '국내사' | '해외사' | 'Index'
  displayOrder: number
  name: string
  currency: string
  quoteSource:
    | 'naver-stock' | 'naver-world-stock' | 'naver-index' | 'krx-index'
    | 'lse' | 'six' | 'twelvedata' | 'marketstack' | 'manual'
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

  // 해외사 — 비미국 4종목. **소스가 넷으로 쪼개져 있다. 되돌리지 마라.**
  //
  // 전부 marketstack 이었다. marketstack 무료 플랜은 호출 수가 아니라 **심볼 수**로
  // 세기 때문에(4심볼을 한 요청에 묶어도 4회) 4종목 × 22거래일 = 월 88회였고 한도가
  // 100이다. 마진이 사흘치뿐이라 2026-08-27 에 실제로 소진됐다(운영.md §2.6).
  // 그래서 **매일 도는 시세만** 각 거래소의 무료 엔드포인트로 옮겼다(Task 31).
  // 연 1회짜리 연초 기준가는 네 종목 모두 여전히 marketstack 이다
  // (src/providers/quote/ytdBase.ts 의 MARKETSTACK_YTD_SUFFIX 가 심볼을 되돌려 준다).
  //
  // 사노피만 남긴 이유: 유로넥스트의 ajax 응답이 암호화된 블롭(`ct:`)이라 쓸 수 없고,
  // FT HTML 스크래핑은 동작하지만 파싱이 깨지기 쉽다. 한도 문제가 이미 해결되는데
  // 취약한 의존을 하나 더 만들 이유가 없다. **사노피용 새 소스를 만들지 마라.**
  //
  // **quoteSymbol 표기가 소스마다 다르다.** marketstack 은 거래소 약칭 접미사를 쓰지만
  // (MIC 접미사 `GSK.XLON` 은 뉴욕 ADR 값이 온다) LSE 는 티커 그대로(`GSK`), SIX 는
  // ValorSymbol(`LONN`) 이다. 네이버 홍콩은 marketstack 과 같은 `2269.HK` 다.
  { category: '해외사', displayOrder: 16, name: 'GSK',    currency: 'GBP', quoteSource: 'lse',               quoteSymbol: 'GSK',     newsQuery: 'GSK', newsAliases: 'GSK,지에스케이', priceDivisorForMarketCap: 100, sharesOutstanding: BigInt(4_046_530_000) },
  { category: '해외사', displayOrder: 17, name: 'Sanofi', currency: 'EUR', quoteSource: 'marketstack',       quoteSymbol: 'SAN.PA',  newsQuery: '사노피', newsAliases: '사노피,Sanofi', sharesOutstanding: BigInt(1_191_860_000) },
  { category: '해외사', displayOrder: 18, name: 'Lonza',  currency: 'CHF', quoteSource: 'six',               quoteSymbol: 'LONN',    newsQuery: '론자', newsAliases: '론자,Lonza', sharesOutstanding: BigInt(70_340_000) },
  // 네이버 홍콩은 `2269.HK` 다. 접미사 없는 `GSK`·`SAN` 은 미국 ADR 이라 값이 다르고,
  // `GSK.L`·`SAN.PA`·`LONN.SW` 는 네이버에 아예 없다(실측: HTTP 409 Not Exist Master).
  { category: '해외사', displayOrder: 19, name: 'Wuxi',   currency: 'HKD', quoteSource: 'naver-world-stock', quoteSymbol: '2269.HK', newsQuery: '우시바이오로직스', newsAliases: '우시바이오로직스,우시바이오,WuXi', sharesOutstanding: BigInt(4_140_750_000) },

  // Index
  // S&P500: newsQuery('뉴욕증시')가 일부러 newsAliases에 없다 — 좁은 검색어로는 기사가
  // 거의 안 잡혀서 넓은 시황 검색어로 기사 풀을 넓힌 뒤 별칭으로 좁힌다. 실측(2026-08-27):
  // '뉴욕증시' 검색 100건을 이 별칭으로 필터링하면 실제로 S&P500 관련 기사가 남는다
  // (예: "S&P500 선물, 엔비디아 실적 호조에 상승…美 국채금리↑"). Vaxcyte류 오타가 아니다.
  { category: 'Index', displayOrder: 20, name: 'S&P500',           currency: 'USD', quoteSource: 'naver-index', quoteSymbol: '.INX',  newsQuery: '뉴욕증시', newsAliases: 'S&P500,S&P 500,스탠더드앤드푸어스', isIndex: true },
  { category: 'Index', displayOrder: 21, name: 'Nasdaq',           currency: 'USD', quoteSource: 'naver-index', quoteSymbol: '.IXIC', newsQuery: '나스닥',   newsAliases: '나스닥,Nasdaq', isIndex: true },
  { category: 'Index', displayOrder: 22, name: 'KOSPI',            currency: 'KRW', quoteSource: 'naver-index', quoteSymbol: 'KOSPI', newsQuery: '코스피',   newsAliases: '코스피,KOSPI', isIndex: true },
  // 코스피200 헬스케어: KRX Open API(`data-dbg.krx.co.kr`)로 자동 수집한다(Task 25).
  // quoteSymbol 은 종목코드가 아니라 **KRX 응답의 `IDX_NM` 문자열 그대로**다 —
  // KRX 는 '코스피 200 헬스케어'(코스피와 200 사이 공백 있음)라 쓰고 우리 name 은
  // 원본 브리프 엑셀을 따라 '코스피200 헬스케어'(공백 없음)라 쓴다. 두 표기가 다르므로
  // name 으로 매칭하면 51행 중 아무것도 안 걸린다. 상수는
  // src/providers/quote/krx.ts 의 KRX_IDX_NM_KOSPI200_HEALTHCARE 이고,
  // 이 값과 같은지는 instruments.test.ts 가 지킨다.
  // 시가총액은 응답에 MKTCAP 이 와도 채우지 않는다 — 원본 엑셀이 지수 행의 시총 칸을
  // '-' 로 비우고 다른 지수 3행도 그렇다.
  //
  // **뉴스 검색어만 이 행이 나머지 22행과 규칙이 다르다 — 오타가 아니다.**
  // 다른 행은 그 종목·지수 자신의 이름으로 찾지만, 이 행은 **업종 검색어**를 쓴다.
  //   - '코스피200 헬스케어' 는 실측 0건이다(2026-08-27). 그 표현을 제목에 쓰는
  //     언론이 아예 없어서 이 행의 뉴스 칸이 매일 비어 있었다.
  //   - 원본 샘플 엑셀에는 이 칸에 뉴스가 있었고, 그것은 지수 자체의 뉴스가 아니라
  //     업종 전체에 영향을 주는 뉴스였다:
  //       「美 FDA, 의약품 용기 지침 바뀐다…삼성·셀트리온 시밀러도 영향」
  //     IR 팀은 이 칸을 "헬스케어 업종 동향"으로 쓰고 있었다. KOSPI 행에 시황이
  //     들어가는 것과 같은 성격이다.
  //
  // 검색어 후보 실측 비교(2026-08-27, 같은 별칭 필터 기준):
  //     '제약주'      원본  7건 → 3건 통과. 「한미약품 3.5조 잭팟에 제약株 불붙었다」  업종 단위. 샘플에 가장 가깝다
  //     '바이오 업종' 원본100건 → 업종 수급 위주. 관련은 있으나 초점이 다르다
  //     '제약바이오'  원본100건 → 「대웅제약 mRNA 특허」 등 개별 기업 뉴스가 대부분
  //     '헬스케어'    원본100건 → 「세라젬 BCI」「풀무원헬스케어」. 제약·바이오와 무관. 쓰면 안 된다
  //
  // newsAliases 가 '제약' 하나인 이유: 검색어 '제약주' 를 그대로 별칭에 넣으면
  // 「제약株」(한자)를 못 잡는다. '제약' 은 '제약주'·'제약株'·'제약사' 를 전부 포함하고,
  // 실측에서 통과한 3건이 정확히 이 별칭으로 걸린 것들이다. '제약주'/'제약株' 를
  // 따로 더 넣어도 '제약' 에 이미 포함되어 결과가 한 건도 늘지 않는다(실측 확인).
  // '바이오' 는 일부러 뺐다 — 개별 기업명(에이비엘바이오·리가켐바이오·삼성바이오로직스)에
  // 전부 들어 있어서 업종 행에 개별 종목 뉴스를 끌어온다.
  //
  // **잠정 결정이다. 담당자 인터뷰 후 조정 가능** (스펙 §7 참고).
  { category: 'Index', displayOrder: 23, name: '코스피200 헬스케어', currency: 'KRW', quoteSource: 'krx-index',  quoteSymbol: '코스피 200 헬스케어', newsQuery: '제약주', newsAliases: '제약', isIndex: true },
]
