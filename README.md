# swarmz

swarmz is a Tauri 2 desktop app for hosting many terminal sessions at once, organized as a split tree of tab groups. It pairs a Rust core (PTY spawning, terminal registry) with a React/TypeScript frontend (xterm.js panes, drag-and-drop layout, a sidebar of running terminals).

## Development

```bash
npm install         # on npm 10.9.x an Arborist bug may require `npx npm@11 install` instead
npm run tauri dev    # launch the app in dev mode
npm test             # frontend unit tests (vitest)
cd src-tauri && cargo test   # Rust unit tests
```

## Docs

Specs live in `docs/superpowers/specs`, and implementation plans live in `docs/superpowers/plans`.
