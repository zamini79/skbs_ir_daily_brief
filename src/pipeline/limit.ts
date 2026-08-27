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
