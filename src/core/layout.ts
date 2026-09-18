import * as path from 'node:path';

/**
 * 工作区的目录布局常量与拼路径的纯函数（SPEC §6.1）。
 *
 * 单独放一份是为了让 core/problem 与 core/contest 都能用同一套目录名：
 * contest 要读题目包，题目包若反过来 import contest 就成环了。
 */

export const VERDICT_DIR = '.verdict';
/** 多场比赛：一个比赛一个文件（SPEC §6.2）。 */
export const CONTESTS_DIR = 'contests';
export const PROBLEMS_DIR = 'problems';
/** 测试数据总库：data/<题目 id>/ 里放这个题目的全部 .in / .out。 */
export const DATA_DIR = 'data';
/** 多场比赛的评测记录：一个比赛一个文件。 */
export const SUBMISSIONS_DIR = 'submissions';
/** 0.1.2 及更早的单场比赛布局：.verdict/contest.json 与 .verdict/submissions.json。 */
export const CONTEST_FILE = 'contest.json';
export const SUBMISSIONS_FILE = 'submissions.json';

export function verdictDirOf(rootDir: string): string {
  return path.join(rootDir, VERDICT_DIR);
}

export function contestsDirOf(rootDir: string): string {
  return path.join(verdictDirOf(rootDir), CONTESTS_DIR);
}

export function problemsDirOf(rootDir: string): string {
  return path.join(verdictDirOf(rootDir), PROBLEMS_DIR);
}

/** 一道题的配置目录：.verdict/problems/<题目 id>。 */
export function problemDirOf(rootDir: string, problemId: string): string {
  return path.join(problemsDirOf(rootDir), problemId);
}

/** 数据总库根目录（每道题是它的一个子目录）。 */
export function dataRootOf(rootDir: string): string {
  return path.join(verdictDirOf(rootDir), DATA_DIR);
}

export function submissionsDirOf(rootDir: string): string {
  return path.join(verdictDirOf(rootDir), SUBMISSIONS_DIR);
}

/** 某一道题目在测试数据总库里占的目录。 */
export function problemDataDirOf(rootDir: string, problemId: string): string {
  return path.join(dataRootOf(rootDir), problemId);
}

export function contestFileOf(rootDir: string, contestId: string): string {
  return path.join(contestsDirOf(rootDir), `${contestId}.json`);
}

export function legacyContestFileOf(rootDir: string): string {
  return path.join(verdictDirOf(rootDir), CONTEST_FILE);
}

export function submissionsFileOf(rootDir: string, contestId: string): string {
  return path.join(submissionsDirOf(rootDir), `${contestId}.json`);
}

export function legacySubmissionsFileOf(rootDir: string): string {
  return path.join(verdictDirOf(rootDir), SUBMISSIONS_FILE);
}
