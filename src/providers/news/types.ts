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
