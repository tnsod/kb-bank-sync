# Linux 서버 배포

이 문서는 Ubuntu 서버의 `/opt/kb-bank-sync`에 프로젝트를 배치하고 Docker Compose와 systemd timer로 하루 한 번 실행하는 절차를 설명한다. 예시 사용자는 `ubuntu`, Compose 서비스명은 `kb-sync`, 이미지명은 `kb-bank-sync:0.1.0`이다.

## 1. 프로젝트 배치

```bash
sudo mkdir -p /opt/kb-bank-sync
sudo chown -R ubuntu:ubuntu /opt/kb-bank-sync
cd /opt/kb-bank-sync
chmod 755 scripts/docker-entrypoint.sh scripts/run-sync.sh scripts/status.sh
```

서버 사용자가 `ubuntu`가 아니면 소유자와 systemd 서비스의 `User`, `Group`을 실제 일반 사용자로 변경한다.

## 2. 런타임 설정과 권한

`.env.example`을 참고해 `/opt/kb-bank-sync/.env`를 만들고 서비스 계정 JSON을 서버 런타임 디렉터리에 둔다.

```bash
mkdir -p /opt/kb-bank-sync/secrets
chmod 600 /opt/kb-bank-sync/.env
chmod 700 /opt/kb-bank-sync/secrets
chmod 600 /opt/kb-bank-sync/secrets/google-service-account.json
```

`.env`의 호스트 경로는 다음과 같이 지정한다.

```env
GOOGLE_SERVICE_ACCOUNT_KEY_PATH=/opt/kb-bank-sync/secrets/google-service-account.json
```

Compose가 이 파일을 컨테이너의 `/run/secrets/google-service-account.json`에 읽기 전용으로 마운트한다. Linux의 `secrets/`는 서버 런타임 위치이며 이미지나 소스코드에 포함하지 않는다.

## 3. Docker 빌드

```bash
cd /opt/kb-bank-sync
docker compose build
docker image inspect kb-bank-sync:0.1.0
```

Docker 실행 사용자는 Docker 데몬에 접근할 수 있어야 한다. `docker` 그룹 권한은 사실상 높은 시스템 권한이므로 필요한 사용자에게만 부여한다.

## 4. Dry-run 검증

먼저 `.env`를 안전 모드로 설정한다.

```env
DRY_RUN=true
ENABLE_SHEETS_WRITE=false
```

그 다음 수동으로 한 번 실행한다.

```bash
docker compose run --rm kb-sync
```

Dry-run도 실제 KB 조회와 Google Sheets 읽기를 수행할 수 있지만 append는 하지 않는다. 운영 전에는 로그에 인증값이나 거래 상세가 출력되지 않는지 확인한다.

## 5. 실제 운영 설정

Dry-run 검증 후에만 두 값을 함께 변경한다.

```env
DRY_RUN=false
ENABLE_SHEETS_WRITE=true
```

수동 실행과 timer는 모두 `scripts/run-sync.sh`를 사용한다. 이 스크립트가 `flock`으로 동시 실행을 차단한다.

## 6. systemd 설치

```bash
sudo cp deploy/systemd/kb-bank-sync.service /etc/systemd/system/
sudo cp deploy/systemd/kb-bank-sync.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kb-bank-sync.timer
```

기본 서비스는 `User=ubuntu`, `Group=ubuntu`, 설치 경로 `/opt/kb-bank-sync`를 사용한다. 다른 환경에서는 다음 항목을 설치 전에 수정한다.

- `User`, `Group`
- `WorkingDirectory`
- `ExecStart`

## 7. 예약과 수동 실행

timer는 KST 기준 매일 04:10에 실행하며 최대 5분의 임의 지연이 적용된다. 예약 시각에 서버가 꺼져 있었으면 `Persistent=true`에 의해 부팅 후 누락 실행을 시작한다.

```bash
systemd-analyze calendar '*-*-* 04:10:00 Asia/Seoul'
sudo systemctl start kb-bank-sync.service
sudo systemctl status kb-bank-sync.service --no-pager
systemctl list-timers kb-bank-sync.timer --no-pager
```

배포판의 systemd가 `OnCalendar` 시간대 문법을 지원하지 않으면 서버 시간대를 먼저 설정하고 timer에서 시간대 접미사를 제거한다.

```bash
sudo timedatectl set-timezone Asia/Seoul
# OnCalendar=*-*-* 04:10:00
```

## 8. 로그와 상태 확인

```bash
journalctl -u kb-bank-sync.service -n 100 --no-pager
KB_BANK_SYNC_DIR=/opt/kb-bank-sync ./scripts/status.sh
```

## 9. 자동 실행 중지

```bash
sudo systemctl disable --now kb-bank-sync.timer
```

인증정보 유출이나 반복 오류가 의심되면 timer를 먼저 중지한 뒤 [SECURITY.md](../SECURITY.md)의 대응 절차를 따른다.
