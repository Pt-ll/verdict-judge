import * as fs from 'node:fs';
import * as vscode from 'vscode';

/**
 * 删除一个文件或目录：优先丢进系统回收站，回收站不可用（某些远程文件系统）时退回直接删。
 *
 * 只给「用户明确确认过要删」的地方用。走回收站是刻意的：出题人删错一个测试点数据的代价
 * 太大，而回收站让这件事变成可以反悔的。
 */
export async function removePath(target: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.delete(vscode.Uri.file(target), {
      recursive: true,
      useTrash: true,
    });
    return true;
  } catch {
    try {
      await fs.promises.rm(target, { recursive: true, force: true });
      return !fs.existsSync(target);
    } catch {
      return false;
    }
  }
}
