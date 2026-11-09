# boards

디자인 캔버스의 보드별 HTML 소스(독립 실행 가능). 브라우저로 바로 열 수 있다.

- 토큰 보드: Main(개요) · Benchmark(시장 벤치마크) · Colors · Typography · Foundations · Components · Flow(화면 흐름 개요)
- 화면(390px 폰): Landing → Login → Home → Category → Product → Reading → Daily → MyPage → Credits → Questions → Library → Sample(내 사주 정보)

화면 사이의 `<a href="*.html">`로 흐름이 연결돼 있다. 모든 값은 인라인 style에 하드코딩되어 있으며, 토큰 이름 대응은 ../tokens.json 참고.
