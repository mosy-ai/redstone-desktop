/** Error surfacing that never leaks a path or a token into the dialog text. */
import { dialog } from 'electron';
import { redact } from './logger';

export function showError(title: string, err: unknown): void {
  const detail = redact((err as Error)?.message ?? String(err));
  void dialog.showMessageBox({
    type: 'error',
    title,
    message: title,
    detail,
    buttons: ['OK'],
  });
}
