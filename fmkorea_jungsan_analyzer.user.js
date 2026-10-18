// ==UserScript==
// @name         정산 승률 분석기
// @namespace    fmkorea-jungsan-analyzer
// @version      6.6
// @description  잉여력놀이터 '정산' 게시판의 최근 24시간 내 마감 글들을 자동으로 읽어서 참가자별 승률(종합/종목별)을 집계합니다. 사이트 내부 AJAX(pp.getPpList)를 그대로 호출해서, 글을 일일이 열고 참여현황을 손으로 베낄 필요가 없습니다. 종합 랭킹에는 진행중인(아직 결과가 안 나온) 경기에 누가 어디 베팅했는지도 함께 보여줍니다.
// @match        https://www.fmkorea.com/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/srleeinkorea/rota-status2/main/fmkorea_jungsan_analyzer.user.js
// @downloadURL  https://raw.githubusercontent.com/srleeinkorea/rota-status2/main/fmkorea_jungsan_analyzer.user.js
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_VERSION = '6.6';
  const CATEGORIES = [
    { id: '4874265175', label: '정산' },
    { id: '5179656568', label: '정산(결산미포함)' },
  ];
  const MAX_LIST_PAGES = 8;              // 목록에서 최대 몇 페이지까지 훑을지
  // v2.8에서 동시요청을 과감히 늘렸다가 사이트 보안 시스템(비정상 접속 탐지)에 막히는 사고가
  // 있었음. v2.9부터는 동시요청 수를 최소로(최대 2개) 줄이고, 매 요청 사이에 사람이 쓰는 것처럼
  // 무작위 지연(지터)을 섞어서 "짧은 간격으로 수백 건을 일정하게 때리는" 패턴 자체를 피한다.
  // 속도는 캐시(한 번 받은 정산 결과는 다시 안 받아옴)로 보완한다.
  // v2.9에서 완전 보수적으로(동시 2개, 지연 260ms+지터) 낮췄던 걸, 차단 없이 버틴 걸 확인한
  // 뒤로 아주 조금씩만 다시 올리는 값들. 한 번에 크게 올리지 않고 글 처리 동시 수만 3으로,
  // 지연은 살짝만 줄인다 — 목록 페이지 동시조회는 여전히 꺼둔 채로(가장 의심스러웠던 부분).
  const REQUEST_DELAY_MS = 190;          // 요청 사이 기본 지연
  const REQUEST_JITTER_MS = 180;         // 기본 지연에 더해지는 무작위 지연(0~이 값 사이)
  const CONCURRENCY = 3;                 // 글 처리 동시 진행 수
  const LIST_PAGE_BATCH = 1;             // 목록 페이지는 여전히 동시에 여러 장 긁지 않고 한 장씩

  // ---------- GitHub 대시보드 동기화 ----------
  // 분석이 끝날 때마다 결과 JSON을 GitHub 저장소에 올려서, 별도의 GitHub Pages 대시보드가
  // 그 파일을 읽어 보여줄 수 있게 한다(진짜 실시간은 아니고, 분석을 돌릴 때마다 갱신됨 —
  // GitHub Pages는 정적 사이트라 fmkorea.com에 직접 요청을 못 보내기 때문).
  const GITHUB_REPO = 'srleeinkorea/rota-status2';
  const GITHUB_DATA_PATH = 'data.json';
  const GITHUB_STATUS_PATH = 'status.json';
  const GH_TOKEN_KEY = 'jsa-gh-token-v1';
  const UPLOAD_TOP_N = 300; // 대시보드에 올릴 종합 랭킹 인원 수 (100명은 부족하다는 요청으로 상향)

  // ---------- 유틸 ----------
  // 크롬은 화면에 안 보이는 탭의 setTimeout을 크게 늦춘다(숨겨진 뒤 5분이 지나면 1분에 한 번).
  // 이 분석기는 글 사이사이 짧은 지연을 두고 순차 처리하므로, 그 상태에선 사실상 멈춘 것처럼
  // 기어간다. 무음 오디오로 제한을 푸는 방법은 사용자가 탭을 한 번도 건드리지 않으면
  // 오디오가 suspended로 막혀 효과가 없었다. 웹 워커의 타이머는 이 제한을 받지 않으므로,
  // 지연은 워커에 맡기고 실패할 때만 setTimeout으로 대체한다.
  const sleepWorker = (() => {
    try {
      const src = 'onmessage=function(e){setTimeout(function(){postMessage(e.data.id);},e.data.ms);}';
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })));
      const pending = new Map();
      let seq = 0;
      w.onmessage = (e) => {
        const done = pending.get(e.data);
        if (done) { pending.delete(e.data); done(); }
      };
      return { wait: (ms) => new Promise((res) => { const id = ++seq; pending.set(id, res); w.postMessage({ id, ms }); }) };
    } catch (e) { return null; }
  })();

  function sleep(ms) {
    if (sleepWorker) return sleepWorker.wait(ms);
    return new Promise((r) => setTimeout(r, ms));
  }
  // 매번 똑같은 간격이 아니라 사람처럼 들쭉날쭉하게 — 요청 지문(fingerprint)을 피하기 위함
  function sleepJitter(base) { return sleep((base || REQUEST_DELAY_MS) + Math.random() * REQUEST_JITTER_MS); }

  // 분석 시작 시 고를 수 있는 기간 필터
  // maxPages: 기간이 길수록 목록을 더 깊이(여러 페이지) 훑어야 하므로 기간별로 다르게 설정
  const WINDOW_OPTIONS = [
    { value: 'today', label: '오늘', maxPages: 8, rangeStart: (now) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0) },
    { value: '24h', label: '최근 24시간', maxPages: 8, rangeStart: (now) => new Date(now.getTime() - 24 * 3600 * 1000) },
    { value: '2d', label: '최근 2일', maxPages: 12, rangeStart: (now) => new Date(now.getTime() - 2 * 24 * 3600 * 1000) },
    { value: '3d', label: '최근 3일', maxPages: 16, rangeStart: (now) => new Date(now.getTime() - 3 * 24 * 3600 * 1000) },
    { value: '5d', label: '최근 5일', maxPages: 25, rangeStart: (now) => new Date(now.getTime() - 5 * 24 * 3600 * 1000) },
    { value: '7d', label: '최근 7일', maxPages: 35, rangeStart: (now) => new Date(now.getTime() - 7 * 24 * 3600 * 1000) },
    { value: '15d', label: '최근 15일', maxPages: 70, rangeStart: (now) => new Date(now.getTime() - 15 * 24 * 3600 * 1000) },
    { value: '30d', label: '최근 30일', maxPages: 140, rangeStart: (now) => new Date(now.getTime() - 30 * 24 * 3600 * 1000) },
  ];
  function getWindowOption(value) {
    return WINDOW_OPTIONS.find((o) => o.value === value) || WINDOW_OPTIONS[1];
  }

  // 제목에서 [마감 M/D hh:mm] 패턴을 실제 Date 객체로 변환
  // (연도는 제목에 없으므로, 지금 시각 기준으로 가장 그럴듯한 연도를 추론: 만들어진 시각이
  //  미래로 12시간 넘게 벗어나면 작년으로 간주해서 연도를 보정 — 연말/연초 경계 대비)
  function extractDeadlineDate(title) {
    const m = title.match(/마감\s*(\d{1,2})\/(\d{1,2})\s*(\d{1,2}):(\d{1,2})/);
    if (!m) return null;
    const now = new Date();
    let year = now.getFullYear();
    const month = parseInt(m[1], 10) - 1;
    const day = parseInt(m[2], 10);
    const hour = parseInt(m[3], 10);
    const minute = parseInt(m[4], 10);
    let dt = new Date(year, month, day, hour, minute);
    if (dt.getTime() - now.getTime() > 180 * 24 * 3600 * 1000) {
      dt = new Date(year - 1, month, day, hour, minute); // 연말/연초 경계 보정
    }
    return dt;
  }

  // 마감 시각이 [start, end] 구간 안에 있는지 판단 (start 이상, end 이하)
  function isWithinRange(title, start, end) {
    const dt = extractDeadlineDate(title);
    if (!dt) return false;
    return dt.getTime() >= start.getTime() && dt.getTime() <= end.getTime();
  }

  // 종목 분류 (제목 키워드 기반, 필요시 자유롭게 추가/수정)
  // 순서가 중요하다. 위에서부터 먼저 걸리는 규칙이 적용되므로, 더 구체적인 것을 위에 둔다.
  // (예: 'K리그1'을 프랑스 '리그1'보다 먼저, 'AFC 챔피언스리그 2'를 UCL보다 먼저)
  const SPORT_RULES = [
    // 3x3은 일반 농구와 경기 양상이 달라 따로 집계한다. 다른 농구 규칙보다 앞에 둬야 한다.
    [/3\s*x\s*3|3대3/i, '3x3 농구(FIBA)'],

    // ---- 축구: 국내 ----
    [/K리그\s*1/, '축구/국내 K리그1'],
    [/K리그\s*2/, '축구/국내 K리그2'],
    [/코리아컵|FA컵/, '축구/국내 컵대회'],

    // ---- 축구: 아시아 ----
    [/AFC|ACL\s*2|\bACL\b|챔피언스리그 엘리트/, '축구/아시아 AFC'],
    [/J리그/, '축구/아시아 J리그'],
    [/\bISL\b|인도 슈퍼리그/, '축구/아시아 ISL'],

    // ---- 축구: 유럽 대항전 ----
    [/\bUCL\b|UEFA 챔피언스리그|챔스/, '축구/유럽 UCL'],
    [/\bUEL\b|유로파/, '축구/유럽 UEL'],
    [/\bUECL\b|컨퍼런스리그/, '축구/유럽 UECL'],
    [/UEFA\s*유스/, '축구/유럽 UEFA 유스리그'],

    // ---- 축구: 해외 리그 ----
    [/\bPL\b|EPL|프리미어리그/, '축구/해외 EPL'],
    [/\bEFL\b/, '축구/해외 EFL 챔피언십'],
    [/라리가/, '축구/해외 라리가'],
    [/분데스리가/, '축구/해외 분데스리가'],
    [/세리에\s*A/, '축구/해외 세리에A'],
    [/에레디비시/, '축구/해외 에레디비시'],
    [/프리메이라/, '축구/해외 프리메이라'],
    [/리그\s*1/, '축구/해외 리그1(프랑스)'],
    [/\bMLS\b/, '축구/해외 MLS'],
    [/A-?리그/, '축구/해외 A리그(호주)'],
    [/FIFA|월드컵|네이션스리그|친선경기/, '축구/국가대표'],

    // ---- 그 외 종목 ----
    [/ETTU|탁구/, '탁구(ETTU)'],
    [/BWF|배드민턴/, '배드민턴(BWF)'],
    // ---- 배구: 국내 / 해외 ----
    [/KOVO|V리그|한국배구/, '배구/국내 KOVO'],
    [/튀르키예.*배구|술탄라리기/, '배구/해외 튀르키예'],
    [/폴란드.*배구|플러스리가/, '배구/해외 폴란드'],
    [/이탈리아.*배구|세리에.*배구/, '배구/해외 이탈리아'],
    [/러시아.*배구/, '배구/해외 러시아'],
    [/카자흐스탄.*배구/, '배구/해외 카자흐스탄'],
    [/일본.*배구|\bSV리그\b/, '배구/해외 일본'],
    [/\bFIVB\b|VNL|세계선수권.*배구|배구.*세계선수권/, '배구/국제대회'],
    [/배구/, '배구/해외 기타'],
    [/WTA/, '테니스(WTA)'],
    [/ATP/, '테니스(ATP)'],
    [/LOL|LCK|DCGI/, 'LOL'],
    [/VCT|발로란트/, '발로란트(VCT)'],
    [/NBA/, 'NBA'],
    [/NFL/, 'NFL(미식축구)'],
    [/KBL/, 'KBL(농구)'],
    [/\bCBA\b/, 'CBA(농구)'],
    [/\bMLB\b/, 'MLB(야구)'],
    [/\bKBO\b/, 'KBO(야구)'],
    [/\bNPB\b/, 'NPB(야구)'],
    [/\bNHL\b|IIHF|아이스하키/, '아이스하키'],
    [/스타크래프트|\bASL\b|스타끝장전/, '스타크래프트'],
  ];

  function classifySport(title) {
    for (const [re, label] of SPORT_RULES) {
      if (re.test(title)) return label;
    }
    return '기타';
  }

  // 글 제목에서 두 선택지(팀/옵션) 이름만 짧게 추출.
  // 예: "[마감 10/13 18:59] AFC 챔피언스리그 엘리트 :: 포항 스틸러스(+0.5) vs 조호르 다룰 탁짐 :: 10/13 19:00 경기"
  //  -> { a: "포항 스틸러스", b: "조호르 다룰 탁짐" }
  // "::"로 구분된 조각들 중 "vs"가 들어간 조각을 찾아 양쪽을 나눈다. 핸디캡/배당 괄호는 제거.
  function extractMatchupTeams(title) {
    const parts = title.split('::').map((s) => s.trim());
    for (const part of parts) {
      const m = part.match(/^(.+?)\s+vs\.?\s+(.+?)$/i);
      if (m) {
        const clean = (s) => s.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').trim();
        const a = clean(m[1]);
        const b = clean(m[2]);
        if (a && b) return { a, b };
      }
    }
    return null;
  }

  // ---------- 1. 선택한 기간 내 마감 글 목록 수집 (정산 + 정산(결산미포함) 두 카테고리 모두) ----------
  async function fetchListPage(categoryId, page) {
    const url = `https://www.fmkorea.com/index.php?mid=pointplay&category=${categoryId}&page=${page}`;
    const res = await fetch(url, { credentials: 'same-origin' });
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const anchors = Array.from(doc.querySelectorAll('a[href*="document_srl="]'));
    const posts = [];
    const seen = new Set();
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      // 댓글 링크(#..._comment)는 제외, 제목 링크만
      const m = href.match(/document_srl=(\d+)$/);
      if (!m) continue;
      const srl = m[1];
      const title = (a.textContent || '').trim();
      if (!title || !title.startsWith('[마감')) continue;
      if (seen.has(srl)) continue;
      seen.add(srl);
      posts.push({ document_srl: srl, title });
    }
    return posts;
  }

  // 목록 페이지를 LIST_PAGE_BATCH개씩 묶어서 동시에 가져온다. 몇 페이지까지 더 가야 하는지는
  // 페이지를 열어봐야 알 수 있으므로, 배치 전체를 받은 뒤 한꺼번에 판정한다
  // (최악의 경우 윈도우 경계를 LIST_PAGE_BATCH-1페이지 정도 더 넘어갈 수 있지만, 속도 이득이 더 크다).
  async function collectWindowPostsInCategory(categoryId, categoryLabel, log, start, end, windowLabel, maxPages) {
    const windowPosts = [];
    const limit = maxPages || MAX_LIST_PAGES;

    for (let page = 1; page <= limit; ) {
      const batchPages = [];
      for (let p = page; p < page + LIST_PAGE_BATCH && p <= limit; p++) batchPages.push(p);
      log(`[${categoryLabel}] 목록 ${batchPages[0]}~${batchPages[batchPages.length - 1]}페이지 확인 중... (${windowLabel} 기준)`);
      const batchResults = await Promise.all(batchPages.map((p) => fetchListPage(categoryId, p)));

      let shouldStop = false;
      for (let bi = 0; bi < batchResults.length; bi++) {
        const posts = batchResults[bi];
        if (posts.length === 0) { shouldStop = true; break; }
        let hitThisPage = 0;
        let pastWindowCount = 0; // 마감이 start보다 더 오래된 글
        for (const p of posts) {
          const dt = extractDeadlineDate(p.title);
          if (!dt) continue;
          if (isWithinRange(p.title, start, end)) {
            windowPosts.push(p);
            hitThisPage++;
          } else if (dt.getTime() < start.getTime()) {
            pastWindowCount++;
          }
        }
        const pageNum = batchPages[bi];
        // 목록은 최신순이므로, 이 페이지 전체가 윈도우보다 오래된 글이면 더 내려갈 필요 없음
        if (hitThisPage === 0 && pastWindowCount >= posts.length && pageNum > 1) shouldStop = true;
        if (pastWindowCount >= posts.length * 0.9 && hitThisPage === 0) shouldStop = true;
      }

      page += batchPages.length;
      if (shouldStop) break;
      if (page <= limit) await sleepJitter();
    }
    return windowPosts;
  }

  async function collectTodayPosts(log, start, end, windowLabel, maxPages) {
    // 두 카테고리를 동시에 긁지 않고 순서대로 — 동시요청을 최소화해서 사이트 보안 시스템에
    // 걸리지 않도록 함
    const all = [];
    for (const cat of CATEGORIES) {
      const posts = await collectWindowPostsInCategory(cat.id, cat.label, log, start, end, windowLabel, maxPages);
      all.push(...posts);
      await sleepJitter();
    }
    // 중복 제거 (혹시 같은 글이 두 카테고리 모두에 걸려 있을 경우 대비)
    const uniq = new Map();
    for (const p of all) uniq.set(p.document_srl, p);
    return Array.from(uniq.values());
  }

  // ---------- 2. 각 글의 pk(point-game id) 추출 ----------
  // pk와 함께 실제 선택지 이름도 같이 뽑는다.
  // 제목만 보고 "A vs B"를 선택지로 쓰면 언/오버나 O/X 같은 글에서 틀린 이름이 붙는다
  // (예: "라리가 양팀 득점 합 [2.5] 언/오버 :: 레알 베티스 vs 바르셀로나"의 선택지는
  //  팀이 아니라 "2.5 언더"/"2.5 오버"). 글 페이지의 label.label2가 실제 선택지 이름이다.
  async function fetchPostDetail(document_srl) {
    // 짧은 URL 형태(/문서번호)가 긴 쿼리스트링 형태보다 안정적으로 응답함(간헐적 432 차단 회피)
    const url = `https://www.fmkorea.com/${document_srl}`;
    // 432(일시 차단)는 간헐적으로 뜬다. 여기서 실패하면 선택지 이름을 놓치므로 조금씩
    // 간격을 늘려가며 두 번까지 더 시도한다.
    let res = await fetch(url, { credentials: 'same-origin' });
    for (let attempt = 1; attempt <= 2 && res.status === 432; attempt++) {
      await sleep(800 * attempt);
      res = await fetch(url, { credentials: 'same-origin' });
    }
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/getPpListClick\((\d+)\s*,\s*1\)/);
    if (!m) return null;
    let labels = null;
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const ls = Array.from(doc.querySelectorAll('label.label2'))
        .map((l) => (l.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      if (ls.length >= 2) labels = { a: ls[0], b: ls[1] };
    } catch (e) { /* 실패하면 제목 파싱으로 대체 */ }
    return { pk: parseInt(m[1], 10), labels };
  }

  // ---------- 3. pp.getPpList AJAX 호출 (페이지네이션 포함) ----------
  function execJson(action, params) {
    return new Promise((resolve, reject) => {
      try {
        window.jQuery.exec_json(action, params, (p) => resolve(p));
      } catch (e) {
        reject(e);
      }
      setTimeout(() => reject(new Error('timeout: ' + action)), 10000);
    });
  }

  async function fetchAllOptionEntries(pk, optionNum) {
    let page = 1;
    let all = [];
    let winOption = null;
    while (true) {
      const params = { pk, o_win: optionNum };
      if (page > 1) params.page = page;
      const p = await execJson('pp.getPpList', params);
      if (!p || p.error) break;
      winOption = p.o_win;
      const list = (p.bet_all && p.bet_all.o_list) ? p.bet_all.o_list : [];
      all = all.concat(list);
      if (p.page_last && p.page_cur < p.page_last) {
        page = p.page_cur + 1;
        await sleepJitter();
        continue;
      }
      break;
    }
    return { entries: all, winOption };
  }

  // 글 하나(pk)에 대해 승/패 참가자(닉네임 + 베팅액/배당금) 리스트를 구함
  async function fetchPostResult(pk) {
    // 옵션1, 옵션2를 동시에 보내지 않고 순서대로 — 동시요청을 최소화
    const opt1 = await fetchAllOptionEntries(pk, 1);
    await sleepJitter();
    const opt2 = await fetchAllOptionEntries(pk, 2);
    const winOption = opt1.winOption || opt2.winOption; // 1 또는 2 (실제 승리 옵션)

    const winList = [];
    const loseList = [];

    const bucket1 = winOption === 1 ? winList : loseList;
    const bucket2 = winOption === 2 ? winList : loseList;

    function toEntry(e) {
      return { name: e.nick_name, bet: e.point || 0, payout: e.point_after || 0 };
    }
    for (const e of opt1.entries) if (e.nick_name) bucket1.push(toEntry(e));
    for (const e of opt2.entries) if (e.nick_name) bucket2.push(toEntry(e));

    return { winList, loseList, winOption };
  }

  // ---------- 3.5. 진행중인(아직 결과 안 나온) 경기 베팅 현황 수집 ----------
  // 종합 랭킹 "진행중인 베팅" 컬럼용. 과거 정산 집계와는 별개로, 지금 이 시점에 열려있는
  // 경기들에 누가 어느 팀에 걸어뒀는지를 모은다. '진행중인 경기' 목록 페이지
  // (mid=pointplay&act=dispBoardOngoingMatches)를 직접 긁어서 사용한다 — 지금 그 페이지에
  // 있으면 현재 DOM을 그대로 쓰고, 다른 페이지(마감 탭 등)에 있으면 fetch로 가져온다.
  function extractOngoingPostsFromDoc(doc) {
    const anchors = Array.from(doc.querySelectorAll('a.pointplay-match-title'));
    const posts = [];
    const seen = new Set();
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/document_srl=(\d+)/);
      if (!m) continue;
      const srl = m[1];
      const title = (a.textContent || '').trim();
      if (!title || seen.has(srl)) continue;
      seen.add(srl);
      posts.push({ document_srl: srl, title });
    }
    return posts;
  }

  // 항상 서버에서 새로 받아온다. 예전엔 "지금 이 페이지가 진행중인 경기 목록이면 현재 DOM을
  // 그대로 쓴다"는 최적화가 있었는데, 그 탭이 오래 열려 있으면 페이지를 연 시점의 낡은 목록을
  // 읽어버려서 — 이미 마감된 경기가 남고 새로 열린 경기는 빠진 채로 — 대시보드에 올라갔다.
  // 요청 1번 더 보내는 비용보다 최신성이 훨씬 중요하므로 DOM 지름길을 없앴다.
  async function getOngoingMatchPosts() {
    const url = `https://www.fmkorea.com/index.php?mid=pointplay&act=dispBoardOngoingMatches&_=${Date.now()}`;
    const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return extractOngoingPostsFromDoc(doc);
  }

  // 진행중인 경기 하나(pk)에 걸린 사람들을 옵션별로 모음 — 아직 승패가 안 갈렸으므로
  // fetchPostResult와 달리 승/패 구분 없이 "누가 어느 옵션에 걸었는지"만 필요하다.
  async function fetchOngoingBettors(pk) {
    const opt1 = await fetchAllOptionEntries(pk, 1);
    await sleepJitter();
    const opt2 = await fetchAllOptionEntries(pk, 2);
    return { opt1: opt1.entries, opt2: opt2.entries };
  }

  // 경기(글) 여러 건을 CONCURRENCY개씩 동시에 처리 — 한 건씩 순서대로 기다리지 않는다.
  // 사람별 picks map 외에, 대시보드의 "진행중인 경기 목록" 섹션용으로 경기 자체의
  // 목록(팀별 베팅 인원수/총액)도 함께 모아서 반환한다.
  // 제목 끝의 "10/17 16:30 경기"에서 경기 시작 시각을 뽑는다. 연도는 제목에 없으므로
  // 지금 기준으로 추론한다(미래로 12시간 넘게 벗어나면 작년으로 보정 — 연말/연초 경계 대비).
  function extractMatchStartDate(title) {
    const m = title.match(/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})\s*경기/);
    if (!m) return null;
    const now = new Date();
    let dt = new Date(now.getFullYear(), parseInt(m[1], 10) - 1, parseInt(m[2], 10), parseInt(m[3], 10), parseInt(m[4], 10));
    if (dt.getTime() - now.getTime() > 12 * 3600 * 1000) {
      dt = new Date(now.getFullYear() - 1, parseInt(m[1], 10) - 1, parseInt(m[2], 10), parseInt(m[3], 10), parseInt(m[4], 10));
    }
    return dt;
  }

  // 혹시 낡은 목록을 받아왔더라도(예: 업데이트 전 코드가 돌고 있는 오래된 탭), 이미 시작
  // 시각이 지난 경기는 "진행중"이 아니므로 올리지 않는다. 시작 시각을 못 읽는 글(예: O/X
  // 투표처럼 경기 시각이 없는 것)은 그대로 둔다.
  function extractDeadlineDate(title) {
    const m = (title || '').match(/마감\s*(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
    if (!m) return extractMatchStartDate(title);
    const now = new Date();
    let dt = new Date(now.getFullYear(), parseInt(m[1], 10) - 1, parseInt(m[2], 10), parseInt(m[3], 10), parseInt(m[4], 10));
    if (dt.getTime() - now.getTime() > 180 * 24 * 3600 * 1000) {
      dt = new Date(now.getFullYear() - 1, parseInt(m[1], 10) - 1, parseInt(m[2], 10), parseInt(m[3], 10), parseInt(m[4], 10));
    }
    return dt;
  }

  function isStillUpcoming(title) {
    const start = extractMatchStartDate(title);
    if (!start) return true;
    return start.getTime() > Date.now();
  }

  // ---------- 3.6 고정 닉네임의 현재 잉여력(포인트) 조회 ----------
  // 베팅 목록에는 보유 잉여력이 없고(point=베팅액, exp=예상 배당금), 회원정보 페이지에만
  // "레벨: N / 잉여력: M" 형태로 들어있다. 그래서 고정 닉네임에 한해서만(요청 수를 줄이려고)
  // 회원정보 페이지를 열어 현재 잉여력을 읽어온다.
  const PINNED_NAMES_KEY = 'jsa-pinned-names';   // 대시보드가 명령에 실어 보낸 고정 닉네임 목록
  const MEMBER_SRL_KEY = 'jsa-member-srl-v1';    // 닉네임 -> member_srl 캐시 (조회 비용 절약)

  function loadPinnedNames() {
    try { const v = JSON.parse(localStorage.getItem(PINNED_NAMES_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function savePinnedNames(list) {
    try { safeSetItem(PINNED_NAMES_KEY, JSON.stringify(list)); } catch (e) { /* 무시 */ }
  }
  function loadSrlMap() {
    try { return JSON.parse(localStorage.getItem(MEMBER_SRL_KEY) || '{}'); } catch (e) { return {}; }
  }
  function saveSrlMap(m) {
    try { safeSetItem(MEMBER_SRL_KEY, JSON.stringify(m)); } catch (e) { /* 무시 */ }
  }

  // 검색 페이지에서 닉네임으로 member_srl 찾기 (최근 글이 없는 사람은 안 잡힐 수 있음)
  async function lookupMemberSrlByNick(nick) {
    try {
      const url = `https://www.fmkorea.com/search.php?mid=pointplay&category=&search_keyword=${encodeURIComponent(nick)}&search_target=nick_name`;
      const doc = new DOMParser().parseFromString(await (await fetch(url, { credentials: 'same-origin' })).text(), 'text/html');
      for (const a of doc.querySelectorAll('a.member_plate')) {
        if ((a.textContent || '').trim() !== nick) continue;
        const m = String(a.className || '').match(/member_(\d+)/);
        if (m) return parseInt(m[1], 10);
      }
    } catch (e) { /* 무시 */ }
    return null;
  }

  // 회원정보 페이지에서 현재 잉여력 읽기. 페이지 상단에는 "로그인한 본인"의 잉여력도 같이
  // 나오므로, 회원정보 표의 "레벨: N / 잉여력: M" 형태(슬래시 포함)만 골라야 한다.
  async function fetchMemberPoint(srl) {
    try {
      const url = `https://www.fmkorea.com/index.php?mid=pointplay&act=dispMemberInfo&member_srl=${srl}&_=${Date.now()}`;
      const doc = new DOMParser().parseFromString(await (await fetch(url, { credentials: 'same-origin' })).text(), 'text/html');
      for (const tr of doc.querySelectorAll('tr')) {
        const t = (tr.textContent || '').replace(/\s+/g, ' ').trim();
        const m = t.match(/레벨:\s*\d+\s*\/\s*잉여력:\s*([\d,]+)/);
        if (m) return parseInt(m[1].replace(/,/g, ''), 10);
      }
    } catch (e) { /* 무시 */ }
    return null;
  }

  // 고정 닉네임들의 현재 잉여력을 모아서 { 닉네임: 잉여력 } 로 반환.
  // srl은 ① 진행중 베팅 목록에서 얻은 것 ② 캐시 ③ 검색 순으로 찾는다.
  // 잉여력은 자주 안 바뀌므로 짧게 캐시해둔다. 새로고침을 연달아 눌러도 회원정보 페이지를
  // 매번 다시 긁지 않게 해서 체감 속도를 크게 줄인다.
  const PINNED_POINTS_KEY = 'jsa-pinned-points-v1';
  const PINNED_POINTS_TTL_MS = 5 * 60 * 1000;

  function loadCachedPinnedPoints() {
    try {
      const v = JSON.parse(localStorage.getItem(PINNED_POINTS_KEY) || 'null');
      if (v && v.at && Date.now() - v.at < PINNED_POINTS_TTL_MS && v.points) return v.points;
    } catch (e) { /* 무시 */ }
    return null;
  }
  function saveCachedPinnedPoints(points) {
    try { safeSetItem(PINNED_POINTS_KEY, JSON.stringify({ at: Date.now(), points })); } catch (e) { /* 무시 */ }
  }

  async function collectPinnedPoints(srlFromBets, log, force) {
    const names = loadPinnedNames();
    if (!names.length) return {};
    if (!force) {
      const cached = loadCachedPinnedPoints();
      if (cached) { if (log) log('고정 닉네임 잉여력: 최근 조회값 재사용.'); return cached; }
    }
    const srlMap = loadSrlMap();
    const out = {};
    // 한 명씩 순서대로 하면 느려서, 동시 요청 수를 제한한 채 묶어서 처리한다.
    for (let i = 0; i < names.length; i += CONCURRENCY) {
      const batch = names.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (nick) => {
        let srl = (srlFromBets && srlFromBets.get(nick)) || srlMap[nick] || null;
        if (!srl) srl = await lookupMemberSrlByNick(nick); // 한 번 찾으면 캐시되므로 매번 하지는 않음
        if (!srl) return;
        srlMap[nick] = srl;
        const point = await fetchMemberPoint(srl);
        if (point !== null) out[nick] = point;
      }));
      if (i + CONCURRENCY < names.length) await sleepJitter();
    }
    saveSrlMap(srlMap);
    saveCachedPinnedPoints(out);
    if (log) log(`고정 닉네임 잉여력 ${Object.keys(out).length}명 조회 완료.`);
    return out;
  }

  async function collectOngoingPicks(log) {
    const map = new Map(); // nick_name -> [{team, url, bet}]
    const srlByNick = new Map(); // nick_name -> member_srl (잉여력 조회에 재사용)
    const matches = []; // [{title, url, teamA, teamB, countA, betA, countB, betB}]
    try {
      const allPosts = await getOngoingMatchPosts();
      const posts = allPosts.filter((p) => isStillUpcoming(p.title));
      if (posts.length !== allPosts.length) {
        log(`이미 시작된 경기 ${allPosts.length - posts.length}건은 제외했습니다.`);
      }
      log(`진행중인 경기 ${posts.length}건의 베팅 현황을 확인하는 중...`);
      for (let i = 0; i < posts.length; i += CONCURRENCY) {
        const batch = posts.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (post) => {
          const url = `https://www.fmkorea.com/${post.document_srl}`;
          try {
            const detail = await fetchPostDetail(post.document_srl);
            if (!detail || !detail.pk) return;
            const { pk, labels } = detail;
            // 글에 적힌 실제 선택지 이름이 우선. 없으면 제목의 "A vs B"로 대체한다.
            const matchup = labels || extractMatchupTeams(post.title);
            if (!matchup) return;
            const { opt1, opt2 } = await fetchOngoingBettors(pk);
            let countA = 0, betA = 0, countB = 0, betB = 0;
            for (const e of opt1) {
              if (!e.nick_name) continue;
              if (!map.has(e.nick_name)) map.set(e.nick_name, []);
              map.get(e.nick_name).push({ team: matchup.a, url, bet: e.point || 0 });
              if (e.member_srl) srlByNick.set(e.nick_name, e.member_srl);
              countA++; betA += e.point || 0;
            }
            for (const e of opt2) {
              if (!e.nick_name) continue;
              if (!map.has(e.nick_name)) map.set(e.nick_name, []);
              map.get(e.nick_name).push({ team: matchup.b, url, bet: e.point || 0 });
              if (e.member_srl) srlByNick.set(e.nick_name, e.member_srl);
              countB++; betB += e.point || 0;
            }
            matches.push({ title: post.title, url, teamA: matchup.a, teamB: matchup.b, countA, betA, countB, betB });
          } catch (e) {
            log('  -> 진행중 경기 베팅 조회 오류: ' + e.message);
          }
        }));
        if (i + CONCURRENCY < posts.length) await sleepJitter();
      }
    } catch (e) {
      log('진행중인 경기 목록 조회 실패: ' + e.message);
    }
    matches.sort((a, b) => {
      const da = extractDeadlineDate(a.title || '');
      const db = extractDeadlineDate(b.title || '');
      if (da && db) return da.getTime() - db.getTime();
      if (da) return -1;
      if (db) return 1;
      return (a.title || '').localeCompare(b.title || '', 'ko');
    });
    return { map, matches, srlByNick };
  }

  // ---------- 4. 집계 ----------
  function aggregate(allPostResults) {
    // name -> { win, lose, totalBet, totalPayout, sports: { sport: [w,l] } }
    // (참고: 여기서 다루는 건 전부 "이미 정산 완료된" 과거 글들이다. 어느 팀에 베팅했는지는
    //  더 이상 여기서 다루지 않고, 아직 결과가 안 나온 "진행중인 경기" 베팅 현황은
    //  collectOngoingPicks()가 별도로 수집해서 렌더링 시점에만 붙여준다.)
    const records = new Map();
    function rec(name) {
      if (!records.has(name)) records.set(name, { win: 0, lose: 0, totalBet: 0, totalPayout: 0, sports: new Map() });
      return records.get(name);
    }
    function sportWL(r, sport) {
      if (!r.sports.has(sport)) r.sports.set(sport, [0, 0]);
      return r.sports.get(sport);
    }

    for (const entry of allPostResults) {
      const { winList, loseList } = entry;
      // 종목은 캐시에 저장된 값을 쓰지 않고 제목에서 매번 다시 판정한다.
      // 저장된 값을 쓰면 종목 분류 규칙을 바꿔도(예: 3x3 분리) 이미 캐시된 글들은
      // 옛 분류('기타')로 남아, 캐시를 통째로 지우기 전까지 반영되지 않는다.
      const sport = entry.title ? classifySport(entry.title) : (entry.sport || '기타');
      for (const it of winList) {
        const r = rec(it.name);
        r.win++;
        r.totalBet += it.bet;
        r.totalPayout += it.payout;
        sportWL(r, sport)[0]++;
      }
      for (const it of loseList) {
        const r = rec(it.name);
        r.lose++;
        r.totalBet += it.bet;
        // 패배 시 배당금 0 (베팅액만 잃음)
        sportWL(r, sport)[1]++;
      }
    }
    return records;
  }

  function overallRanking(records, minPicks) {
    const out = [];
    for (const [name, d] of records.entries()) {
      const total = d.win + d.lose;
      if (total >= minPicks) {
        out.push({
          name, win: d.win, lose: d.lose, total, rate: (d.win / total) * 100,
          totalBet: d.totalBet, totalPayout: d.totalPayout, profit: d.totalPayout - d.totalBet,
          sports: d.sports,
        });
      }
    }
    out.sort((a, b) => b.rate - a.rate || b.total - a.total);
    return out;
  }

  function sportRanking(records, minPicks) {
    const bySport = new Map();
    for (const [name, d] of records.entries()) {
      for (const [sport, [w, l]] of d.sports.entries()) {
        const total = w + l;
        if (total < minPicks) continue;
        if (!bySport.has(sport)) bySport.set(sport, []);
        bySport.get(sport).push({ name, win: w, lose: l, total, rate: (w / total) * 100 });
      }
    }
    for (const arr of bySport.values()) arr.sort((a, b) => b.rate - a.rate || b.total - a.total);
    // 종목 이름순으로 정렬 — '축구/...', '배구/...'처럼 같은 종목 분류가 붙어서 보이도록
    return new Map(Array.from(bySport.entries()).sort((a, b) => a[0].localeCompare(b[0], 'ko')));
  }

  // ---------- 5. UI ----------
  const PANEL_POS_KEY = 'jsa-panel-pos-v1';
  const PANEL_SIZE_KEY = 'jsa-panel-size-v1';
  const PANEL_MIN_WIDTH = 380;
  const PANEL_MAX_WIDTH = 1600;
  const PANEL_MIN_HEIGHT = 240;

  function injectStyles() {
    if (document.getElementById('jsa-styles')) return;
    const style = document.createElement('style');
    style.id = 'jsa-styles';
    style.textContent = `
      #jsa-panel {
        --jsa-bg: #16181d;
        --jsa-card: #1e2128;
        --jsa-card-2: #262a33;
        --jsa-border: #2f333c;
        --jsa-text: #eceef1;
        --jsa-text-dim: #9aa1ad;
        --jsa-text-faint: #6b7280;
        --jsa-accent: #4f8cff;
        --jsa-accent-dim: rgba(79,140,255,.14);
        --jsa-win: #34d399;
        --jsa-lose: #f87171;
        --jsa-radius: 12px;
        position:fixed; top:70px; right:20px; width:600px; max-height:82vh;
        display:flex; flex-direction:column;
        background:var(--jsa-bg); color:var(--jsa-text); border:1px solid var(--jsa-border);
        border-radius:var(--jsa-radius); z-index:999999; font-size:13px;
        box-shadow:0 12px 40px rgba(0,0,0,.45), 0 2px 8px rgba(0,0,0,.3);
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
        overflow:hidden;
      }
      #jsa-panel * { box-sizing:border-box; }
      .jsa-header {
        display:flex; align-items:center; gap:8px; padding:12px 14px;
        background:linear-gradient(180deg, var(--jsa-card-2), var(--jsa-card));
        border-bottom:1px solid var(--jsa-border); cursor:grab; user-select:none;
        flex-shrink:0;
      }
      .jsa-header:active { cursor:grabbing; }
      .jsa-grip { color:var(--jsa-text-faint); font-size:13px; letter-spacing:1px; }
      .jsa-title { font-weight:700; font-size:13.5px; flex:1; display:flex; align-items:baseline; gap:6px; }
      .jsa-version { color:var(--jsa-text-faint); font-weight:400; font-size:10.5px; }
      .jsa-headerbtn {
        background:transparent; border:none; color:var(--jsa-text-dim); cursor:pointer;
        width:24px; height:24px; border-radius:6px; font-size:14px; line-height:1;
        display:flex; align-items:center; justify-content:center; transition:background .15s, color .15s;
      }
      .jsa-headerbtn:hover { background:rgba(255,255,255,.08); color:var(--jsa-text); }
      .jsa-body { flex:1 1 auto; overflow-y:auto; padding:14px; min-height:0; }
      .jsa-body.jsa-collapsed { display:none; }
      .jsa-resize-handle {
        position:absolute; right:0; bottom:0; width:18px; height:18px; cursor:nwse-resize;
        display:flex; align-items:flex-end; justify-content:flex-end; padding:3px; z-index:2;
        color:var(--jsa-text-faint); touch-action:none;
      }
      .jsa-resize-handle:hover { color:var(--jsa-text-dim); }
      .jsa-resize-handle svg { display:block; pointer-events:none; }
      .jsa-controls { display:flex; align-items:center; gap:10px; margin-bottom:12px; flex-wrap:wrap; }
      .jsa-btn-primary {
        background:var(--jsa-accent); color:#fff; border:none; border-radius:999px;
        padding:8px 16px; font-size:12.5px; font-weight:600; cursor:pointer;
        transition:filter .15s, transform .1s;
      }
      .jsa-btn-primary:hover { filter:brightness(1.1); }
      .jsa-btn-primary:active { transform:scale(.97); }
      .jsa-field { display:flex; align-items:center; gap:6px; color:var(--jsa-text-dim); font-size:12px; }
      .jsa-field input {
        width:46px; background:var(--jsa-card-2); border:1px solid var(--jsa-border); color:var(--jsa-text);
        border-radius:6px; padding:5px 6px; font-size:12px; text-align:center;
      }
      .jsa-field select {
        background:var(--jsa-card-2); border:1px solid var(--jsa-border); color:var(--jsa-text);
        border-radius:6px; padding:5px 8px; font-size:12px; cursor:pointer;
      }
      .jsa-progress-wrap { margin-bottom:12px; }
      .jsa-progress-track { background:var(--jsa-card-2); border-radius:999px; overflow:hidden; height:8px; border:1px solid var(--jsa-border); }
      .jsa-progress-bar { background:linear-gradient(90deg, var(--jsa-accent), #7db2ff); height:100%; width:0%; transition:width .25s ease; }
      .jsa-progress-text { font-size:11px; color:var(--jsa-text-dim); margin-top:6px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .jsa-log-details { margin-bottom:12px; }
      .jsa-log-details summary {
        cursor:pointer; font-size:11px; color:var(--jsa-text-faint); list-style:none; user-select:none;
      }
      .jsa-log-details summary::-webkit-details-marker { display:none; }
      .jsa-log-details summary:before { content:'▸ '; }
      .jsa-log-details[open] summary:before { content:'▾ '; }
      #jsa-log {
        font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
        font-size:10.5px; color:var(--jsa-text-faint); white-space:pre-wrap;
        margin-top:6px; max-height:100px; overflow:auto; background:var(--jsa-card-2);
        border-radius:8px; padding:8px; border:1px solid var(--jsa-border);
      }
      .jsa-section-title { display:flex; align-items:center; gap:8px; font-weight:700; font-size:13px; margin-bottom:8px; }
      .jsa-count-badge {
        background:var(--jsa-accent-dim); color:var(--jsa-accent); font-weight:600; font-size:10.5px;
        border-radius:999px; padding:2px 8px;
      }
      .jsa-card { background:var(--jsa-card); border:1px solid var(--jsa-border); border-radius:10px; overflow:hidden; margin-bottom:10px; }
      table.jsa-table { width:100%; border-collapse:collapse; font-size:12px; }
      table.jsa-table thead th {
        text-align:left; font-size:10.5px; font-weight:600; color:var(--jsa-text-faint);
        text-transform:uppercase; letter-spacing:.03em; padding:8px 10px; border-bottom:1px solid var(--jsa-border);
      }
      table.jsa-table td { padding:7px 10px; border-bottom:1px solid var(--jsa-border); }
      table.jsa-table tbody tr:last-child td { border-bottom:none; }
      table.jsa-table tbody tr:nth-child(odd) { background:rgba(255,255,255,.015); }
      table.jsa-table tbody tr:hover { background:rgba(79,140,255,.07); }
      .jsa-rank { display:inline-flex; align-items:center; justify-content:center; width:18px; color:var(--jsa-text-faint); font-size:11px; font-weight:600; }
      .jsa-rank.r1 { color:#ffd166; } .jsa-rank.r2 { color:#cfd8e3; } .jsa-rank.r3 { color:#e0a675; }
      .jsa-name { font-weight:600; }
      .jsa-record-pill {
        display:inline-block; font-size:11px; font-weight:600; padding:2px 7px; border-radius:999px;
        background:rgba(255,255,255,.06); color:var(--jsa-text-dim); white-space:nowrap;
      }
      .jsa-rate { font-weight:700; }
      .jsa-rate.high { color:var(--jsa-win); }
      .jsa-rate.low { color:var(--jsa-text-dim); }
      .jsa-money { text-align:right; font-variant-numeric:tabular-nums; color:var(--jsa-text-dim); }
      .jsa-profit { text-align:right; font-variant-numeric:tabular-nums; font-weight:700; }
      .jsa-profit.pos { color:var(--jsa-win); }
      .jsa-profit.neg { color:var(--jsa-lose); }
      .jsa-picks { display:flex; flex-wrap:wrap; gap:3px; max-width:210px; }
      .jsa-pick-chip {
        display:inline-block; font-size:10px; font-weight:600; padding:1px 6px; border-radius:999px;
        white-space:nowrap; border:1px solid transparent; text-decoration:none; cursor:pointer;
        transition:filter .15s;
      }
      .jsa-pick-chip:hover { filter:brightness(1.15); text-decoration:none; }
      .jsa-pick-chip.pending { background:var(--jsa-accent-dim); color:var(--jsa-accent); border-color:rgba(79,140,255,.3); }
      .jsa-pick-more { font-size:10px; color:var(--jsa-text-faint); }
      .jsa-btn-ghost {
        display:block; width:100%; text-align:center; background:transparent; color:var(--jsa-accent);
        border:1px dashed var(--jsa-border); border-radius:8px; padding:8px; font-size:12px; font-weight:600;
        cursor:pointer; margin-top:2px; transition:background .15s, border-color .15s;
      }
      .jsa-btn-ghost:hover { background:var(--jsa-accent-dim); border-color:var(--jsa-accent); }
      details.jsa-sport-accordion { margin-top:4px; }
      details.jsa-sport-accordion > summary {
        cursor:pointer; list-style:none; display:flex; align-items:center; gap:6px;
        padding:9px 10px; border-radius:8px; background:var(--jsa-card); border:1px solid var(--jsa-border);
        font-weight:700; font-size:12.5px; user-select:none;
      }
      details.jsa-sport-accordion > summary::-webkit-details-marker { display:none; }
      details.jsa-sport-accordion > summary:before { content:'▸'; color:var(--jsa-text-faint); font-size:10px; }
      details.jsa-sport-accordion[open] > summary:before { content:'▾'; }
      .jsa-sport-card { margin-top:6px; }
      .jsa-sport-header { display:flex; align-items:center; gap:6px; padding:7px 10px 2px; font-size:11.5px; color:var(--jsa-text-dim); font-weight:700; }
      .jsa-download-row { margin-top:12px; }
      .jsa-btn-outline {
        display:flex; align-items:center; justify-content:center; gap:6px; width:100%;
        background:transparent; color:var(--jsa-text-dim); border:1px solid var(--jsa-border); border-radius:8px;
        padding:8px; font-size:12px; font-weight:600; cursor:pointer; transition:background .15s, color .15s;
      }
      .jsa-btn-outline:hover { background:rgba(255,255,255,.06); color:var(--jsa-text); }
      .jsa-empty { color:var(--jsa-text-faint); font-size:12px; padding:10px 2px; }
      #jsa-panel ::-webkit-scrollbar { width:8px; height:8px; }
      #jsa-panel ::-webkit-scrollbar-thumb { background:var(--jsa-border); border-radius:4px; }
      #jsa-panel ::-webkit-scrollbar-track { background:transparent; }
    `;
    document.head.appendChild(style);
  }

  function vw() { return document.documentElement.clientWidth || window.innerWidth; }
  function vh() { return document.documentElement.clientHeight || window.innerHeight; }
  const VIEW_MARGIN = 8;

  function makeDraggable(panel, handle) {
    let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;

    function onDown(e) {
      if (e.target.closest('.jsa-headerbtn')) return;
      const rect = panel.getBoundingClientRect();
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      startLeft = rect.left; startTop = rect.top;
      panel.style.right = 'auto';
      panel.style.left = startLeft + 'px';
      panel.style.top = startTop + 'px';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    }
    function onMove(e) {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      const w = panel.offsetWidth, h = panel.offsetHeight;
      // 패널 전체가 항상 뷰포트 안에 들어오도록 — 일부라도 화면 밖으로 안 나가게 제한
      const maxLeft = Math.max(0, vw() - w - VIEW_MARGIN);
      const maxTop = Math.max(0, vh() - h - VIEW_MARGIN);
      const newLeft = Math.max(0, Math.min(maxLeft, startLeft + dx));
      const newTop = Math.max(0, Math.min(maxTop, startTop + dy));
      panel.style.left = newLeft + 'px';
      panel.style.top = newTop + 'px';
    }
    function onUp() {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try {
        localStorage.setItem(PANEL_POS_KEY, JSON.stringify({ left: panel.style.left, top: panel.style.top }));
      } catch (e) { /* 저장 실패해도 무시 */ }
    }
    handle.addEventListener('mousedown', onDown);
  }

  function restorePanelPosition(panel) {
    try {
      const saved = JSON.parse(localStorage.getItem(PANEL_POS_KEY) || 'null');
      if (saved && saved.left && saved.top) {
        panel.style.left = saved.left;
        panel.style.top = saved.top;
        panel.style.right = 'auto';
      }
    } catch (e) { /* 무시 */ }
  }

  // 저장된 좌표/크기가 지금 창 크기와 안 맞으면(예: 더 넓은 창에서 끌어다놓은 뒤 좁은 창에서
  // 열었을 때) 패널이 화면 밖으로 밀려나 안 보일 수 있다. 패널 전체가 항상 뷰포트 안에
  // 완전히 들어오도록(일부라도 화면 밖으로 안 나가게) 위치를 보정한다.
  function clampPanelToViewport(panel) {
    try {
      const rect = panel.getBoundingClientRect();
      const w = rect.width, h = rect.height;
      // 패널이 뷰포트보다 큰 경우(작은 창 등)에는 0에 붙이는 수밖에 없음
      const maxLeft = Math.max(0, vw() - w - VIEW_MARGIN);
      const maxTop = Math.max(0, vh() - h - VIEW_MARGIN);
      let left = Math.min(Math.max(rect.left, 0), maxLeft);
      let top = Math.min(Math.max(rect.top, 0), maxTop);
      if (left !== rect.left || top !== rect.top) {
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
        panel.style.right = 'auto';
        try { localStorage.setItem(PANEL_POS_KEY, JSON.stringify({ left: panel.style.left, top: panel.style.top })); } catch (e2) { /* 무시 */ }
      }
    } catch (e) { /* 무시 */ }
  }

  // 패널 하단 모서리를 드래그해서 가로/세로 크기 조절. 크기를 바꾸는 순간부터는
  // CSS의 기본 width(600px)/max-height(82vh) 대신 사용자가 정한 크기를 그대로 따른다.
  function makeResizable(panel, handle) {
    let resizing = false, startX = 0, startY = 0, startW = 0, startH = 0;

    function onDown(e) {
      resizing = true;
      const rect = panel.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      startW = rect.width; startH = rect.height;
      panel.style.maxHeight = 'none'; // 수동 크기 조절 시작 시점부터 max-height 제약 해제
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
      e.stopPropagation();
    }
    function onMove(e) {
      if (!resizing) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      const rect = panel.getBoundingClientRect();
      // 패널 왼쪽/위쪽 고정 위치 기준으로, 오른쪽/아래쪽이 뷰포트를 넘지 않게 상한을 건다
      const availW = Math.max(PANEL_MIN_WIDTH, vw() - VIEW_MARGIN * 2);
      const availH = Math.max(PANEL_MIN_HEIGHT, vh() - VIEW_MARGIN * 2);
      const newW = Math.max(PANEL_MIN_WIDTH, Math.min(Math.min(PANEL_MAX_WIDTH, availW), startW + dx));
      const newH = Math.max(PANEL_MIN_HEIGHT, Math.min(availH, startH + dy));
      panel.style.width = newW + 'px';
      panel.style.height = newH + 'px';
      panel.style.maxWidth = 'none';
      const overR = rect.left + newW - (vw() - VIEW_MARGIN);
      if (overR > 0) { panel.style.right = 'auto'; panel.style.left = Math.max(VIEW_MARGIN, rect.left - overR) + 'px'; }
      const overB = rect.top + newH - (vh() - VIEW_MARGIN);
      if (overB > 0) { panel.style.top = Math.max(VIEW_MARGIN, rect.top - overB) + 'px'; }
    }
    function onUp() {
      if (!resizing) return;
      resizing = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try {
        localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify({ width: panel.style.width, height: panel.style.height }));
        if (panel.style.left) localStorage.setItem(PANEL_POS_KEY, JSON.stringify({ left: panel.style.left, top: panel.style.top }));
      } catch (e) { /* 저장 실패해도 무시 */ }
    }
    handle.addEventListener('mousedown', onDown);
  }

  function restorePanelSize(panel) {
    try {
      const saved = JSON.parse(localStorage.getItem(PANEL_SIZE_KEY) || 'null');
      if (saved && saved.width && saved.height) {
        panel.style.width = saved.width;
        panel.style.height = saved.height;
        panel.style.maxHeight = 'none';
      }
    } catch (e) { /* 무시 */ }
  }

  function createPanel() {
    injectStyles();
    const panel = document.createElement('div');
    panel.id = 'jsa-panel';
    panel.innerHTML = `
      <div class="jsa-header" id="jsa-drag-handle">
        <span class="jsa-grip">⠿</span>
        <span class="jsa-title">📊 정산 승률 분석기 <span class="jsa-version">v${SCRIPT_VERSION}</span></span>
        <button id="jsa-settings" class="jsa-headerbtn" title="GitHub 대시보드 연동 설정">⚙</button>
        <button id="jsa-minimize" class="jsa-headerbtn" title="최소화">—</button>
        <button id="jsa-close" class="jsa-headerbtn" title="닫기">×</button>
      </div>
      <div class="jsa-body" id="jsa-body">
        <div class="jsa-controls">
          <div class="jsa-field">기간
            <select id="jsa-window">
              ${WINDOW_OPTIONS.map((o) => `<option value="${o.value}"${o.value === '24h' ? ' selected' : ''}>${o.label}</option>`).join('')}
            </select>
          </div>
          <div class="jsa-field">최소 베팅건수
            <input id="jsa-minpicks" type="number" value="4" min="1">
          </div>
          <button id="jsa-run" class="jsa-btn-primary">분석 시작</button>
        </div>
        <div id="jsa-progress-wrap" class="jsa-progress-wrap" style="display:none;">
          <div class="jsa-progress-track"><div id="jsa-progress-bar" class="jsa-progress-bar"></div></div>
          <div id="jsa-progress-text" class="jsa-progress-text"></div>
        </div>
        <details class="jsa-log-details">
          <summary>상세 로그</summary>
          <div id="jsa-log"></div>
        </details>
        <div id="jsa-result"></div>
      </div>
      <div class="jsa-resize-handle" id="jsa-resize-handle" title="크기 조절">
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
          <path d="M10 0L0 10M10 4.5L4.5 10M10 8.5L8.5 10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        </svg>
      </div>
    `;
    document.body.appendChild(panel);
    restorePanelPosition(panel);
    restorePanelSize(panel);
    clampPanelToViewport(panel); // 화면 밖으로 밀려나 있으면 보정
    makeDraggable(panel, panel.querySelector('#jsa-drag-handle'));
    makeResizable(panel, panel.querySelector('#jsa-resize-handle'));
    window.addEventListener('resize', () => clampPanelToViewport(panel));

    panel.querySelector('#jsa-close').onclick = () => panel.remove();
    panel.querySelector('#jsa-settings').onclick = () => {
      const current = getGithubToken();
      const masked = current ? `설정됨 (끝자리 ...${current.slice(-4)})` : '설정 안 됨';
      const input = window.prompt(
        `분석이 끝날 때마다 결과를 GitHub 대시보드(${GITHUB_REPO})에 올리려면, repo 쓰기 권한이 있는 ` +
        `GitHub Personal Access Token을 입력하세요.\n현재 상태: ${masked}\n` +
        `(비워두고 확인을 누르면 저장된 토큰을 삭제합니다. 취소를 누르면 변경 없이 닫힙니다.)`,
        ''
      );
      if (input === null) return; // 취소
      setGithubToken(input.trim());
      alert(input.trim() ? 'GitHub 토큰이 저장되었습니다.' : 'GitHub 토큰이 삭제되었습니다.');
    };
    const body = panel.querySelector('#jsa-body');
    const minBtn = panel.querySelector('#jsa-minimize');
    minBtn.onclick = () => {
      const collapsed = body.classList.toggle('jsa-collapsed');
      minBtn.textContent = collapsed ? '▢' : '—';
      minBtn.title = collapsed ? '펼치기' : '최소화';
      // 크기 조절 기능 때문에 패널에 직접 높이(style.height)가 박혀있는 경우, 본문을 숨겨도
      // 패널 틀 자체는 그 높이를 그대로 유지해서 "최소화해도 빈 칸만 커다랗게 남는" 문제가
      // 있었다. 최소화할 때는 높이를 잠깐 비워 헤더 높이로 저절로 줄게 하고, 펼칠 때 복원한다.
      if (collapsed) {
        if (panel.style.height) panel.dataset.prevHeight = panel.style.height;
        panel.style.height = '';
        panel.style.maxHeight = 'none';
      } else if (panel.dataset.prevHeight) {
        panel.style.height = panel.dataset.prevHeight;
        delete panel.dataset.prevHeight;
      }
    };
    return panel;
  }

  function fmt(n) { return Math.round(n) + '%'; }
  function numFmt(n) { return Math.round(n).toLocaleString('ko-KR'); }

  const OVERALL_TOP_DEFAULT = 10;
  const SPORT_TOP = 10;
  // 종목별로 더 많이 보고 싶은 경우 여기에 인원을 지정한다 (요청: 3x3은 5~10명)
  const SPORT_TOP_OVERRIDES = {};
  function sportTopFor(sport) { return SPORT_TOP_OVERRIDES[sport] || SPORT_TOP; }
  const RANK_MEDAL = ['r1', 'r2', 'r3'];

  const PICKS_SHOWN = 6;

  function picksHtml(picks) {
    // picks: 아직 결과가 안 나온(진행중인) 경기에서 이 사람이 베팅한 팀 목록. 칩을 누르면
    // 해당 경기 글로 바로 이동(새 탭)할 수 있도록 링크를 건다.
    if (!picks || picks.length === 0) return '<span class="jsa-pick-more">—</span>';
    const shown = picks.slice(0, PICKS_SHOWN);
    let html = '<div class="jsa-picks">';
    html += shown.map((p) => {
      const label = escapeHtml(p.team) + (p.bet ? `(${numFmt(p.bet)})` : '');
      if (p.url) {
        return `<a class="jsa-pick-chip pending" href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer" title="해당 경기 글 열기">${label}</a>`;
      }
      return `<span class="jsa-pick-chip pending">${label}</span>`;
    }).join('');
    if (picks.length > PICKS_SHOWN) {
      html += `<span class="jsa-pick-more">+${picks.length - PICKS_SHOWN}</span>`;
    }
    html += '</div>';
    return html;
  }

  const SPORT_ICONS = [
    [/축구|K리그|EPL|라리가|분데스|세리에|리그1|MLS|UCL|UEL|UECL|AFC|J리그|ISL|EFL|에레디비시|프리메이라|A리그|국가대표/, '⚽'],
    [/배구|KOVO|FIVB|VNL/, '🏐'],
    [/야구|MLB|KBO|NPB/, '⚾'],
    [/농구|NBA|KBL|CBA|3x3/i, '🏀'],
    [/미식축구|NFL/, '🏈'],
    [/아이스하키|NHL|IIHF/, '🏒'],
    [/테니스|WTA|ATP/, '🎾'],
    [/탁구|ETTU/, '🏓'],
    [/배드민턴|BWF/, '🏸'],
    [/LOL|발로란트|VCT|스타크래프트/i, '🎮'],
  ];
  function sportIcon(sport) {
    for (const [re, ic] of SPORT_ICONS) { if (re.test(sport)) return ic; }
    return '🎯';
  }

  function rowHtml(r, withMoney, rankIdx, withPicks) {
    const rankCell = (typeof rankIdx === 'number')
      ? `<td><span class="jsa-rank ${RANK_MEDAL[rankIdx] || ''}">${rankIdx + 1}</span></td>`
      : '';
    const rateClass = r.rate >= 70 ? 'high' : 'low';
    let html = `<tr>${rankCell}<td class="jsa-name">${escapeHtml(r.name)}</td><td><span class="jsa-record-pill">${r.win}승${r.lose}패</span></td><td class="jsa-rate ${rateClass}">${fmt(r.rate)}</td>`;
    if (withMoney) {
      const profitClass = r.profit >= 0 ? 'pos' : 'neg';
      html += `<td class="jsa-money">${numFmt(r.totalBet)}</td><td class="jsa-profit ${profitClass}">${r.profit >= 0 ? '+' : ''}${numFmt(r.profit)}</td><td>${picksHtml(r.picks)}</td>`;
    } else if (withPicks) {
      // 종목별 랭킹: 돈 관련 칸은 빼고 "지금 이 종목에 뭘 걸었는지"만 보여준다
      html += `<td>${picksHtml(r.picks)}</td>`;
    }
    html += '</tr>';
    return html;
  }

  // 진행중인 경기 목록으로 "경기 주소 -> 종목" 표를 만든다. 베팅 항목에는 경기 제목이
  // 없고 주소만 있어서, 종목별로 추리려면 이 표가 필요하다.
  function sportByMatchUrl(matches) {
    const map = {};
    (matches || []).forEach((m) => { if (m && m.url) map[m.url] = classifySport(m.title || ''); });
    return map;
  }

  function renderResult(panel, records, minPicks, ongoingPicksMap, ongoingMatchesForPicks) {
    const resultDiv = panel.querySelector('#jsa-result');
    const overall = overallRanking(records, minPicks);
    const bySport = sportRanking(records, Math.max(2, Math.min(2, minPicks)));

    // 종합 랭킹에 "진행중인 경기 베팅" 컬럼을 붙인다 — 과거 정산 집계와는 별개로,
    // 현재 열려있는 경기들에 이 사람이 어느 팀에 걸었는지를 보여준다.
    if (ongoingPicksMap) {
      for (const r of overall) {
        r.picks = ongoingPicksMap.get(r.name) || [];
      }
    }

    let html = `<div class="jsa-section-title">🏆 종합 승률 랭킹 <span class="jsa-count-badge">최소 ${minPicks}건 · ${overall.length}명</span></div>`;

    if (overall.length === 0) {
      html += `<div class="jsa-empty">조건을 만족하는 참가자가 없습니다.</div>`;
    } else {
      html += '<div class="jsa-card"><table class="jsa-table"><thead><tr><th></th><th>닉네임</th><th>전적</th><th>승률</th><th style="text-align:right;">베팅액</th><th style="text-align:right;">수익</th><th>진행중인 베팅</th></tr></thead><tbody>';
      overall.slice(0, OVERALL_TOP_DEFAULT).forEach((r, idx) => { html += rowHtml(r, true, idx); });
      html += '</tbody></table></div>';
      if (overall.length > OVERALL_TOP_DEFAULT) {
        html += `<button id="jsa-more-overall" class="jsa-btn-ghost">상위 ${OVERALL_TOP_DEFAULT}명 외 ${overall.length - OVERALL_TOP_DEFAULT}명 더보기</button>`;
      }
    }

    html += `<details class="jsa-sport-accordion"><summary>⚽ 종목별 랭킹 <span class="jsa-count-badge">${bySport.size}개 종목</span></summary>`;
    html += '<div class="jsa-sport-card">';
    const sportByUrl = sportByMatchUrl(ongoingMatchesForPicks);
    for (const [sport, arr] of bySport.entries()) {
      html += `<div class="jsa-sport-header">${sportIcon(sport)} ${escapeHtml(sport)} <span class="jsa-count-badge">${arr.length}명</span></div>`;
      html += '<div class="jsa-card"><table class="jsa-table"><thead><tr><th></th><th>닉네임</th><th>전적</th><th>승률</th><th>진행중인 베팅</th></tr></thead><tbody>';
      arr.slice(0, sportTopFor(sport)).forEach((r, idx) => {
        // 그 사람의 진행중 베팅 중 이 종목 경기만 추려서 보여준다
        const all = (ongoingPicksMap && ongoingPicksMap.get(r.name)) || [];
        r.picks = all.filter((p) => sportByUrl[p.url] === sport);
        html += rowHtml(r, false, idx, true);
      });
      html += '</tbody></table></div>';
    }
    html += '</div></details>';

    html += `<div class="jsa-download-row"><button id="jsa-download" class="jsa-btn-outline">⬇ JSON 다운로드</button></div>`;
    resultDiv.innerHTML = html;

    const moreBtn = resultDiv.querySelector('#jsa-more-overall');
    if (moreBtn) {
      moreBtn.onclick = () => {
        const tbody = resultDiv.querySelector('table tbody');
        overall.slice(OVERALL_TOP_DEFAULT).forEach((r, i) => {
          tbody.insertAdjacentHTML('beforeend', rowHtml(r, true, OVERALL_TOP_DEFAULT + i));
        });
        moreBtn.remove();
      };
    }

    resultDiv.querySelector('#jsa-download').onclick = () => {
      const obj = {};
      for (const [name, d] of records.entries()) {
        obj[name] = {
          win: d.win, lose: d.lose,
          totalBet: d.totalBet, totalPayout: d.totalPayout, profit: d.totalPayout - d.totalBet,
          sports: Object.fromEntries(d.sports),
          ongoingPicks: (ongoingPicksMap && ongoingPicksMap.get(name)) || [],
        };
      }
      const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `jungsan_result_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
    };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- 5.5 GitHub 대시보드 동기화 ----------
  function getGithubToken() {
    try { return localStorage.getItem(GH_TOKEN_KEY) || ''; } catch (e) { return ''; }
  }
  function setGithubToken(token) {
    try {
      if (token) localStorage.setItem(GH_TOKEN_KEY, token);
      else localStorage.removeItem(GH_TOKEN_KEY);
    } catch (e) { /* 무시 */ }
  }

  // UTF-8 안전 base64 인코딩 (한글 포함 JSON을 올리기 위함)
  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  // UTF-8 안전 base64 디코딩 (GitHub Contents API가 content를 base64로 주므로 역변환 필요)
  function base64ToUtf8(b64) {
    const binary = atob(b64.replace(/\n/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  // 업로드할 JSON payload 구성 — 종합 랭킹 상위 N명 + 종목별 랭킹 + 진행중인 베팅 picks + 진행중인 경기 목록
  function buildDashboardPayload(records, minPicks, ongoingPicksMap, windowLabel, ongoingMatches, pinnedPoints) {
    const overall = overallRanking(records, minPicks);
    const bySport = sportRanking(records, Math.max(2, Math.min(2, minPicks)));
    const overallSlim = overall.slice(0, UPLOAD_TOP_N).map((r) => ({
      name: r.name, win: r.win, lose: r.lose, total: r.total, rate: Math.round(r.rate * 10) / 10,
      totalBet: r.totalBet, totalPayout: r.totalPayout, profit: r.profit,
      picks: (ongoingPicksMap && ongoingPicksMap.get(r.name)) || [],
    }));
    const sportsSlim = {};
    const sportUrlMap = sportByMatchUrl(ongoingMatches);
    for (const [sport, arr] of bySport.entries()) {
      sportsSlim[sport] = arr.slice(0, sportTopFor(sport)).map((r) => ({
        name: r.name, win: r.win, lose: r.lose, total: r.total, rate: Math.round(r.rate * 10) / 10,
        // 이 종목에 지금 걸어둔 베팅만 추려서 함께 올림
        picks: ((ongoingPicksMap && ongoingPicksMap.get(r.name)) || []).filter((p) => sportUrlMap[p.url] === sport),
      }));
    }
    const matchesSlim = (ongoingMatches || []).map((m) => ({
      title: m.title, url: m.url, teamA: m.teamA, teamB: m.teamB,
      countA: m.countA, betA: m.betA, countB: m.countB, betB: m.betB,
    }));
    // 대시보드의 "닉네임 찾기"용: 진행중인 경기에 베팅한 전체 참여자의
    // 베팅 내역(누가 어느 팀에 얼마)을 통째로 올린다. 상위 랭킹에 없는
    // 사람도 검색되도록 하기 위한 것. 과거 정산 전적(랭킹 기준 미달 포함)도
    // 닉네임 검색에서 보여줄 수 있게 간단한 전적 요약도 함께 담는다.
    const allPicks = [];
    if (ongoingPicksMap) {
      for (const [name, picks] of ongoingPicksMap.entries()) {
        allPicks.push({ name, picks });
      }
      allPicks.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    }
    const allRecords = [];
    for (const [name, r] of records.entries()) {
      const total = r.win + r.lose;
      if (total === 0) continue;
      allRecords.push({
        name, win: r.win, lose: r.lose,
        rate: Math.round((r.win / total) * 1000) / 10,
        totalBet: r.totalBet, profit: (r.totalPayout || 0) - (r.totalBet || 0),
      });
    }
    allRecords.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    return {
      generatedAt: new Date().toISOString(),
      scriptVersion: SCRIPT_VERSION,   // 이 결과를 만든 유저스크립트 버전
      windowLabel: windowLabel || null,
      minPicks,
      totalParticipants: overall.length,
      overall: overallSlim,
      sports: sportsSlim,
      ongoingMatches: matchesSlim,
      allPicks,
      allRecords,
      pinnedPoints: pinnedPoints || {},   // { 닉네임: 현재 잉여력 }
      pinnedPointsAt: pinnedPoints && Object.keys(pinnedPoints).length ? new Date().toISOString() : null,
    };
  }

  async function uploadResultsToGitHub(records, minPicks, ongoingPicksMap, windowLabel, ongoingMatches, log, pinnedPoints) {
    const token = getGithubToken();
    if (!token) return; // 토큰 설정 안 돼 있으면 조용히 건너뜀 (패널 설정에서 등록 가능)
    try {
      const payload = buildDashboardPayload(records, minPicks, ongoingPicksMap, windowLabel, ongoingMatches, pinnedPoints);
      const content = utf8ToBase64(JSON.stringify(payload, null, 2));
      const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_DATA_PATH}`;
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      };
      // 기존 파일의 sha를 먼저 조회(있으면 업데이트, 없으면 새로 생성)
      let sha;
      const getRes = await fetch(apiUrl, { headers });
      if (getRes.ok) {
        const info = await getRes.json();
        sha = info.sha;
      }
      const body = { message: `대시보드 데이터 갱신 (${payload.generatedAt})`, content };
      if (sha) body.sha = sha;
      const putRes = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(body) });
      if (!putRes.ok) {
        const errText = await putRes.text().catch(() => '');
        if (log) log(`GitHub 대시보드 업로드 실패 (${putRes.status}): ${errText.slice(0, 150)}`);
      } else if (log) {
        log('GitHub 대시보드에 결과 업로드 완료.');
      }
    } catch (e) {
      if (log) log('GitHub 대시보드 업로드 중 오류: ' + e.message);
    }
  }

  // 작은 JSON 파일(지금은 status.json)을 저장소에 올리는 공용 헬퍼.
  // uploadResultsToGitHub와 로직은 같지만 데이터가 훨씬 작고 자주(분석 시작/종료마다) 올라가므로
  // 분리해둠. 실패해도 조용히 무시(상태 표시는 부가 기능이라 분석 자체를 막으면 안 됨).
  async function uploadJsonToGitHub(path, payload) {
    const token = getGithubToken();
    if (!token) return;
    try {
      const content = utf8ToBase64(JSON.stringify(payload, null, 2));
      const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`;
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      };
      let sha;
      const getRes = await fetch(`${apiUrl}?t=${Date.now()}`, { headers });
      if (getRes.ok) {
        const info = await getRes.json();
        sha = info.sha;
      }
      const body = { message: `상태 갱신 (${path})`, content };
      if (sha) body.sha = sha;
      await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(body) });
    } catch (e) { /* 상태 표시는 부가 기능 — 실패해도 분석 자체는 계속 진행 */ }
  }

  // startedAt을 생략하면(새로 시작하는 분석) 지금 시각을 쓰고, 넘겨주면(새로고침 후 이어서
  // 하는 경우) 그 시각을 그대로 유지한다. 예전엔 여기서 매번 new Date()를 새로 찍어버려서,
  // "진행중인 경기" 페이지가 1분마다 자동 새로고침될 때마다 시작 시각이 "방금"으로 계속
  // 리셋돼 실제로는 안 끊기고 진행 중인데도 "계속 새로 분석되는 것처럼" 보이는 문제가 있었음.
  // progress({processed, total})를 넘기면 status.json에 진행률(processed/total/pct)도 같이
  // 올라가서, 대시보드가 "몇 % 진행됐는지" 보여줄 수 있다.
  function uploadRunningStatus(windowValue, windowLabel, minPicks, startedAt, progress, phase) {
    const payload = {
      state: 'running',
      windowValue, windowLabel, minPicks,
      startedAt: startedAt || new Date().toISOString(),
    };
    if (phase) payload.phase = phase;   // 지금 어느 단계인지 (대시보드에 그대로 표시됨)
    payload.scriptVersion = SCRIPT_VERSION;
    if (progress && typeof progress.total === 'number' && progress.total > 0) {
      payload.processed = progress.processed;
      payload.total = progress.total;
      payload.pct = Math.round((progress.processed / progress.total) * 100);
    }
    uploadJsonToGitHub(GITHUB_STATUS_PATH, payload);
  }
  function uploadIdleStatus(dataUpdatedAt) {
    uploadJsonToGitHub(GITHUB_STATUS_PATH, {
      state: 'idle',
      dataUpdatedAt: dataUpdatedAt || null, // 대시보드가 이 값이 바뀌면 바로 결과를 다시 받아간다
      updatedAt: new Date().toISOString(),
    });
  }

  // ---------- 5.6 대시보드 원격 분석 요청 (command.json 폴링) ----------
  // 대시보드(GitHub Pages)에서 기간/최소 베팅건수를 고르고 "분석 시작"을
  // 누르면 저장소의 command.json에 요청이 기록된다. fmkorea 탭에 떠 있는
  // 이 스크립트가 그 파일을 주기적으로 확인해서, 새 요청이 있으면 패널의
  // 기간/건수를 그 값으로 맞추고 분석을 대신 시작한다. (fmkorea 탭이
  // 하나 이상 열려 있어야 작동하는 구조 — 대시보드 자체는 fmkorea에
  // 접속할 수 없기 때문)
  const GITHUB_COMMAND_PATH = 'command.json';
  const CMD_HANDLED_KEY = 'jsa-last-cmd-ts';
  // 대시보드 버튼을 누른 뒤 이 주기만큼 기다려야 명령을 발견하므로, 체감 속도를 좌우한다.
  // GitHub API는 인증 시 시간당 5000회라 10초 주기(시간당 360회)도 여유가 충분하다.
  const COMMAND_POLL_MS = 10 * 1000;
  const CMD_MAX_AGE_MS = 10 * 60 * 1000; // 10분 넘게 지난 요청은 무시(오래된 잔재)

  // localStorage에 분석 결과 캐시(RESULT_CACHE_KEY)와 작업 상태(JOB_KEY)가 계속 쌓이면
  // 브라우저 저장 용량 한도에 걸릴 수 있다. 그 상태에서 CMD_HANDLED_KEY 기록이 조용히
  // 실패하면, "이미 처리한 요청"을 매번 새 요청으로 착각해서 같은 분석을 45초마다
  // 무한 반복 실행하는 버그가 생긴다. localStorage 저장이 실패하더라도 최소한 지금
  // 열려있는 탭(페이지 메모리) 안에서는 반복 실행을 막도록, 메모리 변수를 1차 기준으로 둔다.
  let cmdHandledMemory = 0;
  try { cmdHandledMemory = Number(localStorage.getItem(CMD_HANDLED_KEY)) || 0; } catch (e) { /* 무시 */ }

  async function pollDashboardCommand() {
    const token = getGithubToken();
    if (!token) return;
    const panel = document.getElementById('jsa-panel');
    if (!panel) return; // 패널이 뜨는 페이지(마감 탭/진행중인 경기)에서만
    try {
      const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_COMMAND_PATH}?t=${Date.now()}`;
      const res = await fetch(apiUrl, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw+json' },
      });
      if (!res.ok) return; // 파일 없음(404) 등 — 요청 없는 상태
      const cmd = await res.json();
      // 대시보드가 보내준 고정 닉네임 목록을 저장해둔다 (잉여력 조회 대상)
      if (cmd && Array.isArray(cmd.pinned)) savePinnedNames(cmd.pinned);

      // action: 'run'= 전체 승률 분석, 'refreshOngoing'= 진행중인 경기 목록만 다시 긁기
      if (!cmd || !cmd.requestedAt) return;
      if (cmd.action !== 'run' && cmd.action !== 'refreshOngoing') return;
      const reqTs = new Date(cmd.requestedAt).getTime();
      if (!reqTs) return;
      let handled = cmdHandledMemory;
      try { handled = Math.max(handled, Number(localStorage.getItem(CMD_HANDLED_KEY)) || 0); } catch (e) { /* 무시 */ }
      if (reqTs <= handled) return; // 이미 처리한 요청
      if (Date.now() - reqTs > CMD_MAX_AGE_MS) {
        // 너무 오래된 요청은 기록만 하고 무시 (다시 재시도하지 않도록 handled 처리)
        cmdHandledMemory = reqTs;
        safeSetItem(CMD_HANDLED_KEY, String(reqTs));
        return;
      }

      // 이미 분석이 돌고 있으면 새로 시작하지 않음(중복 실행 방지).
      // 이 경우 handled 기록을 남기지 않고 그냥 리턴 — 다음 폴링(45초 후)에 현재 작업이
      // 끝나있으면 이 요청을 다시 발견해서 실행한다. (예전엔 여기서 handled를 먼저
      // 기록해버려서, 이전 작업이 돌고 있을 때 들어온 요청이 영원히 무시되는 버그가 있었음)
      const job = loadJob();
      if (job && job.status === 'running') return;

      // localStorage 저장이 실패해도(용량 초과 등) 메모리에는 반드시 기록 — 이게 핵심 수정:
      // 예전엔 저장 실패 시 handled가 끝내 안 올라가서 같은 요청이 영원히 반복 실행됐음.
      // 저장이 실패하면 safeSetItem이 캐시를 정리하고 한 번 더 시도한다(용량 문제의 근본 원인 해소).
      cmdHandledMemory = reqTs;
      const saved = safeSetItem(CMD_HANDLED_KEY, String(reqTs));
      if (!saved) {
        try { getPanelControls(panel).log('⚠ 저장공간 부족으로 요청 처리 기록 저장 실패 (이번 탭에서는 정상 동작하지만, 페이지가 새로고침되면 같은 요청이 중복 실행될 수 있음)'); } catch (e2) { /* 무시 */ }
      }

      // 진행중인 경기 목록만 다시 긁어오는 가벼운 요청 — 전체 분석은 돌리지 않는다.
      if (cmd.action === 'refreshOngoing') {
        try { getPanelControls(panel).log('대시보드 요청: 진행중인 경기 목록을 다시 가져옵니다...'); } catch (e2) { /* 무시 */ }
        refreshOngoingMatchesOnly();
        return;
      }

      const windowSel = panel.querySelector('#jsa-window');
      const minInput = panel.querySelector('#jsa-minpicks');
      if (cmd.windowValue && windowSel && windowSel.querySelector(`option[value="${cmd.windowValue}"]`)) {
        windowSel.value = cmd.windowValue;
      }
      const mp = parseInt(cmd.minPicks, 10);
      if (mp >= 1 && minInput) minInput.value = String(mp);

      const runBtn = panel.querySelector('#jsa-run');
      if (runBtn) runBtn.click();
    } catch (e) { /* 네트워크 오류 등 — 다음 폴링에서 재시도 */ }
  }
  setInterval(pollDashboardCommand, COMMAND_POLL_MS);
  setTimeout(pollDashboardCommand, 6000);

  // ---------- 5.7 진행중인 경기만 자주 갱신 ----------
  // 전체 승률 분석(과거 정산 글 전부 훑기)은 시간이 걸려서 자주 돌리기 부담스럽지만,
  // "진행중인 경기" 목록 자체는 금방 바뀐다(경기가 시작/마감되면서). 그래서 전체 분석과
  // 별개로, 5분마다 진행중인 경기만 가볍게 다시 긁어서 data.json의 ongoingMatches/allPicks/
  // overall[].picks 부분만 patch한다 (과거 정산 전적 같은 나머지 데이터는 건드리지 않음).
  // 전체 분석이 지금 돌고 있는 중이면 건너뛴다 — 그 분석이 끝나면 어차피 전체가 새로 올라가고,
  // 동시에 두 쪽에서 data.json에 써서 서로 덮어쓰는 충돌을 피하기 위함.
  const ONGOING_REFRESH_MS = 5 * 60 * 1000;

  async function refreshOngoingMatchesOnly() {
    const token = getGithubToken();
    if (!token) return;
    const panel = document.getElementById('jsa-panel');
    if (!panel) return;
    if (!window.jQuery || !window.jQuery.exec_json) return;
    const job = loadJob();
    if (job && job.status === 'running') return; // 전체 분석과 충돌 방지

    try {
      const { map, matches, srlByNick } = await collectOngoingPicks(() => {}); // 조용히 수집(패널 로그 오염 방지)
      const pinnedPoints = await collectPinnedPoints(srlByNick, null);
      const matchesSlim = matches.map((m) => ({
        title: m.title, url: m.url, teamA: m.teamA, teamB: m.teamB,
        countA: m.countA, betA: m.betA, countB: m.countB, betB: m.betB,
      }));
      const allPicks = [];
      for (const [name, picks] of map.entries()) allPicks.push({ name, picks });
      allPicks.sort((a, b) => a.name.localeCompare(b.name, 'ko'));

      const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_DATA_PATH}`;
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      };
      const getRes = await fetch(`${apiUrl}?t=${Date.now()}`, { headers });
      if (!getRes.ok) return; // data.json이 아직 없으면 건너뜀 (최초 전체 분석이 먼저 필요)
      const info = await getRes.json();
      const sha = info.sha;
      let data;
      try { data = JSON.parse(base64ToUtf8(info.content)); } catch (e) { return; }

      data.ongoingMatches = matchesSlim;
      data.allPicks = allPicks;
      data.ongoingUpdatedAt = new Date().toISOString();
      data.ongoingScriptVersion = SCRIPT_VERSION;
      if (Object.keys(pinnedPoints).length) {
        data.pinnedPoints = pinnedPoints;
        data.pinnedPointsAt = data.ongoingUpdatedAt;
      }
      if (Array.isArray(data.overall)) {
        data.overall.forEach((r) => { r.picks = map.get(r.name) || []; });
      }

      const body = {
        message: `진행중인 경기 갱신 (${data.ongoingUpdatedAt})`,
        content: utf8ToBase64(JSON.stringify(data, null, 2)),
        sha,
      };
      await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(body) });
      uploadIdleStatus(data.ongoingUpdatedAt); // 대시보드가 기다리지 않고 바로 받아가도록
    } catch (e) { /* 다음 주기에 재시도 */ }
  }
  setInterval(refreshOngoingMatchesOnly, ONGOING_REFRESH_MS);
  setTimeout(refreshOngoingMatchesOnly, 90 * 1000); // 패널 뜨고 좀 지나서 첫 실행(초기 분석과 겹치지 않게)

  // ---------- 5.8 구버전 탭 자동 정리 ----------
  // Tampermonkey는 스크립트를 업데이트해도 "이미 열려 있는 탭"은 예전 코드로 계속 돌린다.
  // 그래서 오래 띄워둔 탭이 옛날 로직으로 명령을 처리해버리는 사고가 반복됐다
  // (낡은 경기 목록 업로드, 선택지 이름 오표기 등). 저장소의 최신 버전을 주기적으로
  // 확인해서, 지금 돌고 있는 코드가 구버전이면 페이지를 새로고침해 최신 코드로 갈아탄다.
  const VERSION_CHECK_MS = 10 * 60 * 1000;
  const VERSION_RELOAD_KEY = 'jsa-version-reload-at';
  const VERSION_RELOAD_COOLDOWN_MS = 10 * 60 * 1000;

  function isNewerVersion(remote, local) {
    const ra = String(remote).split('.').map(Number);
    const la = String(local).split('.').map(Number);
    for (let i = 0; i < Math.max(ra.length, la.length); i++) {
      const r = ra[i] || 0, l = la[i] || 0;
      if (r > l) return true;
      if (r < l) return false;
    }
    return false;
  }

  async function checkForNewVersion() {
    try {
      const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/fmkorea_jungsan_analyzer.user.js?_=${Date.now()}`;
      const text = await (await fetch(url, { cache: 'no-store' })).text();
      const m = text.match(/@version\s+([0-9.]+)/);
      if (!m || !isNewerVersion(m[1], SCRIPT_VERSION)) return;

      const job = loadJob();
      if (job && job.status === 'running') return; // 분석 중에는 건드리지 않음 (끝나고 다음 확인 때 처리)

      // Tampermonkey가 아직 새 버전을 설치하지 않았다면 새로고침해도 그대로라
      // 무한 새로고침이 될 수 있다. 쿨다운을 둬서 최대 10분에 한 번만 시도한다.
      let lastAt = 0;
      try { lastAt = Number(sessionStorage.getItem(VERSION_RELOAD_KEY)) || 0; } catch (e) { /* 무시 */ }
      if (Date.now() - lastAt < VERSION_RELOAD_COOLDOWN_MS) return;
      try { sessionStorage.setItem(VERSION_RELOAD_KEY, String(Date.now())); } catch (e) { /* 무시 */ }

      const panel = document.getElementById('jsa-panel');
      if (panel) {
        try { getPanelControls(panel).log(`새 버전(v${m[1]}) 발견 — 최신 코드로 전환하기 위해 페이지를 새로고침합니다.`); } catch (e) { /* 무시 */ }
      }
      setTimeout(() => location.reload(), 1500);
    } catch (e) { /* 네트워크 오류 등은 무시 */ }
  }
  setInterval(checkForNewVersion, VERSION_CHECK_MS);
  setTimeout(checkForNewVersion, 20 * 1000);

  // ---------- 6. 새로고침에도 끊기지 않는 작업(Job) 상태 저장 ----------
  // 이 페이지(dispBoardOngoingMatches)는 다른 스크립트가 1분마다 새로고침을 거는 경우가 있어서,
  // 분석 진행 상태를 localStorage에 계속 저장해두고, 새로고침 후에도 자동으로 이어서 진행한다.
  const JOB_KEY = 'jsa-job-v1';

  // 저장 실패(용량 초과)가 계속되면 작업이 "진행중"인 채로 영원히 굳어버려서, 새로고침할
  // 때마다 같은 분석을 다시 돌리고 새 원격 요청도 "이미 돌고 있음"으로 계속 막히는 문제가
  // 있었다. 저장 성공 여부를 추적하고, 실패하면 공간을 비운 뒤 재시도한다.
  let jobSaveFailed = false;

  // 분석 결과(allPostResults)는 글별 결과 캐시에 이미 똑같이 들어있으므로, 작업 기록에는
  // 처리된 글 번호(processedSrls)만 저장하고 불러올 때 캐시에서 되살린다. 예전엔 같은
  // 데이터를 두 군데에 중복 저장해서 용량을 두 배로 먹었다.
  function serializeJob(job) {
    const slim = Object.assign({}, job);
    slim.processedSrls = (job.allPostResults || []).map((r) => r.srl).filter(Boolean);
    delete slim.allPostResults;
    slim.lastSavedAt = Date.now();
    return slim;
  }
  function hydrateJob(job) {
    if (!job) return job;
    if (Array.isArray(job.allPostResults)) return job; // 예전 형식(결과를 통째로 저장)도 그대로 지원
    const cache = loadResultCache();
    job.allPostResults = (job.processedSrls || []).map((srl) => cache[srl]).filter(Boolean);
    return job;
  }

  function saveJob(job) {
    const payload = JSON.stringify(serializeJob(job));
    try {
      localStorage.setItem(JOB_KEY, payload);
      jobSaveFailed = false;
      return true;
    } catch (e) { /* 아래에서 공간 확보 후 재시도 */ }
    freeUpStorageSpace();
    try {
      localStorage.setItem(JOB_KEY, payload);
      jobSaveFailed = false;
      return true;
    } catch (e) {
      jobSaveFailed = true; // 메모리상으로는 계속 진행되지만, 새로고침되면 이어가지 못함
      return false;
    }
  }
  function loadJob() {
    try {
      return hydrateJob(JSON.parse(localStorage.getItem(JOB_KEY) || 'null'));
    } catch (e) { return null; }
  }
  function clearJob() {
    try { localStorage.removeItem(JOB_KEY); } catch (e) { /* 무시 */ }
  }

  // ---------- 6.5 정산 완료된 글 결과 캐시 (속도 개선) ----------
  // 이미 마감/정산된 글의 승패 결과는 절대 바뀌지 않으므로, document_srl 기준으로 한 번
  // 가져온 결과를 영구 캐시해둔다. 기간을 바꿔가며 여러 번 분석을 돌려도(예: 24시간 → 5일 →
  // 30일) 이미 받아본 글은 네트워크 요청 없이 즉시 재사용된다.
  const RESULT_CACHE_KEY = 'jsa-result-cache-v1';
  // 글 하나당 참여자 명단이 통째로 들어가서 항목당 수 KB씩 나간다. 4000건이면 localStorage
  // 용량(보통 5MB)을 혼자 다 먹어버려서, 다른 저장이 전부 실패하는 사고가 있었음 — 1200건으로 낮춤.
  const RESULT_CACHE_MAX = 1200;
  // 캐시 유효기간: 이보다 오래된 항목은 자동으로 버린다. 분석 기간은 길어야 30일이라
  // 그보다 오래된 글의 결과를 들고 있을 이유가 없다.
  const RESULT_CACHE_TTL_MS = 30 * 24 * 3600 * 1000;
  // 캐시가 차지할 수 있는 최대 용량(약 1.5MB). localStorage 전체 한도(보통 5MB)를 캐시
  // 혼자 다 먹어서 다른 저장(작업 기록, 처리 표시)이 전부 실패하는 걸 막기 위한 상한.
  const RESULT_CACHE_MAX_BYTES = 1_500_000;

  function loadResultCache() {
    try { return JSON.parse(localStorage.getItem(RESULT_CACHE_KEY) || '{}'); } catch (e) { return {}; }
  }

  // 오래된 것 → 개수 초과 → 용량 초과 순으로 정리. 항목에 기록 시각(at)이 없으면
  // (예전 형식) 가장 오래된 것으로 취급해서 먼저 버린다.
  function pruneResultCache(cache) {
    const now = Date.now();
    let keys = Object.keys(cache);

    // 1) 유효기간 지난 항목 버리기
    for (const k of keys) {
      const at = cache[k] && cache[k].at;
      if (at && now - at > RESULT_CACHE_TTL_MS) delete cache[k];
    }

    // 오래된 순 정렬 (at 없는 항목이 가장 앞)
    const byAge = () => Object.keys(cache).sort((a, b) => ((cache[a] && cache[a].at) || 0) - ((cache[b] && cache[b].at) || 0));

    // 2) 개수 상한
    keys = byAge();
    for (let i = 0; i < keys.length - RESULT_CACHE_MAX; i++) delete cache[keys[i]];

    // 3) 용량 상한 — 넘으면 오래된 것부터 10%씩 덜어내며 맞춘다
    let guard = 0;
    while (JSON.stringify(cache).length > RESULT_CACHE_MAX_BYTES && guard++ < 50) {
      const ordered = byAge();
      if (ordered.length === 0) break;
      const drop = Math.max(1, Math.floor(ordered.length * 0.1));
      for (let i = 0; i < drop; i++) delete cache[ordered[i]];
    }
    return cache;
  }

  function saveResultCache(cache) {
    try {
      pruneResultCache(cache);
      localStorage.setItem(RESULT_CACHE_KEY, JSON.stringify(cache));
    } catch (e) { /* 용량 초과 등은 무시 — 캐시 없이도 정상 동작함 */ }
  }

  // 페이지가 뜰 때 한 번 돌리는 정기 청소. 캐시의 유효기간/용량을 정리해서, 사용자가
  // 아무것도 안 해도 저장공간이 서서히 꽉 차다가 어느 날 전부 멈추는 일이 없게 한다.
  function housekeepStorage() {
    try {
      const cache = loadResultCache();
      const before = Object.keys(cache).length;
      pruneResultCache(cache);
      const after = Object.keys(cache).length;
      if (after !== before) localStorage.setItem(RESULT_CACHE_KEY, JSON.stringify(cache));
    } catch (e) { /* 무시 */ }
  }

  // localStorage 용량이 꽉 차서 중요한 작은 값(예: "이 요청은 이미 처리했다" 표시)조차
  // 저장이 안 되는 상황을 벗어나기 위한 비상 정리. 결과 캐시를 과감히 줄이고, 이미
  // 완료되어 더는 이어서 할 필요 없는 작업 기록을 지워서 공간을 확보한다.
  function freeUpStorageSpace() {
    try {
      const job = loadJob();
      if (job && job.status === 'done') clearJob(); // 완료된 작업은 이미 업로드/렌더링됐으므로 안전하게 삭제 가능
    } catch (e) { /* 무시 */ }
    try {
      const cache = loadResultCache();
      const keys = Object.keys(cache);
      const keep = Math.min(keys.length, 500); // 평소(4000건)보다 훨씬 작게 줄여서 확실히 여유를 만듦
      const excess = keys.length - keep;
      for (let i = 0; i < excess; i++) delete cache[keys[i]];
      localStorage.setItem(RESULT_CACHE_KEY, JSON.stringify(cache));
    } catch (e) { /* 이것도 실패하면 더 손쓸 방법이 없음 */ }
  }

  // 작은 값 하나를 저장할 때, 용량 초과로 실패하면 한 번 정리하고 재시도한다.
  // CMD_HANDLED_KEY처럼 "꼭 저장돼야 동작이 정상인" 값에 사용 — 반환값으로 성공 여부를 알려준다.
  function safeSetItem(key, value) {
    try { localStorage.setItem(key, value); return true; } catch (e) { /* 아래에서 정리 후 재시도 */ }
    freeUpStorageSpace();
    try { localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }

  function getPanelControls(panel) {
    const logDiv = panel.querySelector('#jsa-log');
    const progressWrap = panel.querySelector('#jsa-progress-wrap');
    const progressBar = panel.querySelector('#jsa-progress-bar');
    const progressText = panel.querySelector('#jsa-progress-text');
    const log = (msg) => { logDiv.textContent += msg + '\n'; logDiv.scrollTop = logDiv.scrollHeight; };
    function setProgress(pct, text) {
      progressWrap.style.display = 'block';
      progressBar.style.width = Math.max(0, Math.min(100, pct)) + '%';
      progressText.textContent = text;
    }
    return { logDiv, log, setProgress, progressWrap };
  }

  // 진행률을 status.json에 너무 자주 올리면(배치마다, 즉 CONCURRENCY=3건마다) GitHub API
  // 호출과 커밋이 과도하게 늘어나므로, 최소 간격(PROGRESS_UPLOAD_MIN_MS)을 두고 그 사이에는
  // 건너뛴다. 모듈 전역 변수라 페이지가 새로고침되면 다시 0부터 시작 — 새로고침 직후 첫
  // 배치에서는 바로 한 번 올라가게 됨(의도된 동작).
  const PROGRESS_UPLOAD_MIN_MS = 15 * 1000;
  let lastProgressUploadAt = 0;
  function maybeUploadProgress(job, total) {
    const now = Date.now();
    if (now - lastProgressUploadAt < PROGRESS_UPLOAD_MIN_MS) return;
    lastProgressUploadAt = now;
    uploadRunningStatus(
      job.windowValue, job.windowLabel, job.minPicks,
      job.startedAt ? new Date(job.startedAt).toISOString() : undefined,
      { processed: job.nextIndex, total },
      '정산 결과 분석 중'
    );
  }

  // 단계가 바뀔 때마다 즉시 올린다(진행률 제한과 무관하게). 대시보드가 "지금 무슨 일을
  // 하고 있는지"를 보여줄 수 있도록 하기 위함.
  function reportPhase(job, phase, progress) {
    if (!job) return;
    lastProgressUploadAt = Date.now(); // 방금 올렸으므로 진행률 제한 타이머도 갱신
    uploadRunningStatus(
      job.windowValue, job.windowLabel, job.minPicks,
      job.startedAt ? new Date(job.startedAt).toISOString() : undefined,
      progress, phase
    );
  }

  // job.posts 중 job.nextIndex부터 끝까지 이어서 처리. CONCURRENCY개씩 묶어 동시에 처리하고,
  // 이미 결과 캐시에 있는(=예전에 한 번 받아본) 글은 네트워크 요청 없이 즉시 재사용한다.
  // 중간에 새로고침이 와도 saveJob()이 배치가 끝날 때마다 저장해두므로 다음 로드 때 이어서 재개된다.
  // ---------- 백그라운드 탭 타이머 제한 해제 ----------
  // 크롬은 화면에 안 보이는 탭의 타이머를 늦춘다. 숨겨진 직후 5분간은 최소 1초 간격으로,
  // 그 뒤로는 1분에 한 번까지 제한된다(intensive throttling). 이 분석기는 글 사이사이
  // 짧은 지연을 두고 순차 처리하는 구조라, 다른 데스크톱/백그라운드에 오래 두면 사실상
  // 멈춘 것처럼 기어간다. "소리가 나는 탭"은 이 제한에서 제외되므로, 분석이 도는 동안만
  // 무음 오디오를 재생해서 제 속도를 유지하고 끝나면 바로 끈다.
  let keepAwakeCtx = null;
  let keepAwakeNodes = null;

  function startKeepAwake() {
    if (keepAwakeCtx) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.0001; // 사실상 무음 (완전 0이면 '소리 없음'으로 판정될 수 있음)
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      keepAwakeCtx = ctx;
      keepAwakeNodes = { osc, gain };
      // 사용자 제스처 없이 시작하면 suspended 상태일 수 있어 재개를 시도한다
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    } catch (e) { /* 실패해도 분석 자체는 그대로 진행 */ }
  }

  function stopKeepAwake() {
    try {
      if (keepAwakeNodes) { keepAwakeNodes.osc.stop(); keepAwakeNodes.osc.disconnect(); keepAwakeNodes.gain.disconnect(); }
      if (keepAwakeCtx) keepAwakeCtx.close();
    } catch (e) { /* 무시 */ }
    keepAwakeCtx = null;
    keepAwakeNodes = null;
  }

  // 분석이 도는 동안만 타이머 제한 해제를 켜둔다. 중간에 오류가 나도 반드시 꺼지도록 감싼다.
  async function processJob(panel, job) {
    startKeepAwake();
    try {
      return await processJobInner(panel, job);
    } finally {
      stopKeepAwake();
    }
  }

  async function processJobInner(panel, job) {
    const { log, setProgress, progressWrap } = getPanelControls(panel);
    const total = job.posts.length;
    const cache = loadResultCache();

    while (job.nextIndex < total) {
      const batch = job.posts.slice(job.nextIndex, job.nextIndex + CONCURRENCY);
      const startIdx = job.nextIndex;
      const endIdx = Math.min(startIdx + batch.length, total);
      const pct = 5 + (endIdx / Math.max(1, total)) * 92; // 5~97%
      setProgress(pct, `[${startIdx + 1}~${endIdx}/${total}] 동시 처리 중...`);

      const results = await Promise.all(batch.map(async (post, bi) => {
        const i = startIdx + bi + 1;
        try {
          const cached = cache[post.document_srl];
          if (cached) {
            log(`[${i}/${total}] (캐시) ${post.title.slice(0, 40)}...`);
            if (!cached.srl) cached.srl = post.document_srl; // 예전 캐시 항목 보정
            return cached;
          }
          log(`[${i}/${total}] ${post.title.slice(0, 40)}...`);
          const detail = await fetchPostDetail(post.document_srl);
          const pk = detail && detail.pk;
          if (!pk) {
            log('  -> pk 추출 실패, 건너뜀');
            return null;
          }
          const { winList, loseList, winOption } = await fetchPostResult(pk);
          if (!winOption) {
            log('  -> 정산 미완료 또는 데이터 없음, 건너뜀');
            return null;
          }
          const sport = classifySport(post.title);
          // srl을 함께 담아둬야, 작업 기록에는 번호만 저장했다가 캐시에서 결과를 되살릴 수 있음
          const entry = { srl: post.document_srl, sport, winList, loseList, title: post.title, at: Date.now() };
          cache[post.document_srl] = entry; // 정산 완료된 글은 결과가 안 바뀌므로 영구 캐시
          log(`  -> ${sport} / 승:${winList.length}명, 패:${loseList.length}명`);
          return entry;
        } catch (e) {
          log('  -> 오류: ' + e.message);
          return null;
        }
      }));

      for (const r of results) if (r) job.allPostResults.push(r);
      job.nextIndex = endIdx;
      saveResultCache(cache);
      saveJob(job); // 배치 하나 끝날 때마다 저장 — 다음 자동새로고침에도 안전
      maybeUploadProgress(job, total); // 대시보드에 진행률 표시(너무 잦지 않게 제한됨)
      if (job.nextIndex < total) await sleepJitter();
    }

    setProgress(97, '진행중인 경기 베팅 정보 수집 중...');
    log('진행중인 경기 베팅 정보 수집 중...');
    reportPhase(job, '진행중인 경기 베팅 수집 중', { processed: total, total });
    let ongoingPicksMap;
    let ongoingMatches;
    let srlByNick = null;
    if (job.ongoingPicks) {
      // 이미 한 번 수집해둔 게 있으면(예: 1분마다 새로고침되는 페이지에서 재개된 경우)
      // 다시 긁지 않고 그대로 재사용한다.
      ongoingPicksMap = new Map(job.ongoingPicks);
      ongoingMatches = job.ongoingMatches || [];
    } else {
      const collected = await collectOngoingPicks(log);
      ongoingPicksMap = collected.map;
      ongoingMatches = collected.matches;
      srlByNick = collected.srlByNick;
      job.ongoingPicks = Array.from(ongoingPicksMap.entries());
      job.ongoingMatches = ongoingMatches;
      saveJob(job);
    }

    // 고정 닉네임들의 현재 잉여력 조회 (대시보드가 보내준 목록이 없으면 건너뜀)
    let pinnedPoints = {};
    try {
      setProgress(98, '고정 닉네임 잉여력 조회 중...');
      reportPhase(job, '고정 닉네임 잉여력 조회 중', { processed: total, total });
      pinnedPoints = await collectPinnedPoints(srlByNick, log, true);
    } catch (e) { log('잉여력 조회 중 오류: ' + e.message); }

    setProgress(99, '집계 중...');
    log('집계 중...');
    reportPhase(job, '집계 중', { processed: total, total });
    const records = aggregate(job.allPostResults);
    log(`완료. 총 참여자 ${records.size}명.`);
    setProgress(100, `완료 — 글 ${total}건, 참여자 ${records.size}명`);
    setTimeout(() => { progressWrap.style.display = 'none'; }, 2500);

    job.status = 'done';
    saveJob(job); // 완료 상태도 저장해둬서, 새로고침 후 다시 열었을 때 바로 결과가 보이게 함
    renderResult(panel, records, job.minPicks, ongoingPicksMap, ongoingMatches);

    // 새로 완료된 분석 결과를 GitHub 대시보드용 데이터로 올림 (토큰 미설정 시 조용히 건너뜀)
    reportPhase(job, '결과 업로드 중', { processed: total, total });
    await uploadResultsToGitHub(records, job.minPicks, ongoingPicksMap, job.windowLabel, ongoingMatches, log, pinnedPoints);
    // 대시보드가 "분석 진행 중" 배너를 내리고 새 결과를 바로 받아가도록 상태 갱신
    uploadIdleStatus(new Date().toISOString());
  }

  async function startNewRun(panel) {
    const { logDiv, log, setProgress, progressWrap } = getPanelControls(panel);
    const minPicks = parseInt(panel.querySelector('#jsa-minpicks').value, 10) || 4;
    const windowValue = panel.querySelector('#jsa-window').value;
    const windowOpt = getWindowOption(windowValue);
    const now = new Date();
    const rangeStart = windowOpt.rangeStart(now);
    const rangeEnd = now;

    logDiv.textContent = '';
    panel.querySelector('#jsa-result').innerHTML = '';
    setProgress(0, '준비 중...');
    clearJob();
    lastProgressUploadAt = 0; // 새 분석이므로 진행률 제한 타이머도 초기화 — 바로 첫 진행률이 올라가게



    if (!window.jQuery || !window.jQuery.exec_json) {
      log('오류: 이 페이지에서 jQuery.exec_json을 찾을 수 없습니다. 잉여력놀이터(mid=pointplay) 게시판 페이지에서 실행해주세요.');
      progressWrap.style.display = 'none';
      return;
    }

    // 대시보드가 "분석 진행 중" 배너를 띄울 수 있도록 상태를 올림 (토큰 미설정 시 조용히 건너뜀)
    uploadRunningStatus(windowValue, windowOpt.label, minPicks);

    setProgress(2, `${windowOpt.label} 기준 정산 글 목록을 가져오는 중...`);
    log(`${windowOpt.label} 기준 정산 글 목록을 가져오는 중...`);
    // 아직 job 객체를 만들기 전이므로 같은 정보를 담은 임시 객체로 단계를 보고한다
    reportPhase({ windowValue, windowLabel: windowOpt.label, minPicks, startedAt: Date.now() }, '정산 글 목록 가져오는 중');
    const posts = await collectTodayPosts(log, rangeStart, rangeEnd, windowOpt.label, windowOpt.maxPages);
    log(`${windowOpt.label} 기준 글 ${posts.length}건 발견.`);
    setProgress(5, `글 ${posts.length}건 발견. 분석 시작...`);

    const job = {
      status: 'running',
      minPicks, windowValue, windowLabel: windowOpt.label,
      posts, nextIndex: 0, allPostResults: [],
      startedAt: Date.now(),
    };
    saveJob(job);
    await processJob(panel, job);
  }

  // ---------- 진입점: 플로팅 버튼 ----------
  function applyJobControlsToPanel(panel, job) {
    if (!job) return;
    const minInput = panel.querySelector('#jsa-minpicks');
    const winSelect = panel.querySelector('#jsa-window');
    if (typeof job.minPicks === 'number') minInput.value = job.minPicks;
    if (job.windowValue) winSelect.value = job.windowValue;
  }

  function init() {
    if (document.getElementById('jsa-panel')) return;
    housekeepStorage(); // 저장공간 정기 청소 (유효기간 지난 캐시 정리)
    const panel = createPanel();
    panel.querySelector('#jsa-run').onclick = () => startNewRun(panel);

    // 이전 작업이 저장돼 있으면(진행 중이었거나 완료됐던 것) 자동으로 이어서 보여줌 —
    // 1분마다 새로고침되는 페이지에서도 분석이 끊기지 않도록 하기 위함.
    const job = loadJob();
    // 저장 실패(용량 초과) 등으로 "진행중"인 채 굳어버린 작업 방어 — 마지막으로 저장된 지
    // 오래됐으면 이어서 진행하지 않고 버린다. 안 그러면 새로고침마다 같은 분석을 다시 돌리고,
    // "이미 분석 중"으로 판단돼서 새 원격 요청도 영원히 처리되지 않는다.
    const STALE_JOB_MS = 15 * 60 * 1000;
    if (job && job.status === 'running') {
      const lastTouched = job.lastSavedAt || job.startedAt || 0;
      if (lastTouched && Date.now() - lastTouched > STALE_JOB_MS) {
        clearJob();
        const { log } = getPanelControls(panel);
        log('(정리) 오래 멈춰 있던 이전 분석 기록을 버렸습니다. 새로 "분석 시작"을 눌러주세요.');
        return;
      }
    }
    if (job) {
      applyJobControlsToPanel(panel, job);
      if (job.status === 'running' && Array.isArray(job.posts)) {
        const { log, setProgress } = getPanelControls(panel);
        if (jobSaveFailed) log('⚠ 저장공간이 부족해 진행 상황이 저장되지 않을 수 있습니다.');
        // 새로고침으로 이어서 진행하는 경우에도 대시보드의 "진행 중" 배너가 유지되도록 다시 올림.
        // job.startedAt(최초 시작 시각)을 그대로 넘겨서 "N분째 진행 중" 표시가 리셋되지 않게 함.
        uploadRunningStatus(
          job.windowValue, job.windowLabel, job.minPicks,
          job.startedAt ? new Date(job.startedAt).toISOString() : undefined,
          Array.isArray(job.posts) ? { processed: job.nextIndex, total: job.posts.length } : undefined
        );
        log(`(자동 복구) 이전 분석을 이어서 진행합니다 — ${job.nextIndex}/${job.posts.length}건 완료됨`);
        setProgress(5 + (job.nextIndex / Math.max(1, job.posts.length)) * 93, `이어서 진행 중... (${job.nextIndex}/${job.posts.length})`);
        if (window.jQuery && window.jQuery.exec_json) {
          processJob(panel, job);
        } else {
          // 스크립트가 아직 안 떴으면 잠시 후 재시도
          const retry = setInterval(() => {
            if (window.jQuery && window.jQuery.exec_json) {
              clearInterval(retry);
              processJob(panel, job);
            }
          }, 300);
        }
      } else if (job.status === 'done' && Array.isArray(job.allPostResults)) {
        const records = aggregate(job.allPostResults);
        const ongoingPicksMap = job.ongoingPicks ? new Map(job.ongoingPicks) : new Map();
        renderResult(panel, records, job.minPicks || 4, ongoingPicksMap, job.ongoingMatches || []);
      }
    }
  }

  // ---------- 7. 새로고침 전후로 스크롤 위치 유지 ----------
  // '진행중인 경기' 페이지는 다른 스크립트가 1분마다 새로고침을 걸기 때문에, 밑으로 스크롤해서
  // 보고 있던 중에 새로고침이 오면 맨 위로 튕겨서 다시 스크롤해야 하는 불편이 있었다.
  // 떠나기 직전 스크롤 위치를 저장해뒀다가, 로드되면 그 위치로 즉시 복원한다.
  const SCROLL_POS_KEY = 'jsa-scroll-pos-v1';

  function saveScrollPos() {
    try { sessionStorage.setItem(SCROLL_POS_KEY, String(window.scrollY)); } catch (e) { /* 무시 */ }
  }

  function restoreScrollPos() {
    try {
      const saved = sessionStorage.getItem(SCROLL_POS_KEY);
      if (saved === null) return;
      const y = parseInt(saved, 10);
      if (!Number.isFinite(y) || y <= 0) return;
      // 레이아웃이 다 잡히기 전에 스크롤하면 어긋날 수 있어서, 두 번(즉시 + 한 박자 뒤) 맞춰준다.
      window.scrollTo(0, y);
      setTimeout(() => window.scrollTo(0, y), 300);
    } catch (e) { /* 무시 */ }
  }

  function initScrollPersistence() {
    restoreScrollPos();
    window.addEventListener('beforeunload', saveScrollPos);
    // 스크롤할 때마다도 틈틈이 저장해둠 — beforeunload가 못 걸리는 새로고침 방식 대비
    let scrollSaveTimer = null;
    window.addEventListener('scroll', () => {
      clearTimeout(scrollSaveTimer);
      scrollSaveTimer = setTimeout(saveScrollPos, 200);
    }, { passive: true });
  }

  // 페이지 로드 후 약간 지연 후 패널 자동 표시 ('마감' 탭 또는 '진행중인 경기' 페이지일 때만)
  const MAGAM_CATEGORY = '4871634816'; // 마감 탭
  const onMagamTab = location.href.includes('mid=pointplay') && location.href.includes(`category=${MAGAM_CATEGORY}`);
  const onOngoingMatches = location.href.includes('mid=pointplay') && location.href.includes('act=dispBoardOngoingMatches');
  if (onMagamTab || onOngoingMatches) {
    initScrollPersistence();
    window.addEventListener('load', () => setTimeout(init, 500));
    if (document.readyState === 'complete') setTimeout(init, 500);
  }
})();
