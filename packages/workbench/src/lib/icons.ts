import { FileText, Puzzle, Search, Sparkles, SquarePen, Terminal } from "lucide-vue-next";
import type { FunctionalComponent, SVGAttributes } from "vue";

export type IconComponent = FunctionalComponent<SVGAttributes>;

/** Chat 步骤类型 → lucide 图标。未知类型回退 Puzzle。 */
export const STEP_ICONS: Record<string, IconComponent> = {
  read: FileText,
  exec: Terminal,
  test: Sparkles,
  search: Search,
  write: SquarePen,
};

export function stepIcon(kind: string): IconComponent {
  return STEP_ICONS[kind] ?? Puzzle;
}
