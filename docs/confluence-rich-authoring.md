# Confluence Rich Authoring: markdown → HTML+ for `confluence-writer`

**Status:** Design / research — converging. Track 1 (feature reference page) complete; converter not yet built.
**Created:** 2026-07-02
**Primary goal:** Let the `confluence-writer` skill produce Confluence pages that use rich features
(colored panels, table of contents, layouts, status pills, dates) while authors keep drafting in
readable markdown. Achieved by authoring in a markdown dialect and converting to Confluence HTML+ at
publish time, all built into the `mfz` CLI.

This is a **living document**: it tracks the work as it is researched, prototyped, and implemented.
Update it as decisions land and code appears.

---

## Why this work exists

The `confluence-writer` skill (`skills/confluence-writer/SKILL.md`) drafts pages as local markdown and
publishes through the Atlassian MCP. Today it publishes as plain markdown, which cannot express any of
Confluence's rich features. Two forces collide:

- **Rich features are valuable.** Colored info/warning panels, a table of contents, multi-column
  layouts, and status pills make a design doc far more scannable and reader-first.
- **Markdown's readability is valuable.** The reason the skill drafts in markdown is that the author
  can *read the draft before it ships*. Authoring directly in HTML+ destroys that — the refine loop
  becomes scanning a wall of `<td><p>…</p></td>`.

The resolution is to keep authoring in markdown and **convert to HTML+ at publish time**, getting both
readable source and rich output.

## Key finding: markdown silently strips macros

The Atlassian MCP (`createConfluencePage` / `updateConfluencePage`) accepts `contentFormat` of
`markdown`, `html`, or `adf`.

- **`markdown` silently drops all macros** — panels, TOC, expand, layouts, status. It even escapes
  `<details>` into literal text. Confirmed by Atlassian MCP issues
  [#161](https://github.com/atlassian/atlassian-mcp-server/issues/161),
  [#106](https://github.com/atlassian/atlassian-mcp-server/issues/106),
  [#53](https://github.com/atlassian/atlassian-mcp-server/issues/53). This is by design: markdown is an
  input convenience that Confluence converts to its internal model, and the converter doesn't carry
  macros.
- **`html` (HTML+)** expresses every feature via `data-type` attributes and is round-trip safe
  (preserves inline comments and local IDs on re-fetch). This is the target format.
- **`adf`** (Atlassian Document Format, the native JSON model) is equally capable but far worse to
  author or diff. No advantage over HTML+ for our use.

**Conclusion:** publish with `contentFormat: "html"`. Never publish rich pages as markdown.

## HTML+ syntax reference

The create/update tool schema documents the full HTML+ vocabulary. The pieces relevant here, verified
by round-tripping the proof-of-concept page:

| Feature | HTML+ | Confluence stored as |
| --- | --- | --- |
| Info/note/warning/success/error panel | `<div data-type="panel-info\|panel-note\|panel-warning\|panel-success\|panel-error"><p>…</p></div>` | `<ac:structured-macro ac:name="info\|note\|…">` |
| Table of contents | `<div data-type="extension" data-extension-key="toc" data-extension-type="com.atlassian.confluence.macro.core" data-parameters="{…}">` | `<ac:structured-macro ac:name="toc">` |
| Expand / collapse | `<details><summary>Title</summary>…</details>` | `<ac:structured-macro ac:name="expand">` |
| Two/three-column layout | `<section data-type="layout-two-equal\|layout-three-equal"><div data-type="column">…</div></section>` | `<ac:layout-section ac:type="two_equal\|three_equal">` |
| Status pill | `<span data-type="status" data-color="green\|red\|yellow\|blue\|neutral\|purple">Label</span>` | `<ac:structured-macro ac:name="status">` |
| Date | `<time datetime="YYYY-MM-DD">label</time>` | `<time datetime="…">` |
| Inline card | `<a href="URL" data-card-appearance="inline">text</a>` | inline card |
| Mention | `<span data-type="mention" data-user-id="ACCOUNT_ID">@Name</span>` | mention |

Nesting rules (from the schema) that the converter must respect: panels cannot contain
tables/expands/blockquotes/panels; list items cannot contain headings/tables/panels/expands; task and
decision items are inline-only. Invalid nesting is rejected with a descriptive error.

### Verified feature → macro mapping (Track 1 round-trip)

Publishing the feature reference page (draft `1450214928`) and reading back the stored storage format
confirmed exactly how each HTML+ node converts. Notable mappings the converter can rely on:

| HTML+ `data-type` | Stored as |
| --- | --- |
| `panel-info` | `ac:structured-macro ac:name="info"` |
| `panel-success` | `ac:structured-macro ac:name="tip"` |
| `panel-warning` | `ac:structured-macro ac:name="note"` |
| `panel-error` | `ac:structured-macro ac:name="warning"` |
| `panel-note` | `ac:adf-extension` → ADF `panel` (`panel-type=note`), with a styled `ac:adf-fallback` |
| `status` + `data-color` | `ac:structured-macro ac:name="status"` (`colour` param capitalized) |
| `layout-two-equal` / `-three-equal` | `ac:layout-section ac:type="two_equal" / "three_equal"` (splits the page `ac:layout`) |
| `<details>` | `ac:structured-macro ac:name="expand"` (summary → `title` param) |
| task / decision list | `ac:task-list` / `ac:adf-extension` decision-list |
| `data-background="#hex"` (cell) | `data-highlight-colour="#hex"` |
| `data-breakout="wide"` (pre) | code macro `breakoutMode` param |
| `<time datetime>` | `<time datetime>` node (self-closing) |

Two panel color names map to macros whose intuitive name is *swapped* (`success`→`tip`, `warning`→`note`,
`error`→`warning`); this is only relevant if we ever parse storage format back, not for authoring.

### Authoring gotchas the round-trip exposed (converter must guard)

- **Status label must not be a color name.** `<span data-type="status" data-color="green">GREEN</span>`
  folds the label into `data-color` and renders a **blank** pill. The label has to be a real word
  (`DONE`, `BLOCKED`). The converter should reject or warn when a status label equals a color name.
- **Code fence language is normalized.** `language-python` became `py`; unknown/`text` passes through.
  Not a bug, but the converter shouldn't assume the language string round-trips verbatim.
- **Block cards collapse to inline.** `data-card-appearance="block"` is silently rewritten to `inline`
  on publish. Author inline; there is no block-card form through this MCP.
- **Jira macro serverId is instance-specific.** A same-site Cloud issue (e.g. OBSERVE) needs only a
  `key` (or `jqlQuery`) — no `serverId`. A separate/on-prem Jira (Tyler's `tylerjira.tylertech.com` =
  serverId `ebd8c297-c6cb-3f11-b12c-a1b99224e60e`, server name "Tyler JIRA"/"Data Center Jira")
  requires `server` + a real `serverId` copied from existing content. The converter's Jira directive
  should default to key-only and treat serverId as an explicit opt-in for cross-instance references.

## Decisions

- **Build into `mfz`, not a bundled script.** The skill already lives in and is synced from the mfz
  repo, so mfz is always present where the skill runs. mfz brings the runtime, pnpm, a build, and
  vitest — the converter is an ideal unit-test target. Invocation is a trivial shell-out
  (`mfz confluence md2html <file>`). *(Flips only if the skill is ever shipped to mfz-less machines,
  which is not the current plan.)*
- **Author in a fenced-block + directive markdown convention.** Chosen for readability of the source.
  Sketch (final grammar TBD during prototyping):
  - Panels: fenced blocks — ` ```panel-warning ` … ` ``` `
  - Table of contents: a marker line — `[[toc]]`
  - Status pills: inline tokens — `{status:green}LIVE{/status}`
  - Layouts: fenced container — `::: layout-3` … `---` (column break) … `:::`
  - Everything else: standard markdown (headings, tables, lists, code, links, emphasis).
- **Expand/collapse is disfavored.** It hides information reviewers might overlook, which is wrong for
  a design doc where the point is that reviewers weigh in on everything. Support it as a rare opt-in,
  never a default for substantive content.
- **`confluence-writer` will always publish rich pages as HTML+.** Draft/refine in the markdown
  dialect, convert at the gate, publish `contentFormat: "html"`.

## Open questions

- **Markdown engine / library.** Likely `markdown-it` plus a directive/container plugin, but confirm
  the library choice (and whether an existing md→Confluence-storage/ADF converter can be reused) before
  committing. Check via Context7.
- **Final directive grammar.** The sketch above needs pinning down — exact fence labels, how panel
  titles are expressed, whether layouts allow uneven columns, TOC parameter passthrough.
- **Converter output target.** Emit HTML+ (the MCP's `html` format) — confirmed. Decide whether the
  converter also needs a preview/validate mode (e.g. dry-run the nesting rules before publish).
- **Skill/CLI contract.** Exact command name and flags (`mfz confluence md2html`?), where it sits in
  `src/`, and how `confluence-writer` invokes it.
- **Front matter.** The artifact already carries a `format:` field; decide how the skill signals
  "convert this" vs. "plain markdown page."

## Work tracks

### Track 1 — feature-demonstration reference page ✅ done

One Confluence page rendering **every** feature, serving as (a) a visual reference of what's possible
and (b) source material distilled into the skill.

Published live as `1450214961` in Watchtower ("Confluence HTML+ Feature Reference"). Each feature
appears twice: the rendered result and a Source code block with the exact HTML+ to reproduce it — so
the page is both a human visual reference and copy-pasteable material for the skill and AI agents. The
artifact (`confluence-feature-reference.confluence.html`) is the known-good HTML+ output; its
per-feature blocks are the converter's test corpus.

Authored directly in HTML+ this round (the markdown dialect doesn't exist yet). When the converter
lands, re-author this page's source in the dialect and diff the output against the artifact — that
diff is Track 2's acceptance test.

### Track 2 — markdown → HTML+ converter in `mfz`

Author in the readable dialect; convert to HTML+ for the MCP's `contentFormat: "html"`.

1. Confirm the markdown engine and directive grammar (resolve the open questions).
2. Implement the converter as an `mfz` subcommand with vitest coverage against Track 1's corpus.
3. Integrate into `confluence-writer`: draft/refine in `.md`, convert at the publish gate, publish
   HTML+. Keep expand a rare opt-in.

## Reference material

- **Feature reference page (Track 1):** Confluence page `1450214961` (published) in Watchtower —
  "Confluence HTML+ Feature Reference". Every feature rendered + its HTML+ source. Artifact:
  `~/.claude/artifacts/confluence/confluence-feature-reference.confluence.html`.
- **Proof-of-concept draft:** Confluence page `1450083691` in the Watchtower space —
  "Observability Pipelines — Design (HTML+ experiment)". All features round-tripped correctly.
- **PoC artifact:** `~/.claude/artifacts/confluence/EXPERIMENT-observability-pipelines-html.confluence.html`
  (HTML+ body + front matter).
- **Source markdown it was derived from:**
  `~/.claude/artifacts/confluence/1447035132-observability-pipelines-design.confluence.md`.
- **Live example pages** (rich features in the wild), both in Watchtower:
  - Public Safety Observability Maturity Model (`1379303928`) — TOC, info/note panels.
  - Observability Maturity Model Criteria Summary & Level Selector (`1380024604`) — expand blocks.
- **Environment:** Watchtower space `spaceId 317489158`, `cloudId 748898e2-ca0a-43b6-981b-09e249be204c`.
- **Skill source of truth:** `skills/confluence-writer/SKILL.md`.
