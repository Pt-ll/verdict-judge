/**
 * 把侧边栏面板渲染成一个普通网页，方便在浏览器里看效果、调样式。
 *
 * 面板的 HTML 是拼字符串拼出来的，改一行 CSS 就想看结果时，启动一次扩展宿主
 * （F5 或 pnpm test:integration）太慢了。这个工具把同一份 panelHtml() 配上假数据
 * 写成一个自包含的 HTML，双击就能看——看不到的只有真实数据与消息往返。
 *
 * 用法（输出刻意放在临时目录，免得混进 dist/ 被打进 VSIX）：
 *   npx esbuild src/tools/previewPanel.ts --bundle --platform=node --format=cjs \
 *     --outfile=/tmp/verdict-preview.cjs
 *   node /tmp/verdict-preview.cjs /tmp/verdict-panel.html
 *
 * 它属于 src/tools/**（构建期工具），esbuild 只从 extension.ts 出发打包，
 * 所以这个文件不会进扩展本体。
 */
import * as fs from 'node:fs';
import type { Verdict } from '../core/model';
import { panelHtml } from '../vscode/panel/html';
import type { PanelState, PanelTest } from '../vscode/panel/state';

const NONCE = 'PREVIEWNONCE';

const state: PanelState = {
  contest: {
    id: 'internal-2026',
    title: '内部训练赛 #3',
    maxRejudge: 3,
    contestants: [
      { id: 'alice', name: 'Alice', auto: false },
      // 预览里故意留一个「自动发现」的，好顺带看看那句话长什么样。
      { id: 'bob', name: 'Bob', auto: true },
    ],
    problemIds: ['A', 'B'],
    all: [
      { id: 'internal-2026', title: '内部训练赛 #3', legacy: false, active: true },
      { id: 'practice-01', title: '练习赛 #1', legacy: true, active: false },
    ],
    problemsDir: '/w/.verdict/problems',
    dataDir: '/w/.verdict/data',
    error: null,
  },
  problems: [
    {
      id: 'A',
      name: 'A. 求和',
      type: 'traditional',
      rootDir: '/w/.verdict/problems/A',
      dataDir: '/w/.verdict/data/A',
      inContest: true,
      testCount: 6,
      maxScore: 100,
      subtaskCount: 2,
      broken: null,
    },
    {
      id: 'B',
      name: 'B. 区间最大子段和',
      type: 'traditional',
      rootDir: '/w/.verdict/problems/B',
      dataDir: '/w/.verdict/data/B',
      inContest: false,
      testCount: 10,
      maxScore: 100,
      subtaskCount: 3,
      broken: null,
    },
  ],
  selected: {
    id: 'A',
    name: 'A. 求和',
    type: 'traditional',
    rootDir: '/w/.verdict/problems/A',
    dataDir: '/w/.verdict/data/A',
    limits: { timeMs: 1000, memoryMb: 256, stackMb: 256, outputKb: 4096 },
    comparator: { mode: 'default' },
    subtasks: [
      {
        id: '1',
        name: '小数据',
        points: 30,
        tests: ['1', '2', '3'],
        dependsOn: [],
        scoring: 'min',
        result: { id: '1', score: 30, maxScore: 30, status: 'full' },
      },
      {
        id: '2',
        name: '大数据',
        points: 70,
        tests: ['4', '5', '6'],
        dependsOn: ['1'],
        scoring: 'min',
        result: { id: '2', score: 0, maxScore: 70, status: 'none' },
      },
    ],
    tests: sampleTests(),
    orphanTests: [],
    score: 30,
    maxScore: 100,
    partial: false,
  },
  source: { path: '/w/players/bob/A.cpp', name: 'A.cpp', dirty: false, judgeable: true },
  standings: {
    problems: [
      { id: 'A', name: 'A. 求和' },
      { id: 'B', name: 'B. 区间最大子段和' },
    ],
    contestants: [
      { id: 'alice', name: 'Alice' },
      { id: 'bob', name: 'Bob' },
    ],
    ranks: [
      { contestant: 'alice', rank: 1, score: 300 },
      { contestant: 'bob', rank: 2, score: 230 },
    ],
    cells: [
      { contestant: 'alice', problem: 'A', score: 100, verdict: 'AC', rejudgeCount: 0 },
      { contestant: 'alice', problem: 'B', score: 100, verdict: 'AC', rejudgeCount: 0 },
      { contestant: 'bob', problem: 'A', score: 30, verdict: 'WA', rejudgeCount: 1 },
      { contestant: 'bob', problem: 'B', score: 100, verdict: 'AC', rejudgeCount: 0 },
    ],
  },
  busy: null,
  notice: { level: 'warn', text: 'WA · AC 3/6 · 得分 30/100 · 用时 214ms' },
};

/** 六个测试点，判定故意混着来，好把每一种颜色都看一遍。 */
function sampleTests(): PanelTest[] {
  const plan: [string, Verdict, number, number][] = [
    ['1', 'AC', 12, 1320],
    ['2', 'AC', 9, 1300],
    ['3', 'AC', 14, 1410],
    ['4', 'WA', 8, 1290],
    ['5', 'RE', 0, 900],
    ['6', 'TLE', 1000, 1500],
  ];
  return plan.map(([id, verdict, timeMs, memoryKb], index) => ({
    id,
    input: `data/${id}.in`,
    answer: `data/${id}.out`,
    points: 10,
    subtask: index < 3 ? '1' : '2',
    verdict,
    timeMs,
    memoryKb,
    message: verdict === 'WA' ? '首个不同的行：第 2 行（期望 26，实际 27）' : '',
    firstDiffLine: verdict === 'WA' ? 2 : null,
    inputText: '3\n7 2 9 5 1 4\n',
    expectedText: '26\n',
    outputText: verdict === 'AC' ? '26\n' : verdict === 'WA' ? '27\n' : '',
    hasData: true,
  }));
}

const html = panelHtml(NONCE).replace(
  '<body>',
  [
    '<body>',
    `<script nonce="${NONCE}">`,
    // 面板脚本第一句就是 acquireVsCodeApi()，这里给它一个只会回灌数据的替身。
    'var SAMPLE = ' + JSON.stringify(state) + ';',
    'window.acquireVsCodeApi = function () {',
    '  return { postMessage: function (message) {',
    '    if (message && message.type === "ready") {',
    '      window.postMessage({ type: "data", payload: SAMPLE }, "*");',
    '    }',
    '  } };',
    '};',
    '</script>',
  ].join('\n'),
);

const target = process.argv[2] ?? '/tmp/verdict-panel.html';
fs.writeFileSync(target, html, 'utf8');
process.stdout.write(`面板预览已写到 ${target}\n`);
