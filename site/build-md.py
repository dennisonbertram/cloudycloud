#!/usr/bin/env python3
"""Regenerate the AI-facing files of the static site from its HTML pages. Run from anywhere: python3 site/build-md.py

Writes: a .md twin for every HTML page, llms.txt, llms-full.txt, sitemap.xml, and the
homepage / FAQ / glossary JSON-LD blocks (between <!--ld--> and <!--/ld--> in each page).
Edit the HTML, then run this. Stdlib only.
"""
import html, json, re, sys
from html.parser import HTMLParser
from pathlib import Path

SITE = Path(__file__).resolve().parent
BASE = 'https://cloudycloud.tech'
LASTMOD = '2026-11-09'
DEFINITION = ('Cloudy Cloud is open-source software (MIT license, install with npx cloudycloud setup) that gives '
              'every Claude Code subagent its own cloud machine, a copy of your repo, and its own branch.')
GH = 'https://github.com/dennisonbertram/cloudycloud'
NPM = 'https://www.npmjs.com/package/cloudycloud'
DOC_SLUGS = ['index', 'how-it-works', 'models', 'reference', 'fleets', 'dashboard', 'troubleshooting',
             'what-is-cloudy-cloud', 'faq', 'glossary']
# llms.txt sections: heading -> slugs ('home' is the homepage)
SECTIONS = [('Docs', ['index', 'what-is-cloudy-cloud', 'how-it-works', 'models', 'fleets', 'dashboard']),
            ('Reference', ['reference', 'faq', 'glossary', 'troubleshooting']),
            ('Optional', ['home'])]

SKIP_TAGS = {'svg', 'script', 'style', 'button', 'canvas', 'nav'}
SKIP_CLASSES = {'cmp', 'ascii', 'why-foot', 'kicker', 'hero-fade', 'replay', 'cta-row', 'hero-note', 'n'}


def page_url(slug):
    return BASE + ('/' if slug == 'home' else '/docs/' if slug == 'index' else f'/docs/{slug}.html')


def md_name(slug):
    return BASE + ('/index.md' if slug == 'home' else f'/docs/{slug}.md')


def src_file(slug):
    return SITE / ('index.html' if slug == 'home' else 'docs/index.html' if slug == 'index' else f'docs/{slug}.html')


class MD(HTMLParser):
    """Converts the page's main content (docs: <article>; home: hero lede + <main>) to Markdown."""

    def __init__(self, home, base_dir):
        super().__init__(convert_charrefs=True)
        self.home, self.base_dir = home, base_dir
        self.out, self.buf = [], ''
        self.stack = []          # (tag, skipping)
        self.skip = 0
        self.cap = 0             # capture depth marker
        self.pre = False
        self.lists = []          # 'ul' / 'ol' counters
        self.table = None
        self.cell = None
        self.quote = ''
        self.details_q = False

    def capturing(self):
        return self.cap > 0 and self.skip == 0

    def flush(self, prefix=''):
        t = self.buf if self.pre else re.sub(r'\s+', ' ', self.buf).strip()
        self.buf = ''
        if t:
            self.out.append(prefix + t)

    def link(self, h):
        if h.startswith('#'):
            return None
        if re.match(r'^[a-z]+:', h):
            return h
        if h.startswith('/'):
            return BASE + h
        path = (self.base_dir + '/' + h).replace('/./', '/')
        parts = []
        for p in path.split('/'):
            if p == '..': parts and parts.pop()
            elif p: parts.append(p)
        return BASE + '/' + '/'.join(parts) if not path.endswith('/') else BASE + '/' + '/'.join(parts) + '/'

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = set((a.get('class') or '').split())
        skipping = tag in SKIP_TAGS or bool(cls & SKIP_CLASSES)
        if tag in ('br', 'img', 'hr', 'input', 'meta', 'link', 'source', 'path', 'rect', 'circle', 'stop'):
            if tag == 'br' and self.capturing(): self.buf += ' '
            return
        if self.skip == 0 and not self.cap:
            if (not self.home and tag == 'article') or (self.home and (tag == 'main' or 'hero-copy' in cls)):
                self.cap = 1
                self.stack.append((tag, False, True))
                return
        self.stack.append((tag, skipping, False))
        if skipping:
            self.skip += 1
            return
        if not self.capturing():
            return
        if tag in ('h1', 'h2', 'h3', 'h4'):
            self.flush(); self.buf = ''
        elif tag in ('p', 'div', 'section', 'summary'):
            if not self.lists and not self.cell is not None: self.flush(self.quote)
            if 'note' in cls: self.quote = '> Note: '
            if 'warn' in cls: self.quote = '> Warning: '
            if tag == 'summary': self.details_q = True
        elif tag == 'pre':
            self.flush(); self.pre = True
        elif tag in ('ul', 'ol'):
            self.flush(); self.lists.append([tag, 0])
        elif tag == 'li':
            self.flush()
            self.lists[-1][1] += 1
        elif tag == 'code' and not self.pre:
            self.buf += '`'
        elif tag in ('strong', 'b'):
            self.buf += '**'
        elif tag in ('em', 'i'):
            self.buf += '*'
        elif tag == 'a':
            h = self.link(a.get('href', '')) if a.get('href') else None
            self.buf += '[' if h else ''
            self.stack[-1] = (tag, False, False, h)
        elif tag == 'table':
            self.flush(); self.table = []
        elif tag == 'tr' and self.table is not None:
            self.table.append([])
        elif tag in ('td', 'th') and self.table is not None:
            self.cell = ''
            self.buf = ''

    def handle_endtag(self, tag):
        if tag in ('br', 'img', 'hr', 'input', 'meta', 'link', 'source', 'path', 'rect', 'circle', 'stop'):
            return
        if not self.stack:
            return
        # pop to matching tag
        while self.stack and self.stack[-1][0] != tag:
            self.stack.pop()
        if not self.stack:
            return
        ent = self.stack.pop()
        if len(ent) == 3 and ent[2]:
            self.flush(); self.cap = 0
            return
        if ent[1]:
            self.skip -= 1
            return
        if not self.capturing():
            return
        if tag in ('h1', 'h2', 'h3', 'h4'):
            t = re.sub(r'\s+', ' ', self.buf).strip(); self.buf = ''
            if t and not (self.home and tag == 'h1'):
                self.out.append('#' * int(tag[1]) + ' ' + t)
        elif tag == 'summary':
            t = re.sub(r'\s+', ' ', self.buf).strip(); self.buf = ''
            if t: self.out.append('### ' + t)
            self.details_q = False
        elif tag in ('p', 'div', 'section'):
            if self.cell is None and not self.lists:
                self.flush(self.quote)
            if tag in ('div', 'p') and self.quote and tag == 'div': self.quote = ''
            if self.quote and tag == 'p': self.quote = '> '
        elif tag == 'pre':
            code = self.buf.strip('\n'); self.buf = ''; self.pre = False
            self.out.append('```\n' + code + '\n```')
        elif tag in ('ul', 'ol'):
            self.flush(); self.lists.pop()
        elif tag == 'li':
            t = re.sub(r'\s+', ' ', self.buf).strip(); self.buf = ''
            if t:
                kind, n = self.lists[-1]
                self.out.append('  ' * (len(self.lists) - 1) + (f'{n}. ' if kind == 'ol' else '- ') + t)
        elif tag == 'code' and not self.pre:
            self.buf += '`'
        elif tag in ('strong', 'b'):
            self.buf += '**'
        elif tag in ('em', 'i'):
            self.buf += '*'
        elif tag == 'a':
            h = ent[3] if len(ent) > 3 else None
            if h: self.buf += f']({h})'
        elif tag in ('td', 'th') and self.table is not None:
            self.table[-1].append(re.sub(r'\s+', ' ', self.buf).strip().replace('|', '\\|')); self.buf = ''; self.cell = None
        elif tag == 'table':
            rows, self.table = self.table, None
            rows = [r for r in rows if r]
            if rows:
                w = max(len(r) for r in rows)
                rows = [r + [''] * (w - len(r)) for r in rows]
                lines = ['| ' + ' | '.join(rows[0]) + ' |', '|' + '---|' * w]
                lines += ['| ' + ' | '.join(r) + ' |' for r in rows[1:]]
                self.out.append('\n'.join(lines))

    def handle_data(self, d):
        if self.capturing():
            self.buf += d


def meta(s, pat):
    return html.unescape(re.search(pat, s, re.S).group(1)).strip()


def convert(slug):
    s = src_file(slug).read_text()
    title = meta(s, r'<title>(.*?)</title>')
    desc = DEFINITION if slug == 'home' else meta(s, r'name="description" content="(.*?)"')
    base_dir = '' if slug == 'home' else 'docs'
    p = MD(slug == 'home', base_dir)
    p.feed(s)
    p.flush()
    out = []
    for chunk in p.out:
        if out and re.match(r'\s*(- |\d+\. )', chunk) and re.match(r'\s*(- |\d+\. )', out[-1].split('\n')[-1]):
            out[-1] += '\n' + chunk
        else:
            out.append(chunk)
    body = '\n\n'.join(out)
    # homepage stat tiles: "**50**subagents" -> "**50** subagents"; drop the setup-time tile (the docs state no setup time)
    body = re.sub(r'^\*{4,}\n\n', '', body, flags=re.M)
    body = re.sub(r'^\*\*[^*\n]*\*\*to set up\n\n', '', body, flags=re.M)
    body = re.sub(r'^(\*\*[^*\n]+\*\*)(?=\S)', r'\1 ', body, flags=re.M)
    if slug != 'home':  # the page's own H1 becomes the title
        m = re.match(r'# (.+?)\n\n', body + '\n\n')
        if m:
            title = m.group(1)
            body = body[m.end():]
    return title, desc, body


def text(frag):
    t = re.sub(r'<pre><code>(.*?)</code></pre>', lambda m: ' ' + m.group(1) + ' ', frag, flags=re.S)
    t = re.sub(r'<[^>]+>', '', t)
    return re.sub(r'\s+', ' ', html.unescape(t)).strip()


def qa_pairs(slug):
    """(heading, answer text) pairs: <details> on the homepage, h3 sections elsewhere."""
    s = src_file(slug).read_text()
    if slug == 'home':
        return [(text(q), text(a)) for q, a in re.findall(r'<details><summary>(.*?)</summary>(.*?)</details>', s, re.S)]
    art = re.search(r'<article>(.*?)</article>', s, re.S).group(1)
    art = art.split('<h2 id="more"')[0]
    return [(text(h), text(b)) for h, b in re.findall(r'<h3 id="[^"]*">(.*?)</h3>(.*?)(?=<h3 |\Z)', art, re.S)]


def ld_blocks(slug):
    ld = []
    if slug == 'home':
        ld.append({"@context": "https://schema.org", "@type": "SoftwareApplication", "name": "Cloudy Cloud",
                   "description": DEFINITION, "applicationCategory": "DeveloperApplication",
                   "operatingSystem": "macOS, Linux", "softwareVersion": "0.1.0",
                   "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"},
                   "license": GH + "/blob/HEAD/LICENSE", "downloadUrl": NPM, "codeRepository": GH,
                   "url": BASE + "/", "isAccessibleForFree": True})
        ld.append({"@context": "https://schema.org", "@type": "Organization", "name": "Cloudy Cloud",
                   "url": BASE + "/", "sameAs": [GH, NPM]})
        ld.append({"@context": "https://schema.org", "@type": "WebSite", "name": "Cloudy Cloud", "url": BASE + "/",
                   "description": DEFINITION})
    if slug in ('home', 'faq'):
        ld.append({"@context": "https://schema.org", "@type": "FAQPage",
                   "mainEntity": [{"@type": "Question", "name": q,
                                   "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in qa_pairs(slug)]})
    if slug == 'glossary':
        ld.append({"@context": "https://schema.org", "@type": "DefinedTermSet", "name": "Cloudy Cloud glossary",
                   "url": page_url(slug),
                   "hasDefinedTerm": [{"@type": "DefinedTerm", "name": q, "description": a,
                                       "inDefinedTermSet": page_url(slug)} for q, a in qa_pairs(slug)]})
    return ld


def inject_ld(slug):
    f = src_file(slug)
    s = f.read_text()
    ld = ld_blocks(slug)
    if not ld:
        return
    block = '<!--ld-->\n' + '\n'.join('<script type="application/ld+json">' + json.dumps(b, ensure_ascii=False).replace('</', '<\\/') + '</script>' for b in ld) + '\n<!--/ld-->\n'
    if '<!--ld-->' in s:
        s = re.sub(r'<!--ld-->\n.*?<!--/ld-->\n', lambda m: block, s, flags=re.S)
    else:
        s = s.replace('</head>', block + '</head>', 1)
    f.write_text(s)


def main():
    slugs = ['home'] + DOC_SLUGS
    for slug in slugs:
        inject_ld(slug)
    pages = {}
    for slug in slugs:
        title, desc, body = convert(slug)
        pages[slug] = (title, desc, body)
        out = SITE / ('index.md' if slug == 'home' else f'docs/{slug}.md')
        out.write_text(f'# {title}\n\n> {desc}\n\nSource: {page_url(slug)}\n\n{body}\n')
    # llms.txt
    L = ['# Cloudy Cloud', '', f'> {DEFINITION}', '',
         f'Cloudy Cloud is open source under the MIT license. The npm package is `cloudycloud` (version 0.1.0). '
         f'Install and set up with `npx cloudycloud setup`. The code is at {GH}. '
         'You need an account with a cloud sandbox provider (Instabox is supported today), Claude credentials '
         '(a Claude subscription or an API key), a GitHub repo you can push to, and Node.js 20 or later. '
         'Cloudy Cloud has no price of its own; you pay your own providers. A hosted version is coming.', '',
         'Each page below also has its text as Markdown at its URL with `.html` replaced by `.md`. '
         f'[llms-full.txt]({BASE}/llms-full.txt) holds all of them in one file.', '']
    for head, slist in SECTIONS:
        L.append(f'## {head}')
        L.append('')
        for sl in slist:
            title, desc, _ = pages[sl]
            if sl == 'home': title = 'Cloudy Cloud homepage'
            L.append(f'- [{title}]({md_name(sl)}): {desc}')
        if head == 'Optional':
            L.append(f'- [Source code on GitHub]({GH}): The repository, README and issues.')
            L.append(f'- [Setup guide (RUNBOOK)]({GH}/blob/HEAD/docs/RUNBOOK.md): Step-by-step setup and operations guide.')
            L.append(f'- [cloudycloud on npm]({NPM}): The npm package.')
        L.append('')
    (SITE / 'llms.txt').write_text('\n'.join(L))
    # llms-full.txt
    parts = []
    for sl in slugs:
        t = (SITE / ('index.md' if sl == 'home' else f'docs/{sl}.md')).read_text()
        parts.append(f'Source: {page_url(sl)}\n\n' + t.replace(f'Source: {page_url(sl)}\n\n', '', 1))
    (SITE / 'llms-full.txt').write_text('\n\n---\n\n'.join(parts))
    # sitemap.xml
    urls = ''.join(f'  <url>\n    <loc>{page_url(sl)}</loc>\n    <lastmod>{LASTMOD}</lastmod>\n  </url>\n' for sl in slugs)
    (SITE / 'sitemap.xml').write_text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls + '</urlset>\n')


if __name__ == '__main__':
    main()
