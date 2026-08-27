// Runs every *.test.js in this directory; exits non-zero if any suite fails.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const suites = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
let failed = 0;

for (const suite of suites) {
	try {
		process.stdout.write(execFileSync(process.execPath, [path.join(__dirname, suite)], { encoding: 'utf8' }));
	} catch (err) {
		failed += 1;
		process.stdout.write(err.stdout || '');
		process.stderr.write(err.stderr || '');
	}
}

console.log('\n' + (failed === 0 ? `all ${suites.length} suites passed` : `${failed} of ${suites.length} suites failed`));
process.exit(failed ? 1 : 0);
