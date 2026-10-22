import { createSkill } from "@mastra/core/skills";

/**
 * Frontend and UI design skill for the coding lane.
 *
 * Merges the guidance from the official Mastra `react-best-practices` and
 * `tailwind-best-practices` skills into one inline skill. It steers the actor
 * toward correct React data flow, rendering, and accessibility, and toward
 * token-driven Tailwind styling, while staying compatible with the lane's
 * whole-file replacement patch model.
 */
export const frontendUiDesignSkill = createSkill({
  name: "frontend-ui-design",
  description:
    "Build or patch React and TypeScript UI with correct state, rendering, accessibility, and token-driven Tailwind styling. Use when a change touches components, hooks, layout, styling, or interaction behavior. For UI work only.",
  instructions: `# Frontend and UI design

Aim for components that are correct, cheap to render, accessible, and styled from the design system rather than by eye.

## State and data flow

- Keep state as local as it can live. Lift only what two or more components genuinely share.
- Derive values during render instead of mirroring them into state with an effect. If it can be computed, do not store it.
- A component should own its data. Fetch at the point of use with a loader or hook, cache the result, and never refetch on every render.
- Model the three states of every async view: loading, empty, and error. Absence of data is a state, not a blank screen.
- Use controlled inputs for form fields, validate before submit, and surface field-level errors rather than a generic failure.

## Rendering and performance

- Give lists stable keys drawn from identity, never the array index, unless the list is static and never reordered.
- Memoize a component or value only when profiling shows a real cost. Do not add memo everywhere.
- Keep props narrow and typed. Avoid passing whole objects that change identity each render.
- Virtualize long lists. Above a couple hundred rows, render only what is visible.
- Never set state during render, and never read a ref's current value during render.

## Accessibility

- Use semantic elements first: button for actions, a for navigation, label tied to input, heading order that does not skip levels.
- Every interactive control is reachable by keyboard and shows a visible focus state.
- Provide alt text for informative images, labels for icon-only controls, and rely on native ARIA only when no semantic element fits.
- Keep color contrast at or above 4.5 to 1 for body text, and never encode meaning in color alone.

## Tailwind and styling

- Compose from utility classes and existing design tokens. Do not invent one-off spacing, color, or font sizes.
- Avoid arbitrary bracket values such as w-[137px] when a scale step exists. Arbitrary values fragment the system.
- Express states with variants like hover:, focus:, disabled:, dark:, and data- attributes, not with imperative style toggles.
- Keep responsive behavior in the same class string with sm:, md:, and lg: prefixes rather than JS window-width logic.
- Extract a repeated class pattern into a component, not into a mega-class blob.

See references/checklist.md before you finalize a UI patch.`,
  references: {
    "checklist.md": `# UI final checklist

- Is state colocated and derived rather than duplicated through effects?
- Are loading, empty, and error states all handled for async views?
- Do lists use identity keys and virtualization when long?
- Is the change reachable and readable by keyboard and screen reader?
- Does styling come from tokens and variants, with no new arbitrary values?
- Is the patch bounded to the files the RCA named?`,
  },
});
