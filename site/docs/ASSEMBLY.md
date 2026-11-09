# Assembling a docs page

`_template.html` is the page shell. For each page, copy it to the target file and replace these markers (plain string replace, each appears once):

| Marker | Replace with |
|---|---|
| `<!--TITLE-->` | Page title, e.g. `Models and keys - Cloudy Cloud docs` (plain text, escape `&`, `<`) |
| `<!--DESCRIPTION-->` | One-sentence description (escape `"`, `&`, `<`) |
| `<!--CONTENT-->` | The content fragment, unchanged |
| `<!--PREVNEXT-->` | Prev/next links (see below) |

Sidebar is static in the template. To mark the current page, find the one `<a href="..." data-page="SLUG">` and add ` aria-current="page"` to it. SLUG is `index`, `how-it-works`, `models`, `reference`, `fleets`, `dashboard` or `troubleshooting`. Sidebar links are relative (`./`, `models.html`), so all pages live in `site/docs/`.

Prev/next: in sidebar order. Omit prev on the first page and next on the last. Markup:

    <a class="prev" href="models.html"><small>Previous</small><span>Models and keys</span></a>
    <a class="next" href="fleets.html"><small>Next</small><span>Coordinators and fleets</span></a>

The first page's prev href for `index` is `./`. If only a next link exists it still sits in the right column (class `next`).

The "On this page" list, copy buttons, heading anchors, table wrappers and theme toggle are all added by `docs.js` from the fragment; do not add them to content. Every page needs `docs.css` and `docs.js` beside it. `_sample.html` shows the result.
