// Deterministic `log.md` renderer: merge the event buckets of every session file
// into one flat, timestamp-ordered stream. Pure (no I/O) so it is unit-testable.
// The artifact contract lives in skills/archive/thread-log/ARTIFACTS.md.

// The five event buckets, by their Title-Case session-file header → lowercase log tag.
// State buckets (Intent & Vision, Artifacts Touched, Sources) never reach the log.
const EVENT_TAGS: Record<string, string> = {
  Decisions: "decision",
  Learnings: "learning",
  "Mistakes Fixed": "mistake_fixed",
  Issues: "issue",
  "Open Questions": "open_question"
};

interface LogEntry {
  timestamp: string;
  tag: string;
  citation: string;
  content: string;
}

// `renderEventLog(files)` → the full `log.md` body. `files` are raw session-file
// contents; order does not matter (entries are sorted strictly by timestamp).
export function renderEventLog(files: readonly string[]): string {
  const entries: LogEntry[] = [];
  for (const file of files)
    for (const bullet of eventBullets(file)) {
      const entry = parseBullet(bullet.text, bullet.tag);
      if (entry) entries.push(entry);
    }
  // Strict timestamp order; Array.sort is stable, so equal timestamps keep
  // file-then-bullet order. Sessions overlap in time — that is expected.
  entries.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  return entries
    .map((entry) => `- [${entry.timestamp}] ${entry.tag} (${entry.citation}): ${entry.content}`)
    .join("\n");
}

// Walk a session file and yield each event-bucket bullet with its log tag.
// Bullets under state buckets or above the first header are skipped.
function eventBullets(file: string): { tag: string; text: string }[] {
  const out: { tag: string; text: string }[] = [];
  let tag: string | null = null;
  let buffer: string | null = null;
  const flush = () => {
    if (buffer !== null && tag) out.push({ tag, text: buffer.trim() });
    buffer = null;
  };
  for (const line of stripFrontmatter(file).split("\n")) {
    const header = /^##\s+(.+?)\s*$/.exec(line);
    if (header) {
      flush();
      tag = EVENT_TAGS[header[1] ?? ""] ?? null;
      continue;
    }
    if (/^-\s+/.test(line)) {
      flush();
      if (tag) buffer = line;
      continue;
    }
    if (buffer !== null) {
      if (line.trim() === "") flush();
      else buffer += ` ${line.trim()}`;
    }
  }
  flush();
  return out;
}

// Drop a leading `---` … `---` YAML frontmatter block so its quoted values
// (which can contain `## ` or `- ` text) never feed the bucket parser.
function stripFrontmatter(file: string): string {
  if (!file.startsWith("---")) return file;
  const close = file.indexOf("\n---", 3);
  if (close === -1) return file;
  const newline = file.indexOf("\n", close + 1);
  return newline === -1 ? "" : file.slice(newline + 1);
}

const BULLET_RE = /^-\s+\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\s*(.*)$/s;
// A citation carries a middle dot (`·`), which distinguishes it from any other
// trailing parenthetical: `(<id> · turn N)` or `(<id> · <part-id>)`.
const CITATION_RE = /\s*\(([^()]*·[^()]*)\)\s*$/;

function parseBullet(text: string, tag: string): LogEntry | null {
  const bullet = BULLET_RE.exec(text);
  if (!bullet?.[1] || bullet[2] === undefined) return null;
  const cite = CITATION_RE.exec(bullet[2]);
  if (!cite?.[1]) return null;
  return {
    timestamp: bullet[1],
    tag,
    citation: cite[1].trim(),
    content: atomicize(bullet[2].slice(0, cite.index))
  };
}

// The log carries atomic references, not detail — the detail stays in the session
// file. Drop bold markers, collapse whitespace, and keep the headline sentence.
function atomicize(text: string): string {
  return firstSentence(text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim());
}

// Common abbreviations whose trailing period is not a sentence end.
const ABBREV = /(?:^|\s)(?:e\.g|i\.e|vs|etc|approx|no|inc|cf|al|dr|mr|ms|st)\.$/i;

function firstSentence(text: string): string {
  const boundary = /[.!?]\s+(?=[~"“($]*[A-Z0-9])/g;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(text)) !== null) {
    const upto = text.slice(0, match.index + 1);
    if (ABBREV.test(upto)) continue;
    return upto;
  }
  return text;
}
