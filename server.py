import copy
import json
import os
import secrets
import socket
import sqlite3
import threading
import time

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", "8080"))

DB_PATH = Path(
    os.environ.get("ROOMS_DB", str(BASE_DIR / "rooms.sqlite3"))
).expanduser()

MAX_STUDENTS = 40
DEFAULT_STUDENTS = 20
DEFAULT_LAPS = 5

rooms = {}
rooms_lock = threading.RLock()


# ============================================================
# 保存
# ============================================================

def open_database():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    connection = sqlite3.connect(str(DB_PATH), timeout=10)

    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS rooms (
            room_key TEXT PRIMARY KEY,
            data TEXT NOT NULL
        )
        """
    )

    return connection


def serialize_room(room):
    saved = copy.deepcopy(room)

    # 単調時計の値とBの接続状態は保存後に再利用しない。
    saved["started_at"] = None
    saved["last_b_seen"] = 0.0

    return json.dumps(
        saved,
        ensure_ascii=False,
        allow_nan=False,
    )


def save_room(room):
    """rooms_lock の取得中に呼び出す。"""
    connection = open_database()

    try:
        with connection:
            connection.execute(
                """
                INSERT INTO rooms (room_key, data)
                VALUES (?, ?)
                ON CONFLICT(room_key)
                DO UPDATE SET data = excluded.data
                """,
                (room["key"], serialize_room(room)),
            )
    finally:
        connection.close()


def reset_measurement(room):
    """
    設定を残し、計測結果を初期化する。

    リスト内の非表示の生徒も初期化する。
    名前と目標周数はそのまま保持する。
    """
    room["running"] = False
    room["started_at"] = None
    room["started_at_wall"] = None
    room["elapsed"] = 0.0
    room["run_id"] = secrets.token_hex(8)
    room["finish_requests"] = {}

    for student in room["students"]:
        student["remaining"] = student["target"]
        student["finish_time"] = None
        student["completed_laps"] = None
        student["retired"] = False
        student["revision"] = student.get("revision", 0) + 1

    room["version"] = room.get("version", 0) + 1


def load_rooms():
    """
    サーバー起動時に全室の計測結果を初期化して保存する。

    読み込みまたは保存に失敗した場合は起動しない。
    """
    connection = open_database()
    restored = {}

    try:
        rows = connection.execute(
            "SELECT room_key, data FROM rooms"
        ).fetchall()

        for key, raw_data in rows:
            room = json.loads(raw_data)

            if room.get("key") != key:
                raise ValueError(
                    f"部屋データのキーが一致しません: {key}"
                )

            room["last_b_seen"] = 0.0
            reset_measurement(room)
            restored[key] = room

        # 全室をまとめて保存。途中で失敗したらロールバック。
        with connection:
            for room in restored.values():
                connection.execute(
                    "UPDATE rooms SET data = ? WHERE room_key = ?",
                    (serialize_room(room), room["key"]),
                )
    finally:
        connection.close()

    with rooms_lock:
        rooms.clear()
        rooms.update(restored)


# ============================================================
# 部屋・生徒
# ============================================================

def new_student(index):
    return {
        "id": index,
        "name": f"生徒{index + 1:02d}",
        "target": DEFAULT_LAPS,
        "remaining": DEFAULT_LAPS,
        "finish_time": None,
        "completed_laps": None,
        "retired": False,
        "revision": 0,
    }


def new_room():
    while True:
        key = secrets.token_hex(6).upper()

        if key not in rooms:
            break

    return {
        "key": key,
        "admin_token": secrets.token_urlsafe(24),
        "version": 0,
        "run_id": secrets.token_hex(8),
        "screen": "setup",
        "running": False,
        "started_at": None,
        "started_at_wall": None,
        "elapsed": 0.0,
        "draft_count": DEFAULT_STUDENTS,
        "student_count": DEFAULT_STUDENTS,
        "students": [
            new_student(i)
            for i in range(DEFAULT_STUDENTS)
        ],
        "last_b_seen": 0.0,
        "finish_requests": {},
    }


def elapsed_of(room):
    if room["running"] and room["started_at"] is not None:
        return max(0.0, time.monotonic() - room["started_at"])

    return room["elapsed"]


def room_snapshot(room):
    return {
        "key": room["key"],
        "version": room["version"],
        "run_id": room["run_id"],
        "screen": room["screen"],
        "running": room["running"],
        "elapsed": elapsed_of(room),
        "draft_count": room["draft_count"],
        "student_count": room["student_count"],
        "students": [
            dict(student)
            for student in room["students"][:room["student_count"]]
        ],
        "b_connected": (
            room["last_b_seen"] > 0
            and time.monotonic() - room["last_b_seen"] < 3.0
        ),
    }


def checked_integer(value, minimum, maximum, label):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(
            f"{label}は{minimum}〜{maximum}の整数で入力してください。"
        )

    return value


def get_student(room, student_id):
    index = checked_integer(
        student_id,
        0,
        room["student_count"] - 1,
        "生徒番号",
    )

    return room["students"][index]


def require_admin(room, token):
    if (
        not isinstance(token, str)
        or not secrets.compare_digest(room["admin_token"], token)
    ):
        raise PermissionError("Aの認証情報が正しくありません。")


def require_role(role, expected):
    if role != expected:
        raise PermissionError(f"{expected}専用の操作です。")


def require_counter(room):
    if room["screen"] != "counter":
        raise ValueError("記録画面で操作してください。")


def require_running(room):
    require_counter(room)

    if not room["running"]:
        raise ValueError("計測開始後に操作してください。")


def require_current_run(room, payload):
    if payload.get("run_id") != room["run_id"]:
        raise ValueError(
            "走行が切り替わりました。最新画面を確認してください。"
        )


def require_not_retired(student):
    if student.get("retired", False):
        raise ValueError(
            "リタイヤ中は周回を変更できません。"
        )


def local_ip_address():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    try:
        sock.connect(("192.0.2.1", 80))
        return sock.getsockname()[0]
    except OSError:
        return "IPアドレスを確認してください"
    finally:
        sock.close()


# ============================================================
# API操作
# ============================================================

def apply_operation(path, room, role, payload, received_at):
    if path == "/api/draft":
        require_role(role, "A")

        if room["screen"] != "setup":
            raise ValueError("人数選択画面で操作してください。")

        count = checked_integer(
            payload.get("count"), 1, MAX_STUDENTS, "人数"
        )

        if room["draft_count"] != count:
            room["draft_count"] = count
            room["version"] += 1

    elif path == "/api/prepare":
        require_role(role, "A")

        if room["screen"] != "setup":
            raise ValueError("人数選択画面で操作してください。")

        count = checked_integer(
            payload.get("count"), 1, MAX_STUDENTS, "人数"
        )

        while len(room["students"]) < count:
            room["students"].append(
                new_student(len(room["students"]))
            )

        room["student_count"] = count
        room["draft_count"] = count
        room["screen"] = "counter"
        reset_measurement(room)

    elif path == "/api/start":
        require_role(role, "A")
        require_counter(room)
        require_current_run(room, payload)

        if room["running"]:
            raise ValueError("すでに計測中です。")

        room["started_at"] = time.monotonic()
        room["started_at_wall"] = time.time()
        room["elapsed"] = 0.0
        room["running"] = True
        room["version"] += 1

    elif path == "/api/setup":
        require_role(role, "A")
        require_counter(room)
        require_current_run(room, payload)

        room["elapsed"] = elapsed_of(room)
        room["running"] = False
        room["started_at"] = None
        room["started_at_wall"] = None
        room["screen"] = "setup"
        room["draft_count"] = room["student_count"]
        room["run_id"] = secrets.token_hex(8)
        room["finish_requests"] = {}
        room["version"] += 1

    elif path == "/api/reset":
        require_role(role, "A")
        require_counter(room)
        require_current_run(room, payload)

        reset_measurement(room)

    elif path == "/api/change":
        require_role(role, "A")
        require_running(room)
        require_current_run(room, payload)

        student = get_student(room, payload.get("student_id"))
        require_not_retired(student)

        delta = payload.get("delta")

        if type(delta) is not int or delta not in (-1, 1):
            raise ValueError("操作が不正です。")

        if delta == -1 and student["remaining"] <= 1:
            raise ValueError("最後の−1はB専用です。")

        if delta == 1 and student["remaining"] >= student["target"]:
            raise ValueError(
                "残り周数を目標周数より増やせません。"
            )

        student["remaining"] += delta
        student["finish_time"] = None
        student["completed_laps"] = None
        student["revision"] += 1
        room["version"] += 1

    elif path == "/api/edit":
        require_role(role, "A")
        require_counter(room)
        require_current_run(room, payload)

        student = get_student(room, payload.get("student_id"))
        name = payload.get("name")

        if not isinstance(name, str):
            raise ValueError("名前を入力してください。")

        name = name.strip()

        if not 1 <= len(name) <= 100:
            raise ValueError("名前は1〜100文字で入力してください。")

        target = checked_integer(
            payload.get("target"), 1, 9999, "目標周数"
        )

        reset = payload.get("reset") is True
        target_changed = target != student["target"]

        student["name"] = name
        student["target"] = target

        if reset or target_changed:
            student["remaining"] = target
            student["finish_time"] = None
            student["completed_laps"] = None
            student["retired"] = False

        student["revision"] += 1
        room["version"] += 1

    elif path == "/api/retire":
        require_role(role, "A")
        require_counter(room)
        require_current_run(room, payload)

        student = get_student(room, payload.get("student_id"))
        revision = payload.get("revision")
        retired = payload.get("retired")

        if type(retired) is not bool:
            raise ValueError("リタイヤ状態が不正です。")

        if type(revision) is not int or revision != student["revision"]:
            raise ValueError(
                "記録が更新されています。最新画面を確認してください。"
            )

        if student["finish_time"] is not None:
            raise ValueError(
                "完走済みのランナーはリタイヤにできません。"
            )

        student["retired"] = retired
        student["revision"] += 1
        room["version"] += 1

    elif path == "/api/finish":
        require_role(role, "B")
        require_running(room)
        require_current_run(room, payload)

        request_id = payload.get("request_id")

        if (
            not isinstance(request_id, str)
            or not 1 <= len(request_id) <= 100
        ):
            raise ValueError("操作番号が不正です。")

        if request_id in room["finish_requests"]:
            return

        student = get_student(room, payload.get("student_id"))
        revision = payload.get("revision")

        if (
            type(revision) is not int
            or revision != student["revision"]
            or student["remaining"] != 1
            or student["finish_time"] is not None
            or student.get("retired", False)
        ):
            raise ValueError(
                "記録が更新されています。最新画面を確認してください。"
            )

        if received_at < room["started_at"]:
            raise ValueError("スタート前の操作は記録できません。")

        student["remaining"] = 0
        student["finish_time"] = received_at - room["started_at"]
        student["completed_laps"] = student["target"]
        student["revision"] += 1
        room["version"] += 1

        room["finish_requests"][request_id] = True

        if len(room["finish_requests"]) > 2000:
            oldest = next(iter(room["finish_requests"]))
            del room["finish_requests"][oldest]

    else:
        raise ValueError("不明な操作です。")


# ============================================================
# HTTPサーバー
# ============================================================

class Handler(BaseHTTPRequestHandler):
    def log_message(self, format_string, *args):
        print(f"{self.address_string()} - {format_string % args}")

    def send_json(self, status, payload):
        body = json.dumps(
            payload,
            ensure_ascii=False,
            allow_nan=False,
        ).encode("utf-8")

        try:
            self.send_response(status)
            self.send_header(
                "Content-Type",
                "application/json; charset=utf-8",
            )
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def send_file(self, filename, content_type):
        try:
            body = (BASE_DIR / filename).read_bytes()
        except OSError:
            self.send_error(404)
            return

        try:
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))

            if not 1 <= length <= 8192:
                raise ValueError("送信データのサイズが不正です。")

            payload = json.loads(
                self.rfile.read(length).decode("utf-8")
            )

            if not isinstance(payload, dict):
                raise ValueError("送信データの形式が不正です。")

            return payload

        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError(
                "送信データを読み取れませんでした。"
            )

    def get_room_and_role(self):
        key = self.headers.get("X-Room-Key", "").strip().upper()
        role = self.headers.get("X-Role", "").strip().upper()
        token = self.headers.get("X-Admin-Token", "")

        if role not in ("A", "B"):
            raise PermissionError("役割を確認できません。")

        room = rooms.get(key)

        if room is None:
            raise ValueError(
                "接続キーが見つかりません。"
                "Aの画面に表示されたキーを確認してください。"
            )

        if role == "A":
            require_admin(room, token)
        else:
            room["last_b_seen"] = time.monotonic()

        return room, role

    def do_GET(self):
        static_files = {
            "/": ("index.html", "text/html; charset=utf-8"),
            "/style.css": ("style.css", "text/css; charset=utf-8"),
            "/app.js": ("app.js", "text/javascript; charset=utf-8"),
        }

        if self.path in static_files:
            filename, content_type = static_files[self.path]
            self.send_file(filename, content_type)
            return

        if self.path != "/api/state":
            self.send_error(404)
            return

        try:
            with rooms_lock:
                room, _ = self.get_room_and_role()
                snapshot = room_snapshot(room)

            self.send_json(200, {"ok": True, "state": snapshot})

        except PermissionError as error:
            self.send_json(403, {"ok": False, "error": str(error)})

        except ValueError as error:
            self.send_json(404, {"ok": False, "error": str(error)})

    def do_POST(self):
        received_at = time.monotonic()

        try:
            payload = self.read_json()

            with rooms_lock:
                if self.path == "/api/create":
                    room = new_room()

                    save_room(room)
                    rooms[room["key"]] = room

                    response = {
                        "ok": True,
                        "key": room["key"],
                        "admin_token": room["admin_token"],
                        "state": room_snapshot(room),
                    }

                else:
                    original, role = self.get_room_and_role()
                    updated = copy.deepcopy(original)

                    apply_operation(
                        self.path,
                        updated,
                        role,
                        payload,
                        received_at,
                    )

                    save_room(updated)
                    rooms[updated["key"]] = updated

                    response = {
                        "ok": True,
                        "state": room_snapshot(updated),
                    }

            self.send_json(200, response)

        except PermissionError as error:
            self.send_json(403, {"ok": False, "error": str(error)})

        except ValueError as error:
            self.send_json(400, {"ok": False, "error": str(error)})

        except Exception as error:
            print("サーバーエラー:", repr(error))

            self.send_json(
                500,
                {
                    "ok": False,
                    "error": (
                        "処理または保存に失敗しました。"
                        "サーバーのログと保存先を確認してください。"
                    ),
                },
            )


class Server(ThreadingHTTPServer):
    daemon_threads = True


def main():
    # ポートを確保できない場合は、保存データを変更しない。
    server = Server((HOST, PORT), Handler)

    try:
        load_rooms()

        print()
        print("持久走・周回カウンター")
        print(f"保存先: {DB_PATH}")
        print(f"このPC: http://localhost:{PORT}")
        print(f"他の端末: http://{local_ip_address()}:{PORT}")
        print("終了: Ctrl+C")
        print()

        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nサーバーを終了します。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
