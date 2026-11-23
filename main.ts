// Token Radar, radar-2 — the entry point.
//
// Run it from the repository root and it does one job: read the sealed
// snapshot, score it with the model in lib/model.ts, and lay out /output
// exactly the way the gate expects it — board.json with the ranked rows,
// data.js with the dashboard's dataset, the dashboard/ and screenshots/
// copied in as they stand, and dossier.json written last from the finished
// directory, so the scorer rebuilding it gets the same bytes.
//
// The program is standard-library only and runs on Node 22 as-is. Outside
// the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
//
// Two runs over the same snapshot write the same bytes: the model is a pure
// function of the snapshot, the file order is sorted, and nothing here reads
// the clock, the network or a random source.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const REPO_ROOT = fileURLToPath(new URL('.', import.meta.url));

/** The dossier's text cap, and the screenshot caps the gate enforces. */
const DOSSIER_TEXT_BYTES = 65_536;
const SHOT_LIMITS = { max: 4, max_bytes: 524_288 };
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Die with a message on stderr and a non-zero exit. */
function fail(message: string): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(1);
}

/** The value after `--name <value>` or `--name=<value>`, else `fallback`. */
function flagValue(name: string, fallback: string): string {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === `--${name}` && i + 1 < argv.length) return argv[i + 1]!;
    const prefixed = `--${name}=`;
    if (argv[i]!.startsWith(prefixed)) return argv[i]!.slice(prefixed.length);
  }
  return fallback;
}

/** Resolve the snapshot path: a file, or a directory holding snapshot.json. */
function snapshotPath(): string {
  const given = flagValue('input', '/input');
  const path = given.endsWith('.json') ? given : join(given, 'snapshot.json');
  if (!existsSync(path)) {
    fail(`no snapshot at ${path}: pass --input <snapshot.json|directory> or mount the sealed /input`);
  }
  return path;
}

/**
 * Mirror one directory's regular files into `dest`, skipping dot-names
 * and anything that is not a file, and return the names it copied.
 */
function mirrorFolder(from: string, dest: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(dest, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const src = join(from, name);
    if (!statSync(src).isFile()) continue;
    copyFileSync(src, join(dest, name));
    copied.push(name);
  }
  return copied;
}

function run(): void {
  const snapText = readFileSync(snapshotPath(), 'utf8');
  const snapshot = parseSnapshot(snapText);
  const { board, radar } = buildRadar(snapshot);
  const problem = boardIssue(board, snapshot);
  if (problem !== null) fail(`the model wrote a board the gate refuses: ${problem}`);

  const out = flagValue('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
  writeFileSync(join(out, 'data.js'), dataScript(radar));

  mirrorFolder(join(REPO_ROOT, 'dashboard'), join(out, 'dashboard'));
  const shots = mirrorFolder(join(REPO_ROOT, 'screenshots'), join(out, 'screenshots'));
  if (shots.length < 3) {
    fail(`screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view`);
  }
  for (const name of shots) {
    if (!SHOT_NAME.test(name)) {
      fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`);
    }
  }

  // The dossier goes last: it is built from the finished /output, so the
  // scorer rebuilding it from the same files gets the same bytes.
  const dossier = buildDossier(out, {
    text_max_bytes: DOSSIER_TEXT_BYTES,
    screenshots: SHOT_LIMITS,
    dashboard: { max_files: 400, max_bytes: 4_194_304 },
  });
  writeFileSync(join(out, 'dossier.json'), dossier);

  process.stdout.write(
    `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
      `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (3 files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
  );
}

run();
