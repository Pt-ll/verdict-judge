# SPEC：Verdict · VSCode 本地评测系统

> 状态：Draft v0.2（范围收敛：传统题 / 交互题 / testlib SPJ）
> 交付物：一个 **VSCode 扩展**（不是 CLI、不是本地服务部署、不是独立 GUI）。
> 平台：全平台 Windows / macOS / Linux，通过 Git 单一仓库在多机间同步。
> 约束：**完全离线、免费、零 API、零付费服务、零遥测**。扩展自身**零 npm 运行时依赖**（仅 Node 内置 + VSCode API）；仅调用用户本机已安装的编译器 / 解释器。
> 定位：在编辑器内完成「出题 → 造数据 → 评测 → 重测 → 榜单 → 导出」全流程的**自研本地评测系统**。
> 读者：开发者 + AI 编码助手。配合 `AGENTS.md` 使用。
>
> `Verdict` 为工作名，可随时重命名；本文后续统一使用该名。

---

## 1. 概述

### 1.1 一句话

Verdict 是一个 VSCode 扩展：把 OI / ICPC 风格的**本地评测系统**做进编辑器——支持传统题、交互题，内置 **testlib Special Judge**，支持测试点与子任务依赖、实数比较、榜单与成绩导出，并让每次评测都成为 VSCode 原生体验（Testing 面板、问题面板、原生 diff、一键调试）。

### 1.2 目标

1. 在 VSCode 内完成「新建比赛/题目 → 管理测试点与子任务 → 编译 → 评测 → 查看成绩与榜单 → 导出」全流程。
2. 判定语义完整、可预期：`AC / WA / TLE / MLE / OLE / RE / CE / PC`，支持部分分。
3. 支持 2 种题型（传统 / 交互）与 **testlib Special Judge**，以及子任务依赖计分。
4. 单个 VSIX 跨平台安装，纯 TypeScript，无原生二进制。
5. 完全离线、免费，不请求任何网络，不需要任何 API Key。
6. 相同 `(题目数据, 程序, 编译器, 配置)` 在允许误差内可复现；评测结果稳定、可导出。

### 1.3 非目标（本版明确不做）

- 不做在线评测、不抓取网页题面、不接入任何 LLM / 云服务。
- 不做硬性内存隔离的绝对保证（无原生模块时只能尽力而为，见 §8.3）。
- 不做分布式/多机评测。
- 本版不做提交答案题（output-only）与通信题（communication），推迟到后续（见 §19）。
- 不提供精确到 CPU 指令级的性能剖析。

### 1.4 前置假设

- 用户本机已安装至少一个编译器：`g++` / `clang++` / `cl`（MSVC）之一；解释型语言可选装 `python` 等。
- 扩展不捆绑编译器，只探测并调用。

### 1.5 术语

| 术语 | 含义 |
|---|---|
| 工作区（Workspace） | 一个评测工程的根，数据存于 `.verdict/` |
| 比赛（Contest） | 一组题目 + 选手的集合，是评测与榜单的顶层单位 |
| 题目（Problem） | 一道题，含类型、限制、测试点、子任务、比较方式 |
| 测试点（Test / TestCase） | 一对输入 `*.in` 与答案 `*.out` |
| 子任务（Subtask） | 一组测试点的集合，可有分值、依赖与计分方式 |
| 选手（Contestant） | 参赛者，对应一个源码文件夹 |
| 提交（Submission） | 某选手对某题的一次评测请求 |
| 判定（Verdict） | AC / WA / TLE / MLE / OLE / RE / CE / PC / UKE |
| 比较器（Comparator） | 默认 / 逐行 / 实数 / Special Judge / 交互 |
| Special Judge（spj） | 自定义校验程序，采用 **testlib** 调用约定：`checker <input> <output> <answer>`，以退出码给出 AC/WA/PE/UKE/PC |
| testlib | 竞赛评测事实标准库；SPJ / interactor 使用 `testlib.h` 编写 |
| 重测（Rejudge） | 对已有提交重新评测，受最大重测次数约束 |

### 1.6 命名与标识

| 项 | 值 |
|---|---|
| 扩展显示名 | `Verdict · VSCode 评测系统` |
| package.json `name` | `verdict` |
| publisher / 扩展 ID | `<publisher>.verdict` |
| 命令 / 配置前缀 | `verdict.` |
| 虚拟文档 scheme | `verdict://` |
| 工作区目录 | `.verdict/` |
| 输出通道 / 诊断集合 | `Verdict` / `verdict` |
| 活动栏容器 / 视图 | `verdict` / `verdict.controlPanel`（侧边栏面板，§4.12） |
| Testing 控制器 | `verdict` |
| 仓库目录名 | `verdict` |

---

## 2. 用户场景

```
场景 A：出题人办一场小型内部赛
  1. 命令「Verdict: 新建比赛」          -> 生成 .verdict/contest.json
  2. 「Verdict: 新建题目」              -> 选类型(传统/交互)、限制、分值
  3. 拖入 / 指定数据目录                -> 自动识别 1.in/1.out、2.in/2.out…
  4. 「Verdict: 配置子任务」            -> 勾选测试点、设分值、设依赖
  5. 指定 Special Judge / 实数比较      -> 保存到题目配置
  6. 指定选手文件夹                     -> 自动生成选手列表
  7. 「Verdict: 评测全部」              -> Testing 面板逐题跑，问题面板报 CE
  8. 「Verdict: 导出 HTML 成绩」        -> 生成自包含、可离线打开的 HTML

场景 B：选手本地自测
  1. 打开 solve.cpp                     -> 顶部 CodeLens「▶ 评测」「🐞 调试首测点」
  2. 评测结果回写到 Testing 面板 / 状态栏
  3. WA 时自动打开「我的输出 vs 标准答案」原生 diff，定位首个不同行
  4. 需要手动调试 -> 「🐞 调试」用首个测试点数据起一个调试会话

场景 C：题目包复用与迁移
  1. 「Verdict: 导出题目包」            -> 打包为可迁移目录/压缩包
  2. 「Verdict: 导入题目包」            -> 在另一台机器/仓库直接评测

场景 D：交互题
  1. 题目类型选「交互题」，指定基于 testlib 的 interactor
  2. 评测时选手程序与 interactor 通过管道对拷，超时/协议错误给对应判定
```

---

## 3. 插件架构

纯 TypeScript，运行在扩展宿主（Extension Host）内；编译与运行通过 `child_process.spawn` 异步执行，不阻塞 UI。

```text
┌───────────────────────── VSCode Extension Host (Node.js) ─────────────────────────┐
│                                                                                   │
│  UI 层 (src/vscode/)                                                              │
│   ├── commands        命令注册与调度            ├── diagnostics   Problems 面板    │
│   ├── codelens        文件顶部按钮              ├── testing       Testing 面板     │
│   ├── tree            活动栏: 比赛/榜单/提交     ├── webview       榜单/分数分布    │
│   ├── statusBar        评测进度                 ├── virtualDocs   verdict:// 文档   │
│   ├── config          读写 .verdict/            ├── debug         生成并启动调试会话│
│   └── diff            我的输出 vs 标准答案       └── htmlExport    自包含 HTML      │
│                                    │                                              │
│  Core 引擎 (src/core/，平台无关，零 vscode 依赖)   v                              │
│   ├── compiler    编译与缓存        ├── sandbox   进程执行/限额/杀树               │
│   ├── compare     默认/逐行/实数/spj ├── judge     单点判定 + 子任务计分            │
│   ├── problem     题目包读写         ├── contest   比赛/选手/重测/统计              │
│   ├── types       题目类型适配        ├── report    HTML/Markdown/JSON 报告         │
│   └── rng         确定性 PRNG        └── i18n      文案                           │
│                                    │                                              │
│                     child_process (spawn)  +  用户编译器/解释器                    │
└───────────────────────────────────────────────────────────────────────────────────┘
```

说明：
- **不使用 Worker、不安装原生模块、不联网**。长任务通过 `CancellationToken` + `spawn` 的异步性保持响应。
- Core 层不 import 任何 `vscode` 模块，便于单测与将来复用。
- 评测并发：默认串行；可选 `min(cpu数, 8)` 的多线程评测，命中即汇总。

---

## 4. VSCode 集成点

### 4.1 命令（contributes.commands）

| 命令 ID | 标题 | 说明 |
|---|---|---|
| `verdict.newContest` | Verdict: 新建比赛 | 生成 `.verdict/contest.json` |
| `verdict.newProblem` | Verdict: 新建题目 | 选类型/限制/分值 |
| `verdict.addTests` | Verdict: 导入测试点 | 扫描 `*.in/*.out` 并登记 |
| `verdict.configureSubtasks` | Verdict: 配置子任务 | 分值/依赖/计分方式 |
| `verdict.setLimits` | Verdict: 设置限制 | 时间/内存/栈/输出 |
| `verdict.setComparator` | Verdict: 设置比较方式 | 默认/逐行/实数/spj/交互 |
| `verdict.judgeCurrent` | Verdict: 评测当前文件 | 对当前题目跑当前源码 |
| `verdict.judgeProblem` | Verdict: 评测整题 | 全部测试点 |
| `verdict.judgeAll` | Verdict: 评测全部 | 全部选手 × 全部题目 |
| `verdict.rejudge` | Verdict: 重测 | 受最大重测次数约束 |
| `verdict.debugCase` | Verdict: 调试首测点 | 生成并启动调试会话 |
| `verdict.showDiff` | Verdict: 对比输出 | 打开 output vs answer diff |
| `verdict.openPackage` | Verdict: 打开题目包 | 在资源管理器定位 |
| `verdict.exportProblem` | Verdict: 导出题目包 | 生成可迁移目录/压缩包 |
| `verdict.importProblem` | Verdict: 导入题目包 | 从目录/压缩包导入 |
| `verdict.exportHtml` | Verdict: 导出 HTML 成绩 | 自包含、离线可开 |
| `verdict.showStandings` | Verdict: 显示榜单 | WebView |
| `verdict.cancel` | Verdict: 取消当前任务 | 中止评测/重测 |
| `verdict.checkEnv` | Verdict: 检查环境 | 探测编译器 |

### 4.2 CodeLens

在被识别为「选手源码 / 标准程序 / 生成器 / 交互器 / spj」的 C++ / Python 等文件顶部显示：
- `▶ 评测`、`🐞 调试首测点`、`⚙ 限制`；数据文件顶部显示 `📋 关联测试点`。

### 4.3 问题面板（Diagnostics）

归入 `DiagnosticCollection('verdict')`：
- **编译错误**：把编译器输出解析为 `file/line/col/message`，报 `Error`，可点击跳转。
- **Special Judge / interactor 编译错误**：报到对应文件。
- 评测判定本身不进问题面板（进 Testing 面板），仅 RE 的栈回溯行（若解析得到）可选报 `Warning`。

### 4.4 Testing API

注册 `TestController('verdict')`：
- 树结构：`比赛 > 题目 > 测试点 / 子任务`。
- 每个测试点是一个 `TestItem`，`run` 执行评测并回写状态；
- `debug` profile：用该测试点输入启动调试会话。
- 失败态在 Testing 侧边栏可见，可单独重跑。

> 实现进度：树结构、`run` profile 与 `debug` profile 都已落地（`src/vscode/testing.ts`）。
> M2 的树是「题目 > 子任务 > 测试点」，比赛那一层（§5.7）属于 M3。
> 调试入口一共有四处：Testing 面板的调试按钮、命令 `verdict.debugCase`、
> 源码顶部的 CodeLens「🐞 调试首测点」，以及评测失败通知里的「🐞 调试该测试点」
> （SPEC §4.8 说的「评测失败 → 一键起调试」）。

### 4.5 原生 diff

WA 时执行 `vscode.commands.executeCommand('vscode.diff', outputUri, answerUri, ...)`，两侧优先指向虚拟文档（见 §4.6），并显示首个不同行号。

### 4.6 虚拟文档

`TextDocumentContentProvider` 注册 scheme `verdict://`：
- `verdict://case/<problem>/<test>/input`
- `verdict://case/<problem>/<test>/output`（选手输出）
- `verdict://case/<problem>/<test>/answer`
- `verdict://report/<id>/standings.json`

只读；支持另存。

### 4.7 WebView

- **榜单**：选手 × 题目分数矩阵，按主题（IOI/JOI/plain）配色；单元格可点开单次提交详情。
- **统计**：分数分布直方图、各题通过率、时间/内存散点。
- 使用 `asWebviewUri` + nonce + 严格 CSP，**WebView 内不允许任何网络请求**；数据以 `postMessage` 注入；图表用原生 SVG 手写。

### 4.8 调试集成

`vscode.debug.startDebugging` 生成一份临时 `cppdbg`（cpptools）或 `debugpy`（Python）配置，注入首个测试点输入作为 stdin，实现「评测失败 → 一键起调试」。若用户未装对应调试扩展，给出可操作提示。

实现要点（`src/core/debug/launch.ts` 生成配置，`src/vscode/debug.ts` 负责起会话）：

- 调试用**调试版参数**另编一份（关优化、加 `-g` / `/Zi`），不复用评测产物：优化过的代码
  单步会跳、变量会被优化没。编译缓存键里含编译参数，两份产物互不干扰。
- stdin 注入：cppdbg / debugpy 都**没有**「把某个文件接到 stdin」的配置字段，只能借调试器
  自己的命令（lldb 用 `settings set target.input-path`，gdb 用 `set inferior-tty`），
  并标 `ignoreFailures`——两个调试器对这套命令的支持随版本而变，注入失败不该让整个会话起不来。
  MSVC 的 `cppvsdbg` 没有对应能力，只能手动喂输入，此时把输入文件路径明确告诉用户。
- 没装调试扩展时**提前**给出可操作提示、并直接带用户去扩展面板搜索，
  而不是让 `startDebugging` 抛一句 "no debug adapter"。
- 工作目录设成题目包根目录，程序读相对路径的数据文件时与出题人的预期一致
  （评测时 cwd 继承扩展宿主，SPEC 没有规定，也就不该指望它）。

已验证到什么程度（免得把「试过」当成「能用」）：

- **lldb 路径（macOS）已证明可用**：集成测试里放了一个探针程序，它在调试会话中把读到的
  stdin 写到文件，断言内容与测试点输入完全一致。这条命令是 `setupCommands` 里的
  `settings set target.input-path`，生效与否只能这样验，光看「命令发出去了」不算数。
- **gdb 路径（Linux）尚未验证**：用的是 `set inferior-tty`，标了 `ignoreFailures`，
  失败也不会让会话起不来；真没生效时退化成手动喂输入（输入文件路径会打在输出通道里）。
  本机没有 gdb，Linux CI 又没有 cpptools，所以这条只能留着待验。
- **MSVC（cppvsdbg）没有对应的注入能力**，只能手动喂；此时提示里会写清楚输入文件在哪。
- `verdict.debugStopAtEntry` 打开后停在程序入口（cpptools 用 `stopAtEntry`，
  debugpy 用 `stopOnEntry`）。

交互题的调试走另一条路：**录制-重放**。调试器里跑不了真实的两进程对话（断点一停，
交互器就等在那儿，两边都不动），所以先真跑一局，把「交互器发给选手」的那串字节写成
文件，调试会话就从这个文件读 stdin（`runConnected` 的结果里带上两个方向的字节流，
上限 64KB）。前提是选手的反应与录制时一致——自适应交互器会在第一次分歧之后对不上，
这一点写在提示里；完整对局记录也会落盘，方便复盘。

### 4.9 状态栏

- 评测中：`$(sync~spin) 评测 12/40 · AC 7 WA 3 TLE 2`。
- 空闲：`$(beaker) Verdict · 3 题 · 12 选手`。

### 4.10 输出通道

`OutputChannel('Verdict')`，分级日志（error/warn/info/debug）；默认 `info`，`verdict.debug` 开启 `debug`。

### 4.11 激活与配置贡献

- `activationEvents`：`onLanguage:cpp`、`onLanguage:c`、`workspaceContains:**/.verdict/contest.json`、`onStartupFinished`（当存在评测目录时）。
- 设置项：`verdict.compiler`、`verdict.flags`、`verdict.defaultTimeMs`、`verdict.defaultMemoryMb`、`verdict.outputLimitKb`、`verdict.testlibPath`、`verdict.parallelJudge`、`verdict.autoJudgeOnSave`、`verdict.reportDir`、`verdict.debug`。

实现现状：已落地 `compiler` / `flags` / `debug` / `defaultTimeMs` / `defaultMemoryMb` /
`outputLimitKb` / `comparator` / `realAbsEps` / `realRelEps` / `autoDiff` / `testlibPath` /
`debugStopAtEntry`。`parallelJudge`（并行评测）与 `autoJudgeOnSave`（保存即评测）
尚未实现；`reportDir` 暂未使用（导出 HTML 走保存对话框）。

### 4.12 侧边栏面板（活动栏，WebView）

**为什么要有它**：`problem.json` / `contest.json` 都能手写，但**大多数人不会去写 JSON**。
命令面板把「创建」图形化了，「看和改」却仍然要打开文件；评测、榜单、重测又散在命令面板、
Testing 面板与编辑器标签页里。所以补一个常驻面板：**活动栏上一个 Verdict 图标**，
点开就是整套操作台——参照 LemonLime 那类本地评测软件的做法，把出题、评测、看结果收进一个界面。

**设计原则：JSON 仍然是唯一的存储格式，面板只是它的一个视图。**

- 面板的每次编辑都走 `saveProblem` / `saveContest`，与手改文件完全等价；
- 磁盘上的文件被改动（编辑器里手改、git 切分支、另一个窗口改了）时面板跟着刷新；
- 于是「不想碰 JSON 的人用面板」与「想用 git 管数据的人继续手写」两不误，也没有第二份数据。

贡献点：

```jsonc
"viewsContainers": { "activitybar": [{ "id": "verdict", "title": "Verdict", "icon": "media/activity.svg" }] },
"views": { "verdict": [{ "type": "webview", "id": "verdict.controlPanel", "name": "评测面板" }] }
```

布局（三页签 + 常驻顶部/底部）：

```text
┌─ A. 求和 ──────────────────────────┐  顶部：当前题目、比赛、当前源码
│ 内部训练赛 #3 · 2 名选手            │  [▶ 评测] [🐞 调试] [■ 取消]
│ 源码：A.cpp                         │
├─────────────────────────────────────┤
│  题目  |  测试点  |  榜单            │  页签
├─────────────────────────────────────┤
│ 限制    1000ms / 256MB / 4096KB [编辑] │
│ 比较    default                 [切换] │
├─────────────────────────────────────┤
│ 小数据  30 分 · 依赖 无 · 组内全对     │
│  #1 [AC] 12ms 1.3MB      [▶][🐞][▸]  │
│ 大数据  70 分 · 依赖 无 · 组内全对     │
│  #2 [WA]  8ms 1.3MB      [▶][🐞][⇄][▸]│
│ [扫描新测试点][＋子任务][按点均分][清空]│
├─────────────────────────────────────┤
│ WA · AC 3/6 · 得分 30/100 · 214ms     │  底部：忙碌中/最近一次结果
└─────────────────────────────────────┘
```

- 「题目」页签：比赛信息（没有就一键新建）、题目列表、新建/导入/导出题目包、
  选中题目的**限制**与**比较方式**（五种模式都能在这里改，real 的 eps 与 spj / interactor
  的文件用文件选择器指定）。
- 顶部是**比赛选择器**：一个工作区可以有好几场，切换后题目、测试点、榜单全跟着换（§6.2）；
  旁边就是「再开一场」。题目行上有 `＋` / `−`（加入 / 移出当前比赛，题目库是共用的）
  与 `🗑`（删题：只从比赛移除 / 删题目包 / 连数据一起删，删除走系统回收站）。
- 「测试点」页签：按子任务分组的测试点表；每行给出最近一次判定、用时、内存，
  `▶` 只跑这一个点、`🐞` 用它起调试、`⇄` 开 diff、`▸` 展开看输入 / 标准答案 / 实际输出；
  子任务能改分值、依赖与组内计分（min / sum），也能增删、按点均分、清空；
  测试点可以改归属或移出登记（**只取消登记，不动 `data/` 里的文件**）。
- 「榜单」页签：紧凑的选手 × 题目矩阵，点单元格看详情并重测（受 `maxRejudge` 约束），
  一键「评测全部」、导出 HTML、或打开编辑器里那份完整榜单。
- 行的状态来自 `CaseDocumentStore`，与 Testing 面板、`verdict.showDiff` 共用同一份结果，
  不另算一套；**单点运行只更新那一个点**，不会把别的点的输出清掉。

消息协议（与榜单 WebView 同一套做法，双向）：

| 方向 | 消息 | 说明 |
| --- | --- | --- |
| 面板 → 扩展 | `ready` / `refresh` / `selectProblem` / `selectContest` | 就绪、刷新、切换当前题目、切换当前比赛 |
| 面板 → 扩展 | `judge` / `judgeCase` / `debug` / `debugCase` / `openDiff` | 评测与运行 |
| 面板 → 扩展 | `setLimits` / `setComparator` / `pickComparatorFile` | 改限制与比较方式 |
| 面板 → 扩展 | `scanTests` / `moveTest` / `removeTest` / `addSubtask` / `removeSubtask` / `updateSubtask` / `evenSubtasks` / `clearSubtasks` | 改测试点与子任务 |
| 面板 → 扩展 | `openCaseFile` / `openDataDir` / `openProblemJson` | 用编辑器打开文件，不重造编辑器 |
| 面板 → 扩展 | `rejudge` / `cancel` / `command` | 重测、取消、执行白名单里的命令（`command` 可带一个 `arg`，例如题目 id） |
| 扩展 → 面板 | `data` | 比赛、题目、测试点、最近结果、榜单 |
| 扩展 → 面板 | `busy` / `notice` / `filePicked` | 进度、需要用户知道的一句话、选中的文件路径 |

安全与实现沿用榜单 WebView：CSP `default-src 'none'`、脚本与样式用 nonce、
数据全部 `postMessage` 注入、DOM 用 `createElement` / `textContent` 构建（不拼 HTML 字符串）。
面板的纯逻辑（改限制、加子任务、移归属……）都在 `core/problem/edit.ts` 里，是纯函数、可单测；
`src/vscode/panel/` 只负责把状态收出来、把消息接上。

单点运行的分数**是个下界**：子任务计分是拿整套数据算的，只跑一个点时依赖它的子任务会变成
0 分——所以 `ProblemResult.partial` 会标出来，面板在 partial 时干脆不显示总分，
只说「点『评测整题』看完整得分」。把那个 0 分当结论展示，是在骗人。

想看效果又不想起扩展宿主时，用 `src/tools/previewPanel.ts` 把面板渲染成一个普通网页
（见该文件头部的两行命令）。

---

## 5. 内核模块与接口（TypeScript）

Core 层零 `vscode` 依赖。

### 5.1 模型

```ts
// src/core/model.ts
export type ProblemType = 'traditional' | 'interactive';
export type Verdict =
  | 'AC' | 'WA' | 'TLE' | 'MLE' | 'OLE' | 'RE' | 'CE' | 'PC' | 'UKE';

export interface Limits {
  timeMs: number;        // 默认 1000
  memoryMb: number;      // 默认 256
  stackMb?: number;      // 默认与内存限制相同
  outputKb: number;      // 默认 4096，stdout/stderr 各自截断
  procCount?: number;    // 进程/线程数上限（尽力而为）
}

export interface TestCase {
  id: string;            // '1', '2', ... 或 'sample1'
  input: string;         // 相对题目包路径
  answer: string;        // 相对题目包路径
  points: number;
  subtask?: string;
  validator?: string;    // 可选：数据合法性校验器
}

export interface Subtask {
  id: string;
  name?: string;
  points: number;
  tests: string[];
  dependsOn: string[];   // 子任务依赖
  scoring: 'min' | 'sum'; // 子任务内计分：取最小 / 求和
}

export interface ComparatorConfig {
  mode: 'default' | 'line' | 'real' | 'spj' | 'interactive';
  absEps?: number;       // real 模式绝对误差
  relEps?: number;       // real 模式相对误差
  spj?: string;          // spj 源码/可执行文件路径
  interactor?: string;   // 交互题交互器
}

export interface Problem {
  id: string;
  name: string;
  type: ProblemType;
  limits: Limits;
  comparator: ComparatorConfig;
  subtasks: Subtask[];
  tests: TestCase[];
  sourceDir: string;
  answerDir: string;
}

export interface Contestant { id: string; name: string; folder: string }

export interface Contest {
  id: string;
  title: string;
  problems: Problem[];
  contestants: Contestant[];
  maxRejudge: number;    // 最大重测次数
}
```

### 5.2 Compiler（编译）★

```ts
export type CompilerKind = 'g++' | 'clang++' | 'cl' | 'python' | 'custom';

export interface CompileOptions {
  flags: string[];        // 默认 ['-O2','-std=c++17','-static','-DONLINE_JUDGE']
  stackBytes?: number;    // MinGW 下映射为 -Wl,--stack,<bytes>
  defines?: Record<string, string>;
  includeDirs?: string[]; // 附加 -I；SPJ / interactor 注入 testlib.h 所在目录（§6.6）
}

export interface CompileDiagnostic {
  file: string; line: number; column: number; message: string; raw: string;
}

export interface CompileResult {
  ok: boolean;
  exe: string;                 // 缓存目录中的可执行文件路径（解释型语言为空）
  runCmd: { cmd: string; args: string[] };
  diagnostics: CompileDiagnostic[];
  compilerVersion: string;
}

export interface Toolchain {
  detect(prefer?: CompilerKind): Promise<{ kind: CompilerKind; path: string; version: string } | null>;
  compile(srcPath: string, opts: CompileOptions): Promise<CompileResult>;
}
```

约定：
- 探测顺序：`g++` → `clang++` → `cl`；Windows 上尝试 `g++.exe` 等；解释型语言按 `python` 等。
- Windows 下 `cl` 需定位 VS 开发环境（vswhere + vcvars），失败则明确提示"未找到可用编译器"。
- `-static` 仅对 MinGW 生效；其他平台自动去除。
- 缓存键 = `sha256(源码) + flags + 编译器版本 + 栈设置`，产物存 `context.globalStorageUri/cache/`。
- 编译失败返回结构化诊断，不抛异常。

### 5.3 Sandbox（进程执行）★

```ts
export type RunVerdict = 'OK' | 'TLE' | 'MLE' | 'OLE' | 'RE' | 'INTERNAL';

export interface RunResult {
  status: RunVerdict;
  exitCode: number | null;
  signal: string | null;
  stdout: Buffer;
  stderr: Buffer;
  wallMs: number;
  cpuMs: number | null;    // 平台支持时提供
  peakMemKb: number;
  truncated: boolean;
}

export interface Sandbox {
  run(cmd: { cmd: string; args: string[] }, stdin: Buffer, lim: Limits,
      token?: CancellationTokenLike): Promise<RunResult>;
  runInteractive(a: { cmd: string; args: string[] },
                 b: { cmd: string; args: string[] },
                 lim: Limits, token?: CancellationTokenLike): Promise<{ a: RunResult; b: RunResult }>;
}
```

- `runInteractive` 同时启动两个进程，用双管道互连（交互题）。
- 执行与限额细节见 §8。

实现说明：落地时叫 `runConnected(primary, secondary, primaryLimits, secondaryLimits, token?)`，
两边各有自己的限额（选手用题目限制，交互器用放宽后的），总时限取选手的时限——交互的墙钟时间
由选手的表现决定，交互器不该另算一份。返回值是两侧的 `RunResult` 加一个 `endedFirst`，
因为判定时需要知道「谁把谁等死了」。一边结束时必须关掉另一边的 stdin，否则对端会一直等输入，
整场评测就卡在那里；结束前两边都要杀掉，不留孤儿进程。

### 5.4 Comparator（比较）★

```ts
export interface ComparatorInput {
  input: Buffer; output: Buffer; answer: Buffer;
}

export interface CompareResult {
  verdict: 'AC' | 'WA' | 'PC' | 'UKE';  // UKE：该比较方式尚未实现，如实上报而不是假装判过
  scoreRatio: number;        // 0..1，spj 可给部分分
  detail: string;
  firstDiffLine?: number;    // 逐行模式
}

export interface Comparator {
  config: ComparatorConfig;
  compare(x: ComparatorInput, sandbox: Sandbox): Promise<CompareResult>;
}
```

实现：
- **default**：忽略行尾空白与末尾空行，按行比较；不同则 `WA`。
- **line**：与 default 相同，但额外报告**首个不同行号**。
- **real**：逐 token 按数值比较，同时满足**绝对误差**与**相对误差**（`|a-b| <= absEps || |a-b| <= relEps*|b|`）；对 `nan`/`inf` 做专门判定（同号 nan/inf 视为相等）。
- **spj（testlib）**：编译 spj 源码（需能 include 到 `testlib.h`，见 §6.6），按 testlib 约定调用 `checker <input> <output> <answer>`，依据退出码判定：
  - `0` → AC；`1` → WA；`2` → PE（本版映射为 WA）；`3` → UKE（checker 自身失败）；
  - `7`（`_points` / `_pc`）→ PC，checker 向 stdout 输出 `0..100` 的得分，按比例折算 `scoreRatio`；
  - 其他退出码 → UKE；checker 的 stderr 作为 `detail` 记录。
- **interactive**：见 §5.6。

### 5.5 Judge（单点判定 + 子任务计分）★

```ts
export interface CaseResult {
  test: string;
  verdict: Verdict;
  score: number;
  timeMs: number;
  memoryKb: number;
  exitCode: number | null;
  signal: string | null;
  message?: string;
  output: Buffer;            // 实际输出，供 diff / 报告使用
  answer: Buffer;            // 标准答案
  firstDiffLine?: number;    // line 模式下的首个不同行
}

export interface SubtaskResult {
  id: string;
  score: number;
  maxScore: number;
  status: 'full' | 'partial' | 'none' | 'skipped';
}

export interface ProblemResult {
  problem: string;
  score: number;
  maxScore: number;
  cases: CaseResult[];
  subtasks: SubtaskResult[];
  elapsedMs: number;
}

export class Judge {
  constructor(sandbox: Sandbox, options: { limits: Limits; comparator: ComparatorConfig });
  judgeCase(test: JudgeCaseInput, token?: CancellationTokenLike): Promise<CaseResult>;
}

/** 题目级评测：逐测试点跑完，再按子任务计分。 */
export function judgeProblem(
  pkg: ProblemPackage,
  runCmd: { cmd: string; args: string[] },
  sandbox: Sandbox,
  token?: CancellationTokenLike,
  onProgress?: (stage: string) => void,
): Promise<ProblemResult>;

/** 计分单独成模块，纯函数、可单测（src/core/judge/score.ts）。 */
export function scoreProblem(problem: Problem, cases: CaseResult[]): {
  subtasks: SubtaskResult[];
  score: number;
  maxScore: number;
};
```

与上面草图的差异（实现以本节为准）：

- `judgeProblem` 收 `ProblemPackage` 而不是 `Problem`：测试点路径相对题目包根目录，
  没有 `rootDir` 就还原不出绝对路径。
- 预热（§9）不在这里做：那是「编译产物是不是新写的」这类知识，属于上层 `engineFacade`。
- 不属于任何子任务的测试点直接计入总分，不会因为加了子任务就凭空消失。

判定流程（单测试点）：

```
1. 准备输入：传统题用 test.input；交互题走 runInteractive。
2. 运行选手程序，施加 Limits。
3. 状态优先级：
     被超时/取消杀死      -> TLE
     超过内存上限并杀      -> MLE
     输出超过 outputKb     -> OLE
     exitCode != 0        -> RE
     否则                 -> OK，进入比较
4. 比较：
     CE 由编译阶段单独给出；比较通过 -> AC；否则 WA / PC。
5. 记录 timeMs / peakMemKb。
```

子任务计分：

```
按依赖拓扑排序逐个计算子任务：
  若依赖的子任务 status != 'full' -> 本子任务 status='skipped'，score=0；
  否则 scoring='min' -> 本子任务分 = 每个测试点得分的最小值折算
       scoring='sum' -> 求和后按满分折算
总分 = 各子任务得分之和（无子任务时为各测试点得分之和）。
```

### 5.6 题目类型适配（types/）★

```ts
export interface ProblemTypeAdapter {
  type: ProblemType;
  judgeCase(problem: Problem, test: TestCase, run: PreparedRun,
            ctx: JudgeContext): Promise<CaseResult>;
}
```

- **traditional**：标准 stdin → stdout，交给 Comparator（default / line / real / spj）。
- **interactive（交互题）**：选手程序与基于 testlib 的 `interactor` 通过 `runInteractive` 互连，最终输出由 Comparator 比较（本版只确保 C++）。

实现说明（与上面那句话的差异，以这里为准）：交互题**由 interactor 当裁判**，不再拿选手的
stdout 去和 `.out` 比——那份数据已经在对话里被消耗掉了，硬要比只会比出个假结论。
interactor 用与 checker 相同的退出码协议（0/1/2/3/7），判定优先级是：

1. 选手被限额杀 → TLE / MLE / OLE（§8.5 的优先级最高，交互题也不例外）；
2. 选手自己崩了而交互器只说「答案不对」→ RE：交互器看到 EOF 就会判错，照它报 WA 会把
   「程序崩溃」这个真正的根因藏起来；
3. 其余情况以交互器的退出码为准；
4. 交互器没能正常结束（被限额杀、退出码不认识）→ UKE：那是出题人的问题。

交互题的部分分写在 **stderr** 上（它的 stdout 是对话通道，写分数会把协议弄脏），所以
退出码 7 的分数在 stdout 与 stderr 两处都会去认。

写 checker 时的一条硬提醒：**不要按字节比较输出**。Windows 上程序写出的 `\n` 会变成 `\r\n`，
按字节比会把一份完全正确的输出判成 WA（我们的 default 比较器忽略行尾空白与 CR，正是同一个原因）。
按 token 或用 `InStream::readWord` 这类读法，跨平台才成立。

### 5.7 Contest（比赛/选手/重测/统计）

```ts
export interface Submission {
  id: string;
  contestant: string;
  problem: string;
  source: string;
  language: string;
  result?: ProblemResult;
  rejudgeCount: number;
  time: string;
}

// 实现补充：Submission 还有可选的 verdict / message。正常评测时 verdict 等于
// result.cases 里最严重的那一个（同一处算出来，不会打架）；编译失败时 cases 是空的，
// 只有它能说明发生了什么——把 CE 标成 UKE 会让人以为是评测环境的问题。

export interface StandingsCell { contestant: string; problem: string; score: number; verdict: Verdict | null }
export interface Standings {
  cells: StandingsCell[];
  totals: { contestant: string; score: number }[];
  ranks: { contestant: string; rank: number; score: number }[];
}

export function computeStandings(contest: Contest, subs: Submission[]): Standings;
export function canRejudge(sub: Submission, contest: Contest): boolean;
export function summaryStats(contest: Contest, subs: Submission[]): ContestStats;
```

- 重测：`rejudgeCount < contest.maxRejudge` 才允许；UI 仅对允许项启用。
- 统计：均分/最高/最低、各题通过率、时间与内存分布。

### 5.8 Problem Package（题目包读写）

```ts
export interface ProblemPackage {
  problem: Problem;
  rootDir: string;
  dataDir: string;       // *.in / *.out
  extraDir: string;      // checker / interactor / std / gen
}
export function loadProblem(rootDir: string): Promise<ProblemPackage>;
export function saveProblem(pkg: ProblemPackage): Promise<void>;
export function scanTests(dataDir: string): Promise<TestCase[]>;
export function exportProblemPackage(pkg: ProblemPackage, dest: string): Promise<void>;
export function importProblemPackage(src: string): Promise<ProblemPackage>;
```

- `scanTests` 自动识别 `1.in/1.out`、`test1.in/test1.out`、`sample*`、`*.ans` 等命名约定，并保持稳定顺序。
- 所有写操作仅限 `.verdict/` 与题目数据目录，绝不改动选手源码。

#### 5.8.1 M1 的过渡：`findTestsBesideSource`

题目包（`problem.json`）在 M2 才落地，但 M1 的验收要求「编辑器里评测当前文件」就能用，
因此先提供一个纯约定式的查找函数，按以下顺序定位测试数据：

1. 与源文件同名的一对：`solve.cpp` → `solve.in` + `solve.out` / `.ans` / `.expected`；
2. 同级 `tests/` 或 `test/` 目录，交给 `scanTests`；
3. 源文件所在目录，交给 `scanTests`。

都没有时返回 `null`，UI 给出可操作的提示。M2 引入题目包后，这里退化为「没有 `problem.json` 时的兜底」。

### 5.9 Report（导出）

```ts
export interface ReportOptions { theme: 'ioi' | 'joi' | 'plain'; embedData: boolean }
export function standingsToHtml(contest: Contest, standings: Standings, opts: ReportOptions): string;
export function reportToMarkdown(r: ProblemResult): string;
export function reportToJson(r: ProblemResult): string;
```

实现补充：`standingsToHtml` 还有可选的第四个参数（`submissions`）。给了才能把逐测试点
结果内嵌进去、让单元格可点开详情；不给就退化成一张纯静态表格。`embedData: false` 同理。
「自包含」有测试兜着：输出里不允许出现 `http://`、`<link`、`<script src`、`@import`、`url(`。

- HTML **自包含**：内联 CSS、内联数据（JSON）、无外部字体/脚本/CDN，可离线双击打开。
- 分数单元格按主题着色，并带分数变化色阶。

### 5.10 RNG（造数据确定性，可选模块）

```ts
export interface Rng { nextU32(): number; int(minIncl: number, maxExcl: number): number }
export function splitmix64(seed: bigint): Rng;
```

仅用整数运算，禁止浮点，保证跨平台一致（供后续"数据生成器"使用）。

---

## 6. 数据模型与文件格式

### 6.1 工作区目录

```text
.verdict/
├── contests/                  # 每场比赛一个文件，可以放好几场（§6.2）
│   └── <contestId>.json
├── submissions/               # 提交记录，一场一份（运行产物，可选，便于榜单恢复）
│   └── <contestId>.json
├── data/                      # 测试数据总库：一个题目一个文件夹，用文件夹名区分题目
│   └── <problemId>/           # 1.in 1.out 2.in 2.out ...
└── problems/
    └── <problemId>/
        ├── problem.json       # 题目：类型/限制/比较/子任务/测试点
        └── extra/             # std.cpp checker.cpp interactor.cpp gen.cpp ...
```

**数据目录的解析顺序**（实现见 `src/core/problem/package.ts`）：

1. `problem.json` 的 `dataDir`（显式指定，相对题目包根目录）；
2. `<题目包>/data`（0.1.2 及更早的布局：存在就用它，老工作区不用搬数据）；
3. `.verdict/data/<problemId>`（测试数据总库，0.1.3 起新建题目的默认位置）。

第 3 条只在题目包位于 `.verdict/problems/<id>/` 时成立——题目包可以被放在工作区任何地方，
那种情况下没有「总库」可言，退回包内的 `data/`。0.1.2 与 0.1.3 两套布局因此能共存。

测试点路径（`tests[].input` / `answer`）**相对数据目录**。旧文件里写的 `data/1.in`
（相对题目包根目录）在加载时被归一成 `1.in`：两种写法指向同一个文件，不迁移也能跑。
真要引用数据目录里名为 `data` 的子目录，写成 `./data/x.in` 就不会被归一。

### 6.2 `contest.json`

```jsonc
{
  "version": 1,
  "id": "internal-2026",
  "title": "内部训练赛 #3",
  "maxRejudge": 3,
  "problems": ["A", "B", "C"],
  "contestants": [
    { "id": "alice", "name": "Alice", "folder": "players/alice" },
    { "id": "bob",   "name": "Bob",   "folder": "players/bob" }
  ]
}
```

0.1.3 起比赛文件落在 `.verdict/contests/<contestId>.json`：**一个工作区可以放好几场比赛**，
id 以文件名为准（文件里的 `id` 字段与文件名不一致会当场报错），重名同样报错。
0.1.2 的 `.verdict/contest.json` 继续读（`id` 取文件里的字段），两种布局可以共存。
评测记录跟着比赛走：新布局是 `.verdict/submissions/<contestId>.json`，
旧布局仍是 `.verdict/submissions.json`。

**题目库是全局共用的**：比赛只记题目 id 列表，题目包与数据都在 `.verdict/` 下各占一份。
于是同一道题可以同时出现在多场比赛里，各场的分数、榜单、重测次数互不干扰；
「把题目加入 / 移出当前比赛」改的只是这一场的 id 列表（面板上的 `＋` / `−`，
命令 `verdict.addProblemToContest` / `verdict.removeProblemFromContest`）。

`problems` 可以是空数组——刚建出来的比赛就是这样（先建比赛、再加题）；`contestants` 也可以不写：
`players/` 下每个**含源码的子目录**会被自动当成一名选手（id 与显示名取目录名，按数字感知排序）。
显式写过的以显式配置为准；自动发现的选手不会被写回文件。

### 6.3 `problem.json`

```jsonc
{
  "version": 1,
  "id": "A",
  "name": "A. 求和",
  "type": "traditional",
  "limits": { "timeMs": 1000, "memoryMb": 256, "stackMb": 256, "outputKb": 4096 },
  "comparator": { "mode": "default" },
  "subtasks": [
    { "id": "1", "points": 30, "tests": ["1","2","3"], "dependsOn": [], "scoring": "min" },
    { "id": "2", "points": 70, "tests": ["4","5","6"], "dependsOn": ["1"], "scoring": "min" }
  ],
  "tests": [
    { "id": "1", "input": "1.in", "answer": "1.out", "points": 10, "subtask": "1" }
  ],
  "sourceDir": "players/*/A",
  "answerDir": "players/*/A"
}
```

字段说明（实现见 `src/core/problem/package.ts`；加载时校验，一次列出全部问题）：

- `tests` 可以省略（或写 `[]`）：此时扫描 `data/` 下的 `1.in/1.out`、`*.ans`、`sample*` 等命名约定，
  按数字序排列（`2` 排在 `10` 前）。测试点路径一律相对**数据目录**（§6.1），即写成 `1.in`；
  0.1.2 的 `data/1.in` 也照读（加载时归一）。
- `dataDir` 可选：数据放在别处时写它（相对题目包根目录，例如 `"../../shared/A"`）。
  既不是包内 `data/`、也不是总库约定位置时才写回文件——约定位置跟着题目包算，搬走也不会失效。
- 子任务成员关系以 `subtasks[].tests` 为准；只有它是空的时候，才用测试点的 `subtask` 字段补出来。
  两边说法不一致会直接报错——宁可让人改一处配置，也不要悄悄按其中一个算分。
- 非法数值、引用不存在的测试点或子任务、依赖成环、重复 id、空子任务，都会在加载时报错。
- `limits.procCount`（§5.1 标为「尽力而为」）本版没有实现：写了会明确报错，不静默忽略。
- 未知字段原样保留在 `_raw` 里，写回时先摊开它再覆盖已知字段，因此 round-trip 不丢字段（§6.5）。

### 6.4 比较配置示例

```jsonc
// 实数比较
"comparator": { "mode": "real", "absEps": 1e-6, "relEps": 1e-6 }
// testlib Special Judge
"comparator": { "mode": "spj", "spj": "extra/checker.cpp" }
// 交互题（testlib interactor）
"comparator": { "mode": "interactive", "interactor": "extra/interactor.cpp" }
```

### 6.5 格式策略

- `contest.json` / `problem.json` 为**自有 JSON 格式**：简洁、易 diff、可 git。
- 通过 `exportProblemPackage` / `importProblemPackage` 在目录与 ZIP 之间迁移题目包；ZIP 使用 Node 内置 `zlib` 手写打包（零依赖）。
- 未知字段保留在 `_raw` 中，导入导出不丢失（尽力而为）。

### 6.6 testlib.h 解析

SPJ / interactor 均依赖 `testlib.h`。扩展**不捆绑**、不联网下载，按以下顺序解析其所在目录，并作为编译时 `-I` 参数注入：

1. 题目包 `extra/` 目录（随题目自带 `testlib.h`，推荐，保证可迁移）；
2. 工作区 `.verdict/testlib/`；
3. 用户设置 `verdict.testlibPath` 指向的目录或文件。

均未找到时给出可操作提示（"请将 testlib.h 放入 extra/ 或配置 verdict.testlibPath"），checker 编译失败记为该点 `UKE`（非 CE）。

---

## 7. 配置

### 7.1 工作区配置 `.verdict/contest.json` + `problem.json`

见 §6；可提交、可分享。

### 7.2 VSCode 设置（用户级）

| 设置 | 默认 | 说明 |
|---|---|---|
| `verdict.compiler` | 自动探测 | 指定 `g++`/`clang++`/`cl` 路径 |
| `verdict.flags` | `["-O2","-std=c++17"]` | 编译参数 |
| `verdict.defaultTimeMs` | 1000 | 新题默认时限 |
| `verdict.defaultMemoryMb` | 256 | 新题默认内存 |
| `verdict.outputLimitKb` | 4096 | 输出上限 |
| `verdict.testlibPath` | 空 | testlib.h 所在目录（SPJ / interactor 编译用，见 §6.6） |
| `verdict.parallelJudge` | false | 多线程评测 |
| `verdict.autoJudgeOnSave` | false | 保存即评测当前题 |
| `verdict.reportDir` | `.verdict-out` | 导出目录 |
| `verdict.debug` | false | debug 日志 |
| `verdict.defaultTimeMs` | 1000 | 评测当前文件时的时间限制 |
| `verdict.defaultMemoryMb` | 256 | 评测当前文件时的内存限制，同时作为栈上限 |
| `verdict.outputLimitKb` | 4096 | 评测当前文件时的输出上限 |
| `verdict.comparator` | `default` | 评测当前文件时的比较方式（`default` / `line` / `real`）；M2 起由 `problem.json` 覆盖 |
| `verdict.realAbsEps` | 1e-6 | `real` 比较的绝对误差 |
| `verdict.realRelEps` | 1e-6 | `real` 比较的相对误差 |

工作区文件优先于用户设置；两者都不存在时使用内置默认值。

---

## 8. 沙箱跨平台实现

### 8.1 执行与超时

- `child_process.spawn(cmd, args, { stdio: ['pipe','pipe','pipe'] })`，写入 stdin，累积 stdout/stderr（超 `outputKb` 截断并标记）。
- 超时：`setTimeout(timeMs)` → 杀进程树：
  - POSIX：`spawn` 时 `detached: true` 建立进程组，`process.kill(-pid, 'SIGKILL')`。
  - Windows：`taskkill /PID <pid> /T /F`。
- 取消令牌触发同样的杀树逻辑。

### 8.2 时间统计

- 以 **wall time** 为超时基准（跨平台可靠）。
- POSIX 下可额外尝试 CPU time：通过包装 `sh -c 'ulimit -t <sec>; exec "$0" "$@"'` 施加 CPU 限额，并可用 `/usr/bin/time`（若存在）读取；不存在则 `cpuMs=null`。
- `wallMs` 与 `cpuMs` 均记录，不参与"确定性"判定。

### 8.3 内存限制

- **尽力而为**（无原生模块）：
  - Linux：25ms 轮询 `/proc/<pid>/status` 的 `VmRSS` 作为**限额判据**；同时用 `sh -c 'ulimit -v <2×kb>; exec "$0" "$@"'`
    加一层**兜底**。兜底刻意取 2 倍而非等于限额：虚拟内存 ≥ 常驻内存，若把 `ulimit -v` 卡在限额上，
    程序会在采样发现超限之前就先 `malloc` 失败并崩溃，把 MLE 误判成 RE。
  - macOS：`ulimit -v` 在部分版本不生效，仅轮询 `ps -o rss= -p <pid>`；超限杀树。
  - Windows：`tasklist /FI "PID eq <pid>" /FO CSV /NH` 解析工作集；超限杀树。
- 取采样最大值作为 `peakMemKb`；一旦超过 `memoryMb` 判 `MLE` 并杀树。
- **限制是"采样 + 超限杀"**，存在采样间隔内的短暂超标；不提供硬性上限（见 §11）。
- CPU 时间兜底：POSIX 下用 `ulimit -t` 施加 CPU 秒数上限；被内核以 `SIGXCPU` 杀死时判 TLE。

### 8.4 栈限制

- POSIX：`ulimit -s` 施加（默认与内存限制相同）。
- Windows/MinGW：编译时 `-Wl,--stack,<bytes>`。MSVC：`/STACK:<bytes>`。

### 8.5 状态判定（优先级）

```
被超时/取消杀死        -> TLE
超过内存上限并杀        -> MLE
stdout 超 outputKb      -> OLE
exitCode != 0          -> RE
否则                   -> OK
启动失败               -> INTERNAL
```

### 8.6 运行模型

- 单线程异步；评测并发由 `parallelJudge` 控制，默认串行。
- 不使用 Worker；`spawn` 的异步性足以保持 UI 响应。

---

## 9. 确定性与性能

- **确定性**：相同 `(题目数据, 程序, 编译器, flags, 配置)` 在同一机器上两次评测，判定与分数一致；输出 diff 一致。
- `wallMs`、`peakMemKb`、`cpuMs` 受系统影响，不参与判定的"确定性"。
- 编译缓存（`sha256(源码)+flags+编译器版本`）在整个会话内有效。
- 性能目标：

  | 项 | 目标 |
  |---|---|
  | 单次 spawn 开销（不含被测程序） | < 50ms |
  | 扩展空闲内存 | < 150MB |
  | 单题评测默认预算 | 受测试点数与时限约束，可取消 |
  | UI 响应 | 任意时刻不阻塞 > 100ms |

> **预热**：macOS 上「刚写入磁盘的可执行文件」首次执行要 400-900ms（内核的代码校验），
> 之后只要几毫秒。若不处理，一个刚编译好的正确程序在默认 1 秒时限下会被误判 TLE。
> 因此 `engineFacade` 在新编译（非缓存命中）后先用空输入空跑一次，结果整体丢弃，代价约 0.2 秒。
> 副作用是被测程序多执行一次——OI 程序约定为 stdin 到 stdout 的纯变换，故可接受。

---

## 10. 错误处理与日志

- Core 层所有函数以 `Error` 返回失败，不抛出到 UI 之外。
- UI 层统一捕获 → 弹 `showErrorMessage` + 写 Output Channel。
- 编译器缺失、无题目/选手、数据缺失、spj 编译失败、交互协议错误等给出**可操作的提示**。
- 非 UTF-8 数据文件按字节处理（评测以字节流为准，比较器内部按行 / token 处理）。
- 日志级别默认 `info`；`verdict.debug` 开启 `debug`。
- 全程不收集/上传任何数据；扩展不含任何网络调用（CI 断言，见 §18）。

---

## 11. 已知限制

1. 内存限制为采样式，非硬上限（§8.3）。
2. macOS 的内存采样依赖外部命令 `ps`。若运行环境禁止执行 `ps`（某些受安全策略约束的沙箱），
   采样恒为失败，内存超限将无法判定，程序会一直跑到时限为止并判 TLE。
3. 交互题暂时只确保 C++；SPJ / interactor 基于 testlib，需自备或指定 `testlib.h`（§6.6）。
4. 实数比较按 token 数值比较，不支持自定义解析（可改用 spj）。
5. 本版不支持提交答案题（output-only）与通信题（communication），见 §19。
6. 多线程评测为实验特性，可能影响计时稳定性。
7. 需要用户自备编译器；MSVC 依赖 VS 开发环境定位，可能失败后回退。
8. `cpuMs` 恒为 `null`：用 `/usr/bin/time` 包装会把被测程序变成孙子进程，破坏 RSS 采样的目标 pid；
   跨平台可靠的口径是 `wallMs`（§8.2）。
9. macOS 上 `abort()` 之类的崩溃要等系统写完崩溃报告，实测约 260ms 才真正退出；
   机器繁忙时更久。给 RE 的用例设置接近默认的时限时，可能先撞上超时而被判成 TLE。
10. 栈上限只在 Windows 编译期施加（MinGW `-Wl,--stack` / MSVC `/STACK:`）；POSIX 一律用运行时
    `ulimit -s`。在 macOS/Linux 上传 `-Wl,--stack` 会让链接器直接报错，表现为整次编译 CE。
11. 评测会为了预热多执行被测程序一次（仅限新编译的产物，见 §9）。若题目程序有读写文件的副作用，
    预热会带来一次额外副作用。

---

## 12. 里程碑与验收标准

### M1 — 骨架 + 编译运行 + 单点判定
交付：`package.json` 贡献点、`extension.ts` 激活、`checkEnv`、`compiler`、`sandbox`（三平台）、`compare`（default/line/real）、`judgeCurrent`、Diagnostics（编译错误）、Output、状态栏。
验收：
- Win/mac/Linux 三平台均能安装并激活（CI 通过）。
- 能探测到至少一个编译器；没有时给出明确引导。
- 死循环判 TLE；`abort()` 判 RE；超输出判 OLE；正常判 AC/WA 且时间合理。
- 编译错误能在问题面板定位到行列。

### M2 — 题目包 + 测试点 + 子任务 + Testing/diff
交付：`problem` 包读写、`scanTests`、`configureSubtasks`、子任务计分、Testing API、虚拟文档、`vscode.diff`（含首个不同行号）。
验收：
- 对已知正确/错误程序，判定与分数正确。
- WA 时自动打开 diff，首个不同行号正确。
- 子任务依赖：依赖未满分时后继子任务被 skip 且计 0 分。

### M3 — 比赛 + 选手 + 重测 + 榜单 + HTML
交付：`contest` 模型、`judgeAll`、`rejudge`（受上限）、`computeStandings`、榜单 WebView、`exportHtml`、统计。
验收：
- 多选手多题评测后榜单正确，最大重测次数约束生效。
- 导出的 HTML 自包含、离线可开、表格可点开提交详情。

### M4 — 交互题 + testlib SPJ + 题目包导入导出 + 打包
交付：`interactive` 适配器、testlib SPJ 完整流程、`importProblem`/`exportProblem`（含 ZIP）、单 VSIX 打包。
验收：
- 一个 VSIX 可安装于三平台，无原生依赖、无网络请求。
- 交互题对拍正确、协议错误有明确判定。
- testlib checker 的 AC / WA / PE / 部分分（退出码 7）判定与折算正确（§5.4）。
- 题目包导出后可在另一工作区导入并成功评测。

### M5 — 侧边栏面板（不写 JSON 也能用）
交付：活动栏容器与 `verdict.controlPanel` 视图、`src/vscode/panel/**`、`core/problem/edit.ts`
的编辑函数、单测试点运行（`onlyTestIds` + `ProblemResult.partial`）、预览工具。
验收：
- 点活动栏图标就能看到面板：题目、测试点、限制、比较方式、子任务、榜单都在里面。
- 从空工作区开始，只用面板就能走完「新建比赛 → 新建题目 → 扫描测试点 → 评测 → 榜单」。
- 面板上的每次编辑都写进 `problem.json` / `contest.json`，与手改文件等价，改完仍能加载。
- 单点运行只更新那一个测试点，且分数被标成 partial、不当作整题结论展示。
- 面板里没有网络请求、没有 `innerHTML` 拼串（单测断言）。

### M6 — 数据总库 + 多场比赛 + 删题 + 成绩单详情（0.1.3）
交付：`.verdict/data/<题目 id>/` 总库与 `dataDir` 解析（含旧布局兼容）、
`.verdict/contests/<id>.json` 多场比赛与题目重叠、`verdict.deleteProblem`
（含「连数据一起删」与跨比赛摘除）、导出的成绩单带上逐题逐测试点详情、
面板上的比赛切换器与题目 `＋` / `−` / `🗑`。
验收：
- 老工作区（`.verdict/contest.json` + 包内 `data/` + `"data/1.in"`）不改一行也能继续评测。
- 同一道题出现在两场比赛里时，两边的榜单、重测计数、导出互不影响。
- 删题给的三个选项都只动该动的东西；题目在别的比赛里时先摘干净，不留下加载不出来的比赛。
- 导出的 HTML 断网可开，且不点任何单元格就能看到每道题的测试点清单。

---

## 13. 目录结构

```text
verdict-judge/
├── .vscode/                  # launch.json（运行扩展 / 以 testdata 为工作区）/ tasks.json / settings.json
├── .github/workflows/        # ci.yml（三平台矩阵：typecheck / lint / 单测 / 集成测试）
├── .gitattributes
├── .editorconfig
├── .gitignore
├── .nvmrc                    # 24（CI 与开发用；扩展运行时仍是 VSCode 自带的 Node 20）
├── .vscodeignore             # 改用 vsce 打包时的白名单（自己的打包器不读它）
├── package.json              # 扩展清单 + 贡献点（命令 / 视图 / 设置）+ scripts
├── tsconfig.json
├── esbuild.js                # 打包扩展（dev dep，无运行时依赖）
├── eslint.config.mjs         # 唯一的 lint 配置
├── pnpm-workspace.yaml       # allowBuilds：放行 esbuild 的安装脚本
├── scripts/package.js        # pnpm package 的入口：生产构建 + 打 VSIX
├── src/
│   ├── extension.ts          # activate / deactivate 与依赖装配
│   ├── engineFacade.ts       # 串起 core，向 UI 暴露任务 API + 进度事件
│   ├── core/                 # 平台无关内核（不 import vscode）
│   │   ├── model.ts          # 数据模型（Problem / Contest / Submission / 判定…）
│   │   ├── layout.ts         # 工作区布局常量与拼路径（§6.1）
│   │   ├── compiler.ts       # 编译器探测、编译与缓存
│   │   ├── zip.ts            # 手写 ZIP（只用内置 zlib；导入导出与 VSIX 共用）
│   │   ├── sandbox/
│   │   │   ├── sandbox.ts    # 接口与工厂
│   │   │   ├── posix.ts      # POSIX：进程组 + ulimit
│   │   │   └── windows.ts    # Windows：Job Object + taskkill
│   │   ├── compare/
│   │   │   ├── compare.ts    # 模式分派与 UKE 兜底
│   │   │   ├── prepare.ts    # checker / interactor 的编译准备
│   │   │   ├── default.ts    # 忽略行尾空白
│   │   │   ├── real.ts       # 实数（绝对 + 相对误差）
│   │   │   ├── spj.ts        # testlib checker（含退出码 7 部分分）
│   │   │   └── interactive.ts# testlib interactor
│   │   ├── judge/
│   │   │   ├── judge.ts      # 单点判定
│   │   │   └── score.ts      # 子任务计分
│   │   ├── problem/
│   │   │   ├── package.ts    # problem.json 读写、数据目录解析、测试点路径
│   │   │   ├── scan.ts       # 扫描数据目录与「源文件旁边」的约定式数据
│   │   │   ├── edit.ts       # 加测试点 / 子任务编辑（纯函数，可单测）
│   │   │   ├── subtasks.ts   # 子任务依赖拓扑排序
│   │   │   ├── archive.ts    # 题目包 ZIP 导入导出
│   │   │   └── testlib.ts    # testlib.h 查找
│   │   ├── contest/
│   │   │   ├── contest.ts    # contests/*.json 读写（含旧 contest.json 兼容）
│   │   │   ├── sources.ts    # 选手源码查找
│   │   │   ├── plan.ts       # 选手 × 题目任务规划
│   │   │   ├── submissions.ts# 评测记录读写与合并
│   │   │   └── standings.ts  # 榜单、最优提交、重测上限
│   │   ├── report/
│   │   │   ├── html.ts       # 自包含成绩单（含题目与测试点清单）
│   │   │   ├── markdown.ts   # Markdown 报告（暂无命令入口）
│   │   │   └── json.ts       # JSON 报告（暂无命令入口）
│   │   └── debug/launch.ts   # 生成各调试器的 launch 配置
│   ├── vscode/               # 仅此目录依赖 vscode API
│   │   ├── commands.ts       # 评测 / 取消 / 检查环境
│   │   ├── problemCommands.ts# 题目包相关命令、改题与删题
│   │   ├── contest.ts        # ContestSession：多场比赛、评测全部、重测、导出
│   │   ├── controlPanel.ts   # 活动栏侧边栏面板的 provider 与消息路由（§4.12）
│   │   ├── caseDocs.ts       # verdict:// 虚拟文档 + 原生 diff
│   │   ├── codelens.ts       # ▶ 评测 / 🐞 调试首测点 / ⚙ 限制
│   │   ├── diagnostics.ts    # 编译错误进问题面板
│   │   ├── testing.ts        # Testing 面板：题目 > 子任务 > 测试点
│   │   ├── standingsView.ts  # 完整榜单 WebView
│   │   ├── statusBar.ts
│   │   ├── output.ts
│   │   ├── config.ts         # 把 VSCode 设置读成内核参数
│   │   ├── workspace.ts      # 题目包发现与工作区根
│   │   ├── debug.ts          # 起调试会话（stdin 注入 / 交互题录制-重放）
│   │   └── panel/            # 面板的纯 UI 层
│   │       ├── html.ts       # 模板 + CSS + 脚本（CSP nonce，无网络）
│   │       └── state.ts      # 采集面板状态
│   ├── tools/                # 构建期工具，不进扩展本体
│   │   ├── vsix.ts           # 自写 VSIX 打包器（零依赖）
│   │   └── previewPanel.ts   # 把面板渲染成普通网页，调样式用
│   └── util/                 # 两端共用的纯函数
│       ├── files.ts
│       ├── json.ts           # 配置读取 + 一次列出全部问题
│       ├── paths.ts
│       ├── process.ts
│       └── which.ts
├── test/                     # 单测（纯 Node）+ 集成测试
│   ├── runTest.js            # 集成测试入口：先打包，再拉起真实扩展宿主
│   └── integration/index.js  # 在宿主里断言命令、判定、面板、比赛与成绩单
├── testdata/                 # 样例工作区（集成测试与 F5 都用它）
│   ├── itest/                # M1 约定式查找的样例程序（AC/WA/TLE/RE/OLE/CE）
│   ├── .verdict/             # 一场演示赛：contests/demo.json + data/<题目> + problems/<题目>
│   └── players/              # 选手源码（alice 全对；bob 的 A 题故意溢出，拿 30 分）
├── docs/wiki/                # GitHub wiki 页面的源件
├── media/                    # 活动栏图标与扩展图标
├── assets/                   # 图标源图
├── SPEC.md
├── AGENTS.md
├── README.md
├── CHANGELOG.md
├── PUBLISHING.md             # 发布到两个市场的步骤
└── LICENSE
```

---

## 14. 依赖策略

- **运行时依赖：0**（仅 Node 内置模块 + VSCode API）。
- 配置用 JSON；HTML 导出内联资源；ZIP 用内置 `zlib`；不引入任何解析 / 图表库。
- 开发依赖仅：`typescript`、`esbuild`、`@types/vscode`、`@types/node`、测试框架（`vitest`）、`@vscode/test-electron`、`@vscode/vsce`、`eslint`。
- 严禁引入任何需要联网、上报或收费的包。

---

## 15. 开发环境与工具链

### 15.1 主机策略

| 用途 | 环境 | 说明 |
|---|---|---|
| **主力开发/调试** | **Windows 11** | Extension Host 内 F5 调试；本机装 MinGW `g++` 即可跑通评测 |
| **跨平台验证** | **GitHub Actions 三平台矩阵** | `ubuntu-latest / windows-latest / macos-latest` 自动跑测试 |
| WSL2（可选） | Ubuntu + Node + g++ | 需本地复现 Linux 行为时使用，非必需 |

> 原则：**三平台均可作为开发机**，代码与脚本不得假设某一平台；跨平台验证由 CI 兜底，无需同时维护三套本地环境。任意一台机器 clone 后都能跑通 `pnpm install`、`pnpm build`、`pnpm test`、F5 调试与 `pnpm package`。

### 15.2 工具链

| 类别 | 推荐 |
|---|---|
| 编辑器 | VSCode Stable（自己用自己，F5 起 Extension Development Host） |
| 运行时 | Node.js 20 LTS |
| 包管理 | pnpm 11.26.0（`npm install -g pnpm@11.26.0`；仓库内由 `packageManager` 字段锁定版本） |
| 语言 | TypeScript 5，`strict: true` |
| 打包 | esbuild |
| 发布 | `@vscode/vsce` |
| 单测 | vitest |
| 集成测试 | `@vscode/test-electron` |
| C++ 编译器 | MinGW-w64 `g++` 13+（winlibs/MSYS2）；mac/linux 侧编译器由 CI 提供 |

### 15.3 调试配置

`.vscode/launch.json`：

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "运行扩展",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
      "outFiles": ["${workspaceFolder}/dist/**/*.js"],
      "preLaunchTask": "npm: watch"
    },
    {
      // 直接以样例工作区启动，省掉「开发宿主里再开一次文件夹」这一步。
      "name": "运行扩展（testdata 工作区）",
      "type": "extensionHost",
      "request": "launch",
      "args": [
        "--extensionDevelopmentPath=${workspaceFolder}",
        "${workspaceFolder}/testdata"
      ],
      "outFiles": ["${workspaceFolder}/dist/**/*.js"],
      "preLaunchTask": "npm: watch"
    }
  ]
}
```

`.vscode/tasks.json`：

```jsonc
{
  "version": "2.0.0",
  "tasks": [
    { "type": "npm", "script": "watch", "isBackground": true, "problemMatcher": "$esbuild-watch", "label": "npm: watch" }
  ]
}
```

开发循环：改代码 → esbuild watch 增量编译 → F5 扩展宿主 → 触发命令 → TS 断点调试（sourcemap）。

### 15.4 最小起步清单

1. 安装 Node 20 LTS + pnpm 11.26.0（`npm install -g pnpm@11.26.0`）+ 至少一个 C++ 编译器（Windows 可用 MinGW-w64 `g++` 加入 PATH）。
2. 建仓，安装 §14 开发依赖。
3. 写 `package.json` 贡献点（§4）、`tsconfig`、`esbuild.js`、`.vscode/*`。
4. 实现 M1（`checkEnv` + 编译 + 单点判定）。
5. 建 GitHub 仓库，加 §17.2 的 CI。

### 15.5 三平台可开发性约定（强制）

在 **Windows / Linux / macOS** 上任一平台开发都必须成立，具体约束：

1. **路径**：一律使用 `path.join` / `path.sep` / `os.tmpdir()`，禁止硬编码 `/` 或 `\`、禁止硬编码盘符。
2. **脚本**：`package.json` scripts 只用 Node（`node esbuild.js` 等），禁止 `rm` / `cp` / `&&` / `export FOO=` 等平台专有 shell 语法；需要删目录/拷贝时写在 Node 脚本里。
3. **可执行文件**：探测编译器时按平台尝试后缀（Windows `g++.exe` / `python.exe`），调用一律走 `spawn` 不拼 shell 字符串。
4. **换行与编码**：源码 LF + UTF-8（`.gitattributes` / `.editorconfig` 兜底，§16.2）；数据文件按字节处理，不做换行规范化假定。
5. **大小写**：文件名不得仅靠大小写区分（macOS/Windows 不敏感，Linux 敏感）。
6. **进程与终止**：杀进程树按平台分支（POSIX 进程组 / Windows `taskkill`，§8.1），不在代码里写死一种。
7. **CI 门禁**：任何 PR 必须在 `windows-latest / ubuntu-latest / macos-latest` 三平台全绿（§17.2）方可合并。

---

## 16. 多机同步与仓库约定

多机之间保持**同一份代码**，采用 **Git 单一远端 + 分支/PR + CI**；不使用任何云盘同步。

### 16.1 分支策略

```
main          始终可运行（发布/打包用）
feat/*        每台机器上的短分支，完成即 PR 合并后删除
```

- 同一时刻只有一台机器改同一分支；并行改动走独立分支 + PR。
- 每个 PR 必须过三平台 CI 才能合并。

### 16.2 必须入库的基准文件

`.gitattributes`：

```gitattributes
* text=auto eol=lf
*.png binary
*.jpg binary
*.vsix binary
*.exe binary
```

`.editorconfig`：

```ini
root = true

[*]
end_of_line = lf
charset = utf-8
insert_final_newline = true
trim_trailing_whitespace = true
indent_style = space
indent_size = 2

[*.md]
trim_trailing_whitespace = false
```

`.gitignore`：

```gitignore
node_modules/
dist/
out/
.vscode-test/
.verdict-out/
*.exe
*.vsix
*.log
```

`.nvmrc`：

```
20
```

`pnpm-workspace.yaml`（pnpm 10+ 把包管理器设置从 `package.json` 移到了这里）：

```yaml
# esbuild 安装时需要执行构建脚本以链接平台原生二进制；
# pnpm 11 默认拦截依赖脚本，必须显式放行，否则 pnpm build 会报 ERR_PNPM_IGNORED_BUILDS。
allowBuilds:
  esbuild: true
```

`package.json` 锁定运行时与包管理器：

```jsonc
{
  "engines": { "node": ">=20" },
  "packageManager": "pnpm@11.26.0"
}
```

> `pnpm-lock.yaml` 与 `pnpm-workspace.yaml` 必须入库；各机使用 `pnpm install --frozen-lockfile`。
>
> `packageManager` 的版本必须与本机实际安装的 pnpm 一致：版本不符时 pnpm 会**联网下载**指定版本，
> 在离线环境表现为命令长时间无响应。

### 16.3 每台机器首次 clone 后的一次性设置

```bash
git config --global user.name  "Your Name"
git config --global user.email "you@example.com"
git config --global core.autocrlf false
git config --global core.fileMode false      # 仅 Windows；Linux/macOS 保持 true
git config --global pull.rebase true
git config --global rebase.autoStash true

# 取得 pnpm（二选一）：
npm install -g pnpm@11.26.0     # 推荐：装到 npm 全局目录，无需 sudo
# corepack enable               # 备选：由 Node 自带的 corepack 提供

git clone git@github.com:<you>/verdict.git
cd verdict
pnpm install --frozen-lockfile
```

SSH key 每台机器各配一把，**私钥永不入库**。

### 16.4 日常同步流程

```bash
git status
git pull --rebase          # 开工前必做
git switch -c feat/<topic>

# ...编辑...
git add -A
git commit -m "feat(scope): message"
git push -u origin feat/<topic>
```

换机器继续同分支：

```bash
git switch feat/<topic> || git switch -c feat/<topic> origin/feat/<topic>
git pull --rebase
```

### 16.5 红线

- 绝不用 OneDrive/Dropbox/坚果云等同步仓库目录。
- 不提交 `node_modules/`、`dist/`、`.exe`、`.vsix`。
- 不跨机共享同一工作目录（网络盘）；各自本地 clone。
- 避免仅大小写不同的文件名（Windows/macOS 不敏感，Linux 敏感）。

---

## 17. 构建、测试与脚本

### 17.1 `package.json` scripts

```jsonc
{
  "scripts": {
    "watch": "node esbuild.js --watch",
    "build": "node esbuild.js",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src test",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "node ./test/runTest.js",
    "package": "node scripts/package.js"
  }
}
```

### 17.2 CI 三平台矩阵

```yaml
# .github/workflows/ci.yml
name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  test:
    strategy:
      matrix:
        os: [windows-latest, ubuntu-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm test
      - name: 安装 g++ (ubuntu)
        if: runner.os == 'Linux'
        run: sudo apt-get update && sudo apt-get install -y g++
      # 集成测试（编译→评测→子任务→榜单）在具备编译器的平台上运行
      - run: pnpm test:integration
```

### 17.3 打包

`pnpm package` 生成**单个平台无关 VSIX**（纯 TS，无原生依赖），可安装于三平台。

实现说明：不用 `vsce`，而是 `scripts/package.js` + `src/tools/vsix.ts` 自己打——VSIX 本质就是一个
ZIP（`[Content_Types].xml` + `extension.vsixmanifest` + `extension/**`），复用扩展自己的 ZIP 实现
（`core/zip.ts`，只用 Node 内置 zlib）。这样打包也不需要联网安装任何工具，与「完全离线、零依赖」
这条前提一致；代价是清单要自己写对，所以有单测盯着（条目、标识、引擎要求、转义），
并且真的用 `code --install-extension` 装过一次来验证格式能被官方安装器接受。

两个容易踩的点，都写进打包器了：开发用的 `*.map` 不进生产包（体积最大，而且陈旧的那份
比没有更糟），以及输出写在 `dist/` 下时要跳过 `*.vsix`（否则会把上一次的包打进这一次的包里）。

发布相关：市场页面就是 `README.md` 的渲染，加上 `package.json` 的描述、`icon`（128×128 RGBA PNG，
放在 `media/icon.png`，源图留在 `assets/icon-source.png`）与分类；`repository` 字段是 `vsce`
的硬要求；`CHANGELOG.md` 也会进包，市场页面据此多出一个「Changelog」标签页。
步骤见 `PUBLISHING.md`（含官方市场与 Open VSX 两条路线，以及在 PAT 卡住时用网页直接传 VSIX 的办法）。

```bash
pnpm package                                             # 生成 dist/verdict-<版本>.vsix
code --install-extension dist/verdict-judge-0.1.3.vsix   # 安装
```

---

## 18. 测试策略

- **单元测试**（core，不依赖 VSCode）：
  - `compare/default`：空白、行尾、末尾空行、空输入边界。
  - `compare/real`：绝对/相对误差边界、`nan`/`inf` 判定。
  - `compare/spj`：testlib 退出码协议（AC/WA/PE/UKE）与部分分（退出码 7）折算。
  - `judge/score`：子任务依赖拓扑、`min`/`sum` 计分、skip 语义。
  - `scan`：命名约定识别与稳定排序。
  - `standings`：并列名次、未提交、重测后更新。
  - `report/html`：自包含性与着色（快照）。
  - `problem/zip`：打包 → 解包 → 往返一致。
  - `sandbox`：死循环 / 爆内存 / `abort()` / 巨量输出 / 正常，五类断言（在支持的平台）。
- **集成测试**：用 `testdata/` 的样例比赛/题目/程序，在三平台 CI 上跑「编译 → 评测 → 子任务 → 榜单」，断言判定与分数。
- **确定性测试**：同配置跑两次，判定/分数/输出 diff 一致。
- **无网络断言**：扫描产物源码，断言不含 `http`/`https`/`fetch`/`net.connect`/`dns` 等调用。

---

## 19. 后续扩展（推迟）

1. 提交答案题（output-only）与通信题（communication）题型。
2. 更多语言评测适配（Java / Rust / Go / 解释型）。
3. 数据生成器与压力测试工具链（gen / brute / 对拍）。
4. 更完整的统计与图表。
5. 可选的精确内存限制（原生助手）。
6. 与主流 OI 题目数据目录约定的自动识别增强。

---

## 参考资料

- 常见 OJ 判定与 Special Judge 调用约定、实数比较的绝对/相对误差处理。
- VSCode Extension API：命令、CodeLens、Diagnostics、Testing、Webview、TextDocumentContentProvider、Debug、TreeView。
- Node 内置模块：`child_process`、`fs`、`path`、`crypto`、`zlib`。

---

## 附录 A：预计 token 与成本估算（开发侧）

| 项 | 估计 |
|---|---|
| 代码量（impl + test + 配置） | ~10,000 行 |
| 输出 token | 约 130k–180k |
| 输入 token（上下文/回读/报错） | 约 400k–900k |
| 合计 | 约 0.6M–1.2M tokens |

DeepSeek 现价（每 1M tokens，闲时/峰时；峰时为 UTC 周一至周五 01:00–04:00、06:00–10:00）：

| 模型 | 输入·缓存命中 | 输入·缓存未命中 | 输出 |
|---|---|---|---|
| deepseek-flash | $0.003 / $0.006 | $0.15 / $0.30 | $0.60 / $1.20 |
| deepseek-v4-pro | $0.022 / $0.044 | $0.66 / $1.32 | $1.98 / $3.96 |

**整项目成本估算**：

| 模型 | 成本区间 |
|---|---|
| deepseek-flash | 约 $0.08 – $0.42 |
| deepseek-v4-pro | 约 $0.30 – $1.70 |

> 此为 AI 编码的开发侧开销，与插件「零 API、零付费」的运行约束无关。降本要点：闲时执行 + 保持固定上下文前缀命中缓存 + 每里程碑开新会话。
