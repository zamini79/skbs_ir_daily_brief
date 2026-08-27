# IR Daily Brief 자동화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 평일 07:40 KST에 23행 분량의 주가·시총·뉴스요약을 자동 수집하고, IR 담당자가 08:00 출근 후 뉴스와 요약문을 골라 확정할 수 있는 검수 화면을 제공한다.

**Architecture:** 변할 것으로 아는 외부 소스(시세 3종·뉴스·요약·환율)를 전부 Provider 인터페이스 뒤에 격리하고, 순수 계산은 `domain/`에 두어 네트워크·DB와 분리한다. 수집은 코드 내 스케줄러가 아니라 공유 시크릿으로 보호된 HTTP 엔드포인트로만 기동해, Vercel Cron과 사내 crontab이 동일한 진입점을 쓰게 한다.

**Tech Stack:** Next.js 15 (App Router) · TypeScript · Prisma · PostgreSQL(Supabase) · Vitest · Tailwind CSS

**Spec:** `docs/superpowers/specs/2026-08-27-ir-daily-brief-design.md`

## Global Constraints

- **DB 이식성**: Prisma 스키마는 PostgreSQL/MySQL 공통 타입만 사용한다. ID는 `String @id @default(cuid())`, enum 금지(문자열 + 앱 레벨 검증), 긴 문자열은 `@db.Text`.
- **Supabase 고유 기능 금지**: RLS·Realtime·Storage·Auth SDK를 쓰지 않는다. 접속은 `DATABASE_URL` 하나로만 한다.
- **스케줄러를 코드에 넣지 않는다**: 수집 진입점은 `POST /api/cron/collect` 하나뿐이다.
- **요약 길이**: 공백 포함 100자 이내. 검증은 반드시 `[...text].length` (코드포인트 기준). `String.length` 사용 금지.
- **Gemini 모델**: `gemini-3.6-flash` 고정. `gemini-2.5-flash`는 신규 사용자에게 404다.
- **Gemini 응답 파싱**: `parts[0].text`를 쓰지 않는다. `thought`가 아닌 text 파트를 골라야 한다.
- **런던 펜스 보정**: `GSK.L`은 GBX인데 `price_currency`가 `GBP`로 온다. 시총 계산 시에만 100으로 나눈다. 표시 가격은 펜스 그대로.
- **시각 기준**: 모든 날짜 판정은 `Asia/Seoul`. DB 저장은 UTC.
- **뉴스 검색 범위**: 실행 당일과 D-1. 시세 기준일(직전 영업일)과 다를 수 있다.

### 환경변수

```
DATABASE_URL=postgresql://...
CRON_SECRET=<임의 문자열>
TWELVEDATA_API_KEY=<발급됨>
MARKETSTACK_API_KEY=<발급됨>
GEMINI_API_KEY=<발급됨>
NAVER_CLIENT_ID=<필요>
NAVER_CLIENT_SECRET=<필요>
```

---

### Task 1: 프로젝트 스캐폴딩과 테스트 러너

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `.gitignore`, `.env.example`
- Create: `src/app/layout.tsx`, `src/app/page.tsx`
- Test: `src/domain/__tests__/smoke.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `npm test`(vitest), `npm run dev`(next dev), `npm run build`

- [ ] **Step 1: Next.js 프로젝트 생성**

```bash
cd /Users/zamini/Project/ir_daily_brief
npx create-next-app@latest . --typescript --tailwind --app --src-dir --no-eslint --import-alias "@/*" --use-npm --yes
```

기존 `docs/`, `.env.local`은 유지된다. 덮어쓰기 프롬프트가 뜨면 유지를 선택한다.

- [ ] **Step 2: Vitest 설치**

```bash
npm i -D vitest @vitest/coverage-v8
```

- [ ] **Step 3: `vitest.config.ts` 작성**

```ts
import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
})
```

- [ ] **Step 4: `package.json`에 test 스크립트 추가**

```json
"scripts": {
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "test": "vitest run",
  "test:watch": "vitest"
}
```

- [ ] **Step 5: 스모크 테스트 작성**

`src/domain/__tests__/smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

describe('test runner', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 6: 테스트 실행**

Run: `npm test`
Expected: PASS 1 test

- [ ] **Step 7: `.env.example` 작성**

```
DATABASE_URL=
CRON_SECRET=
TWELVEDATA_API_KEY=
MARKETSTACK_API_KEY=
GEMINI_API_KEY=
NAVER_CLIENT_ID=
NAVER_CLIENT_SECRET=
```

- [ ] **Step 8: `.gitignore`에 `.env.local` 포함 확인 후 커밋**

```bash
grep -q '.env' .gitignore || echo '.env*.local' >> .gitignore
git init 2>/dev/null; git add -A
git commit -m "chore: scaffold Next.js + Vitest"
```

---

### Task 2: 문자 길이와 날짜 유틸

**Files:**
- Create: `src/domain/text.ts`
- Create: `src/domain/date.ts`
- Test: `src/domain/text.test.ts`, `src/domain/date.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `charLength(text: string): number` — 코드포인트 기준 길이
  - `truncateAtSentence(text: string, max: number): string`
  - `kstDateString(d: Date): string` — `YYYY-MM-DD`
  - `kstTodayAndYesterday(now: Date): { today: string; yesterday: string }`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/domain/text.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { charLength, truncateAtSentence } from './text'

describe('charLength', () => {
  it('한글을 코드포인트로 센다', () => {
    expect(charLength('셀트리온')).toBe(4)
  })
  it('공백을 포함해 센다', () => {
    expect(charLength('가 나')).toBe(3)
  })
  it('서로게이트 페어를 1자로 센다', () => {
    // String.length 는 2 를 반환한다. 이 테스트가 그 차이를 고정한다.
    expect(charLength('𝕏')).toBe(1)
    expect('𝕏'.length).toBe(2)
  })
})

describe('truncateAtSentence', () => {
  it('한도 이내면 그대로 둔다', () => {
    expect(truncateAtSentence('짧은 문장임', 100)).toBe('짧은 문장임')
  })
  it('한도를 넘으면 마지막 문장 경계에서 자른다', () => {
    const t = '첫 문장임. 두 번째 문장임. 세 번째 문장임.'
    expect(truncateAtSentence(t, 14)).toBe('첫 문장임.')
  })
  it('문장 경계가 없으면 한도에서 자른다', () => {
    expect(truncateAtSentence('가나다라마바사', 3)).toBe('가나다')
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- src/domain/text.test.ts`
Expected: FAIL — `Cannot find module './text'`

- [ ] **Step 3: 구현**

`src/domain/text.ts`:

```ts
/** 코드포인트 기준 길이. 한글·이모지 안전. String.length 를 쓰면 안 된다. */
export function charLength(text: string): number {
  return [...text].length
}

/** max 를 넘으면 마지막 문장 경계에서 자른다. 경계가 없으면 max 에서 자른다. */
export function truncateAtSentence(text: string, max: number): string {
  if (charLength(text) <= max) return text
  const chars = [...text]
  const head = chars.slice(0, max).join('')
  const lastStop = Math.max(head.lastIndexOf('.'), head.lastIndexOf('。'))
  if (lastStop > 0) return head.slice(0, lastStop + 1)
  return head
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- src/domain/text.test.ts`
Expected: PASS 6 tests

- [ ] **Step 5: 날짜 테스트 작성**

`src/domain/date.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { kstDateString, kstTodayAndYesterday } from './date'

describe('kstDateString', () => {
  it('UTC 자정 직후를 KST 같은 날로 넘긴다', () => {
    // 2026-08-26T22:40Z = KST 2026-08-27 07:40 (수집 시각)
    expect(kstDateString(new Date('2026-08-26T22:40:00Z'))).toBe('2026-08-27')
  })
  it('UTC 오전을 KST 같은 날로 본다', () => {
    expect(kstDateString(new Date('2026-08-27T03:00:00Z'))).toBe('2026-08-27')
  })
})

describe('kstTodayAndYesterday', () => {
  it('당일과 전일을 준다', () => {
    const r = kstTodayAndYesterday(new Date('2026-08-26T22:40:00Z'))
    expect(r).toEqual({ today: '2026-08-27', yesterday: '2026-08-26' })
  })
  it('월초 경계를 넘긴다', () => {
    const r = kstTodayAndYesterday(new Date('2026-08-31T22:40:00Z'))
    expect(r).toEqual({ today: '2026-09-01', yesterday: '2026-08-31' })
  })
})
```

- [ ] **Step 6: 실패 확인**

Run: `npm test -- src/domain/date.test.ts`
Expected: FAIL — `Cannot find module './date'`

- [ ] **Step 7: 구현**

`src/domain/date.ts`:

```ts
const KST = 'Asia/Seoul'

/** Asia/Seoul 기준 YYYY-MM-DD */
export function kstDateString(d: Date): string {
  // en-CA 로케일은 YYYY-MM-DD 를 준다.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: KST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

/** 뉴스 검색 범위: KST 기준 당일과 전일 */
export function kstTodayAndYesterday(now: Date): { today: string; yesterday: string } {
  const today = kstDateString(now)
  const yesterday = kstDateString(new Date(now.getTime() - 24 * 60 * 60 * 1000))
  return { today, yesterday }
}
```

- [ ] **Step 8: 통과 확인**

Run: `npm test -- src/domain/date.test.ts`
Expected: PASS 4 tests

- [ ] **Step 9: 커밋**

```bash
git add src/domain
git commit -m "feat: add codepoint-safe text and KST date utilities"
```

---

### Task 3: 시세 계산과 표시 포맷

**Files:**
- Create: `src/domain/types.ts`
- Create: `src/domain/calc.ts`
- Create: `src/domain/format.ts`
- Test: `src/domain/calc.test.ts`, `src/domain/format.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `type RawQuote = { close: number; prevClose: number; currency: string; asOf: string }`
  - `changePct(close, prevClose): number`
  - `ytdPct(close, yearOpen): number`
  - `marketCapKrwTrillion(args): number`
  - `formatPrice(close, currency, isIndex): string`
  - `formatPrevDiff(close, prevClose): string`

- [ ] **Step 1: 계산 테스트 작성**

`src/domain/calc.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { changePct, ytdPct, marketCapKrwTrillion } from './calc'

describe('changePct', () => {
  it('샘플의 SK바이오사이언스를 재현한다', () => {
    // 37,550 / 전일 38,300 => -0.0196
    expect(changePct(37550, 38300)).toBeCloseTo(-0.0196, 4)
  })
  it('전일가가 0이면 0을 준다', () => {
    expect(changePct(100, 0)).toBe(0)
  })
})

describe('ytdPct', () => {
  it('연초 대비 상승을 계산한다', () => {
    expect(ytdPct(110, 100)).toBeCloseTo(0.1, 6)
  })
  it('연초가가 0이면 0을 준다', () => {
    expect(ytdPct(110, 0)).toBe(0)
  })
})

describe('marketCapKrwTrillion', () => {
  it('원화 종목은 환율 1로 조원을 만든다', () => {
    // 1,585,000원 * 46,290,000주 = 73.4조
    const v = marketCapKrwTrillion({
      close: 1_585_000, shares: 46_290_000, fxToKrw: 1, priceDivisor: 1,
    })
    expect(v).toBeCloseTo(73.37, 1)
  })

  it('런던 펜스 종목은 100으로 나눈다', () => {
    // GSK 1,890.5 GBX = £18.905, 40억주, GBP/KRW 1885.7
    const v = marketCapKrwTrillion({
      close: 1890.5, shares: 4_000_000_000, fxToKrw: 1885.7, priceDivisor: 100,
    })
    expect(v).toBeGreaterThan(130)
    expect(v).toBeLessThan(155)
  })

  it('보정을 빠뜨리면 100배가 된다는 것을 고정한다', () => {
    const wrong = marketCapKrwTrillion({
      close: 1890.5, shares: 4_000_000_000, fxToKrw: 1885.7, priceDivisor: 1,
    })
    const right = marketCapKrwTrillion({
      close: 1890.5, shares: 4_000_000_000, fxToKrw: 1885.7, priceDivisor: 100,
    })
    expect(wrong / right).toBeCloseTo(100, 6)
  })

  it('주식수가 없으면 null 을 준다', () => {
    const v = marketCapKrwTrillion({
      close: 100, shares: null, fxToKrw: 1, priceDivisor: 1,
    })
    expect(v).toBeNull()
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- src/domain/calc.test.ts`
Expected: FAIL — `Cannot find module './calc'`

- [ ] **Step 3: 타입과 계산 구현**

`src/domain/types.ts`:

```ts
export type Category = '국내사' | '해외사' | 'Index'
export type QuoteSource = 'naver-stock' | 'naver-index' | 'twelvedata' | 'marketstack' | 'manual'
export type Decision = 'PENDING' | 'SELECTED' | 'OMITTED'

export type RawQuote = {
  close: number
  prevClose: number
  currency: string
  /** 소스가 알려준 시세 기준일 YYYY-MM-DD. 소스마다 다를 수 있다. */
  asOf: string
  /** 소스가 시총을 직접 준 경우에만 채운다(네이버 국내주식). 단위: 조원 */
  marketCapKrwTrillion?: number
}
```

`src/domain/calc.ts`:

```ts
export function changePct(close: number, prevClose: number): number {
  if (!prevClose) return 0
  return (close - prevClose) / prevClose
}

export function ytdPct(close: number, yearOpen: number): number {
  if (!yearOpen) return 0
  return (close - yearOpen) / yearOpen
}

export function marketCapKrwTrillion(args: {
  close: number
  shares: number | null
  fxToKrw: number
  /** 런던 펜스 호가 보정. GSK=100, 그 외=1 */
  priceDivisor: number
}): number | null {
  const { close, shares, fxToKrw, priceDivisor } = args
  if (shares === null || shares <= 0) return null
  const unitPrice = close / priceDivisor
  return (unitPrice * shares * fxToKrw) / 1e12
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- src/domain/calc.test.ts`
Expected: PASS 7 tests

- [ ] **Step 5: 포맷 테스트 작성**

`src/domain/format.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { formatPrice, formatPrevDiff } from './format'

describe('formatPrice', () => {
  it('국내 종목을 샘플처럼 만든다', () => {
    expect(formatPrice(37550, 'KRW', false)).toBe('KRW 37,550')
  })
  it('미국 종목은 소수 둘째 자리까지 만든다', () => {
    expect(formatPrice(28.57, 'USD', false)).toBe('USD 28.57')
  })
  it('런던 펜스는 표시상 그대로 둔다', () => {
    expect(formatPrice(1905.5, 'GBP', false)).toBe('GBP 1,905.5')
  })
  it('지수는 통화 없이 숫자만 만든다', () => {
    expect(formatPrice(7677.28, 'USD', true)).toBe('7,677.28')
  })
})

describe('formatPrevDiff', () => {
  it('상승은 ▲ 를 붙인다', () => {
    expect(formatPrevDiff(1597000, 1585000)).toBe('▲ 12,000')
  })
  it('하락은 ▼ 를 붙이고 절대값을 쓴다', () => {
    expect(formatPrevDiff(37550, 38300)).toBe('▼ 750')
  })
  it('보합은 - 를 준다', () => {
    expect(formatPrevDiff(100, 100)).toBe('-')
  })
  it('소수 차이를 유지한다', () => {
    expect(formatPrevDiff(28.57, 27.97)).toBe('▲ 0.6')
  })
})
```

- [ ] **Step 6: 실패 확인**

Run: `npm test -- src/domain/format.test.ts`
Expected: FAIL — `Cannot find module './format'`

- [ ] **Step 7: 구현**

`src/domain/format.ts`:

```ts
/** 부동소수 오차를 없애고 유효 소수만 남긴다. 1905.5 -> "1,905.5" */
function numberToDisplay(n: number): string {
  const rounded = Math.round(n * 1e6) / 1e6
  return rounded.toLocaleString('en-US', { maximumFractionDigits: 6 })
}

export function formatPrice(close: number, currency: string, isIndex: boolean): string {
  if (isIndex) return numberToDisplay(close)
  return `${currency} ${numberToDisplay(close)}`
}

export function formatPrevDiff(close: number, prevClose: number): string {
  const diff = Math.round((close - prevClose) * 1e6) / 1e6
  if (diff === 0) return '-'
  const mark = diff > 0 ? '▲' : '▼'
  return `${mark} ${numberToDisplay(Math.abs(diff))}`
}
```

- [ ] **Step 8: 통과 확인**

Run: `npm test -- src/domain/format.test.ts`
Expected: PASS 8 tests

- [ ] **Step 9: 커밋**

```bash
git add src/domain
git commit -m "feat: add quote calculations and display formatting"
```

---

### Task 4: Prisma 스키마와 고정 종목 시드

**Files:**
- Create: `prisma/schema.prisma`, `prisma/seed.ts`, `prisma/instruments.ts`
- Create: `src/db/client.ts`
- Test: `prisma/instruments.test.ts`

**Interfaces:**
- Consumes: `Category`, `QuoteSource` (Task 3)
- Produces:
  - `prisma` 싱글턴 (`@/db/client`)
  - `INSTRUMENTS: InstrumentSeed[]` — 23행 고정 목록
  - 테이블: `Instrument`, `YearOpenPrice`, `BriefRun`, `QuoteSnapshot`, `NewsCandidate`, `NewsSummary`, `Selection`

- [ ] **Step 1: Prisma 설치와 초기화**

```bash
npm i @prisma/client && npm i -D prisma tsx
npx prisma init --datasource-provider postgresql
```

- [ ] **Step 2: 스키마 작성**

`prisma/schema.prisma`. MariaDB 이관 시 `provider`만 `mysql`로 바꾼다. enum·네이티브 확장을 쓰지 않는 이유가 이것이다.

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Instrument {
  id            String  @id @default(cuid())
  category      String  // 국내사 | 해외사 | Index
  displayOrder  Int
  name          String
  currency      String
  quoteSource   String  // naver-stock | naver-index | twelvedata | marketstack | manual
  quoteSymbol   String
  newsQuery     String
  isIndex       Boolean @default(false)

  /// 해외사 시총 계산용. 국내사는 네이버가 시총을 직접 주므로 null.
  sharesOutstanding      BigInt?
  /// 런던 펜스 호가 보정. GSK=100, 그 외=1.
  priceDivisorForMarketCap Int  @default(1)

  quotes     QuoteSnapshot[]
  candidates NewsCandidate[]
  selections Selection[]
  yearOpens  YearOpenPrice[]

  @@unique([displayOrder])
}

model YearOpenPrice {
  id           String     @id @default(cuid())
  instrumentId String
  year         Int
  price        Decimal
  instrument   Instrument @relation(fields: [instrumentId], references: [id])

  @@unique([instrumentId, year])
}

model BriefRun {
  id         String   @id @default(cuid())
  /// 시세 기준일(직전 영업일). 뉴스 기준일과 다를 수 있다.
  tradeDate  String
  /// 실행 당일 KST 날짜. 검수 화면 URL 키.
  runDate    String
  status     String   // COLLECTING | READY | FAILED
  startedAt  DateTime @default(now())
  finishedAt DateTime?

  quotes     QuoteSnapshot[]
  candidates NewsCandidate[]
  selections Selection[]

  @@unique([runDate])
}

model QuoteSnapshot {
  id           String   @id @default(cuid())
  runId        String
  instrumentId String
  close        Decimal?
  prevClose    Decimal?
  changePct    Float?
  ytdPct       Float?
  marketCapKrwTrillion Decimal?
  fxRate       Float?
  /// 소스가 알려준 시세 기준일. 소스마다 다르므로 반드시 저장한다.
  asOf         String?
  sourceName   String
  errorMessage String?  @db.Text
  fetchedAt    DateTime @default(now())

  run        BriefRun   @relation(fields: [runId], references: [id], onDelete: Cascade)
  instrument Instrument @relation(fields: [instrumentId], references: [id])

  @@unique([runId, instrumentId])
}

model NewsCandidate {
  id           String   @id @default(cuid())
  runId        String
  instrumentId String
  rank         Int      // 1..3
  title        String   @db.Text
  url          String   @db.Text
  publisher    String
  publishedAt  DateTime
  /// 같은 사건을 다룬 매체 수. 이 값이 '빈도'다.
  clusterSize  Int

  run        BriefRun      @relation(fields: [runId], references: [id], onDelete: Cascade)
  instrument Instrument    @relation(fields: [instrumentId], references: [id])
  summaries  NewsSummary[]

  @@unique([runId, instrumentId, rank])
}

model NewsSummary {
  id          String @id @default(cuid())
  candidateId String
  variant     Int    // 1=수치 2=배경 3=시사점
  text        String @db.Text

  candidate NewsCandidate @relation(fields: [candidateId], references: [id], onDelete: Cascade)

  @@unique([candidateId, variant])
}

model Selection {
  id           String   @id @default(cuid())
  runId        String
  instrumentId String
  decision     String   @default("PENDING") // PENDING | SELECTED | OMITTED
  chosenCandidateId String?
  chosenSummaryId   String?
  editedText   String?  @db.Text
  /// 코스피200 헬스케어 전용 수기 입력.
  manualClose     Decimal?
  manualPrevClose Decimal?
  updatedAt    DateTime @updatedAt

  run        BriefRun   @relation(fields: [runId], references: [id], onDelete: Cascade)
  instrument Instrument @relation(fields: [instrumentId], references: [id])

  @@unique([runId, instrumentId])
}
```

- [ ] **Step 3: 고정 종목 목록 작성**

`prisma/instruments.ts`. `sharesOutstanding`은 Step 6에서 채운다.

```ts
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
  { category: '해외사', displayOrder: 11, name: 'Pfizer',   currency: 'USD', quoteSource: 'twelvedata', quoteSymbol: 'PFE',  newsQuery: '화이자' },
  { category: '해외사', displayOrder: 12, name: 'Merck',    currency: 'USD', quoteSource: 'twelvedata', quoteSymbol: 'MRK',  newsQuery: '머크' },
  { category: '해외사', displayOrder: 13, name: 'Novavax',  currency: 'USD', quoteSource: 'twelvedata', quoteSymbol: 'NVAX', newsQuery: '노바백스' },
  { category: '해외사', displayOrder: 14, name: 'Vaxcyte',  currency: 'USD', quoteSource: 'twelvedata', quoteSymbol: 'PCVX', newsQuery: '박사이트' },
  { category: '해외사', displayOrder: 15, name: 'Moderna',  currency: 'USD', quoteSource: 'twelvedata', quoteSymbol: 'MRNA', newsQuery: '모더나' },

  // 해외사 — 비미국 4종목은 marketstack. 거래소 약칭 접미사를 쓴다(MIC 접미사는 ADR 값이 온다).
  { category: '해외사', displayOrder: 16, name: 'GSK',    currency: 'GBP', quoteSource: 'marketstack', quoteSymbol: 'GSK.L',   newsQuery: 'GSK', priceDivisorForMarketCap: 100 },
  { category: '해외사', displayOrder: 17, name: 'Sanofi', currency: 'EUR', quoteSource: 'marketstack', quoteSymbol: 'SAN.PA',  newsQuery: '사노피' },
  { category: '해외사', displayOrder: 18, name: 'Lonza',  currency: 'CHF', quoteSource: 'marketstack', quoteSymbol: 'LONN.SW', newsQuery: '론자' },
  { category: '해외사', displayOrder: 19, name: 'Wuxi',   currency: 'HKD', quoteSource: 'marketstack', quoteSymbol: '2269.HK', newsQuery: '우시바이오로직스' },

  // Index
  { category: 'Index', displayOrder: 20, name: 'S&P500',           currency: 'USD', quoteSource: 'naver-index', quoteSymbol: '.INX',  newsQuery: '뉴욕증시', isIndex: true },
  { category: 'Index', displayOrder: 21, name: 'Nasdaq',           currency: 'USD', quoteSource: 'naver-index', quoteSymbol: '.IXIC', newsQuery: '나스닥',   isIndex: true },
  { category: 'Index', displayOrder: 22, name: 'KOSPI',            currency: 'KRW', quoteSource: 'naver-index', quoteSymbol: 'KOSPI', newsQuery: '코스피',   isIndex: true },
  { category: 'Index', displayOrder: 23, name: '코스피200 헬스케어', currency: 'KRW', quoteSource: 'manual',     quoteSymbol: '',      newsQuery: '코스피200 헬스케어', isIndex: true },
]
```

- [ ] **Step 4: 목록 무결성 테스트 작성**

`prisma/instruments.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { INSTRUMENTS } from './instruments'

describe('INSTRUMENTS', () => {
  it('23행이다', () => {
    expect(INSTRUMENTS).toHaveLength(23)
  })
  it('구분별 개수가 샘플과 같다', () => {
    const count = (c: string) => INSTRUMENTS.filter(i => i.category === c).length
    expect(count('국내사')).toBe(10)
    expect(count('해외사')).toBe(9)
    expect(count('Index')).toBe(4)
  })
  it('displayOrder 가 1..23 중복 없이 채워진다', () => {
    const orders = INSTRUMENTS.map(i => i.displayOrder).sort((a, b) => a - b)
    expect(orders).toEqual(Array.from({ length: 23 }, (_, i) => i + 1))
  })
  it('GSK 만 펜스 보정을 갖는다', () => {
    const divisors = INSTRUMENTS.filter(i => (i.priceDivisorForMarketCap ?? 1) !== 1)
    expect(divisors.map(i => i.name)).toEqual(['GSK'])
    expect(divisors[0].priceDivisorForMarketCap).toBe(100)
  })
  it('국내 종목코드는 6자리 숫자다', () => {
    for (const i of INSTRUMENTS.filter(i => i.quoteSource === 'naver-stock')) {
      expect(i.quoteSymbol).toMatch(/^\d{6}$/)
    }
  })
  it('비미국 4종목은 MIC 접미사를 쓰지 않는다', () => {
    for (const i of INSTRUMENTS.filter(i => i.quoteSource === 'marketstack')) {
      expect(i.quoteSymbol).not.toMatch(/\.X[A-Z]{3}$/)
    }
  })
})
```

- [ ] **Step 5: 테스트 실행**

Run: `npm test -- prisma/instruments.test.ts`
Expected: PASS 6 tests

`vitest.config.ts`의 `include`에 `prisma/**/*.test.ts`를 추가해야 한다.

- [ ] **Step 6: 국내 종목코드를 실제 API로 검증**

종목코드는 사람이 옮겨 적은 값이라 틀릴 수 있다. 실제 이름과 대조한다.

```bash
node -e '
const codes = {
  "302440":"SK바이오사이언스","207940":"삼성바이오로직스","068270":"셀트리온",
  "326030":"SK바이오팜","128940":"한미약품","006280":"녹십자",
  "196170":"알테오젠","141080":"리가켐바이오","298380":"에이비엘바이오","206650":"유바이오로직스"
};
(async () => {
  for (const [code, want] of Object.entries(codes)) {
    const r = await fetch(`https://m.stock.naver.com/api/stock/${code}/basic`, {
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://m.stock.naver.com/" },
    });
    const j = await r.json();
    const got = j.stockName ?? j.message;
    console.log(`${code} 기대=${want} 실제=${got} ${got === want ? "OK" : "!! 불일치"}`);
  }
})();
'
```

불일치가 있으면 `prisma/instruments.ts`의 `quoteSymbol`을 실제 값으로 고친다.

- [ ] **Step 7: 해외사 발행주식수 산출**

샘플 엑셀이 종가와 시총을 함께 주므로 역산으로 초깃값을 얻는다.
`shares = 시총(조원) × 1e12 ÷ (종가 ÷ divisor × 환율)`

```bash
node -e '
const fx = { USD: 1383.49, GBP: 1885.7, EUR: 1614.5, CHF: 1721.1, HKD: 176.5 }; // Frankfurter 기준 근사
const rows = [
  ["Pfizer",  "USD", 28.57,   225.07, 1],
  ["Merck",   "USD", 156.45,  533.49, 1],
  ["Novavax", "USD", 9.44,    2.15,   1],
  ["Vaxcyte", "USD", 61.09,   12.56,  1],
  ["Moderna", "USD", 158.83,  87.64,  1],
  ["GSK",     "GBP", 1905.5,  145.4,  100],
  ["Sanofi",  "EUR", 79.74,   153.44, 1],
  ["Lonza",   "CHF", 593.8,   71.89,  1],
  ["Wuxi",    "HKD", 52.2,    38.15,  1],
];
for (const [name, cur, price, capTrillion, div] of rows) {
  const shares = (capTrillion * 1e12) / ((price / div) * fx[cur]);
  console.log(`${name.padEnd(9)} ${Math.round(shares).toLocaleString()}`);
}
'
```

출력값을 `prisma/instruments.ts`의 각 해외사 `sharesOutstanding`에 `BigInt`로 넣는다.
예: `sharesOutstanding: 5_690_000_000n`.

이 값은 근사치다. 분기 실적 발표 후 각사 IR 자료의 발행주식수로 갱신하는 것이
정확하며, `docs/운영.md`에 갱신 절차로 적어둔다(Task 15).

- [ ] **Step 8: 시드 스크립트 작성**

`prisma/seed.ts`:

```ts
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
        isIndex: i.isIndex ?? false,
        sharesOutstanding: i.sharesOutstanding ?? null,
        priceDivisorForMarketCap: i.priceDivisorForMarketCap ?? 1,
      },
    })
  }
  console.log(`seeded ${INSTRUMENTS.length} instruments`)
}

main().finally(() => prisma.$disconnect())
```

`package.json`에 추가:

```json
"prisma": { "seed": "tsx prisma/seed.ts" }
```

- [ ] **Step 9: Prisma 클라이언트 싱글턴 작성**

`src/db/client.ts`. Next.js 개발 서버의 핫리로드에서 커넥션이 새는 것을 막는다.

```ts
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma = globalForPrisma.prisma ?? new PrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
```

- [ ] **Step 10: 마이그레이션과 시드 실행**

Supabase 프로젝트를 만들고 `DATABASE_URL`을 `.env.local`에 넣은 뒤:

```bash
npx prisma migrate dev --name init
npx prisma db seed
```

Expected: `seeded 23 instruments`

- [ ] **Step 11: 커밋**

```bash
git add prisma src/db package.json vitest.config.ts
git commit -m "feat: add portable Prisma schema and 23-instrument seed"
```

---

### Task 5: 환율 Provider

**Files:**
- Create: `src/providers/fx/frankfurter.ts`
- Test: `src/providers/fx/frankfurter.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `fetchFxToKrw(currencies: string[]): Promise<Record<string, number>>`
  — `KRW`는 항상 `1`을 포함한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/providers/fx/frankfurter.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchFxToKrw } from './frankfurter'

afterEach(() => vi.unstubAllGlobals())

function stubFetch(payload: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })))
}

describe('fetchFxToKrw', () => {
  it('USD 기준 응답을 통화별 KRW 환율로 바꾼다', async () => {
    // USD->KRW 1383.49, USD->GBP 0.73368  =>  GBP->KRW = 1383.49/0.73368
    stubFetch({ amount: 1, base: 'USD', date: '2026-08-26', rates: { KRW: 1383.49, GBP: 0.73368 } })
    const fx = await fetchFxToKrw(['USD', 'GBP'])
    expect(fx.USD).toBeCloseTo(1383.49, 2)
    expect(fx.GBP).toBeCloseTo(1885.68, 1)
  })

  it('KRW 는 항상 1이다', async () => {
    stubFetch({ amount: 1, base: 'USD', date: '2026-08-26', rates: { KRW: 1383.49 } })
    const fx = await fetchFxToKrw(['KRW'])
    expect(fx.KRW).toBe(1)
  })

  it('응답에 없는 통화는 결과에서 빠진다', async () => {
    stubFetch({ amount: 1, base: 'USD', date: '2026-08-26', rates: { KRW: 1383.49 } })
    const fx = await fetchFxToKrw(['USD', 'CHF'])
    expect(fx.CHF).toBeUndefined()
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- src/providers/fx/frankfurter.test.ts`
Expected: FAIL — `Cannot find module './frankfurter'`

- [ ] **Step 3: 구현**

`src/providers/fx/frankfurter.ts`:

```ts
const BASE = 'https://api.frankfurter.dev/v1/latest'

/**
 * 각 통화 1단위가 몇 원인지 반환한다.
 * Frankfurter 는 base 통화 1단위당 상대 통화량을 주므로,
 * base=USD 로 한 번만 호출하고 KRW/해당통화 로 나눠 계산한다.
 */
export async function fetchFxToKrw(currencies: string[]): Promise<Record<string, number>> {
  const wanted = [...new Set(currencies)]
  const nonKrw = wanted.filter(c => c !== 'KRW')

  const result: Record<string, number> = {}
  if (wanted.includes('KRW')) result.KRW = 1
  if (nonKrw.length === 0) return result

  const symbols = [...new Set(['KRW', ...nonKrw])].join(',')
  const res = await fetch(`${BASE}?base=USD&symbols=${symbols}`)
  if (!res.ok) throw new Error(`frankfurter ${res.status}`)
  const json = (await res.json()) as { rates: Record<string, number> }

  const usdToKrw = json.rates.KRW
  if (!usdToKrw) throw new Error('frankfurter: KRW rate missing')

  for (const c of nonKrw) {
    if (c === 'USD') {
      result.USD = usdToKrw
      continue
    }
    const usdToC = json.rates[c]
    if (!usdToC) continue
    result[c] = usdToKrw / usdToC
  }
  return result
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- src/providers/fx/frankfurter.test.ts`
Expected: PASS 3 tests

- [ ] **Step 5: 실제 호출로 눈으로 확인**

```bash
npx tsx -e 'import("./src/providers/fx/frankfurter").then(async m => console.log(await m.fetchFxToKrw(["USD","GBP","EUR","CHF","HKD","KRW"])))'
```

Expected: 6개 통화 모두 숫자. `KRW: 1`, `USD`는 1300~1500 사이.

- [ ] **Step 6: 커밋**

```bash
git add src/providers/fx
git commit -m "feat: add Frankfurter FX provider"
```

---

### Task 6: 네이버 시세 Provider (국내주식·국내지수·해외지수)

**Files:**
- Create: `src/providers/quote/types.ts`
- Create: `src/providers/quote/naverParse.ts`
- Create: `src/providers/quote/naver.ts`
- Test: `src/providers/quote/naverParse.test.ts`

**Interfaces:**
- Consumes: `RawQuote` (Task 3)
- Produces:
  - `parseKoreanNumber(s: string): number`
  - `parseMarketValueToTrillion(s: string): number` — `"73조 6,026억"` → `73.6026`
  - `fetchNaverStock(code: string): Promise<RawQuote>`
  - `fetchNaverDomesticIndex(code: string): Promise<RawQuote>`
  - `fetchNaverWorldIndex(code: string): Promise<RawQuote>`

**배경:** 네이버는 한 엔드포인트로 필요한 값을 다 주지 않는다.
`/basic`은 현재가·등락률을 주지만 시가총액이 없고, `/integration`은 전일 종가와
시가총액을 주지만 현재가가 없다. 국내 종목은 둘을 합쳐야 한다.
07:40 실행 시각에는 `marketStatus`가 `CLOSE`라 `closePrice`가 전일 종가다.

- [ ] **Step 1: 파서 테스트 작성**

`src/providers/quote/naverParse.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseKoreanNumber, parseMarketValueToTrillion } from './naverParse'

describe('parseKoreanNumber', () => {
  it('천단위 쉼표를 없앤다', () => {
    expect(parseKoreanNumber('1,592,000')).toBe(1592000)
  })
  it('음수를 읽는다', () => {
    expect(parseKoreanNumber('-7,000')).toBe(-7000)
  })
  it('소수를 읽는다', () => {
    expect(parseKoreanNumber('7,675.70')).toBeCloseTo(7675.7, 4)
  })
  it('빈 값이면 NaN 을 준다', () => {
    expect(Number.isNaN(parseKoreanNumber(''))).toBe(true)
  })
})

describe('parseMarketValueToTrillion', () => {
  it('조와 억이 함께 있으면 합산한다', () => {
    expect(parseMarketValueToTrillion('73조 6,026억')).toBeCloseTo(73.6026, 6)
  })
  it('조만 있으면 그대로 읽는다', () => {
    expect(parseMarketValueToTrillion('44조')).toBeCloseTo(44, 6)
  })
  it('억만 있으면 1조 미만이 된다', () => {
    // 유바이오로직스처럼 소형주는 조 단위가 없다
    expect(parseMarketValueToTrillion('3,300억')).toBeCloseTo(0.33, 6)
  })
  it('읽을 수 없으면 NaN 을 준다', () => {
    expect(Number.isNaN(parseMarketValueToTrillion('N/A'))).toBe(true)
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- src/providers/quote/naverParse.test.ts`
Expected: FAIL — `Cannot find module './naverParse'`

- [ ] **Step 3: 파서 구현**

`src/providers/quote/naverParse.ts`:

```ts
export function parseKoreanNumber(s: string): number {
  if (!s) return NaN
  return Number(s.replace(/,/g, '').trim())
}

/** "73조 6,026억" -> 73.6026 (단위: 조원) */
export function parseMarketValueToTrillion(s: string): number {
  if (!s) return NaN
  const jo = s.match(/([\d,]+)\s*조/)
  const eok = s.match(/([\d,]+)\s*억/)
  if (!jo && !eok) return NaN
  const joVal = jo ? parseKoreanNumber(jo[1]) : 0
  const eokVal = eok ? parseKoreanNumber(eok[1]) : 0
  // 1조 = 10,000억
  return joVal + eokVal / 10_000
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- src/providers/quote/naverParse.test.ts`
Expected: PASS 8 tests

- [ ] **Step 5: Provider 인터페이스 작성**

`src/providers/quote/types.ts`:

```ts
import type { RawQuote } from '@/domain/types'

export type QuoteFetcher = (symbol: string) => Promise<RawQuote>

export class QuoteError extends Error {
  constructor(public readonly symbol: string, message: string) {
    super(`[${symbol}] ${message}`)
    this.name = 'QuoteError'
  }
}
```

- [ ] **Step 6: 네이버 Provider 구현**

`src/providers/quote/naver.ts`:

```ts
import type { RawQuote } from '@/domain/types'
import { QuoteError } from './types'
import { parseKoreanNumber, parseMarketValueToTrillion } from './naverParse'

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  Referer: 'https://m.stock.naver.com/',
}

async function getJson(url: string, symbol: string): Promise<any> {
  const res = await fetch(url, { headers: HEADERS })
  if (!res.ok) throw new QuoteError(symbol, `HTTP ${res.status}`)
  const json = await res.json()
  if (json?.code === 'StockConflict') throw new QuoteError(symbol, json.message ?? 'StockConflict')
  return json
}

/** localTradedAt("2026-08-26T16:39:23-04:00") 에서 날짜만 뽑는다 */
function asOfFrom(localTradedAt: string | undefined): string {
  if (!localTradedAt) return ''
  return localTradedAt.slice(0, 10)
}

/**
 * 국내 개별주. /basic 과 /integration 을 합친다.
 * /basic 에는 시총이 없고 /integration 에는 현재가가 없다.
 */
export async function fetchNaverStock(code: string): Promise<RawQuote> {
  const [basic, integration] = await Promise.all([
    getJson(`https://m.stock.naver.com/api/stock/${code}/basic`, code),
    getJson(`https://m.stock.naver.com/api/stock/${code}/integration`, code),
  ])

  const close = parseKoreanNumber(basic.closePrice)
  if (Number.isNaN(close)) throw new QuoteError(code, 'closePrice 없음')

  const infos: Array<{ code: string; value: string }> = integration.totalInfos ?? []
  const lastClose = infos.find(i => i.code === 'lastClosePrice')?.value
  const marketValue = infos.find(i => i.code === 'marketValue')?.value

  const prevClose = parseKoreanNumber(lastClose ?? '')
  if (Number.isNaN(prevClose)) throw new QuoteError(code, 'lastClosePrice 없음')

  const cap = marketValue ? parseMarketValueToTrillion(marketValue) : NaN

  return {
    close,
    prevClose,
    currency: 'KRW',
    asOf: asOfFrom(basic.localTradedAt),
    marketCapKrwTrillion: Number.isNaN(cap) ? undefined : cap,
  }
}

/** 국내 지수(KOSPI). 전일 종가는 현재가에서 전일대비를 빼서 얻는다. */
export async function fetchNaverDomesticIndex(code: string): Promise<RawQuote> {
  const j = await getJson(`https://m.stock.naver.com/api/index/${code}/basic`, code)
  const close = parseKoreanNumber(j.closePrice)
  const diff = parseKoreanNumber(j.compareToPreviousClosePrice)
  if (Number.isNaN(close) || Number.isNaN(diff)) throw new QuoteError(code, '지수 시세 파싱 실패')
  return {
    close,
    prevClose: close - diff,
    currency: 'KRW',
    asOf: asOfFrom(j.localTradedAt),
  }
}

/** 해외 지수(.INX/.IXIC). stockItemTotalInfos 안에 전일 종가가 있다. */
export async function fetchNaverWorldIndex(code: string): Promise<RawQuote> {
  const j = await getJson(`https://api.stock.naver.com/index/${code}/basic`, code)
  const close = parseKoreanNumber(j.closePrice)
  if (Number.isNaN(close)) throw new QuoteError(code, 'closePrice 없음')

  const infos: Array<{ code: string; value: string }> = j.stockItemTotalInfos ?? []
  const lastClose = parseKoreanNumber(infos.find(i => i.code === 'lastClosePrice')?.value ?? '')
  const diff = parseKoreanNumber(j.compareToPreviousClosePrice)
  const prevClose = Number.isNaN(lastClose) ? close - diff : lastClose
  if (Number.isNaN(prevClose)) throw new QuoteError(code, '전일 종가 파싱 실패')

  return {
    close,
    prevClose,
    currency: 'USD',
    asOf: asOfFrom(j.localTradedAt),
  }
}
```

- [ ] **Step 7: 실제 호출로 확인**

```bash
npx tsx -e '
import("./src/providers/quote/naver").then(async m => {
  console.log("삼바   ", await m.fetchNaverStock("207940"));
  console.log("KOSPI  ", await m.fetchNaverDomesticIndex("KOSPI"));
  console.log("S&P500 ", await m.fetchNaverWorldIndex(".INX"));
})'
```

Expected: 세 줄 모두 `close`, `prevClose`가 숫자이고 삼성바이오로직스는
`marketCapKrwTrillion`이 70 내외다.

- [ ] **Step 8: 커밋**

```bash
git add src/providers/quote
git commit -m "feat: add Naver quote provider for domestic stocks and indices"
```

---

### Task 7: Twelve Data Provider (미국 5종목)

**Files:**
- Create: `src/providers/quote/twelvedata.ts`
- Test: `src/providers/quote/twelvedata.test.ts`

**Interfaces:**
- Consumes: `RawQuote`, `QuoteError` (Task 6)
- Produces: `fetchTwelveDataQuotes(symbols: string[]): Promise<Map<string, RawQuote>>`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/providers/quote/twelvedata.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchTwelveDataQuotes } from './twelvedata'

afterEach(() => vi.unstubAllGlobals())

function stub(payload: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })))
}

describe('fetchTwelveDataQuotes', () => {
  it('단일 심볼 응답을 읽는다', async () => {
    stub({
      symbol: 'PFE', name: 'Pfizer Inc.', close: '28.30000',
      previous_close: '28.57000', currency: 'USD', datetime: '2026-08-26',
    })
    const m = await fetchTwelveDataQuotes(['PFE'])
    expect(m.get('PFE')).toEqual({
      close: 28.3, prevClose: 28.57, currency: 'USD', asOf: '2026-08-26',
    })
  })

  it('복수 심볼 응답을 심볼별로 나눈다', async () => {
    stub({
      PFE: { symbol: 'PFE', close: '28.30', previous_close: '28.57', currency: 'USD', datetime: '2026-08-26' },
      MRK: { symbol: 'MRK', close: '153.10', previous_close: '156.45', currency: 'USD', datetime: '2026-08-26' },
    })
    const m = await fetchTwelveDataQuotes(['PFE', 'MRK'])
    expect(m.size).toBe(2)
    expect(m.get('MRK')?.close).toBeCloseTo(153.1, 4)
  })

  it('심볼별 오류는 그 심볼만 빠뜨리고 나머지를 살린다', async () => {
    stub({
      PFE: { symbol: 'PFE', close: '28.30', previous_close: '28.57', currency: 'USD', datetime: '2026-08-26' },
      WXIBY: { status: 'error', message: 'symbol not found' },
    })
    const m = await fetchTwelveDataQuotes(['PFE', 'WXIBY'])
    expect(m.has('PFE')).toBe(true)
    expect(m.has('WXIBY')).toBe(false)
  })

  it('빈 목록이면 호출하지 않는다', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const m = await fetchTwelveDataQuotes([])
    expect(m.size).toBe(0)
    expect(spy).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- src/providers/quote/twelvedata.test.ts`
Expected: FAIL — `Cannot find module './twelvedata'`

- [ ] **Step 3: 구현**

`src/providers/quote/twelvedata.ts`:

```ts
import type { RawQuote } from '@/domain/types'

type TdQuote = {
  symbol?: string
  close?: string
  previous_close?: string
  currency?: string
  datetime?: string
  status?: string
  message?: string
}

function toRawQuote(q: TdQuote): RawQuote | null {
  if (q.status === 'error') return null
  const close = Number(q.close)
  const prevClose = Number(q.previous_close)
  if (!Number.isFinite(close) || !Number.isFinite(prevClose)) return null
  return {
    close,
    prevClose,
    currency: q.currency ?? 'USD',
    asOf: q.datetime ?? '',
  }
}

/**
 * 미국 종목 전용. 무료 플랜은 비미국 상장을 차단하므로 넣지 말 것.
 * 심볼을 콤마로 묶어 한 번에 호출한다.
 */
export async function fetchTwelveDataQuotes(symbols: string[]): Promise<Map<string, RawQuote>> {
  const out = new Map<string, RawQuote>()
  if (symbols.length === 0) return out

  const key = process.env.TWELVEDATA_API_KEY
  if (!key) throw new Error('TWELVEDATA_API_KEY 없음')

  const url = `https://api.twelvedata.com/quote?symbol=${symbols.join(',')}&apikey=${key}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`twelvedata HTTP ${res.status}`)
  const json = (await res.json()) as Record<string, TdQuote> | TdQuote

  // 심볼이 하나면 객체를 그대로, 여럿이면 심볼을 키로 하는 맵을 준다.
  if (symbols.length === 1) {
    const q = toRawQuote(json as TdQuote)
    if (q) out.set(symbols[0], q)
    return out
  }

  for (const s of symbols) {
    const entry = (json as Record<string, TdQuote>)[s]
    if (!entry) continue
    const q = toRawQuote(entry)
    if (q) out.set(s, q)
  }
  return out
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- src/providers/quote/twelvedata.test.ts`
Expected: PASS 4 tests

- [ ] **Step 5: 실제 호출로 확인**

```bash
npx tsx -e '
process.env.TWELVEDATA_API_KEY = require("fs").readFileSync(".env.local","utf8").match(/TWELVEDATA_API_KEY=(.*)/)[1].trim();
import("./src/providers/quote/twelvedata").then(async m => {
  const r = await m.fetchTwelveDataQuotes(["PFE","MRK","NVAX","PCVX","MRNA"]);
  for (const [k,v] of r) console.log(k, v);
})'
```

Expected: 5종목 모두 출력. 없는 심볼이 있으면 그 줄만 빠진다.

- [ ] **Step 6: 커밋**

```bash
git add src/providers/quote/twelvedata.ts src/providers/quote/twelvedata.test.ts
git commit -m "feat: add Twelve Data provider for US equities"
```

---

### Task 8: marketstack Provider (비미국 4종목)

**Files:**
- Create: `src/providers/quote/marketstack.ts`
- Test: `src/providers/quote/marketstack.test.ts`

**Interfaces:**
- Consumes: `RawQuote`
- Produces:
  - `fetchMarketstackQuotes(symbols: string[]): Promise<Map<string, RawQuote>>`
  - `fetchMarketstackYearOpen(symbols: string[], year: number): Promise<Map<string, number>>`

**배경:** 심볼은 반드시 거래소 약칭 접미사(`.L`/`.PA`/`.SW`/`.HK`)를 쓴다.
MIC 접미사(`GSK.XLON`)는 뉴욕 ADR 가격을 XLON 라벨로 반환하는 것이 실측으로 확인됐다.
`/eod/latest`는 전일 종가를 주지 않으므로 `/eod`로 최근 2거래일을 받아 계산한다.
무료 한도가 월 100회이므로 심볼을 콤마로 묶어 하루 1회만 호출한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/providers/quote/marketstack.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchMarketstackQuotes } from './marketstack'

afterEach(() => vi.unstubAllGlobals())

function stub(payload: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })))
}

describe('fetchMarketstackQuotes', () => {
  it('심볼별 최신 2거래일로 종가와 전일 종가를 만든다', async () => {
    stub({
      data: [
        { symbol: 'GSK.L', close: 1890.5, price_currency: 'GBP', date: '2026-08-25T00:00:00+0000' },
        { symbol: 'GSK.L', close: 1875.0, price_currency: 'GBP', date: '2026-08-24T00:00:00+0000' },
        { symbol: 'SAN.PA', close: 78.74, price_currency: 'EUR', date: '2026-08-26T00:00:00+0000' },
        { symbol: 'SAN.PA', close: 79.10, price_currency: 'EUR', date: '2026-08-25T00:00:00+0000' },
      ],
    })
    const m = await fetchMarketstackQuotes(['GSK.L', 'SAN.PA'])
    expect(m.get('GSK.L')).toEqual({
      close: 1890.5, prevClose: 1875.0, currency: 'GBP', asOf: '2026-08-25',
    })
    expect(m.get('SAN.PA')?.prevClose).toBeCloseTo(79.1, 4)
  })

  it('거래일이 하나뿐이면 그 심볼을 버린다', async () => {
    stub({ data: [{ symbol: 'LONN.SW', close: 593.8, price_currency: 'CHF', date: '2026-08-26T00:00:00+0000' }] })
    const m = await fetchMarketstackQuotes(['LONN.SW'])
    expect(m.has('LONN.SW')).toBe(false)
  })

  it('오류 응답이면 예외를 던진다', async () => {
    stub({ error: { code: 'invalid_access_key', message: 'bad key' } })
    await expect(fetchMarketstackQuotes(['GSK.L'])).rejects.toThrow(/marketstack/)
  })

  it('빈 목록이면 호출하지 않는다', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const m = await fetchMarketstackQuotes([])
    expect(m.size).toBe(0)
    expect(spy).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- src/providers/quote/marketstack.test.ts`
Expected: FAIL — `Cannot find module './marketstack'`

- [ ] **Step 3: 구현**

`src/providers/quote/marketstack.ts`:

```ts
import type { RawQuote } from '@/domain/types'

const BASE = 'https://api.marketstack.com/v2'

type MsRow = { symbol: string; close: number; price_currency?: string; date: string }

function assertOk(json: any) {
  if (json?.error) {
    throw new Error(`marketstack: ${json.error.code ?? ''} ${json.error.message ?? ''}`.trim())
  }
}

function key(): string {
  const k = process.env.MARKETSTACK_API_KEY
  if (!k) throw new Error('MARKETSTACK_API_KEY 없음')
  return k
}

/**
 * 비미국 종목 전용. 심볼은 거래소 약칭 접미사를 써야 한다(GSK.L, SAN.PA, LONN.SW, 2269.HK).
 * MIC 접미사(GSK.XLON)는 뉴욕 ADR 값이 오므로 절대 쓰지 않는다.
 */
export async function fetchMarketstackQuotes(symbols: string[]): Promise<Map<string, RawQuote>> {
  const out = new Map<string, RawQuote>()
  if (symbols.length === 0) return out

  // 종목당 최근 2거래일이 필요하므로 넉넉히 받는다.
  const limit = symbols.length * 6
  const url = `${BASE}/eod?access_key=${key()}&symbols=${symbols.join(',')}&limit=${limit}`
  const res = await fetch(url)
  const json = await res.json()
  assertOk(json)

  const rows: MsRow[] = json.data ?? []
  for (const symbol of symbols) {
    const mine = rows
      .filter(r => r.symbol === symbol)
      .sort((a, b) => b.date.localeCompare(a.date))
    if (mine.length < 2) continue
    out.set(symbol, {
      close: mine[0].close,
      prevClose: mine[1].close,
      currency: mine[0].price_currency ?? '',
      asOf: mine[0].date.slice(0, 10),
    })
  }
  return out
}

/** 연초 기준가. 연 1회만 호출하고 DB에 캐시한다. */
export async function fetchMarketstackYearOpen(
  symbols: string[],
  year: number,
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (symbols.length === 0) return out

  const url =
    `${BASE}/eod?access_key=${key()}&symbols=${symbols.join(',')}` +
    `&date_from=${year}-01-01&date_to=${year}-01-15&limit=${symbols.length * 15}`
  const res = await fetch(url)
  const json = await res.json()
  assertOk(json)

  const rows: MsRow[] = json.data ?? []
  for (const symbol of symbols) {
    const mine = rows
      .filter(r => r.symbol === symbol)
      .sort((a, b) => a.date.localeCompare(b.date))
    if (mine.length === 0) continue
    out.set(symbol, mine[0].close) // 그 해 첫 거래일 종가
  }
  return out
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- src/providers/quote/marketstack.test.ts`
Expected: PASS 4 tests

- [ ] **Step 5: 실제 호출로 확인 (무료 한도 소모에 주의)**

```bash
npx tsx -e '
process.env.MARKETSTACK_API_KEY = require("fs").readFileSync(".env.local","utf8").match(/MARKETSTACK_API_KEY=(.*)/)[1].trim();
import("./src/providers/quote/marketstack").then(async m => {
  const r = await m.fetchMarketstackQuotes(["GSK.L","SAN.PA","LONN.SW","2269.HK"]);
  for (const [k,v] of r) console.log(k, v);
})'
```

Expected: 4종목 모두 출력되고 통화가 각각 GBP/EUR/CHF/HKD다.
GSK가 GBP로 1,800~2,000 범위면 런던 종가가 맞다(50 내외면 ADR이므로 심볼이 잘못된 것).

- [ ] **Step 6: 커밋**

```bash
git add src/providers/quote/marketstack.ts src/providers/quote/marketstack.test.ts
git commit -m "feat: add marketstack provider for non-US equities"
```

---

### Task 9: 시세 라우터와 연초 기준가

**Files:**
- Create: `src/providers/quote/index.ts`
- Test: `src/providers/quote/index.test.ts`

**Interfaces:**
- Consumes: Task 6·7·8의 fetcher 전부
- Produces: `fetchAllQuotes(instruments: QuoteTarget[]): Promise<Map<string, RawQuote | Error>>`
  - `type QuoteTarget = { id: string; quoteSource: string; quoteSymbol: string }`
  - 키는 `instrument.id`. 실패한 종목은 값이 `Error`다(전체를 중단시키지 않는다).

- [ ] **Step 1: 실패하는 테스트 작성**

`src/providers/quote/index.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./naver', () => ({
  fetchNaverStock: vi.fn(async (c: string) => ({ close: 100, prevClose: 90, currency: 'KRW', asOf: '2026-08-26' })),
  fetchNaverDomesticIndex: vi.fn(async () => ({ close: 6800, prevClose: 6700, currency: 'KRW', asOf: '2026-08-26' })),
  fetchNaverWorldIndex: vi.fn(async () => ({ close: 7675, prevClose: 7677, currency: 'USD', asOf: '2026-08-26' })),
}))
vi.mock('./twelvedata', () => ({
  fetchTwelveDataQuotes: vi.fn(async () => new Map([['PFE', { close: 28.3, prevClose: 28.57, currency: 'USD', asOf: '2026-08-26' }]])),
}))
vi.mock('./marketstack', () => ({
  fetchMarketstackQuotes: vi.fn(async () => new Map([['GSK.L', { close: 1890.5, prevClose: 1875, currency: 'GBP', asOf: '2026-08-25' }]])),
  fetchMarketstackYearOpen: vi.fn(async () => new Map()),
}))

import { fetchAllQuotes } from './index'
import { fetchNaverStock } from './naver'

beforeEach(() => vi.clearAllMocks())

describe('fetchAllQuotes', () => {
  it('소스별로 알맞은 fetcher 를 부른다', async () => {
    const r = await fetchAllQuotes([
      { id: 'a', quoteSource: 'naver-stock', quoteSymbol: '207940' },
      { id: 'b', quoteSource: 'twelvedata', quoteSymbol: 'PFE' },
      { id: 'c', quoteSource: 'marketstack', quoteSymbol: 'GSK.L' },
    ])
    expect((r.get('a') as any).close).toBe(100)
    expect((r.get('b') as any).close).toBeCloseTo(28.3, 4)
    expect((r.get('c') as any).close).toBeCloseTo(1890.5, 4)
  })

  it('manual 소스는 결과에 넣지 않는다', async () => {
    const r = await fetchAllQuotes([{ id: 'z', quoteSource: 'manual', quoteSymbol: '' }])
    expect(r.has('z')).toBe(false)
  })

  it('한 종목이 실패해도 나머지를 살린다', async () => {
    vi.mocked(fetchNaverStock).mockRejectedValueOnce(new Error('boom'))
    const r = await fetchAllQuotes([
      { id: 'a', quoteSource: 'naver-stock', quoteSymbol: '207940' },
      { id: 'b', quoteSource: 'twelvedata', quoteSymbol: 'PFE' },
    ])
    expect(r.get('a')).toBeInstanceOf(Error)
    expect((r.get('b') as any).close).toBeCloseTo(28.3, 4)
  })

  it('배치 소스에서 빠진 심볼은 Error 로 남긴다', async () => {
    const r = await fetchAllQuotes([{ id: 'x', quoteSource: 'twelvedata', quoteSymbol: 'NOPE' }])
    expect(r.get('x')).toBeInstanceOf(Error)
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- src/providers/quote/index.test.ts`
Expected: FAIL — `Cannot find module './index'`

- [ ] **Step 3: 구현**

`src/providers/quote/index.ts`:

```ts
import type { RawQuote } from '@/domain/types'
import { fetchNaverStock, fetchNaverDomesticIndex, fetchNaverWorldIndex } from './naver'
import { fetchTwelveDataQuotes } from './twelvedata'
import { fetchMarketstackQuotes } from './marketstack'

export type QuoteTarget = { id: string; quoteSource: string; quoteSymbol: string }

/**
 * 종목별 시세를 모은다. 실패는 그 종목의 값을 Error 로 남기고 전체는 계속 간다.
 * 배치 소스(twelvedata/marketstack)는 한 번에 묶어 호출해 무료 한도를 아낀다.
 */
export async function fetchAllQuotes(
  instruments: QuoteTarget[],
): Promise<Map<string, RawQuote | Error>> {
  const out = new Map<string, RawQuote | Error>()

  const perItem = instruments.filter(i =>
    ['naver-stock', 'naver-index'].includes(i.quoteSource),
  )
  const td = instruments.filter(i => i.quoteSource === 'twelvedata')
  const ms = instruments.filter(i => i.quoteSource === 'marketstack')

  await Promise.all([
    // 개별 호출 소스
    ...perItem.map(async i => {
      try {
        let q: RawQuote
        if (i.quoteSource === 'naver-stock') {
          q = await fetchNaverStock(i.quoteSymbol)
        } else if (i.quoteSymbol.startsWith('.')) {
          q = await fetchNaverWorldIndex(i.quoteSymbol)
        } else {
          q = await fetchNaverDomesticIndex(i.quoteSymbol)
        }
        out.set(i.id, q)
      } catch (e) {
        out.set(i.id, e instanceof Error ? e : new Error(String(e)))
      }
    }),

    // 배치 소스
    (async () => {
      if (td.length === 0) return
      try {
        const m = await fetchTwelveDataQuotes(td.map(i => i.quoteSymbol))
        for (const i of td) {
          const q = m.get(i.quoteSymbol)
          out.set(i.id, q ?? new Error(`twelvedata: ${i.quoteSymbol} 응답 없음`))
        }
      } catch (e) {
        for (const i of td) out.set(i.id, e instanceof Error ? e : new Error(String(e)))
      }
    })(),

    (async () => {
      if (ms.length === 0) return
      try {
        const m = await fetchMarketstackQuotes(ms.map(i => i.quoteSymbol))
        for (const i of ms) {
          const q = m.get(i.quoteSymbol)
          out.set(i.id, q ?? new Error(`marketstack: ${i.quoteSymbol} 응답 없음`))
        }
      } catch (e) {
        for (const i of ms) out.set(i.id, e instanceof Error ? e : new Error(String(e)))
      }
    })(),
  ])

  return out
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- src/providers/quote/index.test.ts`
Expected: PASS 4 tests

- [ ] **Step 5: 커밋**

```bash
git add src/providers/quote/index.ts src/providers/quote/index.test.ts
git commit -m "feat: add quote router with per-instrument failure isolation"
```

---

### Task 10: 네이버 뉴스 검색 Provider

**Files:**
- Create: `src/providers/news/types.ts`
- Create: `src/providers/news/naver.ts`
- Test: `src/providers/news/naver.test.ts`

**Interfaces:**
- Consumes: `kstDateString` (Task 2)
- Produces:
  - `type NewsItem = { title: string; url: string; naverUrl: string | null; publisher: string; publishedAt: Date; description: string }`
  - `stripHtml(s: string): string`
  - `searchNaverNews(query: string, now: Date): Promise<NewsItem[]>` — 당일·D-1만 반환

- [ ] **Step 1: 실패하는 테스트 작성**

`src/providers/news/naver.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { stripHtml, searchNaverNews } from './naver'

afterEach(() => vi.unstubAllGlobals())

function stub(items: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items }), { status: 200 })))
}

describe('stripHtml', () => {
  it('b 태그를 없앤다', () => {
    expect(stripHtml('<b>셀트리온</b>, 매출 증가')).toBe('셀트리온, 매출 증가')
  })
  it('HTML 엔티티를 되돌린다', () => {
    expect(stripHtml('&quot;글로벌 톱3&quot; &amp; 성장')).toBe('"글로벌 톱3" & 성장')
  })
  it('작은따옴표 엔티티를 되돌린다', () => {
    expect(stripHtml('&#39;엑스코프리&#39;')).toBe("'엑스코프리'")
  })
})

describe('searchNaverNews', () => {
  const now = new Date('2026-08-26T22:40:00Z') // KST 2026-08-27 07:40

  it('당일과 D-1 기사만 남긴다', async () => {
    stub([
      { title: '<b>당일</b>', originallink: 'https://a.com/1', link: 'https://n.news.naver.com/1', description: 'd1', pubDate: 'Thu, 27 Aug 2026 06:00:00 +0900' },
      { title: '전일', originallink: 'https://b.com/2', link: 'https://b.com/2', description: 'd2', pubDate: 'Wed, 26 Aug 2026 18:00:00 +0900' },
      { title: '이틀전', originallink: 'https://c.com/3', link: 'https://c.com/3', description: 'd3', pubDate: 'Tue, 25 Aug 2026 18:00:00 +0900' },
    ])
    const r = await searchNaverNews('셀트리온', now)
    expect(r.map(i => i.title)).toEqual(['당일', '전일'])
  })

  it('네이버뉴스 링크를 따로 담는다', async () => {
    stub([
      { title: 'a', originallink: 'https://a.com/1', link: 'https://n.news.naver.com/mnews/article/001/1', description: '', pubDate: 'Thu, 27 Aug 2026 06:00:00 +0900' },
      { title: 'b', originallink: 'https://b.com/2', link: 'https://b.com/2', description: '', pubDate: 'Thu, 27 Aug 2026 06:00:00 +0900' },
    ])
    const r = await searchNaverNews('x', now)
    expect(r[0].naverUrl).toContain('n.news.naver.com')
    expect(r[1].naverUrl).toBeNull()
  })

  it('언론사는 원문 도메인에서 뽑는다', async () => {
    stub([{ title: 'a', originallink: 'https://www.yna.co.kr/view/1', link: 'https://n.news.naver.com/1', description: '', pubDate: 'Thu, 27 Aug 2026 06:00:00 +0900' }])
    const r = await searchNaverNews('x', now)
    expect(r[0].publisher).toBe('yna.co.kr')
  })

  it('기사가 없으면 빈 배열을 준다', async () => {
    stub([])
    expect(await searchNaverNews('x', now)).toEqual([])
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- src/providers/news/naver.test.ts`
Expected: FAIL — `Cannot find module './naver'`

- [ ] **Step 3: 타입 작성**

`src/providers/news/types.ts`:

```ts
export type NewsItem = {
  title: string
  /** 원 언론사 링크 */
  url: string
  /** 네이버뉴스 링크. 본문 크롤링은 이쪽을 우선한다. 없으면 null */
  naverUrl: string | null
  publisher: string
  publishedAt: Date
  /** 검색 API 가 주는 짧은 스니펫. 본문 크롤링 실패 시 요약 입력으로 쓴다. */
  description: string
}
```

- [ ] **Step 4: 구현**

`src/providers/news/naver.ts`:

```ts
import { kstDateString } from '@/domain/date'
import type { NewsItem } from './types'

const ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
}

/** 네이버 검색 API 는 제목·본문에 <b> 태그와 HTML 엔티티를 섞어 준다. */
export function stripHtml(s: string): string {
  let out = s.replace(/<[^>]*>/g, '')
  for (const [k, v] of Object.entries(ENTITIES)) out = out.split(k).join(v)
  return out.trim()
}

function publisherFrom(originallink: string): string {
  try {
    return new URL(originallink).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

type NaverNewsRaw = {
  title: string
  originallink: string
  link: string
  description: string
  pubDate: string
}

/**
 * 당일·D-1(KST) 기사만 반환한다. 그 밖의 기사는 버린다.
 * 정렬은 date 로 받되 '빈도'는 여기서 계산하지 않는다(클러스터링 담당).
 */
export async function searchNaverNews(query: string, now: Date): Promise<NewsItem[]> {
  const id = process.env.NAVER_CLIENT_ID
  const secret = process.env.NAVER_CLIENT_SECRET
  if (!id || !secret) throw new Error('NAVER_CLIENT_ID/SECRET 없음')

  const url =
    `https://openapi.naver.com/v1/search/news.json` +
    `?query=${encodeURIComponent(query)}&display=100&sort=date`

  const res = await fetch(url, {
    headers: { 'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': secret },
  })
  if (!res.ok) throw new Error(`naver news HTTP ${res.status}`)
  const json = (await res.json()) as { items?: NaverNewsRaw[] }

  const today = kstDateString(now)
  const yesterday = kstDateString(new Date(now.getTime() - 24 * 60 * 60 * 1000))
  const allowed = new Set([today, yesterday])

  const out: NewsItem[] = []
  for (const it of json.items ?? []) {
    const publishedAt = new Date(it.pubDate)
    if (Number.isNaN(publishedAt.getTime())) continue
    if (!allowed.has(kstDateString(publishedAt))) continue

    out.push({
      title: stripHtml(it.title),
      url: it.originallink || it.link,
      naverUrl: it.link?.includes('n.news.naver.com') ? it.link : null,
      publisher: publisherFrom(it.originallink || it.link),
      publishedAt,
      description: stripHtml(it.description ?? ''),
    })
  }
  return out
}
```

- [ ] **Step 5: 통과 확인**

Run: `npm test -- src/providers/news/naver.test.ts`
Expected: PASS 7 tests

- [ ] **Step 6: 실제 호출로 확인**

`.env.local`에 `NAVER_CLIENT_ID`/`NAVER_CLIENT_SECRET`을 넣은 뒤:

```bash
npx tsx -e '
const env = require("fs").readFileSync(".env.local","utf8");
for (const line of env.split("\n")) { const m = line.match(/^(\w+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim(); }
import("./src/providers/news/naver").then(async m => {
  const r = await m.searchNaverNews("셀트리온", new Date());
  console.log("당일+D-1 기사 수:", r.length);
  r.slice(0,5).forEach(i => console.log(" -", i.publisher, "|", i.title));
})'
```

Expected: 기사 수가 0 이상. 제목에 `<b>` 태그가 남아 있지 않다.

- [ ] **Step 7: 커밋**

```bash
git add src/providers/news
git commit -m "feat: add Naver news search provider with same-day/D-1 filtering"
```

---

### Task 11: 제목 클러스터링으로 보도 빈도 상위 3건 뽑기

**Files:**
- Create: `src/pipeline/cluster.ts`
- Test: `src/pipeline/cluster.test.ts`

**Interfaces:**
- Consumes: `NewsItem` (Task 10)
- Produces:
  - `normalizeTitle(title: string): string`
  - `jaccard(a: string[], b: string[]): number`
  - `topClusters(items: NewsItem[], topN: number): Array<{ representative: NewsItem; size: number }>`

**배경:** 네이버 검색 API는 정렬이 `sim`/`date`뿐이라 '빈도'를 직접 계산해야 한다.
같은 사건을 다룬 기사는 제목이 비슷하므로, 제목을 정규화해 묶고 **묶음 크기 = 보도 빈도**로 본다.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/pipeline/cluster.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { normalizeTitle, jaccard, topClusters } from './cluster'
import type { NewsItem } from '@/providers/news/types'

function item(title: string, opts: Partial<NewsItem> = {}): NewsItem {
  return {
    title,
    url: opts.url ?? `https://x.com/${encodeURIComponent(title)}`,
    naverUrl: opts.naverUrl ?? null,
    publisher: opts.publisher ?? 'x.com',
    publishedAt: opts.publishedAt ?? new Date('2026-08-27T06:00:00+09:00'),
    description: '',
  }
}

describe('normalizeTitle', () => {
  it('대괄호 말머리를 없앤다', () => {
    expect(normalizeTitle('[속보] 셀트리온 매출 증가')).toBe('셀트리온 매출 증가')
  })
  it('따옴표와 기호를 없앤다', () => {
    expect(normalizeTitle('셀트리온, "글로벌 톱3" 굳힌다…')).toBe('셀트리온 글로벌 톱3 굳힌다')
  })
  it('연속 공백을 하나로 줄인다', () => {
    expect(normalizeTitle('셀트리온   매출')).toBe('셀트리온 매출')
  })
})

describe('jaccard', () => {
  it('완전히 같으면 1이다', () => {
    expect(jaccard(['a', 'b'], ['a', 'b'])).toBe(1)
  })
  it('겹치지 않으면 0이다', () => {
    expect(jaccard(['a'], ['b'])).toBe(0)
  })
  it('절반 겹치면 1/3이다', () => {
    expect(jaccard(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3, 6)
  })
  it('둘 다 비면 0이다', () => {
    expect(jaccard([], [])).toBe(0)
  })
})

describe('topClusters', () => {
  it('많이 보도된 사건을 앞에 놓는다', () => {
    const items = [
      item('셀트리온 글로벌 톱3 굳힌다'),
      item('셀트리온, 글로벌 톱3 지위 굳힌다'),
      item('셀트리온 글로벌 톱3 굳힌다고 밝혀'),
      item('셀트리온 신규 공장 착공'),
    ]
    const r = topClusters(items, 3)
    expect(r[0].size).toBe(3)
    expect(r[1].size).toBe(1)
  })

  it('최대 topN 개만 준다', () => {
    const items = ['가나다 사건', '라마바 사건', '사아자 사건', '차카타 사건'].map(t => item(t))
    expect(topClusters(items, 3)).toHaveLength(3)
  })

  it('기사가 없으면 빈 배열을 준다', () => {
    expect(topClusters([], 3)).toEqual([])
  })

  it('대표 기사는 네이버뉴스 링크가 있는 쪽을 고른다', () => {
    const items = [
      item('셀트리온 글로벌 톱3 굳힌다'),
      item('셀트리온 글로벌 톱3 굳힌다 확정', { naverUrl: 'https://n.news.naver.com/1' }),
    ]
    const r = topClusters(items, 3)
    expect(r[0].representative.naverUrl).toContain('n.news.naver.com')
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- src/pipeline/cluster.test.ts`
Expected: FAIL — `Cannot find module './cluster'`

- [ ] **Step 3: 구현**

`src/pipeline/cluster.ts`:

```ts
import type { NewsItem } from '@/providers/news/types'

/** 같은 사건으로 볼 제목 유사도 임계값 */
const THRESHOLD = 0.5

export function normalizeTitle(title: string): string {
  return title
    .replace(/\[[^\]]*\]/g, ' ')       // [속보], [단독] 같은 말머리
    .replace(/[「」『』<>《》]/g, ' ')
    .replace(/["'"'`]/g, ' ')
    .replace(/[,.…·:;!?~\-–—()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenize(title: string): string[] {
  return normalizeTitle(title)
    .split(' ')
    .filter(t => [...t].length >= 2)
}

export function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a)
  const sb = new Set(b)
  if (sa.size === 0 && sb.size === 0) return 0
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter++
  const union = sa.size + sb.size - inter
  return union === 0 ? 0 : inter / union
}

/** 네이버뉴스 링크가 있으면 우선, 그다음 최신순으로 대표 기사를 고른다. */
function pickRepresentative(members: NewsItem[]): NewsItem {
  return [...members].sort((a, b) => {
    const an = a.naverUrl ? 0 : 1
    const bn = b.naverUrl ? 0 : 1
    if (an !== bn) return an - bn
    return b.publishedAt.getTime() - a.publishedAt.getTime()
  })[0]
}

/**
 * 제목 유사도로 묶은 뒤 묶음 크기(=보도 빈도) 상위 topN 개를 반환한다.
 * 탐욕적 클러스터링이다. 기사 100건 규모에서는 충분하고 결과가 안정적이다.
 */
export function topClusters(
  items: NewsItem[],
  topN: number,
): Array<{ representative: NewsItem; size: number }> {
  const clusters: Array<{ tokens: string[]; members: NewsItem[] }> = []

  for (const it of items) {
    const tokens = tokenize(it.title)
    if (tokens.length === 0) continue
    const hit = clusters.find(c => jaccard(c.tokens, tokens) >= THRESHOLD)
    if (hit) {
      hit.members.push(it)
    } else {
      clusters.push({ tokens, members: [it] })
    }
  }

  return clusters
    .sort((a, b) => {
      if (b.members.length !== a.members.length) return b.members.length - a.members.length
      // 동점이면 최신 기사가 있는 묶음을 앞에 둔다
      const at = Math.max(...a.members.map(m => m.publishedAt.getTime()))
      const bt = Math.max(...b.members.map(m => m.publishedAt.getTime()))
      return bt - at
    })
    .slice(0, topN)
    .map(c => ({ representative: pickRepresentative(c.members), size: c.members.length }))
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- src/pipeline/cluster.test.ts`
Expected: PASS 11 tests

- [ ] **Step 5: 커밋**

```bash
git add src/pipeline/cluster.ts src/pipeline/cluster.test.ts
git commit -m "feat: add title clustering to rank news by coverage frequency"
```

---

### Task 12: 기사 본문 크롤링

**Files:**
- Create: `src/providers/news/article.ts`
- Test: `src/providers/news/article.test.ts`

**Interfaces:**
- Consumes: `NewsItem` (Task 10)
- Produces: `fetchArticleBody(item: NewsItem): Promise<string>`
  — 네이버뉴스 본문을 우선하고, 실패하면 `item.description`으로 폴백한다. 절대 던지지 않는다.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/providers/news/article.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { extractNaverArticleBody, fetchArticleBody } from './article'
import type { NewsItem } from './types'

afterEach(() => vi.unstubAllGlobals())

function base(overrides: Partial<NewsItem> = {}): NewsItem {
  return {
    title: 't', url: 'https://a.com/1', naverUrl: null,
    publisher: 'a.com', publishedAt: new Date(), description: '폴백 스니펫',
    ...overrides,
  }
}

describe('extractNaverArticleBody', () => {
  it('dic_area 안의 본문을 뽑는다', () => {
    const html = `<html><body><div id="dic_area">셀트리온은 매출이 늘었다고 밝혔다.</div></body></html>`
    expect(extractNaverArticleBody(html)).toBe('셀트리온은 매출이 늘었다고 밝혔다.')
  })
  it('본문 안의 태그와 스크립트를 없앤다', () => {
    const html = `<div id="dic_area"><span class="x">앞</span><script>bad()</script> 뒤</div>`
    expect(extractNaverArticleBody(html)).toBe('앞 뒤')
  })
  it('본문 영역이 없으면 빈 문자열을 준다', () => {
    expect(extractNaverArticleBody('<html><body>없음</body></html>')).toBe('')
  })
})

describe('fetchArticleBody', () => {
  it('네이버 링크가 없으면 바로 description 을 쓴다', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    expect(await fetchArticleBody(base())).toBe('폴백 스니펫')
    expect(spy).not.toHaveBeenCalled()
  })

  it('네이버 본문을 받으면 그것을 쓴다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('<div id="dic_area">진짜 본문이다.</div>', { status: 200 })))
    const r = await fetchArticleBody(base({ naverUrl: 'https://n.news.naver.com/1' }))
    expect(r).toBe('진짜 본문이다.')
  })

  it('크롤링이 실패해도 던지지 않고 description 으로 넘어간다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const r = await fetchArticleBody(base({ naverUrl: 'https://n.news.naver.com/1' }))
    expect(r).toBe('폴백 스니펫')
  })

  it('본문이 너무 짧으면 description 을 쓴다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('<div id="dic_area">짧음</div>', { status: 200 })))
    const r = await fetchArticleBody(base({ naverUrl: 'https://n.news.naver.com/1' }))
    expect(r).toBe('폴백 스니펫')
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- src/providers/news/article.test.ts`
Expected: FAIL — `Cannot find module './article'`

- [ ] **Step 3: 구현**

`src/providers/news/article.ts`:

```ts
import type { NewsItem } from './types'

/** 이보다 짧으면 본문 추출에 실패한 것으로 본다. */
const MIN_BODY_CHARS = 50
/** 요약 입력으로 넘길 최대 길이. 토큰 낭비를 막는다. */
const MAX_BODY_CHARS = 3000

/** 네이버뉴스 본문 컨테이너. 구조가 바뀌면 여기만 고치면 된다. */
const BODY_SELECTORS = [/<div[^>]*id="dic_area"[^>]*>([\s\S]*?)<\/div>/i,
                        /<article[^>]*id="dic_area"[^>]*>([\s\S]*?)<\/article>/i,
                        /<div[^>]*id="newsct_article"[^>]*>([\s\S]*?)<\/div>/i]

export function extractNaverArticleBody(html: string): string {
  for (const re of BODY_SELECTORS) {
    const m = html.match(re)
    if (!m) continue
    const text = m[1]
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
    if (text) return text
  }
  return ''
}

/**
 * 요약 입력을 만든다. 어떤 경우에도 예외를 던지지 않는다.
 * 크롤링 실패는 정상 경로다 — 검색 API 스니펫으로 폴백한다.
 */
export async function fetchArticleBody(item: NewsItem): Promise<string> {
  if (!item.naverUrl) return item.description

  try {
    const res = await fetch(item.naverUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IRDailyBrief/1.0)' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return item.description
    const html = await res.text()
    const body = extractNaverArticleBody(html)
    if ([...body].length < MIN_BODY_CHARS) return item.description
    return [...body].slice(0, MAX_BODY_CHARS).join('')
  } catch {
    return item.description
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- src/providers/news/article.test.ts`
Expected: PASS 7 tests

- [ ] **Step 5: 커밋**

```bash
git add src/providers/news/article.ts src/providers/news/article.test.ts
git commit -m "feat: add article body crawler with snippet fallback"
```

---

### Task 13: Gemini 요약 Provider

**Files:**
- Create: `src/providers/summarize/prompt.ts`
- Create: `src/providers/summarize/gemini.ts`
- Test: `src/providers/summarize/gemini.test.ts`

**Interfaces:**
- Consumes: `charLength`, `truncateAtSentence` (Task 2)
- Produces:
  - `type SummarySet = { numeric: string; context: string; implication: string }`
  - `extractJsonText(payload: unknown): string` — thought 파트를 건너뛴다
  - `enforceLimit(s: string): string`
  - `summarize(title: string, body: string): Promise<SummarySet>`

**배경(실측):** `gemini-2.5-flash`는 신규 사용자에게 404다. Gemini 3.x는 응답 파트에
`thoughtSignature`를 함께 실어 보내므로 `parts[0].text`를 그대로 쓰면 안 된다.
호출당 약 8초가 걸린다.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/providers/summarize/gemini.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { extractJsonText, enforceLimit, summarize } from './gemini'

afterEach(() => vi.unstubAllGlobals())

describe('extractJsonText', () => {
  it('thought 파트를 건너뛰고 text 를 고른다', () => {
    const payload = {
      candidates: [{ content: { parts: [
        { text: '생각중...', thought: true },
        { text: '{"numeric":"a"}' },
      ] } }],
    }
    expect(extractJsonText(payload)).toBe('{"numeric":"a"}')
  })
  it('thoughtSignature 가 붙은 text 파트도 읽는다', () => {
    const payload = {
      candidates: [{ content: { parts: [{ text: '{"numeric":"a"}', thoughtSignature: 'xx' }] } }],
    }
    expect(extractJsonText(payload)).toBe('{"numeric":"a"}')
  })
  it('text 파트가 없으면 던진다', () => {
    expect(() => extractJsonText({ candidates: [{ content: { parts: [] } }] })).toThrow()
  })
})

describe('enforceLimit', () => {
  it('100자 이내는 그대로 둔다', () => {
    const s = '가'.repeat(100)
    expect(enforceLimit(s)).toBe(s)
  })
  it('100자를 넘으면 잘라 100자 이내로 만든다', () => {
    const s = '가'.repeat(150)
    expect([...enforceLimit(s)].length).toBeLessThanOrEqual(100)
  })
  it('문장 경계가 있으면 거기서 자른다', () => {
    const s = '첫 문장임.' + '가'.repeat(200)
    expect(enforceLimit(s)).toBe('첫 문장임.')
  })
})

describe('summarize', () => {
  function stubOnce(obj: unknown) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(obj), thoughtSignature: 'x' }] } }],
    }), { status: 200 })))
  }

  it('3안을 돌려준다', async () => {
    process.env.GEMINI_API_KEY = 'k'
    stubOnce({ numeric: '수치임', context: '배경임', implication: '시사점임' })
    const r = await summarize('제목', '본문')
    expect(r).toEqual({ numeric: '수치임', context: '배경임', implication: '시사점임' })
  })

  it('100자를 넘긴 응답을 잘라서 돌려준다', async () => {
    process.env.GEMINI_API_KEY = 'k'
    stubOnce({ numeric: '가'.repeat(180), context: '배경임', implication: '시사점임' })
    const r = await summarize('제목', '본문')
    expect([...r.numeric].length).toBeLessThanOrEqual(100)
  })

  it('키가 없으면 던진다', async () => {
    delete process.env.GEMINI_API_KEY
    await expect(summarize('제목', '본문')).rejects.toThrow(/GEMINI_API_KEY/)
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- src/providers/summarize/gemini.test.ts`
Expected: FAIL — `Cannot find module './gemini'`

- [ ] **Step 3: 프롬프트 상수 작성**

`src/providers/summarize/prompt.ts`. 3안의 성격은 담당자 인터뷰 후 바뀔 수 있으므로 분리해 둔다.

```ts
export const SUMMARY_VARIANTS = [
  { key: 'numeric', variant: 1, label: '수치 중심' },
  { key: 'context', variant: 2, label: '배경·맥락 중심' },
  { key: 'implication', variant: 3, label: '시사점 중심' },
] as const

export const MAX_SUMMARY_CHARS = 100

export function buildPrompt(title: string, body: string): string {
  return `다음 기사를 IR 데일리 브리프용으로 요약한다. 서로 다른 관점의 요약 3안을 작성하라.

1안(수치 중심): 기사의 핵심 수치를 중심으로
2안(배경·맥락 중심): 왜 이런 일이 일어났는지 배경을 중심으로
3안(시사점 중심): 회사·시장에 주는 함의를 중심으로

제약:
- 각 요약은 공백 포함 ${MAX_SUMMARY_CHARS}자 이내. 반드시 지킬 것.
- 개조식 문체(~함, ~임)로 간결하게. 기사 제목을 반복하지 말 것.

제목: ${title}

기사:
${body}`
}
```

- [ ] **Step 4: 구현**

`src/providers/summarize/gemini.ts`:

```ts
import { charLength, truncateAtSentence } from '@/domain/text'
import { buildPrompt, MAX_SUMMARY_CHARS } from './prompt'

/** gemini-2.5-flash 는 신규 사용자에게 404다. 3.6 으로 고정한다. */
const MODEL = 'gemini-3.6-flash'
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`

export type SummarySet = { numeric: string; context: string; implication: string }

/**
 * Gemini 3.x 는 파트에 thoughtSignature 를 함께 실어 보낸다.
 * parts[0].text 를 그대로 쓰면 빈 응답처럼 보인다.
 */
export function extractJsonText(payload: unknown): string {
  const parts = (payload as any)?.candidates?.[0]?.content?.parts ?? []
  for (const p of parts) {
    if (typeof p?.text === 'string' && !p.thought) return p.text
  }
  throw new Error('gemini: text 파트를 찾지 못했다')
}

export function enforceLimit(s: string): string {
  const t = s.trim()
  if (charLength(t) <= MAX_SUMMARY_CHARS) return t
  return truncateAtSentence(t, MAX_SUMMARY_CHARS)
}

export async function summarize(title: string, body: string): Promise<SummarySet> {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY 없음')

  const req = {
    contents: [{ parts: [{ text: buildPrompt(title, body) }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          numeric: { type: 'STRING' },
          context: { type: 'STRING' },
          implication: { type: 'STRING' },
        },
        required: ['numeric', 'context', 'implication'],
      },
    },
  }

  const res = await fetch(`${ENDPOINT}?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`gemini HTTP ${res.status}: ${detail.slice(0, 200)}`)
  }

  const parsed = JSON.parse(extractJsonText(await res.json())) as SummarySet
  return {
    numeric: enforceLimit(parsed.numeric ?? ''),
    context: enforceLimit(parsed.context ?? ''),
    implication: enforceLimit(parsed.implication ?? ''),
  }
}
```

- [ ] **Step 5: 통과 확인**

Run: `npm test -- src/providers/summarize/gemini.test.ts`
Expected: PASS 9 tests

- [ ] **Step 6: 실제 호출로 확인**

```bash
npx tsx -e '
const env = require("fs").readFileSync(".env.local","utf8");
for (const line of env.split("\n")) { const m = line.match(/^(\w+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim(); }
import("./src/providers/summarize/gemini").then(async m => {
  const r = await m.summarize("셀트리온, 진입장벽 높은 시밀러 시장서 글로벌 톱3 굳힌다",
    "셀트리온은 최근 2년 사이 매출이 104% 증가했으며 상업화 제품을 11개로 확대했다. 상반기 매출 2조 5,387억원, 영업이익 7,737억원을 기록했다. 향후 3년 내 상업화 제품을 20개 이상으로 늘릴 계획이다.");
  for (const [k,v] of Object.entries(r)) console.log(`${k} (${[...v].length}자): ${v}`);
})'
```

Expected: 3안 모두 100자 이내이고 서로 다른 관점이다.

- [ ] **Step 7: 커밋**

```bash
git add src/providers/summarize
git commit -m "feat: add Gemini summarizer with 100-char enforcement"
```

---

### Task 14: 연초 기준가 수집

**Files:**
- Create: `src/providers/quote/yearOpen.ts`
- Test: `src/providers/quote/yearOpen.test.ts`

**Interfaces:**
- Consumes: `fetchMarketstackYearOpen` (Task 8)
- Produces:
  - `parseNaverSiseJson(raw: string): Array<{ date: string; open: number; close: number }>`
  - `fetchYearOpen(targets: QuoteTarget[], year: number): Promise<Map<string, number>>`

**배경(실측으로 확정):** 연초대비의 기준가는 **그 해 첫 거래일의 종가가 아니라 시가**다.
샘플 엑셀과 대조한 결과 SK바이오사이언스는 시가 48,200 기준 `-0.2210`으로 소수점까지
일치했고(종가 기준은 -0.2177), 삼성바이오로직스도 시가 기준이 정확히 맞았다.

네이버 일별시세는 **수정주가**를 준다. 셀트리온·한미약품·알테오젠은 시가 기준이라도
샘플과 0.5~4.6%p 어긋나는데, 배당락·액면분할 조정 때문으로 보인다.
Step 6에서 담당자와 대조해 확정한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/providers/quote/yearOpen.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseNaverSiseJson } from './yearOpen'

describe('parseNaverSiseJson', () => {
  const raw = `
 [['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율'],
["20260102", 1695000, 1709000, 1679000, 1683000, 46684, 12.62],
["20260105", 1673000, 1724000, 1671000, 1713000, 51390, 12.67]]`

  it('헤더를 건너뛰고 데이터 행만 읽는다', () => {
    const rows = parseNaverSiseJson(raw)
    expect(rows).toHaveLength(2)
  })
  it('시가와 종가를 구분해 읽는다', () => {
    const rows = parseNaverSiseJson(raw)
    expect(rows[0]).toEqual({ date: '20260102', open: 1695000, close: 1683000 })
  })
  it('소수를 가진 지수 행도 읽는다', () => {
    const rows = parseNaverSiseJson(`[["20260102", 4224.53, 4313.55, 4216.68, 4309.63, 406339, 0.0]]`)
    expect(rows[0].open).toBeCloseTo(4224.53, 2)
    expect(rows[0].close).toBeCloseTo(4309.63, 2)
  })
  it('데이터가 없으면 빈 배열을 준다', () => {
    expect(parseNaverSiseJson(`[['날짜','시가','고가','저가','종가']]`)).toEqual([])
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- src/providers/quote/yearOpen.test.ts`
Expected: FAIL — `Cannot find module './yearOpen'`

- [ ] **Step 3: 구현**

`src/providers/quote/yearOpen.ts`:

```ts
import type { QuoteTarget } from './index'
import { fetchMarketstackYearOpen } from './marketstack'

/**
 * 네이버 siseJson 은 헤더 행에 홑따옴표를 써서 유효한 JSON 이 아니다.
 * 데이터 행만 정규식으로 뽑는다.
 */
export function parseNaverSiseJson(raw: string): Array<{ date: string; open: number; close: number }> {
  const out: Array<{ date: string; open: number; close: number }> = []
  const re = /\["(\d{8})",\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    out.push({ date: m[1], open: Number(m[2]), close: Number(m[5]) })
  }
  return out
}

async function naverYearOpen(symbol: string, year: number): Promise<number | null> {
  const url =
    `https://api.finance.naver.com/siseJson.naver?symbol=${symbol}` +
    `&requestType=1&startTime=${year}0101&endTime=${year}0120&timeframe=day`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.naver.com/' },
  })
  if (!res.ok) return null
  const rows = parseNaverSiseJson(await res.text())
  if (rows.length === 0) return null
  rows.sort((a, b) => a.date.localeCompare(b.date))
  return rows[0].open // 첫 거래일 '시가'. 종가가 아니다.
}

async function twelveDataYearOpen(symbol: string, year: number): Promise<number | null> {
  const key = process.env.TWELVEDATA_API_KEY
  if (!key) return null
  const url =
    `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=1day` +
    `&start_date=${year}-01-01&end_date=${year}-01-20&apikey=${key}`
  const res = await fetch(url)
  if (!res.ok) return null
  const json = (await res.json()) as { values?: Array<{ datetime: string; open: string }> }
  const values = json.values ?? []
  if (values.length === 0) return null
  values.sort((a, b) => a.datetime.localeCompare(b.datetime))
  return Number(values[0].open)
}

/** 연 1회만 부르고 DB(YearOpenPrice)에 캐시한다. 키는 instrument.id. */
export async function fetchYearOpen(
  targets: QuoteTarget[],
  year: number,
): Promise<Map<string, number>> {
  const out = new Map<string, number>()

  const ms = targets.filter(t => t.quoteSource === 'marketstack')
  const others = targets.filter(t => t.quoteSource !== 'marketstack' && t.quoteSource !== 'manual')

  await Promise.all([
    (async () => {
      if (ms.length === 0) return
      try {
        const m = await fetchMarketstackYearOpen(ms.map(t => t.quoteSymbol), year)
        for (const t of ms) {
          const v = m.get(t.quoteSymbol)
          if (v !== undefined) out.set(t.id, v)
        }
      } catch {
        // 연초가는 없어도 나머지 열은 채워야 한다. 조용히 건너뛴다.
      }
    })(),
    ...others.map(async t => {
      try {
        const v =
          t.quoteSource === 'twelvedata'
            ? await twelveDataYearOpen(t.quoteSymbol, year)
            : await naverYearOpen(t.quoteSymbol, year)
        if (v !== null && Number.isFinite(v)) out.set(t.id, v)
      } catch {
        // 위와 같다
      }
    }),
  ])

  return out
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- src/providers/quote/yearOpen.test.ts`
Expected: PASS 4 tests

- [ ] **Step 5: 샘플 엑셀과 대조**

```bash
npx tsx -e '
import("./src/providers/quote/yearOpen").then(async m => {
  const cases = [
    ["302440","SK바이오사이언스",37550,-0.2210],
    ["207940","삼성바이오로직스",1585000,-0.0649],
    ["068270","셀트리온",189600,0.0999],
    ["128940","한미약품",501000,0.1084],
  ];
  for (const [code,name,close,want] of cases) {
    const r = await m.fetchYearOpen([{id:code, quoteSource:"naver-stock", quoteSymbol:code}], 2026);
    const base = r.get(code);
    const got = base ? close/base - 1 : NaN;
    console.log(`${name} 기준가=${base} 계산=${got.toFixed(4)} 샘플=${want} 차이=${Math.abs(got-want).toFixed(4)}`);
  }
})'
```

Expected: SK바이오사이언스·삼성바이오로직스는 차이가 0.001 미만이다.
셀트리온·한미약품은 더 클 수 있다 — 수정주가 때문이다.

- [ ] **Step 6: 수정주가 차이를 담당자에게 확인**

차이가 0.01을 넘는 종목 목록을 뽑아 IR 담당자에게 보여주고,
"연초대비를 수정주가 기준으로 볼지, 당시 실제 호가 기준으로 볼지" 확정한다.
수정주가 기준으로 합의되면 이대로 두고, 아니면 `YearOpenPrice`를 수기 입력 가능하게
`prisma/seed.ts`에 초깃값을 넣는 방식으로 바꾼다. 결정을 스펙 §3.5에 적는다.

- [ ] **Step 7: 커밋**

```bash
git add src/providers/quote/yearOpen.ts src/providers/quote/yearOpen.test.ts
git commit -m "feat: add year-open baseline fetcher (first trading day OPEN price)"
```

---

### Task 15: 동시성 제한과 수집 파이프라인

**Files:**
- Create: `src/pipeline/limit.ts`
- Create: `src/pipeline/collect.ts`
- Test: `src/pipeline/limit.test.ts`

**Interfaces:**
- Consumes: Task 5·9·10·11·12·13·14 전부
- Produces:
  - `pLimit(n: number): <T>(fn: () => Promise<T>) => Promise<T>`
  - `runCollection(now: Date): Promise<{ runId: string; ok: number; failed: number }>`

**배경:** Gemini 호출이 1건당 약 8초다. 종목 23 × 후보 3 = 최대 69회이므로
순차 실행은 9분을 넘는다. 07:40~08:00 안에 끝내려면 병렬이 필요하고,
무료 티어 RPM 한도가 있으므로 무제한 병렬도 안 된다.

- [ ] **Step 1: 동시성 테스트 작성**

`src/pipeline/limit.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { pLimit } from './limit'

describe('pLimit', () => {
  it('동시 실행 수를 넘지 않는다', async () => {
    const limit = pLimit(2)
    let running = 0
    let peak = 0
    const task = () => limit(async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise(r => setTimeout(r, 10))
      running--
      return 1
    })
    await Promise.all(Array.from({ length: 8 }, task))
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('모든 결과를 순서대로 돌려준다', async () => {
    const limit = pLimit(3)
    const r = await Promise.all([1, 2, 3, 4, 5].map(n => limit(async () => n * 2)))
    expect(r).toEqual([2, 4, 6, 8, 10])
  })

  it('실패해도 큐가 막히지 않는다', async () => {
    const limit = pLimit(1)
    const results = await Promise.allSettled([
      limit(async () => { throw new Error('x') }),
      limit(async () => 'ok'),
    ])
    expect(results[0].status).toBe('rejected')
    expect(results[1]).toMatchObject({ status: 'fulfilled', value: 'ok' })
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- src/pipeline/limit.test.ts`
Expected: FAIL — `Cannot find module './limit'`

- [ ] **Step 3: 구현**

`src/pipeline/limit.ts`:

```ts
/** 외부 의존 없는 동시성 제한기. 실패해도 슬롯을 반드시 반납한다. */
export function pLimit(n: number) {
  let active = 0
  const queue: Array<() => void> = []

  const next = () => {
    active--
    queue.shift()?.()
  }

  return function run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        active++
        fn().then(resolve, reject).finally(next)
      }
      if (active < n) start()
      else queue.push(start)
    })
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- src/pipeline/limit.test.ts`
Expected: PASS 3 tests

- [ ] **Step 5: 파이프라인 구현**

`src/pipeline/collect.ts`:

```ts
import { prisma } from '@/db/client'
import { kstDateString } from '@/domain/date'
import { changePct, ytdPct, marketCapKrwTrillion } from '@/domain/calc'
import { fetchFxToKrw } from '@/providers/fx/frankfurter'
import { fetchAllQuotes, type QuoteTarget } from '@/providers/quote'
import { fetchYearOpen } from '@/providers/quote/yearOpen'
import { searchNaverNews } from '@/providers/news/naver'
import { fetchArticleBody } from '@/providers/news/article'
import { topClusters } from './cluster'
import { summarize } from '@/providers/summarize/gemini'
import { SUMMARY_VARIANTS } from '@/providers/summarize/prompt'
import { pLimit } from './limit'

/** Gemini 무료 티어 한도에 맞춘 동시 호출 수. 늘리면 429가 난다. */
const SUMMARY_CONCURRENCY = 4
const NEWS_CONCURRENCY = 5
const TOP_N = 3

export async function runCollection(now: Date): Promise<{ runId: string; ok: number; failed: number }> {
  const runDate = kstDateString(now)
  const year = Number(runDate.slice(0, 4))

  const instruments = await prisma.instrument.findMany({ orderBy: { displayOrder: 'asc' } })

  const run = await prisma.briefRun.upsert({
    where: { runDate },
    update: { status: 'COLLECTING', startedAt: new Date(), finishedAt: null },
    create: { runDate, tradeDate: runDate, status: 'COLLECTING' },
  })

  // 이전 실행분을 지운다. Selection 은 남긴다(담당자 선택을 덮어쓰지 않는다).
  await prisma.newsCandidate.deleteMany({ where: { runId: run.id } })
  await prisma.quoteSnapshot.deleteMany({ where: { runId: run.id } })

  const targets: QuoteTarget[] = instruments.map(i => ({
    id: i.id, quoteSource: i.quoteSource, quoteSymbol: i.quoteSymbol,
  }))

  // 1) 환율
  const currencies = [...new Set(instruments.map(i => i.currency))]
  const fx = await fetchFxToKrw(currencies).catch(() => ({ KRW: 1 } as Record<string, number>))

  // 2) 시세
  const quotes = await fetchAllQuotes(targets)

  // 3) 연초 기준가 — 캐시에 없는 종목만 조회
  const cached = await prisma.yearOpenPrice.findMany({ where: { year } })
  const cachedIds = new Set(cached.map(c => c.instrumentId))
  const missing = targets.filter(t => !cachedIds.has(t.id))
  if (missing.length > 0) {
    const fetched = await fetchYearOpen(missing, year)
    for (const [instrumentId, price] of fetched) {
      await prisma.yearOpenPrice.upsert({
        where: { instrumentId_year: { instrumentId, year } },
        update: { price },
        create: { instrumentId, year, price },
      })
    }
  }
  const yearOpens = new Map(
    (await prisma.yearOpenPrice.findMany({ where: { year } })).map(c => [c.instrumentId, Number(c.price)]),
  )

  // 4) 시세 저장
  let ok = 0
  let failed = 0
  for (const inst of instruments) {
    const q = quotes.get(inst.id)
    if (!q || q instanceof Error) {
      failed++
      await prisma.quoteSnapshot.create({
        data: {
          runId: run.id, instrumentId: inst.id, sourceName: inst.quoteSource,
          errorMessage: q instanceof Error ? q.message : '소스 없음(수기 입력 대상)',
        },
      })
      continue
    }
    ok++
    const rate = fx[inst.currency] ?? 1
    const yearOpen = yearOpens.get(inst.id)
    const cap =
      q.marketCapKrwTrillion ??
      marketCapKrwTrillion({
        close: q.close,
        shares: inst.sharesOutstanding === null ? null : Number(inst.sharesOutstanding),
        fxToKrw: rate,
        priceDivisor: inst.priceDivisorForMarketCap,
      })

    await prisma.quoteSnapshot.create({
      data: {
        runId: run.id,
        instrumentId: inst.id,
        close: q.close,
        prevClose: q.prevClose,
        changePct: changePct(q.close, q.prevClose),
        ytdPct: yearOpen ? ytdPct(q.close, yearOpen) : null,
        marketCapKrwTrillion: inst.isIndex ? null : cap,
        fxRate: rate,
        asOf: q.asOf,
        sourceName: inst.quoteSource,
      },
    })
  }

  // 5) 뉴스 수집 + 클러스터링
  const newsLimit = pLimit(NEWS_CONCURRENCY)
  const perInstrument = await Promise.all(
    instruments.map(inst =>
      newsLimit(async () => {
        try {
          const items = await searchNaverNews(inst.newsQuery, now)
          return { inst, clusters: topClusters(items, TOP_N) }
        } catch {
          return { inst, clusters: [] }
        }
      }),
    ),
  )

  // 6) 후보 저장 + 요약 3안 생성
  const sumLimit = pLimit(SUMMARY_CONCURRENCY)
  await Promise.all(
    perInstrument.flatMap(({ inst, clusters }) =>
      clusters.map((c, idx) =>
        sumLimit(async () => {
          const candidate = await prisma.newsCandidate.create({
            data: {
              runId: run.id,
              instrumentId: inst.id,
              rank: idx + 1,
              title: c.representative.title,
              url: c.representative.naverUrl ?? c.representative.url,
              publisher: c.representative.publisher,
              publishedAt: c.representative.publishedAt,
              clusterSize: c.size,
            },
          })
          try {
            const body = await fetchArticleBody(c.representative)
            const s = await summarize(c.representative.title, body)
            await prisma.newsSummary.createMany({
              data: SUMMARY_VARIANTS.map(v => ({
                candidateId: candidate.id,
                variant: v.variant,
                text: s[v.key],
              })),
            })
          } catch {
            // 요약 실패는 후보를 지우지 않는다. 담당자가 제목만 보고 판단할 수 있다.
          }
        }),
      ),
    ),
  )

  // 7) Selection 행 준비 (없는 것만)
  for (const inst of instruments) {
    await prisma.selection.upsert({
      where: { runId_instrumentId: { runId: run.id, instrumentId: inst.id } },
      update: {},
      create: { runId: run.id, instrumentId: inst.id, decision: 'PENDING' },
    })
  }

  await prisma.briefRun.update({
    where: { id: run.id },
    data: { status: 'READY', finishedAt: new Date() },
  })

  return { runId: run.id, ok, failed }
}
```

- [ ] **Step 6: 로컬에서 전체 수집 1회 실행**

```bash
npx tsx -e '
const env = require("fs").readFileSync(".env.local","utf8");
for (const line of env.split("\n")) { const m = line.match(/^(\w+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim(); }
import("./src/pipeline/collect").then(async m => console.log(await m.runCollection(new Date())))'
```

Expected: `{ runId: '...', ok: 22, failed: 1 }` — 실패 1건은 코스피200 헬스케어(수기 입력)다.

- [ ] **Step 7: 커밋**

```bash
git add src/pipeline
git commit -m "feat: add collection pipeline with bounded concurrency"
```

---

### Task 16: 수집 트리거 엔드포인트

**Files:**
- Create: `src/app/api/cron/collect/route.ts`
- Create: `vercel.json`
- Test: `src/app/api/cron/collect/route.test.ts`

**Interfaces:**
- Consumes: `runCollection` (Task 15)
- Produces: `POST /api/cron/collect` — `x-cron-secret` 헤더가 `CRON_SECRET`과 같아야 한다.

**배경:** 스케줄러를 코드에 넣지 않는다는 것이 이관 전략의 핵심이다.
Vercel Cron과 사내 crontab이 같은 엔드포인트를 부르므로 이관 시 앱 코드가 바뀌지 않는다.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/app/api/cron/collect/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/pipeline/collect', () => ({
  runCollection: vi.fn(async () => ({ runId: 'r1', ok: 22, failed: 1 })),
}))

import { POST } from './route'
import { runCollection } from '@/pipeline/collect'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'secret-value'
})

function req(headers: Record<string, string>) {
  return new Request('http://localhost/api/cron/collect', { method: 'POST', headers })
}

describe('POST /api/cron/collect', () => {
  it('시크릿이 맞으면 수집을 돌린다', async () => {
    const res = await POST(req({ 'x-cron-secret': 'secret-value' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: 22, failed: 1 })
    expect(runCollection).toHaveBeenCalledOnce()
  })

  it('시크릿이 틀리면 401 이고 수집하지 않는다', async () => {
    const res = await POST(req({ 'x-cron-secret': 'wrong' }))
    expect(res.status).toBe(401)
    expect(runCollection).not.toHaveBeenCalled()
  })

  it('시크릿 헤더가 없으면 401 이다', async () => {
    const res = await POST(req({}))
    expect(res.status).toBe(401)
  })

  it('서버에 CRON_SECRET 이 없으면 500 이다', async () => {
    delete process.env.CRON_SECRET
    const res = await POST(req({ 'x-cron-secret': 'anything' }))
    expect(res.status).toBe(500)
  })

  it('수집이 실패하면 500 과 메시지를 준다', async () => {
    vi.mocked(runCollection).mockRejectedValueOnce(new Error('db down'))
    const res = await POST(req({ 'x-cron-secret': 'secret-value' }))
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: 'db down' })
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- src/app/api/cron/collect/route.test.ts`
Expected: FAIL — `Cannot find module './route'`

- [ ] **Step 3: 구현**

`src/app/api/cron/collect/route.ts`:

```ts
import { runCollection } from '@/pipeline/collect'

/** 수집은 외부 소스를 다 도느라 몇 분이 걸린다. */
export const maxDuration = 300
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    return Response.json({ error: 'CRON_SECRET 미설정' }, { status: 500 })
  }
  if (request.headers.get('x-cron-secret') !== expected) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const result = await runCollection(new Date())
    return Response.json(result)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return Response.json({ error: message }, { status: 500 })
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- src/app/api/cron/collect/route.test.ts`
Expected: PASS 5 tests

- [ ] **Step 5: Vercel Cron 등록**

`vercel.json`. Vercel Cron은 UTC로 돈다. KST 평일 07:40 = UTC 일~목 22:40.

```json
{
  "crons": [
    { "path": "/api/cron/collect", "schedule": "40 22 * * 0-4" }
  ]
}
```

Vercel Cron은 `GET`만 보내고 `Authorization: Bearer $CRON_SECRET`을 붙인다.
두 방식을 모두 받도록 `route.ts`에 `GET`을 추가한다.

```ts
export async function GET(request: Request): Promise<Response> {
  const expected = process.env.CRON_SECRET
  if (expected && request.headers.get('authorization') === `Bearer ${expected}`) {
    // Vercel Cron 경로: 헤더 이름만 다르고 하는 일은 같다.
    return POST(new Request(request.url, {
      method: 'POST',
      headers: { 'x-cron-secret': expected },
    }))
  }
  return Response.json({ error: 'unauthorized' }, { status: 401 })
}
```

- [ ] **Step 6: 로컬에서 엔드포인트 확인**

```bash
npm run dev &
sleep 5
curl -s -X POST http://localhost:3000/api/cron/collect -H "x-cron-secret: $(grep CRON_SECRET .env.local | cut -d= -f2)"
```

Expected: `{"runId":"...","ok":22,"failed":1}`

- [ ] **Step 7: 커밋**

```bash
git add src/app/api vercel.json
git commit -m "feat: add secret-protected collection trigger endpoint"
```

---

### Task 17: 검수 화면

**Files:**
- Create: `src/app/review/[date]/page.tsx`
- Create: `src/app/review/[date]/actions.ts`
- Create: `src/app/review/[date]/RowPanel.tsx`
- Create: `src/app/review/[date]/BriefTable.tsx`
- Create: `src/db/repo.ts`
- Test: `src/db/repo.test.ts`

**Interfaces:**
- Consumes: `prisma`, `formatPrice`, `formatPrevDiff` (Task 3)
- Produces:
  - `getBriefRow(runDate: string): Promise<BriefRow[]>`
  - `rowDisplayState(row): 'NO_NEWS' | 'OMITTED' | 'PENDING' | 'SELECTED'`
  - Server actions: `selectNews`, `omitNews`, `saveManualQuote`

**요구사항(스펙 §9):**
- 뉴스 후보 3건 + **"이 행에 뉴스 싣지 않음"** 네 번째 선택지
- 선택한 뉴스의 요약 3안 중 하나 선택 + 직접 수정 가능
- 행 상태 세 가지를 구분해 표시: 후보 0건 / OMITTED / PENDING
- 코스피200 헬스케어 행은 수치 수기 입력
- 시세 기준일(`asOf`)을 함께 표시

- [ ] **Step 1: 상태 판정 테스트 작성**

`src/db/repo.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { rowDisplayState } from './repo'

describe('rowDisplayState', () => {
  it('후보가 없으면 NO_NEWS 다', () => {
    expect(rowDisplayState({ candidateCount: 0, decision: 'PENDING' })).toBe('NO_NEWS')
  })
  it('후보가 없으면 담당자가 아직 안 봤어도 NO_NEWS 다', () => {
    expect(rowDisplayState({ candidateCount: 0, decision: 'OMITTED' })).toBe('NO_NEWS')
  })
  it('담당자가 뺐으면 OMITTED 다', () => {
    expect(rowDisplayState({ candidateCount: 3, decision: 'OMITTED' })).toBe('OMITTED')
  })
  it('아직 안 봤으면 PENDING 이다', () => {
    expect(rowDisplayState({ candidateCount: 3, decision: 'PENDING' })).toBe('PENDING')
  })
  it('골랐으면 SELECTED 다', () => {
    expect(rowDisplayState({ candidateCount: 3, decision: 'SELECTED' })).toBe('SELECTED')
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- src/db/repo.test.ts`
Expected: FAIL — `Cannot find module './repo'`

- [ ] **Step 3: 리포지토리 구현**

`src/db/repo.ts`:

```ts
import { prisma } from './client'

export type RowState = 'NO_NEWS' | 'OMITTED' | 'PENDING' | 'SELECTED'

/**
 * 시스템이 후보를 못 만든 것(NO_NEWS)과 담당자가 뺀 것(OMITTED)은 다르다.
 * 출력 표에서는 둘 다 공란이지만 검수 화면에서는 구분해 보여야 한다.
 */
export function rowDisplayState(row: { candidateCount: number; decision: string }): RowState {
  if (row.candidateCount === 0) return 'NO_NEWS'
  if (row.decision === 'OMITTED') return 'OMITTED'
  if (row.decision === 'SELECTED') return 'SELECTED'
  return 'PENDING'
}

export async function getBriefRows(runDate: string) {
  const run = await prisma.briefRun.findUnique({ where: { runDate } })
  if (!run) return null

  const instruments = await prisma.instrument.findMany({ orderBy: { displayOrder: 'asc' } })
  const quotes = await prisma.quoteSnapshot.findMany({ where: { runId: run.id } })
  const candidates = await prisma.newsCandidate.findMany({
    where: { runId: run.id },
    include: { summaries: { orderBy: { variant: 'asc' } } },
    orderBy: { rank: 'asc' },
  })
  const selections = await prisma.selection.findMany({ where: { runId: run.id } })

  const quoteBy = new Map(quotes.map(q => [q.instrumentId, q]))
  const selBy = new Map(selections.map(s => [s.instrumentId, s]))

  return {
    run,
    rows: instruments.map(inst => {
      const mine = candidates.filter(c => c.instrumentId === inst.id)
      const sel = selBy.get(inst.id)
      return {
        instrument: inst,
        quote: quoteBy.get(inst.id) ?? null,
        candidates: mine,
        selection: sel ?? null,
        state: rowDisplayState({
          candidateCount: mine.length,
          decision: sel?.decision ?? 'PENDING',
        }),
      }
    }),
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- src/db/repo.test.ts`
Expected: PASS 5 tests

- [ ] **Step 5: Server actions 작성**

`src/app/review/[date]/actions.ts`:

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/db/client'

async function updateSelection(
  runDate: string,
  instrumentId: string,
  data: Record<string, unknown>,
) {
  const run = await prisma.briefRun.findUniqueOrThrow({ where: { runDate } })
  await prisma.selection.upsert({
    where: { runId_instrumentId: { runId: run.id, instrumentId } },
    update: data,
    create: { runId: run.id, instrumentId, decision: 'PENDING', ...data },
  })
  revalidatePath(`/review/${runDate}`)
}

export async function selectNews(
  runDate: string,
  instrumentId: string,
  candidateId: string,
  summaryId: string | null,
) {
  await updateSelection(runDate, instrumentId, {
    decision: 'SELECTED',
    chosenCandidateId: candidateId,
    chosenSummaryId: summaryId,
    editedText: null,
  })
}

/** 후보가 있어도 담당자가 싣지 않기로 한 경우. NO_NEWS 와 구분된다. */
export async function omitNews(runDate: string, instrumentId: string) {
  await updateSelection(runDate, instrumentId, {
    decision: 'OMITTED',
    chosenCandidateId: null,
    chosenSummaryId: null,
  })
}

export async function editSummary(runDate: string, instrumentId: string, text: string) {
  await updateSelection(runDate, instrumentId, { editedText: text })
}

/** 코스피200 헬스케어 전용 수기 입력. */
export async function saveManualQuote(
  runDate: string,
  instrumentId: string,
  close: number,
  prevClose: number,
) {
  await updateSelection(runDate, instrumentId, { manualClose: close, manualPrevClose: prevClose })
}
```

- [ ] **Step 6: 화면 작성**

`src/app/review/[date]/page.tsx`:

```tsx
import { getBriefRows } from '@/db/repo'
import { BriefTable } from './BriefTable'

export default async function ReviewPage({ params }: { params: Promise<{ date: string }> }) {
  const { date } = await params
  const data = await getBriefRows(date)

  if (!data) {
    return (
      <main className="p-8">
        <h1 className="text-xl font-bold">{date} 브리프가 없습니다</h1>
        <p className="mt-2 text-sm text-gray-600">수집이 아직 돌지 않았습니다.</p>
      </main>
    )
  }

  const pending = data.rows.filter(r => r.state === 'PENDING').length

  return (
    <main className="p-6">
      <header className="mb-4 flex items-baseline gap-4">
        <h1 className="text-xl font-bold">주가 현황 및 뉴스 — {date}</h1>
        <span className="text-sm text-gray-600">
          미검토 {pending}건 / 전체 {data.rows.length}건
        </span>
      </header>
      <BriefTable runDate={date} rows={data.rows} />
    </main>
  )
}
```

`src/app/review/[date]/BriefTable.tsx`는 23행 표를 그리고 행을 누르면
`RowPanel`을 연다. `RowPanel`은 후보 3건 + "이 행에 뉴스 싣지 않음" 라디오,
그리고 선택된 후보의 요약 3안 라디오와 수정용 textarea를 보여준다.
상태 배지는 `state`에 따라 다음 문구를 쓴다.

| state | 배지 문구 |
|---|---|
| `NO_NEWS` | 당일·D-1 기사 없음 |
| `OMITTED` | 싣지 않음 (담당자 결정) |
| `PENDING` | 미검토 |
| `SELECTED` | 선택 완료 |

시세 셀 아래에는 `quote.asOf`를 작은 글씨로 함께 표시한다
(소스마다 기준일이 다를 수 있으므로 담당자가 판단해야 한다).

- [ ] **Step 7: 화면 확인**

```bash
npm run dev
```

브라우저에서 `http://localhost:3000/review/<오늘날짜>`를 연다.

Expected:
- 23행이 구분(국내사/해외사/Index) 순서대로 보인다
- 행을 누르면 뉴스 후보 3건과 "싣지 않음"이 함께 보인다
- 뉴스를 고르면 요약 3안이 나오고, 하나를 고르면 좌측 표에 반영된다
- 코스피200 헬스케어 행에 수치 입력 필드가 있다

- [ ] **Step 8: 커밋**

```bash
git add src/app/review src/db/repo.ts src/db/repo.test.ts
git commit -m "feat: add review screen with news/summary selection and omit option"
```

---

### Task 18: 운영 문서와 사내 이관 절차

**Files:**
- Create: `docs/운영.md`
- Modify: `README.md`

- [ ] **Step 1: 운영 문서 작성**

`docs/운영.md`에 다음을 적는다.

1. **매일 흐름**: 07:40 KST 자동 수집 → 08:00 담당자가 `/review/<날짜>` 접속 →
   뉴스·요약 선택 → (2단계에서 최종 확정·메일 발송)
2. **분기 1회 갱신**: 해외사 `sharesOutstanding`. 각사 IR 자료의 발행주식수로
   `prisma/instruments.ts`를 고치고 `npx prisma db seed` 실행.
3. **연 1회 확인**: 1월 첫 영업일 이후 `YearOpenPrice`가 자동으로 채워졌는지 확인.
4. **수기 입력 상시**: 코스피200 헬스케어는 자동 소스가 없다(스펙 §3.3).
5. **무료 한도**: marketstack 월 100회(사용 약 22회), 네이버 검색 일 25,000회,
   Twelve Data 일 800회. 한도 초과 시 증상과 대응.
6. **깨지기 쉬운 곳**: 네이버 비공개 엔드포인트(`m.stock.naver.com`, `api.finance.naver.com`)와
   네이버뉴스 본문 셀렉터. 스키마가 바뀌면 각각 `src/providers/quote/naver.ts`,
   `src/providers/news/article.ts` 한 파일만 고치면 된다.

- [ ] **Step 2: 사내 이관 절차 작성**

`docs/운영.md`에 이어서 적는다.

```
1. 저장소: GitHub -> AWS CodeCommit (remote 변경만)
2. DB: prisma/schema.prisma 의 provider 를 postgresql -> mysql 로 변경
       DATABASE_URL 을 MariaDB 접속 문자열로 교체
       npx prisma migrate deploy
3. 배포: next build 후 사내 Node 서버에서 next start
4. 스케줄: Vercel Cron 대신 crontab 에 등록
   40 7 * * 1-5 curl -s -X POST https://<사내주소>/api/cron/collect \
     -H "x-cron-secret: $CRON_SECRET"
   (crontab 은 서버 로컬 시각이므로 KST 서버라면 07:40 그대로 쓴다)
5. 방화벽 확인 대상:
   m.stock.naver.com, api.stock.naver.com, api.finance.naver.com,
   openapi.naver.com, n.news.naver.com,
   api.twelvedata.com, api.marketstack.com, api.frankfurter.dev,
   generativelanguage.googleapis.com
```

애플리케이션 코드는 바뀌지 않는다. 이것이 Provider 격리와 HTTP 트리거를 택한 이유다.

- [ ] **Step 3: 전체 테스트와 빌드 확인**

```bash
npm test && npm run build
```

Expected: 모든 테스트 통과, 빌드 성공.

- [ ] **Step 4: 커밋**

```bash
git add docs README.md
git commit -m "docs: add operations guide and on-premise migration steps"
```

---

## 자체 검토 결과

**스펙 대조** — 스펙의 각 절이 어느 Task에 대응하는지 확인했다.

| 스펙 | Task |
|---|---|
| §2 산출물 23행 | Task 4(시드), Task 17(표) |
| §3.1 탈락 후보 | 해당 없음(기록용) |
| §3.2 비미국 4종목 | Task 8 |
| §3.3 코스피200 헬스케어 수기 입력 | Task 17 Step 5·6 |
| §3.4 시가총액 산출 | Task 3(계산), Task 4 Step 7(주식수) |
| §3.5 연초대비 | Task 14 |
| §4 아키텍처·이관 3원칙 | Task 4(스키마), Task 16(트리거), Task 18(이관) |
| §5 데이터 모델 | Task 4 |
| §6 파이프라인 | Task 15 |
| §7 클러스터링 | Task 11 |
| §8 요약·8.1 제약·8.2 사전생성 | Task 13, Task 15 |
| §9 검수 UI | Task 17 |
| §10 스케줄 | Task 16 |
| §11 이관 | Task 18 |
| §13 리스크 1~5 | Task 17, 8, 3, 6, 12 |

**빠져 있던 것을 채웠다**: 스펙 §3.5는 연초 기준가가 필요하다고만 했고 소스를 정하지
않았다. Task 14에서 네이버 `siseJson`(국내), Twelve Data `time_series`(미국),
marketstack `/eod`(비미국)로 확정하고, **기준가가 첫 거래일의 시가**라는 것을
샘플 대조로 밝혀 반영했다.

**타입 일관성**: `RawQuote`(Task 3)를 모든 Provider가 반환하고, `QuoteTarget`(Task 9)을
Task 14가 그대로 받는다. `SummarySet`의 키(`numeric`/`context`/`implication`)는
Task 13의 `SUMMARY_VARIANTS`와 Task 15의 저장 코드에서 같은 이름을 쓴다.

**남은 결정 사항**: Task 14 Step 6 — 연초대비를 수정주가 기준으로 볼지 담당자 확인 필요.
