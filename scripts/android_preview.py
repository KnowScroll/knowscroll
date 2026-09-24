"""Keeps the owner's running `.journey` preview intact around any device run that replaces it.

The `.journey` app is also the owner's preview (its APK carries that preview's API address and
token). `preserve()` pulls the installed APK and archives its app data before anything may replace
it, and refuses unless the archive is readable and holds preferences. `restore()` reinstalls that
exact APK (a downgrade is allowed), restores the data, verifies it against the backup's listing,
relaunches it, writes `preview-restored.json`, and only then deletes the archive, because the
archive holds the preview's session. Each run keeps its own timestamped backup directory.
Call `restore()` first in `finally`, so no later cleanup failure can leave the preview replaced.
"""
from pathlib import Path
import datetime
import hashlib
import io
import json
import subprocess
import tarfile


def _listing(data):
    # Names and sizes of regular files; raises on anything that is not a complete tar archive.
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
        return sorted((m.name, m.size) for m in archive.getmembers() if m.isfile())


class PreviewGuard:
    def __init__(self, package, out):
        self.package = package
        self.out = Path(out)
        self.backup = self.out / 'preview-backup' / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        self.backup.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.apk = None
        self.listing = []

    def _pull_data(self):
        data = subprocess.run(['adb', 'exec-out', 'run-as', self.package, 'tar', '-cf', '-', 'shared_prefs', 'files'], capture_output=True)
        if data.returncode != 0: raise RuntimeError('could not archive the preview app data; the preview was not touched')
        listing = _listing(data.stdout)
        if not any(name.startswith('shared_prefs/') for name, _ in listing):
            raise RuntimeError('preview app data archive has no preferences; the preview was not touched')
        return data.stdout, listing

    def preserve(self):
        installed = subprocess.run(['adb', 'shell', 'pm', 'path', self.package], capture_output=True, text=True).stdout.strip()
        if not installed.startswith('package:'): return False
        pulled = self.backup / 'preview-base.apk'
        subprocess.run(['adb', 'pull', installed.splitlines()[0].split(':', 1)[1], str(pulled)], check=True, stdout=subprocess.DEVNULL)
        data, self.listing = self._pull_data()
        (self.backup / 'preview-data.tar').write_bytes(data)
        # Only now is the preview recoverable, so only now may anything replace it.
        self.apk = pulled
        return True

    def restore(self):
        if self.apk is None or not self.apk.exists(): return
        subprocess.run(['adb', 'install', '-r', '-d', str(self.apk)], check=True, stdout=subprocess.DEVNULL)
        subprocess.run(['adb', 'shell', 'pm', 'clear', self.package], stdout=subprocess.DEVNULL)
        data = (self.backup / 'preview-data.tar').read_bytes()
        subprocess.run(['adb', 'shell', f'run-as {self.package} tar -xf -'], input=data, check=True)
        _, restored_listing = self._pull_data()
        subprocess.run(['adb', 'shell', 'am', 'start', '-n', self.package + '/com.knowscroll.mobile.MainActivity'], stdout=subprocess.DEVNULL)
        verified = restored_listing == self.listing
        (self.out / 'preview-restored.json').write_text(json.dumps({
            'apkSha256': hashlib.sha256(self.apk.read_bytes()).hexdigest(), 'backup': self.backup.name,
            'dataBytes': len(data), 'files': len(self.listing), 'dataVerified': verified,
            'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}, indent=2) + '\n')
        if not verified: raise RuntimeError(f'preview data restore differs from its backup; the backup is kept at {self.backup}')
        (self.backup / 'preview-data.tar').unlink()
