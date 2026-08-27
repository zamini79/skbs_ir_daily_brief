import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/pipeline/collect', () => ({
  runCollection: vi.fn(async () => ({
    runId: 'r1',
    ok: 22,
    failed: 1,
    candidatesCreated: 30,
    summariesGenerated: 28,
    summariesSkippedEmptyBody: 1,
    summariesFailed: 1,
  })),
}))

import { POST, GET } from './route'
import { runCollection } from '@/pipeline/collect'

const SECRET = 'secret-value'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = SECRET
})

function postReq(headers: Record<string, string>) {
  return new Request('http://localhost/api/cron/collect', { method: 'POST', headers })
}

function getReq(headers: Record<string, string>) {
  return new Request('http://localhost/api/cron/collect', { method: 'GET', headers })
}

describe('POST /api/cron/collect (사내 crontab 방식: x-cron-secret)', () => {
  it('시크릿이 맞으면 수집을 돌리고 전체 결과를 반환한다', async () => {
    const res = await POST(postReq({ 'x-cron-secret': SECRET }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      runId: 'r1',
      ok: 22,
      failed: 1,
      candidatesCreated: 30,
      summariesGenerated: 28,
      summariesSkippedEmptyBody: 1,
      summariesFailed: 1,
    })
    expect(runCollection).toHaveBeenCalledOnce()
  })

  it('시크릿이 틀리면 401 이고 수집하지 않는다', async () => {
    const res = await POST(postReq({ 'x-cron-secret': 'wrong' }))
    expect(res.status).toBe(401)
    expect(runCollection).not.toHaveBeenCalled()
  })

  it('시크릿 헤더가 없으면 401 이고 수집하지 않는다', async () => {
    const res = await POST(postReq({}))
    expect(res.status).toBe(401)
    expect(runCollection).not.toHaveBeenCalled()
  })

  it('서버에 CRON_SECRET 이 없으면 500 이고 수집하지 않는다 (fail closed)', async () => {
    delete process.env.CRON_SECRET
    const res = await POST(postReq({ 'x-cron-secret': 'anything' }))
    expect(res.status).toBe(500)
    expect(runCollection).not.toHaveBeenCalled()
  })

  it('수집이 실패하면 500 과 에러 메시지를 준다', async () => {
    vi.mocked(runCollection).mockRejectedValueOnce(new Error('db down'))
    const res = await POST(postReq({ 'x-cron-secret': SECRET }))
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: 'db down' })
  })

  it('틀린 시크릿에 대한 401 응답 본문에 서버의 시크릿 값이 노출되지 않는다', async () => {
    const res = await POST(postReq({ 'x-cron-secret': 'wrong' }))
    const bodyText = JSON.stringify(await res.json())
    expect(bodyText).not.toContain(SECRET)
  })
})

describe('GET /api/cron/collect (Vercel Cron 방식: Authorization Bearer)', () => {
  it('Bearer 시크릿이 맞으면 POST 와 동일하게 수집을 돌린다', async () => {
    const res = await GET(getReq({ authorization: `Bearer ${SECRET}` }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ runId: 'r1', ok: 22, failed: 1 })
    expect(runCollection).toHaveBeenCalledOnce()
  })

  it('Bearer 시크릿이 틀리면 401 이고 수집하지 않는다', async () => {
    const res = await GET(getReq({ authorization: 'Bearer wrong' }))
    expect(res.status).toBe(401)
    expect(runCollection).not.toHaveBeenCalled()
  })

  it('Authorization 헤더가 없으면 401 이고 수집하지 않는다', async () => {
    const res = await GET(getReq({}))
    expect(res.status).toBe(401)
    expect(runCollection).not.toHaveBeenCalled()
  })

  it('서버에 CRON_SECRET 이 없으면 500 이고 수집하지 않는다 (fail closed)', async () => {
    delete process.env.CRON_SECRET
    const res = await GET(getReq({ authorization: 'Bearer anything' }))
    expect(res.status).toBe(500)
    expect(runCollection).not.toHaveBeenCalled()
  })

  it('수집이 실패하면 500 과 에러 메시지를 준다', async () => {
    vi.mocked(runCollection).mockRejectedValueOnce(new Error('db down'))
    const res = await GET(getReq({ authorization: `Bearer ${SECRET}` }))
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: 'db down' })
  })
})
