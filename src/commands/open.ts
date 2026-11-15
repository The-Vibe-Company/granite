import { editCommand } from './edit.js';

// Opening an editor is a write surface too; use the same attribution path.
export function openNote(slug: string, options: { author?: string } = {}): void {
  editCommand(slug, options);
}
