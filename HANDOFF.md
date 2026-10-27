# Handoff — thinking rendering round (0.4.8, released 2026-10-23)

> **0.4.12 已发布（2026-10-26）**：PR #21 squash `5195fd4` → tag `v0.4.12` → `gh release create`，只含一个 bug fix。
> **点击框内任意一行都应该展开，之前只有前几行能点**（0.4.11 起就有，split diff 上线后更明显）。
> 根因：split diff 由我们自绘，pi 的 `selfRenderContainer.mouseLayout` 停在「preview 还没到、框里只有 call 行」
> 那次渲染的高度（真实会话里是流式的前两三行）。`boxMouse` 把坐标转给 pi 的组件时，超出旧高度的 y 在
> `Container.handleMouse` 的 `y >= childHeight` 处被丢掉，返回 `undefined`，点击就消失了。同样被丢的还有
> 边框行，和分组内 unframed 体末尾几行（`dy` 比正确坐标多算 2 行）。
> 修法没去刷 pi 的布局（要在 split 分支额外渲染一次完整 unified diff），而是兜底：转发后若有没人接的
> 左键 click，就自己 `setExpanded(!expanded)`。`test/box-click.test.ts` 用真实组件复现「先渲染一帧 pending
> 态再给 result」的流式序列，逐行点击断言，修复前 3 个用例全红。
> **试过但撤销了**：把 pi 的 OSC 8 `file://` 链接从路径行剥掉（新增 `tidy.links`）。目的是让点击第一行只展开、
> 不打开编辑器。剥完用户实测**仍然会唤起 VS Code**，说明这次跳转不止来自 pi 的 hyperlink（Ghostty 自己也会
> 识别纯文本路径），在扩展层修不了，改动整段回退，不留配置项。真想关走 pi 的 `terminal.hyperlinks: false`
> 或终端设置。
>
> **0.4.11 已发布（2026-10-24）**：PR #20 squash `924afa5` → tag `v0.4.11` → `gh release create` →
> `publish.yml`（release published，OIDC）38s 成功 → npm 0.4.11 + provenance。packument 约 100s 后可见
> （`dist-tags.latest`），比 0.4.9/0.4.10 那两次的「tarball 又 404 一段时间」症状轻。
> 内容来自社区：#17（bumaociyuan）与 #19（frostime）是同一个 bug —— `groupTools` 开着时
> `trimMessageEdges()` 把 pi 用户消息 `Box(1, 1, userMessageBg)` 的**带背景填充的 padding 行**当空白删了，
> 气泡上下内衬消失、`▸ N calls` 直接贴住消息。
> 修法取 #18 第一个 commit（`5fe5448`）的 `untrimmed` 分支，cherry-pick 成 `a04ef43` 保留作者署名；
> 另加 `CustomMessageComponent` 同款（`ed887cd`）—— 同形状的 Box、同样被裁，之前没人报。
> **没加配置项**：紧凑版对消息来说是错的，不是偏好，#19 要的其实就是"默认保留"。
> 同 PR 也接了 #18 第二块里的 `os.homedir()`（`fa1eb80`）：原来回退 `${HOME}/.pi/agent`、兜底 `/tmp`，
> Windows 没有 `HOME` 时静默读不到 settings。测试用 `t.mock.method(os, "homedir")` + `syncBuiltinESMExports()`。
> **没合** `FRAME_RIGHT_GUTTER = 1`（给全屏滚动条永久让一列）：根因在 pi 的
> `packages/tui/src/components/scroll-view.ts:94`，只对 `scrollbar === "always"` 预留那一列，`auto` 是有意
> 覆盖内容列。改在 README 里提一句「全屏 + auto 建议设 `always`」。上游 issue 还没开。
> 我们本机看不见这两个 bug：#17 被 pi-starline 挡住（它重写的用户消息 render 首尾是 `───` 横线，
> 判空判不到），滚动条被 `fullscreenScrollbar: "hidden"` 挡住。**接 issue 前先用空 `PI_CODING_AGENT_DIR`
> 加 `pi -ne -e <dir>` 看默认形态**，比事后猜快。
> **npm 搜索索引这条**：0.4.11 之前 pi-tidy 的 search doc 是 `score.final: 0`、
> `downloads: {monthly: 0, weekly: 0}`（下载 API 同期报 81/月），于是 `pi-tidy` 搜不到、
> `keywords:pi-package` 全量 12750 条里也没有它，而 pi.dev 目录（5345 个包）是从那条搜索序列截出来的，
> 所以永远收不到 —— 表现是 pi.dev 搜作者只返回 starline / ghostty-tab / ide-context 三个。
> 发布 0.4.11 后索引重算，现在 `final: 23.63`、`downloads: {81, 81}`，搜 `pi-tidy` 已是第 1 位。
> **pi.dev 目录仍未收录**（搜作者还是 3/4），等它那边抓取刷新再确认；不用找 npm support 了。

> **0.4.10 已发布（2026-10-23）**：PR #16 squash `cc37980` → tag `v0.4.10` → `gh release create
> --target cc37980dcc0cabb26d25a1893df48bc204df9e57` → `publish.yml` 28s 成功 → npm 0.4.10。
> 修的是「多行工具参数当成一行渲染」，见下方 0.4.10 那节。tarball 与 repo 逐文件 `cmp` 一致。
> 这次 registry 滞后比 0.4.9 长：packument 约 4 分钟有 0.4.10，`/-/pi-tidy-0.4.10.tgz` 又 404 了
> 约 6 分钟（`?cb=` 绕缓存那招这次也没用，只能干等）。验证方式仍是裸 URL 的 http code。
> 本地这一步做过：settings 里 `npm:pi-tidy` → `../../Projects/fork/pi/pi-tidy`（备份
> `settings.json.bak-pitidy-npm-to-path-20261023`），重启 pi 真机验证通过；发完又切回 `npm:pi-tidy`
> 并 `pi update --extensions`，installed 0.4.10 == tarball 逐文件一致（备份
> `settings.json.bak-pitidy-path-to-npm-20261023`）。

> **0.4.9 已发布（2026-10-23）**：PR #15 squash `35744c8` → tag `v0.4.9` → `gh release create` →
> `publish.yml` 31s 成功 → npm 0.4.9。下方「游离 thinking 行吞掉点击」那节就是这个补丁。
> 本机已从路径装回 `npm:pi-tidy` 0.4.9（`pi update --extensions`，installed == tarball 逐文件一致）。
> **registry tarball 比 packument 慢一截**：packument 3 分钟就有 0.4.9，但 `/-/pi-tidy-0.4.9.tgz`
> 又 404 了两分钟（带 `?cb=` 能拿到新包，不带就命中旧缓存），所以 `pi update` 连按两次失败，
> 第三次才装上。判断能不能装：`curl -o /dev/null -w "%{http_code}"` 不带 query 看那个 tgz。
> settings 备份：`settings.json.bak-pitidy-path-20261023`（切路径前）、`...bak-pitidy-npm-...`（0.4.8 时）。

状态：**0.4.8 已发布**。PR #14（squash `d9f32a4`）→ tag `v0.4.8` → `gh release create` →
`publish.yml`（release published 触发，OIDC）→ npm 0.4.8 + SLSA provenance。registry 可见性大约滞后
 3–4 分钟（00:04:50 发布，00:08 才在 packument 里）。

- tarball 与 repo 逐文件 `cmp` 一致；本地安装已从路径切回 `npm:pi-tidy` 0.4.8（`pi update`，
  installed == tarball，`pi list` 只有一条）。settings 备份：
  `~/.pi/agent/settings.json.bak-pitidy-npm-20261023`。
- **改完源码要重启 pi**（启动时读 `.ts`）；`/reload` 只换 tool 那层包装，消息那层的
  `BOUNDARY_WRAPPER` 是共享 symbol，旧闭包留在最外层，会半新半旧。

`node --test` **154 个测试全过**；`tsc --noEmit` 干净。这个 repo 没有 biome、不用 vitest
（`node --test`，pi 的 tui 包才用 node --test）。工作树里只剩未跟踪的 `HANDOFF.md`。

## 2026-10-23 修：多行工具参数当成一行，把下面的行全画错（0.4.10，PR #16）

现象：`Working` 状态行上下夹着几段脚本碎片，左边从词中间断开，`0.2s` 单独占一行、贴在右边。

根因：一个「行」在 lines 数组里就是一个字符串。`tool-lines.ts` 的 `argParts()` 只把 `command`
按 `\n` 切开，其它参数原样返回。`chrome-devtools_evaluate_script` 的 `args.function` 是整段脚本，
于是**一个数组元素让终端画了 4 个物理行**，而 pi 的帧只算 1 行 → 它下面的每一行（包括 spinner）
全部错位，旧字节留在屏幕上。`truncateToWidth` 把 `\n` 算 0 宽，预算还会跨行累加，所以行尾那条 `…`
落在最后一行上，看着更像「残留」。

验证手法（值得复用）：pi-tui 的 `VirtualTerminal`（xterm headless）里，同一个组件返回
`["… (+3 lines)"]` 屏幕是干净的，返回一个带 `\n` 的字符串就跑出同样的漂移。
先把「纯布局变矮」排掉也是这么排的（块从 6 行收成 1 行 + spinner，40×6/8/10 三种高度全干净），
所以别一上来就怀疑 pi-tui 的增量重绘。

修法：三个分支共用 `oneLine()` = 首行 + `(+N lines)` + `trim()`（顺带吃掉 CRLF 的 `\r`）。
测试钉在 `test/tool-lines.test.ts`：`formatToolLine` 的返回值里不能再有 `\n`。

## 这一轮改了什么

- **thinking 变成 group 里的一行**：`🧠 thinking  <预览>`，一个 *run* 一行；summary 上是
  `🧠 N thoughts`，位置在 `N failed` 前面。点一下展开成 pi 自己的 markdown（走 pi 的
  `thinkingVisibilityOverrides`，我们的点击和 pi 的点击永远一致）。**pi 的 `hideThinkingBlock`
  被刻意忽略**：不管配置如何，run 一律从「收起」起步。
- **gutter 里面不再有 box**：展开的调用保留自己那行、在 rail 上挑一个 `├─`，输出挂在下面（不再重复
  `$ cmd` 那行）。box 只留给 `edit`/`write`（pinned）和 group 之外的 thinking。
- **指标成列**：`1 line`/`12 lines` 和时长按组内最宽补齐、整块右贴边（`formatToolLine` 的 `align`）。
- **参数按终端宽度算**：不再是固定 60 格；`(+N lines)` 先丢，尾注只在剩不到 12 格时才让位。
- **全程没有空行**：`frameBox` 不再输出开头那格空行（点击几何 `top: 1 - edges.start`）；每个消息块
  由 `trimMessageEdges` 裁首尾，它是**转义感知**的，并把 OSC 133 标记搬回保留下来的行。
- **live thinking 行**：还在流的步骤在 summary 下面留一行，显示文本**尾部**（滑动窗口、按词对齐、
  300ms 一跳 `THOUGHT_TICK_MS`）；此时 summary 写 `◐ thinking` 而不是 `N thoughts`，动画只在
  summary 上，不在行上。
- **点击命中表**：`THOUGHT_SPANS`（每行 + 展开后的框，按裁掉的首行数位移）+ 自己的 `handleMouse`。
  pi 的区域按**未裁剪**布局算，裁完之后必然错行。

## 2026-10-23 收尾（原「未解决」三条，全部处理完）

1. **summary 说 `N thoughts`、组里却没有那一行 —— 已定：不把边界的 run 计进 group。**
   边界的 thinking 画在它自己那块（文字上方，同一套 `🧠 thinking` 行），group 里从来没有它的行，
   计进去等于承诺一个展开也看不到的条目。`noteBoundary(component)` 现在不收 runs。
   反向的一半也补了：一个 carrier 的调用是**已展开的 pinned 工具**（edit/write）时它返回 `plain`
   （pi 自己画这一步，thinking 一起画），这时会把它已经计进去的数**减回去**，并请求下一帧。
   —— 这条是行为取舍，Andy 若要「边界也计数 + 从组内列出」，得改回并让边界把行交给 group。

2. **`◐ thinking` 转不停 / 行留在不是 live 的地方 —— 已修，三个信号取与：**
   - `agentRunning`（`live.ts` 的新 live slot）：`agent_start` 置真，`agent_end`/`agent_settled`
     置假，`index.ts` 里接的。`/reload` 后新模块改的是同一个全局 symbol，老 patch 也读得到。
   - `component.isStreaming === true`：pi 自己 settle 了就立刻停（这个 flag 会残留 true，所以不能单独用）。
   - **文本在最近 `THOUGHT_LIVE_MS`（1500ms）内增长过**：`tool-groups.ts` 的模块级 WeakMap
     `thoughtGrowth`（按消息，不按 group），比的是 runs 的字符总数。只有 `agentRunning` 为真时才记
     `at`，所以**恢复的会话/新回合不会复活旧的有思考**。
   - 到期那一帧没有别的东西会重绘（pi 已经闲了），所以 `scheduleSettle` 自己排一次 `requestRender`，
     否则行和 spinner 会一直挂在屏幕上。
   - 单元测试用 `t.mock.timers.enable({ apis: ["Date"] })` 推时间；`agentRunning` 是全局 slot，
     测完必须 set(false)。

3. **`🧠 thinking` 行出现在并非 live 的地方 —— 同 2，`rows` 改成 `(level === 1 || live)`。**
   折叠态只有真的在流才有那一行；不流了行消失、summary 回到 `N thoughts`。

4. **游离 thinking（不在 group 里的那条：正文上方、或回合刚开始还没调工具时）也 live 了。**
   之前它只走 `previewText`(头部 + 截断)，不会动。现在和组内行同一套：`noteThinking` / `thinkingState`
   提到 `tool-groups.ts` 的模块级 WeakMap（按组件，不按 group），`restyleThinking` 也用它——滑动窗口看
   尾部、300ms 一跳、1500ms 自落。差别只有一个：游离行上方没有 summary 可以转，所以它自己把 spinner
   戴在 label 上（`formatThoughtLine` 新增的 `spinner`）。真机验时顺手看一眼它是不是只转“真的在流”的
   那 1.5 秒。

## 2026-10-23 修：游离 thinking 行吞掉整块消息的点击（0.4.9，PR #15）

现象：一条正文里点 `fish` 代码块（或它上面任何一行）都会把正文上方的 `🧠 thinking` 展开，
代码行选不中、也高亮不起来。

根因：`installCarrierMouse` 挂在**组件实例**上，而组件的角色会中途变——一个助手步骤在流式阶段是
carrier（`renderCarrier`），文本到达后同一个对象变成边界（`restyleThinking`，也是 `THOUGHT_SPANS`
那套）。旧 `rowAt` 只要 `y >= 0` 就返回 `"row"`，比的是 `carrierPlan(component)`（handler 里
没有 runs，`plan.rows` 恒为 false，所以根本没法当判据），于是**整块消息**的点击都被当成点在了
thinking 行上：展开 run、`THOUGHT_OPEN = true`，并 `handled: true` 把事件吃掉。

改法（`tool-group-view.ts`，无配置项变化）：

- 新增 `CARRIER_CLICK`：`renderCarrier` 每帧记录自己画出来的 `header` 下标和思考行区间
  `[from, to]`；`wrapBoundaryRender` 每帧先把 `CARRIER_CLICK` / `THOUGHT_SPANS` 清空，
  所以「这帧没画我的行」= 没有几何 = 不接点击。
- `rowAt` 改成按记录判断；区间外的 move/click 交还给 `installCarrierMouse` 之前那个 handler
  （以前一律 `return undefined`，等于把 pi 自己的处理一起屏蔽）。
- `installRethinkMouse` 在 spans 全不命中时不再把 click 往下传：pi 的区域按**未裁剪**布局放置，
  裁掉首行后必然错一行，`thinking` 行下面那一行会命中 pi 的 label（旧版就有的 off-by-one）。
  非 click 事件照旧传。

回归测试：`test/group-frame.test.ts` 的 “a step that streamed as a carrier hands clicks back once
its text arrives”（真 `AssistantMessageComponent` + 真 `Container.handleMouse`）。`node --test`
155 全过，`tsc --noEmit` 干净。改完要**重启 pi**（源码是启动时读的）。

## 还没做的 / 已知限制

- **真机验证**（npm 0.4.8，pi 1.4.0，重启后）：新会话跑一轮带 tool 的对话，看
  (a) 折叠时 `◐ thinking` → 停流后变 `N thoughts`，行消失；
  (b) 展开的 group 里 thinking 行数 == summary 数（边界那笔不算）；
  (c) 长思考中途 Esc，标记停下（不要转到底）。
  游离 live 已在 2026-10-23 的真机上看过（滑动 + 停流 1.5 秒定格）；组内那条只有组件级测试。
- **落定那一下会从尾部跳回头部**（并收窄到 56 格）。滑动看最新、定格看开头，目标相反，所以跳得
  明显。想换的话：定格保留尾部，或等下一个步骤开始才切。
- **`scheduleSettle` 依赖 `lastUi`**（最近一次渲染的工具的 `ui.requestRender`）。一个全新进程里还
  没渲染过任何工具时它是 undefined：那时若思考停住、pi 也不再重绘，行和 spinner 会留到下次重绘。
  实际中 pi 的 Working 指示器在跑时一直在重绘，所以没暴露；要彻底修就接 `ctx.ui` 进一个 live slot。
- 游离行 / 组内行共用 `noteThinking` 的 WeakMap；一个消息从 "plain streaming" 变成 carrier 时
  （工具调用到达）缓存和计时器是同一份，不会重复调度。

## 复现手法（这一轮一直靠它）

repo 根目录写一个一次性的 `scratch-probe.ts`：用 `@earendil-works/pi-coding-agent` 里的真组件
（`AssistantMessageComponent` / `ToolExecutionComponent`，从本 repo 的 `node_modules` 解析），
`patchToolBoxFrames({ icons: true, groupTools: true })`，然后 `chat.render(W)` **连渲染 4 次**
（group 要几帧才 settle `lateJoin`），strip 掉 ANSI 并把 `THOUGHT_ICON` 换成 `🧠` 方便看。
用完删掉，别提交。

`node --test test/group-frame.test.ts` 是端到端那个：跑的是真组件 + 真 `Container.handleMouse` 派发，
点行、点框、点 header 都在里面。

注意：**这个 harness 的 bash tool 实际跑的是 fish**（`$0` = `/opt/homebrew/bin/fish`），
heredoc 会直接报 `Expected a string, but found a redirection`。多行内容用 write/edit 工具落盘。

# 历史

> 迁入自 `fork/pi/AGENTS.md`（2026-10-23），为让 AGENTS.md 不再每 session 加载 74KB 历史。按时间倒序。

## pi-tidy 0.4.6 — PR #10 (已于 0.4.7/0.4.8 期间合并，本节仅留过程记录)

`fix/bash-renderer-only`, commit `08d54b3`, [PR #10](https://github.com/Andy8647/pi-tidy/pull/10),
CI green, 141 tests + tsc clean. **Not released** — waiting on s5unty's review (he has the pi-playpen
setup; I cannot reproduce the sandbox case here) and Andy's call. Version is already bumped to 0.4.6
with its CHANGELOG section written on the branch, so releasing is: squash merge → tag `v0.4.6` →
`gh release create` (publish.yml triggers on release published).

`bash` was the same conflict as `write` (see 0.4.5 below): pi-tidy re-registered it for the
syntax-highlighted command row plus the collapsed output budget. Both are rendering only, so both are
on `pi.registerToolRenderer()` now — `renderCall` replaced (still maintaining
`state.startedAt/endedAt`, which pi's built-in `renderResult` reads for its `Took 1.2s` footer, since
we own the renderer that normally sets them; the reused `Text` lives in `state.tidyCallText`, not
`state.callText`, so an execution extension's component is never overwritten), `renderResult` wrapped
(call downstream, then `shrinkResultPreview` on the returned component when collapsed and not an
error). `highlightBash: false` returns the renderers untouched. **pi-tidy registers no tools at all
now.**

Old-pi path: `registerToolRenderer` is 1.3. On 1.1/1.2 both features are skipped and one
`session_start` warning names them — gated on the setting actually differing from pi's default
(`writeLines !== 10`, `highlightBash === true`), so nobody who never touched them is told anything.
That gate changed `test/write-renderer.test.ts`'s old-pi case; the resolver harness now lives in
`test/renderer-harness.ts` and is shared with `test/bash-renderer.test.ts`.

Todo before release: check whether the s5unty review says the call row loses a playpen annotation (if
so, the resolver would need to delegate `renderCall` and only decorate, or go behind an option).


## pi-tidy 0.4.5 — RELEASED 2026-10-20 (hover, quieter failures, diffLines)

PR #9 (squash `5007f4c`) → `v0.4.5` → OIDC publish, provenance, tarball `cmp`-identical to the repo;
local install back on `npm:pi-tidy` 0.4.5 (installed == tarball, `pi list` shows only the npm entry).
Andy picked 0.4.5 rather than 0.5.0: patch bumps unless he says otherwise.

- **Hover on folded rows**: `▸`→`▶` plus a full-width `selectedBg` band on the row under the pointer,
  `›` at the end of a level-1 row. The `move` packet is **never consumed** (pi still needs it for
drag-selection); the repaint is requested directly, and only when the hovered row changes. A wrapper
  over `TuiAltScreen.prototype.handleMouseEvent` clears the band when the pointer leaves (editor,
  message, scrollbar) — if that private method is missing, hover stays **off** deliberately. Needs
  1003 all-motion tracking: outside tmux/screen only (`ENABLE_ALL_MOTION_MOUSE`).
- **Failures**: level 0 is one line again. Failed rows no longer hang under the folded summary (a
  56-call group with 2 failures used to "fold" into 3 lines); the summary says `N failed` in red and
  the rows wait in level 1, where each has its `✗`, a `muted` note (`exit 1`), and `dim` for a
  failure that printed nothing (timeout/abort still counts as readable). Count goes `muted` when the
  group is open, so red appears once at either level.
- **`diffLines` (default 20)**: pi's edit renderer draws the whole diff, so a long edit owned the
  screen regardless of `alwaysShowTools`. The collapsed box now windows the diff at the **first
  changed line** (a third of the budget of context above it) and closes with
  `… (N more lines, M total, ctrl+o to expand)`. Cutting at the top would hide the change itself.
  `0` = summary row only (no old/new header). `ctrl+o` draws all.

Verification worth reusing: `test/hover-dispatch.test.ts` drives the **real** `TuiAltScreen` with a
fake terminal and sends `\x1b[<35;x;yM` — proves a button-less motion packet reaches a component
inside a `ScrollView` (that is pi's code, and the whole feature rests on it). Frames were previewed by
rendering the real formatters into HTML and screenshotting with headless Chrome (`/tmp/td-preview/`,
scratch, gone on reboot).


## pi-tidy issue #7 / PR #8 — MERGED 2026-10-20 (renderer-only write preview)

s5unty (pi + pi-playpen user) hit `Tool "write" conflicts with …/pi-tidy/index.ts` on 0.4.4: pi treats
a duplicate tool name as a **hard failure**, so an extension that overrides a built-in tool for
sandboxing cannot coexist with one that re-registers it, in either load order. He filed
[issue #7](https://github.com/Andy8647/pi-tidy/issues/7) and [PR #8](https://github.com/Andy8647/pi-tidy/pull/8)
(squash `96a12cf`) doing `write` via `pi.registerToolRenderer()`. Reviewed (ran his suite: 113 pass,
merge clean against 0.4.5, 129 after) and merged. He did **not** fork to publish — his fork's
`package.json` still points at this repo and nothing is on npm under his name.

pi 1.3's contract, read from the installed dist (do not re-derive):
`resolveToolRenderers(name, base)` = `resolvers[0](name, () => resolvers[1](…) … base())`, `base()` =
`withBuiltInRenderers(name, definition)` which fills in built-in `renderCall`/`renderResult` when the
registered definition lacks them. So `next()` gives the *active* tool's renderers, sandbox wrapper
included, and `{...renderers, renderCall}` keeps `renderShell`. `ToolRenderers.renderResult` must
return a `Component` (not undefined), so a resolver has to leave it absent when downstream has none.

Also settled: pi's package gallery (`pi.dev/packages`) *has* pi-tidy (`/packages/pi-tidy` → 200, shows
0.4.5 + install command). The list page is popularity-sorted and paginated (`1-50 / 5531`), so a
fresh package is hundreds of pages in and the page's filter box only filters what is loaded; npm's own
name search also lags hours behind the publish. Keywords (`pi-package`) were never the problem.


## pi-tidy 0.4.4 — RELEASED 2026-10-20 (side-by-side edit diffs)

PR #6 (squash `04ec8df`) → `v0.4.4` → OIDC publish, provenance, tarball `cmp`-identical;
local install via `pi update npm:pi-tidy` (installed == tarball, 0.4.4).

An edit's diff is now two panes, `old │ new`: line numbers both sides, a bar in its own
column (left of the digits), a tinted row per changed line, word-level emphasis inside the
row, one row per removed/added pair, and a `↳ diff +N -M [+++---]` summary row under the
call line. `writeLines` (default 10) makes write's preview height a setting.

Four things worth keeping:

- **The rendered diff is not reversible.** pi's edit body is `Text(renderDiff(diff))` — the
  ANSI lines carry colours but no old/new line pairing. The raw unified string is still on
  the component (`callRendererComponent.preview.diff`), so the panes are rebuilt from that.
  `callRendererComponent.children[0]` is the call row; keep it and the icon/short-path logic
  in `frameBox` still works.
- **`drawFrame` strips every background fill** (that is where pi-tidy's transparency comes
  from), so tinted rows need an opt-in: `drawFrame(..., keepBg)` takes the row indices the
  split painted. Everything else keeps being stripped.
- **A row tint has to be an absolute colour, and hue has to stay low.** Mixing the diff
  colour into `toolSuccessBg` at 14% gives a plum band, not a removed line: 14% of
  catppuccin's pink over #28293a is (68,55,73). The formula that reads right is
  `tint*0.16 + base*0.35` for the row and `tint*0.32 + base*0.35` for the emphasised word.
  Also: `toolSuccessBg`/`toolErrorBg` are the *same* colour in catppuccin, so the theme
  cannot supply the added/removed distinction at all.
- **write's 10-line preview is hard-coded** (`expanded ? all : 10`) and `formatWriteCall`
  is not exported, so `writeLines` re-registers the write tool the way bash already was.
  `renderToolPath`/`replaceTabs` are *not* in the package exports — the deep path is
  blocked by the exports map, so the `~` shortening and 3-space tab are reimplemented.

Reviewing pi's bundle: `rg` over `chunk-*.js` is near-useless (3.5 MB minified into single
lines, one match dumps 50 KB). Slice it from node instead
(`const i = s.indexOf("function X"); s.slice(i, i+2000)`), and give every `node -e` probe a
`timeout` plus `process.exit(0)` — importing the package runs `initTheme` and the process
never exits on its own.

Driving the frame without a terminal: `split-diff.ts` is pure, so render it and convert the
ANSI to HTML by hand, then `Google Chrome --headless=new --screenshot` on the file. That is
how the tint and alignment were checked before Andy ever ran `pi` — no pty needed.


## pi-tidy 0.4.3 — RELEASED 2026-10-19 (cover, demo video, screenshots)

PR #5 (`7426aa5`) → `v0.4.3` → **first OIDC publish of pi-tidy, worked** (trusted
publisher OK), SLSA provenance. `assets/`: `cover.svg` → `cover.png` (2560×1280,
`rsvg-convert -z 2`, catppuccin mocha, Maple Mono NF with Menlo fallback for ◐),
`demo.mp4` (H.264 1600w 30fps 3.4 MB, from Andy's 33 MB HEVC 120 fps recording —
HEVC doesn't play in Chrome/Firefox), `folded.png`, `process.png`. `pi.image` =
raw.githubusercontent cover; `pi.video` = jsDelivr pinned to the tag (serves
`video/mp4`; raw.githubusercontent serves octet-stream). README uses absolute URLs
so npm renders them; `assets/` is not in the tarball (52 KB). Local install on 0.4.3.
Still manual: GitHub social preview (repo Settings → upload cover.png; no API).


## pi-tidy 0.4.2 — RELEASED 2026-10-19 (rename of pi-toolbox)

First publish by Andy by hand (OIDC can't create a package), trusted publisher
configured (Andy8647 / pi-tidy / publish.yml / env `npm`), `@andy8647/pi-toolbox`
deprecated with the swap command. `gh release create v0.4.2` → `publish.yml`
skipped ("already on npm") → green. npm tarball `cmp`-identical to the repo.
Local install swapped (`pi remove npm:@andy8647/pi-toolbox`, `pi install
npm:pi-tidy` — it lands last in `packages`, fine: boundary wrappers re-install on
top lazily), installed == tarball, `npm ls` shows only pi-tidy 0.4.2. Settings key
renamed `toolbox` → `tidy` (backup `settings.json.bak-pitidy-rename-20261019`);
chezmoi not yet re-added.

- GitHub repo renamed (`gh repo rename`, old URLs redirect), local dir is `pi-tidy/`.
- Peers back to `"*"` with a session-start warning below pi 1.1.0 (pi's docs
  require `"*"` peers; a peer conflict fails every npm install in
  `~/.pi/agent/npm`). pi-starline still has `>=0.84.4` peers — same risk, open.
- Internal `Symbol.for("pi-toolbox:…")` keys kept on purpose (old + new installed
  side by side share one set of patches).
- Next: promotion (Discord, X) — demo + cover shipped in 0.4.3.


## pi-toolbox 0.4.1 — RELEASED 2026-10-19 (background jobs, no flicker)

PR #3 (squash `f6c76fb`) → CI green → `gh release create v0.4.1` → OIDC publish,
SLSA provenance, `latest` = 0.4.1, tarball `cmp`-identical; local install via
`pi update` (installed == tarball). Andy asked for 0.4.1 rather than 0.5.0.
Also in 0.4.1: running rows (and jobs) appear only after 1 s
(`RUNNING_ROW_DELAY_MS`) — quick calls used to pop out under the summary and fold
back a frame later; a step streaming thinking mid-group folds with the group.
README's stale "No mouse handling" section, broken screenshot placeholder and
duplicate color bullet were fixed.

`background-jobs.ts`: provider interface + pi-processes provider. A `process start`
row tracks the process (spinner → `exited 0` / `exit 1` / `killed SIGTERM`), the
`ad-process:notification` messages are hidden once their row exists (drawing only;
the model still gets them). Options `backgroundJobs` / `hideJobNotifications`.

- Protocol read from pi-processes 0.13 `extensions/shared/protocol/`: broadcasts
  `processes:ended` (ProcessInfo) and `processes:notification`, sync query
  `processes:request:get` `{ id, reply }` — `reply(null)` = unknown id, no reply =
  extension not loaded. A row whose id the manager doesn't know is `gone`
  (reloaded session from an earlier pi), then corrected by persisted messages.
- Store is a global slot (shared across `/reload`); ticker 1 s for a job's first
  5 min, then 60 s; `unref`'d.
- **Real-core check** (`scratchpad/pp-real/run.mjs` style): load pi-processes'
  ProcessManager + `registerEventBridge` + `registerRequestHandlers` through jiti
  with pi's loader aliases (`typebox`, `typebox/compile`, `typebox/value`, the two
  `@earendil-works/*`) on pi's real `createEventBus`. Verified exit 3 → failed,
  exit 0 → done, kill → `killed SIGTERM`, unknown → gone. NOT verified against the
  real notification service (log-match note, message hiding) — Andy's live test.


## pi-toolbox 0.4.0 — RELEASED 2026-10-19 (grouped tool calls)

PR #2 (squash `909ee2a`) → CI green → `gh release create v0.4.0` → OIDC publish
with SLSA provenance; npm `latest` = 0.4.0, tarball `cmp`-identical to the repo.
Local install via `pi update npm:@andy8647/pi-toolbox` (worked first time; installed
== tarball). Andy's real-Ghostty click-through is still owed for the round-3 bits
(failed rows, result notes, box clicks on edit/MCP).

Three-level tool folding (C summary line → ▾ header + one row per call → full box).

- **"Every call its own `▸ 1 call`"**: pi gives every model step its own
  `AssistantMessageComponent`, and every one counted as a boundary. Now only a
  user message or an assistant message with non-blank `text` is a boundary;
  tool-only steps are "carriers" — they don't split the group, and their
  `Thinking...` row only shows next to that call's full box.
- **"Clicks do nothing"**, two causes: pi-tui's `event.button` is the string
  `"left"`, not `0`; and the prototype called `beginGroup()` (reset all levels to
  0) whenever the *rendered* boundary changed — i.e. on every frame once there
  were two boundaries. Groups are now keyed by their boundary component, so a
  re-render only selects one. The "siblings are render-cached" theory was wrong:
  layout's `renderCache` is per frame.
- **pi-starline's `UserMessageComponent.render` patch never calls its predecessor**,
  so any wrapper under it is dead. The boundary wrappers re-install on top from
  the tool render (`installGroupBoundaries`).
- ctrl+o vs. a box click both arrive via `setExpanded`; told apart by whether it
  happens inside `handleMouse` (`pointerDepth`). ctrl+o collapse → back to C.
- Round 2 (Andy's asks): level 1 keeps a `▾` header (click → back to C, folds
  boxes inside too); everything in an open group sits on a `│` gutter (boxes
  render 3 cells narrower; image boxes skip it). `alwaysShowTools` (default
  edit/write) never fold — pi's own box with the diff, Claude-Code-style — and
  act as a boundary so the calls after an edit start a new group.
- Round 3 (before release): failed calls keep their row while folded and the
  header counts them; rows carry a result note (`12 lines`, `exit 1`, …) for
  built-in tools only. Box clicks are translated through the frame geometry
  (`__frameGeometry`) into the source component — pi's own handler measured the
  unframed layout, and for `renderShell: "self"` (edit, MCP) read a
  `selfRenderHeight` only its render sets, so those clicks were always dropped.
  Options live in `globalThis[Symbol.for("pi-toolbox:…")]` slots (`live.ts`) so
  `/reload` reaches the patches already installed. `frame.ts` is now a facade over
  frame-draw / tool-frame / tool-group-view / message-frame.
- **Peer floor `>=1.1.0`, measured on published dists**: component mouse events
  0.86.0, bash `maxVisualLines` 1.0.0, `durationMs` in ToolExecutionComponent
  1.1.0. devDeps now `^1.3.0`, and `test/group-frame.test.ts` drives real
  components through `Container.handleMouse` — no fakes, no stand-ins.
- E2E check against the installed pi (real Container mouse dispatch, through
  `index.ts`): symlink the homebrew `pi-coding-agent` + its `pi-tui` into a temp
  `node_modules`, copy the `.ts` files beside it, drive `chat.handleMouse`.


## pi-toolbox 0.3.3 — released 2026-10-05 (frame cache served stale boxes)

Andy: "任务执行的时间不会自动更新,你得点一下那个时间才会刷新" on a running
`sleep 580` bash call. **Not pi — our own extension.** pi's shell renderer is
fine: `renderers/bash.ts` starts a 1s `setInterval(context.invalidate)` while
`isPartial` and rebuilds the `Elapsed` row from `Date.now()` (unchanged in
1.0.2); an isolated `ToolExecutionComponent` shows 0.0 → 1.0 → 2.0s.

- **Root cause:** `frame.ts`'s `fingerprint(lines) = count|lines[0]|lines[last]`.
  `contentBox` is a `Box(1,1)`, which pads an empty row top and bottom, so both
  endpoints are constant filler: the key carried **only the line count**.
  `Elapsed 96.0s` → `97.0s` changes neither → `__frameCache` hit → the stale
  frame is returned; the click "worked" because `expanded` is a cache key.
  Same hole swallowed any streaming output that stayed on the same line count.
- **Fix:** compare the framed lines (`sameLines`) instead of a digest — `Box`/
  `Text` hand back their cached line array, so an unchanged box is still a
  pointer compare per row and allocates nothing. Applied to all three caches
  (tool / message / container), which shared the helper. Also fixed a latent
  writer: the icon step did `content[0] = row` on the array `trimBlankEdges`
  returns unchanged — i.e. **Text's own cache** — duplicating the kind icon on
  the next render (only reachable on the no-renderer fallback path, where the
  `contentText` array has no padding rows to make trim return a slice).
- **Evidence:** regression test added first and seen failing on 0.3.2
  (`interior-only changes are not served from the frame cache`); end-to-end with
  the real installed 1.0.2 `ToolExecutionComponent` + real `Box`/`Text` + patched
  `frame.ts` (harness in `/tmp/tb3/`, import the dist files by absolute path,
  `initTheme("dark")`, then `patchToolBoxFrames`): `shown` goes 0.0s → 1.0s on
  its own. 32/32 tests, `tsc --noEmit` clean.
- **Released:** commit `5e46e0f` → main (CI green) → `gh release create v0.3.3`
  → `publish.yml` (release-triggered, OIDC) → npm `0.3.3` + provenance
  (attestation endpoint 200). Published tarball `cmp`-identical to the repo for
  all 7 files; local install aligned with `pi update npm:@andy8647/pi-toolbox`
  (0.3.3, `npm ls` clean — the ERESOLVE zombie did **not** bite this time).
- **Still owed:** the `~/.pi/agent/npm` tree zombies (`pi-balance` unscoped dup,
  `pi-powerline-footer`, `pi-zentui`, `remote-pi`) — unrelated, still there.


## pi-toolbox 0.3.0 + 0.3.1 — released 2026-09-20/21 (frames, colors, icons)

Both on npm (0.3.0 @ 2026-09-20 13:02 UTC, 0.3.1 @ 2026-09-21 00:55 UTC, which
includes HEAD `3d48154`); installed copy is 0.3.1. Local git tags stop at
v0.2.2 — the v0.3.x tags live on GitHub (release-published flow), not fetched.

- **0.3.0**: message boxes (compaction/branch/skill/custom, user opt-in) get
  the same rounded transparent frame, each in its own `messageBorderColors`
  color; tool boxes get per-tool success border colors (`toolColors`) and Nerd
  Font icons (kind icon leads the call row, file icon in front of the path).
  `frameUserMessages` defaults false because pi-starline patches the same
  prototype. **`toolbox.toolColors` in settings REPLACES the default map
  (`{}` disables)** — any override must write the full map.
- **0.3.1**: file icons render in nvim-web-devicons brand colors (full set:
  736 extensions + 1172 filenames, truecolor); file-icon placement matches the
  `~`-shortened display path and never lands inside an OSC 8 hyperlink; the
  tool-name word is dropped from read/edit/write call rows (` 󰛦 ~/x.ts`).
- **Color precedence (frame.ts)**: pending → `borderMuted` grey, error →
  `error` red, success → `toolColors[tool] || "accent"`. Success is no longer
  green by default — bash's default `bashMode` is **peach in catppuccin-mocha**,
  which read as "yellow on success" and prompted Andy's question.
- **Andy's settings** (`~/.pi/agent/settings.json`, 2026-09-21): full
  `toolbox.toolColors` map written with `bash: "success"` (green on success),
  the rest at defaults. Effective on pi restart. **Not yet chezmoi-synced.**


## pi-toolbox 0.2.3 — the freeze was our extension, not pi (2026-09-18)

Andy: "pi 在 Ghostty 里经常 freeze,画面完全不动,ctrl+c 也退不掉". Reported against
the `~/Downloads/ppd/swansea` session `01a0b2f8…` (30.6 MB, 96 % of it 27
inlined base64 images). **Root cause: `bash-highlight.ts` in pi-toolbox.**

A `#` that is neither at word start nor inside quotes (`fill:#242f60`, `a#b`,
`url#frag`) is in `WORD_BREAK` but no branch handles it: the word loop stops at
the break, `word` comes back empty, `i` never advances, and `out.push("")` grows
until the heap blows up. pi-toolbox re-highlights the call row on **every
tool-argument delta**, so one streaming command containing such a `#` deadlocks
the whole TUI. Bare `\r` and other non-space whitespace (nbsp, `\v`, `\f`) are the
same trap — a second instance of the same bug class.

### How it was actually found (the reusable part)

- `ps`: the frozen pi was **still alive** — 100 % of one core, RSS oscillating
  3.05 GB → 0.93 GB → 1.77 GB, fds 0/1/2 `(revoked)`, `tty ??`. The RSS sawtooth
  *is* the signature: the empty-string array grows to the heap limit, throws, is
  swallowed by `formatBashCallHighlighted`'s `try/catch`, and the next buffered
  delta starts it over. In the same run `args.command` was still growing too
  (1193 → 1232 → 1412 chars) — the consumer never catches up with the stream.
- `sample <pid>`: main thread 4088/4088 samples inside a TLS read callback →
  microtask → JIT, split between `RegExpPrototypeTestFast`, `StringSubstring`,
  `ArrayPrototypePush`, `StringEqual` + `Scavenger`/`MarkCompact`. **Zero
  `ArrayPrototypeShift`/`memmove` samples → provably NOT upstream #9055**
  (EventStream `queue.shift()`), and the hot frame is not in pi-ai at all.
- **`kill -USR1 <pid>` opens the V8 inspector on a running pi** (port 9229); then
  CDP `Debugger.pause` interrupts a busy JS loop and
  `Debugger.evaluateOnCallFrame` reads live locals. That produced the answer:
  `highlightBashCommand` ← `formatBashCallHighlighted` ← `renderCall` ←
  `updateDisplay`/`updateArgs` ← `_handleAgentEvent`, with `i = 612`,
  `n = 1193`, `command.charCodeAt(612) === 35` (`#`) and `out.length` at 86 M and
  climbing. Without it every frame is `??? (in <unknown binary>)` JIT noise.
  **Reach for this whenever a pi process looks wedged — it is the whole trick.**
  The same probe extracted the exact 1412-char payload now used in the test.
- The session jsonl itself held nothing about the cause (and blew up on its own:
  96 % base64 images). The three earlier freeze investigations live only in old
  session transcripts — that is why the record felt lost.

### Closing the tab does NOT kill the process (measured; my first guess was wrong)

I assumed the login shell's SIGHUP disposition was inherited as SIG_IGN.
**Disproved**: a bare `fish -l` and a `node` child of it both die on SIGHUP
(controlled A/B). What actually happens is that the tab close revokes the pty
(fd 0/1/2 `(revoked)`, parent shell reparented to launchd, PPID 1) without ever
delivering a fatal signal — and a userspace-spinning process can never notice:
it does not read stdin and never returns to the event loop, so it cannot see EIO
on stdin either. **Only an external `kill -9` ends it.** Sweep after any freeze:
`ps -Ao pid,%cpu,command | awk '$3=="pi" && $2>90'` then `kill -9`.

### What shipped (0.2.3, npm + GitHub release, provenance)

- Fix: `#` is no longer a word break; plus a progress guard
  (`if (j === i) { push(c, null); i++; continue; }`) so no break character can
  ever stall the scanner again.
- `test/bash-highlight.test.ts`: every case runs in a **worker with a deadline**,
  so a hang fails the test instead of hanging the run, and asserts the output is
  lossless. It fails **9 of 11** on 0.2.2 — that is what makes it worth keeping.
- CI had been red since 2026-07-26: `ci.yml`'s tarball check still required
  `package/click.ts`, deleted in `e85fde9`. Repaired, and it now runs the tests.
- Release path: commit → push `main` → CI green → `gh release create v0.2.3`.
  **`publish.yml` triggers on *release published*, not on a tag push** (opposite
  of pi-ide-context/starline), then OIDC + provenance. npm's version endpoint
  404'd and `dist-tags` stayed on 0.2.2 for ~60 s after
  `+ @andy8647/pi-toolbox@0.2.3` — expected, not a failure. Verify the artifact by
  downloading the tarball and `cmp`-ing it against the repo, not by trusting logs.
- **`pi update` reported "Updated" while staying on 0.2.2 — twice.** It runs a
  lockfile-respecting `npm install`. Plain `npm update` then died on a
  *pre-existing* ERESOLVE: the zombie `pi-powerline-footer@0.7.0` (Starline's
  predecessor) pins `@earendil-works/pi-ai >=0.74.0 <0.81.0` while the tree has
  0.85.1, which blocks **every** npm install/update in `~/.pi/agent/npm`.
  Worked around by aligning `package-lock.json`,
  `node_modules/.package-lock.json` and the installed `package.json` to 0.2.3 by
  hand; `node_modules/@andy8647/pi-toolbox` is now byte-identical to the published
  tarball and `npm ls` reports 0.2.3. **Cleanup still owed (not done):** drop the
  tree zombies — `pi-balance` (unscoped duplicate), `pi-powerline-footer`,
  `pi-zentui`, `remote-pi` — none of them appear in `settings.json` `packages`.

### Taxonomy — never conflate these three (it cost me a confused reply)

| symptom | cause |
| --- | --- |
| **freeze**: no repaint, `ctrl+c` dead, 100 % CPU, GBs of RAM, survives tab close | pi-toolbox bash tokenizer — fixed in 0.2.3 |
| ghost/displaced rows **while drag-selecting the editor** | pi #9332 cursor-marker APC leak (CPU ≈ 0 %) |
| displaced pi-toolbox box rows while **scrolling** (2026-09-08) | still unknown, section below |

The #9332 hotpatch is **not** applied at the moment (see its section) — but it
was never related to the freeze, and it cannot be: swallowing text does not burn
CPU. The August investigations (2026-08-02 / 08-14 / 08-15, recovered from old
session jsonl) saw this same process signature but blamed pi core or the
starline/toolbox patches; this time the stack named the function. Full report,
samples and probe scripts were under `/tmp/pi-freeze-investigation/` (gone on
reboot).


## pi-toolbox scroll corruption — UNRELATED to #9332, root cause not found yet

User-reported (2026-09-08, same session as the selection bug): scrolling the
transcript left displaced pi-toolbox box rows interleaved with message rows
(box fragments with green borders at wrong vertical positions, stale
`Thinking...`). No selection was involved. Proven NOT the marker leak: leaks
only happen while a selection is alive and stop after submit (verified in the
harness), and the leak site (editor row) is written after transcript rows in
every frame, so the APC swallow cannot touch transcript rows. Harness repros
(scroll, scroll-while-streaming, abort mid-turn, trackpad-style wheel hammering
at 200x55) all render clean with correct byte streams. pi-toolbox's own frame
render (`frame.ts`) is width-correct; its `__frameCache` fingerprint
(`length|first|last`) is collision-prone, which is now **confirmed** to cause
stale CONTENT (the frozen `Elapsed` counter, fixed in 0.3.3 — see the top
section) — still no explanation for displaced ROWS, and the collision cannot
produce them: it returns an older array, never a rewritten one.

Next step: capture the corrupting frame from a real session with
`PI_TUI_WRITE_LOG=<dir>` (tui terminal.ts logs every byte written), then check
whether pi emitted the mixed rows (pi/model bug) or the bytes are correct
(terminal-side). If pi's model is wrong, a window resize won't heal it; if the
terminal diverged, resize/scroll-away-and-back rewrites the rows. Ask the user
which it is.

