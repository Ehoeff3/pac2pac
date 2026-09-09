/* =========================================================
   All-time history engine.

   Walks the Sleeper `previous_league_id` chain backward from the
   archive league, pulls every completed season, and folds the two
   current leagues in on top. Everything is keyed by Sleeper user_id,
   so a manager keeps one continuous career line no matter how many
   times they rename the team.

   Runs in the visitor's browser and caches the finished result in
   localStorage, so it costs one burst of requests per person per day.
   ========================================================= */

const HISTORY_CACHE_KEY = 'p2p.history.v3';
const HISTORY_TTL_MS = 12 * 60 * 60 * 1000;

async function loadHistory() {
  const cached = readHistoryCache();
  if (cached) { state.history = cached; return cached; }

  const chain = await walkChain(state.cfg.history && state.cfg.history.archiveLeagueId);
  const seasons = [];

  for (const meta of chain) {
    const s = await loadArchivedSeason(meta);
    if (s) seasons.push(s);
  }

  // Fold in the live season from the leagues already loaded.
  state.order.forEach(k => {
    const b = state.leagues[k];
    if (!b || !b.played) return;
    seasons.push(currentSeasonAsHistory(b));
  });

  seasons.sort((a, b) => Number(a.season) - Number(b.season) || a.name.localeCompare(b.name));

  const history = buildCareers(seasons);
  writeHistoryCache(history);
  state.history = history;
  return history;
}

function readHistoryCache() {
  try {
    const raw = localStorage.getItem(HISTORY_CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj.builtAt || Date.now() - obj.builtAt > HISTORY_TTL_MS) return null;
    if (obj.archiveId !== (state.cfg.history && state.cfg.history.archiveLeagueId)) return null;
    return obj;
  } catch (e) { return null; }
}

function writeHistoryCache(h) {
  try {
    h.builtAt = Date.now();
    h.archiveId = state.cfg.history && state.cfg.history.archiveLeagueId;
    localStorage.setItem(HISTORY_CACHE_KEY, JSON.stringify(h));
  } catch (e) { /* private mode, quota — history just rebuilds next visit */ }
}

/** Follow previous_league_id back to the beginning. */
async function walkChain(startId) {
  const out = [];
  let id = startId;
  let guard = 0;
  while (id && guard++ < 25) {
    let meta;
    try { meta = await getJSON(`${API}/league/${id}`); }
    catch (e) { break; }
    out.push(meta);
    id = meta.previous_league_id;
  }
  return out;
}

async function loadArchivedSeason(meta) {
  const id = meta.league_id;
  const playoffStart = (meta.settings && meta.settings.playoff_week_start) || 15;
  const lastWeek = playoffStart + 2;

  const [users, rosters, bracket] = await Promise.all([
    getJSON(`${API}/league/${id}/users`).catch(() => []),
    getJSON(`${API}/league/${id}/rosters`).catch(() => []),
    getJSON(`${API}/league/${id}/winners_bracket`).catch(() => []),
  ]);
  if (!rosters.length) return null;

  const weekNums = [];
  for (let w = 1; w <= lastWeek; w++) weekNums.push(w);
  const weekRows = await Promise.all(
    weekNums.map(w => getJSON(`${API}/league/${id}/matchups/${w}`).catch(() => []))
  );

  const ownerOf = {};
  rosters.forEach(r => { ownerOf[r.roster_id] = r.owner_id; });

  const userById = {};
  users.forEach(u => { userById[u.user_id] = u; });

  const games = [];
  weekNums.forEach((w, i) => {
    pairWeek(weekRows[i]).forEach(g => {
      const aPts = g.a.points || 0, bPts = g.b.points || 0;
      if (aPts <= 0 && bPts <= 0) return;                    // unplayed
      const a = ownerOf[g.a.roster_id], b = ownerOf[g.b.roster_id];
      if (!a || !b) return;
      games.push({ week: w, a, b, aPts, bPts, post: w >= playoffStart });
    });
  });
  if (!games.length) return null;                            // abandoned shell league

  const teams = rosters.map(r => {
    const u = userById[r.owner_id] || {};
    const s = r.settings || {};
    return {
      userId: r.owner_id,
      display: u.display_name || 'Unknown',
      team: (u.metadata && u.metadata.team_name) || u.display_name || 'Unknown',
      avatar: u.avatar || null,
      wins: s.wins || 0, losses: s.losses || 0, ties: s.ties || 0,
      pf: (s.fpts || 0) + (s.fpts_decimal || 0) / 100,
      pa: (s.fpts_against || 0) + (s.fpts_against_decimal || 0) / 100,
      rosterId: r.roster_id,
    };
  });
  teams.sort((x, y) => (y.wins - x.wins) || (y.pf - x.pf));
  teams.forEach((t, i) => { t.finish = i + 1; });

  const podium = readBracket(bracket, ownerOf);

  return {
    season: String(meta.season),
    leagueId: id,
    name: meta.name || 'League',
    teams, games,
    playoffStart,
    champion: podium.champion,
    runnerUp: podium.runnerUp,
    third: podium.third,
    archived: true,
  };
}

/** Championship, runner-up and third place out of a Sleeper winners bracket. */
function readBracket(bracket, ownerOf) {
  const out = { champion: null, runnerUp: null, third: null };
  (bracket || []).forEach(m => {
    if (m.p === 1 && m.w) { out.champion = ownerOf[m.w] || null; out.runnerUp = ownerOf[m.l] || null; }
    if (m.p === 3 && m.w) { out.third = ownerOf[m.w] || null; }
  });
  return out;
}

/** Shape a live league bundle like an archived season. */
function currentSeasonAsHistory(b) {
  const teams = standings(b).map(t => ({
    userId: t.ownerId, display: t.owner, team: t.name, avatar: t.avatar,
    wins: t.wins, losses: t.losses, ties: t.ties, pf: t.pf, pa: t.pa,
    finish: t.pos, rosterId: t.rosterId,
  }));

  const games = [];
  for (let w = 1; w <= b.lastRegWeek; w++) {
    pairWeek(b.schedule[w]).forEach(g => {
      const aPts = g.a.points || 0, bPts = g.b.points || 0;
      if (aPts <= 0 && bPts <= 0) return;
      if (w >= b.curWeek) return;                            // in progress, not final
      const ta = b.byRoster[g.a.roster_id], tb = b.byRoster[g.b.roster_id];
      if (!ta || !tb) return;
      games.push({ week: w, a: ta.ownerId, b: tb.ownerId, aPts, bPts, post: false });
    });
  }

  return {
    season: String(state.nfl.season), leagueId: b.conf.id, name: b.conf.name,
    teams, games, playoffStart: b.lastRegWeek + 1,
    champion: null, runnerUp: null, third: null, archived: false, live: true,
  };
}

/* ---------------- career + record aggregation ---------------- */

function buildCareers(seasons) {
  const people = {};
  const h2h = {};
  const allGames = [];

  const person = id => (people[id] = people[id] || {
    userId: id, display: 'Unknown', team: '', avatar: null,
    seasons: 0, wins: 0, losses: 0, ties: 0, pf: 0, pa: 0, games: 0,
    titles: [], finals: [], thirds: [], bestFinish: 99,
    high: null, low: null, seasonLines: [],
  });

  seasons.forEach(s => {
    s.teams.forEach(t => {
      const p = person(t.userId);
      p.display = t.display; p.team = t.team; p.avatar = t.avatar || p.avatar;
      p.seasons++;
      p.wins += t.wins; p.losses += t.losses; p.ties += t.ties;
      p.pf += t.pf; p.pa += t.pa;
      p.bestFinish = Math.min(p.bestFinish, t.finish);
      p.seasonLines.push({
        season: s.season, league: s.name, live: !!s.live,
        wins: t.wins, losses: t.losses, ties: t.ties,
        pf: t.pf, pa: t.pa, finish: t.finish, teamName: t.team,
        champion: s.champion === t.userId,
        runnerUp: s.runnerUp === t.userId,
      });
    });
    if (s.champion) person(s.champion).titles.push({ season: s.season, league: s.name });
    if (s.runnerUp) person(s.runnerUp).finals.push({ season: s.season, league: s.name });
    if (s.third) person(s.third).thirds.push({ season: s.season, league: s.name });

    s.games.forEach(g => {
      allGames.push({ ...g, season: s.season, league: s.name });

      [[g.a, g.aPts, g.b, g.bPts], [g.b, g.bPts, g.a, g.aPts]].forEach(([me, mine, opp, theirs]) => {
        const p = person(me);
        p.games++;
        if (!p.high || mine > p.high.pts) p.high = { pts: mine, season: s.season, week: g.week };
        if (!p.low || mine < p.low.pts) p.low = { pts: mine, season: s.season, week: g.week };

        const key = me + '|' + opp;
        const rec = (h2h[key] = h2h[key] || { w: 0, l: 0, t: 0, pf: 0, pa: 0, meetings: [] });
        rec.pf += mine; rec.pa += theirs;
        if (mine > theirs) rec.w++; else if (mine < theirs) rec.l++; else rec.t++;
        rec.meetings.push({ season: s.season, week: g.week, mine, theirs, post: g.post });
      });
    });
  });

  Object.values(people).forEach(p => {
    const tot = p.wins + p.losses + p.ties;
    p.winPct = tot ? (p.wins + p.ties * 0.5) / tot : 0;
    p.ppg = p.games ? p.pf / p.games : 0;
    p.seasonLines.sort((a, b) => Number(b.season) - Number(a.season));
  });

  return { seasons, people, h2h, allGames, builtAt: Date.now() };
}

/* ---------------- lookups used by the views ---------------- */

function careerH2H(aUserId, bUserId) {
  const h = state.history;
  if (!h) return null;
  const rec = h.h2h[aUserId + '|' + bUserId];
  if (!rec) return null;
  return rec;
}

/** "Coyne4 has never beaten Ehoeff3" and friends. */
function careerH2HLine(a, b) {
  const rec = careerH2H(a.ownerId, b.ownerId);
  if (!rec || !(rec.w + rec.l + rec.t)) return 'First ever meeting';

  const total = rec.w + rec.l + rec.t;
  if (rec.l === 0) return `${a.name} leads it ${rec.w}-0 — ${b.name} has never beaten them`;
  if (rec.w === 0) return `${b.name} leads it ${rec.l}-0 — ${a.name} has never beaten them`;

  // active streak, most recent first
  const ms = rec.meetings.slice().sort((x, y) =>
    Number(y.season) - Number(x.season) || y.week - x.week);
  const lastRes = ms[0].mine > ms[0].theirs ? 'W' : ms[0].mine < ms[0].theirs ? 'L' : 'T';
  let streak = 0;
  for (const m of ms) {
    const r = m.mine > m.theirs ? 'W' : m.mine < m.theirs ? 'L' : 'T';
    if (r !== lastRes) break;
    streak++;
  }

  const lead = rec.w > rec.l ? a.name : rec.l > rec.w ? b.name : null;
  const rc = `${Math.max(rec.w, rec.l)}-${Math.min(rec.w, rec.l)}${rec.t ? '-' + rec.t : ''}`;
  const base = lead ? `${lead} leads ${rc} all-time` : `All square ${rec.w}-${rec.l}${rec.t ? '-' + rec.t : ''}`;

  if (streak >= 3 && lastRes !== 'T') {
    const hot = lastRes === 'W' ? a.name : b.name;
    return `${base} · ${hot} has won ${streak} straight`;
  }
  if (total >= 6) return `${base} in ${total} meetings`;
  return base;
}
