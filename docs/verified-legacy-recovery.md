# 누락된 시스템 열과 pagination 복구

동기화는 L이 없는 거래를 자동으로 신규 거래로 취급하지 않는다. J:L 전체가
비어 있고 사용자 표시 값이 KB와 다른 경우, 원래 sourceKey를 추측해 채우지 않는다.

명시적으로 승인된 일회성 migration에서는 KB를 읽기 전용으로 조회하고, pagination이
검출되면 기간을 나눈다. 기존 parser와 정규화를 그대로 사용한다. 한 날짜도 paginated면
중단하며 인증 실패·알 수 없는 DOM을 반복 조회하지 않는다.

전체 A:L 값, 수식과 grid를 Git ignored 파일에 백업한다. 파일 권한은 600이며
SHA-256을 기록한다. KB 후보도 권한 600 파일에 보관하고 원문을 로그에 출력하지 않는다.

`scripts/register-legacy-compatibility.mjs`는 빌드된 코드와 보호된 백업·KB 후보 파일을
사용한다. 기본은 계획 검증이며 `--apply`와 운영 쓰기 설정이 함께 있어야 기록한다.
실행 전 timer를 중지하고, 완료 후 복구한다. 도구는 값/수식이 백업과 정확히 같은지
재확인하며 이미 등록된 index를 덮어쓰지 않는다.

```bash
# 서버에서 scripts 도구를 ignored output에 복사해 컨테이너에 제공한다.
cp scripts/register-legacy-compatibility.mjs output/
docker compose run --rm --entrypoint node kb-sync \
  /app/output/register-legacy-compatibility.mjs \
  --backup /app/output/sheet1-pre-recovery-TIMESTAMP.json \
  --candidates /app/output/incident-kb-candidates.json
# 계획과 백업이 검증됐을 때만 같은 명령에 --apply를 추가한다.
```

KB 후보 파일은 `{collectedAt, evidence, candidates}` 형식이다. `evidence`에는 각
조회의 `from/to/status/paginationDetected`를, `candidates`에는 기존 parser의
`raw`와 정규화된 `transaction`을 담는다. 도구는 성공한 pagination 없는 조회
구간에 속하는지 확인하고 raw를 다시 정규화해 sourceKey를 검증한다.

매칭 분류는 `EXACT_MATCH`, `UNIQUE_COMPATIBLE_MATCH`, `AMBIGUOUS`, `NO_MATCH`다.
적요 또는 금액 표시 부호가 다르면 `NO_MATCH`를 유지한다. 이 경우에도 초 단위 일시,
입출금 방향, 금액 절댓값, 잔액, 비어 있지 않은 거래처와 기관이 모두 일치하고,
KB 및 Sheet 전체에서 완전한 1:1 대응일 때만 별도의 검증된 index를 등록할 수 있다.
청라/국민은행과 이전 통장 표시 문구는 알려진 호환 범위로만 인정한다.
잔액·거래처가 비어 있거나 후보가 둘이면 중단한다.

index는 `kb_sync_verified_legacy_v1`이라는 Sheet developer metadata에 저장한다.
각 record는 A:G 원본 해시, 마스킹된 계좌식별자, 현재/legacy KB sourceKey를 담는다.
A:L 값이나 수식, 기존 sourceKey, 행 수, 정렬, 필터를 변경하지 않는다.
J:L의 물리적 누락 건수와 `verifiedLegacyRowCount`는 실행 요약에서 각각 보고한다.
모든 누락 행이 검증된 record에 대응해야만 동기화를 허용한다.

매 실행 시 원본 A:G, 계좌, record 형식, 키 충돌, 1:1 대응을 검증한다.
전체 행 정렬 및 H/I 편집은 허용한다. 검증한 A:G나 시스템 열이 변경되거나,
새로운 누락 행이 추가되면 안전하게 중단한다. 자동으로 record를 갱신하지 않는다.
append 직전에도 시트와 index를 재확인한다. 과거 행 변경이 필요하면 독립적인
KB 대조와 새 백업을 사용하는 별도 migration이 필요하다.

운영 조회도 명확한 pagination에 한해서 날짜 구간을 자동 분할하고, 모든 구간이
정상 파싱·검증된 후 신규 거래를 한 번에 append한다. 한 구간이라도 실패하면
부분 거래를 저장하지 않는다. 기존 SHA-256 sourceKey 알고리즘은 변경하지 않는다.

Apps Script 프로젝트/실행 이력은 현재 제공된 접근 권한만으로 확인할 수 없었다.
Apps Script가 누락 행을 만들었다고 확정하지 않는다. 일반 onEdit/installable trigger는
[Google 문서](https://developers.google.com/apps-script/guides/triggers/installable)에 따르면
API 요청만으로 실행되지 않지만, 별도 시간 trigger나 web app의 영향은 확인되지 않았다.
