// 채용공고 수집 → jobs.json. 외부 패키지 없음.
//   node scrape.js        공고를 모아 jobs.json에 저장 (GitHub Actions가 몇 시간마다 실행)
//   node scrape.js serve  jobs.json과 index.html을 http://localhost:3000 으로 미리보기
// robots.txt를 지키고, 로그인·봇 차단이 있는 사이트(잡플래닛, 슈퍼루키, 네이버 카페, 마이나비 재팬)는 수집하지 않음.
const fs = require("fs");
const path = require("path");

const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36" };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 같은 사이트에 1초 간격으로 순서대로 요청
async function get(url, opts = {}) {
  await sleep(1000);
  const r = await fetch(url, { ...opts, headers: { ...UA, ...opts.headers }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

const text = s => s.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&middot;/g, "·").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const enc = encodeURIComponent;

// 제목·경력 문구에서 채용 구분 추출. 설명회·인턴십·仕事体験 같은 행사는 채용이 아니라서 "인턴"으로만 분류
const EVENT = /説明会|セミナー|仕事体験|オープン・?カンパニー|インターン|1day|2days|5days?|설명회|세미나|인턴십/i;
function types(s) {
  if (EVENT.test(s)) return ["intern"];
  const t = [];
  if (/신입|新卒|新入社員|未経験/.test(s)) t.push("new");
  if (/경력|中途|経験者/.test(s)) t.push("exp");
  if (/인턴|インターン/.test(s)) t.push("intern");
  if (/경력무관|신입·경력|신입 및 경력/.test(s)) t.push("new", "exp");
  return [...new Set(t)];
}

async function jobkorea() {
  const out = [];
  for (const kw of ["신입", "경력", "인턴", "일본어"]) for (const page of [1, 2, 3]) {
    const h = await get(`https://www.jobkorea.co.kr/Search/?stext=${enc(kw)}&tabType=recruit&Page_No=${page}`);
    for (const c of h.split('data-sentry-component="CardJob"').slice(1)) {
      const id = (c.match(/GI_Read\/(\d+)/) || [])[1];
      const spans = [...c.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map(m => text(m[1])).filter(Boolean);
      const i = spans.indexOf("스크랩");
      if (!id || i < 0) continue;
      const [title, company, location, tags, career] = spans.slice(i + 1);
      out.push({ site: "잡코리아", loc: "kr", id: "jk" + id, title, company, location, tags, career,
        types: types(career + " " + title), url: `https://www.jobkorea.co.kr/Recruit/GI_Read/${id}` });
    }
  }
  return out;
}

async function jasoseol() {
  const now = new Date(), end = new Date(now.getTime() + 45 * 864e5);
  const j = JSON.parse(await get("https://jasoseol.com/employment/calendar_list.json", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ start_time: now.toISOString(), end_time: end.toISOString() }),
  }));
  // division: 1 신입, 2 경력, 3 인턴, 5 신입·경력
  const div = { 1: ["new"], 2: ["exp"], 3: ["intern"], 5: ["new", "exp"] };
  return j.employment.filter(e => new Date(e.end_time) >= now).map(e => ({
    site: "자소설닷컴", loc: "kr", id: "js" + e.id, title: e.title, company: e.name, location: "",
    tags: "", deadline: e.end_time.slice(0, 10),
    types: [...new Set(e.employments.flatMap(x => div[x.division] || []))],
    url: `https://jasoseol.com/recruit/${e.id}`,
  }));
}

async function mynavikorea() {
  const out = [];
  // recruit_list = 국내(일본계 한국법인 등), recruit_tube_list = 해외(일본 현지)
  for (const [list, loc] of [["recruit_list", "kr"], ["recruit_tube_list", "jp"]]) for (const page of [1, 2, 3, 4, 5]) {
    const h = await get(`https://www.mynavikorea.co.kr/recruit/${list}?lpage=${page}`);
    for (const c of h.split('class="result_body').slice(1)) {
      const id = (c.match(/list_proc\.view\('(\d+)'\)/) || [])[1];
      if (!id) continue;
      const title = text((c.match(/class="tit_txt"[^>]*>([\s\S]*?)<\/span>/) || [, ""])[1]);
      const bars = [...c.matchAll(/<span class="bar">([\s\S]*?)<\/span>/g)].map(m => text(m[1]));
      out.push({ site: "마이나비코리아", loc: /^\[일본\s/.test(title) ? "jp" : loc, id: "mk" + id, title,
        company: (title.match(/^\[([^\]]+)\]/) || [, ""])[1], tags: bars[0] || "", career: bars[1] || "",
        location: bars.slice(2).join(" "),
        types: types((bars[1] || "") + " " + title), url: `https://www.mynavikorea.co.kr/recruit/recruit_view?r_seq=${id}` });
    }
  }
  return out;
}

async function rikunabi() {
  // robots.txt가 gy(졸업연도) 파라미터를 막고 있어서 연도별 검색은 하지 않음
  // job_search는 인턴십·설명회·仕事体験만 올라오는 페이지라 전부 "인턴"으로 분류
  const out = [];
  for (const kw of ["", "営業", "エンジニア", "事務", "企画"]) {
    const h = await get(`https://job.rikunabi.com/job_search/${kw ? "?kw=" + enc(kw) : ""}`);
    for (const c of h.split('class="styles_card__').slice(1)) {
      const href = (c.match(/href="(\/job_descriptions\/[^"?]+)/) || [])[1];
      if (!href) continue;
      const pick = re => text((c.match(re) || [, ""])[1]);
      const prog = pick(/styles_programType[^>]*>([\s\S]*?)<\/li>/);
      out.push({ site: "リクナビ", loc: "jp", id: "rk" + href, title: pick(/<h3[^>]*>([\s\S]*?)<\/h3>/),
        company: pick(/styles_employerName[^"]*"[^>]*>([\s\S]*?)<\/p>/), tags: pick(/styles_sector[^"]*"[^>]*>([\s\S]*?)<\/p>/),
        location: pick(/data-beforetype="location"[^>]*>([\s\S]*?)<\/span>/), career: prog,
        types: ["intern"], url: "https://job.rikunabi.com" + href });
    }
  }
  return out;
}

async function careertasu() {
  const out = [];
  for (const kw of ["", "商社", "IT", "メーカー", "金融"]) {
    const h = await get(`https://job.career-tasu.jp/condition-search/result/${kw ? "?keyword=" + enc(kw) : ""}`);
    for (const c of h.split('<li><a class="c_panelLink').slice(1)) {
      const href = (c.match(/href="(\/corp\/[^"]+)"/) || [])[1];
      if (!href) continue;
      const [location, ...ind] = text((c.match(/c_panelCompanyInfoMain__txt">([\s\S]*?)<\/p>/) || [, ""])[1]).split(/\s+/);
      const name = text((c.match(/c_panelCompanyInfoMain__ttl">([\s\S]*?)<\/h2>/) || [, ""])[1]);
      out.push({ site: "キャリタス就活", loc: "jp", id: "ct" + href, title: name + " 新卒採用", company: name,
        tags: ind.join(" "), location, types: ["new"], url: "https://job.career-tasu.jp" + href });
    }
  }
  return out;
}

async function build() {
  const sources = { 잡코리아: jobkorea, 자소설닷컴: jasoseol, 마이나비코리아: mynavikorea, リクナビ: rikunabi, キャリタス就活: careertasu };
  // 사이트끼리는 동시에, 한 사이트 안에서는 순서대로
  const res = await Promise.allSettled(Object.values(sources).map(f => f()));
  const file = path.join(__dirname, "jobs.json");
  let prev = [];
  try { prev = JSON.parse(fs.readFileSync(file, "utf8")).jobs; } catch {}
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set(), jobs = [], errors = [];
  Object.keys(sources).forEach((name, i) => {
    let got = res[i].status === "fulfilled" ? res[i].value : [];
    if (!got.length) {
      // 실패한 사이트는 직전 수집분을 유지 (마감 지난 공고는 뺌)
      got = prev.filter(j => j.site === name && !(j.deadline && j.deadline < today));
      errors.push(`${name}: ${res[i].status === "rejected" ? res[i].reason.message : "공고 0건"}${got.length ? ` (이전 수집분 ${got.length}건 표시 중)` : ""}`);
    }
    for (const j of got) if (!seen.has(j.id)) { seen.add(j.id); jobs.push(j); }
  });
  // 전부 실패하면 기존 jobs.json을 덮어쓰지 않음
  if (!jobs.length) throw new Error("모든 사이트 수집 실패: " + errors.join(" / "));
  fs.writeFileSync(file, JSON.stringify({ jobs, errors, fetched: new Date().toISOString() }));
  console.log(`jobs.json: ${jobs.length}건`, errors.length ? "\n오류: " + errors.join("\n") : "");
}

function serve() {
  const mime = { ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8" };
  require("http").createServer((req, res) => {
    const f = path.join(__dirname, path.basename(new URL(req.url, "http://x").pathname) || "index.html");
    if (!mime[path.extname(f)] || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": mime[path.extname(f)] });
    fs.createReadStream(f).pipe(res);
  }).listen(3000, () => console.log("http://localhost:3000"));
}

if (process.argv[2] === "serve") serve();
else build().catch(e => { console.error(e.message); process.exit(1); });
