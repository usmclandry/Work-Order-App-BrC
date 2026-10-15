(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.JobModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var OPEN = ["new", "in_progress", "waiting"];
  var STATUSES = ["new", "in_progress", "waiting", "done", "canceled"];
  var PRIORITIES = ["low", "normal", "high"];
  var NEEDS_TEXT = ["waiting", "done", "canceled"];

  function personId(login) {
    return "github:" + String(login || "").trim();
  }

  function emptySettings() {
    return { version: 1, people: [] };
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

  function requireActor(actor) {
    if (!actor || !actor.id || !actor.githubLogin) throw new Error("Sign in before saving.");
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

  function findAttachment(doc, id) {
    return doc.attachments.find(function (item) { return item.id === id; });
  }

  function commitMessage(actor, text) {
    return text + " by " + actor.githubLogin;
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
      var displayName = String(op.displayName || actor.displayName || actor.githubLogin).trim() || actor.githubLogin;
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
          githubLogin: actor.githubLogin,
          displayName: displayName
        });
        message = commitMessage(actor, "Add person");
      }
      touch("data/settings.json");
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
        log: [logLine(actor, "created")],
        createdAt: createdAt,
        completedAt: null
      };
      if (created.assignee) order.log.push(logLine(actor, "assigned", { from: "", to: created.assignee }));
      work.orders.push(order);
      touch("data/work.json");
      message = commitMessage(actor, "Add " + orderId);
    } else if (op.type === "updateOrder") {
      var editing = findOrder(work, op.id);
      if (!editing) throw new Error("Work order was not found.");
      var fields = buildOrderFields(op, settings, equipment, editing);
      editing.title = fields.title;
      editing.location = fields.location;
      editing.description = fields.description;
      editing.priority = fields.priority;
      editing.dueDate = fields.dueDate;
      editing.tags = fields.tags;
      editing.equipmentIds = fields.equipmentIds;
      touch("data/work.json");
      message = commitMessage(actor, "Update " + editing.id);
    } else if (op.type === "addNote") {
      var noted = findOrder(work, op.orderId);
      if (!noted) throw new Error("Work order was not found.");
      var noteText = String(op.text || "").trim();
      if (!noteText) throw new Error("Enter a note.");
      noted.notes.push({ at: nowIso(), by: actor.id, text: noteText });
      touch("data/work.json");
      message = commitMessage(actor, "Note on " + noted.id);
    } else if (op.type === "setAssignee") {
      var assignedOrder = findOrder(work, op.orderId);
      if (!assignedOrder) throw new Error("Work order was not found.");
      var assignee = op.assignee || "";
      if (assignee && !findPerson(settings, assignee)) throw new Error("Choose a person to assign.");
      if (assignedOrder.assignee !== assignee) {
        var previous = assignedOrder.assignee;
        assignedOrder.assignee = assignee;
        assignedOrder.log.push(logLine(actor, "assigned", { from: previous, to: assignee }));
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
      if (owner) owner.log.push(logLine(actor, "unlinked", { text: attachment.filename, to: attachment.id }));
      touch("data/work.json");
      message = commitMessage(actor, "Unlink " + attachment.id);
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
      equipmentIds: equipmentIds
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

  function orderHaystack(order, equipmentDoc, settings) {
    var equipmentText = (order.equipmentIds || []).map(function (id) {
      var item = findEquipment(equipmentDoc, id);
      return item ? item.id + " " + item.name : id;
    }).join(" ");
    var person = findPerson(settings, order.assignee);
    var notes = (order.notes || []).map(function (note) { return note.text; }).join(" ");
    return [
      order.id,
      order.title,
      order.location,
      order.description,
      notes,
      (order.tags || []).join(" "),
      equipmentText,
      person ? person.displayName + " " + person.githubLogin : ""
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
    searchAll: searchAll,
    openOrderCount: openOrderCount,
    displayName: displayName,
    linkedAttachments: linkedAttachments,
    findEquipment: findEquipment,
    findOrder: findOrder,
    findPerson: findPerson,
    findAttachment: findAttachment
  };
});
