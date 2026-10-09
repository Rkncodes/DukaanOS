"""How the operating system runs this server process."""

import ctypes
import sys

_PROCESS_POWER_THROTTLING = 4  # PROCESS_INFORMATION_CLASS.ProcessPowerThrottling
_EXECUTION_SPEED = 0x1  # PROCESS_POWER_THROTTLING_EXECUTION_SPEED


class _PowerThrottling(ctypes.Structure):
    _fields_ = [("Version", ctypes.c_ulong), ("ControlMask", ctypes.c_ulong), ("StateMask", ctypes.c_ulong)]


def run_at_full_speed() -> bool:
    """Ask Windows not to power-throttle this process. True if it agreed; False elsewhere.

    A server has no window, so Windows 11 treats it as background work ("efficiency mode") and,
    on processors with performance and efficiency cores, keeps it on the slow cores at a low
    clock speed. Vision inference then takes about 5 s a frame instead of about 1.3 s, and
    loading the models about 35 s instead of 13 s. This is the documented opt-out
    (SetProcessInformation, ProcessPowerThrottling with the execution-speed state cleared)."""
    if sys.platform != "win32":
        return False
    try:
        kernel32 = ctypes.windll.kernel32
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        state = _PowerThrottling(1, _EXECUTION_SPEED, 0)
        return bool(
            kernel32.SetProcessInformation(
                ctypes.c_void_p(kernel32.GetCurrentProcess()), _PROCESS_POWER_THROTTLING, ctypes.byref(state), ctypes.sizeof(state)
            )
        )
    except (AttributeError, OSError):  # an older Windows without this call
        return False
