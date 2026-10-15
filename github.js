(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.JobGitHub = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var JSON_PATHS = ["data/settings.json", "data/equipment.json", "data/work.json"];
  var TEXT_LIMIT = 1000000;

  function encodeUtf8(text) {
    return new TextEncoder().encode(text);
  }

  function bytesToBase64(bytes) {
    var parts = [];
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      var slice = bytes.subarray(i, i + chunk);
      var text = "";
      for (var j = 0; j < slice.length; j++) text += String.fromCharCode(slice[j]);
      parts.push(text);
    }
    return btoa(parts.join(""));
  }

  function base64ToUtf8(value) {
    var clean = String(value || "").replace(/\n/g, "");
    var binary = atob(clean);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function pretty(value) {
    return JSON.stringify(value, null, 2) + "\n";
  }

  function createClient(options) {
    var token = options.token;
    var repo = options.repo;
    var actor = options.actor;
    var shas = {};
    var settings = null;
    var equipment = null;
    var work = null;

    function adopt(next) {
      settings = next.settings;
      equipment = next.equipment;
      work = next.work;
      if (next.shas) shas = next.shas;
    }

    async function request(method, path, body, accept) {
      var response = await fetch("https://api.github.com" + path, {
        method: method,
        headers: {
          Authorization: "Bearer " + token,
          Accept: accept || "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json"
        },
        body: body ? JSON.stringify(body) : undefined
      });
      var text = await response.text();
      var data = null;
      try { data = text ? JSON.parse(text) : null; } catch (parseError) { data = { message: text }; }
      if (!response.ok) {
        var error = new Error((data && data.message) || "GitHub could not complete that save.");
        error.conflict = response.status === 409 || /fast forward|does not match/i.test(error.message);
        throw error;
      }
      return data;
    }

    async function load() {
      var loaded = await Promise.all(JSON_PATHS.map(function (path) {
        return request("GET", "/repos/" + repo + "/contents/" + path);
      }));
      var next = {
        settings: JSON.parse(base64ToUtf8(loaded[0].content)),
        equipment: JSON.parse(base64ToUtf8(loaded[1].content)),
        work: JSON.parse(base64ToUtf8(loaded[2].content)),
        shas: {}
      };
      JSON_PATHS.forEach(function (path, index) {
        next.shas[path] = loaded[index].sha;
      });
      ["settings", "equipment", "work"].forEach(function (name) {
        if (!next[name] || next[name].version !== 1) {
          throw new Error("The " + name + " file is not version 1.");
        }
      });
      adopt(next);
      return { settings: settings, equipment: equipment, work: work, shas: shas };
    }

    function snapshot() {
      return {
        settings: settings,
        equipment: equipment,
        work: work,
        actor: actor
      };
    }

    async function write(result, binary) {
      var payloads = result.files.map(function (path) {
        var value = path === "data/settings.json" ? result.settings : path === "data/equipment.json" ? result.equipment : result.work;
        return { path: path, text: pretty(value) };
      });
      var needsTree = payloads.length > 1 || payloads.some(function (file) {
        return encodeUtf8(file.text).length > TEXT_LIMIT;
      }) || !!binary;
      if (needsTree) await commitTree(result, payloads, binary);
      else await putContent(payloads[0], result.message);
    }

    async function putContent(file, message) {
      var body = {
        message: message,
        content: bytesToBase64(encodeUtf8(file.text)),
        branch: "main",
        author: { name: author().name, email: author().email }
      };
      if (shas[file.path]) body.sha = shas[file.path];
      await request("PUT", "/repos/" + repo + "/contents/" + file.path, body);
    }

    async function commitTree(result, payloads, binary) {
      var ref = await request("GET", "/repos/" + repo + "/git/ref/heads/main");
      var parent = ref.object.sha;
      var commit = await request("GET", "/repos/" + repo + "/git/commits/" + parent);
      var tree = [];
      if (binary) {
        var previous = new Set((work.attachments || []).map(function (item) { return item.id; }));
        var created = result.work.attachments.find(function (item) { return !previous.has(item.id); });
        if (!created) throw new Error("The attachment record was missing.");
        var blob = await request("POST", "/repos/" + repo + "/git/blobs", {
          content: bytesToBase64(binary.bytes),
          encoding: "base64"
        });
        created.sha = blob.sha;
        var workFile = payloads.find(function (file) { return file.path === "data/work.json"; });
        workFile.text = pretty(result.work);
        tree.push({ path: created.path, mode: "100644", type: "blob", sha: blob.sha });
      }
      for (var i = 0; i < payloads.length; i++) {
        var fileBlob = await request("POST", "/repos/" + repo + "/git/blobs", {
          content: bytesToBase64(encodeUtf8(payloads[i].text)),
          encoding: "base64"
        });
        tree.push({ path: payloads[i].path, mode: "100644", type: "blob", sha: fileBlob.sha });
      }
      var nextTree = await request("POST", "/repos/" + repo + "/git/trees", {
        base_tree: commit.tree.sha,
        tree: tree
      });
      var nextCommit = await request("POST", "/repos/" + repo + "/git/commits", {
        message: result.message,
        tree: nextTree.sha,
        parents: [parent],
        author: author()
      });
      try {
        await request("PATCH", "/repos/" + repo + "/git/refs/heads/main", { sha: nextCommit.sha });
      } catch (error) {
        if (!error.conflict) error.conflict = /fast forward|cannot lock|reference/i.test(error.message);
        throw error;
      }
    }

    function author() {
      return {
        name: actor.commitName || actor.displayName || actor.githubLogin,
        email: actor.commitEmail || (actor.githubLogin + "@users.noreply.github.com"),
        date: new Date().toISOString()
      };
    }

    async function save(op, binary) {
      var lastError = null;
      for (var attempt = 0; attempt < 4; attempt++) {
        var fresh = await load();
        var result;
        try {
          result = JobModel.apply({
            settings: fresh.settings,
            equipment: fresh.equipment,
            work: fresh.work,
            actor: actor
          }, op);
        } catch (error) {
          throw error;
        }
        if (!result.files.length) {
          adopt(fresh);
          return result;
        }
        try {
          await write(result, binary);
          await load();
          return result;
        } catch (error) {
          lastError = error;
          if (!error.conflict) throw error;
        }
      }
      throw lastError || new Error("Someone else saved first. Try again.");
    }

    async function readFile(path) {
      var response = await fetch("https://api.github.com/repos/" + repo + "/contents/" + path, {
        headers: {
          Authorization: "Bearer " + token,
          Accept: "application/vnd.github.raw",
          "X-GitHub-Api-Version": "2022-11-28"
        }
      });
      if (!response.ok) throw new Error("Could not open that file.");
      return response.blob();
    }

    return {
      load: load,
      save: save,
      readFile: readFile,
      snapshot: snapshot,
      setActor: function (next) { actor = next; }
    };
  }

  async function getUser(token) {
    var response = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });
    var data = await response.json();
    if (!response.ok) throw new Error(data.message || "That token was not accepted.");
    return {
      id: JobModel.personId(data.login),
      githubLogin: data.login,
      displayName: data.name || data.login,
      commitName: data.name || data.login,
      commitEmail: data.email || (data.id + "+" + data.login + "@users.noreply.github.com")
    };
  }

  return { createClient: createClient, getUser: getUser };
});
