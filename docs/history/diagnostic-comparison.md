# KB 빠른조회 과거 실행 비교 기록

민감한 입력값, 거래 원문, 전체 URL, query 및 응답 본문은 기록하지 않는다. `미수집`은 당시 진단기가 해당 항목을 수집하지 않았다는 뜻이며 0으로 해석하지 않는다.

| 실행 | 모드 | 시각 | 기간 | 제출 전/후 pathname | XHR | main navigation | `#b028770` | `table.tType01` | Page | 결과 |
|---|---|---|---|---|---|---|---|---|---|---|
| stage1-6 | default headless | 2026-07-15 | 미수집 | `/quics` → `/quics` | POST 200 2건 | 감지 | DOM inventory에서 감지 | 구조만 감지 | 1→1 | result unknown |
| stage1-7 빈 기간 | headless | 2026-07-15 | 2026-07-01~07-15 | `/quics` → `/quics` | 미수집 | 감지 | visible | 감지 | 1→1 | empty |
| 6개월 거래 기간 | headless | 2026-07-15 | 2026-01-15~07-15 | `/quics` → `/quics` | 미수집 | 감지 | visible | 감지 | 1→1 | 상세 행 역할 미확정 |
| 파서 수정 후 | default headless | 2026-07-16 | 2026-01-15~07-15 | `/quics` → `/quics` | 미수집 | 전환 감지 | 미감지 | 미감지 | 1→1 | result unknown |
| popup resolver 수정 후 | default headless | 2026-07-16 | 2026-01-15~07-15 | `/quics` → `/quics` | 미수집 | 전환 감지 | 미감지 | 미감지 | 1→1 | result unknown |
| 브라우저 모드 비교 | new headless | 2026-07-16 | 2026-01-15~07-15 | `/quics` → `/quics` | 미수집 | 전환 감지 | 미감지 | 미감지 | 1→1 | result unknown |
| 브라우저 모드 비교 | Xvfb headed | 2026-07-16 | 2026-01-15~07-15 | `/quics` → `/quics` | 미수집 | 전환 감지 | 미감지 | 미감지 | 1→1 | result unknown |

## 현재 가설과 구분 기준

| 가설 | 기존 증거 | 새 진단의 구분 기준 |
|---|---|---|
| popup 또는 짧게 생성된 target 누락 | 최근 Page 1→1이나 사용자는 일반 브라우저의 새 창을 관찰 | window.open 호출, CDP target 생성·즉시 삭제 |
| 클릭 이벤트 경로 또는 입력 반영 실패 | 버튼 click은 성공했지만 결과가 반복적으로 미표시 | 입력 존재 boolean과 mousedown→mouseup→click 순서 |
| 정상 결과 응답 후 DOM 렌더링 실패 | 과거 같은 환경에서 결과 DOM 확인, POST XHR 200 이력 | 응답 메모리 분류에서 결과 wrapper/table 포함 여부와 DOM mutation 비교 |
| 인증·점검·validation 응답 | status 200만으로 정상 여부를 알 수 없음 | 응답 본문의 비식별 오류/점검 pattern 분류 |
| 결과가 생성 후 제거되거나 hidden | 이전 성공과 최근 실패가 혼재 | id/class 전용 MutationObserver의 생성·변경·삭제 순서 |
| profile/session 차이 | 과거 fresh context 성공 때문에 필수 profile 가능성은 낮음 | 쿠키 개수와 storage key 이름 비교, 필요 시 전용 임시 persistent context |
| Linux 또는 자동화 제한 | Xvfb headed와 headless 모두 최근 실패했지만 과거 Linux 성공 이력 존재 | 정상 응답 자체가 없는지, 자동화 환경 전용 오류가 명시되는지 확인 |

`result_page_unknown`은 위 증거가 수집되지 않은 상태이며 근본 원인 결론으로 사용하지 않는다.

## 2026-07-16 근본 원인 확정

- `uf_GoSubmit`은 정상적으로 호출됐고 `InputCheck`도 통과했다.
- 은행 페이지의 `Car_DateCheck`가 `false`를 반환해 URL 결정과 AJAX 호출 전에 제출이 중단됐다.
- 페이지가 렌더링한 기준일은 `2026-07-16`이고 최근 6개월 하한은 `2026-01-16`이었다.
- 이전에 사용한 `2026-01-15 ~ 2026-07-15`는 실행 당일 기준 하한보다 하루 이전이었다.
- 인증 없는 경계 검증에서 `2026-01-15`는 거부되고 `2026-01-16`은 허용됨을 확인했다.
- 따라서 Page, popup, Linux Chromium 또는 결과 선택자가 최근 실패의 직접 원인은 아니다.
