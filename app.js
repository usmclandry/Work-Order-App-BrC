(function () {
  var SESSION_KEY = "jsw.session";
  var THEME_KEY = "jsw.theme";
  var STATUS_LABEL = {
    new: "New",
    in_progress: "In Progress",
    waiting: "Waiting",
    done: "Done",
    canceled: "Canceled"
  };
  var PRIORITY_LABEL = { low: "Low", normal: "Normal", high: "High" };
  var view = { name: "orders" };
  var client = null;
  var user = null;
  var errorText = "";
  var notice = "";
  var busy = false;
  var search = "";
  var filters = { assignee: "", status: "open", tag: "", equipment: "" };
  var dialog = null;
  var settingsOpen = false;
  var printOpen = false;
  var homeMode = "activity";
  var listReturn = "orders";
  var formOpenedAt = 0;
  var ordersMode = "list";
  var calendarCursor = null;
  var calendarDay = "";
  var openGroups = { today: true, week: false, upcoming: false, recent: false };
  var previewState = null;
  var chain = Promise.resolve();

  document.addEventListener("DOMContentLoaded", boot);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && client) enqueue(reload);
  });

  function enqueue(fn) {
    var run = chain.then(fn, fn);
    chain = run.then(function () {}, function () {});
    return run;
  }

  async function boot() {
    localStorage.removeItem("jsw.token");
    localStorage.removeItem("jsw.repo");
    var saved = localStorage.getItem(SESSION_KEY) || "";
    if (saved) {
      try { await connectSession(JSON.parse(saved)); }
      catch (error) {
        localStorage.removeItem(SESSION_KEY);
        errorText = error.message;
      }
    }
    render();
  }

  function rememberSession(session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  async function connect(email, password) {
    var session = await JobSupabase.signIn(email, password);
    try {
      await connectSession(session);
    } catch (error) {
      localStorage.removeItem(SESSION_KEY);
      throw error;
    }
  }

  async function connectSession(session) {
    var current = session;
    var nextUser = JobSupabase.actorFromUser(session.user);
    var nextClient = JobSupabase.createClient({
      session: session,
      actor: nextUser,
      onSession: function (next) {
        current = next;
        rememberSession(next);
      }
    });
    await nextClient.load();
    var people = nextClient.snapshot().settings.people;
    var knownPerson = people.find(function (person) { return person.id === nextUser.id; });
    if (!knownPerson && people.length >= 2) throw new Error("Only two people can use this app.");
    if (knownPerson) nextUser.displayName = knownPerson.displayName;
    nextClient.setActor(nextUser);
    user = nextUser;
    client = nextClient;
    if (!knownPerson) await client.save({ type: "addPerson", displayName: user.displayName });
    rememberSession(current);
    errorText = "";
  }

  function data() {
    if (previewState) {
      return { settings: previewState.settings, equipment: previewState.equipment, work: previewState.work };
    }
    return client.snapshot();
  }

  function today() {
    var now = new Date();
    return now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
  }

  function pad(value) { return String(value).padStart(2, "0"); }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
    });
  }

  function nameOf(id) {
    return JobModel.displayName(data().settings, id);
  }

  function when(iso) {
    if (!iso) return "";
    var date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function tagsInUse() {
    var tags = [];
    data().equipment.equipment.forEach(function (item) { tags = tags.concat(item.tags); });
    data().work.orders.forEach(function (order) { tags = tags.concat(order.tags); });
    return JobModel.parseTags(tags);
  }

  function visibleOrders() {
    var current = data();
    var orders = current.work.orders;
    if (search.trim()) orders = JobModel.searchAll(search, current.settings, current.equipment, current.work).orders;
    orders = orders.filter(function (order) {
      if (filters.assignee === "unassigned" && order.assignee) return false;
      if (filters.assignee && filters.assignee !== "unassigned" && order.assignee !== filters.assignee) return false;
      if (filters.status === "open" && !search.trim() && !JobModel.isOpenStatus(order.status)) return false;
      if (filters.status !== "open" && filters.status !== "all" && order.status !== filters.status) return false;
      if (filters.tag && !order.tags.some(function (tag) { return tag.toLowerCase() === filters.tag.toLowerCase(); })) return false;
      if (filters.equipment && order.equipmentIds.indexOf(filters.equipment) === -1) return false;
      return true;
    });
    return JobModel.sortOrders(orders, today());
  }

  function visibleEquipment() {
    var current = data();
    var items = search.trim()
      ? JobModel.searchAll(search, current.settings, current.equipment, current.work).equipment
      : current.equipment.equipment.slice();
    return items.sort(function (a, b) {
      if (a.status !== b.status) return a.status === "active" ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
  }

  function render() {
    var focus = document.activeElement && document.activeElement.id;
    document.getElementById("app").innerHTML = user ? shell(main()) : signIn();
    if (focus) {
      var field = document.getElementById(focus);
      if (field) {
        field.focus();
        if (field.setSelectionRange && field.value) field.setSelectionRange(field.value.length, field.value.length);
      }
    }
    var modal = document.getElementById("dialog");
    if (modal && !modal.open) modal.showModal();
  }

  function themeDark() {
    return document.documentElement.getAttribute("data-theme") === "dark";
  }

  function applyTheme(theme) {
    var next = theme === "dark" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem(THEME_KEY, next);
  }

  function themeToggle() {
    var dark = themeDark();
    return "<button type=\"button\" class=\"switch\" data-action=\"theme\" aria-pressed=\"" + (dark ? "true" : "false") + "\">" +
      "<span>Dark Mode</span><span class=\"knob\"></span></button>";
  }

  function signIn() {
    var setup = JobSupabase.ready() ? "" : "<p class=\"setup\">Supabase is not connected on this copy of the page yet.</p>";
    return "<section class=\"gate\">" +
      "<div class=\"gate-copy\"><h1>Broussard Campus</h1><p class=\"gate-lead\">Work orders and equipment.</p></div>" +
      banner() +
      "<form class=\"card\" id=\"sign-in\">" +
      "<label>Email<input id=\"email\" name=\"email\" type=\"email\" required autocomplete=\"username\" inputmode=\"email\"></label>" +
      "<label>Password<input id=\"password\" name=\"password\" type=\"password\" required autocomplete=\"current-password\"></label>" +
      "<button type=\"submit\"" + disabled() + ">Sign In</button>" +
      setup +
      "<p class=\"muted\">The session stays on this phone.</p>" +
      "</form>" +
      themeToggle() +
      "</section>";
  }

  function shell(body) {
    var current = data();
      var listing = view.name === "orders" || view.name === "open-orders" || view.name === "equipment";
      return "<header class=\"app-header\">" +
      "<div class=\"topbar\"><div><h1>Broussard Campus</h1><p class=\"who\">" + esc(nameOf(user.id)) + "</p></div>" +
      "<div class=\"header-actions\">" + homeButton() + settingsButton() + "</div></div>" +
      (listing ? "<label class=\"search\"><span class=\"sr-only\">Search</span><input id=\"search\" value=\"" + esc(search) + "\" placeholder=\"Search Orders, Equipment, Notes\"></label>" : "") +
      "</header>" + banner() + (search.trim() && listing ? searchResults(current) : body) + dock() + settingsSheet();
  }

  function homeButton() {
    return "<button type=\"button\" class=\"icon\" data-action=\"home\" aria-label=\"Home\">" +
      "<svg viewBox=\"0 0 24 24\" width=\"22\" height=\"22\" aria-hidden=\"true\"><path fill=\"currentColor\" d=\"M12 3.1 3 10.4V21h6.2v-6.2h5.6V21H21V10.4L12 3.1z\"/></svg></button>";
  }

  function settingsButton() {
    return "<button type=\"button\" class=\"icon\" data-action=\"settings\" aria-label=\"Settings\">" +
      "<svg viewBox=\"0 0 24 24\" width=\"22\" height=\"22\" aria-hidden=\"true\"><path fill=\"currentColor\" d=\"M19.14 12.94a7.4 7.4 0 0 0 .05-.94 7.4 7.4 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.2 7.2 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.49-.42h-3.84a.5.5 0 0 0-.49.42l-.36 2.54a7.2 7.2 0 0 0-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.7 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.4 7.4 0 0 0-.05.94 7.4 7.4 0 0 0 .05.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.4 1.04.72 1.63.94l.36 2.54a.5.5 0 0 0 .49.42h3.84a.5.5 0 0 0 .49-.42l.36-2.54c.59-.22 1.13-.54 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z\"/></svg></button>";
  }

  function settingsSheet() {
    if (!settingsOpen) return "";
    return "<div class=\"sheet-backdrop\"><div class=\"sheet\" role=\"dialog\" aria-label=\"Settings\">" +
      "<div class=\"topbar\"><h2>Settings</h2><button type=\"button\" class=\"text\" data-action=\"close-settings\">Close</button></div>" +
      themeToggle() +
      "<form id=\"name-form\" class=\"name-form\">" +
      "<label>Your Name<input id=\"display-name\" value=\"" + esc(nameOf(user.id)) + "\"></label>" +
      "<button type=\"submit\"" + disabled() + ">Save Name</button></form>" +
      "<button type=\"button\" class=\"text sign-out\" data-action=\"sign-out\">Sign Out</button>" +
      "</div></div>";
  }

  function dock() {
    var equipmentView = view.name.indexOf("equipment") === 0;
    var primary = "";
    if (view.name === "orders" || view.name === "open-orders") primary = "<button type=\"button\" class=\"add\" data-action=\"new-order\"" + disabled() + ">New Order</button>";
    if (view.name === "equipment") primary = "<button type=\"button\" class=\"add\" data-action=\"new-equipment\"" + disabled() + ">New Equipment</button>";
    return "<div class=\"dock\">" + primary +
      "<nav class=\"tabs\">" +
      "<button type=\"button\" data-action=\"nav\" data-view=\"open-orders\"" + (view.name === "open-orders" ? " aria-current=\"page\"" : "") + ">Orders</button>" +
      "<button type=\"button\" data-action=\"nav\" data-view=\"equipment\"" + (equipmentView ? " aria-current=\"page\"" : "") + ">Equipment</button>" +
      "</nav></div>";
  }

  function banner() {
    return (errorText ? "<div class=\"banner error\">" + esc(errorText) + "</div>" : "") +
      (notice ? "<div class=\"banner ok\">" + esc(notice) + "</div>" : "");
  }

  function disabled() { return busy ? " disabled" : ""; }

  function main() {
    if (view.name === "order") return orderDetail();
    if (view.name === "order-form") return orderForm();
    if (view.name === "equipment-form") return equipmentForm();
    if (view.name === "equipment-detail") return equipmentDetail();
    if (view.name === "equipment") return equipmentList();
    if (view.name === "open-orders") return openOrdersPage();
    return orderList();
  }

  function isMine(order) {
    if (!user) return false;
    if (order.assignee === user.id) return true;
    if ((order.steps || []).some(function (step) { return step.assignee === user.id; })) return true;
    return !order.assignee && JobModel.ownerId(order) === user.id;
  }

  function orderList() {
    return homeSwitch() + (homeMode === "tasks" ? tasksHome() : activityHome());
  }

  function homeSwitch() {
    return "<div class=\"view-switch home-switch\">" +
      "<button type=\"button\" data-action=\"home-mode\" data-id=\"activity\"" + (homeMode === "activity" ? " aria-current=\"page\"" : "") + ">Activity</button>" +
      "<button type=\"button\" data-action=\"home-mode\" data-id=\"tasks\"" + (homeMode === "tasks" ? " aria-current=\"page\"" : "") + ">My Tasks</button>" +
      "</div>";
  }

  function tasksHome() {
    var orders = data().work.orders.filter(isMine);
    return viewSwitch() + (ordersMode === "calendar" ? calendarView(orders) : groupedList(orders));
  }

  function openOrdersPage() {
    var orders = JobModel.sortOrders(data().work.orders.filter(function (order) {
      return JobModel.isOpenStatus(order.status);
    }), today());
    return "<h2 class=\"page-title\">Orders</h2>" +
      (orders.map(orderCard).join("") || "<p class=\"muted\">No open orders.</p>");
  }

  function mentionsMe(text) {
    if (!user) return false;
    var person = data().settings.people.find(function (item) { return item.id === user.id; });
    var full = String(person && person.displayName || "").trim();
    if (!full) return false;
    var first = full.split(/\s+/)[0];
    var names = first && first.toLowerCase() !== full.toLowerCase() ? [full, first] : [full];
    return names.some(function (label) {
      return new RegExp("(^|\\s)@" + label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=$|\\s|[^A-Za-z0-9])", "i").test(text || "");
    });
  }

  function forMeText(line) {
    var who = nameOf(line.by);
    if (line.type === "assigned" && line.to === user.id) return who + " assigned this to you";
    if (line.type === "assigned" && line.from === user.id) return line.to ? who + " assigned this to " + nameOf(line.to) : who + " unassigned this";
    if (line.type === "step-assigned" && line.to === user.id) return who + " assigned \"" + line.text + "\" to you";
    if (line.type === "step-assigned" && line.from === user.id) {
      return line.to ? who + " assigned \"" + line.text + "\" to " + nameOf(line.to) : who + " cleared you from \"" + line.text + "\"";
    }
    return "";
  }

  function activityHome() {
    var events = [];
    var start = daysAgo(14);
    data().work.orders.forEach(function (order) {
      (order.log || []).forEach(function (line) {
        if (!user || line.by === user.id || stampOf(line.at) < start) return;
        var text = forMeText(line);
        if (text) events.push({ at: line.at, order: order, text: text });
      });
      (order.notes || []).forEach(function (note) {
        if (!user || note.by === user.id || stampOf(note.at) < start || !mentionsMe(note.text)) return;
        events.push({ at: note.at, order: order, text: nameOf(note.by) + " mentioned you: " + note.text });
      });
    });
    events.sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; });
    if (!events.length) return "<p class=\"muted\">Nothing for you in the last two weeks.</p>";
    var html = "";
    var lastDay = "";
    events.forEach(function (event) {
      var stamp = stampOf(event.at);
      if (stamp !== lastDay) {
        lastDay = stamp;
        html += "<h3 class=\"activity-day\">" + esc(dayLabel(stamp)) + "</h3>";
      }
      var overdue = JobModel.isOpenStatus(event.order.status) && event.order.dueDate && event.order.dueDate < today();
      var tone = overdue ? "overdue" : event.order.status;
      html += "<button type=\"button\" class=\"day-line tone-" + esc(tone) + "\" data-action=\"open-order\" data-id=\"" + esc(event.order.id) + "\">" +
        "<strong>" + esc(event.order.title) + "</strong>" +
        "<span class=\"activity-text\">" + esc(event.text) + "</span>" +
        "<span>" + esc(when(event.at)) + "</span></button>";
    });
    return "<section class=\"activity\">" + html + "</section>";
  }

  function stampOf(iso) {
    var date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
  }

  function daysAgo(count) {
    var parts = today().split("-").map(Number);
    var date = new Date(parts[0], parts[1] - 1, parts[2] - count);
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
  }

  function dayLabel(stamp) {
    if (stamp === today()) return "Today";
    if (stamp === daysAgo(1)) return "Yesterday";
    return prettyDate(stamp);
  }

  function viewSwitch() {
    return "<div class=\"view-switch\">" +
      "<button type=\"button\" data-action=\"orders-mode\" data-id=\"list\"" + (ordersMode === "list" ? " aria-current=\"page\"" : "") + ">List</button>" +
      "<button type=\"button\" data-action=\"orders-mode\" data-id=\"calendar\"" + (ordersMode === "calendar" ? " aria-current=\"page\"" : "") + ">Calendar</button>" +
      "</div>";
  }

  function taskMenu(id, label, rows, emptyText) {
    var open = !!openGroups[id];
    return "<section class=\"menu\">" +
      "<button type=\"button\" class=\"menu-toggle\" data-action=\"toggle-group\" data-id=\"" + id + "\" aria-expanded=\"" + (open ? "true" : "false") + "\">" +
      "<span>" + label + "</span><span class=\"menu-meta\">" + (rows.length ? rows.length + " " : "") + "<span aria-hidden=\"true\">" + (open ? "▾" : "▸") + "</span></span></button>" +
      (open ? "<div class=\"menu-body\">" + (rows.map(orderCard).join("") || "<p class=\"muted\">" + emptyText + "</p>") + "</div>" : "") +
      "</section>";
  }

  function groupedList(orders) {
    var groups = JobModel.taskGroups(orders, today());
    return taskMenu("today", "Today", groups.today, "Nothing due today.") +
      taskMenu("week", "This Week", groups.week, "Nothing else due this week.") +
      taskMenu("upcoming", "Upcoming", groups.upcoming, "Nothing coming up.") +
      taskMenu("recent", "Recent", groups.recent, "Nothing finished in the last two weeks.");
  }

  function ensureCalendar() {
    if (calendarCursor) return;
    var now = new Date();
    calendarCursor = { year: now.getFullYear(), month: now.getMonth() };
    calendarDay = today();
  }

  function shiftMonth(cursor, step) {
    var date = new Date(cursor.year, cursor.month + step, 1);
    return { year: date.getFullYear(), month: date.getMonth() };
  }

  function monthCells(cursor) {
    var first = new Date(cursor.year, cursor.month, 1);
    var lastDate = new Date(cursor.year, cursor.month + 1, 0).getDate();
    var start = new Date(cursor.year, cursor.month, 1 - first.getDay());
    var count = Math.ceil((first.getDay() + lastDate) / 7) * 7;
    var cells = [];
    for (var i = 0; i < count; i++) {
      cells.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
    }
    return cells;
  }

  function calendarView(orders) {
    ensureCalendar();
    var stampToday = today();
    var title = new Date(calendarCursor.year, calendarCursor.month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    var weekdays = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map(function (day) {
      return "<span class=\"cal-dow\">" + day + "</span>";
    }).join("");
    var cells = monthCells(calendarCursor).map(function (date) {
      var stamp = date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
      var due = JobModel.ordersForDay(orders, stamp, stampToday);
      var outside = date.getMonth() !== calendarCursor.month;
      var classes = "cal-day" + (outside ? " outside" : "") + (stamp === stampToday ? " today" : "") + (due.length ? " has-work" : "");
      var count = due.length ? "<span class=\"cal-count" + (due.some(function (order) { return order.dueDate < stampToday; }) ? " overdue" : "") + "\">" + due.length + "</span>" : "";
      var label = prettyDate(stamp) + (due.length ? ", " + due.length + (due.length === 1 ? " order" : " orders") : ", nothing due");
      return "<button type=\"button\" class=\"" + classes + "\" data-action=\"calendar-day\" data-id=\"" + stamp + "\" aria-pressed=\"" + (calendarDay === stamp ? "true" : "false") + "\" aria-label=\"" + esc(label) + "\"><span class=\"cal-num\">" + date.getDate() + "</span>" + count + "</button>";
    }).join("");
    var chosen = calendarDay ? JobModel.ordersForDay(orders, calendarDay, stampToday) : [];
    var dayTitle = calendarDay === stampToday ? "Today · " + prettyDate(calendarDay) : prettyDate(calendarDay);
    var dayList = calendarDay ? daySummary(dayTitle, chosen) : "";
    return "<div class=\"month-bar\"><button type=\"button\" class=\"text\" data-action=\"calendar-move\" data-id=\"prev\">Prev</button>" +
      "<h2>" + esc(title) + "</h2>" +
      "<button type=\"button\" class=\"text\" data-action=\"calendar-move\" data-id=\"next\">Next</button></div>" +
      "<div class=\"cal\">" + weekdays + cells + "</div>" + dayList;
  }

  function daySummary(title, orders) {
    var lines = orders.map(function (order) {
      var overdue = JobModel.isOpenStatus(order.status) && order.dueDate && order.dueDate < today();
      var status = overdue ? "Overdue" : (STATUS_LABEL[order.status] || order.status);
      return "<button type=\"button\" class=\"day-line tone-" + esc(overdue ? "overdue" : order.status) + "\" data-action=\"open-order\" data-id=\"" + esc(order.id) + "\">" +
        "<strong>" + esc(order.title) + "</strong>" +
        "<span>" + esc(order.location) + " · " + esc(status) + (order.assignee ? " · " + esc(nameOf(order.assignee)) : "") + "</span></button>";
    }).join("");
    return "<section class=\"day-sheet\"><h3>" + esc(title) + "</h3>" +
      (lines || "<p class=\"muted\">Nothing due.</p>") + "</section>";
  }

  function filtersHtml() {
    var people = data().settings.people.map(function (person) {
      return "<option value=\"" + esc(person.id) + "\"" + (filters.assignee === person.id ? " selected" : "") + ">" + esc(person.displayName) + "</option>";
    }).join("");
    var statuses = ["open", "all", "new", "in_progress", "waiting", "done", "canceled"].map(function (status) {
      var label = status === "open" ? "Open" : status === "all" ? "All" : STATUS_LABEL[status];
      return "<option value=\"" + status + "\"" + (filters.status === status ? " selected" : "") + ">" + label + "</option>";
    }).join("");
    var tags = tagsInUse().map(function (tag) {
      return "<option value=\"" + esc(tag) + "\"" + (filters.tag === tag ? " selected" : "") + ">" + esc(tag) + "</option>";
    }).join("");
    var equipment = data().equipment.equipment.map(function (item) {
      return "<option value=\"" + esc(item.id) + "\"" + (filters.equipment === item.id ? " selected" : "") + ">" + esc(item.id) + "</option>";
    }).join("");
    return "<div class=\"filters\">" +
      "<label>Assignee<select id=\"filter-assignee\"><option value=\"\">Anyone</option><option value=\"unassigned\"" + (filters.assignee === "unassigned" ? " selected" : "") + ">Unassigned</option>" + people + "</select></label>" +
      "<label>Status<select id=\"filter-status\">" + statuses + "</select></label>" +
      "<label>Tag<select id=\"filter-tag\"><option value=\"\">Any Tag</option>" + tags + "</select></label>" +
      "<label>Equipment<select id=\"filter-equipment\"><option value=\"\">Any Equipment</option>" + equipment + "</select></label>" +
      "</div>";
  }

  function orderCard(order) {
    var overdue = JobModel.isOpenStatus(order.status) && order.dueDate && order.dueDate < today();
    var count = JobModel.linkedAttachments(data().work, order).length;
    var tone = overdue ? "overdue" : order.status;
    var facts = [order.id, PRIORITY_LABEL[order.priority], nameOf(order.assignee) || "Unassigned"];
    if (overdue) facts.splice(1, 0, STATUS_LABEL[order.status]);
    if (order.dueDate) facts.push("Due " + prettyDate(order.dueDate));
    if (repeatLabel(order)) facts.push(repeatLabel(order));
    if (count) facts.push(count + " file" + (count === 1 ? "" : "s"));
    var steps = order.steps || [];
    if (steps.length) {
      var finished = steps.filter(function (step) { return step.done; }).length;
      facts.push(finished + " of " + steps.length);
    }
    return "<button type=\"button\" class=\"card card-button tone-" + esc(tone) + "\" data-action=\"open-order\" data-id=\"" + esc(order.id) + "\">" +
      "<span class=\"job-top\"><strong>" + esc(order.title) + "</strong>" +
      "<span class=\"chip " + esc(tone) + "\">" + esc(overdue ? "Overdue" : STATUS_LABEL[order.status]) + "</span></span>" +
      "<span class=\"where\">" + esc(order.location) + "</span>" +
      "<span class=\"facts\">" + esc(facts.join(" · ")) + "</span></button>";
  }

  function searchResults() {
    return "<h2>Search</h2><h3>Orders</h3>" +
      (visibleOrders().map(orderCard).join("") || "<p class=\"empty\">No matching orders.</p>") +
      "<h3>Equipment</h3>" +
      (visibleEquipment().map(equipmentCard).join("") || "<p class=\"empty\">No matching equipment.</p>");
  }

  function orderForm() {
    var order = view.id ? JobModel.findOrder(data().work, view.id) : null;
    var selected = order ? order.equipmentIds : [];
    var openOrders = data().work.orders.some(function (item) { return JobModel.isOpenStatus(item.status); });
    var emptyNote = !order && !openOrders ? "<p class=\"empty\">No open work orders.</p>" : "";
    return emptyNote + "<form class=\"card\" id=\"order-form\">" +
      "<h2>" + (order ? "Edit " + esc(order.id) : "New Order") + "</h2>" +
      (order ? "" : "<p class=\"muted\">Nothing is created until you submit.</p>") +
      field("Title", "title", order ? order.title : "") +
      field("Location", "location", order ? order.location : "") +
      "<label>Description<textarea name=\"description\" required>" + esc(order ? order.description : "") + "</textarea></label>" +
      "<label>Priority<select name=\"priority\">" + JobModel.PRIORITIES.map(function (priority) {
        return "<option value=\"" + priority + "\"" + ((order ? order.priority : "normal") === priority ? " selected" : "") + ">" + PRIORITY_LABEL[priority] + "</option>";
      }).join("") + "</select></label>" +
      (order ? "" : "<label>Assignee<select name=\"assignee\"><option value=\"\">Unassigned</option>" + peopleOptions(order ? order.assignee : "") + "</select></label>") +
      "<label>Due Date<input type=\"date\" name=\"dueDate\" value=\"" + esc(order ? order.dueDate : "") + "\"></label>" +
      "<label>Repeat<select name=\"repeat\">" + repeatOptions(order ? order.repeat : "") + "</select></label>" +
      field("Tags", "tags", order ? order.tags.join(", ") : "", false) +
      "<fieldset><legend>Equipment</legend>" + equipmentChecks(selected) + "</fieldset>" +
      "<div class=\"actions\"><button type=\"submit\"" + disabled() + ">" + (order ? "Save" : "Submit") + "</button>" +
      "<button type=\"button\" class=\"text\" data-action=\"back\">Cancel</button></div></form>";
  }

  function spec(label, value) {
    return "<dt>" + esc(label) + "</dt><dd>" + esc(value) + "</dd>";
  }

  function specHtml(label, html) {
    return "<dt>" + esc(label) + "</dt><dd>" + html + "</dd>";
  }

  function field(label, name, value, required) {
    return "<label>" + label + "<input name=\"" + name + "\" value=\"" + esc(value) + "\"" + (required === false ? "" : " required") + "></label>";
  }

  var REPEAT_LABEL = { weekly: "Every Week", biweekly: "Every 2 Weeks", monthly: "Every Month", quarterly: "Every Quarter", semiannual: "Every 6 Months", annual: "Every Year" };

  function repeatLabel(order) {
    return REPEAT_LABEL[order && order.repeat] || "";
  }

  function repeatOptions(selected) {
    var choices = [{ value: "", label: "Does Not Repeat" }].concat(JobModel.REPEATS.map(function (repeat) {
      return { value: repeat, label: REPEAT_LABEL[repeat] };
    }));
    return choices.map(function (choice) {
      return "<option value=\"" + choice.value + "\"" + ((selected || "") === choice.value ? " selected" : "") + ">" + choice.label + "</option>";
    }).join("");
  }

  function repeatLinks(order) {
    var links = [];
    if (order.fromId) links.push("<button type=\"button\" class=\"text\" data-action=\"open-order\" data-id=\"" + esc(order.fromId) + "\">From " + esc(order.fromId) + "</button>");
    if (order.nextId) links.push("<button type=\"button\" class=\"text\" data-action=\"open-order\" data-id=\"" + esc(order.nextId) + "\">Next " + esc(order.nextId) + "</button>");
    return links.length ? "<p class=\"links\">" + links.join("") + "</p>" : "";
  }

  function peopleOptions(selected) {
    return data().settings.people.map(function (person) {
      return "<option value=\"" + esc(person.id) + "\"" + (person.id === selected ? " selected" : "") + ">" + esc(person.displayName) + "</option>";
    }).join("");
  }

  function equipmentChecks(selected) {
    var items = data().equipment.equipment.filter(function (item) {
      return item.status === "active" || selected.indexOf(item.id) !== -1;
    });
    if (!items.length) return "<p class=\"muted\">No active equipment yet.</p>";
    return items.map(function (item) {
      var checked = selected.indexOf(item.id) !== -1;
      if (item.status === "retired") {
        return "<label><input type=\"checkbox\" checked disabled> " + esc(item.id) + " · " + esc(item.name) + " (Retired)</label>" +
          "<input type=\"hidden\" name=\"equipment\" value=\"" + esc(item.id) + "\">";
      }
      return "<label><input type=\"checkbox\" name=\"equipment\" value=\"" + esc(item.id) + "\"" + (checked ? " checked" : "") + "> " +
        esc(item.id) + " · " + esc(item.name) + "</label>";
    }).join("");
  }

  function orderDetail() {
    var order = JobModel.findOrder(data().work, view.id);
    if (!order) return "<p>That work order is gone.</p>";
    var files = JobModel.linkedAttachments(data().work, order);
    var overdue = JobModel.isOpenStatus(order.status) && order.dueDate && order.dueDate < today();
    var tone = overdue ? "overdue" : order.status;
    var owns = JobModel.canEditOrder(user, order);
    return "<div class=\"page-head\"><button type=\"button\" class=\"text\" data-action=\"back\">Back</button>" +
      "<button type=\"button\" class=\"text\" data-action=\"print\">Print</button></div>" +
      "<article class=\"record tone-" + esc(tone) + "\"><div class=\"job-top\"><h2>" + esc(order.title) + "</h2>" +
      "<span class=\"chip " + esc(tone) + "\">" + esc(overdue ? "Overdue" : STATUS_LABEL[order.status]) + "</span></div>" +
      "<p class=\"where\">" + esc(order.location) + "</p>" +
      "<dl class=\"spec\">" +
      spec("Order", order.id) +
      spec("Priority", PRIORITY_LABEL[order.priority]) +
      (order.dueDate ? spec("Due", prettyDate(order.dueDate)) : "") +
      (repeatLabel(order) ? spec("Repeats", repeatLabel(order)) : "") +
      (order.tags.length ? spec("Tags", order.tags.join(", ")) : "") +
      specHtml("Equipment", equipmentLinks(order)) +
      (owns
        ? specHtml("Assigned", "<select id=\"assignee\" aria-label=\"Assigned to\"" + disabled() + "><option value=\"\">Unassigned</option>" + peopleOptions(order.assignee) + "</select>")
        : spec("Assigned", nameOf(order.assignee))) +
      specHtml("Followers", followerLine(order, owns)) +
      "</dl>" +
      "<p class=\"lead\">" + esc(order.description) + "</p>" +
      repeatLinks(order) +
      (owns
        ? "<button type=\"button\" class=\"text\" data-action=\"edit-order\" data-id=\"" + esc(order.id) + "\">Edit Details</button>"
        : "<p class=\"muted\">Only " + esc(nameOf(JobModel.ownerId(order))) + " can edit this order. " +
          (JobModel.canAddNote(user, order) ? "You can add notes, and check off steps assigned to you." : "You can check off steps assigned to you.") + "</p>") +
      "</article>" +
      stepsCard(order, owns) +
      (owns ? "<form class=\"card\" id=\"status-form\"><h3>Status</h3>" +
      "<label><span class=\"sr-only\">Status</span><select name=\"status\">" + JobModel.STATUSES.map(function (status) {
        return "<option value=\"" + status + "\"" + (order.status === status ? " selected" : "") + ">" + STATUS_LABEL[status] + "</option>";
      }).join("") + "</select></label>" +
      "<label>Reason<textarea name=\"text\" placeholder=\"Required for Waiting, Done, and Canceled\"></textarea></label>" +
      "<button type=\"submit\"" + disabled() + ">Update Status</button></form>" : "<section class=\"card\"><h3>Status</h3><p>" + esc(STATUS_LABEL[order.status]) + "</p></section>") +
      (JobModel.canAddNote(user, order) ? "<form class=\"card\" id=\"note-form\"><h3>Note</h3><label><span class=\"sr-only\">Note</span><textarea name=\"text\" required placeholder=\"Add a Note\"></textarea></label>" +
      "<button type=\"submit\"" + disabled() + ">Add Note</button></form>" : "") +
      "<section class=\"card\"><h3>Files</h3>" +
      (files.map(function (file) {
        return "<div class=\"file-row\"><button type=\"button\" data-action=\"open-file\" data-id=\"" + esc(file.id) + "\">" + esc(file.filename) + "</button>" +
          "<span class=\"meta\">" + esc(nameOf(file.by)) + " · " + esc(when(file.createdAt)) + "</span>" +
          (owns ? "<button type=\"button\" class=\"text\" data-action=\"unlink\" data-id=\"" + esc(file.id) + "\"" + disabled() + ">Remove</button>" : "") + "</div>";
      }).join("") || "<p class=\"muted\">No files yet.</p>") +
      (owns ? "<label>Add a Photo or Document<input id=\"file\" type=\"file\" accept=\"image/*,.heic,.heif,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv\"" + disabled() + "></label>" : "") +
      "</section>" +
      "<section class=\"card\"><h3>Activity</h3><ul class=\"activity\">" + activity(order) + "</ul></section>" +
      imageDialog() +
      (printOpen ? printPreview(order, overdue) : "");
  }

  function stepsCard(order, owns) {
    var steps = order.steps || [];
    var rows = steps.map(function (step) {
      var canCheck = JobModel.canCompleteStep(user, order, step);
      return "<li class=\"step" + (step.done ? " is-done" : "") + (owns ? "" : " viewer") + "\">" +
        "<button type=\"button\" class=\"check\" data-action=\"toggle-step\" data-id=\"" + esc(step.id) + "\" aria-pressed=\"" + (step.done ? "true" : "false") + "\" aria-label=\"" + (step.done ? "Mark Not Done" : "Mark Done") + "\"" + (canCheck ? disabled() : " disabled") + ">" + (step.done ? "✓" : "") + "</button>" +
        "<span class=\"step-text\">" + esc(step.text) + "</span>" +
        (owns
          ? "<label class=\"step-person\"><select data-step-assignee=\"" + esc(step.id) + "\" aria-label=\"Assign " + esc(step.text) + "\"" + disabled() + ">" +
            "<option value=\"\">None</option>" + peopleOptions(step.assignee || "") + "</select></label>" +
            "<button type=\"button\" class=\"step-remove\" data-action=\"remove-step\" data-id=\"" + esc(step.id) + "\" aria-label=\"Remove " + esc(step.text) + "\"" + disabled() + ">×</button>"
          : "<span class=\"meta step-who\">" + esc(step.assignee ? nameOf(step.assignee) : "") + "</span>") +
        "</li>";
    }).join("");
    return "<section class=\"card\"><h3>Steps</h3>" +
      (rows ? "<ul class=\"steps\">" + rows + "</ul>" : "<p class=\"muted\">No steps yet.</p>") +
      (owns ? "<form id=\"step-form\" class=\"step-add\"><label><span class=\"sr-only\">Add a Step</span><input id=\"step\" name=\"text\" required placeholder=\"Add a Step\"></label>" +
      "<label class=\"step-assign\"><select name=\"assignee\" aria-label=\"Assign Step\"" + disabled() + "><option value=\"\">None</option>" + peopleOptions("") + "</select></label>" +
      "<button type=\"submit\"" + disabled() + ">Add</button></form>" : "") +
      "</section>";
  }

  function followerLine(order, owns) {
    var ids = order.followers || [];
    var names = ids.map(function (id) {
      var remove = owns || id === user.id
        ? " <button type=\"button\" class=\"text\" data-action=\"unfollow\" data-id=\"" + esc(id) + "\"" + disabled() + ">Remove</button>"
        : "";
      return "<span class=\"follower\">" + esc(nameOf(id)) + remove + "</span>";
    }).join("");
    var add = "";
    if (owns) {
      var choices = data().settings.people.filter(function (person) {
        return person.id !== JobModel.ownerId(order) && ids.indexOf(person.id) === -1;
      });
      if (choices.length) {
        add = "<label class=\"follower-add\"><select id=\"add-follower\" aria-label=\"Add Follower\"" + disabled() + "><option value=\"\">Add Follower</option>" +
          choices.map(function (person) {
            return "<option value=\"" + esc(person.id) + "\">" + esc(person.displayName) + "</option>";
          }).join("") + "</select></label>";
      }
    }
    return names + add || "None";
  }

  function equipmentText(order) {
    if (!order.equipmentIds.length) return "None";
    return order.equipmentIds.map(function (id) {
      var item = JobModel.findEquipment(data().equipment, id);
      return item ? item.id + " · " + item.name : id;
    }).join(", ");
  }

  function printPreview(order, overdue) {
    return "<div class=\"print-preview\" role=\"dialog\" aria-label=\"Print preview\">" +
      "<div class=\"print-toolbar\">" +
      "<button type=\"button\" class=\"secondary\" data-action=\"close-print\">Close</button>" +
      "<button type=\"button\" data-action=\"confirm-print\">Print</button>" +
      "</div>" +
      printSheet(order, overdue) +
      "</div>";
  }

  function printSheet(order, overdue) {
    var files = JobModel.linkedAttachments(data().work, order);
    var tone = overdue ? "overdue" : order.status;
    var status = overdue ? "Overdue" : STATUS_LABEL[order.status];
    var notes = order.notes.map(function (note) {
      return "<div class=\"print-note\"><p>" + esc(note.text) + "</p><p class=\"print-meta\">" +
        esc(nameOf(note.by)) + " · " + esc(when(note.at)) + "</p></div>";
    }).join("");
    var filesHtml = files.map(function (file) {
      return "<li>" + esc(file.filename) + "</li>";
    }).join("");
    return "<article class=\"print-sheet\">" +
      "<header class=\"print-brand\">" +
      churchMark() +
      "<div><p class=\"print-campus\">Broussard Campus</p><p class=\"print-doc\">Work Order</p></div>" +
      "</header>" +
      "<div class=\"print-title\">" +
      "<div><p class=\"print-id\">" + esc(order.id) + "</p><h1>" + esc(order.title) + "</h1>" +
      "<p class=\"print-where\">" + esc(order.location) + "</p></div>" +
      "<p class=\"print-status " + esc(tone) + "\">" + esc(status) + "</p></div>" +
      "<div class=\"print-facts\">" +
      printFact("Due", order.dueDate ? prettyDate(order.dueDate) : "No date") +
      (repeatLabel(order) ? printFact("Repeats", repeatLabel(order)) : "") +
      printFact("Priority", PRIORITY_LABEL[order.priority] || order.priority) +
      printFact("Assigned to", nameOf(order.assignee)) +
      printFact("Opened", shortWhen(order.createdAt)) +
      (order.completedAt ? printFact("Completed", shortWhen(order.completedAt)) : "") +
      (order.equipmentIds.length ? "<div class=\"print-fact wide\"><span>Equipment</span><strong>" + esc(equipmentText(order)) + "</strong></div>" : "") +
      (order.tags.length ? "<div class=\"print-fact wide\"><span>Tags</span><strong>" + esc(order.tags.join(", ")) + "</strong></div>" : "") +
      "</div>" +
      "<section class=\"print-block\"><h2>Description</h2><p>" + esc(order.description) + "</p></section>" +
      printSteps(order) +
      (notes ? "<section class=\"print-block\"><h2>Notes</h2>" + notes + "</section>" : "") +
      (filesHtml ? "<section class=\"print-block\"><h2>Files</h2><ul>" + filesHtml + "</ul></section>" : "") +
      "<p class=\"print-foot\">Our Savior's Church · Broussard Campus · Printed " + esc(when(new Date().toISOString())) + "</p>" +
      "</article>";
  }

  function printSteps(order) {
    var steps = order.steps || [];
    if (!steps.length) return "";
    return "<section class=\"print-block\"><h2>Steps</h2><ul class=\"print-steps\">" +
      steps.map(function (step) {
        var who = step.assignee ? "<span class=\"print-step-who\">" + esc(nameOf(step.assignee)) + "</span>" : "";
        return "<li class=\"" + (step.done ? "done" : "") + "\"><span class=\"print-mark\">" + (step.done ? "✓" : "") + "</span><span class=\"print-step-copy\"><span class=\"print-step-text\">" + esc(step.text) + "</span>" + who + "</span></li>";
      }).join("") +
      "</ul></section>";
  }

  function printFact(label, value) {
    return "<div class=\"print-fact\"><span>" + esc(label) + "</span><strong>" + esc(value) + "</strong></div>";
  }

  function prettyDate(value) {
    var parts = String(value || "").split("-");
    if (parts.length !== 3) return value;
    var date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function shortWhen(iso) {
    var date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso || "";
    return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function churchMark() {
    return "<svg class=\"print-logo\" viewBox=\"0 0 1464 1464\" aria-hidden=\"true\"><path fill=\"#1a1714\" d=\"M731.71,0C327.6,0,0,329.02,0,734.88c0,372.99,276.68,681.08,635.15,728.54l17.33-847.59-291.01-29.95,58.57-25.11,295.68,31.68,41.54,870.97h23.77l-37.97-913.9-55.97-5.57,1.92-338.98,91.14-53.57s43.32,1312.69,52.58,1311.41c356.29-49.43,630.67-356.5,630.67-727.93C1463.41,329.02,1135.82,0,731.71,0Zm302.91,652.34l-191.44-18.44v-30.14l257.79,25.11-66.35,23.47Z\"/></svg>";
  }

  function printOrder() {
    var order = view.name === "order" ? JobModel.findOrder(data().work, view.id) : null;
    if (!document.querySelector(".print-sheet") || !order) return;
    printHere(order);
  }

  function printHere(order) {
    var sheet = document.querySelector(".print-preview .print-sheet");
    if (!sheet) return;
    var previous = document.getElementById("print-root");
    if (previous) previous.remove();
    var host = document.createElement("div");
    host.id = "print-root";
    host.innerHTML = sheet.outerHTML;
    document.body.appendChild(host);
    var previousTitle = document.title;
    document.title = order.id + " " + order.title;
    document.body.classList.add("printing");
    function restore() {
      document.title = previousTitle;
      document.body.classList.remove("printing");
      if (host.parentNode) host.remove();
      window.removeEventListener("afterprint", restore);
    }
    window.addEventListener("afterprint", restore);
    window.print();
  }

  function equipmentLinks(order) {
    if (!order.equipmentIds.length) return "None";
    return order.equipmentIds.map(function (id) {
      var item = JobModel.findEquipment(data().equipment, id);
      var label = item ? item.id + " · " + item.name : id;
      return "<button type=\"button\" class=\"text\" data-action=\"open-equipment\" data-id=\"" + esc(id) + "\">" + esc(label) + "</button>";
    }).join(" ");
  }

  function activity(order) {
    var events = order.log.map(function (line) {
      return { at: line.at, text: logText(line) };
    });
    order.notes.forEach(function (note) {
      events.push({ at: note.at, text: nameOf(note.by) + " wrote: " + note.text });
    });
    events.sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; });
    return events.map(function (event) {
      return "<li>" + esc(when(event.at)) + " — " + esc(event.text) + "</li>";
    }).join("") || "<li class=\"muted\">No activity yet.</li>";
  }

  function logText(line) {
    var who = nameOf(line.by);
    if (line.type === "created") return who + " created this";
    if (line.type === "repeated") return line.from ? who + " repeated this from " + line.from : who + " started " + line.to;
    if (line.type === "assigned") return who + " assigned this to " + nameOf(line.to);
    if (line.type === "followed") return who + " added " + nameOf(line.to) + " as a follower";
    if (line.type === "unfollowed") return who + " removed " + nameOf(line.from) + " as a follower";
    if (line.type === "step-assigned") return who + (line.to ? " assigned \"" + line.text + "\" to " + nameOf(line.to) : " cleared the assignee on \"" + line.text + "\"");
    if (line.type === "status") return who + " changed status from " + STATUS_LABEL[line.from] + " to " + STATUS_LABEL[line.to] + (line.text ? ": " + line.text : "");
    if (line.type === "attachment") return who + " added " + line.text;
    if (line.type === "unlinked") return who + " removed " + line.text;
    if (line.type === "retire") return who + " retired this" + (line.text ? ". " + line.text : "");
    if (line.type === "reactivate") return who + " reactivated this";
    if (line.type === "rename") return who + " renamed " + line.from + " to " + line.to;
    return who + " updated this";
  }

  function equipmentList() {
    var cards = visibleEquipment().map(equipmentCard).join("") || "<p class=\"empty\">No equipment yet.</p>";
    return cards;
  }

  function equipmentCard(item) {
    return "<button type=\"button\" class=\"card card-button tone-" + esc(item.status) + "\" data-action=\"open-equipment\" data-id=\"" + esc(item.id) + "\">" +
      "<span class=\"job-top\"><strong>" + esc(item.id) + "</strong>" +
      "<span class=\"chip " + esc(item.status) + "\">" + (item.status === "retired" ? "Retired" : "Active") + "</span></span>" +
      "<span class=\"where\">" + esc(item.name) + "</span>" +
      (item.tags.length ? "<span class=\"facts\">" + esc(item.tags.join(", ")) + "</span>" : "") +
      "</button>";
  }

  function equipmentForm() {
    var item = view.id ? JobModel.findEquipment(data().equipment, view.id) : null;
    return "<form class=\"card\" id=\"equipment-form\">" +
      "<h2>" + (item ? "Edit Equipment" : "New Equipment") + "</h2>" +
      (item ? "<p>ID " + esc(item.id) + "</p>" : field("Equipment ID", "equipmentId", "")) +
      "<label>Name<input name=\"name\" value=\"" + esc(item ? item.name : "") + "\" required></label>" +
      "<label>Notes<textarea name=\"notes\">" + esc(item ? item.notes : "") + "</textarea></label>" +
      "<label>Tags<input name=\"tags\" value=\"" + esc(item ? item.tags.join(", ") : "") + "\"></label>" +
      "<div class=\"actions\"><button type=\"submit\"" + disabled() + ">Save</button>" +
      "<button type=\"button\" class=\"text\" data-action=\"back\">Cancel</button></div></form>";
  }

  function equipmentDetail() {
    var item = JobModel.findEquipment(data().equipment, view.id);
    if (!item) return "<p>That equipment is gone.</p>";
    var orders = data().work.orders.filter(function (order) {
      return order.equipmentIds.indexOf(item.id) !== -1;
    });
    return "<div class=\"page-head\"><button type=\"button\" class=\"text\" data-action=\"back\">Back</button></div>" +
      "<article class=\"record tone-" + esc(item.status) + "\"><div class=\"job-top\"><h2>" + esc(item.id) + "</h2>" +
      "<span class=\"chip " + esc(item.status) + "\">" + (item.status === "retired" ? "Retired" : "Active") + "</span></div>" +
      "<p class=\"where\">" + esc(item.name) + "</p>" +
      "<dl class=\"spec\">" +
      spec("Notes", item.notes || "None") +
      spec("Tags", item.tags.join(", ") || "None") +
      "</dl>" +
      "<div class=\"actions\">" +
      (item.status === "active" ? "<button type=\"button\" class=\"text\" data-action=\"edit-equipment\" data-id=\"" + esc(item.id) + "\">Edit</button>" +
        "<button type=\"button\" class=\"text\" data-action=\"rename\" data-id=\"" + esc(item.id) + "\">Rename ID</button>" +
        "<button type=\"button\" class=\"text danger\" data-action=\"retire\" data-id=\"" + esc(item.id) + "\">Retire</button>"
        : "<button type=\"button\" class=\"text\" data-action=\"reactivate\" data-id=\"" + esc(item.id) + "\"" + disabled() + ">Reactivate</button>") +
      "</div></article>" +
      "<section class=\"card\"><h3>Past Use</h3>" +
      (orders.map(orderCard).join("") || "<p class=\"muted\">No work orders yet.</p>") +
      "</section>" +
      "<section class=\"card\"><h3>History</h3><ul class=\"activity\">" +
      (item.log.map(function (line) { return "<li>" + esc(when(line.at)) + " — " + esc(logText(line)) + "</li>"; }).join("") || "<li class=\"muted\">No history yet.</li>") +
      "</ul></section>" + dialogHtml(item);
  }

  function dialogHtml(item) {
    if (!dialog || dialog.id !== item.id) return "";
    if (dialog.type === "retire") {
      var count = JobModel.openOrderCount(data().work, item.id);
      return "<dialog id=\"dialog\"><form method=\"dialog\" id=\"retire-form\"><h3>Retire " + esc(item.id) + "</h3>" +
        "<p>" + count + " open work order" + (count === 1 ? "" : "s") + " already " + (count === 1 ? "names" : "name") + " this equipment. Those can be finished. New work cannot use it.</p>" +
        "<label>Note<input name=\"note\" placeholder=\"Sold, Transferred, Scrapped\"></label>" +
        "<div class=\"actions\"><button type=\"submit\" class=\"danger\"" + disabled() + ">Retire</button>" +
        "<button type=\"button\" class=\"secondary\" data-action=\"close-dialog\">Cancel</button></div></form></dialog>";
    }
    if (dialog.type === "reactivate") {
      return "<dialog id=\"dialog\"><form method=\"dialog\" id=\"reactivate-form\"><h3>Reactivate " + esc(item.id) + "</h3>" +
        "<p>It will show up again for new work orders. Past orders stay linked.</p>" +
        "<div class=\"actions\"><button type=\"submit\"" + disabled() + ">Reactivate</button>" +
        "<button type=\"button\" class=\"secondary\" data-action=\"close-dialog\">Cancel</button></div></form></dialog>";
    }
    return "<dialog id=\"dialog\"><form method=\"dialog\" id=\"rename-form\"><h3>Rename " + esc(item.id) + "</h3>" +
      "<label>New Equipment ID<input name=\"toId\" required value=\"" + esc(item.id) + "\"></label>" +
      "<div class=\"actions\"><button type=\"submit\"" + disabled() + ">Rename</button>" +
      "<button type=\"button\" class=\"secondary\" data-action=\"close-dialog\">Cancel</button></div></form></dialog>";
  }

  function imageDialog() {
    if (!dialog || dialog.type !== "image") return "";
    return "<dialog id=\"dialog\"><h3>" + esc(dialog.filename) + "</h3><img alt=\"\" src=\"" + dialog.url + "\" style=\"max-width:100%\">" +
      "<div class=\"actions\"><button type=\"button\" class=\"secondary\" data-action=\"close-dialog\">Close</button></div></dialog>";
  }

  document.addEventListener("click", function (event) {
    if (printOpen && event.target.classList && event.target.classList.contains("print-preview")) {
      printOpen = false;
      render();
      return;
    }
    if (settingsOpen && event.target.classList && event.target.classList.contains("sheet-backdrop")) {
      settingsOpen = false;
      render();
      return;
    }
    var target = event.target.closest("[data-action]");
    if (!target || busy) return;
    var action = target.getAttribute("data-action");
    var id = target.getAttribute("data-id");
    if (action === "sign-out") return signOut();
    if (action === "home") { goHome(); return; }
    if (action === "settings") { settingsOpen = true; render(); return; }
    if (action === "close-settings") { settingsOpen = false; render(); return; }
    if (action === "theme") { applyTheme(themeDark() ? "light" : "dark"); render(); return; }
    if (action === "nav") {
      printOpen = false;
      view = { name: target.getAttribute("data-view") };
      dialog = null;
      render();
    }
    if (action === "home-mode") { homeMode = id === "tasks" ? "tasks" : "activity"; render(); return; }
    if (action === "orders-mode") { ordersMode = id === "calendar" ? "calendar" : "list"; render(); return; }
    if (action === "toggle-group") { openGroups[id] = !openGroups[id]; render(); return; }
    if (action === "calendar-move") {
      ensureCalendar();
      calendarCursor = shiftMonth(calendarCursor, id === "next" ? 1 : -1);
      calendarDay = "";
      render();
      return;
    }
    if (action === "calendar-day") {
      ensureCalendar();
      var picked = new Date(Number(id.slice(0, 4)), Number(id.slice(5, 7)) - 1, Number(id.slice(8, 10)));
      calendarCursor = { year: picked.getFullYear(), month: picked.getMonth() };
      calendarDay = calendarDay === id ? "" : id;
      render();
      return;
    }
    if (action === "new-order") {
      settingsOpen = false;
      if (view.name === "open-orders" || view.name === "orders") listReturn = view.name;
      formOpenedAt = Date.now();
      view = { name: "order-form" };
      render();
    }
    if (action === "new-equipment") { view = { name: "equipment-form" }; render(); }
    if (action === "open-order") {
      if (view.name === "open-orders" || view.name === "orders") listReturn = view.name;
      view = { name: "order", id: id };
      render();
    }
    if (action === "open-equipment") { view = { name: "equipment-detail", id: id }; dialog = null; render(); }
    if (action === "edit-order") {
      var editingOrder = JobModel.findOrder(data().work, id);
      if (!editingOrder || !JobModel.canEditOrder(user, editingOrder)) return;
      view = { name: "order-form", id: id };
      render();
    }
    if (action === "edit-equipment") { view = { name: "equipment-form", id: id }; render(); }
    if (action === "back") {
      printOpen = false;
      view = view.id && view.name === "order-form" ? { name: "order", id: view.id } : { name: view.name.indexOf("equipment") === 0 ? "equipment" : (listReturn || "orders") };
      render();
    }
    if (action === "print") { printOpen = true; render(); return; }
    if (action === "close-print") { printOpen = false; render(); return; }
    if (action === "confirm-print") return printOrder();
    if (action === "retire" || action === "reactivate" || action === "rename") { dialog = { type: action === "retire" ? "retire" : action, id: id }; render(); }
    if (action === "close-dialog") closeDialog();
    if (action === "toggle-step") {
      var toggleId = view.id;
      enqueue(function () { return saveOp({ type: "toggleStep", orderId: toggleId, stepId: id }); });
    }
    if (action === "remove-step") {
      var removeId = view.id;
      enqueue(function () { return saveOp({ type: "removeStep", orderId: removeId, stepId: id }); });
    }
    if (action === "unlink") enqueue(function () { return saveOp({ type: "unlinkAttachment", attachmentId: id }); });
    if (action === "unfollow") {
      var unfollowOrder = view.id;
      enqueue(function () { return saveOp({ type: "setFollower", orderId: unfollowOrder, personId: id, following: false }); });
    }
    if (action === "open-file") enqueue(function () { return openFile(id); });
  });

  document.addEventListener("change", function (event) {
    if (event.target.id === "search") return;
    if (event.target.id === "filter-assignee") { filters.assignee = event.target.value; render(); }
    if (event.target.id === "filter-status") { filters.status = event.target.value; render(); }
    if (event.target.id === "filter-tag") { filters.tag = event.target.value; render(); }
    if (event.target.id === "filter-equipment") { filters.equipment = event.target.value; render(); }
    if (event.target.getAttribute && event.target.getAttribute("data-step-assignee")) {
      var stepId = event.target.getAttribute("data-step-assignee");
      var stepOrderId = view.id;
      var stepAssignee = event.target.value;
      enqueue(function () { return saveOp({ type: "setStepAssignee", orderId: stepOrderId, stepId: stepId, assignee: stepAssignee }); });
    }
    if (event.target.id === "assignee") {
      enqueue(function () {
        return saveOp({ type: "setAssignee", orderId: view.id, assignee: event.target.value });
      });
    }
    if (event.target.id === "add-follower" && event.target.value) {
      var followerId = event.target.value;
      enqueue(function () { return saveOp({ type: "setFollower", orderId: view.id, personId: followerId, following: true }); });
    }
    if (event.target.id === "file" && event.target.files[0]) {
      var file = event.target.files[0];
      var orderId = view.id;
      enqueue(function () { return addFile(orderId, file); });
    }
  });

  document.addEventListener("input", function (event) {
    if (event.target.id !== "search") return;
    search = event.target.value;
    render();
  });

  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (form.id === "sign-in") {
      event.preventDefault();
      var email = form.email.value.trim();
      var password = form.password.value;
      enqueue(function () {
        return run(function () { return connect(email, password); });
      });
    }
    if (form.id === "name-form") {
      event.preventDefault();
      enqueue(function () {
        return saveOp({ type: "updateDisplayName", displayName: form.querySelector("#display-name").value });
      });
    }
    if (form.id === "order-form") {
      event.preventDefault();
      if (!view.id && Date.now() - formOpenedAt < 700) return;
      var formData = new FormData(form);
      var op = {
        type: view.id ? "updateOrder" : "createOrder",
        id: view.id,
        title: formData.get("title"),
        location: formData.get("location"),
        description: formData.get("description"),
        priority: formData.get("priority"),
        dueDate: formData.get("dueDate"),
        repeat: formData.get("repeat"),
        tags: formData.get("tags"),
        equipmentIds: formData.getAll("equipment")
      };
      if (!view.id) op.assignee = formData.get("assignee") || "";
      enqueue(function () {
        return saveOp(op, function (result) {
          var created = result.work.orders[result.work.orders.length - 1];
          view = { name: "order", id: view.id || created.id };
        });
      });
    }
    if (form.id === "equipment-form") {
      event.preventDefault();
      var equipmentData = new FormData(form);
      var equipmentId = view.id || String(equipmentData.get("equipmentId") || "").trim();
      var equipmentOp = view.id ? {
        type: "updateEquipment",
        id: view.id,
        name: equipmentData.get("name"),
        notes: equipmentData.get("notes"),
        tags: equipmentData.get("tags")
      } : {
        type: "createEquipment",
        id: equipmentId,
        name: equipmentData.get("name"),
        notes: equipmentData.get("notes"),
        tags: equipmentData.get("tags")
      };
      enqueue(function () {
        return saveOp(equipmentOp, function () {
          view = { name: "equipment-detail", id: equipmentId };
        });
      });
    }
    if (form.id === "status-form") {
      event.preventDefault();
      enqueue(function () {
        var statusData = new FormData(form);
        return saveOp({ type: "setStatus", orderId: view.id, status: statusData.get("status"), text: statusData.get("text") });
      });
    }
    if (form.id === "step-form") {
      event.preventDefault();
      var stepText = form.text.value;
      var stepAssignee = form.assignee.value;
      var stepOrderId = view.id;
      enqueue(function () { return saveOp({ type: "addStep", orderId: stepOrderId, text: stepText, assignee: stepAssignee }); });
    }
    if (form.id === "note-form") {
      event.preventDefault();
      enqueue(function () { return saveOp({ type: "addNote", orderId: view.id, text: form.text.value }); });
    }
    if (form.id === "retire-form") {
      event.preventDefault();
      var retireId = dialog.id;
      enqueue(function () {
        dialog = null;
        return saveOp({ type: "retireEquipment", id: retireId, note: form.note.value });
      });
    }
    if (form.id === "reactivate-form") {
      event.preventDefault();
      var wakeId = dialog.id;
      enqueue(function () {
        dialog = null;
        return saveOp({ type: "reactivateEquipment", id: wakeId });
      });
    }
    if (form.id === "rename-form") {
      event.preventDefault();
      var fromId = dialog.id;
      var toId = form.toId.value.trim();
      enqueue(function () {
        dialog = null;
        return saveOp({ type: "renameEquipment", fromId: fromId, toId: toId }, function () {
          view = { name: "equipment-detail", id: toId };
        });
      });
    }
  });

  function goHome() {
    if (dialog && dialog.url) URL.revokeObjectURL(dialog.url);
    settingsOpen = false;
    printOpen = false;
    dialog = null;
    search = "";
    homeMode = "activity";
    ordersMode = "list";
    view = { name: "orders" };
    render();
  }

  function signOut() {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem("jsw.token");
    localStorage.removeItem("jsw.repo");
    settingsOpen = false;
    client = null;
    user = null;
    homeMode = "activity";
    view = { name: "orders" };
    errorText = "";
    notice = "";
    render();
  }

  function closeDialog() {
    if (dialog && dialog.url) URL.revokeObjectURL(dialog.url);
    dialog = null;
    render();
  }

  async function reload() {
    if (!client) return;
    await run(function () { return client.load(); });
  }

  async function saveOp(op, after, binary) {
    var preview;
    try { preview = JobModel.apply(Object.assign({ actor: user }, client.snapshot()), op); }
    catch (error) { errorText = error.message; notice = ""; render(); return; }
    previewState = preview;
    errorText = "";
    notice = "";
    await run(async function () {
      var result = await client.save(op, binary);
      previewState = null;
      if (after) after(result);
      notice = "Saved.";
    });
    previewState = null;
  }

  async function run(fn) {
    busy = true;
    render();
    try {
      await fn();
      errorText = "";
    } catch (error) {
      previewState = null;
      errorText = error.message || "Something went wrong.";
      if (client) {
        try { await client.load(); } catch (loadError) { errorText = loadError.message; }
      }
    } finally {
      busy = false;
      render();
    }
  }

  async function addFile(orderId, file) {
    var prepared;
    try { prepared = await prepareFile(file); }
    catch (error) { errorText = error.message; render(); return; }
    await saveOp({
      type: "addAttachment",
      orderId: orderId,
      filename: prepared.filename,
      contentType: prepared.contentType,
      byteSize: prepared.byteSize,
      kind: prepared.kind
    }, null, { bytes: prepared.bytes });
  }

  async function openFile(id) {
    var attachment = JobModel.findAttachment(data().work, id);
    if (!attachment) return;
    try {
      await showFile(attachment);
    } catch (error) {
      errorText = error.message;
      render();
    }
  }

  async function showFile(attachment) {
    var blob = await client.readFile(attachment.path);
    var url = URL.createObjectURL(blob);
    var heic = /heic|heif/i.test(attachment.contentType) || /\.heic$|\.heif$/i.test(attachment.filename);
    if (attachment.kind === "image" && !heic) {
      if (dialog && dialog.url) URL.revokeObjectURL(dialog.url);
      dialog = { type: "image", url: url, filename: attachment.filename };
      render();
      return;
    }
    var link = document.createElement("a");
    link.href = url;
    link.download = attachment.filename;
    link.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function prepareFile(file) {
    var ext = (file.name.split(".").pop() || "").toLowerCase();
    var imageExt = { jpg: 1, jpeg: 1, png: 1, webp: 1, heic: 1, heif: 1 };
    var docExt = { pdf: 1, doc: 1, docx: 1, xls: 1, xlsx: 1, txt: 1, csv: 1, ppt: 1, pptx: 1 };
    var isImage = file.type.indexOf("image/") === 0 || !!imageExt[ext];
    if (!isImage && !docExt[ext]) return Promise.reject(new Error("Use a photo, PDF, or Office file."));
    if (!isImage) {
      if (file.size > 25 * 1024 * 1024) return Promise.reject(new Error("Documents need to be 25MB or smaller."));
      return file.arrayBuffer().then(function (buffer) {
        var bytes = new Uint8Array(buffer);
        return { bytes: bytes, filename: file.name, contentType: file.type || "application/octet-stream", kind: "document", byteSize: bytes.length };
      });
    }
    return shrinkImage(file).then(function (blob) {
      return blob.arrayBuffer().then(function (buffer) {
        var bytes = new Uint8Array(buffer);
        return {
          bytes: bytes,
          filename: file.name.replace(/\.[^.]+$/, "") + ".jpg",
          contentType: "image/jpeg",
          kind: "image",
          byteSize: bytes.length
        };
      });
    }).catch(function () {
      var heic = ext === "heic" || ext === "heif" || /heic|heif/i.test(file.type);
      if (heic && file.size <= 10 * 1024 * 1024) {
        return file.arrayBuffer().then(function (buffer) {
          var bytes = new Uint8Array(buffer);
          return { bytes: bytes, filename: file.name, contentType: file.type || "image/heic", kind: "image", byteSize: bytes.length };
        });
      }
      if (heic) throw new Error("This photo is a large HEIC file. Take it again as a JPEG.");
      throw new Error("Could not read that photo.");
    });
  }

  function shrinkImage(file) {
    return createImageBitmap(file).then(function (bitmap) {
      var scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      var canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      if (bitmap.close) bitmap.close();
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) {
          if (!blob) reject(new Error("Could not shrink that photo."));
          else resolve(blob);
        }, "image/jpeg", 0.82);
      });
    });
  }
})();
