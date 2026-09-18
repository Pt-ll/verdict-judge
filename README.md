# Verdict · VSCode 评测系统

把 OI/ICPC 风格的本地评测做进 VS Code：出题、造数据、评测、重测、榜单、导出成绩单，全在编辑器里完成。

**完全离线 · 零运行时依赖 · Windows / macOS / Linux 一致。**

更新日志见 [CHANGELOG.md](CHANGELOG.md)（0.1.3 数据总库 + 多场比赛 + 删除题目 + 成绩单测试点详情，
0.1.0 是侧边栏评测面板）。

完整的使用说明（安装、面板、出题流程、比赛与榜单、命令与设置、常见问题）见
[Wiki](https://github.com/Pt-ll/verdict-judge/wiki/插件使用说明)。

## 它能做什么

- **侧边栏面板**：活动栏上点一下 Verdict 图标就能出题、评测、看榜，**不用手写 JSON**（下一节细说）。
- **评测当前文件**：源码顶部有 `▶ 评测`；判定进状态栏与输出通道，编译错误进问题面板（可点击跳转到行列）。
- **题目包**：一个 `problem.json` 描述限制、比较方式、测试点与子任务；子任务支持依赖与 min / sum 计分，依赖没满分时后继子任务记为「跳过」而不是 0 分。
- **数据总库**：所有测试数据放在 `.verdict/data/<题目 id>/`，用文件夹名区分题目；题目包与数据分开，多场比赛可以共用同一道题的数据。
- **多场比赛**：一个工作区放几场比赛都行（`.verdict/contests/<id>.json`），题目可以重叠，各场的分数与重测次数互不干扰。
- **比赛**：选手 × 题目整场评测、重测（受上限约束）、榜单、导出**离线可开**的自包含 HTML 成绩单（含逐题逐测试点详情）。
- **交互题**：与 testlib 协议一致的 interactor；调试时用「录制-重放」，在真实输入下断点单步。
- **Special Judge**：testlib checker，支持 AC / WA / PE，以及退出码 7 的部分分折算。
- **对比输出**：WA 时自动打开原生 diff，并跳到首个不同的行。
- **Testing 面板**：题目 > 子任务 > 测试点，可单独重跑、可单独调试。
- **调试**：断点单步，测试点输入自动接到 stdin（不需要你手动喂）。

## 侧边栏面板

活动栏上的 **Verdict** 图标点开就是操作台，三个页签：

| 页签 | 能做什么 |
| --- | --- |
| **题目** | 顶部下拉框切换 / 新建比赛；题目列表上 `★` 表示在当前比赛里，`＋` / `−` 把题目加入或移出当前比赛，`🗑` 删题（可选只删题目包或连数据一起删）；新建 / 导入 / 导出题目包；改选中题目的限制与比较方式（`default` / `line` / `real` / `spj` / `interactive`，checker 与 interactor 用文件选择器指定） |
| **测试点** | 按子任务分组，每行给最近一次判定、用时与内存；`▶` 单点运行、`🐞` 调试、`⇄` 看 diff、`▸` 展开输入 / 标准答案 / 实际输出；增删子任务、改分值 / 依赖 / 计分、按点均分；扫描数据目录登记新测试点（面板上直接写着数据在哪） |
| **榜单** | 选手 × 题目矩阵（名单 = 比赛配置里写的 + `players/` 自动发现的），点单元格看重测详情；评测全部、导出 HTML、打开完整榜单 |

顶部一行是当前题目、当前源码与 `▶ 评测` / `🐞 调试` / `■ 取消`，底部一行显示进度与最近一次结果。

面板只是 `problem.json` / `contests/*.json` 的**一个视图**：每次编辑都是读-改-写，和手改文件完全等价。
所以「不想碰 JSON 的人用面板」与「想用 git 管数据的人继续手写」两不误，也不会出现两份数据。

## 快速开始

### 安装

**已经发布在 Open VSX**（VSCodium / Gitpod / Theia 等用的源）：

| 从哪里装 | 怎么做 |
| --- | --- |
| VSCodium / Gitpod / Theia 等 Open VSX 源 | 扩展面板里搜 `Verdict` |
| 任何编辑器（手动） | 从 [Open VSX 页面](https://open-vsx.org/extension/YuChenZhong/verdict-judge) 下 VSIX，再 `code --install-extension <文件>` |
| 本仓库的开发版 | `pnpm package` 之后装 `dist/verdict-<版本>.vsix` |

Open VSX 上现为 0.0.1；**VS Code 官方市场还没发布**（卡在微软 Azure DevOps 的鉴权上，
绕法记在 `PUBLISHING.md`）。两边用的是同一个 VSIX，官方市场补发时不用重新打包。

本仓库内打包与安装：

```bash
pnpm package                                                     # 生成 dist/verdict-judge-0.1.3.vsix
code --install-extension dist/verdict-judge-0.1.3.vsix           # 安装
```

> macOS 上如果提示 `command not found: code`：VS Code 里按 `Cmd+Shift+P`，执行
> `Shell Command: Install 'code' command in PATH`，然后重开终端。临时用一次的话，
> 直接写全路径也行：`/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`。

想改代码：`pnpm install`，在 VS Code 里打开仓库按 `F5` 启动扩展开发宿主。

### 六十秒试一遍

用仓库里的 `testdata/` 当工作区（那里有一场演示赛：两道传统题 + 一道交互题，两个选手）：

1. 点活动栏的 **Verdict** 图标 — 侧边栏面板里已经列出题目、测试点与榜单
2. 在「测试点」页签点某个点的 `▶`，或用顶部的 `▶ 评测` 跑整题；WA 的行会出现 `⇄`，点开就是 diff
3. 「榜单」页签里点 **评测全部** — 输出通道给出 `alice 300 / bob 230`，面板里同步出现分数矩阵
4. 点 **完整榜单** — 大表格（点单元格展开逐测试点结果）、各题情况、分数分布
5. **导出 HTML…** — 得到一个可以直接发给别人的成绩单，不依赖网络
6. 打开 `players/bob/A.cpp`（故意在大数据上写错的那份），Testing 面板里点调试按钮，看它算错在哪

### 做自己的题

1. 侧边栏「题目」页签里点 `＋ 新建比赛` → 填比赛 id、标题、重测上限、选手
2. 点 `＋ 新建题目` → 填题目 id、时限、内存（数据目录会自动建成 `.verdict/data/<题目 id>/`）
3. 把 `1.in` / `1.out`（可以有很多组）放进那个数据目录
4. 回到「测试点」页签点 **扫描新测试点**，再用 **＋ 子任务** 或 **按点均分** 分档
5. 选手源码放在 `players/<选手>/<题目>.cpp`（**放进去就自动算一名选手，不用改比赛配置**），回到「榜单」页签点 **评测全部**

想再办一场？顶部下拉框旁边的 `＋` 就是新建第二场比赛；题目库是共用的，用题目行上的 `＋`
把已有的题加进新比赛即可——同一道题出现在两场比赛里完全没问题。

面板之外，同样的功能都有命令（`Verdict: 导入测试点`、`Verdict: 配置子任务`……），
哪边顺手用哪边；JSON 没有变成摆设，它仍然是唯一的存储格式。

## 目录长什么样

```text
你的工作区/
├── .verdict/
│   ├── contests/                 # 每场比赛一个文件，可以放好几场
│   │   ├── internal-2026.json    # 题目列表、选手、重测上限
│   │   └── practice-01.json
│   ├── data/                     # 测试数据总库：一个题目一个文件夹
│   │   ├── A/                    # 1.in / 1.out / 2.in / 2.out ...
│   │   └── B/
│   ├── submissions/              # 评测记录（运行产物，不入库）
│   │   └── internal-2026.json
│   └── problems/
│       ├── A/
│       │   ├── problem.json      # 题目：限制、比较方式、测试点、子任务
│       │   └── extra/            # checker.cpp / interactor.cpp / std.cpp ...
│       └── B/
└── players/                      # 选手源码
    ├── alice/A.cpp
    └── bob/A.cpp
```

0.1.2 及更早的布局（`.verdict/contest.json` + 题目包内的 `data/`）继续能读，
两种布局可以共存，老工作区不用搬。

最小的 `problem.json`（`tests` 都可以不写——会自动扫数据目录）：

```jsonc
{
  "id": "A",
  "name": "A. 求和",
  "limits": { "timeMs": 1000, "memoryMb": 256, "stackMb": 256, "outputKb": 4096 },
  "comparator": { "mode": "default" },
  "subtasks": [
    { "id": "1", "points": 30, "tests": ["1"], "dependsOn": [], "scoring": "min" },
    { "id": "2", "points": 70, "tests": ["2"], "dependsOn": ["1"], "scoring": "min" }
  ],
  "tests": [
    { "id": "1", "input": "1.in", "answer": "1.out", "points": 30, "subtask": "1" },
    { "id": "2", "input": "2.in", "answer": "2.out", "points": 70, "subtask": "2" }
  ]
}
```

测试点路径相对**数据目录**（上面这套布局里就是 `.verdict/data/A/`）。数据想放别处就写
`"dataDir": "../../shared/A"`（相对题目包根目录）；0.1.2 写的 `"data/1.in"` 也照读。

比较方式有五种：`default`（忽略行尾空白）、`line`（按行，报告首个不同行）、
`real`（实数，绝对 + 相对误差）、`spj`（testlib checker）、`interactive`（testlib interactor）。
checker / interactor 需要的 `testlib.h` 按
「题目包 `extra/` → 工作区 `.verdict/testlib/` → 设置 `verdict.testlibPath`」的顺序查找。

## 命令

| 命令 | 说明 |
| --- | --- |
| `Verdict: 检查环境` | 探测编译器并做一次编译 + 运行自检 |
| `Verdict: 评测当前文件` | 评测当前打开的源码 |
| `Verdict: 调试首测点` | 用第一个测试点的输入起调试会话 |
| `Verdict: 取消当前任务` | 中止正在进行的评测 |
| `Verdict: 新建比赛` / `切换比赛` | 新建 `.verdict/contests/<id>.json`；在多场比赛之间切换 |
| `Verdict: 新建题目` / `删除题目` | 生成 `problem.json` 骨架；删除时可选保留还是连数据一起删 |
| `Verdict: 把题目加入当前比赛` / `移出当前比赛` | 共用题目库：同一道题可以放进好几场比赛 |
| `Verdict: 导入测试点` | 扫描数据目录并登记进 `problem.json` |
| `Verdict: 配置子任务` | 均分 / 清空 / 打开文件手改 |
| `Verdict: 设置限制` | 时间、内存、输出上限 |
| `Verdict: 对比输出` | 打开某个测试点的输出 ↔ 答案 diff |
| `Verdict: 评测全部` | 整场比赛：选手 × 题目 |
| `Verdict: 重测` | 重测某一条提交（受上限约束） |
| `Verdict: 显示榜单` | 在 WebView 里看分数矩阵与统计 |
| `Verdict: 导出 HTML 成绩` | 生成自包含的离线成绩单 |
| `Verdict: 导出题目包` / `导入题目包` | 题目包与 ZIP 互转 |

## 设置

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `verdict.compiler` | 自动探测 | 编译器完整路径（g++ / clang++ / cl） |
| `verdict.flags` | `-O2 -std=c++17` | 编译参数 |
| `verdict.defaultTimeMs` / `defaultMemoryMb` / `outputLimitKb` | 1000 / 256 / 4096 | 默认限制（题目包里的设置优先） |
| `verdict.comparator` | `default` | 没有题目包时用什么比较方式 |
| `verdict.testlibPath` | 空 | `testlib.h` 所在目录或文件 |
| `verdict.autoDiff` | `true` | WA 时自动打开 diff |
| `verdict.debugStopAtEntry` | `false` | 调试时先停在程序入口 |
| `verdict.debug` | `false` | 输出通道里的调试日志 |

## 为什么可以信它的判定

评测系统最怕的不是崩溃，而是**悄悄判错**。所以关键规则都有测试盯着，而不是靠人看代码：

- 200+ 个单元测试 + 一个在**真实 VS Code 宿主**里跑的集成测试（Windows / macOS / Linux 三平台 CI）
- 时限、内存、输出、退出码、信号、取消的判定优先级；子任务依赖跳过；部分分折算；重测上限
- 交互题真的两进程对拍：二分猜数字判 AC、一直猜 1 判 WA、非数字判 PE、崩溃判 RE、死循环判 TLE 且两边都收干净
- 「完全离线」「零运行时依赖」也是测试在管：扫源码禁止网络调用、断言 `dependencies` 为空
- 导出的 HTML 必须自包含：测试断言输出里不许出现 `http://`、`<link`、`<script src`
- 调试的 stdin 注入有探针验证：被调试的程序读到的 stdin 与测试点输入必须一致

## 已知限制

不想让人按想象使用，所以直说：

- **Linux 上的调试注入未验证**：lldb（macOS）已用集成测试证明可用；gdb 用的是
  `set inferior-tty`，标了「失败不影响会话」，真没生效时会退化成手动喂输入。
- **MSVC 的调试器没有注入能力**，调试时只能手动输入（提示里会给出输入文件路径）。
- **Python 调试（debugpy）只有配置层面的单测**，没有真机验证。
- **并行评测**（`verdict.parallelJudge`）与**保存即评测**（`verdict.autoJudgeOnSave`）还没实现，
  整场比赛是逐个提交顺序跑的。
- **成绩单 HTML 里不放实际输出**：`submissions/` 不保存输出字节（输出上限按 KB 算，存进
  成绩单会让文件大到没法发），所以详情里有判定、得分、用时、内存与首个不同行，
  但没有「我的输出 vs 标准答案」的正文——要看输出用 diff，或在面板里重跑一次。
- 交互题调试用的是**录制-重放**：程序这次的反应若与录制时不同（自适应交互器），后面会对不上。

## 开发

```bash
pnpm install
pnpm build            # esbuild 打包到 dist/extension.js
pnpm typecheck        # tsc --noEmit
pnpm lint             # eslint
pnpm test             # vitest 单测（纯 Node，不起 VSCode）
pnpm test:integration # 真实扩展宿主里跑 test/integration/index.js
pnpm package          # 打包 VSIX（自带打包器，零依赖）
```

想连真实调试会话一起验（会真的拉起 lldb 与 cpptools）：
`VERDICT_ITEST_KEEP_EXTENSIONS=1 pnpm test:integration`。

代码分层：`src/core/**` 是平台无关的评测内核（禁止 import vscode，可在纯 Node 下单测），
`src/vscode/**` 只做注册与展示，`src/util/**` 是两端共用的纯函数。
设计细节见 `SPEC.md`，发到市场的步骤见 `PUBLISHING.md`。

`pnpm package` 产出的是自包含 VSIX（`package.json`、`dist/extension.js`、图标、README、
CHANGELOG、LICENSE），不依赖 `vsce` 也不联网——发布时把它交给市场即可。

## 许可

[MIT](LICENSE)，版权归 Pt-ll。你可以自由使用、修改、再分发（含商用与闭源集成），
只需保留版权声明；软件按「原样」提供，不附带任何担保。
