// A very small made-up browser document, enough to run the toolbox page and its tools under Node.
// Not a test file itself (the runner only picks up *.test.mjs). Supports what those scripts use:
// elements and text nodes, attributes, classList, events, a few selectors (#id, tag, .class, [attr], [attr="v"]),
// and <script src> in <head>, which "loads" by running the file the caller maps the URL to.

const SELECTOR = /^([a-z0-9]*)(?:#([\w-]+))?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i;

export class Node {}

class Text extends Node {
  nodeType = 3;
  constructor(data) { super(); this.data = data; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

class Element extends Node {
  nodeType = 1;
  constructor(tag, doc) {
    super();
    this.tagName = tag.toUpperCase(); this.ownerDocument = doc;
    this.attrs = {}; this.childNodes = []; this.parentNode = null; this.listeners = {};
    this.style = {}; this.dataset = {}; this.hidden = false; this._v = undefined; this.checked = false; this.disabled = false;
    this.classList = {
      add: (...c) => { this.className = [...new Set(this.className.split(/\s+/).filter(Boolean).concat(c))].join(" "); },
      remove: (...c) => { this.className = this.className.split(/\s+/).filter(x => x && !c.includes(x)).join(" "); },
      contains: c => this.className.split(/\s+/).includes(c),
      toggle: (c, on) => { const has = this.classList.contains(c); if (on === undefined ? !has : on) this.classList.add(c); else this.classList.remove(c); return !has; },
    };
  }
  get value() {
    if (this._v !== undefined || this.tagName !== "SELECT") return this._v === undefined ? "" : this._v;
    const opts = this.querySelectorAll("option");   // like a browser: the option marked selected, else the first
    return (opts.find(o => o.selected) || opts[0] || { value: "" }).value;
  }
  set value(v) { this._v = String(v); }
  get type() { return this.attrs.type || (this.tagName === "INPUT" ? "text" : ""); }
  set type(v) { this.attrs.type = String(v); }
  get className() { return this.attrs.class || ""; }
  set className(v) { this.attrs.class = String(v); }
  get textContent() { return this.childNodes.map(k => k.textContent).join(""); }
  set textContent(v) { this.replaceChildren(String(v)); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return k in this.attrs; }
  _adopt(k) { const node = typeof k === "string" ? new Text(k) : k; if (node.parentNode) node.parentNode._drop(node); node.parentNode = this; return node; }
  _drop(node) { this.childNodes = this.childNodes.filter(x => x !== node); node.parentNode = null; }
  append(...kids) {
    kids.forEach(k => { this.childNodes.push(this._adopt(k)); });
    if (this.tagName === "HEAD") kids.forEach(k => { if (k.tagName === "SCRIPT") this.ownerDocument._load(k); });
  }
  appendChild(k) { this.append(k); return k; }
  replaceChildren(...kids) { this.childNodes.forEach(k => { k.parentNode = null; }); this.childNodes = []; this.append(...kids); }
  remove() { if (this.parentNode) this.parentNode._drop(this); }
  addEventListener(type, f) { (this.listeners[type] ||= []).push(f); }
  fire(type, extra = {}) { const e = { type, target: this, currentTarget: this, preventDefault() {}, ...extra }; (this.listeners[type] || []).forEach(f => f.call(this, e)); return e; }
  click() { if (!this.disabled) this.fire("click"); }
  focus() { this.ownerDocument.activeElement = this; }
  select() {} scrollIntoView() {}
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
  contains(e) { for (; e; e = e.parentNode) if (e === this) return true; return false; }
  closest(sel) { for (let e = this; e; e = e.parentNode) if (e.matches && e.matches(sel)) return e; return null; }
  matches(sel) {
    if (sel === "*") return true;
    let bad = false;
    const m = SELECTOR.exec(sel.trim());
    if (!m) throw new Error("fake DOM: selector not supported: " + sel);
    if (m[1] && this.tagName !== m[1].toUpperCase()) return false;
    if (m[2] && this.attrs.id !== m[2]) return false;
    if (m[3] && !m[3].split(".").filter(Boolean).every(c => this.classList.contains(c))) return false;
    const rest = (m[4] || "").replace(/\[([\w-]+)(?:=(?:"([^"]*)"|([^\]"]*)))?\]/g, (all, k, q, bare) => {
      const want = q !== undefined ? q : bare;
      if (!(k in this.attrs) || (want !== undefined && this.attrs[k] !== want)) bad = true;
      return "";
    });
    if (rest) throw new Error("fake DOM: selector not supported: " + sel);
    return !bad;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = e => e.childNodes.forEach(k => { if (k.nodeType === 1) { if (k.matches(sel)) out.push(k); walk(k); } });
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

/** options.run(url) is called for each <script src> put into <head>; the script counts as loaded after it returns. */
export function makeDocument({ run } = {}) {
  const doc = {
    title: "", activeElement: null, listeners: {},
    createElement: tag => new Element(tag, doc),
    createTextNode: s => new Text(s),
    addEventListener(type, f) { (this.listeners[type] ||= []).push(f); },
    getElementById: id => doc.documentElement.querySelector("#" + id),
    querySelector: sel => doc.documentElement.querySelector(sel),
    querySelectorAll: sel => doc.documentElement.querySelectorAll(sel),
    _load(script) { queueMicrotask(() => { try { run && run(script.getAttribute("src")); script.onload && script.onload(); } catch (e) { if (script.onerror) script.onerror(e); else throw e; } }); },
  };
  doc.documentElement = new Element("html", doc);
  doc.head = new Element("head", doc);
  doc.body = new Element("body", doc);
  doc.documentElement.append(doc.head, doc.body);
  return doc;
}

/** A page with the pieces the toolbox script looks for. */
export function toolboxShell(doc) {
  const el = (tag, id, attrs = {}) => { const e = doc.createElement(tag); if (id) e.setAttribute("id", id); Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v)); return e; };
  const home = el("section", "home"), view = el("section", "view"), vt = el("h2", "vt"), vb = el("div", "vb"), lang = el("select", "lang");
  view.hidden = true; lang.hidden = true;
  view.append(vt, vb);
  doc.body.append(lang, home, view);
  return { home, view, vt, vb, lang };
}

/** Text of an element's own tree, for assertions. */
export const textOf = e => e.textContent;
/** Finds a button, label or other element by its exact text. */
export const byText = (root, text, sel = "*") => root.querySelectorAll(sel).find(e => e.childNodes.length === 1 && e.childNodes[0].nodeType === 3 && e.childNodes[0].data === text) || null;
