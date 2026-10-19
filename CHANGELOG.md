# Changelog

What changed in each released version of pi-toolbox. Versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1] - 2026-10-19

### Added

**Background jobs on the row that started them.** A `process start` call
(pi-processes) finishes in milliseconds while the process it started runs on, so
the row used to say `✓ … 0.0s` and the process's life showed up as separate
`[process] …` messages further down. The row now tracks the process:
`◐ process ticker  running 12s · READY matched`, changing in place to
`✓ … exited 0 · 20s`, `✗ … exit 1 · 3s` or `⊘ … killed SIGTERM · 3s`. A running or
failed job keeps its row under a folded summary, which spins and counts them
(`▸ 5 calls · … · ◐ 1 running`); failed jobs count toward `N failed`.

The job's notification messages are no longer drawn once its row shows them —
pi-processes still delivers them to the model, toolbox only skips drawing them;
a job without a row (one started from `/ps`) keeps its messages. A reloaded
session is rebuilt from those persisted messages, and a job pi-processes no
longer knows (a session from an earlier pi) reads `not running` instead of
spinning forever. The spinner turns once a second for a job's first five
minutes, then stands still and the clock ticks once a minute, so a dev server
left running for hours doesn't repaint the transcript every second.

This is an adapter: pi has no notion of background jobs, so `background-jobs.ts`
has a small provider interface and pi-processes (its `processes:*` event
protocol and `ad-process:notification` messages) is the first provider. If that
protocol changes, rows simply go back to plain tool rows. New options
`backgroundJobs` and `hideJobNotifications` (both default `true`).

### Fixed

**A quick call flashed a row under the summary.** A folded group shows the row
of a call that is still running — so a call that ran for 40 ms popped out under
`▸ 4 calls` and folded back a frame later, and a `process start` stopped within
a second did the same. A running call (or job) now gets its row, and its
`running …` mention in the summary, after one second; long commands still
surface, quick ones never move. Likewise a step still streaming its thinking in
the middle of a group no longer flashes `Thinking...` under the summary before
its tool call arrives; at the start of a turn, with nothing folded yet, the label
still shows.

The README's "No mouse handling" section described a design removed long ago
and contradicted the click support; it's rewritten, along with the broken
screenshot placeholder and a duplicate border-color bullet.

## [0.4.0] - 2026-10-19

### Added

**Grouped tool calls: one line per assistant segment, three levels deep.** A reply
that ran six tools used to cost six boxes; it now costs one line —
`▸ 6 calls ·  bash×4  read×2 · 1.2s` — with the per-tool icons toolbox already
uses for call rows. Clicking the line turns it into a `▾` header with exactly one
row per call under a `│` gutter
(`│ ✓ bash  cd ~ && python3 - <<'PY' (+26 lines)  0.1s`); clicking a row opens that
call's full box (still on the gutter, so it's clear which group it belongs to),
clicking the box folds it back into its row, and clicking the `▾` header folds the
whole group — boxes included — back to its summary line.

Edits and writes never fold. Their diff is the thing you want to see, so they keep
pi's own box and end the group before them; the calls after an edit start a new
group, which keeps the transcript in order. New `alwaysShowTools` option (default
`["edit", "write"]`, `[]` folds everything).

A group is everything between two boundaries: a user message, or an assistant
message with visible text. The text always renders, so a reply that drifts is
still visible, and each segment keeps its own summary. pi gives every model step
its own assistant message, and a step that only calls a tool has no text — those
steps don't split the group, and their `Thinking...` label folds away with it,
reappearing next to that call's box when you open it. The running tool keeps its
own row under the summary so a long command doesn't look frozen.

Running and failed calls keep their own row under a folded summary — a failure
should never hide inside `▸ 6 calls` — and the summary counts them
(`▸ 6 calls · … · 1 failed · 1.2s`). Clicking any row opens that call's box,
including those two under a folded summary. Every row also says what the call
produced, Claude Code style: `12 lines`, `3 matches`, `no files`, `exit 1` for the
built-in tools (truncated output reports the original total); other tools get no
note rather than a guessed one.

`ctrl+o` expands every box (thinking included, like pi's native transcript), and
pressing it again folds every group back to its summary line; pi's own click on a
full box folds just that box. Membership is derived at render time from transcript
order, so groups survive a session reload without persisting anything. New
`groupTools` option (default `true`).

### Changed

**Requires pi ≥ 1.1.0** (peer dependencies were `*`). Component mouse events
arrived in 0.86 and tool durations in 1.1.0; on anything older the groups can't
be opened and the summary has no times. The dev dependencies moved from 0.82 to
1.3, so the tests now run pi's real click dispatch instead of a stand-in — the
stand-in is how a `button: "left"` vs `0` mismatch went unnoticed.

**Settings apply on `/reload`.** The prototype patches are installed once per
process, and used to keep the options of the first load; a reload's new settings
(including `enabled: false` and `frameMessages: false`) were silently dropped.
The patches now read their options from a global slot each load updates.

**Bash call rows collapse to one line by default.** The call row rendered the
command verbatim, so a heredoc (`python3 - <<'PY'` plus forty lines of body) or a
long `&&` chain filled the box before the command had even run, pushing every
previous tool call off screen. The collapsed row now shows the first line only,
cut at 100 characters (pi's own `COLLAPSED_ARGS_CHARS`, so bash folds like every
other tool), followed by `(+N more lines, ctrl+o to expand)`. `ctrl+o` still
gives the whole command back.

**Collapsed result previews shrank to one line too.** pi's bash renderer caps the
collapsed output at a hard-coded `BASH_PREVIEW_LINES = 5` with no setting, so even
a one-line command cost five output rows. The collapsed view now keeps a single
row and `ctrl+o` still brings back all of it. New `bashResultLines` option (default
`1`, `0` hides output until expanded) — applied by lowering the budget on the
`VisualLinePreview` pi built, so timers, truncation warnings and image fallbacks
stay pi's own.

`frame.ts` is split by job (`frame-draw.ts`, `tool-frame.ts`, `tool-group-view.ts`,
`message-frame.ts`); it keeps re-exporting the same API.

### Fixed

**Clicking a framed box toggled the wrong row — or nothing at all.** pi maps a
click on a box through its own unframed layout, and for `renderShell: "self"`
tools (edit, and MCP tools via pi-mcp-adapter) through a height that only pi's
own render records; toolbox replaces that render, so those clicks were always
dropped. Clicks are now translated through the frame's geometry into the source
component's coordinates and reach pi's own toggle.

`formatBashCallHighlighted(args, theme, options?)` takes the new third argument
(`{ expanded, maxChars, hint }`); omitting it renders the full command, so
existing callers are unaffected. `collapseBashCommand` is exported for tests.

## [0.3.3] - 2026-10-05

### Fixed

**A running tool box no longer freezes on a stale frame.** The frame cache
keyed on `(line count, first line, last line)`; tool boxes are bordered by
constant frame and padding rows, so any change confined to the middle left the
key untouched. A `sleep 580` bash call kept showing `Elapsed 0.0s` until
something else — a click expanding the box — invalidated the cache. The same
hole hid streaming output that stayed on the same number of lines. The cache
now compares the lines it framed, which costs a pointer comparison per row
while `Box`/`Text` hand back their cached arrays. The message and container box
caches, which shared the fingerprint helper, were made sound the same way.

Also: framing no longer writes into the line array `Text` returns from its
cache (`content[0] = row` on an untrimmed array duplicated the kind icon on the
next render).

## [0.3.2] - 2026-09-22

### Removed

**The `collapseAnchor` option and its `(ctrl+o to collapse)` row are gone.**
The row existed because, before Pi 0.86.0, the only way to close one expanded
box was `ctrl+o` collapsing every box at once. Pi now toggles a single tool
box (and compaction/branch/skill message boxes) on a click anywhere in its
content, so the anchor row is redundant. A `toolbox.collapseAnchor` key in
`settings.json` is ignored.

## [0.3.1] - 2026-09-20

### Fixed

**File icon placement for home-relative paths.** pi's `renderToolPath`
shortens `$HOME` to `~` in the display text, so an edit on
`~/.pi/agent/settings.json` never contained the raw args path — the icon
fell back into the prefix (`✏️{} edit ~/.pi/...`) instead of sitting in
front of the path. The matcher now tries both the raw and the `~`-shortened
form.

### Added

**File icons render in their brand colors, with full-set coverage.** The
icon map now contains the complete nvim-web-devicons set — 736 extensions
and 1172 special filenames — each with its brand color applied as a
truecolor escape (TypeScript blue, Rust orange, Go cyan, ...), like lazyvim
and yazi. Unknown extensions fall back to an uncolored generic file icon.
Tool-kind icons (FA glyphs) intentionally stay uncolored; they follow the
call row.

### Changed

**The call row drops the tool-name word for file tools.** With the kind
icon in front, ` 󰛦 edit ~/x.ts` reads choppier than
` 󰛦 ~/x.ts` — the word is redundant, so read/edit/write rows are
just `kind icon + file icon + path`. Rows that don't start with the tool
name are left untouched.

## [0.3.0] - 2026-09-19

### Added

**Message boxes get the same rounded transparent frame as tool boxes, each
kind in its own border color.** User messages, compaction and branch
summaries, skill invocations, and extension custom messages previously kept
pi's default filled-background bars, since they never go through
`ToolExecutionComponent`. Their components are now patched the same way.
User messages keep their OSC 133 zone markers, and custom messages rendered
by an extension-provided renderer are left untouched — the renderer owns its
styling.

**Tool boxes can take per-tool border colors and Nerd Font icons.** A
successful box uses its tool's configured color instead of green (pending
stays grey, errors stay red, unlisted tools take the theme accent), and every
box's call row leads with a kind icon — file tools put the target file's
nvim-web-devicons glyph right in front of the path (`write /tmp/x.ts`
renders `  write 󰛦 /tmp/x.ts`).

New settings under `toolbox`: `frameMessages` (default `true`) toggles the
message frames; `frameUserMessages` (default `false`) opts user messages in
— they are skipped by default because pi-starline patches the same
prototype, and two render patches on one prototype fight over the output;
`icons` (default `true`, requires a Nerd Font) toggles the icons;
`toolColors` maps tool names to success border colors (replaces defaults
when set); `messageBorderColors` picks a border color per message
kind — `user` (`toolTitle`), `compaction` (`customMessageLabel`), `branch`
(`mdCode`), `skill` (`accent`), `custom` (`warning`). Values are theme fg
color names, so they follow the active theme; tool boxes keep their
status-driven grey/green/red.

## [0.2.3] - 2026-09-18

### Fixed

**Bash syntax highlighting can no longer freeze the whole interface.** A `#`
that was neither at the start of a word nor inside quotes — `fill:#242f60`,
`a#b`, `url#frag` — was treated as a word break that no branch handled. The
scanner stopped advancing and pushed empty strings until the process ran out of
memory. Because the call row is re-rendered on every tool-argument delta, a
streaming command containing one of these deadlocked the TUI: 100% CPU, no
repaint, `ctrl+c` unresponsive, and the session file stopped updating. The
process could not recover on its own and survived closing the terminal tab.

Bare `\r` and other non-space whitespace (`\u00a0`, `\v`, `\f`) reached the same
dead end, because they are word breaks too.

The tokenizer now keeps a mid-word `#` inside the word, and the scanner can
never loop without consuming a character — an unhandled break character is
emitted as plain text instead of spinning. `test/bash-highlight.test.ts` covers
the reported shapes, a heredoc with a hex colour, and 400 randomized inputs
containing `#`, `\r` and non-ASCII spaces; every case asserts termination (a hang
is detected by a worker deadline) and that no character is dropped.

## [0.2.2] - 2026-08-10

### Added

**A collapse anchor row inside expanded tool boxes.** When a tool box is
expanded, the frame now ends with a `(ctrl+o to collapse)` row. With
[pi-starline](https://github.com/Andy8647/pi-starline) installed the row is
clickable (click it to collapse the box again); without Starline it reads as
an ordinary keyboard hint — `ctrl+o` really does collapse the box in Pi.
Set `toolbox.collapseAnchor: false` to opt out of the row entirely.

The anchor row is painted by Starline's `expandHintAction` matching it, so
neither extension needs to know about the other.

## [0.2.1] - 2026-07-26

### Changed

- Tool boxes stand down when another extension owns the mouse; clicking to
  expand a box is now opt-in rather than the default.

## [0.2.0] - 2026-07-26

### Added

- Rounded, status-aware tool box frames with bash highlighting.
- Click a tool box's border to expand just that box.

### Removed

- The fixed-editor-era click-to-expand that required Starline's compositor.
