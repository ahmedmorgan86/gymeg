// In-memory Firestore stand-in for tests/firestore-snapshot.test.mjs.
// Counts document reads and writes the way Firestore bills them (one read
// per document returned), so tests can prove read bounds without touching a
// real database. Not a general Firestore emulator: only the surface
// app/lib/firestore-db.ts uses.

const apps = [];
const store = new Map(); // collection name -> Map(docId -> data)
export const __counters = { reads: 0, writes: 0, queries: 0, docsReturned: 0 };
// Test-only hooks: __hooks.beforeQueryGet?.(collectionName) runs before a
// query executes, letting tests simulate a concurrent writer mid-read.
export const __hooks = {};
export const __store = store;
export function __reset() {
  store.clear();
  apps.length = 0;
  __counters.reads = 0;
  __counters.writes = 0;
  __counters.queries = 0;
  __counters.docsReturned = 0;
}

const coll = (name) => {
  if (!store.has(name)) store.set(name, new Map());
  return store.get(name);
};

const docSnap = (id, data) => ({ id, exists: data !== undefined, data: () => data });

function docApi(name, id) {
  return {
    __name: name,
    __id: id,
    get: async () => {
      __counters.reads++;
      return docSnap(id, coll(name).get(id));
    },
    set: async (data) => {
      __counters.writes++;
      coll(name).set(id, data);
    },
    update: async (data) => {
      __counters.writes++;
      coll(name).set(id, { ...(coll(name).get(id) ?? {}), ...data });
    },
    create: async (data) => {
      __counters.writes++;
      if (coll(name).has(id)) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 });
      coll(name).set(id, data);
    },
    delete: async () => {
      __counters.writes++;
      coll(name).delete(id);
    },
  };
}

function matches(id, data, filters) {
  for (const [field, op, value] of filters) {
    const actual = field === '__name__' ? id : data?.[field];
    if (op === '==' && actual !== value) return false;
    if (op === '!=' && actual === value) return false;
    if (op === '>' && !(actual > value)) return false;
    if (op === '<' && !(actual < value)) return false;
    if (op === '>=' && !(actual >= value)) return false;
    if (op === '<=' && !(actual <= value)) return false;
  }
  return true;
}

function queryApi(name, filters, orders, lim) {
  return {
    where: (field, op, value) => queryApi(name, [...filters, [field, op, value]], orders, lim),
    orderBy: (field, dir = 'asc') => queryApi(name, filters, [...orders, [field, dir]], lim),
    limit: (n) => queryApi(name, filters, orders, n),
    get: async () => {
      if (__hooks.beforeQueryGet) __hooks.beforeQueryGet(name);
      let rows = [...coll(name).entries()].filter(([id, data]) => matches(id, data, filters));
      for (const [field, dir] of [...orders].reverse()) {
        rows.sort((a, b) => {
          const x = field === '__name__' ? a[0] : a[1][field];
          const y = field === '__name__' ? b[0] : b[1][field];
          const cmp = x < y ? -1 : x > y ? 1 : 0;
          return dir === 'desc' ? -cmp : cmp;
        });
      }
      if (lim !== undefined) rows = rows.slice(0, lim);
      __counters.queries++;
      __counters.docsReturned += rows.length;
      return { empty: rows.length === 0, size: rows.length, docs: rows.map(([id, d]) => docSnap(id, d)) };
    },
  };
}

function collectionApi(name) {
  return { doc: (id) => docApi(name, id), ...queryApi(name, [], [], undefined) };
}

// Transaction/batch operations apply immediately against the same store and
// count reads/writes identically; sufficient for the single-process,
// single-threaded flows under test.
const txApi = () => ({
  get: (ref) => ref.get(),
  set: (ref, data) => docApi(ref.__name, ref.__id).set(data),
  update: (ref, data) => docApi(ref.__name, ref.__id).update(data),
  delete: (ref) => docApi(ref.__name, ref.__id).delete(),
  create: (ref, data) => docApi(ref.__name, ref.__id).create(data),
});

export function getFirestore() {
  return {
    collection: collectionApi,
    runTransaction: async (fn) => fn(txApi()),
    batch: () => {
      const ops = [];
      return {
        set: (ref, data) => ops.push(() => docApi(ref.__name, ref.__id).set(data)),
        update: (ref, data) => ops.push(() => docApi(ref.__name, ref.__id).update(data)),
        delete: (ref) => ops.push(() => docApi(ref.__name, ref.__id).delete()),
        commit: async () => {
          for (const op of ops) await op();
        },
      };
    },
  };
}

export function initializeApp(_config, name) {
  const app = { name: name ?? '[DEFAULT]' };
  apps.push(app);
  return app;
}
export const getApps = () => apps;
export const cert = (sa) => ({ sa });
export const FieldValue = { serverTimestamp: () => new Date().toISOString() };
