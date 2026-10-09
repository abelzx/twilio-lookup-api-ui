const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseCsv,
  stripBom,
  extractColumnFromCsvRows,
  uniqueLines,
  flattenRecord,
  resultsToRows,
  toCsv,
  mergeChunkResultsPrefix,
  runInBatches,
} = require("../assets/batch.js");

// ---------------------------------------------------------------------------
// runInBatches
// ---------------------------------------------------------------------------

/** Replaces global fetch for one test. `respond(items, init)` returns [status, body]. */
function stubFetch(t, respond) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, init) => {
    const { items } = JSON.parse(init.body);
    calls.push({ url, items });
    const [status, body] = await respond(items, init);
    return new Response(JSON.stringify(body), { status });
  };
  t.after(() => {
    global.fetch = original;
  });
  return calls;
}

const echo = (items) => [200, { results: items.map((input) => ({ input, ok: true })) }];

/** Rejects the way fetch does when its signal is aborted. */
function waitForAbort(signal) {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () =>
      reject(new DOMException("The operation was aborted.", "AbortError"))
    );
  });
}

function baseOptions(overrides) {
  return {
    items: [],
    endpoint: "/test",
    buildBody: (slice) => ({ items: slice }),
    batchSize: 2,
    parallelBatches: 2,
    signal: new AbortController().signal,
    ...overrides,
  };
}

test("runInBatches keeps input order when batches finish out of order", async (t) => {
  // The first batch is held until the other two have reported. A timer would
  // race the first Response/json() call, which can take 30ms+ on a cold runner.
  let releaseFirst;
  const firstHeld = new Promise((r) => {
    releaseFirst = r;
  });
  const calls = stubFetch(t, async (items) => {
    if (items.includes("a")) await firstHeld;
    return echo(items);
  });
  const progress = [];
  const out = await runInBatches(
    baseOptions({
      items: ["a", "b", "c", "d", "e"],
      onProgress: (done, total) => {
        progress.push([done, total]);
        if (done === 3) releaseFirst();
      },
    })
  );
  assert.deepEqual(
    out.results.map((r) => r.input),
    ["a", "b", "c", "d", "e"]
  );
  assert.equal(out.cancelled, false);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "/test");
  // The slow first batch reports last.
  assert.deepEqual(progress, [
    [2, 5],
    [3, 5],
    [5, 5],
  ]);
});

test("runInBatches with nothing to do makes no request", async (t) => {
  const calls = stubFetch(t, echo);
  const out = await runInBatches(baseOptions({ items: [] }));
  assert.deepEqual(out, { results: [], cancelled: false });
  assert.equal(calls.length, 0);
});

test("runInBatches returns the completed prefix on cancel", async (t) => {
  const calls = stubFetch(t, echo);
  const ctrl = new AbortController();
  const out = await runInBatches(
    baseOptions({
      items: ["a", "b", "c", "d"],
      parallelBatches: 1,
      signal: ctrl.signal,
      onProgress: () => ctrl.abort(),
    })
  );
  assert.deepEqual(
    out.results.map((r) => r.input),
    ["a", "b"]
  );
  assert.equal(out.cancelled, true);
  assert.equal(calls.length, 1);
});

test("runInBatches rejects with the server error and stops other batches", async (t) => {
  const calls = stubFetch(t, async (items, init) => {
    if (items.includes("a")) return [401, { error: "SendGrid rejected the API key." }];
    return waitForAbort(init.signal);
  });
  await assert.rejects(
    runInBatches(baseOptions({ items: ["a", "b", "c"], batchSize: 1 })),
    { message: "SendGrid rejected the API key." }
  );
  assert.deepEqual(
    calls.map((c) => c.items),
    [["a"], ["b"]]
  );
});

test("runInBatches rejects on a network error", async (t) => {
  const original = global.fetch;
  global.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  t.after(() => {
    global.fetch = original;
  });
  await assert.rejects(runInBatches(baseOptions({ items: ["a"] })), {
    message: "fetch failed",
  });
});

test("mergeChunkResultsPrefix stops at the first missing chunk", () => {
  assert.deepEqual(mergeChunkResultsPrefix([[1, 2], [3]], 2), [1, 2, 3]);
  assert.deepEqual(mergeChunkResultsPrefix([[1], undefined, [3]], 3), [1]);
});

// ---------------------------------------------------------------------------
// CSV input
// ---------------------------------------------------------------------------

test("parseCsv handles quoted commas, quoted newlines and CRLF", () => {
  assert.deepEqual(parseCsv('a,"b,c"\r\n"x\ny",z\n'), [
    ["a", "b,c"],
    ["x\ny", "z"],
  ]);
});

test("parseCsv unescapes doubled quotes and skips blank lines", () => {
  assert.deepEqual(parseCsv('q,"he said ""hi"""\n\nlast'), [
    ["q", 'he said "hi"'],
    ["last"],
  ]);
});

test("stripBom removes a leading byte-order mark only", () => {
  assert.equal(stripBom("\uFEFFa,b"), "a,b");
  assert.equal(stripBom("a,b"), "a,b");
});

test("extractColumnFromCsvRows trims, skips short rows and de-duplicates", () => {
  const rows = [["x", "1"], ["y"], ["z", "1"], ["w", " 2 "], ["v", ""]];
  assert.deepEqual(extractColumnFromCsvRows(rows, 2), ["1", "2"]);
  assert.deepEqual(extractColumnFromCsvRows(rows, 0), ["x", "y", "z", "w", "v"]);
});

test("uniqueLines splits on newlines and commas", () => {
  assert.deepEqual(uniqueLines(" a \nb,a\r\n\n c"), ["a", "b", "c"]);
  assert.deepEqual(uniqueLines(""), []);
});

// ---------------------------------------------------------------------------
// CSV output
// ---------------------------------------------------------------------------

test("flattenRecord dots nested keys, joins arrays and blanks nulls", () => {
  assert.deepEqual(
    flattenRecord({ a: { b: 1, c: { d: null } }, list: [1, "x", { k: 1 }], n: null }),
    { "a.b": "1", "a.c.d": "", list: '1; x; {"k":1}', n: "" }
  );
});

test("resultsToRows puts status columns first and flattens data", () => {
  assert.deepEqual(
    resultsToRows([
      { input: "a", ok: true, data: { v: { w: 2 } } },
      { input: "b", ok: false, error: "nope", code: 400 },
    ]),
    [
      { input: "a", ok: "true", error: "", error_code: "", "v.w": "2" },
      { input: "b", ok: "false", error: "nope", error_code: "400" },
    ]
  );
});

test("toCsv escapes and takes the union of keys", () => {
  assert.equal(
    toCsv([{ a: "1", b: 'x,"y"' }, { c: "line\nbreak" }]),
    'a,b,c\r\n1,"x,""y""",\r\n,,"line\nbreak"'
  );
  assert.equal(toCsv([]), "");
});
