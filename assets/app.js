/* =========================================================
   PAC2PAC — fantasy football pyramid
   Data: Sleeper public API (read-only, no auth, CORS-open).
   Everything is fetched in the visitor's browser, so scores
   are genuinely live.
   ========================================================= */

const API = 'https://api.sleeper.app/v1';
const AVATAR = 'https://sleepercdn.com/avatars/thumbs/';
const REFRESH_MS = 60000;

const state = {
  cfg: null,
  recaps: [],
  nfl: null,
  leagues: {},          // key -> league bundle
  order: [],            // configured league keys, tier order
  active: null,
  view: 'matchups',
  players: null,
  timer: null,
};

/* ---------------- utils ---------------- */

const $ = (s, r = document) => r.querySelector(s);
const el = (t, c, h) => { const n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const num = (n, d = 2) => (n == null || isNaN(n)) ? '—' : Number(n).toFixed(d);
const pct = n => (n * 100).toFixed(0) + '%';
const norm = s => String(s || '').trim().toLowerCase();

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ' → ' + r.status);
  return r.json();
}

function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function stdev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
function zscores(vals) {
  const m = mean(vals), sd = stdev(vals) || 1;
  return vals.map(v => (v - m) / sd);
}
// Box–Muller
function gauss(mu, sigma) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}
function initials(name) {
  const words = String(name).replace(/[^\w\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '??';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function crestHTML(team, size = '') {
  const hue = hashHue(team.name);
  const style = `--c1:hsl(${hue} 42% 34%); --c2:hsl(${(hue + 28) % 360} 48% 17%)`;
  const inner = team.avatar
    ? `<img src="${AVATAR}${esc(team.avatar)}" alt="" loading="lazy" onerror="this.remove()">`
    : `<span>${esc(initials(team.name))}</span>`;
  return `<div class="crest ${size}" style="${style}">${inner}</div>`;
}

function teamHTML(team, size = '', sub) {
  return `<div class="team">${crestHTML(team, size)}
    <div class="team-txt">
      <div class="team-name">${esc(team.name)}</div>
      <div class="team-sub">${esc(sub != null ? sub : team.owner)}</div>
    </div></div>`;
}

/* ---------------- boot ---------------- */

async function boot() {
  try {
    const [cfg, recaps] = await Promise.all([
      getJSON('data/config.json'),
      getJSON('data/recaps.json').catch(() => ({ recaps: [] })),
    ]);
    state.cfg = cfg;
    state.recaps = (recaps.recaps || []).slice().sort((a, b) => (b.week - a.week));

    $('#siteName').textContent = cfg.siteName || 'League';
    $('#tagline').textContent = cfg.tagline || '';
    $('#brandCrest').textContent = cfg.brandMark || initials(cfg.siteName || 'FF');
    document.title = `${cfg.siteName} — ${Object.values(cfg.leagues).map(l => l.name).join(' & ')}`;

    state.nfl = await getJSON(`${API}/state/nfl`);
    $('#weekLabel').textContent = 'Week ' + state.nfl.display_week;
    $('#seasonLabel').textContent = state.nfl.season + ' season';

    state.order = Object.keys(cfg.leagues)
      .filter(k => cfg.leagues[k].id)
      .sort((a, b) => (cfg.leagues[a].tier || 9) - (cfg.leagues[b].tier || 9));

    if (!state.order.length) {
      $('#view-matchups').innerHTML = setupCard('No league IDs configured yet.');
      return;
    }
    state.active = state.order[0];

    renderLeagueSwitch();
    wireNav();

    await Promise.all(state.order.map(k => loadLeague(k)));
    render();

    // All-time history is a bigger pull; fetch it behind the live views and
    // re-render once it lands so head-to-head lines upgrade in place.
    loadHistory()
      .then(() => render())
      .catch(e => { console.warn('history unavailable', e); state.historyFailed = true; render(); });

    startRefresh();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopRefresh(); else { startRefresh(); refresh(); }
    });
  } catch (e) {
    $('#view-matchups').innerHTML = `<div class="err">Could not start: ${esc(e.message)}</div>`;
    console.error(e);
  }
}

function setupCard(msg) {
  return `<div class="empty"><strong>Setup needed</strong>${esc(msg)}<br><br>
    Open <code>data/config.json</code> and paste the league ID from your Sleeper URL:<br>
    <code>sleeper.com/leagues/<b>1400580506310983680</b>/team</code></div>`;
}

/* ---------------- data ---------------- */

async function loadLeague(key) {
  const conf = state.cfg.leagues[key];
  const id = conf.id;

  const [meta, users, rosters] = await Promise.all([
    getJSON(`${API}/league/${id}`),
    getJSON(`${API}/league/${id}/users`),
    getJSON(`${API}/league/${id}/rosters`),
  ]);

  const lastRegWeek = (meta.settings.playoff_week_start || 15) - 1;
  const curWeek = Math.min(Number(state.nfl.display_week) || 1, lastRegWeek + 4);

  // Pull the whole regular-season schedule (future weeks return pairings with 0 points).
  const weeks = [];
  for (let w = 1; w <= lastRegWeek; w++) weeks.push(w);
  const weekData = await Promise.all(
    weeks.map(w => getJSON(`${API}/league/${id}/matchups/${w}`).catch(() => []))
  );

  const schedule = {};
  weeks.forEach((w, i) => { schedule[w] = weekData[i] || []; });

  const userById = {};
  users.forEach(u => { userById[u.user_id] = u; });

  const teams = rosters.map(r => {
    const u = userById[r.owner_id] || {};
    const s = r.settings || {};
    return {
      key,
      rosterId: r.roster_id,
      ownerId: r.owner_id,
      owner: u.display_name || 'Unknown manager',
      name: (u.metadata && u.metadata.team_name) || u.display_name || `Roster ${r.roster_id}`,
      avatar: u.avatar || null,
      wins: s.wins || 0,
      losses: s.losses || 0,
      ties: s.ties || 0,
      pf: (s.fpts || 0) + (s.fpts_decimal || 0) / 100,
      pa: (s.fpts_against || 0) + (s.fpts_against_decimal || 0) / 100,
      scores: [],
      results: [],
      starters: r.starters || [],
    };
  });

  const byRoster = {};
  teams.forEach(t => { byRoster[t.rosterId] = t; });

  const bundle = { key, conf, meta, users, rosters, teams, byRoster, schedule, lastRegWeek, curWeek };
  computeWeekly(bundle);
  state.leagues[key] = bundle;
  return bundle;
}

/** Pair a week's matchup rows into games. */
function pairWeek(rows) {
  const groups = {};
  (rows || []).forEach(r => {
    if (r.matchup_id == null) return;
    (groups[r.matchup_id] = groups[r.matchup_id] || []).push(r);
  });
  return Object.keys(groups)
    .sort((a, b) => a - b)
    .map(id => ({ id: Number(id), a: groups[id][0], b: groups[id][1] || null }))
    .filter(g => g.b);
}

/** Walk completed weeks to build per-team score history, form, and head-to-head. */
function computeWeekly(b) {
  const h2h = {};
  b.teams.forEach(t => { t.scores = []; t.results = []; });

  for (let w = 1; w <= b.lastRegWeek; w++) {
    const games = pairWeek(b.schedule[w]);
    const settled = w < b.curWeek && games.some(g => (g.a.points || 0) > 0 || (g.b.points || 0) > 0);
    if (!settled) continue;

    games.forEach(g => {
      const ta = b.byRoster[g.a.roster_id], tb = b.byRoster[g.b.roster_id];
      if (!ta || !tb) return;
      const pa = g.a.points || 0, pb = g.b.points || 0;
      ta.scores.push(pa); tb.scores.push(pb);
      const res = pa > pb ? 'W' : pa < pb ? 'L' : 'T';
      ta.results.push({ w, opp: tb.rosterId, for: pa, against: pb, res });
      tb.results.push({ w, opp: ta.rosterId, for: pb, against: pa, res: res === 'W' ? 'L' : res === 'L' ? 'W' : 'T' });

      const k1 = `${ta.rosterId}-${tb.rosterId}`, k2 = `${tb.rosterId}-${ta.rosterId}`;
      h2h[k1] = h2h[k1] || { w: 0, l: 0, t: 0, games: [] };
      h2h[k2] = h2h[k2] || { w: 0, l: 0, t: 0, games: [] };
      if (res === 'W') { h2h[k1].w++; h2h[k2].l++; }
      else if (res === 'L') { h2h[k1].l++; h2h[k2].w++; }
      else { h2h[k1].t++; h2h[k2].t++; }
      h2h[k1].games.push({ w, for: pa, against: pb, res });
      h2h[k2].games.push({ w, for: pb, against: pa, res: res === 'W' ? 'L' : res === 'L' ? 'W' : 'T' });
    });
  }
  b.h2h = h2h;
  b.played = Math.max(0, ...b.teams.map(t => t.scores.length));
}

/** Standings, ordered by the league's tiebreakers. */
function standings(b) {
  const list = b.teams.slice();
  list.sort((x, y) => {
    if (y.wins !== x.wins) return y.wins - x.wins;
    if (y.ties !== x.ties) return y.ties - x.ties;
    return y.pf - x.pf;
  });
  list.forEach((t, i) => { t.pos = i + 1; });
  return list;
}

/* ---------------- head to head (incl. seeded history) ---------------- */

function seededH2H(a, b) {
  const seeds = (state.cfg.history && state.cfg.history.h2h) || [];
  for (const s of seeds) {
    const sa = norm(s.a), sb = norm(s.b);
    const na = [norm(a.name), norm(a.owner)], nb = [norm(b.name), norm(b.owner)];
    if (na.includes(sa) && nb.includes(sb)) return { w: s.aWins || 0, l: s.bWins || 0, t: s.ties || 0, note: s.notes };
    if (na.includes(sb) && nb.includes(sa)) return { w: s.bWins || 0, l: s.aWins || 0, t: s.ties || 0, note: s.notes };
  }
  return null;
}

function allTimeH2H(b, a, opp) {
  // Real archive wins outright once it has loaded; the config seeds are only
  // a stand-in for leagues with no Sleeper history to walk.
  const career = state.history ? careerH2H(a.ownerId, opp.ownerId) : null;
  if (career) return { w: career.w, l: career.l, t: career.t, meetings: career.meetings };

  const cur = b.h2h[`${a.rosterId}-${opp.rosterId}`] || { w: 0, l: 0, t: 0 };
  const seed = seededH2H(a, opp) || { w: 0, l: 0, t: 0 };
  return { w: cur.w + seed.w, l: cur.l + seed.l, t: cur.t + seed.t, note: seed.note, thisSeason: cur };
}

function h2hLine(b, a, opp) {
  // Prefer the real career record once the archive has loaded.
  if (state.history) return careerH2HLine(a, opp);

  const r = allTimeH2H(b, a, opp);
  const total = r.w + r.l + r.t;
  if (!total) return 'First ever meeting';
  if (r.l === 0 && r.w > 0) return `${a.name} is ${r.w}-0 all-time — ${opp.name} has never beaten them`;
  if (r.w === 0 && r.l > 0) return `${opp.name} is ${r.l}-0 all-time — ${a.name} has never beaten them`;
  const lead = r.w > r.l ? a.name : r.l > r.w ? opp.name : null;
  const rec = `${Math.max(r.w, r.l)}-${Math.min(r.w, r.l)}${r.t ? '-' + r.t : ''}`;
  return lead ? `${lead} leads the series ${rec}` : `All square at ${r.w}-${r.l}${r.t ? '-' + r.t : ''}`;
}

/* ---------------- rivalries ---------------- */

function rivalryList() {
  return (state.cfg.rivalries || []).filter(r => r.teams && r.teams.length === 2 && r.teams[0] && r.teams[1]);
}

/** Rivalries don't need a name in config — fall back to "A vs B". */
function rivalryLabel(r, ta, tb) {
  return r.name || `${ta.name} vs ${tb.name}`;
}

/** Find a manager in any league by display name or team name. */
function findManager(ident) {
  const q = norm(ident);
  for (const k of state.order) {
    const b = state.leagues[k];
    if (!b) continue;
    const t = b.teams.find(x => norm(x.name) === q || norm(x.owner) === q);
    if (t) return { team: t, leagueKey: k, bundle: b };
  }
  return null;
}

function rivalryFor(b, ta, tb) {
  const rivals = rivalryList();
  for (const r of rivals) {
    const ids = r.teams.map(norm);
    const na = [norm(ta.name), norm(ta.owner)], nb = [norm(tb.name), norm(tb.owner)];
    const hitA = ids.some(i => na.includes(i)), hitB = ids.some(i => nb.includes(i));
    if (hitA && hitB && ids[0] !== ids[1]) return r;
  }
  return null;
}

/* ---------------- power rankings ---------------- */

function powerRankings(b) {
  const ts = b.teams.filter(t => t.scores.length);
  if (!ts.length) return [];
  const avg = ts.map(t => mean(t.scores));
  const last3 = ts.map(t => mean(t.scores.slice(-3)));
  const wp = ts.map(t => (t.wins + t.ties * 0.5) / Math.max(1, t.wins + t.losses + t.ties));
  const sd = ts.map(t => stdev(t.scores));

  const zAvg = zscores(avg), zL3 = zscores(last3), zWp = zscores(wp), zSd = zscores(sd);

  const rated = ts.map((t, i) => ({
    team: t,
    avg: avg[i], last3: last3[i], winPct: wp[i], sd: sd[i],
    rating: 0.40 * zAvg[i] + 0.30 * zWp[i] + 0.20 * zL3[i] - 0.10 * zSd[i],
  }));
  rated.sort((a, z) => z.rating - a.rating);

  const rs = rated.map(r => r.rating);
  const lo = Math.min(...rs), hi = Math.max(...rs), span = (hi - lo) || 1;
  rated.forEach((r, i) => {
    r.index = 50 + 50 * ((r.rating - lo) / span) * 0.98;
    r.rank = i + 1;
    const posDelta = r.team.pos - r.rank;
    r.delta = posDelta;
  });
  return rated;
}

/* ---------------- Monte Carlo ---------------- */

const SIMS = 6000;
const SHRINK = 4;          // prior weight, in games

/**
 * Expected weekly score for this league, used as the prior a team's own
 * average is pulled toward early on. Derived from real scores as soon as
 * there are any; before that, estimated from the starting lineup, because
 * a 12-starter superflex league scores far more than a 10-starter one.
 */
function leaguePrior(b) {
  const all = [];
  b.teams.forEach(t => { all.push(...t.scores); });
  if (all.length >= b.teams.length) return mean(all);

  const pos = b.meta.roster_positions || [];
  const starters = pos.filter(p => !['BN', 'IR', 'TAXI'].includes(p)).length || 10;
  const superflex = pos.includes('SUPER_FLEX');
  return 11 * starters + (superflex ? 8 : 0);
}

function simulate(b) {
  const teams = b.teams;
  const n = teams.length;
  if (!n) return null;

  const playoffSpots = b.conf.playoffTeams || b.meta.settings.playoff_teams || 6;
  const relCount = b.conf.relegationCount || 0;
  const proCount = b.conf.promotionCount || 0;
  const dropTeams = b.conf.dropBracketTeams || 0;      // consolation bracket size
  const dropSurvivors = b.conf.dropSurvivors || 0;     // how many of those stay up

  const idx = {};
  teams.forEach((t, i) => { idx[t.rosterId] = i; });

  const prior = leaguePrior(b);
  const played = teams.map(t => t.scores.length);
  const mu = teams.map((t, i) => {
    const m = t.scores.length ? mean(t.scores) : prior;
    return (played[i] * m + SHRINK * prior) / (played[i] + SHRINK);
  });
  // Spread scales with the league's scoring level rather than a fixed constant.
  const sigma = teams.map(t => Math.max(
    t.scores.length > 2 ? stdev(t.scores) : prior * 0.22,
    prior * 0.17));

  // Remaining regular-season fixtures
  const fixtures = [];
  for (let w = b.curWeek; w <= b.lastRegWeek; w++) {
    pairWeek(b.schedule[w]).forEach(g => {
      const a = idx[g.a.roster_id], z = idx[g.b.roster_id];
      if (a != null && z != null) fixtures.push([a, z]);
    });
  }

  const cnt = {
    playoff: new Array(n).fill(0),
    releg: new Array(n).fill(0),
    promo: new Array(n).fill(0),
    title: new Array(n).fill(0),
    seed1: new Array(n).fill(0),
    survive: new Array(n).fill(0),   // won the consolation bracket from the drop zone
    final: new Array(n).fill(0),     // reached the championship game
  };

  const baseW = teams.map(t => t.wins + t.ties * 0.5);
  const basePF = teams.map(t => t.pf);

  for (let s = 0; s < SIMS; s++) {
    const w = baseW.slice(), pf = basePF.slice();

    for (const [a, z] of fixtures) {
      const sa = gauss(mu[a], sigma[a]), sz = gauss(mu[z], sigma[z]);
      pf[a] += sa; pf[z] += sz;
      if (sa > sz) w[a] += 1; else if (sz > sa) w[z] += 1; else { w[a] += .5; w[z] += .5; }
    }

    const order = [...Array(n).keys()].sort((x, y) => (w[y] - w[x]) || (pf[y] - pf[x]));

    for (let p = 0; p < n; p++) {
      const t = order[p];
      if (p < playoffSpots) cnt.playoff[t]++;
      if (p === 0) cnt.seed1[t]++;
    }

    // Championship bracket
    const seeds = order.slice(0, playoffSpots);
    const po = simPlayoffs(seeds, mu, sigma);
    if (po.champ != null) { cnt.title[po.champ]++; cnt.final[po.champ]++; }
    if (po.runnerUp != null) cnt.final[po.runnerUp]++;

    // Promotion is won in the bracket: champion, runner-up, third-place game winner.
    if (proCount) {
      [po.champ, po.runnerUp, po.third]
        .filter(x => x != null).slice(0, proCount)
        .forEach(t => cnt.promo[t]++);
    }

    // Relegation is survived in the consolation bracket, not avoided in the table.
    if (dropTeams) {
      const dropSeeds = order.slice(playoffSpots, playoffSpots + dropTeams);
      const survivor = dropSurvivors ? simSingleElim(dropSeeds, mu, sigma) : null;
      dropSeeds.forEach(t => {
        if (t === survivor) cnt.survive[t]++;
        else cnt.releg[t]++;
      });
    } else if (relCount) {
      for (let p = n - relCount; p < n; p++) cnt.releg[order[p]]++;
    }
  }

  const out = teams.map((t, i) => ({
    team: t,
    playoff: cnt.playoff[i] / SIMS,
    releg: cnt.releg[i] / SIMS,
    promo: cnt.promo[i] / SIMS,
    title: cnt.title[i] / SIMS,
    seed1: cnt.seed1[i] / SIMS,
    survive: cnt.survive[i] / SIMS,
    final: cnt.final[i] / SIMS,
  }));
  return out;
}

function game(a, z, mu, sigma) {
  return gauss(mu[a], sigma[a]) >= gauss(mu[z], sigma[z]) ? a : z;
}

/** Seeded single elimination; returns the last team standing. */
function simSingleElim(seeds, mu, sigma) {
  let alive = seeds.slice();
  while (alive.length > 1) {
    const next = [];
    const pairs = Math.floor(alive.length / 2);
    for (let i = 0; i < pairs; i++) next.push(game(alive[i], alive[alive.length - 1 - i], mu, sigma));
    if (alive.length % 2) next.splice(0, 0, alive[pairs]);   // odd bracket: top seed gets the bye
    alive = next;
  }
  return alive[0];
}

/**
 * Championship bracket. Returns the champion, the runner-up and the winner of
 * the third-place game — all three matter, because the G.R.I.T. League promotes
 * exactly those teams.
 */
function simPlayoffs(seeds, mu, sigma) {
  const s = seeds.slice();
  if (!s.length) return { champ: null, runnerUp: null, third: null };
  if (s.length === 1) return { champ: s[0], runnerUp: null, third: null };
  if (s.length === 2) {
    const w = game(s[0], s[1], mu, sigma);
    return { champ: w, runnerUp: w === s[0] ? s[1] : s[0], third: null };
  }

  let semis;   // [[winner, loser], [winner, loser]]
  if (s.length <= 4) {
    const w1 = game(s[0], s[3], mu, sigma);
    const w2 = game(s[1], s[2], mu, sigma);
    semis = [[w1, w1 === s[0] ? s[3] : s[0]], [w2, w2 === s[1] ? s[2] : s[1]]];
  } else {
    // 6-team: byes for the top two, 3v6 and 4v5 in the first round
    const r1a = game(s[2], s[5], mu, sigma);
    const r1b = game(s[3], s[4], mu, sigma);
    const rank = i => s.indexOf(i);
    const low = rank(r1a) > rank(r1b) ? r1a : r1b;    // worst surviving seed faces the 1
    const high = low === r1a ? r1b : r1a;
    const sw1 = game(s[0], low, mu, sigma);
    const sw2 = game(s[1], high, mu, sigma);
    semis = [[sw1, sw1 === s[0] ? low : s[0]], [sw2, sw2 === s[1] ? high : s[1]]];
  }

  const champ = game(semis[0][0], semis[1][0], mu, sigma);
  const runnerUp = champ === semis[0][0] ? semis[1][0] : semis[0][0];
  const third = game(semis[0][1], semis[1][1], mu, sigma);
  return { champ, runnerUp, third };
}

/* ---------------- nav / shell ---------------- */

function wireNav() {
  $('#navBar').addEventListener('click', e => {
    const btn = e.target.closest('button[data-view]');
    if (!btn) return;
    state.view = btn.dataset.view;
    [...$('#navBar').children].forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + state.view));
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

function renderLeagueSwitch() {
  const box = $('#leagueSwitch');
  box.innerHTML = '';
  state.order.forEach(k => {
    const b = el('button', k === state.active ? 'active' : '', esc(state.cfg.leagues[k].name));
    b.onclick = () => {
      state.active = k;
      renderLeagueSwitch();
      render();
    };
    box.appendChild(b);
  });
  const missing = Object.keys(state.cfg.leagues).filter(k => !state.cfg.leagues[k].id);
  if (missing.length) {
    const b = el('button', '', esc(state.cfg.leagues[missing[0]].name) + ' — not linked');
    b.style.opacity = '.5';
    b.onclick = () => alert('Add this league\'s Sleeper ID to data/config.json to switch it on.');
    box.appendChild(b);
  }
}

const GLOBAL_VIEWS = new Set(['recaps', 'money', 'records', 'watch']);

function render() {
  const v = state.view;
  const host = $('#view-' + v);
  $('#leagueSwitch').style.display = GLOBAL_VIEWS.has(v) ? 'none' : '';
  if (!host) return;
  try {
    ({
      matchups: viewMatchups, tables: viewTables, watch: viewWatch,
      odds: viewOdds, power: viewPower, rivalries: viewRivalries,
      records: viewRecords, money: viewMoney, recaps: viewRecaps,
    })[v](host);
  } catch (e) {
    host.innerHTML = `<div class="err">${esc(e.message)}</div>`;
    console.error(e);
  }
  $('#lastUpdated').textContent = 'updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/* ---------------- views ---------------- */

function viewMatchups(host) {
  host.innerHTML = '';
  const b = state.leagues[state.active];
  if (!b) { host.innerHTML = setupCard('This league is not linked yet.'); return; }

  const week = Math.min(b.curWeek, b.lastRegWeek);
  const games = pairWeek(b.schedule[week]);
  const st = standings(b);
  const relZone = new Set(st.slice(-(b.conf.relegationCount || 0)).map(t => t.rosterId));
  const proZone = new Set(st.slice(0, b.conf.promotionCount || 0).map(t => t.rosterId));

  let anyLive = false;
  games.forEach(g => { if ((g.a.points || 0) > 0 || (g.b.points || 0) > 0) anyLive = true; });
  setLive(anyLive && week === b.curWeek);

  const head = el('div', 'section-head');
  head.innerHTML = `<h2>Week ${week} — ${esc(b.conf.name)}</h2>
    <div class="sub">${anyLive ? 'Live scoring · refreshes every minute' : 'Kickoff pending'}</div>`;
  host.appendChild(head);

  if (!games.length) {
    host.appendChild(el('div', 'empty', '<strong>No fixtures</strong>Sleeper has not published this week yet.'));
    return;
  }

  const grid = el('div', 'matchups');
  games.forEach(g => {
    const ta = b.byRoster[g.a.roster_id], tb = b.byRoster[g.b.roster_id];
    if (!ta || !tb) return;
    const pa = g.a.points || 0, pb = g.b.points || 0;
    const live = pa > 0 || pb > 0;

    const riv = rivalryFor(b, ta, tb);
    const sixPointer = relZone.has(ta.rosterId) && relZone.has(tb.rosterId);
    const promoClash = proZone.has(ta.rosterId) && proZone.has(tb.rosterId);

    const card = el('div', 'mu' + (riv ? ' is-rivalry' : ''));

    if (riv) {
      card.appendChild(el('div', 'mu-flag', `⚔ ${esc(rivalryLabel(riv, ta, tb))}`));
    } else if (sixPointer) {
      card.appendChild(el('div', 'mu-flag six-pointer', '▼ Relegation six-pointer'));
    } else if (promoClash) {
      card.appendChild(el('div', 'mu-flag', '▲ Promotion clash'));
    }

    const body = el('div', 'mu-body');
    [[ta, pa, pb], [tb, pb, pa]].forEach(([t, mine, theirs]) => {
      const cls = !live ? '' : mine > theirs ? ' win' : mine < theirs ? ' lose' : '';
      const row = el('div', 'mu-row' + cls);
      row.innerHTML = `${teamHTML(t, '', `${t.wins}-${t.losses}${t.ties ? '-' + t.ties : ''}`)}
        <div class="score">${live ? num(mine, 2) : '—'}</div>`;
      body.appendChild(row);
    });

    const foot = el('div', 'mu-foot');
    const margin = Math.abs(pa - pb);
    foot.innerHTML = `<span class="h2h">${esc(h2hLine(b, ta, tb))}</span>
      <span>${live ? (margin < 10 ? `<span class="chip gold">${num(margin, 1)} pt game</span>` : num(margin, 1) + ' apart') : ''}</span>`;
    body.appendChild(foot);

    if (riv && riv.blurb) {
      const bl = el('div', '');
      bl.style.cssText = 'font-size:12px;color:var(--muted);margin-top:8px;line-height:1.5;font-style:italic';
      bl.textContent = riv.blurb;
      body.appendChild(bl);
    }

    card.appendChild(body);
    grid.appendChild(card);
  });
  host.appendChild(grid);
}

function setLive(on) {
  const d = $('#liveDot');
  d.classList.toggle('is-idle', !on);
  d.querySelector('span').textContent = on ? 'Live' : 'Idle';
}

function viewTables(host) {
  host.innerHTML = '';
  const b = state.leagues[state.active];
  if (!b) { host.innerHTML = setupCard('This league is not linked yet.'); return; }

  const st = standings(b);
  const n = st.length;
  const playoffs = b.conf.playoffTeams || b.meta.settings.playoff_teams || 6;
  const rel = b.conf.relegationCount || 0;
  const pro = b.conf.promotionCount || 0;
  const dropTeams = b.conf.dropBracketTeams || 0;

  const head = el('div', 'section-head');
  head.innerHTML = `<h2>${esc(b.conf.name)} table</h2><div class="sub">After ${b.played} week${b.played === 1 ? '' : 's'}</div>`;
  host.appendChild(head);

  const card = el('div', 'card');
  const wrap = el('div', 'table-wrap');
  const t = el('table', 'lg');
  t.innerHTML = `<thead><tr>
      <th class="l">#</th><th class="l">Club</th>
      <th>W</th><th>L</th><th>T</th><th>PF</th><th>PA</th><th>Diff</th><th class="l">Form</th>
    </tr></thead><tbody></tbody>`;
  const tb = t.querySelector('tbody');

  st.forEach((team, i) => {
    const pos = i + 1;
    // The cut that matters is the playoff line: above it you are safe (Premier)
    // or still alive for promotion (G.R.I.T.); below it you are in the drop bracket.
    let zone = '';
    if (pos <= playoffs) zone = pro ? 'zone-promo' : 'zone-playoff';
    else if (dropTeams) zone = 'zone-releg';

    const divider = pos === playoffs + 1
      ? (dropTeams ? 'divider-releg' : (pro ? 'divider-promo' : 'divider-playoff'))
      : '';

    const form = team.results.slice(-5).map(r => `<b class="${r.res}">${r.res}</b>`).join('');
    const diff = team.pf - team.pa;
    const tr = el('tr', `${zone} ${divider}`.trim());
    tr.innerHTML = `
      <td class="pos">${pos}</td>
      <td class="l">${teamHTML(team, 'sm')}</td>
      <td>${team.wins}</td><td>${team.losses}</td><td>${team.ties}</td>
      <td>${num(team.pf, 1)}</td><td>${num(team.pa, 1)}</td>
      <td style="color:${diff >= 0 ? 'var(--promo)' : 'var(--releg)'}">${diff >= 0 ? '+' : ''}${num(diff, 1)}</td>
      <td class="l"><span class="form">${form || '<span style="color:var(--muted-dim)">—</span>'}</span></td>`;
    tb.appendChild(tr);
  });

  wrap.appendChild(t);
  card.appendChild(wrap);
  host.appendChild(card);

  const leg = el('div', 'legend');
  const bits = [];
  if (pro) {
    bits.push(`<span><i style="background:var(--promo)"></i>Playoffs — alive for promotion (top ${playoffs})</span>`);
    bits.push(`<span><i style="background:var(--muted-dim)"></i>Out of the promotion race</span>`);
  } else {
    bits.push(`<span><i style="background:var(--gold)"></i>Playoffs — safe (top ${playoffs})</span>`);
  }
  if (dropTeams) bits.push(`<span><i style="background:var(--releg)"></i>Consolation bracket — ${dropTeams} in, ${rel} go down</span>`);
  leg.innerHTML = bits.join('');
  host.appendChild(leg);

  if (state.cfg.rules && state.cfg.rules.summary) {
    const n2 = el('div', '');
    n2.style.cssText = 'margin-top:16px;font-size:13px;color:var(--muted);line-height:1.6';
    n2.textContent = state.cfg.rules.summary;
    host.appendChild(n2);
  }
}

function viewWatch(host) {
  host.innerHTML = '';
  const head = el('div', 'section-head');
  head.innerHTML = `<h2>Promotion &amp; relegation watch</h2><div class="sub">The ladder between the two leagues</div>`;
  host.appendChild(head);

  const grid = el('div', 'watch-grid');

  state.order.forEach(k => {
    const b = state.leagues[k];
    if (!b) return;
    const st = standings(b);
    const n = st.length;
    const rel = b.conf.relegationCount || 0;
    const pro = b.conf.promotionCount || 0;

    const pfs = st.map(t => t.pf);
    const loPF = Math.min(...pfs), hiPF = Math.max(...pfs);
    const meterPct = t => 6 + 94 * ((t.pf - loPF) / Math.max(1, hiPF - loPF));

    const watchRow = (team, pos, tone, gap, barColor) =>
      `<div style="font-family:var(--display);font-size:17px;font-weight:700;color:var(--muted);width:22px">${pos}</div>
       <div>${teamHTML(team, 'sm', `${team.wins}-${team.losses}${team.ties ? '-' + team.ties : ''} · ${num(team.pf, 1)} PF`)}
         <div class="meter"><i style="width:${meterPct(team).toFixed(1)}%;background:${barColor}"></i></div>
       </div>
       <div class="gap">${gap.main}<small>${gap.sub}</small></div>`;

    // The line that decides both ladders is the playoff cut, not the foot of the table.
    const playoffs = b.conf.playoffTeams || b.meta.settings.playoff_teams || 6;
    const dropTeams = b.conf.dropBracketTeams || 0;
    const lastIn = st[playoffs - 1];
    const firstOut = st[playoffs];

    if (dropTeams) {
      const col = el('div', 'card watch-col releg');
      col.innerHTML = `<h3>▼ The drop</h3>
        <div class="note">Miss the top ${playoffs} and you fall into the ${dropTeams}-team consolation bracket,
        where only the winner stays up — the other ${rel} go down to ${esc(nextTierName(k))}.
        The safety line is ${esc(lastIn ? lastIn.name : '—')} in ${playoffs}${ord(playoffs)}.</div>`;
      const shown = st.slice(Math.max(0, playoffs - 2));
      shown.forEach((team, i) => {
        const pos = playoffs - Math.min(playoffs, 2) + i + 1;
        const inZone = pos > playoffs;
        const gap = inZone ? margin(team, lastIn, 'of safety')
                           : cushion(team, firstOut, 'of cushion');
        const row = el('div', 'watch-row ' + (inZone ? 'peril' : 'safe'));
        row.innerHTML = watchRow(team, pos, inZone, gap, inZone ? 'var(--releg)' : 'var(--promo)');
        col.appendChild(row);
      });
      const foot = el('div', '');
      foot.style.cssText = 'margin-top:14px;padding-top:12px;border-top:1px solid var(--line-soft);font-size:12px;color:var(--muted-dim);line-height:1.6';
      foot.textContent = 'Nobody in the bottom four is doomed yet — one of them survives by winning the consolation bracket.';
      col.appendChild(foot);
      grid.appendChild(col);
    }

    if (pro) {
      const col = el('div', 'card watch-col promo');
      col.innerHTML = `<h3>▲ Going up</h3>
        <div class="note">Top ${playoffs} of ${esc(b.conf.name)} reach the playoffs. Promotion to
        ${esc(prevTierName(k))} goes to the two finalists and the winner of the third-place game —
        ${pro} spots, decided in the bracket.</div>`;
      st.forEach((team, i) => {
        const pos = i + 1;
        const alive = pos <= playoffs;
        const gap = alive ? cushion(team, firstOut, 'of cushion')
                          : margin(team, lastIn, 'of the playoffs');
        const row = el('div', 'watch-row ' + (alive ? 'safe' : 'peril'));
        row.innerHTML = watchRow(team, pos, alive, gap, alive ? 'var(--promo)' : 'var(--muted-dim)');
        col.appendChild(row);
      });
      const foot = el('div', '');
      foot.style.cssText = 'margin-top:14px;padding-top:12px;border-top:1px solid var(--line-soft);font-size:12px;color:var(--muted-dim);line-height:1.6';
      foot.textContent = `Making the playoffs only buys a ticket — ${pro} of these ${playoffs} go up, and the semi-finals decide which.`;
      col.appendChild(foot);
      grid.appendChild(col);
    }
  });

  host.appendChild(grid);

  if (state.order.length < 2) {
    host.appendChild(el('div', 'empty', '<strong>One league linked</strong>Add the second league ID to <code>data/config.json</code> to see both sides of the ladder.'));
  }
}

/** How far a team is BEHIND the team holding the line. */
function margin(team, line, label) {
  if (!line) return { main: '—', sub: label };
  const dw = line.wins - team.wins;
  if (dw > 0) return { main: dw + (dw === 1 ? ' win' : ' wins'), sub: 'off ' + label.replace(/^of /, '') };
  const dp = line.pf - team.pf;
  if (dp <= 0.05) return { main: 'Level', sub: 'dead even' };
  return { main: num(dp, 1) + ' pts', sub: 'on the tiebreak' };
}

/** How much room a team has ABOVE the first team outside the line. */
function cushion(team, chaser, label) {
  if (!chaser) return { main: 'Clear', sub: label };
  const dw = team.wins - chaser.wins;
  if (dw > 0) return { main: '+' + dw + (dw === 1 ? ' win' : ' wins'), sub: label.replace(/^of /, '') };
  const dp = team.pf - chaser.pf;
  if (dp <= 0.05) return { main: 'Level', sub: 'one loss from trouble' };
  return { main: '+' + num(dp, 1) + ' pts', sub: 'on the tiebreak' };
}

function nextTierName(k) {
  const tier = state.cfg.leagues[k].tier;
  const down = Object.keys(state.cfg.leagues).find(x => state.cfg.leagues[x].tier === tier + 1);
  return down ? state.cfg.leagues[down].name : 'the lower league';
}
function prevTierName(k) {
  const tier = state.cfg.leagues[k].tier;
  const up = Object.keys(state.cfg.leagues).find(x => state.cfg.leagues[x].tier === tier - 1);
  return up ? state.cfg.leagues[up].name : 'the top league';
}
function ord(n) { return ['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th'; }

function viewOdds(host) {
  host.innerHTML = '';
  const b = state.leagues[state.active];
  if (!b) { host.innerHTML = setupCard('This league is not linked yet.'); return; }

  const head = el('div', 'section-head');
  head.innerHTML = `<h2>${esc(b.conf.name)} odds</h2>
    <div class="sub">${SIMS.toLocaleString()} simulated seasons · recalculated in your browser</div>`;
  host.appendChild(head);

  const sim = simulate(b);
  if (!sim) { host.appendChild(el('div', 'empty', 'No data yet.')); return; }

  const rel = b.conf.relegationCount || 0;
  const pro = b.conf.promotionCount || 0;
  const dropTeams = b.conf.dropBracketTeams || 0;
  sim.sort((a, z) => (z.promo - a.promo) || (a.releg - z.releg) || z.playoff - a.playoff || z.title - a.title);

  const card = el('div', 'card');
  const wrap = el('div', 'table-wrap');
  const t = el('table', 'lg');
  t.innerHTML = `<thead><tr>
      <th class="l">Club</th><th class="l">Playoffs</th><th class="l">Title</th>
      ${pro ? '<th class="l">Promotion</th>' : ''}
      ${dropTeams ? '<th class="l">Relegation</th>' : ''}
    </tr></thead><tbody></tbody>`;
  const tb = t.querySelector('tbody');

  sim.forEach(r => {
    const bar = (v, color) => `<div class="odds-bar"><i style="width:${Math.max(2, v * 100)}%;background:${color};opacity:${0.25 + v * 0.75}"></i><span>${v < 0.005 && v > 0 ? '<1%' : pct(v)}</span></div>`;
    const tr = el('tr', dropTeams && r.releg > 0.35 ? 'zone-releg' : (pro && r.promo > 0.5 ? 'zone-promo' : ''));
    tr.innerHTML = `<td class="l">${teamHTML(r.team, 'sm')}</td>
      <td class="l">${bar(r.playoff, 'var(--gold)')}</td>
      <td class="l">${bar(r.title, 'var(--gold-bright)')}</td>
      ${pro ? `<td class="l">${bar(r.promo, 'var(--promo)')}</td>` : ''}
      ${dropTeams ? `<td class="l">${bar(r.releg, 'var(--releg)')}</td>` : ''}`;
    tb.appendChild(tr);
  });

  wrap.appendChild(t); card.appendChild(wrap); host.appendChild(card);

  const note = el('div', '');
  note.style.cssText = 'margin-top:16px;font-size:12px;color:var(--muted-dim);line-height:1.7;max-width:70ch';
  note.innerHTML = `Each club's weekly scoring is modelled from its own results so far, pulled toward this league's
    scoring level early on when there is not much to go on. The real remaining fixture list is used.
    ${dropTeams
      ? `Relegation is not read off the table — every simulated season plays out the ${dropTeams}-team consolation
         bracket, and only the team that loses it three times over shows a high number here.`
      : ''}
    ${pro
      ? `Promotion runs through the bracket too: the two finalists and the third-place-game winner go up, so
         a high seed with a soft draw can rate above a team with a better record.`
      : ''}
    Early in the year these numbers sit close to a coin flip — that is honest, not broken.`;
  host.appendChild(note);
}

function viewPower(host) {
  host.innerHTML = '';
  const b = state.leagues[state.active];
  if (!b) { host.innerHTML = setupCard('This league is not linked yet.'); return; }

  const head = el('div', 'section-head');
  head.innerHTML = `<h2>${esc(b.conf.name)} power rankings</h2><div class="sub">Scoring, form and consistency — not just record</div>`;
  host.appendChild(head);

  standings(b);            // sets .pos so "vs Table" is meaningful
  const pr = powerRankings(b);
  if (!pr.length) {
    host.appendChild(el('div', 'empty', '<strong>Nothing to rank yet</strong>Power rankings appear once Week 1 is in the books.'));
    return;
  }

  const card = el('div', 'card');
  const wrap = el('div', 'table-wrap');
  const t = el('table', 'lg');
  t.innerHTML = `<thead><tr>
      <th class="l">#</th><th class="l">Club</th><th>Index</th><th>Avg PF</th><th>Last 3</th><th>Win %</th><th>Swing</th><th>vs Table</th>
    </tr></thead><tbody></tbody>`;
  const tb = t.querySelector('tbody');

  pr.forEach(r => {
    const d = r.delta;
    const dTxt = d === 0 ? '—' : (d > 0 ? `▲ ${d}` : `▼ ${-d}`);
    const dCol = d === 0 ? 'var(--muted-dim)' : d > 0 ? 'var(--promo)' : 'var(--releg)';
    const tr = el('tr');
    tr.innerHTML = `<td class="pos">${r.rank}</td>
      <td class="l">${teamHTML(r.team, 'sm')}</td>
      <td style="font-family:var(--display);font-size:18px;font-weight:700;color:var(--gold-bright)">${num(r.index, 1)}</td>
      <td>${num(r.avg, 1)}</td><td>${num(r.last3, 1)}</td><td>${pct(r.winPct)}</td>
      <td>±${num(r.sd, 1)}</td>
      <td style="color:${dCol}">${dTxt}</td>`;
    tb.appendChild(tr);
  });
  wrap.appendChild(t); card.appendChild(wrap); host.appendChild(card);

  const note = el('div', '');
  note.style.cssText = 'margin-top:16px;font-size:12px;color:var(--muted-dim);line-height:1.7;max-width:70ch';
  note.textContent = 'Index blends average points (40%), win rate (30%) and last-three-week form (20%), '
    + 'with a small penalty for wild week-to-week swings (10%). “vs Table” shows how far the rankings disagree with the standings — '
    + 'a big ▲ means a team is better than its record.';
  host.appendChild(note);
}

function viewRivalries(host) {
  host.innerHTML = '';
  const head = el('div', 'section-head');
  head.innerHTML = `<h2>Rivalries &amp; head-to-head</h2><div class="sub">Grudges, streaks and unfinished business</div>`;
  host.appendChild(head);

  const rivals = rivalryList();

  if (rivals.length) {
    const grid = el('div', 'matchups');
    rivals.forEach(r => {
      const A = findManager(r.teams[0]);
      const B = findManager(r.teams[1]);
      const card = el('div', 'mu is-rivalry');
      const body = el('div', 'mu-body');

      if (A && B) {
        const crossLeague = A.leagueKey !== B.leagueKey;
        const rec = allTimeH2H(A.bundle, A.team, B.team);
        card.appendChild(el('div', 'mu-flag', `⚔ ${esc(rivalryLabel(r, A.team, B.team))}`));

        body.innerHTML = `
          <div class="mu-row">${teamHTML(A.team, '', `${esc(A.team.owner)} · ${esc(state.cfg.leagues[A.leagueKey].short || state.cfg.leagues[A.leagueKey].name)}`)}<div class="score">${rec.w}</div></div>
          <div class="mu-row">${teamHTML(B.team, '', `${esc(B.team.owner)} · ${esc(state.cfg.leagues[B.leagueKey].short || state.cfg.leagues[B.leagueKey].name)}`)}<div class="score">${rec.l}</div></div>
          <div class="mu-foot"><span class="h2h">${esc(h2hLine(A.bundle, A.team, B.team))}</span>
          <span>${rec.t ? rec.t + ' tied' : ''}</span></div>`;

        if (crossLeague) {
          const x = el('div', '');
          x.style.cssText = 'margin-top:10px';
          x.innerHTML = `<span class="chip red">Split by the ladder</span>
            <div style="font-size:12px;color:var(--muted-dim);margin-top:7px;line-height:1.55">
              They are in different leagues this season, so they cannot meet.
              Someone has to go up or come down first.</div>`;
          body.appendChild(x);
        }
      } else {
        const missing = [!A ? r.teams[0] : null, !B ? r.teams[1] : null].filter(Boolean);
        card.appendChild(el('div', 'mu-flag', `⚔ ${esc(r.name || r.teams.join(' vs '))}`));
        body.innerHTML = `<div style="color:var(--muted);font-size:13px">
          No Sleeper match for <strong>${esc(missing.join('</strong>, <strong>'))}</strong> —
          check the spelling in <code>config.json</code> against the display name in Sleeper.</div>`;
      }

      if (r.blurb) {
        const bl = el('div', '');
        bl.style.cssText = 'font-size:13px;color:var(--muted);margin-top:10px;line-height:1.6;font-style:italic';
        bl.textContent = r.blurb;
        body.appendChild(bl);
      }
      card.appendChild(body);
      grid.appendChild(card);
    });
    host.appendChild(grid);
  } else {
    host.appendChild(el('div', 'empty', '<strong>No rivalries yet</strong>Add them to the <code>rivalries</code> list in <code>data/config.json</code> and they will show up here and on the matchup cards.'));
  }

  // full H2H grid for the active league
  const b = state.leagues[state.active];
  if (b && b.played) {
    const h = el('div', 'section-head');
    h.innerHTML = `<h2>${esc(b.conf.name)} head-to-head</h2><div class="sub">All meetings on record</div>`;
    host.appendChild(h);

    const st = standings(b);
    const card = el('div', 'card');
    const wrap = el('div', 'table-wrap');
    const t = el('table', 'lg');
    t.innerHTML = `<thead><tr><th class="l">Club</th>${st.map(x => `<th title="${esc(x.name)}">${esc(initials(x.name))}</th>`).join('')}</tr></thead><tbody></tbody>`;
    const tb = t.querySelector('tbody');
    st.forEach(a => {
      const tr = el('tr');
      tr.innerHTML = `<td class="l">${teamHTML(a, 'sm')}</td>` + st.map(z => {
        if (a === z) return `<td style="color:var(--muted-dim)">—</td>`;
        const r = allTimeH2H(b, a, z);
        const tot = r.w + r.l + r.t;
        if (!tot) return `<td style="color:var(--muted-dim)">·</td>`;
        const col = r.w > r.l ? 'var(--promo)' : r.l > r.w ? 'var(--releg)' : 'var(--muted)';
        return `<td style="color:${col};font-size:12px">${r.w}-${r.l}${r.t ? '-' + r.t : ''}</td>`;
      }).join('');
      tb.appendChild(tr);
    });
    wrap.appendChild(t); card.appendChild(wrap); host.appendChild(card);
  }
}

/** Career rows lead with the manager — team names change every year. */
function personTeam(p) {
  return { name: p.display, owner: p.team || '', avatar: p.avatar };
}

/** The team name a manager actually used in a given season. */
function teamNameIn(userId, season) {
  const h = state.history;
  if (!h) return '';
  for (const s of h.seasons) {
    if (String(s.season) !== String(season)) continue;
    const t = s.teams.find(x => x.userId === userId);
    if (t) return t.team;
  }
  return (h.people[userId] || {}).team || '';
}

/** teamHTML input for a manager as they were in one particular season. */
function personTeamIn(p, season) {
  return { name: teamNameIn(p.userId, season) || p.display, owner: p.display, avatar: p.avatar };
}

function viewRecords(host) {
  host.innerHTML = '';
  const h = state.history;

  const seasonsSpan = h && h.seasons.length
    ? `${h.seasons[0].season}–${h.seasons[h.seasons.length - 1].season}`
    : state.cfg.season;

  const head = el('div', 'section-head');
  head.innerHTML = `<h2>The record book</h2><div class="sub">${esc(seasonsSpan)}</div>`;
  host.appendChild(head);

  if (!h) {
    host.appendChild(el('div', 'empty', state.historyFailed
      ? '<strong>Archive unavailable</strong>Could not reach the historical leagues just now. Reload to try again.'
      : '<strong>Reading the archives…</strong>Pulling every season from Sleeper. This takes a few seconds the first time.'));
    return;
  }

  const people = Object.values(h.people);

  /* ---- Honour roll ---- */
  const titled = people.filter(p => p.titles.length)
    .sort((a, b) => b.titles.length - a.titles.length || b.winPct - a.winPct);

  if (titled.length) {
    const hr = el('div', 'section-head');
    hr.innerHTML = `<h2>Honour roll</h2><div class="sub">Champions of the PAC2PAC</div>`;
    host.appendChild(hr);

    const grid = el('div', 'matchups');
    titled.forEach(p => {
      const card = el('div', 'mu is-rivalry');
      card.appendChild(el('div', 'mu-flag',
        `${'★'.repeat(Math.min(p.titles.length, 5))} ${p.titles.length === 1 ? 'Champion' : p.titles.length + '× champion'}`));
      const body = el('div', 'mu-body');
      body.innerHTML = `
        <div class="mu-row">${teamHTML(personTeam(p), 'lg', p.display)}
          <div class="score">${p.titles.length}<small>${p.titles.length === 1 ? 'TITLE' : 'TITLES'}</small></div></div>
        <div class="mu-foot">
          <span class="h2h">${p.titles.map(t => t.season).join(' · ')}</span>
          <span>${p.finals.length ? p.finals.length + ' other final' + (p.finals.length > 1 ? 's' : '') : ''}</span>
        </div>`;
      card.appendChild(body);
      grid.appendChild(card);
    });
    host.appendChild(grid);
  }

  /* ---- Season by season ---- */
  const sh = el('div', 'section-head');
  sh.innerHTML = `<h2>Season by season</h2><div class="sub">${h.seasons.length} seasons on record</div>`;
  host.appendChild(sh);

  const scard = el('div', 'card watch-col');
  h.seasons.slice().reverse().forEach(s => {
    const champ = s.champion ? h.people[s.champion] : null;
    const ru = s.runnerUp ? h.people[s.runnerUp] : null;
    const row = el('div', 'watch-row');
    row.innerHTML = `
      <div style="font-family:var(--display);font-weight:700;font-size:19px;color:var(--gold);width:52px">${esc(s.season)}</div>
      <div>${champ ? teamHTML(personTeamIn(champ, s.season), 'sm', `${esc(champ.display)} · ${s.teams.length}-team ${esc(s.name)}`)
                   : `<div class="team-name">${esc(s.name)}</div><div class="team-sub">${s.teams.length} teams · ${s.live ? 'in progress' : 'no bracket recorded'}</div>`}</div>
      <div class="gap">${champ ? '<span class="chip gold">Champion</span>' : (s.live ? '<span class="chip green">Live</span>' : '')}
        <small>${ru ? 'beat ' + esc(ru.display) : ''}</small></div>`;
    scard.appendChild(row);
  });
  host.appendChild(scard);

  /* ---- Career table ---- */
  const ch = el('div', 'section-head');
  ch.innerHTML = `<h2>All-time career records</h2><div class="sub">Keyed to the manager, not the team name</div>`;
  host.appendChild(ch);

  // Titles first, then total wins — a 5-game cameo shouldn't outrank a career.
  const careers = people.slice().sort((a, b) =>
    b.titles.length - a.titles.length || b.wins - a.wins || b.winPct - a.winPct);

  const ccard = el('div', 'card');
  const cwrap = el('div', 'table-wrap');
  const ct = el('table', 'lg');
  ct.innerHTML = `<thead><tr>
      <th class="l">#</th><th class="l">Manager</th><th>Yrs</th><th>W</th><th>L</th>
      <th>Win %</th><th>PPG</th><th>Titles</th><th>Finals</th><th>Best</th>
    </tr></thead><tbody></tbody>`;
  const ctb = ct.querySelector('tbody');
  careers.forEach((p, i) => {
    const tr = el('tr', p.titles.length ? 'zone-promo' : '');
    tr.innerHTML = `<td class="pos">${i + 1}</td>
      <td class="l">${teamHTML(personTeam(p), 'sm', p.display)}</td>
      <td>${p.seasons}</td><td>${p.wins}</td><td>${p.losses}</td>
      <td>${pct(p.winPct)}</td><td>${num(p.ppg, 1)}</td>
      <td style="color:var(--gold-bright);font-weight:700">${p.titles.length || '—'}</td>
      <td>${p.finals.length || '—'}</td>
      <td>${p.bestFinish === 99 ? '—' : p.bestFinish + ord(p.bestFinish)}</td>`;
    ctb.appendChild(tr);
  });
  cwrap.appendChild(ct); ccard.appendChild(cwrap); host.appendChild(ccard);

  /* ---- The record book ---- */
  const rh = el('div', 'section-head');
  rh.innerHTML = `<h2>Single-game records</h2><div class="sub">Every game ever played, both leagues</div>`;
  host.appendChild(rh);

  const flat = [];
  h.allGames.forEach(g => {
    flat.push({ who: g.a, pts: g.aPts, opp: g.b, oppPts: g.bPts, season: g.season, week: g.week, post: g.post });
    flat.push({ who: g.b, pts: g.bPts, opp: g.a, oppPts: g.aPts, season: g.season, week: g.week, post: g.post });
  });

  const nameOf = id => (h.people[id] ? h.people[id] : { team: 'Unknown', display: 'Unknown', avatar: null });

  const sets = [
    ['Highest scores ever', flat.slice().sort((a, b) => b.pts - a.pts).slice(0, 5), r => num(r.pts, 2)],
    ['Lowest scores ever', flat.slice().sort((a, b) => a.pts - b.pts).slice(0, 5), r => num(r.pts, 2)],
    ['Biggest beatdowns', flat.filter(r => r.pts > r.oppPts).sort((a, b) => (b.pts - b.oppPts) - (a.pts - a.oppPts)).slice(0, 5), r => '+' + num(r.pts - r.oppPts, 2)],
    ['Narrowest escapes', flat.filter(r => r.pts > r.oppPts).sort((a, b) => (a.pts - a.oppPts) - (b.pts - b.oppPts)).slice(0, 5), r => '+' + num(r.pts - r.oppPts, 2)],
  ];

  const rgrid = el('div', 'watch-grid');
  sets.forEach(([title, rows, fmt]) => {
    const col = el('div', 'card watch-col');
    col.innerHTML = `<h3>${title}</h3><div class="note">All seasons</div>`;
    rows.forEach(r => {
      const p = nameOf(r.who);
      const row = el('div', 'watch-row');
      row.innerHTML = `<div style="width:58px;color:var(--muted-dim);font-size:11px;line-height:1.3">${esc(r.season)}<br>W${r.week}${r.post ? ' <span style="color:var(--gold)">PO</span>' : ''}</div>
        <div>${teamHTML(personTeamIn(p, r.season), 'sm', `${esc(p.display)} vs ${esc(nameOf(r.opp).display)}`)}</div>
        <div class="gap">${fmt(r)}</div>`;
      col.appendChild(row);
    });
    rgrid.appendChild(col);
  });
  host.appendChild(rgrid);

  /* ---- Season records ---- */
  // Only completed seasons — a half-finished year is not a "best season".
  const seasonLines = [];
  people.forEach(p => p.seasonLines.forEach(l => { if (!l.live) seasonLines.push({ ...l, p }); }));
  if (!seasonLines.length) return;

  const sgrid = el('div', 'watch-grid');
  [['Best seasons by record', seasonLines.slice().sort((a, b) =>
      (b.wins - b.losses) - (a.wins - a.losses) || b.pf - a.pf).slice(0, 5), l => `${l.wins}-${l.losses}`],
   ['Most points in a season', seasonLines.slice().sort((a, b) => b.pf - a.pf).slice(0, 5), l => num(l.pf, 1)],
   ['Worst seasons', seasonLines.slice().sort((a, b) =>
      (a.wins - a.losses) - (b.wins - b.losses) || a.pf - b.pf).slice(0, 5), l => `${l.wins}-${l.losses}`],
  ].forEach(([title, rows, fmt]) => {
    const col = el('div', 'card watch-col');
    col.innerHTML = `<h3>${title}</h3><div class="note">All seasons</div>`;
    rows.forEach(l => {
      const row = el('div', 'watch-row');
      row.innerHTML = `<div style="width:44px;color:var(--muted-dim);font-size:11px">${esc(l.season)}</div>
        <div>${teamHTML({ name: l.teamName || l.p.display, owner: l.p.display, avatar: l.p.avatar }, 'sm', l.p.display + (l.champion ? ' · 🏆' : ''))}</div>
        <div class="gap">${fmt(l)}</div>`;
      col.appendChild(row);
    });
    sgrid.appendChild(col);
  });
  host.appendChild(sgrid);
  return;
}

function viewRecordsLegacy(host) {
  host.innerHTML = '';
  const head = el('div', 'section-head');
  head.innerHTML = `<h2>Records &amp; history</h2><div class="sub">Since ${esc((state.cfg.history && state.cfg.history.firstSeason) || state.cfg.season)}</div>`;
  host.appendChild(head);

  // Live season records across both leagues
  const all = [];
  state.order.forEach(k => {
    const b = state.leagues[k];
    if (!b) return;
    b.teams.forEach(t => t.results.forEach(r => all.push({ team: t, league: b.conf.name, ...r })));
  });

  if (all.length) {
    const high = all.slice().sort((a, b2) => b2.for - a.for).slice(0, 5);
    const low = all.slice().sort((a, b2) => a.for - b2.for).slice(0, 5);
    const blowout = all.slice().sort((a, b2) => (b2.for - b2.against) - (a.for - a.against)).slice(0, 5);
    const nail = all.filter(r => r.for > r.against).sort((a, b2) => (a.for - a.against) - (b2.for - b2.against)).slice(0, 5);

    const grid = el('div', 'watch-grid');
    [['Highest scores', high, r => num(r.for, 2)],
     ['Lowest scores', low, r => num(r.for, 2)],
     ['Biggest beatdowns', blowout, r => '+' + num(r.for - r.against, 2)],
     ['Narrowest escapes', nail, r => '+' + num(r.for - r.against, 2)],
    ].forEach(([title, rows, fmt]) => {
      const col = el('div', 'card watch-col');
      col.innerHTML = `<h3>${title}</h3><div class="note">${state.cfg.season} season, both leagues</div>`;
      rows.forEach(r => {
        const row = el('div', 'watch-row');
        row.innerHTML = `<div style="width:22px;color:var(--muted-dim);font-size:12px">W${r.w}</div>
          <div>${teamHTML(r.team, 'sm', r.league)}</div>
          <div class="gap">${fmt(r)}</div>`;
        col.appendChild(row);
      });
      grid.appendChild(col);
    });
    host.appendChild(grid);
  } else {
    host.appendChild(el('div', 'empty', '<strong>No games played yet</strong>Season records start filling in after Week 1.'));
  }

  const hist = state.cfg.history || {};
  if ((hist.champions || []).length || (hist.movements || []).length) {
    const h = el('div', 'section-head');
    h.innerHTML = `<h2>The ladder, year by year</h2>`;
    host.appendChild(h);
    const card = el('div', 'card watch-col');
    (hist.champions || []).forEach(c => {
      const row = el('div', 'watch-row');
      row.innerHTML = `<div style="font-family:var(--display);font-weight:700;color:var(--gold)">${esc(c.season)}</div>
        <div><div class="team-name">${esc(c.champion)}</div><div class="team-sub">${esc(c.league || '')}</div></div>
        <div class="gap"><span class="chip gold">Champion</span></div>`;
      card.appendChild(row);
    });
    (hist.movements || []).forEach(m => {
      const row = el('div', 'watch-row');
      row.innerHTML = `<div style="font-family:var(--display);font-weight:700;color:var(--muted)">${esc(m.season)}</div>
        <div><div class="team-name">${esc(m.team)}</div><div class="team-sub">${esc(m.note || '')}</div></div>
        <div class="gap"><span class="chip ${m.direction === 'up' ? 'green' : 'red'}">${m.direction === 'up' ? '▲ Promoted' : '▼ Relegated'}</span></div>`;
      card.appendChild(row);
    });
    host.appendChild(card);
  }
}

function viewMoney(host) {
  host.innerHTML = '';
  const head = el('div', 'section-head');
  head.innerHTML = `<h2>Prize money</h2><div class="sub">What everyone is actually playing for</div>`;
  host.appendChild(head);

  const p = state.cfg.payouts || {};
  const cur = p.currency || '$';

  /* ---- One combined pot across both leagues ---- */
  if (p.combined) {
    const teams = state.order.reduce((n, k) => n + (state.leagues[k] ? state.leagues[k].teams.length : 0), 0);
    const pot = (p.buyIn || 0) * teams;
    const paid = (p.prizes || []).reduce((s, x) => s + Number(x.amount || 0), 0);

    const potCard = el('div', 'card pot');
    potCard.innerHTML = `<div class="amt">${cur}${pot.toLocaleString()}</div>
      <div class="lbl">${teams} teams × ${cur}${(p.buyIn || 0).toLocaleString()} · both leagues, one pot</div>`;
    host.appendChild(potCard);

    const grid = el('div', 'money-grid');
    grid.style.marginTop = '16px';

    state.order.forEach(k => {
      const prizes = (p.prizes || []).filter(x => x.league === k);
      if (!prizes.length) return;
      const b = state.leagues[k];
      const st = b ? standings(b) : [];
      const card = el('div', 'card watch-col');
      const sub = prizes.reduce((s, x) => s + Number(x.amount || 0), 0);
      card.innerHTML = `<h3>${esc(state.cfg.leagues[k].name)}</h3>
        <div class="note">${cur}${sub.toLocaleString()} of the pot</div>`;
      prizes.forEach(pr => {
        const seed = pr.place && st[pr.place - 1] ? st[pr.place - 1] : null;
        const row = el('div', 'prize-row');
        row.innerHTML = `<span>${esc(pr.label)}${seed
          ? ` <span class="team-sub">— ${esc(seed.name)} on current seeding</span>` : ''}</span>
          <span class="amt">${cur}${Number(pr.amount || 0).toLocaleString()}</span>`;
        card.appendChild(row);
      });
      grid.appendChild(card);
    });
    host.appendChild(grid);

    const n2 = el('div', '');
    n2.style.cssText = 'margin-top:18px;font-size:13px;color:var(--muted);line-height:1.7;max-width:70ch';
    n2.innerHTML = `${esc(p.notes || '')}
      ${paid === pot
        ? ` <span style="color:var(--promo)">The pot balances exactly: ${cur}${pot.toLocaleString()} in, ${cur}${paid.toLocaleString()} out.</span>`
        : ` <span style="color:var(--releg)">Heads up — ${cur}${pot.toLocaleString()} collected but ${cur}${paid.toLocaleString()} allocated (${paid > pot ? 'over' : 'under'} by ${cur}${Math.abs(pot - paid).toLocaleString()}).</span>`}
      <br><br>Placings are decided in the playoffs; the names above are just who currently holds that seed.`;
    host.appendChild(n2);
    return;
  }

  const configured = state.order.some(k => p[k] && (p[k].buyIn || (p[k].prizes || []).length));

  if (!configured) {
    host.appendChild(el('div', 'empty', '<strong>No payouts set</strong>Add buy-ins and prize lines to <code>payouts</code> in <code>data/config.json</code> and this page fills itself in.'));
    return;
  }

  const grid = el('div', 'money-grid');
  state.order.forEach(k => {
    const b = state.leagues[k];
    const pay = p[k] || {};
    const teams = b ? b.teams.length : 0;
    const pot = (pay.buyIn || 0) * teams;
    const card = el('div', 'card watch-col');
    card.innerHTML = `<h3>${esc(state.cfg.leagues[k].name)}</h3>
      <div class="pot" style="padding:10px 0 4px"><div class="amt">${cur}${pot.toLocaleString()}</div>
      <div class="lbl">${teams} × ${cur}${(pay.buyIn || 0).toLocaleString()} buy-in</div></div>`;
    (pay.prizes || []).forEach(pr => {
      const row = el('div', 'prize-row');
      const winner = pr.place && b ? standings(b)[pr.place - 1] : null;
      row.innerHTML = `<span>${esc(pr.label)}${winner ? ` <span class="team-sub">— currently ${esc(winner.name)}</span>` : ''}</span>
        <span class="amt">${cur}${Number(pr.amount || 0).toLocaleString()}</span>`;
      card.appendChild(row);
    });
    grid.appendChild(card);
  });
  host.appendChild(grid);

  if (p.notes) {
    const n = el('div', '');
    n.style.cssText = 'margin-top:18px;font-size:13px;color:var(--muted);line-height:1.7;max-width:70ch';
    n.textContent = p.notes;
    host.appendChild(n);
  }
}

function viewRecaps(host) {
  host.innerHTML = '';
  const head = el('div', 'section-head');
  head.innerHTML = `<h2>Weekly word</h2><div class="sub">What actually happened, and who should be embarrassed</div>`;
  host.appendChild(head);

  if (!state.recaps.length) {
    host.appendChild(el('div', 'empty', '<strong>First recap lands after Week 1</strong>Written the morning after Monday Night Football.'));
    return;
  }

  state.recaps.forEach(r => {
    const card = el('div', 'card recap');
    const bodyHTML = (r.body || []).map(p => `<p>${p}</p>`).join('');
    card.innerHTML = `
      <div class="recap-head"><span class="wknum">Week ${esc(r.week)}</span>
        <span class="team-sub">${esc(r.date || '')}</span></div>
      <h3>${esc(r.headline || '')}</h3>
      <div class="recap-body">${bodyHTML}</div>`;
    if ((r.awards || []).length) {
      const aw = el('div', 'awards');
      r.awards.forEach(a => {
        aw.innerHTML += `<div class="award"><div class="lbl">${esc(a.label)}</div>
          <div class="val">${esc(a.team)}</div><div class="desc">${esc(a.note || '')}</div></div>`;
      });
      card.appendChild(aw);
    }
    host.appendChild(card);
  });
}

/* ---------------- refresh ---------------- */

function startRefresh() {
  stopRefresh();
  state.timer = setInterval(refresh, REFRESH_MS);
}
function stopRefresh() { if (state.timer) clearInterval(state.timer); state.timer = null; }

async function refresh() {
  try {
    for (const k of state.order) {
      const b = state.leagues[k];
      if (!b) continue;
      const w = Math.min(b.curWeek, b.lastRegWeek);
      const [rows, rosters] = await Promise.all([
        getJSON(`${API}/league/${b.conf.id}/matchups/${w}`),
        getJSON(`${API}/league/${b.conf.id}/rosters`),
      ]);
      b.schedule[w] = rows;
      rosters.forEach(r => {
        const t = b.byRoster[r.roster_id];
        if (!t) return;
        const s = r.settings || {};
        t.wins = s.wins || 0; t.losses = s.losses || 0; t.ties = s.ties || 0;
        t.pf = (s.fpts || 0) + (s.fpts_decimal || 0) / 100;
        t.pa = (s.fpts_against || 0) + (s.fpts_against_decimal || 0) / 100;
      });
      computeWeekly(b);
    }
    render();
  } catch (e) { console.warn('refresh failed', e); }
}

boot();
