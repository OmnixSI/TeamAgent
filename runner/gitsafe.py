"""Git command classes for indexing and private detached readers (K2).

The existing development executor keeps its own Git writer. Callers of this
module cannot commit/push, install hooks, or invoke repository diff helpers.
Fetch resolves system/global credentials in a neutral repository; its network
process loads only command-line policy and a temporary bare repository's config.
"""
from contextlib import contextmanager
import os
import re
import selectors
import signal
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import urllib.parse

try:
    from runner import team_home
except ModuleNotFoundError:
    import team_home


class GitDenied(ValueError):
    pass


class GitFailed(RuntimeError):
    pass


class GitOutputTooLarge(GitFailed):
    pass


class GitFiltersConfigured(GitDenied):
    pass


PREFIX = ['git', '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
          '-c', 'diff.external=', '-c', 'core.pager=cat', '-c', 'color.ui=false', '-c', 'color.diff=false',
          '-c', 'log.showSignature=false', '-c', 'gpg.program=/usr/bin/false',
          '-c', 'gpg.openpgp.program=/usr/bin/false', '-c', 'gpg.x509.program=/usr/bin/false',
          '-c', 'gpg.ssh.program=/usr/bin/false',
          '-c', 'core.sshCommand=/usr/bin/ssh -F /dev/null -oBatchMode=yes -oConnectTimeout=5',
          '-c', 'credential.helper=', '-c', 'protocol.ext.allow=never']
DEFAULT_REFSPEC = '+refs/heads/*:refs/remotes/origin/*'
# Constant helper: the secret lives only in the fetch process environment.
FIXED_HELPER = ('!f() { test "$1" = get || exit 0; '
                'printf \'username=%s\\npassword=%s\\n\' "$TEAMAGENT_GIT_USERNAME" "$TEAMAGENT_GIT_PASSWORD"; }; f')
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
    base = (team_home.home() / 'sub').resolve()
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


def _kill_process_group(process):
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.communicate(timeout=1)


def _run_process(args, *, cwd, env, timeout, input=None, max_bytes=None):
    """Reap Git after every run; kill its entire process group on timeout."""
    with subprocess.Popen(args, cwd=cwd, env=env, start_new_session=True,
                          stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as process:
        try:
            if max_bytes is None:
                output, _ = process.communicate(None if input is None else input.encode('utf-8'), timeout=timeout)
            else:
                # Patch reads have no stdin. Read at most cap+1 bytes so a large
                # tracked file cannot first be buffered in full in memory.
                deadline = time.monotonic() + timeout
                output = bytearray()
                with selectors.DefaultSelector() as ready:
                    ready.register(process.stdout, selectors.EVENT_READ)
                    while True:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0 or not ready.select(remaining):
                            raise subprocess.TimeoutExpired(args, timeout)
                        block = os.read(process.stdout.fileno(), min(65536, max_bytes + 1 - len(output)))
                        if not block:
                            break
                        output.extend(block)
                        if len(output) > max_bytes:
                            raise GitOutputTooLarge('Git output exceeded byte limit')
                process.wait(timeout=max(0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            _kill_process_group(process)
            raise
        except GitOutputTooLarge:
            # Reap short-lived Git directly to avoid a vanished-group race.
            # A helper retaining stdout must not turn cleanup into an unbounded wait.
            process.kill()
            try:
                process.communicate(timeout=1)
            except subprocess.TimeoutExpired:
                _kill_process_group(process)
            raise
        return subprocess.CompletedProcess(args, process.returncode, output.decode('utf-8', errors='replace'), '')


def _credential_env(env, gitdir):
    trusted = dict(env)
    trusted.pop('GIT_CONFIG_NOSYSTEM', None)
    trusted.pop('GIT_CONFIG_GLOBAL', None)
    trusted['GIT_DIR'] = str(gitdir)
    return trusted


def _lookup_credential(url, gitdir, env):
    # Let Git resolve system/global helpers, URL matching, and includes in an
    # empty repo. Source gitdir/hasconfig includeIf rules intentionally do not
    # match here. Only get is sent; never approve/reject a trusted credential.
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ('https', 'http') or not parts.netloc:
        return None
    request = 'protocol=%s\nhost=%s\npath=%s\n\n' % (parts.scheme, parts.netloc, parts.path.lstrip('/'))
    result = _run_process(['git', 'credential', 'fill'], cwd=gitdir, env=_credential_env(env, gitdir),
                            input=request, timeout=_timeout())
    if result.returncode:
        return None
    fields = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    user, password = fields.get('username'), fields.get('password')
    return (user, password) if user and password else None


def _invoke(root, env, args, extra=(), input=None, max_bytes=None):
    result = _run_process(PREFIX + list(extra) + ['-c', 'safe.directory=' + str(Path(root).resolve())] + list(args),
                            cwd=root, env=env, input=input, timeout=_timeout(), max_bytes=max_bytes)
    if result.returncode:
        raise GitFailed('Git command failed')
    return result.stdout


def _origin_url(root):
    url = run(root, 'read', 'config', '--get', 'remote.origin.url').strip()
    if not re.fullmatch(r'(?:https://github\.com/|git@github\.com:)[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', url):
        raise GitFailed('Git remote denied')
    return url


def _origin_refspecs(root):
    try:
        rows = run(root, 'read', 'config', '--get-regexp', r'^remote\.origin\.fetch$')
    except GitFailed:  # rc 1 = unset
        return []
    return [row.partition(' ')[2] for row in rows.splitlines()]


def _ref_pattern_ok(pattern, gitdir, env):
    if not pattern.startswith('refs/'):
        return False
    try:
        _invoke(gitdir, env, ['check-ref-format', '--refspec-pattern', pattern])
        return True
    except GitFailed:
        return False


def _usable_refspecs(raw, gitdir, env):
    # Invalid entries are skipped independently. An invalid negative entry can
    # therefore fetch extra branches; retain every valid exclusion unchanged.
    positive, negative = [], []
    for spec in raw:
        if spec.startswith('^'):
            src = spec[1:]
            if ':' not in src and '+' not in spec[:2] and _ref_pattern_ok(src, gitdir, env):
                negative.append(spec)
            continue
        body = spec[1:] if spec.startswith('+') else spec
        src, sep, dst = body.partition(':')
        if (sep and dst.startswith('refs/remotes/origin/') and ':' not in dst
                and src.count('*') == dst.count('*') <= 1
                and _ref_pattern_ok(src, gitdir, env) and _ref_pattern_ok(dst, gitdir, env)):
            positive.append(spec)
    return (positive or [DEFAULT_REFSPEC]) + negative


def _refs(root, env):
    rows = _invoke(root, env, ['for-each-ref', '--format=%(objectname) %(refname) %(symref)'])
    refs = {}
    for row in rows.splitlines():
        parts = row.split()
        if len(parts) == 2:  # Leave symbolic refs such as origin/HEAD untouched.
            sha, ref = parts
            refs[ref] = sha
    return refs


def _fetch(root, env):
    url = _origin_url(root)
    objects = run(root, 'read', 'rev-parse', '--path-format=absolute', '--git-path', 'objects').strip()
    object_format = run(root, 'read', 'rev-parse', '--show-object-format').strip()
    before = _refs(root, env)
    raw_refspecs = _origin_refspecs(root)
    # Fetch never loads the source repository's config: http/credential/url keys
    # (including includes, URL-specific proxy/CA overrides and rewrites) stay out.
    # Share only objects; publish fetched origin refs/tags atomically on success.
    with tempfile.TemporaryDirectory(prefix='teamagent-fetch-') as temporary:
        _invoke(temporary, env, ['init', '--bare', '--template=', '--object-format=' + object_format])
        network_env = dict(env, GIT_OBJECT_DIRECTORY=objects)
        if before:
            _invoke(temporary, network_env, ['update-ref', '--stdin'],
                    input=''.join('update ' + ref + ' ' + sha + '\n' for ref, sha in before.items()))
        refspecs = _usable_refspecs(raw_refspecs, temporary, env)
        credential = _lookup_credential(url, temporary, env)
        # System/global proxy, CA and extraHeader remain unsupported by fetch.
        policy = ['-c', 'remote.origin.url=' + url]
        for spec in refspecs:
            policy += ['-c', 'remote.origin.fetch=' + spec]
        policy += [
                  '-c', 'http.proxy=', '-c', 'http.sslVerify=true', '-c', 'http.extraHeader=',
                  '-c', 'http.followRedirects=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false']
        fetch_env = dict(network_env)
        auth = []
        if credential:
            user, password = credential
            fetch_env.update(TEAMAGENT_GIT_USERNAME=user, TEAMAGENT_GIT_PASSWORD=password)
            auth = ['-c', 'credential.helper=' + FIXED_HELPER]
        output = _invoke(temporary, fetch_env, ['fetch', '--prune', 'origin'], extra=policy + auth)
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


def _check_filters(root, env):
    # Local includes participate in status/diff, so this query must follow them.
    result = _run_process(PREFIX + ['-c', 'safe.directory=' + str(Path(root).resolve()),
                                     'config', '--includes', '--name-only', '--get-regexp', r'^filter\.'],
                            cwd=root, env=env, timeout=_timeout())
    if result.returncode == 0:
        raise GitFiltersConfigured('Git filter drivers denied')
    if result.returncode != 1:  # rc 1 means no matching keys; other errors fail closed.
        raise GitFailed('Git command failed')


def run(root, cls, *args, max_bytes=None):
    """Return stdout for a permitted Git command; errors never include output."""
    _validate(root, cls, args)
    command, *rest = args
    flags = ['--no-textconv'] if command == 'grep' else ['--no-ext-diff', '--no-textconv'] if command in ('show', 'diff', 'log') else ['--no-includes'] if command == 'config' else []
    if command in ('status', 'diff'):
        flags += ['--ignore-submodules=all']
    env = {k:v for k,v in os.environ.items() if not k.startswith('GIT_') and k not in ('SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE')}
    try:
        # Block repo-local askPass execution as well as interactive terminal prompts.
        env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_TERMINAL_PROMPT='0',
                   GIT_ASKPASS='/usr/bin/false', GIT_OPTIONAL_LOCKS='0')
        if command == 'fetch':
            return _fetch(root, env)
        if cls == 'read':
            env['GIT_ALLOW_PROTOCOL'] = 'none'
        if command in ('status', 'diff'):
            _check_filters(root, env)
        return _invoke(root, env, [command] + flags + rest, max_bytes=max_bytes)
    except subprocess.TimeoutExpired:
        raise TimeoutError('Git command timed out') from None
