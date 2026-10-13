import type { RawQuote } from '@/domain/types'
import { QuoteError } from './types'

/**
 * FT(`markets.ft.com`) 종목 요약 페이지. **유럽 3종목(GSK·Sanofi·Lonza)의 1차이고
 * Wuxi 의 2차다**(Task 43, 2026-10-13).
 *
 * **이 소스는 취약하다 — 그 판단은 그대로다.** JSON API 가 아니라 **사람이 보는 HTML
 * 페이지를 긁는다.** LSE·SIX·네이버도 비문서화 엔드포인트지만 적어도 기계용 JSON 이라
 * 필드 이름이 바뀌면 바뀐 티가 난다. HTML 은 광고 한 줄, 배너 하나로도 구조가 변한다.
 *
 * **[폐기된 결론] 「2차(폴백) 전용이다. 평소에는 부르지 않고 1차가 실패한 날에만
 * 부른다. 1차로 올리지 마라.」** (Task 32, 2026-08-28) — Task 43 에서 유럽 3종목에
 * 한해 뒤집었다. 근거는 같은 시점에 나란히 부른 실측이다(2026-10-13 10:52 KST 화요일):
 *
 *     GSK    LSE         1771  / 전일 1750  / 기준 10-12  ┐ FT GSK:LSE  와 완전히 같다
 *     Lonza  SIX         574   / 전일 572.2 / 기준 10-12  ┘ FT LONN:SWX 와 완전히 같다
 *     Sanofi marketstack 71.52 / 전일 70.93 / 기준 10-09  ← 하루 늦다(월요일 10-12 가 없다)
 *     Sanofi FT SAN:PAR  71.6  / 전일 71.52 / 기준 10-12
 *
 * 사노피의 1차(marketstack)는 **실패가 아니라 하루 늦은 값을 성공으로** 돌려줬다.
 * 그래서 폴백이 돌지도 않고 매일 하루 늦은 숫자가 나갔다(10-02 화면에서도 기준 09-29).
 * 「2차 자리에서도 장점을 그대로 얻는다」던 전제가 여기서 깨졌다 — 2차는 1차가 **실패**해야
 * 돈다. FT 를 1차로 올리면 세 종목이 한 소스·같은 기준일로 맞춰진다.
 *
 * **대가**: FT 화면 구조가 바뀌면 **세 종목 1차가 동시에 실패한다.** 그래도 2차가
 * 각자 있어(lse·marketstack·six) 값은 채워지고 행마다 「… 대체」 배지가 뜬다.
 * 이 파일의 파서가 라벨을 못 찾으면 값을 채우지 않고 실패로 남기는 규칙이 그래서 중요하다.
 *
 * **Wuxi 는 옮기지 않는다.** FT 는 「지금 값」을 준다. 홍콩은 한국 시간 오전(10:30 KST)에
 * 장이 열려 실행 시각에 따라 숫자가 바뀐다(스펙 §3.0) — 실측 같은 시각 FT 2269:HKG 는
 * 51.1 / 기준 10-13(장중), 네이버는 52.65 / 기준 10-12 였다. 유럽 장은 KST 16시(서머타임 해제 뒤 17시)에
 * 열리므로 **그 이후에 수집하면 유럽 3종목도 장중 값**이다(정기 06:30 KST 는 무관). 기존
 * LSE·SIX 도 같은 성질이라 새로 생긴 위험은 아니다.
 *
 * 심볼 표기가 또 다르다 — `{티커}:{거래소}` 다(`GSK:LSE`, `SAN:PAR`, `LONN:SWX`,
 * `2269:HKG`). **`LONN:VTX` 는 302 로 검색 페이지에 떨어진다. `SWX` 를 써라.**
 * 유럽 3종목은 시드의 `quoteSymbol`, Wuxi 는 `quoteFallbackSymbol` 이 이 표기를 들고 있다.
 * 연초 기준가는 FT 에 없어서 marketstack 이 주고, ytdBase.ts 가 거래소 코드로 심볼을 바꾼다.
 *
 * 키가 필요 없다. 깨지면 이 파일 하나만 고친다.
 */
const BASE = 'https://markets.ft.com/data/equities/tearsheet/summary'

/** 사유 문구가 DB(QuoteSnapshot.errorMessage)와 화면에 실린다. 본문을 통째로 싣지 않는다. */
const MAX_ERROR_DETAIL_CHARS = 120

/** 일반 브라우저 User-Agent. 사람이 보는 페이지이므로 화면과 같은 모양으로 부른다. */
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  Accept: 'text/html',
}

/**
 * 한 칸(라벨 또는 값)에서 읽어들일 최대 길이. 마지막 칸처럼 다음 토큰이 없는 경우에
 * 문서 끝까지 긁지 않기 위한 상한이다. 실측 칸은 전부 30자 미만이다.
 */
const MAX_CELL_CHARS = 400

/** 시세 요약 목록의 라벨·값 span. **class 안에 다른 클래스가 섞여 와도 걸리게** 둔다. */
const CELL_TAG_RE = /<span[^>]*class="[^"]*mod-ui-data-list__(label|value)[^"]*"[^>]*>/g

/** `Price (EUR)` — 괄호 안이 통화다. GBX·CHF·HKD·EUR 실측 확인. */
const PRICE_LABEL_RE = /^Price \(([A-Za-z]{2,5})\)$/

/** 전일 대비 변동 금액과 등락률이 함께 오는 칸(`-1.01 / -1.29%`). */
const CHANGE_LABEL = "Today's Change"

/**
 * 시세 모듈의 데이터 기준 시각.
 *
 *     <div class="mod-disclaimer">Data delayed at least 15 minutes, as of Aug 27 2026 16:39 BST.</div>
 *
 * 실측(2026-08-28)에서 네 종목 페이지 전부에 있었고, 값을 읽는 `<ul>` 바로 뒤에 붙는다.
 */
const AS_OF_RE = /Data delayed[^<]{0,160}?as of\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})/g

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 태그를 걷어내고 실제로 만나는 엔티티만 되돌린다. 공백은 하나로 접는다. */
function textOf(fragment: string): string {
  return fragment
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#0?39;|&apos;|&rsquo;|&#8217;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 라벨 비교용. FT 가 곧은따옴표를 쓰지만 굽은따옴표로 바뀌어도 같은 라벨로 본다. */
function canonicalLabel(s: string): string {
  return s.replace(/[‘’]/g, "'")
}

/**
 * 라벨-값 쌍을 **문서 순서가 아니라 인접 관계로** 뽑는다.
 *
 * **위치로 읽지 않는 것이 이 함수의 존재 이유다.** FT 요약 목록은 `<li>` 안에
 * 라벨 span 과 값 span 이 나란히 놓인 구조인데, 항목 순서는 페이지 개편 한 번이면
 * 바뀐다. 순서로 읽으면 그날 종가 자리에 「거래량」이나 「베타」가 들어오고,
 * 값이 그럴듯한 숫자라 아무도 눈치채지 못한다(six.ts 의 `cell()` 과 같은 이유).
 *
 * 값 span 안에는 `<span class="mod-format--neg"><i/>…</span>` 처럼 태그가 더 들어
 * 있으므로 닫는 `</span>` 을 세지 않는다 — **다음 칸이 시작되는 곳까지**를 그 칸의
 * 내용으로 보고 태그를 걷어낸다. 중첩 깊이가 바뀌어도 값이 그대로 나온다.
 */
function dataPairs(html: string): Array<{ label: string; value: string }> {
  const tokens: Array<{ kind: string; tagStart: number; contentStart: number }> = []
  CELL_TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CELL_TAG_RE.exec(html)) !== null) {
    tokens.push({ kind: m[1], tagStart: m.index, contentStart: m.index + m[0].length })
  }

  const cellText = (i: number): string => {
    const start = tokens[i].contentStart
    let end = Math.min(tokens[i + 1]?.tagStart ?? html.length, start + MAX_CELL_CHARS)
    // 한 칸의 내용은 자기 `<li>` 를 넘지 않는다. 목록의 **마지막 칸**은 뒤에 다음
    // 토큰이 없어서, 이 경계가 없으면 목록 뒤에 오는 안내 문구("Data delayed …")까지
    // 값으로 빨려 들어간다. 그러면 순서만 바뀌어도 파싱이 깨진다.
    for (const closer of ['</li>', '</ul>']) {
      const at = html.indexOf(closer, start)
      if (at >= 0 && at < end) end = at
    }
    return textOf(html.slice(start, end))
  }

  const out: Array<{ label: string; value: string }> = []
  for (let i = 0; i + 1 < tokens.length; i++) {
    // 값이 딸리지 않은 라벨(관심종목 추가 버튼 등)은 쌍이 되지 않으므로 그냥 지나간다.
    if (tokens[i].kind !== 'label' || tokens[i + 1].kind !== 'value') continue
    out.push({ label: canonicalLabel(cellText(i)), value: cellText(i + 1) })
  }
  return out
}

/**
 * 천 단위 콤마만 걷어내고 **칸 전체가 숫자일 때만** 숫자를 준다.
 *
 * 부분 일치(문자열 안에서 첫 숫자 뽑기)를 하지 않는 것이 중요하다. 라벨이 바뀌어
 * 엉뚱한 칸을 읽게 된 날, 부분 일치는 「3.59m」에서 3.59 를 뽑아내 그럴듯한 주가를
 * 만들어 낸다. 여기서는 NaN 이 되고 호출자가 실패로 남긴다.
 */
function toNumber(raw: string): number {
  const t = raw.replace(/,/g, '').replace(/^\+/, '').trim()
  if (!/^-?\d+(\.\d+)?$/.test(t)) return NaN
  return Number(t)
}

/** 소스가 실제로 적어 준 소수 자릿수. `1,852.00` → 2, `0.600` → 3, `50` → 0. */
function decimalPlaces(raw: string): number {
  const m = /\.(\d+)/.exec(raw.replace(/,/g, '').trim())
  return m ? m[1].length : 0
}

/**
 * 시세 기준일 `YYYY-MM-DD`. **모르면 빈 문자열이다 — 추측해서 채우지 않는다.**
 *
 * 페이지가 주는 것은 「데이터 기준 시각」(런던 시간)이지 거래소가 찍어 준 거래일
 * 필드가 아니다. 그래도 쓰는 이유: 이 네 종목의 거래 시간대(런던·파리·취리히·홍콩)는
 * 전부 **런던 달력 날짜 안에서 끝난다** — 파리 17:30 CEST = 16:30 BST, 홍콩 16:00 HKT
 * = 08:00 BST 다. 그래서 이 시각의 날짜 부분이 곧 그 거래일이다. 07:40 KST 수집
 * 시점(런던 전날 23:40)에도 마찬가지다.
 * **이 전제가 깨지는 시장(런던 자정을 넘겨 마치는 거래소)을 FT 로 부른다면 이
 * 함수부터 다시 봐야 한다.**
 *
 * 값을 안 쓰고 비워 두는 쪽이 나은 경우가 하나 있다: 같은 페이지에 서로 **다른**
 * 기준 시각이 여러 개 있으면 어느 것이 시세 모듈의 것인지 우리가 알 수 없다.
 * 그때는 하나를 고르지 않고 빈 값으로 둔다(화면에 「기준일 미상」이 뜬다).
 */
function parseAsOf(html: string): string {
  AS_OF_RE.lastIndex = 0
  const found = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = AS_OF_RE.exec(html)) !== null) {
    const month = MONTHS.indexOf(m[1])
    if (month < 0) continue
    found.add(`${m[3]}-${String(month + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`)
  }
  return found.size === 1 ? [...found][0] : ''
}

/**
 * FT 종목 시세. `code` 는 `{티커}:{거래소}` 표기다(`SAN:PAR`).
 *
 * **라벨을 못 찾으면 실패다.** 0 이나 null 로 채우고 넘어가지 않는다 — HTML 이
 * 바뀌었을 때 조용히 0원이 찍히는 것이 이 코드베이스가 반복해서 맞아 온 결함이다.
 * 실패로 남아야 유럽 3종목은 각자의 2차로 넘어가고, Wuxi 는 사유가 화면에 남는다.
 *
 * **전일 종가는 `Today's Change` 의 변동 금액에서 유도한다** — `가격 − 변동금액`.
 * 검산(실측 2026-08-28): 77.28 − (−1.01) = 78.29. lse.ts 가 `lastclose - netchange`
 * 를 쓰는 것과 같은 방식이다.
 *
 * **등락률(`/` 뒤의 값)은 버린다.** 전 종목을 `domain/calc.ts` 의 `changePct` 로
 * 계산한다 — 소스별 반올림 규칙이 다르면 그 행만 끝자리가 어긋난다(krx.ts·naver
 * 해외가 소스 등락률을 버리는 것과 같은 이유).
 *
 * **통화는 접지 않고 그대로 준다.** GSK 는 `GBX`(펜스)로 온다 — 2차(LSE)와 같은
 * 단위이므로 `Instrument.priceDivisorForMarketCap = 100` 이 1차·2차 어느 경로에서도
 * 그대로 맞는다. GBP 로 미리 접으면 `collectHelpers.currencyMismatchReason` 이 무력해진다.
 *
 * 없는 심볼은 오류가 아니라 **302 리다이렉트**다(실측: `LONN:VTX`, `ZZZZNOPE:XXX`
 * 둘 다 `/data/search?query=…` 로 보낸다). 따라가면 종목 페이지가 아닌 곳의 숫자를
 * 읽을 위험이 있으므로 따라가지 않고 실패로 남긴다(`redirect: 'manual'`).
 */
export async function fetchFtQuote(code: string): Promise<RawQuote> {
  const res = await fetch(`${BASE}?s=${encodeURIComponent(code)}`, {
    headers: HEADERS,
    redirect: 'manual',
  })

  // 형식은 다른 provider 와 같은 `... HTTP {status}` 다. retry.ts 의
  // classifyQuoteFailure 가 이 숫자를 보고 재시도 여부를 가른다(302 는 재시도하지 않는다).
  if (!res.ok) {
    const note =
      res.status >= 300 && res.status < 400 ? ' (심볼을 찾지 못해 검색 페이지로 리다이렉트)' : ''
    throw new QuoteError(code, `FT HTTP ${res.status}${note}`)
  }

  const html = await res.text()
  const pairs = dataPairs(html)

  const priceCell = pairs.find(p => PRICE_LABEL_RE.test(p.label))
  if (!priceCell) throw new QuoteError(code, 'FT: Price 라벨을 찾지 못함')

  const currency = PRICE_LABEL_RE.exec(priceCell.label)![1].toUpperCase()

  const close = toNumber(priceCell.value)
  if (!Number.isFinite(close)) {
    throw new QuoteError(code, `FT: Price 파싱 실패: ${priceCell.value.slice(0, MAX_ERROR_DETAIL_CHARS)}`)
  }

  const changeCell = pairs.find(p => p.label === CHANGE_LABEL)
  if (!changeCell) throw new QuoteError(code, `FT: ${CHANGE_LABEL} 라벨을 찾지 못함`)

  // `-1.01 / -1.29%` — 앞이 금액, 뒤가 등락률이다. 등락률은 쓰지 않는다.
  const amountPart = changeCell.value.split('/')[0]
  const change = toNumber(amountPart)
  if (!Number.isFinite(change)) {
    throw new QuoteError(
      code,
      `FT: ${CHANGE_LABEL} 파싱 실패: ${changeCell.value.slice(0, MAX_ERROR_DETAIL_CHARS)}`,
    )
  }

  // 뺄셈의 부동소수 찌꺼기를 남기지 않는다. 77.28 − (−1.01) 은 이진 부동소수에서
  // 78.29000000000001 이 되는데, 뒤 12자리는 **소스에 없던 정밀도**다(그대로 저장하면
  // DB·후속 산출물에 그 숫자가 그대로 실린다). 값을 반올림해 바꾸는 것이 아니라,
  // 소스가 적어 준 자릿수(둘 중 더 긴 쪽)를 넘는 자리를 만들지 않는 것이 목적이다.
  const digits = Math.max(decimalPlaces(priceCell.value), decimalPlaces(amountPart))
  return {
    close,
    prevClose: Number((close - change).toFixed(Math.min(digits, 10))),
    currency,
    // 기준일은 못 읽어도 실패가 아니다(값이 아니다). 빈 문자열은 normalizeAsOf 가
    // null 로 바꾸고 화면이 「기준일 미상」으로 말한다 — 없는 날짜를 지어내지 않는다.
    asOf: parseAsOf(html),
  }
}
