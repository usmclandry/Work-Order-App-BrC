(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.JobSupabase = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function config() {
    var value = typeof JOB_SUPABASE === "undefined" ? null : JOB_SUPABASE;
    if (!value || !value.url || !value.anonKey) return null;
    return { url: String(value.url).replace(/\/$/, ""), anonKey: String(value.anonKey) };
  }

  function ready() {
    return !!config();
  }

  function errorMessage(data, fallback) {
    if (!data) return fallback;
    return data.error_description || data.msg || data.message || data.error || fallback;
  }

  function actorFromUser(user) {
    var email = String((user && user.email) || "").trim();
    var metadata = (user && user.user_metadata) || {};
    return {
      id: "user:" + String(user && user.id || "").trim(),
      email: email,
      githubLogin: "",
      displayName: metadata.display_name || email.split("@")[0] || "User"
    };
  }

  function normalizeSession(data) {
    if (!data || !data.access_token || !data.refresh_token || !data.user) {
      throw new Error(errorMessage(data, "Sign-in did not return a session."));
    }
    var expiresAt = data.expires_at;
    if (!expiresAt && data.expires_in) expiresAt = Math.floor(Date.now() / 1000) + Number(data.expires_in);
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: expiresAt || 0,
      user: { id: data.user.id, email: data.user.email || "" }
    };
  }

  async function authRequest(path, body) {
    var project = config();
    if (!project) throw new Error("Supabase is not connected on this copy of the page yet.");
    var response = await fetch(project.url + path, {
      method: "POST",
      headers: {
        apikey: project.anonKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    var data = null;
    try { data = await response.json(); } catch (parseError) { data = null; }
    if (!response.ok) throw new Error(errorMessage(data, "That email or password was not accepted."));
    return normalizeSession(data);
  }

  function signIn(email, password) {
    return authRequest("/auth/v1/token?grant_type=password", {
      email: String(email || "").trim(),
      password: password || ""
    });
  }

  function refresh(session) {
    return authRequest("/auth/v1/token?grant_type=refresh_token", {
      refresh_token: session.refresh_token
    });
  }

  function createClient(options) {
    var project = config();
    var session = options.session;
    var actor = options.actor;
    var onSession = options.onSession || function () {};
    var revision = 1;
    var settings = null;
    var equipment = null;
    var work = null;

    function adopt(next) {
      settings = next.settings;
      equipment = next.equipment;
      work = next.work;
      if (next.revision) revision = next.revision;
    }

    async function ensureFresh() {
      var now = Math.floor(Date.now() / 1000);
      if (session.expires_at && session.expires_at - now > 60) return;
      session = await refresh(session);
      onSession(session);
    }

    async function request(method, path, body, headers) {
      if (!project) throw new Error("Supabase is not connected on this copy of the page yet.");
      await ensureFresh();
      var requestHeaders = {
        apikey: project.anonKey,
        Authorization: "Bearer " + session.access_token,
        Accept: "application/json"
      };
      Object.keys(headers || {}).forEach(function (key) { requestHeaders[key] = headers[key]; });
      var response = await fetch(project.url + path, {
        method: method,
        headers: requestHeaders,
        body: body
      });
      if (response.status === 204) return null;
      var text = await response.text();
      var data = null;
      if (text) {
        try { data = JSON.parse(text); } catch (parseError) { data = { message: text }; }
      }
      if (!response.ok) {
        var error = new Error(errorMessage(data, "Supabase could not complete that save."));
        error.conflict = response.status === 409;
        throw error;
      }
      return data;
    }

    async function load() {
      var rows = await request("GET", "/rest/v1/app_state?id=eq.1&select=settings,equipment,work,revision", null, {});
      var row = rows && rows[0];
      if (!row) throw new Error("The work-order database is missing. Run the Supabase setup SQL.");
      ["settings", "equipment", "work"].forEach(function (name) {
        if (!row[name] || row[name].version !== 1) throw new Error("The " + name + " data is not version 1.");
      });
      adopt({
        settings: row.settings,
        equipment: row.equipment,
        work: row.work,
        revision: row.revision
      });
      return snapshot();
    }

    function snapshot() {
      return { settings: settings, equipment: equipment, work: work, actor: actor };
    }

    async function upload(binary, result) {
      var previous = new Set((work.attachments || []).map(function (item) { return item.id; }));
      var created = result.work.attachments.find(function (item) { return !previous.has(item.id); });
      if (!created) throw new Error("The attachment record was missing.");
      var objectPath = created.path.split("/").map(encodeURIComponent).join("/");
      await request("POST", "/storage/v1/object/attachments/" + objectPath, binary.bytes, {
        "Content-Type": created.contentType || "application/octet-stream",
        "x-upsert": "true"
      });
    }

    async function write(result, binary) {
      if (binary) await upload(binary, result);
      var nextRevision = revision + 1;
      var updated = await request(
        "PATCH",
        "/rest/v1/app_state?id=eq.1&revision=eq." + revision,
        JSON.stringify({
          settings: result.settings,
          equipment: result.equipment,
          work: result.work,
          revision: nextRevision
        }),
        { "Content-Type": "application/json", Prefer: "return=representation" }
      );
      if (!updated || !updated.length) {
        var conflict = new Error("Someone else saved first. Try again.");
        conflict.conflict = true;
        throw conflict;
      }
    }

    async function save(op, binary) {
      var lastError = null;
      for (var attempt = 0; attempt < 4; attempt++) {
        var fresh = await load();
        var result = JobModel.apply({
          settings: fresh.settings,
          equipment: fresh.equipment,
          work: fresh.work,
          actor: actor
        }, op);
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
      var objectPath = String(path || "").split("/").map(encodeURIComponent).join("/");
      await ensureFresh();
      var response = await fetch(project.url + "/storage/v1/object/authenticated/attachments/" + objectPath, {
        headers: {
          apikey: project.anonKey,
          Authorization: "Bearer " + session.access_token
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

  return {
    ready: ready,
    signIn: signIn,
    actorFromUser: actorFromUser,
    createClient: createClient
  };
});
