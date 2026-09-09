# PAC2PAC — two leagues, one ladder

A live site for a linked pair of Sleeper fantasy football leagues with promotion and relegation
between them.

Everything on the site is pulled from Sleeper's public API **in the visitor's browser**, so scores
are genuinely live on Sundays and the site never needs a server, a database, or an API key.

---

## 1. Put it online (about five minutes)

1. Go to <https://github.com/new>. Name the repository whatever you like — `pac2pac` is fine.
   Make it **Public**. Don't add a README (this folder already has one).
2. On the new repo's page, click **uploading an existing file**.
3. Drag in everything from this folder: `index.html`, the `assets` folder, the `data` folder,
   and this README. Click **Commit changes**.
4. Go to **Settings → Pages**. Under "Build and deployment", set **Source** to
   *Deploy from a branch*, **Branch** to `main` and the folder to `/ (root)`. Click **Save**.
5. Wait about a minute, then reload that page. GitHub shows your URL, something like
   `https://yourname.github.io/pac2pac/`. That's the link you send to the league.

Any time you change a file in the repo, the site updates within a minute. No rebuild step.

---

## 2. Add the second league

Open `data/config.json` and paste the G-League's Sleeper ID into the empty `id` field:

```json
"gleague": { "id": "PASTE_IT_HERE", "name": "G-League", ... }
```

You find the ID in the Sleeper URL when the league is open on a computer:

```
https://sleeper.com/leagues/1400580506310983680/team
                            ^^^^^^^^^^^^^^^^^^^ this
```

Team names, avatars, records, scores and the full schedule come across automatically — there is
nothing else to enter.

---

## 3. Everything else you can change

All of it lives in `data/config.json`. You never need to touch the code.

### Prize money

One combined pot across both leagues:

```json
"payouts": {
  "currency": "$", "buyIn": 50, "combined": true,
  "prizes": [
    { "label": "Premier League champion",    "amount": 500, "league": "premier", "place": 1 },
    { "label": "Premier League runner-up",   "amount": 200, "league": "premier", "place": 2 },
    { "label": "Premier League third place", "amount": 50,  "league": "premier", "place": 3 },
    { "label": "G.R.I.T. League champion",   "amount": 150, "league": "gleague", "place": 1 }
  ]
}
```

18 teams x $50 = $900, and the four prizes total $900. **The page checks this for you** — if the
prizes ever stop adding up to the pot it says so in red, with the amount you are over or under.
Change a buy-in or add a team and it re-checks itself.

`place` is optional and only controls the "on current seeding" note. Since every placing is
actually settled in the playoffs, the page says so rather than implying the table decides it.

### Rivalries

```json
"rivalries": [
  { "teams": ["PeterNell", "TheGloveDidntFit"], "name": "", "blurb": "" },
  { "teams": ["BalineseBandit", "jackfierro"],  "name": "", "blurb": "" }
]
```

Match by **Sleeper display name or team name**. `name` and `blurb` are both optional — leave `name`
empty and the site calls it "PeterNell vs TheGloveDidntFit". Fill it in whenever you think of
something better, and add a `blurb` for the backstory.

When the two play each other, the matchup card gets a gold rivalry banner. Every rivalry also gets
a card on the Rivalries tab with the all-time series pulled from the archive.

**Cross-league rivalries work.** If the two managers are in different leagues the card is flagged
*"Split by the ladder"* — they cannot meet until one of them goes up or comes down.

### League history — handled automatically

```json
"history": {
  "archiveLeagueId": "1388341853870366720"
}
```

That is the whole configuration. The site follows Sleeper's `previous_league_id` chain backward
from that league and pulls **every season it can reach** — 2025, 2024 and 2023 as of now, plus the
abandoned 2026 shell, which it detects as having no games and skips.

From that archive it builds:

- the **honour roll** — every champion, from the real playoff brackets
- **career records** for every manager: seasons, W-L, win %, points per game, titles, finals
- the **record book** — highest and lowest scores ever, biggest beatdowns, narrowest escapes,
  best and worst seasons
- **all-time head-to-head** between every pair of managers, which is what produces the lines on the
  matchup cards: *"Coyne4 has never beaten Ehoeff3"*, *"Ehoeff3 has won 4 straight"*

Everything is keyed to the Sleeper **user ID**, not the team name, so a manager keeps one
continuous career line across every rename. The site shows the team name they actually used in that
season when it's displaying an old record.

When a new season ends it folds in on its own. There is nothing to regenerate.

The `h2h`, `champions` and `movements` arrays are a manual fallback for leagues with no Sleeper
history to walk. Yours has history, so leave them empty — real data always wins over them.

### The promotion / relegation rules

Both ladders are settled in the postseason, not by the final table, and the site models that
everywhere — the tables, the watch page and the odds.

```json
"premier": { "playoffTeams": 6, "dropBracketTeams": 4, "dropSurvivors": 1, "relegationCount": 3 },
"gleague": { "playoffTeams": 4, "promotionCount": 3 }
```

- **Premier League** — top 6 make the playoffs and are safe. The other 4 fall into a consolation
  bracket; its winner stays up, the other 3 are relegated.
- **G.R.I.T. League** — only the top 4 make the playoffs, and 3 of those 4 are promoted: the
  champion, the runner-up and the winner of the third-place game. Finish 5th and the season is over.

This is why the league tables draw the line at 6th rather than at the foot of the table, and why
the relegation odds are not simply "who finishes bottom three". Each simulated season plays out the
consolation bracket, so a team can finish 10th and still be favoured to survive.

The `summary` text prints under each league table. Edit it if the wording changes.

---

## 4. Weekly recaps

`data/recaps.json` holds the written analysis. Newest first; the site sorts by week anyway.

```json
{
  "recaps": [
    {
      "week": 5,
      "date": "October 7, 2026",
      "headline": "The bottom three starts to look permanent",
      "body": ["First paragraph.", "Second paragraph, with <strong>bold</strong> allowed."],
      "awards": [
        { "label": "Team of the week", "team": "Bombs Over Baghdad", "note": "148.6, never close." }
      ]
    }
  ]
}
```

Each `body` entry becomes a paragraph. Awards render as a row of cards under the article.

---

## What's on each tab

| Tab | What it shows |
| --- | --- |
| **Matchups** | Live scores for the current week, refreshed every minute. Rivalry games get a banner; two relegation-zone teams playing each other get flagged as a six-pointer. Each card carries the all-time head-to-head. |
| **Tables** | Full league table with form guide. Green stripe = promotion places, gold = playoff places, red = relegation zone. |
| **Promo / Releg** | Both leagues side by side. The Premier side shows who is falling into the consolation bracket; the G.R.I.T. side shows who is still alive for promotion — only the top 4 there. |
| **Odds** | 6,000 simulated seasons in the browser using the real remaining fixtures, with the championship and consolation brackets played out in each one. |
| **Power Rankings** | Blends scoring, win rate, recent form and consistency, then shows how far that disagrees with the actual table. |
| **Rivalries** | Configured rivalries plus a full head-to-head grid for the league. |
| **Records** | The full archive: honour roll of champions, all-time career records for every manager, single-game and single-season record book, season by season back to 2023. |
| **Money** | The combined pot, the four prizes, and a check that they still add up. |
| **Recaps** | The weekly written analysis. |

---

## Files

```
index.html            page shell
assets/styles.css     all styling
assets/app.js         data loading, standings, simulations, rendering
assets/history.js     walks the archive chain and builds all-time records
data/config.json      ← the only file you normally edit
data/recaps.json      ← weekly write-ups
```

No build step, no dependencies, no tracking.
