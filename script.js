const DB_NAME = "coaching-manager-db";
const DB_VERSION = 1;
const ATTENDANCE_STATUSES = ["not yet", "present", "absent", "sick", "else"];

let db;
let activeClassName = null;
let activeStudentFilter = "All";
let activeFeeFilter = "all";
let activeFeeMonth = monthKey();
let editingStudentId = null;

function todayKey() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function monthKey() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(year, monthNumber - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

function shiftMonth(month, delta) {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(year, monthNumber - 1 + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function amountValue(value) {
  return Math.max(0, Number(value || 0));
}

function money(value) {
  const amount = amountValue(value);
  return `$${amount.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function titleCase(value = "") {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getInitials(name = "") {
  return name
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains("classes")) {
        database.createObjectStore("classes", { keyPath: "name" });
      }

      if (!database.objectStoreNames.contains("students")) {
        const store = database.createObjectStore("students", {
          keyPath: "id",
          autoIncrement: true,
        });
        store.createIndex("batch", "batch", { unique: false });
      }

      if (!database.objectStoreNames.contains("attendance")) {
        const store = database.createObjectStore("attendance", {
          keyPath: "key",
        });
        store.createIndex("studentId", "studentId", { unique: false });
        store.createIndex("date", "date", { unique: false });
      }

      if (!database.objectStoreNames.contains("fees")) {
        const store = database.createObjectStore("fees", { keyPath: "key" });
        store.createIndex("studentId", "studentId", { unique: false });
        store.createIndex("month", "month", { unique: false });
        store.createIndex("status", "status", { unique: false });
      }

      if (!database.objectStoreNames.contains("settings")) {
        database.createObjectStore("settings", { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function store(name, mode = "readonly") {
  return db.transaction(name, mode).objectStore(name);
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function getAll(name) {
  return requestToPromise(store(name).getAll());
}

function getOne(name, key) {
  return requestToPromise(store(name).get(key));
}

async function putOne(name, value) {
  const transaction = db.transaction(name, "readwrite");
  transaction.objectStore(name).put(value);
  await txDone(transaction);
}

async function clearStore(name) {
  const transaction = db.transaction(name, "readwrite");
  transaction.objectStore(name).clear();
  await txDone(transaction);
}

async function migrateLocalStorage() {
  const migrated = await getOne("settings", "localStorageMigrated");
  if (migrated) return;

  const classes = JSON.parse(localStorage.getItem("classes") || "[]");
  const students = JSON.parse(localStorage.getItem("students") || "[]");

  for (const className of classes) {
    await putOne("classes", {
      name: className,
      createdAt: new Date().toISOString(),
    });
  }

  for (const student of students) {
    if (student.name && student.batch) {
      await putOne("students", {
        name: student.name,
        fathersName: student.fathersName || "",
        mobile: student.mobile || "",
        monthlyFee: Number(student.monthlyFee || 0),
        batch: student.batch,
        roll: student.roll || "",
        photo: student.photo || "",
        joined:
          student.joined ||
          new Date().toLocaleDateString("en-US", {
            month: "short",
            day: "2-digit",
            year: "numeric",
          }),
      });
      await putOne("classes", {
        name: student.batch,
        createdAt: new Date().toISOString(),
      });
    }
  }

  await putOne("settings", { key: "localStorageMigrated", value: true });
}

async function appData() {
  const classes = await getAll("classes");
  const students = await getAll("students");
  const attendance = await getAll("attendance");
  const fees = await getAll("fees");
  return { classes, students, attendance, fees };
}

async function ensureFeeRecords(students) {
  const month = activeFeeMonth;

  for (const student of students) {
    const key = `${month}_${student.id}`;
    const existing = await getOne("fees", key);
    if (!existing) {
      await putOne("fees", {
        key,
        studentId: student.id,
        month,
        amount: amountValue(student.monthlyFee),
        status: "pending",
        paidAt: "",
        note: "",
      });
    }
  }
}

function attendanceFor(attendance, studentId, date = todayKey()) {
  return attendance.find(
    (item) => item.studentId === studentId && item.date === date,
  );
}

function feeFor(fees, studentId, month = activeFeeMonth) {
  return fees.find(
    (item) => item.studentId === studentId && item.month === month,
  );
}

async function setAttendance(studentId, status) {
  const date = todayKey();
  await putOne("attendance", {
    key: `${date}_${studentId}`,
    studentId,
    date,
    status,
    updatedAt: new Date().toISOString(),
  });
  await refreshAll();
  showToast(`Attendance set to ${titleCase(status)}.`);
}

async function setFeeStatus(studentId, status) {
  const month = activeFeeMonth;
  const students = await getAll("students");
  const student = students.find((item) => item.id === studentId);
  const existing = await getOne("fees", `${month}_${studentId}`);

  await putOne("fees", {
    key: `${month}_${studentId}`,
    studentId,
    month,
    amount: amountValue(existing?.amount ?? student?.monthlyFee),
    status,
    paidAt: status === "paid" ? new Date().toLocaleDateString("en-US") : "",
    note: existing?.note || "",
  });

  await refreshAll();
  showToast(`Fee marked ${titleCase(status)}.`);
}

function createAvatar(student, className = "student-avatar") {
  if (student.photo) {
    return `<div class="${className}"><img src="${escapeHtml(student.photo)}" alt="${escapeHtml(student.name)}" /></div>`;
  }

  return `<div class="${className}">${getInitials(student.name)}</div>`;
}

function statusBadge(status = "pending") {
  const badgeClass =
    status === "paid" ? "success" : status === "overdue" ? "danger" : "pending";
  return `<span class="status-badge ${badgeClass}">${escapeHtml(titleCase(status))}</span>`;
}

async function getAdminProfile() {
  const saved = await getOne("settings", "adminProfile");
  return {
    name: "Admin Name",
    role: "Coaching Admin",
    image: "",
    coaching: "Coaching Manager",
    mobile: "",
    email: "",
    address: "",
    about:
      "Manage classes, students, attendance, and monthly fees from one place.",
    ...(saved?.value || {}),
  };
}

function profileImageMarkup(profile, className = "admin-avatar") {
  if (profile.image) {
    return `<div class="${className}"><img src="${escapeHtml(profile.image)}" alt="${escapeHtml(profile.name)}" /></div>`;
  }

  return `<div class="${className}">${getInitials(profile.name || profile.coaching)}</div>`;
}

function renderHomeStats(students, classes, fees) {
  const pending = fees
    .filter((fee) => fee.month === activeFeeMonth && fee.status !== "paid")
    .reduce((sum, fee) => sum + amountValue(fee.amount), 0);
  const paid = fees
    .filter((fee) => fee.month === activeFeeMonth && fee.status === "paid")
    .reduce((sum, fee) => sum + amountValue(fee.amount), 0);
  const activeToday = students.filter((student) => student.batch).length;

  document.getElementById("home-stats").innerHTML = `
    <div class="dashboard-stat primary">
      <span class="material-icons">groups</span>
      <div><strong>${students.length}</strong><p>Total Students</p></div>
    </div>
    <div class="dashboard-stat">
      <span class="material-icons">school</span>
      <div><strong>${classes.length}</strong><p>Class Sections</p></div>
    </div>
    <div class="dashboard-stat">
      <span class="material-icons">event_available</span>
      <div><strong>${activeToday}</strong><p>Active Records</p></div>
    </div>
    <div class="dashboard-stat money-stat">
      <span class="material-icons">payments</span>
      <div><strong>${money(paid)}</strong><p>Collected</p></div>
    </div>
    <div class="dashboard-stat money-stat warning">
      <span class="material-icons">pending_actions</span>
      <div><strong>${money(pending)}</strong><p>Pending</p></div>
    </div>
  `;
}

function renderClasses(classes, students, attendance) {
  const container = document.getElementById("classes-container");
  container.innerHTML = "";

  if (activeClassName) {
    renderClassStudents(activeClassName, students, attendance);
    return;
  }

  if (!classes.length) {
    container.innerHTML =
      '<p class="empty-state">No classes yet. Add a class to begin.</p>';
    return;
  }

  classes
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((classItem) => {
      const classStudents = students.filter(
        (student) => student.batch === classItem.name,
      );
      const marked = classStudents.filter((student) =>
        attendanceFor(attendance, student.id),
      ).length;
      const button = document.createElement("button");
      button.className = "class-card";
      button.type = "button";
      button.innerHTML = `
        <span class="material-icons">school</span>
        <div>
          <h3>${escapeHtml(classItem.name)}</h3>
          <p>${classStudents.length} students · ${marked}/${classStudents.length} marked today</p>
        </div>
        <span class="material-icons chevron">chevron_right</span>
      `;
      button.addEventListener("click", async () => {
        activeClassName = classItem.name;
        await refreshAll();
      });
      container.appendChild(button);
    });
}

function renderClassStudents(className, students, attendance) {
  const container = document.getElementById("classes-container");
  const classStudents = students.filter(
    (student) => student.batch === className,
  );

  container.innerHTML = `
    <div class="class-students-view">
      <div class="class-view-header">
        <button class="icon-btn" id="back-to-classes" title="Back to classes">
          <span class="material-icons">arrow_back_ios_new</span>
        </button>
        <div>
          <h3>${escapeHtml(className)}</h3>
          <p>${classStudents.length} student${classStudents.length === 1 ? "" : "s"}</p>
        </div>
      </div>
      <div class="class-student-list"></div>
      <button class="fab btn class-add-student" title="Add Student">
        <span class="material-icons">person_add</span>
      </button>
    </div>
  `;

  document
    .getElementById("back-to-classes")
    .addEventListener("click", async () => {
      activeClassName = null;
      await refreshAll();
    });

  container
    .querySelector(".class-add-student")
    .addEventListener("click", () => {
      openStudentModal({ batch: className });
    });

  const list = container.querySelector(".class-student-list");
  if (!classStudents.length) {
    list.innerHTML =
      '<p class="empty-state">No students in this class yet.</p>';
    return;
  }

  classStudents.forEach((student) => {
    list.appendChild(
      studentCard(
        student,
        attendanceFor(attendance, student.id)?.status || "not yet",
      ),
    );
  });
}

function studentCard(student, todayStatus) {
  const card = document.createElement("div");
  card.className = "card student-card";
  card.innerHTML = `
    <div class="student-header">
      ${createAvatar(student)}
      <div class="student-basic-info">
        <div class="name-row">
          <h4>${escapeHtml(student.name)}</h4>
          <span class="attendance-dot ${todayStatus.replace(" ", "-")}" title="${escapeHtml(titleCase(todayStatus))}"></span>
        </div>
        <p>${student.roll ? `Roll ${escapeHtml(student.roll)} | ` : ""}${escapeHtml(student.batch)}</p>
        <div class="student-meta-row">
          <span><span class="material-icons">call</span>${escapeHtml(student.mobile || "No mobile")}</span>
          <span><span class="material-icons">payments</span>${money(student.monthlyFee)}</span>
          <span class="mini-status ${todayStatus.replace(" ", "-")}">${escapeHtml(titleCase(todayStatus))}</span>
        </div>
      </div>
      <div class="header-actions">
        <button class="icon-btn call-btn" title="Call"><span class="material-icons">call</span></button>
        <button class="icon-btn edit-btn" title="Edit"><span class="material-icons">edit</span></button>
        <button class="icon-btn profile-btn" title="Details"><span class="material-icons">visibility</span></button>
      </div>
    </div>
  `;

  card
    .querySelector(".student-header")
    .addEventListener("click", () => openStudentDetails(student.id));
  card.querySelector(".call-btn").addEventListener("click", (event) => {
    event.stopPropagation();
    showToast(
      student.mobile ? `Calling ${student.mobile}` : "No mobile number saved.",
    );
  });
  card.querySelector(".edit-btn").addEventListener("click", (event) => {
    event.stopPropagation();
    openStudentModal(student);
  });
  card.querySelector(".profile-btn").addEventListener("click", (event) => {
    event.stopPropagation();
    openStudentDetails(student.id);
  });

  return card;
}

function renderAttendance(classes, students, attendance) {
  const container = document.getElementById("attendance-container");
  document.getElementById("attendance-date-label").textContent =
    new Date().toLocaleDateString("en-US", {
      weekday: "long",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  container.innerHTML = "";

  if (!classes.length) {
    container.innerHTML =
      '<p class="empty-state">Add classes and students to mark attendance.</p>';
    return;
  }

  classes
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((classItem) => {
      const classStudents = students.filter(
        (student) => student.batch === classItem.name,
      );
      const marked = classStudents.filter((student) =>
        attendanceFor(attendance, student.id),
      ).length;
      const section = document.createElement("div");
      section.className = "card attendance-class-card accordion";
      section.innerHTML = `
        <button class="attendance-class-head accordion-header" type="button">
          <span class="material-icons">fact_check</span>
          <div>
            <h3>${escapeHtml(classItem.name)}</h3>
            <p>${marked}/${classStudents.length} marked today</p>
          </div>
          <span class="material-icons chevron">expand_more</span>
        </button>
        <div class="category-content">
          <div class="attendance-list"></div>
        </div>
      `;

      const list = section.querySelector(".attendance-list");
      if (!classStudents.length) {
        list.innerHTML =
          '<p class="empty-state">No students in this class.</p>';
      }

      classStudents.forEach((student) => {
        const current =
          attendanceFor(attendance, student.id)?.status || "not yet";
        const row = document.createElement("div");
        row.className = "attendance-row";
        row.innerHTML = `
          <div class="attendance-student">
            ${createAvatar(student, "student-avatar small")}
            <div>
              <h4>${escapeHtml(student.name)}</h4>
              <p>${student.roll ? `Roll ${escapeHtml(student.roll)}` : "No roll"}</p>
            </div>
          </div>
          <div class="status-control"></div>
        `;

        const controls = row.querySelector(".status-control");
        ATTENDANCE_STATUSES.forEach((status) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = `status-pill ${status.replace(" ", "-")} ${current === status ? "active" : ""}`;
          button.textContent = titleCase(status);
          button.addEventListener("click", () =>
            setAttendance(student.id, status),
          );
          controls.appendChild(button);
        });

        list.appendChild(row);
      });

      container.appendChild(section);
      section
        .querySelector(".attendance-class-head")
        .addEventListener("click", () => {
          section.classList.toggle("open");
        });
    });
}

function renderStudents(classes, students, attendance) {
  const filters = document.getElementById("student-class-filters");
  const list = document.getElementById("all-students-list");
  const search = document
    .getElementById("student-search")
    .value.trim()
    .toLowerCase();
  const classNames = ["All", ...classes.map((item) => item.name).sort()];

  filters.innerHTML = "";
  classNames.forEach((className) => {
    const button = document.createElement("button");
    button.className = `chip ${activeStudentFilter === className ? "active" : ""}`;
    button.textContent = className;
    button.addEventListener("click", async () => {
      activeStudentFilter = className;
      await refreshAll();
    });
    filters.appendChild(button);
  });

  const filtered = students
    .filter(
      (student) =>
        activeStudentFilter === "All" || student.batch === activeStudentFilter,
    )
    .filter((student) => {
      const value =
        `${student.name} ${student.batch} ${student.roll} ${student.mobile}`.toLowerCase();
      return value.includes(search);
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  list.innerHTML = "";
  if (!filtered.length) {
    list.innerHTML = '<p class="empty-state">No students match this view.</p>';
    return;
  }

  filtered.forEach((student) => {
    list.appendChild(
      studentCard(
        student,
        attendanceFor(attendance, student.id)?.status || "not yet",
      ),
    );
  });
}

function renderFees(students, fees) {
  const stats = document.getElementById("fee-stats");
  const filters = document.getElementById("fee-filters");
  const container = document.getElementById("fees-container");
  document.getElementById("fee-month-label").textContent =
    monthLabel(activeFeeMonth);
  const currentFees = students.map((student) => ({
    student,
    fee: feeFor(fees, student.id) || {
      amount: amountValue(student.monthlyFee),
      status: "pending",
      paidAt: "",
    },
  }));

  const collected = currentFees
    .filter((item) => item.fee.status === "paid")
    .reduce((sum, item) => sum + amountValue(item.fee.amount), 0);
  const pending = currentFees
    .filter((item) => item.fee.status === "pending")
    .reduce((sum, item) => sum + amountValue(item.fee.amount), 0);
  const overdue = currentFees
    .filter((item) => item.fee.status === "overdue")
    .reduce((sum, item) => sum + amountValue(item.fee.amount), 0);

  stats.innerHTML = `
    <div class="stat-item"><span>${money(collected)}</span>Collected</div>
    <div class="stat-item"><span>${money(pending)}</span>Pending</div>
    <div class="stat-item"><span>${money(overdue)}</span>Overdue</div>
  `;

  filters.innerHTML = "";
  [
    ["all", "All"],
    ["pending", "Pending"],
    ["overdue", "Overdue"],
    ["paid", "Paid"],
  ].forEach(([value, label]) => {
    const button = document.createElement("button");
    button.className = `chip ${activeFeeFilter === value ? "active" : ""}`;
    button.textContent = label;
    button.addEventListener("click", async () => {
      activeFeeFilter = value;
      await refreshAll();
    });
    filters.appendChild(button);
  });

  const visible = currentFees.filter(
    (item) => activeFeeFilter === "all" || item.fee.status === activeFeeFilter,
  );
  container.innerHTML = "";

  if (!visible.length) {
    container.innerHTML =
      '<p class="empty-state">No fee records in this view.</p>';
    return;
  }

  visible.forEach(({ student, fee }) => {
    const card = document.createElement("div");
    card.className = "card fee-card";
    card.innerHTML = `
      <div class="fee-main">
        ${createAvatar(student, "student-avatar small")}
        <div class="task-info">
          <h4>${escapeHtml(student.name)}</h4>
          <p>${escapeHtml(monthLabel(activeFeeMonth))} | ${escapeHtml(student.batch)} | ${money(fee.amount)}</p>
          ${fee.paidAt ? `<p>Paid on ${escapeHtml(fee.paidAt)}</p>` : ""}
        </div>
        ${statusBadge(fee.status)}
      </div>
      <div class="fee-actions">
        <button class="btn-small" data-status="paid">Paid</button>
        <button class="btn-small" data-status="pending">Pending</button>
        <button class="btn-small danger-outline" data-status="overdue">Overdue</button>
        <button class="btn-small remind-btn">Remind</button>
      </div>
    `;

    card.querySelectorAll("[data-status]").forEach((button) => {
      button.addEventListener("click", () =>
        setFeeStatus(student.id, button.dataset.status),
      );
    });
    card.querySelector(".remind-btn").addEventListener("click", () => {
      showToast(
        `Reminder ready for ${student.name}: ${money(fee.amount)} is ${fee.status}.`,
      );
    });
    container.appendChild(card);
  });
}

function renderFeesByClass(students, fees) {
  const stats = document.getElementById("fee-stats");
  const filters = document.getElementById("fee-filters");
  const container = document.getElementById("fees-container");
  document.getElementById("fee-month-label").textContent =
    monthLabel(activeFeeMonth);

  const currentFees = students.map((student) => ({
    student,
    fee: feeFor(fees, student.id) || {
      amount: amountValue(student.monthlyFee),
      status: "pending",
      paidAt: "",
    },
  }));

  const collected = currentFees
    .filter((item) => item.fee.status === "paid")
    .reduce((sum, item) => sum + amountValue(item.fee.amount), 0);
  const pending = currentFees
    .filter((item) => item.fee.status === "pending")
    .reduce((sum, item) => sum + amountValue(item.fee.amount), 0);
  const overdue = currentFees
    .filter((item) => item.fee.status === "overdue")
    .reduce((sum, item) => sum + amountValue(item.fee.amount), 0);

  stats.innerHTML = `
    <div class="stat-item"><span>${money(collected)}</span>Collected</div>
    <div class="stat-item"><span>${money(pending)}</span>Pending</div>
    <div class="stat-item"><span>${money(overdue)}</span>Overdue</div>
  `;

  filters.innerHTML = "";
  [
    ["all", "All"],
    ["pending", "Pending"],
    ["overdue", "Overdue"],
    ["paid", "Paid"],
  ].forEach(([value, label]) => {
    const button = document.createElement("button");
    button.className = `chip ${activeFeeFilter === value ? "active" : ""}`;
    button.textContent = label;
    button.addEventListener("click", async () => {
      activeFeeFilter = value;
      await refreshAll();
    });
    filters.appendChild(button);
  });

  const visible = currentFees.filter(
    (item) => activeFeeFilter === "all" || item.fee.status === activeFeeFilter,
  );
  container.innerHTML = "";

  if (!visible.length) {
    container.innerHTML =
      '<p class="empty-state">No fee records in this view.</p>';
    return;
  }

  const grouped = new Map();
  visible.forEach((record) => {
    if (!grouped.has(record.student.batch))
      grouped.set(record.student.batch, []);
    grouped.get(record.student.batch).push(record);
  });

  [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([className, records]) => {
      const paidCount = records.filter(
        ({ fee }) => fee.status === "paid",
      ).length;
      const section = document.createElement("div");
      section.className = "card fee-class-card accordion";
      section.innerHTML = `
      <button class="fee-class-head accordion-header" type="button">
        <span class="material-icons">account_balance_wallet</span>
        <div>
          <h3>${escapeHtml(className)}</h3>
          <p>${paidCount}/${records.length} paid for ${escapeHtml(monthLabel(activeFeeMonth))}</p>
        </div>
        <span class="material-icons chevron">expand_more</span>
      </button>
      <div class="category-content">
        <div class="fee-list"></div>
      </div>
    `;

      const list = section.querySelector(".fee-list");
      records
        .sort((a, b) => a.student.name.localeCompare(b.student.name))
        .forEach(({ student, fee }) => {
          const card = document.createElement("div");
          card.className = "fee-card";
          card.innerHTML = `
        <div class="fee-main">
          ${createAvatar(student, "student-avatar small")}
          <div class="task-info">
            <h4>${escapeHtml(student.name)}</h4>
            <p>${escapeHtml(monthLabel(activeFeeMonth))} | ${money(fee.amount)}</p>
            ${fee.paidAt ? `<p>Paid on ${escapeHtml(fee.paidAt)}</p>` : ""}
          </div>
          ${statusBadge(fee.status)}
        </div>
        <div class="fee-actions">
          <button class="btn-small" data-status="paid">Paid</button>
          <button class="btn-small" data-status="pending">Pending</button>
          <button class="btn-small danger-outline" data-status="overdue">Overdue</button>
          <button class="btn-small remind-btn">Remind</button>
        </div>
      `;

          card.querySelectorAll("[data-status]").forEach((button) => {
            button.addEventListener("click", () =>
              setFeeStatus(student.id, button.dataset.status),
            );
          });
          card.querySelector(".remind-btn").addEventListener("click", () => {
            showToast(
              `Reminder ready for ${student.name}: ${money(fee.amount)} is ${fee.status}.`,
            );
          });
          list.appendChild(card);
        });

      container.appendChild(section);
      section.querySelector(".fee-class-head").addEventListener("click", () => {
        section.classList.toggle("open");
      });
    });
}

async function openStudentDetails(studentId) {
  const [students, attendance, fees] = await Promise.all([
    getAll("students"),
    getAll("attendance"),
    getAll("fees"),
  ]);
  const student = students.find((item) => item.id === studentId);
  if (!student) return;

  const counts = ATTENDANCE_STATUSES.reduce((result, status) => {
    result[status] = attendance.filter(
      (item) => item.studentId === student.id && item.status === status,
    ).length;
    return result;
  }, {});
  const today = attendanceFor(attendance, student.id)?.status || "not yet";
  const currentFee = feeFor(fees, student.id) || {
    status: "pending",
    amount: student.monthlyFee,
  };
  const detailsModal = document.getElementById("student-details-modal");
  const detailsContent = document.getElementById("student-details-content");

  detailsContent.innerHTML = `
    <div class="student-profile-head">
      ${createAvatar(student, "student-profile-photo")}
      <h3>${escapeHtml(student.name)}</h3>
      <p>${escapeHtml(student.batch || "No class assigned")}</p>
    </div>
    <div class="profile-stat-grid">
      ${ATTENDANCE_STATUSES.map(
        (status) =>
          `<div><span>${counts[status]}</span>${escapeHtml(titleCase(status))}</div>`,
      ).join("")}
    </div>
    <div class="student-details-grid profile-details">
      <div class="detail-row"><strong>Today:</strong><span>${escapeHtml(titleCase(today))}</span></div>
      <div class="detail-row"><strong>Fee:</strong><span>${money(currentFee.amount)} | ${escapeHtml(titleCase(currentFee.status))}</span></div>
      <div class="detail-row"><strong>Roll No:</strong><span>${escapeHtml(student.roll || "N/A")}</span></div>
      <div class="detail-row"><strong>Father's Name:</strong><span>${escapeHtml(student.fathersName || "N/A")}</span></div>
      <div class="detail-row"><strong>Mobile:</strong><span>${escapeHtml(student.mobile || "N/A")}</span></div>
      <div class="detail-row"><strong>Joined:</strong><span>${escapeHtml(student.joined || "N/A")}</span></div>
    </div>
  `;

  detailsModal.classList.add("active");
}

function openStudentModal(student = {}) {
  editingStudentId = student.id || null;
  document.getElementById("student-modal-title").textContent = editingStudentId
    ? "Edit Student"
    : "Add New Student";
  document.getElementById("submit-student").textContent = editingStudentId
    ? "Save Student"
    : "Add Student";
  document.getElementById("student-name").value = student.name || "";
  document.getElementById("student-fathers-name").value =
    student.fathersName || "";
  document.getElementById("student-mobile").value = student.mobile || "";
  document.getElementById("student-monthly-fee").value =
    student.monthlyFee || "";
  document.getElementById("student-batch").value = student.batch || "";
  document.getElementById("student-roll").value = student.roll || "";
  document.getElementById("student-photo").value = student.photo || "";
  document.getElementById("create-student-modal").classList.add("active");
  document.getElementById("student-name").focus();
}

function closeStudentModal() {
  editingStudentId = null;
  document.getElementById("create-student-modal").classList.remove("active");
  document.getElementById("student-modal-title").textContent =
    "Add New Student";
  document.getElementById("submit-student").textContent = "Add Student";
  [
    "student-name",
    "student-fathers-name",
    "student-mobile",
    "student-monthly-fee",
    "student-batch",
    "student-roll",
    "student-photo",
  ].forEach((id) => {
    document.getElementById(id).value = "";
  });
}

async function saveStudentFromModal() {
  const student = {
    name: document.getElementById("student-name").value.trim(),
    fathersName: document.getElementById("student-fathers-name").value.trim(),
    mobile: document.getElementById("student-mobile").value.trim(),
    monthlyFee: amountValue(
      document.getElementById("student-monthly-fee").value,
    ),
    batch: document.getElementById("student-batch").value.trim(),
    roll: document.getElementById("student-roll").value.trim(),
    photo: document.getElementById("student-photo").value.trim(),
  };

  if (!student.name || !student.batch) {
    showToast("Student name and class are required.");
    return;
  }

  const existing = editingStudentId
    ? await getOne("students", editingStudentId)
    : null;
  await putOne("classes", {
    name: student.batch,
    createdAt: existing?.createdAt || new Date().toISOString(),
  });
  const record = {
    ...existing,
    ...student,
    joined:
      existing?.joined ||
      new Date().toLocaleDateString("en-US", {
        month: "short",
        day: "2-digit",
        year: "numeric",
      }),
  };

  if (editingStudentId) {
    record.id = editingStudentId;
  }

  await putOne("students", record);

  closeStudentModal();
  await refreshAll();
  showToast(editingStudentId ? "Student updated." : "Student added.");
}

async function addClassFromModal() {
  const input = document.getElementById("class-name");
  const className = input.value.trim();
  if (!className) {
    showToast("Please enter a class name.");
    return;
  }

  await putOne("classes", {
    name: className,
    createdAt: new Date().toISOString(),
  });
  input.value = "";
  document.getElementById("create-class-modal").classList.remove("active");
  await refreshAll();
  showToast("Class added.");
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function exportCSV() {
  const { students, attendance, fees } = await appData();
  const rows = [
    [
      "Name",
      "Class",
      "Roll",
      "Mobile",
      "Monthly Fee",
      "Today Attendance",
      "Current Fee Status",
    ],
  ];

  students.forEach((student) => {
    rows.push([
      student.name,
      student.batch,
      student.roll || "",
      student.mobile || "",
      student.monthlyFee || 0,
      attendanceFor(attendance, student.id)?.status || "not yet",
      feeFor(fees, student.id)?.status || "pending",
    ]);
  });

  const csv = rows
    .map((row) =>
      row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","),
    )
    .join("\n");

  downloadFile(`coaching-students-${todayKey()}.csv`, csv, "text/csv");
  showToast("CSV exported.");
}

async function exportJSON() {
  const data = await appData();
  downloadFile(
    `coaching-backup-${todayKey()}.json`,
    JSON.stringify(data, null, 2),
    "application/json",
  );
  showToast("Backup downloaded.");
}

async function importJSON(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  await clearStore("classes");
  await clearStore("students");
  await clearStore("attendance");
  await clearStore("fees");

  for (const item of data.classes || []) await putOne("classes", item);
  for (const item of data.students || []) await putOne("students", item);
  for (const item of data.attendance || []) await putOne("attendance", item);
  for (const item of data.fees || []) await putOne("fees", item);

  await refreshAll();
  showToast("Backup restored.");
}

async function clearAllData() {
  if (!confirm("Clear all classes, students, attendance, and fee records?"))
    return;
  await clearStore("classes");
  await clearStore("students");
  await clearStore("attendance");
  await clearStore("fees");
  activeClassName = null;
  await refreshAll();
  showToast("All data cleared.");
}

async function openAdminProfile() {
  const profile = await getAdminProfile();
  const modal = document.getElementById("admin-profile-modal");
  const view = document.getElementById("admin-profile-view");

  view.innerHTML = `
    <div class="admin-profile-card">
      ${profileImageMarkup(profile)}
      <div class="admin-profile-main">
        <h3>${escapeHtml(profile.name)}</h3>
        <p>${escapeHtml(profile.role)} | ${escapeHtml(profile.coaching)}</p>
      </div>
    </div>
    <div class="admin-contact-grid">
      <div><span class="material-icons">call</span><strong>Mobile</strong><p>${escapeHtml(profile.mobile || "Not set")}</p></div>
      <div><span class="material-icons">mail</span><strong>Email</strong><p>${escapeHtml(profile.email || "Not set")}</p></div>
      <div class="wide"><span class="material-icons">location_on</span><strong>Address</strong><p>${escapeHtml(profile.address || "Not set")}</p></div>
      <div class="wide"><span class="material-icons">info</span><strong>About</strong><p>${escapeHtml(profile.about || "Not set")}</p></div>
    </div>
  `;

  document.getElementById("admin-name").value = profile.name;
  document.getElementById("admin-role").value = profile.role;
  document.getElementById("admin-image").value = profile.image;
  document.getElementById("admin-coaching").value = profile.coaching;
  document.getElementById("admin-mobile").value = profile.mobile;
  document.getElementById("admin-email").value = profile.email;
  document.getElementById("admin-address").value = profile.address;
  document.getElementById("admin-about").value = profile.about;
  modal.classList.add("active");
}

async function saveAdminProfile(event) {
  event.preventDefault();
  const profile = {
    name: document.getElementById("admin-name").value.trim() || "Admin Name",
    role:
      document.getElementById("admin-role").value.trim() || "Coaching Admin",
    image: document.getElementById("admin-image").value.trim(),
    coaching:
      document.getElementById("admin-coaching").value.trim() ||
      "Coaching Manager",
    mobile: document.getElementById("admin-mobile").value.trim(),
    email: document.getElementById("admin-email").value.trim(),
    address: document.getElementById("admin-address").value.trim(),
    about: document.getElementById("admin-about").value.trim(),
  };

  await putOne("settings", { key: "adminProfile", value: profile });
  await putOne("settings", { key: "coachingName", value: profile.coaching });
  showToast("Admin profile saved.");
  await openAdminProfile();
}

function closeAdminProfile() {
  document.getElementById("admin-profile-modal").classList.remove("active");
}

async function handleSettingsAction(action) {
  const { students, fees } = await appData();

  switch (action) {
    case "profile":
      await openAdminProfile();
      break;
    case "export-csv":
      await exportCSV();
      break;
    case "export-json":
      await exportJSON();
      break;
    case "import-json":
      document.getElementById("import-json-input").click();
      break;
    case "monthly-bill": {
      const lines = students.map((student) => {
        const fee = feeFor(fees, student.id) || {
          amount: student.monthlyFee,
          status: "pending",
        };
        return `${student.name} | ${student.batch} | ${money(fee.amount)} | ${titleCase(fee.status)}`;
      });
      downloadFile(
        `monthly-bills-${activeFeeMonth}.txt`,
        lines.join("\n"),
        "text/plain",
      );
      showToast("Monthly bill list generated.");
      break;
    }
    case "admit-marksheet":
      downloadFile(
        `admit-list-${todayKey()}.txt`,
        students
          .map(
            (student) =>
              `${student.roll || ""} | ${student.name} | ${student.batch}`,
          )
          .join("\n"),
        "text/plain",
      );
      showToast("Academic list generated.");
      break;
    case "id-card":
      downloadFile(
        `id-cards-${todayKey()}.txt`,
        students
          .map(
            (student) =>
              `${student.name}\nClass: ${student.batch}\nRoll: ${student.roll || "N/A"}\nMobile: ${student.mobile || "N/A"}\n`,
          )
          .join("\n"),
        "text/plain",
      );
      showToast("ID card data generated.");
      break;
    case "send-sms":
      showToast(
        `SMS list ready for ${students.filter((student) => student.mobile).length} contacts.`,
      );
      break;
    case "clear-demo":
      await clearAllData();
      break;
    case "support":
      alert(
        "Use Home to create classes, Students to manage profiles, Tasks to mark attendance, and Fees to track payments.",
      );
      break;
  }
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("active");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("active"), 2200);
}

async function refreshAll() {
  const data = await appData();
  await ensureFeeRecords(data.students);
  const freshData = await appData();
  renderHomeStats(freshData.students, freshData.classes, freshData.fees);
  renderClasses(freshData.classes, freshData.students, freshData.attendance);
  renderAttendance(freshData.classes, freshData.students, freshData.attendance);
  renderStudents(freshData.classes, freshData.students, freshData.attendance);
  renderFeesByClass(freshData.students, freshData.fees);
}

function setupNavigation() {
  const navItems = document.querySelectorAll(".nav-item");
  const pages = document.querySelectorAll(".page");
  const pageTitle = document.getElementById("page-title");

  navItems.forEach((item) => {
    item.addEventListener("click", (event) => {
      event.preventDefault();
      const targetPage = item.getAttribute("data-page");
      navItems.forEach((nav) => nav.classList.remove("active"));
      item.classList.add("active");
      pages.forEach((page) =>
        page.classList.toggle("active", page.id === targetPage),
      );
      pageTitle.textContent = item.querySelector("span:last-child").textContent;
    });
  });
}

function setupModals() {
  const classModal = document.getElementById("create-class-modal");
  document
    .querySelector('#home .fab[title="Add Class"]')
    .addEventListener("click", () => {
      classModal.classList.add("active");
      document.getElementById("class-name").focus();
    });
  document.getElementById("cancel-class").addEventListener("click", () => {
    classModal.classList.remove("active");
  });
  document
    .getElementById("submit-class")
    .addEventListener("click", addClassFromModal);
  classModal.addEventListener("click", (event) => {
    if (event.target === classModal) classModal.classList.remove("active");
  });

  const studentModal = document.getElementById("create-student-modal");
  document
    .querySelector('#students .fab[title="Add Student"]')
    .addEventListener("click", () => openStudentModal());
  document
    .getElementById("cancel-student")
    .addEventListener("click", closeStudentModal);
  document
    .getElementById("submit-student")
    .addEventListener("click", saveStudentFromModal);
  studentModal.addEventListener("click", (event) => {
    if (event.target === studentModal) closeStudentModal();
  });

  const detailsModal = document.getElementById("student-details-modal");
  document
    .getElementById("close-student-details")
    .addEventListener("click", () => {
      detailsModal.classList.remove("active");
    });
  detailsModal.addEventListener("click", (event) => {
    if (event.target === detailsModal) detailsModal.classList.remove("active");
  });

  const adminModal = document.getElementById("admin-profile-modal");
  document
    .getElementById("close-admin-profile")
    .addEventListener("click", closeAdminProfile);
  document
    .getElementById("cancel-admin-profile")
    .addEventListener("click", closeAdminProfile);
  document
    .getElementById("admin-profile-form")
    .addEventListener("submit", saveAdminProfile);
  adminModal.addEventListener("click", (event) => {
    if (event.target === adminModal) closeAdminProfile();
  });
}

function setupSettings() {
  document.querySelectorAll(".settings-item").forEach((item) => {
    item.addEventListener("click", () =>
      handleSettingsAction(item.dataset.action),
    );
  });

  document
    .getElementById("import-json-input")
    .addEventListener("change", async (event) => {
      const [file] = event.target.files;
      if (!file) return;

      try {
        await importJSON(file);
      } catch (error) {
        showToast("Could not import that backup.");
      } finally {
        event.target.value = "";
      }
    });
}

function setupFeeMonthControls() {
  document
    .getElementById("fee-prev-month")
    .addEventListener("click", async () => {
      activeFeeMonth = shiftMonth(activeFeeMonth, -1);
      await refreshAll();
    });

  document
    .getElementById("fee-next-month")
    .addEventListener("click", async () => {
      activeFeeMonth = shiftMonth(activeFeeMonth, 1);
      await refreshAll();
    });
}

document.addEventListener("DOMContentLoaded", async () => {
  db = await openDB();
  await migrateLocalStorage();
  setupNavigation();
  setupModals();
  setupSettings();
  setupFeeMonthControls();
  document
    .getElementById("student-search")
    .addEventListener("input", refreshAll);
  await refreshAll();
});
