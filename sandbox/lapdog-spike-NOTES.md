# lapdog spike notes — 2026-06-28

## Question

How do we inject cost spans into lapdog's local dashboard that actually
render with cost/token metrics?

## Answer — VALIDATED

**Use `POST /v0.4/traces` with msgpack + `meta_struct._llmobs`.**

### What works

The v0.4 trace format carries an `_llmobs` envelope as msgpack bytes inside
`meta_struct`. Lapdog extracts these, synthesizes them as LLMObs spans, and
the dashboard renders them with full metrics — including token counts, cache
breakdown, and cost (nanodollars).

### Wire format

```
POST /v0.4/traces
Content-Type: application/msgpack
X-Datadog-Trace-Count: 1

msgpack([                  # array of traces
  msgpack([                # trace = array of spans
    msgpack({              # span dict
      name: "cost-span",
      service: "claude-code",
      resource: "dispatch",
      span_id: <int64>,
      trace_id: <int64>,
      start: <ns-epoch>,
      duration: <ns>,
      error: 0,
      meta: {},
      meta_struct: {       # KEY: values are msgpack bytes, NOT dicts
        _llmobs: msgpack.packb({
          trace_id: "<32-char-hex>",
          parent_id: "undefined",
          name: "claude-code-request",
          session_id: "<hex>",
          meta: {
            span: { kind: "llm" },
            input: { value: "<prompt>" },
            output: { value: "<response>" },
            model_name: "<model>",
            model_provider: "anthropic",
          },
          metrics: {
            input_tokens: 500,
            output_tokens: 150,
            total_tokens: 650,
            cache_read_input_tokens: 100,
            cache_write_input_tokens: 50,
            non_cached_input_tokens: 350,
            estimated_total_cost: 5400000,        # nanodollars
            estimated_input_cost: 1050000,
            estimated_output_cost: 4350000,
          },
          tags: "env:dev", "ml_app:claude-code" ],
        })
      }
    })
  ])
])
```

### Verified behavior

| Field | Renders? |
|---|---|
| `input_tokens`, `output_tokens`, `total_tokens` | Yes |
| `cache_read_input_tokens`, `cache_write_input_tokens`, `non_cached_input_tokens` | Yes |
| `estimated_total_cost`, `estimated_input_cost`, `estimated_output_cost` | Yes (verbatim) |
| `session_id` | Yes |
| `model_name`, `model_provider` | Yes |

Cost metrics are passed through verbatim from `_llmobs.metrics` — no pricing
table lookup needed. Lapdog's cost computation only runs on the proxy path
(which we're not using), so we must include cost numbers explicitly.

### What does NOT render locally

- `POST /evp_proxy/v4/api/v2/llmobs` (JSON) — forwards to Datadog backend,
  requires DD_API_KEY, does not store locally
- Cost on `/claude/hooks` lifecycle spans — hooks alone carry no cost; spans
  are created with `metrics: {}`

### Implementation path

TS dispatch path already parses usage from the JSON stream (for `runs.json`).
After each dispatch:
1. Build the `_llmobs` payload with token + cost metrics from parsed usage
2. Encode as msgpack trace (needs msgpack lib — node package or shell out
   to `python3 -c ...`)
3. POST to `http://localhost:8126/v0.4/traces`
4. Cost appears in lapdog dashboard alongside hook-created lifecycle spans

Hook events still flow through `/claude/hooks` for the rich lifecycle view.
Cost comes as a separate msgpack trace POST.
