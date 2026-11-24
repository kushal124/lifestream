// @ts-check
/** @import { AddressInfo } from 'node:net' */
/** @import { Server } from 'node:http' */
/** @import { Door } from './lib/door.mjs' */
/** @import { StaticFile } from './lib/static.mjs' */
import { readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, relative } from 'node:path';
import { doorSettings, openDoor } from './lib/door.mjs';
import { facesReader } from './lib/faces.mjs';
import { lifeReader } from './lib/life.mjs';
import { CONTRACT } from './lib/pages.mjs';
import { atlasReader } from './lib/atlas.mjs';
import { setHomeAddress } from './lib/http.mjs';
import { isLoopback, principalGate } from './lib/principals.mjs';
import { staticFiles } from './lib/static.mjs';
import { router } from './lib/routes/router.mjs';
import { connectorRoutes } from './lib/routes/connectors.mjs';
import { feedRoutes } from './lib/routes/feed.mjs';
import { lifeRoutes } from './lib/routes/life.mjs';
import { facesRoutes } from './lib/routes/faces.mjs';
import { ownerRoutes } from './lib/routes/owner.mjs';
import { searchRoutes } from './lib/routes/search.mjs';
import { askRoutes } from './lib/routes/ask.mjs';
import { privacyRoutes } from './lib/routes/privacy.mjs';
import { agentRoutes } from './lib/routes/agents.mjs';
import { feedbackRoutes } from './lib/routes/feedback.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const state = resolve(process.env.VIEWER_STATE_DIR || resolve(here, '.local'));

const AGENT_FIXTURES = ['agents/door', 'agents-host'].map(folder => [folder, resolve(here, '../homelink/Tests/Fixtures', folder)]);
const ATLAS = atlasReader(resolve(here, '../packages/families/shared/geography/world.json'));
const PUBLIC = resolve(here, 'public');
const MARKED = resolve(here, 'node_modules/marked/lib/marked.esm.js');
const PURIFY = resolve(here, 'node_modules/dompurify/dist/purify.es.mjs');
const RAW_STATIC = staticFiles(PUBLIC, {
  '/marked.js': MARKED,
  '/purify.js': PURIFY,
  '/cockpit.css': resolve(here, '../design/css/cockpit.css'),
  '/kit.css': resolve(here, '../design/css/kit.css'),
  '/icons.json': resolve(here, '../design/icons.json'),
  '/pages.json': fileURLToPath(CONTRACT),
  '/geist.woff2': resolve(here, '../design/river/geist.woff2'),
  '/homelink/Tests/Fixtures/report.json': resolve(here, '../homelink/Tests/Fixtures/report.json'),
  '/homelink/Tests/Fixtures/proof-report.json': resolve(here, '../homelink/Tests/Fixtures/proof-report.json'),
  '/homelink/Tests/Fixtures/made.json': resolve(here, '../homelink/Tests/Fixtures/made.json'),
  '/homelink/Tests/Fixtures/models.json': resolve(here, '../homelink/Tests/Fixtures/models.json'),
  '/homelink/Tests/Fixtures/privacy.json': resolve(here, '../homelink/Tests/Fixtures/privacy.json'),
  ...Object.fromEntries(AGENT_FIXTURES.flatMap(([folder, path]) => readdirSync(path).filter(name => name.endsWith('.json'))
    .map(name => [`/homelink/Tests/Fixtures/${folder}/${name}`, resolve(path, name)]))),
});

/** @typedef {{ entries: Map<string, StaticFile>, shims: Map<string, StaticFile> }} Bundles */
/** @type {Promise<Bundles | null> | null} */
let bundlesPromise = null;

/**
 * @param {Record<string, { imports: { path: string }[] }>} inputs
 * @returns {Set<string>}
 */
function cyclicPaths(inputs) {
  /** @type {Map<string, number>} */
  const color = new Map();
  /** @type {Set<string>} */
  const cyclic = new Set();
  /** @type {string[]} */
  const stack = [];
  /** @param {string} node */
  const visit = node => {
    color.set(node, 1);
    stack.push(node);
    for (const edge of inputs[node]?.imports ?? []) {
      const target = edge.path;
      const state = color.get(target);
      if (state === 1) {
        for (let i = stack.indexOf(target); i < stack.length; i += 1) cyclic.add(resolve(stack[i]));
      } else if (!state && inputs[target]) {
        visit(target);
      }
    }
    stack.pop();
    color.set(node, 2);
  };
  for (const node of Object.keys(inputs)) if (!color.has(node)) visit(node);
  return cyclic;
}

/**
 * @param {string} pathname
 * @param {string[]} names
 * @returns {StaticFile}
 */
function shimFor(pathname, names) {
  const named = names.filter(name => name !== 'default');
  const lines = [
    `const _m = globalThis.__lsModules?.[${JSON.stringify(pathname)}] ?? await import(${JSON.stringify(`${pathname}?raw`)});`,
    ...named.map(name => `export const ${name} = _m[${JSON.stringify(name)}];`),
    ...(names.includes('default') ? ['export default _m.default;'] : []),
  ];
  return { body: Buffer.from(`${lines.join('\n')}\n`), type: 'text/javascript' };
}

/** @returns {Promise<Bundles | null>} */
function bundledScripts() {
  bundlesPromise ??= import('esbuild').then(async esbuild => {
    /** @type {import('esbuild').Plugin} */
    const namedPlugin = {
      name: 'dashboard-named',
      setup(build) {
        build.onResolve({ filter: /^\.\.\/(marked|purify)\.js$/ }, args => ({
          path: args.path.endsWith('marked.js') ? MARKED : PURIFY,
        }));
      },
    };
    const entryNames = ['/main.js', '/kit-gallery.js'];
    const entryFiles = new Set(entryNames.map(name => resolve(PUBLIC, name.slice(1))));
    const graphs = await Promise.all(entryNames.map(name => esbuild.build({
      entryPoints: [resolve(PUBLIC, name.slice(1))],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      metafile: true,
      plugins: [namedPlugin],
    })));
    /** @type {Set<string>} */
    const cyclic = new Set();
    /** @type {Map<string, string[]>} */
    const byEntry = new Map();
    /** @type {Set<string>} */
    const allShimmed = new Set();
    for (let index = 0; index < entryNames.length; index += 1) {
      for (const file of cyclicPaths(graphs[index].metafile.inputs)) cyclic.add(file);
    }
    for (let index = 0; index < entryNames.length; index += 1) {
      const files = Object.keys(graphs[index].metafile.inputs)
        .map(file => resolve(file))
        .filter(file => file.startsWith(`${PUBLIC}/`) && !entryFiles.has(file) && file.endsWith('.js') && !cyclic.has(file))
        .sort();
      byEntry.set(entryNames[index], files);
      for (const file of files) allShimmed.add(file);
    }
    const inspected = await esbuild.build({
      entryPoints: [...allShimmed].sort(),
      bundle: true,
      splitting: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      metafile: true,
      outdir: 'out',
      outbase: PUBLIC,
      plugins: [namedPlugin],
    });
    /** @type {Map<string, StaticFile>} */
    const shims = new Map();
    for (const output of Object.values(inspected.metafile.outputs)) {
      if (!output.entryPoint) continue;
      const web = `/${relative(PUBLIC, resolve(output.entryPoint)).replaceAll('\\', '/')}`;
      shims.set(web, shimFor(web, output.exports));
    }
    /** @type {Map<string, StaticFile>} */
    const entries = new Map();
    await Promise.all(entryNames.map(async name => {
      const files = byEntry.get(name) ?? [];
      const rels = files.map(file => `./${relative(PUBLIC, file).replaceAll('\\', '/')}`);
      const contents = [
        `import ${JSON.stringify(`.${name}`)};`,
        ...rels.map((rel, index) => `import * as _m${index} from ${JSON.stringify(rel)};`),
        `globalThis.__lsModules = { ...globalThis.__lsModules, ${rels.map((rel, index) => `${JSON.stringify(rel.slice(1))}: _m${index}`).join(', ')} };`,
      ].join('\n');
      const built = await esbuild.build({
        stdin: { contents, resolveDir: PUBLIC, loader: 'js' },
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'browser',
        minifyWhitespace: true,
        plugins: [namedPlugin],
      });
      entries.set(name, { body: Buffer.from(built.outputFiles[0].contents), type: 'text/javascript' });
    }));
    return { entries, shims };
  }).catch(() => null);
  return bundlesPromise;
}

/**
 * @param {string} pathname
 * @param {string} [search]
 */
const STATIC_FILES = async (pathname, search = '') => {
  if (!search && pathname.endsWith('.js')) {
    const bundles = await bundledScripts();
    if (bundles) {
      const hit = bundles.entries.get(pathname) ?? bundles.shims.get(pathname);
      if (hit) return hit;
    }
  }
  return RAW_STATIC(pathname);
};

/**
 * @typedef {object} ViewerOptions
 * @property {Door | null} [door]
 * @property {string | null} [bind]
 */

/** @param {ViewerOptions} [options] */
export async function createViewer({ door = null, bind = null } = {}) {
  const life = lifeReader(door);
  const faces = facesReader(door, life);
  const handle = router({
    port: () => /** @type {AddressInfo} */ (server.address()).port,
    routes: [...connectorRoutes(door), ...feedRoutes(door),
      ...lifeRoutes(life, ATLAS), ...facesRoutes(faces),
      ...ownerRoutes(door, life, faces), ...searchRoutes(door), ...askRoutes(door), ...privacyRoutes(door), ...agentRoutes(door),
      ...feedbackRoutes(door)],
    files: STATIC_FILES,
  });
  const noDoor = async () => {
    throw new Error('no door');
  };
  const gate = bind && !isLoopback(bind) ? principalGate({ allows: door ? door.allows : noDoor }) : null;
  /** @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} */
  const answer = gate
    ? async (req, res) => {
      try {
        if (await gate(req, res)) return;
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Could not check who is asking.' }));
        return;
      }
      await handle(req, res);
    }
    : handle;
  /** @type {Server} */
  const server = createServer(answer);
  server.on('close', () => door?.close());
  if (bind && !isLoopback(bind)) {
    setHomeAddress(bind);
    const beside = createServer(answer);
    beside.on('error', error => console.error(`Lifestream dashboard: ${bind} is not served: ${error.message}`));
    server.on('listening', () => beside.listen(/** @type {AddressInfo} */ (server.address()).port, bind));
    server.on('close', () => beside.close());
  }
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const settings = doorSettings(state);
  const bind = process.env.VIEWER_BIND || null;
  const server = await createViewer({ door: openDoor(settings), bind });
  if (process.env.VIEWER_ENDS_WITH_STDIN === '1') {
    process.stdin.on('end', () => process.exit(0));
    process.stdin.resume();
  }
  server.listen(Number(process.env.PORT || 4317), '127.0.0.1', () => {
    const port = /** @type {AddressInfo} */ (server.address()).port;
    console.log(`Lifestream dashboard: http://127.0.0.1:${port}`);
    if (bind) console.log(`Lifestream dashboard: http://${bind}:${port} for a reader with a token`);
    if (settings.token() === null) console.log('Lifestream dashboard: no read token for the door yet; Ask, Days, People, Places and Connectors say so until one is there');
  });
}
