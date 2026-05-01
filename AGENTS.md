# Agent Execution Protocol

## 1. Boot Sequence

- **Scan:** Read all `.cursor/rules/*.mdc` before first output.
- **Stack:** React 19, Vite, TypeScript, Tailwind CSS 4 (shadcn-style tokens in `src/index.css`), ESLint (flat config), **@react-three/fiber**, **@react-three/drei**, **three**, **astronomy-engine**, **Luxon**, **tz-lookup**, **magvar**. Static deploy path: **Cloudflare** via `@cloudflare/vite-plugin` and **Wrangler** ([wrangler.jsonc](wrangler.jsonc)). There is no TanStack Router/Start, Biome, Vitest, or Knip in this repo unless explicitly added later. No Svelte; ignore Svelte-specific tooling unless `.svelte` files appear.
- **Validation:** After substantive edits, run **`npm run verify`** (runs ESLint then `npm run build`, which is `tsc -b` + `vite build`). Fix failures before finishing.

---

## 2. Reasoning & Constraints

### A. Think Before Coding

- **Surface tradeoffs:** State assumptions explicitly. If two or more interpretations exist, **ask**; do not guess.
- **Halt on ambiguity:** If a request is unclear, name the confusion and stop.
- **Senior dev filter:** If a solution is 200 lines and could be 50, **rewrite it.** No speculative abstractions.

### B. Surgical implementation

- **Strict scope:** Change only what is requested.
- **No side effects:** Do not "improve" or refactor adjacent code, comments, or formatting.
- **Style match:** Mirror existing patterns, even if suboptimal.
- **No eyebrows:** Never add eyebrow/kicker text (tiny uppercase labels above titles) unless the user explicitly asks.
- **Orphan policy:** Remove imports/variables/functions rendered unused by *your* changes. Leave pre-existing dead code alone.

### C. Goal-driven loop

1. **Reproduce:** Define a specific failure state or observable bug when fixing behavior.
2. **Execute:** Implement the minimum code to solve the problem.
3. **Verify:** Confirm success (e.g. `npm run verify`, UI matches the request).

---

## 3. Tech stack specifics

- **Package manager:** **npm** ([package.json](package.json)).
- **Layout:** Most UI and simulation logic lives in [src/App.tsx](src/App.tsx). Shared primitives: [src/components/ui/](src/components/ui/), [src/lib/utils.ts](src/lib/utils.ts). When you touch a large area, prefer **extracting** hooks or components in `src/` rather than growing `App.tsx` further.
- **Imports:** Prefer **`@/...`** for app code (`@/components/ui/...`, `@/lib/...`), matching [tsconfig.json](tsconfig.json) paths and [vite.config.ts](vite.config.ts).
- **3D:** R3F `Canvas`, drei helpers (`OrbitControls`, `Stars`, `useTexture`, `Line`, etc.), Three.js math and types. See `.cursor/rules/react-r3f-patterns.mdc` when editing the orbit view.
- **Astronomy & time:** `astronomy-engine` for bodies, horizons, rise/set, moon phase; **Luxon** for zoned civil time; **tz-lookup** for IANA zone from lat/lon; **magvar** for compass declination. Keep civic-time helpers (`civicInstantMillis`, etc.) consistent when changing date/time UX.
- **Device compass:** `DeviceOrientation` / iOS compass requires a **secure context**. Local testing over HTTPS: **`npm run dev:https`** (see messages in `useDeviceHeading` in `App.tsx`).
- **Styling:** Tailwind utilities plus tokens from [src/index.css](src/index.css). Follow `.cursor/rules/tailwind.mdc`.
- **Dev / preview:** `npm run dev`; `npm run preview` builds then `wrangler dev`; `npm run deploy` builds then `wrangler deploy`.

---

**Status:** Protocol active. Awaiting task.
