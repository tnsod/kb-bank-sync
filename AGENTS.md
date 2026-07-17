# AGENTS.md

## 프로젝트 목적

이 저장소는 KB국민은행 빠른조회 서비스를 Playwright로 자동 조작해 거래내역을 수집하고, 신규 거래만 Google Sheets에 기록하는 조회 전용 배치 프로그램이다.

핵심 TypeScript 배치는 Windows, macOS, Linux에서 직접 실행할 수 있고 Ubuntu 기반 Docker 이미지는 세 호스트 OS와 Google Cloud Run Jobs에서 사용할 수 있다. 프로그램은 상시 실행되는 웹 서버가 아니라 한 번 실행되고 종료되는 배치 작업이어야 한다.

구현하지 않는 기능:

- 송금 및 이체
- 계좌 설정 또는 인증수단 변경
- 은행 보안장치 우회
- 다중 사용자 서비스
- 외부 공개 HTTP 서버
- SQLite, PostgreSQL 등 별도 데이터베이스

Google Sheets를 최종 저장소이자 중복 판정 기준으로 사용한다.

---

## 전체 실행 흐름

```text
환경변수 검증
→ Google Sheets 기존 거래 조회
→ 최근 거래일과 조회 기간 계산
→ KB 빠른조회 페이지 접속
→ 계좌정보 입력
→ 이미지 키패드로 웹 비밀번호 입력
→ 거래내역 조회
→ DOM 파싱
→ 거래내역 정규화 및 검증
→ sourceKey 생성
→ 현재 실행 내부 중복 제거
→ 기존 시트 sourceKey와 비교
→ 신규 거래만 시간순 정렬
→ Google Sheets 일괄 추가
→ 실행 결과 로그 기록
→ 종료
```

---

## 기술 스택

- Node.js
- TypeScript
- npm
- Playwright
- Zod
- dayjs
- pino
- Google Sheets API
- Docker 및 Docker Compose
- Windows 작업 스케줄러
- macOS launchd
- 선택적 Ubuntu Linux 배포, systemd timer, `flock`
- Google Cloud Run Jobs 및 Cloud Scheduler

새 라이브러리는 실제 필요성이 있을 때만 추가한다. 기존 라이브러리로 해결할 수 있는 문제를 위해 불필요한 의존성을 추가하지 않는다.

### 플랫폼 경계

- `src/`의 핵심 애플리케이션은 환경변수와 `node:path`를 사용하며 특정 사용자나 운영체제의 절대경로를 하드코딩하지 않는다.
- Docker 컨테이너는 Ubuntu 기반이지만 호스트가 Ubuntu일 필요는 없다.
- `deploy/windows/`는 Windows 작업 스케줄러 전용이다.
- `deploy/macos/`는 macOS 사용자 LaunchAgent 전용이며 Linux `flock`을 사용하지 않는다.
- `scripts/run-sync.sh`, `scripts/status.sh`, `deploy/systemd/`는 Linux 자동 실행 전용이다.
- Cloud Run Jobs는 Docker Compose나 데스크톱/서버 스케줄러 대신 Cloud Scheduler를 사용한다.

---

## 에이전트 작업 원칙

1. 변경 전에 기존 코드와 문서를 먼저 읽는다.
2. 요청받지 않은 대규모 리팩터링을 하지 않는다.
3. 실제 페이지를 확인하지 않고 KB DOM 선택자를 임의로 만들지 않는다.
4. 실행하지 않은 테스트나 빌드를 성공했다고 주장하지 않는다.
5. 인증 실패를 반복 재시도하지 않는다.
6. 파싱 결과가 의심스러우면 시트 쓰기를 중단한다.
7. 민감정보를 코드, 로그, fixture, 문서, 테스트 출력에 남기지 않는다.
8. 데이터베이스를 추가하지 않는다.
9. 기존 Google Sheets 데이터를 자동 삭제하거나 수정하지 않는다.
10. 변경 범위와 검증 결과를 작업 완료 보고에 명시한다.

---

## 현재 디렉터리 구조

```text
kb-bank-sync/
├─ src/
│  ├─ bank/
│  ├─ config/
│  ├─ logging/
│  ├─ spreadsheet/
│  ├─ sync/
│  ├─ transaction/
│  ├─ utils/
│  └─ index.ts
├─ tests/
│  └─ fixtures/
├─ assets/keypad-templates/
├─ scripts/
│  ├─ docker-entrypoint.sh
│  ├─ generate-keypad-templates.ts
│  ├─ run-sync.sh
│  └─ status.sh
├─ deploy/
│  ├─ windows/
│  ├─ macos/
│  └─ systemd/
│     ├─ kb-bank-sync.service
│     └─ kb-bank-sync.timer
├─ docs/
│  ├─ cloud-run-deployment.md
│  ├─ page-structure.md
│  ├─ server-deployment.md
│  └─ history/diagnostic-comparison.md
├─ .github/workflows/ci.yml
├─ logs/
├─ output/
├─ secrets/
├─ .env.example
├─ .gitattributes
├─ .gitignore
├─ SECURITY.md
├─ Dockerfile
├─ docker-compose.yml
├─ package.json
├─ tsconfig.json
└─ README.md
```

구조를 조정할 수 있지만 다음 경계는 유지한다.

- 은행 자동화와 Google Sheets 코드를 분리한다.
- DOM 파싱과 거래 정규화를 분리한다.
- 환경변수 검증과 비즈니스 로직을 분리한다.
- 전체 동기화 순서는 `sync` 계층에서 조합한다.
- `index.ts`는 실행 진입점 역할만 담당한다.

---

## 모듈 책임

### `src/config`

- Zod 기반 환경변수 검증
- KB 페이지 선택자 중앙 관리
- 선택자 문자열을 여러 파일에 중복 작성하지 않음

### `src/bank`

- 빠른조회 페이지 접속
- 입력 폼 작성
- 이미지 키패드 입력
- 조회 실행
- 조회 결과 상태 분류
- 거래내역 원본 DOM 추출

이 계층에서 Google Sheets API를 호출하지 않는다.

### `src/transaction`

- 날짜 및 금액 정규화
- 거래 필드 검증
- sourceKey 생성
- Playwright 객체에 의존하지 않음

### `src/spreadsheet`

- Google 서비스 계정 인증
- 헤더 검증
- 기존 행 및 sourceKey 조회
- 신규 행 일괄 추가
- append 실패 후 상태 재확인

이 계층은 KB 페이지 구조를 알 필요가 없어야 한다.

### `src/sync`

- 기존 시트 상태 조회
- 조회 기간 계산
- 은행 조회 호출
- 중복 제거
- 신규 거래 판정
- Dry-run 처리
- 시트 쓰기
- 실행 요약 생성

---

## 환경변수

최소 환경변수:

```env
KB_QUICK_LOOKUP_URL=
KB_ACCOUNT_NUMBER=
KB_BIRTH_DATE=
KB_WEB_PASSWORD=

GOOGLE_SPREADSHEET_ID=
GOOGLE_SHEET_NAME=거래내역
GOOGLE_SERVICE_ACCOUNT_KEY_PATH=

SYNC_OVERLAP_DAYS=3
INITIAL_LOOKBACK_MONTHS=6

PLAYWRIGHT_BROWSER_MODE=new-headless
DRY_RUN=false
ENABLE_SHEETS_WRITE=true
LOG_LEVEL=info
TZ=Asia/Seoul
```

규칙:

- 실제 `.env`는 커밋하지 않는다.
- `.env.example`에는 실제 값을 넣지 않는다.
- 필수 값은 브라우저 실행 전에 검증한다.
- 잘못된 날짜와 숫자 설정은 시작 단계에서 차단한다.
- 환경변수 전체를 로그에 출력하지 않는다.
- 실제 비밀번호나 인증키를 코드에 하드코딩하지 않는다.

---

## Playwright 규칙

기본 컨텍스트:

```ts
{
  viewport: {
    width: 1280,
    height: 900,
  },
  deviceScaleFactor: 1,
  locale: "ko-KR",
  timezoneId: "Asia/Seoul",
}
```

운영 기본값은 headless다. headed 모드는 디버깅 목적으로만 허용한다.

선택자 우선순위:

1. 고유한 `id`
2. `name`
3. `label`
4. `placeholder`
5. 안정적인 속성
6. CSS 구조
7. 텍스트

일반 입력 요소에는 좌표 클릭을 사용하지 않는다.

### 이미지 키패드

1. 키패드 컨테이너를 locator로 찾는다.
2. 이미지 로딩 완료를 확인한다.
3. `boundingBox()`를 구한다.
4. 키패드 내부 상대 좌표 비율을 사용한다.
5. viewport와 device scale을 고정한다.
6. 가능한 경우 입력 자릿수를 검증한다.
7. 키패드 크기나 구조가 예상과 다르면 즉시 중단한다.

페이지 전체 기준 절대 좌표를 사용하지 않는다. 키패드 구조가 변경되면 자동 추측하거나 보안 통제를 우회하지 않는다.

### 대기

조회 완료를 고정된 timeout 하나로 판단하지 않는다.

다음 상태 중 하나를 기다린다.

- 정상 결과
- 거래 없음
- 인증 오류
- 은행 점검
- 페이지 구조 변경
- timeout

---

## 거래 데이터 모델

```ts
export interface Transaction {
  sourceKey: string;
  bank: "KB";
  accountId: string;
  occurredAt: string;
  transactionType: string | null;
  description: string;
  memo: string | null;
  withdrawal: number;
  deposit: number;
  balance: number | null;
  branch: string | null;
  collectedAt: string;
}
```

규칙:

- `accountId`는 전체 계좌번호 대신 `KB-1234` 형태로 저장한다.
- `occurredAt`은 한국 시간대가 포함된 ISO 8601 문자열이다.
- 금액은 숫자로 저장한다.
- 없는 선택 필드는 `null`을 사용한다.
- `collectedAt`은 sourceKey에 포함하지 않는다.

---

## 정규화 및 검증

문자열:

- 앞뒤 공백 제거
- 연속 공백 축소
- 제어문자 제거
- 빈 문자열과 `null` 처리 방식 통일

금액:

- 쉼표
- `원`
- 공백
- `-`
- 빈 문자열
- 음수 표현

숫자 변환 실패 시 임의로 0을 넣지 않는다.

날짜:

- 한국 시간대로 해석한다.
- ISO 8601 문자열로 변환한다.
- 유효하지 않은 날짜는 오류로 처리한다.

다음 상황에서는 시트 쓰기를 중단한다.

- 필수 필드 배열 길이 불일치
- 날짜 변환 실패
- 금액 변환 실패
- 필수 적요 누락
- 입금액과 출금액이 동시에 비정상적으로 존재
- 예상하지 못한 DOM 구조

---

## sourceKey

은행이 안정적인 고유 거래번호를 제공하면 이를 우선 사용한다.

없다면 다음 필드를 정규화한 뒤 SHA-256 해시를 생성한다.

```text
bank
accountId
occurredAt
transactionType
description
memo
withdrawal
deposit
balance
branch
```

포함하지 않는 값:

- collectedAt
- 조회 기간
- 시트 행 번호
- 실행 시각
- 서버 정보
- 로그 ID

sourceKey 규칙은 기존 시트와의 호환성에 직접 영향을 준다. 임의로 변경하지 않는다. 변경이 필요하면 마이그레이션 영향을 먼저 문서화한다.

---

## Google Sheets 규칙

기본 시트 이름은 `거래내역`이다.

```text
A: 거래 일시
B: 거래처 ← memo
C: 거래 유형
D: 거래 기관
E: 거래 금액
F: 거래 후 잔액
G: 적요 ← description
H: 증빙
I: 비고
J: 계좌식별자
K: 수집시각
L: sourceKey
```

규칙:

- 첫 행은 헤더다.
- L열은 중복 판정용이다.
- 헤더가 예상과 다르면 자동 수정하지 않는다.
- 사용자가 정렬했을 수 있으므로 마지막 행을 최신 거래로 가정하지 않는다.
- 모든 유효한 거래일 중 최댓값을 계산한다.
- 신규 거래는 한 요청으로 일괄 추가한다.
- 신규 거래가 없으면 append API를 호출하지 않는다.
- 기존 행을 자동 삭제하거나 수정하지 않는다.
- 기존 중복 sourceKey가 있으면 경고만 남긴다.

---

## 중복 처리

DB를 사용하지 않는다.

중복 방지는 세 단계로 수행한다.

1. 현재 스크래핑 결과 내부에서 sourceKey 중복 제거
2. Google Sheets의 기존 sourceKey Set과 비교
3. Linux `flock`으로 동시 실행 방지

기존 거래가 있으면 최신 거래일에서 기본 3일 전부터 다시 조회한다. 기존 거래가 없으면 기본 6개월을 조회한다.

append 요청이 실패했지만 실제 저장 여부가 불확실하면 다음 순서로 처리한다.

```text
L열 재조회
→ 실제 저장된 sourceKey 제외
→ 아직 없는 거래만 한 번 재시도
```

Google 인증 오류나 권한 오류는 재시도하지 않는다.

---

## 오류 상태

```ts
type SyncRunStatus =
  | "success"
  | "no_new_transactions"
  | "dry_run"
  | "skipped_already_running"
  | "bank_maintenance"
  | "authentication_failed"
  | "page_structure_changed"
  | "google_auth_failed"
  | "google_append_failed"
  | "network_failed"
  | "validation_failed"
  | "unknown_failed";
```

제한적으로 재시도 가능한 오류:

- DNS 오류
- 네트워크 timeout
- Google API 5xx
- KB 페이지의 일시적 로딩 실패

재시도하지 않는 오류:

- 은행 인증 실패
- 계좌정보 오류
- Google 인증 및 권한 오류
- 키패드 구조 변경
- 거래내역 DOM 변경
- 데이터 검증 실패

---

## 보안

절대 로그에 남기지 않는 값:

- 웹 비밀번호
- 계좌번호 전체
- 생년월일 전체
- Google 서비스 계정 키
- 환경변수 전체
- 거래내역 전체 원문
- 전체 페이지 HTML
- 민감정보가 포함된 스크린샷

운영 서버:

- `.env` 권한 `600`
- 인증 JSON 권한 `600`
- SSH 키 인증 사용
- 외부 공개 포트 불필요
- root 직접 로그인 비활성화 권장
- SSH 비밀번호 로그인 비활성화 권장
- OS 보안 업데이트 유지
- Docker 그룹 권한 주의

Trace, HTML, 스크린샷 저장은 운영 환경에서 기본 비활성화한다.

---

## 로그

pino 기반 구조화 로그를 사용한다.

예시:

```json
{
  "status": "success",
  "lookupStartDate": "2026-07-12",
  "lookupEndDate": "2026-07-15",
  "existingRowCount": 120,
  "scrapedCount": 8,
  "uniqueScrapedCount": 8,
  "insertedCount": 1,
  "durationMs": 12000
}
```

로그 허용 항목:

- 실행 시각과 소요 시간
- 조회 기간
- 마스킹된 계좌 식별자
- 조회 및 삽입 건수
- 오류 유형
- 실패 단계
- 현재 URL
- 주요 선택자 존재 여부
- API 상태 코드

거래 상세 내용은 기본 로그에 출력하지 않는다.

---

## 테스트

변경 전후 관련 테스트를 실행한다.

필수 테스트 범위:

### 정규화

- 금액 문자열
- 빈 값
- 날짜 변환
- 공백 정규화
- null 처리
- 잘못된 값 거부

### sourceKey

- 동일 거래는 같은 키
- 수집 시각이 달라도 같은 키
- 금액 또는 잔액이 다르면 다른 키
- 공백 차이 정규화
- null과 빈 문자열 처리

### 파서

- 거래별 공통 부모 구조
- 필드별 배열 구조
- 배열 길이 불일치
- 거래 0건
- 필드 누락

### Google Sheets

- 빈 시트
- 헤더만 존재
- 기존 거래 존재
- 정렬된 시트
- 빈 sourceKey
- 중복 sourceKey
- 잘못된 날짜
- append 성공
- append 실패 후 재조회
- 일부 저장 후 재시도

### 동기화

- 전체 거래가 기존 데이터
- 신규 거래 한 건 및 여러 건
- 실행 내부 중복
- Dry-run
- 신규 거래 없음

실제 비밀번호를 반복해서 틀리는 방식으로 인증 오류를 시험하지 않는다.

---

## Fixture

fixture에는 실제 개인정보를 포함하지 않는다.

반드시 제거하거나 대체할 값:

- 계좌번호
- 이름
- 생년월일
- 거래 상대방
- 메모
- 실제 거래 금액
- 은행 내부 식별번호
- 인증 토큰

실제 DOM 구조는 유지하되 데이터는 가상 값으로 치환한다.

---

## Docker

- Playwright 공식 이미지를 사용한다.
- 프로젝트 Playwright 버전과 이미지 버전을 일치시킨다.
- `npm ci`를 사용한다.
- `.env`와 인증 JSON을 이미지에 복사하지 않는다.
- `TZ=Asia/Seoul`을 설정한다.
- `shm_size`는 최소 1GB다.
- 자동 재시작 정책을 사용하지 않는다.
- 컨테이너는 한 번 실행한 뒤 종료한다.
- 외부 포트를 열지 않는다.
- 컨테이너의 Ubuntu와 Windows·macOS·Linux 호스트를 구분한다.
- Compose는 호스트 서비스 계정 경로를 volume source로 사용하고 컨테이너에는 `/run/secrets/google-service-account.json`을 전달한다.

Docker 이미지 빌드뿐 아니라 실제 컨테이너 실행도 검증한다.

---

## 플랫폼별 자동 실행

공통 실행은 `npm run sync` 또는 `docker compose run --rm kb-sync`다.

- Windows: `deploy/windows/run-sync.ps1`, 작업 스케줄러, named mutex
- macOS: `deploy/macos/run-sync.sh`, launchd, mkdir 잠금
- Linux: `scripts/run-sync.sh`, systemd timer, `flock`
- Cloud Run Jobs: Cloud Scheduler와 `docs/cloud-run-deployment.md`

### Linux systemd 및 실행 스크립트

서비스 조건:

- `Type=oneshot`
- 전용 일반 사용자
- 프로젝트 디렉터리 명시
- `scripts/run-sync.sh` 호출
- 네트워크 이후 실행
- 무한 재시작 금지
- 적절한 timeout

기본 일정은 한국 시간 기준 매일 04:10이며 최대 5분의 임의 지연을 적용한다.

동시 실행은 `flock`으로 막는다. 수동 실행과 자동 실행은 동일한 스크립트를 사용한다.

---

## 명령어

가능하면 다음 npm 스크립트를 유지한다.

```json
{
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint .",
    "check": "npm run lint && npm test && npm run build",
    "sync": "node dist/index.js",
    "dev": "tsx src/index.ts"
  }
}
```

기본 검증:

```bash
npm ci
npm run lint
npm test
npm run build
npm run check
docker build -t kb-bank-sync:0.1.0 .
```

서버 명령:

```bash
./scripts/run-sync.sh
./scripts/run-sync.sh --dry-run
./scripts/run-sync.sh --from 2026-07-01 --to 2026-07-15
./scripts/status.sh
```

Docker Compose 서비스명은 `kb-sync`, 이미지명은 `kb-bank-sync:0.1.0`이다. Linux 배포 절차는 `docs/server-deployment.md`를 따른다.

---

## 코드 스타일

- TypeScript strict 모드를 유지한다.
- `any` 사용을 피한다.
- 외부 입력은 검증한다.
- 함수는 한 가지 책임만 갖게 한다.
- 긴 함수는 단계별 함수로 분리한다.
- 빈 `catch` 블록을 만들지 않는다.
- 비즈니스 로직에서 `console.log` 대신 logger를 사용한다.
- 선택자와 문자열 상수를 중복 작성하지 않는다.
- 코드와 문서의 명칭을 일치시킨다.

---

## 변경 시 특별 주의 대상

### `src/config/selectors.ts`

선택자 변경 시 다음을 확인한다.

- 로컬 headed 실행
- 서버 headless 실행
- 거래 없음 화면
- 오류 및 점검 화면
- iframe 여부
- 키패드 크기와 위치

### `src/transaction/fingerprint.ts`

sourceKey 변경은 기존 시트 중복 판정에 영향을 준다. 호환성 분석 없이 변경하지 않는다.

### `src/spreadsheet/sheet-mapper.ts`

열 순서 변경 시 기존 시트, 헤더 검증, README를 함께 수정한다.

### `scripts/run-sync.sh`

수동 실행과 systemd 실행의 공통 진입점이다. 인수 전달, `flock`, 종료 코드를 함께 검증한다.

---

## 금지 사항

- 실제 비밀번호 하드코딩
- `.env` 커밋
- 인증키 커밋
- 실제 계좌번호를 fixture에 저장
- 실제 거래내역 전체를 로그에 출력
- 은행 보안 절차 우회
- 인증 오류 무한 재시도
- 파서 오류 상태에서 일부 거래 저장
- DB 추가
- 외부 공개 API 서버 추가
- 요청 없는 프레임워크 교체
- 기존 시트 데이터 자동 삭제
- 설명 없는 sourceKey 변경
- 검증하지 않은 작업을 성공으로 보고

---

## 변경 작업 절차

1. 관련 파일과 현재 동작을 확인한다.
2. 변경 범위를 최소화한다.
3. 필요한 테스트를 추가하거나 수정한다.
4. 코드를 변경한다.
5. lint를 실행한다.
6. 테스트를 실행한다.
7. TypeScript 빌드를 실행한다.
8. 필요하면 Docker 빌드와 Dry-run을 실행한다.
9. 민감정보 출력 여부를 확인한다.
10. 변경 및 검증 결과를 보고한다.

실행할 수 없는 검증은 이유를 명시한다.

---

## 완료 기준

요청 범위에 따라 다음 조건을 충족해야 한다.

- 관련 코드 구현 완료
- 관련 테스트 추가 또는 수정
- 테스트 통과
- TypeScript 빌드 통과
- lint 통과
- 민감정보 노출 없음
- 기존 동기화 흐름 훼손 없음
- Dry-run에서 시트 수정 없음
- 중복 처리 유지
- 문서와 `.env.example` 최신화
- 실제 검증하지 못한 항목 명시

은행 페이지나 Google 계정에 접근할 수 없다면 mock 테스트와 정적 검증까지만 완료했다고 보고한다.

---

## 작업 완료 보고 형식

```text
1. 작업 요약
2. 생성한 파일
3. 수정한 파일
4. 주요 구현 내용
5. 보안상 주의한 부분
6. 실행한 명령
7. 테스트 결과
8. 빌드 결과
9. Docker 또는 Dry-run 결과
10. 실제 검증하지 못한 항목
11. 남아 있는 위험 요소
```

---

## 최종 우선순위

```text
민감정보 보호
> 잘못된 거래 저장 방지
> 중복 방지
> 페이지 구조 변경 감지
> 자동 실행 안정성
> 구현 편의성
```

파싱 결과가 불확실하면 저장하지 않는다.

인증 상태가 불확실하면 재시도하지 않는다.

중복 여부가 불확실하면 시트를 다시 읽고 확인한다.

검증하지 않은 결과는 성공으로 간주하지 않는다.
