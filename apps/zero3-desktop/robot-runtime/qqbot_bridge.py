from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

AUTH_ROUNDS = 120_000
APPROVAL_TTL_SECONDS = 120
AUTH_LOCKOUT_SECONDS = 600
MAX_AUTH_FAILURES = 5
DEFAULT_BACKEND = "zero3"

def data_dir() -> Path:
    override = os.getenv("ZERO3_PILOT_DATA_DIR")
    if override:
        return Path(override)
    if os.name == "nt" and os.getenv("LOCALAPPDATA"):
        return Path(os.environ["LOCALAPPDATA"]) / "Zero3Pilot"
    if os.getenv("XDG_DATA_HOME"):
        return Path(os.environ["XDG_DATA_HOME"]) / "zero3-pilot"
    return Path.home() / ".local" / "share" / "zero3-pilot"


def protect_secret(value: str) -> str:
    if os.name != "nt":
        return "plain64:" + base64.b64encode(value.encode()).decode()
    import ctypes
    from ctypes import wintypes
    class Blob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]
    raw = value.encode("utf-8")
    buffer = ctypes.create_string_buffer(raw)
    source = Blob(len(raw), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)))
    target = Blob()
    if not ctypes.windll.crypt32.CryptProtectData(ctypes.byref(source), None, None, None, None, 0, ctypes.byref(target)):
        raise ctypes.WinError()
    try:
        protected = ctypes.string_at(target.pbData, target.cbData)
        return "dpapi:" + base64.b64encode(protected).decode()
    finally:
        ctypes.windll.kernel32.LocalFree(target.pbData)


def unprotect_secret(value: str) -> str:
    if value.startswith("plain64:"):
        return base64.b64decode(value[8:]).decode("utf-8")
    if not value.startswith("dpapi:"):
        return value
    if os.name != "nt":
        raise RuntimeError("DPAPI QQ 凭据只能在原 Windows 用户下解密")
    import ctypes
    from ctypes import wintypes
    class Blob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]
    raw = base64.b64decode(value[6:])
    buffer = ctypes.create_string_buffer(raw)
    source = Blob(len(raw), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)))
    target = Blob()
    if not ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 0, ctypes.byref(target)):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(target.pbData, target.cbData).decode("utf-8")
    finally:
        ctypes.windll.kernel32.LocalFree(target.pbData)


def qq_state_path() -> Path:
    return data_dir() / "qqbot.json"


def auth_state_path() -> Path:
    return data_dir() / "qq-authorization.json"


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except FileNotFoundError:
        return {}

def save_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if os.name != "nt":
        temporary.chmod(0o600)
    temporary.replace(path)


def validate_code(code: str) -> bool:
    return 6 <= len(code) <= 64 and not any(ch.isspace() for ch in code)


def derive_hash(code: str, salt: str) -> str:
    digest = hashlib.sha256(salt.encode() + b"\x00" + code.encode()).digest()
    for round_number in range(1, AUTH_ROUNDS):
        digest = hashlib.sha256(
            digest + salt.encode() + round_number.to_bytes(4, "little") + code.encode()
        ).digest()
    return digest.hex()


def configure_authorization(code: str) -> None:
    if not validate_code(code):
        raise ValueError("授权码长度必须为 6-64 个字符且不能包含空白")
    salt = secrets.token_hex(16)
    save_json(auth_state_path(), {"version": 1, "salt": salt, "password_hash": derive_hash(code, salt)})

def authorization_configured() -> bool:
    value = load_json(auth_state_path())
    return value.get("version") == 1 and bool(value.get("salt")) and bool(value.get("password_hash"))


def verify_authorization(code: str) -> bool:
    value = load_json(auth_state_path())
    if value.get("version") != 1:
        return False
    salt = str(value.get("salt") or "")
    expected = str(value.get("password_hash") or "")
    if not salt or not expected or not validate_code(code):
        return False
    return secrets.compare_digest(derive_hash(code, salt), expected)


def ensure_authorization_interactive() -> None:
    if authorization_configured():
        return
    print("\n首次 QQ 绑定需要设置 Zero3 高风险操作授权码。")
    print("以后 QQ 触发高风险操作时，只放行当前待执行操作。")
    while True:
        code = input("设置授权码（6-64 位，无空白）: ").strip()
        confirm = input("再次输入授权码: ").strip()
        if code != confirm:
            print("两次输入不一致，请重试。")
            continue
        try:
            configure_authorization(code)
            print("QQ 高风险操作授权码设置完成。")
            return
        except ValueError as exc:
            print(str(exc))

def public_status() -> dict[str, Any]:
    state = load_json(qq_state_path())
    connected = bool(state.get("app_id") and state.get("client_secret") and state.get("owner_user_id"))
    return {
        "qq": {
            "connected": connected,
            "app_id": state.get("app_id") if connected else None,
            "owner_user_id": state.get("owner_user_id") if connected else None,
        },
        "authorization_configured": authorization_configured(),
    }


def hermes_root() -> Path:
    configured = os.getenv("ZERO3_QQBOT_HERMES_ROOT") or os.getenv("HERMES_DESKTOP_HERMES_ROOT")
    if configured:
        return Path(configured)
    home = os.getenv("HERMES_HOME") or os.getenv("ZERO3_HERMES_HOME")
    if home:
        return Path(home) / "hermes-agent"
    raise RuntimeError("未配置 Hermes QQBot 传输运行时")


def ensure_qq_runtime_dependencies() -> None:
    missing = []
    try:
        import aiohttp  # noqa: F401
    except ImportError:
        missing.append("aiohttp==3.14.3")
    try:
        import qrcode  # noqa: F401
    except ImportError:
        missing.append("qrcode==7.4.2")
    if not missing:
        return
    uv = shutil.which("uv")
    if uv:
        command = [uv, "pip", "install", "--python", sys.executable, *missing]
    else:
        command = [sys.executable, "-m", "pip", "install", *missing]
    print("首次启用 QQ 机器人：正在安装官方 QQ Bot 所需运行依赖……", flush=True)
    try:
        subprocess.run(command, cwd=str(hermes_root()), check=True, timeout=600)
    except Exception as exc:
        raise RuntimeError("无法安装 QQ Bot 运行依赖；请检查网络或 Hermes Python 环境") from exc


def import_qqbot() -> tuple[Any, Any, Any]:
    ensure_qq_runtime_dependencies()
    root = hermes_root()
    root_text = str(root)
    if root_text not in sys.path:
        sys.path.insert(0, root_text)
    from gateway.config import PlatformConfig
    from gateway.platforms.qqbot import QQAdapter, qr_register
    return PlatformConfig, QQAdapter, qr_register

def login() -> None:
    state = load_json(qq_state_path())
    if state.get("app_id") and state.get("client_secret") and state.get("owner_user_id"):
        print(f"QQ Bot 已绑定：app_id={state['app_id']} owner={state['owner_user_id']}")
        ensure_authorization_interactive()
        print("如需换绑，请先在 Zero3 Pilot 中解除 QQ 绑定。")
        return
    _, _, qr_register = import_qqbot()
    print("正在创建 QQ 官方机器人扫码绑定任务……")
    result = qr_register(timeout_seconds=600)
    if not result:
        raise RuntimeError("QQ 扫码绑定未完成或已超时")
    app_id = str(result.get("app_id") or "").strip()
    client_secret = str(result.get("client_secret") or "").strip()
    owner_user_id = str(result.get("user_openid") or "").strip()
    if not app_id or not client_secret or not owner_user_id:
        raise RuntimeError("QQ 扫码结果缺少 app_id/client_secret/user_openid")
    save_json(qq_state_path(), {
        "version": 1,
        "app_id": app_id,
        "client_secret": protect_secret(client_secret),
        "owner_user_id": owner_user_id,
    })
    ensure_authorization_interactive()
    print("QQ 机器人绑定完成。Zero3 Pilot 会自动启动消息服务。")


def parse_command(text: str, default_backend: str = DEFAULT_BACKEND) -> tuple[str, str]:
    trimmed = text.strip()
    if not trimmed:
        raise ValueError("消息不能为空")
    if not trimmed.startswith("/pilot"):
        return default_backend, trimmed
    rest = trimmed[len("/pilot"):].strip()
    if not rest:
        raise ValueError("用法：直接发送消息，或 /pilot zero3|codex|claude <任务>")
    first, *remaining = rest.split(maxsplit=1)
    if first in {"zero3", "codex", "claude"}:
        if not remaining or not remaining[0].strip():
            raise ValueError("指定处理器后必须提供任务内容")
        return first, remaining[0].strip()
    return default_backend, rest


async def route_to_zero3(
    backend: str,
    text: str,
    approved: bool,
    event: Any,
) -> tuple[int, dict[str, Any]]:
    import httpx
    base_url = (os.getenv("ZERO3_ROBOT_GATEWAY_URL") or "").rstrip("/")
    token = os.getenv("ZERO3_ROBOT_GATEWAY_TOKEN") or ""
    if not base_url or not token:
        raise RuntimeError("Zero3 Robot Gateway 未启动")

    source = getattr(event, "source", None)
    payload = {
        "channel": "qq",
        "backend": backend,
        "text": text,
        "approved": approved,
        "sender_id": str(getattr(event, "user_id", "") or getattr(source, "user_id", "") or ""),
        "chat_id": str(getattr(source, "chat_id", "") or ""),
        "thread_id": str(getattr(source, "thread_id", "") or "") or None,
        "message_id": str(getattr(event, "message_id", "") or "") or None,
    }
    async with httpx.AsyncClient(timeout=610.0) as client:
        response = await client.post(
            base_url + "/v1/route",
            headers={"authorization": "Bearer " + token},
            json=payload,
        )
    try:
        body = response.json()
    except Exception:
        body = {"error": response.text.strip() or f"HTTP {response.status_code}"}
    return response.status_code, body if isinstance(body, dict) else {"error": str(body)}


@dataclass
class PendingApproval:
    backend: str
    text: str
    created_at: float
    failures: int = 0
    locked_until: float = 0.0


_PENDING: dict[str, PendingApproval] = {}

def pending_key(event: Any) -> str:
    source = getattr(event, "source", None)
    chat_id = str(getattr(source, "chat_id", "") or "")
    user_id = str(getattr(event, "user_id", "") or getattr(source, "user_id", "") or "")
    return chat_id + ":" + user_id


def response_text(body: dict[str, Any]) -> str:
    value = body.get("text")
    if isinstance(value, str) and value.strip():
        return value.strip()
    error = body.get("error")
    if isinstance(error, str) and error.strip():
        return "Zero3 Pilot 执行失败：" + error.strip()
    return json.dumps(body, ensure_ascii=False)


async def handle_event(event: Any, owner_user_id: str) -> Optional[str]:
    source = getattr(event, "source", None)
    user_id = str(getattr(event, "user_id", "") or getattr(source, "user_id", "") or "")
    if user_id != owner_user_id:
        return None
    text = str(getattr(event, "text", "") or "").strip()
    if not text:
        return None
    key = pending_key(event)
    pending = _PENDING.get(key)
    now = time.monotonic()

    if pending and now - pending.created_at >= APPROVAL_TTL_SECONDS:
        _PENDING.pop(key, None)
        pending = None
        if validate_code(text):
            return "授权请求已超过 2 分钟并失效，请重新发送原任务。"
    if pending:
        if text.lower() == "/cancel":
            _PENDING.pop(key, None)
            return "已取消当前待授权操作。"
        if pending.locked_until > now:
            minutes = max(1, int((pending.locked_until - now + 59) // 60))
            return f"授权码尝试次数过多，已临时锁定。约 {minutes} 分钟后可重试。"
        if not validate_code(text):
            return "当前操作等待授权。请直接发送授权码，或发送 /cancel 取消。"
        if verify_authorization(text):
            _PENDING.pop(key, None)
            status, body = await route_to_zero3(pending.backend, pending.text, True, event)
            if status >= 400:
                return response_text(body)
            return "授权码验证通过，仅授权当前操作。\n" + response_text(body)
        pending.failures += 1
        if pending.failures >= MAX_AUTH_FAILURES:
            pending.failures = 0
            pending.locked_until = now + AUTH_LOCKOUT_SECONDS
            return "授权码连续错误 5 次，已锁定 10 分钟；当前操作不会执行。"
        return f"授权码错误，当前操作未执行。还可尝试 {MAX_AUTH_FAILURES - pending.failures} 次。"

    try:
        backend, goal = parse_command(text, os.getenv("ZERO3_QQBOT_AGENT") or DEFAULT_BACKEND)
    except ValueError as exc:
        return str(exc)
    status, body = await route_to_zero3(backend, goal, False, event)
    if status == 428:
        reason = str(body.get("error") or body.get("reason") or "该操作需要显式授权")[:500]
        _PENDING[key] = PendingApproval(backend=backend, text=goal, created_at=now)
        return (
            "检测到高风险/需审批操作，当前尚未执行。\n"
            "请在 2 分钟内直接发送授权码；发送 /cancel 可取消。\n"
            f"权限原因：{reason}"
        )
    return response_text(body)


async def run_bridge() -> None:
    state = load_json(qq_state_path())
    app_id = str(state.get("app_id") or "")
    client_secret = unprotect_secret(str(state.get("client_secret") or ""))
    owner_user_id = str(state.get("owner_user_id") or "")
    if not app_id or not client_secret or not owner_user_id:
        raise RuntimeError("QQ Bot 尚未绑定，请先执行 login")
    if not authorization_configured():
        raise RuntimeError("QQ 高风险操作授权码尚未设置，请先执行 login")
    PlatformConfig, QQAdapter, _ = import_qqbot()

    config = PlatformConfig(
        enabled=True,
        typing_indicator=True,
        extra={
            "app_id": app_id,
            "client_secret": client_secret,
            "dm_policy": "allowlist",
            "allow_from": [owner_user_id],
            "group_policy": "open",
            # Adapter accepts group events, then handle_event applies the owner OpenID gate.
            # This lets the bound owner use the bot from any QQ group without trusting other members.
            "group_sessions_per_user": True,
        },
    )
    adapter = QQAdapter(config)
    adapter.set_message_handler(lambda event: handle_event(event, owner_user_id))
    if not await adapter.connect():
        detail = getattr(adapter, "fatal_error_message", None) or "QQ WebSocket 连接失败"
        raise RuntimeError(str(detail))
    print(f"QQ Robot 已连接到 Zero3。owner={owner_user_id}", flush=True)
    try:
        await asyncio.Event().wait()
    finally:
        await adapter.disconnect()


def disconnect() -> None:
    for path in (qq_state_path(), auth_state_path()):
        try:
            path.unlink()
        except FileNotFoundError:
            pass
    print("QQ 本地绑定和高风险操作授权码已移除。")

def self_test() -> None:
    assert parse_command("你好") == ("zero3", "你好")
    assert parse_command("/pilot codex fix it") == ("codex", "fix it")
    assert parse_command("/pilot claude review") == ("claude", "review")
    assert parse_command("/pilot explain") == ("zero3", "explain")
    assert validate_code("123456")
    assert not validate_code("123 456")
    protected = protect_secret("qq-secret-test")
    assert "qq-secret-test" not in protected
    assert unprotect_secret(protected) == "qq-secret-test"
    salt = "test-salt"
    assert derive_hash("839201", salt) == derive_hash("839201", salt)
    assert derive_hash("839201", salt) != derive_hash("839202", salt)
    print("qqbot_bridge self-test passed")


def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else "help"
    if command == "status":
        print(json.dumps(public_status(), ensure_ascii=False, indent=2))
    elif command == "login":
        login()
    elif command == "run":
        asyncio.run(run_bridge())
    elif command == "disconnect":
        disconnect()
    elif command == "self-test":
        self_test()
    else:
        print("Usage: qqbot_bridge.py status|login|run|disconnect|self-test")


if __name__ == "__main__":
    main()
