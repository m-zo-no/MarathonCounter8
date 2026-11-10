"use strict";

// ============================================================
// 画面要素
// ============================================================

const byId = (id) => document.getElementById(id);

const ui = {
  roleScreen: byId("roleScreen"),
  connectionHeader: byId("connectionHeader"),
  setupScreen: byId("setupScreen"),
  counterScreen: byId("counterScreen"),

  roomKey: byId("roomKey"),
  launchButton: byId("launchButton"),
  roleError: byId("roleError"),

  connectionInfo: byId("connectionInfo"),
  connectionStatus: byId("connectionStatus"),
  notice: byId("notice"),
  leaveButton: byId("leaveButton"),

  studentCount: byId("studentCount"),
  prepareButton: byId("prepareButton"),
  startButton: byId("startButton"),
  resetButton: byId("resetButton"),
  setupButton: byId("setupButton"),
  timer: byId("timer"),
  counterHelp: byId("counterHelp"),
  studentGrid: byId("studentGrid"),

  editDialog: byId("editDialog"),
  editForm: byId("editForm"),
  editName: byId("editName"),
  editTarget: byId("editTarget"),
  editReset: byId("editReset"),
  cancelEditButton: byId("cancelEditButton"),
};

const SESSION_KEY = "lapCounterWebSession";
const ADMIN_SESSION_KEY = "lapCounterWebAdminSession";

const POLL_INTERVAL_MS = 500;
const CONNECTION_TIMEOUT_MS = 3000;
const DOUBLE_TAP_MS = 400;

let session = null;
let state = null;
let connected = false;

let lastReceivedAt = 0;
let elapsedBase = 0;
let elapsedBaseAt = 0;

let renderedVersion = null;
let renderedScreen = null;

let polling = false;
let busy = false;
let editingStudentId = null;
let editingRunId = null;
let draftTimer = null;

let nameTapTimer = null;
let lastTappedStudentId = null;
let lastTapAt = 0;

const pendingStudents = new Set();


// ============================================================
// 保存済み接続情報
// ============================================================

function isValidSession(value) {
  return (
    value &&
    ["A", "B"].includes(value.role) &&
    typeof value.key === "string" &&
    value.key.length > 0 &&
    (
      value.role !== "A" ||
      (
        typeof value.adminToken === "string" &&
        value.adminToken.length > 0
      )
    )
  );
}

function readSavedSession(key) {
  const raw = localStorage.getItem(key);

  if (!raw) {
    return null;
  }

  let candidate;

  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new Error("保存された接続情報を読み取れません。");
  }

  if (!isValidSession(candidate)) {
    throw new Error("保存された接続情報が不正です。");
  }

  return candidate;
}

function saveSession(candidate) {
  const serialized = JSON.stringify(candidate);

  if (candidate.role === "A") {
    localStorage.setItem(ADMIN_SESSION_KEY, serialized);
  }

  localStorage.setItem(SESSION_KEY, serialized);
}

function migrateOldSession() {
  const oldValue = sessionStorage.getItem(SESSION_KEY);

  if (!oldValue || localStorage.getItem(SESSION_KEY)) {
    return;
  }

  try {
    const candidate = JSON.parse(oldValue);

    if (isValidSession(candidate)) {
      saveSession(candidate);
    }
  } catch {
    // 旧データが不正な場合は移行しない。
  }
}


// ============================================================
// 共通表示
// ============================================================

function selectedRole() {
  return document.querySelector('input[name="role"]:checked').value;
}

function updateRoleInputs() {
  const isB = selectedRole() === "B";
  ui.roomKey.disabled = !isB;

  if (isB) {
    ui.roomKey.focus();
  }
}

function showRoleScreen() {
  ui.roleScreen.classList.remove("hidden");
  ui.connectionHeader.classList.add("hidden");
  ui.setupScreen.classList.add("hidden");
  ui.counterScreen.classList.add("hidden");
  ui.notice.textContent = "";
}

function showAppScreen(screen) {
  ui.roleScreen.classList.add("hidden");
  ui.connectionHeader.classList.remove("hidden");
  ui.setupScreen.classList.toggle("hidden", screen !== "setup");
  ui.counterScreen.classList.toggle("hidden", screen !== "counter");
}

function formatTime(seconds) {
  const centiseconds = Math.max(0, Math.floor(seconds * 100));
  const minutes = Math.floor(centiseconds / 6000);
  const wholeSeconds = Math.floor((centiseconds % 6000) / 100);
  const fraction = centiseconds % 100;

  return (
    String(minutes).padStart(2, "0") +
    ":" +
    String(wholeSeconds).padStart(2, "0") +
    "." +
    String(fraction).padStart(2, "0")
  );
}

function makeRequestId() {
  if (window.crypto && window.crypto.randomUUID) {
    return window.crypto.randomUUID();
  }

  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2) +
    "-" +
    Math.random().toString(36).slice(2)
  );
}

function currentElapsed() {
  if (!state) {
    return 0;
  }

  if (state.running && connected) {
    return elapsedBase + (performance.now() - elapsedBaseAt) / 1000;
  }

  return elapsedBase;
}

function setOffline() {
  if (connected) {
    elapsedBase = currentElapsed();
    elapsedBaseAt = performance.now();
  }

  connected = false;
  updateConnectionDisplay();
  updateControls();
}

function cancelNameTap() {
  clearTimeout(nameTapTimer);
  nameTapTimer = null;
  lastTappedStudentId = null;
  lastTapAt = 0;
}

function resetRendering() {
  cancelNameTap();

  state = null;
  connected = false;
  renderedVersion = null;
  renderedScreen = null;
  pendingStudents.clear();
}


// ============================================================
// サーバー通信
// ============================================================

async function api(path, payload = null, activeSession = session) {
  const headers = {};

  if (activeSession) {
    headers["X-Room-Key"] = activeSession.key;
    headers["X-Role"] = activeSession.role;

    if (activeSession.role === "A") {
      headers["X-Admin-Token"] = activeSession.adminToken;
    }
  }

  const options = {
    method: payload === null ? "GET" : "POST",
    headers,
    cache: "no-store",
  };

  if (payload !== null) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(payload);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);

  try {
    options.signal = controller.signal;

    const response = await fetch(path, options);
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.error || "通信に失敗しました。");
    }

    return result;
  } finally {
    clearTimeout(timeout);
  }
}

async function pollState() {
  if (!session || polling) {
    return;
  }

  const activeSession = session;
  polling = true;

  try {
    const result = await api("/api/state", null, activeSession);

    if (session === activeSession) {
      applyState(result.state);
    }
  } catch {
    if (session === activeSession) {
      setOffline();
    }
  } finally {
    polling = false;
  }
}

async function performAction(path, payload = {}) {
  if (!session || !connected || busy) {
    return;
  }

  const activeSession = session;
  busy = true;
  updateControls();

  try {
    const result = await api(path, payload, activeSession);

    if (session === activeSession) {
      ui.notice.textContent = "";
      applyState(result.state);
    }
  } catch (error) {
    if (session === activeSession) {
      ui.notice.textContent =
        error.message +
        " 操作が反映された可能性もあるため、最新画面を確認してください。";

      await pollState();
    }
  } finally {
    busy = false;
    updateControls();
  }
}


// ============================================================
// 起動・退出
// ============================================================

document.querySelectorAll('input[name="role"]').forEach((input) => {
  input.addEventListener("change", updateRoleInputs);
});

ui.launchButton.addEventListener("click", async () => {
  const role = selectedRole();

  ui.roleError.textContent = "";
  ui.launchButton.disabled = true;

  try {
    let candidate;
    let result;

    if (role === "A") {
      candidate = readSavedSession(ADMIN_SESSION_KEY);

      if (candidate) {
        if (candidate.role !== "A") {
          throw new Error("Aの保存情報が不正です。");
        }

        result = await api("/api/state", null, candidate);
      } else {
        result = await api("/api/create", {});

        candidate = {
          role: "A",
          key: result.key,
          adminToken: result.admin_token,
        };
      }
    } else {
      const key = ui.roomKey.value.trim().toUpperCase();

      if (!key) {
        throw new Error("接続キーを入力してください。");
      }

      candidate = { role: "B", key };
      result = await api("/api/state", null, candidate);
    }

    saveSession(candidate);

    resetRendering();
    session = candidate;
    applyState(result.state);
  } catch (error) {
    ui.roleError.textContent =
      error.message || "接続できませんでした。";
  } finally {
    ui.launchButton.disabled = false;
  }
});

ui.leaveButton.addEventListener("click", () => {
  if (!confirm("役割選択画面に戻りますか？")) {
    return;
  }

  clearTimeout(draftTimer);
  localStorage.removeItem(SESSION_KEY);

  session = null;
  resetRendering();

  if (ui.editDialog.open) {
    ui.editDialog.close();
  }

  ui.roleError.textContent = "";
  showRoleScreen();
});

async function restoreSession() {
  let candidate;

  try {
    migrateOldSession();
    candidate = readSavedSession(SESSION_KEY);
  } catch (error) {
    showRoleScreen();
    ui.roleError.textContent = error.message;
    return;
  }

  if (!candidate) {
    showRoleScreen();
    return;
  }

  ui.launchButton.disabled = true;

  try {
    const result = await api("/api/state", null, candidate);

    saveSession(candidate);
    resetRendering();
    session = candidate;
    applyState(result.state);
  } catch {
    showRoleScreen();

    if (candidate.role === "B") {
      document.querySelector(
        'input[name="role"][value="B"]'
      ).checked = true;

      ui.roomKey.value = candidate.key;
      updateRoleInputs();
    }

    ui.roleError.textContent =
      "前回の接続を復元できませんでした。"
      + "サーバーを確認してから起動してください。";
  } finally {
    ui.launchButton.disabled = false;
  }
}


// ============================================================
// 状態反映
// ============================================================

function applyState(newState) {
  if (!session || !newState) {
    return;
  }

  if (state && newState.version < state.version) {
    return;
  }

  const oldRunId = state?.run_id;
  state = newState;

  if (oldRunId && oldRunId !== newState.run_id) {
    pendingStudents.clear();
    cancelNameTap();

    if (ui.editDialog.open) {
      ui.editDialog.close();
      ui.notice.textContent =
        "走行が切り替わったため、編集画面を閉じました。";
    }
  }

  connected = true;
  lastReceivedAt = performance.now();

  elapsedBase = Number(newState.elapsed) || 0;
  elapsedBaseAt = performance.now();

  showAppScreen(newState.screen);
  updateConnectionDisplay();

  if (
    renderedVersion !== newState.version ||
    renderedScreen !== newState.screen
  ) {
    if (newState.screen === "setup") {
      renderSetup();
    } else {
      renderCounter();
    }

    renderedVersion = newState.version;
    renderedScreen = newState.screen;
  }

  updateControls();
}

function updateConnectionDisplay() {
  if (!session) {
    return;
  }

  ui.connectionInfo.textContent =
    `${session.role}：${session.role === "A" ? "親機" : "ゴール専用"}`
    + `　接続キー：${session.key}`;

  let text;
  let online = false;

  if (!connected) {
    text = "サーバーに接続できません。再接続を試みています。";
  } else if (session.role === "A") {
    online = Boolean(state?.b_connected);
    text = online
      ? "B接続中 — Aは最後の−1以外を操作できます。"
      : "B未接続 — ゴール記録前にBを接続してください。";
  } else {
    online = true;
    text = "サーバーと同期中 — 最後の−1を操作できます。";
  }

  ui.connectionStatus.textContent = text;
  ui.connectionStatus.className =
    `connection-status ${online ? "status-online" : "status-offline"}`;
}

function updateControls() {
  if (!session || !state) {
    return;
  }

  const isA = session.role === "A";
  const disabled = !isA || !connected || busy;

  ui.studentCount.disabled = disabled;
  ui.prepareButton.disabled = disabled;
  ui.setupButton.disabled = disabled;
  ui.resetButton.disabled = disabled;
  ui.startButton.disabled = disabled || state.running;

  ui.startButton.textContent = state.running
    ? "計測中"
    : "▶ スタート";

  ui.startButton.classList.toggle("running", state.running);

  if (state.screen === "counter") {
    updateCardPermissions();
  }
}


// ============================================================
// 人数選択
// ============================================================

function renderSetup() {
  if (
    session.role === "B" ||
    document.activeElement !== ui.studentCount
  ) {
    ui.studentCount.value = state.draft_count;
  }
}

function readStudentCount() {
  const count = Number(ui.studentCount.value);

  if (!Number.isInteger(count) || count < 1 || count > 40) {
    throw new Error("人数は1〜40名の整数で入力してください。");
  }

  return count;
}

ui.studentCount.addEventListener("input", () => {
  if (session?.role !== "A") {
    return;
  }

  clearTimeout(draftTimer);

  draftTimer = setTimeout(async () => {
    try {
      const count = readStudentCount();

      if (!connected || !session) {
        return;
      }

      const activeSession = session;
      const result = await api("/api/draft", { count }, activeSession);

      if (session === activeSession) {
        applyState(result.state);
      }
    } catch {
      // 入力途中の値は通知しない。
    }
  }, 250);
});

ui.prepareButton.addEventListener("click", () => {
  try {
    const count = readStudentCount();

    clearTimeout(draftTimer);
    performAction("/api/prepare", { count });
  } catch (error) {
    ui.notice.textContent = error.message;
  }
});


// ============================================================
// 記録画面
// ============================================================

function makeButton(className, text) {
  const button = document.createElement("button");

  button.type = "button";
  button.className = className;
  button.textContent = text;

  return button;
}

function applyGridSizing() {
  if (!state || state.screen !== "counter") {
    return;
  }

  const rows = Math.ceil(state.student_count / 2);
  const rowHeight = Math.max(1, ui.studentGrid.clientHeight) / rows;

  ui.studentGrid.style.gridTemplateRows =
    `repeat(${rows}, minmax(0, 1fr))`;

  ui.studentGrid.style.setProperty(
    "--name-size",
    `${Math.max(8, Math.min(22, rowHeight * 0.32))}px`
  );

  ui.studentGrid.style.setProperty(
    "--count-size",
    `${Math.max(9, Math.min(30, rowHeight * 0.46))}px`
  );

  ui.studentGrid.style.setProperty(
    "--button-size",
    `${Math.max(9, Math.min(27, rowHeight * 0.42))}px`
  );

  ui.studentGrid.style.setProperty(
    "--completed-size",
    `${Math.max(7, Math.min(15, rowHeight * 0.23))}px`
  );
}

function renderCounter() {
  ui.counterHelp.textContent = session.role === "A"
    ? "A：名前を1回タップで編集、2回タップでリタイヤ切替。ゴールはBが記録。"
    : "B：残り1周のランナーの最後の−1を操作できます。";

  ui.studentGrid.replaceChildren();

  for (const student of state.students) {
    const card = document.createElement("div");
    card.className = "student-card";
    card.dataset.studentId = student.id;

    if (student.retired) {
      card.classList.add("retired-card");
    }

    const nameButton = makeButton("name-cell", student.name);
    nameButton.title = student.name;
    nameButton.addEventListener("click", () => {
      handleNameTap(student.id);
    });

    const countCell = document.createElement("div");
    countCell.className = "count-cell";

    const finished =
      student.remaining === 0 &&
      student.finish_time !== null;

    if (student.retired) {
      countCell.classList.add("retired");
      countCell.textContent = "リタイヤ";
    } else if (finished) {
      countCell.classList.add("finished");
      countCell.textContent = formatTime(student.finish_time);
    } else {
      if (student.remaining === 1) {
        countCell.classList.add("last");
      }

      const caption = document.createElement("span");
      caption.className = "count-caption";
      caption.textContent = "のこり";

      const number = document.createElement("span");
      number.textContent = `${student.remaining} 周`;

      countCell.append(caption, number);
    }

    let minusCell;

    if (finished) {
      minusCell = document.createElement("div");
      minusCell.className = "completed-cell";

      const text = document.createElement("span");
      text.append("走った周数");
      text.append(document.createElement("br"));
      text.append(`${student.completed_laps} 周`);

      minusCell.append(text);
    } else {
      minusCell = makeButton("minus-cell", "−1");

      if (
        session.role === "B" &&
        student.remaining === 1 &&
        !student.retired
      ) {
        minusCell.classList.add("finish-ready");
      }

      minusCell.addEventListener("click", () => {
        changeRemaining(student.id, -1);
      });
    }

    const plusButton = makeButton("plus-cell", "＋1");
    plusButton.addEventListener("click", () => {
      changeRemaining(student.id, 1);
    });

    card.append(nameButton, countCell, minusCell, plusButton);
    ui.studentGrid.append(card);
  }

  requestAnimationFrame(() => {
    applyGridSizing();
    updateCardPermissions();
  });
}

function canChange(student, delta) {
  if (
    !session ||
    !state ||
    !connected ||
    busy ||
    state.screen !== "counter" ||
    !state.running ||
    student.retired
  ) {
    return false;
  }

  if (session.role === "A") {
    if (delta === -1) {
      return student.remaining >= 2;
    }

    if (delta === 1) {
      return student.remaining < student.target;
    }

    return false;
  }

  return (
    delta === -1 &&
    student.remaining === 1 &&
    student.finish_time === null &&
    !pendingStudents.has(student.id)
  );
}

function updateCardPermissions() {
  if (!session || !state || state.screen !== "counter") {
    return;
  }

  for (const student of state.students) {
    const card = ui.studentGrid.querySelector(
      `[data-student-id="${student.id}"]`
    );

    if (!card) {
      continue;
    }

    const nameButton = card.querySelector(".name-cell");
    const minusButton = card.querySelector(".minus-cell");
    const plusButton = card.querySelector(".plus-cell");

    nameButton.disabled =
      session.role !== "A" || !connected || busy;

    if (minusButton) {
      minusButton.disabled = !canChange(student, -1);
    }

    if (plusButton) {
      plusButton.disabled = !canChange(student, 1);
    }
  }
}

ui.startButton.addEventListener("click", () => {
  if (!state) {
    return;
  }

  performAction("/api/start", { run_id: state.run_id });
});

ui.resetButton.addEventListener("click", () => {
  if (!state) {
    return;
  }

  if (
    !confirm(
      "計測をリセットします。\n"
      + "タイマー、残り周数、完走記録、リタイヤ状態を初期化します。\n"
      + "人数・名前・目標周数は残ります。\n\n"
      + "よろしいですか？"
    )
  ) {
    return;
  }

  performAction("/api/reset", { run_id: state.run_id });
});

ui.setupButton.addEventListener("click", () => {
  if (!state) {
    return;
  }

  if (
    !confirm(
      "人数選択画面に戻ります。\n"
      + "次の走行では残り周数と完走記録がリセットされます。\n\n"
      + "よろしいですか？"
    )
  ) {
    return;
  }

  performAction("/api/setup", { run_id: state.run_id });
});

async function changeRemaining(studentId, delta) {
  if (!state || !session) {
    return;
  }

  const student = state.students.find((item) => item.id === studentId);

  if (!student || !canChange(student, delta)) {
    return;
  }

  if (session.role === "A") {
    await performAction("/api/change", {
      run_id: state.run_id,
      student_id: studentId,
      delta,
    });

    return;
  }

  const activeSession = session;
  const payload = {
    request_id: makeRequestId(),
    run_id: state.run_id,
    student_id: studentId,
    revision: student.revision,
  };

  pendingStudents.add(studentId);
  updateCardPermissions();

  try {
    const result = await api("/api/finish", payload, activeSession);

    if (session === activeSession) {
      ui.notice.textContent = "";
      applyState(result.state);
    }
  } catch {
    if (session === activeSession) {
      ui.notice.textContent =
        "ゴール操作の結果を確認できませんでした。"
        + "記録済みの場合もあるため、最新の完走表示を確認してください。";

      setOffline();
      await pollState();
    }
  } finally {
    pendingStudents.delete(studentId);
    updateCardPermissions();
  }
}


// ============================================================
// 名前タップ・リタイヤ
// ============================================================

function handleNameTap(studentId) {
  if (
    session?.role !== "A" ||
    !state ||
    !connected ||
    busy ||
    state.screen !== "counter"
  ) {
    return;
  }

  const now = performance.now();

  if (
    nameTapTimer !== null &&
    lastTappedStudentId === studentId &&
    now - lastTapAt <= DOUBLE_TAP_MS
  ) {
    cancelNameTap();
    toggleRetirement(studentId);
    return;
  }

  cancelNameTap();

  lastTappedStudentId = studentId;
  lastTapAt = now;

  const runId = state.run_id;

  nameTapTimer = setTimeout(() => {
    cancelNameTap();

    if (state && state.run_id === runId) {
      openEditDialog(studentId);
    }
  }, DOUBLE_TAP_MS);
}

function toggleRetirement(studentId) {
  if (
    session?.role !== "A" ||
    !state ||
    !connected ||
    busy ||
    state.screen !== "counter"
  ) {
    return;
  }

  const student = state.students.find((item) => item.id === studentId);

  if (!student) {
    return;
  }

  if (student.finish_time !== null) {
    ui.notice.textContent =
      "完走済みのランナーはリタイヤにできません。";
    return;
  }

  performAction("/api/retire", {
    run_id: state.run_id,
    student_id: studentId,
    revision: student.revision,
    retired: !student.retired,
  });
}


// ============================================================
// ランナー設定
// ============================================================

function openEditDialog(studentId) {
  if (
    session?.role !== "A" ||
    !connected ||
    busy ||
    !state ||
    state.screen !== "counter" ||
    ui.editDialog.open
  ) {
    return;
  }

  const student = state.students.find((item) => item.id === studentId);

  if (!student) {
    return;
  }

  editingStudentId = studentId;
  editingRunId = state.run_id;

  ui.editName.value = student.name;
  ui.editTarget.value = student.target;
  ui.editReset.checked = false;

  ui.editDialog.showModal();
  ui.editName.focus();
  ui.editName.select();
}

ui.cancelEditButton.addEventListener("click", () => {
  ui.editDialog.close();
});

ui.editForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (
    !state ||
    editingStudentId === null ||
    editingRunId !== state.run_id
  ) {
    return;
  }

  const student = state.students.find(
    (item) => item.id === editingStudentId
  );

  if (!student) {
    ui.editDialog.close();
    return;
  }

  const name = ui.editName.value.trim();
  const target = Number(ui.editTarget.value);

  if (!name || name.length > 100) {
    alert("名前は1〜100文字で入力してください。");
    return;
  }

  if (!Number.isInteger(target) || target < 1 || target > 9999) {
    alert("目標周数は1〜9999の整数で入力してください。");
    return;
  }

  const willReset =
    ui.editReset.checked || target !== student.target;

  if (
    willReset &&
    !confirm(
      "残り周数、完走記録、リタイヤ状態をリセットします。\n"
      + "共通タイマーはリセットされません。\n\n"
      + "よろしいですか？"
    )
  ) {
    return;
  }

  const payload = {
    run_id: editingRunId,
    student_id: editingStudentId,
    name,
    target,
    reset: ui.editReset.checked,
  };

  ui.editDialog.close();
  await performAction("/api/edit", payload);
});


// ============================================================
// 定期更新
// ============================================================

window.addEventListener("resize", applyGridSizing);

setInterval(pollState, POLL_INTERVAL_MS);

setInterval(() => {
  if (!session || !state) {
    return;
  }

  if (
    connected &&
    performance.now() - lastReceivedAt > CONNECTION_TIMEOUT_MS
  ) {
    setOffline();
  }

  ui.timer.textContent = formatTime(currentElapsed());
}, 50);

updateRoleInputs();
restoreSession();
