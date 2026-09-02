# 스택별 기본 게이트 명령 + 흔한 보정

`detect` 가 스택을 판별하면 아래 표의 기본 명령을 `suggested` 에 채운다. "보정" 열은 기본값을 그대로 쓰면 게이트가 조용히 무력해지는(검사 0건인데 초록) 흔한 함정이다 — 인터뷰에서 이 후보를 먼저 보여준다.

## Gradle (Spring Boot 등 JVM)

| 단계 | 기본 명령 | 보정 |
|------|-----------|------|
| compile | `./gradlew compileJava` | **`compileTestJava` 도 포함**해야 한다 — 테스트 코드만 깨진 컴파일 오류는 `compileJava` 단독으로는 안 잡힌다 |
| lint | checkstyle/spotless 가 감지될 때만 | 없으면 `null`(스킵) — 억지로 만들지 않는다 |
| build | `./gradlew build -x test` | — |
| test | `./gradlew test` | **`--no-daemon` 금지** — 데몬 없이 돌리면 일부 Mockito 설정(inline mock maker 등)이 깨진다는 사례가 보고돼 있다. 데몬은 기본값 그대로 둔다 |
| extra | 프로젝트 정적 게이트(디자인 토큰 검사 등)가 있으면 여기 | — |

## npm/Vite/Vue CLI (프론트엔드)

| 단계 | 기본 명령 | 보정 |
|------|-----------|------|
| compile | `null`(빌드가 겸함) | — |
| lint | `npm run lint -- --no-fix` | **`--fix` 를 붙이지 않는다** — 대부분의 `npm run lint` 스크립트는 `--fix` 가 기본이라, 게이트가 코드를 조용히 고쳐놓고 통과시킨다. 게이트 경로에서는 항상 `--no-fix` 를 명시 |
| build | `npm run build` | 스크립트 이름이 `build`/`build:qa`/`build:prod` 라도 **모드 인자가 곧 산출물 종류는 아니다** — 별도 production 전용 스크립트가 있는지 `package.json` 확인 |
| test | `npx vitest run` | **`vitest` 단독(watch 모드) 금지** — 헤드리스 게이트에서 종료하지 않고 걸린다. 반드시 `run` 서브커맨드 |
| extra | e2e/visual 스위트가 있으면 여기(무겁다 — `--full` 전용) | — |

## Python (pytest 계열)

| 단계 | 기본 명령 | 보정 |
|------|-----------|------|
| compile | `null` | — |
| lint | `ruff check` 또는 `flake8`(감지된 쪽) | — |
| test | `pytest -q` | DoD 프로브에 `expect.min_tests` 를 걸어 "수집 0건" 을 통과로 읽지 않게 한다 |

## 모노레포 — dir/paths

- 서브디렉터리마다 `stacks.<name>.dir` 을 따로 둔다(예: `back`, `front`). `paths` 를 생략하면 기본값이 `<dir>/**` 라 서로 겹치지 않는다.
- **공용 루트 파일**(루트 `package.json`, 루트 CI 설정 등)만 바꾼 커밋은 어느 스택에도 안 걸릴 수 있다 — 스택 매칭에서 빠지면 경량 게이트가 전부 SKIPPED 로 뜬다. 이런 변경이 잦으면 별도 `root` 스택(`dir: "."`, `paths: ["*.json","*.yml"]` 등)을 두는 편이 안전하다.
- 스택별 `env_file` 은 서로 다른 gitignore 파일을 가리켜야 한다 — 같은 파일을 공유하면 한쪽 스택의 시크릿이 다른 스택 로그에도 노출된다.
