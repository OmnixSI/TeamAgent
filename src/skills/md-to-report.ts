// Markdown -> typeset PDF through Typst. The Markdown-to-Typst converter is the Python script below (standard library only),
// so this path needs no pandoc; it is run locally by test/skills-typeset.test.mjs.
import type { Skill, SkillArgs, SkillFile } from "./types.ts";
import { sh } from "./types.ts";

export const MD2TYP_PY = String.raw`#!/usr/bin/env python3
# Markdown -> Typst. Standard library only. Anything it does not understand becomes plain text.
#   md2typ.py IN.md OUT.typ --style report|paper|note [--title T] [--subtitle S] [--author A] [--date D]
#             [--short-title S] [--toc] [--no-numbering] [--columns 1|2] [--plain-math] [--root DIR]
import sys, os, re, argparse, datetime

BT = chr(96)
CJK = re.compile(r'[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]')
NOTES = []


def note(s):
    if s not in NOTES:
        NOTES.append(s)


def tstr(s):
    return '"' + s.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n').replace('\t', '\\t').replace('\r', '') + '"'


ESC = set('\\#$*_' + BT + '<>@[]~-+/=')


def esc(s):
    s = ''.join('\\' + c if c in ESC else c for c in s)
    return re.sub(r'^(\s*\d+)\.', lambda m: m.group(1) + '\\.', s)


# ---------------------------------------------------------------- LaTeX math -> Typst math
GREEK = ('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega '
         'Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega').split()
SYM = {
    'varepsilon': 'epsilon.alt', 'vartheta': 'theta.alt', 'varphi': 'phi.alt', 'varrho': 'rho.alt', 'varpi': 'pi.alt', 'varsigma': 'sigma.alt',
    'cdot': 'dot.op', 'times': 'times', 'div': 'div', 'pm': 'plus.minus', 'mp': 'minus.plus', 'leq': 'lt.eq', 'le': 'lt.eq', 'geq': 'gt.eq',
    'ge': 'gt.eq', 'neq': 'eq.not', 'ne': 'eq.not', 'approx': 'approx', 'equiv': 'equiv', 'sim': 'tilde.op', 'simeq': 'tilde.eq', 'propto': 'prop',
    'infty': 'infinity', 'partial': 'partial', 'nabla': 'nabla', 'to': 'arrow.r', 'rightarrow': 'arrow.r', 'leftarrow': 'arrow.l',
    'gets': 'arrow.l', 'Rightarrow': 'arrow.r.double', 'Leftarrow': 'arrow.l.double', 'leftrightarrow': 'arrow.l.r',
    'Leftrightarrow': 'arrow.l.r.double', 'iff': 'arrow.l.r.double', 'implies': 'arrow.r.double', 'mapsto': 'arrow.r.bar', 'uparrow': 'arrow.t',
    'downarrow': 'arrow.b', 'in': 'in', 'notin': 'in.not', 'ni': 'in.rev', 'subset': 'subset', 'subseteq': 'subset.eq', 'supset': 'supset',
    'supseteq': 'supset.eq', 'cup': 'union', 'cap': 'inter', 'forall': 'forall', 'exists': 'exists', 'emptyset': 'emptyset', 'varnothing': 'emptyset',
    'ldots': 'dots.h', 'dots': 'dots.h', 'cdots': 'dots.h.c', 'vdots': 'dots.v', 'ddots': 'dots.down', 'ell': 'ell', 'hbar': '"ℏ"',
    'angle': 'angle', 'circ': 'compose', 'bullet': 'bullet', 'star': 'star.op', 'ast': 'ast.op', 'otimes': 'times.o', 'oplus': 'plus.o',
    'perp': 'perp', 'parallel': 'parallel', 'mid': 'divides', 'sum': 'sum', 'prod': 'product', 'int': 'integral', 'oint': 'integral.cont',
    'iint': 'integral.double', 'iiint': 'integral.triple', 'langle': 'chevron.l', 'rangle': 'chevron.r', 'lfloor': 'floor.l', 'rfloor': 'floor.r',
    'lceil': 'ceil.l', 'rceil': 'ceil.r', 'neg': 'not', 'lnot': 'not', 'land': 'and', 'wedge': 'and', 'lor': 'or', 'vee': 'or', 'top': 'top',
    'bot': 'bot', 'vdash': 'tack.r', 'models': 'tack.r.double', 'll': 'lt.double', 'gg': 'gt.double', 'prime': 'prime', 'dagger': 'dagger',
    'degree': 'degree', 'checkmark': 'checkmark', 'Re': 'Re', 'Im': 'Im', 'aleph': 'aleph', 'setminus': 'without', 'oplus': 'plus.o',
    'quad': 'quad', 'qquad': 'wide', 'thinspace': 'thin', 'colon': ':', 'lbrace': 'brace.l', 'rbrace': 'brace.r', 'lvert': '|', 'rvert': '|',
    'Vert': 'bar.v.double', 'vert': '|', 'sqcup': 'union.sq', 'sqcap': 'inter.sq', 'bigcup': 'union.big', 'bigcap': 'inter.big',
    'longrightarrow': 'arrow.r.long', 'longleftarrow': 'arrow.l.long', 'Longrightarrow': 'arrow.r.double.long', 'hookrightarrow': 'arrow.r.hook',
    'because': 'because', 'therefore': 'therefore', 'cong': 'tilde.equiv', 'asymp': 'tilde.eq', 'doteq': 'eq.dots',
}
for g in GREEK:
    SYM.setdefault(g, g)
OPS = set('arccos arcsin arctan arg cos cosh cot coth csc deg det dim exp gcd hom ker lg lim liminf limsup ln log max min sec sin sinh tan tanh sup inf Pr'.split())
SKIP0 = set('displaystyle textstyle scriptstyle limits nolimits big Big bigg Bigg bigl bigr Bigl Bigr biggl biggr nonumber notag left_ right_ hfill'.split())
SKIP1 = set('label hspace vspace tag phantom hphantom vphantom'.split())
ACC = {'hat': 'hat', 'widehat': 'hat', 'bar': 'overline', 'overline': 'overline', 'underline': 'underline', 'vec': 'arrow', 'tilde': 'tilde',
       'widetilde': 'tilde', 'dot': 'dot', 'ddot': 'dot.double', 'check': 'caron', 'overrightarrow': 'arrow', 'breve': 'breve', 'mathbf': 'bold',
       'boldsymbol': 'bold', 'bm': 'bold', 'mathcal': 'cal', 'mathscr': 'cal', 'mathfrak': 'frak', 'mathit': 'italic', 'mathsf': 'sans',
       'mathtt': 'mono', 'mathbin': '', 'mathrel': '', 'mathop': '', 'cancel': 'cancel'}
BB = {'R': 'RR', 'N': 'NN', 'Z': 'ZZ', 'Q': 'QQ', 'C': 'CC', 'H': 'HH', 'P': 'PP', 'E': 'EE'}
MAT = {'pmatrix': '"("', 'bmatrix': '"["', 'Bmatrix': '"{"', 'vmatrix': '"|"', 'Vmatrix': '"||"', 'matrix': '#none', 'smallmatrix': '#none'}
ALIGNED = set('aligned align align* split gather gather* alignat eqnarray equation equation* multline array'.split())
MATH_BAD = []


class Tex:
    def __init__(self, s):
        self.s = s
        self.i = 0

    def peek(self, k=0):
        j = self.i + k
        return self.s[j] if j < len(self.s) else ''

    def ws(self):
        while self.peek() and self.peek().isspace():
            self.i += 1

    def at(self, t):
        return self.s.startswith(t, self.i)

    def raw_group(self):
        # content of {...} as raw text, cursor after the closing brace
        self.ws()
        if self.peek() != '{':
            c = self.peek()
            self.i += 1 if c else 0
            return c
        depth, j = 0, self.i
        while j < len(self.s):
            if self.s[j] == '\\':
                j += 2
                continue
            if self.s[j] == '{':
                depth += 1
            elif self.s[j] == '}':
                depth -= 1
                if depth == 0:
                    break
            j += 1
        out = self.s[self.i + 1:j]
        self.i = min(j + 1, len(self.s))
        return out

    def arg(self):
        # one argument: a {group} or a single token, as Typst math
        self.ws()
        if self.peek() == '{':
            self.i += 1
            r = self.seq()
            if self.peek() == '}':
                self.i += 1
            return r
        a, _ = self.base()
        return a

    def seq(self):
        parts = []
        while True:
            self.ws()
            if not self.peek() or self.peek() == '}' or self.peek() == '&' or self.at('\\\\') or self.at('\\end') or self.at('\\right'):
                break
            r = self.atom()
            if r:
                parts.append(r)
        return ' '.join(parts)

    def script_arg(self):
        self.ws()
        if self.peek() == '{':
            self.i += 1
            r = self.seq()
            if self.peek() == '}':
                self.i += 1
            return r if re.fullmatch(r'[A-Za-z0-9]|[A-Za-z]+\.[a-z.]+', r or '') else '(' + r + ')'
        r, _ = self.base(single=True)
        return r if re.fullmatch(r'[A-Za-z0-9]|[A-Za-z]+(\.[a-z]+)*', r) else '(' + r + ')'

    def atom(self):
        b, grp = self.base()
        if b == '':
            if not (self.peek() in '_^' and self.peek()):
                return ''
        first = True
        while True:
            self.ws()
            c = self.peek()
            if c in ('_', '^') and c:
                if grp and first:
                    b = '(' + b + ')'
                first = False
                self.i += 1
                b += c + self.script_arg()
            elif c == "'":
                self.i += 1
                b += "'"
            else:
                break
        return b

    def delim(self):
        self.ws()
        if self.peek() == '\\':
            m = re.match(r'\\([a-zA-Z]+|.)', self.s[self.i:])
            d = m.group(0)
            self.i += len(d)
            return {'\\{': 'brace.l', '\\}': 'brace.r', '\\|': 'bar.v.double', '\\langle': 'chevron.l', '\\rangle': 'chevron.r', '\\lfloor': 'floor.l',
                    '\\rfloor': 'floor.r', '\\lceil': 'ceil.l', '\\rceil': 'ceil.r', '\\vert': '|', '\\lvert': '|', '\\rvert': '|',
                    '\\Vert': 'bar.v.double'}.get(d, '')
        c = self.peek()
        self.i += 1 if c else 0
        return {'(': '\\(', ')': '\\)', '[': '\\[', ']': '\\]', '|': '|', '.': '', '/': 'slash', '<': 'chevron.l', '>': 'chevron.r'}.get(c, '')

    def env(self, name):
        rows, row, cell = [], [], []
        if name == 'array' or name.startswith('alignat'):
            self.raw_group()
        while True:
            cell.append(self.seq())
            if self.at('\\end'):
                self.i += 4
                self.raw_group()
                row.append(' '.join(x for x in cell if x))
                rows.append(row)
                break
            if self.peek() == '&':
                self.i += 1
                row.append(' '.join(x for x in cell if x))
                cell = []
            elif self.at('\\\\'):
                self.i += 2
                row.append(' '.join(x for x in cell if x))
                rows.append(row)
                row, cell = [], []
            else:
                row.append(' '.join(x for x in cell if x))
                rows.append(row)
                break
        rows = [r for r in rows if any(r)]
        if name in MAT:
            body = '; '.join(', '.join(c or '""' for c in r) for r in rows)
            return 'mat(delim: %s, %s)' % (MAT[name], body)
        if name == 'cases':
            return 'cases(' + ', '.join(' quad '.join(c for c in r if c) for r in rows) + ')'
        return ' \\ '.join(' & '.join(r) if name in ALIGNED else ' '.join(r) for r in rows)

    def base(self, single=False):
        self.ws()
        c = self.peek()
        if not c:
            return '', False
        if c == '{' and not single:
            self.i += 1
            r = self.seq()
            if self.peek() == '}':
                self.i += 1
            return r, True
        if c == '{':
            return self.arg(), True
        if c == '\\':
            return self.command(), False
        if c.isdigit():
            if single:
                self.i += 1
                return c, False
            m = re.match(r'\d+(\.\d+)?', self.s[self.i:])
            self.i += len(m.group(0))
            return m.group(0), False
        self.i += 1
        if c.isalpha() or ord(c) > 127:
            return c, False
        if c == '/':
            return 'slash', False
        if c == '*':
            return 'ast.op', False
        if c in '+-=<>!,;:.()[]|?':
            return c, False
        if c == '~':
            return 'thin', False
        if c == '&':
            return 'quad', False
        if c in '^_':
            self.i -= 1
            return '', False
        if c in '"@#%$' + BT:
            return tstr(c), False
        if c == '}':
            return '', False
        return tstr(c), False

    def command(self):
        m = re.match(r'\\([a-zA-Z]+\*?|.)', self.s[self.i:], re.S)
        full = m.group(0)
        n = m.group(1).rstrip('*') if m.group(1)[0].isalpha() else m.group(1)
        self.i += len(full)
        if n in SKIP0:
            return ''
        if n in SKIP1:
            self.raw_group()
            return ''
        if not n.isalpha():
            return {',': 'thin', ';': 'thick', ':': 'med', '!': '', ' ': 'thin', '{': 'brace.l', '}': 'brace.r', '|': 'bar.v.double', '%': tstr('%'),
                    '&': tstr('&'), '_': tstr('_'), '#': tstr('#'), '$': tstr('$'), '\\': '\\', '/': '', '>': 'med', '"': tstr('"')}.get(n, tstr(n))
        if n in ('frac', 'dfrac', 'tfrac', 'cfrac'):
            a = self.arg()
            b = self.arg()
            return 'frac(%s, %s)' % (a, b)
        if n == 'binom':
            a = self.arg()
            b = self.arg()
            return 'binom(%s, %s)' % (a, b)
        if n == 'sqrt':
            self.ws()
            if self.peek() == '[':
                j = self.s.find(']', self.i)
                if j > 0:
                    idx = Tex(self.s[self.i + 1:j]).seq()
                    self.i = j + 1
                    return 'root(%s, %s)' % (idx, self.arg())
            return 'sqrt(%s)' % self.arg()
        if n in ('text', 'textrm', 'textbf', 'textit', 'mbox', 'textsf', 'texttt', 'hbox'):
            return tstr(self.raw_group())
        if n in ('mathrm', 'operatorname', 'mathsf_'):
            raw = self.raw_group()
            if re.fullmatch(r'[A-Za-z0-9 ]+', raw):
                return ('op(%s)' if n == 'operatorname' else 'upright(%s)') % tstr(raw)
            return 'upright(%s)' % Tex(raw).seq()
        if n == 'mathbb':
            raw = self.raw_group().strip()
            return BB.get(raw) or 'bb(%s)' % Tex(raw).seq()
        if n in ACC:
            a = self.arg()
            return '%s(%s)' % (ACC[n], a) if ACC[n] else a
        if n in ('overset', 'stackrel'):
            a = self.arg()
            b = self.arg()
            return 'attach(%s, t: %s)' % (b, a)
        if n == 'underset':
            a = self.arg()
            b = self.arg()
            return 'attach(%s, b: %s)' % (b, a)
        if n in ('xrightarrow', 'xleftarrow'):
            return 'attach(%s, t: %s)' % ('arrow.r.long' if n == 'xrightarrow' else 'arrow.l.long', self.arg())
        if n == 'left':
            d1 = self.delim()
            inner = self.seq()
            d2 = ''
            if self.at('\\right'):
                self.i += 6
                d2 = self.delim()
            return 'lr(%s)' % ' '.join(x for x in (d1, inner, d2) if x)
        if n in ('right', 'end'):
            return ''
        if n == 'begin':
            name = self.raw_group().strip()
            return self.env(name)
        if n in ('newline', 'cr'):
            return '\\'
        if n in ('lim', 'sup', 'inf', 'max', 'min') or n in OPS:
            return n
        if n in SYM:
            return SYM[n]
        if n == 'not':
            return 'not'
        MATH_BAD.append('\\' + n)
        return tstr('\\' + n)


def tex2typ(src):
    t = Tex(src.strip())
    out = []
    while True:
        r = t.seq()
        if r:
            out.append(r)
        if t.i >= len(t.s):
            break
        if t.at('\\\\'):
            t.i += 2
            out.append('\\')
        else:
            t.i += 1  # stray } & \right
    return ' '.join(out)


PLAIN_MATH = False


def math_inline(src):
    if PLAIN_MATH:
        return ('f', '#raw(%s);' % tstr('$' + src + '$'))
    try:
        r = tex2typ(src)
    except Exception:
        r = ''
    if not r.strip():
        return ('f', '#raw(%s);' % tstr('$' + src + '$'))
    return ('t', '$' + r + '$')


def math_block(src):
    if PLAIN_MATH:
        return '#block(width: 100%%, raw(%s))' % tstr(src.strip())
    try:
        r = tex2typ(src)
    except Exception:
        r = ''
    if not r.strip():
        return '#block(width: 100%%, raw(%s))' % tstr(src.strip())
    return '$ ' + r + ' $'


# ---------------------------------------------------------------- inline Markdown
PUNCT = set('!"#$%&\'()*+,-./:;<=>?@[\\]^_{|}~') | {BT}
URL_RE = re.compile(r'https?://[A-Za-z0-9\-._~:/?#\[\]@!$&\'()*+,;=%]+')


class Ctx:
    def __init__(self, root='.', inputs=None):
        self.fn = {}
        self.refs = {}
        self.root = root
        self.inputs = inputs or []
        self.used_fn = set()


def find_image(ctx, src):
    if re.match(r'^[a-z]+://', src, re.I) or src.startswith('data:'):
        return None
    src = src.split('?')[0].split('#')[0]
    cands = [src, os.path.basename(src)]
    from urllib.parse import unquote
    cands += [unquote(c) for c in cands]
    for c in cands:
        p = os.path.join(ctx.root, 'in', c)
        if os.path.isfile(p):
            return '/in/' + c
    low = {f.lower(): f for f in ctx.inputs}
    for c in cands:
        if os.path.basename(c).lower() in low:
            return '/in/' + low[os.path.basename(c).lower()]
    return None


def image_call(ctx, alt, src, inline=False):
    p = find_image(ctx, src)
    ext = os.path.splitext(src.split('?')[0])[1].lower()
    if not p or ext not in ('.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'):
        note('图片 %s 找不到或格式不支持，已改成文字' % (src if len(src) < 60 else src[:57] + '...'))
        return None
    if inline:
        return '#box(image(%s, height: 1.2em));' % tstr(p)
    return 'fig(%s)' % tstr(p)


def join_ft(parts):
    out = []
    for kind, s in parts:
        out.append(s)
    return ''.join(out)


def inline(s, ctx, depth=0):
    parts = []   # (kind, str)
    buf = []

    def flush():
        if buf:
            parts.append(('t', esc(''.join(buf))))
            del buf[:]

    def emit(kind, code):
        flush()
        parts.append((kind, code))

    i, n = 0, len(s)
    while i < n:
        c = s[i]
        if c == '\\' and i + 1 < n and s[i + 1] in PUNCT:
            buf.append(s[i + 1])
            i += 2
            continue
        if c == '\x00':   # hard line break marker
            emit('t', '\\\n')
            i += 1
            continue
        if c == BT:
            j = i
            while j < n and s[j] == BT:
                j += 1
            k = j - i
            m = re.compile('(?<!' + BT + ')' + BT * k + '(?!' + BT + ')').search(s, j)
            if m:
                code = s[j:m.start()].replace('\n', ' ')
                if code.startswith(' ') and code.endswith(' ') and code.strip():
                    code = code[1:-1]
                emit('f', '#raw(%s);' % tstr(code))
                i = m.end()
                continue
            buf.append(s[i:j])
            i = j
            continue
        if c == '$':
            dbl = s.startswith('$$', i)
            q = 2 if dbl else 1
            j = i + q
            end = -1
            while j < n:
                if s[j] == '\\':
                    j += 2
                    continue
                if s.startswith('$' * q, j):
                    end = j
                    break
                j += 1
            body = s[i + q:end] if end > 0 else ''
            ok = end > 0 and body.strip() and not body[0].isspace() and not body[-1].isspace() and not (end + q < n and s[end + q].isdigit())
            if dbl and end > 0 and body.strip():
                ok = True
            if ok:
                kind, code = math_inline(body)
                emit(kind, code)
                i = end + q
                continue
            buf.append('$')
            i += 1
            continue
        if c == '!' and s.startswith('![', i):
            m = re.match(r'!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)', s[i:])
            if m:
                call = image_call(ctx, m.group(1), m.group(2), inline=True)
                if call:
                    emit('f', call)
                else:
                    buf.append('[' + (m.group(1) or '图') + ']')
                i += m.end()
                continue
        if c == '[':
            if s.startswith('[^', i):
                m = re.match(r'\[\^([^\]\s]+)\]', s[i:])
                if m and m.group(1) in ctx.fn:
                    emit('f', '#footnote[%s];' % inline(ctx.fn[m.group(1)], ctx, depth + 1))
                    i += m.end()
                    continue
            # find matching bracket
            d, j = 0, i
            while j < n:
                if s[j] == '\\':
                    j += 2
                    continue
                if s[j] == BT:
                    k = s.find(BT, j + 1)
                    if k > 0:
                        j = k + 1
                        continue
                if s[j] == '[':
                    d += 1
                elif s[j] == ']':
                    d -= 1
                    if d == 0:
                        break
                j += 1
            if j < n and d == 0:
                text = s[i + 1:j]
                m = re.match(r'\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)', s[j + 1:])
                url = None
                end = j + 1
                if m:
                    url = m.group(1)
                    end = j + 1 + m.end()
                else:
                    m2 = re.match(r'\[([^\]]*)\]', s[j + 1:])
                    if m2:
                        key = (m2.group(1) or text).lower()
                        if key in ctx.refs:
                            url = ctx.refs[key]
                            end = j + 1 + m2.end()
                    elif text.lower() in ctx.refs:
                        url = ctx.refs[text.lower()]
                if url is not None and depth < 6:
                    inner = inline(text, ctx, depth + 1) if text else esc(url)
                    if re.match(r'^(https?://|mailto:)', url):
                        emit('f', '#link(%s)[%s];' % (tstr(url), inner))
                    else:
                        emit('t', inner)
                    i = end
                    continue
            buf.append('[')
            i += 1
            continue
        if c == '<':
            m = re.match(r'<((?:https?://|mailto:)[^>\s]+)>', s[i:])
            if m:
                emit('f', '#link(%s)[%s];' % (tstr(m.group(1)), esc(m.group(1))))
                i += m.end()
                continue
            m = re.match(r'<br\s*/?>', s[i:], re.I)
            if m:
                emit('t', '\\\n')
                i += m.end()
                continue
            m = re.match(r'</?[A-Za-z][^>]*>|<!--.*?-->', s[i:], re.S)
            if m:
                i += m.end()
                continue
            buf.append('<')
            i += 1
            continue
        if c == 'h' and (s.startswith('http://', i) or s.startswith('https://', i)) and (i == 0 or not s[i - 1].isalnum()):
            m = URL_RE.match(s, i)
            if m:
                url = m.group(0).rstrip('.,;:!?)')
                emit('f', '#link(%s)[%s];' % (tstr(url), esc(url)))
                i += len(url)
                continue
        if c == '~' and s.startswith('~~', i):
            j = s.find('~~', i + 2)
            if j > 0 and s[i + 2:j].strip():
                emit('f', '#strike[%s];' % inline(s[i + 2:j], ctx, depth + 1))
                i = j + 2
                continue
        if c in '*_':
            j = i
            while j < n and s[j] == c:
                j += 1
            run = j - i
            L = min(run, 3)
            prev = s[i - 1] if i > 0 else ' '
            nxt = s[j] if j < n else ' '
            ok = not nxt.isspace() and not (c == '_' and (prev.isalnum() and ord(prev) < 128))
            if ok:
                k = j
                found = -1
                while k < n:
                    if s[k] == '\\':
                        k += 2
                        continue
                    if s[k] == BT:
                        e = s.find(BT, k + 1)
                        if e > 0:
                            k = e + 1
                            continue
                    if s[k] == c:
                        r = k
                        while r < n and s[r] == c:
                            r += 1
                        rl = r - k
                        before = s[k - 1] if k > 0 else ' '
                        after = s[r] if r < n else ' '
                        good = not before.isspace() and not (c == '_' and after.isalnum() and ord(after) < 128)
                        if good and ((L == 1 and rl == 1) or (L == 2 and rl == 2) or (L == 3 and rl >= 3)):
                            found = k
                            break
                        k = r
                        continue
                    k += 1
                if found > 0 and found > j:
                    inner = inline(s[j:found], ctx, depth + 1)
                    if L == 1:
                        emit('f', '#emph[%s];' % inner)
                    elif L == 2:
                        emit('f', '#strong[%s];' % inner)
                    else:
                        emit('f', '#strong[#emph[%s]];' % inner)
                    i = found + L
                    continue
            buf.append(s[i:j])
            i = j
            continue
        buf.append(c)
        i += 1
    flush()
    out = []
    for idx, (kind, code) in enumerate(parts):
        out.append(code)
    return ''.join(out)


# ---------------------------------------------------------------- blocks
def indent_of(line):
    return len(line) - len(line.lstrip(' '))


FENCE = re.compile(r'^\s{0,3}(' + BT + r'{3,}|~{3,})\s*([^\s' + BT + r']*)')
HEAD = re.compile(r'^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$')
HR = re.compile(r'^\s{0,3}([-*_])(?:\s*\1){2,}\s*$')
LIST = re.compile(r'^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$')
SEP = re.compile(r'^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$')


def split_row(line):
    line = line.strip()
    if line.startswith('|'):
        line = line[1:]
    if line.endswith('|') and not line.endswith('\\|'):
        line = line[:-1]
    cells, cur, i, tick, dollar = [], [], 0, False, False
    while i < len(line):
        c = line[i]
        if c == '\\' and i + 1 < len(line):
            cur.append(line[i:i + 2])
            i += 2
            continue
        if c == BT:
            tick = not tick
        elif c == '$' and not tick:
            dollar = not dollar
        if c == '|' and not tick and not dollar:
            cells.append(''.join(cur).strip())
            cur = []
        else:
            cur.append(c)
        i += 1
    cells.append(''.join(cur).strip())
    return [c.replace('\\|', '|') for c in cells]


def starts_block(line, nxt=None):
    if FENCE.match(line) or HEAD.match(line) or HR.match(line) or line.lstrip().startswith('>') or line.strip().startswith('$$'):
        return True
    m = LIST.match(line)
    if m and (m.group(2) in '-*+' or m.group(2).rstrip('.)') == '1'):
        return True
    if '|' in line and nxt is not None and SEP.match(nxt) and '-' in nxt and ('|' in nxt):
        return True
    return False


def parse_blocks(lines, ctx):
    blocks = []
    i, n = 0, len(lines)
    while i < n:
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        m = FENCE.match(line)
        if m:
            fence, lang = m.group(1), m.group(2)
            ind = indent_of(line)
            body = []
            i += 1
            while i < n:
                if re.match(r'^\s{0,3}' + re.escape(fence[0]) + '{' + str(len(fence)) + r',}\s*$', lines[i]):
                    i += 1
                    break
                body.append(lines[i][min(ind, indent_of(lines[i])):])
                i += 1
            blocks.append(('code', re.sub(r'[^A-Za-z0-9_+#.-]', '', lang or ''), '\n'.join(body)))
            continue
        st = line.strip()
        if st.startswith('$$') or st == '\\[':
            close = '$$' if st.startswith('$$') else '\\]'
            first = st[2:] if st.startswith('$$') else st[2:]
            if close in first:
                body = first[:first.index(close)]
                i += 1
            else:
                body = [first]
                i += 1
                while i < n:
                    if close in lines[i]:
                        body.append(lines[i][:lines[i].index(close)])
                        i += 1
                        break
                    body.append(lines[i])
                    i += 1
                body = '\n'.join(body)
            blocks.append(('math', body))
            continue
        m = HEAD.match(line)
        if m:
            blocks.append(('h', len(m.group(1)), m.group(2)))
            i += 1
            continue
        if HR.match(line):
            blocks.append(('hr',))
            i += 1
            continue
        if re.match(r'^\s*<!--.*-->\s*$', line):
            i += 1
            continue
        if re.match(r'^\s*<!--', line):
            while i < n and '-->' not in lines[i]:
                i += 1
            i += 1
            continue
        m = re.match(r'^\s{0,3}\[\^([^\]\s]+)\]:\s*(.*)$', line)
        if m:
            txt = [m.group(2)]
            i += 1
            while i < n and lines[i].strip() and (indent_of(lines[i]) >= 2):
                txt.append(lines[i].strip())
                i += 1
            ctx.fn[m.group(1)] = ' '.join(txt)
            continue
        m = re.match(r'^\s{0,3}\[([^\]^][^\]]*)\]:\s*(\S+)', line)
        if m:
            ctx.refs[m.group(1).lower()] = m.group(2).strip('<>')
            i += 1
            continue
        if line.lstrip().startswith('>'):
            q = []
            while i < n and lines[i].lstrip().startswith('>'):
                q.append(re.sub(r'^\s*> ?', '', lines[i]))
                i += 1
            blocks.append(('quote', parse_blocks(q, ctx)))
            continue
        if '|' in line and i + 1 < n and SEP.match(lines[i + 1]) and '|' in lines[i + 1] + line:
            head = split_row(line)
            seps = split_row(lines[i + 1])
            if len(seps) == len(head) and all(re.fullmatch(r':?-+:?', x) for x in seps):
                aligns = ['center' if x.startswith(':') and x.endswith(':') else 'right' if x.endswith(':') else 'left' for x in seps]
                i += 2
                rows = []
                while i < n and lines[i].strip() and '|' in lines[i] and not HEAD.match(lines[i]):
                    rows.append(split_row(lines[i]))
                    i += 1
                blocks.append(('table', head, aligns, rows))
                continue
        m = LIST.match(line)
        if m:
            base = len(m.group(1))
            ordered = m.group(2)[0].isdigit()
            start = int(re.match(r'\d+', m.group(2)).group(0)) if ordered else 1
            items = []
            while i < n:
                if items:
                    j = i
                    while j < n and not lines[j].strip():
                        j += 1
                    mj = LIST.match(lines[j]) if j < n else None
                    if mj and len(mj.group(1)) <= base + 1 and len(mj.group(1)) >= base and not HR.match(lines[j]):
                        i = j
                m = LIST.match(lines[i])
                if not m or len(m.group(1)) > base + 1 and items or (m.group(2)[0].isdigit()) != ordered or len(m.group(1)) < base:
                    break
                if HR.match(lines[i]):
                    break
                cont = len(m.group(1)) + len(m.group(2)) + 1
                body = [m.group(3)]
                i += 1
                while i < n:
                    ln = lines[i]
                    if not ln.strip():
                        j = i
                        while j < n and not lines[j].strip():
                            j += 1
                        if j < n and indent_of(lines[j]) > base and not (LIST.match(lines[j]) and indent_of(lines[j]) <= base):
                            body.extend([''] * (j - i))
                            i = j
                            continue
                        break
                    ind = indent_of(ln)
                    if LIST.match(ln) and ind <= base:
                        break
                    if ind > base:
                        body.append(ln[min(ind, cont):])
                        i += 1
                        continue
                    if starts_block(ln, lines[i + 1] if i + 1 < n else None):
                        break
                    body.append(ln.strip())
                    i += 1
                task = None
                mm = re.match(r'^\[([ xX])\]\s+(.*)$', body[0])
                if mm:
                    task = mm.group(1) != ' '
                    body[0] = mm.group(2)
                items.append((task, parse_blocks(body, ctx)))
            blocks.append(('ol' if ordered else 'ul', start, items))
            continue
        # paragraph
        para = [line]
        i += 1
        while i < n and lines[i].strip() and not starts_block(lines[i], lines[i + 1] if i + 1 < n else None):
            para.append(lines[i])
            i += 1
        blocks.append(('p', para))
    return blocks


def join_para(para):
    out = ''
    for k, ln in enumerate(para):
        t = ln.strip()
        hard = ln.endswith('  ') or ln.endswith('\\') and not ln.endswith('\\\\')
        if ln.endswith('\\') and not ln.endswith('\\\\'):
            t = t[:-1]
        if k:
            prev = out[-1:] if out and out[-1] != '\x00' else ''
            if out.endswith('\x00'):
                pass
            elif CJK.match(prev or ' ') or CJK.match(t[:1] or ' '):
                pass
            else:
                out += ' '
        out += t
        if hard and k < len(para) - 1:
            out += '\x00'
    return out


def table_code(b, ctx):
    head, aligns, rows = b[1], b[2], b[3]
    nc = max(len(head), len(aligns))
    pad = lambda r: (r + [''] * nc)[:nc]
    head = pad(head)
    rows = [pad(r) for r in rows]
    lens = []
    for c in range(nc):
        lens.append(max([len(re.sub('[*_' + BT + r'\[\]]', '', head[c]))] + [len(re.sub('[*_' + BT + r'\[\]]', '', r[c])) for r in rows] + [2]))
    wlen = [min(l, 30) for l in lens]
    if sum(wlen) > 44:
        cols = ', '.join('%.1ffr' % max(w, 4) for w in wlen)
    else:
        cols = ', '.join(['auto'] * nc)
    al = ', '.join((aligns + ['left'] * nc)[:nc])
    out = ['#table(', '  columns: (%s),' % cols, '  align: (%s),' % al]
    out.append('  table.header(' + ', '.join('[#strong[%s]]' % inline(c, ctx) for c in head) + '),')
    for r in rows:
        out.append('  ' + ', '.join('[%s]' % inline(c, ctx) for c in r) + ',')
    out.append('  table.hline(stroke: 0.7pt),')
    out.append(')')
    return '\n'.join(out)


def render(blocks, ctx, top=False):
    out = []
    for b in blocks:
        k = b[0]
        if k == 'p':
            txt = join_para(b[1])
            m = re.fullmatch(r'!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"([^"]*)")?\s*\)', txt.strip())
            if m:
                call = image_call(ctx, m.group(1), m.group(2))
                if call:
                    cap = m.group(1) or m.group(3) or ''
                    if cap:
                        out.append('#figure(%s, caption: [%s]);' % (call, inline(cap, ctx)))
                    else:
                        out.append('#figure(%s);' % call)
                else:
                    out.append('#align(center)[#text(fill: luma(120))[[图：%s]]]' % esc(m.group(1) or m.group(2)))
                continue
            out.append(inline(txt, ctx))
        elif k == 'h':
            out.append('#heading(level: %d)[%s]' % (b[1], inline(b[2], ctx)))
        elif k == 'code':
            lang = ', lang: %s' % tstr(b[1]) if b[1] else ''
            out.append('#raw(block: true%s, %s)' % (lang, tstr(b[2])))
        elif k == 'math':
            out.append(math_block(b[1]))
        elif k == 'quote':
            out.append('#bq[\n%s\n]' % render(b[1], ctx))
        elif k == 'hr':
            out.append('#line(length: 100%, stroke: 0.5pt + luma(180))')
        elif k == 'table':
            out.append(table_code(b, ctx))
        elif k in ('ul', 'ol'):
            items = []
            for task, sub in b[2]:
                body = render(sub, ctx)
                if task is not None:
                    body = ('☑ ' if task else '☐ ') + body
                items.append('[%s]' % body)
            if k == 'ul':
                out.append('#list(' + ', '.join(items) + ')')
            else:
                out.append('#enum(start: %d, ' % b[1] + ', '.join(items) + ')')
    return '\n\n'.join(out)


# ---------------------------------------------------------------- document assembly
def front_matter(text):
    fm = {}
    m = re.match(r'^\ufeff?---\s*\n(.*?)\n---\s*(\n|$)', text, re.S)
    if not m:
        return fm, text
    for ln in m.group(1).split('\n'):
        mm = re.match(r'^([A-Za-z_]+)\s*:\s*(.*)$', ln)
        if mm:
            fm[mm.group(1).lower()] = mm.group(2).strip().strip('"\'')
    return fm, text[m.end():]


def plain_inline(s):
    s = re.sub(r'!\[[^\]]*\]\([^)]*\)', '', s)
    s = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', s)
    return re.sub('[*_' + BT + '~]', '', s).strip()


THEMES = {
    'report': dict(font='("Noto Sans CJK SC", "DejaVu Sans")', mono='("DejaVu Sans Mono", "Noto Sans Mono CJK SC", "Noto Sans CJK SC")',
                   accent='rgb("#1f4e79")', size='10.5pt', lead='0.85em', spacing='0.95em', indent='0pt', justify='true',
                   margin='(x: 2.4cm, top: 2.7cm, bottom: 2.5cm)'),
    'paper': dict(font='("Libertinus Serif", "Noto Serif CJK SC", "Noto Serif CJK JP")', mono='("DejaVu Sans Mono", "Noto Sans Mono CJK SC")',
                  accent='black', size='10.5pt', lead='0.75em', spacing='0.7em', indent='2em', justify='true',
                  margin='(x: 2.3cm, top: 2.6cm, bottom: 2.4cm)'),
    'note': dict(font='("Noto Sans CJK SC", "DejaVu Sans")', mono='("DejaVu Sans Mono", "Noto Sans Mono CJK SC", "Noto Sans CJK SC")',
                 accent='rgb("#2f7d6d")', size='11pt', lead='0.95em', spacing='1.05em', indent='0pt', justify='false',
                 margin='(x: 2.3cm, top: 2.3cm, bottom: 2.2cm)'),
}


def preamble(a, zh, title, short, author, numbering, cols):
    t = THEMES[a.style]
    L = lambda zh_, en_: zh_ if zh else en_
    sty = a.style
    lang = '"zh", region: "cn"' if zh else '"en"'
    quotes = ''
    if zh:
        if sty == 'paper':
            quotes = '#show regex("[\u2018\u2019\u201c\u201d]"): set text(font: "Noto Serif CJK SC")\n'
    head_size = {'report': ('16pt', '13pt', '11.5pt'), 'paper': ('13pt', '11.5pt', '10.5pt'), 'note': ('16pt', '13pt', '11.5pt')}[sty]
    o = []
    o.append('#set document(title: %s, author: %s)' % (tstr(title or ''), tstr(author or '')))
    o.append('#let accent = %s' % t['accent'])
    o.append('#let hdrfill = %s' % ('accent.lighten(88%)' if sty != 'paper' else 'none'))
    o.append('#set text(font: %s, size: %s, lang: %s, fill: %s)' % (t['font'], t['size'], lang, 'luma(20)' if sty != 'note' else 'luma(35)'))
    o.append('#set par(leading: %s, spacing: %s, justify: %s%s)' % (t['lead'], t['spacing'], t['justify'],
             (', first-line-indent: (amount: %s, all: true)' % t['indent']) if (zh and t['indent'] != '0pt') else ''))
    head = ''
    if title:
        right = tstr(author) if (author and sty != 'paper') else '""'
        head = ('context { if counter(page).get().first() > 1 { set text(size: 8.5pt, fill: luma(110)); [%s #h(1fr) #%s]; v(-5pt); line(length: 100%%, stroke: 0.4pt + luma(190)) } }'
                % (esc(short or title), right))
    foot = 'context { align(%s, text(size: 9pt, fill: luma(100))[#counter(page).display("1 / 1", both: true)]) }' % ('right' if sty == 'note' else 'center')
    o.append('#set page(paper: "a4", margin: %s, %s footer: %s)' % (t['margin'], ('header: %s,' % head) if head else '', foot))
    if numbering:
        o.append('#set heading(numbering: "1.1")' if sty != 'note' else '#set heading(numbering: "1.")')
    o.append('#show heading: set text(font: %s)' % t['font'])
    if sty == 'report':
        o.append('#show heading.where(level: 1): it => {\n  v(0.9em, weak: true)\n  block(width: 100%%, below: 0.8em, stroke: (bottom: 0.8pt + accent), inset: (bottom: 5pt))[#set text(size: %s, weight: "bold", fill: accent); #it]\n}' % head_size[0])
        o.append('#show heading.where(level: 2): it => block(above: 1.3em, below: 0.7em)[#set text(size: %s, weight: "bold", fill: accent); #it]' % head_size[1])
        o.append('#show heading.where(level: 3): it => block(above: 1.1em, below: 0.6em)[#set text(size: %s, weight: "bold"); #it]' % head_size[2])
    elif sty == 'paper':
        o.append('#show heading.where(level: 1): it => block(above: 1.5em, below: 0.9em)[#set text(size: %s, weight: "bold"); #it]' % head_size[0])
        o.append('#show heading.where(level: 2): it => block(above: 1.2em, below: 0.7em)[#set text(size: %s, weight: "bold"); #it]' % head_size[1])
        o.append('#show heading.where(level: 3): it => block(above: 1em, below: 0.6em)[#set text(size: %s, weight: "bold", style: "italic"); #it]' % head_size[2])
    else:
        o.append('#show heading.where(level: 1): it => block(above: 1.6em, below: 0.8em)[#set text(size: %s, weight: "bold", fill: accent); #box(width: 4pt, height: 0.85em, fill: accent, baseline: 0.05em); #h(6pt); #if it.numbering != none [#counter(heading).display(it.numbering)#h(0.5em)]#it.body]' % head_size[0])
        o.append('#show heading.where(level: 2): it => block(above: 1.3em, below: 0.7em)[#set text(size: %s, weight: "bold", fill: accent); #it]' % head_size[1])
        o.append('#show heading.where(level: 3): it => block(above: 1.1em, below: 0.6em)[#set text(size: %s, weight: "bold"); #it]' % head_size[2])
    o.append('#set heading(numbering: none)' if not numbering else '')
    o.append('#show raw: set text(font: %s, size: 0.88em)' % t['mono'])
    o.append('#show raw.where(block: false): it => box(fill: luma(240), inset: (x: 3pt), outset: (y: 3pt), radius: 2pt, it)')
    o.append('#show raw.where(block: true): it => block(width: 100%%, fill: luma(%s), inset: 9pt, radius: 3pt, stroke: 0.4pt + luma(215), breakable: true, it)' % ('246' if sty != 'note' else '244'))
    o.append('#show link: set text(fill: rgb("#1a5fb4"))')
    o.append('#set list(indent: 0.6em, body-indent: 0.5em, spacing: 0.7em)')
    o.append('#set enum(indent: 0.6em, body-indent: 0.5em, spacing: 0.7em)')
    o.append('#set table(inset: (x: 7pt, y: 5.5pt), fill: (x, y) => if y == 0 { hdrfill }, stroke: %s)' % (
        '(x, y) => (top: if y == 0 { 0.9pt } else if y == 1 { 0.5pt }, bottom: none)' if sty == 'paper' else '0.5pt + luma(205)'))
    o.append('#show table: set par(justify: false, first-line-indent: 0pt)')
    o.append('#show table: set text(size: 0.95em)')
    o.append('#show table: it => block(breakable: true, above: 1em, below: 1em, it)')
    o.append('#set figure(supplement: [%s])' % L('图', 'Figure'))
    o.append('#show figure.caption: set text(size: 9.5pt, fill: luma(80))')
    o.append('#show figure: set block(above: 1.2em, below: 1.2em)')
    o.append('#show footnote.entry: set text(size: 8.5pt)')
    o.append('#let bq(body) = block(width: 100%%, inset: (left: 12pt, y: 6pt, right: 6pt), stroke: (left: 2.5pt + %s), fill: luma(247), above: 1em, below: 1em, { set par(first-line-indent: 0pt); set text(fill: luma(60)); body })' % ('luma(150)' if sty == 'paper' else 'accent'))
    o.append('#let fig(path) = layout(size => { let im = image(path); let d = measure(im); let s = calc.min(0.86 * size.width / d.width, 9.5cm / d.height, 1.6); align(center, image(path, width: d.width * s)) })')
    o.append(quotes)
    o.append('')
    return '\n'.join(x for x in o if x != '')


def build(a):
    global PLAIN_MATH
    PLAIN_MATH = a.plain_math
    text = open(a.input, encoding='utf-8', errors='replace').read().replace('\r\n', '\n').replace('\r', '\n').replace('\t', '    ')
    fm, text = front_matter(text)
    root = a.root
    inputs = sorted(os.listdir(os.path.join(root, 'in'))) if os.path.isdir(os.path.join(root, 'in')) else []
    ctx = Ctx(root, inputs)
    blocks = parse_blocks(text.split('\n'), ctx)
    title = a.title or fm.get('title') or ''
    subtitle = a.subtitle or fm.get('subtitle') or ''
    author = a.author or fm.get('author') or ''
    date = a.date if a.date is not None else fm.get('date')
    if blocks and not title:
        for k, b in enumerate(blocks):
            if b[0] == 'h' and b[1] == 1:
                title = plain_inline(b[2])
                blocks.pop(k)
                if k < len(blocks) and blocks[k][0] == 'p' and not subtitle and len(blocks[k][1]) == 1 and len(blocks[k][1][0]) < 60 and blocks[k][1][0].startswith(('*', '_')):
                    subtitle = plain_inline(blocks[k][1][0])
                    blocks.pop(k)
                break
            if b[0] != 'h':
                break
    hs = [b[1] for b in blocks if b[0] == 'h']
    shift = (min(hs) - 1) if hs else 0
    blocks = [('h', b[1] - shift, b[2]) if b[0] == 'h' else b for b in blocks]
    sample = text[:4000] + title
    zh = len(CJK.findall(sample)) > 0.04 * max(len(sample), 1) if True else False
    if fm.get('lang') in ('zh', 'en'):
        zh = fm['lang'] == 'zh'
    if date is None:
        date = (datetime.datetime.utcnow() + datetime.timedelta(hours=8)).date().strftime('%Y年%m月%d日' if zh else '%Y-%m-%d')
    if date.strip().lower() in ('none', '无', '-', ''):
        date = ''
    cols = a.columns if a.style == 'paper' else 1
    numbering = (not a.no_numbering) and a.style != 'note' or (a.style == 'note' and not a.no_numbering and False)
    if a.style == 'note' and fm.get('numbering', '') in ('true', '1', 'yes'):
        numbering = True
    own = [b for b in blocks if b[0] == 'h' and re.match(r'^\s*(\d+([.\uff0e]\d+)*[\s.\u3001\uff0e)]|[\u4e00-\u9fa5]{1,3}[\u3001\uff0e]|\u7b2c[\u4e00-\u9fa5\d]+[\u7ae0\u8282\u90e8\u5206]|[IVX]+\.)', plain_inline(b[2]))]
    if hs and len(own) * 2 >= len(hs):
        numbering = False
        note('标题已经带编号，没有再自动编号')
    short = a.short_title or fm.get('short_title') or fm.get('short') or (title if len(title) <= 26 else title[:24] + '…')

    # paper: abstract and references
    body_blocks = blocks
    abstract = fm.get('abstract', '')
    abs_blocks = []
    if a.style == 'paper':
        nb = []
        k = 0
        while k < len(blocks):
            b = blocks[k]
            if b[0] == 'h' and re.fullmatch(r'(摘\s*要|内容摘要|abstract)[:：]?', plain_inline(b[2]), re.I) and not abs_blocks:
                k += 1
                while k < len(blocks) and blocks[k][0] != 'h':
                    abs_blocks.append(blocks[k])
                    k += 1
                continue
            if b[0] == 'h' and re.fullmatch(r'(参考文献|references?|bibliography)[:：]?', plain_inline(b[2]), re.I):
                k += 1
                refs = []
                while k < len(blocks) and blocks[k][0] != 'h':
                    bb = blocks[k]
                    if bb[0] in ('ol', 'ul'):
                        for _t, sub in bb[2]:
                            refs.append(render(sub, ctx))
                    elif bb[0] == 'p':
                        refs.append(inline(join_para(bb[1]), ctx))
                    k += 1
                nb.append(('refs', plain_inline(b[2]), refs))
                continue
            nb.append(b)
            k += 1
        body_blocks = nb
    # render
    out = [preamble(a, zh, title, short, author, numbering, cols)]
    if title:
        if a.style == 'paper':
            out.append('#align(center)[\n  #block(below: 0.7em)[#text(size: 17pt, weight: "bold")[%s]]\n%s%s%s]\n' % (
                inline(title, ctx),
                ('  #text(size: 11pt, style: "italic")[%s] \\\n' % inline(subtitle, ctx)) if subtitle else '',
                ('  #v(4pt) #text(size: 11pt)[%s]\n' % inline(author, ctx)) if author else '',
                ('  #v(2pt) #text(size: 9.5pt, fill: luma(90))[%s]\n' % esc(date)) if date else ''))
        elif a.style == 'note':
            out.append('#block(below: 1.4em)[\n  #text(size: 21pt, weight: "bold", fill: accent)[%s]\n%s  #v(2pt)\n  #line(length: 3.2cm, stroke: 2.2pt + accent)\n%s]\n' % (
                inline(title, ctx),
                ('  #v(2pt) #text(size: 12pt, fill: luma(100))[%s]\n' % inline(subtitle, ctx)) if subtitle else '',
                ('  #v(2pt) #text(size: 9.5pt, fill: luma(110))[%s]\n' % esc(' · '.join(x for x in (author, date) if x))) if (author or date) else ''))
        else:
            meta = ' #h(1.2em) '.join(x for x in ((esc(author) if author else ''), (esc(date) if date else '')) if x)
            out.append('#block(width: 100%%, below: 1.6em)[\n  #text(size: 25pt, weight: "bold", fill: accent)[%s] \\\n%s  #v(6pt)\n  #line(length: 100%%, stroke: 1.4pt + accent)\n%s]\n' % (
                inline(title, ctx),
                ('  #v(3pt) #text(size: 13pt, fill: luma(90))[%s]\n' % inline(subtitle, ctx)) if subtitle else '',
                ('  #v(1pt) #text(size: 10pt, fill: luma(100))[%s]\n' % meta) if meta else ''))
    if a.style == 'paper' and (abs_blocks or abstract):
        kw = fm.get('keywords') or fm.get('关键词') or ''
        absbody = render(abs_blocks, ctx) if abs_blocks else inline(abstract, ctx)
        out.append('#align(center)[#block(width: 90%%)[\n  #set par(first-line-indent: 0pt, justify: true, leading: 0.65em)\n  #set text(size: 9.5pt)\n  #align(left)[#strong[%s] #h(0.6em) %s%s]\n]]\n' % (
            '摘要' if zh else 'Abstract', absbody.replace('\n\n', ' '), ('\\\n#strong[%s] #h(0.6em) %s' % ('关键词：' if zh else 'Keywords: ', esc(kw))) if kw else ''))
    if a.toc:
        out.append('#outline(title: %s, depth: 3, indent: 1.2em)\n%s' % (tstr('目录' if zh else 'Contents'), '#pagebreak(weak: true)\n' if len(hs) > 12 else '#v(0.8em)\n'))
    if cols == 2:
        out.append('#show: rest => columns(2, gutter: 1.4em, rest)\n')
    rendered = []
    for b in body_blocks:
        if b[0] == 'refs':
            r = ['#heading(level: 1, numbering: none)[%s]' % esc(b[1]), '#set text(size: 9pt)']
            for n_, ref in enumerate(b[2], 1):
                ref = re.sub(r'^(\\\[\d+\\\]|\[\d+\])\s*', '', ref.strip())
                r.append('#par(hanging-indent: 2.2em, first-line-indent: 0pt)[\\[%d\\]#h(0.5em)%s]' % (n_, ref))
            rendered.append('\n\n'.join(r))
        else:
            rendered.append(render([b], ctx))
    out.append('// body\n' + '\n\n'.join(rendered) + '\n')
    for k in sorted(ctx.fn):
        pass
    open(a.output, 'w', encoding='utf-8').write('\n'.join(out))
    for m in sorted(set(MATH_BAD)):
        note('公式里的 %s 不认识，已原样显示' % m)
    for nline in NOTES:
        print('NOTE ' + nline)
    print('TITLE ' + (title or ''))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('input')
    ap.add_argument('output')
    ap.add_argument('--style', default='report', choices=['report', 'paper', 'note'])
    ap.add_argument('--title')
    ap.add_argument('--subtitle')
    ap.add_argument('--author')
    ap.add_argument('--date')
    ap.add_argument('--short-title', dest='short_title')
    ap.add_argument('--toc', action='store_true')
    ap.add_argument('--no-numbering', action='store_true')
    ap.add_argument('--columns', type=int, default=1)
    ap.add_argument('--plain-math', action='store_true')
    ap.add_argument('--root', default='.')
    build(ap.parse_args())
`;

const enc = new TextEncoder();
export const b64 = (s: string): string => {
  const bytes = enc.encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
/** Writes text to a file inside the run directory without a heredoc: base64 in small printf chunks, so quoting never matters. */
export const putFile = (path: string, text: string): string[] => {
  const data = b64(text), cmds = [`mkdir -p "$(dirname ${sh(path)})" && : > ${sh(path + ".b64")}`];
  for (let i = 0; i < data.length; i += 16000) cmds.push(`printf %s ${sh(data.slice(i, i + 16000))} >> ${sh(path + ".b64")}`);
  cmds.push(`base64 -d < ${sh(path + ".b64")} > ${sh(path)} && rm -f ${sh(path + ".b64")}`);
  return cmds;
};
export const TYPST_INSTALL =
  "command -v typst >/dev/null 2>&1 || { curl -fsSL https://github.com/typst/typst/releases/latest/download/typst-x86_64-unknown-linux-musl.tar.xz | tar -xJ --strip-components=1 -C /usr/local/bin --wildcards '*/typst'; }; command -v typst >/dev/null 2>&1 || { echo '排版引擎 Typst 装不上，请稍后再试' >&2; exit 1; }";
export const PY_PICK = "PY=$(command -v /opt/py/bin/python || command -v python3)";
/** Counts pages of a PDF without extra tools. */
export const PDF_PAGES = (pdf: string) =>
  `$($PY -c 'import re,sys;d=open(sys.argv[1],"rb").read();print(len(re.findall(rb"/Type\\s*/Page(?![s\\w])",d)))' ${sh(pdf)})`;
export const MAX_TEXT_BYTES = 150_000;
export const safeName = (s: unknown, fallback: string) => {
  const n = String(s ?? "").replace(/\.(pdf|pptx|typ|md)$/i, "").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return n || fallback;
};
export const truthy = (v: unknown) => v === true || v === "true" || v === "是" || v === 1 || v === "1";

/** The Markdown text: from the `markdown` argument (written to a file safely) or the first .md/.txt input file. */
export function markdownSource(args: SkillArgs, files: SkillFile[]): { path: string; cmds: string[] } {
  if (typeof args.markdown === "string" && args.markdown.trim()) {
    if (enc.encode(args.markdown).length > MAX_TEXT_BYTES) throw new Error("文字太长了，请把 Markdown 存成 .md 文件上传再处理");
    return { path: "in/_text.md", cmds: putFile("in/_text.md", args.markdown) };
  }
  const f = files.find((x) => /\.(md|markdown|txt)$/i.test(x.name));
  if (!f) throw new Error("请把 Markdown 正文放进 markdown 参数，或者上传一个 .md 文件");
  return { path: "in/" + f.name, cmds: [] };
}

const STYLES = ["report", "paper", "note"];
const skill: Skill = {
  name: "md-to-report",
  title: "Markdown 转排版 PDF",
  when:
    "把 Markdown 文字排成一份能直接交的 PDF：标题块、可选目录、章节编号、中英文混排、表格、代码块、引用、脚注、公式（$行内$ 和 $$独立公式$$，写 LaTeX 即可）、图片、页码和页眉。" +
    "正文直接放进 markdown 参数最省事（你手上已有文字时），也可以上传 .md 文件，文中的 ![](图片名) 指向一起上传的图片文件。" +
    "style 选 report（商务/技术报告，默认）、paper（论文：衬线字体，可双栏，「摘要」「参考文献」两节自动排成论文样式）、note（学习笔记，轻量）。" +
    "文档开头第一个 # 一级标题会当作文档标题；也可以用 title、subtitle、author、date 参数指定。返回 PDF 和 .typ 排版源文件。",
  args: {
    markdown: { type: "string", description: "Markdown 正文。有文字在手就直接填这里；用文件上传时可以不填。" },
    style: { type: "string", description: "排版风格：report 报告（默认）、paper 论文、note 笔记。", enum: STYLES },
    title: { type: "string", description: "文档标题。不填就用正文里第一个 # 标题。" },
    subtitle: { type: "string", description: "副标题，可不填。" },
    author: { type: "string", description: "作者，可不填。" },
    date: { type: "string", description: "日期，如 2026年11月15日。不填就用今天；填「无」则不显示日期。" },
    toc: { type: "boolean", description: "是否生成目录，默认不生成。" },
    numbering: { type: "boolean", description: "是否给章节自动编号，默认是（笔记风格默认否；标题里已经带编号时会自动不再编号）。" },
    columns: { type: "integer", description: "论文风格可选 2 表示双栏，默认 1。" },
    short_title: { type: "string", description: "页眉里显示的短标题，不填就用标题。" },
    name: { type: "string", description: "输出文件名（不含扩展名），不填就用「report」。" },
  },
  files: { min: 0, max: 30, extensions: ["md", "markdown", "txt", "png", "jpg", "jpeg", "gif", "svg", "webp"], what: "Markdown 文件，以及正文引用的图片" },
  timeoutSeconds: 240,
  commands(args, files) {
    const style = String(args.style || "report");
    if (!STYLES.includes(style)) throw new Error("style 只能是 report、paper、note 三种之一");
    const columns = args.columns == null || args.columns === "" ? 1 : Number(args.columns);
    if (columns !== 1 && columns !== 2) throw new Error("columns 只能是 1 或 2");
    for (const k of ["title", "subtitle", "author", "date", "short_title"]) if (args[k] != null && String(args[k]).length > 200) throw new Error(`${k} 太长了，请控制在 200 字以内`);
    const src = markdownSource(args, files);
    const name = safeName(args.name, "report");
    const opts = [
      `--style ${style}`,
      args.title ? `--title ${sh(args.title)}` : "",
      args.subtitle ? `--subtitle ${sh(args.subtitle)}` : "",
      args.author ? `--author ${sh(args.author)}` : "",
      args.date != null && String(args.date) !== "" ? `--date ${sh(args.date)}` : "",
      args.short_title ? `--short-title ${sh(args.short_title)}` : "",
      truthy(args.toc) ? "--toc" : "",
      args.numbering === false || args.numbering === "false" ? "--no-numbering" : "",
      columns === 2 ? "--columns 2" : "",
      "--root .",
    ].filter(Boolean).join(" ");
    const typ = `out/${name}.typ`, pdf = `out/${name}.pdf`;
    const conv = (extra: string) => `$PY .skill/md2typ.py ${sh(src.path)} ${sh(typ)} ${opts}${extra}`;
    const compile = `typst compile --root . ${sh(typ)} ${sh(pdf)} 2>.skill/err.txt`;
    return [
      "mkdir -p in out .skill",
      TYPST_INSTALL,
      ...putFile(".skill/md2typ.py", MD2TYP_PY),
      ...src.cmds,
      `${PY_PICK}; ${conv("")} && { ${compile} || { echo 'NOTE 公式排版出错，已改成普通文字显示公式'; ${conv(" --plain-math")} >/dev/null && ${compile} || { cat .skill/err.txt >&2; exit 1; }; }; } && echo PAGES=${PDF_PAGES(pdf)} && echo FILE=${sh(pdf)}`,
    ];
  },
  report(stdout) {
    const text = stdout.join("\n");
    const pages = Number(/PAGES=(\d+)/.exec(text)?.[1] || 0);
    const notes = [...text.matchAll(/^NOTE (.+)$/gm)].map((m) => m[1]);
    return { pages, ...(notes.length ? { notes } : {}) };
  },
};
export default skill;
