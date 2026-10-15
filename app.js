(function () {
  var TOKEN_KEY = "jsw.token";
  var REPO_KEY = "jsw.repo";
  var STATUS_LABEL = {
    new: "New",
    in_progress: "In progress",
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
    var token = localStorage.getItem(TOKEN_KEY) || "";
    var repo = localStorage.getItem(REPO_KEY) || "";
    if (token && repo) {
      try { await connect(token, repo); }
      catch (error) { errorText = error.message; }
    }
    render();
  }

  async function connect(token, repo) {
    var nextUser = await JobGitHub.getUser(token);
    var nextClient = JobGitHub.createClient({ token: token, repo: repo, actor: nextUser });
    await nextClient.load();
    var people = nextClient.snapshot().settings.people;
    var known = people.some(function (person) { return person.id === nextUser.id; });
    if (!known && people.length >= 2) throw new Error("Only two people can use this app.");
    user = nextUser;
    client = nextClient;
    if (!known) await client.save({ type: "addPerson", displayName: user.displayName });
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(REPO_KEY, repo);
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
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
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

  function signIn() {
    var repo = esc(localStorage.getItem(REPO_KEY) || "");
    return "<header><h1>Job site work orders</h1></header>" +
      banner() +
      "<form class=\"card\" id=\"sign-in\">" +
      "<label>Private repo<input id=\"repo\" name=\"repo\" required placeholder=\"owner/job-site-work-orders\" value=\"" + repo + "\"></label>" +
      "<label>GitHub token<input id=\"token\" name=\"token\" type=\"password\" required autocomplete=\"off\"></label>" +
      "<button type=\"submit\"" + disabled() + ">Sign in</button>" +
      "<p class=\"muted\">Use a fine-grained token that can only read and write the private repo. It stays on this device.</p>" +
      "</form>";
  }

  function shell(body) {
    var current = data();
      var listing = view.name === "orders" || view.name === "equipment";
      return "<header>" +
      "<div class=\"row\"><h1>Job site</h1><span>" + esc(nameOf(user.id)) + "</span>" +
      "<button type=\"button\" class=\"secondary\" data-action=\"sign-out\">Sign out</button></div>" +
      "<label>Search<input id=\"search\" value=\"" + esc(search) + "\" placeholder=\"Orders, equipment, notes\"></label>" +
      "<nav class=\"nav\">" +
      "<button type=\"button\" data-action=\"nav\" data-view=\"orders\"" + (view.name === "orders" ? " aria-current=\"page\"" : "") + ">Orders</button>" +
      "<button type=\"button\" data-action=\"nav\" data-view=\"equipment\"" + (view.name === "equipment" || view.name === "equipment-form" ? " aria-current=\"page\"" : "") + ">Equipment</button>" +
      "</nav>" +
      "<form id=\"name-form\" class=\"row\">" +
      "<label>Your name<input id=\"display-name\" value=\"" + esc(nameOf(user.id)) + "\"></label>" +
      "<button type=\"submit\" class=\"secondary\"" + disabled() + ">Save name</button></form>" +
      "</header>" + banner() + (search.trim() && listing ? searchResults(current) : body);
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
    return orderList();
  }

  function orderList() {
    var orders = visibleOrders();
    var cards = orders.map(orderCard).join("") || "<p class=\"muted\">No open work orders.</p>";
    return "<div class=\"row\"><h2>Work orders</h2><button type=\"button\" data-action=\"new-order\"" + disabled() + ">New order</button></div>" +
      filtersHtml() + cards;
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
      "<label>Tag<select id=\"filter-tag\"><option value=\"\">Any tag</option>" + tags + "</select></label>" +
      "<label>Equipment<select id=\"filter-equipment\"><option value=\"\">Any equipment</option>" + equipment + "</select></label>" +
      "</div>";
  }

  function orderCard(order) {
    var overdue = JobModel.isOpenStatus(order.status) && order.dueDate && order.dueDate < today();
    var count = JobModel.linkedAttachments(data().work, order).length;
    return "<button type=\"button\" class=\"card card-button\" data-action=\"open-order\" data-id=\"" + esc(order.id) + "\">" +
      "<strong>" + esc(order.title) + "</strong>" +
      "<span class=\"meta\">" + esc(order.id) + " · " + esc(order.location) + "</span>" +
      "<span><span class=\"chip " + esc(order.status) + (overdue ? " overdue" : "") + "\">" + esc(STATUS_LABEL[order.status]) + (overdue ? " · Overdue" : "") + "</span> " +
      esc(PRIORITY_LABEL[order.priority]) + " · " + esc(nameOf(order.assignee)) +
      (order.dueDate ? " · Due " + esc(order.dueDate) : "") +
      (count ? " · " + count + " file" + (count === 1 ? "" : "s") : "") +
      "</span></button>";
  }

  function searchResults() {
    return "<h2>Search</h2><h3>Orders</h3>" +
      (visibleOrders().map(orderCard).join("") || "<p class=\"muted\">No matching orders.</p>") +
      "<h3>Equipment</h3>" +
      (visibleEquipment().map(equipmentCard).join("") || "<p class=\"muted\">No matching equipment.</p>");
  }

  function orderForm() {
    var order = view.id ? JobModel.findOrder(data().work, view.id) : null;
    var selected = order ? order.equipmentIds : [];
    return "<form class=\"card\" id=\"order-form\">" +
      "<h2>" + (order ? "Edit " + esc(order.id) : "New work order") + "</h2>" +
      field("Title", "title", order ? order.title : "") +
      field("Location", "location", order ? order.location : "") +
      "<label>Description<textarea name=\"description\" required>" + esc(order ? order.description : "") + "</textarea></label>" +
      "<label>Priority<select name=\"priority\">" + JobModel.PRIORITIES.map(function (priority) {
        return "<option value=\"" + priority + "\"" + ((order ? order.priority : "normal") === priority ? " selected" : "") + ">" + PRIORITY_LABEL[priority] + "</option>";
      }).join("") + "</select></label>" +
      (order ? "" : "<label>Assignee<select name=\"assignee\"><option value=\"\">Unassigned</option>" + peopleOptions(order ? order.assignee : "") + "</select></label>") +
      "<label>Due date<input type=\"date\" name=\"dueDate\" value=\"" + esc(order ? order.dueDate : "") + "\"></label>" +
      field("Tags", "tags", order ? order.tags.join(", ") : "", false) +
      "<fieldset><legend>Equipment</legend>" + equipmentChecks(selected) + "</fieldset>" +
      "<div class=\"actions\"><button type=\"submit\"" + disabled() + ">Save</button>" +
      "<button type=\"button\" class=\"secondary\" data-action=\"back\">Cancel</button></div></form>";
  }

  function field(label, name, value, required) {
    return "<label>" + label + "<input name=\"" + name + "\" value=\"" + esc(value) + "\"" + (required === false ? "" : " required") + "></label>";
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
        return "<label><input type=\"checkbox\" checked disabled> " + esc(item.id) + " · " + esc(item.name) + " (retired)</label>" +
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
    return "<button type=\"button\" class=\"secondary\" data-action=\"back\">Back</button>" +
      "<article class=\"card\"><h2>" + esc(order.title) + "</h2>" +
      "<p class=\"meta\">" + esc(order.id) + " · " + esc(order.location) + "</p>" +
      "<p>" + esc(order.description) + "</p>" +
      "<p><span class=\"chip " + esc(order.status) + "\">" + esc(STATUS_LABEL[order.status]) + "</span> " +
      esc(PRIORITY_LABEL[order.priority]) + (order.dueDate ? " · Due " + esc(order.dueDate) : "") + "</p>" +
      "<p>Tags: " + esc(order.tags.join(", ") || "None") + "</p>" +
      "<p>Equipment: " + equipmentLinks(order) + "</p>" +
      "<label>Assigned to<select id=\"assignee\"" + disabled() + "><option value=\"\">Unassigned</option>" + peopleOptions(order.assignee) + "</select></label>" +
      "<button type=\"button\" class=\"secondary\" data-action=\"edit-order\" data-id=\"" + esc(order.id) + "\">Edit details</button>" +
      "</article>" +
      "<form class=\"card\" id=\"status-form\"><h3>Status</h3>" +
      "<label>Status<select name=\"status\">" + JobModel.STATUSES.map(function (status) {
        return "<option value=\"" + status + "\"" + (order.status === status ? " selected" : "") + ">" + STATUS_LABEL[status] + "</option>";
      }).join("") + "</select></label>" +
      "<label>Reason<textarea name=\"text\" placeholder=\"Required for Waiting, Done, and Canceled\"></textarea></label>" +
      "<button type=\"submit\"" + disabled() + ">Update status</button></form>" +
      "<form class=\"card\" id=\"note-form\"><h3>Note</h3><label>Note<textarea name=\"text\" required></textarea></label>" +
      "<button type=\"submit\"" + disabled() + ">Add note</button></form>" +
      "<section class=\"card\"><h3>Files</h3>" +
      (files.map(function (file) {
        return "<div class=\"file-row\"><button type=\"button\" data-action=\"open-file\" data-id=\"" + esc(file.id) + "\">" + esc(file.filename) + "</button>" +
          "<span class=\"meta\">" + esc(nameOf(file.by)) + " · " + esc(when(file.createdAt)) + "</span>" +
          "<button type=\"button\" class=\"secondary\" data-action=\"unlink\" data-id=\"" + esc(file.id) + "\"" + disabled() + ">Remove from order</button></div>";
      }).join("") || "<p class=\"muted\">No files yet.</p>") +
      "<label>Add a photo or document<input id=\"file\" type=\"file\" accept=\"image/*,.heic,.heif,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv\"" + disabled() + "></label>" +
      "</section>" +
      "<section class=\"card\"><h3>Activity</h3><ul class=\"activity\">" + activity(order) + "</ul></section>" +
      imageDialog();
  }

  function equipmentLinks(order) {
    if (!order.equipmentIds.length) return "None";
    return order.equipmentIds.map(function (id) {
      var item = JobModel.findEquipment(data().equipment, id);
      var label = item ? item.id + " · " + item.name : id;
      return "<button type=\"button\" class=\"secondary\" data-action=\"open-equipment\" data-id=\"" + esc(id) + "\">" + esc(label) + "</button>";
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
    if (line.type === "assigned") return who + " assigned this to " + nameOf(line.to);
    if (line.type === "status") return who + " changed status from " + STATUS_LABEL[line.from] + " to " + STATUS_LABEL[line.to] + (line.text ? ": " + line.text : "");
    if (line.type === "attachment") return who + " added " + line.text;
    if (line.type === "unlinked") return who + " removed " + line.text;
    if (line.type === "retire") return who + " retired this" + (line.text ? ". " + line.text : "");
    if (line.type === "reactivate") return who + " reactivated this";
    if (line.type === "rename") return who + " renamed " + line.from + " to " + line.to;
    return who + " updated this";
  }

  function equipmentList() {
    var cards = visibleEquipment().map(equipmentCard).join("") || "<p class=\"muted\">No equipment yet.</p>";
    return "<div class=\"row\"><h2>Equipment</h2><button type=\"button\" data-action=\"new-equipment\"" + disabled() + ">New equipment</button></div>" + cards;
  }

  function equipmentCard(item) {
    return "<button type=\"button\" class=\"card card-button\" data-action=\"open-equipment\" data-id=\"" + esc(item.id) + "\">" +
      "<strong>" + esc(item.id) + "</strong><span>" + esc(item.name) + "</span>" +
      "<span class=\"chip " + esc(item.status) + "\">" + (item.status === "retired" ? "Retired" : "Active") + "</span> " +
      "<span class=\"meta\">" + esc(item.tags.join(", ")) + "</span></button>";
  }

  function equipmentForm() {
    var item = view.id ? JobModel.findEquipment(data().equipment, view.id) : null;
    return "<form class=\"card\" id=\"equipment-form\">" +
      "<h2>" + (item ? "Edit equipment" : "New equipment") + "</h2>" +
      (item ? "<p>ID " + esc(item.id) + "</p>" : field("Equipment ID", "equipmentId", "")) +
      "<label>Name<input name=\"name\" value=\"" + esc(item ? item.name : "") + "\" required></label>" +
      "<label>Notes<textarea name=\"notes\">" + esc(item ? item.notes : "") + "</textarea></label>" +
      "<label>Tags<input name=\"tags\" value=\"" + esc(item ? item.tags.join(", ") : "") + "\"></label>" +
      "<div class=\"actions\"><button type=\"submit\"" + disabled() + ">Save</button>" +
      "<button type=\"button\" class=\"secondary\" data-action=\"back\">Cancel</button></div></form>";
  }

  function equipmentDetail() {
    var item = JobModel.findEquipment(data().equipment, view.id);
    if (!item) return "<p>That equipment is gone.</p>";
    var orders = data().work.orders.filter(function (order) {
      return order.equipmentIds.indexOf(item.id) !== -1;
    });
    return "<button type=\"button\" class=\"secondary\" data-action=\"back\">Back</button>" +
      "<article class=\"card\"><h2>" + esc(item.id) + "</h2><p>" + esc(item.name) + "</p>" +
      "<p><span class=\"chip " + esc(item.status) + "\">" + (item.status === "retired" ? "Retired" : "Active") + "</span></p>" +
      "<p>" + esc(item.notes || "No notes") + "</p><p>Tags: " + esc(item.tags.join(", ") || "None") + "</p>" +
      "<div class=\"actions\">" +
      (item.status === "active" ? "<button type=\"button\" class=\"secondary\" data-action=\"edit-equipment\" data-id=\"" + esc(item.id) + "\">Edit</button>" +
        "<button type=\"button\" class=\"secondary\" data-action=\"rename\" data-id=\"" + esc(item.id) + "\">Rename ID</button>" +
        "<button type=\"button\" class=\"danger\" data-action=\"retire\" data-id=\"" + esc(item.id) + "\">Retire</button>"
        : "<button type=\"button\" data-action=\"reactivate\" data-id=\"" + esc(item.id) + "\"" + disabled() + ">Reactivate</button>") +
      "</div></article>" +
      "<section class=\"card\"><h3>Past use</h3>" +
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
        "<label>Note<input name=\"note\" placeholder=\"Sold, transferred, scrapped\"></label>" +
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
      "<label>New equipment ID<input name=\"toId\" required value=\"" + esc(item.id) + "\"></label>" +
      "<div class=\"actions\"><button type=\"submit\"" + disabled() + ">Rename</button>" +
      "<button type=\"button\" class=\"secondary\" data-action=\"close-dialog\">Cancel</button></div></form></dialog>";
  }

  function imageDialog() {
    if (!dialog || dialog.type !== "image") return "";
    return "<dialog id=\"dialog\"><h3>" + esc(dialog.filename) + "</h3><img alt=\"\" src=\"" + dialog.url + "\" style=\"max-width:100%\">" +
      "<div class=\"actions\"><button type=\"button\" class=\"secondary\" data-action=\"close-dialog\">Close</button></div></dialog>";
  }

  document.addEventListener("click", function (event) {
    var target = event.target.closest("[data-action]");
    if (!target || busy) return;
    var action = target.getAttribute("data-action");
    var id = target.getAttribute("data-id");
    if (action === "sign-out") return signOut();
    if (action === "nav") { view = { name: target.getAttribute("data-view") }; dialog = null; render(); }
    if (action === "new-order") { view = { name: "order-form" }; render(); }
    if (action === "new-equipment") { view = { name: "equipment-form" }; render(); }
    if (action === "open-order") { view = { name: "order", id: id }; render(); }
    if (action === "open-equipment") { view = { name: "equipment-detail", id: id }; dialog = null; render(); }
    if (action === "edit-order") { view = { name: "order-form", id: id }; render(); }
    if (action === "edit-equipment") { view = { name: "equipment-form", id: id }; render(); }
    if (action === "back") { view = view.id && view.name === "order-form" ? { name: "order", id: view.id } : { name: view.name.indexOf("equipment") === 0 ? "equipment" : "orders" }; render(); }
    if (action === "retire" || action === "reactivate" || action === "rename") { dialog = { type: action === "retire" ? "retire" : action, id: id }; render(); }
    if (action === "close-dialog") closeDialog();
    if (action === "unlink") enqueue(function () { return saveOp({ type: "unlinkAttachment", attachmentId: id }); });
    if (action === "open-file") enqueue(function () { return openFile(id); });
  });

  document.addEventListener("change", function (event) {
    if (event.target.id === "search") return;
    if (event.target.id === "filter-assignee") { filters.assignee = event.target.value; render(); }
    if (event.target.id === "filter-status") { filters.status = event.target.value; render(); }
    if (event.target.id === "filter-tag") { filters.tag = event.target.value; render(); }
    if (event.target.id === "filter-equipment") { filters.equipment = event.target.value; render(); }
    if (event.target.id === "assignee") {
      enqueue(function () {
        return saveOp({ type: "setAssignee", orderId: view.id, assignee: event.target.value });
      });
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
      var repo = form.repo.value.trim();
      var token = form.token.value.trim();
      enqueue(function () {
        return run(function () { return connect(token, repo); });
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
      var formData = new FormData(form);
      var op = {
        type: view.id ? "updateOrder" : "createOrder",
        id: view.id,
        title: formData.get("title"),
        location: formData.get("location"),
        description: formData.get("description"),
        priority: formData.get("priority"),
        dueDate: formData.get("dueDate"),
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

  function signOut() {
    localStorage.removeItem(TOKEN_KEY);
    client = null;
    user = null;
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
