# sajuengine으로 새 서비스 시작하기

이 묶음은 새 사주 서비스 저장소에 넣을 안내서와 AI 에이전트 규칙, 실행 예제다. 완성된 웹앱이나 엔진 배포 파일은 포함하지 않는다. 기존 `zzz664/saju` 저장소를 수정할 필요 없이, 패키지를 설치하고 서비스 작업을 시작할 수 있다.

기준 소스는 `zzz664/saju`의 `refactor/sajuengine-package-boundary` 브랜치, 커밋 `abc77f71531591969151fd5b6e4b51c32e0ac3d9`다. 패키지 버전은 `0.1.0`, inquiry 정책 버전은 `1.1.0`이다. [PR 163](https://github.com/zzz664/saju/pull/163)은 안내 작성 시점에 미병합 상태이므로 현재 `main`이나 `develop`을 받으면 이 설치 안내와 다를 수 있다.

## 읽는 순서

1. 이 파일로 새 앱과 패키지 설치를 끝낸다.
2. `docs/SAJUENGINE_SERVICE_GUIDE.md`로 기능과 상품 개발 방법을 읽는다.
3. `AGENTS.md`와 `CLAUDE.md`를 새 저장소 루트에 둔다.
4. `examples/`의 실행 예제를 확인한다.
5. `templates/FIRST_TASK.md`를 AI 에이전트의 첫 작업 지시로 사용한다.

기존에 동명의 파일이 있다면 필요한 내용을 합친다. 기존 프로젝트의 규칙이나 Next.js가 만든 안내를 통째로 덮어쓰지 않는다.

## 1 준비

Git과 Node.js 24를 설치한다. 원본 엔진 저장소는 npm 11.19.1 이상 12 미만을 요구한다. 다음 명령은 macOS 또는 Linux 터미널 기준이며, 두 저장소를 같은 부모 폴더에 만든다.

```sh
node --version
npm --version
git --version
```

Node 버전이 24가 아니면 Node.js 24로 맞춘다. npm 버전이 낮으면 Node.js 24 환경에서 다음을 실행한다.

```sh
npm install --global npm@11.19.1
```

## 2 엔진 배포 파일 만들기

기존 작업 폴더를 건드리지 않도록 새 폴더에 복제한다. 비공개 저장소라면 먼저 GitHub 계정으로 Git 인증을 완료한다.

```sh
git clone --branch refactor/sajuengine-package-boundary --single-branch https://github.com/zzz664/saju.git saju-engine-source
cd saju-engine-source
git switch --detach abc77f71531591969151fd5b6e4b51c32e0ac3d9
npm ci --ignore-scripts
npm run pack:engine
```

이 커밋으로 고정하는 이유는 문서와 같은 API를 설치하기 위해서다. `pack:engine`은 패키지를 빌드하고 저장소 루트에 `sajuengine-0.1.0.tgz`를 만든다. 엔진의 `.env`나 LLM 키는 필요하지 않다.

## 3 새 앱 만들고 패키지 설치하기

여기서는 메신저 화면과 서버 API를 함께 만들기 쉬운 Next.js를 사용한다. `saju-messenger`는 예시 이름이며 바꿔도 된다. Next.js 버전은 설치 때 확정한 뒤 lockfile로 고정한다.

```sh
cd ..
npx create-next-app@latest saju-messenger --ts --eslint --tailwind --app --src-dir --import-alias "@/*" --use-npm --yes
cd saju-messenger
mkdir -p vendor
cp ../saju-engine-source/sajuengine-0.1.0.tgz ./vendor/
npm install ./vendor/sajuengine-0.1.0.tgz --ignore-scripts
npm install server-only
```

`vendor/`는 설치 파일 보관 폴더다. `vendor/sajuengine-0.1.0.tgz`, `package.json`, `package-lock.json`을 새 저장소에 함께 커밋한다. 그러면 다른 개발자와 배포 서버도 `npm ci`로 같은 파일을 설치할 수 있다. 개인 컴퓨터의 절대 경로를 의존성 경로로 남기지 않는다.

현재 패키지는 `private: true`이므로 공개 npm 업로드가 막혀 있지만 `.tgz` 설치는 가능하다. 현재 상태에서 `npm install sajuengine`은 이 비공개 산출물을 설치하는 방법이 아니다. `npm install github:zzz664/saju`도 패키지 하위 폴더 대신 원본 앱 루트를 가리키므로 사용하지 않는다.

## 4 서버 실행 설정

`next.config.ts`의 기존 설정에 아래 항목을 합친다. JSON 파일로 복사하는 코드가 아니라 TypeScript 설정 코드다.

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["sajuengine", "@js-temporal/polyfill", "manseryeok"],
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/@js-temporal/polyfill/package.json",
      "./node_modules/@js-temporal/polyfill/dist/**/*",
    ],
  },
};

export default nextConfig;
```

`sajuengine/node`는 Node.js 어댑터다. 기본 사용 경로는 서버에서 계산하며, 클라이언트 컴포넌트나 Edge 런타임에서 호출하지 않는다. Next.js Route Handler에서 계산할 때는 `export const runtime = "nodejs"`를 선언하고, 공통 계산 모듈에는 `import "server-only"`를 둔다. 패키지 진입점 자체가 브라우저에서 읽힐 수 있다는 것과 Node 어댑터를 브라우저에서 실행할 수 있다는 것은 별개다.

`outputFileTracingIncludes`는 배포 파일을 모을 때 시간 계산 라이브러리의 필요한 파일이 빠지지 않도록 하는 설정이다. 이 파일이 빠지면 개발 서버에서는 동작해도 배포 결과에서 계산 요청이 실패할 수 있다. 이 구성은 Node 24와 Next.js 16.4.2에서 독립된 standalone 실행으로 계산과 고전 자료 조회를 확인했다. 직접 Node 서버로 배포하려면 `output: "standalone"`을 추가할 수 있다. 다른 Next.js 버전이나 호스팅을 쓰면 해당 배포 산출물에서도 계산과 선택형 고전 JSON 조회를 확인한다.

## 5 설치 확인과 예제 실행

이 묶음의 `examples/`를 새 앱에 복사한다. `examples/README.md`에 적힌 명령으로 기본 계산과 서비스 규칙 예제를 실행한다. 예제는 가상 출생정보를 사용하고 LLM이나 데이터베이스를 호출하지 않는다.

```sh
npm ls sajuengine
npx tsc --noEmit
npm run dev
```

패키지 버전과 원본 커밋, 배포 파일의 SHA-256을 기록한다. 같은 `0.1.0` 이름으로 다른 빌드를 덮어쓰지 않는다. 이후 갱신 때는 새로운 버전의 파일과 lockfile을 함께 반영하고 예제를 재실행한다. macOS에서는 `shasum -a 256 vendor/sajuengine-0.1.0.tgz`, Linux에서는 `sha256sum vendor/sajuengine-0.1.0.tgz`로 해시를 구한다.

## 6 새 GitHub 저장소에 올리기

이 묶음에서 `AGENTS.md`, `CLAUDE.md`, `docs/`, `examples/`, 필요한 `templates/`를 새 앱으로 옮긴다. 새 앱의 기본 README에는 이 안내의 필요한 내용을 합친다. `node_modules`, `.next`, `.env.local`, 실제 출생정보와 생성 결과는 커밋하지 않는다.

GitHub에서 빈 비공개 저장소 `saju-messenger`를 만든 뒤 새 앱 폴더에서 실행한다. `YOUR_GITHUB_ID`는 본인 GitHub 아이디로 바꾼다. 이 명령의 `main`은 새 서비스 저장소의 브랜치다.

```sh
git status
git add .
git commit -m "chore: initialize saju service with sajuengine"
git branch -M main
git remote add origin https://github.com/YOUR_GITHUB_ID/saju-messenger.git
git push -u origin main
```

Next.js 생성기가 Git 저장소를 만들지 않은 경우에만 먼저 `git init`을 실행한다. 이미 `origin`이 있다면 `git remote -v`로 대상이 새 서비스 저장소인지 확인한다.

## 환경 변수

사주 계산과 이 묶음의 예제에는 환경 변수가 없다. LLM을 연결할 때 선택한 제공자의 서버 키와 모델 설정을 새 앱에 추가한다. 이 문서에서는 특정 제공자나 모델을 확정하지 않는다. 키에는 `NEXT_PUBLIC_` 접두어를 붙이지 않고, 원본 앱의 `.env`를 그대로 복사하지 않는다.

## 첫 개발 목표

먼저 원국 중심의 짧은 종합 풀이 한 개를 완성한다. 성향, 강점, 일, 돈, 연애, 사람 관계를 주제로 삼고 같은 결과를 메신저에서 다시 열 수 있게 저장한다. 실제 LLM 문장 품질은 계산 예제 통과와 별도로 확인한다. 첫 상품이 완성되면 기간 상품, 궁합, 긴 종합 리포트로 확장한다.
