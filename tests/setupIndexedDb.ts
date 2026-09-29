import { IDBFactory } from "fake-indexeddb";

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
});
