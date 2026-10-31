// Builds dist-unrestricted/: the @haseebeqx/pi-safari-unrestricted package, generated from this repo's source at release time
// so both packages always ship identical code and the same version. Usage:
//   node --experimental-strip-types scripts/stage-unrestricted.ts [outDir]   (default: dist-unrestricted)
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = resolve(process.argv[2] ?? join(root, 'dist-unrestricted'));
const UNRESTRICTED_PACKAGE_NAME = '@haseebeqx/pi-safari-unrestricted';

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const safeName: string = pkg.name;

rmSync(out, { recursive: true, force: true });
cpSync(join(root, 'src'), join(out, 'src'), { recursive: true });
cpSync(join(root, 'LICENSE'), join(out, 'LICENSE'));

const unrestrictedPkg = {
  ...pkg,
  name: UNRESTRICTED_PACKAGE_NAME,
  description: `${pkg.description} (unrestricted variant: restricted actions and JavaScript evaluation pre-approved)`,
  keywords: [...(pkg.keywords ?? []), 'unrestricted'],
  files: ['src', 'README.md', 'LICENSE'],
  pi: { ...pkg.pi, extensions: ['./src/index-unrestricted.ts'] },
};
// The staged package is a build output: no dev tooling, and no prepublishOnly (checks already ran on the repo).
delete unrestrictedPkg.scripts;
delete unrestrictedPkg.devDependencies;
writeFileSync(join(out, 'package.json'), `${JSON.stringify(unrestrictedPkg, null, 2)}\n`);

const banner = `> [!WARNING]
> **This is \`${UNRESTRICTED_PACKAGE_NAME}\`, the unrestricted variant of [\`${safeName}\`](https://www.npmjs.com/package/${safeName}).**
> Every Pi session starts with **restricted actions** (click, type, keyPress, hover, navigate, activate, upload) **and JavaScript evaluation already granted**, as if you had run \`/safari-permissions allow\` and \`/safari-evaluate allow\`, **in every Pi mode, including print, JSON and RPC**. The task classifier is skipped, so the agent — or instructions injected by a web page — can click, submit, upload local files and run arbitrary JavaScript in pages without a per-task check.
> Safari settings, URL/target validation and tool limits still apply. \`/safari-permissions revoke\` and \`/safari-evaluate revoke\` clear the grants until the next session.
> Install only one of the two packages: \`pi remove npm:${safeName}\` before \`pi install npm:${UNRESTRICTED_PACKAGE_NAME}\`.
> Wherever the text below says a permission must be granted with a command, this package grants it automatically.

`;
// The README already documents both packages side by side; the banner marks which one this is.
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const firstSection = readme.indexOf('\n## ');
writeFileSync(join(out, 'README.md'), firstSection === -1 ? banner + readme : `${readme.slice(0, firstSection + 1)}${banner}${readme.slice(firstSection + 1)}`);

console.log(`Staged ${UNRESTRICTED_PACKAGE_NAME}@${pkg.version} in ${out}`);
