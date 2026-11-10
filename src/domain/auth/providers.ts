/**
 * 로그인 정책 (출시 버전까지 유지): 카카오만 지원한다.
 *
 * - 구글, 이메일 가입·비밀번호, 이메일 OTP·매직 링크, 그 밖의 제공자는 지원하지 않는다.
 * - 결제 모드(CHECKOUT_MODE)와 관계없다. 무료 테스트에서 결제로 돌아가도 이 목록은 바뀌지 않는다.
 * - 다른 로그인 수단은 별도 요구사항이 있을 때만 검토한다.
 *
 * 로그인 시작(/auth/login), 콜백(/auth/callback), 서버의 회원 판정이 모두 이 목록을 쓴다.
 * Supabase 쪽 설정(Authentication > Sign In / Providers)도 카카오만 켜 둔다.
 */
export const LOGIN_PROVIDERS = ["kakao"] as const;

export type LoginProvider = (typeof LOGIN_PROVIDERS)[number];

export function isLoginProvider(value: unknown): value is LoginProvider {
  return typeof value === "string" && (LOGIN_PROVIDERS as readonly string[]).includes(value);
}

interface IdentityHolder {
  readonly identities?: readonly { readonly provider: string }[] | null;
}

/**
 * 서버가 Supabase Auth에서 다시 받은 사용자 정보(getUser)의 실제 연결(identities)에 지원 제공자가 있는지 본다.
 * 최초 가입 제공자(app_metadata.provider) 하나만 보지 않는다. 처음 구글로 가입했어도 카카오가 연결되어 있으면 회원이다.
 * 사용자가 바꿀 수 있는 user_metadata는 보지 않는다.
 */
export function hasLoginIdentity(user: IdentityHolder): boolean {
  return (user.identities ?? []).some((identity) => isLoginProvider(identity.provider));
}
