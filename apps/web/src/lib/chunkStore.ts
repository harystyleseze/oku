/**
 * Browser-side buffer for recorded audio chunks (IndexedDB).
 * Every chunk is written here before it is uploaded and deleted once the server
 * has it, so a dropped connection, a closed tab or a crash never loses audio:
 * on the next visit, anything left over is uploaded and finalised.
 */

const DB_NAME = "oku-recorder";
const DB_VERSION = 1;
const CHUNKS = "chunks";
const TRACKS = "tracks";

export interface StoredTrack {
  trackId: string;
  uploadToken: string;
  mimeType: string;
  /** Total chunks the recorder produced; unknown (null) while still recording. */
  expectedChunks: number | null;
  createdAt: number;
}

interface StoredChunk {
  key: string; // `${trackId}:${index}`
  trackId: string;
  index: number;
  blob: Blob;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CHUNKS)) {
        const s = db.createObjectStore(CHUNKS, { keyPath: "key" });
        s.createIndex("trackId", "trackId");
      }
      if (!db.objectStoreNames.contains(TRACKS)) db.createObjectStore(TRACKS, { keyPath: "trackId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

export const chunkStore = {
  saveTrack: (t: StoredTrack) => tx(TRACKS, "readwrite", (s) => s.put(t)),
  getTrack: (trackId: string) => tx<StoredTrack | undefined>(TRACKS, "readonly", (s) => s.get(trackId)),
  listTracks: () => tx<StoredTrack[]>(TRACKS, "readonly", (s) => s.getAll()),
  deleteTrack: (trackId: string) => tx(TRACKS, "readwrite", (s) => s.delete(trackId)),

  saveChunk: (trackId: string, index: number, blob: Blob) =>
    tx(CHUNKS, "readwrite", (s) => s.put({ key: `${trackId}:${index}`, trackId, index, blob } satisfies StoredChunk)),
  getChunk: (trackId: string, index: number) =>
    tx<StoredChunk | undefined>(CHUNKS, "readonly", (s) => s.get(`${trackId}:${index}`)),
  deleteChunk: (trackId: string, index: number) => tx(CHUNKS, "readwrite", (s) => s.delete(`${trackId}:${index}`)),
  listChunkIndexes: (trackId: string) =>
    tx<IDBValidKey[]>(CHUNKS, "readonly", (s) => s.index("trackId").getAllKeys(trackId)).then((keys) =>
      keys.map((k) => Number(String(k).split(":")[1])).sort((a, b) => a - b),
    ),
};
