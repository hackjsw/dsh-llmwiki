"""Windows file operations for the provider's small dir_fd-based I/O surface.

Directory handles pin every ancestor against rename/delete. Reparse points,
alternate streams and DOS device names are rejected, not followed. New files
receive a protected owner/SYSTEM/Administrators DACL before any bytes are written.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes as w
import msvcrt
import os as _os
from pathlib import Path
import re

O_DIRECTORY = 1 << 28
O_NOFOLLOW = 1 << 29
O_CLOEXEC = 0
_directories = {}
_k = ctypes.WinDLL('kernel32', use_last_error=True)
_a = ctypes.WinDLL('advapi32', use_last_error=True)


class _SA(ctypes.Structure):
    _fields_ = [('length', w.DWORD), ('descriptor', w.LPVOID), ('inherit', w.BOOL)]


_k.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, ctypes.POINTER(_SA), w.DWORD, w.DWORD, w.HANDLE]
_k.CreateFileW.restype = w.HANDLE
_k.CloseHandle.argtypes = [w.HANDLE]
_k.GetFileInformationByHandleEx.argtypes = [w.HANDLE, ctypes.c_int, w.LPVOID, w.DWORD]
_a.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [w.LPCWSTR, w.DWORD, ctypes.POINTER(w.LPVOID), w.LPVOID]
_a.GetSecurityDescriptorDacl.argtypes = [w.LPVOID, ctypes.POINTER(w.BOOL), ctypes.POINTER(w.LPVOID), ctypes.POINTER(w.BOOL)]
_a.SetSecurityInfo.argtypes = [w.HANDLE, ctypes.c_int, w.DWORD, w.LPVOID, w.LPVOID, w.LPVOID, w.LPVOID]
_a.SetSecurityInfo.restype = w.DWORD
_sd = w.LPVOID()
# Grant the account SID explicitly. With an elevated process the default owner
# may be Administrators; OWNER RIGHTS alone then locks out normal desktop DSH.
import win32api
import win32security
_token = win32security.OpenProcessToken(win32api.GetCurrentProcess(), win32security.TOKEN_QUERY)
try:
    _user_sid = win32security.ConvertSidToStringSid(win32security.GetTokenInformation(_token, win32security.TokenUser)[0])
finally:
    _token.Close()
if not _a.ConvertStringSecurityDescriptorToSecurityDescriptorW(
    f'D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;{_user_sid})', 1, ctypes.byref(_sd), None
):
    raise ctypes.WinError(ctypes.get_last_error())
_sa = _SA(ctypes.sizeof(_SA), _sd, False)


def __getattr__(name):
    return getattr(_os, name)


def _leaf(name):
    name = _os.fspath(name)
    if (not name or name in {'.', '..'} or any(c in name for c in '/\\:\x00')
            or name.endswith((' ', '.')) or re.match(r'(?i)^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)', name)):
        raise OSError('unsafe Windows path component')
    return name


def _path(path, dir_fd=None):
    if dir_fd is not None:
        return _directories[dir_fd][0] / _leaf(path)
    result = Path(_os.path.abspath(path))
    if result.drive.startswith('\\') or not result.drive:
        raise OSError('only local absolute paths are supported')
    for part in result.parts[1:]:
        _leaf(part)
    return result


def _handle(path, flags, directory=False):
    access = 0x81 if directory else 0x80020000
    if flags & (_os.O_WRONLY | _os.O_RDWR):
        access = 0x40000000 | 0x80 | 0x40000
        if flags & _os.O_RDWR:
            access |= 0x80000000
    creation = 1 if flags & _os.O_CREAT and flags & _os.O_EXCL else 3
    if flags & _os.O_CREAT and creation != 1:
        raise OSError('only exclusive file creation is supported')
    handle = _k.CreateFileW(str(path), access, 3, ctypes.byref(_sa) if creation == 1 else None,
                            creation, 0x00200000 | (0x02000000 if directory else 0), None)
    if handle == w.HANDLE(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        attrs = (w.DWORD * 2)()
        if not _k.GetFileInformationByHandleEx(handle, 9, attrs, ctypes.sizeof(attrs)):
            raise ctypes.WinError(ctypes.get_last_error())
        if attrs[0] & 0x400 or bool(attrs[0] & 0x10) != directory:
            raise OSError('reparse points and unexpected file types are forbidden')
        return handle
    except BaseException:
        _k.CloseHandle(handle)
        raise


def open(path, flags, mode=0o777, *, dir_fd=None):
    target = _path(path, dir_fd)
    if flags & O_DIRECTORY:
        handles = []
        try:
            for parent in [*reversed(target.parents), target]:
                handles.append(_handle(parent, 0, True))
            fd = msvcrt.open_osfhandle(handles.pop(), _os.O_RDONLY | _os.O_BINARY)
            _directories[fd] = (target, handles)
            return fd
        except BaseException:
            for handle in reversed(handles):
                _k.CloseHandle(handle)
            raise
    if dir_fd is None:
        raise OSError('file access requires a pinned parent directory')
    handle = _handle(target, flags)
    try:
        return msvcrt.open_osfhandle(handle, (flags & (_os.O_WRONLY | _os.O_RDWR | _os.O_APPEND)) | _os.O_BINARY)
    except BaseException:
        _k.CloseHandle(handle)
        raise


def close(fd):
    directory = _directories.pop(fd, None)
    try:
        _os.close(fd)
    finally:
        if directory:
            for handle in reversed(directory[1]):
                _k.CloseHandle(handle)


def dup(fd):
    if fd in _directories:
        return open(_directories[fd][0], O_DIRECTORY)
    return _os.dup(fd)


def fdopen(fd, mode='r', *args, **kwargs):
    if 'b' not in mode:
        kwargs.setdefault('newline', '')
    return _os.fdopen(fd, mode, *args, **kwargs)


def fchmod(fd, mode):
    if mode != 0o600:
        raise OSError('only private file permissions are supported')
    present, defaulted, acl = w.BOOL(), w.BOOL(), w.LPVOID()
    if not _a.GetSecurityDescriptorDacl(_sd, ctypes.byref(present), ctypes.byref(acl), ctypes.byref(defaulted)):
        raise ctypes.WinError(ctypes.get_last_error())
    error = _a.SetSecurityInfo(msvcrt.get_osfhandle(fd), 1, 0x80000004, None, None, acl, None)
    if error:
        raise ctypes.WinError(error)


def fsync(fd):
    # Windows has no supported directory fsync; file flushes and atomic replace remain real.
    if fd not in _directories:
        _os.fsync(fd)


def stat(path, *, dir_fd=None, follow_symlinks=True):
    if isinstance(path, int):
        return _os.fstat(path)
    return _os.stat(_path(path, dir_fd), follow_symlinks=follow_symlinks)


def replace(src, dst, *, src_dir_fd=None, dst_dir_fd=None):
    return _os.replace(_path(src, src_dir_fd), _path(dst, dst_dir_fd))


def rename(src, dst, *, src_dir_fd=None, dst_dir_fd=None):
    return _os.rename(_path(src, src_dir_fd), _path(dst, dst_dir_fd))


def unlink(path, *, dir_fd=None):
    return _os.unlink(_path(path, dir_fd))


def link(src, dst, *, src_dir_fd=None, dst_dir_fd=None, follow_symlinks=True):
    return _os.link(_path(src, src_dir_fd), _path(dst, dst_dir_fd), follow_symlinks=follow_symlinks)


def mkdir(path, mode=0o777, *, dir_fd=None):
    # New directories inherit the parent's protected DACL; reparse checks happen on the next open.
    return _os.mkdir(_path(path, dir_fd), mode)


def is_private(path):
    import win32security

    fd = open(Path(path).parent, O_DIRECTORY)
    file_fd = None
    try:
        file_fd = open(Path(path).name, _os.O_RDONLY, dir_fd=fd)
        descriptor = win32security.GetSecurityInfo(
            msvcrt.get_osfhandle(file_fd), win32security.SE_FILE_OBJECT,
            win32security.DACL_SECURITY_INFORMATION,
        )
        if not descriptor.GetSecurityDescriptorControl()[0] & 0x1000:
            return False
        acl = descriptor.GetSecurityDescriptorDacl()
        allowed = {'S-1-5-18', 'S-1-5-32-544', 'S-1-3-4', _user_sid}
        return acl is not None and acl.GetAceCount() > 0 and all(
            ace[0][0] == 0 and win32security.ConvertSidToStringSid(ace[2]) in allowed
            for ace in (acl.GetAce(i) for i in range(acl.GetAceCount()))
        )
    finally:
        if file_fd is not None:
            close(file_fd)
        close(fd)
