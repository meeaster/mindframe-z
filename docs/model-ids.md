# Model Identification Reference

How models are identified and configured in **Claude Code** and **OpenCode** —
model names, aliases, effort levels, and variants.

## Claude Code

### Model names

| Provider               | Format                             | Examples                                                                                                     |
| ---------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Subscription / API     | alias or full name                 | `sonnet`, `haiku`, `opus`, `claude-sonnet-4-6`, `claude-opus-4-8`, `claude-haiku-4-5`                        |
| Amazon Bedrock         | inference profile or base model ID | `us.anthropic.claude-sonnet-4-6`, `us.anthropic.claude-opus-4-8`, `anthropic.claude-haiku-4-5-20251001-v1:0` |
| Google Vertex AI       | full model name                    | `claude-opus-4-8`, `claude-sonnet-4-6`                                                                       |
| Microsoft Foundry      | full model name                    | `claude-opus-4-8`, `claude-sonnet-4-6`                                                                       |
| Claude Platform on AWS | full model name                    | `claude-opus-4-7`                                                                                            |

**Aliases** resolve to the latest recommended version for your provider and update
over time:

| Alias        | Behavior                                             |
| ------------ | ---------------------------------------------------- |
| `default`    | Clears any override; reverts to account-type default |
| `best`       | Fable 5 where available, otherwise latest Opus       |
| `fable`      | Claude Fable 5 (hardest tasks)                       |
| `sonnet`     | Latest Sonnet (daily coding)                         |
| `opus`       | Latest Opus (complex reasoning)                      |
| `haiku`      | Fast Haiku (simple tasks)                            |
| `opusplan`   | Opus in plan mode, Sonnet for execution              |
| `sonnet[1m]` | Sonnet with 1M-token context window                  |
| `opus[1m]`   | Opus with 1M-token context window                    |

On the Anthropic API, `opus` resolves to Opus 4.8 and `sonnet` to Sonnet 4.6. On
Bedrock, Vertex, and Foundry, `opus` resolves to Opus 4.6 and `sonnet` to Sonnet
4.5; newer versions are available by using the full model name or setting
`ANTHROPIC_DEFAULT_*_MODEL` environment variables.

**Bedrock** requires `CLAUDE_CODE_USE_BEDROCK=1` and `AWS_REGION`. Model IDs use
cross-region inference profile prefixes (`us.`, `eu.`, `apac.`) or base model
IDs (`anthropic.claude-sonnet-4-6`). Pin versions with:

```
ANTHROPIC_DEFAULT_OPUS_MODEL='us.anthropic.claude-opus-4-8'
ANTHROPIC_DEFAULT_SONNET_MODEL='us.anthropic.claude-sonnet-4-6'
ANTHROPIC_DEFAULT_HAIKU_MODEL='us.anthropic.claude-haiku-4-5-20251001-v1:0'
```

**Model selection** (priority order):

1. `/model` during session
2. `claude --model <name>` at startup
3. `ANTHROPIC_MODEL` environment variable
4. `model` in settings file

### Effort levels

| Model                       | Levels                                  |
| --------------------------- | --------------------------------------- |
| Fable 5, Opus 4.8, Opus 4.7 | `low`, `medium`, `high`, `xhigh`, `max` |
| Opus 4.6, Sonnet 4.6        | `low`, `medium`, `high`, `max`          |

Default is `high` (or `xhigh` on Opus 4.7). If you set a level the active model
does not support, Claude Code falls back to the highest supported level at or
below what you set.

`ultracode` is a Claude Code workflow setting (not a model effort level) that
sends `xhigh` and orchestrates dynamic workflows.

**Effort selection** (priority):

1. `CLAUDE_CODE_EFFORT_LEVEL` environment variable
2. `/effort` command or `--effort <level>` flag
3. `effortLevel` in settings file
4. Skill/subagent frontmatter `effort` field

Use `auto` to reset to the model default. `max` is session-only unless set via
`CLAUDE_CODE_EFFORT_LEVEL`.

## OpenCode

### Model names

Format: `provider/model-id`

```bash
opencode models              # list all available models
opencode models openai       # filter by provider
opencode models --verbose    # show full metadata including variants
```

The `--verbose` flag outputs each model's JSON metadata, including the `variants`
object listing supported variant names and their `reasoningEffort`:

```json
{
  "id": "deepseek-v4-flash-free",
  "providerID": "opencode",
  "variants": {
    "low": { "reasoningEffort": "low" },
    "medium": { "reasoningEffort": "medium" },
    "high": { "reasoningEffort": "high" }
  }
}
```

This is the authoritative way to discover which variants a model supports.
Models without reasoning support show `"variants": {}`.

Examples:

- `opencode/deepseek-v4-flash-free`
- `opencode-go/deepseek-v4-pro`
- `openai/gpt-5.4`
- `openai/gpt-5.4-mini`
- `anthropic/claude-sonnet-4-5`

**Model selection** (priority order):

1. `/model` during session
2. `opencode --model <provider/model>`
3. `model` in `opencode.json`
4. `opencode run --model <provider/model>`

A `small_model` in `opencode.json` configures a cheaper model for lightweight
tasks like title generation.

### Variants

Built-in variants map to `reasoningEffort` at the provider level. Names vary by
provider:

| Variant   | Meaning                         |
| --------- | ------------------------------- |
| `none`    | No reasoning                    |
| `minimal` | Minimal reasoning               |
| `low`     | Low reasoning effort            |
| `medium`  | Medium reasoning effort         |
| `high`    | High reasoning effort (default) |
| `xhigh`   | Extra high reasoning effort     |
| `max`     | Maximum reasoning budget        |

Pass `--variant <name>` to the CLI. Custom variants can be defined in
`opencode.json`:

```jsonc
{
  "provider": {
    "openai": {
      "models": {
        "gpt-5": {
          "variants": {
            "high": { "reasoningEffort": "high", "textVerbosity": "low" },
            "low": { "reasoningEffort": "low", "textVerbosity": "low" }
          }
        }
      }
    }
  }
}
```

Use `ctrl+t` in the TUI to cycle variants. Use `ctrl+o` to toggle thinking-block
visibility.

## Quick comparison

|                   | Claude Code                                            | OpenCode                                           |
| ----------------- | ------------------------------------------------------ | -------------------------------------------------- |
| Model format      | `claude-opus-4-8` or alias `opus`                      | `provider/model` e.g. `openai/gpt-5.4`             |
| List models       | `claude` starts with available models                  | `opencode models`                                  |
| Set at launch     | `claude --model <name>`                                | `opencode --model <provider/model>`                |
| Reasoning control | `--effort low\|medium\|high\|xhigh\|max`               | `--variant low\|medium\|high\|max`                 |
| Persist in config | `model` and `effortLevel` in `~/.claude/settings.json` | `model` and provider variants in `opencode.json`   |
| Toggle reasoning  | `/effort` or `Option+T` / `Alt+T`                      | `ctrl+t` (cycle variant), `ctrl+o` (show thinking) |
| Small/fast model  | `haiku` alias (or `ANTHROPIC_DEFAULT_HAIKU_MODEL`)     | `small_model` in `opencode.json`                   |
