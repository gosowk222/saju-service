import "server-only";

/**
 * 이용 방식(결제 모드). 서버 설정 CHECKOUT_MODE 하나로 바꾼다. 클라이언트가 보낸 값은 쓰지 않는다.
 *
 * - free_trial (현재, 설정이 없을 때의 기본값): 카카오 회원에게 무료 이용권 한 장을 지급하고 이용권으로만 풀이를 받는다 (대상 상품은 FREE_TRIAL.productIds).
 *   새 결제(주문 생성, 결제창, 결제 승인)는 서버에서 막는다. 토스 키가 없어도 동작한다.
 * - payment: 기존 토스페이먼츠 결제를 다시 연다. 새 무료 이용권 지급은 멈추고, 이미 지급한 미사용 이용권과
 *   이미 받은 풀이 권한은 그대로 쓴다. 테스트 키 제한(PAYMENTS_ALLOW_LIVE)은 그대로라 모드만 바꿔서 실결제가 되지 않는다.
 * - 그 밖의 값은 설정 오류로 보고 새 지급과 새 결제를 모두 막는다 (이미 받은 이용권 사용과 열람은 된다).
 *
 * 로그인 정책(카카오만)은 이 설정과 관계없다 (src/domain/auth/providers.ts).
 */
export type CheckoutMode = "free_trial" | "payment" | "misconfigured";

export const DEFAULT_CHECKOUT_MODE = "free_trial" as const;

export function checkoutMode(env: NodeJS.ProcessEnv = process.env): CheckoutMode {
  const raw = env.CHECKOUT_MODE?.trim().toLowerCase();
  if (!raw) return DEFAULT_CHECKOUT_MODE;
  if (raw === "free_trial" || raw === "payment") return raw;
  return "misconfigured";
}

/** 새 무료 이용권을 지급하는가 (신규 가입, 로그인 후 누락 복구). */
export function grantsOpen(mode: CheckoutMode): boolean {
  return mode === "free_trial";
}

/** 새 결제(주문 생성, 결제창, 결제 승인)를 받는가. */
export function paymentsOpen(mode: CheckoutMode): boolean {
  return mode === "payment";
}

/**
 * 무료 이용권 캠페인. 식별자는 고정한다 (DB의 free_tickets_campaign_check와 같다).
 * 재배포, 문구 변경, 결제 모드 전환으로 바꾸지 않는다. 바꾸면 같은 회원에게 다시 지급된다.
 */
export const FREE_TRIAL = {
  campaignId: "free-trial-2026-11",
  /**
   * 이용권으로 받을 수 있는 상품: '묘묘의 사주 참견', '무진의 종합 사주'.
   * 캠페인 ID는 그대로라 상품을 더해도 새로 지급하지 않는다. 한 장은 두 상품 중 하나에만 쓰인다 (DB의 회원 단위 잠금).
   */
  productIds: ["first-overview", "mujin-overview"] as readonly string[],
} as const;
