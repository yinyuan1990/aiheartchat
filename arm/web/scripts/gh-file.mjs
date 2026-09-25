// Print GitHub file contents via the API. Usage: node scripts/gh-file.mjs owner/repo path [path...]
const [repo, ...paths] = process.argv.slice(2);
const headers = { "User-Agent": "arclaunch-research", Accept: "application/vnd.github+json" };
for (const p of paths) {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/contents/${p}`, { headers, signal: AbortSignal.timeout(30000) });
    const json = await res.json();
    console.log(`\n===== ${repo}/${p} =====`);
    if (json.content) console.log(Buffer.from(json.content, "base64").toString("utf8"));
    else console.log(JSON.stringify(json).slice(0, 300));
  } catch (e) {
    console.log(`\n===== ${repo}/${p} ===== ERR ${e.message}`);
  }
}
