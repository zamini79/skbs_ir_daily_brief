# Render 임시 배포 절차

화면을 잠깐 남에게 보여 주거나 회사 밖에서 열어 보기 위한 **임시** 배포다.
사내 이관 절차는 성격이 완전히 다르다 — 그건 [`docs/운영.md`](운영.md) 3부다.

---

## 0. 먼저 알아야 할 세 가지

이 절을 읽지 않고 배포하면 나중에 "왜 안 도는지" 찾느라 시간을 쓴다.

### (1) ★ 07:40 자동 수집은 여기서 돌지 않는다

Render 의 **크론(Cron Job)은 유료 서비스 타입이다.** 서비스당 최소 월 $1 이 붙고,
무료 인스턴스 타입을 고를 수 없다. 그래서 무료 플랜으로 올린 이 배포에는
**스케줄러가 아예 없다.**

- 화면에 어제 브리프가 보이는 것은 **로컬에서 이미 수집해 Supabase 에 넣어 둔
  데이터를 읽는 것**이다. Render 가 수집한 것이 아니다.
- 새 날짜 데이터를 보려면 **5절대로 직접 트리거**하거나, 로컬에서 수집을 돌려라.
- 임시 확인용이라는 이 배포의 성격상 문제는 아니다. 다만 **자동으로 도는 줄 알면
  안 된다.** 며칠 뒤 "브리프가 안 생긴다"고 놀랄 자리가 여기다.

`vercel.json` 의 크론 등록은 Vercel 전용이라 Render 는 읽지 않는다. 앱 코드에
스케줄러가 없는 것은 의도된 설계다(설계 문서 §4.1-3) — 고치려 들지 마라.

### (2) 무료 인스턴스는 잠든다

15분 동안 요청이 없으면 인스턴스가 내려가고, 다음 첫 요청이 **약 1분** 걸린다.
화면이 안 뜨는 것처럼 보여도 대개 그냥 깨는 중이다. 그 뒤로는 정상 속도다.

무료 인스턴스는 **0.1 CPU / 512 MB**, 워크스페이스당 월 750 인스턴스 시간이다.
잠드는 덕분에 750시간은 이 용도로 넉넉하다.

### (3) 인증이 걸린다 — 비밀번호를 정해 두어라

지금까지 이 앱에는 인증이 **전혀** 없었다(설계 문서 §9). 사내망 배포를 전제한
결정이었는데 공개 URL 은 그 전제를 깬다. 그래서 이번에 최소한의 문지기로
**HTTP Basic 인증**을 붙였다. 3절에서 아이디와 비밀번호를 직접 정한다.

---

## 1. GitHub 저장소 만들고 푸시

Render 는 Git 저장소에 연결해야 배포한다. 지금 이 저장소에는 원격이 없다.

```bash
cd /Users/zamini/Project/ir_daily_brief

# 아직 커밋되지 않은 변경이 있으면 먼저 정리한다.
git status

# GitHub 에 저장소를 만든다. gh CLI 가 있으면:
gh repo create ir-daily-brief --private --source=. --remote=origin

# 없으면 github.com 에서 빈 저장소를 만든 뒤:
git remote add origin git@github.com:<계정>/ir-daily-brief.git

git push -u origin feature/ir-daily-brief
```

> **저장소는 private 으로 만드는 것을 권한다.** 코드에 자격증명은 없지만
> (`.gitignore` 가 `.env`·`.env.local` 을 막고 있고, 커밋된 파일과 과거 커밋
> 전체를 훑어 키가 없음을 확인했다), 이 저장소에는 회사의 IR 관심종목 구성과
> 운영 문서가 그대로 들어 있다.

> **`.env`·`.env.local` 은 절대 커밋하지 마라.** `git add -A` 를 습관적으로 쓰다
> 새 `.env.*` 파일이 딸려 들어가는 것이 이 종류 사고의 전형이다. 푸시 전에
> `git status` 로 한 번 더 본다.

---

## 2. Render 에서 Blueprint 연결

1. [dashboard.render.com](https://dashboard.render.com) 로그인 (GitHub 계정으로 하면 편하다)
2. **New → Blueprint**
3. 방금 만든 저장소를 고른다. private 이면 Render 에 저장소 접근 권한을 준다.
4. 브랜치를 **`feature/ir-daily-brief`** 로 맞춘다 (기본 브랜치가 아니면 직접 골라야 한다)
5. Render 가 저장소 루트의 `render.yaml` 을 읽고 `ir-daily-brief` 웹 서비스 하나를 제안한다
6. **Apply** 를 누르면 환경변수 10개를 하나씩 물어본다 → 3절

### 리전은 `singapore` 다 — 그대로 두어라

`render.yaml` 에 `region: singapore` 가 적혀 있다. **리전은 나중에 못 바꾼다.**
바꾸려면 서비스를 지우고 다시 만들어야 하므로 근거를 남겨 둔다.

이 프로젝트의 Supabase 는 **ap-southeast-2(시드니)** 이고, Render 에는 시드니
리전이 없다 — 고를 수 있는 곳은 oregon · ohio · virginia · frankfurt · singapore
다섯 곳뿐이다. 그중 시드니에 가장 가까운 것이 싱가포르다.

**사용자가 한국에 있다는 이유로 고른 것이 아니다.** 화면을 그릴 때마다 서버가
DB 를 왕복하므로 붙여야 할 쪽은 브라우저가 아니라 DB 다. 브라우저와 Render
사이의 거리는 한 번의 왕복이지만, Render 와 Supabase 사이의 거리는 페이지 한 장을
그리는 동안 여러 번 곱해진다.

---

## 3. 환경변수 10개 — 값을 어디서 가져오는가

`render.yaml` 에는 **이름만** 있고 값은 없다(`sync: false`). 값은 여기서 넣는다.

| 이름 | 어디서 | 비고 |
|---|---|---|
| `BASIC_AUTH_USER` | **직접 정한다** | 예: `ir` |
| `BASIC_AUTH_PASSWORD` | **직접 정한다** | 아래 ★ 참고 |
| `DATABASE_URL` | 로컬 `.env.local` 의 같은 값 | 아래 ★★ 참고 |
| `CRON_SECRET` | 로컬 `.env.local` 의 같은 값 | 5절에서 이 값을 쓴다 |
| `NAVER_CLIENT_ID` | 로컬 `.env.local` / [네이버 개발자센터](https://developers.naver.com) 애플리케이션 | 검색 API |
| `NAVER_CLIENT_SECRET` | 위와 같은 애플리케이션 | |
| `GEMINI_API_KEY` | 로컬 `.env.local` / [Google AI Studio](https://aistudio.google.com/apikey) | 요약 |
| `TWELVEDATA_API_KEY` | 로컬 `.env.local` / [twelvedata.com](https://twelvedata.com) 계정 | 미국 5종목 |
| `MARKETSTACK_API_KEY` | 로컬 `.env.local` / [marketstack.com](https://marketstack.com) 계정 | 사노피 + 연초 기준가 |
| `KRX_AUTH_KEY` | 로컬 `.env.local` / [KRX Open API](https://openapi.krx.co.kr) | 코스피200 헬스케어 |

가장 빠른 방법은 로컬 `.env.local` 을 열어 그대로 옮기는 것이다.

```bash
cat .env.local          # 값은 화면으로만 보고 어디에도 붙여넣어 두지 마라
```

### ★ `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` — 반드시 **둘 다** 넣어라

동작 규칙은 셋 중 하나다.

| 설정 상태 | 결과 |
|---|---|
| 둘 다 비어 있음 | 인증이 **꺼진다.** 아무나 들어온다 — 공개 URL 에서는 절대 안 된다 |
| 둘 다 채움 | 정상. 브라우저 인증 창이 뜬다 |
| **한쪽만 채움** | **모든 요청이 401.** 화면이 아예 안 뜬다 |

마지막 줄이 일부러 그렇게 만든 부분이다. 오타로 한쪽만 넣었을 때 통과시키면
"인증이 걸린 줄 아는 무방비 상태"가 되는데, 그건 화면상 정상과 구분이 안 된다.
그래서 **열어두는 대신 닫는다.** 이때 서버 로그에 이유가 남는다:

```
[basic-auth] 설정 오류로 모든 요청을 차단한다: BASIC_AUTH_USER 만 설정돼 있고 ...
```

배포 후 모든 화면이 401 이면 **먼저 이 두 값부터 확인해라.**

비밀번호는 아무거나 쓰지 말고 길게 만들어라. 이건 임시 문지기지 계정 체계가
아니다 — 사람마다 다른 계정 같은 건 없고, 2단계에서 사내 인증으로 교체된다.

```bash
openssl rand -base64 24     # 비밀번호 만들기
```

### ★★ `DATABASE_URL` — 세션 풀러 주소여야 한다

Supabase 대시보드가 먼저 보여주는 **직접 접속 호스트(`db.<ref>.supabase.co`)는
IPv6 전용이라 접속되지 않는다.** 세션 풀러 주소를 써야 한다
(운영 문서 2.3-(2), 설계 문서 §4.1).

- 대시보드 → **Connect** → **Session pooler** 쪽 문자열
- 호스트가 `aws-0-<region>.pooler.supabase.com`, 포트가 `5432` 인 것
- 사용자명이 `postgres.<프로젝트ref>` 형태다

배포 후 DB 오류가 나면 **가장 먼저 이 주소를 의심해라.** 로컬에서 되는 주소가
Render 에서 안 되는 경우가 여기다.

풀러에는 동시 접속 상한이 있다(무료 프로젝트는 세션 모드 15). 로컬 개발 서버와
Render 를 동시에 켜 두면 `max clients reached in session mode` 가 뜰 수 있다 —
한쪽을 끄면 풀린다.

---

## 4. 첫 배포 확인

빌드는 `npm ci --include=dev && npx prisma generate && npm run build` 를 돈다.
로그에 `✓ Compiled successfully` 와 `ƒ Proxy (Middleware)` 가 보이면 정상이다.
(`Proxy` 줄이 없으면 Basic 인증이 붙지 않은 것이다 — 그대로 두면 안 된다.)

배포가 끝나면 `https://ir-daily-brief-xxxx.onrender.com` 주소가 나온다.
**첫 요청은 1분쯤 걸린다.**

순서대로 확인한다.

1. **인증 창이 뜨는가.** 주소를 열면 브라우저가 아이디/비밀번호를 묻는다.
   - 안 묻고 화면이 그냥 뜨면 → 환경변수 둘 다 비어 있다. **즉시 채워라.**
   - 아이디/비밀번호를 맞게 넣어도 계속 401 이면 → 한쪽만 채워져 있다. 3절 ★.
2. **화면이 뜨는가.** 인증 후 최근 브리프 날짜로 자동 이동한다.
   ```bash
   curl -I -u '<USER>:<PASSWORD>' https://<주소>/
   ```
   - `500` 이면 DB 다. 3절 ★★ 의 풀러 주소를 확인한다.
   - 「브리프 없음」이면 그 날짜에 데이터가 없는 것이다. 정상이다 — 0절 (1) 참고.
3. **엑셀이 받아지는가.**
   ```bash
   curl -u '<USER>:<PASSWORD>' -o brief.xlsx \
     https://<주소>/api/export/2026-08-31
   ```
   자격증명 없이 부르면 401 이어야 한다. 이게 401 이 아니면 인증이 새고 있는 것이다:
   ```bash
   curl -o /dev/null -w '%{http_code}\n' https://<주소>/api/export/2026-08-31   # 401 이어야 한다
   ```

---

## 5. 수집을 직접 돌리는 법

크론이 없으므로(0절 (1)) 새 데이터가 필요하면 손으로 부른다.
**이 엔드포인트만 Basic 인증에서 제외돼 있다** — `CRON_SECRET` 으로 스스로
인증하기 때문이다. 그래서 `-u` 를 붙이지 않는다.

```bash
curl -X POST https://<주소>/api/cron/collect \
  -H "x-cron-secret: <CRON_SECRET>" \
  --max-time 1800
```

- 로컬 실측 **약 202초**다. Render 무료 인스턴스는 0.1 CPU 라 더 걸릴 수 있다.
  Render 의 요청 최대 지속 시간은 **100분**이라 여기서 잘릴 걱정은 없다.
  대신 **`curl` 쪽 타임아웃이 먼저 끊는다** — `--max-time` 을 넉넉히 줘라.
- 잠들어 있었다면 앞에 콜드 스타트 1분이 더 붙는다.
- 응답은 JSON 이다: `{"runId":...,"ok":22,"failed":1,...}`
- `{"error":"unauthorized"}` → 시크릿이 틀렸다.
- `{"error":"CRON_SECRET 미설정"}` (500) → Render 에 그 환경변수가 없다.
  **이 경우 엔드포인트는 열리는 대신 닫힌다.** 의도된 동작이다.

### 대안: 수집은 로컬에서, 화면만 Render 에서

0.1 CPU 에서 수집이 오래 걸리는 것이 거슬리면, **수집은 지금처럼 로컬에서
돌리고 Render 는 화면만 보는 용도로 쓰면 된다.** 둘이 같은 Supabase 를 보므로
로컬에서 수집한 결과가 Render 화면에 그대로 나온다. 임시 확인용이라면 이쪽이
더 단순하다.

```bash
# 로컬에서
curl -X POST http://localhost:3000/api/cron/collect \
  -H "x-cron-secret: $(grep '^CRON_SECRET=' .env.local | cut -d= -f2-)"
```

---

## 6. 마이그레이션은 배포에 넣지 않았다

`render.yaml` 의 빌드 커맨드에 `prisma migrate deploy` 가 **일부러 없다.**
빌드에 넣으면 배포할 때마다 운영 DB 스키마를 건드린다. 지금 Supabase 는 이미
최신이라 실행할 이유가 없다.

나중에 스키마를 바꿔서 적용이 필요해지면 **사람이 한 번만** 돌린다.

```bash
# 로컬에서 (같은 DATABASE_URL 을 보므로 결과는 같다)
npx prisma migrate deploy
```

**무료 인스턴스에는 Shell·SSH 접속이 없다.** Render 안에서 명령을 칠 방법이
아예 없으니, 마이그레이션은 위처럼 로컬에서 돌린다. 어차피 같은 DB 를 보므로
결과는 같다. 빌드 커맨드에는 넣지 마라.

---

## 7. 알려진 제약 정리

| 제약 | 내용 | 대응 |
|---|---|---|
| **크론 없음** | Render Cron Job 은 유료(서비스당 최소 월 $1), 무료 인스턴스 타입 불가 | 5절대로 손으로 트리거하거나 로컬 수집 |
| **콜드 스타트** | 15분 무요청 시 잠들고, 다음 요청이 약 1분 | 기다린다 |
| **0.1 CPU / 512 MB** | 수집이 로컬(202초)보다 느릴 수 있다 | 요청 상한은 100분이라 잘리지는 않는다 |
| **월 750 인스턴스 시간** | 워크스페이스 전체 기준 | 잠드는 덕에 임시 용도로는 넉넉하다 |
| **대역폭** | 무료 포함량을 넘기면 과금 또는 정지 | 엑셀 몇 개 받는 정도로는 문제없다 |
| **Shell·SSH 없음** | 무료 인스턴스는 대시보드 셸도 SSH 도 못 쓴다 | 명령은 로컬에서 돌린다(6절) |
| **Basic 인증뿐** | 사람마다 다른 계정도, 감사 로그도 없다 | 임시 배포용. 2단계에서 사내 인증으로 교체 |
| **Supabase 풀러** | 직접 접속 호스트는 IPv6 전용이라 실패 | 3절 ★★ |

## 8. 다 보고 나면

임시 배포다. 확인이 끝나면 Render 대시보드에서 서비스를 **Suspend** 하거나
삭제해라. 켜 둔 채로 두면 750시간을 조금씩 쓰고, 공개 URL 이 하나 더 살아 있는
상태가 계속된다.

`render.yaml` 은 저장소에 남겨 둬도 무해하다 — Render 에 연결하지 않으면 아무
일도 하지 않는다.
