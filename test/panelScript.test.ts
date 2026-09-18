import { describe, expect, it } from 'vitest';
import type { Verdict } from '../src/core/model';
import { panelHtml } from '../src/vscode/panel/html';
import type { PanelState, PanelTest } from '../src/vscode/panel/state';

/**
 * 面板脚本没法在单测里真的开一个浏览器，但「脚本里有语法错误」和「渲染时抛异常」
 * 这两类问题，只要给一个够用的假 DOM 就能当场抓住——比等用户点开面板发现一片空白强。
 * 这里做的是渲染冒烟测试：三个页签都渲染一遍，不抛异常、内容非空即可。
 */

interface FakeNode {
  tagName: string;
  className: string;
  textContent: string;
  title: string;
  disabled: boolean;
  value: string;
  selected: boolean;
  style: Record<string, string>;
  children: FakeNode[];
  listeners: Record<string, ((event?: unknown) => void)[]>;
  appendChild(child: FakeNode): FakeNode;
  removeChild(child: FakeNode): void;
  addEventListener(type: string, listener: (event?: unknown) => void): void;
  click(): void;
}

function makeNode(tagName: string): FakeNode {
  const node: FakeNode = {
    tagName,
    className: '',
    textContent: '',
    title: '',
    disabled: false,
    value: '',
    selected: false,
    style: {},
    children: [],
    listeners: {},
    appendChild(child) {
      node.children.push(child);
      return child;
    },
    removeChild(child) {
      node.children = node.children.filter((item) => item !== child);
    },
    addEventListener(type, listener) {
      (node.listeners[type] ??= []).push(listener);
    },
    click() {
      for (const listener of node.listeners.click ?? []) {
        listener({ stopPropagation(): void {} });
      }
    },
  };
  // 脚本会读 firstChild 来清空容器（Map 式的 DOM 遍历），这里给个访问器顶上。
  Object.defineProperty(node, 'firstChild', {
    get: () => node.children[0] ?? null,
  });
  return node;
}

interface Harness {
  root: FakeNode;
  posted: { type?: string }[];
  deliver(message: unknown): void;
  query(predicate: (node: FakeNode) => boolean): FakeNode | undefined;
  text(): string;
}

/** 把 panelHtml 里的脚本抠出来，在一个假 DOM 上跑起来。 */
function boot(): Harness {
  const html = panelHtml('TESTNONCE');
  const start = html.indexOf('<script nonce="TESTNONCE">');
  const script = html.slice(start + '<script nonce="TESTNONCE">'.length, html.indexOf('</script>', start));

  const root = makeNode('div');
  const document = {
    createElement: (tag: string): FakeNode => makeNode(tag),
    getElementById: (id: string): FakeNode | null => (id === 'root' ? root : null),
  };
  const messageListeners: ((event: { data: unknown }) => void)[] = [];
  const window = {
    addEventListener: (type: string, listener: (event: { data: unknown }) => void): void => {
      if (type === 'message') {
        messageListeners.push(listener);
      }
    },
    postMessage: (): void => undefined,
  };
  const posted: { type?: string }[] = [];
  const acquireVsCodeApi = (): { postMessage: (message: { type?: string }) => void } => ({
    postMessage: (message) => posted.push(message),
  });

  // 脚本是 IIFE，直接当函数体跑；语法错误会在这里当场炸掉。
  const run = new Function('window', 'document', 'acquireVsCodeApi', script);
  run(window, document, acquireVsCodeApi);

  const query = (predicate: (node: FakeNode) => boolean): FakeNode | undefined => {
    const queue: FakeNode[] = [root];
    while (queue.length > 0) {
      const node = queue.shift();
      if (node === undefined) {
        break;
      }
      if (predicate(node)) {
        return node;
      }
      queue.push(...node.children);
    }
    return undefined;
  };

  const text = (): string => {
    const parts: string[] = [];
    const walk = (node: FakeNode): void => {
      if (node.textContent.length > 0) {
        parts.push(node.textContent);
      }
      node.children.forEach(walk);
    };
    walk(root);
    return parts.join(' ');
  };

  return {
    root,
    posted,
    deliver: (message) => {
      for (const listener of messageListeners) {
        listener({ data: message });
      }
    },
    query,
    text,
  };
}

function testRow(id: string, verdict: Verdict | null): PanelTest {
  return {
    id,
    input: `data/${id}.in`,
    answer: `data/${id}.out`,
    points: 50,
    subtask: '1',
    verdict,
    timeMs: verdict === null ? null : 12,
    memoryKb: verdict === null ? null : 1300,
    message: verdict === 'WA' ? '第 2 行不同' : '',
    firstDiffLine: verdict === 'WA' ? 2 : null,
    inputText: '1 2\n',
    expectedText: '3\n',
    outputText: verdict === null ? '' : '3\n',
    hasData: true,
  };
}

function sampleState(): PanelState {
  return {
    contest: {
      id: 'demo',
      title: '演示赛',
      maxRejudge: 1,
      contestants: [
        { id: 'alice', name: 'Alice', auto: false },
        { id: 'bob', name: 'Bob', auto: true },
      ],
      problemIds: ['A'],
      all: [{ id: 'demo', title: '演示赛', legacy: true, active: true }],
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
        testCount: 2,
        maxScore: 100,
        subtaskCount: 1,
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
          points: 100,
          tests: ['1', '2'],
          dependsOn: [],
          scoring: 'min',
          result: { id: '1', score: 50, maxScore: 100, status: 'partial' },
        },
      ],
      tests: [testRow('1', 'AC'), testRow('2', 'WA')],
      orphanTests: [],
      score: 50,
      maxScore: 100,
      partial: false,
    },
    source: { path: '/w/players/bob/A.cpp', name: 'A.cpp', dirty: false, judgeable: true },
    standings: {
      problems: [{ id: 'A', name: 'A. 求和' }],
      contestants: [
        { id: 'alice', name: 'Alice' },
        { id: 'bob', name: 'Bob' },
      ],
      ranks: [
        { contestant: 'alice', rank: 1, score: 100 },
        { contestant: 'bob', rank: 2, score: 50 },
      ],
      cells: [
        { contestant: 'alice', problem: 'A', score: 100, verdict: 'AC', rejudgeCount: 0 },
        { contestant: 'bob', problem: 'A', score: 50, verdict: 'WA', rejudgeCount: 1 },
      ],
    },
    busy: null,
    notice: { level: 'warn', text: 'WA · AC 1/2' },
  };
}

describe('侧边栏面板的脚本（假 DOM 冒烟测试）', () => {
  it('启动后先向扩展要数据', () => {
    const harness = boot();
    expect(harness.posted.some((message) => message.type === 'ready')).toBe(true);
  });

  it('收到数据后三个页签都渲染得出来', () => {
    const harness = boot();
    harness.deliver({ type: 'data', payload: sampleState() });
    expect(harness.root.children.length).toBeGreaterThan(0);

    const tabs = harness.query((node) => node.className === 'tabs')?.children ?? [];
    expect(tabs.map((node) => node.textContent)).toEqual(['题目', '测试点', '榜单']);

    for (const tab of tabs) {
      tab.click();
      expect(harness.root.children.length).toBeGreaterThan(0);
      expect(harness.root.children.some((node) => node.className === 'body')).toBe(true);
    }
  });

  it('展开一个测试点时会显示输入 / 答案 / 实际输出', () => {
    const harness = boot();
    harness.deliver({ type: 'data', payload: sampleState() });

    const caseRow = harness.query((node) => node.className === 'case');
    expect(caseRow, '测试点列表里应当有一行').toBeDefined();
    caseRow?.click();

    const box = harness.query((node) => node.className === 'expand');
    expect(box, '展开后应当出现详情区').toBeDefined();
    const texts = (box?.children ?? []).map((node) => node.textContent);
    expect(texts.some((text) => text.includes('实际输出'))).toBe(true);
  });

  it('忙碌与提示消息只改底部状态栏，不炸渲染', () => {
    const harness = boot();
    harness.deliver({ type: 'data', payload: sampleState() });
    harness.deliver({ type: 'busy', text: '评测 2/6' });
    expect(harness.query((node) => node.className.startsWith('status'))?.textContent).toContain('评测 2/6');
    harness.deliver({ type: 'notice', level: 'error', text: '编译失败' });
    expect(harness.query((node) => node.className.startsWith('status'))?.textContent).toContain('编译失败');
  });

  it('空工作区也渲染得出来（还没有题目/比赛）', () => {
    const harness = boot();
    harness.deliver({
      type: 'data',
      payload: {
        contest: null,
        problems: [],
        selected: null,
        source: null,
        standings: null,
        busy: null,
        notice: null,
      },
    });
    expect(harness.root.children.some((node) => node.className === 'body')).toBe(true);
    expect(harness.text()).toContain('Verdict 本地评测');
    expect(harness.text()).toContain('还没有题目');
  });
});
