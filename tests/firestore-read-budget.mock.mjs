const apps = [{ name: 'gymeg-workspace' }];
const store = new Map();
export const __counters = { docReads: 0, queryReads: 0, returnedDocs: 0, queries: [] };

function collectionStore(name) {
  if (!store.has(name)) store.set(name, new Map());
  return store.get(name);
}

export const __store = { get: collectionStore };

export function __reset() {
  store.clear();
  __counters.docReads = 0;
  __counters.queryReads = 0;
  __counters.returnedDocs = 0;
  __counters.queries.length = 0;
}

function snapshot(id, data) {
  return { id, exists: data !== undefined, data: () => data };
}

function documentApi(name, id) {
  return {
    get: async () => {
      __counters.docReads++;
      return snapshot(id, collectionStore(name).get(id));
    },
    set: async data => {
      collectionStore(name).set(id, data);
    },
  };
}

function queryApi(name, filters = [], orders = [], maxDocs) {
  return {
    where: (field, operator, value) => queryApi(name, [...filters, [field, operator, value]], orders, maxDocs),
    orderBy: (field, direction = 'asc') => queryApi(name, filters, [...orders, [field, direction]], maxDocs),
    limit: value => queryApi(name, filters, orders, value),
    get: async () => {
      let rows = [...collectionStore(name).entries()].filter(([id, data]) => filters.every(([field, operator, value]) => {
        const actual = field === '__name__' ? id : data?.[field];
        return operator === '==' ? actual === value : true;
      }));
      for (const [field, direction] of [...orders].reverse()) {
        rows.sort((a, b) => {
          const left = field === '__name__' ? a[0] : a[1][field];
          const right = field === '__name__' ? b[0] : b[1][field];
          const result = left < right ? -1 : left > right ? 1 : 0;
          return direction === 'desc' ? -result : result;
        });
      }
      if (maxDocs !== undefined) rows = rows.slice(0, maxDocs);
      __counters.queryReads++;
      __counters.returnedDocs += rows.length;
      __counters.queries.push({ collection: name, limit: maxDocs, returned: rows.length });
      return { docs: rows.map(([id, data]) => snapshot(id, data)), size: rows.length, empty: rows.length === 0 };
    },
  };
}

export function getFirestore() {
  return {
    collection: name => ({ doc: id => documentApi(name, id), ...queryApi(name) }),
  };
}

export const getApps = () => apps;
export const initializeApp = (_config, name = '[DEFAULT]') => {
  const app = { name };
  apps.push(app);
  return app;
};
export const cert = value => value;
export const FieldValue = {};
