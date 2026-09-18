import type { ComparatorConfig, Limits, Problem, Subtask, TestCase } from '../model';
import { scanPackageTests, type ProblemPackage } from './package';
import { topoOrderSubtasks } from './subtasks';

export interface AddTestsPlan {
  /** 这次要登记的新测试点。 */
  added: TestCase[];
  /** 已经登记过、这次跳过的测试点 id。 */
  skipped: string[];
  /**
   * 登记后的完整列表（已有的在前、新加的在后），直接赋给 problem.tests 即可。
   *
   * 顺手给出来是为了堵住一个很容易犯的错：只把 added 赋回去会把已有测试点全丢掉。
   */
  tests: TestCase[];
}

/**
 * 扫描 data/，找出还没登记进 problem.json 的测试点。
 *
 * 按 id 与输入文件双重去重：只比 id 的话，同一份数据换个文件名仍会被重复登记；
 * 只比文件的话，同一份数据换个 id 也会重复。两种都会让 problem.json 变得难读。
 */
export async function planAddTests(pkg: ProblemPackage): Promise<AddTestsPlan> {
  const scanned = await scanPackageTests(pkg.dataDir);
  const knownIds = new Set(pkg.problem.tests.map((test) => test.id));
  const knownInputs = new Set(pkg.problem.tests.map((test) => test.input));

  const added: TestCase[] = [];
  const skipped: string[] = [];
  for (const test of scanned) {
    if (knownIds.has(test.id) || knownInputs.has(test.input)) {
      skipped.push(test.id);
      continue;
    }
    added.push(test);
  }
  return { added, skipped, tests: [...pkg.problem.tests, ...added] };
}

export interface SubtaskPlan {
  subtasks: Subtask[];
  /**
   * 同步更新过 subtask 字段的测试点。
   *
   * 两边说法必须一致，否则下次加载会报错——所以改子任务时必须把测试点一起改，
   * 不能只动一边。
   */
  tests: TestCase[];
}

/**
 * 把测试点按顺序均分成若干子任务：组内 min（全对才给分）、组间互相独立。
 *
 * 这只是把架子摆好。哪几个点属于同一档数据、要不要加依赖，还得人去改 problem.json：
 * 命令替人做这个决定只会帮倒忙。
 */
export function evenSubtasks(tests: TestCase[], groups: number, totalPoints = 100): SubtaskPlan {
  if (tests.length === 0) {
    return { subtasks: [], tests };
  }

  const count = Math.min(Math.max(1, Math.floor(groups) || 1), tests.length);
  const base = Math.floor(tests.length / count);
  const remainder = tests.length % count;

  const subtasks: Subtask[] = [];
  const updated: TestCase[] = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    const size = base + (index < remainder ? 1 : 0);
    const slice = tests.slice(cursor, cursor + size);
    cursor += size;

    const id = String(index + 1);
    subtasks.push({
      id,
      name: `第 ${id} 组`,
      points: shareOfPoints(index, count, totalPoints),
      tests: slice.map((test) => test.id),
      dependsOn: [],
      scoring: 'min',
    });
    for (const test of slice) {
      updated.push({ ...test, subtask: id });
    }
  }
  return { subtasks, tests: updated };
}

/** 总分尽量均分，余数给前面的组：30/30/20 比 33/33/34 更像人定的。 */
function shareOfPoints(index: number, count: number, total: number): number {
  const base = Math.floor(total / count);
  const remainder = total % count;
  return index < remainder ? base + 1 : base;
}

/** 清空子任务归属，同时把测试点上的 subtask 字段一并去掉。 */
export function clearSubtasks(tests: TestCase[]): TestCase[] {
  return tests.map((test) => {
    if (test.subtask === undefined) {
      return test;
    }
    const copy: TestCase = { ...test };
    delete copy.subtask;
    return copy;
  });
}

/** 只替换限制里给定的字段，其余原样保留；非法值直接忽略，不会把 undefined 写进 JSON。 */
export function withLimits(problem: Problem, patch: Partial<Limits>): Problem {
  const limits = { ...problem.limits };
  for (const [key, value] of Object.entries(patch) as [keyof Limits, number | undefined][]) {
    if (value !== undefined && Number.isFinite(value)) {
      limits[key] = value;
    }
  }
  return { ...problem, limits };
}

/**
 * 检查一组限制能不能用；没问题返回 null，有问题返回给人看的一句话。
 *
 * 面板上的输入框直接显示这句话，所以措辞是给用户看的，不是给日志看的。
 * 0 是合法的时间/输出上限吗：时间必须为正（0ms 连启动都不够，只会把程序判成 TLE），
 * 输出上限允许为 0（等于「不许输出」，有它的用途）；内存与栈同理必须为正。
 */
export function validateLimits(patch: Partial<Limits>): string | null {
  const rules: [keyof Limits, string, (value: number) => boolean][] = [
    ['timeMs', '时间限制', (value) => value > 0],
    ['memoryMb', '内存限制', (value) => value > 0],
    ['stackMb', '栈上限', (value) => value > 0],
    ['outputKb', '输出上限', (value) => value >= 0],
  ];
  for (const [key, label, ok] of rules) {
    const value = patch[key];
    if (value === undefined) {
      continue;
    }
    if (!Number.isFinite(value) || !ok(value)) {
      return `${label}必须是一个合法的${key === 'outputKb' ? '非负' : '正'}整数`;
    }
    if (!Number.isInteger(value)) {
      return `${label}必须是整数`;
    }
  }
  return null;
}

/** 换一种比较方式；real / spj / interactive 的附加字段原样带上。 */
export function withComparator(problem: Problem, config: ComparatorConfig): Problem {
  return { ...problem, comparator: { ...config } };
}

/** 子任务的可改字段。没给的字段保持原样。 */
export interface SubtaskPatch {
  name?: string;
  points?: number;
  dependsOn?: string[];
  scoring?: 'min' | 'sum';
}

/**
 * 下一个可用的子任务 id。
 *
 * 取「已用数字 id 的最大值 + 1」而不是个数 + 1：删掉中间一个再新建时，
 * 用个数算会撞上还活着的那个 id。
 */
export function nextSubtaskId(problem: Problem): string {
  let max = 0;
  for (const subtask of problem.subtasks) {
    const value = Number.parseInt(subtask.id, 10);
    if (Number.isInteger(value) && String(value) === subtask.id && value > max) {
      max = value;
    }
  }
  if (max === 0) {
    // 全是非数字 id 时，退回到「找一个不重复的编号」。
    for (let index = 1; ; index += 1) {
      if (!problem.subtasks.some((item) => item.id === String(index))) {
        return String(index);
      }
    }
  }
  return String(max + 1);
}

/**
 * 加一个空子任务。
 *
 * 空子任务在加载期是非法的（§6.3 明确报错），所以这里拦一道：
 * 加完立刻保存的话，用户下次打开就会看到加载失败，那比不让加更让人困惑。
 */
export function addSubtask(problem: Problem, points: number): Problem {
  if (!Number.isInteger(points) || points < 0) {
    throw new Error('子任务分值必须是非负整数');
  }
  if (problem.tests.length === 0) {
    throw new Error('这个题目还没有测试点，先导入测试点再加子任务');
  }
  const id = nextSubtaskId(problem);
  const subtask: Subtask = {
    id,
    name: `第 ${id} 组`,
    points,
    tests: [],
    dependsOn: [],
    scoring: 'min',
  };
  // 新建的子任务至少要有一个测试点，否则问题包立刻处于非法状态。
  const orphan = problem.tests.find(
    (test) => !problem.subtasks.some((item) => item.tests.includes(test.id)),
  );
  const target = orphan ?? problem.tests[0];
  if (target !== undefined) {
    subtask.tests = [target.id];
  }
  return withSubtask(problem, subtask, target?.id);
}

/** 改一个子任务；依赖成环、引用不存在的子任务都会在这里被挡下。 */
export function updateSubtask(problem: Problem, id: string, patch: SubtaskPatch): Problem {
  const existing = problem.subtasks.find((item) => item.id === id);
  if (existing === undefined) {
    throw new Error(`找不到子任务 "${id}"`);
  }
  if (patch.points !== undefined && (!Number.isInteger(patch.points) || patch.points < 0)) {
    throw new Error('子任务分值必须是非负整数');
  }

  const next: Subtask = { ...existing };
  if (patch.name !== undefined) {
    const trimmed = patch.name.trim();
    if (trimmed.length === 0) {
      delete next.name;
    } else {
      next.name = trimmed;
    }
  }
  if (patch.points !== undefined) {
    next.points = patch.points;
  }
  if (patch.dependsOn !== undefined) {
    const seen = new Set<string>();
    for (const dependency of patch.dependsOn) {
      if (dependency === id) {
        throw new Error(`子任务 "${id}" 不能依赖自己`);
      }
      if (!problem.subtasks.some((item) => item.id === dependency)) {
        throw new Error(`依赖的子任务 "${dependency}" 不存在`);
      }
      if (seen.has(dependency)) {
        throw new Error(`依赖的子任务 "${dependency}" 写了两次`);
      }
      seen.add(dependency);
    }
    next.dependsOn = [...seen];
  }
  if (patch.scoring !== undefined) {
    next.scoring = patch.scoring;
  }

  const subtasks = problem.subtasks.map((item) => (item.id === id ? next : item));
  // 复用加载期的环检测：依赖成环的分数是无意义的，不能让这种配置落盘。
  topoOrderSubtasks(subtasks);
  return { ...problem, subtasks };
}

/**
 * 删一个子任务。
 *
 * 只解除归属关系：测试点、输入与答案文件都留着（它们是真数据，删掉找不回来），
 * 依赖它的子任务自动摘掉这条依赖，否则下次加载会因为「依赖不存在」直接报错。
 */
export function removeSubtask(problem: Problem, id: string): Problem {
  const subtasks = problem.subtasks
    .filter((item) => item.id !== id)
    .map((item) =>
      item.dependsOn.includes(id)
        ? { ...item, dependsOn: item.dependsOn.filter((other) => other !== id) }
        : item,
    );
  const tests = problem.tests.map((test) =>
    test.subtask === id ? withoutSubtaskField(test) : test,
  );
  return { ...problem, subtasks, tests };
}

/**
 * 把测试点挪到另一个子任务（subtaskId 为 null 表示移出所有子任务）。
 *
 * 两处都要改：成员关系的权威来源是 subtask.tests，而测试点上的 subtask 字段
 * 必须跟着一致，否则加载期会因「两边说法不一致」报错（§6.3）。
 */
export function setTestSubtask(
  problem: Problem,
  testId: string,
  subtaskId: string | null,
): Problem {
  if (!problem.tests.some((test) => test.id === testId)) {
    throw new Error(`找不到测试点 "${testId}"`);
  }
  if (subtaskId !== null && !problem.subtasks.some((item) => item.id === subtaskId)) {
    throw new Error(`找不到子任务 "${subtaskId}"`);
  }

  const subtasks = problem.subtasks.map((item) => {
    const without = item.tests.filter((other) => other !== testId);
    if (item.id !== subtaskId) {
      return without.length === item.tests.length ? item : { ...item, tests: without };
    }
    return { ...item, tests: [...without, testId] };
  });
  const tests = problem.tests.map((test) =>
    test.id === testId
      ? subtaskId === null
        ? withoutSubtaskField(test)
        : { ...test, subtask: subtaskId }
      : test,
  );
  return { ...problem, subtasks, tests };
}

/** 移出一个测试点的登记。数据文件留在原地——「不登记」和「删文件」是两件事。 */
export function removeTest(problem: Problem, testId: string): Problem {
  if (!problem.tests.some((test) => test.id === testId)) {
    throw new Error(`找不到测试点 "${testId}"`);
  }
  return {
    ...problem,
    tests: problem.tests.filter((test) => test.id !== testId),
    subtasks: problem.subtasks.map((item) =>
      item.tests.includes(testId)
        ? { ...item, tests: item.tests.filter((other) => other !== testId) }
        : item,
    ),
  };
}

/** 把子任务挂上去，同时把那个测试点的 subtask 字段写成一致的值。 */
function withSubtask(problem: Problem, subtask: Subtask, testId: string | undefined): Problem {
  const tests = problem.tests.map((test) =>
    test.id === testId ? { ...test, subtask: subtask.id } : test,
  );
  // 那个测试点原本属于别的子任务时要摘出来，否则同一个点会被算两次。
  const subtasks = [
    ...problem.subtasks.map((item) =>
      testId === undefined || !item.tests.includes(testId)
        ? item
        : { ...item, tests: item.tests.filter((other) => other !== testId) },
    ),
    subtask,
  ];
  return { ...problem, subtasks, tests };
}

function withoutSubtaskField(test: TestCase): TestCase {
  const copy: TestCase = { ...test };
  delete copy.subtask;
  return copy;
}
