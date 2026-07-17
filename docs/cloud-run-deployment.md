# Google Cloud Run Jobs 배포

Cloud Run Jobs는 컨테이너를 한 번 실행하고 종료하는 이 프로젝트의 배치 모델과 맞는다. Cloud Run에서는 `docker-compose.yml`, systemd, launchd, Windows 작업 스케줄러, `flock`을 사용하지 않는다. 작업 수를 1로 고정하고 Cloud Scheduler가 Job 실행 API를 호출한다.

공식 참고 문서:

- [Cloud Run Job 생성](https://cloud.google.com/run/docs/create-jobs)
- [Cloud Run Job Secret 구성](https://cloud.google.com/run/docs/configuring/jobs/secrets)
- [Cloud Run Job 실행](https://cloud.google.com/run/docs/execute/jobs)
- [Cloud Scheduler로 Job 예약 실행](https://cloud.google.com/run/docs/execute/jobs-on-schedule)

아래 명령은 배포 예시다. 프로젝트 ID, 프로젝트 번호, 서비스 계정과 Secret 이름을 실제 환경에 맞춰 검토한 뒤 실행한다.

## 1. 프로젝트와 API 준비

Google Cloud 프로젝트를 만들고 결제 계정을 연결한 뒤 CLI 프로젝트를 선택한다.

```bash
export PROJECT_ID="your-project-id"
export REGION="asia-northeast3"
export JOB_NAME="kb-bank-sync"
export REPOSITORY="kb-bank-sync"
export IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/kb-bank-sync:0.1.0"

gcloud config set project "$PROJECT_ID"
gcloud services enable \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  secretmanager.googleapis.com \
  cloudscheduler.googleapis.com
```

Cloud Build를 사용하지 않고 로컬에서 이미지를 빌드·push할 수도 있다. 어느 방식이든 결제 계정과 각 API를 사용할 IAM 권한이 필요하다.

## 2. Artifact Registry와 이미지

```bash
gcloud artifacts repositories create "$REPOSITORY" \
  --repository-format=docker \
  --location="$REGION"

gcloud builds submit --tag "$IMAGE" .
```

Cloud Run 이미지에 필요한 핵심 파일은 `Dockerfile`, `package.json`, `package-lock.json`, `src/`, `assets/`, `scripts/docker-entrypoint.sh`다. `.env`와 서비스 계정 키는 이미지에 포함하지 않는다.

## 3. Cloud Run 실행 서비스 계정

```bash
export RUN_SERVICE_ACCOUNT="kb-bank-sync-run@${PROJECT_ID}.iam.gserviceaccount.com"
gcloud iam service-accounts create kb-bank-sync-run \
  --display-name="KB Bank Sync Cloud Run Job"
```

이 서비스 계정은 Cloud Run 컨테이너의 실행 ID이며 Secret Manager secret을 읽는 최소 권한만 부여한다. Google Sheets에 실제로 접근하는 별도 서비스 계정 JSON은 기존 애플리케이션 요구사항에 따라 파일 Secret으로 마운트한다. 해당 Sheets 서비스 계정에는 대상 Spreadsheet만 공유한다.

## 4. Secret Manager 설정

Cloud Run용 `.env`는 호스트 경로 대신 컨테이너 경로를 사용해야 한다.

```env
GOOGLE_SERVICE_ACCOUNT_KEY_PATH=/run/secrets/google-service-account.json
PLAYWRIGHT_BROWSER_MODE=new-headless
TZ=Asia/Seoul
NODE_ENV=production
DRY_RUN=true
ENABLE_SHEETS_WRITE=false
```

Secret을 만든다.

```bash
gcloud secrets create kb-bank-sync-env --replication-policy=automatic
gcloud secrets versions add kb-bank-sync-env --data-file=.env.cloud-run

gcloud secrets create kb-bank-sync-google-key --replication-policy=automatic
gcloud secrets versions add kb-bank-sync-google-key \
  --data-file=/secure/path/google-service-account.json

gcloud secrets add-iam-policy-binding kb-bank-sync-env \
  --member="serviceAccount:${RUN_SERVICE_ACCOUNT}" \
  --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding kb-bank-sync-google-key \
  --member="serviceAccount:${RUN_SERVICE_ACCOUNT}" \
  --role="roles/secretmanager.secretAccessor"
```

서비스 계정 JSON의 내용을 환경변수로 넣지 않고 `/run/secrets/google-service-account.json` 파일로 마운트한다. Cloud Run Job의 secret volume은 실행 시 Secret Manager에서 값을 읽으며 Job에서는 2세대 실행 환경을 사용한다.

## 5. Job 배포

권장 시작값은 작업 수 1, 재시도 0, timeout 15분, CPU 1, 메모리 2GiB다. Chromium 메모리가 부족하면 4GiB로 올린다.

```bash
gcloud run jobs deploy "$JOB_NAME" \
  --image="$IMAGE" \
  --region="$REGION" \
  --service-account="$RUN_SERVICE_ACCOUNT" \
  --tasks=1 \
  --max-retries=0 \
  --task-timeout=15m \
  --cpu=1 \
  --memory=2Gi \
  --set-env-vars="GOOGLE_SERVICE_ACCOUNT_KEY_PATH=/run/secrets/google-service-account.json,PLAYWRIGHT_BROWSER_MODE=new-headless,TZ=Asia/Seoul,NODE_ENV=production" \
  --set-secrets="/app/.env=kb-bank-sync-env:latest,/run/secrets/google-service-account.json=kb-bank-sync-google-key:latest"
```

`--execute-now`를 넣지 않으므로 배포만으로 동기화가 실행되지 않는다. Cloud Run은 Docker Compose의 `shm_size`를 적용하지 않는다. 애플리케이션은 기존 Chromium launch 인자에 `--disable-dev-shm-usage`를 병합해 제한된 `/dev/shm` 대신 컨테이너 임시 저장소를 사용한다.

## 6. Dry-run 수동 실행

`.env.cloud-run` secret이 `DRY_RUN=true`, `ENABLE_SHEETS_WRITE=false`인지 다시 확인한 다음 명시적으로 실행한다.

```bash
gcloud run jobs execute "$JOB_NAME" --region="$REGION" --wait
```

Cloud Logging에서 Chromium 시작, KB 접속, Google 인증을 확인한다. Dry-run도 실제 KB 및 Google Sheets 읽기를 수행할 수 있다.

```bash
gcloud logging read \
  "resource.type=cloud_run_job AND resource.labels.job_name=${JOB_NAME}" \
  --limit=100 \
  --format=json
```

## 7. 실제 쓰기 전환과 중복 검증

Dry-run이 성공한 뒤 Cloud Run용 `.env`를 `DRY_RUN=false`, `ENABLE_SHEETS_WRITE=true`로 변경해 새 Secret 버전을 추가한다. Job을 한 번 실행하고 같은 조회를 다시 실행해 두 번째 실행의 `appendCalled=false`와 신규 거래 0건을 확인한다.

```bash
gcloud secrets versions add kb-bank-sync-env --data-file=.env.cloud-run
gcloud run jobs execute "$JOB_NAME" --region="$REGION" --wait
gcloud run jobs execute "$JOB_NAME" --region="$REGION" --wait
```

Cloud Run 자체에는 `flock`이 없다. 작업 수 1과 재시도 0을 사용하고 Scheduler를 하나만 운영한다. Google Sheets sourceKey 중복 방지는 유지되지만, 수동 실행과 예약 실행의 완전한 동시 시작까지 막는 분산 잠금은 제공하지 않으므로 실행 중 수동 재실행을 피한다.

## 8. Cloud Scheduler 등록

Scheduler 호출 서비스 계정에 해당 Job의 `roles/run.invoker` 권한을 부여한다.

```bash
export PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
export SCHEDULER_SERVICE_ACCOUNT="kb-bank-sync-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud iam service-accounts create kb-bank-sync-scheduler \
  --display-name="KB Bank Sync Scheduler"

gcloud run jobs add-iam-policy-binding "$JOB_NAME" \
  --region="$REGION" \
  --member="serviceAccount:${SCHEDULER_SERVICE_ACCOUNT}" \
  --role="roles/run.invoker"

gcloud scheduler jobs create http kb-bank-sync-daily \
  --location="$REGION" \
  --schedule="10 4 * * *" \
  --time-zone="Asia/Seoul" \
  --uri="https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/jobs/${JOB_NAME}:run" \
  --http-method=POST \
  --oauth-service-account-email="$SCHEDULER_SERVICE_ACCOUNT"
```

이 예시는 매일 KST 04:10에 Cloud Run Job 실행 API를 호출한다. Scheduler 생성 직후 강제 실행하지 말고 다음 예약과 IAM 설정을 먼저 확인한다.

## 9. 코드 업데이트

새 버전 태그로 이미지를 빌드한 뒤 Job의 이미지를 갱신한다.

```bash
export IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/kb-bank-sync:NEW_VERSION"
gcloud builds submit --tag "$IMAGE" .
gcloud run jobs update "$JOB_NAME" --region="$REGION" --image="$IMAGE"
```

업데이트 후 운영 쓰기 전에 다시 Dry-run 검증을 수행한다.

## 제한과 운영 판단

- Cloud Run의 기본 외부 송신 IP는 고정되지 않는다. KB가 데이터센터나 IP 범위를 제한하면 Cloud Run 기본 네트워크로 접속하지 못할 수 있다.
- 고정 송신 IP가 필요하면 VPC egress와 Cloud NAT 같은 별도 네트워크 구성이 필요하다.
- Cloud Run에는 Docker Compose `shm_size`가 적용되지 않는다.
- 실제 리전 배포 후 Dry-run으로 Playwright Chromium, 이미지 키패드, KB 접속을 반드시 검증해야 한다.
- Cloud Run Job은 사용자 데스크톱 스케줄러보다 동시 실행 제어가 제한적이므로 수동 실행과 예약 실행을 겹치지 않는다.
