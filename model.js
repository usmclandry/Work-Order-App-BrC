(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.JobModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var OPEN = ["new", "in_progress", "waiting"];
  var STATUSES = ["new", "in_progress", "waiting", "done", "canceled"];
  var PRIORITIES = ["low", "normal", "high"];
  var REPEATS = ["weekly", "biweekly", "monthly", "quarterly", "semiannual", "annual"];
  var NEEDS_TEXT = ["waiting", "done", "canceled"];

  function personId(login) {
    return "github:" + String(login || "").trim();
  }

  function emptySettings() {
    return { version: 1, people: [], budgets: [] };
  }

  function emptyEquipment() {
    return { version: 1, equipment: [] };
  }

  function emptyWork() {
    return { version: 1, orders: [], attachments: [] };
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function keyOf(id) {
    return String(id || "").trim().toLowerCase();
  }

  function assertVersion(doc, name) {
    if (!doc || doc.version !== 1) throw new Error(name + " is not version 1.");
  }

  function actorTag(actor) {
    return (actor && (actor.githubLogin || actor.email)) || "";
  }

  function requireActor(actor) {
    if (!actor || !actor.id || !actorTag(actor)) throw new Error("Sign in before saving.");
  }

  function nextNumberedId(prefix, ids) {
    var max = 0;
    var re = new RegExp("^" + prefix + "-(\\d+)$");
    ids.forEach(function (id) {
      var match = re.exec(id);
      if (match) max = Math.max(max, parseInt(match[1], 10));
    });
    var n = max + 1;
    return prefix + "-" + (n < 1000 ? String(n).padStart(3, "0") : String(n));
  }

  function safeFilename(name) {
    var base = String(name || "file").split(/[/\\]/).pop();
    var cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return (cleaned || "file").slice(0, 80);
  }

  function normalizeTags(tags) {
    var out = [];
    var seen = {};
    (tags || []).forEach(function (raw) {
      var text = String(raw).trim().replace(/\s+/g, " ");
      if (!text) return;
      var key = text.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      out.push(text);
    });
    return out;
  }

  function parseTags(value) {
    if (Array.isArray(value)) return normalizeTags(value);
    return normalizeTags(String(value || "").split(","));
  }

  function uniqueIds(ids) {
    var out = [];
    var seen = {};
    (ids || []).forEach(function (raw) {
      var id = String(raw || "").trim();
      if (!id) return;
      var key = keyOf(id);
      if (seen[key]) return;
      seen[key] = true;
      out.push(id);
    });
    return out;
  }

  function logLine(actor, type, extra) {
    extra = extra || {};
    return {
      at: nowIso(),
      by: actor.id,
      type: type,
      from: extra.from || "",
      to: extra.to || "",
      text: extra.text || ""
    };
  }

  function findPerson(settings, id) {
    return settings.people.find(function (person) { return person.id === id; });
  }

  function findEquipment(doc, id) {
    var key = keyOf(id);
    return doc.equipment.find(function (item) { return keyOf(item.id) === key; });
  }

  function findOrder(doc, id) {
    return doc.orders.find(function (order) { return order.id === id; });
  }

  function orderSteps(order) {
    if (!Array.isArray(order.steps)) order.steps = [];
    return order.steps;
  }

  function ownerId(order) {
    if (order.assignee) return order.assignee;
    var created = (order.log || []).find(function (line) {
      return line.type === "created" || line.type === "repeated";
    });
    return (created && created.by) || "";
  }

  function repeatOf(value) {
    var repeat = String(value || "").trim();
    if (!repeat) return "";
    if (REPEATS.indexOf(repeat) === -1) throw new Error("Choose how often this repeats.");
    return repeat;
  }

  function localDate(iso) {
    var date = new Date(iso);
    var month = String(date.getMonth() + 1).padStart(2, "0");
    var day = String(date.getDate()).padStart(2, "0");
    return date.getFullYear() + "-" + month + "-" + day;
  }

  function addDays(isoDate, days) {
    var parts = isoDate.split("-").map(Number);
    var date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function addMonths(isoDate, months) {
    var parts = isoDate.split("-").map(Number);
    var cursor = new Date(Date.UTC(parts[0], parts[1] - 1 + months, 1));
    var lastDay = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)).getUTCDate();
    var result = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), Math.min(parts[2], lastDay)));
    return result.toISOString().slice(0, 10);
  }

  function nextDueDate(dueDate, repeat, completedOn) {
    var base = dueDate || completedOn;
    if (!base || !repeat) return "";
    if (repeat === "weekly") return addDays(base, 7);
    if (repeat === "biweekly") return addDays(base, 14);
    if (repeat === "monthly") return addMonths(base, 1);
    if (repeat === "quarterly") return addMonths(base, 3);
    if (repeat === "semiannual") return addMonths(base, 6);
    if (repeat === "annual") return addMonths(base, 12);
    return "";
  }

  function activeEquipmentIds(equipment, ids) {
    return (ids || []).map(function (id) {
      return findEquipment(equipment, id);
    }).filter(function (item) {
      return item && item.status === "active";
    }).map(function (item) {
      return item.id;
    });
  }

  function copySteps(steps) {
    var copied = [];
    (steps || []).forEach(function (step) {
      copied.push({
        id: nextNumberedId("S", copied.map(function (item) { return item.id; })),
        text: step.text,
        assignee: step.assignee || "",
        done: false,
        doneAt: null,
        doneBy: ""
      });
    });
    return copied;
  }

  function spawnNextOrder(work, equipment, actor, source) {
    var orderId = nextNumberedId("WO", work.orders.map(function (order) { return order.id; }));
    var order = {
      id: orderId,
      title: source.title,
      location: source.location,
      description: source.description,
      priority: source.priority,
      assignee: source.assignee,
      status: "new",
      dueDate: nextDueDate(source.dueDate, source.repeat, localDate(source.completedAt || nowIso())),
      tags: (source.tags || []).slice(),
      equipmentIds: activeEquipmentIds(equipment, source.equipmentIds),
      attachmentIds: [],
      notes: [],
      steps: copySteps(source.steps),
      followers: (source.followers || []).filter(function (id) {
        return id && id !== (source.assignee || actor.id);
      }),
      purchases: [],
      repeat: source.repeat,
      fromId: source.id,
      nextId: "",
      log: [logLine(actor, "repeated", { from: source.id })],
      createdAt: nowIso(),
      completedAt: null
    };
    source.nextId = orderId;
    source.log.push(logLine(actor, "repeated", { to: orderId }));
    work.orders.push(order);
    return order;
  }

  function followerIds(order) {
    if (!Array.isArray(order.followers)) order.followers = [];
    return order.followers;
  }

  function addFollower(order, actor, personId) {
    if (!personId || personId === ownerId(order)) return false;
    var followers = followerIds(order);
    if (followers.indexOf(personId) !== -1) return false;
    followers.push(personId);
    order.log.push(logLine(actor, "followed", { to: personId }));
    return true;
  }

  function removeFollower(order, actor, personId) {
    var followers = followerIds(order);
    var index = followers.indexOf(personId);
    if (index === -1) return false;
    followers.splice(index, 1);
    order.log.push(logLine(actor, "unfollowed", { from: personId }));
    return true;
  }

  function mentionedIds(text, settings) {
    var found = [];
    (settings.people || []).forEach(function (person) {
      var full = String(person.displayName || "").trim();
      if (!full) return;
      var first = full.split(/\s+/)[0];
      var names = first && first.toLowerCase() !== full.toLowerCase() ? [full, first] : [full];
      var hit = names.some(function (name) {
        return new RegExp("(^|\\s)@" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=$|\\s|[^A-Za-z0-9])", "i").test(text);
      });
      if (hit) found.push(person.id);
    });
    return found;
  }

  function canEditOrder(actor, order) {
    var owner = ownerId(order);
    return !owner || !!(actor && owner === actor.id);
  }

  function canCompleteStep(actor, order, step) {
    if (canEditOrder(actor, order)) return true;
    return !!(actor && step && step.assignee && step.assignee === actor.id);
  }

  function assertCanEdit(actor, order) {
    if (!canEditOrder(actor, order)) throw new Error("Only the owner can edit this work order.");
  }

  function assertCanCompleteStep(actor, order, step) {
    if (!canCompleteStep(actor, order, step)) throw new Error("You can only check off steps assigned to you.");
  }

  function canAddNote(actor) {
    return !!(actor && actor.id);
  }

  var ACCESS_MANAGER_ID = "user:4bfda55b-dbec-4854-8731-ff75b7d913fd";

  function personCanCreate(settings, actor) {
    var person = findPerson(settings, actor && actor.id);
    if (!person) return false;
    return person.canCreate !== false;
  }

  function canManageAccess(settings, actor) {
    return !!(actor && actor.id === ACCESS_MANAGER_ID && findPerson(settings, actor.id));
  }

  function assertCanCreate(settings, actor) {
    if (!personCanCreate(settings, actor)) throw new Error("You can't create new work orders or budgets.");
  }

  function assertCanManageAccess(settings, actor) {
    if (!canManageAccess(settings, actor)) throw new Error("Only Brandon can change who can create.");
  }

  function assertCanNote(actor, order) {
    if (!canAddNote(actor, order)) throw new Error("Only the owner or a follower can add a note.");
  }

  function findAttachment(doc, id) {
    return doc.attachments.find(function (item) { return item.id === id; });
  }

  function commitMessage(actor, text) {
    return text + " by " + actorTag(actor);
  }

  function budgetsOf(settings) {
    return Array.isArray(settings.budgets) ? settings.budgets : [];
  }

  function findBudget(settings, id) {
    if (!id) return null;
    return budgetsOf(settings).find(function (item) { return item.id === id; }) || null;
  }

  function parseMoney(value) {
    if (value == null) return null;
    var text = String(value).trim().replace(/[$,\s]/g, "");
    if (!text) return null;
    if (!/^\d+(\.\d{0,2})?$/.test(text)) throw new Error("Enter the cost in dollars and cents.");
    var parts = text.split(".");
    var dollars = parseInt(parts[0], 10);
    var cents = parseInt(((parts[1] || "") + "00").slice(0, 2), 10);
    var total = dollars * 100 + cents;
    if (total > 999999999) throw new Error("That amount is too large.");
    return total;
  }

  function formatMoney(cents) {
    if (cents == null) return "";
    var sign = cents < 0 ? "-" : "";
    var abs = Math.abs(Math.trunc(cents));
    var dollars = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return sign + "$" + dollars + "." + String(abs % 100).padStart(2, "0");
  }

  function dateStamp(value, message) {
    var text = String(value || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(message);
    return text;
  }

  function codesOf(budget) {
    if (!budget) return [];
    if (Array.isArray(budget.codes) && budget.codes.length) return budget.codes;
    if (budget.code) return [{ id: budget.id, code: budget.code, limitCents: budget.limitCents || 0 }];
    return Array.isArray(budget.codes) ? budget.codes : [];
  }

  function findCode(settings, id) {
    if (!id) return null;
    var found = null;
    budgetsOf(settings).some(function (budget) {
      var code = codesOf(budget).find(function (item) { return item.id === id; });
      if (!code) return false;
      found = { budget: budget, code: code };
      return true;
    });
    return found;
  }

  function buildBudget(op, settings, existing) {
    var name = String(op.name || "").trim().replace(/\s+/g, " ");
    if (!name) throw new Error("Enter a name for the budget.");
    if (name.length > 80) throw new Error("That budget name is too long.");
    var totalCents = parseMoney(op.total);
    var starts = dateStamp(op.starts, "Enter the first day of the budget year.");
    var ends = dateStamp(op.ends, "Enter the last day of the budget year.");
    if (ends < starts) throw new Error("The budget year has to end after it starts.");
    var kept = [];
    budgetsOf(settings).forEach(function (budget) {
      if (existing && budget.id === existing.id) return;
      codesOf(budget).forEach(function (code) { kept.push(code.id); });
    });
    var seen = {};
    var codes = [];
    (Array.isArray(op.codes) ? op.codes : []).forEach(function (row) {
      var code = String(row && row.code || "").trim().replace(/\s+/g, " ");
      var limitCents = parseMoney(row && row.limit);
      if (!code && limitCents == null) return;
      if (!code) throw new Error("Enter a billing code.");
      if (code.length > 40) throw new Error("That billing code is too long.");
      if (limitCents == null) throw new Error("Enter a limit for " + code + ".");
      var key = code.toLowerCase();
      if (seen[key]) throw new Error(code + " is already in this budget.");
      seen[key] = true;
      var taken = false;
      budgetsOf(settings).forEach(function (budget) {
        if (existing && budget.id === existing.id) return;
        codesOf(budget).forEach(function (item) {
          if (item.code.toLowerCase() === key) taken = true;
        });
      });
      if (taken) throw new Error(code + " is already in a budget.");
      var keepId = row.id && existing && codesOf(existing).some(function (item) { return item.id === row.id; });
      var id = keepId ? row.id : nextNumberedId("BC", kept.concat(codes.map(function (item) { return item.id; })));
      codes.push({ id: id, code: code, limitCents: limitCents });
    });
    if (!codes.length) throw new Error("Add a billing code.");
    return { name: name, totalCents: totalCents, starts: starts, ends: ends, codes: codes };
  }

  function orderPurchases(order) {
    var list = Array.isArray(order.purchases) ? order.purchases.slice() : [];
    if (order.costCents != null && order.budgetId) {
      var covered = list.some(function (item) {
        return item.codeId === order.budgetId && item.costCents === order.costCents;
      });
      if (!covered) {
        list.push({ id: "legacy", codeId: order.budgetId, costCents: order.costCents, at: order.createdAt || "", by: "" });
      }
    }
    return list;
  }

  function orderUsesCode(order, codeId) {
    return orderPurchases(order).some(function (purchase) { return purchase.codeId === codeId; });
  }

  function spentCents(work, codeId) {
    var total = 0;
    (work.orders || []).forEach(function (order) {
      if (order.status === "canceled") return;
      orderPurchases(order).forEach(function (purchase) {
        if (purchase.codeId === codeId && purchase.costCents != null) total += purchase.costCents;
      });
    });
    return total;
  }

  function budgetSpentCents(work, budget) {
    var total = 0;
    codesOf(budget).forEach(function (code) { total += spentCents(work, code.id); });
    return total;
  }

  function budgetNotices(settings, work, todayStamp) {
    var notices = [];
    budgetsOf(settings).forEach(function (budget) {
      var codes = codesOf(budget);
      var assigned = (work.orders || []).some(function (order) {
        return order.status !== "canceled" && codes.some(function (code) { return orderUsesCode(order, code.id); });
      });
      codes.forEach(function (code) {
        var spent = spentCents(work, code.id);
        if (spent > code.limitCents) {
          notices.push({
            kind: "limit",
            budgetId: budget.id,
            codeId: code.id,
            code: code.code,
            spent: spent,
            limit: code.limitCents,
            over: spent - code.limitCents
          });
        }
      });
      if (budget.totalCents != null) {
        var allSpent = budgetSpentCents(work, budget);
        if (allSpent > budget.totalCents) {
          notices.push({
            kind: "total",
            budgetId: budget.id,
            spent: allSpent,
            limit: budget.totalCents,
            over: allSpent - budget.totalCents
          });
        }
      }
      if (assigned && budget.ends < todayStamp) {
        notices.push({ kind: "year", budgetId: budget.id, ends: budget.ends });
      }
    });
    return notices;
  }

  function apply(state, op) {
    var settings = clone(state.settings);
    var equipment = clone(state.equipment);
    var work = clone(state.work);
    assertVersion(settings, "Settings");
    assertVersion(equipment, "Equipment");
    assertVersion(work, "Work orders");
    var actor = state.actor;
    requireActor(actor);
    var files = [];
    var message = "";

    function touch(file) {
      if (files.indexOf(file) === -1) files.push(file);
    }

    if (op.type === "addPerson" || op.type === "updateDisplayName") {
      var displayName = String(op.displayName || actor.displayName || actorTag(actor)).trim() || actorTag(actor);
      var existing = findPerson(settings, actor.id);
      if (existing) {
        existing.displayName = displayName;
        message = commitMessage(actor, "Update display name");
      } else if (op.type === "updateDisplayName") {
        throw new Error("Sign in before changing your name.");
      } else if (settings.people.length >= 2) {
        throw new Error("Only two people can use this app.");
      } else {
        settings.people.push({
          id: actor.id,
          githubLogin: actor.githubLogin || "",
          email: actor.email || "",
          displayName: displayName,
          canCreate: settings.people.length === 0
        });
        message = commitMessage(actor, "Add person");
      }
      touch("data/settings.json");
    } else if (op.type === "setCreateAccess") {
      assertCanManageAccess(settings, actor);
      var accessPerson = findPerson(settings, op.personId);
      if (!accessPerson) throw new Error("Choose a person.");
      var allow = !!op.canCreate;
      if (!allow) {
        var still = settings.people.some(function (person) {
          return person.id !== accessPerson.id && person.canCreate !== false;
        });
        if (!still) throw new Error("Someone has to be able to create.");
      }
      accessPerson.canCreate = allow;
      touch("data/settings.json");
      message = commitMessage(actor, (allow ? "Allow " : "Limit ") + accessPerson.displayName);
    } else if (op.type === "createEquipment") {
      var equipmentId = String(op.id || "").trim();
      if (!equipmentId) throw new Error("Enter an equipment ID.");
      if (equipmentId.length > 40) throw new Error("Equipment ID is too long.");
      if (/[\\/]/.test(equipmentId)) throw new Error("Equipment ID cannot contain a slash.");
      if (findEquipment(equipment, equipmentId)) throw new Error("That equipment ID already exists.");
      var equipmentName = String(op.name || "").trim();
      if (!equipmentName) throw new Error("Enter a name for the equipment.");
      equipment.equipment.push({
        id: equipmentId,
        name: equipmentName,
        notes: String(op.notes || "").trim(),
        tags: parseTags(op.tags),
        status: "active",
        retiredAt: null,
        retiredNote: "",
        log: []
      });
      touch("data/equipment.json");
      message = commitMessage(actor, "Add equipment " + equipmentId);
    } else if (op.type === "updateEquipment") {
      var current = findEquipment(equipment, op.id);
      if (!current) throw new Error("Equipment was not found.");
      var nextName = String(op.name || "").trim();
      if (!nextName) throw new Error("Enter a name for the equipment.");
      current.name = nextName;
      current.notes = String(op.notes || "").trim();
      current.tags = parseTags(op.tags);
      touch("data/equipment.json");
      message = commitMessage(actor, "Update equipment " + current.id);
    } else if (op.type === "renameEquipment") {
      var target = findEquipment(equipment, op.fromId);
      if (!target) throw new Error("Equipment was not found.");
      var toId = String(op.toId || "").trim();
      if (!toId) throw new Error("Enter the new equipment ID.");
      if (toId.length > 40) throw new Error("Equipment ID is too long.");
      if (/[\\/]/.test(toId)) throw new Error("Equipment ID cannot contain a slash.");
      var clash = findEquipment(equipment, toId);
      if (clash && clash !== target) throw new Error("That equipment ID already exists.");
      var fromId = target.id;
      if (fromId === toId) throw new Error("That is already the equipment ID.");
      target.id = toId;
      target.log.push(logLine(actor, "rename", { from: fromId, to: toId }));
      work.orders.forEach(function (order) {
        order.equipmentIds = order.equipmentIds.map(function (id) {
          return id === fromId ? toId : id;
        });
      });
      touch("data/equipment.json");
      touch("data/work.json");
      message = commitMessage(actor, "Rename " + fromId + " to " + toId);
    } else if (op.type === "retireEquipment") {
      var retiring = findEquipment(equipment, op.id);
      if (!retiring) throw new Error("Equipment was not found.");
      if (retiring.status === "retired") throw new Error("That equipment is already retired.");
      var note = String(op.note || "").trim();
      retiring.status = "retired";
      retiring.retiredAt = nowIso();
      retiring.retiredNote = note;
      retiring.log.push(logLine(actor, "retire", { text: note }));
      touch("data/equipment.json");
      message = commitMessage(actor, "Retire " + retiring.id);
    } else if (op.type === "reactivateEquipment") {
      var waking = findEquipment(equipment, op.id);
      if (!waking) throw new Error("Equipment was not found.");
      if (waking.status !== "retired") throw new Error("That equipment is already active.");
      waking.status = "active";
      waking.retiredAt = null;
      waking.retiredNote = "";
      waking.log.push(logLine(actor, "reactivate"));
      touch("data/equipment.json");
      message = commitMessage(actor, "Reactivate " + waking.id);
    } else if (op.type === "createOrder") {
      assertCanCreate(settings, actor);
      var created = buildOrderFields(op, settings, equipment, null);
      var orderId = nextNumberedId("WO", work.orders.map(function (order) { return order.id; }));
      var createdAt = nowIso();
      var order = {
        id: orderId,
        title: created.title,
        location: created.location,
        description: created.description,
        priority: created.priority,
        assignee: created.assignee,
        status: "new",
        dueDate: created.dueDate,
        tags: created.tags,
        equipmentIds: created.equipmentIds,
        attachmentIds: [],
        notes: [],
        steps: [],
        followers: [],
        purchases: [],
        repeat: created.repeat,
        fromId: "",
        nextId: "",
        log: [logLine(actor, "created")],
        createdAt: createdAt,
        completedAt: null
      };
      if (created.assignee) order.log.push(logLine(actor, "assigned", { from: "", to: created.assignee }));
      settings.people.forEach(function (person) {
        if (person.id !== ownerId(order)) addFollower(order, actor, person.id);
      });
      work.orders.push(order);
      touch("data/work.json");
      message = commitMessage(actor, "Add " + orderId);
    } else if (op.type === "updateOrder") {
      var editing = findOrder(work, op.id);
      if (!editing) throw new Error("Work order was not found.");
      assertCanEdit(actor, editing);
      var fields = buildOrderFields(op, settings, equipment, editing);
      editing.title = fields.title;
      editing.location = fields.location;
      editing.description = fields.description;
      editing.priority = fields.priority;
      editing.dueDate = fields.dueDate;
      editing.tags = fields.tags;
      editing.equipmentIds = fields.equipmentIds;
      editing.repeat = fields.repeat;
      touch("data/work.json");
      message = commitMessage(actor, "Update " + editing.id);
    } else if (op.type === "addNote") {
      var noted = findOrder(work, op.orderId);
      if (!noted) throw new Error("Work order was not found.");
      assertCanNote(actor);
      var noteText = String(op.text || "").trim();
      if (!noteText) throw new Error("Enter a note.");
      noted.notes.push({ at: nowIso(), by: actor.id, text: noteText });
      mentionedIds(noteText, settings).forEach(function (personId) {
        addFollower(noted, actor, personId);
      });
      touch("data/work.json");
      message = commitMessage(actor, "Note on " + noted.id);
    } else if (op.type === "setFollower") {
      var followedOrder = findOrder(work, op.orderId);
      if (!followedOrder) throw new Error("Work order was not found.");
      var personId = op.personId || "";
      if (!findPerson(settings, personId)) throw new Error("Choose a person.");
      var adding = !!op.following;
      var ownerHere = canEditOrder(actor, followedOrder);
      if (!ownerHere && !(actor.id === personId && !adding)) throw new Error("Only the owner can change followers.");
      if (personId === ownerId(followedOrder)) throw new Error("The owner is already on this order.");
      var changed = adding ? addFollower(followedOrder, actor, personId) : removeFollower(followedOrder, actor, personId);
      if (changed) {
        touch("data/work.json");
        message = commitMessage(actor, (adding ? "Follow " : "Unfollow ") + followedOrder.id);
      }
    } else if (op.type === "addStep") {
      var stepOrder = findOrder(work, op.orderId);
      if (!stepOrder) throw new Error("Work order was not found.");
      assertCanEdit(actor, stepOrder);
      var stepText = String(op.text || "").trim().replace(/\s+/g, " ");
      if (!stepText) throw new Error("Enter a step.");
      if (stepText.length > 200) throw new Error("That step is too long.");
      var steps = orderSteps(stepOrder);
      var stepAssignee = op.assignee || "";
      if (stepAssignee && !findPerson(settings, stepAssignee)) throw new Error("Choose a person to assign.");
      var stepId = nextNumberedId("S", steps.map(function (step) { return step.id; }));
      steps.push({
        id: stepId,
        text: stepText,
        assignee: stepAssignee,
        done: false,
        doneAt: null,
        doneBy: ""
      });
      if (stepAssignee) {
        stepOrder.log.push(logLine(actor, "step-assigned", { to: stepAssignee, text: stepText }));
      }
      touch("data/work.json");
      message = commitMessage(actor, "Add step on " + stepOrder.id);
    } else if (op.type === "toggleStep") {
      var toggleOrder = findOrder(work, op.orderId);
      if (!toggleOrder) throw new Error("Work order was not found.");
      var step = orderSteps(toggleOrder).find(function (item) { return item.id === op.stepId; });
      if (!step) throw new Error("That step was not found.");
      assertCanCompleteStep(actor, toggleOrder, step);
      step.done = !step.done;
      step.doneAt = step.done ? nowIso() : null;
      step.doneBy = step.done ? actor.id : "";
      touch("data/work.json");
      message = commitMessage(actor, (step.done ? "Finish step on " : "Reopen step on ") + toggleOrder.id);
    } else if (op.type === "removeStep") {
      var stepHost = findOrder(work, op.orderId);
      if (!stepHost) throw new Error("Work order was not found.");
      assertCanEdit(actor, stepHost);
      var remaining = orderSteps(stepHost).filter(function (item) { return item.id !== op.stepId; });
      if (remaining.length === stepHost.steps.length) throw new Error("That step was not found.");
      stepHost.steps = remaining;
      touch("data/work.json");
      message = commitMessage(actor, "Remove step on " + stepHost.id);
    } else if (op.type === "setStepAssignee") {
      var stepAssignOrder = findOrder(work, op.orderId);
      if (!stepAssignOrder) throw new Error("Work order was not found.");
      var assignedStep = orderSteps(stepAssignOrder).find(function (item) { return item.id === op.stepId; });
      if (!assignedStep) throw new Error("That step was not found.");
      assertCanEdit(actor, stepAssignOrder);
      var nextAssignee = op.assignee || "";
      if (nextAssignee && !findPerson(settings, nextAssignee)) throw new Error("Choose a person to assign.");
      var previousAssignee = assignedStep.assignee || "";
      if (previousAssignee !== nextAssignee) {
        assignedStep.assignee = nextAssignee;
        stepAssignOrder.log.push(logLine(actor, "step-assigned", { from: previousAssignee, to: nextAssignee, text: assignedStep.text }));
        touch("data/work.json");
        message = commitMessage(actor, "Assign step on " + stepAssignOrder.id);
      }
    } else if (op.type === "setAssignee") {
      var assignedOrder = findOrder(work, op.orderId);
      if (!assignedOrder) throw new Error("Work order was not found.");
      assertCanEdit(actor, assignedOrder);
      var assignee = op.assignee || "";
      if (assignee && !findPerson(settings, assignee)) throw new Error("Choose a person to assign.");
      if (assignedOrder.assignee !== assignee) {
        var previous = assignedOrder.assignee;
        assignedOrder.assignee = assignee;
        assignedOrder.log.push(logLine(actor, "assigned", { from: previous, to: assignee }));
        removeFollower(assignedOrder, actor, ownerId(assignedOrder));
        if (previous) addFollower(assignedOrder, actor, previous);
        touch("data/work.json");
        message = commitMessage(actor, "Assign " + assignedOrder.id);
      }
    } else if (op.type === "setStatus") {
      var statusOrder = findOrder(work, op.orderId);
      if (!statusOrder) throw new Error("Work order was not found.");
      if (STATUSES.indexOf(op.status) === -1) throw new Error("Choose a status.");
      var reason = String(op.text || "").trim();
      if (NEEDS_TEXT.indexOf(op.status) !== -1 && !reason) throw new Error("Enter a reason.");
      var previousStatus = statusOrder.status;
      statusOrder.status = op.status;
      statusOrder.completedAt = op.status === "done" ? nowIso() : null;
      if (reason) statusOrder.notes.push({ at: nowIso(), by: actor.id, text: reason });
      statusOrder.log.push(logLine(actor, "status", { from: previousStatus, to: op.status, text: reason }));
      if (op.status === "done" && previousStatus !== "done" && statusOrder.repeat && !statusOrder.nextId) {
        spawnNextOrder(work, equipment, actor, statusOrder);
      }
      touch("data/work.json");
      message = commitMessage(actor, "Set " + statusOrder.id + " " + op.status);
    } else if (op.type === "addAttachment") {
      var host = findOrder(work, op.orderId);
      if (!host) throw new Error("Work order was not found.");
      var filename = String(op.filename || "").trim();
      if (!filename) throw new Error("Choose a file.");
      var attachmentId = nextNumberedId("ATT", work.attachments.map(function (item) { return item.id; }));
      var path = "attachments/" + attachmentId + "/" + safeFilename(filename);
      work.attachments.push({
        id: attachmentId,
        workOrderId: host.id,
        kind: op.kind === "image" ? "image" : "document",
        filename: filename,
        path: path,
        contentType: op.contentType || "application/octet-stream",
        byteSize: op.byteSize || 0,
        sha: op.sha || "",
        by: actor.id,
        createdAt: nowIso(),
        removedAt: null
      });
      host.attachmentIds.push(attachmentId);
      host.log.push(logLine(actor, "attachment", { text: filename, to: attachmentId }));
      touch("data/work.json");
      message = commitMessage(actor, "Attach " + attachmentId + " to " + host.id);
    } else if (op.type === "unlinkAttachment") {
      var attachment = findAttachment(work, op.attachmentId);
      if (!attachment) throw new Error("Attachment was not found.");
      if (attachment.removedAt) throw new Error("That file is already removed from the order.");
      attachment.removedAt = nowIso();
      var owner = findOrder(work, attachment.workOrderId);
      if (owner) assertCanEdit(actor, owner);
      if (owner) owner.log.push(logLine(actor, "unlinked", { text: attachment.filename, to: attachment.id }));
      touch("data/work.json");
      message = commitMessage(actor, "Unlink " + attachment.id);
    } else if (op.type === "createBudget") {
      assertCanCreate(settings, actor);
      if (!Array.isArray(settings.budgets)) settings.budgets = [];
      var built = buildBudget(op, settings, null);
      var budgetId = nextNumberedId("BD", settings.budgets.map(function (item) { return item.id; }));
      settings.budgets.push({
        id: budgetId,
        name: built.name,
        totalCents: built.totalCents,
        starts: built.starts,
        ends: built.ends,
        codes: built.codes
      });
      touch("data/settings.json");
      message = commitMessage(actor, "Add budget " + built.name);
    } else if (op.type === "updateBudget") {
      assertCanCreate(settings, actor);
      if (!Array.isArray(settings.budgets)) settings.budgets = [];
      var currentBudget = findBudget(settings, op.id);
      if (!currentBudget) throw new Error("That budget was not found.");
      var revised = buildBudget(op, settings, currentBudget);
      codesOf(currentBudget).forEach(function (code) {
        var still = revised.codes.some(function (item) { return item.id === code.id; });
        if (still) return;
        var usedCode = (work.orders || []).some(function (order) { return orderUsesCode(order, code.id); });
        if (usedCode) throw new Error("A work order still uses " + code.code + ".");
      });
      currentBudget.name = revised.name;
      currentBudget.totalCents = revised.totalCents;
      currentBudget.starts = revised.starts;
      currentBudget.ends = revised.ends;
      currentBudget.codes = revised.codes;
      touch("data/settings.json");
      message = commitMessage(actor, "Update budget " + revised.name);
    } else if (op.type === "removeBudget") {
      assertCanCreate(settings, actor);
      var removing = findBudget(settings, op.id);
      if (!removing) throw new Error("That budget was not found.");
      var used = (work.orders || []).some(function (order) {
        return codesOf(removing).some(function (code) { return orderUsesCode(order, code.id); });
      });
      if (used) throw new Error("A work order still uses a billing code in this budget.");
      settings.budgets = budgetsOf(settings).filter(function (item) { return item.id !== removing.id; });
      touch("data/settings.json");
      message = commitMessage(actor, "Remove budget " + removing.name);
    } else if (op.type === "addPurchase") {
      var purchaseOrder = findOrder(work, op.orderId);
      if (!purchaseOrder) throw new Error("Work order was not found.");
      var codeId = String(op.budgetId || "").trim();
      var chosen = findCode(settings, codeId);
      if (!chosen) throw new Error("Choose a billing code.");
      var purchaseCents = parseMoney(op.cost);
      if (purchaseCents == null || purchaseCents <= 0) throw new Error("Enter a cost.");
      if (!Array.isArray(purchaseOrder.purchases)) purchaseOrder.purchases = [];
      if (purchaseOrder.costCents != null && purchaseOrder.budgetId) {
        purchaseOrder.purchases.push({
          id: nextNumberedId("P", purchaseOrder.purchases.map(function (item) { return item.id; })),
          codeId: purchaseOrder.budgetId,
          costCents: purchaseOrder.costCents,
          at: purchaseOrder.createdAt || nowIso(),
          by: ""
        });
        purchaseOrder.costCents = null;
        purchaseOrder.budgetId = "";
      }
      var purchaseId = nextNumberedId("P", purchaseOrder.purchases.map(function (item) { return item.id; }));
      purchaseOrder.purchases.push({
        id: purchaseId,
        codeId: codeId,
        costCents: purchaseCents,
        at: nowIso(),
        by: actor.id
      });
      purchaseOrder.log.push(logLine(actor, "purchase", { text: chosen.code.code, to: formatMoney(purchaseCents) }));
      touch("data/work.json");
      message = commitMessage(actor, "Add purchase on " + purchaseOrder.id);
    } else if (op.type === "removePurchase") {
      var purchaseHost = findOrder(work, op.orderId);
      if (!purchaseHost) throw new Error("Work order was not found.");
      if (!Array.isArray(purchaseHost.purchases)) purchaseHost.purchases = [];
      if (op.purchaseId === "legacy" && purchaseHost.costCents != null) {
        purchaseHost.log.push(logLine(actor, "purchase-removed", { text: purchaseHost.budgetId, to: formatMoney(purchaseHost.costCents) }));
        purchaseHost.costCents = null;
        purchaseHost.budgetId = "";
      } else {
        var dropping = purchaseHost.purchases.find(function (item) { return item.id === op.purchaseId; });
        if (!dropping) throw new Error("That purchase was not found.");
        purchaseHost.purchases = purchaseHost.purchases.filter(function (item) { return item.id !== dropping.id; });
        var droppedCode = findCode(settings, dropping.codeId);
        purchaseHost.log.push(logLine(actor, "purchase-removed", {
          text: droppedCode ? droppedCode.code.code : dropping.codeId,
          to: formatMoney(dropping.costCents)
        }));
      }
      touch("data/work.json");
      message = commitMessage(actor, "Remove purchase on " + purchaseHost.id);
    } else {
      throw new Error("Unknown save.");
    }

    return { settings: settings, equipment: equipment, work: work, files: files, message: message };
  }

  function buildOrderFields(op, settings, equipment, existing) {
    var title = String(op.title || "").trim();
    var location = String(op.location || "").trim();
    var description = String(op.description || "").trim();
    if (!title) throw new Error("Enter a title.");
    if (!location) throw new Error("Enter a location.");
    if (!description) throw new Error("Enter a description.");
    var priority = op.priority || "normal";
    if (PRIORITIES.indexOf(priority) === -1) throw new Error("Choose a priority.");
    var dueDate = String(op.dueDate || "").trim();
    if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw new Error("Use a real due date.");
    var assignee = existing ? existing.assignee : (op.assignee || "");
    if (!existing) {
      if (assignee && !findPerson(settings, assignee)) throw new Error("Choose a person to assign.");
    }
    var equipmentIds = uniqueIds(op.equipmentIds).map(function (id) {
      var item = findEquipment(equipment, id);
      if (!item) throw new Error("Equipment " + id + " was not found.");
      var already = existing && existing.equipmentIds.some(function (linked) {
        return keyOf(linked) === keyOf(item.id);
      });
      if (!already && item.status !== "active") {
        throw new Error(item.id + " is retired and cannot be added to new work.");
      }
      return item.id;
    });
    return {
      title: title,
      location: location,
      description: description,
      priority: priority,
      dueDate: dueDate,
      assignee: assignee,
      tags: parseTags(op.tags),
      equipmentIds: equipmentIds,
      repeat: repeatOf(op.repeat)
    };
  }

  function isOpenStatus(status) {
    return OPEN.indexOf(status) !== -1;
  }

  function sortOrders(orders, today) {
    var priorityRank = { high: 0, normal: 1, low: 2 };
    return orders.slice().sort(function (a, b) {
      function rank(order) {
        var overdue = isOpenStatus(order.status) && order.dueDate && order.dueDate < today ? 0 : 1;
        var dated = order.dueDate ? 0 : 1;
        return [overdue, dated, order.dueDate || "9999-99-99", priorityRank[order.priority] == null ? 1 : priorityRank[order.priority]];
      }
      var left = rank(a);
      var right = rank(b);
      for (var i = 0; i < left.length; i++) {
        if (left[i] < right[i]) return -1;
        if (left[i] > right[i]) return 1;
      }
      if (a.createdAt === b.createdAt) return 0;
      return a.createdAt < b.createdAt ? 1 : -1;
    });
  }

  function weekEnd(todayStamp) {
    var parts = todayStamp.split("-").map(Number);
    var date = new Date(parts[0], parts[1] - 1, parts[2]);
    return addDays(todayStamp, 6 - date.getDay());
  }

  function taskGroups(orders, todayStamp) {
    var saturday = weekEnd(todayStamp);
    var recentStart = addDays(todayStamp, -14);
    var groups = { today: [], week: [], upcoming: [], recent: [] };
    (orders || []).forEach(function (order) {
      if (order.status === "done" && order.completedAt) {
        var finished = localDate(order.completedAt);
        if (finished >= recentStart && finished <= todayStamp) groups.recent.push(order);
        return;
      }
      if (!isOpenStatus(order.status)) return;
      if (order.dueDate && order.dueDate > todayStamp && order.dueDate <= saturday) groups.week.push(order);
      else if (!order.dueDate || order.dueDate > saturday) groups.upcoming.push(order);
      else groups.today.push(order);
    });
    groups.today = sortOrders(groups.today, todayStamp);
    groups.week = sortOrders(groups.week, todayStamp);
    groups.upcoming = sortOrders(groups.upcoming, todayStamp);
    groups.recent.sort(function (a, b) {
      if (a.completedAt === b.completedAt) return 0;
      return a.completedAt < b.completedAt ? 1 : -1;
    });
    return groups;
  }

  function ordersForDay(orders, day, todayStamp) {
    return sortOrders((orders || []).filter(function (order) {
      if (!isOpenStatus(order.status) || !order.dueDate) return false;
      if (order.dueDate === day) return true;
      return day === todayStamp && order.dueDate < todayStamp;
    }), todayStamp);
  }

  function orderHaystack(order, equipmentDoc, settings) {
    var equipmentText = (order.equipmentIds || []).map(function (id) {
      var item = findEquipment(equipmentDoc, id);
      return item ? item.id + " " + item.name : id;
    }).join(" ");
    var person = findPerson(settings, order.assignee);
    var notes = (order.notes || []).map(function (note) { return note.text; }).join(" ");
    var purchaseText = orderPurchases(order).map(function (purchase) {
      var found = findCode(settings, purchase.codeId);
      return (found ? found.code.code + " " + found.budget.name : purchase.codeId) + " " + formatMoney(purchase.costCents);
    }).join(" ");
    return [
      order.id,
      order.fromId || "",
      order.nextId || "",
      order.title,
      order.location,
      order.description,
      notes,
      (order.steps || []).map(function (step) {
        var owner = findPerson(settings, step.assignee);
        return step.text + (owner ? " " + owner.displayName : "");
      }).join(" "),
      (order.tags || []).join(" "),
      equipmentText,
      person ? person.displayName + " " + (person.githubLogin || "") + " " + (person.email || "") : "",
      purchaseText,
      order.costCents == null ? "" : formatMoney(order.costCents),
      (order.followers || []).map(function (id) {
        var follower = findPerson(settings, id);
        return follower ? follower.displayName : id;
      }).join(" ")
    ].join(" ").toLowerCase();
  }

  function searchAll(query, settings, equipmentDoc, workDoc) {
    var needle = String(query || "").trim().toLowerCase();
    if (!needle) return { orders: [], equipment: [] };
    return {
      orders: workDoc.orders.filter(function (order) {
        return orderHaystack(order, equipmentDoc, settings).indexOf(needle) !== -1;
      }),
      equipment: equipmentDoc.equipment.filter(function (item) {
        return [item.id, item.name, item.notes, (item.tags || []).join(" "), item.status, item.retiredNote]
          .join(" ").toLowerCase().indexOf(needle) !== -1;
      }),
      budgets: budgetsOf(settings).filter(function (budget) {
        var text = [budget.name].concat(codesOf(budget).map(function (code) { return code.code; }));
        return text.join(" ").toLowerCase().indexOf(needle) !== -1;
      })
    };
  }

  function openOrderCount(work, equipmentId) {
    var key = keyOf(equipmentId);
    return work.orders.filter(function (order) {
      return isOpenStatus(order.status) && (order.equipmentIds || []).some(function (id) { return keyOf(id) === key; });
    }).length;
  }

  function displayName(settings, id) {
    if (!id) return "Unassigned";
    var person = findPerson(settings, id);
    return person ? person.displayName : id;
  }

  function linkedAttachments(work, order) {
    return (order.attachmentIds || []).map(function (id) {
      return findAttachment(work, id);
    }).filter(function (item) { return item && !item.removedAt; });
  }

  return {
    OPEN: OPEN,
    STATUSES: STATUSES,
    PRIORITIES: PRIORITIES,
    REPEATS: REPEATS,
    nextDueDate: nextDueDate,
    personId: personId,
    emptySettings: emptySettings,
    emptyEquipment: emptyEquipment,
    emptyWork: emptyWork,
    apply: apply,
    nextNumberedId: nextNumberedId,
    safeFilename: safeFilename,
    parseTags: parseTags,
    isOpenStatus: isOpenStatus,
    sortOrders: sortOrders,
    taskGroups: taskGroups,
    ordersForDay: ordersForDay,
    searchAll: searchAll,
    openOrderCount: openOrderCount,
    displayName: displayName,
    linkedAttachments: linkedAttachments,
    findEquipment: findEquipment,
    findOrder: findOrder,
    ownerId: ownerId,
    canEditOrder: canEditOrder,
    canAddNote: canAddNote,
    personCanCreate: personCanCreate,
    canManageAccess: canManageAccess,
    accessManagerId: ACCESS_MANAGER_ID,
    canCompleteStep: canCompleteStep,
    findPerson: findPerson,
    findAttachment: findAttachment,
    findBudget: findBudget,
    findCode: findCode,
    parseMoney: parseMoney,
    formatMoney: formatMoney,
    spentCents: spentCents,
    budgetSpentCents: budgetSpentCents,
    orderPurchases: orderPurchases,
    budgetNotices: budgetNotices
  };
});
