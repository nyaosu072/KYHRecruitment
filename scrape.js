// 채용공고 수집 → jobs.json. 외부 패키지 없음 (キャリタス就活만 playwright-core 필요, 없으면 그 사이트만 건너뜀).
//   node scrape.js        공고를 모아 jobs.json에 저장 (GitHub Actions가 몇 시간마다 실행)
//   node scrape.js serve  jobs.json과 index.html을 http://localhost:3000 으로 미리보기
// robots.txt를 지키고, 로그인·봇 차단이 있는 사이트(잡플래닛, 슈퍼루키, 네이버 카페, 마이나비 재팬)는 수집하지 않음.
const fs = require("fs");
const path = require("path");

const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36" };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 같은 사이트에 1초 간격으로 순서대로 요청. 연결 오류는 5번까지(5·10·15·20초 쉬고) 다시 시도하고, 실패하면 원인 코드를 남김
// GitHub(미국) → 잡코리아 연결이 가끔 시간 초과로 끊겨서 넉넉히 기다림
async function get(url, opts = {}) {
  for (let i = 1; ; i++) {
    await sleep(i === 1 ? 1000 : 5000 * (i - 1));
    try {
      const r = await fetch(url, { ...opts, headers: { ...UA, ...opts.headers }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { final: true });
      return await r.text();
    } catch (e) {
      if (e.final || i >= 5) throw new Error(`${e.message}${e.cause ? " (" + (e.cause.code || e.cause.message) + ")" : ""} ${url}`);
    }
  }
}

const text = s => s.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&middot;/g, "·").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
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
  if (/계약직|파견직|契約社員|派遣/.test(s)) t.push("contract");
  return [...new Set(t)];
}

// 예상 입사년도. 제목에 적힌 연도로 판단하고, 일본 신졸 사이트는 지금 모집 중인 졸업연도로 채움. 모르면 null
// - "28卒" → 2028 (일본은 졸업한 해 4월 입사)
// - "2026 하반기 공채" → 2027 (하반기 공채는 보통 다음 해 초 입사), "2027년 신입" → 2027
// - "26년 하반기" 처럼 두 자리도 인정, "경력 10년" 같은 기간은 무시
function entryYear(j, now = new Date()) {
  const t = j.title;
  let m = t.match(/(\d\d)卒/);
  if (m) return 2000 + +m[1];
  const jpSite = ["キャリタス就活", "リクナビ", "キャリアチケット"].includes(j.site);
  // 일본 사이트 제목의 "2026年10月開催"는 행사 날짜라서 연도 숫자는 한국 사이트에서만 봄
  m = !jpSite && t.match(/(?:^|[^\d])(20\d\d|'?\d\d(?=년))\s*년?\s*(?:도\s*)?(상반기|하반기)?/);
  if (m) {
    const y = m[1].length === 4 ? +m[1] : 2000 + +m[1].replace("'", "");
    if (y >= now.getFullYear() - 1 && y <= now.getFullYear() + 4) return m[2] === "하반기" ? y + 1 : y;
  }
  // 일본 신졸 채용은 3월에 다음 졸업연도로 넘어감: 본선고 = 올해 3월 이후면 내년 졸업생, 인턴십은 그다음 해
  if (jpSite) {
    const base = now.getFullYear() + (now.getMonth() >= 2 ? 1 : 0);
    return j.types.includes("intern") ? base + 1 : base;
  }
  return null;
}

// 제목에 연도가 없을 때의 추정: 경력은 즉시 입사(올해), 신입·인턴은 9월 이후 공고면 다음 해
function guessYear(j, now = new Date()) {
  const y = now.getFullYear();
  if (!j.types.includes("new") && !j.types.includes("intern") && (j.types.includes("exp") || j.types.includes("contract"))) return y;
  return now.getMonth() >= 8 ? y + 1 : y;
}

// 선고 연결: 제목에 적힌 표현만 인정 (본선고 직결 > 조기선고 우대). 없으면 null
function selTag(title) {
  if (/本選考直結|選考直結|内定直結|採用直結|本選考に直結|본선고 ?직결/.test(title)) return "direct";
  if (/早期選考|選考優遇|選考免除|一次免除|選考パス|ES免除|조기 ?선고|채용 ?연계/.test(title)) return "early";
  return null;
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
    types: [...new Set([...e.employments.flatMap(x => div[x.division] || []), ...types(e.title)])],
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
        types: types((bars[1] || "") + " " + title + " " + (text(c).match(/#\s*(정규직|계약직|파견직)/g) || []).join(" ")), url: `https://www.mynavikorea.co.kr/recruit/recruit_view?r_seq=${id}` });
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

// キャリタス就活은 AWS WAF가 JavaScript 확인을 거친 브라우저에만 페이지를 내줌(2026-10-14부터).
// 그래서 이 사이트만 Playwright 헤드리스 브라우저로 염. 설치된 Chrome이 있으면 쓰고, 없으면 Playwright의 Chromium
async function browserPages(urls) {
  let pw;
  try { pw = require("playwright"); } catch { try { pw = require("playwright-core"); } catch { throw new Error("playwright가 설치되어 있지 않음 (npm i --no-save playwright-core)"); } }
  const b = await pw.chromium.launch({ channel: "chrome" }).catch(() => pw.chromium.launch());
  try {
    const page = await b.newPage();
    // 이미지·글꼴·영상은 받지 않음
    await page.route("**/*", r => ["image", "font", "media"].includes(r.request().resourceType()) ? r.abort() : r.continue());
    const out = [];
    for (const url of urls) {
      await sleep(1000);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      // 첫 요청은 WAF 확인 후 새로고침되므로 목록이 뜰 때까지 기다림
      await page.waitForSelector("a.c_panelLink", { timeout: 30000 }).catch(() => {});
      out.push(await page.content());
    }
    return out;
  } finally { await b.close(); }
}

async function careertasu() {
  const out = [];
  const urls = ["", "商社", "IT", "メーカー", "金融"].map(kw => `https://job.career-tasu.jp/condition-search/result/${kw ? "?keyword=" + enc(kw) : ""}`);
  for (const h of await browserPages(urls)) {
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

// 한국 시간 기준 YYYY-MM-DD
const kstDate = d => new Date(new Date(d).getTime() + 9 * 3600e3).toISOString().slice(0, 10);

async function linkareer() {
  // 목록 페이지의 __NEXT_DATA__ 안에 Apollo 캐시로 공고가 들어 있음
  const kind = { NEW: "new", EXPERIENCED: "exp", INTERN: "intern", CONTRACT: "contract" };
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const h = await get(`https://linkareer.com/list/recruit?filterBy_activityTypeID=5&filterBy_status=OPEN&orderBy_direction=DESC&orderBy_field=RECENT&page=${page}`);
    const nd = JSON.parse((h.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/) || [, "{}"])[1]);
    const st = nd.props?.pageProps?.__APOLLO_STATE__ || {};
    for (const [k, a] of Object.entries(st)) {
      if (!/^Activity:\d+$/.test(k) || !a.title) continue;
      const regions = (a.regions || []).map(r => r.name);
      // 링커리어 지역은 국내 시·도 + "해외" 하나뿐이라, 일본인지는 제목으로 판단. 그 밖의 해외는 "ovs"
      const loc = /일본|도쿄|東京|오사카|大阪|Japan/i.test(a.title + regions.join(" ")) ? "jp" : regions.includes("해외") ? "ovs" : "kr";
      out.push({ site: "링커리어", loc, id: "lk" + a.id, title: a.title,
        company: a.organizationName, location: regions.join(" "),
        tags: (a.categories || []).map(c => st[c.__ref]?.name).filter(Boolean).join(", "),
        deadline: a.recruitCloseAt ? kstDate(a.recruitCloseAt) : undefined,
        types: [...new Set((a.jobTypes || []).map(t => kind[t]).filter(Boolean))], url: `https://linkareer.com/activity/${a.id}` });
    }
  }
  return out;
}

async function gaishishukatsu() {
  // 공개 API. targetYear(졸업연도 = 입사년도)를 그대로 씀
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const j = JSON.parse(await get(`https://api-public.gaishishukatsu.com/3.0/recruitment?limit=100&order=deadline&allgy=true&page=${page}`, { headers: { accept: "application/json" } }));
    for (const r of j.recruitments) {
      const ends = (r.schedules || []).map(s => s.entryEnd).filter(Boolean).sort();
      out.push({ site: "外資就活", loc: "jp", id: "gs" + r.id, title: r.title,
        company: (r.companies || []).map(c => c.name).join(", "),
        tags: [...new Set([...(r.companies || []).map(c => c.industry), ...(r.groupedJobTypes || []).map(g => g.name)])].filter(Boolean).join(", "),
        career: r.type?.label, year: r.targetYear > 2000 ? r.targetYear : undefined,
        deadline: ends.length ? kstDate(ends.at(-1)) : r.displayEndAt ? kstDate(r.displayEndAt) : undefined,
        types: r.type?.label === "本選考" ? ["new"] : ["intern"], url: `https://gaishishukatsu.com/recruiting_info/view/${r.detailID}` });
    }
    if (!j.nextPage) break;
  }
  return out;
}

async function worldjob() {
  // 해외채용공고 전체(한 번에 50건) 중 일본 공고만
  const out = [], now = new Date();
  for (let page = 1; page <= 15; page++) {
    const h = await get("https://www.worldjob.or.kr/advnc/ajax/getEpmtList.do", { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", "x-requested-with": "XMLHttpRequest" },
      body: `showItemListCount=50&pageIndex=${page}&orderByType=DESC&orderByKey=A.DTA_RGST_DT&dobType=1&viewVersion=V2` });
    const boxes = h.split('class="post-box"').slice(1);
    if (!boxes.length) break;
    for (const b of boxes) {
      if (!b.includes('alt="일본 국기"')) continue;
      const v = b.match(/goView1\('([^']+)','([^']+)','([^']+)','([^']+)'\)/);
      if (!v) continue;
      const li = [...((b.match(/<ul>([\s\S]*?)<\/ul>/) || [, ""])[1]).matchAll(/<li>([\s\S]*?)<\/li>/g)].map(m => text(m[1].replace(/&nbsp;/g, " ")));
      const empType = (text(b).match(/\[\s*(정규직|계약직|파견직|인턴|기타)\s*\]/) || [, ""])[1];
      // 마감일은 "10/28(수)"처럼 월/일만 있음. 지난 달 숫자면 내년으로 봄
      const md = text((b.match(/day-box">([\s\S]*?)<\/p>/) || [, ""])[1]).match(/(\d\d)\/(\d\d)/);
      const deadline = md ? `${now.getFullYear() + (+md[1] < now.getMonth() ? 1 : 0)}-${md[1]}-${md[2]}` : undefined;
      const career = li[1] || "";
      out.push({ site: "월드잡플러스", loc: "jp", id: "wj" + v[1], title: text(b.match(/<h5[\s\S]*?<\/h5>/)[0]),
        company: text((b.match(/busiInfoPopup[^>]*>([\s\S]*?)<i/) || [, ""])[1]), tags: li[0], career, location: "일본", deadline,
        types: empType === "인턴" ? ["intern"] : [...(/무관/.test(career) ? ["new", "exp"] : /경력/.test(career) ? ["exp"] : ["new"]), ...(/계약직|파견직/.test(empType) ? ["contract"] : [])],
        url: `https://www.worldjob.or.kr/advnc/view.do?dobType=${v[4]}&joCrtfcNo=${v[1]}&joCrtfcDsp=${v[2]}&joCrtfcDspSn=${v[3]}` });
    }
  }
  return out;
}

async function daijob() {
  // 일본 근무(working_a_locations 230/102) + 新卒歓迎(company_features 1024)
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const h = await get(`https://www.daijob.com/jobs/search_result?working_a_locations[]=230&working_a_locations[]=102&job_search_form_hidden=1&company_features[]=1024&page=${page}`);
    const cards = h.split('class="job-card-wrap"').slice(1);
    if (!cards.length) break;
    for (const c of cards) {
      const id = (c.match(/\/jobs\/detail\/(\d+)/) || [])[1];
      if (!id) continue;
      const title = text((c.match(/job-card__title[^>]*>([\s\S]*?)<\/h2>/) || [, ""])[1]);
      out.push({ site: "Daijob", loc: "jp", id: "dj" + id, title,
        company: text((c.match(/fw-bolder[^>]*>([\s\S]*?)<\/div>/) || [, ""])[1]),
        location: text((c.match(/勤務地[\s\S]*?<dd>([\s\S]*?)<\/dd>/) || [, ""])[1]).replace(/^アジア\s*日本\s*/, ""),
        career: text((c.match(/job-card__tags">([\s\S]*?)<\/div>/) || [, ""])[1]).replace(/★\s*/g, ""),
        types: ["new", ...types(title).filter(t => t !== "new")], url: `https://www.daijob.com/jobs/detail/${id}` });
    }
  }
  return out;
}

async function careerticket() {
  // 기업 목록 첫 화면의 신졸 채용 기업 (설명회 목록은 현재 비어 있음)
  const h = await get("https://careerticket.jp/company/");
  const out = [], seen = new Set();
  for (const m of h.matchAll(/<a href="https:\/\/careerticket\.jp\/company\/(B\d+)\/" class="p-companyTopCard"[\s\S]*?<\/a>/g)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    const c = m[0], name = text((c.match(/p-companyTopCard__name">([\s\S]*?)<\/h3>/) || [, ""])[1]);
    out.push({ site: "キャリアチケット", loc: "jp", id: "ck" + m[1], title: name + " 新卒採用", company: name,
      tags: text((c.match(/p-companyTopCard__category">([\s\S]*?)<\/p>/) || [, ""])[1]),
      location: text((c.match(/p-companyTopCard__infoText">([\s\S]*?)<\/p>/) || [, ""])[1]),
      types: ["new"], url: `https://careerticket.jp/company/${m[1]}/` });
  }
  return out;
}

// マイナビ: robots.txt가 "?" 주소를 막고 Crawl-delay 120을 요구함. 그래서 사이트맵에 공개된 corpN/is.html만 120초 간격으로 받음.
// 한 번에 다 못 받으므로 mynavi.json에 쌓아 두고 다음 실행에서 이어 받음. ("?" 주소는 사용자가 누르는 링크로만 씀)
const MYNAVI_DELAY = 120000, MYNAVI_YEAR = 2028;

function parseMynavi(h, corp) {
  const company = text((h.match(/<title>([\s\S]*?)のインターンシップ/) || [, ""])[1]);
  const industry = (text(h).match(/業種\s+(\S+)/) || [])[1] || "";
  const out = [];
  for (const sec of h.split(/class="internList courseList"/).slice(1)) {
    const kind = text((sec.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) || [, ""])[1]);
    for (const c of sec.split('<div class="course">').slice(1)) {
      const a = c.match(/<h4>\s*<a href="([^"]*optNo=([^"&]+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/);
      if (!a) continue;
      const field = name => text((c.match(new RegExp(`<dt>${name}</dt>\\s*<dd>([\\s\\S]*?)</dd>`)) || [, ""])[1]);
      const d = field("応募締切").match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
      out.push({ site: "マイナビ", loc: "jp", id: `mn${corp}-${a[2]}`, title: text(a[3]), company, tags: industry,
        location: field("開催地域"), career: kind, year: MYNAVI_YEAR, types: ["intern"],
        deadline: d ? `${d[1]}-${d[2].padStart(2, "0")}-${d[3].padStart(2, "0")}` : undefined,
        url: "https://job.mynavi.jp" + a[1].replace(/&amp;/g, "&") });
    }
  }
  return out;
}

async function mynaviCrawl(limit) {
  const file = path.join(__dirname, "mynavi.json");
  let db = { next: 0, corps: {} };
  try { db = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const headers = UA;
  const save = () => fs.writeFileSync(file, JSON.stringify(db));
  const r = await fetch(`https://job.mynavi.jp/sitemap_${MYNAVI_YEAR}_corp.xml`, { headers, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`사이트맵 HTTP ${r.status}`);
  const corps = [...(await r.text()).matchAll(/\/search\/corp(\d+)\/is\.html/g)].map(m => m[1]);
  if (!corps.length) throw new Error("사이트맵에 기업이 없음");
  let done = 0, posts = 0;
  for (let n = 0; n < limit; n++) {
    await sleep(MYNAVI_DELAY);
    const corp = corps[db.next % corps.length];
    db.next = (db.next + 1) % corps.length;
    let res;
    try { res = await fetch(`https://job.mynavi.jp/${String(MYNAVI_YEAR).slice(2)}/pc/search/corp${corp}/is.html`, { headers, signal: AbortSignal.timeout(30000) }); }
    catch (e) { console.log(`corp${corp}: ${e.message}`); continue; }
    // 거부 응답이면 더 요청하지 않고 멈춤
    if (res.status === 403 || res.status === 429 || res.headers.get("x-amzn-waf-action")) { console.log(`중단: HTTP ${res.status}`); break; }
    if (!res.ok) { delete db.corps[corp]; continue; }
    const items = parseMynavi(await res.text(), corp);
    if (items.length) db.corps[corp] = { fetched: new Date().toISOString().slice(0, 10), items }; else delete db.corps[corp];
    done++; posts += items.length;
    if (done % 10 === 0) save(); // 중간에 끊겨도 받은 만큼 남김
  }
  save();
  console.log(`마이나비: 기업 ${done}곳, 공고 ${posts}건 / 누적 기업 ${Object.keys(db.corps).length}곳 / 다음 위치 ${db.next}/${corps.length}`);
}

// ワンキャリア: 목록 API는 외부 접근을 막아 쓰지 않음. 공개 사이트맵의 공고 주소와 상세 페이지만 받음.
// 로그인 화면으로 넘어가는 공고, 募集終了 공고는 건너뜀. 마감일은 페이지에 명확한 값이 없어 비워 둠.
function parseOnecareer(h, finalUrl, id) {
  const kind = (finalUrl.match(/\/events\/(selection|internship|seminar|gosetsu)\//) || [])[1];
  if (!kind) return null; // 로그인 화면 등
  const body = text(h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " "));
  if (/募集終了|受付終了|掲載終了|募集は終了/.test(body)) return null;
  const lds = [...h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => { try { return JSON.parse(m[1]); } catch { return null; } });
  const e = lds.find(x => x && x["@type"] === "Event");
  if (!e || !e.name) return null;
  const grad = body.match(/(20\d\d)年卒/);
  const start = (String(e.startDate || "").match(/(20\d\d)[-/](\d\d)[-/](\d\d)/) || []).slice(1).join("-");
  return { site: "ワンキャリア", loc: "jp", id: "oc" + id, title: e.name.trim(), company: (body.match(/の募集一覧 ＞ (.{1,60}?) ＞/) || [])[1] || "",
    career: { selection: "本選考", internship: "インターン", seminar: "説明会・セミナー", gosetsu: "合説・座談会" }[kind],
    year: grad ? +grad[1] : undefined, start: start || undefined, types: kind === "selection" ? ["new"] : ["intern"],
    url: `https://www.onecareer.jp/events/${kind}/${id}` };
}

async function onecareer() {
  const file = path.join(__dirname, "onecareer.json");
  let db = {};
  try { db = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const zlib = require("zlib");
  const r = await fetch("https://www.onecareer.jp/sitemaps/sitemap_events.xml.gz", { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`사이트맵 HTTP ${r.status}`);
  const xml = zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString();
  const urls = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map(m => [(m[1].match(/\/events\/(\d+)<\/loc>/) || [])[1], (m[1].match(/<lastmod>([^<]+)/) || [])[1]]).filter(u => u[0]);
  const live = new Set(urls.map(u => u[0]));
  for (const id of Object.keys(db)) if (!live.has(id)) delete db[id];
  const today = new Date().toISOString().slice(0, 10), stale = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
  // 새 공고·바뀐 공고·14일 지난 공고를 최근 갱신순으로 한 번에 150건
  const todo = urls.filter(([id, lm]) => !db[id] || db[id].lastmod !== lm || db[id].checked < stale).sort((a, b) => String(b[1]).localeCompare(String(a[1]))).slice(0, 150);
  for (const [id, lastmod] of todo) {
    await sleep(1500);
    let res;
    try { res = await fetch(`https://www.onecareer.jp/events/${id}`, { headers: UA, signal: AbortSignal.timeout(20000) }); } catch { continue; }
    if (res.status === 403 || res.status === 429 || res.headers.get("x-amzn-waf-action")) break; // 거부 응답이면 더 요청하지 않음
    if (!res.ok) continue;
    db[id] = { lastmod, checked: today, item: parseOnecareer(await res.text(), res.url, id) };
  }
  fs.writeFileSync(file, JSON.stringify(db));
  return Object.values(db).map(d => d.item).filter(j => j && !(j.start && j.start < today));
}

const SOURCES = { 잡코리아: jobkorea, 자소설닷컴: jasoseol, 링커리어: linkareer, 마이나비코리아: mynavikorea, 월드잡플러스: worldjob,
  リクナビ: rikunabi, キャリタス就活: careertasu, 外資就活: gaishishukatsu, キャリアチケット: careerticket, Daijob: daijob, ワンキャリア: onecareer };

function finish(j) {
  j.sel = selTag(j.title);
  j.year = j.year ?? entryYear(j);
  j.yearGuess = j.year == null;
  if (j.yearGuess) j.year = guessYear(j);
  return j;
}

// 연결 오류로 실패한 사이트만 다시 받아 jobs.json에 반영. 실패는 실행마다 배정되는 서버에 따라 갈려서,
// Actions의 다음 작업(새 서버)에서 실행함. 거부 응답(HTTP 403 등)은 다시 시도하지 않음
async function retryFailed() {
  const file = path.join(__dirname, "jobs.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const e of d.errors.filter(isConnError)) {
    const name = e.split(":")[0];
    try {
      const got = await SOURCES[name]();
      if (!got.length) continue;
      const seen = new Set();
      d.jobs = d.jobs.filter(j => j.site !== name).concat(got.filter(j => !seen.has(j.id) && seen.add(j.id)).map(finish));
      d.errors = d.errors.filter(x => x !== e);
      console.log(`${name}: ${seen.size}건 다시 받음`);
    } catch (err) { console.log(`${name}: 다시 실패 (${err.message})`); }
  }
  fs.writeFileSync(file, JSON.stringify(d));
}
const isConnError = e => /fetch failed|timeout|abort/i.test(e);

async function build() {
  const sources = SOURCES;
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
  // 마이나비는 별도 작업(mynaviCrawl)이 쌓아 둔 공고를 합침
  try {
    const db = JSON.parse(fs.readFileSync(path.join(__dirname, "mynavi.json"), "utf8"));
    for (const c of Object.values(db.corps)) for (const j of c.items)
      if (!seen.has(j.id) && !(j.deadline && j.deadline < today)) { seen.add(j.id); jobs.push(j); }
  } catch {}
  jobs.forEach(finish);
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

if (process.argv[2] === "test") {
  const now = new Date("2026-10-13"), y = (title, site = "잡코리아", types = ["new"]) => entryYear({ title, site, types }, now);
  const assert = require("assert");
  assert.equal(y("28卒_森永製菓_オープンカンパニー", "リクナビ", ["intern"]), 2028);
  assert.equal(y("2026년 하반기 신입 공개채용"), 2027);
  assert.equal(y("2026 하반기 DN솔루션즈 신입사원 채용"), 2027);
  assert.equal(y("[애경그룹] AK아이에스 2027년 신입사원 공개 채용"), 2027);
  assert.equal(y("[(주)코스알엑스]26년 하반기 경력 및 신입"), 2027);
  assert.equal(y("2026년도 하반기 신입직원 채용공고"), 2027);
  assert.equal(y("[일본계 한국법인] 반도체장비업계 총무(경력 10년 이상)"), null);
  assert.equal(y("渡辺パイプ 新卒採用", "キャリタス就活"), 2027);
  assert.equal(y("東芝のインターンシップ", "リクナビ", ["intern"]), 2028);
  assert.equal(y("【2026年10月開催】仕事体験", "リクナビ", ["intern"]), 2028);
  assert.equal(selTag("【内定直結】デジタルコンサルタント職 本選考"), "direct");
  assert.equal(selTag("【選考直結型OC】グローバルプロジェクト体験"), "direct");
  assert.equal(selTag("早期選考案内あり 1day仕事体験"), "early");
  assert.equal(selTag("소프트캠프 UX/UI 디자이너 (채용 연계형 인턴)"), "early");
  assert.equal(selTag("東宝 オンライン会社説明会"), null);
  assert.equal(guessYear({ types: ["exp"] }, now), 2026);
  assert.equal(guessYear({ types: ["contract"] }, now), 2026);
  assert.deepEqual(types("인천공항시설관리 2026년 제7차 계약직 채용"), ["contract"]);
  assert.deepEqual(types("신입·경력 계약직"), ["new", "exp", "contract"]);
  assert.equal(guessYear({ types: ["new", "exp"] }, now), 2027);
  assert.equal(guessYear({ types: ["new"] }, new Date("2026-05-01")), 2026);
  console.log("ok");
  const mn = parseMynavi(`<title>日本生命保険相互会社のインターンシップ＆キャリア | マイナビ2028</title><p>業種 生命保険 基本</p>
    <div class="internList courseList" id="w"><h2 class="dtHead">仕事体験</h2><div class="course"><h4> <a href="/28/pc/corpinfo/displayInternship/index?corpId=2&amp;optNo=L7v1q" id="x">【2DAYS】アクチュアリーコース</a></h4>
    <dl><div><dt>開催地域</dt> <dd> <span>東京</span> </dd></div><div><dt>応募締切</dt> <dd> <span class="last deadline">2027年1月3日</span> </dd></div></dl></div></div>`, "2");
  assert.deepEqual([mn.length, mn[0].id, mn[0].title, mn[0].company, mn[0].tags, mn[0].location, mn[0].career, mn[0].deadline],
    [1, "mn2-L7v1q", "【2DAYS】アクチュアリーコース", "日本生命保険相互会社", "生命保険", "東京", "仕事体験", "2027-01-03"]);
  assert.equal(mn[0].url, "https://job.mynavi.jp/28/pc/corpinfo/displayInternship/index?corpId=2&optNo=L7v1q");
  console.log("mynavi ok");
  const page = (name, extra = "") => `<script type="application/ld+json">{"@type":"Event","name":"${name}","startDate":"2026/11/05 14:00"}</script><p>本選考の募集一覧 ＞ 3WELL ＞ x 2028年卒 ${extra}</p>`;
  const oc = parseOnecareer(page("【28卒】説明会"), "https://www.onecareer.jp/events/internship/102623", "102623");
  assert.deepEqual([oc.title, oc.company, oc.year, oc.start, oc.types[0], oc.url], ["【28卒】説明会", "3WELL", 2028, "2026-11-05", "intern", "https://www.onecareer.jp/events/internship/102623"]);
  assert.equal(parseOnecareer(page("x"), "https://www.onecareer.jp/events/selection/1", "1").types[0], "new");
  assert.equal(parseOnecareer(page("x", "募集終了"), "https://www.onecareer.jp/events/selection/1", "1"), null);
  assert.equal(parseOnecareer("<p>login</p>", "https://id.onecareer.jp/users/sign_in", "1"), null);
  console.log("onecareer ok");
} else if (process.argv[2] === "mynavi") mynaviCrawl(+process.argv[3] || 150).catch(e => { console.error(e.message); process.exit(1); });
else if (process.argv[2] === "retry") retryFailed().catch(e => { console.error(e.message); process.exit(1); });
else if (process.argv[2] === "needs-retry") console.log(JSON.parse(fs.readFileSync(path.join(__dirname, "jobs.json"), "utf8")).errors.some(isConnError));
else if (process.argv[2] === "serve") serve();
else build().catch(e => { console.error(e.message); process.exit(1); });
