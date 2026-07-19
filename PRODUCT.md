# TREK — Product Context

## Register

**Product.** App UI throughout — authenticated planning surfaces (maps, itineraries, budgets, packing, collab). Design serves the task; earned familiarity over novelty. The README/landing assets live upstream; this repo's design work is the app itself.

## What it is

A self-hosted, real-time collaborative travel planner: trips → days → places → assignments, plus reservations, budgets, packing lists, todos, group chat/polls, and a travel journal. React 19 + Vite client, Node server, shared Zod contracts.

## Who it's for

- Self-hosters running it for their household or friend group.
- Trip groups collaborating live: one person plans, others react, vote, and check things off.
- Chris's fork adds planning-surface features (day timeline, candidate places, booking flow) ahead of upstream.

## Brand personality

- Quiet, monochrome-first utility: near-black accent (`#111827` light / zinc dark), Geist Sans, generous radii (8–18px), soft faint borders.
- Color is data, not decoration — category colors, mood colors, map pins. Chrome stays neutral.
- Dense where the task is dense (day plans, tables), calm elsewhere. Motion is 150–250ms state feedback, `cubic-bezier(0.23,1,0.32,1)`.

## Anti-references

- SaaS dashboard clichés: hero metrics, gradient accents, glassmorphism as default.
- Travel-brand kitsch: sunset gradients, script fonts, postcard styling.
- Anything that breaks the existing token vocabulary (`bg-surface-*`, `text-content-*`, `border-edge-*`, `--accent`).

## Design principles

1. **Tokens first.** Every surface uses the established CSS-variable theme; both light and dark must feel intentional (`:root` / `.dark`).
2. **The itinerary is the hero.** Planning surfaces get the density and interaction budget; settings and admin stay plain.
3. **Direct manipulation over forms.** Drag-to-assign, drag-to-schedule, inline edit — modals are the fallback, not the default.
4. **Collaborative-safe.** Optimistic updates with rollback; every mutation must survive a teammate editing the same trip live.
5. **i18n always.** Every user-facing string goes through `t()`; `en` is the synchronous fallback locale.
