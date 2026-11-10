import { LinkButton } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/layout";

export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col justify-center">
      <EmptyState
        title="찾을 수 없는 화면이에요"
        description="주소가 바뀌었거나 볼 수 있는 권한이 없어요."
        action={<LinkButton href="/home">홈으로 가기</LinkButton>}
      />
    </main>
  );
}
