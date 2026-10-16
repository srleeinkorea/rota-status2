// ==UserScript==
// @name         정산 승률 분석기
// @namespace    fmkorea-jungsan-analyzer
// @version      4.8
// @description  잉여력놀이터 '정산' 게시판의 최근 24시간 내 마감 글들을 자동으로 읽어서 참가자별 승률(종합/종목별)을 집계합니다. 사이트 내부 AJAX(pp.getPpList)를 그대로 호출해서, 글을 일일이 열고 참여현황을 손으로 베낄 필요가 없습니다. 종합 랭킹에는 진행중인(아직 결과가 안 나온) 경기에 누가 어디 베팅했는지도 함께 보여줍니다.
// @match        https://www.fmkorea.com/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/srleeinkorea/rota-status2/main/fmkorea_jungsan_analyzer.user.js
// @downloadURL  https://raw.githubusercontent.com/srleeinkorea/rota-status2/main/fmkorea_jungsan_analyzer.user.js
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_VERSION = '4.8';
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
  const UPLOAD_TOP_N = 100; // 대시보드 용량/속도를 위해 종합 랭킹은 상위 100명까지만 올림

  // ---------- 유틸 ----------
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
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
    if (dt.getTime() - now.getTime() > 12 * 3600 * 1000) {
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
  const SPORT_RULES = [
    [/ETTU|탁구/, '탁구(ETTU)'],
    [/BWF|배드민턴/, '배드민턴(BWF)'],
    [/AFC\s*CL|챔피언스리그 엘리트/, '축구(AFC CL)'],
    [/KOVO|배구.*(일반|O\/U|언\/오버|언더|오버)/i, '배구(KOVO)'],
    [/WTA/, '테니스(WTA)'],
    [/ATP/, '테니스(ATP)'],
    [/LOL|LCK|DCGI/, 'LOL'],
    [/NBA/, 'NBA'],
    [/NFL/, 'NFL(미식축구)'],
    [/KBL/, 'KBL(농구)'],
    [/MLB/, 'MLB(야구)'],
    [/세리에\s*A/, '세리에A'],
    [/라리가/, '라리가'],
    [/프리미어리그|EPL/, 'EPL'],
    [/분데스리가/, '분데스리가'],
    [/튀르키예.*배구/, '배구(튀르키예)'],
    [/폴란드.*배구/, '배구(폴란드)'],
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
  async function fetchPostDetail(document_srl) {
    // 짧은 URL 형태(/문서번호)가 긴 쿼리스트링 형태보다 안정적으로 응답함(간헐적 432 차단 회피)
    const url = `https://www.fmkorea.com/${document_srl}`;
    let res = await fetch(url, { credentials: 'same-origin' });
    if (res.status === 432) {
      await sleep(800);
      res = await fetch(url, { credentials: 'same-origin' }); // 1회 재시도
    }
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/getPpListClick\((\d+)\s*,\s*1\)/);
    if (!m) return null;
    return parseInt(m[1], 10);
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

  async function getOngoingMatchPosts() {
    const onThisPage = location.href.includes('mid=pointplay') && location.href.includes('act=dispBoardOngoingMatches');
    if (onThisPage) return extractOngoingPostsFromDoc(document);
    const url = 'https://www.fmkorea.com/index.php?mid=pointplay&act=dispBoardOngoingMatches';
    const res = await fetch(url, { credentials: 'same-origin' });
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
  async function collectOngoingPicks(log) {
    const map = new Map(); // nick_name -> [{team, url, bet}]
    const matches = []; // [{title, url, teamA, teamB, countA, betA, countB, betB}]
    try {
      const posts = await getOngoingMatchPosts();
      log(`진행중인 경기 ${posts.length}건의 베팅 현황을 확인하는 중...`);
      for (let i = 0; i < posts.length; i += CONCURRENCY) {
        const batch = posts.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (post) => {
          const matchup = extractMatchupTeams(post.title);
          if (!matchup) return;
          const url = `https://www.fmkorea.com/${post.document_srl}`;
          try {
            const pk = await fetchPostDetail(post.document_srl);
            if (!pk) return;
            const { opt1, opt2 } = await fetchOngoingBettors(pk);
            let countA = 0, betA = 0, countB = 0, betB = 0;
            for (const e of opt1) {
              if (!e.nick_name) continue;
              if (!map.has(e.nick_name)) map.set(e.nick_name, []);
              map.get(e.nick_name).push({ team: matchup.a, url, bet: e.point || 0 });
              countA++; betA += e.point || 0;
            }
            for (const e of opt2) {
              if (!e.nick_name) continue;
              if (!map.has(e.nick_name)) map.set(e.nick_name, []);
              map.get(e.nick_name).push({ team: matchup.b, url, bet: e.point || 0 });
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
    return { map, matches };
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

    for (const { sport, winList, loseList } of allPostResults) {
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
    return bySport;
  }

  // ---------- 5. UI ----------
  const PANEL_POS_KEY = 'jsa-panel-pos-v1';
  const PANEL_SIZE_KEY = 'jsa-panel-size-v1';
  const PANEL_MIN_WIDTH = 380;
  const PANEL_MAX_WIDTH = 900;
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
      const maxLeft = Math.max(0, window.innerWidth - w);
      const maxTop = Math.max(0, window.innerHeight - h);
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
      const maxLeft = Math.max(0, window.innerWidth - w);
      const maxTop = Math.max(0, window.innerHeight - h);
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
      const maxW = Math.min(PANEL_MAX_WIDTH, window.innerWidth - rect.left);
      const maxH = Math.min(window.innerHeight - 20, window.innerHeight - rect.top);
      const newW = Math.max(PANEL_MIN_WIDTH, Math.min(maxW, startW + dx));
      const newH = Math.max(PANEL_MIN_HEIGHT, Math.min(maxH, startH + dy));
      panel.style.width = newW + 'px';
      panel.style.height = newH + 'px';
    }
    function onUp() {
      if (!resizing) return;
      resizing = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try {
        localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify({ width: panel.style.width, height: panel.style.height }));
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
  const SPORT_TOP = 3;
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

  function rowHtml(r, withMoney, rankIdx) {
    const rankCell = (typeof rankIdx === 'number')
      ? `<td><span class="jsa-rank ${RANK_MEDAL[rankIdx] || ''}">${rankIdx + 1}</span></td>`
      : '';
    const rateClass = r.rate >= 70 ? 'high' : 'low';
    let html = `<tr>${rankCell}<td class="jsa-name">${escapeHtml(r.name)}</td><td><span class="jsa-record-pill">${r.win}승${r.lose}패</span></td><td class="jsa-rate ${rateClass}">${fmt(r.rate)}</td>`;
    if (withMoney) {
      const profitClass = r.profit >= 0 ? 'pos' : 'neg';
      html += `<td class="jsa-money">${numFmt(r.totalBet)}</td><td class="jsa-profit ${profitClass}">${r.profit >= 0 ? '+' : ''}${numFmt(r.profit)}</td><td>${picksHtml(r.picks)}</td>`;
    }
    html += '</tr>';
    return html;
  }

  function renderResult(panel, records, minPicks, ongoingPicksMap) {
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
    for (const [sport, arr] of bySport.entries()) {
      html += `<div class="jsa-sport-header">${escapeHtml(sport)} <span class="jsa-count-badge">${arr.length}명</span></div>`;
      html += '<div class="jsa-card"><table class="jsa-table"><thead><tr><th></th><th>닉네임</th><th>전적</th><th>승률</th></tr></thead><tbody>';
      arr.slice(0, SPORT_TOP).forEach((r, idx) => { html += rowHtml(r, false, idx); });
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
  function buildDashboardPayload(records, minPicks, ongoingPicksMap, windowLabel, ongoingMatches) {
    const overall = overallRanking(records, minPicks);
    const bySport = sportRanking(records, Math.max(2, Math.min(2, minPicks)));
    const overallSlim = overall.slice(0, UPLOAD_TOP_N).map((r) => ({
      name: r.name, win: r.win, lose: r.lose, total: r.total, rate: Math.round(r.rate * 10) / 10,
      totalBet: r.totalBet, totalPayout: r.totalPayout, profit: r.profit,
      picks: (ongoingPicksMap && ongoingPicksMap.get(r.name)) || [],
    }));
    const sportsSlim = {};
    for (const [sport, arr] of bySport.entries()) {
      sportsSlim[sport] = arr.slice(0, SPORT_TOP).map((r) => ({
        name: r.name, win: r.win, lose: r.lose, total: r.total, rate: Math.round(r.rate * 10) / 10,
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
      windowLabel: windowLabel || null,
      minPicks,
      totalParticipants: overall.length,
      overall: overallSlim,
      sports: sportsSlim,
      ongoingMatches: matchesSlim,
      allPicks,
      allRecords,
    };
  }

  async function uploadResultsToGitHub(records, minPicks, ongoingPicksMap, windowLabel, ongoingMatches, log) {
    const token = getGithubToken();
    if (!token) return; // 토큰 설정 안 돼 있으면 조용히 건너뜀 (패널 설정에서 등록 가능)
    try {
      const payload = buildDashboardPayload(records, minPicks, ongoingPicksMap, windowLabel, ongoingMatches);
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
  function uploadRunningStatus(windowValue, windowLabel, minPicks, startedAt, progress) {
    const payload = {
      state: 'running',
      windowValue, windowLabel, minPicks,
      startedAt: startedAt || new Date().toISOString(),
    };
    if (progress && typeof progress.total === 'number' && progress.total > 0) {
      payload.processed = progress.processed;
      payload.total = progress.total;
      payload.pct = Math.round((progress.processed / progress.total) * 100);
    }
    uploadJsonToGitHub(GITHUB_STATUS_PATH, payload);
  }
  function uploadIdleStatus() {
    uploadJsonToGitHub(GITHUB_STATUS_PATH, {
      state: 'idle',
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
  const COMMAND_POLL_MS = 45 * 1000;
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
      if (!cmd || cmd.action !== 'run' || !cmd.requestedAt) return;
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
      const { map, matches } = await collectOngoingPicks(() => {}); // 조용히 수집(패널 로그 오염 방지)
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
      if (Array.isArray(data.overall)) {
        data.overall.forEach((r) => { r.picks = map.get(r.name) || []; });
      }

      const body = {
        message: `진행중인 경기 갱신 (${data.ongoingUpdatedAt})`,
        content: utf8ToBase64(JSON.stringify(data, null, 2)),
        sha,
      };
      await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(body) });
    } catch (e) { /* 다음 주기에 재시도 */ }
  }
  setInterval(refreshOngoingMatchesOnly, ONGOING_REFRESH_MS);
  setTimeout(refreshOngoingMatchesOnly, 90 * 1000); // 패널 뜨고 좀 지나서 첫 실행(초기 분석과 겹치지 않게)

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
      { processed: job.nextIndex, total }
    );
  }

  // job.posts 중 job.nextIndex부터 끝까지 이어서 처리. CONCURRENCY개씩 묶어 동시에 처리하고,
  // 이미 결과 캐시에 있는(=예전에 한 번 받아본) 글은 네트워크 요청 없이 즉시 재사용한다.
  // 중간에 새로고침이 와도 saveJob()이 배치가 끝날 때마다 저장해두므로 다음 로드 때 이어서 재개된다.
  async function processJob(panel, job) {
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
          const pk = await fetchPostDetail(post.document_srl);
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
    let ongoingPicksMap;
    let ongoingMatches;
    if (job.ongoingPicks) {
      // 이미 한 번 수집해둔 게 있으면(예: 1분마다 새로고침되는 페이지에서 재개된 경우)
      // 다시 긁지 않고 그대로 재사용한다.
      ongoingPicksMap = new Map(job.ongoingPicks);
      ongoingMatches = job.ongoingMatches || [];
    } else {
      const collected = await collectOngoingPicks(log);
      ongoingPicksMap = collected.map;
      ongoingMatches = collected.matches;
      job.ongoingPicks = Array.from(ongoingPicksMap.entries());
      job.ongoingMatches = ongoingMatches;
      saveJob(job);
    }

    setProgress(99, '집계 중...');
    log('집계 중...');
    const records = aggregate(job.allPostResults);
    log(`완료. 총 참여자 ${records.size}명.`);
    setProgress(100, `완료 — 글 ${total}건, 참여자 ${records.size}명`);
    setTimeout(() => { progressWrap.style.display = 'none'; }, 2500);

    job.status = 'done';
    saveJob(job); // 완료 상태도 저장해둬서, 새로고침 후 다시 열었을 때 바로 결과가 보이게 함
    renderResult(panel, records, job.minPicks, ongoingPicksMap);

    // 새로 완료된 분석 결과를 GitHub 대시보드용 데이터로 올림 (토큰 미설정 시 조용히 건너뜀)
    uploadResultsToGitHub(records, job.minPicks, ongoingPicksMap, job.windowLabel, ongoingMatches, log);
    // 대시보드가 "분석 진행 중" 배너를 내릴 수 있도록 상태를 idle로 갱신
    uploadIdleStatus();
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
        renderResult(panel, records, job.minPicks || 4, ongoingPicksMap);
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
