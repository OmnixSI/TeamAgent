"""C1: pushed commit excerpts and workspace statistics; never workspace content."""
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import ssl
import subprocess
import time
import urllib.request

try:
    from runner import gitsafe
    from runner.settings import settings
except ModuleNotFoundError:
    import gitsafe
    from settings import settings

H = Path.home() / '.inkboard-team'
MAX_PATCH_BYTES = 1_048_576
MAX_BODY = 900_000  # Paired with worker.ts /api/runner/repo_index's 1 MiB limit.
MAX_REFS = 60  # Pushed branches reported per repository; the default branch always fits.
MAX_WORKTREES = 60  # Directories examined per round, newest first, across every configured root.
PROJECTS_WORKTREES = ('Projects', '.worktrees')  # Team package worktrees live next to the home directory.
CLONE_TIMEOUT = 120
CLONE_BACKOFF = 1800.0
DENY = ('.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*', 'id_ed25519*',
        '.npmrc', '.netrc', '.pypirc', '*secret*', '*credential*', '*cookie*',
        'worker-secrets.json', '.git/*', '.dev.vars', 'wrangler.toml.local')
PATTERN = re.compile(r'gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|(?:SESSDATA|bili_jct|DedeUserID__ckMd5|auth_token|ct0)=[^;\s]+')
TOKEN_PATTERN = re.compile(
    r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b'
    r'|\bBearer\s+[A-Za-z0-9._~+/-]+=*'
    r'|\b(?:Cookie|Set-Cookie|Authorization)\s*:\s*[^\r\n]+'
    r'|[\"\']?\b(?:runner[_-]?token|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|'
    r'cookie|SESSDATA|bili_jct|DedeUserID__ckMd5|auth_token|ct0|session(?:id|_id))\b[\"\']?\s*[:=]\s*'
    r'(?:"[^"\r\n]*"|\'[^\'\r\n]*\'|[^\s;,\'"}]+)'
    r'|[\"\']?\b(?:sid|session)\b[\"\']?\s*[:=]\s*'
    r'(?:"[A-Za-z0-9_-]{32,}"|\'[A-Za-z0-9_-]{32,}\'|[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-]))', re.I)
_fetch_at = {}
_offset = 0
_backlog = False
_clone_at = {}
_cloned_round = False
CONFIG_SECRET_KEYS = frozenset(('admintoken', 'runnertoken', 'sourcekey', 'accesstoken', 'refreshtoken',
                              'apikey', 'deepseekapikey', 'clientsecret', 'qqappsecret', 'password', 'cookie',
                              'authorization', 'sessdata', 'bilijct', 'authtoken', 'ct0',
                              'token', 'secret', 'privatekey', 'credential', 'credentials', 'accesskey', 'secretkey', 'passwd'))


def _json(path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def _config():
    return _json(H / 'config.json', {})


def repo_root(repo):
    if repo not in settings()['repositories']:
        raise ValueError('Repository denied')
    return H / 'repos' / repo.split('/')[1]


def denied(path):
    path = path.lower()
    return '.git' in path.split('/') or any(fnmatch.fnmatchcase(path, rule) or fnmatch.fnmatchcase(path.rsplit('/', 1)[-1], rule) for rule in DENY)


def redact(text, known_values=()):
    # Only values the caller already holds in memory; never discover credentials.
    values = sorted({v for v in (known_values or ()) if isinstance(v, str) and v}, key=len, reverse=True)
    if values:
        text = re.sub('|'.join(re.escape(v) for v in values), '[REDACTED]', text)
    return PATTERN.sub('[REDACTED]', TOKEN_PATTERN.sub('[REDACTED]', text))


def _config_secrets(value, sensitive=False):
    # Exact credential names (including sync-runtime-secrets.py's config keys),
    # with short placeholders excluded; inspect only the already loaded config.
    if isinstance(value, dict):
        for key, item in value.items():
            yield from _config_secrets(item, sensitive or re.sub(r'[_-]', '', key).lower() in CONFIG_SECRET_KEYS)
    elif isinstance(value, list):
        for item in value:
            yield from _config_secrets(item, sensitive)
    elif sensitive and isinstance(value, str) and len(value) >= 16:
        yield value


def cut_bytes(s, n):
    return s.encode('utf-8')[:n].decode('utf-8', 'ignore')


def _git(root, *args, max_bytes=None):
    return gitsafe.run(root, 'read', *args, max_bytes=max_bytes)


def _default_ref(root):
    try:
        return _git(root, 'rev-parse', '--verify', '--symbolic-full-name', 'refs/remotes/origin/HEAD').strip()
    except gitsafe.GitFailed:
        for ref in ('refs/remotes/origin/main', 'refs/remotes/origin/master'):
            try:
                _git(root, 'rev-parse', '--verify', ref + '^{commit}')
                return ref
            except gitsafe.GitFailed:
                pass
    raise gitsafe.GitFailed('Remote default branch unavailable')


def tracked_refs(root):
    """Every pushed branch, default first and the rest newest first, capped at MAX_REFS."""
    default = _default_ref(root)
    rows = _git(root, 'for-each-ref', '--sort=-committerdate', '--format=%(refname) %(objectname)',
                'refs/remotes/origin').splitlines()
    refs = {}
    for row in rows:
        name, sep, sha = row.partition(' ')
        if sep and name != 'refs/remotes/origin/HEAD' and name not in refs:
            refs[name] = sha
    # The remote default branch outranks the newest of the rest when the cap binds.
    ordered = {default: refs[default]} if default in refs else {}
    ordered.update((name, sha) for name, sha in refs.items() if name not in ordered)
    return dict(list(ordered.items())[:MAX_REFS])


def _pending(root, st, heads):
    if not heads:
        return []
    base = []
    for sha in st.get('frontier', {}).values():
        try:
            _git(root, 'cat-file', '-e', sha + '^{commit}')
            base.append(sha)
        except gitsafe.GitFailed:
            pass
    args = ['rev-list', '--reverse', '--topo-order', '--since=90.days.ago', *dict.fromkeys(heads.values())]
    if base:
        args += ['--not', *dict.fromkeys(base)]
    acked = set(st.get('acked', []))
    return [sha for sha in _git(root, *args).splitlines() if sha not in acked]


def pending_commits(root, st):
    return _pending(root, st, tracked_refs(root))


def _numstat(text):
    parts = text.split('\0'); i = 0; result = []; statuses = {}
    while i < len(parts):
        part = parts[i]; i += 1
        if part.startswith(':'):
            status = part.split()[-1]
            path = parts[i]; i += 1
            if status.startswith(('R', 'C')):
                path = parts[i]; i += 1
            statuses[path] = status[0]
            continue
        match = re.match(r'^(\d+|-)\t(\d+|-)\t([\s\S]*)$', part)
        if not match:
            continue
        add, delete, path = match.groups()
        if not path:  # -z represents a rename with separate old/new names.
            path = parts[i + 1]; i += 2
        item = {'path':path, 'status':statuses.get(path, 'M'),
                'add':int(add) if add != '-' else None, 'del':int(delete) if delete != '-' else None}
        if denied(path):
            item['hidden'] = True
        result.append(item)
    return result


def _patch_paths(text):
    # Raw -z records and patch sections follow the same Git diff queue order.
    parts = text.split('\0'); i = 0; result = []
    while i < len(parts):
        part = parts[i]; i += 1
        if not part.startswith(':'):
            continue
        paths = [parts[i]]; i += 1
        if part.split()[-1].startswith(('R', 'C')):
            paths.append(parts[i]); i += 1
        result.append(paths)
    return result


def commit_record(root, sha, known_values=()):
    meta = _git(root, 'show', '--no-patch', '--format=%H%x00%at%x00%an%x00%s%x00%b', sha).split('\0', 4)
    # --raw adds actual file status alongside the same numstat; -z preserves names.
    stats = _git(root, 'show', '--raw', '--numstat', '-z', '--format=', '--diff-merges=first-parent', sha)
    files = _numstat(stats)[:100]
    try:
        raw = _git(root, 'show', '--patch', '--format=', '--diff-merges=first-parent', sha, max_bytes=MAX_PATCH_BYTES)
        truncated = False
    except gitsafe.GitOutputTooLarge:
        raw = ''
        truncated = True
    segments = []
    patches = [s for s in re.split(r'(?=^diff --git )', raw, flags=re.M) if s.startswith('diff --git ')]
    for paths, segment in zip(_patch_paths(stats) if not truncated else [], patches, strict=True):
        if any(denied(path) for path in paths):
            continue
        # Redact before cutting, too: a cut must not expose half a credential.
        safe = redact(segment, known_values)
        part = cut_bytes(safe, 4000); truncated |= part != safe
        segments.append(part)
    safe = ''.join(segments)
    patch = cut_bytes(safe, 12000); truncated |= patch != safe
    return {'sha':meta[0], 'at':int(meta[1])*1000, 'author':redact(meta[2], known_values), 'subject':redact(meta[3], known_values),
            'body':redact(meta[4].strip(), known_values)[:500], 'files':files, 'patch':patch, 'truncated':int(truncated)}


def branches(root):
    refs = tracked_refs(root); default = refs.get(_default_ref(root))
    rows = []
    for name, sha in list(refs.items())[:30]:
        ahead, behind = (0, 0) if not default else map(int, _git(root, 'rev-list', '--left-right', '--count', sha + '...' + default).split())
        at = int(_git(root, 'show', '--no-patch', '--format=%at', sha).strip()) * 1000
        rows.append({'name':name[len('refs/remotes/origin/'):], 'sha':sha, 'ahead':ahead, 'behind':behind, 'at':at})
    return rows


def _matches_remote(root, repo):
    remote = _git(root, 'config', '--get', 'remote.origin.url').strip()
    return remote in ('https://github.com/'+repo, 'https://github.com/'+repo+'.git', 'git@github.com:'+repo, 'git@github.com:'+repo+'.git')


def worktree_roots():
    """Parents scanned for worktrees; TEAM_INDEX_WORKTREE_ROOTS replaces the default set."""
    override = os.environ.get('TEAM_INDEX_WORKTREE_ROOTS', '')
    if override.strip():
        return [Path(part) for part in override.split(':') if part]
    extra = _config().get('index', {}).get('extra_worktree_roots', [])
    return [H/'work', *map(Path, extra), Path.home().joinpath(*PROJECTS_WORKTREES)]


def _worktree_candidates(roots):
    """Directories to inspect, newest first; Git calls start only after a cheap .git check."""
    seen = set(); found = []
    for parent in roots:
        parent = Path(parent).resolve()
        if not parent.is_dir():
            continue
        try:
            children = list(parent.iterdir())
        except OSError:
            continue
        for candidate in children:
            try:
                resolved = candidate.resolve()
            except OSError:
                continue
            if parent not in resolved.parents or resolved in seen or not resolved.is_dir():
                continue
            seen.add(resolved)
            if not (resolved/'.git').exists():
                continue
            try:
                mtime = resolved.stat().st_mtime
            except OSError:
                mtime = 0.0
            found.append((mtime, candidate, resolved))
    found.sort(key=lambda item: (-item[0], str(item[2])))
    return [(candidate, resolved) for _, candidate, resolved in found[:MAX_WORKTREES]]


def worktrees(roots, repo):
    result = []
    for candidate, resolved in _worktree_candidates(roots):
        try:
            _git(resolved, 'rev-parse', '--git-common-dir')
            if not _matches_remote(resolved, repo):
                continue
            changed = _git(resolved, 'status', '--porcelain=v1', '-z', '--untracked-files=all',
                           max_bytes=MAX_PATCH_BYTES).split('\0')
            stats = {f['path']:f for f in _numstat(_git(resolved, 'diff', '--numstat', '-z', 'HEAD', max_bytes=MAX_PATCH_BYTES))}
            files = []; i = 0
            while i < len(changed):
                line = changed[i]; i += 1
                if not line:
                    continue
                status, path = line[:2], line[3:]
                if 'R' in status or 'C' in status:
                    i += 1
                item = {'path':path, 'status':status, 'add':None, 'del':None}
                if status != '??' and path in stats:
                    item.update(add=stats[path]['add'], **{'del':stats[path]['del']})
                if denied(path):
                    item['hidden'] = True
                files.append(item)
            result.append({'label':candidate.name, 'branch':_git(resolved, 'rev-parse', '--abbrev-ref', 'HEAD').strip(),
                           'base':_git(resolved, 'rev-parse', 'HEAD').strip(), 'files':files[:100],
                           'untracked':sum(f['status']=='??' for f in files), 'updatedAt':int(time.time()*1000)})
        except gitsafe.GitFiltersConfigured:
            result.append({'label':candidate.name, 'skipReason':'filters_configured'})
        except (gitsafe.GitFailed, gitsafe.GitDenied):
            continue
        except TimeoutError:
            # One slow worktree must not consume the whole round's Git budget.
            break
        if len(result) == 20:
            break
    return result


def _clone_once(repo):
    """Try one bounded `gh repo clone`; failures back off per repository."""
    global _cloned_round
    now = time.monotonic()
    if _cloned_round or now - _clone_at.get(repo, float('-inf')) < CLONE_BACKOFF:
        return
    _cloned_round = True
    _clone_at[repo] = now
    target = H / 'repos' / repo.split('/')[1]
    try:
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        result = subprocess.run(['gh', 'repo', 'clone', repo, str(target), '--', '--quiet'],
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                timeout=CLONE_TIMEOUT, env=dict(os.environ, GIT_TERMINAL_PROMPT='0', GH_PROMPT_DISABLED='1'))
    except (OSError, subprocess.SubprocessError) as error:
        print(f'repo index: clone failed {repo} {type(error).__name__}', flush=True)
        return
    if result.returncode:
        print(f'repo index: clone failed {repo} exit {result.returncode}', flush=True)
        return
    print(f'repo index: cloned {repo}', flush=True)


def build(repo, st, budget, known_values=()):
    root = repo_root(repo)
    if not root.is_dir():
        _clone_once(repo)
        return None
    if not _matches_remote(root, repo):
        return None
    heads = tracked_refs(root)
    if not heads:
        return None
    pending = _pending(root, st, heads)
    default = _default_ref(root); sha = heads[default]
    local = worktrees(worktree_roots(), repo)
    fingerprint = hashlib.sha256(json.dumps([heads, [{k:v for k,v in w.items() if k != 'updatedAt'} for w in local]], sort_keys=True).encode()).hexdigest()
    return {'repo':repo, 'head':{'sha':sha, 'branch':default[len('refs/remotes/origin/'):], 'at':int(_git(root,'show','--no-patch','--format=%at',sha).strip())*1000},
            'commits':[commit_record(root,s,known_values) for s in pending[:budget]], 'branches':branches(root), 'worktrees':local,
            'fingerprint':fingerprint, 'pending_left':max(0,len(pending)-budget), '_heads':heads, '_pending':pending}


def _post(body, config):
    request = urllib.request.Request(config['url'].rstrip('/')+'/api/runner/repo_index', data=json.dumps(body,ensure_ascii=False).encode(),
                                     headers={'Authorization':'Bearer '+config['runnerToken'],'Content-Type':'application/json','User-Agent':'TeamAgent/2'})
    with urllib.request.urlopen(request, timeout=25, context=ssl.create_default_context(cafile='/etc/ssl/cert.pem' if Path('/etc/ssl/cert.pem').is_file() else None)) as response:
        return response.status


def _save(state):
    H.mkdir(mode=0o700, parents=True, exist_ok=True)
    temp = H / ('repo-index-state.tmp-'+secrets.token_hex(6))
    try:
        fd = os.open(temp, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd,'w') as stream:
            json.dump(state,stream,ensure_ascii=False)
        os.replace(temp,H/'repo-index-state.json')
    finally:
        temp.unlink(missing_ok=True)


def sync_once(now, known_values=()):
    global _offset, _backlog, _cloned_round
    _cloned_round = False
    config = _config()
    if config.get('index', {}).get('enabled', True) is False:
        return
    known_values = (*known_values, *_config_secrets(config))
    state = _json(H/'repo-index-state.json', {})
    repositories = list(settings()['repositories'])
    if not repositories:
        return
    start = _offset % len(repositories)
    repositories = (repositories[start:]+repositories[:start])[:8]
    body = {'repos':[]}; built = {}; remaining = 30; _backlog = False
    with gitsafe.time_budget(120):
        for repo in repositories:
            try:
                root = repo_root(repo)
                if root.is_dir() and _matches_remote(root, repo) and (repo not in _fetch_at or now-_fetch_at[repo] >= 120):
                    gitsafe.run(root,'lifecycle','fetch','--prune','origin'); _fetch_at[repo] = now
                st = state.get(repo, {})
                data = build(repo,st,remaining,known_values)
            except (gitsafe.GitFailed, TimeoutError, OSError) as error:
                print('repo index: repository unavailable',repo,type(error).__name__,flush=True)
                continue
            if not data:
                continue
            pending = data['_pending']; _backlog |= bool(pending)
            if not pending and data['fingerprint'] == st.get('fingerprint'):
                if now-st.get('sent_at',0) < 300:
                    continue
                item = {'repo':repo,'fingerprint':data['fingerprint'],'unchanged':True}
            else:
                item = {k:v for k,v in data.items() if not k.startswith('_') and k != 'commits'}
                item['commits'] = []
                item['pending_left'] = len(pending)
            body['repos'].append(item)
            if len(json.dumps(body,ensure_ascii=False).encode()) > MAX_BODY:
                body['repos'].pop(); break
            built[repo] = data
            full = False
            for record in data['commits'] if not item.get('unchanged') else []:
                item['commits'].append(record)
                if len(json.dumps(body,ensure_ascii=False).encode()) > MAX_BODY:
                    item['commits'].pop(); full=True; break
                remaining -= 1
            if not item.get('unchanged'):
                item['pending_left'] = len(pending)-len(item['commits'])
            if full:
                break
        if not body['repos']:
            _offset += 1  # Rotate anyway, so a missing clone cannot starve the others.
            return
        try:
            if _post(body,config) != 200:
                return
        except (OSError, TimeoutError):
            print('repo index: report unavailable',flush=True)
            return
        for item in body['repos']:
            repo = item['repo']; data = built[repo]; old = state.get(repo,{})
            acked = list(dict.fromkeys(old.get('acked',[]) + [c['sha'] for c in item.get('commits',[])]))
            outstanding = set(data['_pending'])-set(acked)
            state[repo] = {'frontier':old.get('frontier',{}) if outstanding else data['_heads'],
                           'acked':acked if outstanding else [], 'fingerprint':data['fingerprint'],'sent_at':now}
        _backlog = any(set(data['_pending'])-set(state[repo]['acked']) for repo,data in built.items() if state[repo]['frontier'] != data['_heads'])
        _save(state); _offset += 1


def loop():
    if _config().get('index',{}).get('enabled',True) is False:
        return
    while True:
        try:
            sync_once(time.time())
        except Exception as error:
            print('repo index',type(error).__name__,flush=True)
        time.sleep(10 if _backlog else 60)
