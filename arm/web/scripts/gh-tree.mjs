// List source files of a GitHub repo (filtered). Usage: node scripts/gh-tree.mjs owner/repo [filterRegex]
const [repo, filter = "(app|pages|components|views|features)/"] = process.argv.slice(2);
const headers = { "User-Agent": "arclaunch-research", Accept: "application/vnd.github+json" };
const meta = await (await fetch(`https://api.github.com/repos/${repo}`, { headers })).json();
const branch = meta.default_branch ?? "main";
const tree = await (await fetch(`https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`, { headers })).json();
const re = new RegExp(filter);
const files = (tree.tree ?? []).filter((n) => n.type === "blob" && re.test(n.path) && /\.(tsx?|jsx?|vue)$/.test(n.path)).map((n) => n.path);
console.log(`# ${repo} (${branch}) — ${meta.stargazers_count}★ — ${files.length} files`);
console.log(files.join("\n"));
