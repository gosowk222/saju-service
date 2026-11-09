"use client";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/layout";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="flex flex-1 flex-col justify-center">
      <EmptyState
        title="문제가 생겼어요"
        description="잠시 후 다시 시도해 주세요."
        action={<Button onClick={reset}>다시 시도</Button>}
      />
    </main>
  );
}
