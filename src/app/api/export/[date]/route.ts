import { getBriefRows } from '@/db/repo'
import { isValidDateString } from '@/domain/calendar'
import { excelFileName, toExcelRows } from '@/domain/excel'
import { buildBriefWorkbook } from '@/export/workbook'

/**
 * 검수 화면을 그대로 엑셀로 내려준다.
 *
 * **`force-dynamic` 이 필요하다.** 붙이지 않으면 Next 가 이 라우트를 빌드 시각의
 * 데이터로 고정해 정적 생성하고, 그 뒤로는 담당자가 오늘 화면에서 누른 다운로드가
 * 배포일의 브리프를 준다 — 루트 `/` 리다이렉트에서 이미 한 번 밟은 함정이다.
 *
 * 데이터는 화면과 **같은 `getBriefRows`** 를 쓴다. 엑셀용 조회를 따로 만들면
 * 화면과 파일이 다른 내용을 보여줄 수 있고, 그 순간 이 도구는 못 믿을 것이 된다.
 */
export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  ctx: RouteContext<'/api/export/[date]'>,
): Promise<Response> {
  const { date } = await ctx.params

  // 날짜 형식을 먼저 본다. 형식이 틀린 값은 DB 조회로 넘기지 않는다 —
  // 워크시트 이름이 되는 값이기도 하다.
  if (!isValidDateString(date)) {
    return new Response('날짜 형식이 올바르지 않습니다 (YYYY-MM-DD).', { status: 400 })
  }

  const data = await getBriefRows(date)
  if (!data) {
    return new Response(`${date} 브리프가 없습니다.`, { status: 404 })
  }

  const bytes = await buildBriefWorkbook(date, toExcelRows(data.rows))

  return new Response(bytes, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${excelFileName(date)}"`,
      'Content-Length': String(bytes.byteLength),
      // 검수 중에는 값이 계속 바뀐다. 캐시된 파일이 내려가면 담당자가 방금 고른
      // 기사가 빠진 파일을 메일에 붙이게 된다.
      'Cache-Control': 'no-store',
    },
  })
}
