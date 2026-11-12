import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasLoginIdentity, isLoginProvider, LOGIN_PROVIDERS } from "@/domain/auth/providers";
import { checkoutMode, DEFAULT_CHECKOUT_MODE, FREE_TRIAL, grantsOpen, paymentsOpen } from "@/server/checkout/mode";

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("로그인 정책: 카카오만", () => {
  it("지원 제공자는 카카오 하나다", () => {
    expect(LOGIN_PROVIDERS).toEqual(["kakao"]);
    for (const provider of ["google", "email", "apple", "github", "Kakao", "", null, undefined]) {
      expect(isLoginProvider(provider), String(provider)).toBe(false);
    }
    expect(isLoginProvider("kakao")).toBe(true);
  });

  it("회원 판정은 실제 연결(identities)에서 카카오를 찾는다", () => {
    expect(hasLoginIdentity({ identities: [{ provider: "kakao" }] })).toBe(true);
    expect(hasLoginIdentity({ identities: [{ provider: "google" }, { provider: "kakao" }] })).toBe(true);
    expect(hasLoginIdentity({ identities: [{ provider: "google" }] })).toBe(false);
    expect(hasLoginIdentity({ identities: [] })).toBe(false);
    expect(hasLoginIdentity({ identities: null })).toBe(false);
    // user_metadata나 app_metadata 값은 보지 않는다.
    expect(hasLoginIdentity({ identities: [{ provider: "google" }], user_metadata: { provider: "kakao" } } as never)).toBe(false);
  });

  it.each(["free_trial", "payment", "misconfigured"] as const)("결제 모드(%s)가 바뀌어도 로그인 제공자는 그대로다", (mode) => {
    const env = { CHECKOUT_MODE: mode === "misconfigured" ? "oops" : mode } as unknown as NodeJS.ProcessEnv;
    expect(checkoutMode(env)).toBe(mode);
    expect(LOGIN_PROVIDERS).toEqual(["kakao"]);
  });
});

describe("결제 모드", () => {
  it("설정이 없으면 무료 테스트 모드다", () => {
    expect(DEFAULT_CHECKOUT_MODE).toBe("free_trial");
    expect(checkoutMode({} as unknown as NodeJS.ProcessEnv)).toBe("free_trial");
    expect(checkoutMode({ CHECKOUT_MODE: " " } as unknown as NodeJS.ProcessEnv)).toBe("free_trial");
    expect(checkoutMode({ CHECKOUT_MODE: " FREE_TRIAL " } as unknown as NodeJS.ProcessEnv)).toBe("free_trial");
  });

  it("무료 테스트는 지급만, 결제 모드는 결제만 열고, 잘못된 값은 둘 다 닫는다", () => {
    expect([grantsOpen("free_trial"), paymentsOpen("free_trial")]).toEqual([true, false]);
    expect([grantsOpen("payment"), paymentsOpen("payment")]).toEqual([false, true]);
    expect(checkoutMode({ CHECKOUT_MODE: "free" } as unknown as NodeJS.ProcessEnv)).toBe("misconfigured");
    expect([grantsOpen("misconfigured"), paymentsOpen("misconfigured")]).toEqual([false, false]);
  });

  it("캠페인 식별자는 DB 제약과 같고(무진을 더해도 그대로), 대상 상품은 묘묘의 사주 참견과 무진의 종합 사주다", () => {
    const migration = readdirSync(path.join(root, "supabase/migrations")).find((file) => file.includes("kakao_only_free_trial"))!;
    expect(read(`supabase/migrations/${migration}`)).toContain(`check (campaign_id in ('${FREE_TRIAL.campaignId}'))`);
    expect(FREE_TRIAL.campaignId).toBe("free-trial-2026-11");
    expect(FREE_TRIAL.productIds).toEqual(["first-overview", "mujin-overview"]);
  });
});

describe("로그인 경로와 화면 코드", () => {
  it("앱 코드에는 카카오 외 제공자로 로그인을 시작하는 코드가 없다", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const relative = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(relative);
        else if (/\.(ts|tsx)$/.test(entry.name)) files.push(relative);
      }
    };
    walk("src");
    const offenders = files.filter((file) => {
      const text = read(file);
      return /provider:\s*["'](google|github|apple|azure|facebook)["']/i.test(text) || /signInWith(Otp|Password|IdToken|SSO)\b/.test(text) || /signUp\(/.test(text) || /linkIdentity\(/.test(text);
    });
    expect(offenders).toEqual([]);
    // 브라우저에서 바로 OAuth를 시작하지 않고 서버의 로그인 시작 경로만 쓴다.
    const oauthStarts = files.filter((file) => read(file).includes("signInWithOAuth"));
    expect(oauthStarts).toEqual(["src/app/auth/login/route.ts"]);
  });
});

describe("규칙·안내 문서", () => {
  it("현재 규칙 문서와 환경변수 예시가 카카오 단일 로그인과 무료 테스트 모드를 설명한다", () => {
    for (const file of ["AGENTS.md", "README.md", ".env.example"]) {
      const text = read(file);
      // 지원한다는 설명만 잡는다. "카카오·구글 계정 연결 기능은 철회" 같은 철회 기록은 남아도 된다.
      expect(text, file).not.toMatch(/로그인은 카카오·구글|카카오·구글 로그인|카카오와 구글 로그인|구글 로그인을 지원|Google 로그인 지원/);
    }
    expect(read("AGENTS.md")).toMatch(/로그인은 카카오만 지원한다/);
    expect(read(".env.example")).toMatch(/^# ?CHECKOUT_MODE=|^CHECKOUT_MODE=/m);
  });
});
