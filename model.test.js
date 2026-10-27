const test = require("node:test");
const assert = require("node:assert/strict");
const Model = require("./model.js");

function actor(login, name) {
  return { id: Model.personId(login), githubLogin: login, displayName: name || login };
}

function apply(current, op) {
  const result = Model.apply(current, op);
  result.actor = current.actor;
  return result;
}

function withPerson(current, person) {
  const added = apply(Object.assign({}, current, { actor: person }), { type: "addPerson", displayName: person.displayName });
  added.actor = person;
  return added;
}

function seed() {
  let current = withPerson({
    actor: actor("alex", "Alex"),
    settings: Model.emptySettings(),
    equipment: Model.emptyEquipment(),
    work: Model.emptyWork()
  }, actor("alex", "Alex"));
  current = withPerson(current, actor("jordan", "Jordan"));
  current.actor = actor("alex", "Alex");
  current = apply(current, {
    type: "createEquipment",
    id: "EQ-14",
    name: "Skid steer",
    notes: "Yard",
    tags: "rental, Hydraulic"
  });
  current = apply(current, {
    type: "createOrder",
    title: "Replace hose",
    location: "Bay 2",
    description: "Hydraulic hose is leaking.",
    priority: "high",
    assignee: "github:alex",
    dueDate: "2026-10-01",
    tags: "hydraulic",
    equipmentIds: ["eq-14"]
  });
  return current;
}

test("ten people can join and an eleventh cannot", function () {
  let current = {
    actor: actor("person1", "Person 1"),
    settings: Model.emptySettings(),
    equipment: Model.emptyEquipment(),
    work: Model.emptyWork()
  };
  for (let n = 1; n <= 10; n++) {
    current = withPerson(current, actor("person" + n, "Person " + n));
  }
  assert.equal(current.settings.people.length, 10);
  assert.equal(current.settings.people[0].canCreate, true);
  assert.equal(current.settings.people[1].canCreate, true);
  assert.equal(current.settings.people[1].canManageAccess, true);
  assert.equal(current.settings.people[2].canCreate, false);
  current.actor = actor("person11", "Person 11");
  assert.throws(function () {
    apply(current, { type: "addPerson", displayName: "Person 11" });
  }, /Only 10 people/);
});

test("creates an order stamped by the signed-in person and links equipment", function () {
  const current = seed();
  const order = current.work.orders[0];
  assert.equal(order.id, "WO-001");
  assert.equal(order.equipmentIds[0], "EQ-14");
  assert.equal(order.log[0].by, "github:alex");
  assert.equal(order.log[0].type, "created");
  assert.equal(order.log[1].type, "assigned");
  assert.equal(order.log[1].to, "github:alex");
  assert.equal(order.tags[0], "hydraulic");
  assert.equal(current.equipment.equipment[0].tags[1], "Hydraulic");
  assert.equal(current.message, "Add WO-001 by alex");
});

test("equipment ids ignore case", function () {
  const current = seed();
  assert.throws(function () {
    apply(current, { type: "createEquipment", id: "eq-14", name: "Duplicate" });
  }, /already exists/);
});

test("retired equipment stays on old orders and leaves new work", function () {
  let current = seed();
  current = apply(current, { type: "retireEquipment", id: "EQ-14", note: "Sold" });
  const item = current.equipment.equipment[0];
  assert.equal(item.status, "retired");
  assert.equal(item.retiredNote, "Sold");
  assert.equal(item.log[0].type, "retire");
  assert.equal(item.log[0].by, "github:alex");
  current = apply(current, {
    type: "updateOrder",
    id: "WO-001",
    title: "Replace hose",
    location: "Bay 2",
    description: "Still finishing the old job.",
    priority: "high",
    dueDate: "2026-10-01",
    tags: "hydraulic",
    equipmentIds: ["EQ-14"]
  });
  assert.deepEqual(current.work.orders[0].equipmentIds, ["EQ-14"]);
  assert.throws(function () {
    apply(current, {
      type: "createOrder",
      title: "Next job",
      location: "Bay 3",
      description: "Should fail.",
      equipmentIds: ["EQ-14"]
    });
  }, /retired/);
});

test("reactivate clears the current retire fields and keeps the log", function () {
  let current = seed();
  current = apply(current, { type: "retireEquipment", id: "EQ-14", note: "Mistake" });
  current = apply(current, { type: "reactivateEquipment", id: "EQ-14" });
  const item = current.equipment.equipment[0];
  assert.equal(item.status, "active");
  assert.equal(item.retiredAt, null);
  assert.equal(item.retiredNote, "");
  assert.equal(item.log.map(function (line) { return line.type; }).join(","), "retire,reactivate");
});

test("rename updates past orders in the same result", function () {
  let current = seed();
  current = apply(current, { type: "renameEquipment", fromId: "EQ-14", toId: "Unit 12" });
  assert.equal(current.equipment.equipment[0].id, "Unit 12");
  assert.deepEqual(current.work.orders[0].equipmentIds, ["Unit 12"]);
  assert.ok(current.files.indexOf("data/equipment.json") !== -1);
  assert.ok(current.files.indexOf("data/work.json") !== -1);
});

test("status changes require a reason and done leaves a completed time", function () {
  let current = seed();
  assert.throws(function () {
    apply(current, { type: "setStatus", orderId: "WO-001", status: "waiting", text: "" });
  }, /reason/);
  assert.throws(function () {
    apply(current, { type: "setStatus", orderId: "WO-001", status: "canceled", text: " " });
  }, /reason/);
  current = apply(current, { type: "setStatus", orderId: "WO-001", status: "done", text: "Hose replaced" });
  const order = current.work.orders[0];
  assert.equal(order.status, "done");
  assert.ok(order.completedAt);
  assert.equal(order.notes[0].text, "Hose replaced");
  assert.equal(order.notes[0].by, "github:alex");
  assert.equal(order.log[order.log.length - 1].type, "status");
});

test("attachment ids are assigned and unlink keeps the record", function () {
  let current = seed();
  current = apply(current, {
    type: "addAttachment",
    orderId: "WO-001",
    filename: "hose.jpg",
    contentType: "image/jpeg",
    byteSize: 10,
    kind: "image"
  });
  const attachment = current.work.attachments[0];
  assert.equal(attachment.id, "ATT-001");
  assert.equal(attachment.path, "attachments/ATT-001/hose.jpg");
  assert.equal(attachment.by, "github:alex");
  assert.equal(Model.linkedAttachments(current.work, current.work.orders[0]).length, 1);
  current = apply(current, { type: "unlinkAttachment", attachmentId: "ATT-001" });
  assert.ok(current.work.attachments[0].removedAt);
  assert.equal(Model.linkedAttachments(current.work, current.work.orders[0]).length, 0);
  assert.equal(current.work.orders[0].log[current.work.orders[0].log.length - 1].type, "unlinked");
});

test("the next work order number advances", function () {
  let current = seed();
  current = apply(current, {
    type: "createOrder",
    title: "Second",
    location: "Yard",
    description: "Check fluids."
  });
  assert.equal(current.work.orders[1].id, "WO-002");
});

test("search finds retired equipment and done orders", function () {
  let current = seed();
  current = apply(current, { type: "setStatus", orderId: "WO-001", status: "done", text: "Hose replaced" });
  current = apply(current, { type: "retireEquipment", id: "EQ-14", note: "Sold" });
  const found = Model.searchAll("sold", current.settings, current.equipment, current.work);
  assert.equal(found.equipment.length, 1);
  const orders = Model.searchAll("hose replaced", current.settings, current.equipment, current.work);
  assert.equal(orders.orders.length, 1);
});

test("open orders sort overdue first and undated last", function () {
  let current = seed();
  current = apply(current, {
    type: "createOrder",
    title: "Later",
    location: "Bay 1",
    description: "Not due yet.",
    dueDate: "2026-12-01",
    priority: "low"
  });
  current = apply(current, {
    type: "createOrder",
    title: "No date",
    location: "Bay 4",
    description: "Whenever.",
    priority: "high"
  });
  const sorted = Model.sortOrders(current.work.orders, "2026-10-15");
  assert.deepEqual(sorted.map(function (order) { return order.title; }), ["Replace hose", "Later", "No date"]);
});

test("steps stay on the order and do not follow its status", function () {
  let current = seed();
  delete current.work.orders[0].steps;
  current = apply(current, { type: "addStep", orderId: "WO-001", text: "  Shut off the water  " });
  current = apply(current, { type: "addStep", orderId: "WO-001", text: "Replace the hose" });
  assert.equal(current.work.orders[0].steps[0].id, "S-001");
  assert.equal(current.work.orders[0].steps[0].text, "Shut off the water");
  assert.equal(current.work.orders[0].steps[0].done, false);
  current = apply(current, { type: "toggleStep", orderId: "WO-001", stepId: "S-001" });
  assert.equal(current.work.orders[0].steps[0].done, true);
  assert.equal(current.work.orders[0].steps[0].doneBy, "github:alex");
  assert.equal(current.work.orders[0].status, "new");
  current = apply(current, { type: "toggleStep", orderId: "WO-001", stepId: "S-001" });
  assert.equal(current.work.orders[0].steps[0].done, false);
  assert.equal(current.work.orders[0].steps[0].doneBy, "");
  current = apply(current, { type: "setStatus", orderId: "WO-001", status: "done", text: "Finished" });
  assert.equal(current.work.orders[0].steps[1].done, false);
  const found = Model.searchAll("replace the hose", current.settings, current.equipment, current.work);
  assert.equal(found.orders.length, 1);
  current = apply(current, { type: "removeStep", orderId: "WO-001", stepId: "S-002" });
  assert.equal(current.work.orders[0].steps.length, 1);
  assert.throws(function () {
    apply(current, { type: "addStep", orderId: "WO-001", text: "   " });
  }, /Enter a step/);
});

test("a step can be assigned without changing the order owner", function () {
  let current = seed();
  current = apply(current, { type: "addStep", orderId: "WO-001", text: "Bleed the line", assignee: "github:alex" });
  assert.equal(current.work.orders[0].steps[0].assignee, "github:alex");
  assert.equal(current.work.orders[0].assignee, "github:alex");
  const found = Model.searchAll("alex", current.settings, current.equipment, current.work);
  assert.equal(found.orders.length, 1);
  current = apply(current, { type: "setStepAssignee", orderId: "WO-001", stepId: "S-001", assignee: "github:jordan" });
  assert.equal(current.work.orders[0].steps[0].assignee, "github:jordan");
  assert.equal(current.work.orders[0].assignee, "github:alex");
  assert.equal(current.work.orders[0].log[current.work.orders[0].log.length - 1].type, "step-assigned");
  assert.equal(current.work.orders[0].log[current.work.orders[0].log.length - 1].from, "github:alex");
  current = apply(current, { type: "setStepAssignee", orderId: "WO-001", stepId: "S-001", assignee: "" });
  assert.equal(current.work.orders[0].steps[0].assignee, "");
  assert.throws(function () {
    apply(current, { type: "setStepAssignee", orderId: "WO-001", stepId: "S-001", assignee: "github:sam" });
  }, /Choose a person/);
});

test("only the owner can edit, and a step assignee can check off that step", function () {
  let current = seed();
  assert.deepEqual(current.work.orders[0].followers, ["github:jordan"]);
  current.actor = actor("jordan", "Jordan");
  current = apply(current, { type: "addNote", orderId: "WO-001", text: "Seen it" });
  assert.equal(current.work.orders[0].notes[0].by, "github:jordan");
  current.actor = actor("alex", "Alex");
  current = apply(current, { type: "addStep", orderId: "WO-001", text: "Bleed the line", assignee: "github:jordan" });
  current = apply(current, { type: "addStep", orderId: "WO-001", text: "Close the valve" });
  current.actor = actor("jordan", "Jordan");
  current = apply(current, { type: "toggleStep", orderId: "WO-001", stepId: "S-001" });
  assert.equal(current.work.orders[0].steps[0].done, true);
  assert.equal(current.work.orders[0].steps[0].doneBy, "github:jordan");
  assert.throws(function () {
    apply(current, { type: "toggleStep", orderId: "WO-001", stepId: "S-002" });
  }, /check off steps assigned to you/);
  current = apply(current, { type: "setStatus", orderId: "WO-001", status: "in_progress", text: "Started" });
  assert.equal(current.work.orders[0].status, "in_progress");
  assert.throws(function () {
    apply(current, { type: "removeStep", orderId: "WO-001", stepId: "S-001" });
  }, /Only the owner/);
  current.actor = actor("alex", "Alex");
  current = apply(current, { type: "setFollower", orderId: "WO-001", personId: "github:jordan", following: false });
  current = apply(current, { type: "setAssignee", orderId: "WO-001", assignee: "" });
  assert.equal(Model.ownerId(current.work.orders[0]), "github:alex");
  assert.deepEqual(current.work.orders[0].followers, []);
  current.actor = actor("jordan", "Jordan");
  current = apply(current, { type: "addNote", orderId: "WO-001", text: "Still no" });
  assert.equal(current.work.orders[0].notes[current.work.orders[0].notes.length - 1].text, "Still no");
});

test("repeating an order copies the work and leaves the notes behind", function () {
  let current = seed();
  current = apply(current, { type: "updateOrder", id: "WO-001", title: "Replace hose", location: "Bay 2", description: "Hydraulic hose is leaking.", priority: "high", dueDate: "2026-10-01", tags: "hydraulic", equipmentIds: ["EQ-14"], repeat: "weekly" });
  current = apply(current, { type: "addStep", orderId: "WO-001", text: "Shut the water off", assignee: "github:jordan" });
  current = apply(current, { type: "toggleStep", orderId: "WO-001", stepId: "S-001" });
  current = apply(current, { type: "addNote", orderId: "WO-001", text: "Waiting on the part" });
  current = apply(current, { type: "addAttachment", orderId: "WO-001", filename: "hose.jpg", kind: "image" });
  current = apply(current, { type: "setStatus", orderId: "WO-001", status: "done", text: "Hose replaced" });
  const finished = current.work.orders[0];
  const next = current.work.orders[1];
  assert.equal(finished.status, "done");
  assert.equal(finished.nextId, "WO-002");
  assert.equal(finished.notes.length, 2);
  assert.equal(finished.attachmentIds.length, 1);
  assert.equal(finished.steps[0].done, true);
  assert.equal(next.id, "WO-002");
  assert.equal(next.status, "new");
  assert.equal(next.fromId, "WO-001");
  assert.equal(next.dueDate, "2026-10-08");
  assert.equal(next.repeat, "weekly");
  assert.equal(next.assignee, "github:alex");
  assert.equal(next.title, "Replace hose");
  assert.equal(next.description, "Hydraulic hose is leaking.");
  assert.deepEqual(next.tags, ["hydraulic"]);
  assert.deepEqual(next.equipmentIds, ["EQ-14"]);
  assert.equal(next.notes.length, 0);
  assert.deepEqual(next.followers, ["github:jordan"]);
  assert.equal(next.attachmentIds.length, 0);
  assert.equal(next.steps.length, 1);
  assert.equal(next.steps[0].id, "S-001");
  assert.equal(next.steps[0].text, "Shut the water off");
  assert.equal(next.steps[0].assignee, "github:jordan");
  assert.equal(next.steps[0].done, false);
  assert.equal(next.log[0].type, "repeated");
  assert.equal(next.log[0].from, "WO-001");
  assert.equal(finished.log[finished.log.length - 1].to, "WO-002");
  current = apply(current, { type: "setStatus", orderId: "WO-001", status: "in_progress" });
  current = apply(current, { type: "setStatus", orderId: "WO-001", status: "done", text: "Done again" });
  assert.equal(current.work.orders.length, 2);
  current = apply(current, { type: "retireEquipment", id: "EQ-14", note: "Sold" });
  current = apply(current, { type: "setStatus", orderId: "WO-002", status: "done", text: "Next week done" });
  assert.equal(current.work.orders[2].id, "WO-003");
  assert.deepEqual(current.work.orders[2].equipmentIds, []);
  assert.equal(current.work.orders[2].dueDate, "2026-10-15");
  current.actor = actor("jordan", "Jordan");
  assert.throws(function () {
    apply(current, { type: "updateOrder", id: "WO-003", title: "Replace hose", location: "Bay 2", description: "Hydraulic hose is leaking.", priority: "high", dueDate: "2026-10-15", repeat: "monthly" });
  }, /Only the owner/);
});

test("a canceled order does not start the next one", function () {
  let current = seed();
  current = apply(current, { type: "updateOrder", id: "WO-001", title: "Replace hose", location: "Bay 2", description: "Hydraulic hose is leaking.", priority: "high", dueDate: "2026-10-01", tags: "hydraulic", equipmentIds: ["EQ-14"], repeat: "monthly" });
  current = apply(current, { type: "setStatus", orderId: "WO-001", status: "canceled", text: "No longer needed" });
  assert.equal(current.work.orders.length, 1);
  assert.equal(current.work.orders[0].nextId, "");
});

test("an order with no due date repeats from the day it is finished", function () {
  let current = seed();
  current = apply(current, {
    type: "createOrder",
    title: "Check the filters",
    location: "Mechanical room",
    description: "Look at the filters.",
    repeat: "weekly"
  });
  current = apply(current, { type: "setStatus", orderId: "WO-002", status: "done", text: "Checked" });
  const finished = current.work.orders[1];
  const next = current.work.orders[2];
  const completedOn = new Date(finished.completedAt);
  const month = String(completedOn.getMonth() + 1).padStart(2, "0");
  const day = String(completedOn.getDate()).padStart(2, "0");
  const stamp = completedOn.getFullYear() + "-" + month + "-" + day;
  assert.equal(next.dueDate, Model.nextDueDate("", "weekly", stamp));
  assert.equal(Model.ownerId(next), "github:alex");
});

test("the next due date keeps the schedule", function () {
  assert.equal(Model.nextDueDate("2026-10-01", "biweekly", "2026-10-20"), "2026-10-15");
  assert.equal(Model.nextDueDate("2026-01-31", "monthly", "2026-02-02"), "2026-02-28");
  assert.equal(Model.nextDueDate("2026-03-31", "monthly", "2026-04-01"), "2026-04-30");
  assert.equal(Model.nextDueDate("2024-01-31", "monthly", "2024-02-01"), "2024-02-29");
  assert.equal(Model.nextDueDate("2026-12-15", "monthly", "2026-12-15"), "2027-01-15");
  assert.equal(Model.nextDueDate("2026-01-31", "quarterly", "2026-02-01"), "2026-04-30");
  assert.equal(Model.nextDueDate("2026-01-15", "semiannual", "2026-01-15"), "2026-07-15");
  assert.equal(Model.nextDueDate("2026-08-31", "semiannual", "2026-09-01"), "2027-02-28");
  assert.equal(Model.nextDueDate("2024-02-29", "annual", "2024-03-01"), "2025-02-28");
  assert.equal(Model.nextDueDate("2026-10-21", "annual", "2026-10-21"), "2027-10-21");
  assert.throws(function () {
    apply(seed(), {
      type: "createOrder",
      title: "Bad",
      location: "Bay",
      description: "Nope.",
      repeat: "daily"
    });
  }, /how often/);
});

test("my tasks group into today, this week, upcoming, and recent", function () {
  const orders = [
    { id: "late", status: "new", dueDate: "2026-10-10", priority: "low", createdAt: "2026-10-01" },
    { id: "today", status: "waiting", dueDate: "2026-10-16", priority: "normal", createdAt: "2026-10-02" },
    { id: "morrow", status: "new", dueDate: "2026-10-17", priority: "high", createdAt: "2026-10-03" },
    { id: "soon", status: "in_progress", dueDate: "2026-10-21", priority: "high", createdAt: "2026-10-04" },
    { id: "none", status: "new", dueDate: "", priority: "low", createdAt: "2026-10-05" },
    { id: "finished", status: "done", dueDate: "2026-10-14", priority: "high", createdAt: "2026-10-06", completedAt: "2026-10-15T18:00:00.000Z" },
    { id: "old", status: "done", dueDate: "2026-09-01", priority: "normal", createdAt: "2026-09-01", completedAt: "2026-09-02T18:00:00.000Z" },
    { id: "canceled", status: "canceled", dueDate: "2026-10-16", priority: "normal", createdAt: "2026-10-01" }
  ];
  const groups = Model.taskGroups(orders, "2026-10-16");
  assert.deepEqual(groups.today.map(function (order) { return order.id; }), ["late", "today"]);
  assert.deepEqual(groups.week.map(function (order) { return order.id; }), ["morrow"]);
  assert.deepEqual(groups.upcoming.map(function (order) { return order.id; }), ["soon", "none"]);
  assert.deepEqual(groups.recent.map(function (order) { return order.id; }), ["finished"]);
  const onToday = Model.ordersForDay(orders, "2026-10-16", "2026-10-16");
  assert.deepEqual(onToday.map(function (order) { return order.id; }), ["late", "today"]);
  const onPast = Model.ordersForDay(orders, "2026-10-10", "2026-10-16");
  assert.deepEqual(onPast.map(function (order) { return order.id; }), ["late"]);
});

test("followers stay on the conversation and off the owner's list of edits", function () {
  let current = seed();
  current.actor = actor("jordan", "Jordan");
  assert.throws(function () {
    apply(current, { type: "setFollower", orderId: "WO-001", personId: "github:jordan", following: true });
  }, /Only the owner/);
  current = apply(current, { type: "setFollower", orderId: "WO-001", personId: "github:jordan", following: false });
  assert.deepEqual(current.work.orders[0].followers, []);
  assert.equal(current.work.orders[0].log[current.work.orders[0].log.length - 1].type, "unfollowed");
  current.actor = actor("alex", "Alex");
  current = apply(current, { type: "addNote", orderId: "WO-001", text: "Ask @Jordan to look" });
  assert.deepEqual(current.work.orders[0].followers, ["github:jordan"]);
  current = apply(current, { type: "setAssignee", orderId: "WO-001", assignee: "github:jordan" });
  assert.equal(current.work.orders[0].assignee, "github:jordan");
  assert.deepEqual(current.work.orders[0].followers, ["github:alex"]);
  current.actor = actor("alex", "Alex");
  current = apply(current, { type: "addNote", orderId: "WO-001", text: "Still on it" });
  assert.equal(current.work.orders[0].notes[current.work.orders[0].notes.length - 1].by, "github:alex");
  current = apply(current, { type: "setStatus", orderId: "WO-001", status: "waiting", text: "Hold" });
  assert.equal(current.work.orders[0].status, "waiting");
});

test("only chosen accounts can create work orders and budgets", function () {
  let current = seed();
  assert.equal(current.settings.people[0].canCreate, true);
  assert.equal(current.settings.people[1].canCreate, true);
  current = withPerson(current, actor("sam", "Sam"));
  assert.equal(current.settings.people[2].canCreate, false);
  current.actor = actor("sam", "Sam");
  assert.throws(function () {
    apply(current, {
      type: "createOrder",
      title: "Extra",
      location: "Shop",
      description: "Not allowed."
    });
  }, /can't create/);
  assert.throws(function () {
    apply(current, {
      type: "createBudget",
      name: "Shop",
      total: "10",
      starts: "2026-01-01",
      ends: "2026-12-31",
      codes: [{ code: "100", limit: "10" }]
    });
  }, /can't create/);
  assert.throws(function () {
    apply(current, { type: "setCreateAccess", personId: "github:sam", canCreate: true });
  }, /full account/);
  current.actor = actor("jordan", "Jordan");
  assert.throws(function () {
    apply(current, { type: "setCreateAccess", personId: "github:alex", canCreate: false });
  }, /stays a full account/);
  current = apply(current, { type: "setCreateAccess", personId: "github:sam", canCreate: true });
  current.actor = actor("sam", "Sam");
  current = apply(current, {
    type: "createOrder",
    title: "Extra",
    location: "Shop",
    description: "Allowed now."
  });
  assert.equal(current.work.orders[1].id, "WO-002");
  assert.throws(function () {
    apply(current, { type: "setCreateAccess", personId: "github:sam", canCreate: false });
  }, /full account/);
});

test("safe filenames drop path pieces", function () {
  assert.equal(Model.safeFilename("../panel photo.jpg"), "panel-photo.jpg");
});

test("a budget holds several billing codes and warns when a limit, the total, or the year is passed", function () {
  let current = seed();
  current = apply(current, {
    type: "createBudget",
    name: "2026 Operating",
    total: "100",
    starts: "2026-01-01",
    ends: "2026-12-31",
    codes: [
      { code: "7100", limit: "50" },
      { code: "7200", limit: "40" }
    ]
  });
  const budget = current.settings.budgets[0];
  assert.equal(budget.id, "BD-001");
  assert.equal(budget.totalCents, 10000);
  assert.equal(budget.codes.length, 2);
  assert.equal(budget.codes[0].id, "BC-001");
  assert.equal(budget.codes[1].code, "7200");
  assert.throws(function () {
    apply(current, {
      type: "updateBudget",
      id: "BD-001",
      name: "2026 Operating",
      total: "100",
      starts: "2026-01-01",
      ends: "2026-12-31",
      codes: [
        { id: "BC-001", code: "7100", limit: "50" },
        { code: "7100", limit: "10" }
      ]
    });
  }, /already in this budget/);
  current = apply(current, {
    type: "createOrder",
    title: "Replace filters",
    location: "Student Building",
    description: "Four filters."
  });
  current = apply(current, { type: "addPurchase", orderId: "WO-002", budgetId: "BC-001", cost: "40.50" });
  assert.equal(current.work.orders[1].purchases[0].codeId, "BC-001");
  assert.equal(Model.spentCents(current.work, "BC-001"), 4050);
  assert.equal(Model.budgetSpentCents(current.work, budget), 4050);
  assert.deepEqual(Model.budgetNotices(current.settings, current.work, "2026-06-01"), []);
  current = apply(current, { type: "addPurchase", orderId: "WO-002", budgetId: "BC-001", cost: "19.50" });
  assert.equal(Model.spentCents(current.work, "BC-001"), 6000);
  current = apply(current, {
    type: "createOrder",
    title: "Paint",
    location: "Hall",
    description: "Touch up."
  });
  current = apply(current, { type: "addPurchase", orderId: "WO-003", budgetId: "BC-002", cost: "50" });
  const notices = Model.budgetNotices(current.settings, current.work, "2026-06-01");
  assert.equal(notices.filter(function (notice) { return notice.kind === "limit"; }).length, 2);
  assert.equal(notices.some(function (notice) { return notice.kind === "total" && notice.over === 1000; }), true);
  assert.equal(Model.budgetNotices(current.settings, current.work, "2027-01-01").some(function (notice) {
    return notice.kind === "year";
  }), true);
  current = apply(current, { type: "setStatus", orderId: "WO-002", status: "canceled", text: "Not needed" });
  current = apply(current, { type: "setStatus", orderId: "WO-003", status: "canceled", text: "Not needed" });
  assert.equal(Model.budgetSpentCents(current.work, current.settings.budgets[0]), 0);
  assert.deepEqual(Model.budgetNotices(current.settings, current.work, "2027-01-01"), []);
  current = apply(current, {
    type: "updateOrder",
    id: "WO-001",
    title: "Replace hose",
    location: "Bay 2",
    description: "Hydraulic hose is leaking.",
    priority: "high",
    dueDate: "2026-10-01",
    tags: "hydraulic",
    equipmentIds: ["EQ-14"],
    repeat: "weekly"
  });
  current = apply(current, { type: "addPurchase", orderId: "WO-001", budgetId: "BC-002", cost: "12.00" });
  current = apply(current, { type: "setStatus", orderId: "WO-001", status: "done", text: "Done" });
  const repeated = current.work.orders.find(function (order) { return order.fromId === "WO-001"; });
  assert.deepEqual(repeated.purchases, []);
  assert.throws(function () {
    apply(current, { type: "removeBudget", id: "BD-001" });
  }, /still uses a billing code/);
  assert.throws(function () {
    apply(current, { type: "addPurchase", orderId: "WO-001", budgetId: "BC-999", cost: "5" });
  }, /billing code/);
});
