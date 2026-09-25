// Quick GitHub repo search for UI reference research. Usage: node scripts/gh-search.mjs "query" ["query2" ...]
const queries = process.argv.slice(2);
const headers = { "User-Agent": "arclaunch-research", Accept: "application/vnd.github+json" };
for (const q of queries) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=10`;
  try {
    const res = await fetch(url, { headers });
    const json = await res.json();
    console.log(`\n=== ${q} ===`);
    for (const it of json.items ?? []) {
      const desc = (it.description ?? "").replace(/\s+/g, " ").slice(0, 100);
      console.log(`${String(it.stargazers_count).padStart(6)}  ${it.full_name.padEnd(50)} ${it.pushed_at.slice(0, 10)}  ${desc}`);
    }
    if (!json.items) console.log(JSON.stringify(json).slice(0, 300));
  } catch (e) {
    console.log(`=== ${q} === ERR ${e.message}`);
  }
}
