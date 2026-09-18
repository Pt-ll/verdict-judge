import * as fs from 'node:fs';
import * as path from 'node:path';
import { VERDICT_PRIORITY } from '../model';
import type { CaseResult, ProblemResult, Submission, SubtaskResult, Verdict } from '../model';
import { ConfigIssues, describe, isObject, readJsonObject, readNonNegative, readString } from '../../util/json';
import { submissionKey } from './standings';

export { SUBMISSIONS_FILE } from '../layout';
export const SUBMISSIONS_JSON_VERSION = 1;

/**
 * 读评测记录。
 *
 * 文件是机器写的，读不出来通常意味着被改坏了；这时直接报错而不是猜，
 * 因为重跑一次评测就能重建它（而且比猜测更可信）。
 *
 * 参数是**文件路径**而不是目录：0.1.3 起每场比赛的记录各占一个文件
 * （.verdict/submissions/<比赛 id>.json），单场比赛的旧 .verdict/submissions.json 也照读。
 */
export async function loadSubmissions(file: string): Promise<Submission[]> {
  if (!(await exists(file))) {
    return [];
  }

  const raw = await readJsonObject(file, (target) => fs.promises.readFile(target, 'utf8'));
  const issues = new ConfigIssues();
  const list = raw.submissions;
  if (!Array.isArray(list)) {
    issues.add(`submissions 必须是数组，现在是 ${describe(list)}`);
    issues.throwIfAny(file);
    return [];
  }

  const submissions: Submission[] = [];
  list.forEach((item, index) => {
    const parsed = readSubmission(item, `submissions[${index}]`, issues);
    if (parsed !== null) {
      submissions.push(parsed);
    }
  });
  issues.throwIfAny(file);
  return submissions;
}

export async function saveSubmissions(
  file: string,
  submissions: Submission[],
): Promise<void> {
  const text = `${JSON.stringify(
    { version: SUBMISSIONS_JSON_VERSION, submissions: submissions.map(toStored) },
    null,
    2,
  )}\n`;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, text, 'utf8');
}

/** 用新评的结果替换同一个「选手 × 题目」的旧记录，其余原样保留。 */
export function mergeSubmissions(
  existing: Submission[],
  incoming: Submission[],
): Submission[] {
  const byCell = new Map<string, Submission>();
  for (const submission of existing) {
    byCell.set(submissionKey(submission.contestant, submission.problem), submission);
  }
  for (const submission of incoming) {
    byCell.set(submissionKey(submission.contestant, submission.problem), submission);
  }
  return [...byCell.values()];
}

/**
 * 落盘前丢掉输出与答案。
 *
 * 那是字节流、可能有几十 MB（输出上限按 outputKb 算），而榜单与报告只需要
 * 判定/分数/耗时/内存。需要看输出的场合（diff、详情）都发生在内存里那一次评测，
 * 不依赖重启后的数据。
 */
function toStored(submission: Submission): Record<string, unknown> {
  return {
    id: submission.id,
    contestant: submission.contestant,
    problem: submission.problem,
    source: submission.source,
    language: submission.language,
    ...(submission.verdict === undefined ? {} : { verdict: submission.verdict }),
    ...(submission.message === undefined ? {} : { message: submission.message }),
    rejudgeCount: submission.rejudgeCount,
    time: submission.time,
    ...(submission.result === undefined ? {} : { result: storeResult(submission.result) }),
  };
}

function storeResult(result: ProblemResult): Record<string, unknown> {
  return {
    problem: result.problem,
    score: result.score,
    maxScore: result.maxScore,
    elapsedMs: result.elapsedMs,
    subtasks: result.subtasks,
    // 逐字段列出来而不是整个摊开：这是「存了什么」的契约，多一个字段就得显式决定要不要存。
    cases: result.cases.map((item) => ({
      test: item.test,
      verdict: item.verdict,
      score: item.score,
      timeMs: item.timeMs,
      memoryKb: item.memoryKb,
      exitCode: item.exitCode,
      signal: item.signal,
      ...(item.message === undefined ? {} : { message: item.message }),
      ...(item.firstDiffLine === undefined ? {} : { firstDiffLine: item.firstDiffLine }),
    })),
  };
}

function readSubmission(
  raw: unknown,
  where: string,
  issues: ConfigIssues,
): Submission | null {
  if (!isObject(raw)) {
    issues.add(`${where} 必须是对象，现在是 ${describe(raw)}`);
    return null;
  }
  const id = readString(raw.id);
  const contestant = readString(raw.contestant);
  const problem = readString(raw.problem);
  const source = readString(raw.source);
  const time = readString(raw.time);
  if (id === undefined || contestant === undefined || problem === undefined) {
    issues.add(`${where} 缺少 id / contestant / problem 之一`);
    return null;
  }
  if (source === undefined || time === undefined) {
    issues.add(`${where}（提交 ${id}）缺少 source 或 time`);
    return null;
  }

  return {
    id,
    contestant,
    problem,
    source,
    language: readString(raw.language) ?? 'cpp',
    rejudgeCount: readNonNegative(raw.rejudgeCount, `${where}.rejudgeCount`, issues) ?? 0,
    time,
    ...(readVerdict(raw.verdict) === undefined ? {} : { verdict: readVerdict(raw.verdict) }),
    ...(readString(raw.message) === undefined ? {} : { message: readString(raw.message) }),
    ...(isObject(raw.result) ? { result: readResult(raw.result) } : {}),
  };
}

function readResult(raw: Record<string, unknown>): ProblemResult {
  const cases = Array.isArray(raw.cases) ? raw.cases.filter(isObject).map(readCase) : [];
  const subtasks: SubtaskResult[] = Array.isArray(raw.subtasks)
    ? raw.subtasks.filter(isObject).map((item) => ({
        id: readString(item.id) ?? '?',
        score: typeof item.score === 'number' ? item.score : 0,
        maxScore: typeof item.maxScore === 'number' ? item.maxScore : 0,
        status: (readString(item.status) ?? 'none') as SubtaskResult['status'],
      }))
    : [];
  return {
    problem: readString(raw.problem) ?? '',
    score: typeof raw.score === 'number' ? raw.score : 0,
    maxScore: typeof raw.maxScore === 'number' ? raw.maxScore : 0,
    cases,
    subtasks,
    elapsedMs: typeof raw.elapsedMs === 'number' ? raw.elapsedMs : 0,
  };
}

/** 输出与答案没存，读回来给空 Buffer：保持类型不变，调用方不必到处判空。 */
function readCase(raw: Record<string, unknown>): CaseResult {
  return {
    test: readString(raw.test) ?? '?',
    verdict: readVerdict(raw.verdict) ?? 'UKE',
    score: typeof raw.score === 'number' ? raw.score : 0,
    timeMs: typeof raw.timeMs === 'number' ? raw.timeMs : 0,
    memoryKb: typeof raw.memoryKb === 'number' ? raw.memoryKb : 0,
    exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : null,
    signal: readString(raw.signal) ?? null,
    ...(readString(raw.message) === undefined ? {} : { message: readString(raw.message) }),
    ...(typeof raw.firstDiffLine === 'number' ? { firstDiffLine: raw.firstDiffLine } : {}),
    output: Buffer.alloc(0),
    answer: Buffer.alloc(0),
  };
}

/** 只认已知的判定值：文件被改坏时不要凭空造出一个没人认识的判定。 */
function readVerdict(value: unknown): Verdict | undefined {
  const text = readString(value);
  return text !== undefined && (VERDICT_PRIORITY as string[]).includes(text)
    ? (text as Verdict)
    : undefined;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.promises.access(target);
    return true;
  } catch {
    return false;
  }
}
