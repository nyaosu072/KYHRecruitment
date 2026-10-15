# 한일 채용공고 모아보기

잡코리아 · 자소설닷컴 · 링커리어 · 마이나비코리아 · 월드잡플러스(일본) · リクナビ · キャリタス就活 · 外資就活 · キャリアチケット · Daijob 공고를 한 목록으로 보여 주는 정적 사이트.

- `scrape.js` — 공고를 모아 `jobs.json`에 저장 (Node 18+, 외부 패키지 없음. 단 キャリタス就活은 브라우저 확인(AWS WAF)이 있어 `playwright-core`와 Chrome으로 염)
- `index.html` — `jobs.json`을 읽어 필터링해서 보여 줌
- `.github/workflows/scrape.yml` — 6시간마다 수집 후 `jobs.json` 커밋

## 로컬에서

```
npm i --no-save playwright-core   # キャリタス就活 수집용 (없으면 그 사이트만 건너뜀)
node scrape.js          # jobs.json 갱신
node scrape.js serve    # http://localhost:3000
```

## GitHub Pages 배포

1. GitHub에서 새 저장소 만들기 (Public)
2. 이 폴더를 push
3. 저장소 Settings → Pages → Source: Deploy from a branch → `main` / `/ (root)`
4. Settings → Actions → General → Workflow permissions: Read and write
5. Actions 탭 → "공고 수집" → Run workflow 로 첫 수집 확인

주소: `https://<아이디>.github.io/<저장소이름>/`

## 수집하지 않는 사이트

잡플래닛(봇 차단), 슈퍼루키(회원 전용), 네이버 카페(로그인 필요), 마이나비 재팬(robots.txt가 검색 결과 수집 금지), ONE CAREER(공고 API가 외부 접근 차단, 목록 페이지 noindex).
