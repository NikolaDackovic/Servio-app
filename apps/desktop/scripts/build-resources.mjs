// Priprema sadržaja instalacije (apps/desktop/resources):
//   server/server.js   - API spojen u jedan fajl (posle tsc, da ostanu metapodaci dekoratora za NestJS)
//   server/migrations  - SQL migracije baze
//   web/               - KASA i KDS (isti build; KDS na /kds)
//   admin/             - ADMIN, služi se pod /admin/
//   pgsql/             - PostgreSQL za Windows (lokalna baza kase)
//   bridge/bridge.js   - Print Bridge (štampa na štampače priključene na ovaj računar)
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const out = path.resolve(here, '../resources');
const run = (cmd, env = {}) => execSync(cmd, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, 'server'), { recursive: true });

console.log('1/4 API (tsc)…');
run('npm run build -w apps/api');

console.log('2/4 API u jedan fajl (esbuild)…');
await build({
  entryPoints: [path.join(root, 'apps/api/dist/standalone.js')],
  outfile: path.join(out, 'server/server.js'),
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', keepNames: true, sourcemap: false, logLevel: 'warning',
  // Opcioni paketi koje NestJS / pg / ws učitavaju samo ako postoje
  external: [
    'pg-native', 'bufferutil', 'utf-8-validate', '@nestjs/microservices', '@nestjs/microservices/*', '@nestjs/websockets/*',
    '@nestjs/platform-socket.io', '@fastify/static', '@fastify/view', 'cache-manager', 'ioredis',
    'class-transformer/storage', // rezervni put u @nestjs/mapped-types; pravi (cjs/storage) je u paketu
  ],
});
cpSync(path.join(root, 'apps/api/migrations'), path.join(out, 'server/migrations'), { recursive: true });

console.log('3/4 KASA i KDS (vite)…');
run('npm run build -w apps/web');
cpSync(path.join(root, 'apps/web/dist'), path.join(out, 'web'), { recursive: true });

console.log('4/4 ADMIN (vite, /admin/)…');
run('npm run build -w apps/admin', { ADMIN_BASE: '/admin/' });
cpSync(path.join(root, 'apps/admin/dist'), path.join(out, 'admin'), { recursive: true });

console.log('Print Bridge (štampa) u jedan fajl…');
await build({
  entryPoints: [path.join(root, 'apps/print-bridge/src/main.ts')],
  outfile: path.join(out, 'bridge/bridge.js'),
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', sourcemap: false, logLevel: 'warning',
});

console.log('Servio logo i ikonice…');
cpSync(path.join(root, 'branding'), path.join(out, 'branding'), { recursive: true });

console.log('PostgreSQL (initdb, pg_ctl, postgres)…');
cpSync(path.join(root, 'node_modules/@embedded-postgres/windows-x64/native'), path.join(out, 'pgsql'), { recursive: true });

if (!existsSync(path.join(out, 'server/server.js'))) throw new Error('server.js nije napravljen');
if (!existsSync(path.join(out, 'pgsql/bin/pg_ctl.exe'))) throw new Error('PostgreSQL binarni fajlovi nisu kopirani');
console.log(`Gotovo: ${out}`);
