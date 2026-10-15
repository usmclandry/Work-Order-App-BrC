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
    assignee: "github:jordan",
    dueDate: "2026-10-01",
    tags: "hydraulic",
    equipmentIds: ["eq-14"]
  });
  return current;
}

test("two people can join and a third cannot", function () {
  const alex = actor("alex", "Alex");
  let current = withPerson({
    actor: alex,
    settings: Model.emptySettings(),
    equipment: Model.emptyEquipment(),
    work: Model.emptyWork()
  }, alex);
  current.actor = actor("jordan", "Jordan");
  current = apply(current, { type: "addPerson", displayName: "Jordan" });
  assert.equal(current.settings.people.length, 2);
  current.actor = actor("sam", "Sam");
  assert.throws(function () {
    apply(current, { type: "addPerson", displayName: "Sam" });
  }, /Only two people/);
});

test("creates an order stamped by the signed-in person and links equipment", function () {
  const current = seed();
  const order = current.work.orders[0];
  assert.equal(order.id, "WO-001");
  assert.equal(order.equipmentIds[0], "EQ-14");
  assert.equal(order.log[0].by, "github:alex");
  assert.equal(order.log[0].type, "created");
  assert.equal(order.log[1].type, "assigned");
  assert.equal(order.log[1].to, "github:jordan");
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

test("safe filenames drop path pieces", function () {
  assert.equal(Model.safeFilename("../panel photo.jpg"), "panel-photo.jpg");
});
