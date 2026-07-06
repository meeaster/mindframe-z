---
name: audit-ai-writing
description: Audits prose for the tells of AI-generated writing — puffery, weasel attributions, negative parallelisms, the rule of three, AI vocabulary, and formatting tics. Use when the user asks to review or audit writing for AI signs, check whether text reads as AI-written or "slop", de-slop a draft, or strip ChatGPT-isms.
---

# Audit AI Writing

Hunt the text for **tells**: the giveaways that mark prose as machine-generated. A single tell is usually coincidence; the verdict rides on **density**, the same way a poker tell means nothing once but everything when it repeats. Apply the catalogue below to *every* passage, not a sample.

**Source:** Wikipedia, [Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing), revision of **26 June 2026 23:45 UTC**.

## Process

1. **Read the whole text first.** A mid-piece shift in tone or vocabulary is itself a tell — you can only catch it after seeing the baseline.
2. **Scan against every tell in the catalogue below**, one category at a time. The work is done only when all are checked, not when you have found a few. For each hit: quote the passage verbatim, name the tell, and propose a concrete rewrite.
3. **Weigh density.** One em dash is nothing; em dashes plus puffery plus rule-of-three in one paragraph is a verdict. Do not flag isolated hits as proof — flag patterns.
4. **Report.** Group findings by severity (clusters first), then give a one-line verdict: clean, scattered tells, or pervasively AI-flavored. Never flag the items under [Not tells](#not-tells).

## Tell catalogue

### Significance inflation (puffery)
Generic claims that the subject matters to some broader movement. Watch: *stands/serves as, is a testament to, plays a vital/significant/crucial/pivotal role, underscores the importance, reflects a broader, symbolizing, contributing to, setting the stage, key turning point, evolving landscape, focal point, indelible mark, deeply rooted.*

### Promotional / travel-brochure tone
Marketing warmth where neutral description belongs. Watch: *boasts, vibrant, rich (heritage/tapestry), profound, nestled, in the heart of, groundbreaking, renowned, showcasing, exemplifies, commitment to, natural beauty, diverse array.*

### Vague attribution (weasel words)
Opinions hung on unnamed authorities. Watch: *industry reports, observers have cited, experts argue, some critics argue, several sources/publications,* and *such as* before a padded list. Demand a named source or cut the claim.

### Superficial "-ing" analysis
Analysis faked by tacking a present-participle clause onto a fact: *...facilitating trade, contributing to development, highlighting the role, ensuring access, fostering growth.* The clause adds no checkable content.

### Formulaic conclusion
The "challenges / future" wrap-up: *"Despite its X, [subject] faces several challenges..."* followed by vague optimism or speculation about what lies ahead.

### AI vocabulary density
High concentration of model-favored words. Strong markers: *additionally, delve, intricate/intricacies, interplay, landscape, meticulous, pivotal, underscore, tapestry, testament, leverage, align with, enhance, foster, showcase, robust, seamless.* Density is the signal, not any single word.

### Negative parallelism
Define-by-negation framings: *"not only X, but also Y" · "it's not X, it's Y" · "X rather than Y" · "no…, no…, just…"* Overused to manufacture rhythm.

### Rule of three
Reflexive three-part lists where two or four would read naturally — *adjective, adjective, adjective*; *phrase, phrase, and phrase*; or three parallel bolded headers in a row.

### Elegant variation
Straining to never repeat a noun, so one concept wears many synonyms across a paragraph (an artifact of repetition penalties). Repeating the plain word is usually better.

### Copula avoidance
Dodging *is/are/has* for inflated verbs: *serves as, stands as, marks, represents, features, offers, boasts.* Restore the plain copula.

### Formatting tics
- **Title Case In Headings** where sentence case is the house style.
- **Bold overuse** — mechanically bolding key terms throughout, sometimes broken across line breaks.
- **Em-dash overuse** for emphasis and asides.
- **Curly quotes / apostrophes** (" " ' ') and **emoji as bullets** (✓ ❌) used decoratively.
- **Inline-header lists**: `- **Bolded header:** description` repeated down a list.

## Not tells

Do not flag these — the article calls them unreliable:
- Length, or grammatical and spelling perfection.
- Any single isolated instance of an otherwise-flagged pattern.
- Text written before ChatGPT's launch (November 2022), or where the author can coherently explain their own word choices.

