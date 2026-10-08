"""
给官网页面里的中文打多语言标记，并生成中文原文包 i18n/zh/<page>.js（翻译其他语言就照它翻）。
  python i18n/tools/mark.py home index.html          （在 site/ 目录下跑）
  python i18n/tools/mark.py invest invest/index.html
  python i18n/tools/mark.py t t/index.html
已经有标记的元素保持原 key；新加的中文自动编号（<page>.<序号>）。脚本里的 SiteI18n.t('key', '中文') / T('key', '中文') 也收进原文包。
只改：没有标记、直接含中文文字的最外层元素；处理不了的（里面既有复杂子元素又有多段中文）会列出来，手工加标记。
不想翻的（如逐字动画的中文竖排标语）在外层元素加 data-i18n-skip。
"""
import html
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

CN = re.compile(r"[\u4e00-\u9fff]")
INLINE = {"b", "strong", "i", "em", "br", "span", "small", "a", "sup", "sub", "u", "code", "del", "s", "mark"}
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}
ATTRS = ("alt", "aria-label", "title", "placeholder", "content")
SKIP = {"script", "style"}


class Node:
    def __init__(self, tag, start, inner_start, attrs, parent):
        self.tag, self.start, self.inner_start, self.attrs, self.parent = tag, start, inner_start, dict(attrs), parent
        self.inner_end = None
        self.cn_texts = []
        self.desc_tags = set()


class Scan(HTMLParser):
    def __init__(self, src):
        super().__init__(convert_charrefs=True)
        self.src = src
        self.line_off = [0]
        for m in re.finditer("\n", src):
            self.line_off.append(m.end())
        self.stack = []
        self.nodes = []
        self.voids = []

    def off(self):
        line, col = self.getpos()
        return self.line_off[line - 1] + col

    def _desc(self, tag):
        for n in self.stack:
            n.desc_tags.add(tag)

    def handle_starttag(self, tag, attrs):
        start = self.off()
        text = self.get_starttag_text()
        parent = self.stack[-1] if self.stack else None
        self._desc(tag)
        if tag in VOID:
            self.voids.append(Node(tag, start, start + len(text), attrs, parent))
            return
        n = Node(tag, start, start + len(text), attrs, parent)
        self.stack.append(n)
        self.nodes.append(n)

    def handle_startendtag(self, tag, attrs):
        start = self.off()
        text = self.get_starttag_text()
        parent = self.stack[-1] if self.stack else None
        self._desc(tag)
        self.voids.append(Node(tag, start, start + len(text), attrs, parent))

    def handle_endtag(self, tag):
        pos = self.off()
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i].tag == tag:
                for n in self.stack[i:]:
                    n.inner_end = pos
                del self.stack[i:]
                return

    def handle_data(self, data):
        if not self.stack or any(n.tag in SKIP or "data-i18n-skip" in n.attrs for n in self.stack):
            return
        if CN.search(data):
            self.stack[-1].cn_texts.append(data)


def ancestors(n):
    p = n.parent
    while p:
        yield p
        p = p.parent


def squash(s):
    return re.sub(r"\s+", " ", s).strip()


def js_str(s):
    return "'" + s.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n") + "'"


def main():
    page, rel = sys.argv[1], sys.argv[2]
    path = Path(rel)
    src = path.read_bytes().decode("utf-8")
    sc = Scan(src)
    sc.feed(src)
    sc.close()

    used = set()
    for m in re.finditer(r'data-i18n(?:-text)?="(%s\.(\d+))"' % re.escape(page), src):
        used.add(int(m.group(2)))
    for m in re.finditer(r'data-i18n-attr="([^"]*)"', src):
        for pair in m.group(1).split(";"):
            k = pair.split(":")[-1].strip()
            if k.startswith(page + ".") and k[len(page) + 1:].isdigit():
                used.add(int(k[len(page) + 1:]))
    counter = [max(used) if used else 0]

    def new_key():
        counter[0] += 1
        return "%s.%03d" % (page, counter[0])

    def marked_html(n):
        return "data-i18n" in n.attrs

    edits = []  # (start_tag_offset, start_tag_end, attr_text)
    entries = {}  # key -> (offset, value)
    report = []

    # 已有标记：收进原文包
    for n in sc.nodes:
        if n.inner_end is None:
            continue
        inner = src[n.inner_start:n.inner_end]
        if n.attrs.get("data-i18n"):
            entries[n.attrs["data-i18n"]] = (n.start, squash(inner))
        if n.attrs.get("data-i18n-text"):
            entries[n.attrs["data-i18n-text"]] = (n.start, squash(html.unescape(" ".join(n.cn_texts))))
    for n in sc.nodes + sc.voids:
        if n.attrs.get("data-i18n-attr"):
            for pair in n.attrs["data-i18n-attr"].split(";"):
                a, k = [x.strip() for x in pair.split(":")]
                entries[k] = (n.start, n.attrs.get(a, ""))

    cands = [n for n in sc.nodes if n.cn_texts and n.inner_end is not None and n.tag not in SKIP]
    cand_set = set(id(n) for n in cands)
    for n in cands:
        if marked_html(n) or "data-i18n-text" in n.attrs:
            continue
        if any(marked_html(a) or id(a) in cand_set for a in ancestors(n)):
            continue
        inner = src[n.inner_start:n.inner_end]
        if n.desc_tags <= INLINE:
            k = new_key()
            edits.append((n.start, n.inner_start, ' data-i18n="%s"' % k))
            entries[k] = (n.start, squash(inner))
        elif len([t for t in n.cn_texts if t.strip()]) == 1:
            k = new_key()
            edits.append((n.start, n.inner_start, ' data-i18n-text="%s"' % k))
            entries[k] = (n.start, squash(html.unescape(n.cn_texts[0])))
        else:
            line = src.count("\n", 0, n.start) + 1
            report.append("line %d <%s>: %s" % (line, n.tag, squash(inner)[:120]))

    # 属性里的中文（不在整段替换的元素里面时才单独标）
    for n in sc.nodes + sc.voids:
        if n.attrs.get("data-i18n-attr") or "data-i18n-skip" in n.attrs:
            continue
        if any(marked_html(a) or "data-i18n-skip" in a.attrs for a in ancestors(n)):
            continue
        if any(id(a) in cand_set and a.desc_tags <= INLINE for a in ancestors(n)):
            continue
        pairs = []
        for a in ATTRS:
            v = n.attrs.get(a)
            if v and CN.search(v):
                k = new_key()
                pairs.append("%s:%s" % (a, k))
                entries[k] = (n.start, v)
        if pairs:
            edits.append((n.start, n.inner_start, ' data-i18n-attr="%s"' % ";".join(pairs)))

    out = src
    for start, end, attr in sorted(edits, key=lambda e: -e[0]):
        tag = out[start:end]
        cut = len(tag) - (2 if tag.endswith("/>") else 1)
        while cut > 0 and tag[cut - 1] == " ":
            cut -= 1
        out = out[:start] + tag[:cut] + attr + tag[cut:] + out[end:]
    if out != src:
        path.write_bytes(out.encode("utf-8"))

    # 脚本里的 SiteI18n.t('key', '中文') / T('key', '中文')
    for m in re.finditer(r"(?:SiteI18n\.t|\bT)\(\s*'([\w.]+)'\s*,\s*'((?:[^'\\]|\\.)*)'", out):
        val = re.sub(r"\\(.)", lambda x: "\n" if x.group(1) == "n" else x.group(1), m.group(2))
        entries.setdefault(m.group(1), (10 ** 9 + m.start(), val))

    zh = Path(__file__).resolve().parent.parent / "zh" / (page + ".js")
    zh.parent.mkdir(parents=True, exist_ok=True)
    lines = ["// 中文原文（tools/mark.py 生成，不要手改；翻译其他语言照这份翻）", "SiteI18n.add({"]
    for k, (_, v) in sorted(entries.items(), key=lambda kv: kv[1][0]):
        lines.append("  %s: %s," % (js_str(k), js_str(v)))
    lines.append("});")
    zh.write_bytes(("\n".join(lines) + "\n").encode("utf-8"))

    print("%s: %d new marks, %d entries -> %s" % (page, len(edits), len(entries), zh))
    for r in report:
        print("  MANUAL", r)


if __name__ == "__main__":
    main()
