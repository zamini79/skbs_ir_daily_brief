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
        // fn() 을 try 로 감싼다. **동기 예외를 던지는 fn 이 오면 `.finally(next)` 에
        // 닿지 못해 슬롯이 영영 반납되지 않는다** — NEWS_CONCURRENCY = 1 에서는
        // 뉴스 수집 전체가 그 자리에서 멈춘다(예외도, 로그도 없이).
        // 지금 두 호출부는 async 화살표를 넘기므로 실제로는 일어나지 않지만
        // (async 함수는 동기 예외를 던지지 않는다), 나중에 평범한 함수를 넘기는
        // 호출부 하나가 조용한 교착을 만든다. 방어 비용이 세 줄이다.
        try {
          fn().then(resolve, reject).finally(next)
        } catch (e) {
          reject(e)
          next()
        }
      }
      if (active < n) start()
      else queue.push(start)
    })
  }
}
