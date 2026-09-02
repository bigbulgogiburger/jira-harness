# 스택 감지 → 라벨 후보

이슈 생성 시 라벨 자동 부여와 issueType 추정에 쓴다. 감지는 저장소 루트(모노레포면 각 하위 디렉토리)의 파일로 한다. 라벨은 kebab-case.

| 감지 파일 | 스택 | 라벨 후보 |
|-----------|------|----------|
| `build.gradle` / `build.gradle.kts` / `pom.xml` | Spring Boot (Java/Kotlin) | `spring-boot`, `backend` |
| `pubspec.yaml` | Flutter (Dart) | `flutter`, `mobile` |
| `package.json` + `vue` 의존성 | Vue.js | `vue`, `frontend` |
| `package.json` + `react` / `next` 의존성 | React/Next.js | `react`, `frontend` |
| `package.json` + `@angular/core` 의존성 | Angular | `angular`, `frontend` |
| `go.mod` | Go | `go`, `backend` |
| `Cargo.toml` | Rust | `rust` |
| `pyproject.toml` / `requirements.txt` | Python | `python` |
| (감지 불가) | — | 사용자에게 스택을 묻는다 |

- Gradle 과 Maven 이 같이 있으면 `build.gradle` 우선. `package.json` 은 의존성으로 Vue/React/Angular 를 가른다.
- 프로젝트에 `.claude/harness.json` 이 있으면 `stacks.<name>.dir` 이 곧 스택 목록이다 — 감지보다 그 값을 우선한다.
- 라벨은 프로젝트에 이미 쓰이는 라벨 집합과 맞춘다(있는 라벨을 재사용, 새 라벨은 사용자 확인).
