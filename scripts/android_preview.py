"""Keeps the owner's running `.journey` preview intact around any device run that replaces it.

The `.journey` app is also the owner's preview (its APK carries that preview's API address and
token). `preserve()` runs before anything may replace it: it pulls the installed APK (every split)
and archives the app data, and refuses -- touching nothing -- unless the archive is complete and
holds preferences. It also refuses when the preview holds a signed-in session (#135): that session
is sealed with an Android keystore key that any data clear destroys, so no restore can bring it
back. `KS_PREVIEW_ACCEPT_SIGN_OUT=1` accepts that the owner signs in again afterwards, and the
receipt says so.

`restore()` first checks whether the preview was replaced at all (the installed APK still matches
the backup, byte for byte): if not, it leaves the preview exactly as it is. Otherwise it reinstalls
that exact APK (a downgrade is allowed), restores the data, verifies every file's name, size and
SHA-256 against the backup, relaunches it and writes `preview-restored.json`. Only a verified
restore deletes the archive and the pulled APK (both hold the preview's credentials); on any
failure they are kept and the error names the backup. Call `restore()` first in `finally`.
"""
from pathlib import Path
import datetime
import hashlib
import io
import json
import os
import subprocess
import tarfile

VAULT_PREFS = 'shared_prefs/ks_session_vault_v1.xml'
# SessionVault's ciphertext key: present only while a session is stored (sign-out removes it but
# leaves the file behind, so the file alone proves nothing).
VAULT_SESSION_KEY = b'name="token_ciphertext"'


def _holds_session(data):
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
        for member in archive.getmembers():
            if member.isfile() and member.name == VAULT_PREFS:
                return VAULT_SESSION_KEY in archive.extractfile(member).read()
    return False


def _listing(data):
    # Every regular file's name, size and hash; refuses anything but a complete archive (a cut at a
    # 512-byte boundary still parses, so the end-of-archive zero blocks are required too).
    if len(data) < 1024 or len(data) % 512 or data[-1024:] != bytes(1024):
        raise RuntimeError('preview app data archive is incomplete; the preview was not touched')
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
        return sorted((m.name, m.size, hashlib.sha256(archive.extractfile(m).read()).hexdigest())
                      for m in archive.getmembers() if m.isfile())


def _sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class PreviewGuard:
    def __init__(self, package, out):
        self.package = package
        self.out = Path(out)
        self.backup = self.out / 'preview-backup' / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        self.backup.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.apks = []
        self.listing = []
        self.session_lost = False

    def _installed_paths(self):
        # `pm list packages` answers "absent" explicitly; a failed query (package service not up,
        # adb hiccup) is never read as "absent", or a later install would replace an unguarded preview.
        listed = subprocess.run(['adb', 'shell', 'pm', 'list', 'packages', self.package], capture_output=True, text=True)
        if listed.returncode != 0:
            raise RuntimeError('could not ask the device which packages are installed; the preview was not touched')
        if f'package:{self.package}' not in listed.stdout.split():
            return []
        found = subprocess.run(['adb', 'shell', 'pm', 'path', self.package], capture_output=True, text=True)
        paths = [line.split(':', 1)[1].strip() for line in found.stdout.splitlines() if line.startswith('package:')]
        if found.returncode != 0 or not paths:
            raise RuntimeError('could not locate the installed preview APK; the preview was not touched')
        return paths

    def _pull_data(self):
        data = subprocess.run(['adb', 'exec-out', 'run-as', self.package, 'tar', '-cf', '-', 'shared_prefs', 'files'], capture_output=True)
        if data.returncode != 0: raise RuntimeError('could not archive the preview app data; the preview was not touched')
        listing = _listing(data.stdout)
        if not any(name.startswith('shared_prefs/') for name, _, _ in listing):
            raise RuntimeError('preview app data archive has no preferences; the preview was not touched')
        return data.stdout, listing

    def preserve(self):
        paths = self._installed_paths()
        if not paths:
            (self.out / 'preview-restored.json').write_text(json.dumps({'previewInstalled': False,
                'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}, indent=2) + '\n')
            return False
        data, listing = self._pull_data()
        if _holds_session(data):
            if os.environ.get('KS_PREVIEW_ACCEPT_SIGN_OUT') != '1':
                raise RuntimeError('The preview holds a signed-in session sealed by its Android keystore, which a data restore '
                                   'cannot bring back. Sign out in the preview first, or set KS_PREVIEW_ACCEPT_SIGN_OUT=1 to '
                                   'accept signing in again afterwards. The preview was not touched.')
            self.session_lost = True
        pulled = []
        for index, path in enumerate(paths):
            target = self.backup / f'preview-{index}.apk'
            subprocess.run(['adb', 'pull', path, str(target)], check=True, stdout=subprocess.DEVNULL)
            pulled.append(target)
        (self.backup / 'preview-data.tar').write_bytes(data)
        # Only now is the preview recoverable, so only now may anything replace it.
        self.apks, self.listing = pulled, listing
        return True

    def _replaced(self):
        try:
            paths = self._installed_paths()
        except RuntimeError:
            return True
        if len(paths) != len(self.apks):
            return True
        for index, path in enumerate(paths):
            current = self.backup / f'current-{index}.apk'
            subprocess.run(['adb', 'pull', path, str(current)], check=True, stdout=subprocess.DEVNULL)
            same = _sha(current) == _sha(self.apks[index])
            current.unlink()
            if not same:
                return True
        return False

    def _receipt(self, **fields):
        (self.out / 'preview-restored.json').write_text(json.dumps({
            'apkSha256': [_sha(apk) for apk in self.apks], 'backup': self.backup.name, 'files': len(self.listing),
            'sessionLost': self.session_lost, 'guard': 'scripts/android_preview.py',
            'guardSha256': _sha(Path(__file__)), **fields,
            'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}, indent=2) + '\n')

    def _discard_backup(self):
        # The archive and the APKs hold the preview's credentials; they go once not needed.
        (self.backup / 'preview-data.tar').unlink(missing_ok=True)
        for apk in self.apks:
            apk.unlink(missing_ok=True)

    def restore(self):
        if not self.apks or not all(apk.exists() for apk in self.apks): return
        try:
            self._restore()
        except Exception as error:
            raise RuntimeError(f'{error} -- the preview backup is kept at {self.backup}') from error

    def _restore(self):
        if not self._replaced():
            # The run never installed over the preview (runners install before any `pm clear`), so
            # it is left exactly as it is. Its data is compared too: if it changed meanwhile (the
            # owner used the preview), the backup is kept rather than restored over their changes.
            _, current = self._pull_data()
            unchanged = current == self.listing
            self._receipt(replaced=False, dataUnchanged=unchanged, sessionLost=False)
            if unchanged: self._discard_backup()
            return
        if len(self.apks) == 1:
            subprocess.run(['adb', 'install', '-r', '-d', str(self.apks[0])], check=True, stdout=subprocess.DEVNULL)
        else:
            subprocess.run(['adb', 'install-multiple', '-r', '-d', *map(str, self.apks)], check=True, stdout=subprocess.DEVNULL)
        subprocess.run(['adb', 'shell', 'pm', 'clear', self.package], stdout=subprocess.DEVNULL)
        data = (self.backup / 'preview-data.tar').read_bytes()
        subprocess.run(['adb', 'shell', f'run-as {self.package} tar -xf -'], input=data, check=True)
        _, restored_listing = self._pull_data()
        subprocess.run(['adb', 'shell', 'am', 'start', '-n', self.package + '/com.knowscroll.mobile.MainActivity'], stdout=subprocess.DEVNULL)
        verified = restored_listing == self.listing
        self._receipt(replaced=True, dataBytes=len(data), dataVerified=verified)
        if not verified: raise RuntimeError('preview data restore differs from its backup')
        self._discard_backup()
