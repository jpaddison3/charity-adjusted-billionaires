import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';

const execFile = promisify(execFileCallback);
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const temporaryDirectories = [];
let npmCli;
let projectPolicy;

const createTemporaryDirectory = async (prefix) => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

const runNpm = async (directory, args, options = {}) => {
  const cache = options.cache ?? join(directory, '.npm-cache');
  return execFile(process.execPath, [npmCli, ...args], {
    cwd: directory,
    env: {
      ...process.env,
      INSTALL_MARKER: options.marker,
      npm_config_audit: 'false',
      npm_config_cache: cache,
      npm_config_fund: 'false',
      npm_config_registry: options.registry,
    },
    maxBuffer: 1024 * 1024,
  });
};

const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

const createProject = async (allowScripts = {}, dependencies = {}) => {
  const directory = await createTemporaryDirectory('impactlist-install-policy-');
  await writeFile(join(directory, '.npmrc'), projectPolicy.npmrc);
  await writeJson(join(directory, 'package.json'), {
    name: 'install-policy-test-project',
    version: '1.0.0',
    private: true,
    engines: projectPolicy.packageJson.engines,
    packageManager: projectPolicy.packageJson.packageManager,
    allowScripts: {
      ...projectPolicy.packageJson.allowScripts,
      ...allowScripts,
    },
    dependencies,
  });
  return directory;
};

const createPackageTarball = async (name, version, installScript) => {
  const directory = await createTemporaryDirectory('impactlist-install-package-');
  const packageDirectory = join(directory, 'package');
  await mkdir(packageDirectory);
  await writeJson(join(packageDirectory, 'package.json'), {
    name,
    version,
    ...(installScript ? { scripts: { install: installScript } } : {}),
  });
  await writeFile(join(packageDirectory, 'index.js'), `export default '${version}';\n`);

  const tarball = join(directory, `${name}-${version}.tgz`);
  await execFile('tar', ['-czf', tarball, '-C', directory, 'package']);
  return tarball;
};

const markerInstallScript = "node -e \"require('node:fs').writeFileSync(process.env.INSTALL_MARKER, 'ran')\"";

const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

const close = (server) =>
  new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

const withRegistryPackage = async (name, tarballs, callback) => {
  let registryOrigin;
  const server = createServer(async (request, response) => {
    const tarballEntry = [...tarballs.entries()].find(
      ([version]) => request.url === `/${name}/-/${name}-${version}.tgz`
    );
    if (tarballEntry) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(await readFile(tarballEntry[1]));
      return;
    }

    if (request.url !== `/${name}`) {
      response.writeHead(404).end();
      return;
    }

    const versions = Object.fromEntries(
      await Promise.all(
        [...tarballs.entries()].map(async ([version, tarball]) => [
          version,
          await registryVersion(name, version, tarball, registryOrigin, markerInstallScript),
        ])
      )
    );
    const latest = [...tarballs.keys()].at(-1);
    response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        name,
        'dist-tags': { latest },
        versions,
        time: Object.fromEntries(Object.keys(versions).map((version) => [version, '2020-01-01T00:00:00.000Z'])),
      })
    );
  });

  await listen(server);
  registryOrigin = `http://127.0.0.1:${server.address().port}`;
  try {
    await callback(registryOrigin);
  } finally {
    await close(server);
  }
};

beforeAll(async () => {
  npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run this test through an npm script so npm_execpath identifies the pinned npm CLI.');

  const [{ stdout: npmVersion }, npmrc, packageJson] = await Promise.all([
    execFile(process.execPath, [npmCli, '--version']),
    readFile(join(repositoryRoot, '.npmrc'), 'utf8'),
    readFile(join(repositoryRoot, 'package.json'), 'utf8').then(JSON.parse),
  ]);
  expect(npmVersion.trim()).toBe(packageJson.engines.npm);
  projectPolicy = { npmrc, packageJson };
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('dependency install-script policy', () => {
  test('rejects an unreviewed install script before it can run', async () => {
    const project = await createProject();
    const tarball = await createPackageTarball('fixture-unapproved', '1.0.0', markerInstallScript);
    const marker = join(project, 'unapproved-marker');

    await withRegistryPackage('fixture-unapproved', new Map([['1.0.0', tarball]]), async (registry) => {
      await expect(
        runNpm(project, ['install', 'fixture-unapproved@1.0.0'], { marker, registry })
      ).rejects.toMatchObject({
        code: 1,
      });
    });
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('skips an explicitly denied install script and completes installation', async () => {
    const project = await createProject({ 'fixture-denied': false });
    const tarball = await createPackageTarball('fixture-denied', '1.0.0', markerInstallScript);
    const marker = join(project, 'denied-marker');

    await withRegistryPackage('fixture-denied', new Map([['1.0.0', tarball]]), (registry) =>
      runNpm(project, ['install', 'fixture-denied@1.0.0'], { marker, registry })
    );

    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('runs an exactly approved version and requires review again for a version change', async () => {
    const project = await createProject({ 'fixture-approved@1.0.0': true });
    const approvedTarball = await createPackageTarball('fixture-approved', '1.0.0', markerInstallScript);
    const changedTarball = await createPackageTarball('fixture-approved', '1.0.1', markerInstallScript);
    const marker = join(project, 'approved-marker');

    await withRegistryPackage(
      'fixture-approved',
      new Map([
        ['1.0.0', approvedTarball],
        ['1.0.1', changedTarball],
      ]),
      async (registry) => {
        await runNpm(project, ['install', 'fixture-approved@1.0.0'], { marker, registry });
        expect(await readFile(marker, 'utf8')).toBe('ran');

        await rm(marker);
        await expect(
          runNpm(project, ['install', 'fixture-approved@1.0.1'], { marker, registry })
        ).rejects.toMatchObject({
          code: 1,
        });
      }
    );
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('applies the same approval when npm ci restores the lockfile', async () => {
    const tarball = await createPackageTarball('fixture-approved-ci', '1.0.0', markerInstallScript);
    const project = await createProject({ 'fixture-approved-ci@1.0.0': true }, { 'fixture-approved-ci': '1.0.0' });
    const marker = join(project, 'ci-marker');

    await withRegistryPackage('fixture-approved-ci', new Map([['1.0.0', tarball]]), async (registry) => {
      await runNpm(project, ['install'], { marker, registry });
      await rm(join(project, 'node_modules'), { recursive: true, force: true });
      await rm(marker);
      await runNpm(project, ['ci'], { marker, registry });
    });

    expect(await readFile(marker, 'utf8')).toBe('ran');
  });
});

describe('minimum release age policy', () => {
  test('filters new resolutions and updates but honors an already-locked recent version', async () => {
    const oldTarball = await createPackageTarball('fixture-release-age', '1.0.0');
    const recentTarball = await createPackageTarball('fixture-release-age', '1.1.0');
    const tarballs = new Map([
      ['/fixture-release-age/-/fixture-release-age-1.0.0.tgz', oldTarball],
      ['/fixture-release-age/-/fixture-release-age-1.1.0.tgz', recentTarball],
    ]);
    let includeRecentVersion = false;
    let registryOrigin;

    const server = createServer(async (request, response) => {
      if (tarballs.has(request.url)) {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(await readFile(tarballs.get(request.url)));
        return;
      }

      if (request.url !== '/fixture-release-age') {
        response.writeHead(404).end();
        return;
      }

      const versions = {
        '1.0.0': await registryVersion('fixture-release-age', '1.0.0', oldTarball, registryOrigin),
      };
      if (includeRecentVersion) {
        versions['1.1.0'] = await registryVersion('fixture-release-age', '1.1.0', recentTarball, registryOrigin);
      }
      response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          name: 'fixture-release-age',
          'dist-tags': { latest: includeRecentVersion ? '1.1.0' : '1.0.0' },
          versions,
          time: {
            created: '2020-01-01T00:00:00.000Z',
            modified: new Date().toISOString(),
            '1.0.0': '2020-01-01T00:00:00.000Z',
            ...(includeRecentVersion ? { '1.1.0': new Date().toISOString() } : {}),
          },
        })
      );
    });

    await listen(server);
    registryOrigin = `http://127.0.0.1:${server.address().port}`;

    try {
      const updateProject = await createProject({}, { 'fixture-release-age': '^1.0.0' });
      await runNpm(updateProject, ['install'], { registry: registryOrigin });
      expect(await installedVersion(updateProject)).toBe('1.0.0');

      includeRecentVersion = true;
      const freshProject = await createProject({}, { 'fixture-release-age': '^1.0.0' });
      await runNpm(freshProject, ['install', '--prefer-online'], { registry: registryOrigin });
      expect(await installedVersion(freshProject)).toBe('1.0.0');

      await runNpm(updateProject, ['update', '--prefer-online'], { registry: registryOrigin });
      expect(await installedVersion(updateProject)).toBe('1.0.0');

      const lockedRecentProject = await createProject({}, { 'fixture-release-age': '1.1.0' });
      await runNpm(lockedRecentProject, ['install', '--min-release-age=0'], { registry: registryOrigin });
      expect(await installedVersion(lockedRecentProject)).toBe('1.1.0');

      await rm(join(lockedRecentProject, 'node_modules'), { recursive: true, force: true });
      await runNpm(lockedRecentProject, ['install'], { registry: registryOrigin });
      expect(await installedVersion(lockedRecentProject)).toBe('1.1.0');

      await rm(join(lockedRecentProject, 'node_modules'), { recursive: true, force: true });
      await runNpm(lockedRecentProject, ['ci'], { registry: registryOrigin });
      expect(await installedVersion(lockedRecentProject)).toBe('1.1.0');
    } finally {
      await close(server);
    }
  }, 60_000);
});

const registryVersion = async (name, version, tarball, registryOrigin, installScript) => {
  const contents = await readFile(tarball);
  return {
    name,
    version,
    ...(installScript ? { scripts: { install: installScript } } : {}),
    dist: {
      shasum: createHash('sha1').update(contents).digest('hex'),
      tarball: `${registryOrigin}/${name}/-/${name}-${version}.tgz`,
    },
  };
};

const installedVersion = async (project) => {
  const manifest = JSON.parse(await readFile(join(project, 'node_modules/fixture-release-age/package.json'), 'utf8'));
  return manifest.version;
};
