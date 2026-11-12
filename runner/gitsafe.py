"""Git command classes for indexing and private detached readers (K2).

The existing development executor keeps its own Git writer. Callers of this
module cannot commit/push, install hooks, or invoke repository diff helpers.
"""
from contextlib import contextmanager
import os
import re
from pathlib import Path
import subprocess
import tempfile
import threading
import time


class GitDenied(ValueError):
    pass


class GitFailed(RuntimeError):
    pass


PREFIX = ['git', '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
          '-c', 'diff.external=', '-c', 'core.pager=cat',
          '-c', 'core.sshCommand=/usr/bin/ssh -F /dev/null -oBatchMode=yes -oConnectTimeout=5',
          '-c', 'credential.helper=', '-c', 'protocol.ext.allow=never']
READ = {'log', 'show', 'rev-list', 'rev-parse', 'merge-base', 'for-each-ref',
        'status', 'diff', 'cat-file', 'ls-files', 'grep', 'config', 'worktree'}
_clock = threading.local()


@contextmanager
def time_budget(seconds=120):
    """Share one elapsed-time budget across all Git calls in an index round."""
    previous = getattr(_clock, 'deadline', None)
    deadline = time.monotonic() + seconds
    _clock.deadline = min(previous, deadline) if previous is not None else deadline
    try:
        yield
    finally:
        _clock.deadline = previous


def _private_target(root, target):
    base = Path.home().resolve() / '.inkboard-team/sub'
    path = Path(target)
    path = (path if path.is_absolute() else Path(root) / path).resolve()
    return path != base and base in path.parents


def _validate(root, cls, args):
    if not args or any(not isinstance(a, str) or '\0' in a for a in args):
        raise GitDenied('Git command denied')
    command = args[0]
    if cls == 'read':
        if command not in READ:
            raise GitDenied('Git read command denied')
        # These options execute a helper or write an output file despite being
        # attached to an otherwise read-only command.
        if any(a in ('--ext-diff', '--textconv', '--filters', '--open-files-in-pager')
               or a.startswith(('--output', '--open-files-in-pager='))
               or (command == 'grep' and a.startswith('-O')) for a in args[1:]):
            raise GitDenied('Git read option denied')
        if command == 'config' and not (len(args) == 3 and args[1] in ('--get', '--get-regexp') and not args[2].startswith('-')):
            raise GitDenied('Git config is read-only')
        if command == 'config':
            key = args[2].lower()
            if key.startswith(('include.', 'includeif.')):
                raise GitDenied('Git config include access denied')
            if args[1] == '--get-regexp':
                try:
                    includes = 'include' in key or re.search(args[2], 'include.path', re.I) is not None
                except re.error:
                    includes = True
                if includes:
                    raise GitDenied('Git config include access denied')
        if command == 'diff' and any(a.startswith('--') and len(a.split('=')[0]) > 2
                and ('--no-index'.startswith(a.split('=')[0]) or a.startswith('--no-index=')) for a in args[1:]):
            raise GitDenied('Git diff must stay in the repository')
        if command == 'cat-file' and not (len(args) == 3 and args[1] in ('-e', '-p', '-t', '-s') and not args[2].startswith('-')):
            raise GitDenied('Git cat-file mode denied')
        if command == 'merge-base' and not (len(args) == 4 and args[1] == '--is-ancestor' and all(not a.startswith('-') for a in args[2:])):
            raise GitDenied('Git merge-base mode denied')
        if command == 'worktree' and not (len(args) >= 2 and args[1] == 'list' and all(a in ('--porcelain', '-z') for a in args[2:])):
            raise GitDenied('Git worktree is read-only')
        return
    if cls == 'lifecycle':
        if args == ('fetch', '--prune', 'origin') or args == ('worktree', 'prune'):
            return
        if (len(args) == 5 and args[:3] == ('worktree', 'add', '--detach')
                and not args[3].startswith('-') and not args[4].startswith('-') and _private_target(root, args[3])):
            return
        if (len(args) == 4 and args[:3] == ('worktree', 'remove', '--force')
                and not args[3].startswith('-') and _private_target(root, args[3])):
            return
        raise GitDenied('Git lifecycle command denied')
    raise GitDenied('Unknown Git command class')


def _timeout():
    deadline = getattr(_clock, 'deadline', None)
    timeout = 30 if deadline is None else min(30, deadline - time.monotonic())
    if timeout <= 0:
        raise TimeoutError('Git round timed out')
    return timeout


def _credential_helpers(env):
    # Only fetch needs credentials. Replay trusted system/global helpers after
    # the empty helper reset; never enable repository helpers or other host config.
    # Explicit scopes and a neutral cwd keep .git/config out of helper discovery.
    flags = []
    for scope in ('--system', '--global'):
        result = subprocess.run(['git', 'config', scope, '--includes', '--null', '--get-regexp',
                                 r'^credential(\..*)?\.helper$'], cwd=Path.home(), env=env,
                                text=True, encoding='utf-8', errors='replace', capture_output=True, timeout=_timeout())
        if result.returncode not in (0, 1):
            raise GitFailed('Git command failed')
        for entry in result.stdout.split('\0'):
            if entry:
                key, value = entry.split('\n', 1)
                flags += ['-c', key + '=' + value]
    return flags


def _invoke(root, env, args, extra=(), input=None):
    result = subprocess.run(PREFIX + list(extra) + ['-c', 'safe.directory=' + str(Path(root).resolve())] + list(args),
                            cwd=root, env=env, input=input, text=True, encoding='utf-8', errors='replace',
                            capture_output=True, timeout=_timeout())
    if result.returncode:
        raise GitFailed('Git command failed')
    return result.stdout


def _origin_url(root):
    url = run(root, 'read', 'config', '--get', 'remote.origin.url').strip()
    if not re.fullmatch(r'(?:https://github\.com/|git@github\.com:)[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', url):
        raise GitFailed('Git remote denied')
    return url


def _refs(root, env):
    rows = _invoke(root, env, ['for-each-ref', '--format=%(objectname) %(refname) %(symref)'])
    refs = {}
    for row in rows.splitlines():
        parts = row.split()
        if len(parts) == 2:  # Leave symbolic refs such as origin/HEAD untouched.
            sha, ref = parts
            refs[ref] = sha
    return refs


def _fetch(root, env, helpers):
    url = _origin_url(root)
    objects = run(root, 'read', 'rev-parse', '--path-format=absolute', '--git-path', 'objects').strip()
    object_format = run(root, 'read', 'rev-parse', '--show-object-format').strip()
    before = _refs(root, env)
    # Fetch never loads the source repository's config: http/credential/url keys
    # (including includes, URL-specific proxy/CA overrides and rewrites) stay out.
    # Share only objects; publish fetched origin refs/tags atomically on success.
    with tempfile.TemporaryDirectory(prefix='teamagent-fetch-') as temporary:
        _invoke(temporary, env, ['init', '--bare', '--template=', '--object-format=' + object_format])
        network_env = dict(env, GIT_OBJECT_DIRECTORY=objects)
        if before:
            _invoke(temporary, network_env, ['update-ref', '--stdin'],
                    input=''.join('update ' + ref + ' ' + sha + '\n' for ref, sha in before.items()))
        policy = ['-c', 'remote.origin.url=' + url, '-c', 'remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*',
                  '-c', 'http.proxy=', '-c', 'http.sslVerify=true', '-c', 'http.extraHeader=',
                  '-c', 'http.followRedirects=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false']
        output = _invoke(temporary, network_env, ['fetch', '--prune', 'origin'], extra=policy + helpers)
        after = _refs(temporary, network_env)
        updates = []
        for ref in sorted(before.keys() | after.keys()):
            if not ref.startswith(('refs/remotes/origin/', 'refs/tags/')) or before.get(ref) == after.get(ref):
                continue
            if ref in after:
                updates.append('update ' + ref + ' ' + after[ref] + ' ' + before.get(ref, '0'*len(after[ref])))
            else:
                updates.append('delete ' + ref + ' ' + before[ref])
        if updates:
            _invoke(root, env, ['update-ref', '--stdin'], input='start\n' + '\n'.join(updates) + '\nprepare\ncommit\n')
        return output


def run(root, cls, *args):
    """Return stdout for a permitted Git command; errors never include output."""
    _validate(root, cls, args)
    command, *rest = args
    flags = ['--no-textconv'] if command == 'grep' else ['--no-ext-diff', '--no-textconv'] if command in ('show', 'diff', 'log') else ['--no-includes'] if command == 'config' else []
    env = {k:v for k,v in os.environ.items() if not k.startswith('GIT_') and k not in ('SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE')}
    try:
        helpers = _credential_helpers(env) if command == 'fetch' else []
        # Block repo-local askPass execution as well as interactive terminal prompts.
        env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_TERMINAL_PROMPT='0',
                   GIT_ASKPASS='/usr/bin/false', GIT_OPTIONAL_LOCKS='0')
        if command == 'fetch':
            return _fetch(root, env, helpers)
        return _invoke(root, env, [command] + flags + rest)
    except subprocess.TimeoutExpired:
        raise TimeoutError('Git command timed out') from None
