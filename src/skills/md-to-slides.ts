// Markdown -> editable 16:9 .pptx (python-pptx, already in /opt/py), plus a PDF preview when LibreOffice is there.
// The script also has a --dump mode (slide plan as JSON, no python-pptx needed) that the offline tests use.
import type { Skill } from "./types.ts";
import { sh } from "./types.ts";
import { putFile, markdownSource, safeName, truthy, PY_PICK } from "./md-to-report.ts";

export const MD2PPTX_PY = String.raw`#!/usr/bin/env python3
# Markdown -> editable 16:9 .pptx with python-pptx. "--dump" prints the slide plan as JSON and needs no python-pptx.
#   md2pptx.py IN.md OUT.pptx [--scheme light|dark|brand] [--accent HEX] [--max-lines N] [--title T] [--author A] [--date D]
#              [--font NAME] [--ea-font NAME] [--no-numbers] [--preview-out PATH] [--root DIR] [--dump]
import sys, os, re, json, math, argparse

CJK = re.compile(r'[⺀-鿿豈-﫿＀-￯　-〿]')
BT = chr(96)
NOTES = []


def note(s):
    if s not in NOTES:
        NOTES.append(s)


def wid(s):
    return sum(2 if CJK.match(c) else 1 for c in s)


def strip_md(s):
    s = re.sub(r'!\[[^\]]*\]\([^)]*\)', '', s)
    s = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', s)
    return re.sub(r'(\*\*|__|~~|' + BT + r'|(?<![\w*])\*(?=\S)|(?<=\S)\*(?![\w*]))', '', s).strip()


# ---------------------------------------------------------------- parsing
NOTE_RE = re.compile(r'^\s*>\s*(?:note|notes|speaker|speaker notes|备注|讲稿|演讲备注|旁白)\s*[:：]\s*(.*)$', re.I)
FENCE = re.compile(r'^\s{0,3}(' + BT + r'{3,}|~{3,})\s*([^\s' + BT + r']*)')
SEP = re.compile(r'^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$')
IMG = re.compile(r'^\s*!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)\s*$')


def split_row(line):
    line = line.strip()
    if line.startswith('|'):
        line = line[1:]
    if line.endswith('|') and not line.endswith('\\|'):
        line = line[:-1]
    cells, cur, tick = [], [], False
    i = 0
    while i < len(line):
        c = line[i]
        if c == '\\' and i + 1 < len(line):
            cur.append(line[i:i + 2])
            i += 2
            continue
        if c == BT:
            tick = not tick
        if c == '|' and not tick:
            cells.append(''.join(cur).strip())
            cur = []
        else:
            cur.append(c)
        i += 1
    cells.append(''.join(cur).strip())
    return [c.replace('\\|', '|') for c in cells]


def parse(text):
    text = text.replace('\r\n', '\n').replace('\r', '\n').replace('\t', '    ')
    m = re.match(r'^﻿?---\s*\n(.*?)\n---\s*(\n|$)', text, re.S)
    fm = {}
    if m:
        for ln in m.group(1).split('\n'):
            mm = re.match(r'^([A-Za-z_]+)\s*:\s*(.*)$', ln)
            if mm:
                fm[mm.group(1).lower()] = mm.group(2).strip().strip('"\'')
        text = text[m.end():]
    lines = text.split('\n')
    deck = {'title': fm.get('title', ''), 'subtitle': fm.get('subtitle', ''), 'meta': [x for x in (fm.get('author'), fm.get('date')) if x], 'slides': []}
    cur = None
    state = {'seen_title': bool(deck['title'])}
    last_note = False

    def new(kind, title):
        s = {'type': kind, 'title': title, 'blocks': [], 'notes': [], 'cont': False}
        deck['slides'].append(s)
        return s

    def add_para(slide, kind, lvl, txt, num=None):
        if slide['blocks'] and slide['blocks'][-1]['k'] == 'text':
            slide['blocks'][-1]['paras'].append([kind, lvl, txt, num])
        else:
            slide['blocks'].append({'k': 'text', 'paras': [[kind, lvl, txt, num]]})

    i, n = 0, len(lines)
    while i < n:
        line = lines[i]
        st = line.strip()
        if not st:
            i += 1
            last_note = False
            continue
        m = FENCE.match(line)
        if m:
            fence = m.group(1)
            body = []
            i += 1
            while i < n and not re.match(r'^\s{0,3}' + re.escape(fence[0]) + '{' + str(len(fence)) + r',}\s*$', lines[i]):
                body.append(lines[i])
                i += 1
            i += 1
            if cur is None:
                cur = new('content', '')
            cur['blocks'].append({'k': 'code', 'lang': m.group(2), 'text': '\n'.join(body)})
            continue
        mh = re.match(r'^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$', line)
        if mh:
            lv, t = len(mh.group(1)), mh.group(2)
            last_note = False
            if lv == 1:
                if not state['seen_title']:
                    deck['title'] = strip_md(t)
                    state['seen_title'] = True
                    cur = None
                    state['in_title'] = True
                else:
                    cur = new('section', strip_md(t))
                    state['in_title'] = False
            elif lv == 2:
                state['in_title'] = False
                cur = new('content', t)
            else:
                if cur is None or state.get('in_title'):
                    state['in_title'] = False
                    cur = new('content', t)
                else:
                    add_para(cur, 'h', 0, t)
            i += 1
            continue
        if re.match(r'^\s{0,3}([-*_])(?:\s*\1){2,}\s*$', line):
            if cur is not None and cur['type'] == 'content':
                prev = cur
                cur = new('content', prev['title'])
                cur['cont'] = True
            i += 1
            continue
        mn = NOTE_RE.match(line)
        mc = re.match(r'^\s*<!--\s*(?:note|notes|备注|讲稿)\s*[:：]?\s*(.*?)\s*-->\s*$', line, re.I | re.S)
        if mn or mc:
            txt = (mn or mc).group(1)
            tgt = cur if cur is not None else None
            (tgt['notes'] if tgt else deck.setdefault('notes0', [])).append(txt)
            last_note = True
            i += 1
            continue
        if st.startswith('>'):
            body = re.sub(r'^\s*>\s?', '', line)
            if last_note and cur is not None:
                cur['notes'].append(body)
                i += 1
                continue
            if state.get('in_title') or cur is None:
                i += 1
                continue
            add_para(cur, 'q', 0, body)
            i += 1
            continue
        if re.match(r'^\s*<!--', line):
            while i < n and '-->' not in lines[i]:
                i += 1
            i += 1
            continue
        last_note = False
        if '|' in line and i + 1 < n and SEP.match(lines[i + 1]) and '|' in lines[i + 1]:
            head = split_row(line)
            seps = split_row(lines[i + 1])
            if len(seps) == len(head):
                aligns = ['center' if x.startswith(':') and x.endswith(':') else 'right' if x.endswith(':') else 'left' for x in seps]
                i += 2
                rows = []
                while i < n and lines[i].strip() and '|' in lines[i]:
                    rows.append((split_row(lines[i]) + [''] * len(head))[:len(head)])
                    i += 1
                if cur is None:
                    cur = new('content', '')
                cur['blocks'].append({'k': 'table', 'head': head, 'aligns': aligns, 'rows': rows})
                continue
        mi = IMG.match(line)
        if mi:
            if cur is not None and not state.get('in_title'):
                cur['blocks'].append({'k': 'image', 'alt': mi.group(1), 'src': mi.group(2)})
            i += 1
            continue
        mb = re.match(r'^(\s*)([-*+])\s+(.*)$', line)
        mo = re.match(r'^(\s*)(\d{1,3})[.)]\s+(.*)$', line)
        if state.get('in_title') or cur is None:
            # text between "# Title" and the first "##": subtitle, then meta lines
            t = strip_md(st)
            if mb or mo:
                t = strip_md((mb or mo).group(3))
            if not deck['subtitle']:
                deck['subtitle'] = t
            else:
                deck['meta'].append(t)
            i += 1
            continue
        if mb:
            lvl = 0 if len(mb.group(1)) < 2 else 1
            add_para(cur, 'b', lvl, mb.group(3))
        elif mo:
            lvl = 0 if len(mo.group(1)) < 2 else 1
            add_para(cur, 'n', lvl, mo.group(3), int(mo.group(2)))
        else:
            add_para(cur, 'p', 0, st)
        i += 1
    return deck


# ---------------------------------------------------------------- splitting
def para_cost(p, scale=1.0):
    kind, lvl, text = p[0], p[1], p[2]
    w = wid(strip_md(text))
    if kind == 'h':
        cap, lh, gap = 56, 1.15, 0.25
    elif kind in ('p', 'q'):
        cap, lh, gap = 68, 0.95, 0.3
    elif lvl == 0:
        cap, lh, gap = 64, 1.0, 0.35
    else:
        cap, lh, gap = 72, 0.85, 0.22
    lines = max(1, math.ceil(w / (cap * scale)))
    return lines * lh + gap


def text_cost(paras, scale=1.0):
    return sum(para_cost(p, scale) for p in paras)


ROW = 1.25
CODE_LINE = 0.62


def code_lines(text, cap=96):
    return sum(max(1, math.ceil(wid(l) / cap)) for l in text.split('\n')) if text else 1


def table_row_cost(row):
    ml = max([wid(strip_md(c)) for c in row] + [1])
    return ROW + 0.55 * (math.ceil(ml / 36) - 1) if ml > 36 else ROW


def groups(paras):
    # a heading or a top-level item opens a group; sub-items stay with their parent
    out = []
    for p in paras:
        if p[0] == 'h' or p[1] == 0 or not out:
            out.append([p])
        else:
            out[-1].append(p)
    # a heading stays with the group after it
    merged = []
    k = 0
    while k < len(out):
        g = out[k]
        if g[0][0] == 'h' and len(g) == 1 and k + 1 < len(out):
            g = g + out[k + 1]
            k += 1
        merged.append(g)
        k += 1
    return merged


def split_slide(slide, N):
    if slide['type'] != 'content':
        return [slide]
    blocks = slide['blocks']
    if not blocks:
        return [slide]
    scale = 1.0
    units = []   # (cost, kind, payload)
    for b in blocks:
        if b['k'] == 'text':
            for g in groups(b['paras']):
                c = text_cost(g, scale)
                if c > N and len(g) > 1:
                    for p in g:
                        units.append((para_cost(p, scale), 'text', [p]))
                else:
                    units.append((c, 'text', g))
        elif b['k'] == 'image':
            units.append((5.0, 'image', b))
        elif b['k'] == 'table':
            units.append((1.3 + sum(table_row_cost(r) for r in b['rows']), 'table', b))
        elif b['k'] == 'code':
            units.append((0.8 + CODE_LINE * code_lines(b['text']), 'code', b))
    out = []
    cur = None

    def fresh():
        s = {'type': 'content', 'title': slide['title'], 'blocks': [], 'notes': [], 'cont': bool(out) or slide.get('cont')}
        out.append(s)
        return s

    used = 0.0
    cur = fresh()
    for cost, kind, pl in units:
        room = N - used
        if kind == 'table' and cost > room:
            rows = pl['rows']
            k = 0
            while k < len(rows) or k == 0:
                room = N - used
                fit = int((room - 1.3) // ROW)
                if fit < 2 and cur['blocks']:
                    cur = fresh()
                    used = 0.0
                    continue
                fit = max(fit, 2)
                chunk = rows[k:k + fit]
                cur['blocks'].append({'k': 'table', 'head': pl['head'], 'aligns': pl['aligns'], 'rows': chunk})
                used += 1.3 + sum(table_row_cost(r) for r in chunk)
                k += fit
                if k < len(rows):
                    cur = fresh()
                    used = 0.0
                else:
                    break
            continue
        if kind == 'code' and cost > room:
            lines = pl['text'].split('\n')
            k = 0
            while k < len(lines):
                room = N - used
                fit = int((room - 0.8) // CODE_LINE)
                if fit < 4 and cur['blocks']:
                    cur = fresh()
                    used = 0.0
                    continue
                fit = max(fit, 4)
                chunk = lines[k:k + fit]
                cur['blocks'].append({'k': 'code', 'lang': pl['lang'], 'text': '\n'.join(chunk)})
                used += 0.8 + CODE_LINE * code_lines('\n'.join(chunk))
                k += fit
                if k < len(lines):
                    cur = fresh()
                    used = 0.0
            continue
        if cost > room and cur['blocks']:
            cur = fresh()
            used = 0.0
        if kind == 'image' and any(x['k'] in ('image', 'table', 'code') for x in cur['blocks']):
            cur = fresh()
            used = 0.0
        if kind == 'text':
            if cur['blocks'] and cur['blocks'][-1]['k'] == 'text':
                cur['blocks'][-1]['paras'].extend(pl)
            else:
                cur['blocks'].append({'k': 'text', 'paras': list(pl)})
        else:
            cur['blocks'].append(pl)
        used += cost
    if out:
        out[0]['notes'] = slide['notes']
        out[0]['cont'] = slide.get('cont', False)
    return out


def plan(deck, N):
    slides = []
    for s in deck['slides']:
        slides.extend(split_slide(s, N))
    return slides


def dump(deck, slides):
    res = {'title': deck['title'], 'subtitle': deck['subtitle'], 'meta': deck['meta'], 'slides': []}
    for s in slides:
        bl = []
        for b in s['blocks']:
            if b['k'] == 'text':
                bl.append({'k': 'text', 'lines': [p[2] for p in b['paras']], 'kinds': [p[0] + str(p[1]) for p in b['paras']]})
            elif b['k'] == 'table':
                bl.append({'k': 'table', 'rows': len(b['rows']), 'cols': len(b['head'])})
            elif b['k'] == 'code':
                bl.append({'k': 'code', 'lines': b['text'].count('\n') + 1})
            else:
                bl.append({'k': 'image', 'src': b['src']})
        res['slides'].append({'type': s['type'], 'title': s['title'], 'cont': s['cont'], 'notes': s['notes'], 'blocks': bl})
    return res


# ---------------------------------------------------------------- building
SCHEMES = {
    'light': dict(bg='FFFFFF', title='1F2A44', text='2B2F36', sub='5B6472', accent='2563EB', code_bg='F1F3F6', code_fg='1F2937', alt='F3F6FB', line='D9DEE7', head_fg='FFFFFF'),
    'dark': dict(bg='0F172A', title='F8FAFC', text='E2E8F0', sub='94A3B8', accent='38BDF8', code_bg='1E293B', code_fg='E2E8F0', alt='172033', line='334155', head_fg='0F172A'),
    'brand': dict(bg='FFFFFF', title='1F2937', text='2B2F36', sub='5B6472', accent='E4572E', code_bg='F4F1EE', code_fg='1F2937', alt='F8F4F1', line='E5DDD7', head_fg='FFFFFF'),
}


def find_image(root, src):
    if re.match(r'^[a-z]+://', src, re.I) or src.startswith('data:'):
        return None
    from urllib.parse import unquote
    base = os.path.basename(src.split('?')[0])
    names = os.listdir(os.path.join(root, 'in')) if os.path.isdir(os.path.join(root, 'in')) else []
    for c in (src, base, unquote(src), unquote(base)):
        p = os.path.join(root, 'in', c)
        if os.path.isfile(p):
            return p
    for f in names:
        if f.lower() == base.lower():
            return os.path.join(root, 'in', f)
    return None


def build(deck, slides, out, a, ea_font):
    from pptx import Presentation
    from pptx.util import Inches, Pt, Emu
    from pptx.dml.color import RGBColor
    from pptx.enum.text import PP_ALIGN, MSO_ANCHOR, MSO_AUTO_SIZE
    from pptx.enum.shapes import MSO_SHAPE
    from pptx.oxml.ns import qn
    from pptx.oxml import parse_xml
    from lxml import etree

    sc = dict(SCHEMES[a.scheme])
    if a.scheme == 'brand' or a.accent:
        sc['accent'] = (a.accent or sc['accent']).lstrip('#').upper()
    if a.scheme == 'brand':
        sc['head_fg'] = 'FFFFFF'
    font = a.font
    MONO_L, MONO_EA = 'Consolas', 'Noto Sans Mono CJK SC'
    rgb = lambda h: RGBColor.from_string(h)
    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
    W, H = 13.333, 7.5
    MX = 0.8
    CW = W - 2 * MX

    def set_font(run, size, color, bold=False, italic=False, mono=False):
        f = run.font
        f.size = Pt(size)
        f.bold = bold
        f.italic = italic
        f.color.rgb = rgb(color)
        f.name = MONO_L if mono else font
        rPr = run._r.get_or_add_rPr()
        rPr.set('lang', 'zh-CN')
        rPr.set('altLang', 'en-US')
        latin = rPr.find(qn('a:latin'))
        for tag in ('a:ea', 'a:cs'):
            for old in rPr.findall(qn(tag)):
                rPr.remove(old)
        ea = etree.SubElement(rPr, qn('a:ea'))
        ea.set('typeface', MONO_EA if mono else ea_font)
        cs = etree.SubElement(rPr, qn('a:cs'))
        cs.set('typeface', MONO_L if mono else font)
        rPr.remove(ea)
        rPr.remove(cs)
        latin.addnext(ea)
        ea.addnext(cs)

    TOK = re.compile(r'(\*\*\*.+?\*\*\*|\*\*.+?\*\*|__.+?__|(?<![\w*])\*(?!\s)[^*]+?(?<!\s)\*(?![\w*])|' + BT + r'[^' + BT + r']+' + BT + r'|\[[^\]]+\]\([^)\s]+\))')

    def add_runs(par, text, size, color, bold=False, italic=False):
        text = re.sub(r'!\[[^\]]*\]\([^)]*\)', '', text)
        pos = 0
        for m in TOK.finditer(text):
            if m.start() > pos:
                r = par.add_run()
                r.text = text[pos:m.start()]
                set_font(r, size, color, bold, italic)
            t = m.group(0)
            r = par.add_run()
            if t.startswith('***'):
                r.text = t[3:-3]
                set_font(r, size, color, True, True)
            elif t.startswith('**') or t.startswith('__'):
                r.text = t[2:-2]
                set_font(r, size, color, True, italic)
            elif t.startswith(BT):
                r.text = t[1:-1]
                set_font(r, size * 0.9, sc['accent'], bold, italic, mono=True)
            elif t.startswith('['):
                mm = re.match(r'\[([^\]]+)\]\(([^)\s]+)\)', t)
                r.text = mm.group(1)
                set_font(r, size, sc['accent'], bold, italic)
                if re.match(r'^(https?://|mailto:)', mm.group(2)):
                    r.hyperlink.address = mm.group(2)
                r.font.underline = True
            else:
                r.text = t[1:-1]
                set_font(r, size, color, bold, True)
            pos = m.end()
        if pos < len(text) or not par.runs:
            r = par.add_run()
            r.text = text[pos:]
            set_font(r, size, color, bold, italic)

    def textbox(slide, x, y, w, h, anchor=MSO_ANCHOR.TOP):
        tb = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
        tf = tb.text_frame
        tf.word_wrap = True
        tf.auto_size = MSO_AUTO_SIZE.NONE
        tf.vertical_anchor = anchor
        tf.margin_left = tf.margin_right = Inches(0.05)
        tf.margin_top = tf.margin_bottom = Inches(0.03)
        return tb, tf

    def bullet_xml(par, kind, lvl, num, size):
        pPr = par._p.get_or_add_pPr()
        if kind in ('b', 'n'):
            ind = 0.38 if lvl == 0 else 0.34
            marL = 0.38 if lvl == 0 else 0.38 + 0.4 + ind
            pPr.set('marL', str(int(Inches(marL))))
            pPr.set('indent', str(-int(Inches(ind))))
            clr = parse_xml('<a:buClr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:srgbClr val="%s"/></a:buClr>' % sc['accent'])
            pPr.append(clr)
            if kind == 'b':
                pPr.append(parse_xml('<a:buFont xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" typeface="Arial"/>'))
                pPr.append(parse_xml('<a:buChar xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" char="%s"/>' % ('•' if lvl == 0 else '–')))
            else:
                pPr.append(parse_xml('<a:buFont xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" typeface="+mj-lt"/>'))
                pPr.append(parse_xml('<a:buAutoNum xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" type="arabicPeriod" startAt="%d"/>' % (num or 1)))
        else:
            pPr.set('marL', '0')
            pPr.set('indent', '0')
            pPr.append(parse_xml('<a:buNone xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>'))

    def fill_text(tf, paras, base):
        first = True
        for p in paras:
            kind, lvl, text, num = p
            par = tf.paragraphs[0] if first else tf.add_paragraph()
            first = False
            if kind == 'h':
                size, color, bold, italic = base + 2, sc['accent'], True, False
                gap, before = 4, 8
            elif kind == 'q':
                size, color, bold, italic = base - 2, sc['sub'], False, True
                gap, before = 6, 2
            elif kind == 'p':
                size, color, bold, italic = base - 2, sc['text'], False, False
                gap, before = 8, 2
            elif lvl == 0:
                size, color, bold, italic = base, sc['text'], False, False
                gap, before = 9, 3
            else:
                size, color, bold, italic = base - 4, sc['sub'] if a.scheme != 'dark' else sc['text'], False, False
                gap, before = 5, 0
            par.space_after = Pt(gap)
            par.space_before = Pt(before)
            par.line_spacing = 1.05
            par.level = lvl if kind in ('b', 'n') else 0
            bullet_xml(par, kind, lvl, num, size)
            add_runs(par, text, size, color, bold, italic)

    def background(slide, color):
        fill = slide.background.fill
        fill.solid()
        fill.fore_color.rgb = rgb(color)

    def rect(slide, x, y, w, h, color):
        s = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(x), Inches(y), Inches(w), Inches(h))
        s.fill.solid()
        s.fill.fore_color.rgb = rgb(color)
        s.line.fill.background()
        s.shadow.inherit = False
        return s

    def slide_number(slide, n, color):
        tb, tf = textbox(slide, W - 1.6, H - 0.62, 0.9, 0.35, MSO_ANCHOR.MIDDLE)
        p = tf.paragraphs[0]
        p.alignment = PP_ALIGN.RIGHT
        fld = parse_xml('<a:fld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="en-US" sz="1200"/><a:t>%d</a:t></a:fld>' % n)
        p._p.append(fld)
        rPr = fld.find(qn('a:rPr'))
        rPr.append(parse_xml('<a:solidFill xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:srgbClr val="%s"/></a:solidFill>' % color))
        rPr.append(parse_xml('<a:latin xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" typeface="%s"/>' % font))
        rPr.append(parse_xml('<a:ea xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" typeface="%s"/>' % ea_font))

    def set_title(ph, text, x, y, w, h, color, size=None, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.MIDDLE):
        ph.left, ph.top, ph.width, ph.height = Inches(x), Inches(y), Inches(w), Inches(h)
        tf = ph.text_frame
        tf.word_wrap = True
        tf.auto_size = MSO_AUTO_SIZE.NONE
        tf.vertical_anchor = anchor
        tf.margin_left = tf.margin_right = Inches(0.05)
        tf.text = ''
        par = tf.paragraphs[0]
        par.alignment = align
        ww = wid(strip_md(text))
        if size is None:
            size = 34 if ww <= 44 else 28 if ww <= 60 else 24
        add_runs(par, text, size, color, bold=True)

    L_TITLE, L_TONLY = prs.slide_layouts[0], prs.slide_layouts[5]
    n_slide = 0
    accent = sc['accent']

    def title_slide(title, subtitle, meta, kind='title'):
        s = prs.slides.add_slide(L_TITLE)
        brand = a.scheme == 'brand'
        background(s, accent if brand else sc['bg'])
        fg = 'FFFFFF' if brand else sc['title']
        sub = 'FFFFFF' if brand else sc['sub']
        if not brand:
            rect(s, 0, 0, 0.35, H, accent)
        else:
            rect(s, 0.8, 4.35, 1.6, 0.07, 'FFFFFF')
        set_title(s.shapes.title, title, MX + (0.5 if not brand else 0), 2.0, CW - 0.5, 2.2, fg, size=(46 if wid(title) <= 30 else 38 if wid(title) <= 50 else 30), anchor=MSO_ANCHOR.BOTTOM)
        sp = s.placeholders[1]
        sp.left, sp.top, sp.width, sp.height = Inches(MX + (0.5 if not brand else 0)), Inches(4.6), Inches(CW - 0.5), Inches(1.6)
        tf = sp.text_frame
        tf.word_wrap = True
        tf.auto_size = MSO_AUTO_SIZE.NONE
        tf.vertical_anchor = MSO_ANCHOR.TOP
        tf.text = ''
        first = True
        for k, line in enumerate([subtitle] + meta if subtitle else meta):
            if not line:
                continue
            par = tf.paragraphs[0] if first else tf.add_paragraph()
            first = False
            par.alignment = PP_ALIGN.LEFT
            par.space_after = Pt(6)
            add_runs(par, line, 24 if k == 0 and subtitle else 16, sub if k else sub)
        if first:
            sp._element.getparent().remove(sp._element)
        return s

    def section_slide(title):
        s = prs.slides.add_slide(L_TITLE)
        brand = a.scheme == 'brand'
        bg = accent if brand else (sc['code_bg'] if a.scheme == 'light' else sc['alt'])
        background(s, bg)
        fg = 'FFFFFF' if brand else sc['title']
        if not brand:
            rect(s, MX, 3.05, 0.12, 1.3, accent)
        set_title(s.shapes.title, title, MX + 0.4, 2.6, CW - 0.4, 2.2, fg, size=44 if wid(title) <= 30 else 34)
        sp = s.placeholders[1]
        sp._element.getparent().remove(sp._element)
        return s

    def content_slide(sl):
        s = prs.slides.add_slide(L_TONLY)
        background(s, sc['bg'])
        title = sl['title'] + ('（续）' if sl['cont'] and sl['title'] else '')
        if a.scheme == 'brand':
            rect(s, 0, 0, W, 0.16, accent)
        rect(s, MX - 0.28, 0.62, 0.1, 0.6, accent)
        set_title(s.shapes.title, title or ' ', MX, 0.45, CW, 0.95, sc['title'])
        return s

    def place_blocks(s, sl):
        blocks = sl['blocks']
        y = 1.6
        bottom = H - 0.75
        scale = 1.0
        tcost = sum(text_cost(b['paras'], scale) for b in blocks if b['k'] == 'text')
        base = 30 if tcost <= 5.5 else 28 if tcost <= 8 else 26 if tcost <= 9.5 else 24
        for b in blocks:
            if b['k'] == 'text':
                cost = text_cost(b['paras'], scale) * base / 24.0
                h = min(max(cost * 0.40, 0.5), bottom - y)
                tb, tf = textbox(s, MX, y, CW, h)
                fill_text(tf, b['paras'], base)
                y += h + 0.12
            elif b['k'] == 'image':
                path = find_image(a.root, b['src'])
                if not path:
                    note('图片 %s 找不到，已跳过' % b['src'])
                    continue
                try:
                    from PIL import Image
                    im = Image.open(path)
                    iw, ih = im.size
                    if im.format not in ('PNG', 'JPEG', 'GIF', 'BMP', 'TIFF'):
                        tmp = os.path.join(os.path.dirname(os.path.abspath(out)), '.img_%d.png' % abs(hash(path)))
                        im.convert('RGBA').save(tmp)
                        path = tmp
                except Exception:
                    note('图片 %s 打不开，已跳过' % b['src'])
                    continue
                bx, by, bw, bh = MX, y, CW, max(bottom - y, 2.0)
                r = min(bw / iw, bh / ih)
                pw, ph = iw * r, ih * r
                s.shapes.add_picture(path, Inches(bx + (bw - pw) / 2), Inches(by + (bh - ph) / 2), Inches(pw), Inches(ph))
                y += bh + 0.1
            elif b['k'] == 'table':
                y = place_table(s, b, y, bottom)
            elif b['k'] == 'code':
                y = place_code(s, b, y, bottom)

    def place_table(s, b, y, bottom):
        rows = [b['head']] + b['rows']
        nr, nc = len(rows), len(b['head'])
        fs = 18 if nr <= 6 else 16 if nr <= 8 else 14
        wts = []
        for c in range(nc):
            wts.append(min(max(max(wid(strip_md(r[c])) for r in rows), 6), 40))
        tot = float(sum(wts))
        shape = s.shapes.add_table(nr, nc, Inches(MX), Inches(y), Inches(CW), Inches(0.46 * nr))
        tbl = shape.table
        tblPr = tbl._tbl.tblPr
        sid = tblPr.find(qn('a:tableStyleId'))
        if sid is not None:
            sid.text = '{2D5ABB26-0587-4C30-8999-92F81FD0307C}'
        tblPr.set('bandRow', '0')
        for c in range(nc):
            tbl.columns[c].width = Inches(CW * wts[c] / tot)
        heights = 0.0
        for ri, r in enumerate(rows):
            ml = max(wid(strip_md(x)) / (wts[ci] / tot * CW / 0.1) for ci, x in enumerate(r))
            lines = max(1, math.ceil(ml))
            h = 0.2 + lines * fs * 1.25 / 72.0
            tbl.rows[ri].height = Inches(h)
            heights += h
            for ci, txt in enumerate(r):
                cell = tbl.cell(ri, ci)
                cell.margin_left = cell.margin_right = Inches(0.12)
                cell.margin_top = cell.margin_bottom = Inches(0.05)
                cell.vertical_anchor = MSO_ANCHOR.MIDDLE
                tf = cell.text_frame
                tf.word_wrap = True
                par = tf.paragraphs[0]
                par.alignment = {'left': PP_ALIGN.LEFT, 'center': PP_ALIGN.CENTER, 'right': PP_ALIGN.RIGHT}[b['aligns'][ci] if ci < len(b['aligns']) else 'left']
                if ri == 0:
                    add_runs(par, txt, fs, sc['head_fg'], bold=True)
                    cell.fill.solid()
                    cell.fill.fore_color.rgb = rgb(accent)
                else:
                    add_runs(par, txt, fs, sc['text'])
                    cell.fill.solid()
                    cell.fill.fore_color.rgb = rgb(sc['alt'] if ri % 2 == 0 else sc['bg'])
                tcPr = cell._tc.get_or_add_tcPr()
                ln = parse_xml('<a:lnB xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" w="6350"><a:solidFill><a:srgbClr val="%s"/></a:solidFill></a:lnB>' % sc['line'])
                tcPr.insert(0, ln)
        shape.height = Inches(heights)
        return y + heights + 0.2

    def place_code(s, b, y, bottom):
        lines = b['text'].split('\n')
        n = code_lines(b['text'])
        fs = 16 if n <= 8 else 14 if n <= 11 else 12
        h = min(bottom - y, 0.3 + n * fs * 1.3 / 72.0)
        box = s.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(MX), Inches(y), Inches(CW), Inches(h))
        box.adjustments[0] = 0.04
        box.fill.solid()
        box.fill.fore_color.rgb = rgb(sc['code_bg'])
        box.line.color.rgb = rgb(sc['line'])
        box.line.width = Pt(0.75)
        box.shadow.inherit = False
        tf = box.text_frame
        tf.word_wrap = True
        tf.auto_size = MSO_AUTO_SIZE.NONE
        tf.vertical_anchor = MSO_ANCHOR.TOP
        tf.margin_left = tf.margin_right = Inches(0.22)
        tf.margin_top = tf.margin_bottom = Inches(0.12)
        for k, ln in enumerate(lines):
            par = tf.paragraphs[0] if k == 0 else tf.add_paragraph()
            par.alignment = PP_ALIGN.LEFT
            par.space_after = Pt(0)
            par.line_spacing = 1.1
            r = par.add_run()
            r.text = ln if ln else ' '
            set_font(r, fs, sc['code_fg'], mono=True)
        return y + h + 0.2

    total = 1 + len(slides) if deck['title'] else len(slides)
    if deck['title']:
        s = title_slide(deck['title'], deck['subtitle'], deck['meta'])
        n_slide += 1
        if deck.get('notes0'):
            s.notes_slide.notes_text_frame.text = '\n'.join(deck['notes0'])
        if a.numbers and a.scheme != 'brand':
            pass
    for sl in slides:
        n_slide += 1
        if sl['type'] == 'section':
            s = section_slide(sl['title'])
        elif not sl['blocks']:
            s = section_slide(sl['title'])
        else:
            s = content_slide(sl)
            place_blocks(s, sl)
        if sl['notes']:
            s.notes_slide.notes_text_frame.text = '\n'.join(sl['notes'])
        if a.numbers and not (a.scheme == 'brand' and sl['type'] == 'section'):
            slide_number(s, n_slide, sc['sub'] if not (sl['type'] == 'section' and a.scheme == 'brand') else 'FFFFFF')
    prs.core_properties.title = deck['title']
    prs.core_properties.author = a.author or ''
    prs.save(out)
    return n_slide


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input')
    ap.add_argument('output', nargs='?')
    ap.add_argument('--scheme', default='light', choices=['light', 'dark', 'brand'])
    ap.add_argument('--accent')
    ap.add_argument('--max-lines', dest='max_lines', type=int, default=11)
    ap.add_argument('--title')
    ap.add_argument('--subtitle')
    ap.add_argument('--author')
    ap.add_argument('--date')
    ap.add_argument('--font', default='Noto Sans CJK SC')
    ap.add_argument('--ea-font', dest='ea_font', default='Microsoft YaHei')
    ap.add_argument('--no-numbers', dest='numbers', action='store_false')
    ap.add_argument('--preview-out', dest='preview_out')
    ap.add_argument('--root', default='.')
    ap.add_argument('--dump', action='store_true')
    a = ap.parse_args()
    deck = parse(open(a.input, encoding='utf-8', errors='replace').read())
    if a.title:
        deck['title'] = a.title
    if a.subtitle:
        deck['subtitle'] = a.subtitle
    if a.author:
        deck['meta'] = [x for x in deck['meta'] if x != a.author] + [a.author]
    if a.date:
        deck['meta'].append(a.date)
    slides = plan(deck, a.max_lines)
    if a.dump:
        print(json.dumps(dump(deck, slides), ensure_ascii=False))
        return
    n = build(deck, slides, a.output, a, a.ea_font)
    if a.preview_out:
        build(deck, slides, a.preview_out, a, a.font)
    for x in NOTES:
        print('NOTE ' + x)
    print('SLIDES=%d' % n)


if __name__ == '__main__':
    main()
`;

const SCHEMES = ["light", "dark", "brand"];
const skill: Skill = {
  name: "md-to-slides",
  title: "Markdown 转 PPT",
  when:
    "把 Markdown 大纲做成可编辑的 16:9 PowerPoint（.pptx），并附一份 PDF 预览方便先看效果。" +
    "写法：# 一级标题是封面（紧跟的第一行文字是副标题）；## 二级标题每个开一页；### 页内小标题；- 要点（缩进两格是第二级）；1. 编号列表；" +
    "![](图片名) 插图（和图片文件一起上传，自动缩放进页面）；Markdown 表格会变成原生 PPT 表格；``` 代码块变等宽代码框；" +
    "「> 备注：讲稿内容」会写进演讲者备注；再出现的 # 标题是章节分隔页。内容太多的页会自动拆成「（续）」页。" +
    "scheme 选 light 浅色（默认）、dark 深色、brand 品牌色（用 accent 给主色，如 #E4572E）。每页要点尽量短，一页 4 到 7 条最好。正文直接填 markdown，或上传 .md 文件。",
  args: {
    markdown: { type: "string", description: "Markdown 大纲。有文字在手就直接填这里；用文件上传时可以不填。" },
    scheme: { type: "string", description: "配色：light 浅色（默认）、dark 深色、brand 品牌色。", enum: SCHEMES },
    accent: { type: "string", description: "主色，十六进制如 #E4572E。brand 配色最有用，其他配色也可以改强调色。" },
    max_lines: { type: "integer", description: "一页最多放多少行文字，超过就自动拆页，默认 11，范围 6 到 16。" },
    title: { type: "string", description: "封面标题。不填就用正文里第一个 # 标题。" },
    subtitle: { type: "string", description: "封面副标题，可不填。" },
    author: { type: "string", description: "汇报人，显示在封面，可不填。" },
    date: { type: "string", description: "日期，显示在封面，可不填。" },
    font: { type: "string", description: "字体名，默认 Noto Sans CJK SC。在别人的电脑上打开时中文会自动换成系统里的中文字体。" },
    slide_numbers: { type: "boolean", description: "是否显示页码，默认显示。" },
    preview: { type: "boolean", description: "是否同时生成 PDF 预览，默认生成（电脑上没有 LibreOffice 时自动跳过）。" },
    name: { type: "string", description: "输出文件名（不含扩展名），默认 slides。" },
  },
  files: { min: 0, max: 30, extensions: ["md", "markdown", "txt", "png", "jpg", "jpeg", "gif", "webp", "bmp"], what: "Markdown 文件，以及要放进幻灯片的图片" },
  packs: ["office"],
  timeoutSeconds: 300,
  commands(args, files) {
    const scheme = String(args.scheme || "light");
    if (!SCHEMES.includes(scheme)) throw new Error("scheme 只能是 light、dark、brand 三种之一");
    let accent = "";
    if (args.accent != null && String(args.accent).trim() !== "") {
      accent = String(args.accent).trim();
      if (!/^#?[0-9a-fA-F]{6}$/.test(accent)) throw new Error("accent 要写成 6 位十六进制颜色，比如 #E4572E");
      accent = accent.replace(/^#?/, "#");
    }
    const maxLines = args.max_lines == null || args.max_lines === "" ? 11 : Number(args.max_lines);
    if (!Number.isInteger(maxLines) || maxLines < 6 || maxLines > 16) throw new Error("max_lines 要在 6 到 16 之间");
    for (const k of ["title", "subtitle", "author", "date", "font"]) if (args[k] != null && String(args[k]).length > 120) throw new Error(`${k} 太长了`);
    const src = markdownSource(args, files);
    const name = safeName(args.name, "slides");
    const opts = [
      `--scheme ${scheme}`,
      accent ? `--accent ${sh(accent)}` : "",
      `--max-lines ${maxLines}`,
      args.title ? `--title ${sh(args.title)}` : "",
      args.subtitle ? `--subtitle ${sh(args.subtitle)}` : "",
      args.author ? `--author ${sh(args.author)}` : "",
      args.date ? `--date ${sh(args.date)}` : "",
      args.font ? `--font ${sh(args.font)}` : "",
      args.slide_numbers === false || args.slide_numbers === "false" ? "--no-numbers" : "",
      "--root .",
    ].filter(Boolean).join(" ");
    const wantPreview = args.preview == null || truthy(args.preview) || args.preview === "";
    const prev = `.skill/${name}-preview.pptx`;
    return [
      "mkdir -p in out .skill",
      ...putFile(".skill/md2pptx.py", MD2PPTX_PY),
      ...src.cmds,
      `${PY_PICK}; $PY .skill/md2pptx.py ${sh(src.path)} ${sh(`out/${name}.pptx`)} ${opts}${wantPreview ? ` --preview-out ${sh(prev)}` : ""}`,
      ...(wantPreview
        ? [`export HOME=\${HOME:-/tmp}; if command -v soffice >/dev/null 2>&1; then (cd .skill && timeout 200 soffice --headless --convert-to pdf --outdir . ${sh(`${name}-preview.pptx`)} >/dev/null 2>&1 && mv -f ${sh(`${name}-preview.pdf`)} ${sh(`../out/${name}-preview.pdf`)} && echo PREVIEW=1) || echo PREVIEW=0; else echo PREVIEW=0; fi; true`]
        : []),
    ];
  },
  report(stdout) {
    const text = stdout.join("\n");
    const notes = [...text.matchAll(/^NOTE (.+)$/gm)].map((m) => m[1]);
    return { slides: Number(/SLIDES=(\d+)/.exec(text)?.[1] || 0), preview: /PREVIEW=1/.test(text), ...(notes.length ? { notes } : {}) };
  },
};
export default skill;
