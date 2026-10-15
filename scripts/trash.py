"""把文件/目录移入 Windows 回收站（可恢复），不直接物理删除。

用法:
    python scripts/trash.py <path> [<path> ...]

实现说明:
    本机安全策略禁用了 PowerShell 的 Add-Type 与 COM 实例化，
    因此直接 ctypes 调用 shell32.SHFileOperationW，并置 FOF_ALLOWUNDO，
    等价于在资源管理器里按 Delete（可从回收站恢复）。

    注意：该 API 在本机环境下返回值不可靠（有时返回 2 但操作已生效），
    故成功与否以「调用后目标路径是否消失」为准；fAnyOperationsAborted 作为补充信号。
    执行前做存在性检查，任一目标不存在则整体中止，不删任何文件。
"""

import ctypes
import os
import sys
from ctypes import wintypes

FO_DELETE = 3
FOF_SILENT = 0x0004
FOF_NOCONFIRMATION = 0x0010
FOF_ALLOWUNDO = 0x0040
FOF_NOERRORUI = 0x0400
FOF_WANTNUKEWARNING = 0x4000


class SHFILEOPSTRUCTW(ctypes.Structure):
    _fields_ = [
        ("hwnd", wintypes.HWND),
        ("wFunc", wintypes.UINT),
        ("pFrom", wintypes.LPCWSTR),
        ("pTo", wintypes.LPCWSTR),
        ("fFlags", ctypes.c_uint16),
        ("fAnyOperationsAborted", wintypes.BOOL),
        ("hNameMappings", ctypes.c_void_p),
        ("lpszProgressTitle", wintypes.LPCWSTR),
    ]


def _shfileop(paths):
    """对给定路径调用一次 SHFileOperationW。返回 (ret, aborted)。"""
    src = "\0".join(os.path.abspath(p) for p in paths) + "\0\0"
    op = SHFILEOPSTRUCTW()
    op.hwnd = None
    op.wFunc = FO_DELETE
    op.pFrom = src
    op.pTo = None
    op.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI | FOF_WANTNUKEWARNING
    ret = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
    return ret, bool(op.fAnyOperationsAborted)


def move_to_trash(paths):
    """返回 (done, failed)。done/failed 均为 [(path, note), ...]。"""
    before = {p: os.path.exists(p) for p in paths}
    ret, aborted = _shfileop(paths)
    done, failed = [], []
    for p in paths:
        gone = before[p] and not os.path.exists(p)
        if gone and not aborted:
            done.append((p, f"ret={ret}"))
        else:
            failed.append((p, f"ret={ret} aborted={aborted} still_exists={os.path.exists(p)}"))
    return done, failed


def main(argv):
    if not argv:
        print("用法: python scripts/trash.py <path> [<path> ...]")
        return 2

    missing = [p for p in argv if not os.path.exists(p)]
    if missing:
        print("以下路径不存在，已中止（未删除任何文件）:")
        for p in missing:
            print("  -", p)
        return 3

    done, failed = move_to_trash(argv)
    if done:
        print(f"已移入回收站 {len(done)} 项（可从回收站恢复）:")
        for p, _ in done:
            print("  -", p)
    if failed:
        print(f"失败 {len(failed)} 项:")
        for p, note in failed:
            print(f"  - {p}  ({note})")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
