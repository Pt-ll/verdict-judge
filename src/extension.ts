import * as vscode from 'vscode';
import type { JudgeOutcome } from './engineFacade';
import { CaseDocumentStore } from './vscode/caseDocs';
import { registerCommands } from './vscode/commands';
import {
  registerContestCommands,
  type ContestSummary,
  type RejudgeResult,
} from './vscode/contest';
import { startDebug, type DebugResult } from './vscode/debug';
import { JudgeCodeLensProvider } from './vscode/codelens';
import { DiagnosticsPublisher } from './vscode/diagnostics';
import { VerdictOutput } from './vscode/output';
import { registerProblemCommands } from './vscode/problemCommands';
import { VerdictStatusBar } from './vscode/statusBar';
import { registerTesting } from './vscode/testing';
import { VerdictControlPanel } from './vscode/controlPanel';
import type { PanelState } from './vscode/panel/state';

/**
 * 暴露给集成测试的 API。
 *
 * 集成测试通过 activate() 的返回值拿到评测入口：命令面板里点一下没法断言结果，
 * 只有拿到结构化的 JudgeOutcome 才能验证 AC/WA/TLE/RE/OLE/CE。
 */
export interface VerdictApi {
  judgeDocument(document: vscode.TextDocument): Promise<JudgeOutcome | null>;
  /** 重建 Testing 树；Promise 在树建好后 resolve。 */
  refreshTesting(): Promise<void>;
  /** Testing 树的顶层项（一个题目一项），只读。 */
  testingItems(): vscode.TestItem[];
  /** 按 Testing 面板的语义跑一组测试项，返回这次判定的结果。 */
  runTestingItems(items: vscode.TestItem[]): Promise<JudgeOutcome | null>;
  /** 用当前文件的某个测试点起调试会话；集成测试用它验证「没装调试扩展」这条路径。 */
  debugFirstCase(problemRoot?: string, testId?: string): Promise<DebugResult>;
  /** M3：评测整场比赛（集成测试用它验收 M3 的榜单与分数）。 */
  judgeContestAll(): Promise<ContestSummary | null>;
  /** M3：重测一条提交；受 maxRejudge 约束，拒绝时 ok=false 并说明原因。 */
  rejudgeOne(contestant: string, problem: string): Promise<RejudgeResult>;
  /** M3：生成榜单 HTML 文本（集成测试断言「自包含」）。 */
  standingsHtml(): string | null;
  /** M3：把榜单 HTML 写到指定路径，返回写出的路径。 */
  writeStandingsHtml(target: string): Promise<string | null>;
  /** 侧边栏面板：把一条面板消息交给它处理（集成测试用，等价于 webview 里点一下）。 */
  dispatchPanel(message: unknown): Promise<void>;
  /** 侧边栏面板最近一次算出来的状态。 */
  panelState(): PanelState | null;
}

/**
 * 扩展入口：只负责装配与释放。
 *
 * 具体行为分别在 src/vscode/ 的各模块里，评测内核在 src/core/，
 * 中间由 src/engineFacade.ts 连接。
 */
export function activate(context: vscode.ExtensionContext): VerdictApi {
  const output = new VerdictOutput(
    () => vscode.workspace.getConfiguration('verdict').get<boolean>('debug') === true,
  );
  const status = new VerdictStatusBar();
  const diagnostics = new DiagnosticsPublisher();
  const caseDocs = new CaseDocumentStore();
  caseDocs.register(context);
  const commands = registerCommands({ context, output, status, diagnostics, caseDocs });
  // 改题目包的命令要刷新 Testing 树，而 Testing 跑测试又要用命令的评测入口——
  // 用一个小 hooks 对象打破这个环：先占位，两边都装配好之后再填上真正的实现。
  const hooks: { refreshTests: () => Promise<void>; activeContestId: () => string | null } = {
    refreshTests: async () => undefined,
    activeContestId: () => null,
  };
  const problemCommands = registerProblemCommands({
    output,
    caseDocs,
    refreshTests: () => hooks.refreshTests(),
    activeContestId: () => hooks.activeContestId(),
  });
  const contest = registerContestCommands({ context, output, status });
  hooks.activeContestId = () => contest.session.activeId();
  const testing = registerTesting({
    output,
    judgeInPackage: (document, request) => commands.judgeDocumentInPackage(document, request),
    debugInPackage: (document, problemRoot, testId) =>
      startDebug({ context, output }, document, { problemRoot, testId }),
  });
  // 侧边栏面板（活动栏里那个图标）与 Testing 面板看的是同一份数据，
  // 谁改了题目包都要让两边一起刷新。
  const panel = new VerdictControlPanel({
    context,
    output,
    caseDocs,
    commands,
    contest: contest.session,
    refreshTests: () => hooks.refreshTests(),
  });
  hooks.refreshTests = async () => {
    await testing.refresh();
    await panel.refresh();
  };
  const panelDisposables = panel.register();

  context.subscriptions.push(
    output,
    panel,
    status,
    diagnostics,
    ...panelDisposables,
    ...commands.disposables,
    ...problemCommands,
    ...contest.disposables,
    ...testing.disposables,
    vscode.languages.registerCodeLensProvider(
      [
        { language: 'cpp', scheme: 'file' },
        { language: 'c', scheme: 'file' },
        { language: 'python', scheme: 'file' },
      ],
      new JudgeCodeLensProvider(),
    ),
  );

  output.info('Verdict 已激活。执行命令「Verdict: 检查环境」开始。');

  return {
    judgeDocument: (document) => commands.judgeDocument(document),
    refreshTesting: () => testing.refresh(),
    testingItems: () => testing.roots(),
    runTestingItems: (items) => testing.run(items),
    debugFirstCase: (problemRoot, testId) => {
      const document = vscode.window.activeTextEditor?.document;
      if (document === undefined) {
        return Promise.resolve<DebugResult>({
          kind: 'no-source',
          message: '请先打开一个源码文件。',
        });
      }
      return startDebug({ context, output }, document, { problemRoot, testId });
    },
    judgeContestAll: () => contest.session.judgeAll(),
    rejudgeOne: (contestant, problem) => contest.session.rejudge(contestant, problem),
    standingsHtml: () => contest.session.html(),
    writeStandingsHtml: (target) => contest.session.exportHtml(target),
    dispatchPanel: (message) => panel.dispatch(message),
    panelState: () => panel.state(),
  };
}

export function deactivate(): void {
  // 资源都通过 context.subscriptions 释放，这里无需额外处理。
}
