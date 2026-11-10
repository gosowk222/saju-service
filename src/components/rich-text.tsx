import { splitEmphasis } from "@/domain/reading/emphasis";

/** 말풍선 문장. **강조** 구절은 디자인 보드의 말풍선 강조처럼 굵기 600으로 보여 준다. */
export function RichText({ text }: { text: string }) {
  return (
    <>
      {splitEmphasis(text).map((run, index) =>
        run.strong ? (
          <strong key={index} className="font-semibold">
            {run.text}
          </strong>
        ) : (
          <span key={index}>{run.text}</span>
        ),
      )}
    </>
  );
}
