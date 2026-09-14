# Impact List

Impact List is a project that aims to build and maintain a list which ranks the top ~1,000 living people by their positive impact on the world via donations.

The goal is to make the list popular enough to increase the status awarded to those who rank highly, bring more awareness to the importance of donation effectiveness, and ultimately cause people to donate more effectively and/or donate more money to effective causes.

See [this description of the project](https://forum.effectivealtruism.org/posts/LCJa4AAi7YBcyro2H/proposal-impact-list-like-the-forbes-list-except-for-impact) for details.

## How you can help

We’re actively seeking volunteers to help with the project.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute research to the site. This includes keeping the donations up to date and accurate for existing people, adding more people (and all their donations), and helping to improve our research into the effectiveness of various charities or general types of charity.

We also are looking for volunteer developers and UX people to help improve the functionality and appearance of the website.

Join [the discord](https://discord.gg/6GNre8U2ta) to learn more about these and other ways that you can get involved.

## Tech Stack

- React
- Tailwind CSS
- Vite
- Vitest (unit/integration tests)
- Playwright (end-to-end tests)

## Local development

1. Clone this repository.
2. Select the Node version in `.nvmrc` (for example, run `nvm install` and `nvm use`).
3. Install the npm version pinned in `package.json`, verify the toolchain, and install the locked dependencies:

   ```sh
   sh scripts/bootstrap-npm.sh
   node --version
   npm --version
   npm run setup
   ```

   The version checks should match the Node and npm requirements in `package.json`.
   `setup` runs `npm ci` with dependency scripts disabled, then explicitly initializes Husky with `npm run prepare`.
   CI and Vercel both bootstrap the pinned npm before running the same setup command.

4. Generate data
   ```
   npm run generate-data
   ```
5. Start development server (recommended):

   ```
   vercel dev
   ```

   This is the default way to run locally because it serves both:

   - the Vite frontend
   - Vercel serverless routes under `/api/*` (used by shared assumptions and health checks)

6. Optional frontend-only dev server:

   ```
   npm run dev
   ```

   Use this only when you do not need `/api/*` routes.

7. Build for production:
   ```
   npm run build
   ```
8. Preview production build:
   ```
   npm run preview
   ```

## Linting

1. The entire project

```
npm run lint
```

2. On single file

```
npx eslint <filename>
```

### Prettier

Check:

```
npx prettier --check .
```

Write:

```
npx prettier --write .
```

## Testing

Test Scripts Available:

- npm run test - Run tests in watch mode
- npm run test:run - Run once and exit
- npm run test:coverage - Generate coverage report (enforces 50% coverage floors)
- npm run test:watch - Explicit watch mode
- npm run test:e2e - Playwright end-to-end tests, chromium only (builds the app and serves a preview automatically)
- npm run test:e2e:headed - Same, with a visible browser
- npm run test:e2e:release - The cross-browser pass (chromium + firefox + webkit, self-installs browsers). Run before a release or publicity push, not routinely

CI (GitHub Actions) runs lint, the coverage-gated unit suite, and the production build on every push/PR; the e2e suite runs nightly.

## Shared Assumptions Redis Setup Across Branches/Worktrees

### Why this is needed

Environment variables are configured per **Vercel project/environment**, not per git branch directly.  
Each worktree can be linked to a different Vercel project, and `vercel pull` overwrites `.env.local` with values from the linked project.

### How to make it work everywhere

1. For each Vercel project you use (`orange`, `impactlist`, etc.), add:

   - `SHARED_ASSUMPTIONS_REDIS_REST_URL`
   - `SHARED_ASSUMPTIONS_REDIS_REST_TOKEN`

2. Add them for at least:

   - `development`
   - (recommended) `preview`
   - (recommended) `production`

3. In each branch/worktree:

   - run `vercel link` and confirm which project it points to
   - run `vercel pull --environment=development`
   - run `vercel dev`
     - `vercel dev --listen 3001`

   See `.env.example` for the environment variables the shared-assumptions API reads (and a spelling gotcha to avoid).

### Quick checklist per branch/worktree

1. Check linked project:

   - `.vercel/project.json`

2. Ensure linked project has these vars in `development`:

   - `SHARED_ASSUMPTIONS_REDIS_REST_URL`
   - `SHARED_ASSUMPTIONS_REDIS_REST_TOKEN`

3. Refresh local env:

   - `vercel pull --yes --environment=development`

4. Verify Redis is configured:
   - `curl http://localhost:3001/api/health?check=redis`
   - Response should indicate Redis checks are OK.

## Other

### Dependency updates and install scripts

The committed npm policy waits seven days before selecting a newly published package version and disables dependency
install scripts with `ignore-scripts=true`. Fresh setup uses `npm run setup` to install the lockfile and explicitly initialize
Husky. Data generation is part of the `dev`, `test`, `test:run`, `test:coverage`, `test:watch`, and `build` commands themselves,
so it still runs with automatic lifecycle hooks disabled. The locked esbuild packages work with their packaged binaries
without running install hooks. The locked fsevents packages ship their native binaries, but the lockfile marks them as
having install scripts; the explicit deny entry supports strict, scripts-enabled installs of these locked versions too.
Watcher fallbacks remain available.

`strict-allow-scripts` and the version-specific `allowScripts` entries remain an extra check for an intentional rebuild with
scripts enabled. They are not the default execution barrier: npm 11.16.0 can discover a tarball's `binding.gyp` only after its
strict preflight and run an implicit native build even when registry metadata declares no scripts. The install-policy
fixtures cover this case under both `npm install` and `npm ci`. Do not re-enable scripts for a general install. If a reviewed
package needs a rebuild, target its reviewed exact version, for example `npm rebuild esbuild@0.25.2 --ignore-scripts=false`.

These safeguards cover installation only; they do not sandbox dependency code when the application or development tools
run. npm's explicit command-line and environment overrides remain available.

Before installing a dependency update, review the manifest and lockfile diffs, publication dates, package provenance and
source, and changes to any install code or helpers it invokes (including binary-download fallbacks). Keep approvals
version-specific so each new script-bearing version requires another review. The install-policy fixtures record npm's
lockfile behavior: the seven-day age check filters new resolutions and updates, while both `npm install` and `npm ci`
continue to honor an already-locked recent version.

For an urgent security fix to a direct dependency that is less than seven days old, make a one-command exception and
review the entire manifest and lockfile diff before committing it:

```sh
npm install <package>@<fixed-version> --min-release-age=0
```

For a transitive dependency, use `npm update <package> --min-release-age=0` when its parent's version range allows the fix.
If that range excludes the fixed version, update the parent or add a reviewed `overrides` entry and regenerate the lockfile
with the same one-command age exception. Adding the transitive package as a direct dependency can leave the vulnerable
nested copy installed. Verify that every affected copy in the lockfile has been fixed before committing.

Keep the committed seven-day default unchanged and document why the exception was necessary in the change review.

When running `npm audit` or `npm audit fix`, add `--omit=dev` to analyze only the dependencies in the deployed app/runtime.
`npm audit fix --omit=dev` prunes devDependencies from `node_modules`; repeat the pinned toolchain checks above and run
`npm run setup` afterwards to restore the reproducible development environment and hooks.
