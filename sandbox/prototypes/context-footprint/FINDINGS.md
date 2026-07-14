# Prototype Findings

Status: prototype evidence, not production requirements.

## Question

Can one normalized report make loading behavior, static size, historical usage,
and capability evidence readable without collapsing unlike measurements?

## Verdict

Mostly yes. The loading-class model is understandable when each contributor is
shown under its class, unknown measurements are explicit, and the maximum
conditional path is reported separately as additional path context. Current
capabilities, historical-only capabilities, and capabilities with no observed
use can share one activation list without implying an automatic verdict.

## Prototype-Supported Decisions

- Keep one report with harness-specific contributor loading classes.
- Keep exact characters and bytes beside the labelled `round(characters / 4)` estimate.
- Treat unknown MCP schemas and unavailable skill bodies as unknown, not zero.
- Report the maximum additional conditional path separately from the startup subtotal.
- State that the maximum path is additive to the always-present baseline; it is not another startup subtotal.
- State explicitly when history was not requested and session stores were not read.
- Keep current static measurements separate from historical activation evidence.
- Phrase zero current calls as `no use observed in this window`.
- Mark capabilities seen in history but absent from the current profile as historical-only.
- Show historical prompt input as a window total, average per request, and maximum observed input occupancy per request.
- Derive the average from usage-bearing deduplicated requests, not from all observed model steps.
- Label cache read/write/create values as window totals and keep them as prompt-input components.

## Isolated Harness Validation

An isolated OpenCode CLI probe rendered the personal profile into a temporary
mfz home, used temporary OpenCode config, data, cache, and state directories,
and removed all temporary files afterward. A fixed no-tool prompt on the same
model produced these effective prompt-input measurements:

| Arm | Effective prompt input |
| --- | ---: |
| Baseline: no profile instructions or MCP servers | 9,275 tokens |
| Profile instructions only | 13,311 tokens |
| Profile instructions and enabled MCP servers | 16,857 tokens |

The instructions-only delta was 4,036 tokens against a 4,364-token static
estimate, an approximately 8% difference consistent with the `characters / 4`
heuristic. The three enabled MCP schemas together added 3,546 tokens per model
request. Repository instructions and skill catalogues were unchanged across
these arms, so this probe does not validate their individual estimates.

Direct MCP `initialize` and `tools/list` probes established that both local and
remote servers expose their actual instructions and tool definitions. The local
`fff` server advertised `find_files`, `grep`, and `multi_grep`; the public
Context7 server advertised `resolve-library-id` and `query-docs`. Direct schema
inspection is useful evidence, but an isolated provider request remains the
authoritative measurement of the harness's serialized tool cost.

OpenCode filters skills denied through `permission.skill.<name>` from the
model-visible `available_skills` catalogue. A denied skill body is not startup
context and cannot be loaded through the skill tool. Static analysis must use
the effective profile, global, and project skill override state for the
inspected directory rather than relying only on SKILL.md frontmatter.

## New Concern For The Spec

Historical prompt-input totals are traffic, while the maximum single-request
prompt input is an observed occupancy value that includes cached tokens. Two
harnesses can have the same window total but very different request
distributions and observed maxima. Production history output must not call the
maximum a provider limit or a full prompt-plus-output peak, and must not use it
as an automatic bloat verdict.

## Still Open

- The static output repeats conditional contributors and the derived maximum
  path. Production formatting should decide whether to keep both or collapse
  the contributor list behind a path summary.
- The prototype uses synthetic ASCII text, so the UTF-8 character/byte
  difference still needs a real fixture during implementation.
- The prototype does not exercise missing history stores, malformed records, or
  actual repository discovery. Those remain implementation and integration-test
  concerns.
