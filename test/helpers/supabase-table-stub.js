// Generic in-memory Supabase stub for /api/v1 integration tests, supporting the
// subset of the query-builder chain the new services use (eq/neq/gte/lt/order/
// limit/maybeSingle/single/insert/update/delete) plus .rpc(). Extends the
// pattern of test/api/app.test.js's hand-rolled createSupabaseStub — that one
// stays minimal for the existing /tools tests; this one is for the broader
// filtering the REST read layer needs.

function matches(row, filters) {
  return filters.every(([op, col, val]) => {
    if (op === "eq") return row[col] === val;
    if (op === "neq") return row[col] !== val;
    if (op === "gte") return row[col] >= val;
    if (op === "lt") return row[col] < val;
    if (op === "is" && val === null) return row[col] == null;
    if (op === "in") return Array.isArray(val) && val.includes(row[col]);
    if (op === "ilike") return matchesIlike(row[col], val);
    if (op === "or") return matchesOr(row, val);
    return true;
  });
}

// Mirrors supabase-js's .ilike(col, pattern) — case-insensitive, with SQL's
// "%" (any run of characters) and "_" (any one character) wildcards.
function matchesIlike(cellValue, pattern) {
  if (cellValue == null) return false;
  const regex = "^" + String(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".") + "$";
  return new RegExp(regex, "i").test(String(cellValue));
}

// Mirrors supabase-js's .or("col.eq.val,col2.is.null") — comma-separated
// col.op.value conditions, true if any one of them matches the row.
function matchesOr(row, orString) {
  return orString.split(",").some((cond) => {
    const [col, op, ...rest] = cond.split(".");
    const val = rest.join(".");
    if (op === "eq") return String(row[col]) === val;
    if (op === "is" && val === "null") return row[col] == null;
    return false;
  });
}

function createTableStub(initialTables = {}) {
  const tables = Object.fromEntries(Object.entries(initialTables).map(([k, rows]) => [k, [...rows]]));

  function from(name) {
    if (!tables[name]) tables[name] = [];
    const filters = [];
    let orderCol = null;
    let orderAsc = true;
    let limitN = null;

    function currentRows() {
      let rows = tables[name].filter((row) => matches(row, filters));
      if (orderCol) {
        rows = [...rows].sort((a, b) => {
          const diff = a[orderCol] > b[orderCol] ? 1 : a[orderCol] < b[orderCol] ? -1 : 0;
          return orderAsc ? diff : -diff;
        });
      }
      if (limitN != null) rows = rows.slice(0, limitN);
      return rows;
    }

    const builder = {
      select() {
        return this;
      },
      eq(col, val) {
        filters.push(["eq", col, val]);
        return this;
      },
      neq(col, val) {
        filters.push(["neq", col, val]);
        return this;
      },
      in(col, vals) {
        filters.push(["in", col, vals]);
        return this;
      },
      ilike(col, val) {
        filters.push(["ilike", col, val]);
        return this;
      },
      gte(col, val) {
        filters.push(["gte", col, val]);
        return this;
      },
      lt(col, val) {
        filters.push(["lt", col, val]);
        return this;
      },
      is(col, val) {
        filters.push(["is", col, val]);
        return this;
      },
      or(str) {
        filters.push(["or", null, str]);
        return this;
      },
      limit(n) {
        limitN = n;
        return this;
      },
      order(col, { ascending = true } = {}) {
        orderCol = col;
        orderAsc = ascending;
        // Chainable like every other filter method (eq/gte/...), not
        // terminal — .limit()/.maybeSingle() can follow, same as real
        // supabase-js. Still awaitable bare via the builder's own .then()
        // below when nothing follows it.
        return this;
      },
      // Real supabase-js query builders are themselves thenable — a query can
      // be awaited directly after any filter chain, with no terminal method
      // required. Mirror that so services matching that real-client usage
      // (e.g. .select().eq().eq()) resolve correctly under this stub too.
      then(resolve) {
        resolve({ data: currentRows(), error: null });
      },
      insert(row) {
        const inserted = Array.isArray(row) ? row : [row];
        tables[name].push(...inserted);
        return {
          select: () => ({
            single: async () => ({ data: inserted[0], error: null }),
            maybeSingle: async () => ({ data: inserted[0], error: null }),
          }),
        };
      },
      upsert(row) {
        tables[name] = tables[name].filter((r) => r.endpoint !== row.endpoint);
        tables[name].push(row);
        return { select: () => ({ single: async () => ({ data: row, error: null }) }) };
      },
      // Filter-chain approach (mirrors the read builder's `filters` + matches()
      // above) so any combination/order of .eq()/.or()/.is()/.neq() works
      // before a terminal .select().single()/.maybeSingle() or a bare await —
      // not just the specific one- or two-.eq() shapes services used to use.
      update(patch) {
        const ufilters = [];
        const chain = {
          eq(col, val) {
            ufilters.push(["eq", col, val]);
            return chain;
          },
          neq(col, val) {
            ufilters.push(["neq", col, val]);
            return chain;
          },
          is(col, val) {
            ufilters.push(["is", col, val]);
            return chain;
          },
          or(str) {
            ufilters.push(["or", null, str]);
            return chain;
          },
          select() {
            return {
              single: async () => {
                const idx = tables[name].findIndex((r) => matches(r, ufilters));
                if (idx === -1) return { data: null, error: null };
                tables[name][idx] = { ...tables[name][idx], ...patch };
                return { data: tables[name][idx], error: null };
              },
              maybeSingle: async () => {
                const idx = tables[name].findIndex((r) => matches(r, ufilters));
                if (idx === -1) return { data: null, error: null };
                tables[name][idx] = { ...tables[name][idx], ...patch };
                return { data: tables[name][idx], error: null };
              },
            };
          },
          async then(resolve) {
            tables[name].forEach((r, idx) => {
              if (matches(r, ufilters)) tables[name][idx] = { ...r, ...patch };
            });
            resolve({ error: null });
          },
        };
        return chain;
      },
      delete() {
        const dfilters = [];
        const chain = {
          eq(col, val) {
            dfilters.push(["eq", col, val]);
            return chain;
          },
          is(col, val) {
            dfilters.push(["is", col, val]);
            return chain;
          },
          or(str) {
            dfilters.push(["or", null, str]);
            return chain;
          },
          async then(resolve) {
            tables[name] = tables[name].filter((r) => !matches(r, dfilters));
            resolve({ error: null });
          },
        };
        return chain;
      },
      // Real PostgREST throws PGRST116 ("multiple (or no) rows returned")
      // when a .maybeSingle()/.single() query matches more than one row —
      // replicated here (not just "take rows[0]") so a query that's missing
      // a filter it needs shows up as a real test failure instead of
      // silently passing against this stub while breaking in production.
      async maybeSingle() {
        const rows = currentRows();
        if (rows.length > 1) {
          return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
        }
        return { data: rows[0] ?? null, error: null };
      },
      async single() {
        const rows = currentRows();
        if (rows.length > 1) {
          return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
        }
        return { data: rows[0] ?? null, error: rows[0] ? null : { message: "not found" } };
      },
    };
    return builder;
  }

  function rpc(name, args) {
    if (name === "search_patients") {
      const rows = (tables.Patient ?? []).filter(
        (p) => p.clinicId === args.p_clinic_id && (p.fullName ?? "").includes(args.p_query),
      );
      return Promise.resolve({ data: rows, error: null });
    }
    if (name === "refresh_day_stats") return Promise.resolve({ error: null });
    return Promise.resolve({ data: null, error: null });
  }

  // Minimal Storage stub — just the .createSignedUploadUrl()/.createSignedUrl()
  // surface visit-service.js's createUploadUrl/createReadUrl actually call.
  const storage = {
    from(bucket) {
      return {
        async createSignedUploadUrl(path) {
          return { data: { signedUrl: `https://stub.storage/${bucket}/${path}`, token: "stub-token" }, error: null };
        },
        async createSignedUrl(path) {
          return { data: { signedUrl: `https://stub.storage/${bucket}/${path}?signed=1` }, error: null };
        },
      };
    },
  };

  return { from, rpc, storage, _tables: tables };
}

module.exports = { createTableStub };
