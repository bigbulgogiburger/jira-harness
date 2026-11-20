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
| dod_tests | `{ "adapter": "gradle-junit", "run": "./gradlew test" }` | DoD `tests` 항목을 **한 번에** 돌린다(`--tests` 합집합 1회 → JUnit XML 로 항목마다 판정). 없으면 항목마다 gradle 을 새로 띄운다. XML 위치가 기본(`build/test-results/test`)과 다르면 `reports`. **관련 테스트 게이트(`gate.push_level=related`)도 이 어댑터로 고른다** — 바뀐 클래스를 쓰는 테스트 클래스만 `--tests` 로. 전체로 넘기는 전역 파일 기본값은 `build.gradle*`·`settings.gradle*`·`gradle.properties`·`gradle/**`·`src/main/resources/**`·`src/test/resources/**`(`related.fallback_full` 로 덮어쓴다) |

## npm/Vite/Vue CLI (프론트엔드)

| 단계 | 기본 명령 | 보정 |
|------|-----------|------|
| compile | `null`(빌드가 겸함) | — |
| lint | `npm run lint -- --no-fix` | **`--fix` 를 붙이지 않는다** — 대부분의 `npm run lint` 스크립트는 `--fix` 가 기본이라, 게이트가 코드를 조용히 고쳐놓고 통과시킨다. 게이트 경로에서는 항상 `--no-fix` 를 명시 |
| build | `npm run build` | 스크립트 이름이 `build`/`build:qa`/`build:prod` 라도 **모드 인자가 곧 산출물 종류는 아니다** — 별도 production 전용 스크립트가 있는지 `package.json` 확인 |
| test | `npx vitest run` | **`vitest` 단독(watch 모드) 금지** — 헤드리스 게이트에서 종료하지 않고 걸린다. 반드시 `run` 서브커맨드 |
| extra | e2e/visual 스위트가 있으면 여기(무겁다 — `--full` 전용) | — |
| dod_tests | `{ "adapter": "vitest", "run": "npx vitest run" }`(vitest 일 때) | 경로 필터 합집합 1회 + JSON 리포터로 항목마다 판정. `run` 은 **test 명령과 글자까지 같게** 둔다 — 같으면 전량 게이트가 test 단계 리포트로 DoD 를 판정하고 다시 돌리지 않는다. 관련 테스트 게이트는 `run` 의 `vitest run` 을 `vitest related --run --passWithNoTests <바뀐 파일>` 로 바꿔 돈다 — `run` 이 그 꼴이 아니면 `related.command`(`{files}` 자리) 필요 |
| lint_changed | 없음(선택) — 예 `{ "run": "npm run lint -- --no-fix {files}", "match": ["src/**/*.js", "src/**/*.vue", "*.js"] }` | 켜면 이슈 게이트의 lint 가 바뀐 파일만 본다 — 약해지는 것이 있으니 아래 「이슈 게이트의 lint 를 바뀐 파일로 좁히기」를 읽고 사용자에게 확인받은 뒤에만 넣는다 |

### 이슈 게이트의 lint 를 바뀐 파일로 좁히기 — `lint_changed` (선택)

전체 lint 는 캐시가 있어야 빠른데 캐시는 작업트리마다 따로다(ESLint 는 캐시 파일을 실행한 폴더마다 따로 만든다). 이슈를 새 작업트리에서 시작하면 첫 lint 가 캐시 없이 전체를 돈다(실측: 이슈의 첫 lint 중앙 155초 · 그 뒤 28초 · 캐시 없는 전체 766초 · 파일 12개만 넘기면 40초). `stacks.<name>.lint_changed` 를 두면 **이슈 게이트(`--commit`·`--dod`·`--related`)** 의 lint 단계가 그 게이트가 보는 변경 파일만 넘겨 돈다. `--full` 과 `--main` 은 언제나 `lint`(전체)를 돈다.

```jsonc
"lint": "npm run lint -- --no-fix && npm run lint:i18n",
"lint_changed": {
  "run": "npm run lint -- --no-fix {files}",                 // {files} = 바뀐 파일(스택 dir 기준 경로 · 따옴표 붙음)
  "always": "npm run lint:i18n",                             // 선택 — 파일 목록과 무관한 검사. run 뒤에, 바뀐 대상이 없으면 이것만 돈다
  "match": ["src/**/*.js", "src/**/*.vue", "*.js"],          // 전체 lint 가 보는 범위와 같게(스택 dir 기준 glob)
  "fallback_full": ["package.json", ".eslintrc.*", "eslint-rules/**"],   // 선택 — 바뀌면 전체 lint(기본값이 흔한 린트 설정·잠금 파일을 덮는다)
  "max_files": 200                                           // 선택 — 대상이 더 많으면 전체 lint
}
```

- 대상 파일 = 게이트가 보는 변경(커밋 게이트는 작업트리 변경, `--dod`·`--related` 는 이 브랜치가 바꾼 것 전부) 중 그 스택 dir 아래 · `match` 에 걸림 · 디스크에 있음(지운 파일 제외).
- **`match` 는 전체 lint 가 실제로 보는 범위와 같게 쓴다.** 전체 lint 가 안 보는 폴더까지 넣으면(`**/*.js` 로 e2e·scripts 폴더가 딸려 온다) 전체 lint 에는 없던 실패가 이슈 게이트에서 나고, 더 좁으면 그 파일의 위반이 `--main` 까지 미뤄진다. 전체 lint 의 범위는 lint 스크립트의 인자·린터의 기본 대상(예: Vue CLI 의 `src`·`tests`·루트 `*.js`)·ignore 설정에서 읽는다. glob 은 `**/`(폴더 여러 단계)와 `*`(한 단계 안)만 쓴다 — 중괄호 묶음은 없다.
- **바뀐 대상이 0개면 전체로 넘어가지 않는다** — `always` 가 있으면 그것만 돌고, 없으면 lint 단계가 `SKIPPED` 다. 요약에 `lint 범위 <스택>: 바뀐 파일 중 lint 대상이 없다 — lint 를 돌리지 않았다(검사 0)` 가 찍힌다(관련 테스트 게이트의 「고를 것 없음」과 같은 처리다).
- **전체 lint 로 넘어가는 경우**: `fallback_full` 에 걸리는 파일이 바뀜(규칙이 바뀌면 안 바뀐 파일의 판정도 달라진다 — 스택 dir 안의 파일과, 스택 dir 의 위 폴더들에 바로 놓인 파일을 이름으로 본다. 린터는 위 폴더의 설정도 읽는다) · `max_files` 초과 · 명령줄이 30,000자를 넘음 · 게이트 셸이 cmd(파일 이름을 안전하게 감싸 넘길 수 없다). 어느 쪽으로 돌았는지는 요약의 `lint 범위` 줄과 기록 `gate.lint_scope` 에 남는다.
- **위 폴더의 파일만 바뀐 변경은 이 스택의 lint 를 돌리지 않는다** — 게이트에 오르는 스택은 `paths`(기본 `<dir>/**`)로 정해지고, 이 설정은 이미 오른 스택의 lint 범위만 정한다(이 설정이 없을 때도 같다). 저장소 루트의 린트 설정·잠금 파일이 이 스택의 검사를 바꾼다면 그 파일을 스택의 `paths` 에 넣는다.
- **약해지는 것을 알고 켠다** — 좁힌 lint 는 안 바뀐 파일을 보지 않는다. 바뀐 파일 때문에 **다른 파일**에서 새로 생기는 위반(지운 파일을 가져다 쓰는 곳 · 타입 정보를 쓰는 규칙처럼 파일을 넘나드는 규칙)은 이슈 게이트를 지나 `--main`(또는 `--full`)의 전체 lint 에서 드러난다. 린트 규칙이 전부 파일 하나 안에서 판정되는 프로젝트(ESLint 기본·standard·vue 규칙 묶음 등)는 잃는 것이 거의 없고, 타입 정보를 쓰는 규칙이나 `import/no-unresolved` 류를 켠 프로젝트는 켜지 않는 편이 낫다. `gate.push_level` 이 `full` 인 프로젝트는 push 전에 전체 lint 가 도므로 달라지는 것이 커밋 게이트뿐이다.
- `run` 은 `lint` 와 **같은 린터·같은 옵션**이어야 한다(캐시 위치·확장자·`--no-fix`). 파일 목록과 무관한 검사(다국어 키 검사 등)는 `run` 에 붙이지 말고 `always` 에 둔다 — 그래야 바뀐 대상이 없을 때도 돈다.
- 린터가 무시하는 파일(ignore 패턴·점으로 시작하는 설정 파일)을 직접 넘기면 경고가 난다 — 경고를 실패로 세는 설정(`--max-warnings 0`)이면 `match` 를 좁히거나 린터의 「무시된 파일 경고 끄기」 옵션을 `run` 에 넣는다.
- 켠 뒤에는 한 번 확인한다: 일부러 lint 위반을 넣은 파일로 `gate.mjs --commit --dry-run` 이 그 파일을 넘기는지 보고, 실제 실행이 FAIL 하는지 본다.

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
