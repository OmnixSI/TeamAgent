// A language change redraws the open task panel (also when another tab causes it). What the reader typed into its forms
// must come back: the new-task form, the edit form, the "attach material" form with its mode, the prerequisites, the progress note.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { DRAFT } from "../src/i18n.ts";
import { APP_JS } from "../src/feat/board-page.ts";
import { makeDocument } from "./fake-dom.mjs";

/** DRAFT running against a made-up document. */
function draft() {
  const document = makeDocument();
  const ctx = { document, Object, setTimeout: f => f() };   // the delayed refocus runs at once
  vm.createContext(ctx);
  vm.runInContext(DRAFT + "\nthis.DRAFT = DRAFT;", ctx);
  const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v)); e.append(...kids); return e; };
  return { DRAFT: ctx.DRAFT, document, el };
}

/** A panel the way the board draws one: always-present forms, and forms a button opens. */
function panel(t, { edit = false, mat = false, mode = "link", gone = [] } = {}) {
  const { el } = t;
  const field = (tag, f, attrs = {}) => el(tag, { "data-f": f, ...attrs });
  const body = el("div", { id: "dw-body" });
  const note = el("form", { "data-draft": "note" }, field("textarea", "text"));
  const forms = { note };
  if (edit) forms.edit = el("form", { "data-draft": "edit" }, field("input", "title"), field("textarea", "detail"), field("select", "size"), ...["after-7", "after-9"].filter(k => !gone.includes(k)).map(k => field("input", k, { type: "checkbox" })));
  if (mat) {
    forms.mat = el("form", { "data-draft": "mat", "data-mode": mode }, field("input", "title"), field("input", mode === "link" ? "ref" : "text"));
    forms.mat.__mode = m => { forms.mat.setAttribute("data-mode", m); forms.mat.childNodes[1].setAttribute("data-f", m === "link" ? "ref" : "text"); };
  }
  body.append(el("h3"), ...Object.values(forms));
  const open = {
    edit: () => { body.append(forms.edit = panel(t, { edit: true }).forms.edit); },
    mat: () => { body.append(forms.mat = panel(t, { mat: true }).forms.mat); },
  };
  return { body, forms, open };
}

describe("DRAFT", () => {
  test("takes nothing from a panel without forms", () => {
    const t = draft();
    assert.equal(t.DRAFT.take(t.el("div", {}, t.el("h3"))), null);
    t.DRAFT.put(t.el("div"), null, {});   // and putting nothing back is fine
  });

  test("the progress note comes back in a panel drawn again", () => {
    const t = draft();
    const old = panel(t);
    old.forms.note.querySelector("[data-f=text]").value = "进展：已经联系供应商";
    const taken = t.DRAFT.take(old.body);
    const fresh = panel(t);
    assert.equal(fresh.forms.note.querySelector("[data-f=text]").value, "");
    t.DRAFT.put(fresh.body, taken, fresh.open);
    assert.equal(fresh.forms.note.querySelector("[data-f=text]").value, "进展：已经联系供应商");
  });

  test("a form that starts closed is opened again and filled, with its mode, checkboxes and select", () => {
    const t = draft();
    const old = panel(t, { edit: true, mat: true, mode: "report" });
    const f = old.forms;
    f.edit.querySelector("[data-f=title]").value = "改过的标题";
    f.edit.querySelector("[data-f=detail]").value = "第一行\n第二行";
    f.edit.querySelector("[data-f=size]").value = "big";
    f.edit.querySelector("[data-f=after-7]").checked = true;
    f.edit.querySelector("[data-f=after-9]").checked = false;
    f.mat.querySelector("[data-f=title]").value = "进度";
    f.mat.querySelector("[data-f=text]").value = "报告全文";
    f.note.querySelector("[data-f=text]").value = "写了一半";
    const taken = t.DRAFT.take(old.body);
    assert.deepEqual(Object.keys(taken.forms).sort(), ["edit", "mat", "note"]);

    const fresh = panel(t);   // the new panel has only the note form; the edit and attach forms start closed
    assert.deepEqual(Object.keys(fresh.forms), ["note"]);
    t.DRAFT.put(fresh.body, taken, fresh.open);

    assert.deepEqual(Object.keys(fresh.forms).sort(), ["edit", "mat", "note"], "closed forms were opened");
    const g = (name, k) => fresh.forms[name].querySelector(`[data-f=${k}]`);
    assert.equal(g("edit", "title").value, "改过的标题");
    assert.equal(g("edit", "detail").value, "第一行\n第二行");
    assert.equal(g("edit", "size").value, "big");
    assert.equal(g("edit", "after-7").checked, true);
    assert.equal(g("edit", "after-9").checked, false);
    assert.equal(fresh.forms.mat.getAttribute("data-mode"), "report", "the attach form is back in report mode");
    assert.equal(g("mat", "text").value, "报告全文");
    assert.equal(g("mat", "title").value, "进度");
    assert.equal(g("note", "text").value, "写了一半");
  });

  test("a prerequisite task that is no longer listed is skipped, and the rest still comes back", () => {
    const t = draft();
    const old = panel(t, { edit: true });
    old.forms.edit.querySelector("[data-f=after-7]").checked = true;
    old.forms.edit.querySelector("[data-f=title]").value = "x";
    const taken = t.DRAFT.take(old.body);
    const fresh = panel(t, { edit: true, gone: ["after-7"] });
    t.DRAFT.put(fresh.body, taken, fresh.open);
    assert.equal(fresh.forms.edit.querySelector("[data-f=title]").value, "x");
    assert.equal(fresh.forms.edit.querySelector("[data-f=after-7]"), null);
  });

  test("the cursor goes back to the field and the selection it had, and the scroll position too", () => {
    const t = draft();
    const old = panel(t, { edit: true });
    const detail = old.forms.edit.querySelector("[data-f=detail]");
    detail.value = "预算 5000，下周三前到货";
    old.body.scrollTop = 240;
    detail.focus(); detail.setSelectionRange(3, 7);
    const taken = t.DRAFT.take(old.body);
    assert.deepEqual({ ...taken.focus }, { form: "edit", field: "detail", s: 3, e: 7 });

    const fresh = panel(t, { edit: true });
    t.DRAFT.put(fresh.body, taken, fresh.open);
    const again = fresh.forms.edit.querySelector("[data-f=detail]");
    assert.equal(t.document.activeElement, again);
    assert.deepEqual([again.selectionStart, again.selectionEnd], [3, 7]);
    assert.equal(fresh.body.scrollTop, 240);
  });
});

describe("the board page uses it", () => {
  /** The code of one function, up to where the next piece of the page script begins. */
  const body = (name, next) => { const i = APP_JS.indexOf("function " + name + "("), j = APP_JS.indexOf(next, i); assert.ok(i >= 0 && j > i, name); return APP_JS.slice(i, j); };

  test("every form that takes input is marked, and the forms that start closed have an opener", () => {
    const marks = [...APP_JS.matchAll(/"data-draft":([^,}]*)/g)].map(m => m[1]);
    assert.deepEqual(marks.sort(), ['"after"', '"mat"', '"note"', '"shop"', 't&&t.id?"edit":"new"']);
    const panel = body("taskPanel", "var MEM=");
    assert.match(panel, /^function taskPanel\(j\)\{\nDW\.open=\{\};/);
    for (const name of ["edit", "mat", "after"]) assert.match(panel, new RegExp(`DW\\.open\\.${name}=function\\(\\)\\{\\w+\\.click\\(\\);\\};`), name + " has an opener");
    assert.match(body("addMaterial", "function taskPanel("), /box\.__mode=/, "the attach form can be put back in its mode");
  });

  test("a language change takes the typed text before the section reloads and hands it to the panel it opens", () => {
    const r = body("relang", "function helpPop(");
    assert.ok(r.indexOf("drawerKeep()") >= 0 && r.indexOf("drawerKeep()") < r.indexOf("load(cur,true)"), "taken before the reload");
    assert.match(r, /if\(route===r&&VIEWS\[cur\]\.arg\)\{DW\.draft=kept;VIEWS\[cur\]\.arg\(r\.arg\);\}/, "only handed on when the same panel is opened again");
  });

  test("each panel puts the text back once it is drawn, and closing the panel forgets it", () => {
    assert.match(body("newTask", "function openTask("), /drawerRestore\(\);\n\}\s*$/);
    assert.match(body("taskPanel", "var MEM="), /drawerRestore\(\);\n\}\s*$/);
    assert.match(body("shopArg", "function redemptionsView("), /drawerRestore\(\);\n\}\s*$/);
    assert.match(body("drawerClose", "function leaveDrawer("), /DW\.draft=null/);
    assert.match(body("drawerRestore", "function drawerClose("), /k\.key===DW\.key&&Date\.now\(\)<k\.until/, "only for the same panel and not for long");
  });
});
