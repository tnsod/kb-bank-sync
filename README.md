# kb-bank-sync

## 프로젝트 개요

KB국민은행 빠른조회 페이지에 조회 요청만 수행해 거래내역을 수집하고, Google Sheets에 없는 신규 거래만 append하는 일회성 배치 프로그램이다. 송금·이체·계좌 설정, 별도 데이터베이스, 외부 HTTP 서버는 제공하지 않는다.

핵심 TypeScript 코드는 특정 데스크톱 운영체제에 종속되지 않는다. Node.js로 Windows·macOS·Linux에서 직접 실행하거나, 같은 Ubuntu 기반 컨테이너 이미지를 Windows·macOS·Linux 및 Google Cloud Run Jobs에서 실행할 수 있다. Docker 컨테이너의 Ubuntu는 호스트 운영체제와 별개이며 호스트가 Ubuntu일 필요는 없다.

Google Sheets가 최종 저장소이자 실행 간 중복 판정 기준이다. 일반 동기화는 기존 거래 행과 사용자가 작성한 H열 `증빙`, I열 `비고`를 수정하지 않는다.

## 동작 흐름

```text
환경변수 검증
→ Google Sheets 기존 sourceKey와 최신 거래일 조회
→ 조회 기간 계산
→ KB 빠른조회 접속 및 이미지 키패드 입력
→ 거래 DOM 파싱·정규화·검증
→ sourceKey 생성 및 실행 내부 중복 제거
→ 기존 sourceKey 제외
→ 신규 거래만 시간순 일괄 append
→ 실행 요약 출력 후 종료
```

파싱 결과, 페이지 구조, 인증 상태가 불확실하면 시트 쓰기를 중단한다. 인증 실패는 반복 재시도하지 않으며 append 결과만 불확실한 경우 L열 sourceKey를 다시 읽어 한 번 복구한다.

## 기술 스택

- Node.js 22 이상, TypeScript, npm
- Playwright 1.61.1
- Zod, dayjs, pino, Google Sheets API
- Docker 및 Docker Compose
- 선택적 Linux 배포: Ubuntu, systemd timer, `flock`
- Windows 자동 실행: 작업 스케줄러
- macOS 자동 실행: launchd
- 서버리스 배포: Google Cloud Run Jobs + Cloud Scheduler

## 지원 환경

| 환경 | 직접 실행 | Docker 실행 | 자동 실행 방식 |
|---|---:|---:|---|
| Windows 10/11 | 지원 | 지원 | 작업 스케줄러 |
| macOS | 지원 | 지원 | launchd |
| Ubuntu Linux | 지원 | 지원 | systemd timer |
| Google Cloud Run Jobs | 해당 없음 | 지원 | Cloud Scheduler |

여기서 “지원”은 저장소가 해당 실행·배포 구성을 제공한다는 뜻이다. CI는 Node.js 코드를 Windows·macOS·Ubuntu에서 검증하지만, 실제 작업 스케줄러·launchd·systemd 등록과 각 운영체제의 Docker Desktop 동작은 대상 장비에서 별도로 확인해야 한다.

- Windows 경로와 PowerShell 명령은 Windows 호스트용 예시다.
- `systemd`, `flock`, `/opt/kb-bank-sync`는 Linux 자동 실행 전용이다.
- launchd 구성은 macOS 사용자 LaunchAgent 전용이며 Linux `flock`을 사용하지 않는다.
- 작업 스케줄러 구성은 Windows 사용자 로그인 세션 전용이다.
- Cloud Scheduler는 Cloud Run Job 전용이며 Docker Compose를 사용하지 않는다.

## 요구 버전

공식 최소 Node.js 버전은 `package.json`, `.nvmrc`, `.node-version`에 맞춘 22다.

```bash
nvm use
npm ci
```

Windows에서 nvm을 사용하지 않는다면 Node.js 22 이상을 직접 설치한다. 직접 실행에는 호스트용 Playwright 브라우저 설치가 필요할 수 있다. Docker 실행은 Playwright 공식 Ubuntu 이미지를 사용하므로 호스트 Node 및 Linux 배포판과 분리된다.

## 환경변수 설정

`.env.example`을 `.env`로 복사하고 실제 값은 `.env`에만 입력한다.

```bash
cp .env.example .env
```

주요 설정:

- `GOOGLE_SPREADSHEET_ID`: Spreadsheet URL에 포함된 파일 ID
- `GOOGLE_SHEET_NAME`: Spreadsheet 파일명이 아니라 하단 워크시트 탭 이름
- `GOOGLE_SERVICE_ACCOUNT_KEY_PATH`: 직접 실행에서는 현재 호스트의 키 파일 경로, Compose에서는 volume source로 사용할 호스트 경로
- `SYNC_OVERLAP_DAYS`: 오늘 기준 N일이 아니라 시트 최신 거래일에서 N일을 뺀 재조회 시작 범위
- `INITIAL_LOOKBACK_MONTHS`: 기존 거래가 없을 때의 최초 조회 개월 수
- `PLAYWRIGHT_BROWSER_MODE`: `default-headless`, `new-headless`, `headed` 중 하나
- `DRY_RUN`, `ENABLE_SHEETS_WRITE`: 실제 append를 함께 제어하는 이중 안전장치

서비스 계정 경로 예시:

```text
Windows 직접 실행:       C:\secure\google-service-account.json
Windows Docker Compose: C:/secure/google-service-account.json
macOS:                  /Users/USERNAME/secure/google-service-account.json
Linux:                  /opt/kb-bank-sync/secrets/google-service-account.json
Docker/Cloud Run 내부:  /run/secrets/google-service-account.json
```

Windows Docker Compose에서는 `C:/...` 형식을 권장한다. macOS와 Linux는 POSIX 절대경로를 사용한다. Node.js 코드는 경로 구분자를 임의 변환하지 않고 현재 OS의 `node:path` 규칙으로 절대·상대경로를 처리한다. PowerShell 프로세스 환경변수는 `.env`보다 우선한다.

Compose 변수 치환은 `.env`의 호스트 경로를 volume source로 사용하고, 컨테이너 환경변수는 `/run/secrets/google-service-account.json`으로 재정의한다. 컨테이너 안에서 호스트 경로를 직접 사용하지 않는다.

안전한 조회 테스트:

```env
DRY_RUN=true
ENABLE_SHEETS_WRITE=false
```

실제 운영 업데이트:

```env
DRY_RUN=false
ENABLE_SHEETS_WRITE=true
```

Dry-run도 설정에 따라 실제 KB 조회와 Google Sheets 읽기를 수행하지만 append는 하지 않는다.

## 워크시트 구조

현재 워크시트의 논리적 구조는 A:L이다.

- A:I는 사용자에게 표시되는 거래 정보 및 직접 입력 영역이다.
- J:L은 계좌 식별, 수집 시각, 중복 판정에 사용하는 숨김 시스템 열이다.

```text
A 거래 일시
B 거래처          ← memo
C 거래 유형
D 거래 기관
E 거래 금액        ← 입금 양수, 출금 음수
F 거래 후 잔액
G 적요            ← description
H 증빙            ← 사용자 입력
I 비고            ← 사용자 입력
J 계좌식별자
K 수집시각
L sourceKey
```

일반 동기화는 기존 H/I를 덮어쓰지 않는다. sourceKey canonical 필드 순서는 다음과 같다.

```text
bank, accountId, occurredAt, transactionType, description, memo,
withdrawal, deposit, balance, branch
```

## 공통 실행 방법

직접 Node.js 실행은 모든 데스크톱 지원 OS에서 같다.

```bash
npm ci
npm run build
npm run sync
```

Docker Compose 실행도 Docker Desktop 또는 Docker Engine이 있는 호스트에서 공통이다.

```bash
docker compose build
docker compose run --rm kb-sync
```

Compose 서비스명은 `kb-sync`, 이미지명은 `kb-bank-sync:0.1.0`이다. 자동 실행 래퍼는 이 공통 Compose 명령을 호출하지만 플랫폼별 잠금과 스케줄러는 서로 다르다.

## Windows

직접 실행:

```powershell
cd C:\kb-bank-sync
npm ci
npm run build
npm run sync
```

Docker 실행 및 작업 스케줄러 래퍼 사전 검증:

```powershell
docker compose build
.\deploy\windows\run-sync.ps1 -ValidateOnly
```

작업 스케줄러는 현재 사용자가 로그인한 세션에서 매일 04:10 실행되도록 등록된다. Docker Desktop이 실행 중이어야 한다.

```powershell
.\deploy\windows\register-task.ps1
# 기존 작업을 명시적으로 갱신할 때만:
.\deploy\windows\register-task.ps1 -Force

.\deploy\windows\unregister-task.ps1
```

등록 스크립트는 동기화를 즉시 실행하지 않는다. `run-sync.ps1`은 named mutex `Local\KbBankSync`로 중복 실행을 막고 시작·종료·상태·종료 코드만 `logs/windows-scheduler.log`에 기록한다.

## macOS

직접 Node.js 또는 Docker Compose 명령은 공통 실행 방법과 같다. 사용자 LaunchAgent 설치 전 실행 권한과 Docker Desktop 상태를 확인한다.

```zsh
chmod 755 deploy/macos/*.sh
deploy/macos/install-launch-agent.sh
# 기존 구성을 명시적으로 갱신할 때만:
deploy/macos/install-launch-agent.sh --force

deploy/macos/uninstall-launch-agent.sh
```

LaunchAgent label은 `com.kb-bank-sync.daily`이며 매일 04:10 실행된다. 설치 과정은 동기화를 즉시 실행하지 않는다. macOS에는 기본 `flock`이 없으므로 `run-sync.sh`가 `.sync-lock` 디렉터리를 원자적으로 생성해 중복 실행을 막는다.

제약:

- Mac이 켜져 있고 사용자 계정에 로그인돼 있어야 한다.
- Docker Desktop이 실행 중이어야 한다.
- 잠자기 상태에서는 예약 실행이 누락될 수 있다.
- MacBook은 전원 연결 및 잠자기 설정을 확인한다.

## Linux

Linux 전용 자동 실행 파일은 다음과 같다.

- `scripts/run-sync.sh`: `flock` 기반 Compose 실행
- `scripts/status.sh`: systemd, journal, 이미지와 Compose 상태 확인
- `deploy/systemd/`: oneshot service와 매일 04:10 timer

이 파일들은 Linux 자동 실행에만 필요하며 Windows·macOS 직접 실행이나 핵심 TypeScript 코드의 요구사항이 아니다. 기본 설치 경로는 `/opt/kb-bank-sync`, 예시 사용자는 `ubuntu`다. 자세한 절차는 [Linux 서버 배포](docs/server-deployment.md)를 따른다.

## Google Cloud Run Jobs

Cloud Run은 Dockerfile로 만든 이미지를 Job으로 실행한다. Docker Compose, systemd, launchd, 작업 스케줄러, `flock`은 사용하지 않으며 Cloud Scheduler가 Job API를 호출한다.

권장 시작값은 `asia-northeast3`, 작업 1개, 재시도 0, timeout 15분, CPU 1, 메모리 2GiB다. `.env`와 Google 서비스 계정 JSON은 Secret Manager 파일로 각각 `/app/.env`, `/run/secrets/google-service-account.json`에 마운트한다.

전체 명령, IAM, Secret, Dry-run, Scheduler, 재배포 및 네트워크 제한은 [Cloud Run Jobs 배포 문서](docs/cloud-run-deployment.md)를 따른다.

Cloud Run의 외부 송신 IP는 기본적으로 고정되지 않으며 Docker Compose의 `shm_size`도 적용되지 않는다. Chromium launch 옵션에는 기존 모드를 유지하면서 `--disable-dev-shm-usage`를 병합한다. 실제 리전 배포 후 Dry-run으로 Chromium과 KB 접속을 확인해야 한다.

## 시트 초기화 및 마이그레이션

다음 명령은 일반 동기화와 분리된 명시적 쓰기 작업이다.

```bash
npm run sync -- --initialize-sheet
npm run sync -- --migrate-sheet-layout
npm run sync -- --swap-counterparty-description
```

- `--initialize-sheet`: 빈 신규 워크시트에 A:L 헤더와 서식을 적용한다.
- `--migrate-sheet-layout`: 구형 A:K를 백업 후 A:L로 변환한다.
- `--swap-counterparty-description`: 기존 12열 시트의 B/G를 백업 후 교환한다.

B/G 마이그레이션은 Developer Metadata `kb_bank_sync_layout_mapping_version=2`로 재실행을 차단한다. 일반 동기화는 위 명령을 자동 실행하지 않는다.

## Docker 실행

```bash
docker build -t kb-bank-sync:0.1.0 .
docker compose build
docker compose run --rm kb-sync
```

이미지는 Ubuntu 기반이지만 호스트는 Windows·macOS·Linux일 수 있다. `.env`와 서비스 계정 JSON은 COPY하지 않으며 Compose가 런타임에 읽기 전용으로 마운트한다. 외부 포트와 자동 재시작 정책은 사용하지 않는다.

Cloud Run에서는 Compose를 사용하지 않고 Artifact Registry의 동일 Dockerfile 이미지로 Job을 배포한다.

## 테스트 및 빌드

```bash
npm ci
npm run lint
npm test
npm run build
npm run check
docker build -t kb-bank-sync:0.1.0 .
```

CI는 Node.js 22에서 Ubuntu·Windows·macOS matrix로 `npm run check`를 실행한다. Docker 빌드와 Linux 정적 검증은 별도 Ubuntu job, PowerShell 구문 검사는 Windows, zsh/plist 검사는 macOS에서 수행한다. CI는 스케줄러 등록이나 실제 KB/Google 접속을 실행하지 않는다.

## 문제 해결

- `.env file not found`: 실행 위치와 플랫폼 래퍼가 계산한 프로젝트 루트를 확인한다.
- Windows Docker bind 오류: `.env` 경로를 `C:/secure/google-service-account.json` 형식으로 바꾼다.
- `Docker Desktop is not running`: 데스크톱 앱과 `docker info`를 확인한다.
- 서비스 계정 오류: 직접 실행은 호스트 경로, 컨테이너는 `/run/secrets/google-service-account.json`인지 구분한다.
- 헤더 불일치: 실제 워크시트 탭 이름과 A:L 헤더를 확인하고 자동 수정하지 않는다.
- Linux timer 오류: systemd status, journal, Docker 그룹 권한과 `/opt/kb-bank-sync` 경로를 확인한다.
- macOS 예약 누락: 로그인·Docker Desktop·잠자기·LaunchAgent 상태를 확인한다.
- Windows 예약 누락: 사용자 로그인 세션, Docker Desktop, 작업 기록을 확인한다.
- Cloud Run 실행 실패: Cloud Logging, Secret 권한, Chromium 메모리와 KB 네트워크 접근을 확인한다.

## 보안 운영 참고

인증정보 저장 위치, Linux 권한, 키 유출 대응은 [SECURITY.md](SECURITY.md)를 따른다. `.env`와 `secrets/`는 이미지와 버전 관리에서 제외하며 실제 값을 문서·fixture·스케줄러 명령에 넣지 않는다.

은행 페이지 구조와 과거 진단 이력은 [페이지 구조 문서](docs/page-structure.md)와 `docs/history/`에서 관리한다.

## 라이선스

MIT