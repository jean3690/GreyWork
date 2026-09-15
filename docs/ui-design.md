# GreyWork UI Design Guidelines

This document defines the visual design language for GreyWork. The canonical implementation lives in `@greywork/workbench/src/theme/` — specifically `tokens.css` (CSS custom properties) and `token-contract.ts` (the TypeScript contract that validates them).

## Design Philosophy

- **Dark-first**: Dark mode is the default appearance. The shell writes `data-theme="dark"` on first frame to prevent flash.
- **Near-black canvas**: OLED-friendly pure black (`#000000`) base with 5-level grayscale layering (`bg-base → bg-1 → bg-2 → border`). Cards and surfaces gain depth through elevation, not borders.
- **Blue-primary, violet-brand**: Primary actions use blue (`#4d9fff` dark / `#165dff` light). The GreyWork brand color is violet (`#a1aacb` dark / `#7583b2` light) — used only for brand elements, not primary actions.
- **Color restraint in chat**: Chat surfaces (bubbles, tips panels, thought panels) are all neutral black-gray. Color appears only in Agent identity avatars (`--grey-*`), status signals, and semantic tokens.

## Theme Structure

### Token Categories

Tokens are grouped into semantic categories (mirrored in `token-contract.ts`):

| Group        | Purpose                                        |
| ------------ | ---------------------------------------------- |
| `background` | Canvas, panels, surfaces, paper                |
| `text`       | Primary, secondary, tertiary text              |
| `border`     | Input/output borders, dividers                 |
| `semantic`   | Status signals (warning, info, success, error) |
| `brand`      | GreyWork brand color + Agent identity colors   |
| `accent`     | Primary action color + hover states            |
| `special`    | Font families (not user-overridable color)     |

### Available Palettes

Four palettes are defined:

1. **`greywork`** (default) — Dark-first, near-black, blue primary, violet brand
2. **`github`** — GitHub-inspired code workbench, green primary
3. **`fox`** — Warm terracotta, orange primary
4. **`night-blue`** — Blue-tinted dark, blue primary
5. **`night-green`** — Green-tinted dark, green primary

Each palette has `light` and `dark` variants.

### Token Scoping

- **Appearance-invariant tokens**: Same value in both light and dark mode (e.g., `--console`, `--grey-*`, fonts). Defined once on `:root`.
- **Appearance-scoped tokens**: Different values in light vs. dark mode. Defined on `:root` (light) and overridden in `:root[data-theme="dark"]`.
- **Structure tokens** (`--gw-*`): Layout variables (sidebar width, topbar height, etc.) — not theme-overridable.

## Layout

```
--gw-sidebar-w: 260px      /* Left navigation rail */
--gw-topbar-h: 56px        /* Top app bar */
--gw-side-w: 420px         /* Right property panel (520px on ≥1600px) */
--gw-statusbar-h: 24px     /* Bottom status bar */
```

## Typography

- **UI / Display**: Archivo Variable (DIN-style industrial grotesque with width axis for label tags)
- **Code / Metrics**: JetBrains Mono
- **Chinese fallback**: Noto Sans SC / Microsoft YaHei / system-ui

Font size: 15px base.

## Component Conventions

- Use **shadcn/ui components** as the foundation (configured per `@ greywork/workbench` conventions)
- **Never hardcode** theme tokens — always use CSS variable references from `tokens.css`
- New color tokens must be registered in `token-contract.ts` and will be validated by `token-contract.test.ts`
- Status signals should use the semantic token set (`--amber`, `--cyan`, `--violet`, `--mint`, `--orange`)
- Agent-specific accent colors use the `--grey-*` family (blue, green, orange, violet, red)

## Accessibility

- All text/background contrasts must meet WCAG AA (4.5:1) in both light and dark modes
- `--dim2` is reserved for 10–12px tertiary text (requires extra attention to contrast)
- `color-scheme` is always declared alongside theme roots

## Adding New Tokens

1. Add the token to `tokens.css` under the correct semantic group
2. Add a descriptor entry to `THEME_TOKENS` in `token-contract.ts`
3. Add values for all active palettes (greywork, github, fox, night-blue, night-green)
4. Ensure `token-contract.test.ts` passes parity validation
