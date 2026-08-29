// Minimal DOM shim + module loader, so the content scripts can be exercised in Node.
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

class El {
	constructor(tag) {
		this.tag = tag;
		this.children = [];
		this._text = null;
		this.style = { setProperty(k, v) { this[k] = v; } };
		this.attrs = {};
		this.classList = {
			_s: new Set(),
			add: (...c) => c.forEach((x) => this.classList._s.add(x)),
			remove: (...c) => c.forEach((x) => this.classList._s.delete(x)),
			toggle: (c, f) => (f ? this.classList._s.add(c) : this.classList._s.delete(c)),
			contains: (c) => this.classList._s.has(c)
		};
	}
	get textContent() {
		return this._text !== null ? this._text : this.children.map((c) => c.textContent).join('');
	}
	set textContent(v) { this._text = String(v); this.children = []; }
	set innerHTML(v) { this._html = v; }
	// A real element's classList reflects its className; without this the shim
	// silently reports classes as absent that the browser would have.
	set className(v) {
		this._className = String(v);
		this.classList._s = new Set(this._className.split(/\s+/).filter(Boolean));
	}
	get className() { return this._className || ''; }
	appendChild(c) { this._text = null; this.children.push(c); return c; }
	replaceChildren(...c) { this._text = null; this.children = c; }
	setAttribute(k, v) { this.attrs[k] = v; }
	hasAttribute(k) { return k in this.attrs; }
	addEventListener() {}
	getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
}

function makeContext() {
	const document = {
		documentElement: { dataset: { mode: 'dark' } },
		body: new El('body'),
		createElement: (tag) => new El(tag),
		createElementNS: (_ns, tag) => new El(tag),
		createTextNode: (text) => { const n = new El('#text'); n.textContent = text; return n; },
		querySelector: () => null,
		contains: () => true,
		addEventListener() {}
	};
	const ctx = {
		document, console, Date, Math, Object, String, Number, JSON, Array, Set, Map, RegExp,
		setTimeout, clearTimeout, isNaN, parseInt, parseFloat,
		window: { getComputedStyle: () => ({}), innerWidth: 1000, innerHeight: 800, addEventListener() {} },
		MutationObserver: class { observe() {} disconnect() {} }
	};
	ctx.globalThis = ctx;
	return vm.createContext(ctx);
}

/** Load content-script files into a fresh sandbox and return its globals. */
function load(...files) {
	const ctx = makeContext();
	for (const f of files) {
		vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
	}
	return ctx;
}

let pass = 0;
let fail = 0;

function section(name) {
	console.log('\n  ' + name);
}

function t(label, cond, detail) {
	if (cond) {
		pass += 1;
		console.log('    PASS  ' + label);
	} else {
		fail += 1;
		console.log('    FAIL  ' + label);
		if (detail) console.log('          ' + detail);
	}
}

function report(suite) {
	console.log('\n  ' + (fail === 0 ? 'ALL PASS' : fail + ' FAILED') + '  ' + suite + ' (' + pass + '/' + (pass + fail) + ')');
	return fail;
}

module.exports = { load, section, t, report };
