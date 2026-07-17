# Security

이 문서는 운영 서버에서 KB 빠른조회 및 Google Sheets 인증정보를 안전하게 관리하기 위한 지침이다.

## 인증정보 관리

- KB 계좌번호, 생년월일, 웹 비밀번호를 코드·fixture·문서에 하드코딩하지 않는다.
- Google 서비스 계정 JSON의 경로만 `GOOGLE_SERVICE_ACCOUNT_KEY_PATH`로 전달한다.
- 운영 로그에 인증값, 환경변수 전체, 실제 거래 상세를 출력하지 않는다.
- 서비스 계정에는 동기화 대상 Spreadsheet만 공유하고 불필요한 Google 리소스 권한을 부여하지 않는다.
- `.env`와 서비스 계정 JSON은 Docker 이미지에 복사하지 않고 런타임에 전달한다.

## 권장 저장 위치

- Windows 로컬: `C:\secure\google-service-account.json`
- macOS 로컬: `/Users/USERNAME/secure/google-service-account.json`
- Linux 서버: `/opt/kb-bank-sync/secrets/google-service-account.json`
- Docker 및 Cloud Run 컨테이너: `/run/secrets/google-service-account.json`

Linux의 `secrets/`는 서버 내부 런타임 파일 위치이며 소스코드에 고정된 인증 경로가 아니다. Compose가 호스트 파일을 컨테이너 경로에 읽기 전용으로 마운트한다.
Cloud Run에서는 Secret Manager가 같은 컨테이너 경로에 파일을 마운트한다. 호스트 OS 경로를 컨테이너 환경변수로 직접 전달하지 않는다.

## Linux 권한

```bash
chmod 600 /opt/kb-bank-sync/.env
chmod 700 /opt/kb-bank-sync/secrets
chmod 600 /opt/kb-bank-sync/secrets/google-service-account.json
```

Docker 실행 권한은 사실상 높은 시스템 권한이므로 운영 사용자를 필요한 그룹에만 추가하고 Docker 소켓 접근을 제한한다.

## 유출 또는 오작동 대응

1. `kb-bank-sync.timer`를 중지해 자동 실행을 일시 중지한다.
2. Google Cloud에서 노출된 서비스 계정 키를 폐기하고 새 키를 발급한다.
3. KB 빠른조회 웹 비밀번호를 변경한다.
4. Spreadsheet 공유 대상과 서비스 계정 권한을 점검한다.
5. 최근 systemd journal과 애플리케이션 로그에서 비정상 실행 시각과 오류 유형을 확인한다.

```bash
sudo systemctl disable --now kb-bank-sync.timer
journalctl -u kb-bank-sync.service -n 100 --no-pager
```
