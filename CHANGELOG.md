# Changelog

What changed in each released version of pi-tidy (published as
`@andy8647/pi-toolbox` up to 0.4.1). Versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.1] - 2026-10-30

### Changed

**A row you can click shows a hand.** The band that lights a clickable row under the pointer now comes with the
pointer shape to match: tidy asks the terminal for a hand (OSC 22) while a row is lit and for the arrow again when
none is, and puts the arrow back before pi leaves the alt screen. Ghostty, kitty, foot and WezTerm draw it; other
terminals ignore the sequence.

**A `codemode` box reads as its call list with grouping off, too.** 0.6.0 built the call list into the group:
with `groupTools: false` the box was still pi's own — ten lines of script, the last eight calls, the head of the
output and a `Took` row. Now it is the same list in a frame of its own: the row a group would show for the call
(`✓ codemode bash×3 read×1  1 failed · 0.1s`) as its title, every call the script made, and the script and the
output folded to one row each that open on click and light up under the pointer. `ctrl+o`, or a click anywhere
else in the box, opens both. The list is drawn from a second, expanded rendering of pi's own renderer, so
nothing is cut short and pi's box is left as it was. The same goes for a grouped session with `codemode` in
`alwaysShowTools`. Each box keeps its list until something in it changes: 0.6.0 re-decorated every framed
`codemode` box on every frame, which on a session of 300 scripts cost about 38 ms a frame; it is under 2 ms now.

**Thinking is tidy's row with grouping off, too.** The thinking row was wired into grouping, so with
`groupTools: false` every step left pi's bare `Thinking...` floating over its box. The row has nothing to do with
folding calls: with grouping off each step's thinking is now the same `thinking` row a message that writes text
gets inside a group — the brain, one line of what it thought, a click to open it in its box — and the step loses
pi's padding rows the way it does with grouping on.

### Fixed

**bash's `Command exited with code N` trailer comes off a failed call inside a script.** 0.6.0 said so, but
it only matched the row without pi's box around it: drawn for real, the row is one cell further in, and the
trailer stayed, two blank rows above it.

**Long sessions scroll smoothly again.** pi's fullscreen mode draws the whole transcript on every frame — every
wheel tick, every streamed token, every hover change — and three things tidy draws were rebuilt from scratch each
time. Edit boxes were the worst: the side-by-side diff had a cache with room for one diff, so with more than one
edit in the transcript each box pushed out the one before it, and every frame re-parsed and re-highlighted every
diff in the history. The lag grew with the number of edits, which is why only long sessions felt it. On a
1,500-message session with 121 edits a scroll frame took about 50 ms (pi on its own: under 1 ms); it takes about
1.4 ms now. The diff is kept per box, and so are each group's summary line and each message's thinking rows, each
rebuilt only when what it shows changes. Nothing looks different.

**…and with every box open, too.** With `ctrl+o`'s expand-all on, each opened call's rows went through a
trailing-whitespace regex that is quadratic on a padded row (the padding is followed by a colour reset, so it
never sits at the end), and the same session took about 250 ms a frame. It is about 24 ms now, with nothing
looking different.

## [0.6.0] - 2026-10-30

### Changed

**A `codemode` row says what its script ran.** Nested tool calls never become tool rows of their own, so the
folded row used to show only the script's first line. It counts them now: `codemode bash×3 read×1  0.1s`, growing
while the script runs, with a red `1 failed` when a call inside the script failed and the script caught it and
still succeeded.

**Inside the box, the nested calls read like tidy's rows.** pi draws them with the arguments as compact JSON;
they now carry the same kind icon as the outer rows, and the arguments become the same one-line summary
(`pwd`, `src/app.ts`, `(+12 lines)` for a multi-line one), read back from `result.details.calls`: JSON when the
200-character clip survived it, the surviving key when it did not, pi's own text when neither works. bash's
`Command exited with code N` trailer is dropped from a nested failure, where the error above it already says
what happened.

**The body opens as a call list.** Inside a group, a `codemode` box no longer dumps the script and the output:
the script folds to `▸ script · 13 lines` and the output to `▸ output · 4 items`, each opening in place on
click (and lighting up under the pointer, like every other row), with a dim rule between the sections and a
rail of its own down the body. The call rows take a name column and a duration column, and a nested
`process start` hangs inside the body with them. A script that called nothing folds the same way, using the
output's first marker (`==> text N/M <==`, `<console_output>`, `Script error:`) as the boundary. Nothing wraps
onto a second row: an argument that does not fit is clipped, and the duration is the part that never gives way.
pi's `Took` row is gone, since the row above the body carries the time. The output stays one block: a script
builds its `text()` items from whatever it computed, so an item can be a filtered, merged summary of several
calls and nothing ties it back to the call that fed it.

**`bash` takes the md-console glyph.** `fa-terminal` is missing from some monospace Nerd Fonts and drew as a
blank; `\u{f018d}` renders wherever the rest of the set does. The file-type map's `bash` entry was still on
codicons' terminal glyph, so shell files and the `bash` tool now agree.

**Group rows share a name column.** A call's arguments used to start wherever its name ended, so a list of
`bash` and `read` and `process` rows had a ragged left edge. The name is padded to the widest one in the group
(capped at 14 cells, so one long MCP name cannot push everything out of reach), and a thinking row's label
pads the same way so its text starts in that column too.

### Fixed

**No blank row above a framed message box.** pi inserts a `Spacer(1)` before a user message and before the
compaction, branch and skill boxes, and the frame added an empty row of its own on top of it: the box floated
one row below the transcript, and for the summary boxes that turned pi's filled padding row into a second blank
one. The top border is the first row now, for all four (the user message's `OSC 133` zone marker moved with it).
Custom messages keep the spacer, because pi puts no spacer in front of those and it is the only separation they
have.

**A click on message text lands where it is drawn** ([#30](https://github.com/Andy8647/pi-tidy/pull/30), by
@s5unty). Trimming the message edges and restyling a thinking run changed the layout, but the mouse regions
kept using the untrimmed one: an interactive Markdown element such as pi-code-render's `[COPY]` had a click
target a few rows off, and a click outside a thinking run was swallowed instead of reaching the Markdown, which
left raw code unfoldeable. Rendering and hit testing now go through the same component tree, with one
coordinate transform for the trimmed rows.

## [0.5.0] - 2026-10-30

### Changed

**User messages are tidy's now, in a frame that hugs them.** pi-starline used to restyle user messages, tied to its
editor switch: turning Starline's input box off sent the transcript's prompts back to pi's filled block. They are
tidy's to draw now, independently of Starline, and by default (`userMessageStyle: "frame"`) in tidy's rounded frame,
as wide as the text plus its inset — a one-word prompt gets a small box, a long one stops at the screen's width —
with the user icon set into the top border (`╭─  ───╮`), so the text starts clean and copies without it. The
border is `messageBorderColors.user`.

`"rail"` keeps the look pi-starline drew: a full-width rule above and below, an accent `│` and (with `icons`) the
user icon in front of the text, later rows hanging under it; `userMessagePaddingY` and `userMessageColors` (`rail`,
`rule`; theme names or `#rrggbb`) tune it. `"off"` leaves pi's look. Both styles render pi's own Markdown child, so
markdown transformers keep working. `frameUserMessages` is no longer read: `true` asked for what is now the default.
pi-starline 0.9 drops its own version; with an older pi-starline, Starline's still draws on top.

**Your own `!` commands get a frame, marked as yours.** pi drew `!` / `!!` runs between two full-width `bashMode`
rules, which read like the agent's bash box without its frame. Under `frameMessages` they now get tidy's rounded frame
with the user icon, the `!` or `!!` that was typed in place of `$`, and the user messages' color — the agent's bash
box changes color with its state, this one does not, and pi's own `Running...` / `(exit N)` / `(cancelled)` rows report
the outcome. `!!` stays dim. The 20-row preview and `ctrl+o` are pi's, unchanged.

## [0.4.14] - 2026-10-28

### Fixed

**Background jobs started through codemode are tracked too.** Nested `process start` calls now keep
independent status rows under their calling tool, including multiple processes started by one script.
Completion and log-match notifications fold into those rows instead of appearing separately. A script
failure does not discard jobs it already started, and saved associations survive session restoration.
Direct starts and processes without a corresponding row keep their existing behaviour.

**Each nested process has its own hover and expand target.** Clicking a process no longer expands
codemode. It opens that process's command, working directory and the last 20 output lines; expanded
logs update as output arrives. Closing one process leaves its siblings and the script unchanged.
The group header and collapse-all close child details too. Unavailable logs are reported explicitly,
and process output is stripped of terminal control sequences before display.

## [0.4.13] - 2026-10-27

### Fixed

**The group header keeps its click when a thinking run above it is expanded.** `installCarrierMouse` answered an
expanded run before it looked at which row was hit, and the summary line is drawn by the same component, so
clicking `▾ 3 calls` folded the run instead of shutting the group: the header stayed `▾` and the reasoning
disappeared. The fold now only answers on the run's own rows.

## [0.4.11] - 2026-10-24

### Fixed

**A user message keeps its own padding while tools are folded.** Grouping trims the blank rows pi pads every
message with, so a folded group sits against the line above it. A user message is not one of those: it is a
filled box whose first and last rows are padding *with a background fill*, not empty rows, and the trim
stripped them as well — the highlighted bubble hugged its text on both sides and the `▸ 2 calls` header
pressed against it. The boundary wrapper gained an `untrimmed` branch, and the messages that are pi's own
padded boxes (user, plus custom in the same shape) take it. Assistant steps keep their edges compacted
around a group, which is what the compacting was for.

No setting was added: keeping the padding is now the only behaviour, because the tight version was a
mistake for messages rather than a preference.

Reported by @bumaociyuan (#17) and @frostime (#19); the fix is @bumaociyuan's `untrimmed` change from #18.

**Settings are read from the native home directory.** Before `PI_CODING_AGENT_DIR`, the fallback was
`${HOME}/.pi/agent` with `/tmp` behind it, so a Windows session without `HOME` looked in `/tmp/.pi/agent` and
silently ran on defaults. It asks `os.homedir()` now, which is right on Windows too.

## [0.4.10] - 2026-10-23

### Fixed

**A multi-line argument no longer paints the rows below it off by a line.** A row is one string in the lines
array the renderer hands back, and the summary took a call's `command` apart at its first newline but passed
every other argument through whole. So a tool whose first string argument is a script
(`chrome-devtools_evaluate_script`'s `function`, most MCP tools) returned a "row" with real newlines in it:
the terminal drew four physical rows where pi's frame counted one, and every row below painted off by the
difference. What you saw was the last few lines of a script sitting in the middle of the transcript, with
`Working` wedged between them and the durations stranded on their own rows.

Every argument now goes through the same rule: first line, then `(+N lines)` for the rest, trimmed. That is
also what the collapsed row has always claimed, so a script now reads as `evaluate_script () => { (+3 lines)`.

## [0.4.9] - 2026-10-23

### Fixed

**A thinking row no longer takes the whole message with it.** An assistant step streams as a carrier and
becomes the group boundary when its text arrives, and the click handler installed while it was a carrier
stayed on the component: it answered "this is my row" for every `y`, and consumed the click. So on any
message that had streamed its thinking, clicking the text (a fenced code block included) opened the
reasoning instead of reaching what was under the pointer. The handler now records the rows it actually
drew each frame and hands everything else back to the handler it replaced.

**One row under a thinking row no longer toggles it.** pi places its own regions on the untrimmed
layout, and the padding rows this extension trims away move every row by one, so a click on the first
line below a run landed on pi's hidden label. The runs are ours once restyled — the click table covers
every one of them, open or shut — so a click that misses them all now falls through instead.

## [0.4.8] - 2026-10-23

### Added

**Thinking is a row inside the group, and it stays live while it arrives.** A model step that only
thinks and calls a tool used to vanish when you opened a group: its `Thinking...` label was hidden, so
the transcript showed the call but nothing about the reasoning behind it. Now that step is a `thinking`
line under the `│` gutter — a brain, the word, then one line of what the model actually thought, above
the call it belongs to and in transcript order, at one consistent height whether the group is folded or
open. The summary line counts the runs (`▾ 5 calls · bash×3 · 🧠 4 thoughts · 1 failed · 1.3s`),
which while folded is the only sign the reply did any thinking at all.

- While a run is still arriving, the group keeps one line beneath the summary: a sliding window over the
  *tail* of that thinking, so the newest words are what you see and the row takes the full width. It
  moves on a 300ms tick rather than per frame — pi repaints ~30x/s, and a window recomputed on every
  paint slides a cell per token, which read as flicker — and the cut lands on a word break. The summary
  says `◐ thinking` while it runs and goes back to `N thoughts` once it stops; the row itself does not
  animate. A message's thinking **outside** a group (the label above its text, or a turn that has not
  called a tool yet) is live on the same terms, except that it has no summary above it, so the row wears
  the spinner itself.
- Live means three things at once: an agent run is open (`agent_start` … `agent_end`/`agent_settled`,
  tracked in a live slot so `/reload` reaches the patches), the message is still streaming, and its text
  grew inside the last 1.5 seconds. Growth is the signal that cannot lie — a run that stops sending
  tokens goes quiet on its own — and a repaint is scheduled for the moment the window lapses, because by
  then pi may have nothing left to paint. A restored session never looks live: a component that arrives
  with its text already finished did not grow in front of us.
- A click on the row opens that step's thinking: pi renders its own text, untruncated, inside the same
  rounded box a tool result gets — the border uses the new `thinkingColor` (default `warning`). Another
  click folds it back. pi's `thinkingVisibilityOverrides` is the switch behind it, so pi's own click and
  ours cannot disagree about what is open. A message that is nothing but thinking toggles on any click,
  and the hit map is shifted with the rows when padding is trimmed — pi's own region measures the
  untrimmed layout.
- A message with both thinking **and** text is the group boundary, and its `Thinking...` label used to
  float above the text as bare italic. It now wears the same row — same colour, same format, same
  preview — right where pi draws it, above the text. Its run is **not** added to the group's count: the
  group lists only the runs it folded, and counting one that renders above the text would promise a row
  that opening the group cannot show.
- The summary line of an open group is carried by the leading thinking row when there is one — a carrier
  renders *before* its own call, so the header would otherwise land under it. Folded, the first call
  still carries the line, which keeps the group's first frame from being blank.
- pi's `hideThinkingBlock` setting is deliberately ignored: the row is the same whether the setting is
  on or off, and a click is the one way to read the text. One behaviour, not two.
- The brain is `nf-md-brain`, **U+F09D1** — not the emoji 🧠, which is in no monospace Nerd Font and
  falls back to a two-cell colour glyph that breaks the row it sits in. The preview is capped at **56
  cells**: filling the row turned a glance into a paragraph wedged between the calls.

### Changed

**An opened call keeps its row.** It used to *become* a box: the row vanished and a framed block took
its place, which made a group hard to follow — the thing you clicked disappeared. Inside the group the
rail already says what belongs to what, so a box there was a frame inside a frame. Now the row stays
where it is (the anchor never moves), takes a tick off the rail (`├─`) and its output hangs underneath —
without repeating the command, which the row already spells out. Boxes are kept where they earn their
keep: an `edit`/`write` call (never folded into a group), and a message's own thinking outside one —
where the expanded run now keeps its `thinking` title above the box.

**The metrics sit in columns.** `1 line` / `12 lines` and `2.0s` / `0.1s` used to start wherever the
arguments happened to end, so a group read as a ragged block of numbers. The note and the duration are
now padded to the group's widest of each and the whole tail is right-aligned, so every row ends on the
same cell.

**No padding rows left anywhere in the transcript.** The gaps were not the box's spacer but pi's own
message padding: a user message draws a blank row above and below its text, and an assistant text
message starts with a `Spacer`. Every message block is now trimmed at both edges — a reply sits directly
under the prompt, and a group line directly under the text that introduced it. The OSC 133 zone markers
that ride on those dropped rows move onto the rows that survive, so shell integration (prompt placement,
`Ctrl+Shift+Up`) is unaffected.

### Fixed

**A tool row now spends the terminal's width on the command.** The argument column was a fixed 60 cells
and the row was cut at the right edge afterwards, which meant on a narrow terminal the
`51 lines · 1.6s` went first and a chopped command stayed behind — and on a wide one the command was
still cut at cell 60 with 80 cells of row left empty. The row now measures what it has: the arguments
fill the space left after the tail, the `(+12 lines)` marker is dropped before the command is shortened,
and the tail only gives way when there is no room for both.

**A grouped box no longer opens with a blank row.** pi puts a blank line between a call and its output;
under the gutter that read as a hole between the row and the box. Inside a group the blank is dropped
and the click geometry follows it. The split-diff body lost its own blank row under the `↳ diff +N -M`
summary too: a 20-row diff box was spending three of them on air.

## [0.4.7] - 2026-10-21

### Changed

**The copy no longer says "Claude Code-style".** The comparison set the wrong expectations and invited
the wrong argument: the parts that carry this extension — split diffs with word-level emphasis,
failures pinned at level 1 while the rest of the group is folded, live background-job rows, the
per-tool never-fold list — do not exist there. The README, the npm description and the cover now say
what the extension does instead of what it resembles. `claude-code` stays a search keyword, because
that is what people type when they want this interaction.

The cover also shows the split edit diff (`old │ new`) rather than the old stacked one, at 16:9.

## [0.4.6] - 2026-10-20

### Fixed

**Tidy no longer registers any tools, so sandbox extensions can load alongside it.** Registering a
tool under a built-in name is a hard failure in pi (`Tool "write" conflicts with
…/pi-tidy/index.ts`), and Tidy did it for `bash` (to highlight the command row) and, since 0.4.4, for
`write` (to make the preview height a setting). Any extension that legitimately owns those tools — a
sandbox such as pi-playpen, which must wrap execution or lose its enforcement — could therefore not
be installed at the same time. Both now travel as a `pi.registerToolRenderer()` resolver: the
installed tool keeps execution, schema, shell and result renderer, and `next()` hands Tidy the
downstream renderers so the call row can be replaced and the collapsed preview budget lowered on top
of whatever it returned.

- `bash`: the command row is still syntax highlighted and still folds to one line while collapsed,
  and `bashResultLines` still caps the output preview. The `startedAt`/`endedAt` state pi's own
  result renderer reads for its `Took 1.2s` footer is still maintained (we own the call renderer, so
  nobody else would). `highlightBash: false` leaves bash completely untouched.
- `write`: unchanged behaviour, now on top of whichever result renderer is downstream instead of
  pi's built-in one.
- `pi ≥ 1.3` is required for those two features. On an older pi they are skipped and a single warning
  names what is unavailable, and only when the setting was actually changed away from pi's own
  default — someone who never touched `writeLines` is not lectured.

Thanks to @s5unty for the diagnosis, the constraint that made the alternative (asking a sandbox
extension to stand down) unacceptable, and the write half in #8.

## [0.4.5] - 2026-10-20

### Added

**`diffLines`: the edit box's height is a setting.** pi's edit renderer draws the entire diff, collapsed
or not — a large edit owns the screen no matter what `alwaysShowTools` says. The collapsed box now
draws at most `diffLines` rows (default 20), windowed at the *first changed line* with a third of the
budget of context above it, and closes with `… (N more lines, M total, ctrl+o to expand)`. Cutting at
the top of the diff would hide the change itself on a large file, which is why the window follows the
first change instead. `ctrl+o` draws all of it; `0` keeps just the `↳ diff +N -M` summary.

**Hover on folded rows.** Pointing at a group summary line turns `▸` into `▶` and tints the row;
pointing at a call row in an open group lights that row and shows a `›` at its end. The whole row is
the click target, so the whole row lights up. Nothing is consumed — pi still receives the packet and
drag-selection across rows behaves exactly as before — and the band is dropped the moment the pointer
leaves, via a wrapper over the alt screen's mouse handler. Only available with 1003 all-motion
tracking, which pi enables outside tmux/screen; inside a multiplexer the rows simply never light up.

### Changed

**Failures stopped shouting, and stopped taking up room.** A folded group used to hang one red row
per failed call under its summary. In a 50-call reply with two failures that is a three-line "folded"
group — the fold accomplishes nothing — and three reds (`1 failed`, `✗`, `exit 1`) described one probe.
Now level 0 is one line again: the summary carries `2 failed` in red — the colour is the signal, no
cross beside it — and the failed rows wait in level 1 with the rest. Open the group and each failed row shows its own `✗` (the count goes `muted`,
so red appears once at either level), its note in `muted` (`exit 1` is data, not an alarm), and — for a
failure that printed nothing at all (`sed` on a directory, a `test`, anything that only exits
non-zero) — a whole row dropped to `dim` while keeping the red glyph. A timeout or an abort counts as
something to read and keeps full contrast. The expanded box's red border is unchanged.

## [0.4.4] - 2026-10-20

### Added

**Side-by-side edit diffs.** An edit's diff is now two panes, `old │ new`, with line numbers on both
sides, a coloured bar and a tinted row for every changed line, and the changed words emphasised
inside the line. pi hands its edit renderer a unified diff string, so the panes are re-derived from
that string (the rendered lines are not reversible) and the row tint is mixed from the theme's diff
colours — it follows whatever theme is active. Removed and added blocks pair row by row, so a
replaced block reads as before/after instead of two stacked runs. Below `splitDiffMinWidth` (72 by
default) the box keeps pi's unified diff; `splitDiff: false` turns it off entirely.

The frame keeps the tinted rows' background fill and strips every other one, so the box stays
transparent everywhere else.

**`writeLines`: the write preview's height is a setting.** pi's write box hard-codes ten lines of the
written file while collapsed. The tool is re-registered (the same way bash already was) with a
configurable budget: `"writeLines": 10` is pi's number, `0` keeps just the header until `ctrl+o`.
`alwaysShowTools` remains the switch for whether edits and writes show their own box or fold into
the group — `[]` folds both.

## [0.4.3] - 2026-10-19

### Changed

**A cover image, a demo video and screenshots.** The README opens with a cover
and links a 40-second demo; `pi.image` and `pi.video` give the
[pi package gallery](https://pi.dev/packages) a preview instead of a line of
text. The media live in `assets/` on GitHub and stay out of the npm tarball.

## [0.4.2] - 2026-10-19

### Changed

**Renamed to pi-tidy.** `@andy8647/pi-toolbox` said nothing about what the
package does and sat under a personal scope; it is now the unscoped `pi-tidy`,
and the repository is `Andy8647/pi-tidy` (GitHub redirects the old URLs). Swap
the package with `pi remove npm:@andy8647/pi-toolbox && pi install npm:pi-tidy`.
Settings move to a `"tidy"` key; the `"toolbox"` key is still read, so existing
configs keep working. The old package is deprecated with a pointer here.

**Peer dependencies are `*` again**, as pi asks of extensions. 0.4.0 set them to
`>=1.1.0`, but npm treats a peer conflict as an error for the whole install, so
one mismatched range can block every package in pi's directory — an older pi
now gets a warning at session start instead.

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
