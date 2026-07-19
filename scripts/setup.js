/* eslint-disable no-console */
/**
 * First-time setup script for 0dteTrader.
 *
 * Run: npm run setup
 *
 * This script is idempotent: it is safe to run it multiple times. It will not
 * overwrite an existing .env file or regenerate a CRED_ENCRYPTION_KEY that is
 * already set.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const ENV_PATH = resolve(ROOT, '.env');
const ENV_EXAMPLE_PATH = resolve(ROOT, '.env.example');

const MIN_NODE_MAJOR = 18;
const MIN_NODE_MINOR = 17;

function fail(message) {
  console.error(`\n❌ ${message}`);
  process.exit(1);
}

function info(message) {
  console.log(`\n▶ ${message}`);
}

function ok(message) {
  console.log(`✅ ${message}`);
}

function run(command, options = {}) {
  console.log(`   $ ${command}`);
  return execSync(command, {
    cwd: ROOT,
    stdio: 'inherit',
    encoding: 'utf8',
    ...options,
  });
}

function checkNode() {
  const version = process.versions.node;
  const [major, minor] = version.split('.').map(Number);
  if (major < MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor < MIN_NODE_MINOR)) {
    fail(`Node.js ${version} is installed, but >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} is required.`);
  }
  ok(`Node.js ${version}`);
}

function checkDocker() {
  try {
    execSync('docker info', { stdio: 'pipe' });
  } catch {
    fail('Docker is not running or not installed. Start Docker Desktop first.');
  }
  ok('Docker is running');
}

function ensureEnv() {
  if (existsSync(ENV_PATH)) {
    ok('.env already exists');
  } else {
    info('Creating .env from .env.example');
    writeFileSync(ENV_PATH, readFileSync(ENV_EXAMPLE_PATH, 'utf8'));
    ok('.env created');
  }

  const env = readFileSync(ENV_PATH, 'utf8');
  const placeholderPattern = /^CRED_ENCRYPTION_KEY=\s*(change-me-base64-32-byte-key)?\s*$/m;

  if (placeholderPattern.test(env)) {
    info('Generating a 32-byte CRED_ENCRYPTION_KEY');
    const key = randomBytes(32).toString('base64');
    const updated = env.replace(
      /^CRED_ENCRYPTION_KEY=.*$/m,
      `CRED_ENCRYPTION_KEY=${key}`,
    );
    writeFileSync(ENV_PATH, updated);
    ok('CRED_ENCRYPTION_KEY generated and written to .env');
  } else if (/^CRED_ENCRYPTION_KEY=\s*.+/m.test(env)) {
    ok('CRED_ENCRYPTION_KEY is already set');
  } else {
    fail('CRED_ENCRYPTION_KEY line is missing from .env');
  }
}

async function waitForPostgres() {
  info('Waiting for Postgres to be ready...');
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      execSync(
        'docker compose exec -T postgres pg_isready -U odtetrader',
        { stdio: 'pipe', cwd: ROOT },
      );
      ok('Postgres is ready');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  fail('Postgres did not become ready within 60 seconds. Run `npm run db:up` and check `docker compose ps`.');
}

async function main() {
  console.log('🚀 0dteTrader setup\n');

  checkNode();
  checkDocker();
  ensureEnv();

  info('Installing dependencies');
  run('npm install');

  info('Starting Postgres and Redis');
  run('npm run db:up');

  await waitForPostgres();

  info('Applying database migrations');
  run('npm run db:migrate');

  console.log('\n─────────────────────────────────────────');
  console.log('✅ Setup complete.');
  console.log('');
  console.log('Next steps:');
  console.log('  1. npm run dev              # start the API');
  console.log('  2. Register a dev account:');
  console.log('     curl -X POST http://localhost:3000/v1/auth/register \\');
  console.log('       -H "content-type: application/json" \\');
  console.log('       -d \'{"email":"dev@example.com","password":"password123"}\'');
  console.log('  3. For iOS: cd apps/ios && xcodegen && open 0dteTrader.xcodeproj');
  console.log('  4. For desktop: npm run dev:desktop');
  console.log('');
  console.log('See docs/RUNBOOK.md for Webull credentials and troubleshooting.');
  console.log('─────────────────────────────────────────\n');
}

main().catch((err) => fail(err.message));
