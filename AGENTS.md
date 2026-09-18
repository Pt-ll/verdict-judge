# AGENTS.md

Verdict：把 OI/ICPC 风格的本地评测系统做进 VSCode 的扩展。
完整设计以 `SPEC.md` 为准；本文件只写「动手时必须遵守的规矩」。

## 硬约束

- 交付物是 **VSCode 扩展**，不是 CLI、不是本地服务、不是独立 GUI。
- **运行时依赖为 0**：只能用 Node 内置模块 + VSCode API。不新增 `dependencies`。
- **完全离线**：代码中不得出现 `http`/`https`/`fetch`/`net.connect`/`dns` 等调用。
- 扩展自身不捆绑编译器，只探测并调用用户本机已安装的 `g++` / `clang++` / `cl`。

## 分层

- `src/core/**`：平台无关的评测内核，**禁止 `import 'vscode'`**，必须能在纯 Node 下单测。
- `src/vscode/**`、`src/extension.ts`：唯一允许依赖 VSCode API 的地方，只做注册/展示/弹窗。
- `src/util/**`：两端共用的纯函数工具。
- `src/tools/**`：构建期工具（例如打 VSIX）。esbuild 只从 `src/extension.ts` 出发打包，
  所以它们不会进扩展本体；但照样过 typecheck 与 lint。

## 三平台约定（强制）

1. 路径一律 `path.join` / `path.delimiter` / `os.tmpdir()`，禁止硬编码 `/`、`\` 或盘符。
2. `package.json` 的 scripts 只用 Node 命令，禁止 `rm`/`cp`/`&&`/`export` 等平台专有 shell 语法。
3. 调用外部程序一律 `spawn` 传参数数组，禁止拼接 shell 字符串。
4. 源码 LF + UTF-8；数据文件按字节处理，不做换行规范化假设。
5. 杀进程树必须分平台：POSIX 杀进程组，Windows 用 `taskkill /T /F`。
6. 文件名不得仅靠大小写区分。

## 常用命令

工具链要求 Node ≥ 22.13：`package.json` 锁的 pnpm 11.26.0 内部用了 Node 22 才有的 `node:sqlite`，
Node 20 会让 pnpm 一启动就崩（CI 曾因此三平台全红）。这与扩展运行时无关——VSCode 1.95 自带的
Node 20 才是扩展真正运行的环境，所以 `engines.node` 仍写 `>=20`，`.nvmrc` 与 CI 则用 24。

```bash
pnpm install        # 安装依赖（首次；pnpm 会读 pnpm-workspace.yaml 的 allowBuilds）
pnpm build          # esbuild 打包到 dist/extension.js
pnpm watch          # 增量编译（F5 调试时用）
pnpm typecheck      # tsc --noEmit
pnpm lint           # eslint（配置只有 eslint.config.mjs 一个文件）
pnpm test           # vitest 单测：纯 Node，不起 VSCode（单测超时 30s，见下）
pnpm test:integration  # 真实扩展宿主里跑 test/integration/index.js
pnpm package        # 打包 VSIX（自带打包器，零依赖；见 SPEC §17.3）
```

调试：在 VSCode 中打开本目录，按 `F5` 启动扩展开发宿主。

单测超时统一给到 30s（`--testTimeout=30000`）：默认的 5s 对「真的调编译器」的用例不够，
Windows runner 上一次成功的 MSVC 编译加链接就能吃掉 5s 以上（2026-09-12 因此红过一次）。

## 集成测试

- `test/runTest.js`：入口。先 esbuild 打包，再拉起真实扩展宿主。扩展宿主优先用本机已装的
  VSCode（开发机常常离线），CI 上回落到 `@vscode/test-electron` 下载。
- `test/integration/index.js`：断言命令注册、六种判定（AC/WA/TLE/RE/OLE/CE）与编译失败诊断。
- `testdata/`（集成测试的工作区）：
  - `itest/`：走 M1 约定式查找的样例程序（AC/WA/TLE/RE/OLE/CE + diff 行号）。
  - `.verdict/`：一场完整的比赛（`contests/demo.json` + `problems/A`、`problems/B`、`problems/C`），
    验收 Testing 面板、子任务计分，以及 M3 的榜单 / 重测上限 / 导出 HTML。
    测试数据按 0.1.3 的总库布局放在 `.verdict/data/<题目 id>/`，题目里写 `"input": "1.in"`；
    0.1.2 的旧布局（`contest.json` + 包内 `data/` + `"data/1.in"`）由单测覆盖，样例不必两套都留。
  - `players/`：选手源码。alice 全对；bob 的 A 题故意在 int 溢出上出错，拿 30/100，
    这样「部分分」这条路每次 CI 都会被真的走到。
  - `.vscode/settings.json`：时限 1000ms、内存 256MB、输出 64KB。
  改样例时要同步改 `test/integration/index.js` 里的期望表（分数、名次、用例表都在那里）。
- 本机想连真实调试会话一起验（会真的拉起 lldb 与 cpptools）：
  `VERDICT_ITEST_KEEP_EXTENSIONS=1 pnpm test:integration`。它借用机器上的扩展目录
  （不借用户数据目录，否则会和你正开着的 VSCode 抢实例）。CI 上这个开关是关的，
  调试只验「没装调试扩展时给可操作提示」那条路径。
  打开开关后还会多做两件事：用探针程序验证「调试会话里程序真的读到了测试点输入」
  （这是唯一能证明 stdin 注入生效的办法），以及验证交互题的「录制-重放」。

## 里程碑（见 SPEC §12）

- M1 骨架 + 编译运行 + 单点判定 ✅（2026-09-12 三平台 CI 全绿）
- M2 题目包 + 测试点 + 子任务 + Testing/diff ✅（三平台 CI 全绿）
- M3 比赛 + 选手 + 重测 + 榜单 + HTML ✅（三平台 CI 全绿）
- M4 交互题 + testlib SPJ + 导入导出 + 打包 ✅（本机验收全过；三平台 CI 待确认）
- M5 侧边栏面板（活动栏图标 → 不写 JSON 也能用）✅（0.1.0 发布）
- M6 数据总库 + 一个工作区多场比赛 + 删除题目 + 成绩单测试点详情 ✅（0.1.3）

## 代码风格

- TypeScript 5，`strict: true`；不写隐式 `any`。
- 注释用中文，解释「为什么」而不是复述「做了什么」。
- 不加版权头；不引入任何需要联网或上报的包。

## 容易被当成「多余代码」删掉的必需逻辑

- `engineFacade.ts` 的 `warmUp()`：macOS 上新写入的可执行文件首次执行要 400-900ms，
  不预热会把刚编译好的正确程序误判成 TLE。删除前请先看 SPEC §9 的说明。
- `sandbox/posix.ts` 里 `ulimit -v` 取 **2 倍** 内存上限：卡在等值上会让程序先 `malloc` 失败崩溃，
  把 MLE 误判成 RE（SPEC §8.3）。
- `compiler.ts` 里 `-Wl,--stack` **只在 Windows 加上**：POSIX 传这个参数会让链接直接失败（SPEC §11.10）。
- 比较器全程按字节比较，不要改成先 `toString('utf8')` 再比：不同的非法字节会被统一成 U+FFFD，
  导致本该判 WA 的输出被判成 AC。
- `src/extension.ts` 里 `activate()` 的返回值 `{ judgeDocument }`：集成测试只靠它拿到结构化判定，
  「命令面板点一下」是没法断言的。删掉它，`test/integration` 整片失效。
- `activate()` 返回的 `dispatchPanel` / `panelState`：侧边栏面板没有标签页、DOM 也读不到，
  集成测试只能靠这两个口子验「面板背后的状态与动作」。它们同时也是 webview 真正走的那条路，
  不是测试专用的捷径。
- `ProblemResult.partial` 与 `CaseDocumentStore.record(..., { merge: true })`：面板上单点运行时，
  分数只按跑过的点算（是下界），别的点的输出也不该被清掉。这两条一起保证「单点跑一下」
  不会污染整题结论。
